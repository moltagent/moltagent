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

const { serializeFrontmatter } = require('../knowledge/frontmatter');
const ollamaGate = require('../shared/ollama-gate');

/**
 * HeartbeatExtractor — Layer 2 of the Two-Layer Memory System.
 *
 * Architecture Brief:
 * - Problem: Raw activity logs are not searchable knowledge
 * - Pattern: Periodic local LLM extraction → structured wiki pages
 * - Key Dependencies: ActivityLogger (source), CollectivesClient (sink), LLMRouter (extraction)
 * - Data Flow: heartbeat → read unprocessed entries → LLM extract → write wiki → mark processed
 * - Dependency Map: heartbeat-manager.js → heartbeat-extractor.js → collectives-client.js
 *
 * @module memory/heartbeat-extractor
 * @version 1.0.0
 */

class HeartbeatExtractor {
  /**
   * @param {Object} deps
   * @param {Object} deps.activityLogger - Layer 1 source (ActivityLogger)
   * @param {Object} deps.wikiClient - CollectivesClient for writing extracted knowledge
   * @param {Object} deps.llmRouter - LLMRouter for local LLM extraction
   * @param {Object} [deps.memorySearcher] - MemorySearcher to invalidate cache after writes
   * @param {Object} [deps.logger]
   */
  constructor({ activityLogger, wikiClient, llmRouter, memorySearcher, logger } = {}) {
    if (!activityLogger) throw new Error('HeartbeatExtractor requires activityLogger');
    if (!wikiClient) throw new Error('HeartbeatExtractor requires wikiClient');
    if (!llmRouter) throw new Error('HeartbeatExtractor requires llmRouter');
    this.activityLog = activityLogger;
    this.wiki = wikiClient;
    this.router = llmRouter;
    this.memory = memorySearcher || null;
    this.entityExtractor = null; // Late-bound: set by bot.js wiring
    this.logger = logger || console;
    this._lastExtraction = 0;
    this._minEntries = 3;
    this._extractionCooldown = 300000; // 5 minutes
    this._stats = { extractions: 0, entriesProcessed: 0, writesAttempted: 0 };
  }

  /**
   * Called by HeartbeatManager on every pulse.
   * Checks if there are enough unprocessed entries, extracts knowledge.
   */
  async tick() {
    // Cooldown check
    if (Date.now() - this._lastExtraction < this._extractionCooldown) {
      return;
    }

    // Flush any buffered entries first
    await this.activityLog.flush();

    // Get unprocessed entries
    const entries = this.activityLog.getUnprocessedEntries();

    if (entries.length < this._minEntries) {
      return; // Not enough to extract from
    }

    this.logger.info(
      `[HeartbeatExtractor] Processing ${entries.length} activity entries`
    );

    try {
      await this._extractKnowledge(entries);
      this.activityLog.markProcessed(entries.length);
      this._lastExtraction = Date.now();
      this._stats.extractions++;
      this._stats.entriesProcessed += entries.length;
    } catch (err) {
      this.logger.error(`[HeartbeatExtractor] Extraction failed: ${err.message}`);
      // Entries stay unprocessed for next attempt
    }
  }

  /**
   * Use local LLM to extract structured knowledge from activity entries.
   * @param {Array} entries - Unprocessed activity log entries
   * @private
   */
  async _extractKnowledge(entries) {
    const logText = entries.map(e =>
      `${e.time} | ${e.action} | ${e.summary} | user: ${e.user}`
    ).join('\n');

    const prompt = `Review these recent activity log entries from a Nextcloud AI assistant.
Extract any valuable knowledge. Respond ONLY with a JSON object.

Activity Log:
${logText}

Extract into these categories (omit empty categories):
{
  "people": [{"name": "...", "fact": "..."}],
  "decisions": [{"topic": "...", "decision": "..."}],
  "preferences": [{"who": "...", "preference": "..."}],
  "gaps": [{"topic": "...", "context": "why it was needed"}]
}

Rules:
- Only extract genuinely useful facts, not routine operations
- "Created event X" is routine — don't extract
- "User prefers mornings before 11am" IS useful — extract as preference
- "Searched for Project Phoenix, found nothing" IS useful — extract as gap
- If nothing worth extracting, respond: {"nothing": true}`;

    const MEMORY_SCHEMA = {
      type: 'object',
      properties: {
        people: { type: 'array', items: { type: 'object', properties: { name: { type: 'string' }, fact: { type: 'string' } }, required: ['name', 'fact'] } },
        decisions: { type: 'array', items: { type: 'object', properties: { topic: { type: 'string' }, decision: { type: 'string' } }, required: ['topic', 'decision'] } },
        preferences: { type: 'array', items: { type: 'object', properties: { who: { type: 'string' }, preference: { type: 'string' } }, required: ['who', 'preference'] } },
        gaps: { type: 'array', items: { type: 'object', properties: { topic: { type: 'string' }, context: { type: 'string' } }, required: ['topic', 'context'] } },
        nothing: { type: 'boolean' }
      },
      required: []
    };

    // Yield to user messages — don't block Ollama when user is waiting
    if (ollamaGate.isUserActive()) {
      return;
    }

    const rawResponse = await this.router.route({
      job: 'synthesis',
      content: prompt,
      requirements: { maxTokens: 500, format: MEMORY_SCHEMA }
    });

    const extracted = this._parseJson(rawResponse.result || rawResponse);

    if (!extracted || extracted.nothing) {
      this.logger.info('[HeartbeatExtractor] Nothing worth extracting');
      return;
    }

    await this._writeExtractedKnowledge(extracted);
  }

