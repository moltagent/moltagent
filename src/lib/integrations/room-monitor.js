/**
 * MoltAgent Room Monitor
 *
 * Architecture Brief:
 * -------------------
 * Problem: When a user adds Moltagent to a new Talk room, nothing happens
 * until the next heartbeat pulse (5 min). NC Talk's bot webhook only fires
 * in rooms where the bot is already enabled (chicken-and-egg).
 *
 * Pattern: Lightweight poller (60s default) that detects new rooms and
 * sends welcome messages immediately as the Moltagent USER (not bot).
 * Also detects when bot activation completes and sends a confirmation.
 *
 * Key Dependencies:
 * - NCRequestManager -- all Nextcloud API calls go through this gateway
 * - BotEnroller -- checked for bot activation status via isBotActiveInRoom()
 * - config.roomMonitor -- enabled flag and interval
 *
 * Data Flow:
 * 1. On start(), fetch baseline room list (no messages sent)
 * 2. Every intervalMs, fetch current room list
 * 3. New rooms (not in baseline) get a welcome message
 * 4. Rooms where bot just became active get a confirmation message
 * 5. Track all messaged rooms to prevent duplicates
 *
 * @module integrations/room-monitor
 * @version 1.0.0
 */

'use strict';

class RoomMonitor {
  /**
   * @param {Object} opts
   * @param {Object} opts.ncRequestManager - NCRequestManager instance for API calls
   * @param {Object} [opts.botEnroller] - BotEnroller instance (for isBotActiveInRoom)
   * @param {Object} [opts.config] - Config object (appConfig)
   */
  constructor(opts = {}) {
    if (!opts.ncRequestManager) {
      throw new Error('RoomMonitor requires an ncRequestManager');
    }

    this.nc = opts.ncRequestManager;
    this.botEnroller = opts.botEnroller || null;
    this.config = opts.config || {};

    /** @type {Set<string>} Room tokens known at startup (no messages sent for these) */
    this._knownRooms = new Set();

    /** @type {Set<string>} Room tokens where we already sent the welcome message */
    this._welcomeSentRooms = new Set();

    /** @type {Set<string>} Room tokens where we already sent the bot-active confirmation */
    this._confirmSentRooms = new Set();

    /** @type {boolean} Whether baseline has been loaded */
    this._baselineLoaded = false;

    /** @type {ReturnType<typeof setInterval>|null} */
    this._intervalHandle = null;
  }

  /**
   * Start the room monitor.
   * Loads baseline room list, then starts polling interval.
   */
  async start() {
    if (this._intervalHandle) {
      console.log('[RoomMonitor] Already running');
      return;
    }

    // Load baseline
    try {
      const rooms = await this._fetchRooms();
      for (const room of rooms) {
        this._knownRooms.add(room.token);
      }
      this._baselineLoaded = true;
      console.log(`[RoomMonitor] Baseline: ${this._knownRooms.size} known rooms`);
    } catch (err) {
      console.warn(`[RoomMonitor] Baseline fetch failed: ${err.message}`);
      // Still start polling — baseline will grow as rooms are seen
      this._baselineLoaded = true;
    }

    const intervalMs = this.config.roomMonitor?.intervalMs || 60000;
    this._intervalHandle = setInterval(() => {
      this.check().catch(err => {
        console.error(`[RoomMonitor] Check error: ${err.message}`);
      });
    }, intervalMs);

    console.log(`[RoomMonitor] Started (interval: ${intervalMs / 1000}s)`);
  }

  /**
   * Stop the room monitor.
   */
  stop() {
    if (this._intervalHandle) {
      clearInterval(this._intervalHandle);
      this._intervalHandle = null;
      console.log('[RoomMonitor] Stopped');
    }
  }

