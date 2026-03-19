/*
 * Moltagent - Sovereign AI Security Layer
 * Copyright (C) 2026 Moltagent Contributors
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU Affero General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 */

'use strict';

/**
 * IntentDecomposer — Breaks compound user requests into structured execution plans.
 *
 * Architecture Brief:
 * - Problem: Users say "Check X and create Y if Z" — one sentence, multiple operations.
 *   The single-domain classifier picks one domain and drops the rest.
 * - Pattern: One lightweight LLM call (qwen2.5:3b) decomposes the compound message into
 *   a plan of steps: parallel probes → conditional logic → actions → synthesis.
 *   The plan executor runs probes in parallel, evaluates conditions, executes actions,
 *   and synthesizes a coherent response.
 * - Key Dependencies: LLM router (job: 'decomposition'), knowledge probes (from message-processor),
 *   domain executors (deck, calendar, email via MicroPipeline)
 * - Data Flow: compound message → decompose() → plan JSON → executePlan() → synthesis
 *
 * @module agent/intent-decomposer
 * @version 1.0.0
 */

const DECOMPOSE_PROMPT = `Decompose this user request into a plan of sub-tasks.

Return ONLY a JSON object with a "steps" array. Each step has:
- id: step number (integer)
- type: "probe" (search/lookup) or "action" (create/update/delete/send) or "synthesis" (final summary)
- source: which system to query (wiki, deck, calendar, email, files, graph, sessions)
- query: what to search for OR what action to perform
- condition: (optional) "if_empty:N" — only execute if step N returned no results. "if_found:N" — only if step N found results.
- depends_on: (optional) array of step id numbers — wait for these before executing

Example for "Check Carlos's email and if we have no meeting, create a reminder":
{"steps":[
  {"id":1,"type":"probe","source":"wiki","query":"Carlos email contact"},
  {"id":2,"type":"probe","source":"calendar","query":"Carlos next 14 days"},
  {"id":3,"type":"action","source":"deck","query":"Create reminder: Call Carlos","condition":"if_empty:2","depends_on":[2]},
  {"id":4,"type":"synthesis","query":"Summarize findings","depends_on":[1,2,3]}
]}

Rules:
- Probes are read-only lookups. Actions modify state (create, update, delete, send).
- Probes with no dependencies can run in parallel.
- Actions that depend on probe results run after those probes complete.
- Always end with a synthesis step that reports everything.
- Keep it minimal. 2-5 steps. Don't over-decompose simple queries.
- Action step queries must be self-contained. NEVER reference other steps by number ("from steps 1-2", "using step 1 results"). Write the action as if it were a standalone instruction: "Create card: Eelco Dykstra research", not "Create card with info from steps 1-2". The system injects probe results automatically.`;

class IntentDecomposer {
  /**
   * @param {Object} opts
   * @param {Object} opts.llmRouter - LLM router with .route() method
   * @param {Object} [opts.logger] - Logger instance
   */
  constructor({ llmRouter, logger } = {}) {
    this.llmRouter = llmRouter;
    this.logger = logger || console;
  }

  /**
   * Decompose a compound user message into a structured plan.
   *
   * @param {string} message - User message
   * @returns {Promise<{steps: Array}|null>} Plan with steps, or null on failure
   */
  async decompose(message) {
    if (!this.llmRouter) return null;

    try {
      const result = await this.llmRouter.route({
        job: 'decomposition',
        task: 'intent_decompose',
        system: DECOMPOSE_PROMPT,
        content: message.substring(0, 500),
        requirements: { maxTokens: 400, temperature: 0.1 }
      });

      const raw = result?.result || result?.content || '';
      this.logger.log(`[IntentDecomposer] Raw LLM response: ${raw.substring(0, 300)}`);
      const cleaned = this._cleanJson(raw);
      let plan;
      try {
        plan = JSON.parse(cleaned);
      } catch (parseErr) {
        this.logger.warn(`[IntentDecomposer] JSON parse failed: ${parseErr.message} — cleaned: ${cleaned.substring(0, 200)}`);
        return null;
      }

      if (!plan || !Array.isArray(plan.steps) || plan.steps.length === 0) {
        this.logger.warn(`[IntentDecomposer] Invalid plan structure: ${JSON.stringify(plan).substring(0, 200)}`);
        return null;
      }

      // Validate and normalize steps
      plan.steps = plan.steps.filter(s => s && s.id && s.type);
      plan.originalMessage = message;
      return plan;
    } catch (err) {
      this.logger.warn(`[IntentDecomposer] Decomposition failed: ${err.message}`);
      return null;
    }
  }

