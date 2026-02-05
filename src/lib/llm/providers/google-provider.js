/**
 * Google Provider Adapter
 *
 * Provider for Gemini models via Google AI API.
 *
 * @module llm/providers/google-provider
 * @version 1.0.0
 */

const BaseProvider = require('./base-provider');

class GoogleProvider extends BaseProvider {
  /**
   * @param {Object} config
   * @param {string} config.id - Provider identifier
   * @param {string} [config.endpoint] - API endpoint
   * @param {string} config.model - Model to use (e.g., gemini-1.5-pro)
   * @param {Function} config.getCredential - Async function to get API key
   * @param {Object} [config.costModel] - Cost model
   */
  constructor(config) {
    super({
      ...config,
      type: 'api',
      endpoint: config.endpoint || 'https://generativelanguage.googleapis.com'
    });
  }

  /**
   * Generate a response using Google AI API
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
      const url = `${this.endpoint}/v1beta/models/${this.model}:generateContent?key=${apiKey}`;

      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          contents: [
            {
              parts: [{ text: prompt }]
            }
          ],
          generationConfig: {
            maxOutputTokens: options.maxTokens || 1024,
            temperature: options.temperature ?? 0.7
          }
        })
      });

      const headers = this.extractRateLimitHeaders(response.headers);

      if (!response.ok) {
        const errorData = await response.json().catch(() => ({}));
        const error = new Error(
          errorData.error?.message || `Google AI error: ${response.status}`
        );
        error.status = response.status;
        error.headers = headers;
        this.recordError(error);
        throw error;
      }

      const data = await response.json();
      const result = data.candidates?.[0]?.content?.parts?.[0]?.text || '';
      const usage = data.usageMetadata || {};
      const inputTokens = usage.promptTokenCount || this.estimateTokens(prompt);
      const outputTokens = usage.candidatesTokenCount || this.estimateTokens(result);
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
        finishReason: data.candidates?.[0]?.finishReason
      };

    } catch (error) {
      if (!error.status) {
        error.status = 0;
        error.message = `Google AI connection failed: ${error.message}`;
      }
      this.recordError(error);
      throw error;
    }
  }

  /**
   * Extract rate limit headers
   */
  extractRateLimitHeaders(headers) {
    const get = (name) => headers.get(name);
    return {
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
      const url = `${this.endpoint}/v1beta/models?key=${apiKey}`;
      const response = await fetch(url);

      if (!response.ok) {
        return { connected: false, error: `HTTP ${response.status}` };
      }

      const data = await response.json();
      return {
        connected: true,
        models: data.models?.map(m => m.name) || []
      };

    } catch (error) {
      return { connected: false, error: error.message };
    }
  }
}

module.exports = GoogleProvider;
