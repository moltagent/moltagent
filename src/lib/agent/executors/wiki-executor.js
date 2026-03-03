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
 * WikiExecutor — Parameter-extraction executor for wiki/knowledge operations.
 *
 * Architecture Brief:
 * - Problem: Local models hallucinate wiki tool calls; read queries triggered wiki_write
 * - Pattern: Extract params → route by action → guard → execute via ToolRegistry
 * - Key Dependencies: BaseExecutor, ToolRegistry (wiki_write/wiki_read/memory_search)
 * - Data Flow: message → extract → action switch → categorize/guard → toolRegistry.execute → confirm
 *
 * @module agent/executors/wiki-executor
 * @version 2.0.0
 */

const BaseExecutor = require('./base-executor');

// Auto-categorization map: keyword → parent section
const CATEGORY_MAP = {
  person: 'People',
  people: 'People',
  contact: 'People',
  team: 'People',
  colleague: 'People',
  project: 'Projects',
  initiative: 'Projects',
  product: 'Products',
  process: 'Processes',
  workflow: 'Processes',
  procedure: 'Processes',
  meeting: 'Meetings',
  decision: 'Decisions',
  policy: 'Policies',
  tool: 'Tools',
  software: 'Tools',
  preference: 'Preferences',
  setting: 'Preferences'
};

class WikiExecutor extends BaseExecutor {
  /**
   * @param {Object} config - BaseExecutor config + toolRegistry
   * @param {Object} config.toolRegistry - ToolRegistry with wiki_write/wiki_read/memory_search
   */
  constructor(config = {}) {
    super(config);
    this.toolRegistry = config.toolRegistry;
  }

