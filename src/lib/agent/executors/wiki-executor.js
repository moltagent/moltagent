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
   * @param {Object} [config.entityExtractor] - EntityExtractor for knowledge graph population
   */
  constructor(config = {}) {
    super(config);
    this.toolRegistry = config.toolRegistry;
    this.entityExtractor = config.entityExtractor || null;
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
        action: { type: 'string', enum: ['write', 'read', 'append', 'remember', 'introspect'] },
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

Action rules:
- "introspect" = structural/listing query with NO specific topic. Examples: "What's in your wiki?", "List your pages", "Show me your knowledge base"
- "read" = query about a SPECIFIC topic. Examples: "What do you know about Carlos?", "What do you know about reading documents?", "Tell me about the onboarding process"
- If the message mentions a topic ("about X", a name, a subject), use "read" with that topic — never "introspect"

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

    // Safety net: reclassify introspect → read when a topic is present.
    // Local models sometimes ignore prompt guidance and return introspect for topic queries.
    if (params.action === 'introspect' && (params.topic || params.page_title)) {
      params.action = 'read';
    }

    // Step 3: Route by action
    switch (params.action) {
      case 'write':
        return this._executeWrite(params, context);
      case 'append':
        return this._executeAppend(params, context);
      case 'remember':
        return this._executeRemember(params, context);
      case 'introspect':
        return this._executeIntrospect(context);
      case 'read':
      default:
        return this._executeRead(params, context, message);
    }
  }

  /**
   * Read a wiki page. Never writes.
   * Falls back to memory_search, then warmMemory synthesis if exact title not found.
   *
   * @param {Object} params - Extracted parameters
   * @param {Object} context - { userName, roomToken, warmMemory? }
   * @param {string} message - Original user message (for warmMemory synthesis prompt)
   * @returns {Promise<Object|string>}
   * @private
   */
  async _executeRead(params, context, message) {
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

    // Fallback: check if the enricher pre-populated warmMemory with related knowledge
    const synthesized = await this._synthesizeFromWarmMemory(title, message, context);
    if (synthesized) {
      return synthesized;
    }

    return { response: `I don't have anything about '${title}' in my knowledge yet.` };
  }

  /**
   * Synthesize an answer from enricher-provided warmMemory when no exact page was found.
   * Sends the warm knowledge + user question to the LLM and returns its response.
   *
   * @param {string} title - The topic the user asked about
   * @param {string} message - Original user message
   * @param {Object} context - Pipeline context (may contain warmMemory)
   * @returns {Promise<Object|null>} { response, actionRecord } or null if no warmMemory
   * @private
   */
  async _synthesizeFromWarmMemory(title, message, context) {
    const warm = context && context.warmMemory;
    if (!warm || typeof warm !== 'string' || !warm.includes('<agent_knowledge>')) {
      return null;
    }

    try {
      const synthesisPrompt = `You are a knowledgeable assistant. The user asked about "${title}".
No exact wiki page was found, but here is related knowledge from your memory:

${warm}

Answer the user's question based ONLY on the knowledge above.
If the knowledge doesn't answer the question, say so honestly.
Be concise and helpful.

User question: "${message.substring(0, 300)}"`;

      const result = await this.router.route({
        job: 'chat',
        content: synthesisPrompt,
        requirements: { maxTokens: 500, temperature: 0.3 }
      });

      const answer = (result.result || '').trim();
      if (!answer || answer.length < 10) return null;

      this._logActivity('wiki_read',
        `Synthesized answer for: ${title} (from warm memory)`,
        { topic: title, source: 'warm_memory' },
        context
      );

      return {
        response: answer,
        actionRecord: { type: 'wiki_read', refs: { topic: title, source: 'warm_memory' } }
      };
    } catch (err) {
      this.logger.warn(`[WikiExecutor] Warm memory synthesis failed: ${err.message}`);
      return null;
    }
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

    if (this.entityExtractor) {
      try {
        const pagePath = parent ? `${parent}/${pageTitle}` : pageTitle;
        await this.entityExtractor.extractFromPage(pagePath, content);
      } catch (err) {
        this.logger.warn(`[WikiExecutor] Entity extraction failed: ${err.message}`);
      }
    }

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

      if (this.entityExtractor) {
        try {
          const pagePath = parent ? `${parent}/${pageTitle}` : pageTitle;
          await this.entityExtractor.extractFromPage(pagePath, merged);
        } catch (err) {
          this.logger.warn(`[WikiExecutor] Entity extraction failed: ${err.message}`);
        }
      }

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
    const rawContent = params.fact || params.content || '';

    if (!rawContent) {
      return { response: 'What should I remember?' };
    }

    // Smart entity extraction: use LLM to derive proper entity name and structure
    const entityInfo = await this._extractEntityInfo(rawContent, params);
    const pageTitle = entityInfo.page_title || params.page_title || params.topic || 'Notes';
    const parent = entityInfo.section || params.parent || this._autoCategory(params.topic, params.category, params.fact);

    const guardResult = await this._checkGuardrails('wiki_write', { page_title: pageTitle }, context.roomToken || null);
    if (!guardResult.allowed) {
      return { response: `Action blocked: ${guardResult.reason}` };
    }

    // Format as structured knowledge page with frontmatter
    const formattedContent = this._formatKnowledgePage(pageTitle, entityInfo, rawContent);

    const writeResult = await this.toolRegistry.execute('wiki_write', {
      page_title: pageTitle,
      content: formattedContent,
      parent: parent || undefined,
      type: 'create'
    });

    if (!writeResult.success) {
      return { response: `Wiki write failed: ${writeResult.error || 'unknown error'}` };
    }

    // Fire entity extraction into knowledge graph (non-blocking)
    if (this.entityExtractor) {
      try {
        const pagePath = parent ? `${parent}/${pageTitle}` : pageTitle;
        await this.entityExtractor.extractFromPage(pagePath, formattedContent);
      } catch (err) {
        this.logger.warn(`[WikiExecutor] Entity extraction failed: ${err.message}`);
      }
    }

    this._logActivity('wiki_write',
      `Remembered: ${pageTitle} — ${rawContent.substring(0, 80)}`,
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
   * List wiki structure — answers "what's in your wiki?" queries.
   * Uses wiki_read with known section names and memory_search to enumerate pages.
   * @param {Object} context - { userName, roomToken }
   * @returns {Promise<Object>}
   * @private
   */
  async _executeIntrospect(context) { // eslint-disable-line no-unused-vars
    // Try to list pages via wiki_read for each well-known top-level section
    const sections = ['People', 'Projects', 'Decisions', 'Procedures', 'Preferences', 'Research', 'Notes', 'Sessions'];
    const found = [];

    for (const section of sections) {
      try {
        const result = await this.toolRegistry.execute('wiki_read', { page_title: section });
        if (result.success && this._isWikiContent(result.result)) {
          found.push({ name: section, hasContent: !!(result.result && result.result.trim()) });
        }
      } catch {
        // Section doesn't exist — skip
      }
    }

    // Also do a broad memory search to find individual pages
    let pageList = [];
    try {
      const searchResult = await this.toolRegistry.execute('memory_search', { query: '*', scope: 'wiki' });
      if (searchResult.success && searchResult.result && !searchResult.result.includes('No matching')) {
        // Extract page titles from search results (format: **PageTitle** [source])
        const matches = searchResult.result.matchAll(/\*\*([^*]+)\*\*/g);
        for (const m of matches) {
          pageList.push(m[1]);
        }
      }
    } catch {
      // Search unavailable — proceed with section listing only
    }

    if (found.length === 0 && pageList.length === 0) {
      return {
        response: 'My wiki is empty — no knowledge pages have been created yet.',
        actionRecord: { type: 'wiki_introspect', refs: { pageCount: 0 } }
      };
    }

    const parts = [];
    if (found.length > 0) {
      parts.push('**Wiki sections:**');
      for (const s of found) {
        parts.push(`- ${s.name}/`);
      }
    }

    if (pageList.length > 0) {
      parts.push('');
      parts.push('**Known pages:**');
      for (const p of pageList.slice(0, 20)) {
        parts.push(`- ${p}`);
      }
      if (pageList.length > 20) {
        parts.push(`... and ${pageList.length - 20} more`);
      }
    }

    const totalPages = pageList.length || found.length;
    return {
      response: `Here's what's in my knowledge wiki:\n\n${parts.join('\n')}`,
      actionRecord: { type: 'wiki_introspect', refs: { pageCount: totalPages } }
    };
  }

  /**
   * Extract entity information from a remember message using LLM.
   * Returns structured fields for proper page creation.
   * @param {string} content - The fact/content to remember
   * @param {Object} params - Already-extracted parameters
   * @returns {Promise<Object>} { page_title, section, entity_type, fields }
   * @private
   */
  async _extractEntityInfo(content, params) {
    const ENTITY_SCHEMA = {
      type: 'object',
      properties: {
        page_title: { type: 'string' },
        section: { type: 'string' },
        entity_type: { type: 'string' },
        fields: { type: 'object' }
      },
      required: ['page_title']
    };

    const prompt = `Extract the primary entity from this information to store in a wiki.

Rules:
- page_title MUST be the specific entity name (person name, company name, project name). NEVER generic words like "contacts", "notes", "info", "people".
- section: where this belongs — People, Projects, Research, Procedures, Decisions, or Notes. Default: Notes
- entity_type: person | company | project | decision | procedure | topic
- fields: key-value pairs from the content. For a person: { name, email, company, role, context }. For a company: { name, domain, contacts, description }. For a project: { name, status, description }. Only include fields that are explicitly stated.

Examples:
- "Carlos from TheCatalyne, email carlos@thecatalyne.com" → page_title: "Carlos", section: "People", entity_type: "person", fields: { name: "Carlos", company: "TheCatalyne", email: "carlos@thecatalyne.com" }
- "Project X is our Q3 initiative for automation" → page_title: "Project X", section: "Projects", entity_type: "project", fields: { name: "Project X", description: "Q3 initiative for automation" }

Content: "${content.substring(0, 500)}"`;

    try {
      const result = await this._extractJSON(content, prompt, ENTITY_SCHEMA);
      if (result && result.page_title && result.page_title.length >= 2) {
        return result;
      }
    } catch (err) {
      this.logger.warn(`[WikiExecutor] Entity info extraction failed: ${err.message}`);
    }

    // Fallback: use existing params
    return {
      page_title: params.page_title || params.topic || null,
      section: null,
      entity_type: 'note',
      fields: {}
    };
  }

  /**
   * Format a wiki page with frontmatter and structured content.
   * @param {string} title - Page title
   * @param {Object} entityInfo - { entity_type, fields }
   * @param {string} rawContent - Original content from user
   * @returns {string} Formatted markdown page
   * @private
   */
  _formatKnowledgePage(title, entityInfo, rawContent) {
    const lines = [
      '---',
      `type: ${entityInfo.entity_type || 'note'}`,
      `confidence: medium`,
      `last_verified: ${new Date().toISOString().split('T')[0]}`,
      `created_by: conversation`,
    ];

    // Add structured fields to frontmatter
    if (entityInfo.fields && typeof entityInfo.fields === 'object') {
      for (const [key, value] of Object.entries(entityInfo.fields)) {
        if (value && key !== 'name') {
          lines.push(`${key}: ${String(value).replace(/\n/g, ' ')}`);
        }
      }
    }

    lines.push('---');
    lines.push('');
    lines.push(`# ${title}`);
    lines.push('');
    lines.push(rawContent);

    return lines.join('\n');
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
