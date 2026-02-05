# Moltagent NC Flow Integration — Claude Code Implementation Brief

**Date:** 2026-02-08  
**Author:** Fu + Claude Opus (architecture)  
**Executor:** Claude Code  
**Estimated CCode time:** ~2.5 hours  
**Dependencies:** NCRequestManager must exist. HeartbeatManager must exist. TalkClient must exist.  
**Context:** Field-tested on Hetzner Storage Share NC 31.0.13 (nx89136.your-storageshare.de)

---

## Context

We tested NC Flow capabilities on Storage Share and discovered:

- Webhook Listeners app is installed and functional on NC 31, BUT only 2 trashbin events are whitelisted (not useful for production)
- NC 32 will significantly expand the webhook event whitelist — Hetzner will likely upgrade by Q2 2026
- NC Activity API is available and tracks all events we need (files, calendar, sharing, Deck)
- SystemTags (WebDAV-based) are working — 4 tags already created: `pending` (ID 2), `processed` (ID 5), `needs-review` (ID 8), `ai-flagged` (ID 11)
- Activity notifications have been enabled for the moltagent user

**Strategy:** Build all three modules now. The webhook receiver ships dormant (config-disabled). The Activity poller and SystemTags integration are active from day one. When NC 32 lands, flip `webhooks.enabled: true` and the agent goes real-time.

---

## Deliverables (in build order)

| # | File | Est. Time | What It Does |
|---|------|-----------|-------------|
| 1 | `src/lib/nc-flow/webhook-receiver.js` | 40 min | Express.js HTTP server, receives NC webhook POST events, routes to event bus |
| 2 | `test/nc-flow/webhook-receiver.test.js` | 20 min | Server lifecycle, event routing, auth verification, malformed payload handling |
| 3 | `src/lib/nc-flow/activity-poller.js` | 45 min | Polls NC Activity API, deduplicates, classifies, emits typed events |
| 4 | `test/nc-flow/activity-poller.test.js` | 20 min | Polling, dedup, classification, error handling |
| 5 | `src/lib/nc-flow/system-tags.js` | 30 min | Read/write tags on files via WebDAV, tag lifecycle management |
| 6 | `test/nc-flow/system-tags.test.js` | 15 min | CRUD operations, file-tag assignment, tag queries |
| 7 | `src/lib/nc-flow/index.js` | 5 min | Module exports |
| 8 | Integration notes for HeartbeatManager | — | Documented below, wired in a separate session |

**AGPL-3.0 license header for every new file** (same as all other Moltagent files):

```javascript
/*
 * Moltagent - Sovereign AI Security Layer
 * Copyright (C) 2026 Moltagent Contributors
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU Affero General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 */
```

---

## File Structure After This Session

```
src/
└── lib/
    └── nc-flow/
        ├── index.js               ← Module exports
        ├── webhook-receiver.js    ← Dormant HTTP server for NC webhooks
        ├── activity-poller.js     ← Polls Activity API for workspace events
        └── system-tags.js         ← SystemTags WebDAV client for tag lifecycle

test/
└── nc-flow/
    ├── webhook-receiver.test.js
    ├── activity-poller.test.js
    └── system-tags.test.js
```

---

## Shared: NCFlowEvent Schema

All three modules emit events using a common schema. This is the internal event format that HeartbeatManager (or a future EventBus) consumes.

```javascript
/**
 * @typedef {Object} NCFlowEvent
 * @property {string} id - Unique event ID (source:type:timestamp or NC activity ID)
 * @property {string} source - 'webhook' | 'activity' | 'tag'
 * @property {string} type - Normalized event type (see table below)
 * @property {string} user - NC username who triggered the event
 * @property {number} timestamp - Unix timestamp (ms) when event occurred
 * @property {Object} data - Event-specific payload
 * @property {string} [objectType] - NC object type: 'file', 'calendar', 'deck_card', 'share', etc.
 * @property {string} [objectId] - NC object ID (file ID, calendar event UID, card ID)
 * @property {string} [objectName] - Human-readable name (filename, event title, card title)
 */

/**
 * Normalized event types:
 * 
 * FILES:
 *   file_created      - New file uploaded or created
 *   file_changed       - File content modified
 *   file_deleted       - File moved to trash
 *   file_restored      - File restored from trash
 *   file_shared        - File/folder shared with someone
 *   file_unshared      - Share removed
 *   file_downloaded     - File downloaded via share link
 * 
 * CALENDAR:
 *   calendar_event_created  - New event added
 *   calendar_event_changed  - Event modified (time, title, attendees)
 *   calendar_event_deleted  - Event removed
 *   calendar_todo_changed   - Task/to-do modified
 * 
 * DECK:
 *   deck_card_created   - New card added
 *   deck_card_updated   - Card modified (title, description, labels)
 *   deck_card_moved     - Card moved between stacks
 *   deck_comment_added  - Comment added to card
 * 
 * SHARING:
 *   share_created       - New share created
 *   share_accepted      - Federation share accepted
 *   share_downloaded    - Share link used
 * 
 * TAGS:
 *   tag_assigned        - Tag added to file
 *   tag_removed         - Tag removed from file
 * 
 * OTHER:
 *   unknown             - Unclassified event (logged for analysis)
 */
```

---

## Module 1: WebhookReceiver (Dormant)

### Purpose

Lightweight Express.js HTTP server on the Bot VM that receives webhook POST events from Nextcloud. Ships disabled by default. When NC 32 arrives on Storage Share and the webhook event whitelist expands, flip `config.ncFlow.webhooks.enabled = true` to activate.

### Design Decisions

- **Express.js** — already a project dependency (used by OpenClaw gateway). No new deps.
- **Shared secret validation** — webhook payloads include a configurable shared secret header for verification. NC webhook_listeners doesn't natively sign payloads, so we use a custom `X-Webhook-Secret` header configured at registration time.
- **No new attack surface if disabled** — when `enabled: false`, the HTTP server is never started. Zero listening ports.
- **Events flow through the same NCFlowEvent schema** — webhook events are normalized before being emitted, so HeartbeatManager doesn't care whether an event came from a webhook or from polling.

### Config

```javascript
// In moltagent config
{
  ncFlow: {
    webhooks: {
      enabled: false,          // Dormant by default
      port: 3100,              // HTTP listen port on Bot VM
      host: '0.0.0.0',        // Listen on all interfaces (firewalled to NC IP)
      secret: '',              // Shared secret for verification (set during webhook registration)
      trustedIPs: [],          // Optional: restrict to NC server IP(s). Empty = no IP filtering.
      shutdownTimeoutMs: 5000  // Grace period for in-flight requests on shutdown
    }
  }
}
```

### Implementation

