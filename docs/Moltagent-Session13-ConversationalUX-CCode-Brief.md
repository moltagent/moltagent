# Moltagent Session 13: Conversational UX Fix — Claude Code Brief

**Date:** 2026-02-08  
**Author:** Fu + Claude Opus (architecture)  
**Executor:** Claude Code  
**Estimated CCode time:** ~3 hours  
**Dependencies:** Sessions 1-12 complete. TalkClient, HeartbeatManager, DeckClient, MessageRouter must exist.  
**Priority:** CRITICAL — This session fixes the #1 user-facing issue. Without it, Moltagent feels broken in conversation.

---

## Problem Statement

Real conversation with Moltagent (captured 2026-02-08):

```
User: "Do I have open tasks that are due next week?"
Molti: [Lists 4 open tasks correctly]

User: "Which is the one in inbox?"
Molti: "📭 The mailbox is empty!"   ← WRONG: confused Deck inbox with email

User: "close/put into done: 'Are there black tigers' and 'Evaluate Superdesign.dev'"
Molti: "Okay, I've put them into Done"   ← LIE: didn't actually move cards

User: "reconfirm please if they are marked as done"
Molti: "I need more information..."   ← AMNESIA: forgot the entire exchange

User: "'Are there black tigers?' and 'Evaluate Superdesign.dev' — they are on YOUR deck"
Molti: [Answers "Are there black tigers?" as a knowledge question, evaluates Superdesign.dev as a website, explains Kanban boards]   ← TOTAL FAILURE: treats card titles as questions
```

**Root causes:**

1. **No conversation history** — each message hits the LLM as a fresh, isolated prompt with zero context from the previous exchange
2. **No system prompt identity** — the LLM doesn't know it's Moltagent, doesn't know what tools it has, doesn't know how to use them
3. **Hallucinated actions** — the LLM says "I did it" without actually calling DeckClient
4. **Message router too shallow** — "close X and Y" doesn't classify as a deck action

---

## What To Build

Three modules, built in order:

| # | File | What It Does |
|---|------|-------------|
| 1 | `src/lib/talk/conversation-context.js` | Fetches Talk message history, formats as conversation context for LLM |
| 2 | `config/system-prompt.md` (or equivalent) | Identity, capabilities, tool-use instructions, behavioral rules |
| 3 | Modifications to message router + handlers | Action-result responses, better intent classification |

Plus tests for each.

---

## Module 1: ConversationContext

### Purpose

Fetch the last N messages from the NC Talk room and format them as conversation history that gets injected into the LLM prompt. This single change fixes the amnesia problem — the LLM will see what was just discussed and can follow multi-turn conversations.

### NC Talk Chat API

```
GET /ocs/v2.php/apps/spreed/api/v1/chat/{token}
Headers: OCS-APIRequest: true, Accept: application/json
Auth: Basic (moltagent user)
Query params:
  lookIntoFuture=0     — get past messages (not polling for new ones)
  limit=20             — last 20 messages
  includeLastKnown=0   — don't duplicate the trigger message

Response shape:
{
  "ocs": {
    "data": [
      {
        "id": 12345,
        "actorType": "users",
        "actorId": "funana",
        "actorDisplayName": "Funana",
        "message": "Do I have open tasks?",
        "timestamp": 1707350400,
        "messageType": "comment",
        "systemMessage": ""
      },
      {
        "id": 12346,
        "actorType": "users",
        "actorId": "moltagent",
        "actorDisplayName": "Moltagent",
        "message": "Task Board Summary:\nInbox: 1\nWorking: 3...",
        "timestamp": 1707350410,
        "messageType": "comment",
        "systemMessage": ""
      }
    ]
  }
}

Notes:
- Messages come in REVERSE chronological order (newest first)
- systemMessage != "" means it's a system event (user joined, etc.) — skip these
- actorType "bots" or "users" — both are relevant
- The trigger message (the one being responded to) may or may not be in this list
```

### Config

