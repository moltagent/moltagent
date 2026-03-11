/*
 * Moltagent - Sovereign AI Security Layer
 * Copyright (C) 2026 Moltagent Contributors
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU Affero General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 */

/**
 * NC Flow Activity Poller
 *
 * Architecture Brief:
 * -------------------
 * Problem: Moltagent needs ambient awareness of workspace events (file changes,
 * calendar modifications, sharing, Deck updates, tag changes) without polling
 * each app API individually. The NC Activity API provides a single endpoint
 * that aggregates all workspace events.
 *
 * Pattern: Interval-based poller extending EventEmitter. Uses a `since` cursor
 * (last-seen activity_id) for deduplication and incremental fetches. Classifies
 * raw NC Activity types into normalized NCFlowEvent types. Filters by user and
 * event type before emitting.
 *
 * Key Dependencies:
 * - Node.js built-in: events
 * - NCRequestManager (for Activity API calls)
 *
 * Data Flow:
 * setInterval -> _poll() -> NCRequestManager.request(Activity API)
 *   -> _normalizeActivity() -> _classifyActivityType()
 *   -> emit('event', NCFlowEvent)
 *   -> HeartbeatManager.enqueueExternalEvent() (wired externally)
 *
 * Integration Points:
 * - src/lib/nc-flow/index.js (module export)
 * - src/lib/nc-request-manager.js (API calls)
 * - HeartbeatManager (event consumer, wired in a separate session)
 *
 * @module nc-flow/activity-poller
 * @version 1.0.0
 */

'use strict';

const { EventEmitter } = require('events');

/**
 * Map of NC Activity API `type` strings to normalized NCFlowEvent types.
 * File events use direct mapping; other categories use their own sub-maps.
 * Based on observed NC 31 Activity API responses.
 * @type {Object<string, string>}
 */
const FILE_TYPE_MAP = {
  'file_created': 'file_created',
  'file_changed': 'file_changed',
  'file_deleted': 'file_deleted',
  'file_restored': 'file_restored',
  'file_moved': 'file_changed',
  'file_renamed': 'file_changed',
  'file_favorited': 'file_changed',
};

/**
 * @type {Object<string, string>}
 */
const SHARE_TYPE_MAP = {
  'shared_with_by': 'share_created',
  'shared_user_self': 'share_created',
  'shared': 'share_created',           // NC 31 actual type for file/folder shares
  'remote_share': 'share_created',
  'public_links': 'file_shared',
  'shared_link_mail': 'file_shared',
};

/**
 * @type {Object<string, string>}
 */
const DECK_TYPE_MAP = {
  'deck_card_create': 'deck_card_created',
  'deck_card_update': 'deck_card_updated',
  'deck_card_move': 'deck_card_moved',
  'deck_comment_create': 'deck_comment_added',
  'deck_comment': 'deck_comment_added',           // NC 31 actual type
  'deck_card_description': 'deck_card_updated',    // card description edits
  'deck': 'deck_card_updated',                     // generic deck activity
};

/**
 * Map NC object_type strings to our internal object types.
 * @type {Object<string, string>}
 */
const OBJECT_TYPE_MAP = {
  'files': 'file',
  'file': 'file',
  'calendar': 'calendar',
  'calendar_event': 'calendar',
  'calendar_todo': 'calendar',
  'deck_card': 'deck_card',
  'deck_board': 'deck_card',
  'share': 'share',
  'systemtag': 'tag',
};

class ActivityPoller extends EventEmitter {
  /**
   * @param {Object} config - ncFlow.activity config section
   * @param {boolean} [config.enabled=true] - Whether polling is enabled
   * @param {number} [config.pollIntervalMs=60000] - Polling interval in milliseconds
   * @param {number} [config.maxEventsPerPoll=50] - Max events to fetch per API call
   * @param {boolean} [config.ignoreOwnEvents=true] - Skip events triggered by the moltagent user
   * @param {string[]} [config.ignoreUsers=[]] - Additional usernames to ignore
   * @param {string[]} [config.enabledTypes] - Only emit these event types (null = all)
   * @param {Object} ncRequestManager - NCRequestManager instance for API calls
   * @param {Object} [logger] - Optional logger (defaults to console)
   */
  constructor(config, ncRequestManager, logger) {
    super();
    this.config = config || {};
    this.nc = ncRequestManager;
    this.logger = logger || console;
    this.enabled = this.config.enabled !== false; // Default: enabled

    /** @type {number|null} Cursor for Activity API pagination */
    this.lastActivityId = null;

    /** @type {ReturnType<typeof setInterval>|null} */
    this.pollTimer = null;

    /** @type {boolean} Guard against overlapping polls */
    this.polling = false;

    /** @type {Object} Operational metrics */
    this.metrics = {
      totalPolls: 0,
      totalEvents: 0,
      emittedEvents: 0,
      skippedOwn: 0,
      errors: 0,
    };
  }

