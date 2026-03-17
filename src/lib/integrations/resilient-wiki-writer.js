/**
 * MoltAgent Resilient Wiki Writer
 *
 * Dual-path writer that tries OCS Collectives API first, falls back to
 * NCFiles WebDAV when OCS is unavailable. Provides health tracking with
 * cooldown to avoid hammering a broken OCS endpoint.
 *
 * Architecture Brief
 * ──────────────────
 * Problem:  Collectives OCS API goes down (500s, HTML responses, hangs)
 *           while NC Files WebDAV continues working fine. Writes to the
 *           Collectives directory tree via WebDAV are immediately visible
 *           in the Collectives UI.
 *
 * Pattern:  Dual-path with health tracking.
 *           - createPage: OCS first (resolve → list → create → write),
 *             fallback to WebDAV (mkdir + writeFile).
 *           - updatePage: WebDAV primary, OCS fallback.
 *           - readPage: WebDAV only.
 *           - listPages: OCS primary, WebDAV PROPFIND fallback.
 *
 * Key Dependencies:
 *   - CollectivesClient (OCS path)
 *   - NCFilesClient (WebDAV path)
 *
 * Data Flow:
 *   caller → createPage/updatePage → OCS or WebDAV → Nextcloud
 *
 * Dependency Map:
 *   resilient-wiki-writer.js
 *     ← session-persister.js
 *     ← tool-registry.js
 *     ← metadata-gardener.js
 *     ← heartbeat-manager.js
 *
 * @module resilient-wiki-writer
 * @version 1.0.0
 * @license AGPL-3.0
 */

'use strict';

const OCS_COOLDOWN_MS = 5 * 60 * 1000; // 5 minutes

class ResilientWikiWriter {
  /**
   * @param {Object} opts
   * @param {Object} opts.collectivesClient - CollectivesClient instance (OCS path)
   * @param {Object} opts.ncFilesClient - NCFilesClient instance (WebDAV path)
   * @param {string} [opts.collectivePath] - WebDAV path to Collectives folder
   * @param {Object} [opts.logger] - Logger (defaults to console)
   * @param {number} [opts.ocsTimeoutMs] - Timeout for OCS calls (default 10000)
   */
  constructor({ collectivesClient, ncFilesClient, collectivePath, logger, ocsTimeoutMs } = {}) {
    if (!collectivesClient) throw new Error('ResilientWikiWriter requires collectivesClient');
    if (!ncFilesClient) throw new Error('ResilientWikiWriter requires ncFilesClient');

    this.collectivesClient = collectivesClient;
    this.ncFilesClient = ncFilesClient;
    this.collectivePath = collectivePath || 'Collectives/Moltagent Knowledge';
    this.logger = logger || console;
    this.ocsTimeoutMs = ocsTimeoutMs || 10000;

    this._ocsHealthy = true;
    this._ocsLastFailure = 0;
  }

  /**
   * Whether OCS is currently considered healthy
   */
  get isOCSHealthy() {
    return this._shouldTryOCS();
  }

  /**
   * Create a page in a section. Tries OCS first, falls back to WebDAV.
   * @param {string} sectionPath - Section within collective (e.g. 'Sessions')
   * @param {string} pageName - Page title/filename
   * @param {string} content - Markdown content
   * @returns {Promise<{success: boolean, method: string|null, error?: string}>}
   */
  async createPage(sectionPath, pageName, content) {
    // CHOKEPOINT: ensure the section exists via OCS before ANY create path runs.
    // This is the single gate that prevents duplicate section pages regardless of
    // whether the page itself is created via OCS or WebDAV.
    try {
      const collectiveId = await this.collectivesClient.resolveCollective();
      await this.collectivesClient.ensureSection(collectiveId, sectionPath);
    } catch (err) {
      this.logger.warn?.(`[ResilientWikiWriter] ensureSection("${sectionPath}") failed: ${err.message}`);
      // Continue — the section may already exist from bootstrap, or WebDAV mkdir will create it
    }

    if (this._shouldTryOCS()) {
      try {
        const result = await this._createViaOCS(sectionPath, pageName, content);
        return result;
      } catch (err) {
        this._markOCSDown(err);
        this.logger.warn?.('[ResilientWikiWriter] OCS createPage failed, falling back to WebDAV:', err.message);
      }
    }

    try {
      const result = await this._createViaWebDAV(sectionPath, pageName, content);
      return result;
    } catch (err) {
      this.logger.error?.('[ResilientWikiWriter] WebDAV createPage also failed:', err.message);
      return { success: false, method: null, error: err.message };
    }
  }

