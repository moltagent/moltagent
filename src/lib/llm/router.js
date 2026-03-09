/**
 * MoltAgent LLM Router
 *
 * Routes requests to appropriate providers based on roles.
 * Implements failover chain with rate limit and budget awareness.
 *
 * Roles:
 * - sovereign: Local execution, data never leaves infrastructure
 * - free: Zero marginal cost, for high-volume routine tasks
 * - value: Good quality, low cost - the workhorse tier
 * - premium: Best available quality, for critical tasks only
 * - specialized: Task-specific capabilities
 *
 * @module llm/router
 * @version 2.0.0
 */

const { createProvider } = require('./providers');
const RateLimitTracker = require('./rate-limit-tracker');
const BudgetEnforcer = require('./budget-enforcer');
const BackoffStrategy = require('./backoff-strategy');
const CircuitBreaker = require('./circuit-breaker');
const LoopDetector = require('./loop-detector');
const OutputVerifier = require('../output-verifier');
const appConfig = require('../config');

const JOBS = Object.freeze({
  QUICK: 'quick',
  TOOLS: 'tools',
  THINKING: 'thinking',
  WRITING: 'writing',
  RESEARCH: 'research',
  CODING: 'coding',
  CREDENTIALS: 'credentials',
  SYNTHESIS: 'synthesis',
});
const VALID_JOBS = new Set(Object.values(JOBS));
const PRESET_NAMES = Object.freeze(['all-local', 'smart-mix', 'cloud-first']);

class LLMRouter {
  /**
   * @param {Object} config
   * @param {Object} config.providers - Provider configurations
   * @param {Object} config.roles - Role to provider mappings
   * @param {Object} [config.fallbackChain] - Fallback chains per provider
   * @param {Object} [config.budgets] - Budget limits per provider
   * @param {Function} [config.getCredential] - Credential broker function
   * @param {Function} [config.auditLog] - Audit logging function
   * @param {Function} [config.notifyUser] - User notification function
   */
  constructor(config = {}) {
    this.config = config;
    this.auditLog = config.auditLog || (async () => {});
    this.notifyUser = config.notifyUser || (async () => {});
    this.getCredential = config.getCredential || (async () => null);

    // Initialize providers
    this.providers = new Map();
    this._initializeProviders(config.providers || {});

    // Role mappings (provider IDs in preference order)
    this.roles = config.roles || {
      sovereign: ['ollama-local'],
      free: ['ollama-local'],
      value: ['ollama-local'],
      premium: ['ollama-local']
    };

    // Fallback chains
    this.fallbackChain = config.fallbackChain || {};

    // Rate limit tracker
    this.rateLimits = new RateLimitTracker();

    // Budget enforcer
    this.budget = new BudgetEnforcer({
      budgets: config.budgets || {},
      proactiveDailyBudget: config.proactiveDailyBudget || 0,
      onWarning: (info) => this._handleBudgetWarning(info),
      onExhausted: (info) => this._handleBudgetExhausted(info)
    });

    // Backoff strategy
    this.backoff = new BackoffStrategy(config.backoff || {});

    // Circuit breaker
    this.circuitBreaker = new CircuitBreaker({
      failureThreshold: config.circuitBreaker?.failureThreshold || appConfig.llm.circuitBreakerThreshold,
      resetTimeoutMs: config.circuitBreaker?.resetTimeoutMs || appConfig.llm.circuitBreakerResetMs,
      successThreshold: config.circuitBreaker?.successThreshold || appConfig.llm.circuitBreakerSuccessThreshold,
      onStateChange: (info) => this._handleCircuitStateChange(info),
      onReject: (info) => this._handleCircuitReject(info)
    });

    // Loop detector
    this.loopDetector = new LoopDetector({
      maxConsecutiveErrors: config.loopDetector?.maxConsecutiveErrors || appConfig.llm.loopDetectorMaxErrors,
      maxSameCall: config.loopDetector?.maxSameCall || appConfig.llm.loopDetectorMaxSame,
      historyWindowMs: config.loopDetector?.historyWindowMs || appConfig.llm.loopDetectorWindow,
      pingPongThreshold: config.loopDetector?.pingPongThreshold || appConfig.llm.loopDetectorPingPongThreshold,
      onLoopDetected: (info) => this._handleLoopDetected(info)
    });

    // CostTracker (optional, set post-construction)
    this.costTracker = null;

    // Output verifier
    this.outputVerifier = new OutputVerifier({
      auditLog: this.auditLog,
      strictMode: config.outputVerifier?.strictMode || false,
      allowedDomains: config.outputVerifier?.allowedDomains || [],
      customPatterns: config.outputVerifier?.customPatterns || []
    });

    // Active tier (set by Cockpit, consumed by _buildChain)
    this._activeTier = 'balanced';

    // Job-based roster (null = legacy mode, activated by setPreset/setRoster)
    this._roster = null;
    this._activePreset = null;

    // Stats
    this.stats = {
      totalCalls: 0,
      successfulCalls: 0,
      failovers: 0,
      errors: 0,
      byProvider: {},
      byRole: {}
    };
  }

