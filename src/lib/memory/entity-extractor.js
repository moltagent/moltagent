/*
 * MoltAgent - Sovereign AI Security Layer
 * Copyright (C) 2026 MoltAgent Contributors
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU Affero General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 */

'use strict';

/**
 * EntityExtractor — Two-mode entity extraction from wiki page content.
 *
 * Architecture Brief:
 * - Problem: Knowledge graph needs entities and relationships extracted from text
 * - Pattern: Lightweight regex extraction always runs; deep LLM extraction for substantial content
 * - Key Dependencies: KnowledgeGraph (sink), LLMRouter (deep extraction)
 * - Data Flow: page content → lightweight regex → (optional) deep LLM → knowledge graph
 * - Dependency Map: heartbeat-extractor.js → entity-extractor.js → knowledge-graph.js
 *
 * @module memory/entity-extractor
 * @version 1.0.0
 */

const DEEP_THRESHOLD = 500;       // chars required for deep LLM extraction
const MAX_CONTENT_FOR_LLM = 2000; // truncate content sent to LLM

class EntityExtractor {
  /**
   * @param {Object} deps
   * @param {Object} deps.knowledgeGraph - KnowledgeGraph instance with addEntity() and addTriple()
   * @param {Object} [deps.llmRouter]    - LLMRouter for deep extraction (optional)
   * @param {Object} [deps.logger]       - Logger instance (defaults to console)
   */
  constructor({ knowledgeGraph, llmRouter, logger } = {}) {
    if (!knowledgeGraph) throw new Error('EntityExtractor requires knowledgeGraph');
    this.graph = knowledgeGraph;
    this.router = llmRouter || null;
    this.logger = logger || console;
    this._stats = { lightweight: 0, deep: 0, entities: 0, triples: 0 };
  }

  // ===========================================================================
  // Public API
  // ===========================================================================

  /**
   * Extract entities and relationships from a wiki page, then load them into
   * the knowledge graph.  Lightweight regex extraction always runs; deep LLM
   * extraction only runs when content is >= DEEP_THRESHOLD chars and an LLM
   * router is available.
   *
   * @param {string} title   - Wiki page title / path (e.g. "People/Sarah Chen")
   * @param {string} content - Raw page content (markdown or plain text)
   * @returns {Promise<void>}
   */
  async extractFromPage(title, content) {
    if (!title || typeof title !== 'string') return;

    const safeContent = content || '';

    // Lightweight extraction always runs
    this._lightweightExtract(title, safeContent);

    // Deep LLM extraction is optional — only for substantial content
    if (safeContent.length >= DEEP_THRESHOLD && this.router) {
      await this._deepExtract(title, safeContent);
    }
  }

  // ===========================================================================
  // Internal extraction modes
  // ===========================================================================