  /**
   * Start polling the Activity API.
   * Polls immediately on start, then at config.pollIntervalMs intervals.
   * @returns {boolean} true if started, false if disabled
   */
  start() {
    if (!this.enabled) {
      this.logger.info('[ActivityPoller] Disabled via config');
      return false;
    }

    this.logger.info(`[ActivityPoller] Starting — polling every ${this.config.pollIntervalMs}ms`);

    // Poll immediately on start, then on interval
    this._poll();
    this.pollTimer = setInterval(() => this._poll(), this.config.pollIntervalMs || 60000);
    return true;
  }

  /**
   * Stop polling. Clears the interval timer.
   */
  stop() {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
    this.logger.info('[ActivityPoller] Stopped');
  }

  /**
   * Execute one poll cycle.
   * Fetches activities from the NC Activity API since lastActivityId,
   * filters, normalizes, and emits events.
   *
   * Guard: If a previous poll is still in progress (this.polling === true),
   * this call is silently skipped to prevent overlap.
   *
   * @returns {Promise<void>}
   * @private
   */
  async _poll() {
    if (this.polling) return;  // Skip if previous poll still running
    this.polling = true;
    this.metrics.totalPolls++;

    try {
      // On initial poll (no cursor), fetch most recent activities (desc) to
      // fast-forward the cursor near the current time. Subsequent polls use
      // asc with since cursor for incremental new-event detection.
      const isInitial = !this.lastActivityId;
      const params = new URLSearchParams({
        limit: String(this.config.maxEventsPerPoll || 50),
        sort: isInitial ? 'desc' : 'asc'
      });

      if (this.lastActivityId) {
        params.set('since', String(this.lastActivityId));
      }

      const response = await this.nc.request(
        `/ocs/v2.php/apps/activity/api/v2/activity?${params.toString()}`,
        {
          method: 'GET',
          headers: {
            'Accept': 'application/json',
            'OCS-APIRequest': 'true'
          },
          // Route through OCS endpoint group in NCRequestManager
          endpointGroup: 'ocs',
          // Short cache — activity data changes frequently
          cacheTtlMs: 0  // Don't cache activity polls
        }
      );

      // NCRequestManager returns { status, headers, body, fromCache }
      // body is already parsed JSON when content-type is application/json
      const data = response.body || response;
      const activities = data?.ocs?.data || [];

      this.logger.info(`[ActivityPoller] Poll #${this.metrics.totalPolls}: ${activities.length} activities (since: ${this.lastActivityId || 'initial'})`);

      if (activities.length === 0) {
        this.polling = false;
        return;
      }

      this.metrics.totalEvents += activities.length;

      for (const activity of activities) {
        // Update cursor to latest seen ID
        if (activity.activity_id > (this.lastActivityId || 0)) {
          this.lastActivityId = activity.activity_id;
        }

        // Skip own events if configured (case-insensitive — NC may capitalize)
        if (this.config.ignoreOwnEvents && activity.user?.toLowerCase() === this.nc.ncUser?.toLowerCase()) {
          this.metrics.skippedOwn++;
          continue;
        }

        // Skip ignored users
        if (this.config.ignoreUsers?.includes(activity.user)) {
          continue;
        }

        // Normalize to NCFlowEvent
        const event = this._normalizeActivity(activity);

        // Filter by enabled types
        if (this.config.enabledTypes && !this.config.enabledTypes.includes(event.type)) {
          continue;
        }

        this.emit('event', event);
        this.metrics.emittedEvents++;
        this.logger.info(`[ActivityPoller] Emitted: ${event.type} by ${event.user} (${event.objectType}:${event.objectId})`);
      }
    } catch (err) {
      this.metrics.errors++;
      this.logger.error('[ActivityPoller] Poll error:', err.message);
      // Don't throw — we'll try again next interval
    } finally {
      this.polling = false;
    }
  }

