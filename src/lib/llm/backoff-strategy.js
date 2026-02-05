/**
 * Backoff Strategy
 *
 * Implements exponential backoff with jitter for rate limit handling.
 *
 * @module llm/backoff-strategy
 * @version 1.0.0
 */

const appConfig = require('../config');

class BackoffStrategy {
  /**
   * @param {Object} config
   * @param {number} [config.initialDelayMs] - Initial delay
   * @param {number} [config.maxDelayMs] - Maximum delay (5 minutes)
   * @param {number} [config.multiplier] - Backoff multiplier
   * @param {number} [config.jitterPercent=25] - Jitter percentage
   * @param {number} [config.maxAttempts] - Max attempts before giving up
   */
  constructor(config = {}) {
    this.initialDelayMs = config.initialDelayMs || appConfig.llm.backoffInitialMs;
    this.maxDelayMs = config.maxDelayMs || appConfig.llm.backoffMaxMs;
    this.multiplier = config.multiplier || appConfig.llm.backoffMultiplier;
    this.jitterPercent = config.jitterPercent || 25;
    this.maxAttempts = config.maxAttempts || appConfig.llm.backoffMaxAttempts;

    // Track attempts per provider
    this.attempts = new Map();
  }

  /**
   * Handle a rate limit error
   * @param {string} providerId - Provider that was rate limited
   * @param {Error} error - The error object
   * @returns {Object} - { shouldWait, shouldFailover, delayMs, nextRetry, attempt }
   */
  handleRateLimit(providerId, error) {
    const state = this.attempts.get(providerId) || { count: 0 };
    state.count++;
    state.lastError = error.message;
    state.lastErrorTime = Date.now();

    // Parse retry-after header if available
    const serverDelay = this.parseRetryAfter(error);

    // Calculate backoff delay
    const baseDelay = serverDelay || Math.min(
      this.initialDelayMs * Math.pow(this.multiplier, state.count - 1),
      this.maxDelayMs
    );

    // Add jitter to prevent thundering herd
    const jitterRange = baseDelay * (this.jitterPercent / 100);
    const jitter = (Math.random() * 2 - 1) * jitterRange;
    const finalDelay = Math.round(Math.max(0, baseDelay + jitter));

    state.nextRetry = Date.now() + finalDelay;
    this.attempts.set(providerId, state);

    return {
      shouldWait: state.count <= this.maxAttempts,
      shouldFailover: state.count >= 2, // Try another provider after 2 failures
      delayMs: finalDelay,
      nextRetry: state.nextRetry,
      attempt: state.count,
      gaveUp: state.count > this.maxAttempts
    };
  }

  /**
   * Parse retry-after from error
   * @private
   */
  parseRetryAfter(error) {
    // Check error.headers or error.retryAfter
    let retryAfter = error.headers?.retryAfter || error.retryAfter;

    if (!retryAfter) return null;

    // If it's a number, treat as seconds
    if (typeof retryAfter === 'number') {
      return retryAfter * 1000;
    }

    // Try parsing as integer seconds
    const seconds = parseInt(retryAfter, 10);
    if (!isNaN(seconds)) {
      return seconds * 1000;
    }

    // Try parsing as date
    const date = new Date(retryAfter);
    if (!isNaN(date.getTime())) {
      return Math.max(0, date.getTime() - Date.now());
    }

    return null;
  }

  /**
   * Check if we should wait before retrying
   * @param {string} providerId
   * @returns {Object} - { shouldWait, waitMs, nextRetry }
   */
  shouldWait(providerId) {
    const state = this.attempts.get(providerId);

    if (!state || !state.nextRetry) {
      return { shouldWait: false };
    }

    const now = Date.now();
    if (state.nextRetry > now) {
      return {
        shouldWait: true,
        waitMs: state.nextRetry - now,
        nextRetry: state.nextRetry
      };
    }

    return { shouldWait: false };
  }

  /**
   * Reset attempts for a provider (after successful request)
   * @param {string} providerId
   */
  reset(providerId) {
    this.attempts.delete(providerId);
  }

  /**
   * Get current attempt count
   * @param {string} providerId
   * @returns {number}
   */
  getAttemptCount(providerId) {
    return this.attempts.get(providerId)?.count || 0;
  }

  /**
   * Check if we've exceeded max attempts
   * @param {string} providerId
   * @returns {boolean}
   */
  isExhausted(providerId) {
    const count = this.getAttemptCount(providerId);
    return count >= this.maxAttempts;
  }

  /**
   * Sleep for specified duration
   * @param {number} ms
   * @returns {Promise<void>}
   */
  sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  /**
   * Get state summary
   * @returns {Object}
   */
  getSummary() {
    const summary = {};

    for (const [providerId, state] of this.attempts) {
      summary[providerId] = {
        attempts: state.count,
        lastError: state.lastError,
        nextRetry: state.nextRetry ? new Date(state.nextRetry).toISOString() : null,
        exhausted: state.count >= this.maxAttempts
      };
    }

    return summary;
  }

  /**
   * Clear all backoff state
   */
  clearAll() {
    this.attempts.clear();
  }
}

module.exports = BackoffStrategy;
