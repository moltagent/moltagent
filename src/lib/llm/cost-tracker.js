'use strict';

/**
 * CostTracker
 *
 * Records every LLM call with token counts and computed cost.
 * Maintains daily/monthly accumulators in memory.
 * Writes per-call audit entries to JSONL file in NC Files.
 * Provides totals for Costs card display and budget checking.
 *
 * Currency: All costs stored in USD (matches API pricing).
 * Display: CockpitManager converts to EUR for card display
 * using a static rate (configurable, default 0.92).
 *
 * This is the single source of truth for per-call cost data.
 * BudgetEnforcer handles per-provider budget enforcement separately.
 *
 * @module llm/cost-tracker
 * @version 1.0.0
 */

const PRICING = {
  // Anthropic (per million tokens)
  'claude-opus-4-6':            { input: 15.00, output: 75.00 },
  'claude-opus-4-20250918':     { input: 15.00, output: 75.00 },
  'claude-sonnet-4-6':          { input: 3.00,  output: 15.00 },
  'claude-sonnet-4-20250514':   { input: 3.00,  output: 15.00 },
  'claude-sonnet-4-5-20250514': { input: 3.00,  output: 15.00 },
  'claude-sonnet-4-5-20250929': { input: 3.00,  output: 15.00 },
  'claude-haiku-3-5-20241022':  { input: 0.80,  output: 4.00  },
  'claude-haiku-4-5-20251001':  { input: 0.80,  output: 4.00  },

  // OpenAI (per million tokens)
  'gpt-4o':                     { input: 2.50,  output: 10.00 },
  'gpt-4o-mini':                { input: 0.15,  output: 0.60  },

  // DeepSeek
  'deepseek-chat':              { input: 0.14,  output: 0.28  },

  // Mistral
  'mistral-small-latest':       { input: 0.20,  output: 0.60  },

  // Groq
  'llama-3.3-70b-versatile':    { input: 0.59,  output: 0.79  },

  // Perplexity
  'sonar-pro':                  { input: 3.00,  output: 15.00 },

  // Local models — zero cost
  'phi4-mini':                  { input: 0, output: 0 },
  'qwen2.5:3b':                 { input: 0, output: 0 },
  'qwen3:8b':                   { input: 0, output: 0 },
  'qwen3:14b':                  { input: 0, output: 0 },
  'qwen3:14b-fast':             { input: 0, output: 0 },
};

class CostTracker {
  /**
   * @param {Object} options
   * @param {Object} [options.ncFilesClient] - NC Files client for writing JSONL
   * @param {string} [options.logDir='/Moltagent/Logs'] - NC Files path for logs
   * @param {number} [options.usdToEur=0.92] - Static conversion rate
   */
  constructor({ ncFilesClient, logDir = '/Moltagent/Logs', usdToEur = 0.92 } = {}) {
    this.files = ncFilesClient || null;
    this.logDir = logDir;
    this.usdToEur = usdToEur;

    // In-memory accumulators (survive until process restart)
    this.daily = { cost: 0, cloudCalls: 0, localCalls: 0, byJob: {} };
    this.monthly = { cost: 0, cloudCalls: 0, localCalls: 0, byJob: {} };

    // Track current period boundaries
    this.currentDay = this._todayKey();
    this.currentMonth = this._monthKey();

    // Buffer for batch-writing JSONL (flush on heartbeat)
    this._buffer = [];

    // Track whether log directory has been ensured
    this._logDirEnsured = false;

    // Rate-limit daily summary writes (timestamp of last write)
    this._lastSummaryWrite = 0;
  }

