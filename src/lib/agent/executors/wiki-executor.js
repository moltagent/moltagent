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
          executor: 'wiki', action: params.action || 'write',
          missingFields,
          collectedFields: { topic: params.topic, fact: params.fact, page_title: params.page_title, content: params.content, parent: params.parent },
          originalMessage: message,
        }
      };
    }

    // Step 3: Auto-categorize into parent section
    const parent = params.parent || this._autoCategory(params.topic, params.category, params.fact);

    // Step 4: Determine page title and content
    const pageTitle = params.page_title || params.topic || 'Notes';
    let content = params.content || params.fact || '';

    // For "remember" actions, format as a knowledge entry
    if (params.action === 'remember' && params.fact) {
      content = params.fact;
    }

    // Step 5: Guardrail check
    const guardResult = await this._checkGuardrails('wiki_write', { page_title: pageTitle }, context.roomToken || null);
    if (!guardResult.allowed) {
      return `Action blocked: ${guardResult.reason}`;
    }

    // Step 6: Execute via ToolRegistry
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
    const response = `Saved to wiki: "${pageTitle}"${parentInfo}. ${writeResult.result || ''}`.trim();
    return {
      response,
      actionRecord: { type: 'wiki_write', refs: { pageTitle, parent: parent || null } }
    };
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
