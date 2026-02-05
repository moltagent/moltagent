/**
 * Health and Stats HTTP Handler
 *
 * Architecture Brief:
 * -------------------
 * Problem: webhook-server.js handleRequest() embeds /health and /stats
 * endpoint logic directly, mixing concerns.
 *
 * Pattern: Handler pattern - this module handles health check and statistics
 * endpoints for monitoring and debugging.
 *
 * Key Dependencies:
 * - TalkSignatureVerifier (for verification stats)
 * - NCRequestManager (for request metrics)
 *
 * Data Flow:
 * - HTTP server routes GET /health or /stats to this handler
 * - Handler collects statistics from components
 * - Returns JSON response
 *
 * Integration Points:
 * - Registered with HTTP server for GET /health, GET /stats
 * - Uses signatureVerifier.getStats()
 * - Uses ncRequestManager.getMetrics()
 *
 * @module server/health-handler
 * @version 1.0.0
 */

'use strict';

// -----------------------------------------------------------------------------
// Constants
// -----------------------------------------------------------------------------

/** @type {string} */
const SERVICE_NAME = 'moltagent-webhook';

/** @type {string} */
const VERSION = '2.0.0';

// -----------------------------------------------------------------------------
// Types
// -----------------------------------------------------------------------------

/**
 * @typedef {Object} HealthDependencies
 * @property {Object} signatureVerifier - TalkSignatureVerifier instance
 * @property {Object} [ncRequestManager] - NCRequestManager instance
 */

/**
 * @typedef {Object} HealthResponse
 * @property {string} status - 'ok' or 'degraded'
 * @property {string} service - Service name
 * @property {string} version - Service version
 * @property {number} verifications - Total verification count
 */

/**
 * @typedef {Object} StatsResponse
 * @property {Object} verifier - Signature verifier statistics
 * @property {Object} [ncRequestManager] - NC request manager metrics
 */

// -----------------------------------------------------------------------------
// Health Handler Class
// -----------------------------------------------------------------------------

/**
 * Handles health check and statistics endpoints.
 *
 * Endpoints:
 * - GET /health - Quick health check (status, version, verification count)
 * - GET /stats - Detailed statistics (verifier stats, NC request metrics)
 */
class HealthHandler {
  /**
   * @param {HealthDependencies} deps
   */
  constructor(deps) {
    /** @type {Object} */
    this.signatureVerifier = deps.signatureVerifier;

    /** @type {Object|null} */
    this.ncRequestManager = deps.ncRequestManager || null;
  }

  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------

  /**
   * Handle /health endpoint
   *
   * @param {import('http').IncomingMessage} req - HTTP request
   * @param {import('http').ServerResponse} res - HTTP response
   * @returns {void}
   */
  handleHealth(req, res) {
    this._sendJson(res, 200, {
      status: 'ok',
      service: SERVICE_NAME,
      version: VERSION,
      verifications: this.signatureVerifier.getStats().totalVerifications
    });
  }

  /**
   * Handle /stats endpoint
   *
   * @param {import('http').IncomingMessage} req - HTTP request
   * @param {import('http').ServerResponse} res - HTTP response
   * @returns {void}
   */
  handleStats(req, res) {
    const stats = {
      verifier: this.signatureVerifier.getStats(),
      ncRequestManager: this.ncRequestManager ? this.ncRequestManager.getMetrics() : null
    };
    this._sendJson(res, 200, stats);
  }

  // ---------------------------------------------------------------------------
  // Private Methods
  // ---------------------------------------------------------------------------

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
    res.end(JSON.stringify(body, null, 2));
  }
}

// -----------------------------------------------------------------------------
// Exports
// -----------------------------------------------------------------------------

module.exports = HealthHandler;
