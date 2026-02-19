'use strict';

const fs = require('fs');
const path = require('path');

/**
 * AgentLoop - The Nervous System
 *
 * Core agent loop: receives a user message, builds the LLM prompt with tools,
 * runs the call-parse-execute loop until a final text response, then returns it.
 *
 * @module agent/agent-loop
 * @version 1.0.0
 */

// Tool result size limits to prevent token explosion in multi-iteration chains
const MAX_TOOL_RESULT_CHARS = 8000;  // ~2000 tokens at ~4 chars/token
const MAX_CUMULATIVE_CONTEXT_CHARS = 24000;  // ~6000 tokens — compress older results beyond this
const MAX_CONSECUTIVE_TOOL_FAILURES = 2;  // Skip tool after this many consecutive failures

class AgentLoop {
  /**
   * @param {Object} options
   * @param {import('./tool-registry').ToolRegistry} options.toolRegistry
   * @param {import('../talk/conversation-context').ConversationContext} options.conversationContext
   * @param {import('../knowledge/context-loader').ContextLoader} [options.contextLoader]
   * @param {Object} [options.toolGuard] - ToolGuard instance
   * @param {Object} [options.secretsGuard] - SecretsGuard instance
   * @param {Object} [options.promptGuard] - PromptGuard instance (for content scanning)
   * @param {Object} options.llmProvider - OllamaToolsProvider or ClaudeToolsProvider
   * @param {Object} [options.cockpitManager] - CockpitManager for system prompt overlay
   * @param {Object} [options.dailyBriefing] - DailyBriefing for first-message-of-day greeting
   * @param {Object} [options.config]
   * @param {number} [options.config.maxIterations=8]
   * @param {string} [options.config.soulPath]
   * @param {Object} [options.logger]
   */
  constructor(options) {
    this.toolRegistry = options.toolRegistry;
    this.conversationContext = options.conversationContext;
    this.contextLoader = options.contextLoader || null;
    this.warmMemory = options.warmMemory || null;
    this.cockpitManager = options.cockpitManager || null;
    this.dailyBriefing = options.dailyBriefing || null;
    this.toolGuard = options.toolGuard || null;
    this.secretsGuard = options.secretsGuard || null;
    this.promptGuard = options.promptGuard || null;
    this.llmProvider = options.llmProvider;
    this.statusIndicator = options.statusIndicator || null;
    this.config = options.config || {};
    this.logger = options.logger || console;
    this.maxIterations = this.config.maxIterations || 8;
    this.timezone = this.config.timezone || 'UTC';

    this.soul = this._loadSoul();
  }

