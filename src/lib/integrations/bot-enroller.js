/**
 * MoltAgent Bot Enroller
 *
 * Architecture Brief:
 * -------------------
 * Problem: When users add the "MoltAgent" Nextcloud user to a Talk room, the
 * bot webhook does not fire because the NC Talk bot must also be separately
 * enabled in that room. Users are unaware of this requirement.
 *
 * Pattern: Periodic poll-and-enroll. BotEnroller lists rooms the authenticated
 * user participates in, then enables the bot in each room that has not been
 * enrolled yet. Safe to call repeatedly -- enrolled rooms are cached in a Set
 * so redundant API calls are avoided.
 *
 * Key Dependencies:
 * - NCRequestManager -- all Nextcloud API calls go through this gateway
 * - config.talk.botName -- the registered bot name to look up
 * - auditLog -- optional audit logging function
 *
 * Data Flow:
 * 1. Resolve bot ID via admin endpoint (or per-room fallback)
 * 2. List rooms user is a participant of (OCS Spreed API)
 * 3. For each room not yet in the enrolled Set, POST to enable the bot
 * 4. Track successes and skip 403/400 gracefully
 *
 * Integration Points:
 * - HeartbeatManager.pulse() calls enrollAll() every cycle (level >= 1)
 * - webhook-server.js calls enrollAll() once at startup
 * - bot.js calls enrollAll() once at startup + via heartbeat
 *
 * @module integrations/bot-enroller
 * @version 1.0.0
 */

'use strict';

class BotEnroller {
  /**
   * @param {Object} opts
   * @param {Object} opts.ncRequestManager - NCRequestManager instance for API calls
   * @param {Object} [opts.config] - Configuration object (or pass botName directly)
   * @param {string} [opts.config.botName='MoltAgent'] - Name of the bot to look up
   * @param {string} [opts.botName='MoltAgent'] - Shortcut for config.botName
   * @param {Function} [opts.auditLog] - Audit log function (event, data) => Promise
   */
  constructor(opts = {}) {
    if (!opts.ncRequestManager) {
      throw new Error('BotEnroller requires an ncRequestManager');
    }

    this.nc = opts.ncRequestManager;
    this.botName = opts.botName || opts.config?.botName || 'MoltAgent';
    this.auditLog = opts.auditLog || null;

    /** @type {number|null} Resolved on first run via admin or per-room discovery */
    this._botId = null;

    /** @type {Set<string>} Room tokens we have already enrolled (this session) */
    this._enrolledRooms = new Set();

  }

  /**
   * Attempt to enroll the bot in a single room. Used for instant enrollment
   * when a webhook arrives for a room where the bot isn't active yet.
   * Rate-limited: skips if room was already attempted this session.
   *
   * @param {string} roomToken - Talk room token
   * @returns {Promise<{enrolled: boolean}>}
   */
  async enrollRoom(roomToken) {
    // Skip if already enrolled or attempted
    if (this._enrolledRooms.has(roomToken)) {
      return { enrolled: false };
    }

    // Resolve bot ID if needed
    if (!this._botId) {
      try { await this._resolveBotId(); } catch { /* ignore */ }
      if (!this._botId) return { enrolled: false };
    }

    try {
      const enrolled = await this._enableBotInRoom(roomToken);
      this._enrolledRooms.add(roomToken);
      if (enrolled) {
        console.log(`[BotEnroller] Instant-enrolled bot in room ${roomToken}`);
      }
      return { enrolled };
    } catch (err) {
      const statusCode = this._extractStatusCode(err);
      this._enrolledRooms.add(roomToken); // Don't retry
      if (statusCode === 403 || statusCode === 400) {
        // Expected: not moderator or bot already active
      }
      return { enrolled: false };
    }
  }

