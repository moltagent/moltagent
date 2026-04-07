/*
 * Moltagent - Sovereign AI Security Layer
 * Copyright (C) 2026 Moltagent Contributors
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU Affero General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the
 * GNU Affero General Public License for more details.
 *
 * You should have received a copy of the GNU Affero General Public License
 * along with this program. If not, see <https://www.gnu.org/licenses/>.
 */

'use strict';

/**
 * GapDetector — Surfaces knowledge gaps by comparing conversation topics
 * against the semantic content of the wiki vector store.
 *
 * Architecture Brief:
 * - Problem: Topics discussed frequently in Talk have no corresponding wiki
 *   pages, so institutional knowledge never accumulates around them.
 * - Pattern: Track mention frequency per topic; embed topics and search
 *   the vector store; alert via Talk when similarity is below threshold.
 *   Gated to 12-pulse cadence (~1 hour) to avoid spamming.
 * - Key Dependencies:
 *     VectorStore (SQLite cosine search),
 *     EmbeddingClient (Ollama embed),
 *     NCFilesClient (cooldown persistence),
 *     TalkSendQueue (Talk notifications)
 * - Data Flow:
 *     recordMention(topic) → _mentions Map
 *     tick() every pulse → detectGaps() every 12th pulse
 *     detectGaps() → embed each topic → vectorStore.search()
 *       → gap found (score < 0.35) → surfaceGap() → Talk message
 *       → _saveCooldowns()
 * - Dependency Map:
 *     heartbeat-manager.js → gap-detector.js
 *       → vector-store.js
 *       → embedding-client.js
 *       → nc-files-client.js
 *       → talk-send-queue.js (or compatible talkClient)
 *
 * @module memory/gap-detector
 * @version 1.0.0
 */

const SIMILARITY_THRESHOLD = 0.35;
const MIN_MENTION_COUNT = 3;
const COOLDOWN_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
const PULSE_GATE = 12; // run detectGaps() every 12 pulses

class GapDetector {
  /**
   * @param {Object} deps
   * @param {Object} deps.vectorStore - VectorStore instance with .search(queryVector, limit, threshold)
   * @param {Object} deps.embeddingClient - EmbeddingClient with .embed(text) → Float64Array
   * @param {Object} deps.ncFilesClient - NCFilesClient with .readFile(path) and .writeFile(path, content)
   * @param {Object} deps.talkClient - TalkSendQueue or compatible; must have enqueue(token, msg) or sendMessage(token, msg)
   * @param {Object} [deps.config] - Config object
   * @param {Object} [deps.config.talk] - Talk config
   * @param {string} [deps.config.talk.primaryRoom] - Room token to post gap alerts into
   * @param {Object} [deps.logger] - Logger instance (defaults to console)
   */
  constructor({ vectorStore, embeddingClient, ncFilesClient, talkClient, config, logger } = {}) {
    this.vectorStore = vectorStore || null;
    this.embeddingClient = embeddingClient || null;
    this.ncFilesClient = ncFilesClient || null;
    this.talkClient = talkClient || null;
    this.config = config || {};
    this.logger = logger || console;

    // topic (lowercase, trimmed) → { count: number, lastMentioned: number (ms) }
    this._mentions = new Map();

    // topic → lastAlerted timestamp (ms) — loaded from / persisted to NC Files
    this._cooldowns = new Map();

    this._pulseCount = 0;
    this._cooldownFile = 'Memory/gap-cooldowns.json';
    this._cooldownsLoaded = false;
  }

  // ===========================================================================
  // Public API
  // ===========================================================================

  /**
   * Track a mentioned topic. Increments count and updates lastMentioned.
   * Safe to call on every message — no I/O performed.
   *
   * @param {string} topic - The topic string to record
   * @returns {void}
   */
  recordMention(topic) {
    if (!topic || typeof topic !== 'string') return;

    const normalized = topic.toLowerCase().trim();
    if (normalized.length === 0) return;

    const existing = this._mentions.get(normalized);
    if (existing) {
      existing.count += 1;
      existing.lastMentioned = Date.now();
    } else {
      this._mentions.set(normalized, { count: 1, lastMentioned: Date.now() });
    }
  }

  /**
   * Scan topics with count >= 3, embed each, search the vector store,
   * and surface gaps where the best similarity score is below 0.35.
   * Respects a 7-day per-topic cooldown to avoid repeated alerts.
   *
   * @returns {Promise<{gaps: number, checked: number}>}
   */
  async detectGaps() {
    // Ensure cooldowns are loaded from disk before first run
    if (!this._cooldownsLoaded) {
      await this._loadCooldowns();
      this._cooldownsLoaded = true;
    }

    if (!this.vectorStore || !this.embeddingClient) {
      this.logger.warn('[GapDetector] vectorStore or embeddingClient unavailable — skipping gap detection');
      return { gaps: 0, checked: 0 };
    }

    const candidates = [];
    for (const [topic, data] of this._mentions) {
      if (data.count >= MIN_MENTION_COUNT) {
        candidates.push(topic);
      }
    }

    if (candidates.length === 0) {
      return { gaps: 0, checked: 0 };
    }

    const now = Date.now();
    let gapsFound = 0;

    for (const topic of candidates) {
      // Check 7-day cooldown before embedding (avoids unnecessary Ollama calls)
      const lastAlerted = this._cooldowns.get(topic);
      if (lastAlerted && now - lastAlerted < COOLDOWN_MS) {
        continue;
      }

      let queryVector;
      try {
        queryVector = await this.embeddingClient.embed(topic);
      } catch (err) {
        this.logger.warn(`[GapDetector] Failed to embed topic "${topic}": ${err.message}`);
        continue;
      }

      let results;
      try {
        // Search with threshold 0 so we can inspect the best score ourselves
        results = this.vectorStore.search(queryVector, 1, 0);
      } catch (err) {
        this.logger.warn(`[GapDetector] vectorStore.search failed for "${topic}": ${err.message}`);
        continue;
      }

      // Determine the best similarity score
      const bestScore = results.length > 0 ? results[0].score : 0;

      if (bestScore < SIMILARITY_THRESHOLD) {
        // Gap detected — post alert and record cooldown
        await this.surfaceGap(topic, bestScore);
        gapsFound++;
      }
    }

    // Persist any updated cooldowns after this sweep
    if (gapsFound > 0) {
      await this._saveCooldowns();
    }

    return { gaps: gapsFound, checked: candidates.length };
  }

