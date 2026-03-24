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
   * @param {Object} [options.costTracker] - CostTracker instance for per-call audit logging
   */
  constructor({ router, chatProviders, logger, defaultJob, costTracker } = {}) {
    if (!router) throw new Error('RouterChatBridge requires a router instance');
    if (!chatProviders || chatProviders.size === 0) {
      throw new Error('RouterChatBridge requires at least one chatProvider');
    }

    this.router = router;
    this.chatProviders = chatProviders;
    this.logger = logger || console;
    this.defaultJob = defaultJob || 'tools';
    this.costTracker = costTracker || null;

    // Public property — assigned post-construction (same pattern as ProviderChain)
    this.fallbackNotifier = null;

    // Conversation-level circuit breaker: providers that timed out in THIS conversation
    // are skipped for all subsequent iterations. Prevents 4× 5-minute waits when
    // Ollama can't handle a tool-heavy AgentLoop prompt.
    // Call resetConversation() at the start of each new user conversation.
    this._conversationFailures = new Set();

    // Smart-mix pre-skip: when MicroPipeline classifies a message as non-local,
    // skipLocalForConversation() demotes local providers to fallback-only position.
    // They're tracked in _localPreSkip (separate from real timeout failures) so
    // they remain available as last-resort fallbacks when cloud providers fail.
    this._preSkipLocal = false;
    this._localPreSkip = new Set();
  }

  /**
   * Reset conversation-level failure tracking.
   * Call at the start of each new user conversation so previously-failed
   * providers get a fresh chance.
   *
   * When `_preSkipLocal` is true (set by skipLocalForConversation), the reset
   * re-applies the local skip so AgentLoop's resetConversation() doesn't undo it.
   */
  resetConversation() {
    this._conversationFailures.clear();
    this._localPreSkip.clear();
    if (this._preSkipLocal) {
      this._applyLocalSkip();
    }
  }

  /**
   * Pre-skip all local providers for this conversation.
   * Called by MessageProcessor when MicroPipeline classifies a message
   * as too complex for local handling (question/task/complex).
   * The skip persists across AgentLoop's resetConversation() calls.
   */
  skipLocalForConversation() {
    this._preSkipLocal = true;
    this._applyLocalSkip();
    this.logger.info('[RouterChatBridge] Pre-skipping local providers for conversation');
  }

  /**
   * Clear the pre-skip flag and local skip entries.
   * Called when MicroPipeline will handle the message locally (greeting/chitchat).
   */
  clearLocalSkip() {
    this._preSkipLocal = false;
    this._localPreSkip.clear();
  }

  /**
   * Track local providers for demotion (fallback-only, not primary).
   * Unlike _conversationFailures, these providers remain in the candidate list
   * but are moved behind cloud providers so cloud is tried first.
   * @private
   */
  _applyLocalSkip() {
    this._localPreSkip.clear();
    for (const [id] of this.chatProviders) {
      const provider = this.router.providers.get(id);
      if (provider && provider.type === 'local') {
        this._localPreSkip.add(id);
      }
    }
  }

  /**
   * Dynamically register a chat provider for a router provider ID.
   * Used when the Models card adds new players at runtime.
   * @param {string} id - Router provider ID
   * @param {Object} chatProvider - Chat provider instance (must implement chat())
   */
  registerChatProvider(id, chatProvider) {
    this.chatProviders.set(id, chatProvider);
    this.logger.info(`[RouterChatBridge] Registered chat provider: ${id}`);
  }

  /**
   * Remove a dynamically registered chat provider.
   * @param {string} id - Router provider ID
   */
  unregisterChatProvider(id) {
    this.chatProviders.delete(id);
    this.logger.info(`[RouterChatBridge] Unregistered chat provider: ${id}`);
  }

  /**
   * Route a chat request through LLMRouter's chain, executing via registered chat providers.
   *
   * @param {Object} params
   * @param {string} params.system - System prompt
   * @param {Array} params.messages - Conversation messages
   * @param {Array} [params.tools] - Tool definitions
   * @param {boolean} [params.forceLocal] - Restrict to local providers
   * @param {boolean} [params.allowCloud] - Per-call cloud override (overrides forceLocal and local-only roster)
   * @param {string} [params.job] - Job hint (quick, tools, thinking, etc.)
   * @returns {Promise<{content: string|null, toolCalls: Array|null, _routing: Object}>}
   */
  async chat(params) {
    const job = params.job || this.defaultJob;
    const forceLocal = !!params.forceLocal;
    const allowCloud = !!params.allowCloud;

    // 1. Get chain from router
    const { chain, skipped } = this.router.buildProviderChain(job, { forceLocal, allowCloud });

    // 2. Filter to providers with registered chat implementations,
    //    and skip providers that already timed out in this conversation.
    //    Pre-skipped locals (_localPreSkip) stay in the list but get demoted
    //    behind cloud providers so cloud is tried first, local only as fallback.
    const candidates = chain.filter(entry => {
      if (!this.chatProviders.has(entry.id)) return false;
      if (this._conversationFailures.has(entry.id)) {
        this.logger.info(`[RouterChatBridge] Skipping ${entry.id} — timed out earlier in this conversation`);
        return false;
      }
      return true;
    });

    // Demote pre-skipped locals to end of candidates (fallback position)
    if (this._preSkipLocal && candidates.length > 1) {
      const demoted = [];
      let i = 0;
      while (i < candidates.length) {
        if (this._localPreSkip.has(candidates[i].id)) {
          demoted.push(...candidates.splice(i, 1));
        } else {
          i++;
        }
      }
      if (candidates.length > 0) {
        // Cloud providers remain — append locals as fallbacks
        candidates.push(...demoted);
      } else {
        // ALL candidates were local — restore them (better than nothing)
        candidates.push(...demoted);
      }
    }

    if (candidates.length === 0) {
      const allSkipped = [
        ...skipped.map(s => `${s.id}: ${s.reason}`),
        ...chain.filter(e => !this.chatProviders.has(e.id)).map(e => `${e.id}: no chat provider`),
        ...chain.filter(e => this._conversationFailures.has(e.id)).map(e => `${e.id}: timed out in conversation`)
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

        // Record per-call audit with CostTracker
        if (this.costTracker) {
          const model = providerObj.model || providerId;
          this.costTracker.record({
            model,
            provider: providerId,
            job,
            trigger: params.trigger || 'user_message',
            inputTokens: result._inputTokens || 0,
            outputTokens: result._outputTokens || 0,
            cacheCreationTokens: result._cacheCreationTokens || 0,
            cacheReadTokens: result._cacheReadTokens || 0,
            isLocal,
          });
        }

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

        // Conversation-level circuit breaker: if this was a timeout,
        // skip this provider for the rest of the conversation.
        // Prevents 4× 5-minute waits in multi-iteration AgentLoop.
        const msg = (err.message || '').toLowerCase();
        if (msg.includes('timed out') || msg.includes('timeout') || msg.includes('aborted')) {
          this._conversationFailures.add(providerId);
          this.logger.warn(`[RouterChatBridge] ${providerId} timed out — skipping for rest of conversation`);
        } else {
          this.logger.warn(`[RouterChatBridge] ${providerId} failed: ${err.message}, trying next...`);
        }
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