  /**
   * Execute a wiki operation from a natural language message.
   *
   * @param {string} message - User message
   * @param {Object} context - { userName, roomToken }
   * @returns {Promise<Object|string>} { response, actionRecord } or clarification string
   */
  async execute(message, context) {
    // Step 1: Extract parameters
    const dateContext = this._dateContext();
    const WIKI_SCHEMA = {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['write', 'read', 'append', 'remember'] },
        topic: { type: 'string' },
        fact: { type: 'string' },
        page_title: { type: 'string' },
        content: { type: 'string' },
        parent: { type: 'string' },
        category: { type: 'string' },
        requires_clarification: { type: 'boolean' },
        missing_fields: { type: 'array', items: { type: 'string' } }
      },
      required: ['action']
    };

    const extractionPrompt = `${dateContext}

Extract wiki/knowledge operation parameters from this message.
Leave fields as empty strings if not mentioned. Do NOT guess values.
If the message is NOT about wiki/knowledge, set requires_clarification to true.

Message: "${message.substring(0, 300)}"`;

    const params = await this._extractJSON(message, extractionPrompt, WIKI_SCHEMA);

    if (!params) {
      const err = new Error('Could not extract wiki parameters');
      err.code = 'DOMAIN_ESCALATE';
      throw err;
    }

    // Step 2: Validation gates
    if (params.requires_clarification) {
      const missingFields = Array.isArray(params.missing_fields) && params.missing_fields.length > 0
        ? params.missing_fields
        : ['details'];
      return {
        response: `Could you clarify: ${missingFields.join(', ')}?`,
        pendingClarification: {
          executor: 'wiki', action: params.action || 'read',
          missingFields,
          collectedFields: { topic: params.topic, fact: params.fact, page_title: params.page_title, content: params.content, parent: params.parent },
          originalMessage: message,
        }
      };
    }

    // Step 3: Route by action
    switch (params.action) {
      case 'write':
        return this._executeWrite(params, context);
      case 'append':
        return this._executeAppend(params, context);
      case 'remember':
        return this._executeRemember(params, context);
      case 'read':
      default:
        return this._executeRead(params, context);
    }
  }

  /**
   * Read a wiki page. Never writes.
   * Falls back to memory_search if exact title not found.
   *
   * @param {Object} params - Extracted parameters
   * @param {Object} context - { userName, roomToken }
   * @returns {Promise<Object|string>}
   * @private
   */
  async _executeRead(params, context) {
    const title = params.page_title || params.topic;

    if (!title) {
      return { response: 'What wiki page should I look up?' };
    }

    // Build candidate titles: original + possessive-stripped variant
    // "Funana's Preferences" → also try "Funana Preferences"
    const stripped = title.replace(/['\u2019]s\b/g, '');
    const candidates = stripped !== title ? [title, stripped] : [title];

    // Try direct page fetch for each candidate
    for (const candidate of candidates) {
      const readResult = await this.toolRegistry.execute('wiki_read', { page_title: candidate });
      if (readResult.success && this._isWikiContent(readResult.result)) {
        this._logActivity('wiki_read',
          `Read wiki: ${candidate}`,
          { page: candidate, topic: params.topic },
          context
        );
        const response = readResult.result || `The wiki page "${candidate}" exists but has no content yet.`;
        return {
          response,
          actionRecord: { type: 'wiki_read', refs: { page: candidate } }
        };
      }
    }

    // Fallback: search via memory_search for fuzzy match
    const memoryHit = await this._searchViaMemory(title);
    if (memoryHit) {
      const retryResult = await this.toolRegistry.execute('wiki_read', { page_title: memoryHit.title });
      if (retryResult.success && this._isWikiContent(retryResult.result)) {
        this._logActivity('wiki_read',
          `Read wiki: ${memoryHit.title} (searched for: ${title})`,
          { page: memoryHit.title, originalQuery: title },
          context
        );
        const response = retryResult.result || `The wiki page "${memoryHit.title}" exists but has no content yet.`;
        return {
          response,
          actionRecord: { type: 'wiki_read', refs: { page: memoryHit.title } }
        };
      }
    }

    return { response: `I don't have a wiki page about '${title}'.` };
  }

  /**
   * Write a new wiki page.
   *
   * @param {Object} params - Extracted parameters
   * @param {Object} context - { userName, roomToken }
   * @returns {Promise<Object|string>}
   * @private
   */
  async _executeWrite(params, context) {
    const pageTitle = params.page_title || params.topic;
    const content = params.content || params.fact || '';

    if (!pageTitle || !content) {
      const missing = [];
      if (!pageTitle) missing.push('page title');
      if (!content) missing.push('content');
      return { response: `Could you clarify: ${missing.join(', ')}?` };
    }

    const parent = params.parent || this._autoCategory(params.topic, params.category, params.fact);

    // Guardrail check
    const guardResult = await this._checkGuardrails('wiki_write', { page_title: pageTitle }, context.roomToken || null);
    if (!guardResult.allowed) {
      return { response: `Action blocked: ${guardResult.reason}` };
    }

    const writeResult = await this.toolRegistry.execute('wiki_write', {
      page_title: pageTitle,
      content,
      parent: parent || undefined,
      type: 'create'
    });

    if (!writeResult.success) {
      return { response: `Wiki write failed: ${writeResult.error || 'unknown error'}` };
    }

    this._logActivity('wiki_write',
      `Created wiki: ${pageTitle} — ${content.substring(0, 80)}`,
      { page: pageTitle, topic: params.topic, category: parent },
      context
    );

    const parentInfo = parent ? ` under "${parent}"` : '';
    const response = `Saved to wiki: "${pageTitle}"${parentInfo}. ${writeResult.result || ''}`.trim();
    return {
      response,
      actionRecord: { type: 'wiki_write', refs: { pageTitle, parent: parent || null } }
    };
  }

  /**
   * Append content to an existing wiki page, or create if it doesn't exist.
   *
   * @param {Object} params - Extracted parameters
   * @param {Object} context - { userName, roomToken }
   * @returns {Promise<Object|string>}
   * @private
   */
  async _executeAppend(params, context) {
    const pageTitle = params.page_title || params.topic;
    const newContent = params.content || params.fact || '';

    if (!pageTitle || !newContent) {
      const missing = [];
      if (!pageTitle) missing.push('page title');
      if (!newContent) missing.push('content to append');
      return { response: `Could you clarify: ${missing.join(', ')}?` };
    }

    // Read existing page
    const readResult = await this.toolRegistry.execute('wiki_read', { page_title: pageTitle });

    if (readResult.success && this._isWikiContent(readResult.result)) {
      // Append to existing (if page is empty, just use new content)
      const merged = readResult.result ? readResult.result + '\n\n' + newContent : newContent;

      const parent = params.parent || this._autoCategory(params.topic, params.category, params.fact);

      const guardResult = await this._checkGuardrails('wiki_write', { page_title: pageTitle }, context.roomToken || null);
      if (!guardResult.allowed) {
        return { response: `Action blocked: ${guardResult.reason}` };
      }

      // type: 'create' is correct — append is handled at executor level (read + merge + write)
      const writeResult = await this.toolRegistry.execute('wiki_write', {
        page_title: pageTitle,
        content: merged,
        parent: parent || undefined,
        type: 'create'
      });

      if (!writeResult.success) {
        return { response: `Wiki append failed: ${writeResult.error || 'unknown error'}` };
      }

      this._logActivity('wiki_write',
        `Appended to wiki: ${pageTitle} — ${newContent.substring(0, 80)}`,
        { page: pageTitle, topic: params.topic, appended: true },
        context
      );

      return {
        response: `Appended to wiki page "${pageTitle}". ${writeResult.result || ''}`.trim(),
        actionRecord: { type: 'wiki_write', refs: { pageTitle, appended: true } }
      };
    }

    // Page doesn't exist — delegate to write (create new)
    return this._executeWrite({ ...params, content: newContent }, context);
  }

  /**
   * Remember a fact — proactive knowledge path.
   *
   * @param {Object} params - Extracted parameters
   * @param {Object} context - { userName, roomToken }
   * @returns {Promise<Object|string>}
   * @private
   */
  async _executeRemember(params, context) {
    const pageTitle = params.page_title || params.topic || 'Notes';
    const content = params.fact || params.content || '';

    if (!content) {
      return { response: 'What should I remember?' };
    }

    const parent = params.parent || this._autoCategory(params.topic, params.category, params.fact);

    const guardResult = await this._checkGuardrails('wiki_write', { page_title: pageTitle }, context.roomToken || null);
    if (!guardResult.allowed) {
      return { response: `Action blocked: ${guardResult.reason}` };
    }

    const writeResult = await this.toolRegistry.execute('wiki_write', {
      page_title: pageTitle,
      content,
      parent: parent || undefined,
      type: 'create'
    });

    if (!writeResult.success) {
      return { response: `Wiki write failed: ${writeResult.error || 'unknown error'}` };
    }

    this._logActivity('wiki_write',
      `Remembered: ${pageTitle} — ${content.substring(0, 80)}`,
      { page: pageTitle, topic: params.topic, category: parent },
      context
    );

    const parentInfo = parent ? ` under "${parent}"` : '';
    const response = `Saved to wiki: "${pageTitle}"${parentInfo}. ${writeResult.result || ''}`.trim();
    return {
      response,
      actionRecord: { type: 'wiki_write', refs: { pageTitle, parent: parent || null } }
    };
  }

  /**
   * Check if a wiki_read result represents actual page content (including empty pages)
   * vs a "not found" or error message.
   *
   * @param {string} result - wiki_read result string
   * @returns {boolean} true if the page was found (even if empty)
   * @private
   */
  _isWikiContent(result) {
    // null/undefined = tool failure
    if (result == null) return false;
    // These prefixes indicate the page doesn't exist or the service is down
    if (typeof result === 'string') {
      if (result.startsWith('No wiki page found')) return false;
      if (result.startsWith('Wiki service is temporarily unavailable')) return false;
      if (result.startsWith('Failed to read wiki page')) return false;
    }
    // Empty string = page exists but has no content — still a valid find
    return true;
  }

  /**
   * Search for a wiki page via memory_search fallback.
   *
   * @param {string} query - Search query
   * @returns {Promise<{title: string}|null>}
   * @private
   */
  async _searchViaMemory(query) {
    // Strip possessives — "Funana's Preferences" → "Funana Preferences"
    // NC Unified Search tokenizer chokes on apostrophe-s
    const cleaned = query.replace(/['\u2019]s\b/g, '');
    const queries = cleaned !== query ? [cleaned, query] : [query];

    for (const q of queries) {
      try {
        const result = await this.toolRegistry.execute('memory_search', { query: q, scope: 'wiki' });
        if (!result.success || !result.result || result.result.includes('No matching memories')) continue;
        const match = result.result.match(/\*\*([^*]+)\*\*/);
        if (match) return { title: match[1] };
      } catch {
        // Continue to next query variant
      }
    }
    return null;
  }

  /**
   * Auto-categorize a topic into a parent section.
   * @param {string} [topic] - Topic string
   * @param {string} [category] - Category hint
   * @param {string} [fact] - Fact content for keyword matching
   * @returns {string|null} Parent section name or null
   * @private
   */
  _autoCategory(topic, category, fact) {
    const searchText = [topic, category, fact].filter(Boolean).join(' ').toLowerCase();

    for (const [keyword, section] of Object.entries(CATEGORY_MAP)) {
      if (searchText.includes(keyword)) {
        return section;
      }
    }

    return null;
  }
}

module.exports = WikiExecutor;