```javascript
// src/lib/nc-flow/webhook-receiver.js

const { EventEmitter } = require('events');
const http = require('http');

class WebhookReceiver extends EventEmitter {
  /**
   * @param {Object} config - ncFlow.webhooks config section
   * @param {Object} [logger] - Optional logger (defaults to console)
   */
  constructor(config, logger) {
    super();
    this.config = config;
    this.logger = logger || console;
    this.server = null;
    this.enabled = config?.enabled || false;
  }

  /**
   * Start the HTTP server if enabled.
   * @returns {Promise<boolean>} true if started, false if dormant
   */
  async start() {
    if (!this.enabled) {
      this.logger.info('[WebhookReceiver] Dormant — set ncFlow.webhooks.enabled=true when NC 32+ available');
      return false;
    }

    return new Promise((resolve, reject) => {
      this.server = http.createServer((req, res) => this._handleRequest(req, res));

      this.server.listen(this.config.port, this.config.host, () => {
        this.logger.info(`[WebhookReceiver] Listening on ${this.config.host}:${this.config.port}`);
        resolve(true);
      });

      this.server.on('error', (err) => {
        this.logger.error('[WebhookReceiver] Server error:', err.message);
        reject(err);
      });
    });
  }

  /**
   * Graceful shutdown.
   */
  async stop() {
    if (!this.server) return;
    
    return new Promise((resolve) => {
      this.server.close(() => {
        this.logger.info('[WebhookReceiver] Stopped');
        resolve();
      });

      // Force close after timeout
      setTimeout(() => {
        this.logger.warn('[WebhookReceiver] Force closing');
        resolve();
      }, this.config.shutdownTimeoutMs || 5000);
    });
  }

  /**
   * Handle incoming HTTP request.
   * Only accepts POST to /webhooks/nc
   * @private
   */
  _handleRequest(req, res) {
    // Only accept POST /webhooks/nc
    if (req.method !== 'POST' || req.url !== '/webhooks/nc') {
      res.writeHead(404);
      res.end('Not found');
      return;
    }

    // IP filtering (if configured)
    if (this.config.trustedIPs && this.config.trustedIPs.length > 0) {
      const clientIP = req.socket.remoteAddress;
      if (!this.config.trustedIPs.includes(clientIP)) {
        this.logger.warn(`[WebhookReceiver] Rejected request from untrusted IP: ${clientIP}`);
        res.writeHead(403);
        res.end('Forbidden');
        return;
      }
    }

    // Secret verification (if configured)
    if (this.config.secret) {
      const providedSecret = req.headers['x-webhook-secret'];
      if (providedSecret !== this.config.secret) {
        this.logger.warn('[WebhookReceiver] Invalid webhook secret');
        res.writeHead(401);
        res.end('Unauthorized');
        return;
      }
    }

    // Read body
    let body = '';
    req.on('data', (chunk) => {
      body += chunk;
      // Limit body size to 1MB
      if (body.length > 1048576) {
        res.writeHead(413);
        res.end('Payload too large');
        req.destroy();
      }
    });

    req.on('end', () => {
      try {
        const payload = JSON.parse(body);
        const event = this._normalizeWebhookPayload(payload);

        if (event) {
          this.emit('event', event);
          this.logger.info(`[WebhookReceiver] Event: ${event.type} from ${event.user}`);
        }

        // Always respond 200 quickly — NC doesn't retry on non-200
        // and we don't want to slow down the NC server
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ received: true }));
      } catch (err) {
        this.logger.error('[WebhookReceiver] Parse error:', err.message);
        res.writeHead(400);
        res.end('Bad request');
      }
    });
  }

  /**
   * Normalize a raw NC webhook payload into an NCFlowEvent.
   * 
   * NC webhook_listeners sends payloads like:
   * {
   *   "event": "OCA\\Files\\Events\\NodeCreatedEvent",
   *   "user": { "uid": "moltagent" },
   *   "node": { "id": 12345, "path": "/moltagent/Inbox/report.pdf", "name": "report.pdf" },
   *   "time": 1707350400
   * }
   * 
   * The exact payload structure varies by event class and NC version.
   * This method handles known structures and falls back to a generic mapping.
   * 
   * @param {Object} payload - Raw webhook JSON
   * @returns {NCFlowEvent|null}
   * @private
   */
  _normalizeWebhookPayload(payload) {
    if (!payload || !payload.event) return null;

    const eventClass = payload.event;
    const user = payload.user?.uid || payload.user?.id || 'unknown';
    const timestamp = (payload.time || Math.floor(Date.now() / 1000)) * 1000;

    // Map NC event classes to normalized types
    const eventMap = {
      // Files
      'OCP\\Files\\Events\\NodeCreatedEvent': 'file_created',
      'OCA\\Files\\Events\\NodeCreatedEvent': 'file_created',
      'OCP\\Files\\Events\\NodeWrittenEvent': 'file_changed',
      'OCP\\Files\\Events\\NodeDeletedEvent': 'file_deleted',
      'OCA\\Files_Trashbin\\Events\\NodeRestoredEvent': 'file_restored',
      'OCA\\Files_Trashbin\\Events\\BeforeNodeRestoredEvent': 'file_restored',
      'OCP\\Files\\Events\\NodeCopiedEvent': 'file_created',
      'OCP\\Files\\Events\\NodeRenamedEvent': 'file_changed',

      // Calendar
      'OCA\\DAV\\Events\\CalendarObjectCreatedEvent': 'calendar_event_created',
      'OCA\\DAV\\Events\\CalendarObjectUpdatedEvent': 'calendar_event_changed',
      'OCA\\DAV\\Events\\CalendarObjectDeletedEvent': 'calendar_event_deleted',

      // Sharing
      'OCP\\Share\\Events\\ShareCreatedEvent': 'share_created',
      'OCA\\Files_Sharing\\Events\\ShareCreatedEvent': 'share_created',

      // Deck
      'OCA\\Deck\\Event\\CardCreatedEvent': 'deck_card_created',
      'OCA\\Deck\\Event\\CardUpdatedEvent': 'deck_card_updated',

      // Tags
      'OCP\\SystemTag\\Events\\SystemTagMappedEvent': 'tag_assigned',
      'OCP\\SystemTag\\Events\\SystemTagUnmappedEvent': 'tag_removed',
    };

    const type = eventMap[eventClass] || 'unknown';

    // Extract object info from various payload shapes
    const node = payload.node || payload.object || {};
    const objectType = this._inferObjectType(eventClass);

    return {
      id: `webhook:${type}:${timestamp}:${node.id || Math.random().toString(36).slice(2, 8)}`,
      source: 'webhook',
      type,
      user,
      timestamp,
      objectType,
      objectId: String(node.id || ''),
      objectName: node.name || node.path || '',
      data: {
        eventClass,
        path: node.path || '',
        mimeType: node.mimetype || node.mimeType || '',
        raw: payload  // Preserve full payload for debugging
      }
    };
  }

  /**
   * Infer object type from event class name.
   * @private
   */
  _inferObjectType(eventClass) {
    if (eventClass.includes('Files') || eventClass.includes('Trashbin')) return 'file';
    if (eventClass.includes('Calendar') || eventClass.includes('DAV')) return 'calendar';
    if (eventClass.includes('Share') || eventClass.includes('Sharing')) return 'share';
    if (eventClass.includes('Deck')) return 'deck_card';
    if (eventClass.includes('SystemTag')) return 'tag';
    return 'unknown';
  }

  /**
   * Helper: Register a webhook with NC via OCS API.
   * Call this manually (or from deployment script) when NC 32+ is available.
   * NOT called during normal operation.
   * 
   * @param {Object} ncRequestManager - NCRequestManager instance
   * @param {string} event - Full event class name (e.g. 'OCP\\Files\\Events\\NodeCreatedEvent')
   * @param {Object} [filters={}] - Optional event filters
   * @returns {Promise<Object>} Registration response
   */
  static async registerWebhook(ncRequestManager, event, filters = {}) {
    const config = ncRequestManager.config?.ncFlow?.webhooks || {};
    const uri = `http://${config.host || '0.0.0.0'}:${config.port || 3100}/webhooks/nc`;

    const response = await ncRequestManager.request(
      '/ocs/v2.php/apps/webhook_listeners/api/v1/webhooks',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          httpMethod: 'POST',
          uri,
          event,
          filters
        })
      }
    );

    return response;
  }

  /**
   * Helper: List registered webhooks.
   */
  static async listWebhooks(ncRequestManager) {
    return ncRequestManager.request(
      '/ocs/v2.php/apps/webhook_listeners/api/v1/webhooks',
      { method: 'GET' }
    );
  }

  /**
   * Helper: Delete a webhook by ID.
   */
  static async deleteWebhook(ncRequestManager, webhookId) {
    return ncRequestManager.request(
      `/ocs/v2.php/apps/webhook_listeners/api/v1/webhooks/${webhookId}`,
      { method: 'DELETE' }
    );
  }
}

module.exports = { WebhookReceiver };
```

### Tests

```javascript
// test/nc-flow/webhook-receiver.test.js

const { WebhookReceiver } = require('../../src/lib/nc-flow/webhook-receiver');
const http = require('http');

