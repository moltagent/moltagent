'use strict';

/**
 * ProviderChain - Decorator that adds fallback on 429/529 rate-limit/overload errors.
 *
 * Wraps a primary LLM provider and transparently falls back to a secondary
 * provider when the primary throws a rate-limit or overload error after
 * exhausting its own retries. Tools are stripped on fallback to avoid
 * overwhelming smaller models. Other errors propagate normally.
 *
 * @module agent/providers/provider-chain
 * @version 1.2.0
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
   * Send a chat request, falling back on rate-limit/overload errors.
   *
   * On fallback: tools are stripped so the smaller model can respond
   * conversationally without choking on large tool schemas.
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
        const primaryReason = this._summarizeError(err, this.primary);
        this.logger.warn(`[ProviderChain] ${primaryReason}, falling back to ${this._providerName(this.fallback)} (tool-free)`);

        // Strip tools for fallback — small models choke on large tool schemas
        const fallbackParams = { ...params, tools: [] };

        try {
          const result = await this.fallback.chat(fallbackParams);
          result._routing = {
            isFallback: true,
            primaryIsLocal: this.primaryIsLocal,
            fallbackIsLocal: this.fallbackIsLocal,
            player: 'fallback',
            primaryReason,
          };
          if (this.fallbackNotifier) {
            try { this.fallbackNotifier.onRouteComplete(result); } catch (e) { /* silent */ }
          }
          return result;
        } catch (fallbackErr) {
          // Both providers failed — build a chained error with full context
          const fallbackReason = this._summarizeError(fallbackErr, this.fallback);
          const chainedErr = new Error(
            `${primaryReason}, then ${fallbackReason}`
          );
          chainedErr._errorChain = {
            primary: primaryReason,
            fallback: fallbackReason,
          };
          throw chainedErr;
        }
      }
      throw err;
    }
  }

  /**
   * Get a human-readable name for a provider.
   * @param {Object} provider
   * @returns {string}
   * @private
   */
  _providerName(provider) {
    return provider.model || provider.constructor?.name || 'unknown';
  }

  /**
   * Build a short, human-readable error summary.
   * @param {Error} err
   * @param {Object} provider
   * @returns {string}
   * @private
   */
  _summarizeError(err, provider) {
    const name = this._providerName(provider);
    const msg = err.message || '';
    if (msg.toLowerCase().includes('overloaded') || msg.includes('529')) {
      return `${name} was overloaded`;
    }
    if (msg.toLowerCase().includes('timed out') || msg.toLowerCase().includes('timeout')) {
      return `${name} timed out`;
    }
    if (msg.includes('rate limited') || msg.includes('429')) {
      return `${name} was rate limited`;
    }
    return `${name} failed (${msg.substring(0, 80)})`;
  }

  /**
   * Check whether an error is a rate-limit (429) or overload (529) error.
   *
   * Matches:
   *   - ClaudeToolsProvider: "Claude API rate limited after N retries: ..."
   *   - OllamaToolsProvider: "Ollama error 429: ..."
   *   - Any error with status 429 or 529
   *   - Any error message containing "overloaded"
   *
   * @param {Error} err
   * @returns {boolean}
   * @private
   */
  _isRateLimitError(err) {
    if (err.status === 429 || err.status === 529) return true;
    if (!err.message) return false;
    return err.message.includes('rate limited') ||
           err.message.includes('Rate limited') ||
           err.message.toLowerCase().includes('overloaded') ||
           /\berror (429|529)\b/.test(err.message);
  }
}

module.exports = { ProviderChain };
