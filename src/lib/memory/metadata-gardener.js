/*
 * Moltagent - Sovereign AI Security Layer
 * Copyright (C) 2026 Moltagent Contributors
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU Affero General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 */

'use strict';

/**
 * MetadataGardener — Background frontmatter maintenance for wiki pages.
 *
 * Architecture Brief:
 * - Problem: Pages created by humans or with broken frontmatter are invisible
 *   to the scoring system that rewards typed pages with 2× boost
 * - Pattern: Background heartbeat task that scans for untyped pages, uses LLM
 *   to infer type + structured fields, writes frontmatter back
 * - Key Dependencies: CollectivesClient (page listing/read/write), LLMRouter (type inference)
 * - Data Flow: scan → queue → LLM inference → merge frontmatter → write back
 * - Dependency Map: heartbeat-manager.js → metadata-gardener.js → collectives-client.js
 *
 * @module memory/metadata-gardener
 * @version 1.0.0
 */

class MetadataGardener {
  /**
   * @param {Object} options
   * @param {Object} options.collectivesClient - CollectivesClient with listPages/readPageContent/writePageContent
   * @param {Object} options.router - LLMRouter with route() method
   * @param {Object} [options.logger]
   * @param {number} [options.pagesPerTick=2] - Max pages to garden per heartbeat
   */
  constructor({ collectivesClient, router, logger, pagesPerTick = 2, resilientWriter } = {}) {
    if (!collectivesClient) throw new Error('MetadataGardener requires collectivesClient');
    if (!router) throw new Error('MetadataGardener requires router');
    this.collectivesClient = collectivesClient;
    this.resilientWriter = resilientWriter || null;
    this.router = router;
    this.logger = logger || console;
    this.pagesPerTick = pagesPerTick;
    this._lastFullScan = 0;
    this._scanInterval = 3600000; // Full scan every hour
    this._gardenQueue = [];
    this._failedAttempts = new Map(); // pageId → attempt count
    this._maxAttempts = 2;
  }

  /**
   * Called every heartbeat tick. Gardens 1-2 pages.
   * @returns {Promise<{ gardened: number, queued: number }>}
   */
  async tend() {
    // Refresh queue periodically
    if (this._gardenQueue.length === 0 ||
        Date.now() - this._lastFullScan > this._scanInterval) {
      await this._scanForNakedPages();
    }

    if (this._gardenQueue.length === 0) {
      return { gardened: 0, queued: 0 };
    }

    const batch = this._gardenQueue.splice(0, this.pagesPerTick);
    let gardened = 0;

    for (const page of batch) {
      try {
        await this._gardenPage(page);
        gardened++;
      } catch (err) {
        this.logger.warn(
          `[MetadataGardener] Failed to garden ${page.title}: ${err.message}`
        );
      }
    }

    this.logger.info(
      `[MetadataGardener] Gardened ${gardened}/${batch.length} pages. ` +
      `Queue: ${this._gardenQueue.length} remaining`
    );

    return { gardened, queued: this._gardenQueue.length };
  }

  /**
   * Scan all wiki pages. Queue those missing frontmatter type.
   * Prioritize by access recency and content length.
   * @private
   */
  async _scanForNakedPages() {
    try {
      const collectiveId = await this.collectivesClient.resolveCollective();
      const pages = await this.collectivesClient.listPages(collectiveId);
      this._gardenQueue = [];

      for (const page of pages) {
        const path = page.filePath || page.title || '';
        // Skip Meta/ pages — documentation, not knowledge
        if (path.includes('/Meta') || path.includes('Meta/') || path === 'Meta') continue;

        try {
          const pagePath = this._buildPagePath(page);
          if (!pagePath) continue;
          const content = await this.collectivesClient.readPageContent(pagePath);
          if (!content || content.length < 30) continue; // Skip stubs

          if (!this._hasFrontmatterType(content)) {
            this._gardenQueue.push({
              id: page.id,
              title: page.title,
              path: pagePath,
              content: content,
              priority: this._computePriority(content)
            });
          }
        } catch (err) {
          // Skip pages we can't read
          this.logger.warn(`[MetadataGardener] Scan skip ${page.title}: ${err.message}`);
        }
      }

      this._gardenQueue.sort((a, b) => b.priority - a.priority);
      this._lastFullScan = Date.now();

      this.logger.info(
        `[MetadataGardener] Scan complete. ${this._gardenQueue.length} pages need gardening`
      );
    } catch (err) {
      this.logger.error(`[MetadataGardener] Scan failed: ${err.message}`);
    }
  }

  /**
   * Check if content already has a frontmatter type field.
   * @param {string} content
   * @returns {boolean}
   */
  _hasFrontmatterType(content) {
    if (!content) return false;
    const fmMatch = content.match(/^---\n([\s\S]*?)\n---/);
    if (!fmMatch) return false;
    return /^type:\s*.+/m.test(fmMatch[1]);
  }