  /**
   * Execute a decomposed plan: parallel probes → conditional actions → synthesis.
   *
   * @param {Object} plan - Plan from decompose()
   * @param {Object} opts
   * @param {Object} opts.probeExecutor - Object with probe methods (_probeWiki, _probeDeck, etc.)
   * @param {Object} [opts.actionExecutor] - MicroPipeline for action execution
   * @param {Object} [opts.session] - SessionManager session
   * @param {Function} [opts.replyFn] - Feedback message sender
   * @returns {Promise<string>} Synthesized response
   */
  async executePlan(plan, { probeExecutor, actionExecutor, session, replyFn, userContext } = {}) {
    const results = new Map();

    // Phase 1: Execute all independent probes in parallel
    const independentProbes = plan.steps.filter(s =>
      s.type === 'probe' && (!s.depends_on || s.depends_on.length === 0)
    );

    if (independentProbes.length > 0) {
      if (replyFn) replyFn('\u{1F50D} Gathering information...').catch(() => {});

      const probePromises = independentProbes.map(async step => {
        try {
          const result = await this._executeProbe(step, probeExecutor);
          results.set(step.id, result);
        } catch (err) {
          results.set(step.id, { source: step.source, results: [], error: err.message });
        }
      });
      await Promise.allSettled(probePromises);
    }

    // Phase 1b: Web fallback — fire if probes returned thin content and policy allows.
    // Measure total content volume, not result count. After deep reads, if the wiki
    // has pointers but not substance (< 500 chars total ≈ one decent paragraph),
    // the web fallback fires to enrich.
    const searchPolicy = userContext?.searchPolicy || 'research';
    if (searchPolicy !== 'sovereign' && probeExecutor?.probeWeb) {
      let totalContentLength = 0;
      for (const [, r] of results) {
        if (r.error || r.skipped || !r.results) continue;
        for (const item of r.results) {
          totalContentLength += (item.snippet || item.content || '').trim().length;
        }
      }

      if (totalContentLength < 500) {
        try {
          const webQuery = plan.originalMessage || '';
          const webResults = await probeExecutor.probeWeb(webQuery);
          if (webResults.length > 0) {
            // Assign a synthetic step id that won't collide with plan step ids
            const webStepId = 'web_fallback';
            results.set(webStepId, {
              source: 'web',
              results: webResults,
              provenance: 'web_search'
            });
            console.log(`[IntentDecomposer] Thin probe content (${totalContentLength} chars) — web fallback added ${webResults.length} result(s)`);
          }
        } catch (err) {
          console.log(`[IntentDecomposer] Web fallback error: ${err.message}`);
        }
      }
    }

    // TRACE-1: What did probes return?
    console.log(`[TRACE-1] Probe results: ${results.size} entries, keys: ${[...results.keys()].join(', ')}`);
    for (const [key, val] of results) {
      const items = val.results || [];
      console.log(`[TRACE-1]   ${key}: ${items.length} items, first title: "${(items[0]?.title || 'none').substring(0, 50)}", first content length: ${(items[0]?.fullContent || items[0]?.snippet || items[0]?.content || '').length}`);
    }

    // Phase 2: Execute dependent steps sequentially
    const dependentSteps = plan.steps.filter(s =>
      !independentProbes.includes(s) && s.type !== 'synthesis'
    );

    let hasActions = false;
    for (const step of dependentSteps) {
      // Check condition
      if (step.condition) {
        const shouldExecute = this._evaluateCondition(step.condition, results);
        if (!shouldExecute) {
          results.set(step.id, { skipped: true, reason: `Condition not met: ${step.condition}` });
          continue;
        }
      }

      // Verify dependencies are resolved
      if (step.depends_on) {
        const allDone = step.depends_on.every(id => results.has(id));
        if (!allDone) {
          results.set(step.id, { error: 'Dependencies not met' });
          continue;
        }
      }

      if (step.type === 'probe') {
        try {
          results.set(step.id, await this._executeProbe(step, probeExecutor));
        } catch (err) {
          results.set(step.id, { source: step.source, results: [], error: err.message });
        }
      } else if (step.type === 'action') {
        if (!hasActions && replyFn) {
          replyFn('\u{26A1} Taking action...').catch(() => {});
          hasActions = true;
        }
        try {
          results.set(step.id, await this._executeAction(step, results, actionExecutor, userContext));
        } catch (err) {
          results.set(step.id, { source: step.source, error: err.message });
        }
      }
    }

    // Phase 3: Synthesis
    if (replyFn) replyFn('\u{1F4DD} Putting it all together...').catch(() => {});

    return this._synthesize(plan, results, session);
  }

