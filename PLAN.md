# MoltAgent Session 13: Conversational UX Fix -- Implementation Plan

**Date:** 2026-02-08
**Status:** Architecture Defined
**Author:** Claude Opus 4.6 (Architect)
**Implements:** `/opt/moltagent/docs/Moltagent-Session13-ConversationalUX-CCode-Brief.md`

---

## 1. Architecture Brief

### Problem Statement

MoltAgent suffers from "amnesia" -- each incoming message is processed in
isolation with zero conversation history. The LLM does not know it is
MoltAgent, has no tool-use instructions, and frequently hallucinates
actions it never performed. The message router fails to classify action
patterns like "close X and Y" as deck operations and instead sends them
to the LLM, which treats card titles as questions to answer.

### Chosen Pattern and Rationale

**Three-layer fix:**

1. **ConversationContext** (new module): Fetches the last N messages from
   NC Talk, formats them for LLM prompt injection. Fixes amnesia.

2. **System prompt enrichment** (modify existing): The system prompt at
   `config/system-prompt.md` already exists and is already loaded by
   `src/lib/llm/providers/base-provider.js` (line 14-28). It needs to be
   expanded with tool-use instructions, behavioral rules, and context
   understanding directives per the brief.

3. **Message router improvements** (modify existing): Add deck action
   patterns (close, move, complete, reconfirm), multi-card parsing, and
   conversation-aware routing to the MessageRouter.

### Key Dependencies and Integration Points

- **NCRequestManager** (`src/lib/nc-request-manager.js`): Used by
  ConversationContext to fetch Talk chat history. Properties: `.ncUrl`,
  `.ncUser`. Response format: `{ status, statusText, headers, body, fromCache }`.
  The `body` is auto-parsed JSON when Content-Type is application/json.

- **BaseProvider** (`src/lib/llm/providers/base-provider.js`): Already
  loads `config/system-prompt.md` via `getSystemPrompt()` at line 14-28
  and injects it into `buildPrompt()` at line 118. This is the single
  place where the system prompt enters the LLM call chain. All providers
  (Ollama, Anthropic, Google, OpenAI-compatible) inherit from BaseProvider
  and call `this.buildPrompt()`.

- **MessageRouter** (`src/lib/handlers/message-router.js`): The core
  routing class. `classifyIntent()` at line 146 determines intent.
  `_handleDeck()` at line 463 processes deck commands. `_handleGeneral()`
  at line 762 calls the LLM.

- **MessageProcessor** (`src/lib/server/message-processor.js`): Receives
  webhook data, extracts message, calls `messageRouter.route()`. This is
  where we inject ConversationContext -- the processor has access to the
  room token and message ID.

- **DeckClient** (`src/lib/integrations/deck-client.js`): Has `moveCard()`,
  `getAllCards()`, `getCardsInStack()`, `ensureBoard()`. The `moveCard()`
  signature is `moveCard(cardId, fromStack, toStack, order)` where stacks
  are key names like 'inbox', 'done', 'working'.

- **Test framework**: Custom `test/helpers/test-runner.js` with
  `{ test, asyncTest, summary, exitWithCode }`. Uses Node.js `assert`
  module. NOT Jest -- do NOT use `jest.fn()` or `describe()/it()`.

### Data Flow Summary

```
CURRENT (broken):
  Webhook -> MessageProcessor.process(data)
    -> extract message (content, user, token)
    -> messageRouter.route(content, {user, token})
      -> classifyIntent(content)
      -> _handleGeneral(content, context) // most things end up here
        -> llmRouter.route({task:'chat', content: message})
          -> provider.generate('chat', message)
            -> buildPrompt('chat', message) // system prompt from file
              -> "You are MoltAgent..." + message (no history!)
      -> response sent to Talk

AFTER (fixed):
  Webhook -> MessageProcessor.process(data)
    -> extract message (content, user, token, messageId)
    -> conversationContext.getHistory(token, {excludeMessageId})
    -> messageRouter.route(content, {user, token, messageId, history})
      -> classifyIntent(content, history)  // NEW: history-aware
        -> check deck action patterns FIRST (close, move, complete)
        -> check conversation references ("the one in inbox")
      -> IF deck_action intent:
           -> _handleDeck(content, context)  // enhanced with move/close/multi-card
           -> return factual result string (NOT LLM-generated)
      -> IF general intent:
           -> _handleGeneral(content, context)
             -> build prompt with conversation history
             -> llmRouter.route({task:'chat', content: history+message})
      -> response sent to Talk
```

### What NOT To Change

Per the brief:
- NCRequestManager or endpoint groups
- Security guards
- Credential broker mechanism
- NC Flow modules (webhook receiver, activity poller, system tags)
- Talk bot webhook verification
- HeartbeatManager pulse/heartbeat timing

---

## 2. Deviations from Brief Based on Actual Codebase Analysis

### D1: System Prompt Already Loaded -- No bot.js Change Needed

The brief suggests loading `config/system-prompt.md` in `bot.js` and
injecting into every LLM call. **The codebase already does this.**

`src/lib/llm/providers/base-provider.js` lines 14-28:
```javascript
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
```

And `buildPrompt()` at line 118 injects it as `identity` into every task
prompt. All providers (Ollama, Anthropic, Google, OpenAI) call
`this.buildPrompt(task, content, options)` which returns `identity + task-specific template`.

**Action:** We only need to update the content of `config/system-prompt.md`.
No code changes needed for system prompt loading.

### D2: NCRequestManager Response Format -- Plain Object, Not Fetch

The brief's ConversationContext code uses `response.json()` (fetch style).
Actual NCRequestManager returns `{ status, body, headers }` where `body`
is already parsed JSON when Content-Type is application/json.

The ConversationContext code in the brief has a safety check for this
(lines 174-178), so we use `body` directly but keep the fallback.

