// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Placeholder detection — the canonical "is this value deployer documentation
 * rather than configuration?" primitive.
 *
 * ARCHITECTURE BRIEF
 * Problem: The repo ships `.example` configs and `YOUR_*` env-var defaults as
 *   documentation for the deployer. Those literals are truthy, so an unedited
 *   deployment reads a placeholder as a real value — local inference dies on a
 *   `YOUR_OLLAMA_IP` host (#100), and a `YOUR_NC_ADMIN_USER` share grants a
 *   write+manage ACL to a nonexistent user on the agent's own control surface
 *   (#148). Same generating function as #146: deployment state leaking through
 *   defaults.
 * Pattern: One definition of "placeholder" so the rule travels canonically
 *   (TAO: signals keep custody). A `YOUR_*` value is the ABSENCE of
 *   configuration, treated identically everywhere — `config.js` collapses it to
 *   '' at the env boundary, `resolveOllamaEndpoint` falls back to localhost, the
 *   voice path disables. Adding a deployment language never edits this file: the
 *   marker is a fixed code literal, not natural-language matching (Rule 1).
 * Key deps: none — a true leaf, safe to require from `config.js` (itself a leaf)
 *   and from `resolve-ollama-endpoint.js`.
 * Data flow: callers pass a resolved value → isPlaceholder() → boolean.
 * Dependency map: depended on by config.js (envStr) and
 *   shared/resolve-ollama-endpoint.js (which re-exports `_isPlaceholder` for its
 *   existing importers, e.g. the webhook-server voice path).
 */

'use strict';

/**
 * The marker that identifies a deployer-documentation placeholder. Any value
 * containing it (e.g. `YOUR_OLLAMA_IP`, `YOUR_NC_ADMIN_USER`) is treated as
 * unset rather than as configuration.
 * @type {string}
 */
const PLACEHOLDER_MARKER = 'YOUR_';

/**
 * @param {*} value - any resolved config/env value
 * @returns {boolean} true if the value is a `YOUR_*` placeholder
 */
function isPlaceholder(value) {
  return typeof value === 'string' && value.includes(PLACEHOLDER_MARKER);
}

module.exports = { isPlaceholder, PLACEHOLDER_MARKER };