```javascript
{
  talk: {
    // ... existing Talk config
    conversationContext: {
      enabled: true,
      maxMessages: 20,        // Fetch last 20 messages
      maxTokenEstimate: 2000, // Trim if conversation context exceeds ~2000 tokens
      includeSystemMessages: false,  // Skip "user joined" etc.
      maxMessageAge: 3600000, // Ignore messages older than 1 hour (stale context)
    }
  }
}
```

### Implementation

```javascript
// src/lib/talk/conversation-context.js

'use strict';

class ConversationContext {
  /**
   * @param {Object} config - talk.conversationContext config section
   * @param {Object} ncRequestManager - NCRequestManager instance
   * @param {Object} [logger]
   */
  constructor(config, ncRequestManager, logger) {
    this.config = config;
    this.nc = ncRequestManager;
    this.logger = logger || console;
    this.enabled = config?.enabled !== false;
  }

  /**
   * Fetch recent conversation history from a Talk room.
   * 
   * @param {string} roomToken - NC Talk room token
   * @param {Object} [options]
   * @param {number} [options.limit] - Max messages to fetch (default: config.maxMessages)
   * @param {number} [options.excludeMessageId] - Skip this message ID (the trigger message)
   * @returns {Promise<Array<{role: string, name: string, content: string, timestamp: number}>>}
   */
  async getHistory(roomToken, options = {}) {
    if (!this.enabled) return [];

    const limit = options.limit || this.config.maxMessages || 20;

    try {
      const response = await this.nc.request(
        `/ocs/v2.php/apps/spreed/api/v1/chat/${roomToken}?lookIntoFuture=0&limit=${limit}&includeLastKnown=0`,
        {
          method: 'GET',
          headers: {
            'Accept': 'application/json',
            'OCS-APIRequest': 'true'
          },
          endpointGroup: 'talk',
          cacheTtlMs: 0  // Never cache conversation history
        }
      );

      let data;
      if (typeof response.json === 'function') {
        data = await response.json();
      } else {
        data = response;
      }

      const messages = data?.ocs?.data || [];
      return this._formatMessages(messages, options.excludeMessageId);
    } catch (err) {
      this.logger.error('[ConversationContext] Failed to fetch history:', err.message);
      return [];  // Graceful degradation — proceed without history
    }
  }

  /**
   * Format raw Talk messages into conversation history.
   * Filters, sorts chronologically, trims to token budget.
   * 
   * @param {Array} rawMessages - Raw messages from Talk API
   * @param {number} [excludeId] - Message ID to exclude
   * @returns {Array<{role: string, name: string, content: string, timestamp: number}>}
   * @private
   */
  _formatMessages(rawMessages, excludeId) {
    const now = Date.now();
    const maxAge = this.config.maxMessageAge || 3600000;
    const ncUser = this.nc.config?.nextcloud?.user || 'moltagent';

    let messages = rawMessages
      // Filter out system messages (joins, leaves, etc.)
      .filter(m => !m.systemMessage || m.systemMessage === '')
      // Filter out the trigger message if specified
      .filter(m => !excludeId || m.id !== excludeId)
      // Filter out messages that are too old
      .filter(m => (now - m.timestamp * 1000) < maxAge)
      // Sort chronologically (Talk API returns newest-first)
      .reverse()
      // Map to conversation format
      .map(m => ({
        role: m.actorId === ncUser ? 'assistant' : 'user',
        name: m.actorDisplayName || m.actorId,
        content: m.message,
        timestamp: m.timestamp
      }));

    // Trim to token budget (rough estimate: 1 token ≈ 4 chars)
    const maxChars = (this.config.maxTokenEstimate || 2000) * 4;
    let totalChars = 0;
    const trimmed = [];

    // Keep most recent messages within budget (iterate from end)
    for (let i = messages.length - 1; i >= 0; i--) {
      const msgChars = messages[i].content.length + messages[i].name.length + 10;
      if (totalChars + msgChars > maxChars) break;
      totalChars += msgChars;
      trimmed.unshift(messages[i]);
    }

    return trimmed;
  }

  /**
   * Format conversation history as a string for LLM prompt injection.
   * 
   * @param {Array} history - Output from getHistory()
   * @returns {string} Formatted conversation context
   */
  formatForPrompt(history) {
    if (!history || history.length === 0) return '';

    const lines = history.map(m => {
      const role = m.role === 'assistant' ? 'Moltagent' : m.name;
      return `${role}: ${m.content}`;
    });

    return `<conversation_history>\n${lines.join('\n\n')}\n</conversation_history>`;
  }
}

module.exports = { ConversationContext };
```