  /**
   * Update an existing page. WebDAV primary, OCS fallback.
   * @param {string} pagePath - Path relative to collective (e.g. 'Sessions/2026-03-06.md')
   * @param {string} content - Markdown content
   * @returns {Promise<{success: boolean, method: string|null, error?: string}>}
   */
  async updatePage(pagePath, content) {
    try {
      const fullPath = `${this.collectivePath}/${pagePath}`;
      await this.ncFilesClient.writeFile(fullPath, content);
      return { success: true, method: 'webdav' };
    } catch (err) {
      this.logger.warn?.('[ResilientWikiWriter] WebDAV updatePage failed, trying OCS:', err.message);
    }

    if (this._shouldTryOCS()) {
      try {
        await this._withTimeout(
          this.collectivesClient.writePageContent(pagePath, content),
          this.ocsTimeoutMs
        );
        return { success: true, method: 'ocs' };
      } catch (err) {
        this._markOCSDown(err);
        this.logger.error?.('[ResilientWikiWriter] OCS updatePage also failed:', err.message);
      }
    }

    return { success: false, method: null, error: 'Both WebDAV and OCS failed' };
  }

  /**
   * Read a page via WebDAV.
   * @param {string} pagePath - Path relative to collective
   * @returns {Promise<{content: string, truncated: boolean}|null>}
   */
  async readPage(pagePath) {
    try {
      const fullPath = `${this.collectivePath}/${pagePath}`;
      return await this.ncFilesClient.readFile(fullPath);
    } catch (err) {
      this.logger.error?.('[ResilientWikiWriter] readPage failed:', err.message);
      return null;
    }
  }

  /**
   * List pages in a section. OCS primary, WebDAV PROPFIND fallback.
   * @param {string} sectionPath - Section path relative to collective
   * @returns {Promise<{pages: Array, method: string|null, error?: string}>}
   */
  async listPages(sectionPath) {
    if (this._shouldTryOCS()) {
      try {
        const collectiveId = await this._withTimeout(
          this.collectivesClient.resolveCollective(),
          this.ocsTimeoutMs
        );
        const allPages = await this._withTimeout(
          this.collectivesClient.listPages(collectiveId),
          this.ocsTimeoutMs
        );
        // Filter to pages under the requested section
        const filtered = (allPages || []).filter(p => {
          const path = p.filePath || p.path || '';
          return path.includes(`/${sectionPath}/`) || path.startsWith(`${sectionPath}/`);
        });
        return { pages: filtered, method: 'ocs' };
      } catch (err) {
        this._markOCSDown(err);
        this.logger.warn?.('[ResilientWikiWriter] OCS listPages failed, falling back to WebDAV:', err.message);
      }
    }

    try {
      const fullPath = `${this.collectivePath}/${sectionPath}`;
      const entries = await this.ncFilesClient.listDirectory(fullPath);
      const pages = (entries || []).map(e => ({
        title: (e.name || '').replace(/\.md$/i, ''),
        name: e.name,
        path: `${sectionPath}/${e.name}`,
        type: e.type,
        modified: e.modified
      }));
      return { pages, method: 'webdav' };
    } catch (err) {
      this.logger.error?.('[ResilientWikiWriter] WebDAV listPages also failed:', err.message);
      return { pages: [], method: null, error: err.message };
    }
  }

