/**
 * SPDX-License-Identifier: AGPL-3.0-only
 * Copyright (C) 2026 Moltagent contributors
 *
 * capability-classes — The shared vocabulary for "what can this model do",
 * answered the same way for a local Ollama model and a cloud API model.
 *
 * Problem:
 *   Cleanup A senses local capability from Ollama's `/api/show` `capabilities`
 *   array and partitions the pool inside ModelScout. Cloud players have no
 *   `/api/show`, so their capability comes from a per-provider descriptor. Left
 *   apart, "is this model tool-capable" would be answered by two different code
 *   paths with two different notions of a capability class — the seam where the
 *   local and cloud rosters would drift.
 *
 * Pattern:
 *   Both sources converge on one shape: a `capabilities` array in Ollama's
 *   vocabulary (`completion`, `tools`, `vision`, `embedding`, `thinking`). Local
 *   models carry it from the probe; cloud models get it from the descriptor
 *   (see cloud-model-descriptor.js). This module is the single set of predicates
 *   over that array, so the same question — text-generation? tool-capable? — has
 *   one answer for any player, local or cloud. Capability is read from what a
 *   model declares, never inferred from its family name (NO REGEX FOR
 *   INTELLIGENCE); the declared array is the input, this module only classifies.
 *
 *   Two text-generation predicates exist on purpose. `isTextGeneration` is the
 *   honest class membership (a multimodal generalist that also does vision is
 *   still a text generator). `isDedicatedTextGenerator` is a *selection policy*
 *   the local roster applies — it excludes vision/embedding specialists, because
 *   a local vision model (llava) is a poor general chat model. Cloud multimodal
 *   generalists (Claude) are text-generators and tool-capable regardless of also
 *   declaring vision, so the cloud tools gate keys on `isToolCapable`.
 *
 * Dependency Map:
 *   src/lib/providers/capability-classes.js
 *     ← src/lib/providers/model-scout.js       (local capability partition)
 *     ← src/lib/providers/cloud-model-descriptor.js (cloud capability lookup)
 *     ← src/lib/llm/router.js                   (cloud tools capability gate)
 *     ← (no internal imports — pure, leaf module)
 *
 * @module providers/capability-classes
 * @license AGPL-3.0
 */

'use strict';

/**
 * Declared-capability tokens. These mirror Ollama's `/api/show` `capabilities`
 * vocabulary; the cloud descriptor declares the same tokens so one predicate
 * set spans local and cloud.
 */
const CAPABILITY = Object.freeze({
  COMPLETION: 'completion',
  TOOLS: 'tools',
  VISION: 'vision',
  EMBEDDING: 'embedding',
  THINKING: 'thinking',
});

/**
 * Capability classes — the partitions a model may belong to. A model can belong
 * to several (a multimodal tool-caller is text-generation + tool-capable +
 * vision); embedding is disjoint from text-generation.
 */
const CLASS = Object.freeze({
  TEXT_GENERATION: 'text-generation',
  TOOL_CAPABLE: 'tool-capable',
  VISION: 'vision',
  EMBEDDING: 'embedding',
});

/**
 * Normalize a declared-capabilities array: coerce to lowercase strings and,
 * when nothing is declared, default to text-generation so a model with an
 * unreadable capability line is treated as chat-capable rather than dark. This
 * matches ModelScout's never-go-dark default for a failed `/api/show`.
 * @param {string[]|null|undefined} capabilities
 * @returns {string[]}
 */
function normalizeCapabilities(capabilities) {
  if (!Array.isArray(capabilities) || capabilities.length === 0) {
    return [CAPABILITY.COMPLETION];
  }
  return capabilities.map(c => String(c).toLowerCase());
}

/** @param {string[]} caps @param {string} cap */
function hasCapability(caps, cap) {
  return normalizeCapabilities(caps).includes(cap);
}

/** Whether the model produces embeddings (disjoint from text-generation). */
function isEmbedding(capabilities) {
  return hasCapability(capabilities, CAPABILITY.EMBEDDING);
}

/** Whether the model declares vision (additive — may also be a text generator). */
function hasVision(capabilities) {
  return hasCapability(capabilities, CAPABILITY.VISION);
}

/**
 * Honest text-generation membership: declares completion and is not an
 * embedding model. A multimodal generalist counts (vision is additive).
 */
function isTextGeneration(capabilities) {
  const caps = normalizeCapabilities(capabilities);
  return caps.includes(CAPABILITY.COMPLETION) && !caps.includes(CAPABILITY.EMBEDDING);
}

/**
 * The local roster's stricter text-job policy: a dedicated text generator that
 * is neither a vision nor an embedding specialist. Equivalent to ModelScout's
 * original `_isTextGen` — kept here so the policy has one home.
 */
function isDedicatedTextGenerator(capabilities) {
  return isTextGeneration(capabilities) && !hasVision(capabilities);
}

/**
 * Whether the model can call tools: a text generator that declares `tools`.
 * Vision-additive generalists (Claude) qualify; embedding models do not. This
 * is the predicate the cloud tools gate keys on.
 */
function isToolCapable(capabilities) {
  return isTextGeneration(capabilities) && hasCapability(capabilities, CAPABILITY.TOOLS);
}

/**
 * The set of capability classes a declared-capabilities array belongs to.
 * Consistent for a local model (probe-derived caps) and a cloud model
 * (descriptor-derived caps): the same array yields the same classes.
 * @param {string[]} capabilities
 * @returns {string[]} subset of CLASS values, stable order
 */
function classesOf(capabilities) {
  const caps = normalizeCapabilities(capabilities);
  const classes = [];
  if (isTextGeneration(caps)) classes.push(CLASS.TEXT_GENERATION);
  if (isToolCapable(caps)) classes.push(CLASS.TOOL_CAPABLE);
  if (hasVision(caps)) classes.push(CLASS.VISION);
  if (isEmbedding(caps)) classes.push(CLASS.EMBEDDING);
  return classes;
}

module.exports = {
  CAPABILITY,
  CLASS,
  normalizeCapabilities,
  hasCapability,
  isEmbedding,
  hasVision,
  isTextGeneration,
  isDedicatedTextGenerator,
  isToolCapable,
  classesOf,
};
