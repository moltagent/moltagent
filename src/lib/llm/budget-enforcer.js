/**
 * Budget Enforcer
 *
 * Enforces daily and monthly spending limits per provider.
 * Prevents runaway costs.
 *
 * @module llm/budget-enforcer
 * @version 1.0.0
 */

class BudgetEnforcer {
  /**
   * @param {Object} config
   * @param {Object} config.budgets - Budget limits per provider
   * @param {Function} [config.onWarning] - Called when warning threshold hit
   * @param {Function} [config.onExhausted] - Called when budget exhausted
   * @param {number} [config.warningThreshold=0.8] - Percentage to trigger warning
   */
  constructor(config = {}) {
    this.budgets = config.budgets || {};
    this.onWarning = config.onWarning || (() => {});
    this.onExhausted = config.onExhausted || (() => {});
    this.warningThreshold = config.warningThreshold || 0.8;

    // Usage tracking
    this.usage = new Map();

    // Proactive budget (separate from per-provider budgets)
    this.proactiveDailyBudget = config.proactiveDailyBudget || 0;  // 0 = disabled
    this.proactiveUsage = { dailyCost: 0, dailyCalls: 0, dailyTokens: 0 };
    this.proactiveBudgetExhaustedNotified = false;

    // Track when we last reset
    this.lastDailyReset = this.getDateKey();
    this.lastMonthlyReset = this.getMonthKey();

    // Budget override state
    this._overrideActive = false;
    this._overrideExpiry = 0;

    // File persistence via NCRequestManager (optional)
    this.ncRequestManager = config.ncRequestManager || null;
    this._persistPath = '/remote.php/dav/files/moltagent/Memory/spending.json';
    this._dirty = false;
  }

  /**
   * Get date key for daily tracking
   * @returns {string}
   */
  getDateKey() {
    return new Date().toISOString().split('T')[0];
  }

  /**
   * Get month key for monthly tracking
   * @returns {string}
   */
  getMonthKey() {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
  }

  /**
   * Check and reset if needed
   * @private
   */
  checkReset() {
    const today = this.getDateKey();
    const thisMonth = this.getMonthKey();

    // Daily reset
    if (today !== this.lastDailyReset) {
      for (const [providerId, data] of this.usage) {
        data.dailyCost = 0;
        data.dailyTokens = 0;
        data.dailyCalls = 0;
      }
      this.proactiveUsage = { dailyCost: 0, dailyCalls: 0, dailyTokens: 0 };
      this.proactiveBudgetExhaustedNotified = false;
      this.lastDailyReset = today;
    }

    // Monthly reset
    if (thisMonth !== this.lastMonthlyReset) {
      for (const [providerId, data] of this.usage) {
        data.monthlyCost = 0;
        data.monthlyTokens = 0;
        data.monthlyCalls = 0;
      }
      this.lastMonthlyReset = thisMonth;
    }
  }

  /**
   * Get or create usage data for provider
   * @private
   */
  getUsage(providerId) {
    this.checkReset();

    if (!this.usage.has(providerId)) {
      this.usage.set(providerId, {
        dailyCost: 0,
        dailyTokens: 0,
        dailyCalls: 0,
        monthlyCost: 0,
        monthlyTokens: 0,
        monthlyCalls: 0,
        lastCall: null
      });
    }

    return this.usage.get(providerId);
  }

  /**
   * Check if a request is allowed within budget
   * @param {string} providerId - Provider identifier
   * @param {number} estimatedCost - Estimated cost in USD
   * @returns {Object} - { allowed, reason?, spent?, budget?, resetAt? }
   */
  canSpend(providerId, estimatedCost) {
    // Override active = bypass all checks
    if (this.isOverrideActive()) {
      return { allowed: true };
    }

    const budget = this.budgets[providerId];

    // No budget configured = unlimited
    if (!budget) {
      return { allowed: true };
    }

    const usage = this.getUsage(providerId);

    // Check daily limit
    if (budget.daily !== undefined) {
      if (usage.dailyCost + estimatedCost > budget.daily) {
        return {
          allowed: false,
          reason: 'daily_budget_exceeded',
          spent: usage.dailyCost,
          budget: budget.daily,
          resetAt: this.getNextDailyReset()
        };
      }
    }

    // Check monthly limit
    if (budget.monthly !== undefined) {
      if (usage.monthlyCost + estimatedCost > budget.monthly) {
        return {
          allowed: false,
          reason: 'monthly_budget_exceeded',
          spent: usage.monthlyCost,
          budget: budget.monthly,
          resetAt: this.getNextMonthlyReset()
        };
      }
    }

    // Check warning threshold
    if (budget.daily !== undefined) {
      const percentUsed = (usage.dailyCost + estimatedCost) / budget.daily;
      if (percentUsed >= this.warningThreshold) {
        this.onWarning({
          providerId,
          spent: usage.dailyCost,
          budget: budget.daily,
          percentUsed: percentUsed * 100
        });
      }
    }

    return {
      allowed: true,
      dailyRemaining: budget.daily ? budget.daily - usage.dailyCost : undefined,
      monthlyRemaining: budget.monthly ? budget.monthly - usage.monthlyCost : undefined
    };
  }