### Tests

```javascript
// test/unit/talk/conversation-context.test.js

'use strict';

const { ConversationContext } = require('../../../src/lib/talk/conversation-context');

function createMockNC(messages = []) {
  return {
    config: { nextcloud: { user: 'moltagent' } },
    request: jest.fn().mockResolvedValue({
      ocs: {
        data: messages
      }
    })
  };
}

function makeMessage(id, actorId, displayName, message, timestamp, systemMessage = '') {
  return {
    id,
    actorType: 'users',
    actorId,
    actorDisplayName: displayName,
    message,
    timestamp,
    messageType: 'comment',
    systemMessage
  };
}

describe('ConversationContext', () => {
  // DISABLED MODE
  test('returns empty array when disabled', async () => {
    const ctx = new ConversationContext({ enabled: false }, createMockNC());
    const result = await ctx.getHistory('room-token');
    expect(result).toEqual([]);
  });

  // BASIC HISTORY FETCH
  test('fetches and formats conversation history', async () => {
    const now = Math.floor(Date.now() / 1000);
    const nc = createMockNC([
      // Talk API returns newest-first
      makeMessage(3, 'moltagent', 'Moltagent', 'Task Board Summary:\nInbox: 1', now - 5),
      makeMessage(2, 'funana', 'Funana', 'Do I have open tasks?', now - 10),
      makeMessage(1, 'funana', 'Funana', 'Hello', now - 60),
    ]);

    const ctx = new ConversationContext({
      enabled: true,
      maxMessages: 20,
      maxTokenEstimate: 2000,
      maxMessageAge: 3600000
    }, nc);

    const history = await ctx.getHistory('room-abc');

    // Should be chronological (oldest first)
    expect(history).toHaveLength(3);
    expect(history[0].content).toBe('Hello');
    expect(history[0].role).toBe('user');
    expect(history[0].name).toBe('Funana');
    expect(history[1].content).toBe('Do I have open tasks?');
    expect(history[2].content).toContain('Task Board Summary');
    expect(history[2].role).toBe('assistant');
  });

  // FILTERS SYSTEM MESSAGES
  test('filters out system messages', async () => {
    const now = Math.floor(Date.now() / 1000);
    const nc = createMockNC([
      makeMessage(3, 'funana', 'Funana', 'Hello', now - 5),
      makeMessage(2, '', '', 'Funana joined the conversation', now - 10, 'user_added'),
      makeMessage(1, 'funana', 'Funana', 'Hey', now - 15),
    ]);

    const ctx = new ConversationContext({
      enabled: true, maxMessages: 20, maxTokenEstimate: 2000, maxMessageAge: 3600000
    }, nc);

    const history = await ctx.getHistory('room-abc');
    expect(history).toHaveLength(2);
    expect(history.every(m => m.content !== 'Funana joined the conversation')).toBe(true);
  });

  // EXCLUDES TRIGGER MESSAGE
  test('excludes specified message ID', async () => {
    const now = Math.floor(Date.now() / 1000);
    const nc = createMockNC([
      makeMessage(3, 'funana', 'Funana', 'This is the trigger', now - 5),
      makeMessage(2, 'moltagent', 'Moltagent', 'Previous response', now - 10),
    ]);

    const ctx = new ConversationContext({
      enabled: true, maxMessages: 20, maxTokenEstimate: 2000, maxMessageAge: 3600000
    }, nc);

    const history = await ctx.getHistory('room-abc', { excludeMessageId: 3 });
    expect(history).toHaveLength(1);
    expect(history[0].content).toBe('Previous response');
  });

  // FILTERS OLD MESSAGES
  test('filters messages older than maxMessageAge', async () => {
    const now = Math.floor(Date.now() / 1000);
    const nc = createMockNC([
      makeMessage(2, 'funana', 'Funana', 'Recent', now - 60),
      makeMessage(1, 'funana', 'Funana', 'Very old', now - 7200),  // 2 hours ago
    ]);

    const ctx = new ConversationContext({
      enabled: true, maxMessages: 20, maxTokenEstimate: 2000,
      maxMessageAge: 3600000  // 1 hour
    }, nc);

    const history = await ctx.getHistory('room-abc');
    expect(history).toHaveLength(1);
    expect(history[0].content).toBe('Recent');
  });

  // TOKEN BUDGET TRIMMING
  test('trims to token budget, keeping most recent', async () => {
    const now = Math.floor(Date.now() / 1000);
    const longMessage = 'A'.repeat(5000);  // ~1250 tokens
    const nc = createMockNC([
      makeMessage(3, 'funana', 'Funana', 'Most recent', now - 5),
      makeMessage(2, 'funana', 'Funana', longMessage, now - 10),
      makeMessage(1, 'funana', 'Funana', 'Oldest', now - 15),
    ]);

    const ctx = new ConversationContext({
      enabled: true, maxMessages: 20,
      maxTokenEstimate: 500,  // Very small budget
      maxMessageAge: 3600000
    }, nc);

    const history = await ctx.getHistory('room-abc');
    // Should keep most recent messages that fit
    expect(history.length).toBeLessThan(3);
    expect(history[history.length - 1].content).toBe('Most recent');
  });

  // FORMAT FOR PROMPT
  test('formats history as prompt string', () => {
    const ctx = new ConversationContext({ enabled: true }, createMockNC());

    const history = [
      { role: 'user', name: 'Funana', content: 'Do I have tasks?', timestamp: 100 },
      { role: 'assistant', name: 'Moltagent', content: 'Yes, 4 open tasks.', timestamp: 101 },
      { role: 'user', name: 'Funana', content: 'Close the first one', timestamp: 102 },
    ];

    const formatted = ctx.formatForPrompt(history);

    expect(formatted).toContain('<conversation_history>');
    expect(formatted).toContain('Funana: Do I have tasks?');
    expect(formatted).toContain('Moltagent: Yes, 4 open tasks.');
    expect(formatted).toContain('Funana: Close the first one');
    expect(formatted).toContain('</conversation_history>');
  });

  // EMPTY HISTORY
  test('formatForPrompt returns empty string for no history', () => {
    const ctx = new ConversationContext({ enabled: true }, createMockNC());
    expect(ctx.formatForPrompt([])).toBe('');
    expect(ctx.formatForPrompt(null)).toBe('');
  });

  // ERROR HANDLING
  test('returns empty array on API error', async () => {
    const nc = createMockNC();
    nc.request.mockRejectedValue(new Error('Network timeout'));

    const ctx = new ConversationContext({
      enabled: true, maxMessages: 20, maxTokenEstimate: 2000, maxMessageAge: 3600000
    }, nc);

    const history = await ctx.getHistory('room-abc');
    expect(history).toEqual([]);
  });

  // CORRECT API CALL
  test('calls Talk API with correct parameters', async () => {
    const nc = createMockNC([]);
    const ctx = new ConversationContext({
      enabled: true, maxMessages: 15, maxTokenEstimate: 2000, maxMessageAge: 3600000
    }, nc);

    await ctx.getHistory('room-xyz');

    expect(nc.request).toHaveBeenCalledWith(
      expect.stringContaining('/ocs/v2.php/apps/spreed/api/v1/chat/room-xyz'),
      expect.objectContaining({ method: 'GET' })
    );
    expect(nc.request.mock.calls[0][0]).toContain('limit=15');
    expect(nc.request.mock.calls[0][0]).toContain('lookIntoFuture=0');
  });
});
```