  /**
   * Process a user message through the agent loop.
   *
   * @param {string} message - The user's message text
   * @param {string} roomToken - NC Talk room token
   * @param {Object} [options]
   * @param {number} [options.messageId]
   * @returns {Promise<string>} The agent's final text response
   */
  async process(message, roomToken, options = {}) {
    const startTime = Date.now();

    // Reset conversation-level circuit breaker so each new user message
    // gives previously-failed providers a fresh chance
    if (this.llmProvider.resetConversation) {
      this.llmProvider.resetConversation();
    }

    // Propagate requesting user identity to tool handlers
    if (options.user && this.toolRegistry.setRequestContext) {
      this.toolRegistry.setRequestContext({ user: options.user });
    }

    // 1. Load context
    let history = [];
    if (this.conversationContext) {
      try {
        history = await this.conversationContext.getHistory(roomToken, {
          excludeMessageId: options.messageId
        });
      } catch (err) {
        this.logger.warn('[AgentLoop] History fetch failed:', err.message);
      }
    }

    let memoryContext = '';
    if (this.contextLoader) {
      memoryContext = await this._loadMemoryContext();
    }

    let warmMemoryContext = '';
    if (this.warmMemory) {
      try {
        const warmContent = await this.warmMemory.load();
        if (warmContent) {
          warmMemoryContext = `<warm_memory>\n${warmContent}\n</warm_memory>`;
        }
      } catch (err) {
        this.logger.warn('[AgentLoop] Warm memory load failed:', err.message);
      }
    }

    let briefingContext = '';
    if (this.dailyBriefing) {
      try {
        briefingContext = await this.dailyBriefing.checkAndBuild();
      } catch (err) {
        this.logger.warn('[AgentLoop] Briefing failed:', err.message);
      }
    }

    // 2. Build initial messages array
    const systemPrompt = this._buildSystemPrompt(memoryContext, briefingContext, options, warmMemoryContext);
    const tools = this.toolRegistry.getToolDefinitions();

    const messages = [
      ...history.map(m => ({ role: m.role, content: m.content })),
      { role: 'user', content: message }
    ];

    // 3. Agent loop
    const maxIter = options.maxIterations || this.maxIterations;
    let iteration = 0;
    let lastResponse = null;
    const toolFailureCounts = {};  // toolName -> consecutive failure count
    let cumulativeToolResultChars = 0;
    const toolResultIndices = [];  // indices into messages[] of tool results

    while (iteration < maxIter) {
      iteration++;

      this.logger.info(`[AgentLoop] Iteration ${iteration}/${maxIter}`);

      let response;
      try {
        response = await this.llmProvider.chat({
          system: systemPrompt,
          messages,
          tools,
          job: tools.length > 0 ? 'tools' : 'quick'
        });
      } catch (llmErr) {
        // Friendly message on rate limit / overload instead of surfacing raw error
        if (this._isRateLimitError(llmErr)) {
          this.logger.warn(`[AgentLoop] LLM provider rate limited: ${llmErr.message}`);
          lastResponse = this._buildFriendlyLLMError(llmErr);
          break;
        }
        throw llmErr;
      }

      // Text-to-tool-call resilience: if no native tool calls, try parsing from text
      if ((!response.toolCalls || response.toolCalls.length === 0) && response.content) {
        const parsed = this._parseToolCallFromText(response.content);
        if (parsed) {
          this.logger.info(`[AgentLoop] Parsed tool call from text: ${parsed.name}(${JSON.stringify(parsed.arguments)})`);
          response.toolCalls = [parsed];
        }
      }

      // Check if LLM wants to call tools (native or parsed from text)
      if (response.toolCalls && response.toolCalls.length > 0) {
        // Build single assistant message with all tool calls
        const toolCallEntries = response.toolCalls.map(tc => ({
          id: tc.id || `call_${iteration}_${tc.name}`,
          type: 'function',
          function: {
            name: tc.name,
            arguments: JSON.stringify(tc.arguments)
          }
        }));

        messages.push({
          role: 'assistant',
          content: response.content || '',
          tool_calls: toolCallEntries
        });

        // Execute each tool and append results
        const iterationToolsCalled = [];
        for (const toolCall of response.toolCalls) {
          this.logger.info(`[AgentLoop] Tool call: ${toolCall.name}(${JSON.stringify(toolCall.arguments)})`);

          // Update NC user status to reflect the tool being used
          if (this.statusIndicator) {
            this.statusIndicator.setToolStatus(toolCall.name).catch(() => {});
          }

          const callId = toolCall.id || `call_${iteration}_${toolCall.name}`;

          // Check if tool is disabled due to consecutive failures
          if ((toolFailureCounts[toolCall.name] || 0) >= MAX_CONSECUTIVE_TOOL_FAILURES) {
            this.logger.warn(`[AgentLoop] Skipping ${toolCall.name} — failed ${toolFailureCounts[toolCall.name]}x consecutively`);
            messages.push({
              role: 'tool',
              tool_call_id: callId,
              content: `Tool ${toolCall.name} is temporarily unavailable after repeated failures. Work with what you have.`
            });
            iterationToolsCalled.push(toolCall.name);
            continue;
          }

          // Validate with ToolGuard
          let toolResult;
          if (this.toolGuard) {
            const guardResult = this.toolGuard.evaluate(toolCall.name);
            if (!guardResult.allowed) {
              toolResult = {
                success: false,
                result: '',
                error: `Tool call blocked by security policy: ${guardResult.reason}`
              };
              this.logger.warn(`[AgentLoop] ToolGuard blocked: ${toolCall.name} — ${guardResult.reason}`);
            } else {
              toolResult = await this.toolRegistry.execute(toolCall.name, toolCall.arguments);
            }
          } else {
            toolResult = await this.toolRegistry.execute(toolCall.name, toolCall.arguments);
          }

          // Track tool failures (don't count errors toward maxIterations)
          if (!toolResult.success) {
            toolFailureCounts[toolCall.name] = (toolFailureCounts[toolCall.name] || 0) + 1;
            this.logger.warn(`[AgentLoop] Tool ${toolCall.name} failed (${toolFailureCounts[toolCall.name]}x): ${toolResult.error}`);
          } else {
            toolFailureCounts[toolCall.name] = 0; // Reset on success
          }

          let resultContent = toolResult.success
            ? toolResult.result
            : `Error: ${toolResult.error}`;

          // Trim large tool results to prevent token explosion
          resultContent = this._trimToolResult(resultContent);

          // Sanitize tool results before feeding back to LLM
          if (this.secretsGuard && resultContent) {
            const scanResult = this.secretsGuard.scan(resultContent);
            if (scanResult.hasSecrets) {
              this.logger.warn(`[AgentLoop] SecretsGuard redacted tool result for ${toolCall.name}`);
              resultContent = scanResult.sanitized;
            }
          }

          // Phase 2: Content provenance tagging + injection scanning
          resultContent = await this._applyContentProvenance(
            toolCall.name, resultContent, toolCall.arguments
          );

          // Context growth management: compress older tool results if cumulative exceeds limit
          cumulativeToolResultChars += (resultContent || '').length;
          if (cumulativeToolResultChars > MAX_CUMULATIVE_CONTEXT_CHARS && toolResultIndices.length >= 2) {
            this._compressOlderToolResults(messages, toolResultIndices);
          }

          const msgIdx = messages.length;
          messages.push({
            role: 'tool',
            tool_call_id: callId,
            content: resultContent
          });
          toolResultIndices.push(msgIdx);
          iterationToolsCalled.push(toolCall.name);
        }

        // Log iteration metadata
        this.logger.info(`[AgentLoop] Iteration ${iteration} metadata: { toolsCalled: [${iterationToolsCalled.join(', ')}], cumulativeContextChars: ${cumulativeToolResultChars} }`);

        // Continue loop — LLM will process tool results
        continue;
      }

      // No tool calls — this is the final text response
      lastResponse = response.content || '';
      break;
    }

    if (!lastResponse && iteration >= maxIter) {
      // Check if we have pending tool results — give the LLM one final chance
      // to summarize what happened (no tools, so it MUST give a text response).
      // This prevents the "wiki_write on iteration 8" swallowed-result bug.
      const lastMsg = messages[messages.length - 1];
      if (lastMsg && lastMsg.role === 'tool') {
        try {
          this.logger.info('[AgentLoop] Final summarization call (tool results pending at max iterations)');
          const finalResponse = await this.llmProvider.chat({
            system: systemPrompt,
            messages,
            tools: [],
            job: 'quick'
          });
          if (finalResponse.content) {
            lastResponse = finalResponse.content;
          }
        } catch (e) {
          this.logger.warn(`[AgentLoop] Final summarization failed: ${e.message}`);
        }
      }

      if (!lastResponse) {
        lastResponse = 'I ran into a loop trying to process your request. Please try rephrasing.';
        this.logger.warn(`[AgentLoop] Hit max iterations (${maxIter})`);
      }
    }

    // 4. Sanitize output
    if (this.secretsGuard && lastResponse) {
      const scanResult = this.secretsGuard.scan(lastResponse);
      if (scanResult.hasSecrets) {
        this.logger.warn(`[AgentLoop] SecretsGuard redacted ${scanResult.findings.length} finding(s)`);
        lastResponse = scanResult.sanitized;
      }
    }

    const elapsed = Date.now() - startTime;
    this.logger.info(`[AgentLoop] Complete in ${elapsed}ms, ${iteration} iteration(s)`);

    return lastResponse;
  }