  /**
   * Record spending
   * @param {string} providerId - Provider identifier
   * @param {number} cost - Actual cost in USD
   * @param {number} tokens - Tokens used
   */
  recordSpend(providerId, cost, tokens) {
    const usage = this.getUsage(providerId);

    usage.dailyCost += cost;
    usage.dailyTokens += tokens;
    usage.dailyCalls++;

    usage.monthlyCost += cost;
    usage.monthlyTokens += tokens;
    usage.monthlyCalls++;

    usage.lastCall = Date.now();
    this._dirty = true;

    // Check if we just hit the budget
    const budget = this.budgets[providerId];
    if (budget?.daily && usage.dailyCost >= budget.daily) {
      this.onExhausted({
        providerId,
        spent: usage.dailyCost,
        budget: budget.daily,
        resetAt: this.getNextDailyReset()
      });
    }
  }

  /**
   * Get next daily reset time
   * @returns {Date}
   */
  getNextDailyReset() {
    const now = new Date();
    const tomorrow = new Date(now);
    tomorrow.setDate(tomorrow.getDate() + 1);
    tomorrow.setHours(0, 0, 0, 0);
    return tomorrow;
  }

  /**
   * Get next monthly reset time
   * @returns {Date}
   */
  getNextMonthlyReset() {
    const now = new Date();
    const nextMonth = new Date(now.getFullYear(), now.getMonth() + 1, 1);
    return nextMonth;
  }

  /**
   * Classify an operation as proactive or reactive based on context
   * @param {Object} context - Operation context with trigger field
   * @returns {string} 'proactive' or 'reactive'
   */
  classifyOperation(context) {
    if (!context || !context.trigger) return 'reactive';
    const proactiveTriggers = [
      'heartbeat_deck', 'heartbeat_calendar', 'heartbeat_activity',
      'heartbeat_digest', 'heartbeat_knowledge', 'heartbeat_email',
      'heartbeat_meeting_prep',
      'deck_card_pickup'
    ];
    return proactiveTriggers.includes(context.trigger) ? 'proactive' : 'reactive';
  }

  /**
   * Check if a proactive operation is allowed within budget
   * @param {number} estimatedCost - Estimated cost in USD
   * @returns {Object} { allowed, reason?, spent?, budget?, remaining? }
   */
  canSpendProactive(estimatedCost) {
    if (this.proactiveDailyBudget <= 0) return { allowed: true }; // disabled
    this.checkReset();
    if (this.proactiveUsage.dailyCost + estimatedCost > this.proactiveDailyBudget) {
      return {
        allowed: false,
        reason: 'proactive_budget_exceeded',
        spent: this.proactiveUsage.dailyCost,
        budget: this.proactiveDailyBudget
      };
    }
    return { allowed: true, remaining: this.proactiveDailyBudget - this.proactiveUsage.dailyCost };
  }

  /**
   * Record spending against the proactive budget pool
   * @param {number} cost - Actual cost in USD
   * @param {number} tokens - Tokens used
   */
  recordProactiveSpend(cost, tokens) {
    this.checkReset();
    this.proactiveUsage.dailyCost += cost;
    this.proactiveUsage.dailyCalls++;
    this.proactiveUsage.dailyTokens += tokens;
    this._dirty = true;

    if (this.proactiveDailyBudget > 0 &&
        this.proactiveUsage.dailyCost >= this.proactiveDailyBudget &&
        !this.proactiveBudgetExhaustedNotified) {
      this.proactiveBudgetExhaustedNotified = true;
      this.onExhausted({
        providerId: '_proactive',
        spent: this.proactiveUsage.dailyCost,
        budget: this.proactiveDailyBudget,
        resetAt: this.getNextDailyReset()
      });
    }
  }

  /**
   * Check if the proactive budget is exhausted
   * @returns {boolean}
   */
  isProactiveBudgetExhausted() {
    if (this.proactiveDailyBudget <= 0) return false;
    this.checkReset();
    return this.proactiveUsage.dailyCost >= this.proactiveDailyBudget;
  }

  /**
   * Get usage summary for a provider
   * @param {string} providerId
   * @returns {Object|null}
   */
  getUsageSummary(providerId) {
    const usage = this.usage.get(providerId);
    if (!usage) return null;

    const budget = this.budgets[providerId] || {};

    return {
      daily: {
        cost: usage.dailyCost,
        tokens: usage.dailyTokens,
        calls: usage.dailyCalls,
        budget: budget.daily,
        percentUsed: budget.daily ? (usage.dailyCost / budget.daily) * 100 : null
      },
      monthly: {
        cost: usage.monthlyCost,
        tokens: usage.monthlyTokens,
        calls: usage.monthlyCalls,
        budget: budget.monthly,
        percentUsed: budget.monthly ? (usage.monthlyCost / budget.monthly) * 100 : null
      },
      lastCall: usage.lastCall
    };
  }