  /**
   * Initialize provider instances from config
   * @private
   */
  _initializeProviders(providersConfig) {
    for (const [id, providerConfig] of Object.entries(providersConfig)) {
      try {
        const adapter = providerConfig.adapter || 'ollama';

        // Create credential getter for this provider
        const credentialName = providerConfig.credentialName;
        const getCredential = credentialName
          ? () => this.getCredential(credentialName)
          : async () => null;

        const provider = createProvider(adapter, {
          id,
          ...providerConfig,
          getCredential
        });

        this.providers.set(id, provider);
      } catch (error) {
        console.error(`[LLMRouter] Failed to initialize provider ${id}: ${error.message}`);
      }
    }
  }

  /**
   * Route a request to appropriate provider
   *
   * @param {Object} request
   * @param {string} request.task - Task type
   * @param {string} request.content - Content to process
   * @param {Object} [request.requirements] - Requirements
   * @param {string} [request.requirements.role='value'] - Role to use
   * @param {string} [request.requirements.quality] - Quality hint
   * @param {number} [request.requirements.maxTokens] - Max tokens
   * @returns {Promise<Object>} - { result, provider, tokens, cost, failoverPath }
   */
  async route(request) {
    const startTime = Date.now();
    this.stats.totalCalls++;

    // Normalize request
    const { task, content, requirements = {}, context = {} } = request;
    const role = requirements.role || 'value';
    const options = {
      maxTokens: requirements.maxTokens,
      temperature: requirements.temperature,
      format: requirements.format
    };

    // Track role usage
    this.stats.byRole[role] = (this.stats.byRole[role] || 0) + 1;

    // Check proactive budget before attempting cloud providers
    const opType = this.budget.classifyOperation(context);
    const forceLocal = opType === 'proactive' && this.budget.isProactiveBudgetExhausted();

    // Build provider chain — roster mode or legacy mode
    let job = null;
    let chain;

    if (request.job && this._roster) {
      // New-style: route({ job: 'quick', content: '...' })
      job = VALID_JOBS.has(request.job) ? request.job : JOBS.QUICK;
      chain = this._buildRosterChain(job, { forceLocal });
    } else if (this._roster) {
      // Legacy call with active roster: map task+role → job
      job = this._mapLegacyTask(task, role);
      chain = this._buildRosterChain(job, { forceLocal });
    } else {
      // Pure legacy: no roster active
      chain = this._buildChain(role);

      if (forceLocal) {
        chain = chain.filter(id => {
          const p = this.providers.get(id);
          return p && p.type === 'local';
        });
        if (chain.length === 0) {
          throw new Error('Proactive budget exhausted and no local providers available');
        }
      }
    }

    // Track job usage
    if (job) {
      this.stats.byJob = this.stats.byJob || {};
      this.stats.byJob[job] = (this.stats.byJob[job] || 0) + 1;
    }

    if (chain.length === 0) {
      const label = job ? `job: ${job}` : `role: ${role}`;
      throw new Error(`No providers available for ${label}`);
    }

    const errors = [];
    const failoverPath = [];

    // Check for loop before attempting any provider
    const callSignature = { type: 'llm', action: task, params: { role, contentHash: this._hashContent(content) } };
    const loopCheck = this.loopDetector.checkForLoop(callSignature);
    if (loopCheck.blocked) {
      this.stats.errors++;
      await this.auditLog('llm_loop_blocked', {
        task,
        role,
        loopType: loopCheck.type,
        reason: loopCheck.reason
      });
      throw new Error(`Loop detected: ${loopCheck.reason}`);
    }

    // Record this call attempt
    this.loopDetector.recordCall(callSignature);

    // Try each provider in the chain
    for (const providerId of chain) {
      const provider = this.providers.get(providerId);

      if (!provider) {
        errors.push({ provider: providerId, error: 'Provider not found' });
        continue;
      }

      // Check circuit breaker
      const circuitCheck = this.circuitBreaker.canRequest(providerId);
      if (!circuitCheck.allowed) {
        errors.push({ provider: providerId, error: 'Circuit open', state: circuitCheck.state, retryAt: circuitCheck.retryAt });
        failoverPath.push(providerId);
        continue;
      }

      // Check backoff
      const backoffCheck = this.backoff.shouldWait(providerId);
      if (backoffCheck.shouldWait) {
        errors.push({ provider: providerId, error: 'In backoff', retryAt: backoffCheck.nextRetry });
        failoverPath.push(providerId);
        continue;
      }

      // Check rate limits
      const estimatedTokens = provider.estimateTokens(content) + (options.maxTokens || 500);
      const rateLimitCheck = this.rateLimits.canRequest(providerId, estimatedTokens);

      if (!rateLimitCheck.allowed) {
        errors.push({ provider: providerId, error: rateLimitCheck.reason });
        failoverPath.push(providerId);
        continue;
      }

      // Check budget
      const estimatedCost = provider.estimateCost(estimatedTokens * 0.3, estimatedTokens * 0.7);
      const budgetCheck = this.budget.canSpend(providerId, estimatedCost);

      if (!budgetCheck.allowed) {
        errors.push({ provider: providerId, error: budgetCheck.reason });
        failoverPath.push(providerId);
        continue;
      }

      // Try the provider
      try {
        const result = await provider.generate(task, content, options);

        // Success! Update tracking
        this.backoff.reset(providerId);
        this.rateLimits.clearRetryAfter(providerId);
        this.circuitBreaker.recordSuccess(providerId);
        this.loopDetector.resetErrorCount(callSignature);

        if (result.headers) {
          this.rateLimits.updateFromResponse(providerId, result.headers);
        }

        if (result.cost) {
          this.budget.recordSpend(providerId, result.cost, result.tokens);
          if (opType === 'proactive') {
            this.budget.recordProactiveSpend(result.cost, result.tokens);
          }
        }

        // Record per-call audit with CostTracker
        if (this.costTracker) {
          this.costTracker.record({
            model: result.model || providerId,
            provider: providerId,
            job: job || task || 'route',
            trigger: context.trigger || 'user_message',
            inputTokens: result.inputTokens || 0,
            outputTokens: result.outputTokens || 0,
            isLocal: provider.type === 'local',
          });
        }

        // Track stats
        this.stats.successfulCalls++;
        this.stats.byProvider[providerId] = (this.stats.byProvider[providerId] || 0) + 1;

        if (failoverPath.length > 0) {
          this.stats.failovers++;
        }

        // Verify output before returning
        const verifyResult = await this.outputVerifier.verify(result.result, { task, role, provider: providerId });
        if (!verifyResult.safe) {
          // Output blocked - log and treat as error
          await this.auditLog('llm_output_blocked', {
            task,
            role,
            provider: providerId,
            blocked: verifyResult.blocked,
            outputLength: result.result?.length
          });

          // Notify user
          await this.notifyUser({
            type: 'output_blocked',
            provider: providerId,
            reason: verifyResult.blocked.description,
            category: verifyResult.blocked.category
          });

          // Don't return blocked output - throw error to try next provider or fail
          throw new Error(`Output blocked: ${verifyResult.blocked.description}`);
        }

        // Log warnings if any
        if (verifyResult.warnings && verifyResult.warnings.length > 0) {
          await this.auditLog('llm_output_warnings', {
            task,
            role,
            provider: providerId,
            warnings: verifyResult.warnings
          });
        }

        // Audit log
        await this.auditLog('llm_call', {
          task,
          role,
          provider: providerId,
          model: result.model,
          tokens: result.tokens,
          cost: result.cost,
          duration: Date.now() - startTime,
          failoverPath: failoverPath.length > 0 ? failoverPath : undefined,
          outputVerified: true,
          outputWarnings: verifyResult.warnings?.length || 0
        });

        return {
          result: result.result,
          provider: providerId,
          model: result.model,
          tokens: result.tokens,
          inputTokens: result.inputTokens,
          outputTokens: result.outputTokens,
          cost: result.cost,
          duration: result.duration,
          failoverPath: failoverPath.length > 0 ? failoverPath : undefined,
          verified: true,
          warnings: verifyResult.warnings
        };

      } catch (error) {
        errors.push({ provider: providerId, error: error.message, status: error.status });
        failoverPath.push(providerId);

        // Record failure with circuit breaker
        this.circuitBreaker.recordFailure(providerId, error);

        // Record error with loop detector
        const loopResult = this.loopDetector.recordError(callSignature, error);
        if (loopResult.loopDetected) {
          await this.auditLog('llm_error_loop', {
            task,
            role,
            provider: providerId,
            errorCount: loopResult.count,
            lastError: loopResult.lastError
          });
        }

        // Handle rate limit errors
        if (this._isRateLimitError(error)) {
          const backoffResult = this.backoff.handleRateLimit(providerId, error);
          this.rateLimits.markRateLimited(providerId, backoffResult.delayMs / 1000);

          // Notify user on failover
          if (failoverPath.length === 1) {
            await this.notifyUser({
              type: 'rate_limit',
              provider: providerId,
              fallback: chain[chain.indexOf(providerId) + 1] || 'none',
              retryAt: new Date(backoffResult.nextRetry).toISOString()
            });
          }

          continue; // Try next provider
        }

        // Handle transient errors with brief retry
        if (this._isTransientError(error)) {
          await this._sleep(1000);
          try {
            const retryResult = await provider.generate(task, content, options);
            return {
              result: retryResult.result,
              provider: providerId,
              model: retryResult.model,
              tokens: retryResult.tokens,
              cost: retryResult.cost,
              duration: Date.now() - startTime,
              failoverPath,
              retried: true
            };
          } catch {
            continue; // Retry failed, try next provider
          }
        }

        // Permanent errors don't benefit from failover
        if (this._isPermanentError(error)) {
          this.stats.errors++;
          await this.auditLog('llm_error', {
            task,
            role,
            provider: providerId,
            error: error.message,
            status: error.status,
            permanent: true
          });
          throw error;
        }

        continue; // Unknown error, try next
      }
    }

    // All providers exhausted
    this.stats.errors++;

    await this.auditLog('llm_all_exhausted', {
      task,
      role,
      attempted: failoverPath,
      errors
    });

    // Notify user
    await this.notifyUser({
      type: 'all_exhausted',
      attempted: failoverPath,
      errors: errors.map(e => `${e.provider}: ${e.error}`),
      nextAvailable: this._findNextAvailable(chain)
    });

    const label = job ? `job ${job}` : `role ${role}`;
    throw new Error(`All providers exhausted for ${label}. Tried: ${failoverPath.join(' -> ')}`);
  }

