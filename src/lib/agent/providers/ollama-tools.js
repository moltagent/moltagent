'use strict';

/**
 * OllamaToolsProvider - Adapter for Ollama's native tool calling API.
 *
 * @module agent/providers/ollama-tools
 * @version 1.0.0
 */

class OllamaToolsProvider {
  /**
   * @param {Object} config
   * @param {string} config.endpoint - Ollama API URL (e.g., http://localhost:11434)
   * @param {string} config.model - Model name (e.g., qwen3:8b)
   * @param {number} [config.timeout=300000]
   * @param {Object} [logger]
   */
  constructor(config, logger) {
    this.endpoint = (config.endpoint || 'http://localhost:11434').replace(/\/$/, '');
    this.model = config.model || 'qwen3:8b';
    this.timeout = config.timeout || 300000;
    this.logger = logger || console;
  }

  /**
   * Send a chat request with tool definitions.
   *
   * @param {Object} params
   * @param {string} params.system - System prompt
   * @param {Array} params.messages - Conversation messages
   * @param {Array} params.tools - Tool definitions
   * @returns {Promise<{content: string|null, toolCalls: Array|null}>}
   */
  async chat({ system, messages, tools }) {
    const ollamaMessages = [];

    if (system) {
      ollamaMessages.push({ role: 'system', content: system });
    }

    for (const msg of messages) {
      if (msg.role === 'tool') {
        ollamaMessages.push({
          role: 'tool',
          content: msg.content
        });
      } else if (msg.tool_calls) {
        ollamaMessages.push({
          role: 'assistant',
          content: msg.content || '',
          tool_calls: msg.tool_calls.map(tc => ({
            function: {
              name: tc.function?.name || tc.name,
              arguments: typeof tc.function?.arguments === 'string'
                ? JSON.parse(tc.function.arguments)
                : tc.function?.arguments || tc.arguments || {}
            }
          }))
        });
      } else {
        ollamaMessages.push({
          role: msg.role,
          content: msg.content
        });
      }
    }

    const body = {
      model: this.model,
      messages: ollamaMessages,
      stream: false,
      think: false,
      options: {
        num_predict: 1024
      }
    };

    if (tools && tools.length > 0) {
      body.tools = tools;
    }

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this.timeout);

    try {
      const response = await fetch(`${this.endpoint}/api/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: controller.signal
      });

      clearTimeout(timeoutId);

      if (!response.ok) {
        const errText = await response.text();
        throw new Error(`Ollama error ${response.status}: ${errText}`);
      }

      const data = await response.json();
      return this._parseResponse(data);

    } catch (err) {
      clearTimeout(timeoutId);
      if (err.name === 'AbortError') {
        throw new Error(`Ollama request timed out after ${this.timeout}ms`);
      }
      throw err;
    }
  }

  /** @private */
  _parseResponse(data) {
    const message = data.message || {};

    if (message.tool_calls && message.tool_calls.length > 0) {
      return {
        content: message.content || null,
        toolCalls: message.tool_calls.map((tc, i) => ({
          id: `ollama_${Date.now()}_${i}`,
          name: tc.function?.name,
          arguments: tc.function?.arguments || {}
        }))
      };
    }

    return {
      content: message.content || '',
      toolCalls: null
    };
  }
}

module.exports = { OllamaToolsProvider };