  /**
   * Process a workflow task. Similar to process(), but the "message" is a
   * workflow instruction and the system prompt includes the board's rules.
   * No conversation history, no briefing — just SOUL + memory + workflow context.
   *
   * @param {Object} params
   * @param {string} params.systemAddition - Workflow context to add to system prompt
   * @param {string} params.task - The task description
   * @param {number} params.boardId - For logging/tracking
   * @param {number} params.cardId - For logging/tracking
   * @param {number} params.stackId - For logging/tracking
   * @param {boolean} [params.forceLocal] - Force local LLM provider
   * @param {number} [params.maxIterations] - Override max iterations (default: this.maxIterations)
   * @returns {Promise<string>} The agent's final text response
   */
  async processWorkflowTask({ systemAddition, task, boardId, cardId, stackId, forceLocal, maxIterations }) {
    const startTime = Date.now();
    const iterLimit = maxIterations || this.maxIterations;
    this.logger.info(`[AgentLoop] Workflow task: board=${boardId} card=${cardId} maxIter=${iterLimit}`);

    // Reset conversation-level circuit breaker — each workflow task is standalone
    if (this.llmProvider.resetConversation) {
      this.llmProvider.resetConversation();
    }

    // Workflow tasks always use lean prompt — regardless of provider.
    // The card context in systemAddition has everything needed.
    // This cuts system prompt from ~15,000 tokens to ~200-300.
    const now = new Date();
    const tz = this.timezone;
    const dateStr = new Intl.DateTimeFormat('en-US', {
      weekday: 'long', year: 'numeric', month: 'long', day: 'numeric', timeZone: tz
    }).format(now);
    const systemPrompt = `Today is ${dateStr}.\nYou are a workflow agent. Follow the board rules exactly. Be concise. One comment per action. Do not call tools you don't need.\n\n${systemAddition}`;

    let tools;
    if (forceLocal) {
      tools = this.toolRegistry.getWorkflowToolDefinitions();
    } else {
      tools = this.toolRegistry.getCloudWorkflowToolDefinitions(systemAddition);
    }

    const messages = [
      { role: 'user', content: task }
    ];

    // Agent loop — same tool-calling loop as process()
    let iteration = 0;
    let lastResponse = null;
    const toolFailureCounts = {};
    let cumulativeToolResultChars = 0;
    const toolResultIndices = [];

    while (iteration < iterLimit) {
      iteration++;
      this.logger.info(`[AgentLoop] Workflow iteration ${iteration}/${iterLimit}`);

      let response;
      try {
        response = await this.llmProvider.chat({
          system: systemPrompt,
          messages,
          tools,
          forceLocal,
          job: tools.length > 0 ? 'tools' : 'quick'
        });
      } catch (llmErr) {
        if (this._isRateLimitError(llmErr)) {
          this.logger.warn(`[AgentLoop] Workflow LLM rate limited: ${llmErr.message}`);
          lastResponse = 'Workflow processing paused — ' + this._buildFriendlyLLMError(llmErr);
          break;
        }
        throw llmErr;
      }

      // Text-to-tool-call resilience
      if ((!response.toolCalls || response.toolCalls.length === 0) && response.content) {
        const parsed = this._parseToolCallFromText(response.content);
        if (parsed) {
          this.logger.info(`[AgentLoop] Workflow parsed tool from text: ${parsed.name}`);
          response.toolCalls = [parsed];
        }
      }

      if (response.toolCalls && response.toolCalls.length > 0) {
        const toolCallEntries = response.toolCalls.map(tc => ({
          id: tc.id || `wf_${iteration}_${tc.name}`,
          type: 'function',
          function: { name: tc.name, arguments: JSON.stringify(tc.arguments) }
        }));

        messages.push({
          role: 'assistant',
          content: response.content || '',
          tool_calls: toolCallEntries
        });

        for (const toolCall of response.toolCalls) {
          const callId = toolCall.id || `wf_${iteration}_${toolCall.name}`;

          if ((toolFailureCounts[toolCall.name] || 0) >= MAX_CONSECUTIVE_TOOL_FAILURES) {
            messages.push({
              role: 'tool', tool_call_id: callId,
              content: `Tool ${toolCall.name} is temporarily unavailable after repeated failures.`
            });
            continue;
          }

          let toolResult;
          if (this.toolGuard) {
            const guardResult = this.toolGuard.evaluate(toolCall.name);
            if (!guardResult.allowed) {
              toolResult = { success: false, result: '', error: `Blocked: ${guardResult.reason}` };
            } else {
              toolResult = await this.toolRegistry.execute(toolCall.name, toolCall.arguments);
            }
          } else {
            toolResult = await this.toolRegistry.execute(toolCall.name, toolCall.arguments);
          }

          if (!toolResult.success) {
            toolFailureCounts[toolCall.name] = (toolFailureCounts[toolCall.name] || 0) + 1;
          } else {
            toolFailureCounts[toolCall.name] = 0;
          }

          let resultContent = toolResult.success ? toolResult.result : `Error: ${toolResult.error}`;
          resultContent = this._trimToolResult(resultContent);

          if (this.secretsGuard && resultContent) {
            const scanResult = this.secretsGuard.scan(resultContent);
            if (scanResult.hasSecrets) resultContent = scanResult.sanitized;
          }

          // Content provenance tagging + injection scanning
          resultContent = await this._applyContentProvenance(
            toolCall.name, resultContent, toolCall.arguments
          );

          cumulativeToolResultChars += (resultContent || '').length;
          if (cumulativeToolResultChars > MAX_CUMULATIVE_CONTEXT_CHARS && toolResultIndices.length >= 2) {
            this._compressOlderToolResults(messages, toolResultIndices);
          }

          const msgIdx = messages.length;
          messages.push({ role: 'tool', tool_call_id: callId, content: resultContent });
          toolResultIndices.push(msgIdx);
        }
        continue;
      }

      // Final text response
      lastResponse = response.content || '';
      break;
    }

    if (!lastResponse && iteration >= iterLimit) {
      lastResponse = `⚠️ Reached maximum processing steps (${iterLimit}). Card may need human attention.`;
      this.logger.warn(`[AgentLoop] Workflow hit iteration cap (${iterLimit}) for card=${cardId}`);
    }

    if (this.secretsGuard && lastResponse) {
      const scanResult = this.secretsGuard.scan(lastResponse);
      if (scanResult.hasSecrets) lastResponse = scanResult.sanitized;
    }

    const elapsed = Date.now() - startTime;
    this.logger.info(`[AgentLoop] Workflow complete in ${elapsed}ms, ${iteration} iteration(s)`);

    return lastResponse;
  }

