/**
 * NC Talk Message Signature Verifier
 *
 * Verifies HMAC-SHA256 signatures on incoming NC Talk webhook messages.
 * This is a critical security component that ensures messages actually
 * originate from the configured Nextcloud instance.
 *
 * Headers verified:
 * - X-Nextcloud-Talk-Signature: HMAC-SHA256(random + body, secret)
 * - X-Nextcloud-Talk-Random: 64-char cryptographic nonce
 * - X-Nextcloud-Talk-Backend: Origin Nextcloud URL
 *
 * @module talk-signature-verifier
 * @version 1.0.0
 */

const crypto = require('crypto');

/**
 * Result of signature verification
 * @typedef {Object} VerificationResult
 * @property {boolean} valid - Whether the signature is valid
 * @property {string} [reason] - Reason for failure (if invalid)
 * @property {string} [backend] - The backend URL from the request
 * @property {Object} [details] - Additional details for audit logging
 */

class TalkSignatureVerifier {
  /**
   * @param {Object} config
   * @param {Function} config.getSecret - Async function that returns the shared secret
   * @param {string[]} [config.allowedBackends] - List of allowed Nextcloud URLs
   * @param {Function} [config.auditLog] - Audit logging function
   * @param {boolean} [config.strictMode=true] - Reject on any validation failure
   * @param {boolean} [config.requireBackendValidation=true] - Require backend in allowlist
   */
  constructor(config = {}) {
    if (!config.getSecret || typeof config.getSecret !== 'function') {
      throw new Error('TalkSignatureVerifier requires a getSecret function');
    }

    this.getSecret = config.getSecret;
    this.allowedBackends = config.allowedBackends || [];
    this.auditLog = config.auditLog || (async () => {});
    this.strictMode = config.strictMode !== false;
    this.requireBackendValidation = config.requireBackendValidation !== false;

    // Statistics
    this.stats = {
      totalVerifications: 0,
      successful: 0,
      failed: 0,
      failureReasons: {}
    };
  }

  /**
   * Verify an incoming NC Talk webhook request
   *
   * @param {Object} headers - Request headers (lowercase keys)
   * @param {string|Buffer} body - Raw request body
   * @returns {Promise<VerificationResult>}
   */
  async verify(headers, body) {
    this.stats.totalVerifications++;

    const startTime = Date.now();

    // Normalize headers to lowercase
    const normalizedHeaders = {};
    for (const [key, value] of Object.entries(headers)) {
      normalizedHeaders[key.toLowerCase()] = value;
    }

    const signature = normalizedHeaders['x-nextcloud-talk-signature'];
    const random = normalizedHeaders['x-nextcloud-talk-random'];
    const backend = normalizedHeaders['x-nextcloud-talk-backend'];

    // Step 1: Validate required headers are present
    const headerValidation = this._validateHeaders(signature, random, backend);
    if (!headerValidation.valid) {
      return this._recordFailure(headerValidation.reason, {
        hasSignature: !!signature,
        hasRandom: !!random,
        hasBackend: !!backend
      });
    }

    // Step 2: Validate header formats
    const formatValidation = this._validateFormats(signature, random);
    if (!formatValidation.valid) {
      return this._recordFailure(formatValidation.reason, {
        signatureLength: signature?.length,
        randomLength: random?.length
      });
    }

    // Step 3: Validate backend is in allowlist (if configured)
    if (this.requireBackendValidation && this.allowedBackends.length > 0) {
      const backendValidation = this._validateBackend(backend);
      if (!backendValidation.valid) {
        return this._recordFailure(backendValidation.reason, {
          backend,
          allowedBackends: this.allowedBackends
        });
      }
    }

    // Step 4: Get the secret
    let secret;
    try {
      secret = await this.getSecret();
      if (!secret) {
        return this._recordFailure('Secret not available', {});
      }
    } catch (err) {
      await this.auditLog('signature_verification_error', {
        error: err.message,
        phase: 'get_secret'
      });
      return this._recordFailure('Failed to retrieve secret', {
        error: err.message
      });
    }

    // Step 5: Compute expected signature
    const bodyStr = Buffer.isBuffer(body) ? body.toString('utf8') : body;
    const message = random + bodyStr;

    const expected = crypto
      .createHmac('sha256', secret)
      .update(message)
      .digest('hex');

    // Step 6: Timing-safe comparison
    const isValid = this._timingSafeCompare(expected, signature.toLowerCase());

    const duration = Date.now() - startTime;

    if (isValid) {
      this.stats.successful++;

      await this.auditLog('signature_verified', {
        backend,
        duration,
        bodyLength: bodyStr.length
      });

      return {
        valid: true,
        backend,
        details: {
          duration,
          bodyLength: bodyStr.length
        }
      };
    } else {
      return this._recordFailure('Signature mismatch', {
        backend,
        duration,
        bodyLength: bodyStr.length
      });
    }
  }