---

## Module 2: System Prompt

### Purpose

Define Moltagent's identity, capabilities, behavioral rules, and tool-use instructions. This is the foundation of every LLM interaction — without it, the LLM doesn't know what it is, what it can do, or how to use its tools.

### Where It Lives

Create `config/system-prompt.md` (or embed in the config object). The system prompt is loaded at startup and injected as the `system` field in every LLM call. It should NOT be stored in NC (that would be a security risk — memory poisoning could alter the system prompt). Keep it local on the Bot VM.

### Implementation: `config/system-prompt.md`

```markdown
# Moltagent System Prompt

You are Moltagent, a sovereign AI assistant that lives inside a Nextcloud workspace. You help your employer manage tasks, calendar, files, and communications through natural conversation.

## Your Identity

- Name: Moltagent
- You are a digital employee, not a chatbot
- You work inside Nextcloud — your home, your workspace, your filing system
- You have your own Deck board (task manager), calendar, and file storage
- You communicate through NC Talk (chat)

## Your Capabilities

You have access to these tools and must USE them when appropriate — never just describe what you would do:

### Deck (Task Management)
- **Read tasks**: List cards on your Deck board. Cards are organized in stacks: Inbox, Queued, Working, Done.
- **Move cards**: When asked to close, finish, complete, or mark as done → move the card to the Done stack. When asked to start or work on → move to Working.
- **Create cards**: When asked to add a task, create a reminder, or note something → create a card in Inbox.
- CRITICAL: When the user references a task by title, they mean a CARD on your Deck board. Do NOT treat card titles as questions to answer.

### Calendar (CalDAV)
- **Read events**: Check upcoming events, find free time, detect conflicts.
- **Create events**: Schedule meetings, create reminders.
- **Modify events**: Reschedule, cancel, update event details.

### Files (WebDAV)
- **Read files**: Access files in the Nextcloud workspace.
- **Write files**: Create and update files (audit logs, memory, etc.).

### System Tags
- **Tag files**: Mark files as pending, processed, needs-review, or ai-flagged.
- **Read tags**: Check what tags are on a file.

### Memory (Learning Log + Knowledge Board)
- You maintain a learning log and knowledge board.
- When you learn something new about the user or their preferences, note it.

### Skill Forge
- When asked to connect to a new service, start the Skill Forge conversation flow.

## Behavioral Rules

### ALWAYS DO:
1. **Use your tools.** When asked to move a task, actually call DeckClient.moveCard(). When asked to create an event, actually call CalDAVClient.createEvent(). NEVER just describe what you would do — DO IT.
2. **Confirm with real results.** After performing an action, report what actually happened: card ID, event UID, file path. Not "I've done it" but "✅ Moved 'Task Name' (card #47) to Done."
3. **Follow the conversation.** You can see the recent chat history. Use it. If the user said "the first one" — look at what you just listed and pick the first item.
4. **Ask for clarification** if the request is genuinely ambiguous. But try to resolve it yourself first using context.
5. **Be concise.** Short, direct answers. No fluff, no emoji spam, no markdown headers unless listing multiple items.

### NEVER DO:
1. **Never hallucinate actions.** If a tool call fails, say it failed. Don't pretend it succeeded.
2. **Never treat card titles as questions.** "Are there black tigers?" as a task title means a Deck card called that — don't answer the question.
3. **Never forget context.** The conversation history tells you what was just discussed. Use it.
4. **Never expose credentials.** If a credential appears in a response, redact it.
5. **Never execute destructive operations without confirmation.** Deleting files, clearing tasks — ask first.

## Response Style

- Direct and practical
- Use ✅ for confirmed actions, ❌ for failures, ⚠️ for warnings
- Lists only when showing multiple items
- No patronizing ("Great question!", "I'd be happy to help!")
- No unnecessary markdown formatting
- When uncertain, say so honestly

## Context Understanding

When a user message references something from the conversation history:
- "the one in inbox" → look at the most recently listed board state and find the inbox card
- "close those two" → look at the most recently mentioned items
- "the first one" → first item in the most recently presented list
- "do it" / "go ahead" → execute the most recently proposed action
- "that meeting" → the most recently discussed calendar event
```