### D3: Test Framework -- Custom Runner, NOT Jest

The brief's test code uses `jest.fn()` and `describe()/it()`. The actual
codebase uses a custom test runner at `test/helpers/test-runner.js` with
`test()`, `asyncTest()`, `summary()`, `exitWithCode()`. Tests use
`require('assert')` for assertions. Mock factories are at
`test/helpers/mock-factories.js`.

All tests must use this framework, not Jest.

### D4: DeckClient.moveCard Signature

The brief assumes `moveCard(boardId, cardId, targetStackId)`. The actual
signature is `moveCard(cardId, fromStack, toStack, order)` where stacks
are key names ('inbox', 'done', etc.) and the client resolves IDs internally.

We need to know which stack a card is in before moving it. The approach:
use `getAllCards()` to find the card and its current stack.

### D5: Conversation History in LLM Calls

The brief suggests passing `messages` array with role/content pairs to the
LLM. The actual LLM call chain is:
```
llmRouter.route({task, content, requirements})
  -> provider.generate(task, content, options)
    -> provider.buildPrompt(task, content) // returns a single string
    -> fetch(ollamaUrl, {body: {prompt: singleString}})
```

The LLM providers use a single `prompt` string, not a messages array.
The conversation history must be formatted as a text block and prepended
to the `content` parameter passed to `llmRouter.route()`.

This is already how the MessageRouter works -- `_handleGeneral()` prepends
`contextBlock` (agent memory) to the message content before calling
`llmRouter.route()`.

### D6: MessageProcessor Does Not Currently Pass History

`MessageProcessor.process()` calls `messageRouter.route(content, context)`
where context is `{user, token, messageId}`. The ConversationContext
fetch must happen in MessageProcessor (which has access to the room token)
and the history must be added to the context object passed to the router.

### D7: Config is Frozen

`src/lib/config.js` exports a deeply frozen object. We cannot add
`talk.conversationContext` to it at runtime. Instead, we should add
the `conversationContext` section to the config file itself (it will be
frozen with everything else).

---

## 3. File-by-File Change Specifications

### 3.1 NEW: `src/lib/talk/conversation-context.js` (~120 lines)

**Purpose:** Fetch Talk chat history, format for LLM prompt injection.

**Class:** `ConversationContext`

**Constructor:**
```javascript
/**
 * @param {Object} config - Configuration options
 * @param {boolean} [config.enabled=true] - Enable/disable context fetching
 * @param {number} [config.maxMessages=20] - Max messages to fetch
 * @param {number} [config.maxTokenEstimate=2000] - Token budget
 * @param {boolean} [config.includeSystemMessages=false] - Include system messages
 * @param {number} [config.maxMessageAge=3600000] - Max message age in ms
 * @param {Object} ncRequestManager - NCRequestManager instance
 * @param {Object} [logger] - Logger (defaults to console)
 */
```

**Private State:**
- `this.config` -- config object
- `this.nc` -- NCRequestManager instance
- `this.logger` -- logger
- `this.enabled` -- boolean

**Methods:**

```javascript
async getHistory(roomToken, options = {})
  // Fetches messages from Talk API:
  //   GET /ocs/v2.php/apps/spreed/api/v1/chat/{token}?lookIntoFuture=0&limit={limit}&includeLastKnown=0
  //   Headers: OCS-APIRequest: true, Accept: application/json
  //   endpointGroup detection: URL matches /apps/spreed/ pattern -> 'talk' group
  // NCRequestManager note: URL path is relative, NCRequestManager prepends ncUrl.
  //   Use cacheTtlMs: 0 (or omit -- the talk group default is 5s which is fine)
  // Response: nc.request() returns { status, body } where body is parsed JSON
  //   body.ocs.data = array of message objects
  // Returns: Array<{role, name, content, timestamp}>

_formatMessages(rawMessages, excludeId)
  // Filter system messages (systemMessage !== '')
  // Filter excluded message ID
  // Filter messages older than maxMessageAge
  // Reverse (Talk returns newest-first, we want chronological)
  // Map to {role: 'assistant'|'user', name, content, timestamp}
  //   role = 'assistant' if actorId matches ncUser
  // Trim to token budget (keep most recent)
  // Returns formatted array

formatForPrompt(history)
  // Converts history array to string:
  //   <conversation_history>
  //   Funana: Do I have tasks?
  //
  //   Moltagent: Yes, 4 open tasks.
  //   </conversation_history>
  // Returns empty string if no history
```

**Integration with NCRequestManager:**
The Talk API path `/ocs/v2.php/apps/spreed/api/v1/chat/{token}` matches
both the 'talk' group pattern (`/apps/spreed/`) and the 'ocs' group
pattern (`/ocs/v2.php/`). NCRequestManager resolves by first match in
ENDPOINT_GROUPS order. The 'talk' group has 5s cache TTL and maxRetries: 2.
We should NOT override cacheTtlMs -- 5 seconds is fine for chat history
(prevents redundant fetches within the same pulse cycle).

**Error handling:** All errors return `[]` (graceful degradation).
ConversationContext is an enhancement, not a requirement.

---

### 3.2 MODIFY: `config/system-prompt.md`

**Current state:** 28 lines. Basic identity, tool list, behavior rules.

**Action:** Replace entire content with the expanded system prompt from the
brief (section "Module 2: System Prompt"). The expanded version includes:
- Detailed identity section
- Tool capability descriptions with action verbs
- CRITICAL rules about card titles
- Behavioral rules (ALWAYS DO / NEVER DO)
- Response style guidelines
- Context understanding patterns ("the one in inbox", etc.)

**Specific additions over current content:**
- "CRITICAL: When the user references a task by title, they mean a CARD on
  your Deck board. Do NOT treat card titles as questions to answer."
