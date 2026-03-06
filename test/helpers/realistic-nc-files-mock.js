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
 * RealisticNCFilesMock — Stateful mock that enforces real NC Files WebDAV constraints.
 *
 * Key constraint: Parent directory must exist before file PUT.
 * PUT to Memory/_index fails with 409 if Memory/ directory doesn't exist.
 *
 * Created after 2026-03-05 KnowledgeGraph flush failure where flush() tried to
 * write Memory/_index but the Memory/ directory had never been created.
 */
class RealisticNCFilesMock {
  constructor() {
    /** @type {Map<string, string>} path → content */
    this._files = new Map();
    /** @type {Set<string>} existing directories */
    this._directories = new Set(['/']);
  }

  /**
   * Write file content.
   * CONSTRAINT: Parent directory must exist.
   * Throws 409 if directory not found — matches real WebDAV behavior.
   */
  async writeFile(path, content) {
    const dir = path.split('/').slice(0, -1).join('/') || '/';
    if (dir !== '/' && !this._directories.has(dir)) {
      const err = new Error(
        `WebDAV error: 409 Conflict — parent directory "${dir}" does not exist. ` +
        `Call ensureDirectory("${dir}") first. ` +
        `(RealisticNCFilesMock enforcing real API constraint)`
      );
      err.statusCode = 409;
      throw err;
    }
    this._files.set(path, typeof content === 'string' ? content : JSON.stringify(content));
    return { success: true };
  }

  /**
   * Read file content.
   * CONSTRAINT: File must exist. Throws 404 if not found.
   */
  async readFile(path) {
    if (!this._files.has(path)) {
      const err = new Error(`404 Not Found: ${path}`);
      err.statusCode = 404;
      throw err;
    }
    return { content: this._files.get(path) };
  }

  /**
   * Ensure directory exists (WebDAV MKCOL).
   * Idempotent — safe to call multiple times.
   */
  async ensureDirectory(path) {
    this._directories.add(path);
    // Also add parent directories
    const parts = path.split('/');
    for (let i = 1; i <= parts.length; i++) {
      this._directories.add(parts.slice(0, i).join('/'));
    }
    return { success: true };
  }

  /**
   * Alias for ensureDirectory — KnowledgeGraph calls this.filesClient.mkdir().
   */
  async mkdir(path) {
    return this.ensureDirectory(path);
  }

  /**
   * Check if file exists (WebDAV HEAD).
   */
  async exists(path) {
    return this._files.has(path);
  }

  /**
   * Delete a file.
   */
  async deleteFile(path) {
    if (!this._files.has(path)) {
      const err = new Error(`404 Not Found: ${path}`);
      err.statusCode = 404;
      throw err;
    }
    this._files.delete(path);
    return { success: true };
  }

  // ==================== Test Helpers ====================

  /**
   * Pre-populate files and their parent directories.
   */
  _seed(files) {
    for (const [path, content] of Object.entries(files)) {
      const dir = path.split('/').slice(0, -1).join('/') || '/';
      this._directories.add(dir);
      this._files.set(path, content);
    }
    return this; // Chainable
  }

  /**
   * Assert file exists with expected content.
   */
  _assertFile(path, expectedContent) {
    if (!this._files.has(path)) {
      throw new Error(`Expected file at "${path}" but it doesn't exist`);
    }
    if (expectedContent && !this._files.get(path).includes(expectedContent)) {
      throw new Error(`File "${path}" doesn't contain expected content`);
    }
    return this._files.get(path);
  }

  get fileCount() { return this._files.size; }
  get directoryCount() { return this._directories.size; }
}

module.exports = { RealisticNCFilesMock };