### Loading the System Prompt

The system prompt should be loaded from file at startup and injected into every LLM call. 

**Find where the LLM is called** (likely in HeartbeatManager's escalation path, or in the MessageRouter/handler pipeline) and ensure the system prompt is passed as the `system` parameter.

```javascript
// In startup (bot.js or index.js):
const fs = require('fs');
const systemPrompt = fs.readFileSync(
  path.join(__dirname, 'config', 'system-prompt.md'),
  'utf-8'
);

// Store in config or pass to LLM router
config.systemPrompt = systemPrompt;
```

```javascript
// In LLM call (wherever generate() or chat() is called):
const response = await llmRouter.generate({
  system: config.systemPrompt,
  messages: [
    // Conversation history (from ConversationContext)
    ...conversationHistory.map(m => ({
      role: m.role,
      content: m.content
    })),
    // Current user message
    { role: 'user', content: currentMessage }
  ],
  // ... other params
});
```

**CRITICAL: Search the codebase for every place the LLM is called.** The system prompt must be injected in ALL of them, not just the main chat handler. Check:
- HeartbeatManager's escalation to external LLM
- MessageRouter's intent classification
- SkillForgeHandler's conversation turns
- Any direct Ollama/Claude API calls

---

## Module 3: Message Router & Handler Improvements

### 3.1 Intent Classification Improvements

The message router needs better patterns for action-oriented messages. Currently "close X" or "move X to done" may not classify as deck actions.

**Find the message router's intent classification logic** and add/improve these patterns:

```javascript
// Deck action patterns (add to existing classification)
const DECK_ACTION_PATTERNS = [
  // Close/complete patterns
  /(?:close|finish|complete|done|mark\s+as\s+done|put\s+into?\s+done)\s*[:\-]?\s*(.+)/i,
  // Move patterns
  /(?:move|put|shift)\s+[""']?(.+?)[""']?\s+(?:to|into)\s+(\w+)/i,
  // Start/work patterns
  /(?:start|begin|work\s+on)\s+[""']?(.+)/i,
  // Create patterns
  /(?:add|create|new)\s+(?:task|card|todo)\s*[:\-]?\s*(.+)/i,
  // Reconfirm/check patterns
  /(?:reconfirm|verify|check|is)\s+[""']?(.+?)[""']?\s+(?:done|in\s+done|closed|completed)/i,
];

// Calendar action patterns
const CALENDAR_ACTION_PATTERNS = [
  /(?:schedule|book|create|add)\s+(?:a\s+)?(?:meeting|event|appointment)/i,
  /(?:cancel|delete|remove)\s+(?:the\s+)?(?:meeting|event|appointment)/i,
  /(?:reschedule|move|change)\s+(?:the\s+)?(?:meeting|event)/i,
  /(?:what|do\s+i\s+have)\s+(?:on|for)\s+(?:my\s+)?(?:calendar|schedule)/i,
  /(?:am\s+i|are\s+we)\s+(?:free|busy|available)/i,
];
```

### 3.2 Action-Result Response Pattern

**This is the most important change.** When a handler executes an action (moves a Deck card, creates a calendar event), the response to the user MUST come from the actual API result — not from the LLM.

**Find the Deck handler** (wherever deck commands are processed) and implement this pattern:

```javascript
// BEFORE (broken):
// LLM generates: "I've moved the card to Done" ← hallucination
// AFTER (correct):

async handleDeckMove(cardTitle, targetStack, roomToken) {
  // 1. Find the card by title
  const cards = await this.deckClient.getCards(boardId);
  const card = cards.find(c => 
    c.title.toLowerCase().includes(cardTitle.toLowerCase())
  );

  if (!card) {
    return `❌ Couldn't find a card matching "${cardTitle}" on the board.`;
  }

  // 2. Find the target stack
  const stacks = await this.deckClient.getStacks(boardId);
  const targetStackObj = stacks.find(s => 
    s.title.toLowerCase() === targetStack.toLowerCase()
  );

  if (!targetStackObj) {
    return `❌ No stack called "${targetStack}". Available: ${stacks.map(s => s.title).join(', ')}`;
  }

  // 3. Actually move the card
  try {
    await this.deckClient.moveCard(boardId, card.id, targetStackObj.id);
    return `✅ Moved "${card.title}" (card #${card.id}) to ${targetStackObj.title}.`;
  } catch (err) {
    return `❌ Failed to move "${card.title}": ${err.message}`;
  }
}
```

**The key principle:** Handler returns a factual string describing what happened. This string gets sent directly to Talk. The LLM is NOT involved in generating the response for tool actions — only for open-ended conversation.

### 3.3 Multi-Card Operations

From the chat log: "close X and Y" should handle multiple cards in one message.

```javascript
/**
 * Parse a message for multiple card references.
 * Handles: "close X and Y", "put X, Y into done", "mark X and Y as done"
 * 
 * @param {string} message
 * @returns {string[]} Array of card title fragments
 */
