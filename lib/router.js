const OllamaProvider = require('./providers/ollama');
const DeepSeekProvider = require('./providers/deepseek');
const ClaudeProvider = require('./providers/claude');

class LLMRouter {
  constructor(config, credentialBroker = null, auditLogger = null) {
    this.config = config;
    this.credentialBroker = credentialBroker;
    this.auditLogger = auditLogger;
    this.providers = {};
    this.initializeProviders();
    this.dailySpend = new Map();
    this.lastReset = this.getStartOfDay();
    this.backoffState = new Map();
    this.metrics = { totalCalls: 0, byProvider: {}, failovers: 0, totalCost: 0 };
  }

  initializeProviders() {
    const pc = this.config.providers;
    if (pc.ollama) this.providers.ollama = new OllamaProvider(pc.ollama);
    if (pc.deepseek) this.providers.deepseek = new DeepSeekProvider(pc.deepseek, this.credentialBroker);
    if (pc.claude) this.providers.claude = new ClaudeProvider(pc.claude, this.credentialBroker);
  }

  async route(task, content, options = {}) {
    this.checkDailyReset();
    
    // Handle forceProvider option
    let chain;
    if (options.forceProvider && this.providers[options.forceProvider]) {
      chain = [options.forceProvider];
      // Still add fallback to local for safety
      if (options.forceProvider !== 'ollama') {
        chain.push('ollama');
      }
    } else {
      chain = this.buildProviderChain(task, content, options);
    }
    
    const errors = [];

    for (const providerId of chain) {
      const budgetCheck = this.checkBudget(providerId, options.estimatedTokens || 1000);
      if (!budgetCheck.allowed) { 
        errors.push({ provider: providerId, error: 'budget_exceeded' }); 
        continue; 
      }
      if (this.isInBackoff(providerId)) { 
        errors.push({ provider: providerId, error: 'in_backoff' }); 
        continue; 
      }
      
      const provider = this.providers[providerId];
      if (!provider) { 
        errors.push({ provider: providerId, error: 'not_configured' }); 
        continue; 
      }

      try {
        const result = await provider.generate(task, content, options);
        if (result.success) {
          this.recordSuccess(providerId, result);
          this.backoffState.delete(providerId);
          
          // Log credential access if API provider was used
          if (this.auditLogger && this.credentialBroker && providerId !== 'ollama') {
            const credName = this.config.providers[providerId]?.credentialName;
            if (credName) {
              await this.auditLogger.logCredentialAccess(credName, true);
            }
          }
          
          return {
            success: true, provider: providerId, content: result.content,
            usage: result.usage, cost: result.cost, timing: result.timing,
            failoverPath: errors.length > 0 ? errors.map(e => e.provider) : null
          };
        } else {
          errors.push({ provider: providerId, error: result.error });
          if (result.isRateLimit) this.handleRateLimit(providerId, result);
        }
      } catch (error) {
        errors.push({ provider: providerId, error: error.message });
      }
    }

    return { success: false, error: 'all_providers_exhausted', attempted: errors };
  }

  buildProviderChain(task, content, options) {
    // Security: credential detection forces local-only
    if (options.containsCredentials || this.detectsCredentials(content)) {
      if (this.auditLogger) {
        this.auditLogger.logSecurityEvent('credential_detected', { 
          action: 'routed_to_local',
          task: task 
        });
      }
      return ['ollama'];
    }
    
    // Untrusted content stays local (prompt injection isolation)
    if (options.untrusted || options.isUntrustedContent) {
      return ['ollama'];
    }

    // Determine role based on options
    let role = options.role || 'workhorse';
    if (options.qualityCritical || options.clientFacing) role = 'premium';
    else if (options.bulk || options.costSensitive) role = 'value';
    else if (task === 'heartbeat' || task === 'heartbeat_scan') role = 'sovereign';

    // Build chain from role + fallbacks
    const chain = [...(this.config.roles[role] || ['ollama'])];
    for (const pid of [...chain]) {
      const fallbacks = this.config.fallbackChains[pid] || [];
      for (const fb of fallbacks) if (!chain.includes(fb)) chain.push(fb);
    }
    
    // Always ensure local is available as last resort
    if (!chain.includes('ollama')) chain.push('ollama');
    return chain;
  }

  detectsCredentials(content) {
    const patterns = [
      /api[_-]?key/i, 
      /password/i, 
      /secret/i, 
      /token/i, 
      /bearer\s+\S+/i, 
      /sk-[a-zA-Z0-9]{20,}/
    ];
    const str = typeof content === 'string' ? content : JSON.stringify(content);
    return patterns.some(p => p.test(str));
  }

  checkBudget(providerId, estimatedTokens) {
    const limit = this.config.budgets?.daily?.[providerId];
    if (!limit) return { allowed: true };
    const spent = this.dailySpend.get(providerId) || 0;
    const est = this.estimateCost(providerId, estimatedTokens);
    if (spent + est > limit) {
      if (this.auditLogger) {
        this.auditLogger.logBudgetEvent(providerId, spent, limit, 'blocked');
      }
      return { allowed: false, spent, limit };
    }
    
    // Warn at 80%
    const percentUsed = (spent + est) / limit;
    if (percentUsed > 0.8 && this.auditLogger) {
      this.auditLogger.logBudgetEvent(providerId, spent, limit, 'warning');
    }
    
    return { allowed: true, percentUsed };
  }

  estimateCost(providerId, tokens) {
    const p = this.config.providers[providerId];
    if (!p || p.costModel?.type !== 'per_token') return 0;
    return (tokens * 0.3 * p.costModel.inputPer1M + tokens * 0.7 * p.costModel.outputPer1M) / 1000000;
  }

  isInBackoff(providerId) {
    const s = this.backoffState.get(providerId);
    return s && Date.now() < s.nextRetry;
  }

  handleRateLimit(providerId, result) {
    const s = this.backoffState.get(providerId) || { count: 0 };
    s.count++;
    s.nextRetry = Date.now() + Math.min(Math.pow(2, s.count) * 1000, 300000);
    this.backoffState.set(providerId, s);
    console.log('[Router] ' + providerId + ' rate limited, backing off');
  }

  recordSuccess(providerId, result) {
    this.metrics.totalCalls++;
    this.metrics.byProvider[providerId] = (this.metrics.byProvider[providerId] || 0) + 1;
    if (result.cost) {
      this.metrics.totalCost += result.cost;
      this.dailySpend.set(providerId, (this.dailySpend.get(providerId) || 0) + result.cost);
    }
  }

  checkDailyReset() {
    const today = this.getStartOfDay();
    if (today > this.lastReset) { 
      this.dailySpend.clear(); 
      this.lastReset = today; 
    }
  }

  getStartOfDay() {
    const n = new Date();
    return new Date(n.getFullYear(), n.getMonth(), n.getDate()).getTime();
  }

  getStatus() {
    // Calculate total daily spend
    let totalDailySpend = 0;
    for (const [, amount] of this.dailySpend) {
      totalDailySpend += amount;
    }
    
    return {
      providers: Object.fromEntries(
        Object.entries(this.providers).map(([id, p]) => [id, { available: !this.isInBackoff(id) }])
      ),
      dailySpend: totalDailySpend,
      dailySpendByProvider: Object.fromEntries(this.dailySpend),
      metrics: this.metrics
    };
  }
}

module.exports = LLMRouter;