// Helper: send HTTP request to the receiver
function sendRequest(port, path, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const options = {
      hostname: '127.0.0.1',
      port,
      path,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...headers
      }
    };
    const req = http.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => data += chunk);
      res.on('end', () => resolve({ status: res.statusCode, body: data }));
    });
    req.on('error', reject);
    req.write(JSON.stringify(body));
    req.end();
  });
}

describe('WebhookReceiver', () => {
  // DORMANT MODE
  test('returns false and does not start server when disabled', async () => {
    const receiver = new WebhookReceiver({ enabled: false });
    const result = await receiver.start();
    expect(result).toBe(false);
    expect(receiver.server).toBeNull();
  });

  // SERVER LIFECYCLE
  test('starts and stops HTTP server when enabled', async () => {
    const receiver = new WebhookReceiver({
      enabled: true,
      port: 0,  // random port
      host: '127.0.0.1',
      secret: '',
      trustedIPs: [],
      shutdownTimeoutMs: 1000
    });
    
    await receiver.start();
    expect(receiver.server).not.toBeNull();
    expect(receiver.server.listening).toBe(true);
    
    await receiver.stop();
    expect(receiver.server.listening).toBe(false);
  });

  // EVENT ROUTING
  test('emits normalized event on valid webhook POST', async () => {
    const receiver = new WebhookReceiver({
      enabled: true, port: 0, host: '127.0.0.1',
      secret: '', trustedIPs: [], shutdownTimeoutMs: 1000
    });
    await receiver.start();
    const port = receiver.server.address().port;

    const events = [];
    receiver.on('event', (e) => events.push(e));

    await sendRequest(port, '/webhooks/nc', {
      event: 'OCA\\Files_Trashbin\\Events\\NodeRestoredEvent',
      user: { uid: 'moltagent' },
      node: { id: 42, path: '/moltagent/file.txt', name: 'file.txt' },
      time: 1707350400
    });

    expect(events).toHaveLength(1);
    expect(events[0].source).toBe('webhook');
    expect(events[0].type).toBe('file_restored');
    expect(events[0].user).toBe('moltagent');
    expect(events[0].objectType).toBe('file');
    expect(events[0].objectId).toBe('42');

    await receiver.stop();
  });

  // 404 ON WRONG PATH
  test('returns 404 for non-webhook paths', async () => {
    const receiver = new WebhookReceiver({
      enabled: true, port: 0, host: '127.0.0.1',
      secret: '', trustedIPs: [], shutdownTimeoutMs: 1000
    });
    await receiver.start();
    const port = receiver.server.address().port;

    const res = await sendRequest(port, '/other/path', {});
    expect(res.status).toBe(404);

    await receiver.stop();
  });

  // SECRET VERIFICATION
  test('rejects request with wrong secret', async () => {
    const receiver = new WebhookReceiver({
      enabled: true, port: 0, host: '127.0.0.1',
      secret: 'my-secret-token', trustedIPs: [], shutdownTimeoutMs: 1000
    });
    await receiver.start();
    const port = receiver.server.address().port;

    const res = await sendRequest(port, '/webhooks/nc', { event: 'test' }, {
      'x-webhook-secret': 'wrong-secret'
    });
    expect(res.status).toBe(401);

    await receiver.stop();
  });

  test('accepts request with correct secret', async () => {
    const receiver = new WebhookReceiver({
      enabled: true, port: 0, host: '127.0.0.1',
      secret: 'my-secret-token', trustedIPs: [], shutdownTimeoutMs: 1000
    });
    await receiver.start();
    const port = receiver.server.address().port;

    const res = await sendRequest(port, '/webhooks/nc', {
      event: 'OCA\\Files_Trashbin\\Events\\NodeRestoredEvent',
      user: { uid: 'test' }, node: { id: 1 }, time: 1707350400
    }, { 'x-webhook-secret': 'my-secret-token' });
    expect(res.status).toBe(200);

    await receiver.stop();
  });

  // MALFORMED PAYLOAD
  test('returns 400 for invalid JSON', async () => {
    const receiver = new WebhookReceiver({
      enabled: true, port: 0, host: '127.0.0.1',
      secret: '', trustedIPs: [], shutdownTimeoutMs: 1000
    });
    await receiver.start();
    const port = receiver.server.address().port;

    // Send raw string instead of JSON
    const res = await new Promise((resolve, reject) => {
      const req = http.request({
        hostname: '127.0.0.1', port, path: '/webhooks/nc',
        method: 'POST', headers: { 'Content-Type': 'application/json' }
      }, (r) => {
        let data = '';
        r.on('data', (c) => data += c);
        r.on('end', () => resolve({ status: r.statusCode }));
      });
      req.on('error', reject);
      req.write('not json at all');
      req.end();
    });
    expect(res.status).toBe(400);

    await receiver.stop();
  });

  // UNKNOWN EVENT TYPE
  test('normalizes unknown events as type "unknown"', async () => {
    const receiver = new WebhookReceiver({
      enabled: true, port: 0, host: '127.0.0.1',
      secret: '', trustedIPs: [], shutdownTimeoutMs: 1000
    });
    await receiver.start();
    const port = receiver.server.address().port;

    const events = [];
    receiver.on('event', (e) => events.push(e));

    await sendRequest(port, '/webhooks/nc', {
      event: 'Some\\Future\\EventClass',
      user: { uid: 'test' }, time: 1707350400
    });

    expect(events[0].type).toBe('unknown');
    expect(events[0].data.eventClass).toBe('Some\\Future\\EventClass');

    await receiver.stop();
  });

  // EVENT MAP COVERAGE
  test('maps all known event classes correctly', () => {
    const receiver = new WebhookReceiver({ enabled: false });

    const testCases = [
      ['OCP\\Files\\Events\\NodeCreatedEvent', 'file_created', 'file'],
      ['OCP\\Files\\Events\\NodeWrittenEvent', 'file_changed', 'file'],
      ['OCA\\DAV\\Events\\CalendarObjectCreatedEvent', 'calendar_event_created', 'calendar'],
      ['OCP\\Share\\Events\\ShareCreatedEvent', 'share_created', 'share'],
      ['OCA\\Deck\\Event\\CardCreatedEvent', 'deck_card_created', 'deck_card'],
    ];

    for (const [eventClass, expectedType, expectedObjectType] of testCases) {
      const event = receiver._normalizeWebhookPayload({
        event: eventClass, user: { uid: 'test' },
        node: { id: 1 }, time: 1707350400
      });
      expect(event.type).toBe(expectedType);
      expect(event.objectType).toBe(expectedObjectType);
    }
  });
});
```

---

## Module 2: ActivityPoller

### Purpose

Polls the NC Activity API to detect workspace events: file changes, calendar modifications, sharing activity, Deck card updates, tag changes. This is the primary "ambient awareness" input for Moltagent on NC 31 (until webhooks become viable on NC 32+).

### Design Decisions

- **Polls Activity API, NOT individual app APIs** — one endpoint gives us everything. Much cheaper than polling Talk + Deck + Calendar + Files separately.
- **`since` cursor** — Activity API supports `since=LAST_ACTIVITY_ID` parameter. We track the last-seen ID to only get new events. No duplicates, no waste.
- **Classification into NCFlowEvent** — raw Activity events are classified into the same normalized types as webhook events. HeartbeatManager doesn't care about the source.
- **Separate from HeartbeatManager's existing polling** — HeartbeatManager polls Talk for messages and Deck for tasks. ActivityPoller adds a third input: everything else happening in the workspace. These don't replace each other.
- **Configurable interval** — default 60 seconds. More frequent than heartbeat (5 min) because Activity events are lightweight to fetch, but less frequent than Talk polling (5 sec) because they're less time-sensitive.

### Config

```javascript
{
  ncFlow: {
    activity: {
      enabled: true,
      pollIntervalMs: 60000,    // Check every 60 seconds
      maxEventsPerPoll: 50,     // Limit per API call
      ignoreOwnEvents: true,    // Skip events triggered by moltagent itself
      ignoreUsers: [],          // Additional users to ignore (e.g. admin bots)
      // Which event types to emit (others are logged but not emitted)
      enabledTypes: [
        'file_created', 'file_changed', 'file_deleted', 'file_shared',
        'calendar_event_created', 'calendar_event_changed',
        'deck_card_created', 'deck_card_updated', 'deck_card_moved',
        'tag_assigned', 'tag_removed',
        'share_created'
      ]
    }
  }
}
```

### NC Activity API Reference

```
GET /ocs/v2.php/apps/activity/api/v2/activity
Headers: OCS-APIRequest: true, Accept: application/json
Auth: Basic (moltagent user)
Query params:
  since={activity_id}  — only return events after this ID
  limit={n}            — max results (default 50)
  sort=asc             — oldest first (important for cursor tracking)

