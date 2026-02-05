# Moltagent Session 14: AgentLoop — The Nervous System

**Date:** 2026-02-08
**Author:** Fu + Claude Opus (architecture)
**Executor:** Claude Code
**Estimated CCode time:** 3-4 hours
**Dependencies:** Sessions 1-13 complete. DeckClient, CalDAVClient, SystemTagsClient, ConversationContext, ContextLoader, LLMRouter, ToolGuard, SecretsGuard all exist.
**Priority:** TRANSFORMATIVE — This session turns Moltagent from a regex chatbot into an actual AI agent.

---

## Development Pipeline

Execute this session using the 4-agent pipeline:

1. **Architect** — Read this entire brief. Plan the file structure, identify which existing files need modification, map the integration points. Confirm the plan before writing code.
2. **Implementer** — Build each module in order: ToolRegistry → AgentLoop → OllamaToolsProvider → ClaudeToolsProvider → SOUL.md → Wiring → Tests. Follow the specs below precisely.
3. **Debugger** — Run all tests (`npm test`). Run ESLint (`npm run lint`). Fix any failures. Check for null-safety, error handling edge cases, and missing imports.
4. **Reviewer** — Security review: ensure no credentials leak through tool results, ToolGuard is wired into the loop, SecretsGuard sanitizes all output. Check that the circuit breaker actually stops runaway loops. Verify conversation history format matches what the LLM expects.

Commit only after all 4 agents have run.

---

## Environment

- **Bot VM:** 138.201.246.236
- **NC:** nx89136.your-storageshare.de (NC 31.0.13)
- **Ollama:** Running on separate host (check config for endpoint — currently serves DeepSeek-R1 8B)
- **Entry point:** webhook-server.js on :3000 (systemd: moltagent.service)
- **Codebase:** `/opt/moltagent` (or find via `systemctl cat moltagent`)
- **Current test count:** 1,752 (must not regress)

### Model Setup (Prerequisite)

Before starting the agent loop implementation, pull a tool-calling-capable model:

```bash
# On the Ollama host (find endpoint in moltagent config)
ollama pull llama3.1:8b
# Verify it supports tools:
curl -s http://OLLAMA_HOST:11434/api/chat -d '{
  "model": "llama3.1:8b",
  "messages": [{"role": "user", "content": "hi"}],
  "tools": [{"type": "function", "function": {"name": "test", "description": "test", "parameters": {"type": "object", "properties": {}}}}],
  "stream": false
}' | jq '.message.tool_calls // .message.content'
```

If Ollama is not reachable or llama3.1 can't be pulled, implement with the Claude provider as primary and note it in the commit message.

---

## The Revelation

After 13 sessions building every organ — security guards, calendar, Deck, memory, Skill Forge, NC Flow, conversation context — we discovered the nervous system is missing.

**What we have:** webhook-server.js → MessageRouter (regex patterns) → handlers OR raw LLM fallback.
**What we need:** webhook-server.js → AgentLoop (LLM decides what to do, calls tools, loops until done).

The message router with regex patterns was a workaround for not having a tool-calling agent brain. Every edge case ("what's in Working?" not matching a pattern, "close those two" losing context) exists because regex can't understand language. The LLM can — if we give it tools.

**OpenClaw is installed but not running.** No gateway, no agent loop, no tool pipeline. The decision: we build our own agent loop. ~200 lines of JavaScript. Provider-agnostic. Security-wrapped. Our loop, our rules.

This is compatible with OpenClaw's skill/soul file format. SOUL.md and SKILL.md files live in Nextcloud (versioned, access-controlled, integrity-checked). But the runtime is ours.

---

## Architecture

```
NC Talk message arrives
        │
        ▼
┌─────────────────────────────────────────────────┐
│  FAST PATH: Slash commands (/help, /status)     │
│  Still handled by existing CommandHandler       │
│  No LLM needed                                  │
└──────────────────────┬──────────────────────────┘
                       │ not a slash command
                       ▼
┌─────────────────────────────────────────────────┐
│                  AGENT LOOP                      │
│                                                  │
│  1. Load context:                                │
│     - SOUL.md from NC (system prompt/identity)   │
│     - Conversation history (ConversationContext)  │
│     - Memory context (ContextLoader)             │
│     - Tool definitions (built from clients)      │
│                                                  │
│  2. Send to LLM:                                 │
│     system: SOUL.md                              │
│     tools: [deck_*, calendar_*, file_*, tag_*]   │
│     messages: history + current message          │
│                                                  │
│  3. Parse response:                              │
│     ┌─ tool_call? ──► ToolGuard validates        │
│     │                  ──► Execute tool           │
│     │                  ──► Feed result back       │
│     │                  ──► Go to step 2           │
│     │                                            │
│     └─ text? ────────► SecretsGuard sanitizes    │
│                        ──► Return to user        │
│                                                  │
│  4. Circuit breaker: max 8 iterations            │
│                                                  │
└─────────────────────────────────────────────────┘
```

---

## What To Build

| # | File | Purpose |
|---|------|---------|
| 1 | `src/lib/agent/tool-registry.js` | Define tool schemas from existing clients |
| 2 | `src/lib/agent/agent-loop.js` | The core loop: prompt → LLM → tool calls → repeat |
| 3 | `src/lib/agent/providers/ollama-tools.js` | Ollama tool-calling adapter |
| 4 | `src/lib/agent/providers/claude-tools.js` | Claude API tool-calling adapter |
| 5 | `config/SOUL.md` | Agent identity, loaded from NC at startup |
| 6 | Wiring changes | webhook-server.js routes to AgentLoop |
| 7 | Tests | Tool registry, loop logic, provider adapters |

---

