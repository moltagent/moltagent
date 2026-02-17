'use strict';

/**
 * WarmMemory — Molti's persistent working memory (prefrontal cortex analog).
 *
 * A single bounded markdown file (Memory/WARM.md) stored in NC Files via WebDAV,
 * loaded into every session's system prompt, updated on session expiry.
 *
 * - Loaded at session start (injected into system prompt alongside SOUL.md)
 * - Updated at session end via consolidate()
 * - Hard-capped at 200 lines
 * - Cached in memory with 60s TTL to minimize WebDAV calls
 *
 * Storage: NC Files via WebDAV at Memory/WARM.md
 * Why NC Files over Collectives: Single GET/PUT = 1 HTTP call vs Collectives OCS chain.
 *
 * @module integrations/warm-memory
 * @version 1.0.0
 */

class WarmMemory {
  /**
   * @param {Object} options
   * @param {import('./nc-files-client').NCFilesClient} options.ncFilesClient
   * @param {Object} [options.logger]
   * @param {Object} [options.config]
   * @param {string} [options.config.filePath='Memory/WARM.md']
   * @param {number} [options.config.maxLines=200]
   * @param {number} [options.config.cacheTTLMs=60000]
   */
  constructor({ ncFilesClient, logger, config = {} }) {
    this.ncFilesClient = ncFilesClient;
    this.logger = logger || console;
    this.filePath = config.filePath || 'Memory/WARM.md';
    this.maxLines = config.maxLines || 200;
    this.cacheTTLMs = config.cacheTTLMs || 60000;

    this._cache = null;
    this._cacheAge = 0;
    this._consolidating = false;
  }

  /**
   * Load WARM.md content for injection into system prompt.
   * Returns the raw markdown string. Uses 60s in-memory cache.
   * On 404 (first run): creates initial template + Memory/ directory.
   * On other errors: returns stale cache if available.
   * @returns {Promise<string>}
   */
  async load() {
    if (this._cache && Date.now() - this._cacheAge < this.cacheTTLMs) {
      return this._cache;
    }

    try {
      const { content } = await this.ncFilesClient.readFile(this.filePath);
      this._cache = content;
      this._cacheAge = Date.now();
      return content;
    } catch (err) {
      if (err.statusCode === 404) {
        const initial = await this._createInitial();
        this._cache = initial;
        this._cacheAge = Date.now();
        return initial;
      }
      this.logger.warn(`[WarmMemory] Load failed: ${err.message}`);
      return this._cache || '';
    }
  }

  /**
   * Save updated WARM.md content.
   * Enforces line cap before writing.
   * @param {string} content
   * @returns {Promise<void>}
   */
  async save(content) {
    content = this._enforceLineCap(content);
    await this.ncFilesClient.writeFile(this.filePath, content);
    this._cache = content;
    this._cacheAge = Date.now();
  }

  /**
   * Merge session data into WARM.md.
   * Called during session expiry consolidation.
   *
   * @param {Object} updates
   * @param {string} [updates.continuation] - What to pick up next time
   * @param {string} [updates.openItems] - Unresolved questions/tasks (raw markdown)
   * @param {string} [updates.timestamp] - ISO timestamp of the session
   * @returns {Promise<string>} The updated WARM.md content
   */
  async consolidate(updates) {
    // Simple lock to prevent concurrent consolidation interleaving
    if (this._consolidating) {
      this.logger.warn('[WarmMemory] Consolidation already in progress, skipping');
      return this._cache || '';
    }

    this._consolidating = true;
    try {
      const current = await this.load();
      const sections = this._parse(current);

      // Merge continuation (newest first)
      if (updates.continuation) {
        const ts = updates.timestamp
          ? new Date(updates.timestamp).toISOString().split('T')[0]
          : new Date().toISOString().split('T')[0];
        const entry = `- **${ts}:** ${updates.continuation}`;
        sections.continuation.unshift(entry);
        // Keep only last 10 continuation entries
        if (sections.continuation.length > 10) {
          sections.continuation = sections.continuation.slice(0, 10);
        }
      }

      // Merge open items (deduplicate by normalized content)
      if (updates.openItems) {
        const newItems = updates.openItems
          .split('\n')
          .map(l => l.trim())
          .filter(l => l.length > 0 && l !== 'None' && l !== 'none');

        const existing = new Set(
          sections.openItems.map(i => i.replace(/^[-*]\s*/, '').toLowerCase().trim())
        );

        for (const item of newItems) {
          const normalized = item.replace(/^[-*]\s*/, '').toLowerCase().trim();
          if (!existing.has(normalized)) {
            sections.openItems.push(item.startsWith('-') ? item : `- ${item}`);
            existing.add(normalized);
          }
        }

        // Keep only last 15 open items
        if (sections.openItems.length > 15) {
          sections.openItems = sections.openItems.slice(-15);
        }
      }

      const rebuilt = this._rebuild(sections);
      await this.save(rebuilt);
      return rebuilt;
    } finally {
      this._consolidating = false;
    }
  }