  /**
   * Rehydrate daily and monthly accumulators from the JSONL audit log.
   * Call once after construction, before any route() calls.
   * Reads the current month's JSONL from NC Files, parses each line,
   * and sums today's and this month's totals into the accumulators.
   *
   * Safe to call multiple times — always rebuilds from source of truth.
   * Non-fatal: if the file doesn't exist or can't be read, accumulators
   * stay at zero (identical to current behaviour on fresh start).
   */
  async restore() {
    if (!this.files) return;

    const filename = `costs-${this._monthKey()}.jsonl`;
    const filepath = `${this.logDir}/${filename}`;
    const today = this._todayKey();

    let raw;
    try {
      // Use readFileBuffer to avoid readFile's 50KB truncation
      if (this.files.readFileBuffer) {
        const buf = await this.files.readFileBuffer(filepath);
        raw = buf.toString('utf-8');
      } else {
        const result = await this.files.readFile(filepath);
        raw = (typeof result === 'string' ? result : result.content) || '';
      }
    } catch {
      // File doesn't exist yet — nothing to restore
      return;
    }

    if (!raw || typeof raw !== 'string') return;

    // Reset accumulators before rehydrating
    this.daily = { cost: 0, cloudCalls: 0, localCalls: 0, byJob: {} };
    this.monthly = { cost: 0, cloudCalls: 0, localCalls: 0, byJob: {} };

    const lines = raw.split('\n');
    let restored = 0;

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;

      let entry;
      try {
        entry = JSON.parse(trimmed);
      } catch {
        continue; // Skip malformed lines
      }

      const entryDate = (entry.timestamp || '').slice(0, 10);
      const isLocal = !!entry.is_local;
      const cost = Number(entry.cost_usd) || 0;

      // Monthly accumulation (all entries in this file are current month)
      if (isLocal) {
        this.monthly.localCalls++;
      } else {
        this.monthly.cost += cost;
        this.monthly.cloudCalls++;
      }

      const jobKey = `${entry.job || 'unknown'}:${isLocal ? 'local' : 'cloud'}`;
      this.monthly.byJob[jobKey] = (this.monthly.byJob[jobKey] || 0) + cost;

      // Daily accumulation (only today's entries)
      if (entryDate === today) {
        if (isLocal) {
          this.daily.localCalls++;
        } else {
          this.daily.cost += cost;
          this.daily.cloudCalls++;
        }
        this.daily.byJob[jobKey] = (this.daily.byJob[jobKey] || 0) + cost;
      }

      restored++;
    }

