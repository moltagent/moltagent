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
 * FileExecutor — Parameter-extraction executor for file operations.
 *
 * Architecture Brief:
 * - Problem: Local models hallucinate file tool calls
 * - Pattern: Extract params → validate → guard → write/read → auto-share
 * - Key Dependencies: BaseExecutor, NCFilesClient
 * - Data Flow: message → extract → validate → guard → writeFile → shareFile → confirm
 *
 * @module agent/executors/file-executor
 * @version 1.0.0
 */

const BaseExecutor = require('./base-executor');

class FileExecutor extends BaseExecutor {
  /**
   * @param {Object} config - BaseExecutor config + ncFilesClient
   * @param {Object} config.ncFilesClient - NCFilesClient instance
   */
  constructor(config = {}) {
    super(config);
    this.ncFilesClient = config.ncFilesClient;
  }

  /**
   * Execute a file operation from a natural language message.
   *
   * @param {string} message - User message
   * @param {Object} context - { userName, roomToken }
   * @returns {Promise<string>} Confirmation text
   */
  async execute(message, context) {
    // Step 1: Extract parameters
    const dateContext = this._dateContext();
    const extractionPrompt = `${dateContext}

Extract file operation parameters from this message. Return ONLY valid JSON, no other text.

Message: "${message.substring(0, 300)}"

Return JSON with these fields (use null for missing):
{"action": "write|read|delete|list|share", "filename": "name.ext", "content": "file content or null if needs generation", "folder": "folder path or null", "generate_content": true/false}`;

    const params = await this._extractJSON(message, extractionPrompt);

    if (!params) {
      const err = new Error('Could not extract file parameters');
      err.code = 'DOMAIN_ESCALATE';
      throw err;
    }

    // Step 2: Validate
    if (params.action === 'write' && !params.filename) {
      const err = new Error('Missing required field: filename');
      err.code = 'DOMAIN_ESCALATE';
      throw err;
    }

    // Step 3: Defaults + path sanitization
    const folder = params.folder || 'Outbox';
    const path = `${folder}/${params.filename}`;

    // Reject path traversal attempts
    if (path.includes('..') || path.startsWith('/')) {
      const err = new Error('Invalid file path: traversal not allowed');
      err.code = 'DOMAIN_ESCALATE';
      throw err;
    }

    // Step 4: If content needs generation, use a separate LLM call
    let content = params.content;
    if (params.action === 'write' && (params.generate_content || !content)) {
      try {
        const genResult = await this.router.route({
          job: 'quick',
          content: `Generate the content for a file based on this request. Return ONLY the file content, no explanation.\n\nRequest: "${message.substring(0, 300)}"`,
          requirements: { maxTokens: 500 }
        });
        content = genResult.result || '';
      } catch (err) {
        this.logger.warn(`[FileExecutor] Content generation failed: ${err.message}`);
        content = '';
      }
    }

    if (params.action === 'write' && !content) {
      const err = new Error('No content for file write');
      err.code = 'DOMAIN_ESCALATE';
      throw err;
    }

    // Step 5: Guardrail check
    const toolName = params.action === 'delete' ? 'file_delete' : 'file_write';
    const guardResult = await this._checkGuardrails(toolName, { path }, context.roomToken || null);
    if (!guardResult.allowed) {
      return `Action blocked: ${guardResult.reason}`;
    }

    // Step 6: Execute
    if (params.action === 'write') {
      await this.ncFilesClient.writeFile(path, content);

      // Step 7: Auto-share (best-effort)
      if (context.userName) {
        try {
          await this.ncFilesClient.shareFile(path, context.userName);
        } catch (shareErr) {
          this.logger.warn(`[FileExecutor] Auto-share failed: ${shareErr.message}`);
        }
      }

      // Layer 1: Log activity
      this._logActivity('file_write',
        `Saved "${params.filename}" to ${folder}/, shared with ${context.userName || 'user'}`,
        { filename: params.filename, folder, shared: true },
        context
      );

      return `File "${params.filename}" written to ${folder}/ and shared with ${context.userName || 'you'}.`;
    }

    return `File operation "${params.action}" is not yet supported by the executor.`;
  }
}

module.exports = FileExecutor;