  /**
   * Validate required headers are present
   * @private
   */
  _validateHeaders(signature, random, backend) {
    if (!signature) {
      return { valid: false, reason: 'Missing X-Nextcloud-Talk-Signature header' };
    }
    if (!random) {
      return { valid: false, reason: 'Missing X-Nextcloud-Talk-Random header' };
    }
    if (!backend && this.strictMode) {
      return { valid: false, reason: 'Missing X-Nextcloud-Talk-Backend header' };
    }
    return { valid: true };
  }

  /**
   * Validate header formats
   * @private
   */
  _validateFormats(signature, random) {
    // Signature should be 64 hex characters (SHA256 output)
    if (!/^[a-fA-F0-9]{64}$/.test(signature)) {
      return { valid: false, reason: 'Invalid signature format (expected 64 hex chars)' };
    }

    // Random should be 64 characters (base64-ish or alphanumeric)
    // Nextcloud uses SecureRandom which generates alphanumeric + some special chars
    if (random.length !== 64) {
      return { valid: false, reason: 'Invalid random format (expected 64 chars)' };
    }

    return { valid: true };
  }

  /**
   * Validate backend is in allowlist
   * @private
   */
  _validateBackend(backend) {
    // Normalize URLs for comparison (remove trailing slash)
    const normalizedBackend = backend.replace(/\/+$/, '').toLowerCase();
    const normalizedAllowed = this.allowedBackends.map(b =>
      b.replace(/\/+$/, '').toLowerCase()
    );

    if (!normalizedAllowed.includes(normalizedBackend)) {
      return {
        valid: false,
        reason: 'Backend not in allowlist'
      };
    }

    return { valid: true };
  }

  /**
   * Timing-safe string comparison
   * Handles different length strings safely
   * @private
   */
  _timingSafeCompare(expected, actual) {
    // If lengths differ, comparison will fail but we still do constant-time work
    // to prevent timing attacks from revealing length information
    if (expected.length !== actual.length) {
      // Do a dummy comparison to maintain constant time
      crypto.timingSafeEqual(
        Buffer.from(expected),
        Buffer.from(expected)
      );
      return false;
    }

    try {
      return crypto.timingSafeEqual(
        Buffer.from(expected, 'utf8'),
        Buffer.from(actual, 'utf8')
      );
    } catch {
      return false;
    }
  }

  /**
   * Record a verification failure
   * @private
   */
  async _recordFailure(reason, details) {
    this.stats.failed++;
    this.stats.failureReasons[reason] = (this.stats.failureReasons[reason] || 0) + 1;

    await this.auditLog('signature_verification_failed', {
      reason,
      ...details
    });

    return {
      valid: false,
      reason,
      details
    };
  }

  /**
   * Add a backend to the allowlist
   * @param {string} backend - Nextcloud URL to allow
   */
  addAllowedBackend(backend) {
    if (!this.allowedBackends.includes(backend)) {
      this.allowedBackends.push(backend);
    }
  }

  /**
   * Remove a backend from the allowlist
   * @param {string} backend - Nextcloud URL to remove
   */
  removeAllowedBackend(backend) {
    const index = this.allowedBackends.indexOf(backend);
    if (index > -1) {
      this.allowedBackends.splice(index, 1);
    }
  }

  /**
   * Get verification statistics
   * @returns {Object}
   */
  getStats() {
    return {
      ...this.stats,
      successRate: this.stats.totalVerifications > 0
        ? ((this.stats.successful / this.stats.totalVerifications) * 100).toFixed(2) + '%'
        : 'N/A'
    };
  }

  /**
   * Reset statistics
   */
  resetStats() {
    this.stats = {
      totalVerifications: 0,
      successful: 0,
      failed: 0,
      failureReasons: {}
    };
  }

  /**
   * Create a signature for outgoing bot messages
   * Used when the bot sends messages back to NC Talk
   *
   * @param {string} body - The JSON body to sign
   * @returns {Promise<{random: string, signature: string}>}
   */
  async createSignature(body) {
    const secret = await this.getSecret();
    if (!secret) {
      throw new Error('Secret not available for signing');
    }

    // Generate 64 hex characters (32 bytes)
    const random = crypto.randomBytes(32).toString('hex');

    const signature = crypto
      .createHmac('sha256', secret)
      .update(random + body)
      .digest('hex');

    return { random, signature };
  }
}

/**
 * Custom error for signature verification failures
 */
class SignatureVerificationError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = 'SignatureVerificationError';
    this.code = 'SIGNATURE_INVALID';
    this.reason = details.reason;
    this.backend = details.backend;
  }
}

module.exports = TalkSignatureVerifier;
module.exports.SignatureVerificationError = SignatureVerificationError;
