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
 * - Problem: Local models hallucinate wiki tool calls
 * - Pattern: Extract params → auto-categorize → guard → execute via ToolRegistry
 * - Key Dependencies: BaseExecutor, ToolRegistry (wiki_write/wiki_read handlers)
 * - Data Flow: message → extract → categorize → guard → toolRegistry.execute → confirm
 *
 * @module agent/executors/wiki-executor
 * @version 1.0.0
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
   * @param {Object} config.toolRegistry - ToolRegistry with wiki_write/wiki_read
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
   * @returns {Promise<string>} Confirmation text
   */
  async execute(message, context) {
    // Step 1: Extract parameters
    const dateContext = this._dateContext();
    const extractionPrompt = `${dateContext}

Extract wiki/knowledge operation parameters from this message. Return ONLY valid JSON, no other text.

Message: "${message.substring(0, 300)}"

Return JSON with these fields (use null for missing):
{"action": "write|read|append|remember", "topic": "main topic", "fact": "the fact to remember", "page_title": "explicit page title or null", "content": "explicit content or null", "parent": "parent section or null", "category": "keyword hint for categorization"}`;

    const params = await this._extractJSON(message, extractionPrompt);

    if (!params) {
      const err = new Error('Could not extract wiki parameters');
      err.code = 'DOMAIN_ESCALATE';
      throw err;
    }

    // Step 2: Auto-categorize into parent section
    const parent = params.parent || this._autoCategory(params.topic, params.category, params.fact);

    // Step 3: Determine page title and content
    const pageTitle = params.page_title || params.topic || 'Notes';
    let content = params.content || params.fact || '';

    // For "remember" actions, format as a knowledge entry
    if (params.action === 'remember' && params.fact) {
      content = params.fact;
    }

    // Step 4: Guardrail check
    const guardResult = await this._checkGuardrails('wiki_write', { page_title: pageTitle }, context.roomToken || null);
    if (!guardResult.allowed) {
      return `Action blocked: ${guardResult.reason}`;
    }

    // Step 5: Execute via ToolRegistry
    const writeResult = await this.toolRegistry.execute('wiki_write', {
      page_title: pageTitle,
      content,
      parent: parent || undefined,
      type: params.action === 'append' ? 'append' : 'create'
    });

    if (!writeResult.success) {
      return `Wiki write failed: ${writeResult.error}`;
    }

    // Layer 1: Log activity
    this._logActivity('wiki_write',
      `Updated wiki: ${pageTitle} — ${(content || '').substring(0, 80)}`,
      { page: pageTitle, topic: params.topic, category: parent },
      context
    );

    // Step 6: Confirm
    const parentInfo = parent ? ` under "${parent}"` : '';
    return `Saved to wiki: "${pageTitle}"${parentInfo}. ${writeResult.result || ''}`.trim();
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