## Module 1: ToolRegistry

### Purpose

Generate tool definitions (JSON schemas) from existing Moltagent clients. These schemas tell the LLM what tools are available and how to call them.

### File: `src/lib/agent/tool-registry.js`

```javascript
'use strict';

/**
 * ToolRegistry defines the tools available to the agent and maps
 * tool calls to actual client method invocations.
 *
 * Each tool has:
 * - name: unique identifier
 * - description: what the tool does (LLM reads this)
 * - parameters: JSON schema of expected arguments
 * - handler: async function that executes the tool
 */
class ToolRegistry {
  constructor({ deckClient, calDAVClient, systemTagsClient, ncFiles, logger }) {
    this.clients = { deckClient, calDAVClient, systemTagsClient, ncFiles };
    this.logger = logger || console;
    this.tools = new Map();
    this._registerDefaultTools();
  }

  /**
   * Get all tool definitions in Ollama/OpenAI function-calling format.
   * @returns {Array<Object>} Tool definitions
   */
  getToolDefinitions() {
    return Array.from(this.tools.values()).map(t => ({
      type: 'function',
      function: {
        name: t.name,
        description: t.description,
        parameters: t.parameters
      }
    }));
  }

  /**
   * Execute a tool call, with validation.
   * @param {string} name - Tool name
   * @param {Object} args - Tool arguments
   * @returns {Promise<{success: boolean, result: string, error?: string}>}
   */
  async execute(name, args) {
    const tool = this.tools.get(name);
    if (!tool) {
      return { success: false, result: '', error: `Unknown tool: ${name}` };
    }

    try {
      const result = await tool.handler(args);
      return { success: true, result: typeof result === 'string' ? result : JSON.stringify(result) };
    } catch (err) {
      this.logger.error(`[ToolRegistry] Tool ${name} failed:`, err.message);
      return { success: false, result: '', error: err.message };
    }
  }

  /**
   * Register a custom tool.
   * @param {Object} toolDef - { name, description, parameters, handler }
   */
  register(toolDef) {
    this.tools.set(toolDef.name, toolDef);
  }

  /** @private */
  _registerDefaultTools() {
    // ═══════════════════════════════════════════
    // DECK TOOLS
    // ═══════════════════════════════════════════

    this.register({
      name: 'deck_list_cards',
      description: 'List all cards on the task board, optionally filtered by stack name (Inbox, Queued, Working, Done). Returns card titles, IDs, and which stack they are in.',
      parameters: {
        type: 'object',
        properties: {
          stack: {
            type: 'string',
            description: 'Filter by stack name. If omitted, lists all cards from all stacks.',
            enum: ['Inbox', 'Queued', 'Working', 'Done']
          }
        },
        required: []
      },
      handler: async (args) => {
        const deck = this.clients.deckClient;
        const stacks = await deck.getStacks();
        let cards = [];

        for (const stack of stacks) {
          if (args.stack && stack.title !== args.stack) continue;
          const stackCards = (stack.cards || []).map(c => ({
            id: c.id,
            title: c.title,
            stack: stack.title,
            dueDate: c.duedate || null
          }));
          cards = cards.concat(stackCards);
        }

        if (cards.length === 0) {
          return args.stack
            ? `No cards in ${args.stack}.`
            : 'The board is empty.';
        }

        return cards.map(c =>
          `• [#${c.id}] "${c.title}" — ${c.stack}${c.dueDate ? ` (due: ${c.dueDate})` : ''}`
        ).join('\n');
      }
    });

    this.register({
      name: 'deck_move_card',
      description: 'Move a card to a different stack. Use this when asked to close, finish, start, or queue a task. The card can be identified by title (partial match) or ID.',
      parameters: {
        type: 'object',
        properties: {
          card: {
            type: 'string',
            description: 'Card title (partial match OK) or card ID prefixed with #'
          },
          target_stack: {
            type: 'string',
            description: 'Destination stack',
            enum: ['Inbox', 'Queued', 'Working', 'Done']
          }
        },
        required: ['card', 'target_stack']
      },
      handler: async (args) => {
        const deck = this.clients.deckClient;
        const stacks = await deck.getStacks();

        // Find the card
        let foundCard = null;
        let fromStack = null;

        for (const stack of stacks) {
          for (const card of (stack.cards || [])) {
            const matchById = args.card.startsWith('#') && card.id === parseInt(args.card.slice(1));
            const matchByTitle = card.title.toLowerCase().includes(args.card.toLowerCase());
            if (matchById || matchByTitle) {
              foundCard = card;
              fromStack = stack;
              break;
            }
          }
          if (foundCard) break;
        }

        if (!foundCard) {
          return `❌ No card found matching "${args.card}". Available cards:\n` +
            stacks.flatMap(s => (s.cards || []).map(c => `  • "${c.title}" in ${s.title}`)).join('\n');
        }

        // Find target stack
        const targetStack = stacks.find(s => s.title === args.target_stack);
        if (!targetStack) {
          return `❌ Stack "${args.target_stack}" not found.`;
        }

        if (fromStack.id === targetStack.id) {
          return `Card "${foundCard.title}" is already in ${targetStack.title}.`;
        }

        await deck.moveCard(foundCard.id, targetStack.id);
        return `✅ Moved "${foundCard.title}" (card #${foundCard.id}) from ${fromStack.title} → ${targetStack.title}.`;
      }
    });

    this.register({
      name: 'deck_create_card',
      description: 'Create a new card (task) on the board. Cards are created in the Inbox stack by default.',
      parameters: {
        type: 'object',
        properties: {
          title: { type: 'string', description: 'Card title' },
          description: { type: 'string', description: 'Card description (optional)' },
          stack: {
            type: 'string',
            description: 'Stack to create in (default: Inbox)',
            enum: ['Inbox', 'Queued', 'Working', 'Done']
          }
        },
        required: ['title']
      },
      handler: async (args) => {
        const deck = this.clients.deckClient;
        const stacks = await deck.getStacks();
        const targetName = args.stack || 'Inbox';
        const targetStack = stacks.find(s => s.title === targetName);

        if (!targetStack) {
          return `❌ Stack "${targetName}" not found.`;
        }

        const card = await deck.createCard(targetStack.id, {
          title: args.title,
          description: args.description || ''
        });

        return `✅ Created "${args.title}" (card #${card.id}) in ${targetName}.`;
      }
    });

    // ═══════════════════════════════════════════
    // CALENDAR TOOLS
    // ═══════════════════════════════════════════

    this.register({
      name: 'calendar_list_events',
      description: 'List upcoming calendar events. Returns event titles, times, and descriptions.',
      parameters: {
        type: 'object',
        properties: {
          days: {
            type: 'number',
            description: 'Number of days ahead to check (default: 7)'
          }
        },
        required: []
      },
      handler: async (args) => {
        const cal = this.clients.calDAVClient;
        const days = args.days || 7;
        const events = await cal.getUpcomingEvents(days);

        if (!events || events.length === 0) {
          return `No events in the next ${days} days.`;
        }

        return events.map(e =>
          `• ${e.title} — ${e.start} to ${e.end}${e.location ? ` at ${e.location}` : ''}`
        ).join('\n');
      }
    });

    this.register({
      name: 'calendar_create_event',
      description: 'Create a new calendar event. Supports natural date/time descriptions.',
      parameters: {
        type: 'object',
        properties: {
          title: { type: 'string', description: 'Event title' },
          date: { type: 'string', description: 'Date (e.g., "tomorrow", "next Tuesday", "2026-02-15")' },
          time: { type: 'string', description: 'Start time (e.g., "2pm", "14:00")' },
          duration: { type: 'number', description: 'Duration in minutes (default: 60)' },
          description: { type: 'string', description: 'Event description (optional)' },
          location: { type: 'string', description: 'Location (optional)' }
        },
        required: ['title', 'date', 'time']
      },
      handler: async (args) => {
        const cal = this.clients.calDAVClient;
        const event = await cal.createEvent({
          title: args.title,
          date: args.date,
          time: args.time,
          duration: args.duration || 60,
          description: args.description || '',
          location: args.location || ''
        });

        return `✅ Created "${args.title}" on ${args.date} at ${args.time} (${args.duration || 60} min).` +
          (event?.uid ? ` Event ID: ${event.uid}` : '');
      }
    });

    this.register({
      name: 'calendar_check_conflicts',
      description: 'Check if a time slot has conflicts with existing events.',
      parameters: {
        type: 'object',
        properties: {
          date: { type: 'string', description: 'Date to check' },
          time: { type: 'string', description: 'Time to check' },
          duration: { type: 'number', description: 'Duration in minutes (default: 60)' }
        },
        required: ['date', 'time']
      },
      handler: async (args) => {
        const cal = this.clients.calDAVClient;
        const conflicts = await cal.checkConflicts(args.date, args.time, args.duration || 60);

        if (!conflicts || conflicts.length === 0) {
          return `✅ No conflicts on ${args.date} at ${args.time}.`;
        }

        return `⚠️ Conflicts found:\n` +
          conflicts.map(c => `  • ${c.title} (${c.start} - ${c.end})`).join('\n');
      }
    });

    // ═══════════════════════════════════════════
    // SYSTEM TAGS TOOLS
    // ═══════════════════════════════════════════

    this.register({
      name: 'tag_file',
      description: 'Assign a system tag to a file. Tags: pending, processed, needs-review, ai-flagged.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'File path in Nextcloud' },
          tag: {
            type: 'string',
            description: 'Tag to assign',
            enum: ['pending', 'processed', 'needs-review', 'ai-flagged']
          }
        },
        required: ['path', 'tag']
      },
      handler: async (args) => {
        const tags = this.clients.systemTagsClient;
        await tags.tagFileByPath(args.path, args.tag);
        return `✅ Tagged "${args.path}" as ${args.tag}.`;
      }
    });

    // ═══════════════════════════════════════════
    // MEMORY TOOL (read-only for agent)
    // ═══════════════════════════════════════════

    this.register({
      name: 'memory_recall',
      description: 'Search the learning log and knowledge board for information about a topic. Use this when you need to recall something previously learned.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'What to search for' }
        },
        required: ['query']
      },
      handler: async (args) => {
        // Delegate to ContextLoader's search
        // This is a simplified version — adapt to actual ContextLoader API
        const files = this.clients.ncFiles;
        try {
          const log = await files.read('/moltagent/Memory/LearningLog.md');
          const lines = log.split('\n').filter(l =>
            l.toLowerCase().includes(args.query.toLowerCase())
          );
          if (lines.length === 0) return `No memories found matching "${args.query}".`;
          return `Found ${lines.length} relevant entries:\n${lines.slice(0, 10).join('\n')}`;
        } catch (e) {
          return `Could not access memory: ${e.message}`;
        }
      }
    });
  }
}