  /**
   * Compute gardening priority. Higher = more urgent.
   * @param {string} content
   * @returns {number}
   * @private
   */
  _computePriority(content) {
    let priority = 0;

    // Recently accessed pages are higher priority
    const accessMatch = content.match(/last_accessed:\s*"?([^"\n]+)/);
    if (accessMatch) {
      const ts = new Date(accessMatch[1]).getTime();
      if (Number.isFinite(ts)) {
        const age = Date.now() - ts;
        if (age < 86400000) priority += 10;       // Accessed today
        else if (age < 604800000) priority += 5;   // This week
      }
    }

    // Longer content = more to extract
    if (content.length > 500) priority += 3;
    if (content.length > 2000) priority += 5;

    // Pages with access_count are more important
    const countMatch = content.match(/access_count:\s*(\d+)/);
    if (countMatch && parseInt(countMatch[1]) > 3) priority += 5;

    return priority;
  }

  /**
   * Garden a single page: generate frontmatter via LLM, merge, write back.
   * @param {Object} page - { id, title, path, content, priority }
   * @private
   */
  async _gardenPage(page) {
    const contentForAnalysis = page.content.substring(0, 2000);

    const prompt = `Analyze this wiki page and generate YAML frontmatter.

Page title: "${page.title}"
Page path: ${page.path || 'unknown'}

Content:
"""
${contentForAnalysis}
"""

Determine the entity TYPE. Extract structured fields appropriate for that type.

Types and their fields:
- person: name, company, role, email, context
- project: name, lead, goal, status (active|planned|completed|paused), timeline
- procedure: name, domain, frequency (daily|weekly|monthly|as-needed), dependencies
- decision: name, date, participants, outcome, rationale
- research: name, topic, source, key_findings
- reference: name, category, url, description
- note: topic, context

If you cannot determine the type, use "note" as the default.
Always include: type, confidence (high|medium|low)

If existing frontmatter exists but lacks a type field, PRESERVE all existing fields
and ADD the missing ones. Do not remove last_accessed, access_count, or other existing fields.

Respond with ONLY the YAML key-value pairs (NO --- delimiters, no other text):`;

    const rawResponse = await this.router.route({
      job: 'quick',
      content: prompt,
      requirements: { maxTokens: 300 },
      context: { trigger: 'heartbeat_garden', internal: true }
    });

    const responseText = (rawResponse.result || rawResponse || '').toString().trim();
    const generatedFields = this._parseYamlFields(responseText);

    if (!generatedFields.type) {
      // Track failed attempts — fallback to type: note after _maxAttempts
      const attempts = (this._failedAttempts.get(page.id) || 0) + 1;
      this._failedAttempts.set(page.id, attempts);

      if (attempts >= this._maxAttempts) {
        this.logger.info(
          `[MetadataGardener] ${page.title}: ${attempts} attempts, assigning type: note`
        );
        generatedFields.type = 'note';
        generatedFields.confidence = 'low';
        generatedFields.gardener_assigned = 'true';
        this._failedAttempts.delete(page.id);
      } else {
        this.logger.warn(
          `[MetadataGardener] ${page.title}: no type (attempt ${attempts}/${this._maxAttempts})`
        );
        return;
      }
    } else {
      // Success — clear any failed attempt tracking
      this._failedAttempts.delete(page.id);
    }

    // Merge: existing frontmatter fields win over generated ones
    const existingFields = this._extractFrontmatterFields(page.content);
    const merged = { ...generatedFields, ...existingFields };

    // Ensure type exists (generated fills the gap)
    if (!merged.type) merged.type = generatedFields.type;

    // Build new frontmatter + content without old frontmatter
    const contentWithoutFM = page.content.replace(/^---\n[\s\S]*?\n---\n*/, '');
    const yamlLines = Object.entries(merged)
      .map(([k, v]) => `${k}: ${String(v).replace(/\n/g, ' ')}`)
      .join('\n');
    const updatedContent = `---\n${yamlLines}\n---\n\n${contentWithoutFM.trim()}`;

    if (this.resilientWriter) {
      await this.resilientWriter.updatePage(page.path, updatedContent);
    } else {
      await this.collectivesClient.writePageContent(page.path, updatedContent);
    }

    this.logger.info(
      `[MetadataGardener] Enriched ${page.title}: type=${merged.type}`
    );
  }

  /**
   * Parse YAML-like key-value pairs from LLM response.
   * Handles markdown fences and extra text.
   * @param {string} raw
   * @returns {Object}
   * @private
   */
  _parseYamlFields(raw) {
    if (!raw) return {};
    let text = raw.trim();
    // Strip markdown fences
    text = text.replace(/```ya?ml\n?/gi, '').replace(/```\n?/g, '');
    // Strip --- delimiters if present
    text = text.replace(/^---\s*\n?/, '').replace(/\n?---\s*$/, '');

    const fields = {};
    const lines = text.split('\n');
    for (const line of lines) {
      const match = line.match(/^([a-z_]+):\s*(.+)/i);
      if (match) {
        fields[match[1].toLowerCase()] = match[2].trim();
      }
    }
    return fields;
  }

  /**
   * Extract existing frontmatter fields from page content.
   * @param {string} content
   * @returns {Object}
   * @private
   */
  _extractFrontmatterFields(content) {
    if (!content) return {};
    const fmMatch = content.match(/^---\n([\s\S]*?)\n---/);
    if (!fmMatch) return {};
    return this._parseYamlFields(fmMatch[1]);
  }

  /**
   * Build WebDAV page path from Collectives page object.
   * Uses filePath/fileName pattern matching CollectivesClient._buildPagePath().
   * @param {Object} page - Page object with fileName and filePath from API
   * @returns {string|null}
   * @private
   */
  _buildPagePath(page) {
    if (page.fileName) {
      return page.filePath
        ? `${page.filePath}/${page.fileName}`
        : page.fileName;
    }
    if (!page.title) return null;
    return `${page.title}.md`;
  }
}

module.exports = MetadataGardener;