- "Use your tools. When asked to move a task, actually call DeckClient.moveCard()."
- "Confirm with real results: card ID, event UID, file path."
- "Follow the conversation. You can see the recent chat history."
- "Never hallucinate actions. If a tool call fails, say it failed."
- Context understanding section with examples

The expanded prompt is ~120 lines. See brief section "Module 2" for full text.

**Impact:** Since BaseProvider caches the system prompt in a module-level
variable `_systemPrompt` (lazy-loaded on first call), the updated file will
be picked up on next bot restart. No code changes needed.

---

### 3.3 MODIFY: `src/lib/config.js` -- Add conversationContext config

**Location:** Inside the `talk` section (line 311-313).

**Current:**
```javascript
talk: {
  defaultToken: envStr('NC_TALK_DEFAULT_TOKEN', null)
},
```

**After:**
```javascript
talk: {
  defaultToken: envStr('NC_TALK_DEFAULT_TOKEN', null),
  conversationContext: {
    enabled: envBool('TALK_CONTEXT_ENABLED', true),
    maxMessages: envInt('TALK_CONTEXT_MAX_MESSAGES', 20),
    maxTokenEstimate: envInt('TALK_CONTEXT_MAX_TOKENS', 2000),
    includeSystemMessages: envBool('TALK_CONTEXT_INCLUDE_SYSTEM', false),
    maxMessageAge: envInt('TALK_CONTEXT_MAX_AGE', 3600000)
  }
},
```

**Note:** The config is frozen via `deepFreeze()`. This is fine -- we're
adding the properties at definition time, before freezing occurs.

---

### 3.4 MODIFY: `src/lib/handlers/message-router.js` -- Enhanced Intent Classification and Deck Handling

This is the most significant change. Multiple areas need modification.

#### 3.4.1 Add Deck Action Patterns to `classifyIntent()`

**Location:** `classifyIntent()` method, line 146-253.

**Current deck detection (lines 198-211):**
Only matches static keyword phrases like 'deck board', 'my tasks', 'open tasks', etc.
Does NOT match action patterns like "close X", "put X into done", "mark X as done".

**Add BEFORE the existing deckKeywords check (around line 197):**

```javascript
// Deck ACTION patterns (high priority -- check before keyword-based deck match)
// These patterns indicate the user wants to PERFORM an action on a Deck card.
const DECK_ACTION_PATTERNS = [
  // Close/complete/done patterns
  /(?:close|finish|complete|mark\s+as\s+done|put\s+into?\s+done|move\s+to\s+done)\b/i,
  // Move patterns
  /(?:move|put|shift)\s+.+\s+(?:to|into)\s+(?:inbox|queued|working|review|done)\b/i,
  // Start/work patterns
  /(?:start|begin|work\s+on)\s+.+/i,
  // Reconfirm/verify patterns
  /(?:reconfirm|verify|check\s+if|is|are)\s+.+\s+(?:done|closed|completed|in\s+done)\b/i,
  // "due next week" / "due this week" task queries
  /(?:due|overdue)\s+(?:this|next|last)\s+(?:week|month)\b/i,
  // "tasks that are" patterns
  /tasks?\s+(?:that\s+are|which\s+are)\b/i,
];

for (const pattern of DECK_ACTION_PATTERNS) {
  if (pattern.test(lower)) {
    return 'deck';
  }
}
```

**This ensures** "close X and Y", "put X into done", "reconfirm if X is done",
"mark as done: X" all classify as deck intent BEFORE the email keyword scoring.

#### 3.4.2 Add `history` Parameter to Route Context

**Location:** `route()` method signature at line 286.

**Current:**
```javascript
async route(message, context = {}) {
  const { user, token, messageId } = context;
```

**No signature change needed** -- context is already an open object. The
MessageProcessor will add `history` to the context object. The router
just needs to pass it through.

**Change in `route()` around line 292:**
```javascript
// Pass history to classifyIntent for context-aware classification
let intent = this.classifyIntent(message, context.history);
```

#### 3.4.3 Update `classifyIntent()` to Accept History

**Location:** Line 146.

**Current:**
```javascript
classifyIntent(message) {
```

**After:**
```javascript
classifyIntent(message, history) {
```

The `history` parameter is optional. When present, it enables
conversation-aware reference resolution for ambiguous messages.

**Add at the END of classifyIntent, before `return 'general'`:**

```javascript
// Conversation-aware reference resolution
// If the message references something from recent history, try to resolve intent
if (history && history.length > 0) {
  const refPatterns = [
    /(?:the\s+one|which\s+one).*(?:inbox|working|done|queued)/i,
    /(?:those|the\s+first|the\s+second|the\s+last|all\s+of\s+them)/i,
    /(?:close|move|finish|complete)\s+(?:it|them|those|that)/i,
  ];

  if (refPatterns.some(p => p.test(lower))) {
    // Check if recent assistant messages contain deck-related content
    const recentAssistant = history
      .filter(m => m.role === 'assistant')
      .slice(-3);
    const hasDeckContext = recentAssistant.some(m =>
      /task board|inbox|working|queued|done|open tasks/i.test(m.content)
    );
    if (hasDeckContext) {
      return 'deck';
    }
  }
}
```

#### 3.4.4 Enhance `_handleDeck()` with Move/Close/Multi-Card Operations

**Location:** `_handleDeck()` method at line 463-538.

**Current:** Only supports `add task: <title>` and list/show tasks.

**Replace the method body** with an enhanced version that handles:

1. **Close/complete/done commands** -- parse card title(s), find card(s),
   move to 'done' stack, return factual result.
2. **Move commands** -- parse card title, target stack, move card.
3. **Multi-card operations** -- "close X and Y" parses to multiple titles.
4. **Reconfirm/verify** -- check if a card is in the expected stack.
5. **Existing functionality** -- add task, list tasks (preserved).

**New helper methods to add:**