  /**
   * Post a gap alert to Talk and record the cooldown for this topic.
   *
   * @param {string} topic - The topic with no wiki coverage
   * @param {number} score - Best cosine similarity found (< 0.35)
   * @returns {Promise<void>}
   */
  async surfaceGap(topic, score) {
    if (!topic || typeof topic !== 'string') return;

    const roomToken = this.config && this.config.talk && this.config.talk.primaryRoom
      ? this.config.talk.primaryRoom
      : null;

    if (!roomToken) {
      this.logger.warn(`[GapDetector] No primaryRoom configured — cannot surface gap for "${topic}"`);
      // Still record the cooldown so we don't re-check immediately
      this._cooldowns.set(topic, Date.now());
      return;
    }

    const message = `I noticed we discuss **${topic}** but I have no notes on it. Consider creating a wiki page?`;

    if (!this.talkClient) {
      this.logger.warn(`[GapDetector] No talkClient — cannot post gap alert for "${topic}"`);
      this._cooldowns.set(topic, Date.now());
      return;
    }

    try {
      // Support both TalkSendQueue.enqueue() and a plain sendMessage() interface
      if (typeof this.talkClient.enqueue === 'function') {
        await this.talkClient.enqueue(roomToken, message);
      } else if (typeof this.talkClient.sendMessage === 'function') {
        await this.talkClient.sendMessage(roomToken, message);
      } else {
        this.logger.warn('[GapDetector] talkClient has neither enqueue() nor sendMessage()');
      }

      const scoreStr = Number.isFinite(score) ? score.toFixed(3) : 'N/A';
      this.logger.info(`[GapDetector] Surfaced gap: "${topic}" (score=${scoreStr})`);
    } catch (err) {
      this.logger.error(`[GapDetector] Failed to send gap alert for "${topic}": ${err.message}`);
    }

    // Update cooldown regardless of send success so we don't retry immediately
    this._cooldowns.set(topic, Date.now());
  }

  /**
   * Called every heartbeat pulse. Increments the internal pulse counter and
   * runs detectGaps() every 12 pulses (~1 hour at a 5-minute pulse interval).
   *
   * Never throws — all errors are caught and logged.
   *
   * @returns {Promise<{gaps: number, checked: number}|null>}
   */
  async tick() {
    this._pulseCount++;

    if (this._pulseCount % PULSE_GATE !== 0) {
      return null;
    }

    try {
      const result = await this.detectGaps();
      return result;
    } catch (err) {
      this.logger.error(`[GapDetector] tick() error: ${err.message}`);
      return null;
    }
  }

  // ===========================================================================
  // Persistence
  // ===========================================================================

  /**
   * Load persisted cooldowns from NC Files (Memory/gap-cooldowns.json).
   * On any read/parse error, starts with an empty cooldowns map.
   *
   * @returns {Promise<void>}
   * @private
   */
  async _loadCooldowns() {
    if (!this.ncFilesClient) {
      this.logger.info('[GapDetector] No ncFilesClient — cooldowns will not persist');
      return;
    }

    try {
      const { content } = await this.ncFilesClient.readFile(this._cooldownFile);
      const parsed = JSON.parse(content);

      // Expect an object of topic → timestamp (number)
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        this._cooldowns = new Map(Object.entries(parsed));
        this.logger.info(`[GapDetector] Loaded ${this._cooldowns.size} cooldowns from ${this._cooldownFile}`);
      } else {
        this._cooldowns = new Map();
        this.logger.info('[GapDetector] Cooldown file had unexpected shape — starting fresh');
      }
    } catch (err) {
      // 404 on first run or JSON parse failure — start with empty map
      this._cooldowns = new Map();
      this.logger.info('[GapDetector] No existing cooldown file — starting fresh');
    }
  }

  /**
   * Persist the current cooldowns map to NC Files as JSON.
   * On write failure, logs error but does not throw.
   *
   * @returns {Promise<void>}
   * @private
   */
  async _saveCooldowns() {
    if (!this.ncFilesClient) return;

    try {
      // Convert Map to plain object for JSON serialisation
      const obj = Object.fromEntries(this._cooldowns);
      const payload = JSON.stringify(obj, null, 2);
      await this.ncFilesClient.writeFile(this._cooldownFile, payload);
      this.logger.info(`[GapDetector] Saved ${this._cooldowns.size} cooldowns to ${this._cooldownFile}`);
    } catch (err) {
      this.logger.error(`[GapDetector] Failed to save cooldowns: ${err.message}`);
    }
  }
}

module.exports = GapDetector;
