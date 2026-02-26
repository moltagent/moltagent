/**
 * Provider Registry
 *
 * Exports all provider adapters and factory function.
 *
 * @module llm/providers
 * @version 1.0.0
 */

const BaseProvider = require('./base-provider');
const OllamaProvider = require('./ollama-provider');
const OpenAICompatibleProvider = require('./openai-compatible-provider');
const AnthropicProvider = require('./anthropic-provider');
const GoogleProvider = require('./google-provider');

/**
 * Provider adapter registry
 * Maps adapter names to their classes and default configurations
 */
const ADAPTERS = {
  ollama: {
    class: OllamaProvider,
    defaults: {
      endpoint: 'http://localhost:11434',
      model: 'phi4-mini'
    }
  },
  openai: {
    class: OpenAICompatibleProvider,
    defaults: {
      endpoint: 'https://api.openai.com/v1',
      model: 'gpt-4o',
      costModel: {
        type: 'per_token',
        inputPer1M: 2.50,
        outputPer1M: 10.00
      }
    }
  },
  anthropic: {
    class: AnthropicProvider,
    defaults: {
      endpoint: 'https://api.anthropic.com',
      model: 'claude-sonnet-4-20250514',
      costModel: {
        type: 'per_token',
        inputPer1M: 3.00,
        outputPer1M: 15.00
      }
    }
  },
  deepseek: {
    class: OpenAICompatibleProvider,
    defaults: {
      endpoint: 'https://api.deepseek.com/v1',
      model: 'deepseek-chat',
      costModel: {
        type: 'per_token',
        inputPer1M: 0.14,
        outputPer1M: 0.28
      }
    }
  },
  mistral: {
    class: OpenAICompatibleProvider,
    defaults: {
      endpoint: 'https://api.mistral.ai/v1',
      model: 'mistral-small-latest',
      costModel: {
        type: 'per_token',
        inputPer1M: 0.20,
        outputPer1M: 0.60
      }
    }
  },
  google: {
    class: GoogleProvider,
    defaults: {
      endpoint: 'https://generativelanguage.googleapis.com',
      model: 'gemini-1.5-flash',
      costModel: {
        type: 'per_token',
        inputPer1M: 0.075,
        outputPer1M: 0.30
      }
    }
  },
  groq: {
    class: OpenAICompatibleProvider,
    defaults: {
      endpoint: 'https://api.groq.com/openai/v1',
      model: 'llama-3.3-70b-versatile',
      costModel: {
        type: 'per_token',
        inputPer1M: 0.59,
        outputPer1M: 0.79
      }
    }
  },
  together: {
    class: OpenAICompatibleProvider,
    defaults: {
      endpoint: 'https://api.together.xyz/v1',
      model: 'meta-llama/Llama-3-70b-chat-hf',
      costModel: {
        type: 'per_token',
        inputPer1M: 0.90,
        outputPer1M: 0.90
      }
    }
  },

  // Generic adapter — endpoint and model must be supplied by the caller.
  // Useful for any OpenAI-compatible service not listed above.
  'openai-compatible': {
    class: OpenAICompatibleProvider,
    defaults: {
      costModel: {
        type: 'per_token',
        inputPer1M: 1.00,
        outputPer1M: 3.00
      }
    }
  },

  perplexity: {
    class: OpenAICompatibleProvider,
    defaults: {
      endpoint: 'https://api.perplexity.ai',
      model: 'sonar-pro',
      costModel: {
        type: 'per_token',
        inputPer1M: 3.00,
        outputPer1M: 15.00
      }
    }
  },

  fireworks: {
    class: OpenAICompatibleProvider,
    defaults: {
      endpoint: 'https://api.fireworks.ai/inference/v1',
      model: 'accounts/fireworks/models/llama-v3p1-70b-instruct',
      costModel: {
        type: 'per_token',
        inputPer1M: 0.90,
        outputPer1M: 0.90
      }
    }
  },

  openrouter: {
    class: OpenAICompatibleProvider,
    defaults: {
      endpoint: 'https://openrouter.ai/api/v1',
      model: 'anthropic/claude-sonnet-4',
      costModel: {
        type: 'per_token',
        inputPer1M: 3.00,
        outputPer1M: 15.00
      }
    }
  },

  xai: {
    class: OpenAICompatibleProvider,
    defaults: {
      endpoint: 'https://api.x.ai/v1',
      model: 'grok-3',
      costModel: {
        type: 'per_token',
        inputPer1M: 3.00,
        outputPer1M: 15.00
      }
    }
  }
};

/**
 * Create a provider instance from configuration
 *
 * @param {string} adapterId - Adapter type (ollama, openai, anthropic, etc.)
 * @param {Object} config - Provider configuration
 * @param {string} config.id - Unique provider ID
 * @param {string} [config.endpoint] - API endpoint
 * @param {string} [config.model] - Model name
 * @param {string} [config.credentialName] - Credential name for credential broker
 * @param {Function} [config.getCredential] - Async function to get credential
 * @param {Object} [config.costModel] - Cost model override
 * @returns {BaseProvider} - Provider instance
 */
function createProvider(adapterId, config) {
  const adapter = ADAPTERS[adapterId];

  if (!adapter) {
    throw new Error(`Unknown adapter: ${adapterId}. Available: ${Object.keys(ADAPTERS).join(', ')}`);
  }

  const mergedConfig = {
    ...adapter.defaults,
    ...config,
    costModel: config.costModel || adapter.defaults.costModel
  };

  return new adapter.class(mergedConfig);
}

/**
 * Get list of available adapter names
 * @returns {string[]}
 */
function getAvailableAdapters() {
  return Object.keys(ADAPTERS);
}

/**
 * Get adapter defaults
 * @param {string} adapterId
 * @returns {Object|null}
 */
function getAdapterDefaults(adapterId) {
  return ADAPTERS[adapterId]?.defaults || null;
}

module.exports = {
  // Classes
  BaseProvider,
  OllamaProvider,
  OpenAICompatibleProvider,
  AnthropicProvider,
  GoogleProvider,

  // Factory
  createProvider,
  getAvailableAdapters,
  getAdapterDefaults,

  // Registry
  ADAPTERS
};
