/**
 * Rate Limit Tracker
 *
 * Tracks rate limits across all providers from response headers.
 * Prevents requests when limits are exhausted.
 *
 * @module llm/rate-limit-tracker
 * @version 1.0.0
 */

class RateLimitTracker {
  constructor() {
    this.limits = new Map();
    this.history = new Map();
  }

  /**
   * Update rate limits from API response headers
   * @param {string} providerId - Provider identifier
   * @param {Object} headers - Parsed headers from response
   */
  updateFromResponse(providerId, headers) {
    if (!headers) return;

    const current = this.limits.get(providerId) || {};

    const limits = {
      // Request limits
      requestsLimit: headers.requestsLimit ?? current.requestsLimit,
      requestsRemaining: headers.requestsRemaining ?? current.requestsRemaining,
      requestsReset: this.parseResetTime(headers.requestsReset) ?? current.requestsReset,

      // Token limits
      tokensLimit: headers.tokensLimit ?? current.tokensLimit,
      tokensRemaining: headers.tokensRemaining ?? current.tokensRemaining,
      tokensReset: this.parseResetTime(headers.tokensReset) ?? current.tokensReset,

      // Retry info
      retryAfter: headers.retryAfter ?? null,

      updatedAt: Date.now()
    };

    this.limits.set(providerId, limits);
    this.recordHistory(providerId, limits);

    return limits;
  }

  /**
   * Parse reset time from header value
   * @param {string|number|null} value - Reset time value
   * @returns {number|null} - Unix timestamp
   */
  parseResetTime(value) {
    if (value === null || value === undefined) return null;

    // Already a number (seconds from now)
    if (typeof value === 'number') {
      return Date.now() + value * 1000;
    }

    // ISO timestamp string
    if (typeof value === 'string') {
      // Check if it's seconds
      const seconds = parseInt(value, 10);
      if (!isNaN(seconds) && value === String(seconds)) {
        return Date.now() + seconds * 1000;
      }

      // Try parsing as date
      const date = new Date(value);
      if (!isNaN(date.getTime())) {
        return date.getTime();
      }
    }

    return null;
  }

  /**
   * Record history for prediction
   * @private
   */
  recordHistory(providerId, limits) {
    if (!this.history.has(providerId)) {
      this.history.set(providerId, []);
    }

    const history = this.history.get(providerId);
    history.push({
      timestamp: Date.now(),
      tokensRemaining: limits.tokensRemaining,
      requestsRemaining: limits.requestsRemaining
    });

    // Keep only last 100 entries
    if (history.length > 100) {
      history.splice(0, history.length - 100);
    }
  }

  /**
   * Check if we can make a request to a provider
   * @param {string} providerId - Provider identifier
   * @param {number} [estimatedTokens=500] - Estimated tokens for request
   * @returns {Object} - { allowed, reason?, retryAt?, confidence }
   */
  canRequest(providerId, estimatedTokens = 500) {
    const limits = this.limits.get(providerId);

    // No data - allow with unknown confidence
    if (!limits) {
      return { allowed: true, confidence: 'unknown' };
    }

    const now = Date.now();

    // Check if rate limit has reset
    if (limits.requestsReset && limits.requestsReset < now) {
      // Limit should have reset, optimistically allow
      return { allowed: true, confidence: 'medium' };
    }

    // Check request limit
    if (limits.requestsRemaining !== null && limits.requestsRemaining < 1) {
      return {
        allowed: false,
        reason: 'request_limit_exhausted',
        retryAt: limits.requestsReset,
        confidence: 'high'
      };
    }

    // Check token limit (with 20% buffer)
    if (limits.tokensRemaining !== null) {
      const safeLimit = limits.tokensRemaining * 0.8;
      if (estimatedTokens > safeLimit) {
        return {
          allowed: false,
          reason: 'token_limit_low',
          available: limits.tokensRemaining,
          requested: estimatedTokens,
          retryAt: limits.tokensReset,
          confidence: 'high'
        };
      }
    }

    // Check retry-after
    if (limits.retryAfter) {
      const retryAt = limits.updatedAt + limits.retryAfter * 1000;
      if (retryAt > now) {
        return {
          allowed: false,
          reason: 'retry_after_active',
          retryAt,
          confidence: 'high'
        };
      }
    }

    return { allowed: true, confidence: 'high' };
  }

  /**
   * Mark provider as rate limited (from 429 error)
   * @param {string} providerId - Provider identifier
   * @param {number} [retryAfterSeconds] - Seconds to wait
   */
  markRateLimited(providerId, retryAfterSeconds = 60) {
    const current = this.limits.get(providerId) || {};

    this.limits.set(providerId, {
      ...current,
      requestsRemaining: 0,
      retryAfter: retryAfterSeconds,
      updatedAt: Date.now()
    });
  }

  /**
   * Get current limits for a provider
   * @param {string} providerId
   * @returns {Object|null}
   */
  getLimits(providerId) {
    return this.limits.get(providerId) || null;
  }

  /**
   * Get all tracked providers
   * @returns {string[]}
   */
  getTrackedProviders() {
    return Array.from(this.limits.keys());
  }

  /**
   * Predict when a provider will be available
   * @param {string} providerId
   * @returns {Object} - { available, retryAt? }
   */
  predictAvailability(providerId) {
    const limits = this.limits.get(providerId);

    if (!limits) {
      return { available: true };
    }

    const now = Date.now();

    // Find the next reset time
    const resetTimes = [
      limits.requestsReset,
      limits.tokensReset,
      limits.retryAfter ? limits.updatedAt + limits.retryAfter * 1000 : null
    ].filter(t => t && t > now);

    if (resetTimes.length === 0) {
      return { available: true };
    }

    const nextReset = Math.min(...resetTimes);

    return {
      available: false,
      retryAt: nextReset,
      waitMs: nextReset - now
    };
  }

  /**
   * Clear rate limit data for a provider (e.g., after successful request)
   * @param {string} providerId
   */
  clearRetryAfter(providerId) {
    const limits = this.limits.get(providerId);
    if (limits) {
      limits.retryAfter = null;
    }
  }

  /**
   * Get summary of all rate limits
   * @returns {Object}
   */
  getSummary() {
    const summary = {};

    for (const [providerId, limits] of this.limits) {
      summary[providerId] = {
        requestsRemaining: limits.requestsRemaining,
        tokensRemaining: limits.tokensRemaining,
        canRequest: this.canRequest(providerId).allowed,
        updatedAt: limits.updatedAt
      };
    }

    return summary;
  }
}

module.exports = RateLimitTracker;
