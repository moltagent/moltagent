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

/*
 * Architecture Brief
 * ------------------
 * Problem: The agent has no memory between conversations. Every heartbeat cycle
 * starts from zero with no knowledge of what was learned previously.
 *
 * Pattern: Append-only markdown log stored via Nextcloud WebDAV. Entries are
 * batched in memory and flushed periodically to reduce API calls. The markdown
 * format is both human-readable in Nextcloud Files and machine-parseable for
 * context loading.
 *
 * Key Dependencies:
 *   - NCRequestManager: WebDAV GET/PUT for reading/writing the log file
 *     Returns: { status, headers, body, fromCache }
 *     body is raw string for text/markdown Content-Type
 *
 * Data Flow:
 *   log(entry) -> pendingWrites[] -> scheduleWrite() -> flushWrites()
 *     flushWrites: GET existing -> merge -> PUT updated
 *   getRecent(limit) -> GET file -> parseLog() -> entries[]
 *
 * Dependency Map:
 *   learning-log.js depends on: NCRequestManager (injected)
 *   Used by: context-loader.js, heartbeat-manager.js, bot.js
 */

/**
 * Append-only learning log stored in Nextcloud via WebDAV.
 * Records what the agent learns from conversations and tasks.
 *
 * @module knowledge/learning-log
 */
class LearningLog {
  /**
   * @param {Object} options
   * @param {import('../nc-request-manager')} options.ncRequestManager - NCRequestManager instance
   * @param {string} [options.logPath='/Memory/LearningLog.md'] - WebDAV path relative to user root
   * @param {string} [options.username='moltagent'] - Nextcloud username for WebDAV path
   * @param {number} [options.writeDebounceMs=5000] - Batch write interval in ms
   */
  constructor({ ncRequestManager, logPath = '/Memory/LearningLog.md', username = 'moltagent', writeDebounceMs = 5000 }) {
    this.nc = ncRequestManager;
    this.logPath = logPath;
    this.username = username;
    this.pendingWrites = [];
    this.writeDebounceMs = writeDebounceMs;
    this.writeTimer = null;
    this._flushing = false;
  }

  /**
   * Build the full WebDAV URL path for the log file.
   * @private
   * @returns {string}
   */
  _webdavPath() {
    return `/remote.php/dav/files/${this.username}${this.logPath}`;
  }

  /**
   * Record a learning event. Queues the entry for batched writing.
   *
   * @param {Object} entry
   * @param {string} entry.type - 'learned' | 'updated' | 'uncertainty' | 'contradiction'
   * @param {string} entry.content - What was learned (human-readable)
   * @param {string} entry.source - Where it came from (user mention, file, inference)
   * @param {string} [entry.confidence='medium'] - 'high' | 'medium' | 'low' | 'disputed'
   * @param {Object} [entry.context={}] - Additional context (roomToken, userId, taskId)
   * @returns {Object} The structured record that was queued
   */
  async log(entry) {
    const record = {
      timestamp: new Date().toISOString(),
      type: entry.type || 'learned',
      content: entry.content,
      source: entry.source,
      confidence: entry.confidence || 'medium',
      context: entry.context || {}
    };

    this.pendingWrites.push(record);
    this._scheduleWrite();

    return record;
  }

  /**
   * Convenience: Record something learned from a user.
   * @param {string} content - What was learned
   * @param {string} source - Where it came from
   * @param {string} [confidence='medium'] - Confidence level
   * @returns {Object} The queued record
   */
  async learned(content, source, confidence = 'medium') {
    return this.log({ type: 'learned', content, source, confidence });
  }

  /**
   * Convenience: Record uncertainty that needs verification.
   * @param {string} content - What is uncertain
   * @param {string} source - Where the uncertainty arose
   * @param {Object} [context={}] - Additional context
   * @returns {Object} The queued record
   */
  async uncertain(content, source, context = {}) {
    return this.log({ type: 'uncertainty', content, source, confidence: 'low', context });
  }

  /**
   * Convenience: Record a contradiction between sources.
   * @param {string} content - Description of the contradiction
   * @param {string} source - Where the contradiction was found
   * @param {Object} [context={}] - Additional context
   * @returns {Object} The queued record
   */
  async contradiction(content, source, context = {}) {
    return this.log({ type: 'contradiction', content, source, confidence: 'disputed', context });
  }