  /**
   * Get full usage report
   * @returns {Object}
   */
  getFullReport() {
    this.checkReset();

    const report = {
      date: this.getDateKey(),
      month: this.getMonthKey(),
      providers: {}
    };

    for (const [providerId] of this.usage) {
      report.providers[providerId] = this.getUsageSummary(providerId);
    }

    report.proactive = {
      dailyCost: this.proactiveUsage.dailyCost,
      dailyCalls: this.proactiveUsage.dailyCalls,
      dailyBudget: this.proactiveDailyBudget,
      exhausted: this.isProactiveBudgetExhausted()
    };

    return report;
  }

  /**
   * Activate a temporary budget override.
   * Allows cloud spending to bypass limits for the specified duration.
   * @param {number} [durationMs=3600000] - Override duration (default: 1 hour)
   */
  activateOverride(durationMs = 3600000) {
    this._overrideActive = true;
    this._overrideExpiry = Date.now() + durationMs;
    console.log(`[BudgetEnforcer] Override activated for ${durationMs / 60000} minutes`);
  }

  /**
   * Check if override is currently active.
   * @returns {boolean}
   */
  isOverrideActive() {
    if (this._overrideActive && Date.now() < this._overrideExpiry) {
      return true;
    }
    if (this._overrideActive) {
      this._overrideActive = false;
    }
    return false;
  }

  /**
   * Update budget configuration
   * @param {Object} budgets - New budget config
   */
  updateBudgets(budgets) {
    this.budgets = { ...this.budgets, ...budgets };
  }

  /**
   * Manually set usage (for loading persisted state)
   * @param {string} providerId
   * @param {Object} usageData
   */
  setUsage(providerId, usageData) {
    this.usage.set(providerId, {
      dailyCost: usageData.dailyCost || 0,
      dailyTokens: usageData.dailyTokens || 0,
      dailyCalls: usageData.dailyCalls || 0,
      monthlyCost: usageData.monthlyCost || 0,
      monthlyTokens: usageData.monthlyTokens || 0,
      monthlyCalls: usageData.monthlyCalls || 0,
      lastCall: usageData.lastCall || null
    });
  }

  /**
   * Export usage data for persistence
   * @returns {Object}
   */
  exportUsage() {
    const data = {
      lastDailyReset: this.lastDailyReset,
      lastMonthlyReset: this.lastMonthlyReset,
      providers: {},
      proactiveUsage: { ...this.proactiveUsage }
    };

    for (const [providerId, usage] of this.usage) {
      data.providers[providerId] = { ...usage };
    }

    return data;
  }

  /**
   * Persist current usage data to Nextcloud WebDAV (Memory/spending.json).
   * Only writes when _dirty flag is set. No-op if ncRequestManager is not configured.
   * @returns {Promise<void>}
   */
  async persist() {
    if (!this._dirty || !this.ncRequestManager) return;
    const data = JSON.stringify(this.exportUsage());
    await this.ncRequestManager.request(this._persistPath, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: data
    });
    this._dirty = false;
  }

  /**
   * Restore usage data from Nextcloud WebDAV (Memory/spending.json).
   * Handles 404 gracefully (file doesn't exist yet).
   * @returns {Promise<void>}
   */
  async restore() {
    if (!this.ncRequestManager) return;
    try {
      const response = await this.ncRequestManager.request(this._persistPath, { method: 'GET' });
      if (response.status === 200 && response.body) {
        const data = typeof response.body === 'string' ? JSON.parse(response.body) : response.body;
        this.importUsage(data);
        console.log('[BudgetEnforcer] Restored spending data from file');
      }
    } catch (err) {
      if (err.message?.includes('404') || err.statusCode === 404) {
        // File doesn't exist yet, that's fine
        return;
      }
      console.warn('[BudgetEnforcer] Could not restore spending data:', err.message);
    }
  }

  /**
   * Import usage data from persistence
   * @param {Object} data
   */
  importUsage(data) {
    if (data.lastDailyReset) this.lastDailyReset = data.lastDailyReset;
    if (data.lastMonthlyReset) this.lastMonthlyReset = data.lastMonthlyReset;

    if (data.providers) {
      for (const [providerId, usage] of Object.entries(data.providers)) {
        this.setUsage(providerId, usage);
      }
    }

    if (data.proactiveUsage) {
      this.proactiveUsage = {
        dailyCost: data.proactiveUsage.dailyCost || 0,
        dailyCalls: data.proactiveUsage.dailyCalls || 0,
        dailyTokens: data.proactiveUsage.dailyTokens || 0
      };
    }

    // Check if we need to reset after import
    this.checkReset();
  }
}

module.exports = BudgetEnforcer;
