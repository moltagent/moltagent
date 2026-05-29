/**
 * Resolve the effective Ollama endpoint URL from layered sources.
 *
 * Single canonical resolver for every Ollama provider construction site.
 * Lives here because the same precedence question recurs at five places
 * (providers registry, three OllamaToolsProvider sites in webhook-server,
 * heartbeat-manager player registration) and any of them silently picking
 * a YOUR_* placeholder kills local inference.
 *
 * Precedence (highest first):
 *   1. OLLAMA_URL env var, if set and not a YOUR_* placeholder
 *   2. candidate (typically YAML/JSON config value), if not a placeholder
 *   3. defaultUrl ('http://localhost:11434' unless caller overrides)
 *
 * A YOUR_* literal in any candidate is treated as the absence of
 * configuration, not configuration. The placeholder is documentation for
 * the deployer; the resolver makes the code agree with that intent.
 *
 * @module shared/resolve-ollama-endpoint
 */

'use strict';

const DEFAULT_FALLBACK = 'http://localhost:11434';
const PLACEHOLDER_MARKER = 'YOUR_';

const _warnedOnce = new Set();

function _isPlaceholder(value) {
  return typeof value === 'string' && value.includes(PLACEHOLDER_MARKER);
}

function _warnOnce(key, message, logger) {
  if (_warnedOnce.has(key)) return;
  _warnedOnce.add(key);
  (logger?.warn || console.warn).call(logger || console, message);
}

/**
 * @param {string|null|undefined} candidate - Endpoint from config (YAML/JSON/inline)
 * @param {Object} [options]
 * @param {string} [options.envUrl=process.env.OLLAMA_URL] - Env var override
 * @param {string} [options.defaultUrl='http://localhost:11434'] - Final fallback
 * @param {Object} [options.logger=console] - Logger for warn-once placeholder notice
 * @param {string} [options.source] - Caller label for diagnostic warnings
 * @returns {string} Trailing-slash-stripped endpoint URL
 */
function resolveOllamaEndpoint(candidate, options = {}) {
  const envUrl = options.envUrl !== undefined ? options.envUrl : process.env.OLLAMA_URL;
  const defaultUrl = options.defaultUrl || DEFAULT_FALLBACK;
  const logger = options.logger || console;
  const source = options.source || 'ollama';

  if (envUrl && !_isPlaceholder(envUrl)) {
    return envUrl.replace(/\/$/, '');
  }

  if (envUrl && _isPlaceholder(envUrl)) {
    _warnOnce(
      `env:${envUrl}`,
      `[resolveOllamaEndpoint] OLLAMA_URL is a placeholder ("${envUrl}") — ignoring`,
      logger
    );
  }

  if (candidate && !_isPlaceholder(candidate)) {
    return candidate.replace(/\/$/, '');
  }

  if (candidate && _isPlaceholder(candidate)) {
    _warnOnce(
      `${source}:${candidate}`,
      `[resolveOllamaEndpoint] ${source} endpoint is a placeholder ("${candidate}") — falling back to ${defaultUrl}`,
      logger
    );
  }

  return defaultUrl.replace(/\/$/, '');
}

/** Test helper — resets the warn-once latch. */
function _resetWarnedForTests() {
  _warnedOnce.clear();
}

module.exports = {
  resolveOllamaEndpoint,
  _resetWarnedForTests,
  DEFAULT_FALLBACK,
  PLACEHOLDER_MARKER,
};