Response shape:
{
  "ocs": {
    "data": [
      {
        "activity_id": 12345,
        "type": "file_created",          // NC activity type string
        "subject": "You created report.pdf",
        "user": "moltagent",
        "affecteduser": "moltagent",
        "datetime": "2026-02-07T15:30:00+00:00",
        "object_type": "files",
        "object_id": 67890,
        "object_name": "/moltagent/Inbox/report.pdf",
        "app": "files"
      }
    ]
  }
}

The `type` field values vary by app:
  Files: file_created, file_changed, file_deleted, file_restored,
         file_moved, file_renamed, file_favorited
  Sharing: shared_with_by, shared_user_self, remote_share,
           public_links
  Calendar: calendar_event, calendar_todo
  Deck: deck_card_create, deck_card_update, deck_card_move,
        deck_comment_create
  SystemTags: systemtag_assign, systemtag_unassign
```

### Implementation

```javascript
// src/lib/nc-flow/activity-poller.js

const { EventEmitter } = require('events');

class ActivityPoller extends EventEmitter {
  /**
   * @param {Object} config - ncFlow.activity config section
   * @param {Object} ncRequestManager - NCRequestManager instance for API calls
   * @param {Object} [logger] - Optional logger
   */
  constructor(config, ncRequestManager, logger) {
    super();
    this.config = config;
    this.nc = ncRequestManager;
    this.logger = logger || console;
    this.enabled = config?.enabled !== false;  // Default: enabled
    
    this.lastActivityId = null;   // Cursor for pagination
    this.pollTimer = null;
    this.polling = false;         // Guard against overlapping polls
    
    this.metrics = {
      totalPolls: 0,
      totalEvents: 0,
      emittedEvents: 0,
      skippedOwn: 0,
      errors: 0
    };
  }