  /**
   * Normalize an NC Activity API object into an NCFlowEvent.
   *
   * @param {Object} activity - Raw activity from NC Activity API
   * @param {number} activity.activity_id - Unique activity ID
   * @param {string} activity.type - NC activity type string
   * @param {string} activity.app - Source app name
   * @param {string} activity.user - User who triggered the activity
   * @param {string} activity.affecteduser - User affected by the activity
   * @param {string} activity.datetime - ISO 8601 datetime string
   * @param {string} activity.object_type - NC object type string
   * @param {number} activity.object_id - NC object ID
   * @param {string} activity.object_name - Object name/path
   * @param {string} activity.subject - Human-readable subject line
   * @returns {NCFlowEvent}
   * @private
   */
  _normalizeActivity(activity) {
    const type = this._classifyActivityType(activity.type, activity.app);
    const timestamp = new Date(activity.datetime).getTime();

    return {
      id: `activity:${activity.activity_id}`,
      source: 'activity',
      type,
      user: activity.user || activity.affecteduser || 'unknown',
      timestamp,
      objectType: this._mapObjectType(activity.object_type),
      objectId: String(activity.object_id || ''),
      objectName: activity.object_name || '',
      data: {
        activityId: activity.activity_id,
        app: activity.app,
        subject: activity.subject,
        rawType: activity.type,
        affectedUser: activity.affecteduser,
        // Don't store full raw — Activity payloads can be large
      }
    };
  }

  /**
   * Map NC Activity type strings to normalized NCFlowEvent types.
   *
   * NC Activity types are app-specific and inconsistent. This mapping
   * is based on NC 31 observed values. Falls back to app-based inference,
   * then to 'unknown'.
   *
   * @param {string} activityType - The `type` field from NC Activity API
   * @param {string} app - The `app` field from NC Activity API
   * @returns {string} Normalized event type
   * @private
   */
  _classifyActivityType(activityType, app) {
    // File events
    if (FILE_TYPE_MAP[activityType]) return FILE_TYPE_MAP[activityType];

    // Sharing events
    if (SHARE_TYPE_MAP[activityType]) return SHARE_TYPE_MAP[activityType];

    // Deck events
    if (DECK_TYPE_MAP[activityType]) return DECK_TYPE_MAP[activityType];

    // Calendar events
    if (activityType === 'calendar_event' || (app === 'dav' && activityType.includes('calendar'))) {
      return 'calendar_event_changed';
    }
    if (activityType === 'calendar_todo') {
      return 'calendar_todo_changed';
    }

    // Tag events
    if (activityType === 'systemtag_assign') return 'tag_assigned';
    if (activityType === 'systemtag_unassign') return 'tag_removed';

    // App-based fallback
    if (app === 'files') return 'file_changed';
    if (app === 'files_sharing') return 'share_created';
    if (app === 'deck') return 'deck_card_updated';
    if (app === 'dav') return 'calendar_event_changed';

    return 'unknown';
  }

  /**
   * Map NC object_type strings to our internal object types.
   * @param {string} ncObjectType - The `object_type` field from NC Activity API
   * @returns {string} Internal object type
   * @private
   */
  _mapObjectType(ncObjectType) {
    return OBJECT_TYPE_MAP[ncObjectType] || ncObjectType || 'unknown';
  }

  /**
   * Get current operational metrics.
   * @returns {Object} Metrics snapshot including totalPolls, totalEvents,
   *   emittedEvents, skippedOwn, errors, lastActivityId, enabled, polling
   */
  getMetrics() {
    return {
      ...this.metrics,
      lastActivityId: this.lastActivityId,
      enabled: this.enabled,
      polling: this.polling,
    };
  }

  /**
   * Force an immediate poll cycle (for testing or on-demand use).
   * @returns {Promise<void>}
   */
  async pollNow() {
    return this._poll();
  }
}

module.exports = {
  ActivityPoller,
  FILE_TYPE_MAP,
  SHARE_TYPE_MAP,
  DECK_TYPE_MAP,
  OBJECT_TYPE_MAP,
};