module.exports = { ToolRegistry };
```

### Notes for Claude Code

- **Adapt handler implementations to actual client APIs.** The code above assumes `deckClient.getStacks()`, `deckClient.moveCard(cardId, stackId)`, etc. Check the actual method signatures in the existing DeckClient, CalDAVClient, SystemTagsClient, and ncFiles implementations and adjust accordingly.
- The boardId parameter for Deck operations needs to come from config or be fetched once at startup. Check how the existing Deck handler resolves this.
- Calendar's `createEvent` may use a different interface than shown. Check CalDAVClient's actual API.
- The handler functions must never expose credentials. The LLM sees only the result strings.

---

## Module 2: AgentLoop

### Purpose

The core: receives a user message, builds the LLM prompt with tools, runs the call-parse-execute loop until a final text response, then returns it.

### File: `src/lib/agent/agent-loop.js`

```javascript
'use strict';

const fs = require('fs');
const path = require('path');

class AgentLoop {
  /**
   * @param {Object} options
   * @param {Object} options.toolRegistry - ToolRegistry instance
   * @param {Object} options.conversationContext - ConversationContext instance
   * @param {Object} options.contextLoader - ContextLoader instance (memory)
   * @param {Object} options.toolGuard - ToolGuard instance (validates tool calls)
   * @param {Object} options.secretsGuard - SecretsGuard instance (sanitizes output)
   * @param {Object} options.llmProvider - Tool-calling LLM provider (OllamaTools or ClaudeTools)
   * @param {Object} options.config - { maxIterations, soulPath, ... }
   * @param {Object} [options.logger]
   */
  constructor(options) {
    this.toolRegistry = options.toolRegistry;
    this.conversationContext = options.conversationContext;
    this.contextLoader = options.contextLoader;
    this.toolGuard = options.toolGuard;
    this.secretsGuard = options.secretsGuard;
    this.llmProvider = options.llmProvider;
    this.config = options.config || {};
    this.logger = options.logger || console;
    this.maxIterations = this.config.maxIterations || 8;

    // Load SOUL.md (system prompt)
    this.soul = this._loadSoul();
  }

