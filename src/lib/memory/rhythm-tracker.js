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
 * RhythmTracker — Behavioral session pattern tracking for the Living Agent.
 *
 * Architecture Brief:
 * - Problem: Agent has no awareness of its own usage patterns across sessions
 * - Pattern: Record lightweight session metadata on every session close; derive
 *   behavioral patterns (peak hours, avg duration, topic breadth) from a 30-day
 *   rolling window without LLM involvement
 * - Key Dependencies: NCFilesClient (WebDAV persistence at Memory/rhythms.json)
 * - Data Flow: session ends → recordSession(meta) → _sessions buffer → tick() →
 *              _save() → rhythms.json; getPatterns() → analyze rolling window
 * - Dependency Map: heartbeat-manager.js → rhythm-tracker.js → nc-files-client.js
 *
 * Persisted format (Memory/rhythms.json):
 * [
 *   { startTime, endTime, duration, messageCount, directiveRatio,
 *     topicDiversity, roomName, recordedAt }
 * ]
 *
 * 90-day rolling window is enforced on every _save() to bound file size.
 *
 * @module memory/rhythm-tracker
 * @version 1.0.0
 */

const FILE_PATH = 'Memory/rhythms.json';
const ROLLING_WINDOW_DAYS = 90;
const ROLLING_WINDOW_MS = ROLLING_WINDOW_DAYS * 24 * 60 * 60 * 1000;

class RhythmTracker {
  /**
   * @param {Object} deps
   * @param {import('../integrations/nc-files-client').NCFilesClient} deps.ncFilesClient
   * @param {Object} [deps.logger]
   */
  constructor({ ncFilesClient, logger } = {}) {
    if (!ncFilesClient) throw new Error('RhythmTracker requires ncFilesClient');
    this.ncFilesClient = ncFilesClient;
    this.logger = logger || console;

    /** @type {Array<Object>} Rolling array of session entries */
    this._sessions = [];

    /** @type {boolean} True when in-memory state has not yet been persisted */
    this._dirty = false;

    /** @type {boolean} True once _load() has completed (lazy init flag) */
    this._loaded = false;

    this._filePath = FILE_PATH;
  }

  // ===========================================================================
  // Public API
  // ===========================================================================

  /**
   * Append a completed session entry to the in-memory rolling array.
   * Triggers a lazy load on the first call so the array is populated before
   * any new entry is appended.
   *
   * @param {Object} sessionMeta
   * @param {string} sessionMeta.startTime     - ISO timestamp of session start
   * @param {string} sessionMeta.endTime       - ISO timestamp of session end
   * @param {number} sessionMeta.duration      - Session length in seconds
   * @param {number} sessionMeta.messageCount  - Total messages exchanged
   * @param {number} sessionMeta.directiveRatio - Fraction of messages that were directives (0–1)
   * @param {number} sessionMeta.topicDiversity - Measure of topic spread (0–1)
   * @param {string} sessionMeta.roomName      - Talk room where session occurred
   * @returns {Promise<void>}
   */
  async recordSession(sessionMeta) {
    if (!sessionMeta || typeof sessionMeta !== 'object') return;

    await this._ensureLoaded();

    this._sessions.push({
      startTime:      sessionMeta.startTime      || null,
      endTime:        sessionMeta.endTime        || null,
      duration:       sessionMeta.duration       != null ? sessionMeta.duration       : 0,
      messageCount:   sessionMeta.messageCount   != null ? sessionMeta.messageCount   : 0,
      directiveRatio: sessionMeta.directiveRatio != null ? sessionMeta.directiveRatio : 0,
      topicDiversity: sessionMeta.topicDiversity != null ? sessionMeta.topicDiversity : 0,
      roomName:       sessionMeta.roomName       || 'unknown',
      recordedAt:     new Date().toISOString()
    });

    this._dirty = true;
  }

