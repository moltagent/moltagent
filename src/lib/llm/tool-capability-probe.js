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
 * Second item (#168, PR-4): a model that produces a tool call can still anchor
 *   a relative date to its training prior (qwen3:8b emits ~October 2023 for
 *   "tomorrow"). After the tool-call check passes, the probe sends one canned
 *   scheduling request whose `start` schema carries the SAME live-date anchor
 *   production ships (groundedStartDescription) against a FIXED injected
 *   "today"; a start outside a sane window of that today is DATE_UNGROUNDED —
 *   demoted like prose. The fixture measures the model as-shipped: if the
 *   grounding text grounds it, this is a regression pin; if not, the seat
 *   demotes honestly and the consequence is named, not tuned away (#275).
 *
 * Data Flow:
 *   webhook-server (boot, inside the ModelScout .then, after the golden-set
 *   probe so the post-probe resolver re-log reflects both — NOTE(#233))
 *     → probe.run(candidates) → { name, status: 'tool-call'|'prose'|'date-ungrounded'|'unmeasured' }
 *     → modelResolver.markToolIncapable(name) per prose OR date-ungrounded result
 *
 * Dependency Map:
 *   src/lib/llm/tool-capability-probe.js
 *     ← src/lib/agent/calendar-date-grounding (groundedStartDescription, isoDateInZone)
 *       — the ONE pure leaf util so the probe's date anchor is byte-identical to
 *         what production injects; callers still inject chatFn (no transport here).
 *
 * @module llm/tool-capability-probe
 * @license AGPL-3.0
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { groundedStartDescription, isoDateInZone } = require('../agent/calendar-date-grounding');

const CACHE_FILENAME = 'tool-capability-probe.json';

// Bump when the probe schema/instruction or pass criterion changes — old
// cached verdicts then re-measure instead of masquerading as comparable.
// r2 (#168, PR-4): adds the relative-date grounding item below.
const PROBE_REV = 2;

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

// --- Relative-date grounding item (#168, PR-4) -----------------------------
// A model can produce a tool call and still anchor "tomorrow" to its training
// prior (qwen3:8b → ~October 2023). This item measures the SHIPPED grounding
// mechanism: a schedule tool whose `start` carries the exact live-date anchor
// production injects (groundedStartDescription), against a FIXED injected
// "today" so the verdict is deterministic and cacheable by PROBE_REV.
const PROBE_DATE_TODAY = new Date('2026-06-15T12:00:00Z'); // fixed clock; UTC.
const PROBE_DATE_TZ = 'UTC';
const PROBE_DATE_TODAY_ISO = isoDateInZone(PROBE_DATE_TODAY, PROBE_DATE_TZ);
const PROBE_DATE_TOMORROW_ISO = isoDateInZone(new Date(PROBE_DATE_TODAY.getTime() + 86400000), PROBE_DATE_TZ);

// Sane window: a grounded model lands on or near today (tomorrow = +1). The
// window catches the gross failure — a start years off (2023) — without
// demanding tomorrow-exact precision. Inclusive [today-1d, today+7d].
const PROBE_DATE_WINDOW_MS = 7 * 86400000;

const PROBE_DATE_TOOL = {
  type: 'function',
  function: {
    name: 'schedule_event',
    description: 'Schedule an event at a given time. Call this — do not answer in text.',
    parameters: {
      type: 'object',
      properties: {
        start: {
          type: 'string',
          description: groundedStartDescription('Start datetime as ISO 8601 string', {
            today: PROBE_DATE_TODAY_ISO,
            tomorrow: PROBE_DATE_TOMORROW_ISO,
            weekday: new Intl.DateTimeFormat('en-US', { weekday: 'long', timeZone: PROBE_DATE_TZ }).format(PROBE_DATE_TODAY),
          }),
        },
      },
      required: ['start'],
    },
  },
};

const PROBE_DATE_SYSTEM = `Today is ${PROBE_DATE_TODAY_ISO}. You are a scheduling assistant; call the schedule_event function with an ISO 8601 start.`;
const PROBE_DATE_MESSAGE = 'Schedule a meeting tomorrow at 15:00.';

/** Probe verdicts. */
const VERDICT = {
  TOOL_CALL: 'tool-call',   // produced a tool call AND grounded the relative date
  PROSE: 'prose',           // answered without a usable tool call
  DATE_UNGROUNDED: 'date-ungrounded', // called a tool but anchored the date off-window (e.g. 2023)
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
          // Tool-call capable. Now the second item: can it ground a relative
          // date (#168)? A throw here (transport) propagates to the catch →
          // UNMEASURED, so a cold host never caches a false date failure.
          const date = await this._probeDateGrounding(candidate.name);
          status = date.status;
          detail = date.detail;
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

  /**
   * The relative-date grounding item (#168, PR-4). Sends one canned scheduling
   * request against a FIXED injected "today", with the shipped grounding anchor
   * in the `start` schema. A tool call whose start lands in the sane window is
   * grounded (TOOL_CALL); a start years off (the 2023 anchor) is DATE_UNGROUNDED
   * and demotes the seat like prose. A transport error throws to the caller,
   * which records UNMEASURED (not cached) — cold is not an ungrounded date.
   *
   * @param {string} model
   * @returns {Promise<{status: string, detail: string}>}
   * @private
   */
  async _probeDateGrounding(model) {
    const res = await this.chatFn(model, {
      system: PROBE_DATE_SYSTEM,
      messages: [{ role: 'user', content: PROBE_DATE_MESSAGE }],
      tools: [PROBE_DATE_TOOL],
    });
    const calls = res && Array.isArray(res.toolCalls) ? res.toolCalls : [];
    const call = calls.find(tc => tc && tc.name === PROBE_DATE_TOOL.function.name) || calls[0];
    if (!call) {
      return { status: VERDICT.DATE_UNGROUNDED, detail: 'date probe: prose, no scheduling call' };
    }
    const args = typeof call.arguments === 'string'
      ? (() => { try { return JSON.parse(call.arguments); } catch (_e) { return {}; } })()
      : (call.arguments || {});
    const startStr = args.start;
    const startMs = startStr ? Date.parse(startStr) : NaN;
    if (!startStr || Number.isNaN(startMs)) {
      return { status: VERDICT.DATE_UNGROUNDED, detail: `date probe: no parseable start (${startStr || 'absent'})` };
    }
    const todayMs = PROBE_DATE_TODAY.getTime();
    const grounded = startMs >= todayMs - 86400000 && startMs <= todayMs + PROBE_DATE_WINDOW_MS;
    const startDay = String(startStr).slice(0, 10);
    return grounded
      ? { status: VERDICT.TOOL_CALL, detail: `tool call + date grounded (start ${startDay})` }
      : { status: VERDICT.DATE_UNGROUNDED, detail: `date anchored off-window: start ${startDay}, today ${PROBE_DATE_TODAY_ISO}` };
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
