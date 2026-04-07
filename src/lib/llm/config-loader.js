/**
 * LLM Configuration Loader
 *
 * Loads provider configuration from YAML file.
 * Falls back to Ollama-only default if no config exists.
 *
 * @module llm/config-loader
 * @version 1.0.0
 */

const fs = require('fs');
const path = require('path');

// Try to load yaml parser, fall back to JSON-like parsing
let yaml;
try {
  yaml = require('js-yaml');
} catch {
  yaml = null;
}

/**
 * Default configuration - Ollama only
 * Used when no config file exists
 */
const DEFAULT_CONFIG = {
  providers: {
    'ollama-local': {
      adapter: 'ollama',
      endpoint: 'http://localhost:11434',
      model: 'phi4-mini'
    }
  },
  roles: {
    sovereign: ['ollama-local'],
    free: ['ollama-local'],
    value: ['ollama-local'],
    premium: ['ollama-local']
  },
  fallbackChain: {
    'ollama-local': []
  },
  budgets: {}
};

/**
 * Load configuration from file or return defaults
 *
 * @param {Object} options
 * @param {string} [options.configPath] - Path to config file
 * @param {string} [options.configDir] - Directory to search for config
 * @param {Function} [options.getCredential] - Credential broker function
 * @returns {Object} - Configuration object ready for LLMRouter
 */
function loadConfig(options = {}) {
  const configPath = options.configPath || findConfigFile(options.configDir);

  if (!configPath || !fs.existsSync(configPath)) {
    console.log('[LLMConfig] No config file found, using Ollama-only defaults');
    return {
      ...DEFAULT_CONFIG,
      getCredential: options.getCredential
    };
  }

  try {
    const content = fs.readFileSync(configPath, 'utf-8');
    let config;

    if (configPath.endsWith('.yaml') || configPath.endsWith('.yml')) {
      if (!yaml) {
        console.warn('[LLMConfig] js-yaml not installed, cannot parse YAML config');
        return { ...DEFAULT_CONFIG, getCredential: options.getCredential };
      }
      config = yaml.load(content);
    } else if (configPath.endsWith('.json')) {
      config = JSON.parse(content);
    } else {
      // Try YAML first, then JSON
      try {
        config = yaml ? yaml.load(content) : JSON.parse(content);
      } catch {
        config = JSON.parse(content);
      }
    }

    console.log(`[LLMConfig] Loaded configuration from ${configPath}`);

    // Merge with defaults to ensure all required fields exist
    return mergeConfig(config, options.getCredential);

  } catch (error) {
    console.error(`[LLMConfig] Error loading config: ${error.message}`);
    console.log('[LLMConfig] Falling back to Ollama-only defaults');
    return {
      ...DEFAULT_CONFIG,
      getCredential: options.getCredential
    };
  }
}

/**
 * Find configuration file in common locations
 * @private
 */
function findConfigFile(configDir) {
  const searchPaths = [
    configDir ? path.join(configDir, 'moltagent-providers.yaml') : null,
    configDir ? path.join(configDir, 'moltagent-providers.yml') : null,
    configDir ? path.join(configDir, 'moltagent-providers.json') : null,
    path.join(process.cwd(), 'config', 'moltagent-providers.yaml'),
    path.join(process.cwd(), 'config', 'moltagent-providers.yml'),
    path.join(process.cwd(), 'config', 'moltagent-providers.json'),
    path.join(process.cwd(), 'moltagent-providers.yaml'),
    path.join(process.cwd(), 'moltagent-providers.yml')
  ].filter(Boolean);

  for (const searchPath of searchPaths) {
    if (fs.existsSync(searchPath)) {
      return searchPath;
    }
  }

  return null;
}

/**
 * Merge loaded config with defaults
 * @private
 */