    if (restored > 0) {
      console.log(
        `[CostTracker] Restored ${restored} entries from ${filename} | ` +
        `Day: $${this.daily.cost.toFixed(2)} (${this.daily.cloudCalls} cloud, ${this.daily.localCalls} local) | ` +
        `Month: $${this.monthly.cost.toFixed(2)} (${this.monthly.cloudCalls} cloud, ${this.monthly.localCalls} local)`
      );
    }
  }

  /**
   * Record a completed LLM call.
   * Called after every successful API response.
   *
   * @param {Object} entry
   * @param {string} entry.model - Model identifier (must match PRICING keys)
   * @param {string} entry.job - Job type (quick, tools, thinking, writing, research, coding, etc.)
   * @param {string} entry.trigger - What caused this call (user_message, heartbeat, workflow, etc.)
   * @param {number} entry.inputTokens - From response usage object
   * @param {number} entry.outputTokens - From response usage object
   * @param {number} [entry.cacheCreationTokens=0] - Anthropic cache creation tokens
   * @param {number} [entry.cacheReadTokens=0] - Anthropic cache read tokens
   * @param {boolean} [entry.isLocal=false] - Whether this was a local model call
   * @param {string} [entry.provider] - Provider ID for attribution
   * @param {boolean} [entry.internal=false] - Internal heartbeat call (excluded from display counters)
   */
  record(entry) {
    this._checkReset();

    const cost = this._computeCost(entry);
    const isLocal = entry.isLocal || this._isLocalModel(entry.model);
    const isInternal = !!entry.internal;

    // Accumulate — internal calls still track cost (for budget enforcement)
    // but are excluded from call counts (which feed Status cards)
    if (isLocal) {
      if (!isInternal) {
        this.daily.localCalls++;
        this.monthly.localCalls++;
      }
    } else {
      this.daily.cost += cost;
      this.monthly.cost += cost;
      if (!isInternal) {
        this.daily.cloudCalls++;
        this.monthly.cloudCalls++;
      }
    }

    // Track by job
    const jobKey = `${entry.job || 'unknown'}:${isLocal ? 'local' : 'cloud'}`;
    this.daily.byJob[jobKey] = (this.daily.byJob[jobKey] || 0) + cost;
    this.monthly.byJob[jobKey] = (this.monthly.byJob[jobKey] || 0) + cost;

    // Buffer audit entry
    this._buffer.push({
      timestamp: new Date().toISOString(),
      model: entry.model,
      provider: entry.provider || null,
      job: entry.job || 'unknown',
      trigger: entry.trigger || 'unknown',
      input_tokens: entry.inputTokens || 0,
      output_tokens: entry.outputTokens || 0,
      cache_creation_tokens: entry.cacheCreationTokens || 0,
      cache_read_tokens: entry.cacheReadTokens || 0,
      cost_usd: Math.round(cost * 1000000) / 1000000,
      is_local: isLocal,
    });

    console.log(
      `[CostTracker] ${entry.model} ${entry.job || 'unknown'}: ` +
      `${entry.inputTokens || 0}in/${entry.outputTokens || 0}out ` +
      `$${cost.toFixed(4)} | Day: $${this.daily.cost.toFixed(2)} | ` +
      `Month: $${this.monthly.cost.toFixed(2)}`
    );
  }

  /**
   * Get current totals for display and budget checks.
   * Returns both USD and EUR values.
   */
  getTotals() {
    this._checkReset();
    return {
      daily: {
        costUsd: this.daily.cost,
        costEur: this.daily.cost * this.usdToEur,
        cloudCalls: this.daily.cloudCalls,
        localCalls: this.daily.localCalls,
      },
      monthly: {
        costUsd: this.monthly.cost,
        costEur: this.monthly.cost * this.usdToEur,
        cloudCalls: this.monthly.cloudCalls,
        localCalls: this.monthly.localCalls,
      },
      localRatio: this._localRatio(),
      topSpending: this._topSpending(),
    };
  }

  /**
   * Flush buffered entries to JSONL file in NC Files.
   * Called by HeartbeatManager on each pulse.
   */
  async flush() {
    if (this._buffer.length === 0) return;
    if (!this.files) return;

    const entries = this._buffer.splice(0); // Take all, clear buffer
    const lines = entries.map(e => JSON.stringify(e)).join('\n') + '\n';
    const filename = `costs-${this._monthKey()}.jsonl`;
    const filepath = `${this.logDir}/${filename}`;

    try {
      // Ensure log directory exists (once per lifetime)
      if (!this._logDirEnsured) {
        try {
          await this.files.mkdir(this.logDir);
        } catch (_e) {
          // Directory likely already exists — ignore
        }
        this._logDirEnsured = true;
      }

      // Read existing file as raw buffer to avoid readFile's 50KB truncation
      let existing = '';
      try {
        if (this.files.readFileBuffer) {
          const buf = await this.files.readFileBuffer(filepath);
          existing = buf.toString('utf-8');
        } else {
          const result = await this.files.readFile(filepath);
          existing = (typeof result === 'string' ? result : result.content) || '';
        }
      } catch (_e) {
        // File doesn't exist yet — will create new
      }

      await this.files.writeFile(filepath, existing + lines);
      console.log(`[CostTracker] Flushed ${entries.length} entries to ${filepath}`);
    } catch (err) {
      console.error(`[CostTracker] Failed to write cost log: ${err.message}`);
      // Put entries back in buffer to retry next flush
      this._buffer.unshift(...entries);
    }
  }

  /**
   * Write or update a daily cost summary CSV to NC Files.
   * Called by HeartbeatManager once per heartbeat cycle.
   * Appends one row per day; skips if today's row was already written.
   *
   * CSV path: {logDir}/cost-summary.csv
   * Columns: date,total_usd,total_eur,opus_usd,sonnet_usd,haiku_usd,
   *          local_calls,cloud_calls,top_job,top_job_usd
   */
  async writeDailySummary() {
    if (!this.files) return;

    const today = this._todayKey();
    // Rate-limit: write at most once per 10 minutes
    const now = Date.now();
    if (now - this._lastSummaryWrite < 10 * 60 * 1000) return;

    const filepath = `${this.logDir}/cost-summary.csv`;
    const header = 'date,total_usd,total_eur,opus_usd,sonnet_usd,haiku_usd,local_calls,cloud_calls,top_job,top_job_usd';

    // Aggregate today's data from the JSONL
    const jsonlPath = `${this.logDir}/costs-${this._monthKey()}.jsonl`;

    let raw = '';
    try {
      // Use readFileBuffer to avoid readFile's 50KB truncation
      if (this.files.readFileBuffer) {
        const buf = await this.files.readFileBuffer(jsonlPath);
        raw = buf.toString('utf-8');
      } else {
        const result = await this.files.readFile(jsonlPath);
        raw = (typeof result === 'string' ? result : result.content) || '';
      }
    } catch {
      // No JSONL yet — nothing to summarise
      return;
    }

    // Parse today's entries from JSONL
    let totalUsd = 0;
    let opusUsd = 0;
    let sonnetUsd = 0;
    let haikuUsd = 0;
    let localCalls = 0;
    let cloudCalls = 0;
    const jobCosts = {};

    for (const line of raw.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) continue;

      let entry;
      try { entry = JSON.parse(trimmed); } catch { continue; }

      const entryDate = (entry.timestamp || '').slice(0, 10);
      if (entryDate !== today) continue;

      const cost = Number(entry.cost_usd) || 0;
      const model = entry.model || '';

      if (entry.is_local) {
        localCalls++;
      } else {
        cloudCalls++;
        totalUsd += cost;
      }

      if (/opus/i.test(model)) opusUsd += cost;
      else if (/sonnet/i.test(model)) sonnetUsd += cost;
      else if (/haiku/i.test(model)) haikuUsd += cost;

      const job = entry.job || 'unknown';
      jobCosts[job] = (jobCosts[job] || 0) + cost;
    }

    // Find top job
    let topJob = '';
    let topJobUsd = 0;
    for (const [job, cost] of Object.entries(jobCosts)) {
      if (cost > topJobUsd) { topJob = job; topJobUsd = cost; }
    }

    const totalEur = totalUsd * this.usdToEur;

    // Build the CSV row
    const row = [
      today,
      totalUsd.toFixed(4),
      totalEur.toFixed(4),
      opusUsd.toFixed(4),
      sonnetUsd.toFixed(4),
      haikuUsd.toFixed(4),
      localCalls,
      cloudCalls,
      topJob.replace(/,/g, ';'), // Escape commas in job name
      topJobUsd.toFixed(4),
    ].join(',');

    try {
      // Read existing CSV
      let existing = '';
      try {
        const result = await this.files.readFile(filepath);
        existing = (typeof result === 'string' ? result : result.content) || '';
      } catch {
        // File doesn't exist yet — will create with header
      }

      if (!existing) {
        // New file: header + row
        await this.files.writeFile(filepath, header + '\n' + row + '\n');
      } else {
        // Check if today's row already exists (idempotent)
        if (existing.includes(today + ',')) {
          // Replace today's row with updated values
          const lines = existing.split('\n');
          const updated = lines.map(l => l.startsWith(today + ',') ? row : l).join('\n');
          await this.files.writeFile(filepath, updated);
        } else {
          // Append new row
          const content = existing.endsWith('\n') ? existing : existing + '\n';
          await this.files.writeFile(filepath, content + row + '\n');
        }
      }

      this._lastSummaryWrite = Date.now();
      console.log(`[CostTracker] Daily summary written: ${today} $${totalUsd.toFixed(2)} (${cloudCalls} cloud, ${localCalls} local)`);
    } catch (err) {
      console.error(`[CostTracker] Failed to write daily summary: ${err.message}`);
    }
  }

  /**
   * Compute cost for a single call using the pricing table.
   */
  _computeCost(entry) {
    const pricing = PRICING[entry.model];
    if (!pricing) {
      console.warn(`[CostTracker] Unknown model "${entry.model}", assuming zero cost`);
      return 0;
    }

    const inputCost = ((entry.inputTokens || 0) / 1_000_000) * pricing.input;
    const outputCost = ((entry.outputTokens || 0) / 1_000_000) * pricing.output;

    // Anthropic cache tokens: creation costs 25% more than input, reads cost 10% of input
    let cacheCost = 0;
    if (entry.cacheCreationTokens) {
      cacheCost += (entry.cacheCreationTokens / 1_000_000) * pricing.input * 1.25;
    }
    if (entry.cacheReadTokens) {
      cacheCost += (entry.cacheReadTokens / 1_000_000) * pricing.input * 0.10;
    }

    return inputCost + outputCost + cacheCost;
  }

  _isLocalModel(model) {
    const pricing = PRICING[model];
    if (pricing) return pricing.input === 0 && pricing.output === 0;
    // Unknown models: check common local patterns
    return /^(qwen|llama|phi|gemma|mistral-nemo|deepseek-r1)/i.test(model || '');
  }

  _localRatio() {
    const total = this.monthly.cloudCalls + this.monthly.localCalls;
    if (total === 0) return 100;
    return Math.round((this.monthly.localCalls / total) * 100);
  }

  _topSpending() {
    return Object.entries(this.monthly.byJob)
      .filter(([, cost]) => cost > 0)
      .sort(([, a], [, b]) => b - a)
      .slice(0, 5)
      .map(([key, cost]) => {
        const [job, type] = key.split(':');
        return { job, type, costUsd: cost };
      });
  }

  _checkReset() {
    const today = this._todayKey();
    const month = this._monthKey();

    if (today !== this.currentDay) {
      console.log(`[CostTracker] Day reset: ${this.currentDay} → ${today}`);
      this.daily = { cost: 0, cloudCalls: 0, localCalls: 0, byJob: {} };
      this.currentDay = today;
    }

    if (month !== this.currentMonth) {
      console.log(`[CostTracker] Month reset: ${this.currentMonth} → ${month}`);
      this.monthly = { cost: 0, cloudCalls: 0, localCalls: 0, byJob: {} };
      this.currentMonth = month;
    }
  }

  _todayKey() {
    return new Date().toISOString().slice(0, 10);
  }

  _monthKey() {
    return new Date().toISOString().slice(0, 7);
  }
}

CostTracker.PRICING = PRICING;

module.exports = CostTracker;