  /**
   * Single check cycle: fetch rooms, detect new ones, send messages.
   * @returns {Promise<{checked: number, welcomed: number, confirmed: number}>}
   */
  async check() {
    if (!this._baselineLoaded) {
      return { checked: 0, welcomed: 0, confirmed: 0 };
    }

    const results = { checked: 0, welcomed: 0, confirmed: 0 };

    let rooms;
    try {
      rooms = await this._fetchRooms();
    } catch (err) {
      console.warn(`[RoomMonitor] Room fetch failed: ${err.message}`);
      return results;
    }

    results.checked = rooms.length;

    for (const room of rooms) {
      const token = room.token;

      // New room detected
      if (!this._knownRooms.has(token)) {
        this._knownRooms.add(token);

        // Check if bot is already active (moderator pre-enabled it)
        if (this.botEnroller && this.botEnroller.isBotActiveInRoom(token)) {
          // Bot already active — send confirmation instead of welcome
          if (!this._confirmSentRooms.has(token)) {
            await this._sendConfirmation(token);
            results.confirmed++;
          }
        } else {
          // Bot not active yet — send welcome with activation instructions
          if (!this._welcomeSentRooms.has(token)) {
            await this._sendWelcomeMessage(token);
            results.welcomed++;
          }
        }
        continue;
      }

      // Existing room: check if bot just became active (wasn't before)
      if (this.botEnroller
          && this.botEnroller.isBotActiveInRoom(token)
          && this._welcomeSentRooms.has(token)
          && !this._confirmSentRooms.has(token)) {
        await this._sendConfirmation(token);
        results.confirmed++;
      }
    }

    if (results.welcomed > 0 || results.confirmed > 0) {
      console.log(`[RoomMonitor] Cycle: ${results.welcomed} welcomed, ${results.confirmed} confirmed`);
    }

    return results;
  }

  /**
   * Fetch group/public rooms the authenticated user participates in.
   * @returns {Promise<Array<Object>>} Room objects with at least { token, type }
   * @private
   */
  async _fetchRooms() {
    const response = await this.nc.request(
      '/ocs/v2.php/apps/spreed/api/v4/room',
      {
        method: 'GET',
        headers: { 'OCS-APIRequest': 'true', 'Accept': 'application/json' }
      }
    );
    const data = response.body?.ocs?.data || [];
    // Filter to group (type 2) and public (type 3) conversations
    return data.filter(r => r.type === 2 || r.type === 3);
  }

  /**
   * Send a welcome/activation message to a new room.
   * @param {string} token - Room token
   * @private
   */
  async _sendWelcomeMessage(token) {
    const message =
      '\ud83d\udc4b Hi! I\'ve been added to this room but I can\'t listen to messages yet.\n\n' +
      'To activate me, a moderator needs to:\n' +
      '1. Click the **\u22ef** menu (top right, next to the room name)\n' +
      '2. Select **Conversation settings**\n' +
      '3. Go to **Bots** in the left sidebar\n' +
      '4. Click **Enable** next to MoltAgent\n\n' +
      'Once enabled, I\'ll be ready to help! \ud83d\udfe2';

    try {
      await this._sendMessage(token, message);
      this._welcomeSentRooms.add(token);
      console.log(`[RoomMonitor] Sent welcome to room ${token}`);
    } catch (err) {
      console.warn(`[RoomMonitor] Failed to send welcome to ${token}: ${err.message}`);
    }
  }

  /**
   * Send a confirmation message after bot activation is detected.
   * @param {string} token - Room token
   * @private
   */
  async _sendConfirmation(token) {
    const message = '\u2705 I\'m active in this room now! Feel free to ask me anything.';

    try {
      await this._sendMessage(token, message);
      this._confirmSentRooms.add(token);
      console.log(`[RoomMonitor] Sent confirmation to room ${token}`);
    } catch (err) {
      console.warn(`[RoomMonitor] Failed to send confirmation to ${token}: ${err.message}`);
    }
  }

  /**
   * Send a chat message to a room via the Talk API (as the Moltagent user).
   * @param {string} token - Room token
   * @param {string} message - Message text
   * @private
   */
  async _sendMessage(token, message) {
    await this.nc.request(
      `/ocs/v2.php/apps/spreed/api/v1/chat/${token}`,
      {
        method: 'POST',
        headers: {
          'OCS-APIRequest': 'true',
          'Content-Type': 'application/json',
          'Accept': 'application/json'
        },
        body: { message }
      }
    );
  }
}

module.exports = RoomMonitor;