  /**
   * Start polling the Activity API.
   * @returns {boolean}
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
   * Stop polling.
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
   * @private
   */
  async _poll() {
    if (this.polling) return;  // Skip if previous poll still running
    this.polling = true;
    this.metrics.totalPolls++;

    try {
      const params = new URLSearchParams({
        limit: String(this.config.maxEventsPerPoll || 50),
        sort: 'asc'   // Oldest first — important for cursor tracking
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

      // Parse response
      let data;
      if (typeof response.json === 'function') {
        data = await response.json();
      } else {
        data = response;
      }

      const activities = data?.ocs?.data || [];
      
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

        // Skip own events if configured
        if (this.config.ignoreOwnEvents && activity.user === this.nc.config?.nextcloud?.user) {
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
   * @param {Object} activity - Raw activity from NC API
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
   * NC Activity types are app-specific and inconsistent.
   * This mapping is based on NC 31 observed values.
   * @private
   */
  _classifyActivityType(activityType, app) {
    // File events
    const fileMap = {
      'file_created': 'file_created',
      'file_changed': 'file_changed',
      'file_deleted': 'file_deleted',
      'file_restored': 'file_restored',
      'file_moved': 'file_changed',
      'file_renamed': 'file_changed',
      'file_favorited': 'file_changed',
    };
    if (fileMap[activityType]) return fileMap[activityType];

    // Sharing events
    const shareMap = {
      'shared_with_by': 'share_created',
      'shared_user_self': 'share_created',
      'remote_share': 'share_created',
      'public_links': 'file_shared',
      'shared_link_mail': 'file_shared',
    };
    if (shareMap[activityType]) return shareMap[activityType];

    // Calendar events
    if (activityType === 'calendar_event' || (app === 'dav' && activityType.includes('calendar'))) {
      return 'calendar_event_changed';
    }
    if (activityType === 'calendar_todo') {
      return 'calendar_todo_changed';
    }

    // Deck events
    const deckMap = {
      'deck_card_create': 'deck_card_created',
      'deck_card_update': 'deck_card_updated',
      'deck_card_move': 'deck_card_moved',
      'deck_comment_create': 'deck_comment_added',
    };
    if (deckMap[activityType]) return deckMap[activityType];

    // Tag events
    if (activityType === 'systemtag_assign') return 'tag_assigned';
    if (activityType === 'systemtag_unassign') return 'tag_removed';

    // App-based fallback
    if (app === 'files') return 'file_changed';
    if (app === 'deck') return 'deck_card_updated';
    if (app === 'dav') return 'calendar_event_changed';

    return 'unknown';
  }

  /**
   * Map NC object_type strings to our internal types.
   * @private
   */
  _mapObjectType(ncObjectType) {
    const map = {
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
    return map[ncObjectType] || ncObjectType || 'unknown';
  }

  /**
   * Get current metrics.
   */
  getMetrics() {
    return {
      ...this.metrics,
      lastActivityId: this.lastActivityId,
      enabled: this.enabled,
      polling: this.polling
    };
  }

  /**
   * Force an immediate poll (for testing or on-demand use).
   */
  async pollNow() {
    return this._poll();
  }
}

module.exports = { ActivityPoller };
```

### Tests

```javascript
// test/nc-flow/activity-poller.test.js

const { ActivityPoller } = require('../../src/lib/nc-flow/activity-poller');

// Mock NCRequestManager
function createMockNC(activities = []) {
  return {
    config: { nextcloud: { user: 'moltagent' } },
    request: jest.fn().mockResolvedValue({
      ocs: {
        data: activities
      }
    })
  };
}

function makeActivity(id, type, app, user = 'alice', objectName = '/test/file.txt') {
  return {
    activity_id: id,
    type,
    app,
    user,
    affecteduser: 'moltagent',
    datetime: '2026-02-07T15:30:00+00:00',
    object_type: 'files',
    object_id: id * 100,
    object_name: objectName,
    subject: `${user} did ${type}`
  };
}

describe('ActivityPoller', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  // DISABLED MODE
  test('returns false when disabled', () => {
    const poller = new ActivityPoller({ enabled: false }, createMockNC());
    expect(poller.start()).toBe(false);
  });

  // BASIC POLLING
  test('emits normalized events from Activity API', async () => {
    const nc = createMockNC([
      makeActivity(1, 'file_created', 'files', 'alice', '/Inbox/report.pdf'),
      makeActivity(2, 'file_changed', 'files', 'bob', '/Projects/doc.md'),
    ]);
    const poller = new ActivityPoller({
      enabled: true, pollIntervalMs: 60000,
      maxEventsPerPoll: 50, ignoreOwnEvents: true,
      enabledTypes: ['file_created', 'file_changed']
    }, nc);

    const events = [];
    poller.on('event', (e) => events.push(e));

    await poller.pollNow();

    expect(events).toHaveLength(2);
    expect(events[0].source).toBe('activity');
    expect(events[0].type).toBe('file_created');
    expect(events[0].user).toBe('alice');
    expect(events[0].objectName).toBe('/Inbox/report.pdf');
    expect(events[1].type).toBe('file_changed');
  });

  // CURSOR TRACKING
  test('tracks lastActivityId for pagination', async () => {
    const nc = createMockNC([
      makeActivity(10, 'file_created', 'files'),
      makeActivity(15, 'file_changed', 'files'),
    ]);
    const poller = new ActivityPoller({
      enabled: true, pollIntervalMs: 60000, ignoreOwnEvents: false,
      enabledTypes: ['file_created', 'file_changed']
    }, nc);

    await poller.pollNow();

    expect(poller.lastActivityId).toBe(15);

    // Next poll should include since=15
    await poller.pollNow();
    const lastCallArgs = nc.request.mock.calls[1][0];
    expect(lastCallArgs).toContain('since=15');
  });

  // SKIP OWN EVENTS
  test('skips events from moltagent user when ignoreOwnEvents=true', async () => {
    const nc = createMockNC([
      makeActivity(1, 'file_created', 'files', 'moltagent'),
      makeActivity(2, 'file_created', 'files', 'alice'),
    ]);
    const poller = new ActivityPoller({
      enabled: true, pollIntervalMs: 60000, ignoreOwnEvents: true,
      enabledTypes: ['file_created']
    }, nc);

    const events = [];
    poller.on('event', (e) => events.push(e));

    await poller.pollNow();

    expect(events).toHaveLength(1);
    expect(events[0].user).toBe('alice');
    expect(poller.metrics.skippedOwn).toBe(1);
  });

  // TYPE FILTERING
  test('only emits enabled event types', async () => {
    const nc = createMockNC([
      makeActivity(1, 'file_created', 'files'),
      makeActivity(2, 'file_deleted', 'files'),
    ]);
    const poller = new ActivityPoller({
      enabled: true, pollIntervalMs: 60000, ignoreOwnEvents: false,
      enabledTypes: ['file_created']  // file_deleted not enabled
    }, nc);

    const events = [];
    poller.on('event', (e) => events.push(e));

    await poller.pollNow();

    expect(events).toHaveLength(1);
    expect(events[0].type).toBe('file_created');
  });

  // EVENT CLASSIFICATION
  test('classifies all known activity types', () => {
    const nc = createMockNC();
    const poller = new ActivityPoller({ enabled: false }, nc);

    const cases = [
      ['file_created', 'files', 'file_created'],
      ['file_changed', 'files', 'file_changed'],
      ['file_deleted', 'files', 'file_deleted'],
      ['shared_with_by', 'files_sharing', 'share_created'],
      ['deck_card_create', 'deck', 'deck_card_created'],
      ['deck_card_move', 'deck', 'deck_card_moved'],
      ['calendar_event', 'dav', 'calendar_event_changed'],
      ['systemtag_assign', 'systemtags', 'tag_assigned'],
      ['something_unknown', 'unknown_app', 'unknown'],
    ];

    for (const [activityType, app, expected] of cases) {
      expect(poller._classifyActivityType(activityType, app)).toBe(expected);
    }
  });

  // ERROR HANDLING
  test('continues polling after API error', async () => {
    const nc = createMockNC();
    nc.request.mockRejectedValueOnce(new Error('Network timeout'));
    nc.request.mockResolvedValueOnce({
      ocs: { data: [makeActivity(1, 'file_created', 'files', 'alice')] }
    });

    const poller = new ActivityPoller({
      enabled: true, pollIntervalMs: 60000, ignoreOwnEvents: false,
      enabledTypes: ['file_created']
    }, nc);

    const events = [];
    poller.on('event', (e) => events.push(e));

    // First poll fails
    await poller.pollNow();
    expect(poller.metrics.errors).toBe(1);
    expect(events).toHaveLength(0);

    // Second poll succeeds
    await poller.pollNow();
    expect(events).toHaveLength(1);
  });

  // OVERLAP PREVENTION
  test('skips poll if previous poll still running', async () => {
    let resolveFirstPoll;
    const nc = createMockNC();
    nc.request.mockImplementationOnce(() => new Promise(resolve => {
      resolveFirstPoll = () => resolve({ ocs: { data: [] } });
    }));

    const poller = new ActivityPoller({
      enabled: true, pollIntervalMs: 60000, ignoreOwnEvents: false,
      enabledTypes: ['file_created']
    }, nc);

    // Start first poll (will hang)
    const poll1 = poller.pollNow();
    
    // Start second poll while first is running — should skip
    await poller.pollNow();
    
    expect(nc.request).toHaveBeenCalledTimes(1);
    
    // Resolve first poll
    resolveFirstPoll();
    await poll1;
  });

  // METRICS
  test('tracks accurate metrics', async () => {
    const nc = createMockNC([
      makeActivity(1, 'file_created', 'files', 'moltagent'),
      makeActivity(2, 'file_created', 'files', 'alice'),
      makeActivity(3, 'file_deleted', 'files', 'bob'),
    ]);
    const poller = new ActivityPoller({
      enabled: true, pollIntervalMs: 60000, ignoreOwnEvents: true,
      enabledTypes: ['file_created']  // file_deleted filtered out
    }, nc);

    poller.on('event', () => {});
    await poller.pollNow();

    const metrics = poller.getMetrics();
    expect(metrics.totalPolls).toBe(1);
    expect(metrics.totalEvents).toBe(3);
    expect(metrics.skippedOwn).toBe(1);
    expect(metrics.emittedEvents).toBe(1);  // Only alice's file_created
  });
});
```

---

## Module 3: SystemTags

### Purpose

Read and write NC SystemTags on files via the WebDAV API. Enables tag lifecycle management: when Moltagent processes a file, it transitions the file through tag states (`pending` → `processed` or `needs-review` or `ai-flagged`).

### Design Decisions

- **WebDAV, not OCS** — SystemTags use the WebDAV PROPFIND/PROPPATCH interface at `/remote.php/dav/systemtags/` and `/remote.php/dav/systemtags-relations/files/`. The OCS endpoint doesn't work for SystemTags (confirmed in our testing).
- **Known tag IDs** — tags are pre-created during deployment. We cache the ID→name mapping at startup. No need to create tags at runtime.
- **File ID resolution** — NC files have integer IDs. To tag a file, you need its ID. We get this from WebDAV PROPFIND on the file path.

### Pre-Created Tags (Deployment)

| Tag | ID | Set by | Meaning |
|-----|-----|--------|---------|
| `pending` | 2 | User or Flow auto-tag | Waiting for Moltagent to process |
| `processed` | 5 | Moltagent | AI is done |
| `needs-review` | 8 | Moltagent | Human attention required |
| `ai-flagged` | 11 | Moltagent | Something unusual detected |

**Note:** Tag IDs are instance-specific. During deployment, the concierge script creates tags and records the returned IDs in config. The IDs above are from our test instance (nx89136).

### Config

```javascript
{
  ncFlow: {
    tags: {
      enabled: true,
      // Tag name → ID mapping (populated during deployment)
      tagIds: {
        'pending': 2,
        'processed': 5,
        'needs-review': 8,
        'ai-flagged': 11
      }
    }
  }
}
```

### Implementation

```javascript
// src/lib/nc-flow/system-tags.js

class SystemTagsClient {
  /**
   * @param {Object} config - ncFlow.tags config section
   * @param {Object} ncRequestManager - NCRequestManager instance
   * @param {Object} [logger]
   */
  constructor(config, ncRequestManager, logger) {
    this.config = config;
    this.nc = ncRequestManager;
    this.logger = logger || console;
    this.enabled = config?.enabled !== false;

    // Tag name → ID mapping from config
    this.tagIds = new Map(Object.entries(config?.tagIds || {}));
    // Reverse: ID → name
    this.tagNames = new Map();
    for (const [name, id] of this.tagIds) {
      this.tagNames.set(id, name);
    }
  }

  /**
   * Get tag ID by name.
   * @param {string} name - Tag name (e.g. 'pending')
   * @returns {number|null}
   */
  getTagId(name) {
    return this.tagIds.get(name) || null;
  }

  /**
   * Get tag name by ID.
   * @param {number} id
   * @returns {string|null}
   */
  getTagName(id) {
    return this.tagNames.get(id) || null;
  }

  /**
   * Refresh tag ID mapping from NC.
   * Call this during startup or if tags are added dynamically.
   * @returns {Promise<Map<string, number>>} Updated tag mapping
   */
  async refreshTagIds() {
    const xml = `<?xml version="1.0"?>
<d:propfind xmlns:d="DAV:" xmlns:oc="http://owncloud.org/ns">
  <d:prop>
    <oc:display-name/>
    <oc:id/>
    <oc:user-visible/>
    <oc:user-assignable/>
  </d:prop>
</d:propfind>`;

    const response = await this.nc.request('/remote.php/dav/systemtags/', {
      method: 'PROPFIND',
      headers: {
        'Content-Type': 'application/xml',
        'Depth': '1'
      },
      body: xml,
      endpointGroup: 'webdav',
      cacheTtlMs: 300000  // Cache tag list for 5 minutes
    });

    const body = typeof response.text === 'function' ? await response.text() : String(response);
    const tags = this._parseTagsPropfind(body);

    this.tagIds.clear();
    this.tagNames.clear();
    for (const tag of tags) {
      this.tagIds.set(tag.name, tag.id);
      this.tagNames.set(tag.id, tag.name);
    }

    this.logger.info(`[SystemTags] Refreshed: ${this.tagIds.size} tags loaded`);
    return this.tagIds;
  }

  /**
   * Get all tags assigned to a file.
   * @param {number} fileId - NC file ID
   * @returns {Promise<Array<{id: number, name: string}>>}
   */
  async getFileTags(fileId) {
    const xml = `<?xml version="1.0"?>
<d:propfind xmlns:d="DAV:" xmlns:oc="http://owncloud.org/ns">
  <d:prop>
    <oc:display-name/>
    <oc:id/>
  </d:prop>
</d:propfind>`;

    const response = await this.nc.request(
      `/remote.php/dav/systemtags-relations/files/${fileId}`,
      {
        method: 'PROPFIND',
        headers: {
          'Content-Type': 'application/xml',
          'Depth': '1'
        },
        body: xml,
        endpointGroup: 'webdav'
      }
    );

    const body = typeof response.text === 'function' ? await response.text() : String(response);
    return this._parseTagsPropfind(body);
  }

  /**
   * Assign a tag to a file.
   * @param {number} fileId - NC file ID
   * @param {string} tagName - Tag name (e.g. 'processed')
   * @returns {Promise<boolean>} true if successful
   */
  async assignTag(fileId, tagName) {
    const tagId = this.getTagId(tagName);
    if (!tagId) {
      this.logger.error(`[SystemTags] Unknown tag: ${tagName}`);
      return false;
    }

    try {
      await this.nc.request(
        `/remote.php/dav/systemtags-relations/files/${fileId}/${tagId}`,
        {
          method: 'PUT',
          endpointGroup: 'webdav'
        }
      );
      this.logger.info(`[SystemTags] Tagged file ${fileId} as '${tagName}'`);
      return true;
    } catch (err) {
      // 409 Conflict means already tagged — that's fine
      if (err.status === 409) {
        this.logger.info(`[SystemTags] File ${fileId} already tagged '${tagName}'`);
        return true;
      }
      this.logger.error(`[SystemTags] Failed to tag file ${fileId}:`, err.message);
      return false;
    }
  }

  /**
   * Remove a tag from a file.
   * @param {number} fileId - NC file ID
   * @param {string} tagName - Tag name
   * @returns {Promise<boolean>}
   */
  async removeTag(fileId, tagName) {
    const tagId = this.getTagId(tagName);
    if (!tagId) {
      this.logger.error(`[SystemTags] Unknown tag: ${tagName}`);
      return false;
    }

    try {
      await this.nc.request(
        `/remote.php/dav/systemtags-relations/files/${fileId}/${tagId}`,
        {
          method: 'DELETE',
          endpointGroup: 'webdav'
        }
      );
      this.logger.info(`[SystemTags] Removed '${tagName}' from file ${fileId}`);
      return true;
    } catch (err) {
      // 404 means tag wasn't assigned — that's fine
      if (err.status === 404) {
        return true;
      }
      this.logger.error(`[SystemTags] Failed to remove tag from file ${fileId}:`, err.message);
      return false;
    }
  }

  /**
   * Transition a file's tag state.
   * Removes old tag(s) and assigns new tag(s) atomically.
   * 
   * @param {number} fileId - NC file ID
   * @param {string|string[]} fromTags - Tag(s) to remove
   * @param {string|string[]} toTags - Tag(s) to assign
   * @returns {Promise<boolean>}
   */
  async transitionTags(fileId, fromTags, toTags) {
    const froms = Array.isArray(fromTags) ? fromTags : [fromTags];
    const tos = Array.isArray(toTags) ? toTags : [toTags];

    // Remove old tags
    for (const tag of froms) {
      await this.removeTag(fileId, tag);
    }

    // Assign new tags
    for (const tag of tos) {
      const success = await this.assignTag(fileId, tag);
      if (!success) return false;
    }

    this.logger.info(`[SystemTags] File ${fileId}: ${froms.join(',')} → ${tos.join(',')}`);
    return true;
  }

  /**
   * Check if a file has a specific tag.
   * @param {number} fileId
   * @param {string} tagName
   * @returns {Promise<boolean>}
   */
  async hasTag(fileId, tagName) {
    const tags = await this.getFileTags(fileId);
    return tags.some(t => t.name === tagName);
  }

  /**
   * Get the file ID for a given WebDAV path.
   * Needed because tag operations use file IDs, not paths.
   * 
   * @param {string} filePath - Path relative to user root (e.g. '/Inbox/report.pdf')
   * @param {string} [user='moltagent'] - NC username
   * @returns {Promise<number|null>} File ID or null
   */
  async getFileId(filePath, user) {
    const ncUser = user || this.nc.config?.nextcloud?.user || 'moltagent';
    
    const xml = `<?xml version="1.0"?>
<d:propfind xmlns:d="DAV:" xmlns:oc="http://owncloud.org/ns">
  <d:prop>
    <oc:fileid/>
  </d:prop>
</d:propfind>`;

    try {
      const response = await this.nc.request(
        `/remote.php/dav/files/${ncUser}${filePath}`,
        {
          method: 'PROPFIND',
          headers: {
            'Content-Type': 'application/xml',
            'Depth': '0'
          },
          body: xml,
          endpointGroup: 'webdav'
        }
      );

      const body = typeof response.text === 'function' ? await response.text() : String(response);
      const match = body.match(/<oc:fileid>(\d+)<\/oc:fileid>/);
      return match ? parseInt(match[1], 10) : null;
    } catch (err) {
      this.logger.error(`[SystemTags] Failed to get file ID for ${filePath}:`, err.message);
      return null;
    }
  }

  /**
   * Convenience: Tag a file by path (resolves file ID automatically).
   * @param {string} filePath
   * @param {string} tagName
   * @returns {Promise<boolean>}
   */
  async tagFileByPath(filePath, tagName) {
    const fileId = await this.getFileId(filePath);
    if (!fileId) {
      this.logger.error(`[SystemTags] Could not resolve file ID for: ${filePath}`);
      return false;
    }
    return this.assignTag(fileId, tagName);
  }

  /**
   * Convenience: Transition tags by file path.
   * @param {string} filePath
   * @param {string|string[]} fromTags
   * @param {string|string[]} toTags
   * @returns {Promise<boolean>}
   */
  async transitionTagsByPath(filePath, fromTags, toTags) {
    const fileId = await this.getFileId(filePath);
    if (!fileId) {
      this.logger.error(`[SystemTags] Could not resolve file ID for: ${filePath}`);
      return false;
    }
    return this.transitionTags(fileId, fromTags, toTags);
  }

  /**
   * Parse a WebDAV PROPFIND multistatus response for tags.
   * @private
   */
  _parseTagsPropfind(xml) {
    const tags = [];
    // Match all response blocks that contain tag data
    const responseRegex = /<d:response>([\s\S]*?)<\/d:response>/g;
    let match;

    while ((match = responseRegex.exec(xml)) !== null) {
      const block = match[1];
      
      // Extract display-name and id
      const nameMatch = block.match(/<oc:display-name>(.*?)<\/oc:display-name>/);
      const idMatch = block.match(/<oc:id>(\d+)<\/oc:id>/);

      if (nameMatch && idMatch) {
        tags.push({
          name: nameMatch[1],
          id: parseInt(idMatch[1], 10)
        });
      }
    }

    return tags;
  }
}

module.exports = { SystemTagsClient };
```

### Tests

```javascript
// test/nc-flow/system-tags.test.js

const { SystemTagsClient } = require('../../src/lib/nc-flow/system-tags');

// Mock NCRequestManager
function createMockNC() {
  return {
    config: { nextcloud: { user: 'moltagent' } },
    request: jest.fn()
  };
}

const TAG_CONFIG = {
  enabled: true,
  tagIds: {
    'pending': 2,
    'processed': 5,
    'needs-review': 8,
    'ai-flagged': 11
  }
};

describe('SystemTagsClient', () => {
  // TAG ID LOOKUPS
  test('resolves tag IDs from config', () => {
    const client = new SystemTagsClient(TAG_CONFIG, createMockNC());
    expect(client.getTagId('pending')).toBe(2);
    expect(client.getTagId('processed')).toBe(5);
    expect(client.getTagId('nonexistent')).toBeNull();
    expect(client.getTagName(8)).toBe('needs-review');
    expect(client.getTagName(999)).toBeNull();
  });

  // ASSIGN TAG
  test('assigns tag to file via WebDAV PUT', async () => {
    const nc = createMockNC();
    nc.request.mockResolvedValue({});
    const client = new SystemTagsClient(TAG_CONFIG, nc);

    const result = await client.assignTag(12345, 'processed');

    expect(result).toBe(true);
    expect(nc.request).toHaveBeenCalledWith(
      '/remote.php/dav/systemtags-relations/files/12345/5',
      expect.objectContaining({ method: 'PUT' })
    );
  });

  // ASSIGN UNKNOWN TAG
  test('returns false for unknown tag name', async () => {
    const nc = createMockNC();
    const client = new SystemTagsClient(TAG_CONFIG, nc);

    const result = await client.assignTag(12345, 'nonexistent');

    expect(result).toBe(false);
    expect(nc.request).not.toHaveBeenCalled();
  });

  // REMOVE TAG
  test('removes tag from file via WebDAV DELETE', async () => {
    const nc = createMockNC();
    nc.request.mockResolvedValue({});
    const client = new SystemTagsClient(TAG_CONFIG, nc);

    const result = await client.removeTag(12345, 'pending');

    expect(result).toBe(true);
    expect(nc.request).toHaveBeenCalledWith(
      '/remote.php/dav/systemtags-relations/files/12345/2',
      expect.objectContaining({ method: 'DELETE' })
    );
  });

  // REMOVE ALREADY-REMOVED TAG
  test('handles 404 on tag removal gracefully', async () => {
    const nc = createMockNC();
    nc.request.mockRejectedValue({ status: 404 });
    const client = new SystemTagsClient(TAG_CONFIG, nc);

    const result = await client.removeTag(12345, 'pending');
    expect(result).toBe(true);  // Not an error
  });

  // TAG TRANSITION
  test('transitions tags: removes old, assigns new', async () => {
    const nc = createMockNC();
    nc.request.mockResolvedValue({});
    const client = new SystemTagsClient(TAG_CONFIG, nc);

    const result = await client.transitionTags(12345, 'pending', 'processed');

    expect(result).toBe(true);
    // Should have called DELETE for pending, PUT for processed
    expect(nc.request).toHaveBeenCalledTimes(2);
    expect(nc.request.mock.calls[0][0]).toContain('/2');   // DELETE pending (ID 2)
    expect(nc.request.mock.calls[0][1].method).toBe('DELETE');
    expect(nc.request.mock.calls[1][0]).toContain('/5');   // PUT processed (ID 5)
    expect(nc.request.mock.calls[1][1].method).toBe('PUT');
  });

  // MULTI-TAG TRANSITION
  test('transitions multiple tags at once', async () => {
    const nc = createMockNC();
    nc.request.mockResolvedValue({});
    const client = new SystemTagsClient(TAG_CONFIG, nc);

    const result = await client.transitionTags(
      12345,
      'pending',
      ['processed', 'ai-flagged']
    );

    expect(result).toBe(true);
    expect(nc.request).toHaveBeenCalledTimes(3);  // 1 remove + 2 assigns
  });

  // GET FILE ID
  test('resolves file ID from path via PROPFIND', async () => {
    const nc = createMockNC();
    nc.request.mockResolvedValue({
      text: () => Promise.resolve(`<?xml version="1.0"?>
        <d:multistatus xmlns:d="DAV:" xmlns:oc="http://owncloud.org/ns">
          <d:response>
            <d:propstat>
              <d:prop><oc:fileid>67890</oc:fileid></d:prop>
              <d:status>HTTP/1.1 200 OK</d:status>
            </d:propstat>
          </d:response>
        </d:multistatus>`)
    });
    const client = new SystemTagsClient(TAG_CONFIG, nc);

    const fileId = await client.getFileId('/Inbox/report.pdf');

    expect(fileId).toBe(67890);
    expect(nc.request).toHaveBeenCalledWith(
      '/remote.php/dav/files/moltagent/Inbox/report.pdf',
      expect.objectContaining({ method: 'PROPFIND' })
    );
  });

  // TAG BY PATH (convenience)
  test('tags file by path (resolves ID automatically)', async () => {
    const nc = createMockNC();
    // First call: PROPFIND to get file ID
    nc.request.mockResolvedValueOnce({
      text: () => Promise.resolve(
        '<d:multistatus xmlns:d="DAV:" xmlns:oc="http://owncloud.org/ns">' +
        '<d:response><d:propstat><d:prop><oc:fileid>42</oc:fileid></d:prop>' +
        '<d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response></d:multistatus>'
      )
    });
    // Second call: PUT to assign tag
    nc.request.mockResolvedValueOnce({});

    const client = new SystemTagsClient(TAG_CONFIG, nc);
    const result = await client.tagFileByPath('/Inbox/doc.pdf', 'ai-flagged');

    expect(result).toBe(true);
    expect(nc.request).toHaveBeenCalledTimes(2);
  });

  // REFRESH TAG IDS
  test('refreshes tag mapping from NC', async () => {
    const nc = createMockNC();
    nc.request.mockResolvedValue({
      text: () => Promise.resolve(`<?xml version="1.0"?>
        <d:multistatus xmlns:d="DAV:" xmlns:oc="http://owncloud.org/ns">
          <d:response><d:propstat><d:prop>
            <oc:display-name>custom-tag</oc:display-name>
            <oc:id>99</oc:id>
          </d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>
        </d:multistatus>`)
    });

    const client = new SystemTagsClient({ enabled: true, tagIds: {} }, nc);
    await client.refreshTagIds();

    expect(client.getTagId('custom-tag')).toBe(99);
    expect(client.getTagName(99)).toBe('custom-tag');
  });

  // GET FILE TAGS
  test('lists tags assigned to a file', async () => {
    const nc = createMockNC();
    nc.request.mockResolvedValue({
      text: () => Promise.resolve(`<?xml version="1.0"?>
        <d:multistatus xmlns:d="DAV:" xmlns:oc="http://owncloud.org/ns">
          <d:response><d:propstat><d:prop>
            <oc:display-name>pending</oc:display-name>
            <oc:id>2</oc:id>
          </d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>
          <d:response><d:propstat><d:prop>
            <oc:display-name>ai-flagged</oc:display-name>
            <oc:id>11</oc:id>
          </d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>
        </d:multistatus>`)
    });

    const client = new SystemTagsClient(TAG_CONFIG, nc);
    const tags = await client.getFileTags(12345);

    expect(tags).toHaveLength(2);
    expect(tags[0]).toEqual({ name: 'pending', id: 2 });
    expect(tags[1]).toEqual({ name: 'ai-flagged', id: 11 });
  });

  // HAS TAG
  test('checks if file has specific tag', async () => {
    const nc = createMockNC();
    nc.request.mockResolvedValue({
      text: () => Promise.resolve(
        '<d:multistatus xmlns:d="DAV:" xmlns:oc="http://owncloud.org/ns">' +
        '<d:response><d:propstat><d:prop>' +
        '<oc:display-name>pending</oc:display-name><oc:id>2</oc:id>' +
        '</d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>' +
        '</d:multistatus>'
      )
    });

    const client = new SystemTagsClient(TAG_CONFIG, nc);
    expect(await client.hasTag(12345, 'pending')).toBe(true);
  });
});
```

---

## Module Index

```javascript
// src/lib/nc-flow/index.js

const { WebhookReceiver } = require('./webhook-receiver');
const { ActivityPoller } = require('./activity-poller');
const { SystemTagsClient } = require('./system-tags');

module.exports = {
  WebhookReceiver,
  ActivityPoller,
  SystemTagsClient
};
```

---

## Integration with HeartbeatManager (DO NOT BUILD YET)

This section documents how to wire the NC Flow modules into the existing architecture. **This is a separate Claude Code session** — don't do it in this session.

### Startup Wiring (in index.js)

```javascript
const { WebhookReceiver, ActivityPoller, SystemTagsClient } = require('./lib/nc-flow');

// Create NC Flow modules
const webhookReceiver = new WebhookReceiver(config.ncFlow?.webhooks);
const activityPoller = new ActivityPoller(config.ncFlow?.activity, ncRequestManager);
const systemTags = new SystemTagsClient(config.ncFlow?.tags, ncRequestManager);

// Refresh tag IDs on startup
await systemTags.refreshTagIds();

// Wire events from both sources into a common handler
const handleFlowEvent = (event) => {
  // Feed into HeartbeatManager's event queue
  heartbeatManager.enqueueExternalEvent(event);
};

webhookReceiver.on('event', handleFlowEvent);
activityPoller.on('event', handleFlowEvent);

// Start both
await webhookReceiver.start();  // Returns false if dormant
activityPoller.start();

// Shutdown
process.on('SIGTERM', async () => {
  activityPoller.stop();
  await webhookReceiver.stop();
  // ... existing shutdown
});
```

### HeartbeatManager Changes

Add a method to HeartbeatManager that accepts external events:

```javascript
class HeartbeatManager {
  constructor(/* existing */) {
    this.externalEvents = [];  // Queue for NC Flow events
  }

  enqueueExternalEvent(event) {
    this.externalEvents.push(event);
  }

  async heartbeat() {
    // EXISTING: poll Talk, check Deck
    
    // NEW: Process any NC Flow events accumulated since last heartbeat
    const flowEvents = this.externalEvents.splice(0);
    if (flowEvents.length > 0) {
      await this.processFlowEvents(flowEvents);
    }
  }

  async processFlowEvents(events) {
    for (const event of events) {
      // Example handlers:
      if (event.type === 'file_created' && event.objectName.startsWith('/Inbox/')) {
        // New file in inbox — tag as pending, queue for processing
        await this.systemTags.tagFileByPath(event.objectName, 'pending');
        // Create Deck card for processing
      }
      if (event.type === 'calendar_event_changed') {
        // Calendar change — check for conflicts
      }
      if (event.type === 'tag_assigned' && event.data.tagName === 'pending') {
        // User manually tagged a file as pending — queue for processing
      }
    }
  }
}
```

### Config Section

Add to the main Moltagent config:

```javascript
{
  // ... existing config sections (nextcloud, providers, budgets, etc.)
  
  ncFlow: {
    webhooks: {
      enabled: false,         // Dormant until NC 32
      port: 3100,
      host: '0.0.0.0',
      secret: '',
      trustedIPs: [],
      shutdownTimeoutMs: 5000
    },
    activity: {
      enabled: true,          // Active on NC 31
      pollIntervalMs: 60000,
      maxEventsPerPoll: 50,
      ignoreOwnEvents: true,
      ignoreUsers: [],
      enabledTypes: [
        'file_created', 'file_changed', 'file_deleted', 'file_shared',
        'calendar_event_created', 'calendar_event_changed',
        'deck_card_created', 'deck_card_updated', 'deck_card_moved',
        'tag_assigned', 'tag_removed',
        'share_created'
      ]
    },
    tags: {
      enabled: true,
      tagIds: {
        'pending': 2,         // Instance-specific — set during deployment
        'processed': 5,
        'needs-review': 8,
        'ai-flagged': 11
      }
    }
  }
}
```

---

## Exit Criteria

Before calling this session done:

### WebhookReceiver:
- [ ] Server does NOT start when `enabled: false`
- [ ] Server starts and stops cleanly when enabled
- [ ] Accepts POST to `/webhooks/nc`, returns 404 for other paths
- [ ] Verifies shared secret header when configured
- [ ] Rejects requests from untrusted IPs when configured
- [ ] Handles malformed JSON gracefully (400, no crash)
- [ ] Normalizes known NC event classes to NCFlowEvent types
- [ ] Normalizes unknown events as type `'unknown'` with raw data preserved
- [ ] Emits `'event'` with correct schema
- [ ] Payload size limited to 1MB

### ActivityPoller:
- [ ] Returns false when disabled
- [ ] Polls Activity API and emits normalized events
- [ ] Tracks `lastActivityId` cursor for pagination
- [ ] Skips own events when `ignoreOwnEvents: true`
- [ ] Filters by `enabledTypes`
- [ ] Classifies all known activity types correctly
- [ ] Handles API errors without crashing (logs and continues)
- [ ] Prevents overlapping polls
- [ ] `pollNow()` works for manual/test invocation
- [ ] Metrics are accurate

### SystemTagsClient:
- [ ] Resolves tag name ↔ ID from config
- [ ] Assigns tag to file via WebDAV PUT
- [ ] Removes tag from file via WebDAV DELETE
- [ ] Handles 409 (already tagged) and 404 (already removed) gracefully
- [ ] Transitions tags (remove old, assign new)
- [ ] Resolves file ID from path via PROPFIND
- [ ] Convenience methods (`tagFileByPath`, `transitionTagsByPath`) work
- [ ] `refreshTagIds()` fetches from NC and updates mapping
- [ ] `getFileTags()` returns tags assigned to a file
- [ ] `hasTag()` correctly checks tag presence

### General:
- [ ] All tests pass: `npm test`
- [ ] ESLint passes: `npm run lint`
- [ ] AGPL-3.0 license headers on all new files
- [ ] JSDoc annotations on all public methods
- [ ] `src/lib/nc-flow/index.js` exports all 3 modules
- [ ] No external dependencies added (pure Node.js + existing project deps)

---

## Do NOT Change

- The HeartbeatManager's existing Talk polling or Deck pipeline
- The NCRequestManager's endpoint groups or rate limiting
- Any security guards
- The credential broker mechanism
- The LLM routing table

---

## What Comes Next (After This Session)

1. **Wire NC Flow into HeartbeatManager** — add `enqueueExternalEvent()`, process flow events in heartbeat cycle
2. **Add `ncFlow` endpoint group to NCRequestManager** — Activity API and SystemTags WebDAV need their own rate limit group
3. **Flow Recipes documentation** — 5 click-by-click guides for customers
4. **NC 32 Webhook Activation Guide** — step-by-step for when Storage Share upgrades

---

*Built for Moltagent NC Flow Integration. The nervous system of your digital employee's home.*