  /**
   * Process a user message through the agent loop.
   *
   * @param {string} message - The user's message text
   * @param {string} roomToken - NC Talk room token (for conversation history)
   * @param {Object} [options]
   * @param {number} [options.messageId] - The trigger message ID (to exclude from history)
   * @returns {Promise<string>} - The agent's final text response
   */
  async process(message, roomToken, options = {}) {
    const startTime = Date.now();

    // 1. Load context
    const history = await this.conversationContext.getHistory(roomToken, {
      excludeMessageId: options.messageId
    });

    const memoryContext = this.contextLoader
      ? await this._loadMemoryContext()
      : '';

    // 2. Build initial messages array
    const systemPrompt = this._buildSystemPrompt(memoryContext);
    const tools = this.toolRegistry.getToolDefinitions();

    const messages = [
      ...history.map(m => ({ role: m.role, content: m.content })),
      { role: 'user', content: message }
    ];

    // 3. Agent loop
    let iteration = 0;
    let lastResponse = null;

    while (iteration < this.maxIterations) {
      iteration++;

      this.logger.info(`[AgentLoop] Iteration ${iteration}/${this.maxIterations}`);

      // Call LLM with tools
      const response = await this.llmProvider.chat({
        system: systemPrompt,
        messages,
        tools
      });

      // Check if LLM wants to call tools
      if (response.toolCalls && response.toolCalls.length > 0) {
        // Process each tool call
        for (const toolCall of response.toolCalls) {
          this.logger.info(`[AgentLoop] Tool call: ${toolCall.name}(${JSON.stringify(toolCall.arguments)})`);

          // Validate with ToolGuard
          const guardResult = this.toolGuard
            ? await this.toolGuard.evaluate({
                tool: toolCall.name,
                arguments: toolCall.arguments
              })
            : { allowed: true };

          let toolResult;
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

          // Add tool call and result to messages
          messages.push({
            role: 'assistant',
            content: '',
            tool_calls: [{
              id: toolCall.id || `call_${iteration}_${toolCall.name}`,
              type: 'function',
              function: {
                name: toolCall.name,
                arguments: JSON.stringify(toolCall.arguments)
              }
            }]
          });

          messages.push({
            role: 'tool',
            tool_call_id: toolCall.id || `call_${iteration}_${toolCall.name}`,
            content: toolResult.success
              ? toolResult.result
              : `Error: ${toolResult.error}`
          });
        }

        // Continue loop — LLM will process tool results
        continue;
      }

      // No tool calls — this is the final text response
      lastResponse = response.content || '';
      break;
    }

    if (!lastResponse && iteration >= this.maxIterations) {
      lastResponse = '⚠️ I ran into a loop trying to process your request. Please try rephrasing.';
      this.logger.warn(`[AgentLoop] Hit max iterations (${this.maxIterations})`);
    }

    // 4. Sanitize output (strip any leaked credentials)
    if (this.secretsGuard) {
      lastResponse = this.secretsGuard.redact(lastResponse);
    }

    const elapsed = Date.now() - startTime;
    this.logger.info(`[AgentLoop] Complete in ${elapsed}ms, ${iteration} iteration(s)`);

    return lastResponse;
  }

  /** @private */
  _buildSystemPrompt(memoryContext) {
    let prompt = this.soul || '';

    if (memoryContext) {
      prompt += `\n\n<agent_memory>\n${memoryContext}\n</agent_memory>`;
    }

    return prompt;
  }

  /** @private */
  _loadSoul() {
    // Try loading from NC (preferred) or local file (fallback)
    const localPath = this.config.soulPath
      || path.join(__dirname, '..', '..', '..', 'config', 'SOUL.md');

    try {
      return fs.readFileSync(localPath, 'utf-8');
    } catch (e) {
      this.logger.warn(`[AgentLoop] Could not load SOUL.md from ${localPath}: ${e.message}`);
      return 'You are Moltagent, a sovereign AI assistant running inside Nextcloud. Help the user manage tasks, calendar, and files.';
    }
  }