  /**
   * Build provider chain for a role
   * @private
   */
  _buildChain(role) {
    const chain = [];

    // Start with providers assigned to this role
    const roleProviders = this.roles[role] || [];
    chain.push(...roleProviders);

    // Add fallback chains
    for (const providerId of roleProviders) {
      const fallbacks = this.fallbackChain[providerId] || [];
      for (const fb of fallbacks) {
        if (!chain.includes(fb)) {
          chain.push(fb);
        }
      }
    }

    // Always end with local providers (guaranteed to work)
    for (const [id, provider] of this.providers) {
      if (provider.type === 'local' && !chain.includes(id)) {
        chain.push(id);
      }
    }

    // Tier gate: when 'local-only' and role is not sovereign, keep only local providers
    if (this._activeTier === 'local-only' && role !== 'sovereign') {
      return chain.filter(id => {
        const p = this.providers.get(id);
        return p && p.type === 'local';
      });
    }

    return chain;
  }

  /**
   * Resolve first local provider ID.
   * @private
   * @returns {string|null}
   */
  _resolveLocalDefault() {
    for (const [id, provider] of this.providers) {
      if (provider.type === 'local') return id;
    }
    return null;
  }

  /**
   * Resolve primary cloud provider ID.
   * Priority: anthropic-claude > first non-local.
   * @private
   * @returns {string|null}
   */
  _resolveCloudPrimary() {
    if (this.providers.has('anthropic-claude') && this.providers.get('anthropic-claude').type !== 'local') {
      return 'anthropic-claude';
    }
    for (const [id, provider] of this.providers) {
      if (provider.type !== 'local') return id;
    }
    return null;
  }

