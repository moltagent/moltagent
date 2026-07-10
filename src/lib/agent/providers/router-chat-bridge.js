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
   * @param {Object} [options.modelResolver] - ModelResolver: the single source of
   *   truth for the per-job model and trust level. When present, the bridge runs
   *   the resolved model on local providers, logs the resolved model to
   *   CostTracker, and enforces `trust: local-only` at this execution chokepoint.
   * @param {Object} [options.modelScorecard] - ModelScorecard (maturation loop).
   *   The bridge records the LLM-call-level failure signal (timeout/error is
   *   model-attributable and only this chokepoint knows which model ran);
   *   envelope-level outcomes are recorded by AgentLoop from _routing.model.
   * @param {Object} [options.judgeQueue] - JudgeQueue (Session 4). Judged jobs
   *   (writing/thinking) have no mechanical signal, so their responses are
   *   retained here for the heartbeat-idle judge. This is the one place the
   *   concrete model, the job, and the response content are simultaneously in
   *   scope — the same custody point that computes _routing.model. Capture is
   *   an append into a bounded judge-then-delete store; no judging happens on
   *   the request path.
   * @param {Function} [options.getLanguage] - () => cockpit language code.
   *   Snapshotted per sample at production time — language is bound to the
   *   response here or nowhere.
   */
  constructor({ router, chatProviders, logger, defaultJob, costTracker, modelResolver, modelScorecard, judgeQueue, getLanguage } = {}) {
    if (!router) throw new Error('RouterChatBridge requires a router instance');
    if (!chatProviders || chatProviders.size === 0) {
      throw new Error('RouterChatBridge requires at least one chatProvider');
    }

    this.router = router;
    this.chatProviders = chatProviders;
    this.logger = logger || console;
    this.defaultJob = defaultJob || 'tools';
    this.costTracker = costTracker || null;
    this.modelResolver = modelResolver || null;
    this.modelScorecard = modelScorecard || null;
    this.judgeQueue = judgeQueue || null;
    this.getLanguage = typeof getLanguage === 'function' ? getLanguage : null;

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
   * The task a judged sample answered: the most recent user-role message.
   * Structural extraction (role field), not content inspection.
   * @private
   * @param {Object} params - chat() params
   * @returns {string|null}
   */
  _lastUserPrompt(params) {
    const msgs = Array.isArray(params.messages) ? params.messages : [];
    for (let i = msgs.length - 1; i >= 0; i--) {
      const m = msgs[i];
      if (m && m.role === 'user' && typeof m.content === 'string' && m.content) return m.content;
    }
    return null;
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
   * @param {string} [params.cloudTier] - Cloud tier: 'fast' (Haiku/Sonnet only) or null (smart-mix)
   * @param {string} [params.job] - Job hint (quick, tools, thinking, etc.)
   * @returns {Promise<{content: string|null, toolCalls: Array|null, _routing: Object}>}
   */
  async chat(params) {
    const job = params.job || this.defaultJob;
    let forceLocal = !!params.forceLocal;
    let allowCloud = !!params.allowCloud;
    const cloudTier = params.cloudTier || null;

    // Resolve the model + trust for this job once. This is the phenotype: every
    // downstream read (which model to run, what to log, whether cloud is allowed)
    // comes from here, never from a raw config source.
    const resolved = this.modelResolver ? this.modelResolver.resolve(job) : null;

    // Trust boundary is the single control (dev rule 3) and guards belong where
    // the pipe narrows (dev rule 5): this is the chokepoint every conversational
    // call converges on, so enforcing local-only here covers all paths AND the
    // boot window — not just the eventually-consistent heartbeat roster. trust
    // can only narrow: a per-call allowCloud must not widen past local-only.
    if (resolved && resolved.trust === 'local-only') {
      if (allowCloud || !forceLocal) {
        this.logger.info(`[RouterChatBridge] Trust local-only — forcing local for job ${job}`);
      }
      forceLocal = true;
      allowCloud = false;
    }

    // 1. Get chain from router
    const { chain, skipped } = this.router.buildProviderChain(job, { forceLocal, allowCloud, cloudTier });

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

      // For local providers, run the resolver's model for this job — the
      // canonical per-job pick (ModelScout's discovery, else the deployer/env
      // config), not the provider's static OLLAMA_MODEL default. Resolved
      // per-candidate rather than by mutating shared params, so a cloud fallback
      // never inherits a local model name.
      const localModel = (isLocal && resolved && resolved.model) ? resolved.model : null;
      const callParams = localModel ? { ...params, model: localModel } : params;

      try {
        const result = await chatProvider.chat(callParams);

        // Record success with router
        this.router.recordOutcome(providerId, {
          success: true,
          cost: result._cost || 0,
          tokens: result._tokens || 0,
          inputTokens: result._inputTokens || 0,
          outputTokens: result._outputTokens || 0,
          headers: result._headers || null
        });

        // Record per-call audit with CostTracker. The model logged is the one
        // that ACTUALLY ran: the resolved model for local calls, the cloud
        // provider's model otherwise. The cost line must never advertise a model
        // the request never used (the chimerism this whole change fixes).
        if (this.costTracker) {
          const model = localModel || providerObj.model || providerId;
          this.costTracker.record({
            model,
            source: (localModel && resolved) ? resolved.source : null,
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

        // Attach _routing metadata (FallbackNotifier compatible). `model` is
        // the concrete model that actually ran — computed once here, where the
        // identity is known, and carried on the response so downstream outcome
        // observers (AgentLoop's maturation-loop samples) never re-derive it.
        result._routing = {
          isFallback,
          primaryIsLocal,
          fallbackIsLocal: isLocal,
          player: isFallback ? 'fallback' : 'primary',
          provider: providerId,
          model: localModel || providerObj.model || null,
          job,
          failoverPath: failoverPath.length > 0 ? [...failoverPath] : undefined
        };

        // Session 4: retain judged-job samples for the heartbeat-idle judge.
        // The queue itself gates on judged jobs (writing/thinking) and drops
        // anything unattributable, so this is a plain hand-off; it must never
        // break the request path.
        if (this.judgeQueue && result.content) {
          try {
            this.judgeQueue.enqueue({
              job,
              model: localModel || providerObj.model || null,
              provider: providerId,
              isLocal,
              language: this.getLanguage ? this.getLanguage() : null,
              prompt: this._lastUserPrompt(params),
              response: result.content,
            });
          } catch (_e) { /* capture is best-effort */ }
        }

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
        errors.push({ provider: providerId, error: err.message, status: err.status, cause: err });
        failoverPath.push(providerId);

        // Record failure with router
        this.router.recordOutcome(providerId, {
          success: false,
          error: err
        });

        // Maturation loop: a timeout/error is a mechanical failure of the
        // (job, model) pairing, and this catch is the only place the model
        // that failed is known. Envelope-level outcomes (valid tool call,
        // hallucinated tool) are recorded by the loop's caller instead —
        // one sample per LLM call either way.
        if (this.modelScorecard && job === 'tools') {
          const failedModel = localModel || providerObj.model || null;
          if (failedModel) {
            this.modelScorecard.recordSample('tools', failedModel, null, false);
          }
        }

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
    // The last provider error is the root cause of this exhaustion. Carrying it
    // on `.cause` lets ErrorHandler.classify() name the real category (TIMEOUT,
    // NETWORK) instead of falling back to INTERNAL on the wrapper's message.
    const lastCause = errors[errors.length - 1]?.cause || null;
    const chainedErr = new Error(
      `All providers exhausted for job ${job}. Tried: ${failoverPath.join(' → ')}` +
      (lastCause ? `. Last error: ${lastCause.message}` : '')
    );
    if (lastCause) chainedErr.cause = lastCause;
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