  /**
   * Write extracted knowledge to appropriate wiki pages.
   * @param {Object} extracted - Parsed extraction result
   * @private
   */
  async _writeExtractedKnowledge(extracted) {
    let writesAttempted = 0;
    const dateTag = new Date().toISOString().slice(0, 10);

    // People facts → People/ pages
    if (Array.isArray(extracted.people)) {
      for (const person of extracted.people) {
        if (!person.name || !person.fact) continue;
        try {
          await this._appendToWikiPage(
            `People/${person.name.replace(/[^a-zA-Z0-9 ]/g, '')}`,
            `- ${person.fact} _(${dateTag})_`,
            'person'
          );
          writesAttempted++;
        } catch (err) {
          this.logger.error(`[HeartbeatExtractor] People write failed: ${err.message}`);
        }
      }
    }

    // Preferences → People/ page or General/Preferences
    if (Array.isArray(extracted.preferences)) {
      for (const pref of extracted.preferences) {
        if (!pref.preference) continue;
        try {
          const page = pref.who
            ? `People/${pref.who.replace(/[^a-zA-Z0-9 ]/g, '')}`
            : 'General/Preferences';
          await this._appendToWikiPage(
            page,
            `- **Preference:** ${pref.preference} _(${dateTag})_`,
            'preference'
          );
          writesAttempted++;
        } catch (err) {
          this.logger.error(`[HeartbeatExtractor] Preference write failed: ${err.message}`);
        }
      }
    }

    // Decisions → Decisions Index
    if (Array.isArray(extracted.decisions)) {
      for (const dec of extracted.decisions) {
        if (!dec.topic || !dec.decision) continue;
        try {
          await this._appendToWikiPage(
            'Decisions Index',
            `- **${dec.topic}:** ${dec.decision} _(${dateTag})_`,
            'decision'
          );
          writesAttempted++;
        } catch (err) {
          this.logger.error(`[HeartbeatExtractor] Decision write failed: ${err.message}`);
        }
      }
    }

    // Knowledge gaps → Meta/Pending Questions
    if (Array.isArray(extracted.gaps)) {
      for (const gap of extracted.gaps) {
        if (!gap.topic) continue;
        try {
          await this._appendToWikiPage(
            'Meta/Pending Questions',
            `- **${gap.topic}** — ${gap.context || 'no context'} _(${dateTag})_`,
            'gap'
          );
          writesAttempted++;
        } catch (err) {
          this.logger.error(`[HeartbeatExtractor] Gap write failed: ${err.message}`);
        }
      }
    }



    // Entity extraction: read actual page content for knowledge graph
    if (writesAttempted > 0 && this.entityExtractor) {
      const pagePaths = [];
      if (Array.isArray(extracted.people)) {
        for (const p of extracted.people) {
          if (p.name) pagePaths.push(`People/${p.name.replace(/[^a-zA-Z0-9 ]/g, '')}`);
        }
      }
      if (Array.isArray(extracted.preferences)) {
        for (const pref of extracted.preferences) {
          const page = pref.who
            ? `People/${pref.who.replace(/[^a-zA-Z0-9 ]/g, '')}`
            : 'General/Preferences';
          if (!pagePaths.includes(page)) pagePaths.push(page);
        }
      }
      if (Array.isArray(extracted.decisions)) pagePaths.push('Decisions Index');
      if (Array.isArray(extracted.gaps)) pagePaths.push('Meta/Pending Questions');
      for (const path of pagePaths) {
        try {
          const pageContent = await this.wiki.readPageContent(path) || '';
          await this.entityExtractor.extractFromPage(path, pageContent);
        } catch (_err) { /* non-blocking — graph enrichment is best-effort */ }
      }
    }

    this._stats.writesAttempted += writesAttempted;
    this.logger.info(
      `[HeartbeatExtractor] Extracted and wrote ${writesAttempted} knowledge entries`
    );
  }

  /**
   * Append content to a wiki page, creating it with biological frontmatter if needed.
   * @param {string} pagePath - Wiki page path
   * @param {string} content - Markdown line to append
   * @param {string} [category] - Knowledge category for decay defaults (person, decision, etc.)
   * @private
   */
  async _appendToWikiPage(pagePath, content, category) {
    let existing = '';
    let isNewPage = false;
    try {
      const page = await this.wiki.readPageContent(pagePath);
      if (page) {
        existing = page;
      } else {
        isNewPage = true;
      }
    } catch (_e) {
      isNewPage = true;
    }

    if (isNewPage) {
      // Create with biological frontmatter and header
      const title = pagePath.split('/').pop();
      const now = new Date().toISOString();
      const fm = {
        type: category || 'unknown',
        created: now,
        last_updated: now,
        confidence: 'medium',
        decay_days: this._defaultDecayForType(category),
        access_count: 0,
      };
      existing = serializeFrontmatter(fm, `# ${title}\n\n`);
    }

    // Ensure trailing newline before appending
    if (existing && !existing.endsWith('\n')) {
      existing += '\n';
    }

    await this.wiki.writePageContent(pagePath, existing + content + '\n');
  }

  /**
   * Default decay period by knowledge type. Different types age at different rates.
   * @param {string} type - Knowledge category
   * @returns {number} Decay days
   * @private
   */
  _defaultDecayForType(type) {
    const defaults = {
      person: 90,
      decision: 180,
      preference: 365,
      project: 60,
      procedure: 180,
      gap: 30,
    };
    return defaults[type] || 90;
  }

  /**
   * Parse JSON from LLM response, stripping markdown fences.
   * @param {string} response
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
   * Get extraction stats.
   * @returns {Object}
   */
  getStats() {
    return { ...this._stats };
  }
}

module.exports = { HeartbeatExtractor };