  /**
   * Build a roster object from a preset name.
   * @private
   * @param {string} presetName - 'all-local' | 'smart-mix' | 'cloud-first'
   * @returns {Object} job → provider-ID chain map
   */
  _resolvePreset(presetName) {
    const localIds = [];
    const cloudIds = [];
    for (const [id, provider] of this.providers) {
      if (provider.type === 'local') localIds.push(id);
      else cloudIds.push(id);
    }

    const roster = {};

    if (presetName === 'all-local') {
      // Sort local providers: ollama-fast first for QUICK chain speed
      const fastFirstLocal = [...localIds].sort((a, b) => {
        if (a.includes('-fast')) return -1;
        if (b.includes('-fast')) return 1;
        return 0;
      });
      for (const job of VALID_JOBS) {
        roster[job] = job === JOBS.QUICK ? [...fastFirstLocal] : [...localIds];
      }
    } else if (presetName === 'smart-mix') {
      // 3-tier routing: heavy (most expensive cloud) for depth,
      // workhorse (cheaper cloud) for volume, local as fallback.
      // With 1 cloud provider, heavy === workhorse (backward-compatible).
      // Additional cloud providers (3+) become late-chain fallbacks before local.
      const { heavy, workhorse, rest } = this._classifyCloudProviders(cloudIds);

      // Sort local providers: ollama-fast first for QUICK chain speed
      const fastFirst = [...localIds].sort((a, b) => {
        if (a.includes('-fast')) return -1;
        if (b.includes('-fast')) return 1;
        return 0;
      });

      for (const job of VALID_JOBS) {
        if (job === JOBS.QUICK) {
          // Classification/synthesis: fast local first (qwen2.5:3b ~420ms), then other local, then cloud
          roster[job] = [...new Set([...fastFirst, workhorse, ...rest].filter(Boolean))];
        } else if (job === JOBS.TOOLS) {
          // Extraction/tools: workhorse cloud first (Sonnet handles structured output well), local fallback
          roster[job] = [...new Set([workhorse, ...rest, ...localIds].filter(Boolean))];
        } else if (job === JOBS.THINKING || job === JOBS.WRITING || job === JOBS.CODING) {
          // Deep/complex work: heavy cloud first, workhorse fallback, rest, local last
          roster[job] = [...new Set([heavy, workhorse, ...rest, ...localIds].filter(Boolean))];
        } else if (job === JOBS.RESEARCH) {
          // Research: workhorse cloud first, rest, local last (no heavy — cost-efficient)
          roster[job] = [...new Set([workhorse, ...rest, ...localIds].filter(Boolean))];
        }
      }
    } else if (presetName === 'cloud-first') {
      for (const job of VALID_JOBS) {
        roster[job] = [...cloudIds, ...localIds];
      }
    }

    // credentials: prefer credential-specific local provider, then all other local
    const credLocalIds = localIds.filter(id => id.includes('-credential'));
    const otherLocalIds = localIds.filter(id => !id.includes('-credential'));
    roster[JOBS.CREDENTIALS] = [...credLocalIds, ...otherLocalIds];

    return roster;
  }