  /**
   * Clear cached content, forcing next load() to read from WebDAV.
   */
  invalidateCache() {
    this._cache = null;
    this._cacheAge = 0;
  }

  /**
   * Create initial WARM.md template + Memory/ directory.
   * @private
   * @returns {Promise<string>} The initial template content
   */
  async _createInitial() {
    // Ensure Memory/ directory exists (mkdir handles 405 already-exists gracefully)
    try {
      await this.ncFilesClient.mkdir('Memory');
    } catch (err) {
      this.logger.warn(`[WarmMemory] mkdir Memory/ failed: ${err.message}`);
    }

    const template = [
      '# Working Memory',
      '',
      '## Where We Left Off',
      'No previous sessions yet.',
      '',
      '## Open Items',
      'No open items.',
      '',
      '## Key Context',
      'No context recorded yet.',
      '',
      '---',
      `Last updated: ${new Date().toISOString()}`
    ].join('\n');

    try {
      await this.ncFilesClient.writeFile(this.filePath, template);
      this.logger.info('[WarmMemory] Created initial WARM.md');
    } catch (err) {
      this.logger.error(`[WarmMemory] Failed to create initial WARM.md: ${err.message}`);
    }

    return template;
  }

  /**
   * Parse WARM.md into structured sections.
   * @private
   * @param {string} content
   * @returns {{ continuation: string[], openItems: string[], keyContext: string[] }}
   */
  _parse(content) {
    const sections = {
      continuation: [],
      openItems: [],
      keyContext: []
    };

    if (!content) return sections;

    // Split by ## headers
    const parts = content.split(/^## /m);

    for (const part of parts) {
      const firstNewline = part.indexOf('\n');
      if (firstNewline === -1) continue;

      const header = part.substring(0, firstNewline).trim().toLowerCase();
      const body = part.substring(firstNewline + 1).trim();
      const lines = body.split('\n').filter(l => l.trim().length > 0);

      // Skip placeholder lines
      const meaningful = lines.filter(l =>
        !l.startsWith('No previous sessions') &&
        !l.startsWith('No open items') &&
        !l.startsWith('No context recorded') &&
        !l.startsWith('---') &&
        !l.startsWith('Last updated:')
      );

      if (header.includes('where we left off') || header.includes('continuation')) {
        sections.continuation = meaningful;
      } else if (header.includes('open item')) {
        sections.openItems = meaningful;
      } else if (header.includes('key context') || header.includes('key fact') || header.includes('about')) {
        sections.keyContext = meaningful;
      }
    }

    return sections;
  }

  /**
   * Rebuild WARM.md from structured sections.
   * @private
   * @param {{ continuation: string[], openItems: string[], keyContext: string[] }} sections
   * @returns {string}
   */
  _rebuild(sections) {
    const lines = ['# Working Memory', ''];

    lines.push('## Where We Left Off');
    if (sections.continuation.length > 0) {
      lines.push(...sections.continuation);
    } else {
      lines.push('No previous sessions yet.');
    }
    lines.push('');

    lines.push('## Open Items');
    if (sections.openItems.length > 0) {
      lines.push(...sections.openItems);
    } else {
      lines.push('No open items.');
    }
    lines.push('');

    lines.push('## Key Context');
    if (sections.keyContext.length > 0) {
      lines.push(...sections.keyContext);
    } else {
      lines.push('No context recorded yet.');
    }
    lines.push('');

    lines.push('---');
    lines.push(`Last updated: ${new Date().toISOString()}`);

    return lines.join('\n');
  }

  /**
   * Enforce the line cap by trimming oldest non-header lines.
   * @private
   * @param {string} content
   * @returns {string}
   */
  _enforceLineCap(content) {
    const lines = content.split('\n');
    if (lines.length <= this.maxLines) return content;

    this.logger.warn(`[WarmMemory] Enforcing ${this.maxLines}-line cap (was ${lines.length})`);

    // Re-parse, trim each section proportionally, rebuild
    const sections = this._parse(content);
    const totalEntries = sections.continuation.length + sections.openItems.length + sections.keyContext.length;
    const overhead = 15; // headers, separators, metadata
    const budget = this.maxLines - overhead;

    if (totalEntries > budget && totalEntries > 0) {
      const ratio = budget / totalEntries;
      sections.continuation = sections.continuation.slice(0, Math.max(1, Math.floor(sections.continuation.length * ratio)));
      sections.openItems = sections.openItems.slice(0, Math.max(1, Math.floor(sections.openItems.length * ratio)));
      sections.keyContext = sections.keyContext.slice(0, Math.max(1, Math.floor(sections.keyContext.length * ratio)));
    }

    return this._rebuild(sections);
  }
}

module.exports = WarmMemory;
