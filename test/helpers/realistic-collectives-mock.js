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
 * RealisticCollectivesMock — Stateful mock that enforces real Collectives API constraints.
 *
 * Key constraint: Pages must be created via createPage() before content can be written
 * via writePageContent(). This matches the real Collectives OCS + WebDAV behavior where
 * the OCS API manages page existence and WebDAV manages content.
 *
 * Created after 2026-03-05 triple production failure where stateless mocks hid
 * three write-to-nonexistent-page bugs that all passed tests and all failed in production.
 */
class RealisticCollectivesMock {
  constructor() {
    /** @type {Map<string, {id: number, path: string, title: string, content: string, filePath: string, fileName: string}>} */
    this._pages = new Map();
    this._nextId = 1000;
    this._collectiveId = 2; // Default test collective
  }

  // ==================== OCS API (Page Management) ====================

  /**
   * Create a page. Must be called before writePageContent().
   * Real API: POST /apps/collectives/_api/{collectiveId}/pages
   */
  async createPage(parentId, title) {
    const id = this._nextId++;
    const parentPage = [...this._pages.values()].find(p => p.id === parentId);
    const filePath = parentPage ? `${parentPage.filePath}/${parentPage.title}` : '';
    const fileName = `${title}.md`;
    const fullPath = filePath ? `${filePath}/${fileName}` : fileName;

    this._pages.set(fullPath, {
      id,
      path: fullPath,
      title,
      content: '',
      filePath,
      fileName,
      parentId
    });

    return { id, title, filePath, fileName };
  }

  /**
   * List all pages in the collective.
   * Returns only pages that were actually created.
   */
  async listPages() {
    return [...this._pages.values()].map(p => ({
      id: p.id,
      title: p.title,
      filePath: p.filePath,
      fileName: p.fileName
    }));
  }

  /**
   * Read page content by page ID.
   * Returns null if page doesn't exist — matches real behavior.
   */
  async readPageContent(pageId) {
    const page = [...this._pages.values()].find(p => p.id === pageId);
    if (!page) return null;
    return page.content;
  }

  /**
   * Write content to an existing page via WebDAV.
   * CONSTRAINT: Page must exist (created via createPage).
   * Throws 404 if page not found — this is the constraint the old mocks missed.
   */
  async writePageContent(pathOrId, content) {
    const page = this._findPage(pathOrId);
    if (!page) {
      const err = new Error(
        `WebDAV error: 404 on PUT ${pathOrId} — ` +
        `page does not exist in Collectives. Create it via createPage() first. ` +
        `(RealisticCollectivesMock enforcing real API constraint)`
      );
      err.statusCode = 404;
      throw err;
    }
    page.content = content;
    return { success: true };
  }

  /**
   * Update page content by page ID.
   * CONSTRAINT: Page must exist.
   */
  async updatePageContent(pageId, content) {
    const page = [...this._pages.values()].find(p => p.id === pageId);
    if (!page) {
      const err = new Error(
        `Page ${pageId} not found. ` +
        `(RealisticCollectivesMock enforcing real API constraint)`
      );
      err.statusCode = 404;
      throw err;
    }
    page.content = content;
    return { success: true };
  }

  /**
   * Resolve the collective (for API calls that need collectiveId).
   */
  async resolveCollective() {
    return this._collectiveId;
  }

  // ==================== Internal Helpers ====================

  /**
   * Find page by path string or page ID.
   * Attempts multiple matching strategies, like real Collectives:
   * - Exact path match
   * - Path with .md extension
   * - Match by title (last segment of path)
   */
  _findPage(pathOrId) {
    if (typeof pathOrId === 'number') {
      return [...this._pages.values()].find(p => p.id === pathOrId) || null;
    }

    const path = String(pathOrId);

    // Exact match
    if (this._pages.has(path)) return this._pages.get(path);

    // With .md
    if (this._pages.has(path + '.md')) return this._pages.get(path + '.md');

    // By title (last segment)
    const title = path.split('/').pop().replace(/\.md$/, '');
    for (const [, page] of this._pages) {
      if (page.title === title) return page;
    }

    return null;
  }

  // ==================== Test Helpers ====================

  /**
   * Pre-populate pages for tests that need existing data.
   * Use this instead of manually calling createPage() in test setup
   * when the test is about reading, not about the creation flow.
   *
   * @param {Array<{path: string, title: string, content: string}>} pages
   */
  _seed(pages) {
    for (const p of pages) {
      const id = this._nextId++;
      const parts = p.path.split('/');
      const fileName = parts.pop();
      const filePath = parts.join('/');
      this._pages.set(p.path, {
        id,
        path: p.path,
        title: p.title || fileName.replace(/\.md$/, ''),
        content: p.content || '',
        filePath,
        fileName: fileName.endsWith('.md') ? fileName : fileName + '.md',
        parentId: null
      });
    }
    return this; // Chainable
  }

  /**
   * Assert a page exists with expected content.
   * Useful for verifying write operations in tests.
   */
  _assertPage(path, { hasContent, hasType } = {}) {
    const page = this._findPage(path);
    if (!page) throw new Error(`Expected page at "${path}" but it doesn't exist`);
    if (hasContent && !page.content.includes(hasContent)) {
      throw new Error(`Page "${path}" doesn't contain "${hasContent}"`);
    }
    if (hasType && !page.content.match(new RegExp(`type:\\s*${hasType}`))) {
      throw new Error(`Page "${path}" doesn't have type: ${hasType}`);
    }
    return page;
  }

  /**
   * Get count of pages (for verification).
   */
  get pageCount() {
    return this._pages.size;
  }
}

module.exports = { RealisticCollectivesMock };