  /**
   * Trim a tool result to stay within token budget.
   * Cuts at the last newline boundary to avoid breaking structured data.
   *
   * @param {string} result - Raw tool result string
   * @returns {string} Trimmed result
   * @private
   */
  _trimToolResult(result) {
    if (!result || result.length <= MAX_TOOL_RESULT_CHARS) {
      return result;
    }

    const truncated = result.substring(0, MAX_TOOL_RESULT_CHARS);
    // Cut at last newline to avoid breaking mid-line
    const lastNewline = truncated.lastIndexOf('\n');
    const cleanCut = lastNewline > MAX_TOOL_RESULT_CHARS * 0.8
      ? truncated.substring(0, lastNewline)
      : truncated;

    const originalTokens = Math.ceil(result.length / 4);
    return cleanCut + `\n\n[... truncated, showing ~${Math.ceil(cleanCut.length / 4)} of ${originalTokens} tokens]`;
  }

  /** @private */
  _buildSystemPrompt(memoryContext, briefingContext, options = {}, warmMemoryContext = '') {
    // Inject current date/time in the configured timezone so the LLM knows today's date (P1-1)
    const now = new Date();
    const tz = this.timezone;
    const dateStr = new Intl.DateTimeFormat('en-US', {
      weekday: 'long', year: 'numeric', month: 'long', day: 'numeric',
      timeZone: tz
    }).format(now);
    const timeStr = new Intl.DateTimeFormat('en-US', {
      hour: '2-digit', minute: '2-digit', hour12: false,
      timeZone: tz
    }).format(now);
    const dateHeader = `Today is ${dateStr}. Current time: ${timeStr} (24h format, ${tz}). Use this for all date-related queries.\n\n`;

    // Style directive goes FIRST — before identity, tools, everything.
    // Persona directive goes SECOND — constrains how the style is expressed.
    // Positional authority matters: LLMs weight early instructions more heavily.
    let stylePrefix = '';
    let personaPrefix = '';
    if (this.cockpitManager) {
      try {
        const directive = this.cockpitManager.buildStyleDirective();
        if (directive) {
          stylePrefix = directive + '\n\n';
        }
      } catch (err) {
        this.logger.warn('[AgentLoop] Style directive failed:', err.message);
      }
      try {
        const personaDirective = this.cockpitManager.buildPersonaDirective();
        if (personaDirective) {
          personaPrefix = personaDirective + '\n\n';
        }
      } catch (err) {
        this.logger.warn('[AgentLoop] Persona directive failed:', err.message);
      }
    }

    let prompt = stylePrefix + personaPrefix + dateHeader + (this.soul || '');

    if (memoryContext) {
      prompt += `\n\n${memoryContext}`;
    }

    if (warmMemoryContext) {
      prompt += `\n\n${warmMemoryContext}`;
    }

    if (briefingContext) {
      prompt += `\n\n${briefingContext}`;
    }

    // Cockpit overlay: inject active configuration from Deck control plane
    if (this.cockpitManager) {
      try {
        const cockpitOverlay = this.cockpitManager.buildSystemPromptOverlay();
        if (cockpitOverlay) {
          prompt += `\n\n${cockpitOverlay}`;
        }
      } catch (err) {
        this.logger.warn('[AgentLoop] Cockpit overlay failed:', err.message);
      }
    }

    // Voice input context: help LLM interpret transcribed speech
    if (options.inputType === 'voice') {
      prompt += '\n\n## Voice Input Context\n\n'
        + "The user's message was transcribed from a voice recording.\n"
        + 'It may contain filler words, hesitations, or informal phrasing.\n'
        + 'Interpret the intent generously. If unclear, confirm briefly before acting.\n\n'
        + 'Keep your response concise and conversational.';

      if (options.voiceReplyEnabled) {
        prompt += '\n\n## Voice Reply Output\n\n'
          + 'Your response will be synthesized as spoken audio.\n'
          + 'Keep it concise: aim for 2-3 sentences.\n'
          + 'Avoid markdown, URLs, code blocks, and special formatting.\n'
          + 'Write naturally as if speaking aloud.';
      }
    }

    return prompt;
  }