  /**
   * Classify cloud providers into heavy (most expensive, for depth),
   * workhorse (cheaper, for volume), and rest (additional fallbacks).
   * With only one cloud provider, both roles point to the same ID.
   * @private
   * @param {string[]} cloudIds
   * @returns {{ heavy: string|null, workhorse: string|null, rest: string[] }}
   */
  _classifyCloudProviders(cloudIds) {
    if (cloudIds.length === 0) return { heavy: null, workhorse: null, rest: [] };
    if (cloudIds.length === 1) return { heavy: cloudIds[0], workhorse: cloudIds[0], rest: [] };

    // Sort by output cost descending — most expensive = heavy
    const sorted = [...cloudIds].sort((a, b) => {
      const costA = this.providers.get(a)?.costModel?.outputPer1M || 0;
      const costB = this.providers.get(b)?.costModel?.outputPer1M || 0;
      return costB - costA;
    });

    return { heavy: sorted[0], workhorse: sorted[1], rest: sorted.slice(2) };
  }

  /**
   * Map legacy task+role to a job name.
   * @private
   * @param {string} task
   * @param {string} role
   * @returns {string} job name
   */
  _mapLegacyTask(task, role) {
    if (role === 'sovereign') return JOBS.CREDENTIALS;

    const taskMap = {
      chat: JOBS.QUICK,
      classify: JOBS.QUICK,
      email_summarize: JOBS.QUICK,
      session_summary: JOBS.QUICK,
      email_parse: JOBS.TOOLS,
      calendar_parse: JOBS.TOOLS,
      email_analyze: JOBS.TOOLS,
      email_draft: JOBS.WRITING,
      email_reply: JOBS.WRITING,
      writing: JOBS.WRITING,
      research: JOBS.RESEARCH,
      meeting_prep: JOBS.RESEARCH,
      admin: JOBS.THINKING,
      generic: JOBS.THINKING,
      followup: JOBS.THINKING,
    };

    return taskMap[task] || JOBS.THINKING;
  }

  /**
   * Build provider chain from the active roster for a given job.
   * @private
   * @param {string} job
   * @param {Object} [options]
   * @param {boolean} [options.forceLocal=false]
   * @returns {string[]}
   */
  _buildRosterChain(job, options = {}) {
    // credentials job → only local providers (enforced)
    if (job === JOBS.CREDENTIALS) {
      const chain = (this._roster[JOBS.CREDENTIALS] || []).filter(id => {
        const p = this.providers.get(id);
        return p && p.type === 'local';
      });
      return [...new Set(chain)];
    }

    let chain = [...(this._roster[job] || this._roster[JOBS.QUICK] || [])];

    if (options.forceLocal) {
      chain = chain.filter(id => {
        const p = this.providers.get(id);
        return p && p.type === 'local';
      });
    }

    // Last-local rule: ensure chain ends with a local provider
    const localDefault = this._resolveLocalDefault();
    if (localDefault && chain.length > 0) {
      const lastId = chain[chain.length - 1];
      const lastProvider = this.providers.get(lastId);
      if (!lastProvider || lastProvider.type !== 'local') {
        chain.push(localDefault);
      }
    }

    return [...new Set(chain)];
  }

  /**
   * Find when next provider will be available
   * @private
   */
  _findNextAvailable(chain) {
    let earliestAvailable = Infinity;

    for (const providerId of chain) {
      const availability = this.rateLimits.predictAvailability(providerId);
      if (availability.available) {
        return new Date().toISOString();
      }
      if (availability.retryAt && availability.retryAt < earliestAvailable) {
        earliestAvailable = availability.retryAt;
      }
    }

    return earliestAvailable < Infinity
      ? new Date(earliestAvailable).toISOString()
      : 'unknown';
  }

  _isRateLimitError(error) {
    return error.status === 429 ||
      error.code === 'rate_limit_exceeded' ||
      error.message?.toLowerCase().includes('rate limit');
  }

  _isTransientError(error) {
    return [500, 502, 503, 504].includes(error.status) ||
      error.code === 'overloaded';
  }

  _isPermanentError(error) {
    return [400, 401, 403, 404].includes(error.status);
  }

  _sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  async _handleBudgetWarning(info) {
    await this.notifyUser({
      type: 'budget_warning',
      provider: info.providerId,
      spent: info.spent.toFixed(2),
      budget: info.budget.toFixed(2),
      percent: info.percentUsed.toFixed(1)
    });
  }

  async _handleBudgetExhausted(info) {
    await this.notifyUser({
      type: 'budget_exhausted',
      provider: info.providerId,
      spent: info.spent.toFixed(2),
      budget: info.budget.toFixed(2),
      resetAt: info.resetAt.toISOString()
    });
  }