```javascript
/**
 * Parse a message for multiple card references.
 * Handles: "close X and Y", "put X, Y into done", "mark X and Y as done"
 *
 * @param {string} message - User message
 * @returns {string[]} Array of card title fragments
 * @private
 */
_parseMultipleCards(message) {
  // Remove the action prefix
  const cleaned = message
    .replace(/(?:close|finish|complete|done|mark\s+as\s+done|put\s+into?\s+done|move\s+to\s+done)\s*[:\-]?\s*/i, '')
    .replace(/^["']|["']$/g, '');

  // Split on " and ", ", ", " & "
  return cleaned
    .split(/\s+(?:and|&)\s+|,\s+/)
    .map(s => s.replace(/^["']+|["']+$/g, '').trim())
    .filter(s => s.length > 0);
}

/**
 * Find a card by title fragment across all stacks.
 *
 * @param {Object} allCards - Output of deckClient.getAllCards()
 * @param {string} titleFragment - Card title to search for
 * @returns {{card: Object, stack: string}|null}
 * @private
 */
_findCardByTitle(allCards, titleFragment) {
  const lowerTitle = titleFragment.toLowerCase();
  for (const [stack, cards] of Object.entries(allCards)) {
    for (const card of cards) {
      if (card.title.toLowerCase().includes(lowerTitle)) {
        return { card, stack };
      }
    }
  }
  return null;
}
```

**Enhanced `_handleDeck()` logic:**

```javascript
async _handleDeck(message, context) {
  if (!this.deckClient) {
    return { response: 'Task board is not configured yet.', intent: 'deck', error: true };
  }

  const lower = message.toLowerCase();

  try {
    await this.deckClient.ensureBoard();

    // 1. Close/complete/done patterns
    if (/(?:close|finish|complete|mark\s+as\s+done|put\s+into?\s+done|move\s+to\s+done)\b/i.test(lower)) {
      const titles = this._parseMultipleCards(message);
      if (titles.length === 0) {
        return { response: 'Which card(s) should I close? Please specify the title.', intent: 'deck' };
      }
      return await this._handleDeckClose(titles, context);
    }

    // 2. Move-to-stack patterns
    const moveMatch = message.match(/(?:move|put|shift)\s+["']?(.+?)["']?\s+(?:to|into)\s+(inbox|queued|working|review|done)\b/i);
    if (moveMatch) {
      const title = moveMatch[1].trim();
      const targetStack = moveMatch[2].toLowerCase();
      return await this._handleDeckMove([title], targetStack, context);
    }

    // 3. Reconfirm/verify patterns
    if (/(?:reconfirm|verify|check\s+if|is\s+.+\s+(?:done|closed|completed))/i.test(lower)) {
      return await this._handleDeckVerify(message, context);
    }

    // 4. Add/create task
    const addMatch = message.match(/(?:add|create|new)\s+task[:\s]+(.+)/i);
    if (addMatch) {
      const title = addMatch[1].trim();
      const card = await this.deckClient.createCard('inbox', { title });
      await this.auditLog('deck_task_created', { user: context.user, title, cardId: card.id });
      return { response: `Created task in Inbox: "${title}" (card #${card.id})`, intent: 'deck' };
    }

    // 5. Start/work on patterns
    if (/(?:start|begin|work\s+on)\b/i.test(lower)) {
      const titlePart = message.replace(/(?:start|begin|work\s+on)\s*/i, '').trim();
      return await this._handleDeckMove([titlePart], 'working', context);
    }

    // 6. Default: list/show tasks (existing functionality, preserved)
    return await this._handleDeckList(message, lower, context);
  } catch (e) {
    console.error('[MessageRouter] Deck handler failed:', e.message);
    return { response: `Task board error: ${e.message}`, intent: 'deck', error: true };
  }
}
```

**New private methods for deck operations:**

```javascript
/**
 * Close/complete one or more cards (move to Done).
 * @private
 */
async _handleDeckClose(titles, context) {
  const allCards = await this.deckClient.getAllCards();
  const results = [];

  for (const title of titles) {
    const found = this._findCardByTitle(allCards, title);
    if (!found) {
      results.push(`Could not find card matching "${title}"`);
      continue;
    }
    if (found.stack === 'done') {
      results.push(`"${found.card.title}" (card #${found.card.id}) is already in Done`);
      continue;
    }
    try {
      await this.deckClient.moveCard(found.card.id, found.stack, 'done');
      results.push(`Moved "${found.card.title}" (card #${found.card.id}) to Done`);
      await this.auditLog('deck_card_closed', {
        user: context.user, cardId: found.card.id, title: found.card.title, fromStack: found.stack
      });
    } catch (err) {
      results.push(`Failed to move "${found.card.title}": ${err.message}`);
    }
  }

  return { response: results.join('\n'), intent: 'deck' };
}

/**
 * Move one or more cards to a target stack.
 * @private
 */
async _handleDeckMove(titles, targetStack, context) {
  const allCards = await this.deckClient.getAllCards();
  const results = [];

  for (const title of titles) {
    const found = this._findCardByTitle(allCards, title);
    if (!found) {
      results.push(`Could not find card matching "${title}"`);
      continue;
    }
    if (found.stack === targetStack) {
      results.push(`"${found.card.title}" is already in ${targetStack}`);
      continue;
    }
    try {
      await this.deckClient.moveCard(found.card.id, found.stack, targetStack);
      results.push(`Moved "${found.card.title}" (card #${found.card.id}) from ${found.stack} to ${targetStack}`);
      await this.auditLog('deck_card_moved', {
        user: context.user, cardId: found.card.id, title: found.card.title,
        fromStack: found.stack, toStack: targetStack
      });
    } catch (err) {
      results.push(`Failed to move "${found.card.title}": ${err.message}`);
    }
  }

  return { response: results.join('\n'), intent: 'deck' };
}

