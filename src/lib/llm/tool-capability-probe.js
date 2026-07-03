/**
 * SPDX-License-Identifier: AGPL-3.0-only
 * Copyright (C) 2026 Moltagent contributors
 *
 * ToolCapabilityProbe — Verify at boot that each model assigned to a
 * tool-capable job ACTUALLY produces tool calls (#118).
 *
 * Problem:
 *   A model's /api/show capabilities declare tool support; some models
 *   declare it and still answer a tool-requiring instruction with prose.
 *   That deficiency surfaced downstream, mid-request, as parse fallbacks
 *   and hallucinated action reports — never at boot, where it belongs.
 *
 * Pattern:
 *   Same probe-and-cache shape as GoldenSetProbe (one probing pattern, not
 *   two): for each candidate, send ONE trivial function schema plus an
 *   instruction that requires calling it, through the SAME provider class
 *   production uses (chatFn injected — the probe owns no transport). A
 *   response whose toolCalls names the probe function passes; prose fails
 *   and is flagged in the boot log and ModelResolver.describe(). Results
 *   are cached on disk keyed by model digest + probe revision so warm
 *   boots stay fast; an errored measurement (Ollama cold, #124) is NOT
 *   cached and NOT flagged — cold is not prose.
 *
 * Boundary (#118 vs the maturation loop): the probe FLAGS; it does not
 *   reseat. Reseating on evidence is the ModelScorecard/maturation loop's
 *   authority — at runtime the existing QUICK chain already falls back on
 *   tool-call failure. The probe converts that silent runtime discovery
 *   into a loud boot line.
 *
 * Data Flow:
 *   webhook-server (boot, inside the ModelScout .then, after the golden-set
 *   probe so the post-probe resolver re-log reflects both — NOTE(#233))
 *     → probe.run(candidates) → { name, status: 'tool-call'|'prose'|'unmeasured' }
 *     → modelResolver.markToolIncapable(name) per prose result
 *
 * Dependency Map:
 *   src/lib/llm/tool-capability-probe.js
 *     ← (no internal imports — standalone; callers inject chatFn)
 *
 * @module llm/tool-capability-probe
 * @license AGPL-3.0
 */

'use strict';

const fs = require('fs');
const path = require('path');

const CACHE_FILENAME = 'tool-capability-probe.json';

// Bump when the probe schema/instruction or pass criterion changes — old
// cached verdicts then re-measure instead of masquerading as comparable.
const PROBE_REV = 1;

// The trivial probe function: one boolean argument, no room for ambiguity.
const PROBE_TOOL = {
  type: 'function',
  function: {
    name: 'mark_ready',
    description: 'Report readiness. Call this function — do not answer in text.',
    parameters: {
      type: 'object',
      properties: {
        ready: { type: 'boolean', description: 'Always true.' },
      },
      required: ['ready'],
    },
  },
};

const PROBE_SYSTEM = 'You are a function-calling assistant. You MUST answer by calling the provided function. Never answer in prose.';
const PROBE_MESSAGE = 'Call the mark_ready function with ready set to true.';

/** Probe verdicts. */
const VERDICT = {
  TOOL_CALL: 'tool-call',   // produced a tool call naming the probe function
  PROSE: 'prose',           // answered without a usable tool call
  UNMEASURED: 'unmeasured', // transport error/timeout — presence unknown, retry next boot
};

class ToolCapabilityProbe {
  /**
   * @param {Object} opts
   * @param {Function} [opts.chatFn] - async (modelName, { system, messages, tools })
   *   => provider response ({ content, toolCalls }). Production injects the
   *   real OllamaToolsProvider.chat; tests inject a fake. The probe owns no
   *   transport of its own.
   * @param {string} [opts.cacheDir] - Directory for the results cache
   *   (defaults to `data/` under cwd, same as GoldenSetProbe).
   * @param {Object} [opts.logger=console]
   */
  constructor({ chatFn, cacheDir, logger } = {}) {
    this.chatFn = typeof chatFn === 'function' ? chatFn : null;
    this.cacheDir = cacheDir || path.resolve(process.cwd(), 'data');
    this._cacheFile = path.join(this.cacheDir, CACHE_FILENAME);
    this.logger = logger || console;
  }

  /**
   * Probe each candidate once (sequential — one Ollama host serves these).
   * @param {Array<{name: string, digest?: string}>} candidates
   * @returns {Promise<Array<{name: string, status: string, detail: string}>>}
   */
  async run(candidates) {
    const list = Array.isArray(candidates) ? candidates.filter(c => c && typeof c.name === 'string') : [];
    if (list.length === 0 || !this.chatFn) {
      if (!this.chatFn) this.logger.warn('[ToolCapabilityProbe] Missing chatFn; skipping probe.');
      return [];
    }

    const diskCache = this._loadCache();
    let cacheChanged = false;
    const results = [];

    for (const candidate of list) {
      const key = this._cacheKey(candidate);
      const cached = diskCache[key];
      if (cached && cached.status && cached.status !== VERDICT.UNMEASURED) {
        results.push({ name: candidate.name, status: cached.status, detail: `${cached.detail || ''} (cached)`.trim() });
        continue;
      }

      let status;
      let detail;
      try {
        const res = await this.chatFn(candidate.name, {
          system: PROBE_SYSTEM,
          messages: [{ role: 'user', content: PROBE_MESSAGE }],
          tools: [PROBE_TOOL],
        });
        const calls = res && Array.isArray(res.toolCalls) ? res.toolCalls : [];
        if (calls.some(tc => tc && tc.name === PROBE_TOOL.function.name)) {
          status = VERDICT.TOOL_CALL;
          detail = 'tool call produced';
        } else {
          status = VERDICT.PROSE;
          const preview = res && typeof res.content === 'string' ? res.content.slice(0, 60) : '';
          detail = `prose instead of tool call${preview ? `: "${preview}"` : ''}`;
        }
      } catch (err) {
        // Transport error / timeout: NOT evidence of prose (#124 cold-start).
        // Do not cache, do not flag; retry next boot.
        status = VERDICT.UNMEASURED;
        detail = err && err.message;
        this.logger.warn(`[ToolCapabilityProbe] ${candidate.name}: probe errored (${detail}); not caching, will retry next boot.`);
      }

      if (status !== VERDICT.UNMEASURED) {
        diskCache[key] = { status, detail, at: new Date().toISOString() };
        cacheChanged = true;
      }
      results.push({ name: candidate.name, status, detail });
    }

    if (cacheChanged) this._saveCache(diskCache);
    return results;
  }

  /** @private */
  _cacheKey(candidate) {
    const id = (candidate && (candidate.digest || candidate.name)) || 'unknown';
    return `${id}__toolprobe_r${PROBE_REV}`;
  }

  /** @private */
  _loadCache() {
    try {
      const parsed = JSON.parse(fs.readFileSync(this._cacheFile, 'utf8'));
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed;
    } catch (_err) { /* missing/corrupt — start fresh */ }
    return {};
  }

  /** @private */
  _saveCache(cache) {
    try {
      if (!fs.existsSync(this.cacheDir)) fs.mkdirSync(this.cacheDir, { recursive: true });
      const tmp = this._cacheFile + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(cache, null, 2), 'utf8');
      fs.renameSync(tmp, this._cacheFile);
    } catch (err) {
      this.logger.warn(`[ToolCapabilityProbe] Failed to persist probe cache: ${err.message}`);
    }
  }
}

module.exports = { ToolCapabilityProbe, VERDICT };