  /** @private */
  _loadSoul() {
    const localPath = this.config.soulPath
      || path.join(__dirname, '..', '..', '..', 'config', 'SOUL.md');

    try {
      return fs.readFileSync(localPath, 'utf-8');
    } catch (e) {
      this.logger.warn(`[AgentLoop] Could not load SOUL.md from ${localPath}: ${e.message}`);
      return 'You are Moltagent, a sovereign AI assistant running inside Nextcloud. Help the user manage tasks, calendar, and files.';
    }
  }

  /**
   * Parse a tool call from LLM text output (resilience for smaller models).
   * Detects two formats:
   *   JSON: {"name": "tool_name", "parameters": {...}}
   *   Function-style: tool_name({"key": "value"})
   *
   * Only returns a match if the tool name exists in the registry.
   *
   * @param {string} text - The LLM's text response
   * @returns {{id: string, name: string, arguments: Object}|null}
   * @private
   */
  _parseToolCallFromText(text) {
    if (!text) return null;

    // Pattern 1: JSON object with name + parameters
    // e.g. {"name": "deck_move_card", "parameters": {"card": "#44", "target_stack": "Done"}}
    const jsonMatch = text.match(/\{\s*"name"\s*:\s*"([^"]+)"\s*,\s*"parameters"\s*:\s*(\{[^}]*\})\s*\}/);
    if (jsonMatch) {
      const resolved = this._resolveToolName(jsonMatch[1]);
      if (resolved) {
        try {
          const args = JSON.parse(jsonMatch[2]);
          return { id: `parsed_${Date.now()}`, name: resolved, arguments: args };
        } catch { /* invalid JSON args, fall through */ }
      }
    }

    // Pattern 2: Function-style call
    // e.g. deck_move_card({"card": "#44", "target_stack": "Done"})
    const funcMatch = text.match(/\b([a-z][a-z0-9_]+)\s*\(\s*(\{[^}]*\})\s*\)/);
    if (funcMatch) {
      const resolved = this._resolveToolName(funcMatch[1]);
      if (resolved) {
        try {
          const args = JSON.parse(funcMatch[2]);
          return { id: `parsed_${Date.now()}`, name: resolved, arguments: args };
        } catch { /* invalid JSON args, fall through */ }
      }
    }

