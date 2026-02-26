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
   * @param {string} config.model - Model name (e.g., phi4-mini)
   * @param {number} [config.timeout=300000] - Default timeout for simple requests
   * @param {number} [config.toolTimeout=60000] - Timeout when tools are present (tool-heavy prompts)
   * @param {Object} [logger]
   */
  constructor(config, logger) {
    this.endpoint = (config.endpoint || 'http://localhost:11434').replace(/\/$/, '');
    this.model = config.model || 'phi4-mini';
    this.timeout = config.timeout || 300000;
    this.toolTimeout = config.toolTimeout || 60000;
    this.logger = logger || console;
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
          this.logger.warn(`[OllamaToolsProvider] fetch failed (attempt ${attempt + 1}), retrying in ${delayMs}ms`);
          await new Promise(r => setTimeout(r, delayMs));
          continue;
        }
        throw err;
      }
    }
  }

  /**
   * Send a chat request with tool definitions.
   *
   * @param {Object} params
   * @param {string} params.system - System prompt
   * @param {Array} params.messages - Conversation messages
   * @param {Array} params.tools - Tool definitions
   * @param {number} [params.timeout] - Override timeout (ms). If not set, uses toolTimeout for tool requests, default timeout otherwise.
   * @returns {Promise<{content: string|null, toolCalls: Array|null}>}
   */
  async chat({ system, messages, tools, timeout, format }) {
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

    if (format) {
      body.format = format;
    }

    // Timeout priority: explicit override > toolTimeout (when tools present) > default
    // Domain tool-calling uses 90s override; full AgentLoop uses 60s toolTimeout.
    const effectiveTimeout = timeout || ((tools && tools.length > 0) ? this.toolTimeout : this.timeout);

    const controller = new AbortController();

    // Hard timeout via Promise.race — AbortController alone doesn't force-close
    // the TCP connection promptly (Ollama can linger ~90s after abort signal).
    let timerId;
    const timeoutPromise = new Promise((_, reject) => {
      timerId = setTimeout(() => {
        controller.abort();
        reject(new Error(`Ollama request timed out after ${effectiveTimeout}ms`));
      }, effectiveTimeout);
    });

    try {
      const fetchPromise = (async () => {
        const response = await this._fetchWithRetry(`${this.endpoint}/api/chat`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
          signal: controller.signal
        });

        if (!response.ok) {
          const errText = await response.text();
          throw new Error(`Ollama error ${response.status}: ${errText}`);
        }

        const data = await response.json();
        return this._parseResponse(data);
      })();

      const result = await Promise.race([fetchPromise, timeoutPromise]);
      clearTimeout(timerId);
      return result;

    } catch (err) {
      clearTimeout(timerId);
      controller.abort();
      throw err;
    }
  }

  /** @private */
  _parseResponse(data) {
    const message = data.message || {};
    const inputTokens = data.prompt_eval_count || 0;
    const outputTokens = data.eval_count || 0;

    const base = {
      _inputTokens: inputTokens,
      _outputTokens: outputTokens,
      _tokens: inputTokens + outputTokens,
    };

    if (message.tool_calls && message.tool_calls.length > 0) {
      return {
        content: message.content || null,
        toolCalls: message.tool_calls.map((tc, i) => ({
          id: `ollama_${Date.now()}_${i}`,
          name: tc.function?.name,
          arguments: tc.function?.arguments || {}
        })),
        ...base
      };
    }

    return {
      content: message.content || '',
      toolCalls: null,
      ...base
    };
  }
}

module.exports = { OllamaToolsProvider };
