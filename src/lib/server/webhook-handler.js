/**
 * Webhook Handler
 *
 * Architecture Brief:
 * -------------------
 * Problem: webhook-server.js handleRequest() mixes HTTP routing, signature
 * verification, and message processing in one function.
 *
 * Pattern: Handler pattern - this module handles the /webhook/nctalk endpoint
 * specifically, including signature verification and message processing.
 *
 * Key Dependencies:
 * - TalkSignatureVerifier (for webhook authentication)
 * - MessageProcessor (for processing verified messages)
 * - Audit logging
 *
 * Data Flow:
 * - HTTP server routes POST /webhook/nctalk to this handler
 * - Handler collects request body
 * - Verifies signature via TalkSignatureVerifier
 * - If valid, passes to MessageProcessor
 * - Returns appropriate HTTP response
 *
 * Integration Points:
 * - Registered with HTTP server for POST /webhook/nctalk
 * - Uses signatureVerifier.verify()
 * - Uses messageProcessor.process()
 *
 * @module server/webhook-handler
 * @version 1.0.0
 */

'use strict';

// -----------------------------------------------------------------------------
// Types
// -----------------------------------------------------------------------------

/**
 * @typedef {Object} WebhookDependencies
 * @property {Object} signatureVerifier - TalkSignatureVerifier instance
 * @property {Object} messageProcessor - MessageProcessor instance
 * @property {Function} auditLog - Audit logging function
 */

/**
 * @typedef {Object} WebhookResult
 * @property {number} status - HTTP status code
 * @property {Object} [body] - Response body (JSON)
 * @property {string} [text] - Response text (plain)
 */

// -----------------------------------------------------------------------------
// Webhook Handler Class
// -----------------------------------------------------------------------------

/**
 * Handles incoming NC Talk webhook requests.
 *
 * Responsibilities:
 * - Collect request body from stream
 * - Verify HMAC-SHA256 signature
 * - Validate backend URL
 * - Delegate to message processor
 * - Return appropriate HTTP responses
 */
class WebhookHandler {
  /**
   * @param {WebhookDependencies} deps
   */
  constructor(deps) {
    /** @type {Object} */
    this.signatureVerifier = deps.signatureVerifier;

    /** @type {Object} */
    this.messageProcessor = deps.messageProcessor;

    /** @type {Function} */
    this.auditLog = deps.auditLog || (async () => {});

    /** @type {Object|null} BotEnroller for instant enrollment on webhook */
    this.botEnroller = deps.botEnroller || null;
  }

  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------

  /**
   * Handle an incoming webhook request
   *
   * @param {import('http').IncomingMessage} req - HTTP request
   * @param {import('http').ServerResponse} res - HTTP response
   * @returns {Promise<void>}
   */
  async handle(req, res) {
    const clientIp = req.socket.remoteAddress;

    // Collect request body
    const body = await this._collectBody(req);

    // Verify signature BEFORE processing
    const verifyResult = await this.signatureVerifier.verify(req.headers, body);

    if (!verifyResult.valid) {
      console.log(`[Webhook] Signature verification failed: ${verifyResult.reason}`);
      await this.auditLog('webhook_rejected', {
        ip: clientIp,
        reason: verifyResult.reason,
        backend: req.headers['x-nextcloud-talk-backend'] || 'missing'
      });

      this._sendJson(res, 401, {
        error: 'Signature verification failed',
        reason: verifyResult.reason
      });
      return;
    }

    // Signature valid - respond immediately, then process asynchronously
    try {
      const data = JSON.parse(body);
      console.log(`[Webhook] Verified ${data.type || 'message'} from ${verifyResult.backend}`);

      // Respond to webhook immediately (NC Talk expects fast response)
      this._sendText(res, 200, 'OK');

      // Instant bot enrollment: if webhook arrived for a room, ensure the bot
      // is enrolled. This catches "user added to room" events immediately
      // rather than waiting for the next heartbeat periodic scan.
      if (this.botEnroller && data.target?.token) {
        this.botEnroller.enrollRoom(data.target.token).catch(() => {});
      }

      // Process message asynchronously (fire-and-forget)
      this.messageProcessor.process(data).catch(error => {
        console.error('[Webhook] Async processing error:', error.message);
        this.auditLog('webhook_error', {
          ip: clientIp,
          error: error.message
        }).catch(() => {});
      });

    } catch (error) {
      // Only JSON parsing errors reach here (synchronous errors before processing)
      console.error('[Webhook] Message parsing error:', error.message);
      await this.auditLog('webhook_error', {
        ip: clientIp,
        error: error.message
      });

      this._sendJson(res, 500, { error: 'Invalid message format' });
    }
  }

  // ---------------------------------------------------------------------------
  // Private Methods
  // ---------------------------------------------------------------------------

  /**
   * Collect request body from stream
   *
   * @param {import('http').IncomingMessage} req - HTTP request
   * @returns {Promise<string>}
   * @private
   */
  _collectBody(req) {
    return new Promise((resolve, reject) => {
      let body = '';
      req.on('data', chunk => { body += chunk; });
      req.on('end', () => resolve(body));
      req.on('error', reject);
    });
  }

  /**
   * Send JSON response
   *
   * @param {import('http').ServerResponse} res - HTTP response
   * @param {number} status - HTTP status code
   * @param {Object} body - Response body
   * @private
   */
  _sendJson(res, status, body) {
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(body));
  }

  /**
   * Send text response
   *
   * @param {import('http').ServerResponse} res - HTTP response
   * @param {number} status - HTTP status code
   * @param {string} text - Response text
   * @private
   */
  _sendText(res, status, text) {
    res.writeHead(status, { 'Content-Type': 'text/plain' });
    res.end(text);
  }
}

// -----------------------------------------------------------------------------
// Exports
// -----------------------------------------------------------------------------

module.exports = WebhookHandler;
