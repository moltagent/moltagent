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
   * @param {Object} [options={}]
   * @param {boolean} [options.primaryIsLocal=false]
   * @param {boolean} [options.fallbackIsLocal=false]
   * @param {Object|null} [options.fallbackNotifier=null] - Object with onRouteComplete(result) method
   */
  constructor(primary, fallback, logger, options = {}) {
    this.primary = primary;
    this.fallback = fallback || null;
    this.logger = logger || console;
    this.primaryIsLocal = options.primaryIsLocal || false;
    this.fallbackIsLocal = options.fallbackIsLocal || false;
    // Public property — can also be assigned post-construction:
    //   llmProvider.fallbackNotifier = fallbackNotifier;
    this.fallbackNotifier = options.fallbackNotifier || null;
  }

  /**
   * Send a chat request, falling back on 429 rate-limit errors.
   *
   * Attaches `_routing` metadata to every result:
   *   { isFallback, primaryIsLocal, fallbackIsLocal, player }
   *
   * @param {Object} params - Same shape as any provider's chat() method
   * @returns {Promise<{content: string|null, toolCalls: Array|null, _routing: Object}>}
   */
  async chat(params) {
    // forceLocal: skip cloud providers, use only local.
    // Treated as intentional routing, not a fallback (isFallback: false).
    if (params.forceLocal) {
      if (this.primaryIsLocal) {
        const result = await this.primary.chat(params);
        result._routing = {
          isFallback: false,
          primaryIsLocal: this.primaryIsLocal,
          fallbackIsLocal: this.fallbackIsLocal,
          player: 'primary',
        };
        if (this.fallbackNotifier) {
          try { this.fallbackNotifier.onRouteComplete(result); } catch (e) { /* silent */ }
        }
        return result;
      }
      if (this.fallback && this.fallbackIsLocal) {
        const result = await this.fallback.chat(params);
        result._routing = {
          isFallback: false,
          primaryIsLocal: this.primaryIsLocal,
          fallbackIsLocal: this.fallbackIsLocal,
          player: 'fallback',
        };
        if (this.fallbackNotifier) {
          try { this.fallbackNotifier.onRouteComplete(result); } catch (e) { /* silent */ }
        }
        return result;
      }
      throw new Error('forceLocal requested but no local provider available');
    }

    try {
      const result = await this.primary.chat(params);
      result._routing = {
        isFallback: false,
        primaryIsLocal: this.primaryIsLocal,
        fallbackIsLocal: this.fallbackIsLocal,
        player: 'primary',
      };
      if (this.fallbackNotifier) {
        try { this.fallbackNotifier.onRouteComplete(result); } catch (e) { /* silent */ }
      }
      return result;
    } catch (err) {
      if (this.fallback && this._isRateLimitError(err)) {
        this.logger.warn(`[ProviderChain] Primary provider 429, falling back: ${err.message}`);
        const result = await this.fallback.chat(params);
        result._routing = {
          isFallback: true,
          primaryIsLocal: this.primaryIsLocal,
          fallbackIsLocal: this.fallbackIsLocal,
          player: 'fallback',
        };
        if (this.fallbackNotifier) {
          try { this.fallbackNotifier.onRouteComplete(result); } catch (e) { /* silent */ }
        }
        return result;
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