  // ── Internal: OCS create path ──

  async _createViaOCS(sectionPath, pageName, content) {
    const collectiveId = await this._withTimeout(
      this.collectivesClient.resolveCollective(),
      this.ocsTimeoutMs
    );

    // Section already ensured by createPage() chokepoint. Find it in the page list.
    const allPages = await this._withTimeout(
      this.collectivesClient.listPages(collectiveId),
      this.ocsTimeoutMs
    );

    const target = sectionPath.toLowerCase().trim();
    const sectionPage = (allPages || []).find(p => {
      const title = (p.title || '').toLowerCase().trim();
      return title === target || title.replace(/\s*\(\d+\)\s*$/, '') === target;
    });
    if (!sectionPage) {
      throw new Error(`Section "${sectionPath}" not found after ensureSection`);
    }
    const sectionId = sectionPage.id;

    // Check if the entity page already exists under the section.
    const existing = (allPages || []).find(p =>
      p.parentId === sectionId && (p.title || '') === pageName
    );

    // Track whether we created a new page so we can roll it back on write failure.
    let createdPage = null;
    if (!existing) {
      createdPage = await this._withTimeout(
        this.collectivesClient.createPage(collectiveId, sectionId, pageName),
        this.ocsTimeoutMs
      );
    }

    // Write content — if this fails and we just created an empty page, trash it
    // to avoid leaving a title-only stub in the wiki.
    const pagePath = `${sectionPath}/${pageName}.md`;
    try {
      await this._withTimeout(
        this.collectivesClient.writePageContent(pagePath, content),
        this.ocsTimeoutMs
      );
    } catch (writeErr) {
      if (createdPage && createdPage.id) {
        // Best-effort cleanup: delete the empty page we just created.
        try {
          await this._withTimeout(
            this.collectivesClient.trashPage(collectiveId, createdPage.id),
            this.ocsTimeoutMs
          );
          this.logger.warn?.(`[ResilientWikiWriter] Trashed empty page "${pageName}" after content write failed: ${writeErr.message}`);
        } catch (trashErr) {
          this.logger.warn?.(`[ResilientWikiWriter] Could not trash empty page "${pageName}": ${trashErr.message}`);
        }
      }
      throw writeErr;
    }

    return { success: true, method: 'ocs' };
  }

  // ── Internal: WebDAV create path ──

  async _createViaWebDAV(sectionPath, pageName, content) {
    const sectionDir = `${this.collectivePath}/${sectionPath}`;
    await this.ncFilesClient.mkdir(sectionDir);

    const filePath = `${sectionDir}/${pageName}.md`;
    await this.ncFilesClient.writeFile(filePath, content);

    return { success: true, method: 'webdav' };
  }

  // ── Health tracking ──

  _shouldTryOCS() {
    if (this._ocsHealthy) return true;
    const elapsed = Date.now() - this._ocsLastFailure;
    if (elapsed >= OCS_COOLDOWN_MS) {
      this._ocsHealthy = true;
      return true;
    }
    return false;
  }

  _markOCSDown(err) {
    // 404 = bad path, not a service outage — don't mark OCS unhealthy
    const status = err.statusCode || err.status || 0;
    const is404 = status === 404 || (err.message && err.message.includes('404'));
    if (is404) {
      this.logger.warn?.(`[ResilientWikiWriter] OCS 404 (bad path, not marking unhealthy): ${err.message}`);
      return;
    }
    this._ocsHealthy = false;
    this._ocsLastFailure = Date.now();
    this.logger.warn?.(`[ResilientWikiWriter] OCS marked unhealthy: ${err.message}`);
  }

  _withTimeout(promise, ms) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('OCS timeout')), ms);
      promise.then(
        val => { clearTimeout(timer); resolve(val); },
        err => { clearTimeout(timer); reject(err); }
      );
    });
  }
}

module.exports = ResilientWikiWriter;
