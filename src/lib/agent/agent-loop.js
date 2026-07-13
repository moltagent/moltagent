'use strict';

const fs = require('fs');
const path = require('path');
const { extractArtifact } = require('./artifact-extractor');
const { stagesApprovalCeremony, stripApprovalMarker, ACTION_REPROMPT_DIRECTIVE } = require('./action-guard');
const { isWriteClass } = require('./guardrail-enforcer');
const { surfaceText, normalizeLanguage } = require('./surface-text');
const { injectLiveDate } = require('./calendar-date-grounding');

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
    this.guardrailEnforcer = options.guardrailEnforcer || null;
    this.llmProvider = options.llmProvider;
    this.statusIndicator = options.statusIndicator || null;
    this.activityLogger = options.activityLogger || null;
    // ModelScorecard (maturation loop): envelope-level tools outcomes — a
    // valid tool call promotes the (tools, model) pairing, a hallucinated
    // tool name or a tool-less action turn demotes it. The model identity
    // comes from response._routing.model (computed once at RouterChatBridge).
    this.modelScorecard = options.modelScorecard || null;
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
   * @param {string} [options.gate] - Classification gate; which pipeline the
   *   message needs. With expectsMutation, 'action' arms the mutation guard.
   * @param {boolean} [options.expectsMutation] - Whether the user asked for state
   *   to be CHANGED, from the verdict (#272). Only an explicit `false` disarms the
   *   honesty guard and trailer; absent or unknown leaves them armed.
   * @param {string} [options.language] - The language the USER wrote in, resolved
   *   from the verdict with the persona as fallback (#273). Picks the honesty
   *   trailer's template and is carried into a PendingAction record at birth.
   *   Unset falls back to EN.
   * @returns {Promise<string>} The agent's final text response
   */
  async process(message, roomToken, options = {}) {
    const startTime = Date.now();

    // Reset conversation-level circuit breaker so each new user message
    // gives previously-failed providers a fresh chance
    if (this.llmProvider.resetConversation) {
      this.llmProvider.resetConversation();
    }

    // Propagate requesting user identity and the turn's language to tool
    // handlers. The language (verdict-derived, #273/#274) lets a handler default
    // user-facing calendar content — e.g. an absent event title — in the tongue
    // the user wrote in, without any handler re-deriving it from message text.
    if (this.toolRegistry.setRequestContext) {
      this.toolRegistry.setRequestContext({ user: options.user, language: options.language });
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
    const systemPrompt = this._buildSystemPrompt(memoryContext, briefingContext, options, warmMemoryContext, history);
    // #133: scope the advertised tools to the verdict's domain when it is a single,
    // known, non-compound domain. Null/unknown/compound → full registry. Execution
    // is uncaged (ToolRegistry.execute reads the full map), so this guides the
    // model's first choice without stranding the turn.
    const scopeDomain = (options.domain && !options.compound && this.toolRegistry.hasDomainTools(options.domain))
      ? options.domain
      : null;
    // The live date is injected INTO the calendar tools' `start` description
    // here, at the single per-turn seam where the subset and full paths
    // converge (#168, PR-4). qwen3:8b ignores the "Today is …" system header —
    // far from the argument it generates — and anchors "tomorrow" to its ~2023
    // training prior; a schema description sits next to that argument. The
    // transform clones (never mutates the shared registry schema), so a stale
    // date cannot leak into a later turn. Inert for cloud models, which already
    // ground. See calendar-date-grounding.js.
    const tools = injectLiveDate(
      scopeDomain
        ? this.toolRegistry.getToolSubset(scopeDomain)
        : this.toolRegistry.getToolDefinitions(),
      new Date(),
      this.timezone
    );

    const messages = [
      ...history.map(m => ({ role: m.role, content: m.content })),
      { role: 'user', content: message }
    ];

    // Inject optional system-level context (e.g. memory flush prompt)
    if (options.systemSuffix) {
      messages.push({ role: 'system', content: options.systemSuffix });
    }

    // 3. Agent loop
    let maxIter = options.maxIterations || this.maxIterations;
    let iteration = 0;
    let lastResponse = null;
    const toolFailureCounts = {};  // toolName -> consecutive failure count
    let cumulativeToolResultChars = 0;
    const toolResultIndices = [];  // indices into messages[] of tool results
    const failedCallIds = new Set();  // tool_call_ids that returned errors
    let actionGuardFired = false;  // once-per-turn re-prompt for tool-less action responses

    // #81 commit 2: the names of tools this turn actually invoked, accumulated
    // across iterations. toolResultIndices holds message indices, not names, and
    // iterationToolsCalled resets each iteration — neither can answer "did this
    // turn change anything?". A name lands here only where the tool is really
    // handed to _executeWithGuards, so the consecutive-failure skip path (which
    // pushes to iterationToolsCalled for a tool that never ran) cannot fake a
    // mutation. A DENIED or timed-out call does land here, and must: the guard
    // polices narration-instead-of-invocation, and a refused ceremony is a real
    // invocation with a real answer.
    //
    // The question is MUTATION, not approval. The write class (#266) is the set
    // of tools that need a human's consent — deletes, shares, sends. It is a
    // strict subset of the tools that change the world: deck_create_card mutates
    // and needs no consent. Keying the guard on the write class would append
    // "no action was executed" beneath a successfully created card, which is
    // #81's harm inverted. Each tool declares `mutates` or `readOnly` at its
    // registration site, and the write-class pin asserts write-class ⊆ mutates.
    const toolsInvokedThisTurn = new Set();
    const invokedMutatingTool = () => [...toolsInvokedThisTurn].some(name =>
      // A registry that cannot answer is treated as "it mutated", so the guard
      // stays silent rather than printing a false "nothing happened". Unknown
      // names (a fuzzy alias, a SkillForge tool) answer the same way inside
      // ToolRegistry.isMutating, for the same reason.
      typeof this.toolRegistry?.isMutating !== 'function' || this.toolRegistry.isMutating(name)
    );

    // Did the user ask for state to be CHANGED? `gate=action` does not answer
    // that: it answers "this message needs the tool pipeline", which a board
    // overview also needs (#134). Reading the two meanings out of one field
    // appended an apology beneath correct answers to read-only questions
    // (#272), so the classifier now states the mutation expectation directly.
    //
    // Only an explicit `false` disarms the guard. Absent, unparseable, or
    // unknown → armed: the guard is honesty enforcement, and the safe failure
    // is a possible false apology, never a missed fabrication.
    const expectsMutation = options.expectsMutation !== false;

    while (iteration < maxIter) {
      iteration++;

      this.logger.info(`[AgentLoop] Iteration ${iteration}/${maxIter}`);

      const job = options.job || this._classifyJob(messages, tools);
      let response;
      try {
        response = await this.llmProvider.chat({
          system: systemPrompt,
          messages,
          tools,
          job
        });
      } catch (llmErr) {
        // Salvage: if previous iterations completed tool calls successfully,
        // return confirmed results instead of discarding them.
        const salvaged = this._salvageToolResults(messages, failedCallIds);
        if (salvaged) {
          this.logger.info('[AgentLoop] Salvaged tool results after LLM failure');
          lastResponse = salvaged;
          break;
        }

        // No tool results to salvage — handle error normally
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

      this._recordToolsEnvelope(job, response);

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

        // Batch approval (Approval Custody Phase 2, §6 / #84): a turn that
        // resolves to N approval-required calls gets ONE ceremony over the
        // enumerated set, not N. Gather them and run the single ceremony before
        // executing anything; the per-call loop then reads this one decision.
        // Scope: ToolGuard APPROVAL_REQUIRED (the #265/#84 core). The Cockpit GATE
        // path (`check()`) stays per-call — a noted follow-up.
        let batchApproval = null;      // 'yes' | 'no' | 'timeout' | 'edit' | null
        let batchEditMessage = null;
        if (roomToken && this.guardrailEnforcer && this.toolGuard) {
          const approvalCalls = response.toolCalls.filter((tc) => {
            if ((toolFailureCounts[tc.name] || 0) >= MAX_CONSECUTIVE_TOOL_FAILURES) return false;
            const g = this.toolGuard.evaluate(tc.name);
            return !g.allowed && g.level === 'APPROVAL_REQUIRED';
          });
          if (approvalCalls.length > 0) {
            const decision = await this.guardrailEnforcer.checkApprovalBatch(
              approvalCalls.map(tc => ({ tool: tc.name, arguments: tc.arguments })),
              roomToken, { language: options.language, requestingUser: options.user }
            );
            batchApproval = decision.decision;
            batchEditMessage = decision.message || null;
            this.logger.info(`[AgentLoop] batch approval: targets=${approvalCalls.length} decision=${batchApproval}`);
          }
        }

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
            failedCallIds.add(callId);
            messages.push({
              role: 'tool',
              tool_call_id: callId,
              content: `Tool ${toolCall.name} is temporarily unavailable after repeated failures. Work with what you have.`
            });
            iterationToolsCalled.push(toolCall.name);
            continue;
          }

          // The turn invoked this tool. Recorded before the result is known:
          // a denial, a timeout, or a handler error are all outcomes of a real
          // invocation, and the guard asks whether the tool was called — not
          // whether it succeeded.
          toolsInvokedThisTurn.add(toolCall.name);

          // A call covered by the batch ceremony above uses that one decision
          // instead of raising its own. approved → execute (approval held as a
          // fact); anything else → blocked, per-target, without re-asking.
          const batchGuard = (roomToken && this.guardrailEnforcer && this.toolGuard)
            ? this.toolGuard.evaluate(toolCall.name) : { allowed: true };
          const inBatch = batchApproval !== null && !batchGuard.allowed && batchGuard.level === 'APPROVAL_REQUIRED';

          let toolResult;
          if (inBatch) {
            if (batchApproval === 'yes') {
              toolResult = await this._executeWithGuards(toolCall, roomToken, { language: options.language, user: options.user, approvalGranted: true });
            } else if (batchApproval === 'edit') {
              toolResult = {
                success: false, result: '', error:
                  `The user wants to revise this before it runs. Their message: "${batchEditMessage || 'edit'}". ` +
                  'Ask what they\'d like to change, then retry with the updated content.'
              };
            } else {
              toolResult = { success: false, result: '', error: `Action blocked: approval ${batchApproval === 'timeout' ? 'timed out' : 'denied'}.` };
            }
          } else {
            toolResult = await this._executeWithGuards(toolCall, roomToken, { language: options.language, user: options.user });
          }

          // Track tool failures (don't count errors toward maxIterations)
          if (!toolResult.success) {
            toolFailureCounts[toolCall.name] = (toolFailureCounts[toolCall.name] || 0) + 1;
            failedCallIds.add(callId);
            this.logger.warn(`[AgentLoop] Tool ${toolCall.name} failed (${toolFailureCounts[toolCall.name]}x): ${toolResult.error}`);
          } else {
            toolFailureCounts[toolCall.name] = 0; // Reset on success

            // Layer 1: Log successful tool execution to activity log
            if (this.activityLogger) {
              this.activityLogger.append({
                action: toolCall.name,
                summary: `[Cloud] ${toolCall.name}(${Object.keys(toolCall.arguments || {}).join(', ')})`,
                details: toolCall.arguments,
                user: options?.user,
                room: roomToken
              });
            }

            // Capture artifact focus from structured tool results
            if (options.onArtifact) {
              try {
                const artifact = extractArtifact(toolCall.name, toolResult);
                if (artifact) options.onArtifact(artifact);
              } catch (e) {
                this.logger.warn('[AgentLoop] Artifact focus capture failed:', e.message);
              }
            }
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

      // Action-hallucination guard: when the classifier said this turn is an
      // action but the LLM produced text without doing the work, re-prompt
      // once before letting the response reach the user. The check is
      // structural (gate + invoked tool names + HITL marker) — language-free.
      //
      // Two structural signals trigger the re-prompt:
      //   (a) No MUTATING tool call this turn. Zero-tool-calls was the
      //       original PR #68 proxy for this, and it was too weak: on
      //       2026-07-09 a gate=action turn called deck_list_cards, then ended
      //       by asking "Delete it?" in prose. A read had run, so the old
      //       condition was false, and no marker was emitted, so (b) was false
      //       too. The turn talked about a deletion it never invoked. Mutation
      //       is each tool's own declaration at its registration site, read via
      //       ToolRegistry.isMutating() — never the approval policy, which
      //       covers a strictly smaller set (see the note above the Set).
      //   (b) The response renders the HITL prompt marker (\u{1F510}) that
      //       the GuardrailEnforcer reserves for its Talk surface. If the
      //       agent emits that codepoint, it is staging a fake approval
      //       ceremony instead of calling the destructive tool (#81).
      //
      // A read-only tool call no longer satisfies "this turn did the work",
      // which means an honest not-found refusal ("I couldn't find that card")
      // trips (a) as well — it is structurally identical to the prose offer,
      // and telling them apart would mean reading prose. That is accepted: the
      // model restates the refusal on its second pass, the bound below stops
      // there, and the user's answer is unchanged.
      //
      // Bounded to one re-prompt per turn via actionGuardFired so legitimate
      // text-only refusals on the second pass ("I can't because…") are not
      // re-prompted again. maxIter is bumped to guarantee at least one more
      // iteration even when the caller passed a tight iteration budget.
      // Marker staging is illegitimate at ANY gate — the 🔐 codepoint belongs to
      // GuardrailEnforcer's Talk surface, never a model response. A confirmation
      // follow-up ("lösch den dritten") classifies as gate=confirmation, so gating
      // this on action would miss the #85 leak. The write-class signal stays
      // gate=action (a knowledge turn legitimately performs no write).
      const responseStagesApproval = stagesApprovalCeremony(response.content);
      const actionWithoutMutation = options.gate === 'action' && expectsMutation && !invokedMutatingTool();
      if (!actionGuardFired && (actionWithoutMutation || responseStagesApproval)) {
        actionGuardFired = true;
        maxIter = Math.max(maxIter, iteration + 1);

        messages.push({
          role: 'assistant',
          content: response.content || ''
        });
        messages.push({
          role: 'user',
          content: ACTION_REPROMPT_DIRECTIVE
        });

        const reason = responseStagesApproval
          ? 'response staged HITL marker without destructive tool call'
          : `no mutating tool call (gate=action expectsMutation=true, invoked=[${[...toolsInvokedThisTurn].join(', ')}])`;
        this.logger.warn(`[AgentLoop] Action-hallucination guard fired at iteration ${iteration} — re-prompting (${reason})`);
        // Maturation loop: the guard firing is a structural failure of the
        // (tools, model) pairing — an action turn that didn't act.
        if (this.modelScorecard && job === 'tools' && response._routing?.model) {
          this.modelScorecard.recordSample('tools', response._routing.model, null, false);
        }
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
        lastResponse = surfaceText('fallback_max_iterations', options.language);
        this.logger.warn(`[AgentLoop] Hit max iterations (${maxIter})`);
      }

      // Fire-and-forget: notify caller of exhaustion so it can create a recovery card
      if (options.onExhaustion) {
        try { options.onExhaustion({ message, iterations: maxIter }); } catch (_) { /* never block */ }
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

    // Terminal HITL-marker strip: the re-prompt guard is bounded to one pass, so
    // if a misbehaving model stages the 🔐 marker again afterward it would fall
    // through. Strip it here so the reserved codepoint never reaches the user —
    // the structural invariant the marker contract relies on (#85).
    if (stagesApprovalCeremony(lastResponse)) {
      this.logger.warn('[AgentLoop] HITL marker survived the re-prompt — stripping from final response (model staged ceremony twice)');
      lastResponse = stripApprovalMarker(lastResponse);
    }

    // 5. Honesty floor (#81 commit 2, Layer 2). The re-prompt above is bounded to
    // one attempt, and on 2026-07-09 a model spent that attempt producing a more
    // confident falsehood ("Ich habe die Karte gelöscht — die Tool-Bestätigung
    // liegt vor", zero tool calls). One re-prompt is a request, not a guarantee.
    //
    // So the turn's honesty is made structural rather than hoped for: a turn
    // that was asked to change something and invoked no mutating tool did not
    // act, and says so in a code-owned sentence beneath whatever the model
    // wrote. The trailer appends and never replaces — substituting it would
    // delete a legitimate specific refusal ("I couldn't find that card"), the
    // most useful sentence in such a turn, in favour of a generic one.
    //
    // The trigger reads the turn's invoked tool names, never its prose. The
    // ProvenanceAnnotator's groundedRatio was the tempting alternative and is not
    // consulted: it scores a fabricated claim as grounded whenever the claim
    // echoes the user's own nouns (#267).
    //
    // "Asked to change something" is the verdict's expectsMutation, not its
    // gate. Until #272 this read gate=action alone, and every read-only deck or
    // calendar question — which #134 correctly routes through the tool pipeline
    // — carried an apology beneath a correct answer. The fix belonged in the
    // classification, and that is where it went: the model states the
    // expectation, the guard consumes it.
    if (options.gate === 'action' && expectsMutation && !invokedMutatingTool() && lastResponse) {
      this.logger.warn(
        `[AgentLoop] Honesty trailer appended: gate=action expectsMutation=true mutatingCall=none ` +
        `invoked=[${[...toolsInvokedThisTurn].join(', ')}] guardFired=${actionGuardFired} language=${options.language || 'unset'}`
      );
      lastResponse = `${lastResponse}\n\n${surfaceText('no_action_trailer', options.language)}`;
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
   * @param {boolean} [params.allowCloud] - Per-call cloud override (overrides forceLocal)
   * @param {string} [params.cloudTier] - Cloud tier: 'fast' (Haiku/Sonnet only) or null (smart-mix)
   * @param {number} [params.maxIterations] - Override max iterations (default: this.maxIterations)
   * @returns {Promise<string>} The agent's final text response
   */
  async processWorkflowTask({ systemAddition, task, boardId, cardId, stackId, forceLocal, allowCloud, cloudTier, maxIterations, searchPolicy }) {
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
    if (forceLocal && !allowCloud) {
      tools = this.toolRegistry.getWorkflowToolDefinitions({ includeUpdateCard: cardId > 0 });
    } else {
      // Per-card processing (cardId > 0) gets update_card; schedules (cardId === 0) don't.
      // searchPolicy gates web_search/web_read: excluded only when 'sovereign'.
      tools = this.toolRegistry.getCloudWorkflowToolDefinitions(systemAddition, { includeUpdateCard: cardId > 0, searchPolicy });
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
    const failedCallIds = new Set();

    while (iteration < iterLimit) {
      iteration++;
      this.logger.info(`[AgentLoop] Workflow iteration ${iteration}/${iterLimit}`);

      // LLM: cloud         → writing job (Opus → Sonnet → Haiku)
      // LLM: cloud-writing → coding job  (Sonnet → Haiku, skips Opus)
      // LLM: cloud-fast    → tools job   (Haiku only)
      // LLM: local         → tools job   (local only)
      const job = !allowCloud ? 'tools'
        : cloudTier === 'fast' ? 'tools'
        : cloudTier === 'writing' ? 'coding'
        : 'writing';
      let response;
      try {
        response = await this.llmProvider.chat({
          system: systemPrompt,
          messages,
          tools,
          forceLocal: forceLocal && !allowCloud,
          allowCloud,
          cloudTier,
          job
        });
      } catch (llmErr) {
        // Salvage: if previous iterations completed tool calls successfully,
        // return confirmed results instead of discarding them.
        const salvaged = this._salvageToolResults(messages, failedCallIds);
        if (salvaged) {
          this.logger.info('[AgentLoop] Workflow salvaged tool results after LLM failure');
          lastResponse = salvaged;
          break;
        }

        // No tool results to salvage — handle error normally
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

      this._recordToolsEnvelope(job, response);

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
            failedCallIds.add(callId);
            messages.push({
              role: 'tool', tool_call_id: callId,
              content: `Tool ${toolCall.name} is temporarily unavailable after repeated failures.`
            });
            continue;
          }

          const toolResult = await this._executeWithGuards(toolCall, null);

          if (!toolResult.success) {
            toolFailureCounts[toolCall.name] = (toolFailureCounts[toolCall.name] || 0) + 1;
            failedCallIds.add(callId);
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
   * Execute a tool the user already approved. The approval ceremony ran when the
   * offer was made; its answer arrived after the poll had timed out, so it is
   * resolved from the PendingAction record instead (#104). Every other guard —
   * ToolGuard's non-approval levels, the Cockpit GATE guardrails — still runs:
   * only the approval the record already carries is skipped.
   *
   * @param {Object} toolCall - { name, arguments }
   * @param {string|null} roomToken
   * @returns {Promise<{success: boolean, result: string, error?: string}>}
   */
  executeApprovedTool(toolCall, roomToken) {
    return this._executeWithGuards(toolCall, roomToken, { approvalGranted: true });
  }

  /**
   * Re-read a held invocation's target to detect drift before a late "yes"
   * releases (Approval Custody Phase 2, §5, void-on-drift). A release must never
   * fire into a world that no longer matches the approval — if the card was
   * deleted by other means while the question sat, the record voids instead.
   *
   * Deck cards are read precisely (the gate's drift case). For tools without a
   * cheap presence read here, `known:false` returns present:true — the safe
   * direction is to re-present with the stored state, never to falsely void.
   *
   * @param {{tool: string, args: Object}} held
   * @returns {Promise<{known: boolean, present: boolean}>}
   */
  async readTargetPresence(held) {
    try {
      const deck = this.toolRegistry?.clients?.deckClient;
      if (held.tool === 'deck_delete_card' && deck && typeof this.toolRegistry._resolveCardOnBoard === 'function') {
        const res = await this.toolRegistry._resolveCardOnBoard(deck, held.args.card, held.args.board);
        return { known: true, present: !!res.found };
      }
    } catch (err) {
      this.logger.warn(`[AgentLoop] target presence read failed for ${held.tool}: ${err.message}`);
    }
    return { known: false, present: true };
  }

  /**
   * Narrate an outcome the code already decided. The model is not re-involved in
   * deciding what to execute — it receives the result and tells the user about
   * it, in whatever language they were speaking.
   *
   * @param {Object} params
   * @param {string} params.userMessage - The user's reply that resolved the offer
   * @param {string} params.label - Human-readable action label, already in the user's language
   * @param {string} params.outcome - What actually happened (tool result or cancellation)
   * @param {string|null} [params.language] - The offer's birth language (#273/#276)
   * @returns {Promise<string>} A sentence for the user
   */
  async narrateOutcome({ userMessage, label, outcome, language = null }) {
    // "Reply in the person's language" is unusable here: the person said "ja".
    // A one-word reply carries no language worth reading, which is why the
    // offer's language was stored on the record at birth (#273). Name it.
    const replyLanguage = normalizeLanguage(language);

    try {
      const response = await this.llmProvider.chat({
        job: 'synthesis',
        system: [
          'You report an outcome to the person you assist. The action is already finished.',
          '',
          'Rules:',
          `  - Reply in this language: ${replyLanguage}. The person's own words may be too short to tell.`,
          '  - One or two sentences. State what happened.',
          '  - Never ask for confirmation. Never offer to do it again. It is done.',
        ].join('\n'),
        messages: [{
          role: 'user',
          content: `I said: "${userMessage}"\n\nAction: ${label}\nOutcome: ${outcome}\n\nTell me what happened.`
        }],
        tools: []
      });
      const content = (response?.content || '').trim();
      if (content) return content;
    } catch (err) {
      this.logger.warn(`[AgentLoop] Outcome narration failed: ${err.message}`);
    }
    return `${label}: ${outcome}`;
  }

  /**
   * Execute a tool call with ToolGuard (hardcoded security) and GuardrailEnforcer
   * (dynamic Cockpit guardrails with HITL confirmation) checks.
   *
   * @param {Object} toolCall - { name, arguments }
   * @param {string|null} roomToken - Talk room token (null for workflow)
   * @param {Object} [options]
   * @param {boolean} [options.approvalGranted=false] - Approval already held as a fact
   * @returns {Promise<{success: boolean, result: string, error?: string}>}
   * @private
   */
  async _executeWithGuards(toolCall, roomToken, { approvalGranted = false, language = null, user = null } = {}) {
    // ToolGuard: hardcoded security policy
    if (this.toolGuard) {
      const guardResult = this.toolGuard.evaluate(toolCall.name);
      if (!guardResult.allowed) {
        if (guardResult.level === 'APPROVAL_REQUIRED' && this.guardrailEnforcer) {
          if (approvalGranted) {
            this.logger.info(`[AgentLoop] ToolGuard approval pre-granted by PendingAction record: ${toolCall.name}`);
            // Fall through to GuardrailEnforcer.check() and then execute
          } else {
            // Route through HITL approval instead of hard-blocking
            const history = (roomToken && this.conversationContext)
              ? await this.conversationContext.getHistory(roomToken, { limit: 10 })
              : [];
            // The resolved language rides along so a timed-out offer is born
            // speaking the user's language, not the persona's (#273).
            const approvalResult = await this.guardrailEnforcer.checkApproval(
              toolCall.name, toolCall.arguments, roomToken, history, { language, requestingUser: user }
            );
            if (!approvalResult.allowed) {
              if (approvalResult.editRequest) {
                this.logger.info(`[AgentLoop] ToolGuard approval edit: ${toolCall.name}`);
                return {
                  success: false, result: '', error:
                    `The user wants to revise this before it's sent. Their message: "${approvalResult.editMessage || 'edit'}". ` +
                    'Ask the user what they\'d like to change, then retry with the updated content.'
                };
              }
              this.logger.info(`[AgentLoop] ToolGuard approval denied: ${toolCall.name} — ${approvalResult.reason}`);
              return { success: false, result: '', error: `Action blocked: ${approvalResult.reason}` };
            }
            // Approved — fall through to GuardrailEnforcer.check() and then execute
          }
        } else {
          this.logger.warn(`[AgentLoop] ToolGuard blocked: ${toolCall.name} — ${guardResult.reason}`);
          return { success: false, result: '', error: `Tool call blocked by security policy: ${guardResult.reason}` };
        }
      }
    }

    // GuardrailEnforcer: dynamic Cockpit guardrails with HITL confirmation
    if (this.guardrailEnforcer) {
      const result = await this.guardrailEnforcer.check(toolCall.name, toolCall.arguments, roomToken, { language });
      if (!result.allowed) {
        if (result.editRequest) {
          this.logger.info(`[AgentLoop] GuardrailEnforcer edit requested: ${toolCall.name}`);
          return {
            success: false, result: '', error:
              `The user wants to revise this before it's sent. Their message: "${result.editMessage || 'edit'}". ` +
              'Ask the user what they\'d like to change, then retry with the updated content.'
          };
        }
        this.logger.info(`[AgentLoop] GuardrailEnforcer blocked: ${toolCall.name} — ${result.reason}`);
        return { success: false, result: '', error: `Action blocked: ${result.reason}` };
      }
    }

    // Authority ledger (Approval Custody Phase 2, §2). Every write-class
    // execution that passes this chokepoint carries exactly one nameable
    // authority — `release` (a held PendingAction was released for it) or
    // `standing-policy` (an operator-governed context authorized it: a workflow
    // card under a null room, or a conversational SENSITIVE write no active GATE
    // guardrail gates). Reads are `not-write-class` and need no line. This makes
    // the implicit authorities explicit and loggable (§7 task 3); it does not
    // change which paths execute.
    if (isWriteClass(toolCall.name)) {
      const authority = approvalGranted ? 'release' : 'standing-policy';
      const authorityRef = approvalGranted
        ? 'pending-action'
        : (roomToken ? 'conversational:no-active-gate' : 'workflow:null-room');
      this.logger.info(
        `[AgentLoop] write-class authority: tool=${toolCall.name} authority=${authority} ` +
        `authorityRef=${authorityRef} room=${roomToken || 'none'} user=${user || 'none'}`
      );
    }

    return this.toolRegistry.execute(toolCall.name, toolCall.arguments);
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

  /**
   * Infer conversational mode from recent message patterns.
   * Short rapid exchanges → focused. Long exploratory questions → exploratory.
   * Returns 'focused', 'exploratory', or 'balanced'.
   *
   * @param {Array} history - Recent conversation messages [{role, content}]
   * @returns {string} 'focused' | 'exploratory' | 'balanced'
   * @private
   */
  _inferConversationalMode(history) {
    if (!history || history.length === 0) return 'balanced';

    const recentMessages = history.slice(-6);
    const userMessages = recentMessages.filter(m => m.role === 'user');
    if (userMessages.length === 0) return 'balanced';

    const avgLength = userMessages.reduce((sum, m) =>
      sum + (m.content || '').length, 0) / userMessages.length;

    const hasQuestionMarks = userMessages.some(m => (m.content || '').includes('?'));
    const hasExploratoryWords = userMessages.some(m =>
      /\b(what if|could we|brainstorm|ideas|explore|think about|imagine)\b/i.test(m.content || '')
    );

    if (avgLength < 50 && !hasExploratoryWords) {
      return 'focused';
    } else if (hasExploratoryWords || (avgLength > 200 && hasQuestionMarks)) {
      return 'exploratory';
    }
    return 'balanced';
  }

  /** @private */
  _buildSystemPrompt(memoryContext, briefingContext, options = {}, warmMemoryContext = '', history = []) {
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

    // Cockpit overlay: inject active configuration EARLY for positional authority.
    // Mode and guardrails are operational state — the model needs them front-of-mind.
    let cockpitBlock = '';
    if (this.cockpitManager) {
      try {
        const cockpitOverlay = this.cockpitManager.buildSystemPromptOverlay();
        if (cockpitOverlay) {
          cockpitBlock = cockpitOverlay + '\n\n';
        }
      } catch (err) {
        this.logger.warn('[AgentLoop] Cockpit overlay failed:', err.message);
      }
    }

    let prompt = stylePrefix + personaPrefix + cockpitBlock + dateHeader + (this.soul || '');

    if (memoryContext) {
      prompt += `\n\n${memoryContext}`;
    }

    if (warmMemoryContext) {
      prompt += `\n\n${warmMemoryContext}`;
    }

    if (briefingContext) {
      prompt += `\n\n${briefingContext}`;
    }

    // Turn verdict (declarative register — name the subject, never forbid tools).
    // The domain comes from the classification verdict carried in options (#133);
    // scoping the advertised tools is handled at the tools-build site, this only
    // tells the model what the turn is about. No domain → no line.
    if (options.domain && this.toolRegistry.hasDomainTools(options.domain)) {
      prompt += `\n\n## This Turn\n\nThe user's request is about ${options.domain}. `
        + 'The tools you need for it are available; reach for them first.';
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

    // Conversational mode inference — adjust response style based on message patterns.
    // Cockpit mode (if active) overrides inference.
    const cockpitMode = this.cockpitManager?.getActiveMode?.();
    if (!cockpitMode) {
      const mode = this._inferConversationalMode(history);
      if (mode === 'focused') {
        prompt += '\n\nCONVERSATIONAL MODE: Focused\nThe user is working fast. Keep responses concise and action-oriented. Surface only the most directly relevant knowledge. Suppress tangential connections.';
      } else if (mode === 'exploratory') {
        prompt += '\n\nCONVERSATIONAL MODE: Exploratory\nThe user is thinking broadly. Make connections across domains. Surface related knowledge even if the link is loose. Suggest angles they might not have considered.';
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
   * Record the envelope-level tools outcome with the maturation loop: one
   * sample per LLM call on the `tools` job. A turn that emits tool calls
   * whose names all exist is a success; a hallucinated tool name is a
   * failure. A tool-less turn is NEUTRAL here (a knowledge answer over
   * advertised tools is legitimate) — the tool-less ACTION turn is recorded
   * by the action-hallucination guard, and timeouts by RouterChatBridge, so
   * every call yields at most one sample. Checks are structural (registry
   * membership), never content reads.
   * @param {string} job
   * @param {Object} response
   * @private
   */
  _recordToolsEnvelope(job, response) {
    if (!this.modelScorecard || job !== 'tools') return;
    const model = response?._routing?.model;
    if (!model) return;
    const calls = response.toolCalls;
    if (!Array.isArray(calls) || calls.length === 0) return;
    const registry = this.toolRegistry;
    if (!registry || typeof registry.has !== 'function') return;
    const hallucinated = calls.some(tc => !tc || !registry.has(tc.name));
    this.modelScorecard.recordSample('tools', model, null, !hallucinated);
  }

  /**
   * Parse a tool call from LLM text output (resilience for smaller models).
   * Detects two formats:
   *   JSON: {"name": "tool_name", "arguments": {...}} (also accepts "parameters")
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

    // Pattern 1: JSON object with name + an args key.
    // Accept BOTH "arguments" (the canonical OpenAI/Ollama shape qwen3:8b emits,
    // optionally wrapped in <tool_call> tags — matched here via search) and the
    // older "parameters" shape. Without "arguments", a text-form call sailed past
    // the parser and the loop shipped the raw envelope to Talk as the reply (#164).
    // e.g. {"name": "deck_move_card", "arguments": {"card": "#44", "target_stack": "Done"}}
    const jsonMatch = text.match(/\{\s*"name"\s*:\s*"([^"]+)"\s*,\s*"(?:arguments|parameters)"\s*:\s*(\{[^}]*\})\s*\}/);
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
   * Salvage successful tool results from the messages array when an LLM call fails.
   * Tool results are already human-readable strings (e.g., 'Created "Test 9" on ...').
   * Uses failedCallIds set for robust error detection — avoids fragile string matching
   * that can be fooled by content provenance wrapping on external tool results.
   *
   * @param {Array<Object>} messages - The conversation messages array
   * @param {Set<string>} failedCallIds - tool_call_ids that returned errors
   * @returns {string|null} Salvaged response or null
   * @private
   */
  _salvageToolResults(messages, failedCallIds) {
    const successResults = [];
    for (const msg of messages) {
      if (msg.role === 'tool' && msg.content &&
          !failedCallIds.has(msg.tool_call_id)) {
        successResults.push(msg.content);
      }
    }
    if (successResults.length === 0) return null;

    // Tool results are already human-readable — trim each to avoid giant outputs
    const summary = successResults
      .map(r => r.substring(0, 500))
      .join('\n\n');

    return summary +
      '\n\n_(Note: I had trouble generating a full response, but the action above completed successfully.)_';
  }

  /**
   * Classify the current agent loop iteration into a job type for LLM routing.
   * Routes to the cheapest appropriate model: Sonnet for tool-calling and simple
   * queries, Opus for complex reasoning and code generation.
   *
   * @param {Array<Object>} messages - Current conversation messages
   * @param {Array<Object>} tools - Available tool definitions
   * @returns {string} Job type: 'quick' | 'tools' | 'thinking' | 'writing' | 'coding' | 'research'
   * Note: The thinking *intent* (four-gate classifier) bypasses AgentLoop entirely via
   *   message-processor._handleThinkingQuery(). The 'thinking' return here is AgentLoop's
   *   internal default for long, unclassified messages — routes to Opus for complex reasoning.
   * @private
   */
  _classifyJob(messages, tools) {
    // If tools are available, this is likely a tool-calling turn
    if (tools && tools.length > 0) {
      // Check if recent messages contain tool results we need to synthesize
      const recentToolResults = this._recentToolResultCount(messages);
      if (recentToolResults >= 2) {
        // Multiple tool results gathered — now synthesizing into a response
        return 'writing';
      }
      return 'tools';
    }

    // No tools — final response turn. Classify based on the user's original message.
    const userContent = this._lastUserContent(messages);
    if (!userContent) return 'quick';

    // Check for coding signals (before length check — "debug this" is short but coding)
    const codingPattern = /\b(code|debug|function|script|implement|refactor|sql|regex|bug|stack\s?trace|syntax)\b/i;
    if (codingPattern.test(userContent)) return 'coding';

    // Check for writing signals
    const writingPattern = /\b(write|draft|compose|summarize|summary|email|report|document|letter|blog|template)\b/i;
    if (writingPattern.test(userContent)) return 'writing';

    // Check for research signals
    const researchPattern = /\b(search|find out|look\s?up|research|compare|what\s+is|who\s+is|latest|news)\b/i;
    if (researchPattern.test(userContent)) return 'research';

    // Short messages without keyword signals are quick
    if (userContent.length < 100) return 'quick';

    // Default: thinking (complex reasoning)
    return 'thinking';
  }

  /**
   * Count tool results in the last N messages.
   * @param {Array<Object>} messages
   * @returns {number}
   * @private
   */
  _recentToolResultCount(messages) {
    let count = 0;
    for (let i = messages.length - 1; i >= Math.max(0, messages.length - 6); i--) {
      if (messages[i]?.role === 'tool') count++;
    }
    return count;
  }

  /**
   * Extract the content of the last user message.
   * @param {Array<Object>} messages
   * @returns {string}
   * @private
   */
  _lastUserContent(messages) {
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i]?.role === 'user') {
        return typeof messages[i].content === 'string' ? messages[i].content : '';
      }
    }
    return '';
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
