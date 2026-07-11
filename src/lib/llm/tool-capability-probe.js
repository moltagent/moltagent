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
 * Admission gate + idle lane (#285): at boot the probe measures ONLY the
 *   models the resolver actually seats for tool-capable jobs (`bootSet`); every
 *   other tool-capable candidate, plus any seated model whose only verdict is
 *   from a prior PROBE_REV, is drained one-per-pulse by the heartbeat idle lane
 *   (getUnmeasuredCandidates/measureOne) instead of at boot. A prior-rev verdict
 *   seats PROVISIONALLY (its flag applies now; a re-measurement in idle
 *   corrects it), so a PROBE_REV bump never turns into a boot-time re-measure
 *   stampede against serving. Between measurement items the loop yields to a
 *   live turn via the shared serving gate — the same one-serving-signal home
 *   the heartbeat reads (shared/ollama-gate). Second instance of the #260
 *   measure-vs-serve contention class; this is the admission control #260
 *   deferred.
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
// Since #285 a REV bump no longer re-measures at BOOT: the old-rev verdict
// seats provisionally and the re-measure happens in the idle lane.
const PROBE_REV = 2;

// How long a probe measurement will wait for a live turn to finish before it
// proceeds anyway (admission gate, #285). Generous — measurement must eventually
// happen; the gate trades its latency, never its existence.
const DEFAULT_SERVING_WAIT_MS = 3 * 60 * 1000;

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
   * @param {Object} [opts.servingGate] - The shared serving-active admission
   *   gate (shared/ollama-gate). When set, the measurement loop yields to a live
   *   turn before each candidate and between the two items (#285). Null → no
   *   yielding (pre-#285 behaviour; tests that don't exercise the gate omit it).
   * @param {number} [opts.servingWaitMs] - Cap on the per-yield wait before the
   *   probe proceeds anyway. Defaults to DEFAULT_SERVING_WAIT_MS.
   * @param {Object} [opts.logger=console]
   */
  constructor({ chatFn, cacheDir, servingGate, servingWaitMs, logger } = {}) {
    this.chatFn = typeof chatFn === 'function' ? chatFn : null;
    this.cacheDir = cacheDir || path.resolve(process.cwd(), 'data');
    this._cacheFile = path.join(this.cacheDir, CACHE_FILENAME);
    this.logger = logger || console;
    this.servingGate = servingGate && typeof servingGate.isServing === 'function' ? servingGate : null;
    this._servingWaitMs = Number.isFinite(servingWaitMs) && servingWaitMs > 0
      ? servingWaitMs
      : DEFAULT_SERVING_WAIT_MS;

    // The candidate list from the most recent run(), so the heartbeat idle lane
    // can drain the non-boot / provisional candidates without re-deriving it
    // (#285, mirrors GoldenSetProbe._lastCandidates).
    this._lastCandidates = [];

    // Current-rev cache keys seated PROVISIONALLY on a prior-rev verdict this
    // boot (#285): the flag applies now, but the key still needs a current-rev
    // measurement, which the idle lane performs. Cleared per key by measureOne().
    this._provisional = new Set();

    // True only while run()'s boot loop + final cache save are in flight. The
    // idle lane (getUnmeasuredCandidates) no-ops while set, so a boot run() and
    // an idle pulse never interleave their cache writes (mirrors GoldenSetProbe).
    this._running = false;
  }

  /**
   * Probe the boot set once (sequential — one Ollama host serves these) and
   * return a verdict per boot candidate. Candidates outside `bootSet` are
   * retained for the idle lane but not measured here (#285). A boot candidate
   * with only a prior-PROBE_REV verdict seats PROVISIONALLY (its flag returned
   * now, re-measurement deferred to idle) rather than re-measuring at boot.
   *
   * @param {Array<{name: string, digest?: string}>} candidates - the full
   *   tool-capable candidate list (boot set ∪ idle-lane residents).
   * @param {Object} [opts]
   * @param {Array<string>|Set<string>} [opts.bootSet] - model names to measure
   *   at boot (the seated minimal set). Absent → measure all at boot (pre-#285
   *   default; callers that don't scope keep full boot behaviour).
   * @returns {Promise<Array<{name: string, status: string, detail: string, provisional?: boolean}>>}
   *   one entry per boot candidate that was measured or provisionally seated.
   */
  async run(candidates, opts = {}) {
    const list = Array.isArray(candidates) ? candidates.filter(c => c && typeof c.name === 'string') : [];
    this._lastCandidates = list;
    if (list.length === 0 || !this.chatFn) {
      if (!this.chatFn) this.logger.warn('[ToolCapabilityProbe] Missing chatFn; skipping probe.');
      return [];
    }

    const bootNames = opts && opts.bootSet
      ? new Set(Array.isArray(opts.bootSet) ? opts.bootSet : [...opts.bootSet])
      : null;

    // Fence the idle lane out until this boot pass has persisted (mirrors
    // GoldenSetProbe): the skip set isn't final and the save is pending.
    this._running = true;
    const diskCache = this._loadCache();
    let cacheChanged = false;
    const results = [];

    try {
      for (const candidate of list) {
        const key = this._cacheKey(candidate);

        // Not seated: never measured at boot — the idle lane drains it later.
        if (bootNames && !bootNames.has(candidate.name)) continue;

        const cached = diskCache[key];
        if (cached && cached.status && cached.status !== VERDICT.UNMEASURED) {
          results.push({ name: candidate.name, status: cached.status, detail: `${cached.detail || ''} (cached)`.trim() });
          continue;
        }

        // #285: no current-rev verdict, but a prior-rev verdict exists → seat it
        // PROVISIONALLY (apply its flag now), re-measure in idle, not at boot.
        const prior = this._priorRevEntry(diskCache, candidate);
        if (prior) {
          this._provisional.add(key);
          this.logger.log(`[ToolCapabilityProbe] ${candidate.name}: seated provisionally on a prior-rev verdict (${prior.status}); re-measuring in idle.`);
          results.push({
            name: candidate.name,
            status: prior.status,
            detail: `${prior.detail || ''} (provisional, re-measuring in idle)`.trim(),
            provisional: true,
          });
          continue;
        }

        // Genuinely unmeasured (new model, or a prior errored/uncached): measure.
        await this._yieldToServing(candidate.name);
        const { status, detail, complete } = await this._measureCandidate(candidate);
        if (complete) {
          diskCache[key] = { status, detail, at: new Date().toISOString() };
          cacheChanged = true;
        }
        results.push({ name: candidate.name, status, detail });
      }

      if (cacheChanged) this._saveCache(diskCache);
    } finally {
      this._running = false;
    }
    return results;
  }

  /**
   * Measure a single candidate on both items (tool-call, then #168 date
   * grounding). Shared by run() (boot) and measureOne() (idle lane). A transport
   * error on either item → UNMEASURED with complete:false (cold ≠ prose, #124):
   * the caller neither caches nor flags it.
   * @param {{name: string, digest?: string}} candidate
   * @returns {Promise<{status: string, detail: string, complete: boolean}>}
   * @private
   */
  async _measureCandidate(candidate) {
    try {
      const res = await this.chatFn(candidate.name, {
        system: PROBE_SYSTEM,
        messages: [{ role: 'user', content: PROBE_MESSAGE }],
        tools: [PROBE_TOOL],
      });
      const calls = res && Array.isArray(res.toolCalls) ? res.toolCalls : [];
      if (calls.some(tc => tc && tc.name === PROBE_TOOL.function.name)) {
        // Tool-call capable. Yield to a live turn before the second item (#285),
        // then probe date grounding (#168). A throw here (transport) propagates
        // to the catch → UNMEASURED, so a cold host never caches a false failure.
        await this._yieldToServing(candidate.name);
        const date = await this._probeDateGrounding(candidate.name);
        return { status: date.status, detail: date.detail, complete: true };
      }
      const preview = res && typeof res.content === 'string' ? res.content.slice(0, 60) : '';
      return { status: VERDICT.PROSE, detail: `prose instead of tool call${preview ? `: "${preview}"` : ''}`, complete: true };
    } catch (err) {
      // Transport error / timeout: NOT evidence of prose (#124 cold-start).
      const detail = err && err.message;
      this.logger.warn(`[ToolCapabilityProbe] ${candidate.name}: probe errored (${detail}); not caching, will retry.`);
      return { status: VERDICT.UNMEASURED, detail, complete: false };
    }
  }

  /**
   * The tool-capable candidates with no usable current-PROBE_REV verdict: those
   * outside the boot set, plus any seated model seated provisionally on a
   * prior-rev verdict (#285). The heartbeat idle lane drains one per pulse via
   * measureOne(), so capability calibration converges in downtime instead of
   * competing with serving at boot (part C). Consults the on-disk cache, not
   * just this run's provisional set, so a candidate measured on a prior idle
   * pulse is not re-measured.
   * @param {Array<{name: string, digest?: string}>} [candidates] defaults to the
   *   most recent run()'s list.
   * @returns {Array} unmeasured/provisional candidates, input order preserved.
   */
  getUnmeasuredCandidates(candidates) {
    // While a boot run() is measuring, the skip set isn't final and its save is
    // pending — don't let the idle lane act on a moving target.
    if (this._running) return [];
    const source = Array.isArray(candidates) ? candidates : this._lastCandidates;
    const list = (source || []).filter(c => c && typeof c.name === 'string');
    if (list.length === 0) return [];
    const diskCache = this._loadCache();
    return list.filter(c => {
      const key = this._cacheKey(c);
      // A provisional seat still needs a current-rev measurement (#285).
      if (this._provisional.has(key)) return true;
      const cached = diskCache[key];
      return !(cached && cached.status && cached.status !== VERDICT.UNMEASURED);
    });
  }

  /**
   * Measure one candidate and persist a current-PROBE_REV verdict — the idle
   * lane's unit of work (#285), the seat-neutral analogue of GoldenSetProbe's
   * measureOne(). It warms the cache so the NEXT boot's run() serves a current
   * verdict (and applies any now-corrected flag) without measuring; it does not
   * itself reseat. An incomplete (cold) measurement is not cached and stays in
   * getUnmeasuredCandidates() for the next pulse.
   * @param {{name: string, digest?: string}} candidate
   * @returns {Promise<{name: string|null, measured: boolean, status: string, detail: string}>}
   */
  async measureOne(candidate) {
    if (!candidate || typeof candidate.name !== 'string') {
      return { name: null, measured: false, status: VERDICT.UNMEASURED, detail: 'invalid candidate' };
    }
    if (!this.chatFn) {
      return { name: candidate.name, measured: false, status: VERDICT.UNMEASURED, detail: 'no chatFn' };
    }
    await this._yieldToServing(candidate.name);
    const { status, detail, complete } = await this._measureCandidate(candidate);
    if (!complete) {
      return { name: candidate.name, measured: false, status, detail };
    }
    // Load-modify-save so a concurrent write is preserved (runs long after run()).
    const key = this._cacheKey(candidate);
    const diskCache = this._loadCache();
    diskCache[key] = { status, detail, at: new Date().toISOString() };
    this._saveCache(diskCache);
    this._provisional.delete(key);
    return { name: candidate.name, measured: true, status, detail };
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

  /**
   * @private
   * Yield the Ollama slot to a live turn (#285). If the serving gate reports a
   * user turn in flight, wait for it to finish (or the cap) before the next
   * measurement item. No-op when no gate is wired or nothing is serving.
   * @param {string} label - candidate name, for the log line.
   */
  async _yieldToServing(label) {
    if (!this.servingGate || !this.servingGate.isServing()) return;
    this.logger.log(`[ToolCapabilityProbe] probe paused: serving active, yielding (${label})`);
    const r = await this.servingGate.idle(this._servingWaitMs);
    if (r && r.timedOut) {
      this.logger.warn(`[ToolCapabilityProbe] probe resumed after ${this._servingWaitMs}ms cap while still serving — measuring anyway (${label})`);
    } else {
      this.logger.log(`[ToolCapabilityProbe] probe resumed: serving idle (${label})`);
    }
  }

  /**
   * @private
   * The candidate's stable identity in a cache key — the digest when present
   * (survives a re-tag), else the name. The prefix before the `__toolprobe_r*`
   * suffix.
   */
  _candidateId(candidate) {
    return (candidate && (candidate.digest || candidate.name)) || 'unknown';
  }

  /**
   * @private
   * The most recent cached verdict for this model under a DIFFERENT PROBE_REV
   * (#285): same model identity, prior probe revision, a real (non-UNMEASURED)
   * status. Used to seat a model provisionally when its current-rev verdict is
   * missing, instead of re-measuring at boot. Returns the cache entry, or null.
   * @param {Object} diskCache
   * @param {{name: string, digest?: string}} candidate
   * @returns {{status: string, detail?: string, at?: string}|null}
   */
  _priorRevEntry(diskCache, candidate) {
    const currentKey = this._cacheKey(candidate);
    const id = this._candidateId(candidate);
    let best = null;
    for (const [k, v] of Object.entries(diskCache)) {
      if (k === currentKey) continue;
      if (!v || !v.status || v.status === VERDICT.UNMEASURED) continue;
      const sep = k.lastIndexOf('__');
      if (sep < 0 || k.slice(0, sep) !== id) continue;
      if (!best || (v.at && (!best.at || v.at > best.at))) best = v;
    }
    return best || null;
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
