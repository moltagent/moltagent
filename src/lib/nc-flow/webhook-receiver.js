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
 * NC Flow Webhook Receiver
 *
 * Architecture Brief:
 * -------------------
 * Problem: Moltagent needs real-time event delivery from Nextcloud when the
 * webhook_listeners app expands its event whitelist (NC 32+). Until then,
 * this module ships dormant (config-disabled).
 *
 * Pattern: Lightweight HTTP server using Node.js built-in `http` module,
 * extending EventEmitter to emit normalized NCFlowEvent objects. Express.js
 * is NOT used -- we use raw http.createServer to avoid adding any dependency
 * surface for a dormant feature.
 *
 * Key Dependencies:
 * - Node.js built-in: events, http
 * - NCRequestManager (only for static helper methods: registerWebhook, listWebhooks, deleteWebhook)
 *
 * Data Flow:
 * NC Server --POST /webhooks/nc--> WebhookReceiver._handleRequest()
 *   --> _normalizeWebhookPayload() --> emit('event', NCFlowEvent)
 *   --> HeartbeatManager.enqueueExternalEvent() (wired externally)
 *
 * Integration Points:
 * - src/lib/nc-flow/index.js (module export)
 * - HeartbeatManager (event consumer, wired in a separate session)
 * - NCRequestManager (for webhook registration helpers)
 *
 * @module nc-flow/webhook-receiver
 * @version 1.0.0
 */

'use strict';

const { EventEmitter } = require('events');
const crypto = require('crypto');
const http = require('http');

/**
 * Map of known NC webhook event class names to normalized NCFlowEvent types.
 * Based on NC 31 / NC 32 event class naming conventions.
 * @type {Object<string, string>}
 */
const WEBHOOK_EVENT_MAP = {
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

/**
 * Maximum allowed request body size in bytes (1 MB).
 * @type {number}
 */
const MAX_BODY_SIZE = 1048576;

class WebhookReceiver extends EventEmitter {
  /**
   * @param {Object} config - ncFlow.webhooks config section
   * @param {boolean} [config.enabled=false] - Whether to start the HTTP server
   * @param {number} [config.port=3100] - HTTP listen port
   * @param {string} [config.host='0.0.0.0'] - Listen host
   * @param {string} [config.secret=''] - Shared secret for X-Webhook-Secret header verification
   * @param {string[]} [config.trustedIPs=[]] - Restrict to these source IPs (empty = no filtering)
   * @param {number} [config.shutdownTimeoutMs=5000] - Grace period on shutdown
   * @param {Object} [logger] - Optional logger (defaults to console)
   */
  constructor(config, logger) {
    super();
    this.config = config || {};
    this.logger = logger || console;
    this.server = null;
    this.enabled = this.config.enabled || false;
  }

  /**
   * Start the HTTP server if enabled.
   * If config.enabled is false, logs a dormant message and returns false.
   * @returns {Promise<boolean>} true if server started, false if dormant
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
   * Graceful shutdown of the HTTP server.
   * Waits up to config.shutdownTimeoutMs for in-flight requests to complete,
   * then force-closes.
   * @returns {Promise<void>}
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
   * Only accepts POST to /webhooks/nc. Validates IP, secret, body size,
   * parses JSON, normalizes to NCFlowEvent, emits 'event'.
   *
   * Response codes:
   * - 200: Event received (always respond quickly)
   * - 400: Malformed JSON
   * - 401: Invalid or missing shared secret
   * - 403: Untrusted source IP
   * - 404: Wrong method or path
   * - 413: Payload too large
   *
   * @param {http.IncomingMessage} req
   * @param {http.ServerResponse} res
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

    // Secret verification (if configured) — timing-safe comparison
    if (this.config.secret) {
      const providedSecret = req.headers['x-webhook-secret'] || '';
      const expected = Buffer.from(this.config.secret);
      const provided = Buffer.from(providedSecret);
      if (expected.length !== provided.length || !crypto.timingSafeEqual(expected, provided)) {
        this.logger.warn('[WebhookReceiver] Invalid webhook secret');
        res.writeHead(401);
        res.end('Unauthorized');
        return;
      }
    }

    // Read body
    let body = '';
    let aborted = false;
    req.on('data', (chunk) => {
      body += chunk;
      // Limit body size to 1MB
      if (!aborted && body.length > MAX_BODY_SIZE) {
        aborted = true;
        res.writeHead(413);
        res.end('Payload too large');
        req.destroy();
      }
    });

    req.on('end', () => {
      if (aborted) return;
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
   * @param {Object} payload - Raw webhook JSON body (parsed)
   * @returns {NCFlowEvent|null} Normalized event, or null if payload has no 'event' field
   * @private
   */
  _normalizeWebhookPayload(payload) {
    if (!payload || !payload.event) return null;

    const eventClass = payload.event;
    const user = payload.user?.uid || payload.user?.id || 'unknown';
    const timestamp = (payload.time || Math.floor(Date.now() / 1000)) * 1000;

    // Map NC event classes to normalized types
    const type = WEBHOOK_EVENT_MAP[eventClass] || 'unknown';

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
   * Infer the internal object type from a NC event class name.
   * @param {string} eventClass - Full NC event class name (e.g. 'OCP\\Files\\Events\\NodeCreatedEvent')
   * @returns {string} One of: 'file', 'calendar', 'share', 'deck_card', 'tag', 'unknown'
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
   * Register a webhook with NC via the OCS webhook_listeners API.
   * Call this manually (or from a deployment script) when NC 32+ is available.
   * NOT called during normal operation.
   *
   * @param {Object} ncRequestManager - NCRequestManager instance
   * @param {string} event - Full NC event class name (e.g. 'OCP\\Files\\Events\\NodeCreatedEvent')
   * @param {Object} [filters={}] - Optional event filters
   * @returns {Promise<Object>} Registration response from NC
   * @static
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
   * List all registered webhooks on the NC instance.
   * @param {Object} ncRequestManager - NCRequestManager instance
   * @returns {Promise<Object>} List of registered webhooks
   * @static
   */
  static async listWebhooks(ncRequestManager) {
    return ncRequestManager.request(
      '/ocs/v2.php/apps/webhook_listeners/api/v1/webhooks',
      { method: 'GET' }
    );
  }

  /**
   * Delete a registered webhook by ID.
   * @param {Object} ncRequestManager - NCRequestManager instance
   * @param {number|string} webhookId - Webhook registration ID
   * @returns {Promise<Object>} Deletion response
   * @static
   */
  static async deleteWebhook(ncRequestManager, webhookId) {
    const sanitizedId = String(parseInt(webhookId, 10));
    return ncRequestManager.request(
      `/ocs/v2.php/apps/webhook_listeners/api/v1/webhooks/${sanitizedId}`,
      { method: 'DELETE' }
    );
  }
}

module.exports = { WebhookReceiver, WEBHOOK_EVENT_MAP, MAX_BODY_SIZE };