  async _handleCircuitStateChange(info) {
    await this.auditLog('circuit_state_change', {
      provider: info.providerId,
      oldState: info.oldState,
      newState: info.newState,
      failures: info.failures,
      lastError: info.lastError
    });

    if (info.newState === 'open') {
      await this.notifyUser({
        type: 'circuit_opened',
        provider: info.providerId,
        failures: info.failures,
        lastError: info.lastError
      });
    }
  }

  async _handleCircuitReject(info) {
    await this.auditLog('circuit_rejected', {
      provider: info.providerId,
      error: info.error?.message
    });
  }

  async _handleLoopDetected(info) {
    await this.auditLog('loop_detected', {
      type: info.type,
      reason: info.reason,
      suggestion: info.suggestion,
      pattern: info.pattern
    });

    await this.notifyUser({
      type: 'loop_detected',
      loopType: info.type,
      reason: info.reason,
      suggestion: info.suggestion
    });
  }

  /**
   * Create a simple hash of content for loop detection
   * @private
   */
  _hashContent(content) {
    if (!content) return 'empty';
    const str = typeof content === 'string' ? content : JSON.stringify(content);
    // Simple hash - just use first 100 chars + length for quick comparison
    return `${str.substring(0, 100)}:${str.length}`;
  }

  /**
   * Test connectivity to all providers
   * @returns {Promise<Object>}
   */
  async testConnections() {
    const results = {};

    for (const [id, provider] of this.providers) {
      try {
        results[id] = await provider.testConnection();
      } catch (error) {
        results[id] = { connected: false, error: error.message };
      }
    }

    return results;
  }

  /**
   * Get router statistics
   * @returns {Object}
   */
  getStats() {
    return {
      ...this.stats,
      rateLimits: this.rateLimits.getSummary(),
      budget: this.budget.getFullReport(),
      backoff: this.backoff.getSummary(),
      circuitBreaker: this.circuitBreaker.getSummary(),
      loopDetector: this.loopDetector.getSummary(),
      outputVerifier: this.outputVerifier.getStats(),
      roster: this.getRoster(),
      activePreset: this._activePreset,
      routingMode: this._roster ? 'roster' : 'legacy'
    };
  }

  /**
   * Get available roles
   * @returns {string[]}
   */
  getAvailableRoles() {
    return Object.keys(this.roles);
  }

  /**
   * Get providers for a role
   * @param {string} role
   * @returns {string[]}
   */
  getProvidersForRole(role) {
    return this._buildChain(role);
  }

  /**
   * Set the active LLM tier from Cockpit.
   * Affects _buildChain(): when 'local-only', non-sovereign roles
   * are restricted to local providers only.
   * @param {string} tier - 'local-only' | 'balanced' | 'premium'
   */
  setTier(tier) {
    const valid = ['local-only', 'balanced', 'premium'];
    if (valid.includes(tier) && tier !== this._activeTier) {
      console.log(`[LLMRouter] Tier changed: ${this._activeTier} -> ${tier}`);
      this._activeTier = tier;

      // Sync roster if active
      if (this._roster) {
        const tierToPreset = { 'local-only': 'all-local', 'balanced': 'smart-mix', 'premium': 'cloud-first' };
        if (tierToPreset[tier]) this.setPreset(tierToPreset[tier]);
      }
    }
  }

  /**
   * Get the current active tier.
   * @returns {string}
   */
  getTier() {
    return this._activeTier;
  }

  /**
   * Activate a preset roster configuration.
   * @param {string} presetName - 'all-local' | 'smart-mix' | 'cloud-first'
   */
  setPreset(presetName) {
    if (!PRESET_NAMES.includes(presetName)) {
      console.log(`[LLMRouter] Invalid preset: ${presetName}. Valid: ${PRESET_NAMES.join(', ')}`);
      return;
    }
    this._roster = this._resolvePreset(presetName);
    this._activePreset = presetName;
    console.log(`[LLMRouter] Preset activated: ${presetName}`);
  }

  /**
   * Set a custom roster (job → provider chain map).
   * Merges with smart-mix defaults so missing jobs get chains.
   * @param {Object} roster - job → string[] map
   */
  setRoster(roster) {
    // Start with smart-mix as base
    const base = this._resolvePreset('smart-mix');

    for (const [job, chain] of Object.entries(roster)) {
      // Accept any job name except credentials (which is always local-only)
      // This allows future job types (images, video, music) from the Models card
      if (job === JOBS.CREDENTIALS) continue;
      // Filter to known provider IDs
      const validChain = chain.filter(id => this.providers.has(id));
      if (validChain.length > 0) {
        base[job] = validChain;
      }
    }

    this._roster = base;
    this._activePreset = null;
    console.log('[LLMRouter] Custom roster activated');
  }

  /**
   * Get a copy of the active roster, or null if in legacy mode.
   * @returns {Object|null}
   */
  getRoster() {
    if (!this._roster) return null;
    const copy = {};
    for (const [job, chain] of Object.entries(this._roster)) {
      copy[job] = [...chain];
    }
    return copy;
  }

