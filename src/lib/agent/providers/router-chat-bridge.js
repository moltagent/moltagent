'use strict';

/**
 * RouterChatBridge — Bridges LLMRouter v3 routing with AgentLoop's chat() interface.
 *
 * LLMRouter uses provider.generate(task, content) (single-shot text, no tools).
 * AgentLoop needs provider.chat({ system, messages, tools }) (multi-turn with tool calling).
 * This bridge routes chat() calls through LLMRouter's chain-building, circuit breakers,
 * backoff, rate limits, and budget enforcement, while delegating actual execution
 * to registered chat providers (ClaudeToolsProvider, OllamaToolsProvider).
 *
 * @module agent/providers/router-chat-bridge
 * @version 1.0.0
 */

class RouterChatBridge {
  /**
   * @param {Object} options
   * @param {import('../../llm/router')} options.router - LLMRouter v3 instance
   * @param {Map<string, Object>} options.chatProviders - Map of routerProviderId → chatProvider
   *   e.g. 'ollama-local' → OllamaToolsProvider, 'anthropic-claude' → ClaudeToolsProvider
   * @param {Object} [options.logger=console]
   * @param {string} [options.defaultJob='tools'] - Default job when none specified
   */
  constructor({ router, chatProviders, logger, defaultJob } = {}) {
    if (!router) throw new Error('RouterChatBridge requires a router instance');
    if (!chatProviders || chatProviders.size === 0) {
      throw new Error('RouterChatBridge requires at least one chatProvider');
    }

    this.router = router;
    this.chatProviders = chatProviders;
    this.logger = logger || console;
    this.defaultJob = defaultJob || 'tools';

    // Public property — assigned post-construction (same pattern as ProviderChain)
    this.fallbackNotifier = null;
  }

  /**
   * Route a chat request through LLMRouter's chain, executing via registered chat providers.
   *
   * @param {Object} params
   * @param {string} params.system - System prompt
   * @param {Array} params.messages - Conversation messages
   * @param {Array} [params.tools] - Tool definitions
   * @param {boolean} [params.forceLocal] - Restrict to local providers
   * @param {string} [params.job] - Job hint (quick, tools, thinking, etc.)
   * @returns {Promise<{content: string|null, toolCalls: Array|null, _routing: Object}>}
   */
  async chat(params) {
    const job = params.job || this.defaultJob;
    const forceLocal = !!params.forceLocal;

    // 1. Get chain from router
    const { chain, skipped } = this.router.buildProviderChain(job, { forceLocal });

    // 2. Filter to providers with registered chat implementations
    const candidates = chain.filter(entry => this.chatProviders.has(entry.id));

    if (candidates.length === 0) {
      const allSkipped = [
        ...skipped.map(s => `${s.id}: ${s.reason}`),
        ...chain.filter(e => !this.chatProviders.has(e.id)).map(e => `${e.id}: no chat provider`)
      ];
      const err = new Error(
        `All providers exhausted for job ${job}. ` +
        `Skipped: ${allSkipped.join(', ') || 'none'}`
      );
      err._errorChain = {
        primary: allSkipped[0] || 'no providers available',
        fallback: allSkipped[allSkipped.length - 1] || 'no fallback'
      };
      throw err;
    }

    // Determine primary (first candidate) locality for _routing metadata
    const primaryId = candidates[0].id;
    const primaryProvider = candidates[0].provider;
    const primaryIsLocal = primaryProvider.type === 'local';

    // 3. Try each candidate in order
    const errors = [];
    const failoverPath = [];

    for (let i = 0; i < candidates.length; i++) {
      const { id: providerId } = candidates[i];
      const chatProvider = this.chatProviders.get(providerId);
      const providerObj = candidates[i].provider;
      const isLocal = providerObj.type === 'local';
      const isFallback = i > 0;

      try {
        const result = await chatProvider.chat(params);

        // Record success with router
        this.router.recordOutcome(providerId, {
          success: true,
          cost: result._cost || 0,
          tokens: result._tokens || 0,
          inputTokens: result._inputTokens || 0,
          outputTokens: result._outputTokens || 0,
          headers: result._headers || null
        });

        if (isFallback) {
          this.router.stats.failovers++;
        }

        // Attach _routing metadata (FallbackNotifier compatible)
        result._routing = {
          isFallback,
          primaryIsLocal,
          fallbackIsLocal: isLocal,
          player: isFallback ? 'fallback' : 'primary',
          provider: providerId,
          job,
          failoverPath: failoverPath.length > 0 ? [...failoverPath] : undefined
        };

        // Notify FallbackNotifier
        if (this.fallbackNotifier) {
          try { this.fallbackNotifier.onRouteComplete(result); } catch (_e) { /* silent */ }
        }

        if (isFallback) {
          this.logger.info(`[RouterChatBridge] Failover: ${failoverPath.join(' → ')} → ${providerId} (job: ${job})`);
        } else {
          this.logger.info(`[RouterChatBridge] Routed to ${providerId} (job: ${job})`);
        }

        return result;
      } catch (err) {
        errors.push({ provider: providerId, error: err.message, status: err.status });
        failoverPath.push(providerId);

        // Record failure with router
        this.router.recordOutcome(providerId, {
          success: false,
          error: err
        });

        this.logger.warn(`[RouterChatBridge] ${providerId} failed: ${err.message}, trying next...`);
        continue;
      }
    }

    // All candidates exhausted
    this.router.stats.errors++;

    const lastProvider = candidates[candidates.length - 1];
    const chainedErr = new Error(
      `All providers exhausted for job ${job}. Tried: ${failoverPath.join(' → ')}`
    );
    chainedErr._errorChain = {
      primary: `${primaryId}: ${errors[0]?.error || 'failed'}`,
      fallback: errors.length > 1
        ? `${errors[errors.length - 1].provider}: ${errors[errors.length - 1].error}`
        : `${primaryId}: ${errors[0]?.error || 'failed'}`
    };
    // Preserve rate-limit status for AgentLoop._isRateLimitError()
    if (errors.some(e => e.status === 429 || e.status === 529)) {
      chainedErr.status = 429;
    }
    throw chainedErr;
  }
}

module.exports = { RouterChatBridge };