  /**
   * Regex-based entity extraction.  Runs synchronously; never throws.
   *
   * Steps:
   *  1. Parse the title to derive a typed source entity (e.g. People/Sarah Chen → person)
   *  2. Scan for capitalised name pairs (e.g. "Sarah Chen") and register as persons
   *  3. Scan for wikilinks ([[Target Page]]) and create "references" triples
   *
   * @param {string} title
   * @param {string} content
   * @private
   */
  _lightweightExtract(title, content) {
    this._stats.lightweight++;

    // -------------------------------------------------------------------------
    // Step 1: Resolve source entity from page title / path
    // -------------------------------------------------------------------------
    const parts = title.split('/');
    let sourceId;

    if (parts.length >= 2) {
      const category = parts[parts.length - 2].toLowerCase();
      const name = parts[parts.length - 1];

      // Map known path segments to semantic types
      const typeMap = {
        people: 'person',
        projects: 'project',
        procedures: 'procedure',
        research: 'research',
        decisions: 'decision',
      };
      const type = typeMap[category] || 'page';

      sourceId = this.graph.addEntity(name, type);
    } else {
      sourceId = this.graph.addEntity(title, 'page');
    }

    // -------------------------------------------------------------------------
    // Step 2: Capitalised name pairs (e.g. "Sarah Chen", "Project Phoenix")
    // -------------------------------------------------------------------------
    const namePattern = /\b[A-Z][a-z]+ [A-Z][a-z]+\b/g;
    let nameMatch;
    while ((nameMatch = namePattern.exec(content)) !== null) {
      this.graph.addEntity(nameMatch[0], 'person');
      this._stats.entities++;
    }

    // -------------------------------------------------------------------------
    // Step 3: Wikilinks [[Target Page]] → "references" triple from source
    // -------------------------------------------------------------------------
    const wikilinkPattern = /\[\[([^\]]+)\]\]/g;
    let wikiMatch;
    while ((wikiMatch = wikilinkPattern.exec(content)) !== null) {
      const target = wikiMatch[1];
      const targetId = this.graph.addEntity(target, 'page');
      this.graph.addTriple(sourceId, 'references', targetId);
      this._stats.triples++;
    }
  }

  /**
   * LLM-based deep entity and relationship extraction.
   * Truncates content to MAX_CONTENT_FOR_LLM before sending.
   * Failures are caught and logged; they do not propagate to the caller.
   *
   * @param {string} title
   * @param {string} content
   * @returns {Promise<void>}
   * @private
   */
  async _deepExtract(title, content) {
    this._stats.deep++;

    const truncated = content.slice(0, MAX_CONTENT_FOR_LLM);

    const prompt = `Extract entities and relationships from this wiki page.
Page title: ${title}

Content:
${truncated}

Respond ONLY with JSON:
{
  "entities": [{"name": "...", "type": "person|project|organization|tool|concept"}],
  "relationships": [{"from": "...", "predicate": "...", "to": "..."}]
}

ENTITY rules:
- Each entity should appear ONLY ONCE with its most accurate type
- "Project Phoenix" is a project, not a person. Only use "person" for actual people (e.g. "Fu", "Sarah", "Carlos")
- When in doubt, prefer the more specific type (project, organization, tool) over "person"
- Type must be one of: person, project, organization, tool, concept

RELATIONSHIP rules:
- Extract relationships that are explicitly stated in the text
- Predicates: leads, led_by, managed_by, works_on, works_at, reports_to, belongs_to, employed_by, affiliated_with, client_of, contacts, contact_for, responsible_for, depends_on, related_to, has_goal, has_status, blocks
- "led by Fu" → {"from": "Project Phoenix", "predicate": "led_by", "to": "Fu"}
- "works at TheCatalyne" → {"from": "Sarah", "predicate": "works_at", "to": "TheCatalyne"}
- Do NOT infer relationships that aren't clearly stated

If nothing worth extracting, respond: {"entities":[],"relationships":[]}`;

    try {
      const rawResponse = await this.router.route({
        job: 'quick',
        content: prompt,
        requirements: { maxTokens: 500, role: 'sovereign' },
      });

      const parsed = this._parseJson(rawResponse.result || rawResponse);
      if (!parsed) return;

      // Register entities from the LLM response
      if (Array.isArray(parsed.entities)) {
        for (const entity of parsed.entities) {
          if (!entity || !entity.name) continue;
          this.graph.addEntity(entity.name, entity.type || 'concept');
          this._stats.entities++;
        }
      }

      // Register relationships as triples
      if (Array.isArray(parsed.relationships)) {
        for (const rel of parsed.relationships) {
          if (!rel || !rel.from || !rel.to || !rel.predicate) continue;
          // Ensure both endpoint entities exist in the graph before linking
          const fromId = this.graph.addEntity(rel.from, 'concept');
          const toId = this.graph.addEntity(rel.to, 'concept');
          this.graph.addTriple(fromId, rel.predicate, toId);
          this._stats.triples++;
        }
      }
    } catch (err) {
      // Deep extraction is best-effort — never block the caller
      this.logger.warn(`[EntityExtractor] Deep extraction failed: ${err.message}`);
    }
  }

  // ===========================================================================
  // Helpers
  // ===========================================================================

  /**
   * Parse JSON from an LLM response string, stripping markdown code fences
   * and any preamble text before the opening brace.
   *
   * @param {string|*} response
   * @returns {Object|null}
   * @private
   */
  _parseJson(response) {
    if (!response) return null;
    let text = typeof response === 'string' ? response : String(response);
    text = text.trim();
    text = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '');
    const first = text.indexOf('{');
    const last = text.lastIndexOf('}');
    if (first === -1 || last === -1) return null;
    try {
      return JSON.parse(text.slice(first, last + 1));
    } catch (_e) {
      return null;
    }
  }

  /**
   * Backfill the knowledge graph from all existing wiki pages.
   * Requires a collectivesClient to list and read pages.
   * Skips Meta/ pages and stubs (< 50 chars).
   * Flushes the graph after processing.
   *
   * @param {Object} collectivesClient - CollectivesClient instance
   * @returns {Promise<{ processed: number, failed: number }>}
   */
  async backfillAll(collectivesClient) {
    if (!collectivesClient) {
      this.logger.warn('[EntityExtractor] backfillAll requires collectivesClient');
      return { processed: 0, failed: 0 };
    }

    let processed = 0;
    let failed = 0;

    try {
      const collectiveId = await collectivesClient.resolveCollective();
      const pages = await collectivesClient.listPages(collectiveId);

      for (const page of pages) {
        const path = page.filePath || page.title || '';
        if (path.includes('/Meta') || path.includes('Meta/') || path === 'Meta') continue;

        try {
          const pagePath = this._buildPagePath(page);
          if (!pagePath) continue;
          const content = await collectivesClient.readPageContent(pagePath);
          if (!content || content.length < 50) continue;

          await this.extractFromPage(pagePath, content);
          processed++;
        } catch (err) {
          this.logger.warn(
            `[EntityExtractor] Backfill failed for ${page.title}: ${err.message}`
          );
          failed++;
        }
      }
    } catch (err) {
      this.logger.error(`[EntityExtractor] Backfill aborted: ${err.message}`);
    }

    this.logger.info(
      `[EntityExtractor] Backfill complete: ${processed} pages, ${failed} failed`
    );

    // Flush graph immediately after backfill
    try {
      await this.graph.flush();
    } catch (err) {
      this.logger.warn(`[EntityExtractor] Post-backfill flush failed: ${err.message}`);
    }

    return { processed, failed };
  }

  /**
   * Build a WebDAV-compatible page path from a Collectives page object.
   * Uses filePath/fileName pattern matching CollectivesClient._buildPagePath().
   * @param {Object} page - Page object from listPages()
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

  /**
   * Return a snapshot of internal counters for monitoring.
   *
   * @returns {{ lightweight: number, deep: number, entities: number, triples: number }}
   */
  getStats() {
    return { ...this._stats };
  }
}

module.exports = EntityExtractor;
