/**
 * Anthropic Provider Adapter
 *
 * Provider for Claude models via Anthropic API.
 *
 * @module llm/providers/anthropic-provider
 * @version 1.0.0
 */

const BaseProvider = require('./base-provider');

class AnthropicProvider extends BaseProvider {
  /**
   * @param {Object} config
   * @param {string} config.id - Provider identifier
   * @param {string} [config.endpoint] - API endpoint (default: https://api.anthropic.com)
   * @param {string} config.model - Model to use (e.g., claude-sonnet-4-20250514)
   * @param {Function} config.getCredential - Async function to get API key
   * @param {Object} [config.costModel] - Cost model
   */
  constructor(config) {
    super({
      ...config,
      type: 'api',
      endpoint: config.endpoint || 'https://api.anthropic.com'
    });
    this.apiVersion = config.apiVersion || '2023-06-01';
  }

  /**
   * Generate a response using Anthropic API
   */
  async generate(task, content, options = {}) {
    const startTime = Date.now();
    const prompt = this.buildPrompt(task, content, options);

    const apiKey = await this.getCredential();
    if (!apiKey) {
      const error = new Error(`No API key available for ${this.id}`);
      error.status = 401;
      this.recordError(error);
      throw error;
    }

    try {
      const response = await fetch(`${this.endpoint}/v1/messages`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': apiKey,
          'anthropic-version': this.apiVersion
        },
        body: JSON.stringify({
          model: this.model,
          max_tokens: options.maxTokens || 1024,
          messages: [
            { role: 'user', content: prompt }
          ]
        })
      });

      // Capture rate limit headers
      const headers = this.extractRateLimitHeaders(response.headers);

      if (!response.ok) {
        const errorData = await response.json().catch(() => ({}));
        const error = new Error(
          errorData.error?.message || `Anthropic error: ${response.status}`
        );
        error.status = response.status;
        error.headers = headers;
        error.type = errorData.error?.type;
        this.recordError(error);
        throw error;
      }

      const data = await response.json();
      const result = data.content?.[0]?.text || '';
      const inputTokens = data.usage?.input_tokens || this.estimateTokens(prompt);
      const outputTokens = data.usage?.output_tokens || this.estimateTokens(result);
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
        headers,
        stopReason: data.stop_reason
      };

    } catch (error) {
      if (!error.status) {
        error.status = 0;
        error.message = `Anthropic connection failed: ${error.message}`;
      }
      this.recordError(error);
      throw error;
    }
  }

  /**
   * Extract rate limit headers from Anthropic response
   */
  extractRateLimitHeaders(headers) {
    const get = (name) => headers.get(name);
    return {
      // Request limits
      requestsLimit: this.parseNumber(get('anthropic-ratelimit-requests-limit')),
      requestsRemaining: this.parseNumber(get('anthropic-ratelimit-requests-remaining')),
      requestsReset: get('anthropic-ratelimit-requests-reset'),
      // Token limits
      tokensLimit: this.parseNumber(get('anthropic-ratelimit-tokens-limit')),
      tokensRemaining: this.parseNumber(get('anthropic-ratelimit-tokens-remaining')),
      tokensReset: get('anthropic-ratelimit-tokens-reset'),
      // Retry
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

    // Anthropic doesn't have a models endpoint, so we just test auth
    // by making a minimal request
    try {
      const response = await fetch(`${this.endpoint}/v1/messages`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': apiKey,
          'anthropic-version': this.apiVersion
        },
        body: JSON.stringify({
          model: this.model,
          max_tokens: 1,
          messages: [{ role: 'user', content: 'Hi' }]
        })
      });

      if (response.status === 401) {
        return { connected: false, error: 'Invalid API key' };
      }

      // Even a rate limit means we're connected
      return { connected: true, model: this.model };

    } catch (error) {
      return { connected: false, error: error.message };
    }
  }
}

module.exports = AnthropicProvider;
