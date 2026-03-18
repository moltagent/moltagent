/**
 * Ollama Provider Adapter
 *
 * Local LLM provider using Ollama.
 * Data never leaves infrastructure - suitable for sovereign role.
 *
 * @module llm/providers/ollama-provider
 * @version 1.0.0
 */

const BaseProvider = require('./base-provider');

class OllamaProvider extends BaseProvider {
  /**
   * @param {Object} config
   * @param {string} config.id - Provider identifier
   * @param {string} [config.endpoint] - Ollama API URL (default: http://localhost:11434)
   * @param {string} [config.model] - Model to use (default: phi4-mini)
   */
  constructor(config) {
    super({
      ...config,
      type: 'local',
      endpoint: config.endpoint || 'http://localhost:11434',
      model: config.model || 'phi4-mini',
      costModel: { type: 'free' }
    });
    this._fetch = globalThis.fetch;
  }

  /**
   * Fetch with retry for transient connection errors.
   * Only retries on network-level failures (!err.status), not HTTP errors.
   */
  async _fetchWithRetry(url, fetchOptions, retries = 1, delayMs = 2000) {
    for (let attempt = 0; attempt <= retries; attempt++) {
      try {
        return await this._fetch(url, fetchOptions);
      } catch (err) {
        if (attempt < retries && !err.status) {
          this.logger.warn(`[OllamaProvider] fetch failed (attempt ${attempt + 1}), retrying in ${delayMs}ms`);
          await new Promise(r => setTimeout(r, delayMs));
          continue;
        }
        throw err;
      }
    }
  }

  /**
   * Generate a response using Ollama
   */
  async generate(task, content, options = {}) {
    const startTime = Date.now();
    const prompt = this.buildPrompt(task, content, options);

    try {
      // Add timeout to prevent hanging on unreachable Ollama
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 120000); // 120 second timeout

      try {
        const messages = [];
        if (options.system) messages.push({ role: 'system', content: options.system });
        messages.push({ role: 'user', content: prompt });

        const requestBody = {
            model: this.model,
            messages,
            stream: false,
            keep_alive: '10m',
            options: {
              temperature: options.temperature ?? 0.7,
              num_predict: options.maxTokens || 1024
            }
          };
        if (options.format) requestBody.format = options.format;

        // Disable thinking mode for structured extraction (temperature 0).
        // Qwen3 thinking burns num_predict tokens on reasoning, returning empty content.
        if (options.temperature === 0) requestBody.think = false;

        const response = await this._fetchWithRetry(`${this.endpoint}/api/chat`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(requestBody),
          signal: controller.signal
        });
        clearTimeout(timeout);

        if (!response.ok) {
          const text = await response.text();
          const error = new Error(`Ollama error: ${response.status} - ${text}`);
          error.status = response.status;
          this.recordError(error);
          throw error;
        }

        const data = await response.json();
        const tokens = (data.prompt_eval_count || 0) + (data.eval_count || 0);

        this.recordSuccess(tokens);

        return {
          result: data.message?.content || '',
          tokens,
          inputTokens: data.prompt_eval_count || 0,
          outputTokens: data.eval_count || 0,
          duration: Date.now() - startTime,
          model: this.model,
          provider: this.id
        };

      } catch (fetchError) {
        clearTimeout(timeout);
        throw fetchError;
      }

    } catch (error) {
      let wrapped;
      if (error.name === 'AbortError') {
        wrapped = new Error('Ollama request timeout after 120s');
        wrapped.status = 0;
      } else if (!error.status) {
        wrapped = new Error(`Ollama connection failed: ${error.message}`);
        wrapped.status = 0;
      } else {
        wrapped = error;
      }
      this.recordError(wrapped);
      throw wrapped;
    }
  }

  /**
   * Test connection to Ollama
   */
  async testConnection() {
    try {
      // Add timeout to prevent hanging on unreachable Ollama
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 5000); // 5 second timeout for connection test

      const response = await fetch(`${this.endpoint}/api/tags`, {
        signal: controller.signal
      });
      clearTimeout(timeout);

      if (!response.ok) {
        return {
          connected: false,
          error: `HTTP ${response.status}`
        };
      }

      const data = await response.json();
      const models = data.models?.map(m => m.name) || [];

      return {
        connected: true,
        models,
        hasModel: models.some(m => m.startsWith(this.model.split(':')[0]))
      };

    } catch (error) {
      return {
        connected: false,
        error: error.name === 'AbortError' ? 'Connection timeout' : error.message
      };
    }
  }
}

module.exports = OllamaProvider;