  /** @private */
  async _loadMemoryContext() {
    try {
      return await this.contextLoader.getRecentContext();
    } catch (e) {
      this.logger.warn('[AgentLoop] Could not load memory context:', e.message);
      return '';
    }
  }
}

module.exports = { AgentLoop };
```

---

## Module 3: Ollama Tool-Calling Provider

### Purpose

Adapter that calls Ollama's `/api/chat` endpoint with tool definitions and parses tool calls from the response. Ollama natively supports tool calling since 2024 for supported models.

### CRITICAL: Model Selection for Tool Calling

**DeepSeek-R1 8B (currently installed):** Does NOT natively support Ollama's tool calling API. The stock `deepseek-r1:8b` model returns `"does not support tools"`. There IS a community workaround model `MFDoom/deepseek-r1-tool-calling:8b` with a custom chat template, but DeepSeek's own docs say function calling is "unstable" and may result in "looped calls or empty responses."

**Recommended models for reliable tool calling on Ollama (8B class):**
1. **Llama 3.1 8B** — Best overall for tool calling. Natively supported. `ollama pull llama3.1:8b`
2. **Mistral 7B** — Excellent tool calling, lower resources. `ollama pull mistral:7b`
3. **Qwen 2.5 7B** — Strong tool support. `ollama pull qwen2.5:7b`
4. **MFDoom/deepseek-r1-tool-calling:8b** — Community model, may work. Test it.

**Testing order for Session 14:**
1. Pull `llama3.1:8b` and/or `mistral:7b` alongside existing DeepSeek
2. Run the 5-message test sequence with each model
3. If local models work ≥80% of the time → Starter tier is sovereign
4. If local models fail → add Claude API fallback (still proves the loop works)

### File: `src/lib/agent/providers/ollama-tools.js`

```javascript
'use strict';

/**
 * OllamaToolsProvider — Adapter for Ollama's native tool calling API.
 *
 * Ollama API format:
 * POST /api/chat
 * {
 *   model: "llama3.1:8b",
 *   messages: [...],
 *   tools: [...],
 *   stream: false
 * }
 *
 * Response with tool call:
 * {
 *   message: {
 *     role: "assistant",
 *     content: "",
 *     tool_calls: [{ function: { name: "...", arguments: {...} } }]
 *   }
 * }
 */
