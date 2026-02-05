'use strict';

/**
 * ProviderChain - Decorator that adds fallback on 429 rate-limit errors.
 *
 * Wraps a primary LLM provider and transparently falls back to a secondary
 * provider when the primary throws a rate-limit error after exhausting its
 * own retries. Non-429 errors propagate normally.
 *
 * @module agent/providers/provider-chain
 * @version 1.0.0
 */

class ProviderChain {
  /**
   * @param {Object} primary - Primary LLM provider (must implement chat())
   * @param {Object|null} fallback - Fallback LLM provider (may be null)
   * @param {Object} [logger=console]
   */
  constructor(primary, fallback, logger, options = {}) {
    this.primary = primary;
    this.fallback = fallback || null;
    this.logger = logger || console;
    this.primaryIsLocal = options.primaryIsLocal || false;
    this.fallbackIsLocal = options.fallbackIsLocal || false;
  }

  /**
   * Send a chat request, falling back on 429 rate-limit errors.
   *
   * @param {Object} params - Same shape as any provider's chat() method
   * @returns {Promise<{content: string|null, toolCalls: Array|null}>}
   */
  async chat(params) {
    // forceLocal: skip cloud providers, use only local
    if (params.forceLocal) {
      if (this.primaryIsLocal) {
        return this.primary.chat(params);
      }
      if (this.fallback && this.fallbackIsLocal) {
        return this.fallback.chat(params);
      }
      throw new Error('forceLocal requested but no local provider available');
    }

    try {
      return await this.primary.chat(params);
    } catch (err) {
      if (this.fallback && this._isRateLimitError(err)) {
        this.logger.warn(`[ProviderChain] Primary provider 429, falling back: ${err.message}`);
        return this.fallback.chat(params);
      }
      throw err;
    }
  }

  /**
   * Check whether an error is a rate-limit (429) error.
   *
   * Matches:
   *   - ClaudeToolsProvider: "Claude API rate limited after N retries: ..."
   *   - OllamaToolsProvider: "Ollama error 429: ..."
   *   - Any error with status 429
   *
   * @param {Error} err
   * @returns {boolean}
   * @private
   */
  _isRateLimitError(err) {
    if (err.status === 429) return true;
    if (!err.message) return false;
    return err.message.includes('rate limited') ||
           err.message.includes('Rate limited') ||
           /\berror 429\b/.test(err.message);
  }
}

module.exports = { ProviderChain };