function parseMultipleCards(message) {
  // Remove the action part
  const cleaned = message
    .replace(/(?:close|finish|complete|done|mark\s+as\s+done|put\s+into?\s+done)\s*[:\-]?\s*/i, '')
    .replace(/^["']|["']$/g, '');

  // Split on " and ", ", ", " & "
  return cleaned
    .split(/\s+(?:and|&)\s+|,\s+/)
    .map(s => s.replace(/^["']|["']$/g, '').trim())
    .filter(s => s.length > 0);
}
```

### 3.4 Conversation-Aware Routing

The message router should check conversation history to resolve ambiguous references.

```javascript
/**
 * Resolve references like "the first one", "those two", "it" 
 * by examining recent conversation context.
 * 
 * @param {string} message - Current user message
 * @param {Array} history - Conversation history from ConversationContext
 * @returns {Object} Resolved context: { referencedCards: [], referencedEvents: [], etc. }
 */
function resolveReferences(message, history) {
  const refs = { referencedCards: [], referencedEvents: [] };

  // "the one in inbox" → find last board listing, extract inbox cards
  if (/(?:the\s+one|which\s+one).*(?:inbox|working|done)/i.test(message)) {
    // Look for the last assistant message that listed deck cards
    const lastBoardListing = history
      .filter(m => m.role === 'assistant')
      .reverse()
      .find(m => m.content.includes('Task Board Summary') || m.content.includes('Open tasks'));
    
    if (lastBoardListing) {
      // Parse the listing to extract card names per stack
      // Implementation depends on the exact format Moltagent uses
    }
  }

  // "close those two" / "the first one" → reference last listed items
  if (/(?:those|the\s+first|the\s+second|the\s+last|all\s+of\s+them)/i.test(message)) {
    // Find last list of items in assistant messages
    // Extract referenced items
  }

  return refs;
}
```

---

## Integration: Putting It All Together

### Modified Message Processing Pipeline

Find the main message handler (likely in HeartbeatManager or a dedicated message handler) and modify the flow:

```
BEFORE:
  1. Receive Talk message
  2. Send to LLM with no context
  3. Return LLM response to Talk

AFTER:
  1. Receive Talk message from room {token}
  2. Fetch conversation history: ConversationContext.getHistory(token)
  3. Classify intent (with history for reference resolution)
  4. IF action intent (deck_move, calendar_create, etc.):
       → Execute action via handler
       → Return action result directly to Talk (NO LLM involved)
  5. IF conversational intent (question, discussion, etc.):
       → Build LLM prompt: system prompt + conversation history + current message
       → Call LLM
       → Return LLM response to Talk
  6. Audit log the interaction
```

### Key Integration Points

**1. ConversationContext instantiation** (in bot.js or startup):

```javascript
const { ConversationContext } = require('./lib/talk/conversation-context');
const conversationContext = new ConversationContext(
  config.talk?.conversationContext,
  ncRequestManager
);
```

**2. System prompt loading** (in bot.js or startup):

```javascript
const systemPrompt = fs.readFileSync(
  path.join(__dirname, 'config', 'system-prompt.md'),
  'utf-8'
);
```

**3. Message handler modification** (find the function that processes incoming Talk messages):

```javascript
async handleMessage(message, roomToken) {
  // Step 1: Get conversation history
  const history = await this.conversationContext.getHistory(roomToken, {
    excludeMessageId: message.id
  });

  // Step 2: Classify intent (pass history for reference resolution)
  const intent = this.messageRouter.classify(message.text, history);

  // Step 3: Route to handler
  let response;
  if (intent.type === 'deck_action') {
    response = await this.deckHandler.execute(intent, history);
  } else if (intent.type === 'calendar_action') {
    response = await this.calendarHandler.execute(intent, history);
  } else {
    // Conversational — use LLM with full context
    const conversationForPrompt = this.conversationContext.formatForPrompt(history);
    response = await this.llmRouter.generate({
      system: this.systemPrompt,
      messages: [
        { role: 'system', content: conversationForPrompt },
        { role: 'user', content: message.text }
      ]
    });
  }

  // Step 4: Send response
  await this.talkClient.sendMessage(roomToken, response);
}
```

---

## Exit Criteria

### ConversationContext:
- [ ] Fetches messages from Talk API with correct parameters
- [ ] Returns empty array when disabled
- [ ] Sorts messages chronologically (oldest first)
- [ ] Filters system messages
- [ ] Excludes specified message ID
- [ ] Filters messages older than maxMessageAge
- [ ] Trims to token budget (keeps most recent)
- [ ] formatForPrompt() produces correct `<conversation_history>` block
- [ ] Graceful degradation on API error (returns empty, doesn't crash)

### System Prompt:
- [ ] `config/system-prompt.md` exists with identity, capabilities, rules
- [ ] System prompt is loaded at startup
- [ ] System prompt is injected into every LLM call (search ALL call sites)
- [ ] System prompt clearly instructs tool use over description
- [ ] System prompt defines response style (concise, action-oriented)

### Message Router:
- [ ] "close X and Y" classifies as deck_move intent
- [ ] "put X into done" classifies as deck_move intent
- [ ] "reconfirm if X is done" classifies as deck_query intent
- [ ] "which one is in inbox" resolves from conversation history
- [ ] Multiple card references parsed correctly ("X and Y", "X, Y")

### Action-Result Responses:
- [ ] Deck move returns actual card ID and stack name
- [ ] Deck move returns error message on failure
- [ ] Card not found returns helpful error with card title
- [ ] Multi-card operations return results for each card
- [ ] Calendar actions return actual event details
- [ ] LLM is NOT involved in generating action confirmations

### Integration:
- [ ] Conversation history flows into LLM context for conversational messages
- [ ] Action intents bypass LLM entirely (direct handler → Talk response)
- [ ] System prompt present in all LLM calls
- [ ] All tests pass: `npm test`
- [ ] ESLint passes: `npm run lint`

---

## Do NOT Change

- The NCRequestManager or endpoint groups
- Security guards
- The credential broker mechanism
- The NC Flow modules (webhook receiver, activity poller, system tags)
- Talk bot webhook verification
- HeartbeatManager's pulse/heartbeat timing

---

## What Comes Next (After This Session)

1. **E2E dogfooding test** — have a real conversation with Moltagent, verify the fixes work
2. **Calendar v2 Smart Meetings** — participant resolution, RSVP tracking
3. **Flow Recipes documentation** — customer-facing guides

---

*Session 13: Making Moltagent feel like a colleague instead of a broken chatbot.*
