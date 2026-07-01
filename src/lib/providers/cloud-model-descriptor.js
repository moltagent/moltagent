/**
 * SPDX-License-Identifier: AGPL-3.0-only
 * Copyright (C) 2026 Moltagent contributors
 *
 * cloud-model-descriptor — The Declared tier for cloud players: a datasheet of
 * published capability facts, so the capability gate spans cloud the same way
 * Cleanup A's `/api/show` probe spans local.
 *
 * Problem:
 *   A cloud model has no `/api/show` to ask. Its capabilities (does it call
 *   tools, does it see images, how large is its context) are published facts,
 *   not runtime-sensible ones. Without them, the router treats every cloud
 *   provider as tool-capable and a non-tool cloud model (an embedding endpoint)
 *   would sit in the tools roster it has no business serving — the cloud twin of
 *   the local roster contamination Cleanup A fixed.
 *
 * Pattern:
 *   Two tiers, both honest datasheets — recorded truth about a small, fixed,
 *   publicly-specified roster the deployer chose, NOT a hunch inferred from a
 *   model name (that is the affinity-map anti-pattern this pack retired).
 *
 *   - ADAPTER_PROFILES: keyed on the adapter the deployer explicitly configured
 *     (`anthropic`, `openai`, ...). This is the API contract — "the Anthropic
 *     Messages API supports tool use and vision" is a fact about the endpoint,
 *     stable across model versions, so it survives a model bump without edits.
 *   - MODEL_OVERRIDES: keyed on an exact model name, for facts that vary within
 *     a provider (an embedding-only model; a precise context window). Layered on
 *     top of the adapter profile.
 *
 *   An adapter/model with no entry is reported as `source: 'unknown'` (caller
 *   logs the gap and adds it to the datasheet) rather than guessed from its
 *   name. Capabilities are emitted in the shared vocabulary so the same
 *   predicates in capability-classes.js classify local and cloud alike.
 *
 * Dependency Map:
 *   src/lib/providers/cloud-model-descriptor.js
 *     → src/lib/providers/capability-classes.js (normalizeCapabilities)
 *     ← src/lib/llm/router.js                    (cloud tools capability gate)
 *
 * @module providers/cloud-model-descriptor
 * @license AGPL-3.0
 */

'use strict';

const { normalizeCapabilities } = require('./capability-classes');

/**
 * Adapter-level capability profiles. Keyed by the `adapter` id from the
 * provider config (config/moltagent-providers.yaml → provider.adapter, mirrored
 * by the ADAPTERS registry in src/lib/llm/providers/index.js). Each entry is a
 * published fact about that provider's chat API. `capabilities` uses the shared
 * vocabulary; `contextWindow`/`structuredOutput` are declared for downstream
 * consumers (Session 2+) and are not read by the tools gate.
 *
 * A maintainer adds a row here when they wire up a new cloud provider.
 */
const ADAPTER_PROFILES = Object.freeze({
  anthropic: { capabilities: ['completion', 'tools', 'vision'], contextWindow: 200000, structuredOutput: true },
  openai: { capabilities: ['completion', 'tools', 'vision'], contextWindow: 128000, structuredOutput: true },
  google: { capabilities: ['completion', 'tools', 'vision'], contextWindow: 1000000, structuredOutput: true },
  // OpenAI-compatible chat APIs that implement function/tool calling. Vision
  // varies by the specific model behind the endpoint, so it is not claimed at
  // the adapter level; a MODEL_OVERRIDES row adds it where true.
  deepseek: { capabilities: ['completion', 'tools'], contextWindow: 64000, structuredOutput: true },
  mistral: { capabilities: ['completion', 'tools'], contextWindow: 128000, structuredOutput: true },
  groq: { capabilities: ['completion', 'tools'], contextWindow: 128000, structuredOutput: true },
  together: { capabilities: ['completion', 'tools'], contextWindow: 32000, structuredOutput: false },
  fireworks: { capabilities: ['completion', 'tools'], contextWindow: 32000, structuredOutput: false },
  openrouter: { capabilities: ['completion', 'tools'], contextWindow: 200000, structuredOutput: true },
  xai: { capabilities: ['completion', 'tools'], contextWindow: 131072, structuredOutput: true },
});

/**
 * Per-model overrides layered on the adapter profile. Keyed by exact model name.
 * Present here only where a model deviates from its adapter's profile — an
 * embedding endpoint that cannot chat or call tools, a differing context window.
 * These are recorded published facts, not name-pattern guesses.
 */
const MODEL_OVERRIDES = Object.freeze({
  // OpenAI embedding endpoints: served through the `openai` adapter but neither
  // chat nor tool-capable — the exact cloud contamination the gate excludes.
  'text-embedding-3-small': { capabilities: ['embedding'], contextWindow: 8191, structuredOutput: false },
  'text-embedding-3-large': { capabilities: ['embedding'], contextWindow: 8191, structuredOutput: false },
});

/**
 * Look up the declared capabilities of a cloud model from the datasheet.
 *
 * A model-name override wins over the adapter profile. When neither is known,
 * `source` is `'unknown'` and `capabilities` is null — the caller decides how to
 * treat an unrecognized cloud model (the router keeps it in the roster but logs
 * the gap) rather than this module inventing a capability from the name.
 *
 * @param {Object} [player]
 * @param {string} [player.adapter] - Adapter id (e.g. 'anthropic').
 * @param {string} [player.model] - Model name (e.g. 'claude-opus-4-6').
 * @returns {{
 *   capabilities: string[]|null,
 *   contextWindow: number|null,
 *   structuredOutput: boolean|null,
 *   source: 'model-override'|'adapter'|'unknown'
 * }}
 */
function cloudCapabilities({ adapter, model } = {}) {
  const override = (typeof model === 'string' && MODEL_OVERRIDES[model]) || null;
  const profile = (typeof adapter === 'string' && ADAPTER_PROFILES[adapter]) || null;

  if (!override && !profile) {
    return { capabilities: null, contextWindow: null, structuredOutput: null, source: 'unknown' };
  }

  const merged = { ...(profile || {}), ...(override || {}) };
  return {
    capabilities: normalizeCapabilities(merged.capabilities),
    contextWindow: Number.isFinite(merged.contextWindow) ? merged.contextWindow : null,
    structuredOutput: typeof merged.structuredOutput === 'boolean' ? merged.structuredOutput : null,
    source: override ? 'model-override' : 'adapter',
  };
}

module.exports = {
  ADAPTER_PROFILES,
  MODEL_OVERRIDES,
  cloudCapabilities,
};