  /**
   * Get the active preset name, or null if custom/legacy.
   * @returns {string|null}
   */
  getPreset() {
    return this._activePreset || null;
  }

  /**
   * Dynamically register a new provider (e.g., from Cockpit Models card).
   * @param {string} id - Provider ID (e.g., 'perplexity-sonar-pro')
   * @param {Object} providerConfig - Config for createProvider()
   * @param {string} providerConfig.adapter - Adapter type (e.g., 'perplexity', 'openai-compatible')
   * @param {string} providerConfig.endpoint - API endpoint
   * @param {string} providerConfig.model - Model name
   * @param {string} [providerConfig.credentialName] - Credential name
   * @param {Function} [providerConfig.getCredential] - Credential getter
   */
  registerProvider(id, providerConfig) {
    try {
      const adapter = providerConfig.adapter || 'openai-compatible';
      const credentialName = providerConfig.credentialName;
      const getCredential = providerConfig.getCredential || (
        credentialName ? () => this.getCredential(credentialName) : async () => null
      );

      const provider = createProvider(adapter, {
        id,
        ...providerConfig,
        getCredential
      });

      this.providers.set(id, provider);
      console.log(`[LLMRouter] Registered provider: ${id} (${adapter}, ${providerConfig.model})`);
    } catch (error) {
      console.error(`[LLMRouter] Failed to register provider ${id}: ${error.message}`);
      throw error;
    }
  }

  /**
   * Remove a dynamically registered provider.
   * @param {string} id - Provider ID
   */
  unregisterProvider(id) {
    if (this.providers.has(id)) {
      this.providers.delete(id);
      console.log(`[LLMRouter] Unregistered provider: ${id}`);
    }
  }

  /**
   * Get metadata for all registered providers.
   * @returns {Object} Map of id → { type, model, endpoint }
   */
  getRegisteredProviders() {
    const result = {};
    for (const [id, provider] of this.providers) {
      result[id] = {
        type: provider.type,
        model: provider.model,
        endpoint: provider.endpoint || null
      };
    }
    return result;
  }

  // ---------------------------------------------------------------------------
  // Public routing API for RouterChatBridge
  // ---------------------------------------------------------------------------

  /**
   * Build a provider chain with health checks, without executing a generate() call.
   * Exposes the router's chain-building + filtering logic for external callers
   * (e.g. RouterChatBridge) that handle their own execution.
   *
   * @param {string} job - Job classification (quick, tools, thinking, etc.)
   * @param {Object} [context={}]
   * @param {boolean} [context.forceLocal=false] - Restrict to local providers
   * @param {string} [context.opType] - Operation type for budget checks
   * @returns {{ chain: Array<{id: string, provider: Object}>, skipped: Array<{id: string, reason: string}> }}
   */
  buildProviderChain(job, context = {}) {
    // Check proactive budget → forceLocal
    const opType = context.opType || 'reactive';
    let forceLocal = !!context.forceLocal;
    if (opType === 'proactive' && this.budget.isProactiveBudgetExhausted()) {
      forceLocal = true;
    }

    // Build raw chain from roster or legacy
    let rawChain;
    if (this._roster) {
      rawChain = this._buildRosterChain(job, { forceLocal });

      // Unknown job with no roster entry — fall back to local providers
      if (!rawChain || rawChain.length === 0) {
        console.warn(`[LLMRouter] No roster entry for job '${job}'. Using local fallback.`);
        rawChain = [...this.providers.entries()]
          .filter(([, p]) => p.type === 'local')
          .map(([id]) => id);
      }
    } else {
      // Legacy mode: unknown jobs map to QUICK
      const role = this._jobToRole(VALID_JOBS.has(job) ? job : JOBS.QUICK);
      rawChain = this._buildChain(role);
      if (forceLocal) {
        rawChain = rawChain.filter(id => {
          const p = this.providers.get(id);
          return p && p.type === 'local';
        });
      }
    }

    // Filter through health checks
    const chain = [];
    const skipped = [];

    for (const providerId of rawChain) {
      const provider = this.providers.get(providerId);
      if (!provider) {
        skipped.push({ id: providerId, reason: 'provider not found' });
        continue;
      }

      // Circuit breaker
      const circuitCheck = this.circuitBreaker.canRequest(providerId);
      if (!circuitCheck.allowed) {
        skipped.push({ id: providerId, reason: `circuit open (${circuitCheck.state})` });
        continue;
      }

      // Backoff
      const backoffCheck = this.backoff.shouldWait(providerId);
      if (backoffCheck.shouldWait) {
        skipped.push({ id: providerId, reason: `in backoff until ${new Date(backoffCheck.nextRetry).toISOString()}` });
        continue;
      }

      // Rate limits (estimate with a moderate token count)
      const estimatedTokens = 1000;
      const rateLimitCheck = this.rateLimits.canRequest(providerId, estimatedTokens);
      if (!rateLimitCheck.allowed) {
        skipped.push({ id: providerId, reason: rateLimitCheck.reason });
        continue;
      }

      // Budget
      const estimatedCost = provider.estimateCost ? provider.estimateCost(300, 700) : 0;
      const budgetCheck = this.budget.canSpend(providerId, estimatedCost);
      if (!budgetCheck.allowed) {
        skipped.push({ id: providerId, reason: budgetCheck.reason });
        continue;
      }

      chain.push({ id: providerId, provider });
    }

    return { chain, skipped };
  }