function mergeConfig(loaded, getCredential) {
  const config = {
    providers: { ...DEFAULT_CONFIG.providers },
    roles: { ...DEFAULT_CONFIG.roles },
    fallbackChain: { ...DEFAULT_CONFIG.fallbackChain },
    budgets: {},
    backoff: {},
    getCredential
  };

  // Merge providers
  if (loaded.providers) {
    for (const [id, providerConfig] of Object.entries(loaded.providers)) {
      if (providerConfig.enabled === false) continue;
      config.providers[id] = providerConfig;
    }
  }

  // Merge roles
  if (loaded.roles) {
    config.roles = { ...config.roles, ...loaded.roles };
  }

  // Merge fallback chains
  if (loaded.fallbackChain) {
    config.fallbackChain = { ...config.fallbackChain, ...loaded.fallbackChain };
  }

  // Merge budgets (daily limits)
  if (loaded.budgets) {
    if (loaded.budgets.daily) {
      for (const [providerId, limit] of Object.entries(loaded.budgets.daily)) {
        config.budgets[providerId] = config.budgets[providerId] || {};
        config.budgets[providerId].daily = limit;
      }
    }
    if (loaded.budgets.monthly) {
      for (const [providerId, limit] of Object.entries(loaded.budgets.monthly)) {
        config.budgets[providerId] = config.budgets[providerId] || {};
        config.budgets[providerId].monthly = limit;
      }
    }
  }

  // Backoff settings
  if (loaded.rateLimits?.backoff) {
    config.backoff = loaded.rateLimits.backoff;
  }

  return config;
}

/**
 * Validate configuration
 * @param {Object} config
 * @returns {Object} - { valid: boolean, errors: string[] }
 */
function validateConfig(config) {
  const errors = [];

  // Check providers
  if (!config.providers || Object.keys(config.providers).length === 0) {
    errors.push('No providers configured');
  }

  // Check roles reference valid providers
  if (config.roles) {
    for (const [role, providerIds] of Object.entries(config.roles)) {
      for (const providerId of providerIds) {
        if (!config.providers[providerId]) {
          errors.push(`Role '${role}' references unknown provider '${providerId}'`);
        }
      }
    }
  }

  // Check fallback chains reference valid providers
  if (config.fallbackChain) {
    for (const [providerId, fallbacks] of Object.entries(config.fallbackChain)) {
      if (!config.providers[providerId]) {
        errors.push(`Fallback chain references unknown provider '${providerId}'`);
      }
      for (const fb of fallbacks) {
        if (!config.providers[fb]) {
          errors.push(`Fallback chain for '${providerId}' references unknown provider '${fb}'`);
        }
      }
    }
  }

  return {
    valid: errors.length === 0,
    errors
  };
}

/**
 * Generate example configuration
 * @returns {string} - YAML configuration example
 */
function generateExampleConfig() {
  return `# Moltagent Provider Configuration
# Place this file at: config/moltagent-providers.yaml

# Provider definitions
providers:
  # Local - always available (sovereign/free)
  ollama-local:
    adapter: ollama
    endpoint: http://localhost:11434
    model: phi4-mini

  # Value tier - uncomment and configure as needed
  # deepseek:
  #   adapter: deepseek
  #   credentialName: deepseek-api-key  # Credential name in NC Passwords
  #   model: deepseek-chat

  # mistral:
  #   adapter: mistral
  #   credentialName: mistral-api-key
  #   model: mistral-small-latest

  # Premium tier - uncomment and configure as needed
  # claude:
  #   adapter: anthropic
  #   credentialName: claude-api-key
  #   model: claude-sonnet-4-20250514

  # gpt4:
  #   adapter: openai
  #   credentialName: openai-api-key
  #   model: gpt-4o

# Role assignments (providers tried in order listed)
# First provider is tried first, then next, etc.
roles:
  sovereign: [ollama-local]
  free: [ollama-local]
  value: [ollama-local]        # Add: [deepseek, mistral, ollama-local]
  premium: [ollama-local]      # Add: [claude, gpt4, deepseek, ollama-local]

# Fallback chains (when a provider fails, try these next)
fallbackChain:
  ollama-local: []  # Local has no fallback - it's the last resort
  # claude: [deepseek, ollama-local]
  # gpt4: [claude, deepseek, ollama-local]
  # deepseek: [mistral, ollama-local]
  # mistral: [deepseek, ollama-local]

# Daily budget limits in USD (optional)
budgets:
  daily: {}
    # claude: 2.00
    # gpt4: 2.00
    # deepseek: 1.00
  monthly: {}
    # claude: 50.00
    # deepseek: 20.00
`;
}

module.exports = {
  loadConfig,
  validateConfig,
  generateExampleConfig,
  DEFAULT_CONFIG
};
