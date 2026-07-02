/**
 * SPDX-License-Identifier: AGPL-3.0-only
 * Copyright (C) 2026 Moltagent contributors
 *
 * emitOllamaTimings — One extraction of Ollama's server-side timing fields,
 * shared by both adapter necks (Layer 3, niche assignment foundation).
 *
 * Problem:
 *   Ollama reports `load_duration` / `total_duration` / `eval_duration`
 *   (nanoseconds) in every /api/chat response, but both adapters read the
 *   body and keep only content + token counts. `load_duration` is the free,
 *   portable carrying-capacity signal (design doc §7): a large value means
 *   the model was not resident and the box paid a cold load. Nothing
 *   upstream ever sees it.
 *
 * Pattern:
 *   The raw response body exists in exactly two places — OllamaProvider
 *   (generate family) and OllamaToolsProvider (chat family). Rule 5: capture
 *   at the necks, once each, through one shared helper, and emit to a single
 *   injected sink (NicheAssignment's residency ledger). The sink never
 *   throws into the request path: observability must not break inference.
 *
 *   The `calibration` flag marks scheduled measurement traffic — the
 *   golden-set probe's boot burst, the local judge's idle-cycle probes, and
 *   any future fixture — as one structural class (the same shape as
 *   ModelScorecard's `synthetic` flag). Calibration loads still feed the
 *   residency ledger (they are real loads, real evidence of what co-fits);
 *   they are excluded from thrash detection, whose failure mode is felt
 *   latency on organic requests only.
 *
 * Data Flow:
 *   OllamaProvider.generate / OllamaToolsProvider.chat
 *     → response.json() → emitOllamaTimings(sink, data, requestedModel, calibration)
 *       → sink({ model, loadDurationMs, totalDurationMs, evalDurationMs, calibration })
 *         → NicheAssignment.recordTiming (residency ledger, thrash oracle)
 *
 * Dependency Map:
 *   src/lib/llm/ollama-timings.js
 *     ← (no internal imports — standalone, testable in isolation)
 *
 * @module llm/ollama-timings
 * @license AGPL-3.0
 */

'use strict';

const NS_PER_MS = 1e6;

/**
 * Extract Ollama server-side timings from a parsed /api/chat response and
 * emit them to the sink. Ollama reports durations in nanoseconds; the sink
 * receives milliseconds. Absent fields emit as 0 (a warm response can omit
 * or zero `load_duration`). Never throws: a broken sink must not break the
 * request that carried the measurement.
 *
 * @param {Function|null|undefined} sink - ({ model, loadDurationMs,
 *   totalDurationMs, evalDurationMs, calibration }) => void
 * @param {Object} data - Parsed Ollama response body
 * @param {string} [requestedModel] - Model named in the request; fallback
 *   when the response omits `model` (the response's own name wins — the
 *   response is the custodian of which model actually served).
 * @param {boolean} [calibration=false] - Scheduled measurement traffic
 *   (probe/judge), excluded from thrash detection by the sink.
 */
function emitOllamaTimings(sink, data, requestedModel, calibration = false) {
  if (typeof sink !== 'function' || !data || typeof data !== 'object') return;
  const ms = (ns) => (Number.isFinite(ns) && ns > 0 ? ns / NS_PER_MS : 0);
  try {
    sink({
      model: (typeof data.model === 'string' && data.model) ? data.model : (requestedModel || null),
      loadDurationMs: ms(data.load_duration),
      totalDurationMs: ms(data.total_duration),
      evalDurationMs: ms(data.eval_duration),
      calibration: !!calibration,
    });
  } catch (_err) {
    // Observability never breaks the request path.
  }
}

module.exports = { emitOllamaTimings };