  /**
   * Get recent log entries by reading and parsing the markdown file.
   * @param {number} [limit=50] - Maximum entries to return
   * @returns {Promise<Array<Object>>} Parsed entries, most recent first
   */
  async getRecent(limit = 50) {
    try {
      const response = await this.nc.request(this._webdavPath(), {
        method: 'GET',
        headers: { 'Accept': 'text/markdown' },
        skipCache: true
      });

      // NCRequestManager returns { status, headers, body, fromCache }
      // For text files, body is the raw string (not parsed as JSON)
      if (response.status === 404) {
        return [];
      }

      if (response.status >= 400) {
        throw new Error(`Failed to read log: HTTP ${response.status}`);
      }

      const text = typeof response.body === 'string' ? response.body : '';
      return this.parseLog(text, limit);
    } catch (error) {
      if (error.message && error.message.includes('404')) {
        return [];
      }
      console.error('[LearningLog] Failed to read learning log:', error.message);
      return [];
    }
  }

  /**
   * Parse markdown log into structured entries.
   * Format:
   *   ## YYYY-MM-DD
   *   ### HH:MM - Type: Content
   *   - **Source:** value
   *   - **Confidence:** value
   *   - **Room:** value (optional)
   *   - **User:** value (optional)
   *
   * @param {string} text - Raw markdown content
   * @param {number} limit - Max entries to return
   * @returns {Array<Object>} Parsed entries, most recent first
   */
  parseLog(text, limit) {
    const entries = [];
    const lines = text.split('\n');
    let currentDate = null;
    let currentEntry = null;

    for (const line of lines) {
      // Match date heading: ## YYYY-MM-DD
      if (line.startsWith('## ')) {
        const match = line.match(/## (\d{4}-\d{2}-\d{2})/);
        if (match) {
          currentDate = match[1];
        }
        continue;
      }

      // Match entry heading: ### HH:MM - Type: Content
      if (line.startsWith('### ')) {
        if (currentEntry) {
          entries.push(currentEntry);
        }
        const match = line.match(/### (\d{2}:\d{2}) - (\w+): (.+)/);
        if (match && currentDate) {
          currentEntry = {
            timestamp: `${currentDate}T${match[1]}:00Z`,
            type: match[2].toLowerCase(),
            content: match[3]
          };
        } else {
          currentEntry = null;
        }
        continue;
      }

      // Match detail lines: - **Key:** Value
      if (currentEntry && line.startsWith('- **')) {
        const detailMatch = line.match(/- \*\*(.+?):\*\* (.+)/);
        if (detailMatch) {
          currentEntry[detailMatch[1].toLowerCase()] = detailMatch[2];
        }
      }
    }

    // Push the last entry
    if (currentEntry) {
      entries.push(currentEntry);
    }

    // Return most recent first, limited
    return entries.reverse().slice(0, limit);
  }

  /**
   * Schedule a batched write to avoid hammering the API.
   * @private
   */
  _scheduleWrite() {
    if (this.writeTimer) return;

    this.writeTimer = setTimeout(async () => {
      this.writeTimer = null;
      await this.flushWrites();
    }, this.writeDebounceMs);
  }

  /**
   * Flush pending writes to the log file via WebDAV.
   * Reads existing content, merges new entries, writes back.
   */
  async flushWrites() {
    if (this.pendingWrites.length === 0 || this._flushing) return;
    this._flushing = true;

    // Drain the pending queue
    const entries = this.pendingWrites.splice(0, this.pendingWrites.length);
    const markdown = this._formatEntries(entries);

    try {
      // Read existing content
      let existing = '';
      const readResponse = await this.nc.request(this._webdavPath(), {
        method: 'GET',
        headers: { 'Accept': 'text/markdown' },
        skipCache: true
      });

      if (readResponse.status >= 200 && readResponse.status < 300) {
        existing = typeof readResponse.body === 'string' ? readResponse.body : '';
      } else if (readResponse.status !== 404) {
        throw new Error(`Failed to read log: HTTP ${readResponse.status}`);
      }
      // 404 is fine -- we will create a new file

      // Append new entries
      const updated = this._appendToLog(existing, markdown);

      // Write back
      const writeResponse = await this.nc.request(this._webdavPath(), {
        method: 'PUT',
        body: updated,
        headers: { 'Content-Type': 'text/markdown' }
      });

      if (writeResponse.status >= 400) {
        throw new Error(`Failed to write log: HTTP ${writeResponse.status}`);
      }

      console.log(`[LearningLog] Wrote ${entries.length} entries`);
    } catch (error) {
      console.error('[LearningLog] Failed to write learning log:', error.message);
      // Re-queue failed entries at the front (cap at 500 to prevent unbounded growth)
      this.pendingWrites.unshift(...entries);
      if (this.pendingWrites.length > 500) {
        const dropped = this.pendingWrites.length - 500;
        this.pendingWrites.length = 500;
        console.warn(`[LearningLog] Dropped ${dropped} oldest entries (queue cap reached)`);
      }
    } finally {
      this._flushing = false;
    }
  }

  /**
   * Format entries as markdown grouped by date.
   * @private
   * @param {Array<Object>} entries
   * @returns {string} Markdown text
   */
  _formatEntries(entries) {
    const byDate = {};

    for (const entry of entries) {
      const date = entry.timestamp.split('T')[0];
      const time = entry.timestamp.split('T')[1].substring(0, 5);

      if (!byDate[date]) byDate[date] = [];

      let md = `### ${time} - ${this._capitalize(entry.type)}: ${entry.content}\n`;
      md += `- **Source:** ${entry.source}\n`;
      md += `- **Confidence:** ${this._capitalize(entry.confidence)}\n`;

      if (entry.context.roomToken) {
        md += `- **Room:** ${entry.context.roomToken}\n`;
      }
      if (entry.context.userId) {
        md += `- **User:** ${entry.context.userId}\n`;
      }

      md += '\n';
      byDate[date].push(md);
    }

    let result = '';
    // Sort dates descending so newest is first
    for (const [date, items] of Object.entries(byDate).sort().reverse()) {
      result += `## ${date}\n\n`;
      result += items.join('');
    }

    return result;
  }

  /**
   * Append new entries to existing log, keeping newest entries at top.
   * @private
   * @param {string} existing - Existing log content
   * @param {string} newEntries - Formatted new entries
   * @returns {string} Merged log content
   */
  _appendToLog(existing, newEntries) {
    if (!existing.trim()) {
      return `# MoltAgent Learning Log\n\n${newEntries}`;
    }

    // Insert new entries after the header line
    const headerEnd = existing.indexOf('\n## ');
    if (headerEnd === -1) {
      return existing + '\n' + newEntries;
    }

    // Insert new content right after header, before existing date sections
    return existing.substring(0, headerEnd) + '\n' + newEntries + existing.substring(headerEnd);
  }

  /**
   * Convenience: Record a wiki page change for automatic journaling.
   * Called from wiki_write tool handler after successful page creation/update.
   *
   * @param {string} action - 'created' | 'updated'
   * @param {string} pageTitle - Wiki page title
   * @param {Object} [metadata={}] - Optional { confidence, type, roomToken, userId }
   * @returns {Object} The queued record
   */
  async logKnowledgeChange(action, pageTitle, metadata = {}) {
    const content = `Wiki ${action}: "${pageTitle}"`;
    const source = 'wiki_write';
    return this.log({
      type: action === 'created' ? 'learned' : 'updated',
      content,
      source,
      confidence: metadata.confidence || 'medium',
      context: {
        wikiPage: pageTitle,
        wikiAction: action,
        ...metadata
      }
    });
  }

  /**
   * Force flush any pending writes and cancel the timer.
   * Called during shutdown to ensure no data is lost.
   */
  async shutdown() {
    if (this.writeTimer) {
      clearTimeout(this.writeTimer);
      this.writeTimer = null;
    }
    await this.flushWrites();
  }

  /**
   * Capitalize the first letter of a string.
   * @private
   * @param {string} str
   * @returns {string}
   */
  _capitalize(str) {
    if (!str) return '';
    return str.charAt(0).toUpperCase() + str.slice(1);
  }
}

module.exports = { LearningLog };
