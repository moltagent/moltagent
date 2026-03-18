/**
 * MoltAgent LLM Router
 *
 * Backward-compatible wrapper around the new LLM module.
 * New code should use require('./llm') directly.
 *
 * @version 2.0.0
 * @deprecated Use require('./llm').LLMRouter with config instead
 */

const { LLMRouter, loadConfig } = require('./llm');

/**
 * Legacy LLMRouter wrapper
 * Maintains backward compatibility with old constructor signature
 */
class LegacyLLMRouter {
  /**
   * @param {Object} config - Legacy config format
   * @param {Object} [config.ollama] - Ollama configuration
   * @param {string} [config.ollama.url] - Ollama URL
   * @param {string} [config.ollama.model] - Model name
   * @param {Function} [config.auditLog] - Audit logging function
   * @param {Function} [config.getCredential] - Credential broker function
   */
  constructor(config = {}) {
    // Load config from file, with legacy overrides
    const loadedConfig = loadConfig({
      getCredential: config.getCredential
    });

    // Override with legacy ollama settings if provided
    if (config.ollama) {
      loadedConfig.providers['ollama-local'] = {
        adapter: 'ollama',
        endpoint: config.ollama.url || 'http://localhost:11434',
        model: config.ollama.model || 'phi4-mini'
      };
      // Credential-dedicated model (same endpoint, potentially heavier model)
      const credModel = config.ollama.modelCredential || config.ollama.model || 'phi4-mini';
      if (credModel !== (config.ollama.model || 'phi4-mini')) {
        loadedConfig.providers['ollama-credential'] = {
          adapter: 'ollama',
          endpoint: config.ollama.url || 'http://localhost:11434',
          model: credModel
        };
      }

      // Fast model for QUICK jobs (classification, synthesis, extraction)
      const fastModel = config.ollama.modelFast;
      if (fastModel && fastModel !== (config.ollama.model || 'phi4-mini')) {
        loadedConfig.providers['ollama-fast'] = {
          adapter: 'ollama',
          endpoint: config.ollama.url || 'http://localhost:11434',
          model: fastModel
        };
      }
    }

    // Create the new router
    this._router = new LLMRouter({
      ...loadedConfig,
      auditLog: config.auditLog,
      notifyUser: config.notifyUser,
      proactiveDailyBudget: config.proactiveDailyBudget || 0
    });

    // Expose legacy stats interface
    this.stats = {
      totalCalls: 0,
      ollamaCalls: 0,
      errors: 0,
      totalTokens: 0
    };
  }

  /**
   * Route a request (backward compatible)
   * Supports both: route(task, content, opts) and route({task, content, ...})
   */
  async route(taskOrConfig, content, options = {}) {
    // Normalize to new format
    let request;

    if (typeof taskOrConfig === 'object' && taskOrConfig !== null) {
      request = {
        job: taskOrConfig.job,
        task: taskOrConfig.task,
        system: taskOrConfig.system,
        content: taskOrConfig.content,
        requirements: taskOrConfig.requirements || taskOrConfig.options || {},
        context: taskOrConfig.context
      };
    } else {
      request = {
        task: taskOrConfig,
        content: content,
        requirements: options
      };
    }

    // Call new router
    const result = await this._router.route(request);

    // Update legacy stats
    this.stats.totalCalls++;
    this.stats.totalTokens += result.tokens || 0;
    if (result.provider?.includes('ollama')) {
      this.stats.ollamaCalls++;
    }

    return result;
  }

  /**
   * Get router statistics
   */
  getStats() {
    const newStats = this._router.getStats();
    return {
      ...this.stats,
      ...newStats
    };
  }

  /**
   * Test connection to providers
   */
  async testConnection() {
    const results = await this._router.testConnections();
    // Return Ollama result for backward compatibility
    return results['ollama-local'] || { connected: false, error: 'No ollama provider' };
  }

  /**
   * Access the underlying new router
   */
  get router() {
    return this._router;
  }

  // Local Intelligence: ModelScout integration proxies
  setLocalRoster(roster) { return this._router.setLocalRoster(roster); }
  getLocalRoster() { return this._router.getLocalRoster(); }
  hasCloudPlayers() { return this._router.hasCloudPlayers(); }
  async isCloudAvailable() { return this._router.isCloudAvailable(); }

  // Cockpit propagation proxies
  setPreset(name) { return this._router.setPreset(name); }
  setRoster(roster) { return this._router.setRoster(roster); }
  getRoster() { return this._router.getRoster(); }
  getPreset() { return this._router.getPreset(); }

  // Dynamic provider registration (B2: Models card wiring)
  registerProvider(id, providerConfig) { return this._router.registerProvider(id, providerConfig); }
  unregisterProvider(id) { return this._router.unregisterProvider(id); }
  getRegisteredProviders() { return this._router.getRegisteredProviders(); }
}

module.exports = LegacyLLMRouter;