  /**
   * Record outcome of an external call back into router subsystems.
   * Used by RouterChatBridge after executing a chat() call.
   *
   * @param {string} providerId - The router provider ID
   * @param {Object} outcome
   * @param {boolean} outcome.success - Whether the call succeeded
   * @param {Error} [outcome.error] - Error if failed
   * @param {number} [outcome.cost] - Cost in USD
   * @param {number} [outcome.tokens] - Total tokens used
   * @param {number} [outcome.inputTokens] - Input tokens
   * @param {number} [outcome.outputTokens] - Output tokens
   * @param {Object} [outcome.headers] - Response headers (for rate limit tracking)
   * @param {string} [outcome.opType] - 'proactive' | 'reactive'
   */
  recordOutcome(providerId, outcome = {}) {
    if (outcome.success) {
      this.backoff.reset(providerId);
      this.rateLimits.clearRetryAfter(providerId);
      this.circuitBreaker.recordSuccess(providerId);

      if (outcome.headers) {
        this.rateLimits.updateFromResponse(providerId, outcome.headers);
      }

      if (outcome.cost) {
        this.budget.recordSpend(providerId, outcome.cost, outcome.tokens);
        if (outcome.opType === 'proactive') {
          this.budget.recordProactiveSpend(outcome.cost, outcome.tokens);
        }
      }

      // Track stats
      this.stats.successfulCalls++;
      this.stats.byProvider[providerId] = (this.stats.byProvider[providerId] || 0) + 1;
    } else {
      const error = outcome.error || new Error('unknown');
      this.circuitBreaker.recordFailure(providerId, error);

      if (this._isRateLimitError(error)) {
        const backoffResult = this.backoff.handleRateLimit(providerId, error);
        this.rateLimits.markRateLimited(providerId, backoffResult.delayMs / 1000);
      }
    }
  }

  /**
   * Map a job name to a legacy role.
   * Used by buildProviderChain when in legacy mode (no roster).
   * @private
   * @param {string} job
   * @returns {string}
   */
  _jobToRole(job) {
    if (job === JOBS.CREDENTIALS) return 'sovereign';
    if (job === JOBS.QUICK || job === JOBS.TOOLS) return 'value';
    return 'premium'; // thinking, writing, research, coding
  }

  // ---------------------------------------------------------------------------
  // Local Intelligence: ModelScout integration
  // ---------------------------------------------------------------------------

  /**
   * Store a local model roster (model-name → job map) from ModelScout.
   * Informational storage — MicroPipeline reads this to decide which model
   * to pass to Ollama for each micro-call. Future versions will use this
   * for per-job model selection within Ollama.
   * @param {Object} roster - { quick: ['model1'], thinking: ['model2'], ... }
   */
  setLocalRoster(roster) {
    if (!roster) {
      this._localRoster = null;
      return;
    }

    // Translate model names to provider IDs.
    // ModelScout returns { quick: ['qwen2.5:3b'], thinking: ['qwen3:8b'] }.
    // The router needs provider IDs like 'ollama-fast', 'ollama-local'.
    // Build a model→providerId lookup from registered providers.
    const modelToProvider = new Map();
    for (const [id, provider] of this.providers) {
      if (provider.model) {
        modelToProvider.set(provider.model, id);
      }
    }

    const resolved = {};
    for (const [job, models] of Object.entries(roster)) {
      resolved[job] = (models || []).map(m => modelToProvider.get(m) || m);
    }

    this._localRoster = resolved;
    const jobs = Object.keys(resolved);
    console.log(`[LLMRouter] Local roster set: ${jobs.length} jobs mapped`);
  }

  /**
   * Get the stored local model roster, or null if not set.
   * @returns {Object|null}
   */
  getLocalRoster() {
    return this._localRoster || null;
  }

  /**
   * Check if any registered provider is a cloud (non-local) provider.
   * @returns {boolean}
   */
  hasCloudPlayers() {
    for (const [, provider] of this.providers) {
      if (provider.type !== 'local') return true;
    }
    return false;
  }

  /**
   * Ping the first cloud provider to check if it's reachable.
   * Returns false if no cloud providers exist or if the ping fails.
   * @returns {Promise<boolean>}
   */
  async isCloudAvailable() {
    const cloudId = this._resolveCloudPrimary();
    if (!cloudId) return false;

    const provider = this.providers.get(cloudId);
    if (!provider) return false;

    try {
      const result = await provider.testConnection();
      return !!(result && result.connected);
    } catch {
      return false;
    }
  }
}

LLMRouter.JOBS = JOBS;
LLMRouter.VALID_JOBS = VALID_JOBS;
LLMRouter.PRESET_NAMES = PRESET_NAMES;

module.exports = LLMRouter;
