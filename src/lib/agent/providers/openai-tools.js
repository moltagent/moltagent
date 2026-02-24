'use strict';

/**
 * OpenAIToolsProvider - Adapter for OpenAI-compatible APIs with tool calling.
 *
 * Works with OpenAI, Perplexity, Mistral, Groq, Together, Fireworks,
 * DeepSeek, OpenRouter, xAI, and any other OpenAI-compatible API.
 *
 * @module agent/providers/openai-tools
 * @version 1.0.0
 */

class OpenAIToolsProvider {
  /**
   * @param {Object} config
   * @param {string} config.endpoint - API base URL (e.g., 'https://api.perplexity.ai')
   * @param {string} config.model - Model name
   * @param {Function} config.getApiKey - Async function that returns the API key
   * @param {number} [config.maxTokens=4096] - Default max tokens
   * @param {number} [config.timeout=30000] - Request timeout in ms
   * @param {number} [config.maxRetries=2] - Max retries on 429/529
   * @param {Object} [config.headers={}] - Additional headers
   * @param {Object} [logger]
   */
  constructor(config, logger) {
    this.endpoint = (config.endpoint || '').replace(/\/+$/, '');
    this.model = config.model;
    this.getApiKey = config.getApiKey;
    this.maxTokens = config.maxTokens || 4096;
    this.timeout = config.timeout || 30000;
    this.maxRetries = config.maxRetries ?? 2;
    this.additionalHeaders = config.headers || {};
    this.logger = logger || console;

    if (!this.endpoint) throw new Error('OpenAIToolsProvider requires an endpoint');
    if (!this.model) throw new Error('OpenAIToolsProvider requires a model');
  }

  /**
   * Send a chat request with tool definitions.
   * Matches the interface of OllamaToolsProvider and ClaudeToolsProvider.
   *
   * @param {Object} params
   * @param {string} params.system - System prompt
   * @param {Array} params.messages - Conversation messages
   * @param {Array} [params.tools] - Tool definitions (OpenAI format)
   * @param {number} [params.timeout] - Override timeout (ms)
   * @returns {Promise<{content: string|null, toolCalls: Array|null}>}
   */
  async chat({ system, messages, tools, timeout }) {
    const apiKey = await this.getApiKey();
    if (!apiKey) throw new Error('API key not available');

    // Build messages array with system prompt
    const apiMessages = [];
    if (system) {
      apiMessages.push({ role: 'system', content: system });
    }

    for (const msg of messages) {
      if (msg.role === 'system') continue; // handled above

      if (msg.role === 'tool') {
        // Tool result message
        apiMessages.push({
          role: 'tool',
          tool_call_id: msg.tool_call_id,
          content: typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content)
        });
      } else if (msg.tool_calls) {
        // Assistant message with tool calls
        apiMessages.push({
          role: 'assistant',
          content: msg.content || null,
          tool_calls: msg.tool_calls.map(tc => ({
            id: tc.id,
            type: 'function',
            function: {
              name: tc.function?.name || tc.name,
              arguments: typeof tc.function?.arguments === 'string'
                ? tc.function.arguments
                : JSON.stringify(tc.function?.arguments || tc.arguments || {})
            }
          }))
        });
      } else {
        apiMessages.push({
          role: msg.role,
          content: msg.content
        });
      }
    }

    const body = {
      model: this.model,
      messages: apiMessages,
      max_tokens: this.maxTokens,
      temperature: 0.7,
    };

    if (tools && tools.length > 0) {
      body.tools = tools;
    }

    const effectiveTimeout = timeout || this.timeout;

    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), effectiveTimeout);

      try {
        const response = await fetch(`${this.endpoint}/chat/completions`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${apiKey}`,
            ...this.additionalHeaders,
          },
          body: JSON.stringify(body),
          signal: controller.signal,
        });

        clearTimeout(timeoutId);

        // Retry on rate limit / overload
        if (response.status === 429 || response.status === 529) {
          if (attempt < this.maxRetries) {
            const backoffMs = this._parseRetryAfter(response.headers, attempt);
            this.logger.warn(
              `[OpenAIToolsProvider] ${response.status} rate limited, retry ${attempt + 1}/${this.maxRetries} in ${backoffMs}ms`
            );
            await this._sleep(backoffMs);
            continue;
          }
          const errText = await response.text();
          throw new Error(`Rate limited after ${this.maxRetries} retries: ${errText}`);
        }

        if (!response.ok) {
          const errText = await response.text();
          throw new Error(`API error ${response.status}: ${errText.substring(0, 200)}`);
        }

        const data = await response.json();
        return this._parseResponse(data);

      } catch (err) {
        clearTimeout(timeoutId);
        if (err.name === 'AbortError') {
          throw new Error(`Request timed out after ${effectiveTimeout}ms`);
        }
        throw err;
      }
    }
  }

  /** @private */
  _parseResponse(data) {
    const choice = data.choices?.[0];
    if (!choice) throw new Error('No choices in response');

    const message = choice.message || {};

    if (message.tool_calls && message.tool_calls.length > 0) {
      return {
        content: message.content || null,
        toolCalls: message.tool_calls.map(tc => ({
          id: tc.id || `openai_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
          name: tc.function?.name,
          arguments: typeof tc.function?.arguments === 'string'
            ? this._safeParseArgs(tc.function.arguments)
            : tc.function?.arguments || {}
        }))
      };
    }

    return {
      content: message.content || '',
      toolCalls: null
    };
  }

  /** @private */
  _safeParseArgs(argsString) {
    try {
      return JSON.parse(argsString);
    } catch {
      return { _raw: argsString };
    }
  }

  /** @private */
  _parseRetryAfter(headers, attempt = 0) {
    const retryAfter = headers.get('retry-after');
    if (retryAfter) {
      const seconds = parseInt(retryAfter, 10);
      if (!isNaN(seconds)) return seconds * 1000;
    }
    // Exponential backoff with jitter
    return Math.pow(2, attempt) * 1000 + Math.random() * 1000;
  }

  /** @private */
  _sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}

module.exports = { OpenAIToolsProvider };