  /**
   * Evaluate a step condition against previous results.
   * @param {string} condition - "if_empty:N" or "if_found:N" or "always"
   * @param {Map} results - Step results map
   * @returns {boolean}
   */
  _evaluateCondition(condition, results) {
    if (condition === 'always') return true;

    if (condition.startsWith('if_empty:')) {
      const stepId = parseInt(condition.split(':')[1], 10);
      const stepResult = results.get(stepId);
      return !stepResult || !stepResult.results || stepResult.results.length === 0;
    }

    if (condition.startsWith('if_found:')) {
      const stepId = parseInt(condition.split(':')[1], 10);
      const stepResult = results.get(stepId);
      return stepResult?.results?.length > 0;
    }

    // Unknown condition — execute by default (safer than skipping)
    return true;
  }

  /**
   * Execute a probe step using the probe executor.
   * @private
   */
  async _executeProbe(step, probeExecutor) {
    if (!probeExecutor) {
      return { source: step.source, results: [], provenance: 'unavailable' };
    }

    const terms = (step.query || '').split(/\s+/).filter(w => w.length >= 2);

    switch (step.source) {
      case 'wiki':
        return {
          source: 'wiki',
          results: await (probeExecutor.probeWiki || probeExecutor._probeWiki || (() => []))(terms),
          provenance: 'stored_knowledge'
        };

      case 'deck':
        return {
          source: 'deck',
          results: await (probeExecutor.probeDeck || probeExecutor._probeDeck || (() => []))(terms),
          provenance: 'task_state'
        };

      case 'calendar':
        return {
          source: 'calendar',
          results: await (probeExecutor.probeCalendar || probeExecutor._probeCalendar || (() => []))(step.query),
          provenance: 'scheduled_events'
        };

      case 'graph':
        return {
          source: 'graph',
          results: await (probeExecutor.probeGraph || probeExecutor._probeGraph || (() => []))(terms),
          provenance: 'entity_relationship'
        };

      case 'sessions':
        return {
          source: 'sessions',
          results: await (probeExecutor.probeSessions || probeExecutor._probeSessions || (() => []))(terms),
          provenance: 'conversation_history'
        };

      case 'web':
        return {
          source: 'web',
          results: await (probeExecutor.probeWeb || (() => []))(step.query || terms.join(' ')),
          provenance: 'web_search'
        };

      default:
        return { source: step.source, results: [], provenance: 'unknown' };
    }
  }