class OllamaToolsProvider {
  /**
   * @param {Object} config
   * @param {string} config.endpoint - Ollama API URL (e.g., http://localhost:11434)
   * @param {string} config.model - Model name (e.g., llama3.1:8b)
   * @param {number} [config.timeout] - Request timeout in ms (default: 120000)
   * @param {Object} [logger]
   */
  constructor(config, logger) {
    this.endpoint = config.endpoint || 'http://localhost:11434';
    this.model = config.model || 'llama3.1:8b';
    this.timeout = config.timeout || 120000;
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

    // System prompt as first message
    if (system) {
      ollamaMessages.push({ role: 'system', content: system });
    }

    // Convert messages to Ollama format
    for (const msg of messages) {
      if (msg.role === 'tool') {
        // Ollama expects tool results in a specific format
        ollamaMessages.push({
          role: 'tool',
          content: msg.content
        });
      } else if (msg.tool_calls) {
        // Assistant message with tool calls
        ollamaMessages.push({
          role: 'assistant',
          content: msg.content || '',
          tool_calls: msg.tool_calls.map(tc => ({
            function: {
              name: tc.function?.name || tc.name,
              arguments: typeof tc.function?.arguments === 'string'
                ? JSON.parse(tc.function.arguments)
                : tc.function?.arguments || tc.arguments
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
      options: {
        num_predict: 1024
      }
    };

    // Only include tools if provided and non-empty
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

    // Check for tool calls
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

    // Plain text response
    return {
      content: message.content || '',
      toolCalls: null
    };
  }
}

module.exports = { OllamaToolsProvider };
```

---

## Module 4: Claude API Tool-Calling Provider

### Purpose

Adapter for Claude's API with native tool calling. Used as fallback when local models can't handle the task, or as primary for Pro/Sovereign tier customers.

### File: `src/lib/agent/providers/claude-tools.js`

```javascript
'use strict';

/**
 * ClaudeToolsProvider — Adapter for Anthropic's Claude API with tool calling.
 *
 * Claude API format:
 * POST https://api.anthropic.com/v1/messages
 * {
 *   model: "claude-sonnet-4-5-20250929",
 *   system: "...",
 *   messages: [...],
 *   tools: [...],
 *   max_tokens: 1024
 * }
 */
class ClaudeToolsProvider {
  /**
   * @param {Object} config
   * @param {string} config.model - Claude model (default: claude-sonnet-4-5-20250929)
   * @param {number} [config.maxTokens] - Max response tokens (default: 1024)
   * @param {number} [config.timeout] - Request timeout in ms (default: 30000)
   * @param {Function} config.getApiKey - Async function that returns the API key
   *   (fetches from NC Passwords via credential broker — never stored)
   * @param {Object} [logger]
   */
  constructor(config, logger) {
    this.model = config.model || 'claude-sonnet-4-5-20250929';
    this.maxTokens = config.maxTokens || 1024;
    this.timeout = config.timeout || 30000;
    this.getApiKey = config.getApiKey;
    this.logger = logger || console;
  }

  async chat({ system, messages, tools }) {
    const apiKey = await this.getApiKey();
    if (!apiKey) throw new Error('Claude API key not available');

    // Convert tools to Claude format
    const claudeTools = (tools || []).map(t => ({
      name: t.function.name,
      description: t.function.description,
      input_schema: t.function.parameters
    }));

    // Convert messages — Claude doesn't use 'system' in messages array
    const claudeMessages = [];
    for (const msg of messages) {
      if (msg.role === 'system') continue; // handled separately

      if (msg.role === 'tool') {
        claudeMessages.push({
          role: 'user',
          content: [{
            type: 'tool_result',
            tool_use_id: msg.tool_call_id,
            content: msg.content
          }]
        });
      } else if (msg.tool_calls) {
        claudeMessages.push({
          role: 'assistant',
          content: msg.tool_calls.map(tc => ({
            type: 'tool_use',
            id: tc.id || tc.function?.id,
            name: tc.function?.name || tc.name,
            input: typeof tc.function?.arguments === 'string'
              ? JSON.parse(tc.function.arguments)
              : tc.function?.arguments || tc.arguments
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
      system: system || undefined,
      messages: claudeMessages
    };

    if (claudeTools.length > 0) {
      body.tools = claudeTools;
    }

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

      if (!response.ok) {
        const errText = await response.text();
        throw new Error(`Claude API error ${response.status}: ${errText}`);
      }

      const data = await response.json();
      return this._parseResponse(data);

    } catch (err) {
      clearTimeout(timeoutId);
      if (err.name === 'AbortError') {
        throw new Error(`Claude API timed out after ${this.timeout}ms`);
      }
      throw err;
    }
  }

  /** @private */
  _parseResponse(data) {
    const content = data.content || [];

    const textBlocks = content.filter(b => b.type === 'text');
    const toolBlocks = content.filter(b => b.type === 'tool_use');

    if (toolBlocks.length > 0) {
      return {
        content: textBlocks.map(b => b.text).join('\n') || null,
        toolCalls: toolBlocks.map(b => ({
          id: b.id,
          name: b.name,
          arguments: b.input || {}
        }))
      };
    }

    return {
      content: textBlocks.map(b => b.text).join('\n') || '',
      toolCalls: null
    };
  }
}

module.exports = { ClaudeToolsProvider };
```

---

## Module 5: SOUL.md

### Purpose

The agent's identity file. Replaces `config/system-prompt.md` from Session 13. Lives in NC at `/moltagent/Config/SOUL.md` (versioned, access-controlled) with a local fallback at `config/SOUL.md` on the Bot VM.

### File: `config/SOUL.md`

Take the system prompt from Session 13's `config/system-prompt.md` and rename/move it to `config/SOUL.md`. Keep the content identical — it already has identity, capabilities, behavioral rules, tool-use instructions, and response style. The AgentLoop loads this file.

Additionally, **upload a copy to NC** at `/moltagent/Config/SOUL.md` via WebDAV. The AgentLoop can later be enhanced to load from NC first, falling back to local.

No content changes needed — the Session 13 system prompt is already comprehensive.

---

## Module 6: Wiring — Connect AgentLoop to the Webhook Server

### Find and Modify the Message Processing Path

The current flow in `webhook-server.js` (or wherever incoming Talk messages are processed) needs to change:

```
BEFORE:
  message → MessageRouter.classify() → handler or LLM fallback

AFTER:
  message → is slash command? → CommandHandler (existing)
          → is Skill Forge trigger? → SkillForgeHandler (existing)
          → everything else → AgentLoop.process()
```

### Startup Wiring (in bot.js/index.js or wherever the server initializes):

```javascript
const { ToolRegistry } = require('./lib/agent/tool-registry');
const { AgentLoop } = require('./lib/agent/agent-loop');
const { OllamaToolsProvider } = require('./lib/agent/providers/ollama-tools');
const { ClaudeToolsProvider } = require('./lib/agent/providers/claude-tools');
const { ConversationContext } = require('./lib/talk/conversation-context');

// Tool Registry — wire up all existing clients
const toolRegistry = new ToolRegistry({
  deckClient,
  calDAVClient,
  systemTagsClient,
  ncFiles
});

// LLM Provider — start with Ollama, fallback to Claude
const ollamaProvider = new OllamaToolsProvider({
  endpoint: config.ollama?.endpoint || 'http://localhost:11434',
  model: config.agentLoop?.model || 'llama3.1:8b',  // NOT deepseek-r1 for tool calling
  timeout: config.ollama?.timeout || 120000
});

const claudeProvider = new ClaudeToolsProvider({
  model: 'claude-sonnet-4-5-20250929',
  getApiKey: async () => credentialBroker.get('claude-api-key'),
  timeout: 30000
});

// Choose provider based on config
const llmProvider = config.agentLoop?.provider === 'claude'
  ? claudeProvider
  : ollamaProvider;

// Conversation Context (from Session 13)
const conversationContext = new ConversationContext(
  config.talk?.conversationContext,
  ncRequestManager
);

// Agent Loop
const agentLoop = new AgentLoop({
  toolRegistry,
  conversationContext,
  contextLoader,          // existing ContextLoader from Session 6
  toolGuard,              // existing ToolGuard from Session 2
  secretsGuard,           // existing SecretsGuard from Session 1
  llmProvider,
  config: {
    maxIterations: config.agentLoop?.maxIterations || 8,
    soulPath: path.join(__dirname, 'config', 'SOUL.md')
  }
});
```

### Message Handler Change:

```javascript
// In the webhook handler / message processor:

async function handleTalkMessage(message, roomToken) {
  const text = message.text?.trim();
  if (!text) return;

  // Fast path: slash commands
  if (text.startsWith('/') || text.startsWith('!')) {
    return await commandHandler.handle(text, roomToken);
  }

  // Skill Forge triggers
  if (skillForgeHandler.isSkillForgeMessage(text)) {
    return await skillForgeHandler.handle(text, roomToken, message);
  }

  // Everything else: Agent Loop
  const response = await agentLoop.process(text, roomToken, {
    messageId: message.id
  });

  await talkClient.sendMessage(roomToken, response);
}
```

---

## Module 7: Testing

### Test: ToolRegistry

```javascript
// test/unit/agent/tool-registry.test.js

describe('ToolRegistry', () => {
  test('returns tool definitions in correct format', () => {
    const registry = new ToolRegistry({
      deckClient: mockDeckClient,
      calDAVClient: mockCalDAVClient,
      systemTagsClient: mockTagsClient,
      ncFiles: mockNcFiles
    });

    const defs = registry.getToolDefinitions();
    expect(defs.length).toBeGreaterThan(0);
    expect(defs[0]).toHaveProperty('type', 'function');
    expect(defs[0]).toHaveProperty('function.name');
    expect(defs[0]).toHaveProperty('function.description');
    expect(defs[0]).toHaveProperty('function.parameters');
  });

  test('executes deck_list_cards tool', async () => { /* ... */ });
  test('executes deck_move_card tool with partial title match', async () => { /* ... */ });
  test('deck_move_card returns error for unknown card', async () => { /* ... */ });
  test('executes calendar_list_events tool', async () => { /* ... */ });
  test('returns error for unknown tool name', async () => {
    const registry = new ToolRegistry({ /* mocks */ });
    const result = await registry.execute('nonexistent_tool', {});
    expect(result.success).toBe(false);
    expect(result.error).toContain('Unknown tool');
  });
  test('custom tool can be registered and executed', async () => { /* ... */ });
});
```

### Test: AgentLoop

```javascript
// test/unit/agent/agent-loop.test.js

describe('AgentLoop', () => {
  test('returns text response for simple message', async () => {
    const mockProvider = {
      chat: jest.fn().mockResolvedValue({ content: 'Hello!', toolCalls: null })
    };

    const loop = new AgentLoop({
      toolRegistry: new ToolRegistry({ /* mocks */ }),
      conversationContext: { getHistory: jest.fn().mockResolvedValue([]) },
      llmProvider: mockProvider,
      config: { soulPath: '/tmp/test-soul.md' }
    });

    const response = await loop.process('Hi there', 'room-abc');
    expect(response).toBe('Hello!');
    expect(mockProvider.chat).toHaveBeenCalledTimes(1);
  });

  test('executes tool call and feeds result back to LLM', async () => {
    let callCount = 0;
    const mockProvider = {
      chat: jest.fn().mockImplementation(() => {
        callCount++;
        if (callCount === 1) {
          // First call: LLM wants to use a tool
          return { content: null, toolCalls: [{ id: 'call_1', name: 'deck_list_cards', arguments: {} }] };
        }
        // Second call: LLM responds with final text after seeing tool result
        return { content: 'You have 3 tasks.', toolCalls: null };
      })
    };

    const mockRegistry = {
      getToolDefinitions: () => [{ type: 'function', function: { name: 'deck_list_cards', description: 'List cards', parameters: {} } }],
      execute: jest.fn().mockResolvedValue({ success: true, result: '3 cards found' })
    };

    const loop = new AgentLoop({
      toolRegistry: mockRegistry,
      conversationContext: { getHistory: jest.fn().mockResolvedValue([]) },
      llmProvider: mockProvider,
      config: {}
    });

    const response = await loop.process('What tasks do I have?', 'room-abc');
    expect(response).toBe('You have 3 tasks.');
    expect(mockProvider.chat).toHaveBeenCalledTimes(2);
    expect(mockRegistry.execute).toHaveBeenCalledWith('deck_list_cards', {});
  });

  test('hits circuit breaker after max iterations', async () => {
    const mockProvider = {
      chat: jest.fn().mockResolvedValue({
        content: null,
        toolCalls: [{ id: 'call', name: 'deck_list_cards', arguments: {} }]
      })
    };

    const mockRegistry = {
      getToolDefinitions: () => [],
      execute: jest.fn().mockResolvedValue({ success: true, result: 'data' })
    };

    const loop = new AgentLoop({
      toolRegistry: mockRegistry,
      conversationContext: { getHistory: jest.fn().mockResolvedValue([]) },
      llmProvider: mockProvider,
      config: { maxIterations: 3 }
    });

    const response = await loop.process('test', 'room-abc');
    expect(response).toContain('loop');
    expect(mockProvider.chat).toHaveBeenCalledTimes(3);
  });

  test('ToolGuard blocks dangerous tool call', async () => { /* ... */ });
  test('SecretsGuard sanitizes final output', async () => { /* ... */ });
  test('conversation history is included in messages', async () => { /* ... */ });
  test('memory context is included in system prompt', async () => { /* ... */ });
});
```

### Test: OllamaToolsProvider

```javascript
// test/unit/agent/providers/ollama-tools.test.js

describe('OllamaToolsProvider', () => {
  test('sends correct request format to Ollama', async () => { /* ... */ });
  test('parses tool call response', () => {
    const provider = new OllamaToolsProvider({ endpoint: 'http://localhost:11434', model: 'test' });
    const result = provider._parseResponse({
      message: {
        role: 'assistant',
        content: '',
        tool_calls: [{
          function: { name: 'deck_list_cards', arguments: { stack: 'Working' } }
        }]
      }
    });

    expect(result.toolCalls).toHaveLength(1);
    expect(result.toolCalls[0].name).toBe('deck_list_cards');
    expect(result.toolCalls[0].arguments).toEqual({ stack: 'Working' });
  });

  test('parses plain text response', () => { /* ... */ });
  test('handles timeout gracefully', async () => { /* ... */ });
  test('handles HTTP errors', async () => { /* ... */ });
});
```

---

## Live Testing Protocol

After the modules are built and unit tests pass, run this test LIVE on the Bot VM:

### Step 0: Pull a Tool-Calling Model

```bash
# SSH to Ollama host (wherever Ollama runs)
ollama pull llama3.1:8b
# OR
ollama pull mistral:7b
```

### Step 1: Deploy and Restart

```bash
# On Bot VM
cd /opt/moltagent  # or wherever it lives
git pull
sudo systemctl restart moltagent
```

### Step 2: The 5-Message Test

In NC Talk, send these in sequence. Record what Moltagent responds:

```
1. "Do I have open tasks?"
   Expected: calls deck_list_cards → returns real card list

2. "What's in Working?"
   Expected: calls deck_list_cards({ stack: "Working" }) → returns Working cards

3. "Close 'Are there black tigers'"
   Expected: calls deck_move_card({ card: "Are there black tigers", target_stack: "Done" })
             → returns "✅ Moved ... to Done"

4. "Also close 'Evaluate Superdesign.dev'"
   Expected: uses conversation history + calls deck_move_card → returns "✅ Moved ..."

5. "Confirm both are done"
   Expected: calls deck_list_cards({ stack: "Done" }) → lists both cards in Done
```

### Step 3: Compare Providers (if time permits)

Run the same 5 messages with:
- **Round 1:** Ollama with llama3.1:8b (config: `agentLoop.provider = 'ollama'`)
- **Round 2:** Claude Sonnet (config: `agentLoop.provider = 'claude'`)

Compare: reliability of tool calls, response quality, response time.

---

## Exit Criteria

### ToolRegistry:
- [ ] Generates valid tool definitions in OpenAI function-calling format
- [ ] All tool handlers execute against real client APIs (DeckClient, CalDAVClient, etc.)
- [ ] deck_list_cards returns real card data
- [ ] deck_move_card finds cards by partial title match
- [ ] deck_create_card creates cards in specified stack
- [ ] calendar_list_events returns upcoming events
- [ ] Unknown tool returns error (doesn't crash)
- [ ] Custom tools can be registered dynamically

### AgentLoop:
- [ ] Processes a simple message (no tool calls) → returns LLM text
- [ ] Processes a message requiring one tool call → executes tool → returns result
- [ ] Processes a message requiring multiple tool calls → handles all
- [ ] Circuit breaker stops after maxIterations
- [ ] ToolGuard blocks unauthorized tool calls
- [ ] SecretsGuard sanitizes final output
- [ ] Conversation history flows into LLM context
- [ ] Memory context injected into system prompt
- [ ] SOUL.md loaded and used as system prompt

### Providers:
- [ ] OllamaToolsProvider sends correct format to Ollama API
- [ ] OllamaToolsProvider parses tool call responses
- [ ] OllamaToolsProvider handles timeouts gracefully
- [ ] ClaudeToolsProvider sends correct format to Anthropic API
- [ ] ClaudeToolsProvider parses tool_use blocks
- [ ] ClaudeToolsProvider fetches API key via credential broker (never stored)

### Wiring:
- [ ] Slash commands still handled by CommandHandler
- [ ] Skill Forge triggers still handled by SkillForgeHandler
- [ ] All other messages route through AgentLoop
- [ ] All tests pass: `npm test`
- [ ] ESLint passes: `npm run lint`

### Live Test:
- [ ] 5-message sequence works with at least one provider
- [ ] Tool calls produce real results (actual card IDs, real board state)
- [ ] No hallucinated actions
- [ ] Conversation context maintained across messages

---

## Do NOT Change

- Security guards (SecretsGuard, ToolGuard, PromptGuard, PathGuard, EgressGuard)
- Credential broker mechanism
- NC Flow modules (webhook receiver, activity poller, system tags)
- Talk bot webhook verification (HMAC-SHA256)
- HeartbeatManager's pulse/heartbeat timing
- NCRequestManager or endpoint groups

## Do NOT Remove (But It Gets Bypassed)

- MessageRouter — keep it for potential future use (fast-path intent classification, analytics). The AgentLoop replaces its role as the brain, but the code stays.
- Session 13's ConversationContext — AgentLoop uses it directly.
- Session 13's `config/system-prompt.md` — rename to `config/SOUL.md`, same content.

---

## What Comes Next (After This Session)

1. **Live dogfooding** — use Moltagent via Talk for a full day of real work
2. **Provider comparison** — document DeepSeek vs Llama vs Mistral vs Claude for tool calling
3. **Fallback chain in AgentLoop** — if Ollama tool call fails to parse or returns malformed JSON, automatically retry the same prompt with Claude. This is the bridge between "sovereign when possible" and "reliable always." Implementation: wrap `llmProvider.chat()` in a try/catch that swaps to the fallback provider on parse failure. One config flag: `agentLoop.fallbackProvider`.
4. **SOUL.md in NC** — load from Nextcloud with integrity checking (MemoryIntegrityChecker)
5. **Calendar v2 Smart Meetings** — add meeting tools to ToolRegistry
6. **Cost tracking** — track tokens per agent loop iteration

### DeepSeek-R1 8B Tool Calling Notes (For Reference)

From testing and community reports: DeepSeek-R1 8B can technically do tool calling but "randomly misses tokens" in tool call payloads, produces malformed JSON with complex schemas, and may loop. It works acceptably for simple single-tool calls with short arguments. For the Moltagent use case (multiple tools, multi-step reasoning), Llama 3.1 8B or Mistral 7B are significantly more reliable choices for sovereign tool calling. Keep DeepSeek-R1 for general reasoning tasks where tool calling isn't needed.

---

*Session 14: Every organ was built. Now we connect the nervous system.*
*"You built a body. This session gives it a brain."*