  /**
   * Analyze sessions within the last N days and return behavioral pattern data.
   * Lazy-loads from disk on first call.
   *
   * @param {number} [days=30] - Lookback window in days
   * @returns {Promise<{
   *   peakHours: number[],
   *   avgDuration: number,
   *   avgMessages: number,
   *   directiveTendency: number,
   *   topicBreadth: number,
   *   sessionCount: number
   * }>}
   */
  async getPatterns(days = 30) {
    const safedays = (Number.isFinite(days) && days > 0) ? days : 30;

    await this._ensureLoaded();

    const cutoff = Date.now() - safedays * 24 * 60 * 60 * 1000;

    const window = this._sessions.filter(s => {
      // Use recordedAt as the canonical timestamp for windowing
      const ts = s.recordedAt ? new Date(s.recordedAt).getTime() : 0;
      return Number.isFinite(ts) && ts >= cutoff;
    });

    const zeroed = {
      peakHours:         [],
      avgDuration:       0,
      avgMessages:       0,
      directiveTendency: 0,
      topicBreadth:      0,
      sessionCount:      0
    };

    if (window.length === 0) return zeroed;

    // --- Accumulate numeric metrics ---
    let totalDuration       = 0;
    let totalMessages       = 0;
    let totalDirective      = 0;
    let totalTopicDiversity = 0;

    // Hour frequency map (0-23) keyed on the hour extracted from startTime
    const hourFreq = {};

    for (const s of window) {
      totalDuration       += Number.isFinite(s.duration)       ? s.duration       : 0;
      totalMessages       += Number.isFinite(s.messageCount)   ? s.messageCount   : 0;
      totalDirective      += Number.isFinite(s.directiveRatio) ? s.directiveRatio : 0;
      totalTopicDiversity += Number.isFinite(s.topicDiversity) ? s.topicDiversity : 0;

      // Derive hour from startTime; fall back to recordedAt if startTime missing
      const timeSource = s.startTime || s.recordedAt;
      if (timeSource) {
        const ts = new Date(timeSource).getTime();
        if (Number.isFinite(ts)) {
          const hour = new Date(ts).getHours(); // local hour (0-23)
          hourFreq[hour] = (hourFreq[hour] || 0) + 1;
        }
      }
    }

    const n = window.length;

    // Sort hour entries descending by frequency, extract just the hour numbers
    const peakHours = Object.entries(hourFreq)
      .sort((a, b) => b[1] - a[1])
      .map(([h]) => parseInt(h, 10));

    return {
      peakHours,
      avgDuration:       totalDuration       / n,
      avgMessages:       totalMessages       / n,
      directiveTendency: totalDirective      / n,
      topicBreadth:      totalTopicDiversity / n,
      sessionCount:      n
    };
  }

  /**
   * Called by HeartbeatManager on every pulse.
   * Flushes pending session data to disk when dirty.
   *
   * @returns {Promise<void>}
   */
  async tick() {
    if (this._dirty) {
      await this._save();
    }
  }

  // ===========================================================================
  // Persistence
  // ===========================================================================

  /**
   * Load sessions from NCFiles at Memory/rhythms.json.
   * On 404 or parse error, initializes an empty array.
   * Sets _loaded = true once complete.
   *
   * @returns {Promise<void>}
   * @private
   */
  async _load() {
    try {
      const { content } = await this.ncFilesClient.readFile(this._filePath);
      const parsed = JSON.parse(content);

      if (Array.isArray(parsed)) {
        this._sessions = parsed;
      } else {
        // Unexpected shape — start fresh without discarding the file
        this._sessions = [];
        this.logger.warn('[RhythmTracker] rhythms.json had unexpected shape, starting fresh');
      }

      this.logger.info(
        `[RhythmTracker] Loaded ${this._sessions.length} session records`
      );
    } catch (err) {
      // 404 on first run or JSON parse failure — normal bootstrap path
      this._sessions = [];
      this.logger.info('[RhythmTracker] No existing rhythms file found, starting fresh');
    }

    this._loaded = true;
  }

  /**
   * Prune sessions older than 90 days, then persist the rolling array to
   * NCFiles as JSON. Clears _dirty on success.
   *
   * @returns {Promise<void>}
   * @private
   */
  async _save() {
    const cutoff = Date.now() - ROLLING_WINDOW_MS;

    // Prune sessions outside the 90-day rolling window
    const before = this._sessions.length;
    this._sessions = this._sessions.filter(s => {
      const ts = s.recordedAt ? new Date(s.recordedAt).getTime() : 0;
      return Number.isFinite(ts) && ts >= cutoff;
    });
    const pruned = before - this._sessions.length;

    if (pruned > 0) {
      this.logger.info(`[RhythmTracker] Pruned ${pruned} session records older than ${ROLLING_WINDOW_DAYS} days`);
    }

    try {
      const payload = JSON.stringify(this._sessions, null, 2);
      await this.ncFilesClient.writeFile(this._filePath, payload);
      this._dirty = false;
      this.logger.info(
        `[RhythmTracker] Saved ${this._sessions.length} session records`
      );
    } catch (err) {
      this.logger.error(`[RhythmTracker] Save failed: ${err.message}`);
      // _dirty remains true so next tick() will retry
    }
  }

  // ===========================================================================
  // Helpers
  // ===========================================================================

  /**
   * Ensure sessions are loaded from disk exactly once (lazy initialization).
   * Sets _loaded before awaiting _load() to prevent concurrent loads.
   *
   * @returns {Promise<void>}
   * @private
   */
  async _ensureLoaded() {
    if (!this._loaded) {
      this._loaded = true; // guard against concurrent callers
      await this._load();
    }
  }
}

module.exports = RhythmTracker;