  /**
   * Check all rooms the user is in and enable the bot where needed.
   * Safe to call repeatedly -- skips already-enrolled rooms.
   *
   * @returns {Promise<Object>} Results object with checked, enrolled, skipped, errors
   */
  async enrollAll() {
    // 1. Resolve our bot ID (once per session)
    if (!this._botId) {
      try {
        await this._resolveBotId();
      } catch (err) {
        console.warn(`[BotEnroller] Bot ID resolution failed: ${err.message}`);
      }
      if (!this._botId) {
        return { checked: 0, enrolled: 0, skipped: 0, errors: [] };
      }
    }

    // 2. List rooms we are in
    let rooms;
    try {
      rooms = await this._listRooms();
    } catch (err) {
      console.error(`[BotEnroller] Failed to list rooms: ${err.message}`);
      return { checked: 0, enrolled: 0, skipped: 0, errors: [{ room: '*', error: err.message }] };
    }

    const results = { checked: rooms.length, enrolled: 0, skipped: 0, errors: [] };

    for (const room of rooms) {
      // Skip rooms we already enrolled in (this session)
      if (this._enrolledRooms.has(room.token)) {
        results.skipped++;
        continue;
      }

      try {
        const enrolled = await this._enableBotInRoom(room.token);
        this._enrolledRooms.add(room.token);
        if (enrolled) {
          results.enrolled++;
        } else {
          results.skipped++;
        }
      } catch (err) {
        // Parse HTTP status from NCRequestManager error messages
        const statusCode = this._extractStatusCode(err);

        if (statusCode === 400 || statusCode === 403) {
          // 400 = bot already enabled or not available
          // 403 = not a moderator
          this._enrolledRooms.add(room.token); // Don't retry
          results.skipped++;
        } else {
          results.errors.push({ room: room.token, error: err.message });
        }
      }
    }

    if (results.enrolled > 0) {
      console.log(`[BotEnroller] Enabled bot in ${results.enrolled} new room(s)`);
      if (this.auditLog) {
        try {
          await this.auditLog('bot_enrolled', {
            enrolled: results.enrolled,
            total: rooms.length
          });
        } catch {
          // Audit failure should never break enrollment
        }
      }
    }

    return results;
  }

  /**
   * Resolve our bot's numeric ID from the admin endpoint.
   * Falls back to per-room discovery if admin access is unavailable.
   *
   * @returns {Promise<void>}
   * @private
   */
  async _resolveBotId() {
    // Try admin endpoint first
    try {
      const response = await this.nc.request(
        '/ocs/v2.php/apps/spreed/api/v1/bot/admin',
        {
          method: 'GET',
          headers: { 'OCS-APIRequest': 'true', 'Accept': 'application/json' }
        }
      );
      const data = response.body?.ocs?.data || [];
      const bot = data.find(b => b.name === this.botName);
      if (bot) {
        this._botId = bot.id;
        console.log(`[BotEnroller] Resolved bot ID: ${this._botId} (${this.botName})`);
        return;
      }
    } catch (err) {
      // Not admin -- expected; fall through to per-room discovery
      console.warn(`[BotEnroller] Admin bot list unavailable: ${err.message}`);
    }

    // Fallback: try to discover bot ID from rooms we are in
    try {
      const rooms = await this._listRooms();
      for (const room of rooms) {
        const discovered = await this._discoverBotIdFromRoom(room.token);
        if (discovered) return;
      }
    } catch {
      // Could not list rooms either
    }

    console.warn('[BotEnroller] Could not resolve bot ID -- enrollment disabled');
  }

  /**
   * List Talk rooms the authenticated user participates in.
   * Filters to group (type 2) and public (type 3) conversations.
   *
   * @returns {Promise<Array<Object>>} Array of room objects with at least { token, type }
   * @private
   */
  async _listRooms() {
    const response = await this.nc.request(
      '/ocs/v2.php/apps/spreed/api/v4/room',
      {
        method: 'GET',
        headers: { 'OCS-APIRequest': 'true', 'Accept': 'application/json' }
      }
    );
    const data = response.body?.ocs?.data || [];
    // Filter to group/public conversations (type 2 or 3)
    // Skip 1-on-1 (type 1), changelog (type 4), and former (type 5)
    return data.filter(r => r.type === 2 || r.type === 3);
  }

