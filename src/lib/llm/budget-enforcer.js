/**
 * Budget Enforcer
 *
 * Enforces daily and monthly spending limits per provider.
 * Cost data is read from CostTracker (single source of truth).
 * This module is responsible only for cap checks, degradation callbacks,
 * and the proactive budget pool (a BudgetEnforcer-only concept not tracked
 * by CostTracker).
 *
 * @module llm/budget-enforcer
 * @version 2.0.0
 */

class BudgetEnforcer {
  /**
   * @param {Object} config
   * @param {Object} config.budgets - Budget limits per provider
   * @param {Function} [config.onWarning] - Called when warning threshold hit
   * @param {Function} [config.onExhausted] - Called when budget exhausted
   * @param {number} [config.warningThreshold=0.8] - Percentage to trigger warning
   * @param {number} [config.proactiveDailyBudget=0] - Daily cap for proactive ops (0 = disabled)
   */
  constructor(config = {}) {
    this.budgets = config.budgets || {};
    this.onWarning = config.onWarning || (() => {});
    this.onExhausted = config.onExhausted || (() => {});
    this.warningThreshold = config.warningThreshold || 0.8;

    // Proactive budget pool (separate from per-provider budgets, in-process only)
    this.proactiveDailyBudget = config.proactiveDailyBudget || 0;
    this.proactiveUsage = { dailyCost: 0, dailyCalls: 0, dailyTokens: 0 };
    this.proactiveBudgetExhaustedNotified = false;
    this._proactiveDay = this._todayKey();

    // Budget override state
    this._overrideActive = false;
    this._overrideExpiry = 0;

    // CostTracker reference — set post-construction by the caller (e.g. HeartbeatManager)
    this.costTracker = null;
  }

  /**
   * Check if a request is allowed within budget.
   * Reads actual spend from CostTracker when available; falls back to zero
   * (fail-open) when CostTracker is not wired in.
   *
   * @param {string} providerId - Provider identifier
   * @param {number} estimatedCost - Estimated cost in USD
   * @returns {Object} { allowed, reason?, spent?, budget?, resetAt? }
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

    // Read actual spend from CostTracker (single source of truth)
    const totals = this.costTracker ? this.costTracker.getTotals() : null;
    const dailySpent = totals ? totals.daily.costUsd : 0;
    const monthlySpent = totals ? totals.monthly.costUsd : 0;

    // Check daily limit
    if (budget.daily !== undefined) {
      if (dailySpent + estimatedCost > budget.daily) {
        return {
          allowed: false,
          reason: 'daily_budget_exceeded',
          spent: dailySpent,
          budget: budget.daily,
          resetAt: this.getNextDailyReset()
        };
      }
    }

    // Check monthly limit
    if (budget.monthly !== undefined) {
      if (monthlySpent + estimatedCost > budget.monthly) {
        return {
          allowed: false,
          reason: 'monthly_budget_exceeded',
          spent: monthlySpent,
          budget: budget.monthly,
          resetAt: this.getNextMonthlyReset()
        };
      }
    }

    // Check warning threshold (daily)
    if (budget.daily !== undefined) {
      const percentUsed = (dailySpent + estimatedCost) / budget.daily;
      if (percentUsed >= this.warningThreshold) {
        this.onWarning({
          providerId,
          spent: dailySpent,
          budget: budget.daily,
          percentUsed: percentUsed * 100
        });
      }
    }

    return {
      allowed: true,
      dailyRemaining: budget.daily ? budget.daily - dailySpent : undefined,
      monthlyRemaining: budget.monthly ? budget.monthly - monthlySpent : undefined
    };
  }

  /**
   * Called after a successful spend to fire the exhausted callback if a daily cap
   * was just crossed. No accumulation — reads from CostTracker.
   *
   * @param {string} providerId - Provider identifier
   */
  recordSpend(providerId) {
    const budget = this.budgets[providerId];
    if (!budget?.daily) return;

    const totals = this.costTracker ? this.costTracker.getTotals() : null;
    const dailySpent = totals ? totals.daily.costUsd : 0;

    if (dailySpent >= budget.daily) {
      this.onExhausted({
        providerId,
        spent: dailySpent,
        budget: budget.daily,
        resetAt: this.getNextDailyReset()
      });
    }
  }

  /**
   * Classify an operation as proactive or reactive based on context.
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
   * Check if a proactive operation is allowed within the proactive daily budget.
   * @param {number} estimatedCost - Estimated cost in USD
   * @returns {Object} { allowed, reason?, spent?, budget?, remaining? }
   */
  canSpendProactive(estimatedCost) {
    if (this.proactiveDailyBudget <= 0) return { allowed: true };
    this._checkProactiveReset();
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
   * Record spending against the proactive budget pool.
   * @param {number} cost - Actual cost in USD
   * @param {number} tokens - Tokens used
   */
  recordProactiveSpend(cost, tokens) {
    this._checkProactiveReset();
    this.proactiveUsage.dailyCost += cost;
    this.proactiveUsage.dailyCalls++;
    this.proactiveUsage.dailyTokens += tokens;

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
   * Check if the proactive budget is exhausted.
   * @returns {boolean}
   */
  isProactiveBudgetExhausted() {
    if (this.proactiveDailyBudget <= 0) return false;
    this._checkProactiveReset();
    return this.proactiveUsage.dailyCost >= this.proactiveDailyBudget;
  }

  /**
   * Get next daily reset time.
   * @returns {Date}
   */
  getNextDailyReset() {
    const tomorrow = new Date();
    tomorrow.setDate(tomorrow.getDate() + 1);
    tomorrow.setHours(0, 0, 0, 0);
    return tomorrow;
  }

  /**
   * Get next monthly reset time.
   * @returns {Date}
   */
  getNextMonthlyReset() {
    const now = new Date();
    return new Date(now.getFullYear(), now.getMonth() + 1, 1);
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
   * Update budget configuration.
   * @param {Object} budgets - New budget config
   */
  updateBudgets(budgets) {
    this.budgets = { ...this.budgets, ...budgets };
  }

  /**
   * Reset proactive accumulator at day boundary.
   * @private
   */
  _checkProactiveReset() {
    const today = this._todayKey();
    if (today !== this._proactiveDay) {
      this.proactiveUsage = { dailyCost: 0, dailyCalls: 0, dailyTokens: 0 };
      this.proactiveBudgetExhaustedNotified = false;
      this._proactiveDay = today;
    }
  }

  _todayKey() {
    return new Date().toISOString().slice(0, 10);
  }
}

module.exports = BudgetEnforcer;
