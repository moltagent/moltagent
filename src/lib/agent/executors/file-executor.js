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
 * - Pattern: Extract params → validate → guard → execute (read/write/list/delete/share)
 * - Key Dependencies: BaseExecutor, NCFilesClient, TextExtractor
 * - Data Flow: message → extract → validate → _buildPath → guard → execute → confirm
 *
 * @module agent/executors/file-executor
 * @version 2.0.0
 */

const { execFile } = require('child_process');
const { promisify } = require('util');
const fs = require('fs').promises;
const os = require('os');
const nodePath = require('path');

const execFileAsync = promisify(execFile);

const BaseExecutor = require('./base-executor');

let appConfig;
try { appConfig = require('../../config'); } catch (_) { /* optional */ }

let TextExtractor;
try { TextExtractor = require('../../extraction/text-extractor').TextExtractor; } catch (_) { /* optional */ }

const MAX_LIST_ENTRIES = 30;
const MAX_SYNTHESIS_CHARS = 12000;

/** File type classification by extension */
const FILE_TYPE_MAP = {
  text: new Set(['md', 'txt', 'json', 'yaml', 'yml', 'csv', 'html', 'htm',
    'xml', 'js', 'py', 'sh', 'env', 'cfg', 'ini', 'toml', 'log', 'conf', 'css']),
  document: new Set(['pdf', 'docx', 'xlsx', 'xls', 'odt', 'ods']),
  image: new Set(['png', 'jpg', 'jpeg', 'gif', 'svg', 'webp', 'bmp', 'ico', 'tiff']),
  audio: new Set(['mp3', 'wav', 'ogg', 'flac', 'm4a', 'aac', 'wma']),
  video: new Set(['mp4', 'mkv', 'avi', 'mov', 'webm', 'wmv', 'flv']),
};

/** Detect explicit raw-content requests */
const RAW_CONTENT_PATTERN = /\b(show|paste|display|dump|print|output|raw|full text|verbatim|cat)\b/i;

class FileExecutor extends BaseExecutor {
  /**
   * @param {Object} config - BaseExecutor config + ncFilesClient + textExtractor
   * @param {Object} config.ncFilesClient - NCFilesClient instance
   * @param {Object} [config.textExtractor] - TextExtractor for rich document reading
   */
  constructor(config = {}) {
    super(config);
    this.ncFilesClient = config.ncFilesClient;
    this.textExtractor = config.textExtractor || null;
  }

  /**
   * Build a sanitized file path from extracted params.
   * @param {Object} params - { path?, folder?, filename? }
   * @returns {{ path: string, folder: string, filename: string }}
   * @throws {Error} with code DOMAIN_ESCALATE on path traversal
   */
  _buildPath(params) {
    let path;
    if (params.path && typeof params.path === 'string' && params.path.trim()) {
      path = params.path.trim();
    } else {
      const folder = (params.folder || '').trim();
      const filename = (params.filename || '').trim();
      path = folder ? `${folder}/${filename}` : filename;
    }

    // Reject path traversal
    if (path.includes('..') || path.startsWith('/')) {
      const err = new Error('Invalid file path: traversal not allowed');
      err.code = 'DOMAIN_ESCALATE';
      throw err;
    }

    // Derive folder and filename from the resolved path
    const lastSlash = path.lastIndexOf('/');
    const folder = lastSlash >= 0 ? path.substring(0, lastSlash) : '';
    const filename = lastSlash >= 0 ? path.substring(lastSlash + 1) : path;

    return { path, folder, filename };
  }