  /**
   * Execute an action step using the MicroPipeline's domain executors.
   * @private
   */
  async _executeAction(step, previousResults, actionExecutor, userContext = {}) {
    if (!actionExecutor) {
      return { source: step.source, error: 'No action executor available' };
    }

    // Build the action message with probe findings inlined.
    // The decomposer's action query is generic ("create a card with findings").
    // The executor's LLM needs to see the actual content to extract a meaningful
    // title and description. Inline the findings so the message is self-contained.
    const probeFindings = this._aggregateProbeFindings(previousResults);
    // TRACE-2: What did aggregation produce?
    console.log(`[TRACE-2] Aggregated findings: ${probeFindings ? probeFindings.length + ' chars' : 'NULL'}`);
    if (probeFindings) console.log(`[TRACE-2] First 200 chars: ${probeFindings.substring(0, 200)}`);

    let actionMessage = step.query || '';
    if (probeFindings) {
      actionMessage += `\n\nResearch findings (use only the actual content — ignore any technical tags like [Semantic match...], [Graph:...], score values, or collection paths):\n${probeFindings.substring(0, 3000)}`;
    }
    // TRACE-3: What goes to the tool-calling LLM?
    console.log(`[TRACE-3] Action message length: ${actionMessage.length}, starts with: "${actionMessage.substring(0, 100)}"`);

    try {
      const response = await actionExecutor.process(actionMessage, {
        intent: step.source,
        userName: userContext.userName || 'system',
        roomToken: userContext.roomToken || '',
        warmMemory: userContext.warmMemory || '',
        compoundAction: true, // signals executors that titles/boards are agent-decided
        probeFindings, // also available directly for card description
        ...(userContext.getRecentContext ? { getRecentContext: userContext.getRecentContext } : {})
      });

      const responseText = typeof response === 'object' ? (response.response || JSON.stringify(response)) : String(response);

      // Mark the card as done if findings were provided — the content is complete.
      const cardIdMatch = responseText.match(/card\/(\d+)/) || responseText.match(/#(\d+)/);
      console.log(`[TRACE-6] Card ID from response: ${cardIdMatch?.[1] || 'NOT FOUND'}, probeFindings: ${!!probeFindings}, markCardDone: ${!!userContext.markCardDone}, responseText starts: "${responseText.substring(0, 80)}"`);
      if (probeFindings && userContext.markCardDone && cardIdMatch) {
        userContext.markCardDone(cardIdMatch[1]).catch(err =>
          this.logger.warn(`[IntentDecomposer] markCardDone failed: ${err.message}`)
        );
      }

      return {
        source: step.source,
        results: [{ title: step.query, snippet: responseText }],
        provenance: 'action_result',
        actionTaken: true
      };
    } catch (err) {
      return { source: step.source, error: err.message };
    }
  }

  /**
   * Aggregate findings from completed probe steps into a single text block.
   * Used to populate card descriptions in compound action steps.
   * @param {Map} results - Step results map
   * @returns {string|null} Aggregated findings or null if no probe results
   * @private
   */
  _aggregateProbeFindings(results) {
    if (!results || results.size === 0) return null;

    // Pass raw probe content to the action message. The extraction LLM (Haiku)
    // naturally ignores search metadata tags — no code-level stripping needed.
    const lines = [];
    for (const [, result] of results) {
      if (result.error || result.skipped || !result.results) continue;
      for (const r of result.results) {
        const title = (r.title || '').trim();
        const content = (r.snippet || r.content || '').trim();
        if (!content && !title) continue;
        lines.push(title ? `**${title}**\n${content}` : content);
      }
    }

    return lines.length > 0 ? lines.join('\n\n---\n\n') : null;
  }

  /**
   * Synthesize a coherent response from all step results.
   * @private
   */
  async _synthesize(plan, results, session) {
    let context = '';
    for (const step of plan.steps) {
      if (step.type === 'synthesis') continue;
      const result = results.get(step.id);
      if (!result) continue;

      context += `\n--- Step ${step.id}: ${step.type} ${step.source} ---\n`;
      if (result.skipped) {
        context += `Skipped: ${result.reason}\n`;
      } else if (result.error) {
        context += `Error: ${result.error}\n`;
      } else if (result.results && result.results.length > 0) {
        for (const r of result.results) {
          if (r.url) {
            context += `[${result.provenance}] Title: ${r.title || ''} | Link: ${r.url}\n${r.snippet || r.content || ''}\n`;
          } else {
            context += `[${result.provenance}] Title: ${r.title || ''}\n${r.snippet || r.content || ''}\n`;
          }
        }
      } else {
        context += `No results found.\n`;
      }
    }

    if (!this.llmRouter) {
      return this._formatResultsPlain(plan, results);
    }

    const prompt = `You completed a multi-step task the user asked for. Here are the results:

${context}

Compose a clear, concise response that:
1. Reports what was found and what actions were taken
2. Uses natural language, not step numbers
3. States facts. Names gaps. No fabrication.
4. When a result includes a Link field, format as a markdown link: [Title](Link).
5. NEVER ask the user for permission to do something they already requested. The user's original message IS the instruction — you already executed it. Report results, don't ask "Want me to...?" or "Should I...?". If something is incomplete, say what's missing and that you'll follow up — don't ask.`;

    try {
      const result = await this.llmRouter.route({
        job: 'synthesis',
        task: 'compound_synthesis',
        system: prompt,
        content: plan.originalMessage || 'Summarize the results.',
        requirements: { maxTokens: 1000, temperature: 0.3 }
      });

      return result?.result || result?.content || this._formatResultsPlain(plan, results);
    } catch (err) {
      this.logger.warn(`[IntentDecomposer] Synthesis failed: ${err.message}`);
      return this._formatResultsPlain(plan, results);
    }
  }

  /**
   * Plain-text fallback when LLM synthesis is unavailable.
   * @private
   */
  _formatResultsPlain(plan, results) {
    const lines = [];
    for (const step of plan.steps) {
      if (step.type === 'synthesis') continue;
      const result = results.get(step.id);
      if (!result) continue;

      if (result.skipped) {
        lines.push(`- ${step.query}: Skipped (${result.reason})`);
      } else if (result.error) {
        lines.push(`- ${step.query}: Error (${result.error})`);
      } else if (result.results && result.results.length > 0) {
        for (const r of result.results) {
          lines.push(`- ${r.title || step.query}: ${r.snippet || ''}`);
        }
      } else {
        lines.push(`- ${step.query}: No results found`);
      }
    }
    return lines.join('\n') || 'Plan completed but no results to report.';
  }

  /**
   * Strip markdown fences, think tags, and extract JSON from LLM output.
   * @private
   */
  _cleanJson(raw) {
    let cleaned = raw
      .replace(/<think>[\s\S]*?<\/think>/g, '')
      .replace(/```(?:json)?\s*/g, '')
      .replace(/```/g, '')
      .trim();

    // Find JSON object
    const match = cleaned.match(/\{[\s\S]*\}/);
    return match ? match[0] : '{}';
  }
}

module.exports = IntentDecomposer;
