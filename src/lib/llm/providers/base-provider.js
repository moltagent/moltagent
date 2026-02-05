/**
 * Base Provider Class
 *
 * Abstract base class for all LLM provider adapters.
 * Each provider implements the generate() method.
 *
 * @module llm/providers/base-provider
 * @version 1.0.0
 */

const fs = require('fs');
const path = require('path');

let _systemPrompt = null;

function getSystemPrompt() {
  if (!_systemPrompt) {
    try {
      _systemPrompt = fs.readFileSync(
        path.join(__dirname, '../../../../config/system-prompt.md'), 'utf8'
      );
    } catch (e) {
      console.error('Failed to load system-prompt.md:', e.message);
      _systemPrompt = 'You are MoltAgent, a sovereign AI assistant.';
    }
  }
  return _systemPrompt;
}

class BaseProvider {
  /**
   * @param {Object} config - Provider configuration
   * @param {string} config.id - Unique provider identifier
   * @param {string} config.type - 'local' or 'api'
   * @param {string} config.endpoint - API endpoint URL
   * @param {string} config.model - Model identifier
   * @param {Object} [config.costModel] - Cost model for budgeting
   * @param {Object} [config.rateLimits] - Known rate limits
   * @param {Function} [config.getCredential] - Async function to get API key
   */
  constructor(config) {
    if (new.target === BaseProvider) {
      throw new Error('BaseProvider is abstract and cannot be instantiated directly');
    }

    this.id = config.id;
    this.type = config.type || 'api';
    this.endpoint = config.endpoint;
    this.model = config.model;
    this.costModel = config.costModel || { type: 'free' };
    this.rateLimits = config.rateLimits || {};
    this.getCredential = config.getCredential || (async () => null);

    // Stats
    this.stats = {
      calls: 0,
      tokens: 0,
      errors: 0,
      lastCall: null,
      lastError: null
    };
  }

  isLocal() { return this.type === 'local'; }

  /**
   * Generate a response from the LLM
   * @abstract
   * @param {string} task - Task type for prompt building
   * @param {string} content - The content/prompt
   * @param {Object} [options] - Generation options
   * @param {number} [options.maxTokens] - Maximum response tokens
   * @param {number} [options.temperature] - Temperature (0-1)
   * @returns {Promise<Object>} - { result, tokens, headers, duration }
   */
  async generate(task, content, options = {}) {
    throw new Error('generate() must be implemented by subclass');
  }

  /**
   * Test connection to the provider
   * @returns {Promise<Object>} - { connected: boolean, error?: string, models?: string[] }
   */
  async testConnection() {
    throw new Error('testConnection() must be implemented by subclass');
  }

  /**
   * Estimate token count for content
   * @param {string} text - Text to estimate
   * @returns {number} - Estimated token count
   */
  estimateTokens(text) {
    // Rough estimation: ~4 chars per token for English
    return Math.ceil((text || '').length / 4);
  }

  /**
   * Estimate cost for a request
   * @param {number} inputTokens - Input token count
   * @param {number} outputTokens - Output token count
   * @returns {number} - Estimated cost in USD
   */
  estimateCost(inputTokens, outputTokens) {
    if (this.costModel.type === 'free') return 0;
    if (this.costModel.type === 'fixed') return 0; // Fixed monthly, not per-request

    const inputCost = (inputTokens * (this.costModel.inputPer1M || 0)) / 1000000;
    const outputCost = (outputTokens * (this.costModel.outputPer1M || 0)) / 1000000;
    return inputCost + outputCost;
  }

  /**
   * Build a prompt based on task type
   * @param {string} task - Task type
   * @param {string} content - Content to include
   * @param {Object} [options] - Additional options
   * @returns {string} - Formatted prompt
   */
  buildPrompt(task, content, options = {}) {
    const identity = getSystemPrompt();

    const taskPrompts = {
      research: `${identity}

## Current Task: Research
Analyze the following and provide key insights, findings, and recommendations.

Task: ${content}

Provide a concise but thorough analysis. Include:
1. Summary of what this is
2. Key features or points
3. Potential concerns or considerations
4. Your recommendation

Be direct and actionable.`,

      writing: `${identity}

## Current Task: Writing
Help with the following writing task.

Task: ${content}

Provide clear, well-structured content. Match the appropriate tone and style for the context.`,

      admin: `${identity}

## Current Task: Admin
Help with the following task.

Task: ${content}

Provide clear, actionable steps or information.`,

      chat: `${identity}

## Current Conversation

The user is chatting with you in Nextcloud Talk. Respond naturally and helpfully.
If the conversation includes history from previous messages, use it to maintain context.
If the user references something discussed earlier, resolve the reference using the conversation history.

${content}`,

      classify: `${identity}\n\n${content}`,

      followup: `${identity}\n\n${content}`,

      heartbeat_scan: `${identity}\n\n${content}`,

      generic: `${identity}

Task: ${content}`
    };

    return taskPrompts[task] || taskPrompts.generic;
  }

  /**
   * Record a successful call
   * @param {number} tokens - Tokens used
   */
  recordSuccess(tokens) {
    this.stats.calls++;
    this.stats.tokens += tokens;
    this.stats.lastCall = Date.now();
  }

  /**
   * Record an error
   * @param {Error} error - The error
   */
  recordError(error) {
    this.stats.errors++;
    this.stats.lastError = {
      message: error.message,
      timestamp: Date.now()
    };
  }

  /**
   * Get provider statistics
   * @returns {Object} - Stats object
   */
  getStats() {
    return { ...this.stats };
  }
}

module.exports = BaseProvider;