    // Pattern 2b: Function-style with keyword args: tool_name(key="value", key2="value2")
    const kwMatch = text.match(/\b([a-z][a-z0-9_]+)\s*\(([^)]+)\)/);
    if (kwMatch) {
      const resolved = this._resolveToolName(kwMatch[1]);
      if (resolved) {
        const argsStr = kwMatch[2];
        const argPairs = argsStr.match(/(\w+)\s*=\s*"([^"]*)"/g);
        if (argPairs && argPairs.length > 0) {
          const args = {};
          for (const pair of argPairs) {
            const [key, val] = pair.split(/\s*=\s*/);
            args[key] = val.replace(/^"|"$/g, '');
          }
          return { id: `parsed_${Date.now()}`, name: resolved, arguments: args };
        }
      }
    }

    return null;
  }

  /**
   * Resolve a tool name, with fuzzy suffix matching as fallback.
   * If the exact name exists, return it. Otherwise, check if exactly one
   * registered tool ends with the given name (e.g. "list_cards" → "deck_list_cards").
   *
   * @param {string} name - Tool name from LLM output
   * @returns {string|null} Resolved tool name, or null if no match
   * @private
   */
  _resolveToolName(name) {
    if (this.toolRegistry.has(name)) return name;

    // Fuzzy: find tools whose name ends with the parsed name
    const suffix = `_${name}`;
    const candidates = this.toolRegistry.getToolDefinitions()
      .map(t => t.function.name)
      .filter(n => n.endsWith(suffix) || n === name);

    if (candidates.length === 1) {
      this.logger.info(`[AgentLoop] Fuzzy matched tool "${name}" → "${candidates[0]}"`);
      return candidates[0];
    }

    return null;
  }

  /** @private */
  async _loadMemoryContext() {
    try {
      return await this.contextLoader.loadContext();
    } catch (e) {
      this.logger.warn('[AgentLoop] Could not load memory context:', e.message);
      return '';
    }
  }

  /**
   * Check whether an error is a rate-limit (429) or overload error.
   * @param {Error} err
   * @returns {boolean}
   * @private
   */
  _isRateLimitError(err) {
    if (err.status === 429 || err.status === 529) return true;
    if (!err.message) return false;
    const msg = err.message.toLowerCase();
    return msg.includes('rate limit') || msg.includes('overloaded') ||
           msg.includes('timed out') || msg.includes('error 429') ||
           msg.includes('error 529') || msg.includes('too many requests');
  }

  /**
   * Build a friendly user-facing message from an LLM error,
   * including error chain context when available.
   * @param {Error} err
   * @returns {string}
   * @private
   */
  _buildFriendlyLLMError(err) {
    // ProviderChain attaches _errorChain when both primary and fallback fail
    if (err._errorChain) {
      return `I couldn't process that — ${err._errorChain.primary}, ` +
             `then ${err._errorChain.fallback}. ` +
             'Please try again in a moment.';
    }

    // Single provider failure
    const msg = (err.message || '').toLowerCase();
    if (msg.includes('overloaded') || msg.includes('529')) {
      return "The AI service (Claude) is temporarily overloaded on Anthropic's side. " +
             'Please try again in a minute or two.';
    }
    if (msg.includes('timed out')) {
      return 'The AI service took too long to respond. Please try again.';
    }
    return "I'm a bit busy right now — the AI service is temporarily " +
           'at capacity. Please try again in a minute or two.';
  }

  /**
   * Compress older tool results to keep cumulative context under budget.
   * Keeps the most recent 2 tool results in full; summarizes everything older
   * to a single-line preview.
   *
   * @param {Array<Object>} messages - The conversation messages array (mutated in place)
   * @param {Array<number>} toolResultIndices - Indices into messages[] of tool results
   * @private
   */
  _compressOlderToolResults(messages, toolResultIndices) {
    // Keep the most recent 2 tool results in full
    const toCompress = toolResultIndices.slice(0, -2);

    for (const idx of toCompress) {
      const msg = messages[idx];
      if (!msg || msg.role !== 'tool' || msg._compressed) continue;

      const content = msg.content || '';
      const lineCount = content.split('\n').length;
      const charCount = content.length;

      // Extract first non-empty line as preview, truncated to 100 chars
      const firstLine = content.split('\n').find(l => l.trim()) || '(empty result)';
      const preview = firstLine.length > 100 ? firstLine.substring(0, 100) + '...' : firstLine;

      msg.content = `[Summarized: ${preview} — ${lineCount} lines, ${charCount} chars original]`;
      msg._compressed = true;

      this.logger.info(`[AgentLoop] Compressed tool result at index ${idx} (${charCount} → ${msg.content.length} chars)`);
    }
  }

  /**
   * Apply content provenance tagging and injection scanning to tool results.
   * Wraps untrusted content with trust boundary tags and scans for injection.
   *
   * @param {string} toolName - Name of the tool that produced the result
   * @param {string} resultContent - Raw tool result content
   * @param {Object} toolArgs - Tool call arguments (for metadata)
   * @returns {Promise<string>} Processed content (possibly framed or replaced)
   * @private
   */
  async _applyContentProvenance(toolName, resultContent, toolArgs) {
    if (!resultContent) return resultContent;

    let ContentProvenance;
    try {
      ContentProvenance = require('../../security/content-provenance');
    } catch {
      return resultContent; // ContentProvenance not available
    }

    const trustLevel = ContentProvenance.trustForTool(toolName);

    // Only process untrusted content (EXTERNAL or STORED)
    if (trustLevel !== ContentProvenance.TRUST.EXTERNAL &&
        trustLevel !== ContentProvenance.TRUST.STORED) {
      return resultContent;
    }

    // Build provenance metadata
    const metadata = { tool: toolName };
    if (toolArgs?.url) metadata.url = toolArgs.url;
    if (toolArgs?.path) metadata.path = toolArgs.path;
    if (toolArgs?.page_title) metadata.page_title = toolArgs.page_title;

    const wrapped = ContentProvenance.wrap(resultContent, trustLevel, metadata);

    // Scan with PromptGuard if available
    if (this.promptGuard && typeof this.promptGuard.scanContent === 'function') {
      try {
        const scan = await this.promptGuard.scanContent(wrapped);

        if (!scan.allowed) {
          const source = metadata.url || metadata.path || toolName;
          this.logger.warn(`[AgentLoop] PromptGuard blocked content from ${toolName}: ${scan.evidence || 'injection detected'}`);

          if (trustLevel === ContentProvenance.TRUST.EXTERNAL) {
            return `[Content from ${source} was blocked: potential prompt injection detected]`;
          }
          return `[Content from ${source} flagged: potential injection pattern. Quarantine recommended.]`;
        }
      } catch (err) {
        this.logger.warn(`[AgentLoop] PromptGuard scanContent failed for ${toolName}: ${err.message}`);
        // Fail closed for EXTERNAL content — no downstream guards catch injection
        if (trustLevel === ContentProvenance.TRUST.EXTERNAL) {
          const source = metadata.url || metadata.page_title || toolName;
          return `[Content from ${source} unavailable: security scan failed]`;
        }
        // Fail open for STORED content — framing still provides some protection
      }
    }

    // Frame external content with trust boundary tags
    if (trustLevel === ContentProvenance.TRUST.EXTERNAL) {
      return ContentProvenance.frameExternalContent(resultContent, metadata);
    }

    return resultContent;
  }
}

module.exports = { AgentLoop };