  /**
   * Enable the bot in a specific room.
   *
   * @param {string} roomToken - The Talk room token
   * @returns {Promise<boolean>} true if newly enabled (201), false if already enabled (200)
   * @throws {Error} On HTTP errors (403 not moderator, 400 not available, etc.)
   * @private
   */
  async _enableBotInRoom(roomToken) {
    // If we still don't have a bot ID, try to discover it from this room
    if (!this._botId) {
      await this._discoverBotIdFromRoom(roomToken);
      if (!this._botId) return false;
    }

    const response = await this.nc.request(
      `/ocs/v2.php/apps/spreed/api/v1/bot/${roomToken}/${this._botId}`,
      {
        method: 'POST',
        headers: { 'OCS-APIRequest': 'true', 'Accept': 'application/json' }
      }
    );

    // NCRequestManager resolves 200-299 and 404; rejects 401/403 and other 4xx/5xx.
    // But 200 (already enabled) and 201 (newly enabled) both resolve here.
    return response.status === 201;
  }

  /**
   * Attempt to discover the bot ID by listing bots available in a room.
   *
   * @param {string} roomToken - The Talk room token
   * @returns {Promise<boolean>} true if bot ID was discovered
   * @private
   */
  async _discoverBotIdFromRoom(roomToken) {
    try {
      const response = await this.nc.request(
        `/ocs/v2.php/apps/spreed/api/v1/bot/${roomToken}`,
        {
          method: 'GET',
          headers: { 'OCS-APIRequest': 'true', 'Accept': 'application/json' }
        }
      );
      const bots = response.body?.ocs?.data || [];
      const bot = bots.find(b => b.name === this.botName);
      if (bot) {
        this._botId = bot.id;
        console.log(`[BotEnroller] Discovered bot ID: ${this._botId} from room ${roomToken}`);
        return true;
      }
    } catch {
      // Can't list bots in this room -- likely not moderator
    }
    return false;
  }

  /**
   * Extract HTTP status code from NCRequestManager error messages.
   * NCRequestManager rejects with Error messages like:
   * - "Authentication error: 403"
   * - "HTTP 400: Bad Request"
   *
   * @param {Error} err
   * @returns {number|null} HTTP status code or null
   * @private
   */
  _extractStatusCode(err) {
    if (!err || !err.message) return null;
    // Match "Authentication error: 403" or "Authentication error: 401"
    const authMatch = err.message.match(/Authentication error:\s*(\d{3})/);
    if (authMatch) return parseInt(authMatch[1], 10);
    // Match "HTTP 400: ..."
    const httpMatch = err.message.match(/HTTP\s+(\d{3})/);
    if (httpMatch) return parseInt(httpMatch[1], 10);
    return null;
  }

  /**
   * Check if the bot is currently active (enrolled) in a specific room.
   * Sync method — checks the in-memory cache only.
   *
   * @param {string} roomToken - Talk room token
   * @returns {boolean} true if bot is known to be enrolled in this room
   */
  isBotActiveInRoom(roomToken) {
    return this._enrolledRooms.has(roomToken);
  }

  /**
   * Clear the enrolled rooms cache.
   * Useful for daily reset or when rooms may have changed.
   */
  resetCache() {
    this._enrolledRooms.clear();
  }

  /**
   * Get the current bot ID (for diagnostics).
   * @returns {number|null}
   */
  get botId() {
    return this._botId;
  }

  /**
   * Get count of enrolled rooms (for diagnostics).
   * @returns {number}
   */
  get enrolledCount() {
    return this._enrolledRooms.size;
  }
}

module.exports = BotEnroller;