  /**
   * Execute a file operation from a natural language message.
   *
   * @param {string} message - User message
   * @param {Object} context - { userName, roomToken }
   * @returns {Promise<string|Object>} Confirmation text or structured response
   */
  async execute(message, context) {
    // Step 1: Extract parameters
    const dateContext = this._dateContext();
    const FILE_SCHEMA = {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['write', 'read', 'delete', 'list', 'share'] },
        filename: { type: 'string' },
        content: { type: 'string' },
        folder: { type: 'string' },
        path: { type: 'string' },
        share_with: { type: 'string' },
        permission: { type: 'string', enum: ['read', 'edit'] },
        generate_content: { type: 'boolean' },
        requires_clarification: { type: 'boolean' },
        missing_fields: { type: 'array', items: { type: 'string' } }
      },
      required: ['action']
    };

    // Build context hint from action ledger + recent conversation
    const contextHint = this._buildContextHint(context);
    const contextBlock = contextHint
      ? `\nContext from this conversation:\n${contextHint}\n\nResolve relative references using this context.\n- "the most recent one" / "the newest" → use the Newest file from the listing\n- "the biggest one" / "the largest" → use the Biggest file from the listing\n- "the first one" → first file in the Files list\n- "that PDF" / "the spreadsheet" → match by extension from the Files list\n- "the one about X" → match by filename keywords from the Files list\nDo not set requires_clarification if the reference can be resolved from context.\n`
      : '';

    const extractionPrompt = `${dateContext}
${contextBlock}
Extract file operation parameters from this message.
Leave fields as empty strings if not mentioned. Set generate_content to true if the user wants content created.
If the message is NOT about a file operation, set requires_clarification to true.

Action rules:
- "Create/write/save a file" → action: write
- "Read/open/show/cat a file" → action: read
- "List/browse/show folder" → action: list
- "Delete/remove a file" → action: delete
- "Share a file with someone" → action: share
- If the message is ONLY a filename or path with no action word, default to action: read
  Examples: "report.pdf" → action: read, path: "report.pdf"
            "Documents/spec.md" → action: read, path: "Documents/spec.md"

Use "path" for full relative paths like "Projects/spec.md".
Use "folder" + "filename" when they are separate.
Use "share_with" for the NC username to share with.
Use "permission" (read or edit) for share permission level.

Message: "${message.substring(0, 300)}"`;

    const params = await this._extractJSON(message, extractionPrompt, FILE_SCHEMA);

    if (!params) {
      const err = new Error('Could not extract file parameters');
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
          executor: 'file', action: params.action || 'write',
          missingFields,
          collectedFields: { filename: params.filename, content: params.content, folder: params.folder, path: params.path, generate_content: params.generate_content },
          originalMessage: message,
        }
      };
    }

    if (params.filename && params.filename.length > 100) {
      return "I couldn't extract a clear filename. Could you tell me just the file name?";
    }

    // Route to action handler
    switch (params.action) {
      case 'write': return await this._executeWrite(params, message, context);
      case 'read':  return await this._executeRead(params, message, context);
      case 'list':  return await this._executeList(params, context);
      case 'delete': return await this._executeDelete(params, context);
      case 'share': return await this._executeShare(params, context);
      default:
        return `File operation "${params.action}" is not supported.`;
    }
  }

  /**
   * Write a file and auto-share with requesting user.
   */
  async _executeWrite(params, message, context) {
    if (!params.filename || params.filename.trim() === '') {
      // Check if path provides a filename
      if (!params.path || !params.path.trim()) {
        return {
          response: 'I need a filename. What should I call the file?',
          pendingClarification: {
            executor: 'file', action: 'write',
            missingFields: ['filename'],
            collectedFields: { content: params.content, folder: params.folder, generate_content: params.generate_content },
            originalMessage: message,
          }
        };
      }
    }

    // Default folder to Outbox for write action
    if (!params.folder && !params.path) {
      params.folder = 'Outbox';
    }

    const { path, folder, filename } = this._buildPath(params);

    if (!filename) {
      return {
        response: 'I need a filename. What should I call the file?',
        pendingClarification: {
          executor: 'file', action: 'write',
          missingFields: ['filename'],
          collectedFields: { content: params.content, folder: params.folder, generate_content: params.generate_content },
          originalMessage: message,
        }
      };
    }

    // Content generation
    let content = params.content;
    if (params.generate_content || !content) {
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

    if (!content) {
      const err = new Error('No content for file write');
      err.code = 'DOMAIN_ESCALATE';
      throw err;
    }

    // Guardrail check
    const guardResult = await this._checkGuardrails('file_write', { path }, context.roomToken || null);
    if (!guardResult.allowed) {
      return `Action blocked: ${guardResult.reason}`;
    }

    // Execute
    await this.ncFilesClient.writeFile(path, content);

    // Auto-share (best-effort)
    if (context.userName) {
      try {
        await this.ncFilesClient.shareFile(path, context.userName);
      } catch (shareErr) {
        this.logger.warn(`[FileExecutor] Auto-share failed: ${shareErr.message}`);
      }
    }

    this._logActivity('file_write',
      `Saved "${filename}" to ${folder || 'Outbox'}/, shared with ${context.userName || 'user'}`,
      { filename, folder: folder || 'Outbox', shared: true },
      context
    );

    return {
      response: `File "${filename}" written to ${folder || 'Outbox'}/ and shared with ${context.userName || 'you'}.`,
      actionRecord: { type: 'file_write', refs: { path, filename, folder: folder || 'Outbox' } }
    };
  }

  /**
   * Classify a file by extension into text/document/image/audio/video/binary.
   * @param {string} filename
   * @returns {string}
   */
  _classifyFileType(filename) {
    const ext = (filename || '').split('.').pop().toLowerCase();
    for (const [type, extensions] of Object.entries(FILE_TYPE_MAP)) {
      if (extensions.has(ext)) return type;
    }
    return 'binary';
  }

  /**
   * Read a file: classify → extract → synthesize via LLM.
   * Returns a human summary by default; raw content only when explicitly requested.
   */
  async _executeRead(params, message, context) {
    // Need a filename or path
    const hasFile = (params.filename && params.filename.trim()) || (params.path && params.path.trim());
    if (!hasFile) {
      return {
        response: 'Which file should I read? Please provide a filename or path.',
        pendingClarification: {
          executor: 'file', action: 'read',
          missingFields: ['filename'],
          collectedFields: { folder: params.folder },
          originalMessage: '',
        }
      };
    }

    const { path, filename } = this._buildPath(params);

    // Reject wildcard / aggregate read attempts
    if (path.includes('*') || path.toLowerCase() === 'all') {
      return 'I can only read one file at a time. Which file would you like me to read?';
    }

    // Content-type gate: reject non-readable file types early
    const fileType = this._classifyFileType(filename);

    if (fileType === 'image') {
      // Attempt OCR — tesseract reads PNG/JPG/TIFF/BMP directly
      try {
        const buffer = await this.ncFilesClient.readFileBuffer(path);
        const ocrText = await this._ocrImage(buffer, filename);

        if (ocrText && ocrText.trim().length > 50) {
          this._logActivity('file_read', `OCR read "${path}"`, { path, ocr: true }, context);

          const wantsRaw = RAW_CONTENT_PATTERN.test(message || '');
          if (wantsRaw) {
            return {
              response: ocrText.trim(),
              actionRecord: { type: 'file_read', refs: { path, result: 'image_ocr_raw', contentLength: ocrText.length } }
            };
          }

          return await this._synthesizeFileContent(path, filename, ocrText.trim());
        }
      } catch (err) {
        this.logger?.warn?.(`[FileExecutor] Image read/OCR failed for ${path}: ${err.message}`);
      }

      // No meaningful text found or OCR unavailable
      return {
        response: `**${filename}** is an image file. I ran OCR but found no readable text — this appears to be a photo or graphic rather than a document.`,
        actionRecord: { type: 'file_read', refs: { path, result: 'image_no_text' } }
      };
    }

    if (fileType === 'audio' || fileType === 'video') {
      return {
        response: `**${filename}** is a ${fileType} file. I can't process ${fileType} files directly.`,
        actionRecord: { type: 'file_read', refs: { path, result: `${fileType}_skipped` } }
      };
    }

    if (fileType === 'binary') {
      return {
        response: `**${filename}** is a binary file. I can't read binary content. If this should be a readable format, let me know what type it is.`,
        actionRecord: { type: 'file_read', refs: { path, result: 'binary_skipped' } }
      };
    }

    // Text or document — extract content
    try {
      let content;
      let pages;

      if (this.textExtractor && TextExtractor && TextExtractor.isSupported(path)) {
        const buffer = await this.ncFilesClient.readFileBuffer(path);
        const result = await this.textExtractor.extract(buffer, path);
        content = result.text;
        pages = result.pages;
      } else {
        const result = await this.ncFilesClient.readFile(path);
        content = result.content;
      }

      this._logActivity('file_read', `Read "${path}"`, { path }, context);

      // If user explicitly asked for raw content, return it directly
      const wantsRaw = RAW_CONTENT_PATTERN.test(message || '');
      if (wantsRaw) {
        return {
          response: content,
          actionRecord: { type: 'file_read', refs: { path, contentLength: content.length } }
        };
      }

      // Default: synthesize through LLM
      return await this._synthesizeFileContent(path, filename, content, pages);
    } catch (err) {
      if (err.statusCode === 404 || (err.message && err.message.includes('404'))) {
        return `File not found: ${path}. Use file_list to browse.`;
      }
      throw err;
    }
  }

  /**
   * Pass file content through LLM for intelligent synthesis.
   * Falls back to truncated raw content if LLM fails.
   */
  async _synthesizeFileContent(filePath, filename, content, pages) {
    const contextText = content.slice(0, MAX_SYNTHESIS_CHARS);
    const truncatedNote = content.length > MAX_SYNTHESIS_CHARS
      ? `\n[... content truncated, full file is ${content.length} characters ...]`
      : '';

    const ext = (filename || '').split('.').pop().toLowerCase();
    const pageInfo = pages ? ` (${pages} pages)` : '';

    const synthesisPrompt = `You just read a file shared with you. Here are the details:

Filename: ${filename}
Type: .${ext}${pageInfo}

Content:
---
${contextText}${truncatedNote}
---

Tell the user what this document contains. Be specific about:
- What it is (type of document, its purpose)
- Key content (main topics, decisions, people mentioned, data points)
- Anything notable or actionable

Be concise but thorough. Do NOT dump the raw content. Speak as someone who just read and understood the document.`;

    try {
      const result = await this.router.route({
        job: 'quick',
        content: synthesisPrompt,
        requirements: { maxTokens: 800 }
      });

      const synthesis = (result.result || '').trim();
      if (synthesis.length > 20) {
        return {
          response: synthesis,
          actionRecord: { type: 'file_read', refs: { path: filePath, result: 'synthesized', contentLength: content.length } }
        };
      }
    } catch (err) {
      this.logger?.warn?.(`[FileExecutor] Synthesis failed, returning truncated content: ${err.message}`);
    }

    // Fallback: return truncated raw content if LLM fails
    const fallback = content.length > MAX_SYNTHESIS_CHARS
      ? contextText + `\n\n[Content truncated — full file is ${(content.length / 1024).toFixed(1)} KB. Ask me to show a specific section.]`
      : content;
    return {
      response: fallback,
      actionRecord: { type: 'file_read', refs: { path: filePath, result: 'raw_fallback', contentLength: content.length } }
    };
  }

  /**
   * Run tesseract OCR directly on an image buffer.
   * Returns extracted text or empty string on failure/unavailable.
   */
  async _ocrImage(buffer, filename) {
    // Lazy availability check (cached for process lifetime)
    if (this._tesseractAvailable === undefined) {
      try {
        await execFileAsync('tesseract', ['--version']);
        this._tesseractAvailable = true;
      } catch {
        this._tesseractAvailable = false;
      }
    }

    if (!this._tesseractAvailable) {
      this.logger?.warn?.('[FileExecutor] tesseract not available, skipping image OCR');
      return '';
    }

    const ext = nodePath.extname(filename) || '.png';
    const stamp = Date.now();
    const tmpIn = nodePath.join(os.tmpdir(), `molti-ocr-${stamp}${ext}`);
    const tmpOut = nodePath.join(os.tmpdir(), `molti-ocr-${stamp}`);

    try {
      await fs.writeFile(tmpIn, buffer);

      const languages = appConfig?.extraction?.ocrLanguages ?? 'eng+deu+por';
      const timeout = appConfig?.extraction?.ocrTimeoutMs ?? 30000;
      await execFileAsync('tesseract', [tmpIn, tmpOut, '-l', languages], { timeout });

      const text = await fs.readFile(tmpOut + '.txt', 'utf-8');
      return text;
    } catch (err) {
      this.logger?.warn?.(`[FileExecutor] Image OCR failed: ${err.message}`);
      return '';
    } finally {
      await fs.unlink(tmpIn).catch(() => {});
      await fs.unlink(tmpOut + '.txt').catch(() => {});
    }
  }

  /**
   * List directory contents.
   */
  async _executeList(params, context) {
    const rawPath = (params.path && params.path.trim()) || (params.folder && params.folder.trim()) || '';
    const dirPath = rawPath || '/';

    // Reject path traversal (root '/' is allowed for listing)
    if (rawPath && (rawPath.includes('..') || rawPath.startsWith('/'))) {
      const err = new Error('Invalid file path: traversal not allowed');
      err.code = 'DOMAIN_ESCALATE';
      throw err;
    }

    try {
      const entries = await this.ncFilesClient.listDirectory(dirPath);

      // Sort: directories first, then files
      const dirs = entries.filter(e => e.type === 'directory');
      const files = entries.filter(e => e.type !== 'directory');
      const sorted = [...dirs, ...files];

      // Compute enriched metadata for action ledger
      const fileEntries = sorted.filter(e => e.type !== 'directory');
      const first10Names = sorted.slice(0, 10).map(e => e.name);

      let newestFile = null;
      let biggestFile = null;
      const typeCounts = {};

      for (const f of fileEntries) {
        if (f.modified) {
          const modTime = new Date(f.modified).getTime();
          if (!newestFile || modTime > newestFile._time) {
            newestFile = { name: f.name, modified: f.modified, _time: modTime };
          }
        }
        const sz = Number.isFinite(f.size) ? f.size : 0;
        if (!biggestFile || sz > biggestFile.size) {
          biggestFile = { name: f.name, size: sz };
        }
        const ext = (f.name.includes('.') ? f.name.split('.').pop().toLowerCase() : 'other');
        typeCounts[ext] = (typeCounts[ext] || 0) + 1;
      }

      const capped = sorted.slice(0, MAX_LIST_ENTRIES);
      const lines = capped.map(e => {
        const icon = e.type === 'directory' ? '\u{1F4C1}' : '';
        const size = e.size ? this._formatSize(e.size) : '';
        const modified = e.modified || '';
        const parts = [e.name];
        if (size) parts.push(size);
        if (modified) parts.push(modified);
        return `${icon} ${parts.join(' \u2014 ')}`.trim();
      });

      let formatted = lines.join('\n');
      if (sorted.length > MAX_LIST_ENTRIES) {
        formatted += `\n[+${sorted.length - MAX_LIST_ENTRIES} more]`;
      }

      this._logActivity('file_list',
        `Listed "${dirPath}" (${sorted.length} entries)`,
        { path: dirPath, count: sorted.length },
        context
      );

      return {
        response: formatted,
        actionRecord: {
          type: 'file_list',
          refs: {
            path: dirPath,
            count: sorted.length,
            files: first10Names,
            newest: newestFile ? { name: newestFile.name, modified: newestFile.modified } : null,
            biggest: biggestFile,
            types: typeCounts
          }
        }
      };
    } catch (err) {
      if (err.statusCode === 404 || (err.message && err.message.includes('404'))) {
        return 'Folder not found.';
      }
      throw err;
    }
  }

  /**
   * Delete a file.
   */
  async _executeDelete(params, context) {
    const hasFile = (params.filename && params.filename.trim()) || (params.path && params.path.trim());
    if (!hasFile) {
      return {
        response: 'Which file should I delete? Please provide a filename or path.',
        pendingClarification: {
          executor: 'file', action: 'delete',
          missingFields: ['filename'],
          collectedFields: { folder: params.folder },
          originalMessage: '',
        }
      };
    }

    const { path, filename } = this._buildPath(params);

    // Guardrail check — file_delete REQUIRES_APPROVAL
    const guardResult = await this._checkGuardrails('file_delete', { path }, context.roomToken || null);
    if (!guardResult.allowed) {
      return `Action blocked: ${guardResult.reason}`;
    }

    try {
      await this.ncFilesClient.deleteFile(path);
    } catch (err) {
      if (err.statusCode === 404 || (err.message && err.message.includes('404'))) {
        return `File not found: ${path}.`;
      }
      throw err;
    }

    this._logActivity('file_delete',
      `Deleted "${path}"`,
      { path, filename },
      context
    );

    return {
      response: `Deleted "${filename}" from ${path}.`,
      actionRecord: { type: 'file_delete', refs: { path } }
    };
  }

  /**
   * Share a file with a Nextcloud user.
   */
  async _executeShare(params, context) {
    const hasFile = (params.filename && params.filename.trim()) || (params.path && params.path.trim());
    if (!hasFile) {
      return {
        response: 'Which file should I share? Please provide a filename or path.',
        pendingClarification: {
          executor: 'file', action: 'share',
          missingFields: ['filename'],
          collectedFields: { folder: params.folder, share_with: params.share_with, permission: params.permission },
          originalMessage: '',
        }
      };
    }

    if (!params.share_with || !params.share_with.trim()) {
      return {
        response: 'Who should I share this file with? Please provide a username.',
        pendingClarification: {
          executor: 'file', action: 'share',
          missingFields: ['share_with'],
          collectedFields: { filename: params.filename, folder: params.folder, path: params.path, permission: params.permission },
          originalMessage: '',
        }
      };
    }

    const { path, filename } = this._buildPath(params);
    const permission = params.permission || 'read';
    const shareWith = params.share_with.trim();

    // Guardrail check — file_share REQUIRES_APPROVAL
    const guardResult = await this._checkGuardrails('file_share', { path, shareWith, permission }, context.roomToken || null);
    if (!guardResult.allowed) {
      return `Action blocked: ${guardResult.reason}`;
    }

    try {
      await this.ncFilesClient.shareFile(path, shareWith, permission);
    } catch (err) {
      if (err.statusCode === 404 || (err.message && err.message.includes('404'))) {
        return `File not found: ${path}.`;
      }
      throw err;
    }

    this._logActivity('file_share',
      `Shared "${path}" with ${shareWith} (${permission})`,
      { path, filename, sharedWith: shareWith, permission },
      context
    );

    return {
      response: `Shared "${filename}" with ${shareWith} (${permission} access).`,
      actionRecord: { type: 'file_share', refs: { path, sharedWith: shareWith, permission } }
    };
  }

  /**
   * Summarize a previous action record for context injection.
   * @param {Object|null} action - Action record from the ledger
   * @returns {string} Human-readable summary or empty string
   */
  _summarizeLastAction(action) {
    if (!action || !action.type) return '';

    const refs = action.refs || {};
    switch (action.type) {
      case 'file_list': {
        const parts = [`Previous listing of ${refs.path || '/'} (${refs.count || 0} entries)`];
        if (Array.isArray(refs.files) && refs.files.length > 0) {
          parts.push(`Files: ${refs.files.join(', ')}`);
        }
        if (refs.newest && refs.newest.name) {
          parts.push(`Newest: ${refs.newest.name} (${refs.newest.modified || 'unknown date'})`);
        }
        if (refs.biggest && refs.biggest.name) {
          parts.push(`Biggest: ${refs.biggest.name} (${refs.biggest.size || 0} bytes)`);
        }
        return parts.join('\n');
      }
      case 'file_read':
        return `Last read: ${refs.path || 'unknown'}`;
      case 'file_write':
        return `Last wrote: ${refs.path || refs.filename || 'unknown'}`;
      case 'file_delete':
        return `Last deleted: ${refs.path || 'unknown'}`;
      case 'file_share':
        return `Last shared: ${refs.path || 'unknown'} with ${refs.sharedWith || 'unknown'}`;
      default:
        return '';
    }
  }

  /**
   * Build a context hint from the session's action ledger and recent conversation.
   * Returns empty string when no context is available (backward compatible).
   * @param {Object} context - Execution context with optional getLastAction/getRecentContext
   * @returns {string} Context hint for the extraction prompt
   */
  _buildContextHint(context) {
    if (!context) return '';

    const parts = [];

    // Action ledger: last file action
    if (typeof context.getLastAction === 'function') {
      const lastAction = context.getLastAction('file_');
      const summary = this._summarizeLastAction(lastAction);
      if (summary) parts.push(summary);
    }

    // Conversation history: last assistant response
    if (typeof context.getRecentContext === 'function') {
      const recent = context.getRecentContext();
      if (Array.isArray(recent) && recent.length > 0) {
        // Find the last assistant message
        for (let i = recent.length - 1; i >= 0; i--) {
          if (recent[i] && recent[i].role === 'assistant' && recent[i].content) {
            const truncated = recent[i].content.substring(0, 400);
            parts.push(`Last assistant response:\n${truncated}`);
            break;
          }
        }
      }
    }

    return parts.join('\n\n');
  }

  /**
   * Format file size for display.
   * @param {number} bytes
   * @returns {string}
   */
  _formatSize(bytes) {
    if (!Number.isFinite(bytes) || bytes < 0) return '';
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  }
}

module.exports = FileExecutor;
