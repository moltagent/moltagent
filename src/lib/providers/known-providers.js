'use strict';

/**
 * Known Providers Registry
 *
 * A lightweight metadata lookup table mapping provider type names to their
 * defaults and capabilities. Used by CockpitManager when parsing custom player
 * definitions to resolve adapter keys and fill in missing endpoint/protocol
 * fields without instantiating any provider class.
 *
 * This is intentionally separate from llm/providers/index.js, which is a
 * factory registry. This file carries no class references.
 *
 * @module providers/known-providers
 */

const KNOWN_PROVIDERS = {
  // ---------------------------------------------------------------------------
  // Local providers (no auth required, endpoint resolved from env/config)
  // ---------------------------------------------------------------------------
  ollama: {
    endpoint: null,           // Uses OLLAMA_URL from env/config
    protocol: 'openai',
    auth: false,
    local: true,
    adapter: 'ollama',        // Maps to ADAPTERS key in llm/providers/index.js
    description: 'Local Ollama instance',
  },
  'llama-cpp': {
    endpoint: null,
    protocol: 'openai',
    auth: false,
    local: true,
    adapter: 'openai-compatible',
    description: 'llama.cpp server (local)',
  },
  vllm: {
    endpoint: null,
    protocol: 'openai',
    auth: false,
    local: true,
    adapter: 'openai-compatible',
    description: 'vLLM server (local)',
  },

  // ---------------------------------------------------------------------------
  // Cloud providers
  // ---------------------------------------------------------------------------
  anthropic: {
    endpoint: 'https://api.anthropic.com',
    protocol: 'anthropic',
    auth: true,
    local: false,
    adapter: 'anthropic',
    description: 'Anthropic Claude models',
  },
  openai: {
    endpoint: 'https://api.openai.com/v1',
    protocol: 'openai',
    auth: true,
    local: false,
    adapter: 'openai',
    description: 'OpenAI GPT models',
  },
  perplexity: {
    endpoint: 'https://api.perplexity.ai',
    protocol: 'openai',
    auth: true,
    local: false,
    adapter: 'openai-compatible',
    description: 'Perplexity search-augmented models',
  },
  mistral: {
    endpoint: 'https://api.mistral.ai/v1',
    protocol: 'openai',
    auth: true,
    local: false,
    adapter: 'mistral',
    description: 'Mistral AI models (EU)',
  },
  deepseek: {
    endpoint: 'https://api.deepseek.com/v1',
    protocol: 'openai',
    auth: true,
    local: false,
    adapter: 'deepseek',
    description: 'DeepSeek models',
  },
  groq: {
    endpoint: 'https://api.groq.com/openai/v1',
    protocol: 'openai',
    auth: true,
    local: false,
    adapter: 'groq',
    description: 'Groq inference (fast)',
  },
  together: {
    endpoint: 'https://api.together.xyz/v1',
    protocol: 'openai',
    auth: true,
    local: false,
    adapter: 'together',
    description: 'Together AI (open models)',
  },
  fireworks: {
    endpoint: 'https://api.fireworks.ai/inference/v1',
    protocol: 'openai',
    auth: true,
    local: false,
    adapter: 'openai-compatible',
    description: 'Fireworks AI (fast inference)',
  },
  openrouter: {
    endpoint: 'https://openrouter.ai/api/v1',
    protocol: 'openai',
    auth: true,
    local: false,
    adapter: 'openai-compatible',
    description: 'OpenRouter (multi-provider gateway)',
  },
  xai: {
    endpoint: 'https://api.x.ai/v1',
    protocol: 'openai',
    auth: true,
    local: false,
    adapter: 'openai-compatible',
    description: 'xAI Grok models',
  },
  google: {
    endpoint: 'https://generativelanguage.googleapis.com/v1beta/openai',
    protocol: 'openai',
    auth: true,
    local: false,
    adapter: 'google',
    description: 'Google Gemini models (via OpenAI-compatible endpoint)',
  },
};

/**
 * Look up default metadata for a provider type by name.
 * The lookup is case-insensitive.
 *
 * @param {string} typeName - Provider type name (e.g. 'ollama', 'PERPLEXITY')
 * @returns {Object|null} Provider defaults object, or null if not recognised
 */
function getProviderDefaults(typeName) {
  if (typeof typeName !== 'string') return null;
  return KNOWN_PROVIDERS[typeName.toLowerCase()] || null;
}

/**
 * Return all registered provider type names.
 *
 * @returns {string[]}
 */
function getKnownProviderTypes() {
  return Object.keys(KNOWN_PROVIDERS);
}

module.exports = { KNOWN_PROVIDERS, getProviderDefaults, getKnownProviderTypes };
