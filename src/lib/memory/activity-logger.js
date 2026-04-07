/*
 * Moltagent - Sovereign AI Security Layer
 * Copyright (C) 2026 Moltagent Contributors
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU Affero General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 */

'use strict';

/**
 * ActivityLogger — Layer 1 of the Two-Layer Memory System.
 *
 * Architecture Brief:
 * - Problem: Wiki stays empty because writes depend on LLM choosing to write
 * - Pattern: Pure code logging — every executor action appends one line, no LLM
 * - Key Dependencies: CollectivesClient (wiki write)
 * - Data Flow: executor completes → append(entry) → buffer → flush() → wiki page
 * - Dependency Map: base-executor.js → activity-logger.js → collectives-client.js
 *
 * @module memory/activity-logger
 * @version 1.0.0
 */

class ActivityLogger {
  /**
   * @param {Object} deps
   * @param {Object} deps.wikiClient - CollectivesClient for writing to wiki
   * @param {Object} [deps.logger]
   */
  constructor({ wikiClient, logger } = {}) {
    if (!wikiClient) throw new Error('ActivityLogger requires a wikiClient');
    this.wiki = wikiClient;
    this.logger = logger || console;
    this._buffer = [];
    this._flushInterval = 60000; // 60 seconds
    this._lastFlush = Date.now();
    this._flushInProgress = false;
    this._todayPageName = null;
  }

  /**
   * Append an activity entry. Called by executors after every action.
   * Buffers in memory and flushes periodically to avoid API spam.
   *
   * @param {Object} entry
   * @param {string} entry.action - Tool/action name (e.g., 'calendar_create')
   * @param {string} entry.summary - One-line human-readable summary
   * @param {Object} [entry.details] - Structured data for Layer 2 extraction
   * @param {string} [entry.user] - Who triggered it
   * @param {string} [entry.room] - Which Talk room
   */
  append(entry) {
    if (!entry || !entry.action) return;

    const timestamp = new Date().toISOString().slice(11, 16); // HH:MM

    this._buffer.push({
      time: timestamp,
      action: entry.action,
      summary: entry.summary || '',
      details: entry.details || {},
      user: entry.user || 'unknown',
      room: entry.room || 'unknown',
      processed: false // Layer 2 hasn't extracted from this yet
    });

    // Hard cap: prevent unbounded growth if extraction never runs
    if (this._buffer.length > 500) {
      this._buffer = this._buffer.slice(-200);
    }

    // Auto-flush if buffer is large or enough time has passed
    if (this._buffer.length >= 10 ||
        Date.now() - this._lastFlush > this._flushInterval) {
      this.flush().catch(err =>
        this.logger.error(`[ActivityLogger] Flush failed: ${err.message}`)
      );
    }
  }

  /**
   * Write buffered entries to the daily wiki page.
   * Called automatically by append() or manually by heartbeat.
   */
  async flush() {
    if (this._flushInProgress || this._buffer.length === 0) return;
    this._flushInProgress = true;

    try {
      return await this._doFlush();
    } finally {
      this._flushInProgress = false;
    }
  }

  /** @private */
  async _doFlush() {
    const today = new Date().toISOString().slice(0, 10);
    const pageName = `Meta/Activity Log ${today}`;

    // Format entries as markdown table rows
    const unflushed = this._buffer.filter(e => !e._flushed);
    if (unflushed.length === 0) return;

    // Escape pipe chars and newlines to avoid breaking markdown tables
    const esc = (s) => String(s || '').replace(/\|/g, '\\|').replace(/\n/g, ' ');

    const lines = unflushed.map(e =>
      `| ${esc(e.time)} | ${esc(e.action)} | ${esc(e.summary)} | ${esc(e.user)} |`
    );

    const newContent = lines.join('\n') + '\n';

    try {
      // Read existing page content (append, don't overwrite)
      let existing = '';
      try {
        const page = await this.wiki.readPageContent(pageName);
        if (page) existing = page;
      } catch (_e) {
        // Page doesn't exist yet — create with header
        existing = `# Activity Log — ${today}\n\n| Time | Action | Summary | User |\n|------|--------|---------|------|\n`;
      }

      await this.wiki.writePageContent(pageName, existing + newContent);

      this._lastFlush = Date.now();
      this._todayPageName = pageName;

      // Mark as flushed (but keep for Layer 2 extraction)
      for (const e of unflushed) {
        e._flushed = true;
      }

      this.logger.info(
        `[ActivityLogger] Flushed ${unflushed.length} entries to ${pageName}`
      );
    } catch (err) {
      this.logger.error(`[ActivityLogger] Wiki write failed: ${err.message}`);
      // Entries stay in buffer for next attempt
    }
  }

  /**
   * Get unprocessed entries for Layer 2 extraction.
   * Called by HeartbeatExtractor.
   * @returns {Array}
   */
  getUnprocessedEntries() {
    return this._buffer.filter(e => !e.processed);
  }

  /**
   * Mark entries as processed by Layer 2.
   * @param {number} count - Number of entries to mark
   */
  markProcessed(count) {
    let marked = 0;
    for (const entry of this._buffer) {
      if (!entry.processed && marked < count) {
        entry.processed = true;
        marked++;
      }
    }

    // Prune old processed entries (keep last 100 unprocessed + 20 processed)
    if (this._buffer.length > 120) {
      const unprocessed = this._buffer.filter(e => !e.processed);
      const processed = this._buffer.filter(e => e.processed).slice(-20);
      this._buffer = unprocessed.concat(processed);
    }
  }

  /**
   * Get today's page name (for HeartbeatExtractor to read).
   * @returns {string|null}
   */
  getTodayPageName() {
    return this._todayPageName;
  }

  /**
   * Get current buffer size (for monitoring).
   * @returns {number}
   */
  getBufferSize() {
    return this._buffer.length;
  }
}

module.exports = { ActivityLogger };