/**
 * Verify/reconfirm card status.
 * @private
 */
async _handleDeckVerify(message, context) {
  const allCards = await this.deckClient.getAllCards();
  // Extract card title from message
  const cleaned = message.replace(/(?:reconfirm|verify|check\s+if|is|are)\s*/i, '')
    .replace(/\s+(?:done|closed|completed|in\s+done|marked\s+as\s+done)\s*/i, '')
    .replace(/^["']|["']$/g, '').trim();

  const titles = cleaned.split(/\s+(?:and|&)\s+|,\s+/)
    .map(s => s.replace(/^["']+|["']+$/g, '').trim())
    .filter(s => s.length > 0);

  const results = [];
  for (const title of titles) {
    const found = this._findCardByTitle(allCards, title);
    if (!found) {
      results.push(`Could not find card matching "${title}"`);
    } else {
      const stackLabel = found.stack.charAt(0).toUpperCase() + found.stack.slice(1);
      results.push(`"${found.card.title}" (card #${found.card.id}) is in ${stackLabel}`);
    }
  }

  return { response: results.join('\n'), intent: 'deck' };
}

/**
 * List/show task board summary (existing functionality, extracted).
 * @private
 */
async _handleDeckList(message, lower, context) {
  const summary = await this.deckClient.getWorkloadSummary();

  const lines = ['**Task Board Summary:**\n'];
  const stacks = [
    ['Inbox', summary.inbox],
    ['Queued', summary.queued],
    ['Working', summary.working],
    ['Review', summary.review],
    ['Done', summary.done]
  ];
  for (const [name, count] of stacks) {
    if (count > 0) lines.push(`- **${name}:** ${count}`);
  }
  if (summary.total === 0) {
    lines.push('No tasks on the board.');
  } else {
    lines.push(`\n**Total:** ${summary.total}`);
  }

  // If asking specifically about open/pending, show card titles
  if (lower.includes('what tasks') || lower.includes('open tasks') ||
      lower.includes('show tasks') || lower.includes('list tasks') ||
      lower.includes('due')) {
    const active = await this.deckClient.getAllCards();
    const openCards = [
      ...(active.inbox || []),
      ...(active.queued || []),
      ...(active.working || [])
    ];
    if (openCards.length > 0) {
      lines.push('\n**Open tasks:**');
      for (const card of openCards.slice(0, 10)) {
        const stackLabel = Object.entries(active)
          .find(([, cards]) => cards.some(c => c.id === card.id))?.[0] || '';
        lines.push(`- ${card.title}${stackLabel ? ` (${stackLabel})` : ''}`);
      }
      if (openCards.length > 10) {
        lines.push(`_...and ${openCards.length - 10} more_`);
      }
    }
  }

  await this.auditLog('deck_query', { user: context.user, total: summary.total });
  return { response: lines.join('\n'), intent: 'deck' };
}
```

#### 3.4.5 Inject Conversation History into `_handleGeneral()`

**Location:** `_handleGeneral()` at line 762.

**Current (lines 770-786):**
```javascript
// Load agent memory context
let contextBlock = '';
if (this.contextLoader) {
  try {
    const ctx = await this.contextLoader.loadContext();
    if (ctx) contextBlock = ctx + '\n\n';
  } catch (e) {
    console.error('[MessageRouter] Context load failed:', e.message);
  }
}

const startTime = Date.now();
const result = await this.llmRouter.route({
  task: 'chat',
  content: contextBlock + message,
  requirements: { role: 'free' }
});
```

**After:**
```javascript
// Load agent memory context
let contextBlock = '';
if (this.contextLoader) {
  try {
    const ctx = await this.contextLoader.loadContext();
    if (ctx) contextBlock = ctx + '\n\n';
  } catch (e) {
    console.error('[MessageRouter] Context load failed:', e.message);
  }
}

// Add conversation history if available
let conversationBlock = '';
if (context.history && context.history.length > 0 && this.conversationContext) {
  conversationBlock = this.conversationContext.formatForPrompt(context.history);
  if (conversationBlock) conversationBlock += '\n\n';
}

const startTime = Date.now();
const result = await this.llmRouter.route({
  task: 'chat',
  content: contextBlock + conversationBlock + message,
  requirements: { role: 'free' }
});
```

#### 3.4.6 Add `conversationContext` to Constructor Options

**Location:** Constructor at line 111.

**Add to the options type and constructor:**
```javascript
this.conversationContext = options.conversationContext || null;
```

---

### 3.5 MODIFY: `src/lib/server/message-processor.js` -- Inject ConversationContext

**Location:** `process()` method at line 121.

**Current flow (lines 144-164):**
```javascript
let response;
let result;

if (extracted.content.startsWith('/')) {
  result = await this.commandHandler.handle(extracted.content, { ... });
  response = result.response;
} else {
  result = await this.messageRouter.route(extracted.content, {
    user: extracted.user,
    token: extracted.token,
    messageId: extracted.messageId
  });
  response = result.response || '...';
}
```

**After:**
```javascript
let response;
let result;

if (extracted.content.startsWith('/')) {
  result = await this.commandHandler.handle(extracted.content, { ... });
  response = result.response;
} else {
  // Fetch conversation history if ConversationContext is available
  let history = [];
  if (this.conversationContext && extracted.token) {
    try {
      history = await this.conversationContext.getHistory(extracted.token, {
        excludeMessageId: extracted.messageId
      });
    } catch (err) {
      console.warn('[Message] Conversation context fetch failed:', err.message);
    }
  }

  result = await this.messageRouter.route(extracted.content, {
    user: extracted.user,
    token: extracted.token,
    messageId: extracted.messageId,
    history
  });
  response = result.response || '...';
}
```

**Add to constructor (line 85-109):**
```javascript
/** @type {Object|null} */
this.conversationContext = deps.conversationContext || null;
```

**Add to ProcessorDependencies typedef (line 42):**
```javascript
 * @property {Object} [conversationContext] - ConversationContext instance
```

---

### 3.6 MODIFY: `src/lib/server/index.js` -- Wire ConversationContext

**Location:** `createServerComponents()` function at line 70.

**Add `conversationContext` to deps destructuring (line 71):**
```javascript
const {
  signatureVerifier,
  messageRouter,
  llmRouter,
  ncRequestManager,
  sendTalkReply,
  auditLog,
  botUsername,
  allowedBackends,
  onTokenDiscovered,
  conversationContext   // <-- ADD
} = deps;
```

**Pass to MessageProcessor constructor (line 93-100):**
```javascript
const messageProcessor = new MessageProcessor({
  messageRouter,
  commandHandler,
  sendTalkReply,
  auditLog,
  botUsername,
  onTokenDiscovered,
  conversationContext   // <-- ADD
});
```

**Update ServerDependencies typedef (line 49):**
```javascript
 * @property {Object} [conversationContext] - ConversationContext instance
```

---

### 3.7 MODIFY: `src/bot.js` -- Instantiate ConversationContext

**Location:** After NCRequestManager initialization (around line 158).

**Add after line 158 ("NC Request Manager ready for notifications"):**

```javascript
// Initialize Conversation Context (for Talk chat history in LLM prompts)
const { ConversationContext } = require('./lib/talk/conversation-context');
const conversationContext = new ConversationContext(
  appConfig.talk.conversationContext,
  ncRequestManager
);
console.log('[INIT] Conversation Context ready');
```

**Also wire it into HeartbeatManager config (if needed for future use)
and into any server components.** The bot.js file does NOT currently
create server components directly (those are in webhook-server.js), but
if there is a webhook-server.js that calls `createServerComponents()`,
we need to pass `conversationContext` there too.

Let me check for webhook-server.js.

**Additional wiring in bot.js:** Pass `conversationContext` to the
MessageRouter that is used by the HeartbeatManager's message processing,
if any. Looking at the code, HeartbeatManager does NOT use MessageRouter
directly -- it processes deck tasks via DeckTaskProcessor and does not
handle Talk messages. Talk message handling goes through the webhook
server pipeline:

```
webhook-server.js -> WebhookHandler -> MessageProcessor -> MessageRouter
```

So we need to check webhook-server.js for where `createServerComponents`
is called and pass `conversationContext` through.

---

### 3.8 MODIFY: `webhook-server.js` (if it exists) -- Pass ConversationContext

Need to find and check this file.

**After checking:** The webhook server is at `src/lib/server/index.js` which
exports `createServerComponents`. The actual HTTP server that calls it
needs to be found. Let me check for `webhook-server.js` in the project root.

If it exists, we need to add `conversationContext` as a dependency passed
to `createServerComponents()`.

If it does NOT exist (server setup is done elsewhere), then bot.js must
be modified to create and pass the ConversationContext to the MessageRouter.

**Key finding from bot.js analysis:** bot.js does NOT set up a webhook
server or create a MessageRouter. It only creates HeartbeatManager. The
webhook server must be a separate process or file.

**For this session,** the ConversationContext needs to be wired wherever
`createServerComponents()` or `new MessageRouter()` is called. The
Implementer should:
1. Search for all call sites of `createServerComponents()`
2. Search for all instantiations of `new MessageRouter()`
3. Pass `conversationContext` to each

---

### 3.9 MODIFY: `src/lib/llm/providers/base-provider.js` -- Add 'chat' Task Prompt

**Location:** `buildPrompt()` method at line 118.

**Current task prompts (lines 121-166):**
The `taskPrompts` object has entries for 'research', 'writing', 'admin',
'classify', 'followup', 'heartbeat_scan', 'generic'. There is NO 'chat'
entry.

The MessageRouter calls `llmRouter.route({task: 'chat', ...})` which
reaches `provider.generate('chat', content)` which calls
`this.buildPrompt('chat', content)`. Since there is no 'chat' entry,
it falls through to `taskPrompts.generic` which is just
`${identity}\n\nTask: ${content}`.

**Add a 'chat' task prompt** that includes conversation-friendly framing:

```javascript
chat: `${identity}

## Current Conversation

The user is chatting with you in Nextcloud Talk. Respond naturally and helpfully.
If the conversation includes history from previous messages, use it to maintain context.
If the user references something discussed earlier, resolve the reference using the conversation history.

${content}`,
```

This is a minor improvement -- the main impact comes from the enhanced
system prompt content and the conversation history being prepended to
`content` by the MessageRouter.

---

### 3.10 NEW: `test/unit/talk/conversation-context.test.js` (~200 lines)

**Purpose:** Unit tests for ConversationContext.

**Framework:** Uses `test/helpers/test-runner.js` and `require('assert')`.

**Test structure:**
```
- require assert, test-runner
- Create helper functions for mocking NC request manager
- Section: Constructor Tests
- Section: getHistory Tests
- Section: _formatMessages Tests
- Section: formatForPrompt Tests
- Section: Error Handling Tests
- Summary + exitWithCode
```

**Test cases:**

| ID | Test |
|---|---|
| TC-CC-001 | Constructor stores config and nc reference |
| TC-CC-002 | Returns empty array when disabled |
| TC-CC-010 | getHistory calls Talk API with correct URL |
| TC-CC-011 | getHistory returns chronological messages |
| TC-CC-012 | getHistory filters system messages |
| TC-CC-013 | getHistory excludes specified message ID |
| TC-CC-014 | getHistory filters messages older than maxAge |
| TC-CC-015 | getHistory trims to token budget (keeps most recent) |
| TC-CC-016 | getHistory maps actorId to role correctly |
| TC-CC-020 | formatForPrompt produces conversation_history block |
| TC-CC-021 | formatForPrompt returns empty string for empty history |
| TC-CC-022 | formatForPrompt returns empty string for null |
| TC-CC-030 | getHistory returns empty array on API error |
| TC-CC-031 | getHistory returns empty array on malformed response |

**Mock factory function to add (can be inline in test file):**

```javascript
function createMockNC(messages = []) {
  return {
    ncUrl: 'https://cloud.example.com',
    ncUser: 'moltagent',
    request: async (path, options) => ({
      status: 200,
      body: {
        ocs: {
          data: messages
        }
      }
    })
  };
}
```

---

### 3.11 NEW: `test/unit/handlers/message-router-deck.test.js` (~250 lines)

**Purpose:** Tests for the enhanced deck action handling in MessageRouter.

**Test cases:**

| ID | Test |
|---|---|
| TC-DECK-001 | classifyIntent returns 'deck' for "close X" |
| TC-DECK-002 | classifyIntent returns 'deck' for "put X into done" |
| TC-DECK-003 | classifyIntent returns 'deck' for "mark as done: X" |
| TC-DECK-004 | classifyIntent returns 'deck' for "reconfirm if X is done" |
| TC-DECK-005 | classifyIntent returns 'deck' for "move X to working" |
| TC-DECK-006 | classifyIntent returns 'deck' for "finish X and Y" |
| TC-DECK-007 | classifyIntent returns 'deck' for "complete X" |
| TC-DECK-010 | _parseMultipleCards splits "X and Y" |
| TC-DECK-011 | _parseMultipleCards splits "X, Y, Z" |
| TC-DECK-012 | _parseMultipleCards handles quoted titles |
| TC-DECK-013 | _parseMultipleCards handles single title |
| TC-DECK-020 | _findCardByTitle finds card by partial title |
| TC-DECK-021 | _findCardByTitle returns null for no match |
| TC-DECK-022 | _findCardByTitle is case insensitive |
| TC-DECK-030 | _handleDeckClose moves card to done |
| TC-DECK-031 | _handleDeckClose handles multiple cards |
| TC-DECK-032 | _handleDeckClose reports already-done cards |
| TC-DECK-033 | _handleDeckClose reports not-found cards |
| TC-DECK-040 | _handleDeckVerify reports card stack correctly |
| TC-DECK-050 | classifyIntent with history resolves "close it" to deck |

**Mock DeckClient for tests:**

```javascript
function createMockDeckClient(allCards = {}) {
  return {
    ensureBoard: async () => ({ boardId: 1, stacks: {} }),
    getAllCards: async () => allCards,
    getCardsInStack: async (stack) => allCards[stack] || [],
    moveCard: async (cardId, from, to) => {},
    createCard: async (stack, data) => ({ id: 999, title: data.title }),
    getWorkloadSummary: async () => {
      const summary = { inbox: 0, queued: 0, working: 0, review: 0, done: 0, total: 0 };
      for (const [stack, cards] of Object.entries(allCards)) {
        summary[stack] = cards.length;
        summary.total += cards.length;
      }
      return summary;
    }
  };
}
```

---

## 4. Directory Structure

### New Files to Create

```
/opt/moltagent/
  src/
    lib/
      talk/                              <-- NEW directory
        conversation-context.js          <-- NEW (Module 1)
  test/
    unit/
      talk/                              <-- NEW directory
        conversation-context.test.js     <-- NEW
      handlers/
        message-router-deck.test.js      <-- NEW
```

### Existing Files to Modify

```
/opt/moltagent/
  config/
    system-prompt.md                     <-- REPLACE contents
  src/
    lib/
      config.js                          <-- ADD talk.conversationContext section
      handlers/
        message-router.js               <-- MAJOR: enhanced deck handling, history support
      server/
        message-processor.js             <-- ADD ConversationContext integration
        index.js                         <-- ADD conversationContext to deps
      llm/
        providers/
          base-provider.js               <-- ADD 'chat' task prompt
  src/
    bot.js                              <-- ADD ConversationContext instantiation
```

---

## 5. Dependency Map and Implementation Order

```
Level 0 (no dependencies, can build first):
  config/system-prompt.md               -- Just content, no code
  src/lib/config.js                     -- Add config section

Level 1 (depends on config + NCRequestManager):
  src/lib/talk/conversation-context.js  -- New module, depends only on config + nc

Level 2 (depends on Level 1):
  test/unit/talk/conversation-context.test.js  -- Tests for Level 1

Level 3 (depends on existing MessageRouter + DeckClient):
  src/lib/handlers/message-router.js    -- Enhanced deck handling + history support

Level 4 (depends on Level 3):
  test/unit/handlers/message-router-deck.test.js  -- Tests for Level 3

Level 5 (wiring, depends on Level 1 + Level 3):
  src/lib/server/message-processor.js   -- Add ConversationContext integration
  src/lib/server/index.js               -- Pass through deps
  src/bot.js                            -- Instantiate ConversationContext
  src/lib/llm/providers/base-provider.js -- Add 'chat' task prompt
```

**Recommended implementation order:**

```
1. config/system-prompt.md               -- Quick win, immediate impact
2. src/lib/config.js                     -- Add config section (trivial)
3. src/lib/talk/conversation-context.js  -- New module
4. test/unit/talk/conversation-context.test.js  -- Verify module
5. src/lib/handlers/message-router.js    -- Enhanced deck + history
6. test/unit/handlers/message-router-deck.test.js  -- Verify changes
7. src/lib/llm/providers/base-provider.js  -- Add 'chat' prompt
8. src/lib/server/message-processor.js   -- Wire ConversationContext
9. src/lib/server/index.js               -- Pass through
10. src/bot.js                           -- Instantiate
11. Run all tests: npm test
12. Run lint: npm run lint
```

---

## 6. Test Plan

### Unit Tests

| Module | Test File | Test Count |
|---|---|---|
| ConversationContext | `test/unit/talk/conversation-context.test.js` | ~14 |
| MessageRouter (deck) | `test/unit/handlers/message-router-deck.test.js` | ~18 |
| **Total new tests** | | **~32** |

### Existing Tests That Must Continue to Pass

| Test File | What It Tests |
|---|---|
| `test/unit/handlers/message-router.test.js` | Existing routing (calendar, email, general, skillforge, confirm) |
| `test/unit/server/message-processor.test.js` | Message extraction, bot filtering |
| `test/unit/server/command-handler.test.js` | Slash commands |
| All other existing tests | Must not be broken by changes |

### Regression Risks

1. **classifyIntent changes:** Adding deck action patterns BEFORE score-based
   classification means some messages that previously routed to 'email' or
   'general' may now route to 'deck'. This is intentional -- "close X" should
   be a deck action, not a general LLM query.

2. **MessageProcessor constructor change:** Adding `conversationContext` as
   an optional dependency. Existing code that does not pass it will get
   `null`, which is handled by the `if (this.conversationContext)` guard.

3. **MessageRouter constructor change:** Adding `conversationContext` as
   optional. Same null-safety pattern.

4. **classifyIntent signature change:** Adding optional `history` parameter.
   Existing callers pass one argument, which means `history` will be
   `undefined`. The code checks `if (history && history.length > 0)`, so
   this is safe.

### Validation Checklist

- [ ] `npm test` passes (all existing + new tests)
- [ ] `npm run lint` passes
- [ ] ConversationContext fetches messages from Talk API correctly
- [ ] ConversationContext returns `[]` on error (graceful degradation)
- [ ] "close X and Y" classifies as deck intent
- [ ] "put X into done" classifies as deck intent
- [ ] "reconfirm if X is done" classifies as deck intent
- [ ] Multi-card parsing works ("X and Y", "X, Y")
- [ ] Card close actually calls deckClient.moveCard()
- [ ] Response includes card ID and stack name (factual, not hallucinated)
- [ ] Conversation history injected into LLM calls for general messages
- [ ] System prompt expanded with tool-use instructions
- [ ] Existing calendar routing still works
- [ ] Existing email routing still works
- [ ] Existing skill forge routing still works
- [ ] Existing confirmation flow still works

---

## 7. Key Architectural Decisions

### AD1: Conversation History as Text Block, Not Messages Array

The LLM providers use a single `prompt` string (Ollama API, buildPrompt).
Conversation history is formatted as a `<conversation_history>` XML-tagged
text block prepended to the content. This is compatible with the existing
architecture without requiring changes to the provider layer.

### AD2: Deck Action Patterns Before Score-Based Classification

Deck action patterns (close, move, complete) are checked BEFORE the
keyword-scoring classification. This prevents "close my inbox tasks"
from being classified as 'email' (because "inbox" is an email keyword).
The action verb is the strongest signal.

### AD3: ConversationContext in MessageProcessor, Not MessageRouter

The ConversationContext fetch happens in MessageProcessor because:
- It has access to the room token and message ID
- It runs once per message (not once per route attempt)
- It keeps the MessageRouter focused on routing logic
- The history is passed as part of the context object

### AD4: Factual Responses for Tool Actions

When the user says "close X", the response is the actual result of the
`moveCard()` call: `Moved "X" (card #47) to Done` -- not an LLM-generated
confirmation. The LLM is only involved for conversational (non-action) messages.

### AD5: Graceful Degradation

ConversationContext errors return `[]` (empty history). The bot continues
to work exactly as before if Talk history fetch fails. This is an
enhancement layer, not a critical dependency.

---

## 8. Notes for Implementer

### Watch Out For

1. **NCRequestManager.request() path format:** Pass the full path starting
   with `/ocs/v2.php/...`. Do NOT include the NC base URL -- NCRequestManager
   prepends `this.ncUrl`.

2. **Frozen config:** `src/lib/config.js` deep-freezes the config object.
   The `talk.conversationContext` section must be added within the config
   object literal BEFORE the `deepFreeze()` call at line 421.

3. **Talk API message order:** The NC Talk API returns messages in REVERSE
   chronological order (newest first). `_formatMessages()` must `.reverse()`
   the array to get chronological order.

4. **Test runner:** Use `require('../../helpers/test-runner')` with
   `{ test, asyncTest, summary, exitWithCode }`. Do NOT use Jest.
   Mock objects are plain objects with async functions, not `jest.fn()`.

5. **DeckClient.moveCard signature:** `moveCard(cardId, fromStack, toStack, order)`
   where stacks are key names like 'inbox', 'done'. The client resolves
   IDs internally via `_getIds()`.

6. **Message ID types:** The `excludeMessageId` in Talk API context is a
   numeric message ID. The webhook payload provides it as `data.object?.id`
   or `data.object?.message?.id`. Compare with `===` (both should be numbers,
   but use loose comparison `!=` as safety).

7. **Existing _handleDeck code:** The current `_handleDeck()` (lines 463-538)
   must be REPLACED, not appended to. The new version preserves the
   add-task and list-tasks functionality while adding move/close/verify.

8. **webhook-server.js location:** Search for this file. It is likely in
   the project root or in `src/`. It calls `createServerComponents()` and
   needs to receive and pass `conversationContext`.

### Files to Search For (Implementer Should Verify)

- `webhook-server.js` -- main webhook server, must wire ConversationContext
- Any other file that calls `new MessageRouter()`
- Any other file that calls `createServerComponents()`
- Any other file that calls `llmRouter.route()` with task='chat'

### Quick Test Commands

```bash
# Run all tests
npm test

# Run specific test files
node test/unit/talk/conversation-context.test.js
node test/unit/handlers/message-router-deck.test.js
node test/unit/handlers/message-router.test.js

# Lint
npm run lint
```
