/**
 * OpenAI-Compatible Provider Adapter
 *
 * Works with OpenAI, DeepSeek, Mistral, and other OpenAI-compatible APIs.
 *
 * @module llm/providers/openai-compatible-provider
 * @version 1.0.0
 */

const BaseProvider = require('./base-provider');

class OpenAICompatibleProvider extends BaseProvider {
  /**
   * @param {Object} config
   * @param {string} config.id - Provider identifier
   * @param {string} config.endpoint - API endpoint
   * @param {string} config.model - Model to use
   * @param {Function} config.getCredential - Async function to get API key
   * @param {Object} [config.costModel] - Cost model
   * @param {Object} [config.headers] - Additional headers
   */
  constructor(config) {
    super({
      ...config,
      type: 'api'
    });
    this.additionalHeaders = config.headers || {};
  }

  /**
   * Generate a response using OpenAI-compatible API
   */
  async generate(task, content, options = {}) {
    const startTime = Date.now();
    const prompt = this.buildPrompt(task, content, options);

    // Get API key from credential broker
    const apiKey = await this.getCredential();
    if (!apiKey) {
      const error = new Error(`No API key available for ${this.id}`);
      error.status = 401;
      this.recordError(error);
      throw error;
    }

    try {
      const response = await fetch(`${this.endpoint}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${apiKey}`,
          ...this.additionalHeaders
        },
        body: JSON.stringify({
          model: this.model,
          messages: [
            { role: 'user', content: prompt }
          ],
          max_tokens: options.maxTokens || 1024,
          temperature: options.temperature ?? 0.7
        })
      });

      // Capture rate limit headers
      const headers = this.extractRateLimitHeaders(response.headers);

      if (!response.ok) {
        const errorData = await response.json().catch(() => ({}));
        const error = new Error(
          errorData.error?.message || `API error: ${response.status}`
        );
        error.status = response.status;
        error.headers = headers;
        this.recordError(error);
        throw error;
      }

      const data = await response.json();
      const result = data.choices?.[0]?.message?.content || '';
      const usage = data.usage || {};
      const inputTokens = usage.prompt_tokens || this.estimateTokens(prompt);
      const outputTokens = usage.completion_tokens || this.estimateTokens(result);
      const tokens = inputTokens + outputTokens;

      this.recordSuccess(tokens);

      return {
        result,
        tokens,
        inputTokens,
        outputTokens,
        cost: this.estimateCost(inputTokens, outputTokens),
        duration: Date.now() - startTime,
        model: this.model,
        provider: this.id,
        headers
      };

    } catch (error) {
      if (!error.status) {
        error.status = 0;
        error.message = `${this.id} connection failed: ${error.message}`;
      }
      this.recordError(error);
      throw error;
    }
  }

  /**
   * Extract rate limit headers from response
   */
  extractRateLimitHeaders(headers) {
    const get = (name) => headers.get(name);
    return {
      requestsRemaining: this.parseNumber(get('x-ratelimit-remaining-requests')),
      requestsLimit: this.parseNumber(get('x-ratelimit-limit-requests')),
      requestsReset: get('x-ratelimit-reset-requests'),
      tokensRemaining: this.parseNumber(get('x-ratelimit-remaining-tokens')),
      tokensLimit: this.parseNumber(get('x-ratelimit-limit-tokens')),
      tokensReset: get('x-ratelimit-reset-tokens'),
      retryAfter: this.parseNumber(get('retry-after'))
    };
  }

  parseNumber(value) {
    if (value === null || value === undefined) return null;
    const num = parseInt(value, 10);
    return isNaN(num) ? null : num;
  }

  /**
   * Test connection
   */
  async testConnection() {
    const apiKey = await this.getCredential();
    if (!apiKey) {
      return { connected: false, error: 'No API key configured' };
    }

    try {
      const response = await fetch(`${this.endpoint}/models`, {
        headers: {
          'Authorization': `Bearer ${apiKey}`,
          ...this.additionalHeaders
        }
      });

      if (!response.ok) {
        return { connected: false, error: `HTTP ${response.status}` };
      }

      const data = await response.json();
      return {
        connected: true,
        models: data.data?.map(m => m.id) || []
      };

    } catch (error) {
      return { connected: false, error: error.message };
    }
  }
}

module.exports = OpenAICompatibleProvider;
