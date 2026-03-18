'use strict';

/**
 * ClaudeToolsProvider - Adapter for Anthropic's Claude API with tool calling.
 *
 * @module agent/providers/claude-tools
 * @version 1.0.0
 */

class ClaudeToolsProvider {
  /**
   * @param {Object} config
   * @param {string} [config.model='claude-opus-4-6']
   * @param {number} [config.maxTokens=4096]
   * @param {number} [config.timeout=30000]
   * @param {Function} config.getApiKey - Async function that returns the API key
   * @param {number} [config.maxRetries=3] - Max retries on 429
   * @param {Object} [logger]
   */
  constructor(config, logger) {
    this.model = config.model || 'claude-opus-4-6';
    this.maxTokens = config.maxTokens || 4096;
    this.timeout = config.timeout || 30000;
    this.getApiKey = config.getApiKey;
    this.maxRetries = config.maxRetries ?? 3;
    this.logger = logger || console;
  }

  /**
   * Send a chat request with tool definitions.
   *
   * @param {Object} params
   * @param {string} params.system - System prompt
   * @param {Array} params.messages - Conversation messages
   * @param {Array} params.tools - Tool definitions (OpenAI format)
   * @returns {Promise<{content: string|null, toolCalls: Array|null}>}
   */
  async chat({ system, messages, tools }) {
    const apiKey = await this.getApiKey();
    if (!apiKey) throw new Error('Claude API key not available');

    // Convert tools from OpenAI format to Claude format
    const claudeTools = (tools || []).map(t => ({
      name: t.function.name,
      description: t.function.description,
      input_schema: t.function.parameters
    }));

    // Convert messages to Claude format
    const claudeMessages = [];
    for (const msg of messages) {
      if (msg.role === 'system') continue; // handled via system param

      if (msg.role === 'tool') {
        const toolResult = {
          type: 'tool_result',
          tool_use_id: msg.tool_call_id,
          content: msg.content
        };
        // Merge consecutive tool results into a single user message
        const last = claudeMessages[claudeMessages.length - 1];
        if (last && last.role === 'user' && Array.isArray(last.content)
            && last.content.length > 0 && last.content[0].type === 'tool_result') {
          last.content.push(toolResult);
        } else {
          claudeMessages.push({
            role: 'user',
            content: [toolResult]
          });
        }
      } else if (msg.tool_calls) {
        claudeMessages.push({
          role: 'assistant',
          content: msg.tool_calls.map(tc => ({
            type: 'tool_use',
            id: tc.id,
            name: tc.function?.name || tc.name,
            input: typeof tc.function?.arguments === 'string'
              ? JSON.parse(tc.function.arguments)
              : tc.function?.arguments || tc.arguments || {}
          }))
        });
      } else {
        claudeMessages.push({
          role: msg.role,
          content: msg.content
        });
      }
    }

    const body = {
      model: this.model,
      max_tokens: this.maxTokens,
      messages: claudeMessages
    };

    if (system) {
      // Enable prompt caching on the system prompt — it's reused across
      // all tool-calling turns in a conversation, so caching saves ~90%
      // of input tokens on subsequent requests.
      body.system = [{
        type: 'text',
        text: system,
        cache_control: { type: 'ephemeral' }
      }];
    }

    if (claudeTools.length > 0) {
      body.tools = claudeTools;
    }

    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), this.timeout);

      try {
        const response = await fetch('https://api.anthropic.com/v1/messages', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-api-key': apiKey,
            'anthropic-version': '2023-06-01'
          },
          body: JSON.stringify(body),
          signal: controller.signal
        });

        clearTimeout(timeoutId);

        if (response.status === 429 || response.status === 529) {
          const backoffMs = this._parseRetryAfter(response.headers, attempt);

          if (attempt < this.maxRetries) {
            this.logger.warn(`[ClaudeToolsProvider] ${response.status} ${response.status === 529 ? 'overloaded' : 'rate limited'}, retry ${attempt + 1}/${this.maxRetries} in ${backoffMs}ms`);
            await this._sleep(backoffMs);
            continue;
          }

          // Max retries exhausted — throw with context
          const errText = await response.text();
          throw new Error(`Claude API rate limited after ${this.maxRetries} retries: ${errText}`);
        }

        if (!response.ok) {
          const errText = await response.text();
          throw new Error(`Claude API error ${response.status}: ${errText}`);
        }

        const data = await response.json();
        const result = this._parseResponse(data);
        // Capture rate limit headers for RouterChatBridge
        if (response.headers) {
          result._headers = {
            requestsRemaining: this._parseHeaderInt(response.headers, 'anthropic-ratelimit-requests-remaining'),
            tokensRemaining: this._parseHeaderInt(response.headers, 'anthropic-ratelimit-tokens-remaining'),
          };
        }
        return result;

      } catch (err) {
        clearTimeout(timeoutId);
        if (err.name === 'AbortError') {
          throw new Error(`Claude API timed out after ${this.timeout}ms`);
        }
        throw err;
      }
    }
  }

  /**
   * Parse Retry-After header from a response.
   * @param {Headers} headers - Fetch API Headers object
   * @returns {number} Milliseconds to wait
   * @private
   */
  _parseRetryAfter(headers, attempt = 0) {
    const retryAfter = headers.get('retry-after');
    if (retryAfter) {
      const seconds = parseInt(retryAfter, 10);
      if (!isNaN(seconds)) return seconds * 1000;

      // Try HTTP-date format
      const date = new Date(retryAfter);
      if (!isNaN(date.getTime())) return Math.max(1000, date.getTime() - Date.now());
    }

    // Exponential backoff with jitter: 2^attempt * 1000ms + random 0-1000ms
    // attempt 0 → 1-2s, attempt 1 → 2-3s, attempt 2 → 4-5s
    const baseMs = Math.pow(2, attempt) * 1000;
    return baseMs + Math.random() * 1000;
  }

  /**
   * @param {number} ms
   * @returns {Promise<void>}
   * @private
   */
  _sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  /** @private */
  _parseResponse(data) {
    const content = data.content || [];
    const usage = data.usage || {};

    const inputTokens = usage.input_tokens || 0;
    const outputTokens = usage.output_tokens || 0;
    const cacheCreationTokens = usage.cache_creation_input_tokens || 0;
    const cacheReadTokens = usage.cache_read_input_tokens || 0;
    const tokens = inputTokens + outputTokens;

    const textBlocks = content.filter(b => b.type === 'text');
    const toolBlocks = content.filter(b => b.type === 'tool_use');

    const base = {
      _inputTokens: inputTokens,
      _outputTokens: outputTokens,
      _cacheCreationTokens: cacheCreationTokens,
      _cacheReadTokens: cacheReadTokens,
      _tokens: tokens,
    };

    if (toolBlocks.length > 0) {
      return {
        content: textBlocks.map(b => b.text).join('\n') || null,
        toolCalls: toolBlocks.map(b => ({
          id: b.id,
          name: b.name,
          arguments: b.input || {}
        })),
        ...base
      };
    }

    return {
      content: textBlocks.map(b => b.text).join('\n') || '',
      toolCalls: null,
      ...base
    };
  }

  /** @private */
  _parseHeaderInt(headers, name) {
    const val = headers.get(name);
    if (val === null || val === undefined) return null;
    const num = parseInt(val, 10);
    return isNaN(num) ? null : num;
  }
}

module.exports = { ClaudeToolsProvider };
