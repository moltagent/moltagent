# MoltAgent Session 6: Deck Extended Brain
## Claude Code Implementation Brief

**Date:** 2026-02-06  
**Author:** Fu + Claude Opus (architecture)  
**Executor:** Claude Code  
**Estimated CCode time:** ~2-2.5 hours  
**Dependencies:** Sessions 1-5 complete (security layer + calendar fix)  
**Spec source:** `moltagent-knowledge-system.md` (Phase 1 only)

---

## Context

The agent currently has **no memory between conversations**. Every heartbeat cycle, it processes tasks with zero knowledge of what it learned yesterday. This session implements the **minimum viable memory** — not the full knowledge system (that's Phase 9, post-launch), but enough that:

1. The agent can **log what it learns** (append-only LearningLog.md)
2. The agent can **recall recent context** on startup (load last N entries)
3. Humans can **verify/correct** the agent's understanding via Deck cards
4. The agent's learning is **auditable** and **transparent**

**Why now?** Concierge clients paying €399-799 expect the agent to remember "you told me last week that John leads Q3". Without this, every conversation starts from zero.

**Scope constraint:** This is NOT the full knowledge system with entity extraction, relationship graphs, and freshness checking. That's 3-4 sessions of work. This session builds the **learning log** and **verification board** only — the minimum infrastructure that all future knowledge features will build on.

**AGPL-3.0 license header for every new file:**

```javascript
/*
 * MoltAgent - Sovereign AI Security Layer
 * Copyright (C) 2026 MoltAgent Contributors
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU Affero General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 */
```

---

## Pre-Session Discovery

**IMPORTANT:** Before building, check the current state:

```bash
# 1. Check if Memory directory exists in NC
curl -u "moltagent:$NC_PASSWORD" \
  -X PROPFIND -H "Depth: 1" \
  "https://nx89136.your-storageshare.de/remote.php/dav/files/moltagent/Memory/" | head -50

# 2. Check if LearningLog.md already exists
curl -u "moltagent:$NC_PASSWORD" \
  "https://nx89136.your-storageshare.de/remote.php/dav/files/moltagent/Memory/LearningLog.md" 2>/dev/null | head -20

# 3. Check if a knowledge board exists in Deck
curl -u "moltagent:$NC_PASSWORD" \
  -H "OCS-APIRequest: true" -H "Accept: application/json" \
  "https://nx89136.your-storageshare.de/index.php/apps/deck/api/v1.0/boards" | jq '.[] | select(.title | contains("Knowledge"))'

# 4. Check existing DeckClient capabilities
grep -n "createBoard\|createStack\|createCard" /opt/moltagent/src/lib/deck-client.js | head -20

# 5. Check if WebDAV operations exist
grep -n "webdav\|PUT.*dav\|GET.*dav" /opt/moltagent/src/lib/*.js | head -20
```

Adjust implementation based on findings.

---

## Deliverables

| # | File | Est. Time | What It Does |
|---|------|-----------|-------------|
| 1 | `src/lib/knowledge/learning-log.js` | 45 min | Append-only log to /Memory/LearningLog.md |
| 2 | `src/lib/knowledge/knowledge-board.js` | 30 min | Create/manage "MoltAgent Knowledge" Deck board |
| 3 | `src/lib/knowledge/context-loader.js` | 30 min | Load recent learnings into agent context |
| 4 | Heartbeat integration | 20 min | Log learnings, check verification cards |
| 5 | `test/knowledge/` tests | 30 min | Unit tests for all modules |
| 6 | Integration + commit | 15 min | Wire up, test, commit |

---

## 1. Learning Log

**File:** `src/lib/knowledge/learning-log.js`

The learning log is an **append-only markdown file** stored in Nextcloud. Each entry records something the agent learned, with metadata for later verification.

```javascript
const { NCRequestManager } = require('../nc-request-manager');

/**
 * Append-only learning log stored in Nextcloud.
 * Records what the agent learns from conversations.
 */
class LearningLog {
  /**
   * @param {Object} options
   * @param {NCRequestManager} options.ncRequestManager
   * @param {string} options.logPath - WebDAV path (default: /Memory/LearningLog.md)
   */
  constructor({ ncRequestManager, logPath = '/Memory/LearningLog.md' }) {
    this.nc = ncRequestManager;
    this.logPath = logPath;
    this.pendingWrites = [];
    this.writeDebounceMs = 5000;  // Batch writes every 5 seconds
    this.writeTimer = null;
  }

  /**
   * Record a learning event.
   * @param {Object} entry
   * @param {string} entry.type - 'learned' | 'updated' | 'uncertainty' | 'contradiction'
   * @param {string} entry.content - What was learned (human-readable)
   * @param {string} entry.source - Where it came from (user, file, inference)
   * @param {string} [entry.confidence] - 'high' | 'medium' | 'low'
   * @param {Object} [entry.context] - Additional context (roomToken, userId, etc.)
   */
  async log(entry) {
    const record = {
      timestamp: new Date().toISOString(),
      type: entry.type || 'learned',
      content: entry.content,
      source: entry.source,
      confidence: entry.confidence || 'medium',
      context: entry.context || {},
    };

    this.pendingWrites.push(record);
    this.scheduleWrite();

    return record;
  }

  /**
   * Convenience method: Record something learned from a user.
   */
  async learned(content, source, confidence = 'medium') {
    return this.log({ type: 'learned', content, source, confidence });
  }

  /**
   * Convenience method: Record uncertainty that needs verification.
   */
  async uncertain(content, source, context = {}) {
    return this.log({ type: 'uncertainty', content, source, confidence: 'low', context });
  }

  /**
   * Convenience method: Record a contradiction between sources.
   */
  async contradiction(content, source, context = {}) {
    return this.log({ type: 'contradiction', content, source, confidence: 'disputed', context });
  }

  /**
   * Get recent log entries.
   * @param {number} limit - Max entries to return
   * @returns {Promise<Array>}
   */
  async getRecent(limit = 50) {
    try {
      const content = await this.nc.request(
        `/remote.php/dav/files/moltagent${this.logPath}`,
        { method: 'GET', group: 'webdav' }
      );

      if (!content.ok) {
        if (content.status === 404) return [];
        throw new Error(`Failed to read log: ${content.status}`);
      }

      const text = await content.text();
      return this.parseLog(text, limit);
    } catch (error) {
      console.error('Failed to read learning log:', error.message);
      return [];
    }
  }

  /**
   * Parse markdown log into structured entries.
   * @private
   */
  parseLog(text, limit) {
    const entries = [];
    const entryPattern = /### (\d{2}:\d{2}) - (\w+): (.+?)\n([\s\S]*?)(?=### \d{2}:\d{2}|## \d{4}-\d{2}-\d{2}|$)/g;
    const datePattern = /## (\d{4}-\d{2}-\d{2})/g;

    let currentDate = null;
    let dateMatch;

    // Find dates and entries
    const lines = text.split('\n');
    let currentEntry = null;

    for (const line of lines) {
      if (line.startsWith('## ')) {
        const match = line.match(/## (\d{4}-\d{2}-\d{2})/);
        if (match) currentDate = match[1];
      } else if (line.startsWith('### ')) {
        if (currentEntry) entries.push(currentEntry);
        const match = line.match(/### (\d{2}:\d{2}) - (\w+): (.+)/);
        if (match && currentDate) {
          currentEntry = {
            timestamp: `${currentDate}T${match[1]}:00Z`,
            type: match[2].toLowerCase(),
            content: match[3],
            details: [],
          };
        }
      } else if (currentEntry && line.startsWith('- **')) {
        const detailMatch = line.match(/- \*\*(.+?):\*\* (.+)/);
        if (detailMatch) {
          currentEntry[detailMatch[1].toLowerCase()] = detailMatch[2];
        }
      }
    }

    if (currentEntry) entries.push(currentEntry);

    // Return most recent first, limited
    return entries.reverse().slice(0, limit);
  }

  /**
   * Schedule a batched write to avoid hammering the API.
   * @private
   */
  scheduleWrite() {
    if (this.writeTimer) return;

    this.writeTimer = setTimeout(async () => {
      this.writeTimer = null;
      await this.flushWrites();
    }, this.writeDebounceMs);
  }

  /**
   * Flush pending writes to the log file.
   * @private
   */
  async flushWrites() {
    if (this.pendingWrites.length === 0) return;

    const entries = this.pendingWrites.splice(0, this.pendingWrites.length);
    const markdown = this.formatEntries(entries);

    try {
      // Read existing content
      let existing = '';
      const readResponse = await this.nc.request(
        `/remote.php/dav/files/moltagent${this.logPath}`,
        { method: 'GET', group: 'webdav' }
      );

      if (readResponse.ok) {
        existing = await readResponse.text();
      } else if (readResponse.status !== 404) {
        throw new Error(`Failed to read log: ${readResponse.status}`);
      }

      // Append new entries
      const updated = this.appendToLog(existing, markdown);

      // Write back
      await this.nc.request(
        `/remote.php/dav/files/moltagent${this.logPath}`,
        {
          method: 'PUT',
          body: updated,
          headers: { 'Content-Type': 'text/markdown' },
          group: 'webdav',
        }
      );

      console.log(`[LearningLog] Wrote ${entries.length} entries`);
    } catch (error) {
      console.error('Failed to write learning log:', error.message);
      // Re-queue failed entries
      this.pendingWrites.unshift(...entries);
    }
  }

  /**
   * Format entries as markdown.
   * @private
   */
  formatEntries(entries) {
    const byDate = {};

    for (const entry of entries) {
      const date = entry.timestamp.split('T')[0];
      const time = entry.timestamp.split('T')[1].substring(0, 5);

      if (!byDate[date]) byDate[date] = [];

      let md = `### ${time} - ${this.capitalize(entry.type)}: ${entry.content}\n`;
      md += `- **Source:** ${entry.source}\n`;
      md += `- **Confidence:** ${this.capitalize(entry.confidence)}\n`;

      if (entry.context.roomToken) {
        md += `- **Room:** ${entry.context.roomToken}\n`;
      }
      if (entry.context.userId) {
        md += `- **User:** ${entry.context.userId}\n`;
      }

      md += '\n';
      byDate[date].push(md);
    }

    let result = '';
    for (const [date, items] of Object.entries(byDate).sort().reverse()) {
      result += `## ${date}\n\n`;
      result += items.join('');
    }

    return result;
  }

  /**
   * Append new entries to existing log, merging date sections.
   * @private
   */
  appendToLog(existing, newEntries) {
    if (!existing.trim()) {
      return `# MoltAgent Learning Log\n\n${newEntries}`;
    }

    // Insert new entries after the header
    const headerEnd = existing.indexOf('\n## ');
    if (headerEnd === -1) {
      return existing + '\n' + newEntries;
    }

    // Insert new content right after header
    return existing.substring(0, headerEnd) + '\n' + newEntries + existing.substring(headerEnd);
  }

  /**
   * Force flush any pending writes.
   */
  async shutdown() {
    if (this.writeTimer) {
      clearTimeout(this.writeTimer);
      this.writeTimer = null;
    }
    await this.flushWrites();
  }

  capitalize(str) {
    return str.charAt(0).toUpperCase() + str.slice(1);
  }
}

module.exports = { LearningLog };
```

---

## 2. Knowledge Board

**File:** `src/lib/knowledge/knowledge-board.js`

A dedicated Deck board for tracking uncertain knowledge that needs human verification.

```javascript
/**
 * Manages the "MoltAgent Knowledge" Deck board for verification tracking.
 */
class KnowledgeBoard {
  /**
   * @param {Object} options
   * @param {DeckClient} options.deckClient
   * @param {Object} [options.config]
   */
  constructor({ deckClient, config = {} }) {
    this.deck = deckClient;
    this.config = {
      boardTitle: config.boardTitle || 'MoltAgent Knowledge',
      boardColor: config.boardColor || '0082c9',
      ...config,
    };

    this.boardId = null;
    this.stacks = {};
    this.initialized = false;
  }

  /**
   * Initialize the board, creating it if it doesn't exist.
   */
  async initialize() {
    if (this.initialized) return;

    // Check if board exists
    const boards = await this.deck.getBoards();
    let board = boards.find(b => b.title === this.config.boardTitle);

    if (!board) {
      // Create the board
      board = await this.deck.createBoard({
        title: this.config.boardTitle,
        color: this.config.boardColor,
      });
      console.log(`[KnowledgeBoard] Created board: ${board.id}`);

      // Create stacks
      await this.createStacks(board.id);
    } else {
      // Load existing stacks
      await this.loadStacks(board.id);
    }

    this.boardId = board.id;
    this.initialized = true;
  }

  /**
   * Create the standard stacks for knowledge tracking.
   * @private
   */
  async createStacks(boardId) {
    const stackDefs = [
      { title: '✓ Verified', order: 0 },
      { title: '? Uncertain', order: 1 },
      { title: '⚠️ Stale', order: 2 },
      { title: '✗ Disputed', order: 3 },
    ];

    for (const def of stackDefs) {
      const stack = await this.deck.createStack({
        boardId,
        title: def.title,
        order: def.order,
      });
      this.stacks[def.title] = stack.id;
    }

    console.log(`[KnowledgeBoard] Created ${stackDefs.length} stacks`);
  }

  /**
   * Load existing stacks from the board.
   * @private
   */
  async loadStacks(boardId) {
    const stacks = await this.deck.getStacks(boardId);
    for (const stack of stacks) {
      this.stacks[stack.title] = stack.id;
    }
  }

  /**
   * Create a verification card for uncertain knowledge.
   * @param {Object} item
   * @param {string} item.title - What needs verification
   * @param {string} item.description - Details and context
   * @param {string} [item.source] - Where the uncertainty came from
   * @param {string} [item.assignTo] - User to assign (optional)
   */
  async createVerificationCard(item) {
    await this.initialize();

    const stackId = this.stacks['? Uncertain'];
    if (!stackId) {
      throw new Error('Uncertain stack not found');
    }

    // Check for duplicates
    const existingCards = await this.deck.getCards(this.boardId, stackId);
    const duplicate = existingCards.find(c => 
      c.title === `Verify: ${item.title}` || c.title === item.title
    );

    if (duplicate) {
      console.log(`[KnowledgeBoard] Skipping duplicate: ${item.title}`);
      return duplicate;
    }

    const description = this.formatVerificationDescription(item);

    const card = await this.deck.createCard({
      boardId: this.boardId,
      stackId,
      title: `Verify: ${item.title}`,
      description,
      dueDate: this.addDays(new Date(), 7),
    });

    if (item.assignTo) {
      await this.deck.assignCard(card.id, item.assignTo);
    }

    console.log(`[KnowledgeBoard] Created verification card: ${card.id}`);
    return card;
  }

  /**
   * Create a card for a detected contradiction.
   */
  async createDisputeCard(item) {
    await this.initialize();

    const stackId = this.stacks['✗ Disputed'];
    if (!stackId) {
      throw new Error('Disputed stack not found');
    }

    const description = `## Contradiction Detected

**Topic:** ${item.title}

### Conflicting Information

**Source A:** ${item.sourceA}
> ${item.claimA}

**Source B:** ${item.sourceB}
> ${item.claimB}

### Please Resolve

Which information is correct? Move this card to "Verified" after resolution.

---
*Auto-generated by MoltAgent*`;

    const card = await this.deck.createCard({
      boardId: this.boardId,
      stackId,
      title: `Dispute: ${item.title}`,
      description,
      dueDate: this.addDays(new Date(), 3),  // Disputes are urgent
    });

    return card;
  }

  /**
   * Get all cards needing verification (in Uncertain or Stale stacks).
   */
  async getPendingVerifications() {
    await this.initialize();

    const pending = [];

    for (const stackTitle of ['? Uncertain', '⚠️ Stale']) {
      const stackId = this.stacks[stackTitle];
      if (stackId) {
        const cards = await this.deck.getCards(this.boardId, stackId);
        pending.push(...cards.map(c => ({ ...c, status: stackTitle })));
      }
    }

    return pending;
  }

  /**
   * Check if a card was moved to Verified (indicates human confirmation).
   * @param {number} cardId
   */
  async isVerified(cardId) {
    const card = await this.deck.getCard(cardId);
    return card && card.stackId === this.stacks['✓ Verified'];
  }

  /**
   * Format the description for a verification card.
   * @private
   */
  formatVerificationDescription(item) {
    return `## Verification Needed

**Item:** ${item.title}
**Source:** ${item.source || 'Unknown'}
**Logged:** ${new Date().toISOString().split('T')[0]}

### Current Understanding

${item.description}

### Please Confirm

1. Is this information accurate?
2. If not, what's the correct information?
3. Add a comment with corrections, then move to "Verified".

---
*This card was auto-generated by MoltAgent.*`;
  }

  /**
   * Add days to a date.
   * @private
   */
  addDays(date, days) {
    const result = new Date(date);
    result.setDate(result.getDate() + days);
    return result.toISOString().split('T')[0];
  }

  /**
   * Get board status summary.
   */
  async getStatus() {
    await this.initialize();

    const status = { boardId: this.boardId, stacks: {} };

    for (const [title, stackId] of Object.entries(this.stacks)) {
      const cards = await this.deck.getCards(this.boardId, stackId);
      status.stacks[title] = cards.length;
    }

    return status;
  }
}

module.exports = { KnowledgeBoard };
```

---

## 3. Context Loader

**File:** `src/lib/knowledge/context-loader.js`

Loads recent learnings into the agent's context at startup, giving it memory of recent conversations.

```javascript
/**
 * Loads recent knowledge context for the agent.
 * Provides memory across conversations.
 */
class ContextLoader {
  /**
   * @param {Object} options
   * @param {LearningLog} options.learningLog
   * @param {KnowledgeBoard} options.knowledgeBoard
   * @param {Object} [options.config]
   */
  constructor({ learningLog, knowledgeBoard, config = {} }) {
    this.log = learningLog;
    this.board = knowledgeBoard;
    this.config = {
      maxRecentLearnings: config.maxRecentLearnings || 20,
      maxContextTokens: config.maxContextTokens || 2000,
      ...config,
    };
  }

  /**
   * Load context for the agent's system prompt.
   * Called during bot startup or before processing messages.
   * @returns {Promise<string>} Context string to include in prompts
   */
  async loadContext() {
    const sections = [];

    // Recent learnings
    const learnings = await this.loadRecentLearnings();
    if (learnings.length > 0) {
      sections.push(this.formatLearningsSection(learnings));
    }

    // Pending verifications
    const pending = await this.loadPendingVerifications();
    if (pending.length > 0) {
      sections.push(this.formatPendingSection(pending));
    }

    if (sections.length === 0) {
      return '';
    }

    return `<agent_memory>
${sections.join('\n\n')}
</agent_memory>`;
  }

  /**
   * Load recent learnings from the log.
   * @private
   */
  async loadRecentLearnings() {
    try {
      const entries = await this.log.getRecent(this.config.maxRecentLearnings);

      // Filter to high/medium confidence, skip uncertainties
      return entries.filter(e => 
        e.type !== 'uncertainty' && 
        e.confidence !== 'low' &&
        e.confidence !== 'disputed'
      );
    } catch (error) {
      console.error('Failed to load recent learnings:', error.message);
      return [];
    }
  }

  /**
   * Load items awaiting verification.
   * @private
   */
  async loadPendingVerifications() {
    try {
      const cards = await this.board.getPendingVerifications();
      return cards.slice(0, 5);  // Limit to avoid context bloat
    } catch (error) {
      console.error('Failed to load pending verifications:', error.message);
      return [];
    }
  }

  /**
   * Format learnings for the context.
   * @private
   */
  formatLearningsSection(learnings) {
    const lines = ['## Recent Knowledge\n'];
    lines.push('Things I have learned recently:\n');

    for (const entry of learnings) {
      const date = new Date(entry.timestamp).toLocaleDateString('en-US', {
        month: 'short',
        day: 'numeric',
      });
      lines.push(`- **${date}:** ${entry.content} (from ${entry.source})`);
    }

    return lines.join('\n');
  }

  /**
   * Format pending verifications for the context.
   * @private
   */
  formatPendingSection(pending) {
    const lines = ['## Awaiting Verification\n'];
    lines.push('These items need human confirmation:\n');

    for (const card of pending) {
      const title = card.title.replace('Verify: ', '').replace('Dispute: ', '');
      lines.push(`- ⚠️ ${title} (${card.status})`);
    }

    lines.push('\n*When asked about these topics, I should note my uncertainty.*');

    return lines.join('\n');
  }

  /**
   * Get a summary of what the agent remembers.
   * Useful for responding to "what do you know about X?"
   */
  async getSummary() {
    const learnings = await this.log.getRecent(50);
    const pending = await this.board.getPendingVerifications();

    return {
      totalLearnings: learnings.length,
      highConfidence: learnings.filter(e => e.confidence === 'high').length,
      pendingVerifications: pending.length,
      recentTopics: learnings.slice(0, 10).map(e => e.content),
    };
  }
}

module.exports = { ContextLoader };
```

---

## 4. Heartbeat Integration

**Update:** `src/lib/heartbeat-manager.js`

Add knowledge tracking to the heartbeat cycle.

```javascript
// Add to HeartbeatManager constructor options:
// knowledgeLog: LearningLog instance
// knowledgeBoard: KnowledgeBoard instance
// contextLoader: ContextLoader instance

// In HeartbeatManager.initialize():
async initialize() {
  // ... existing initialization ...

  // Initialize knowledge board
  if (this.knowledgeBoard) {
    await this.knowledgeBoard.initialize();
  }

  // Load context for this session
  if (this.contextLoader) {
    this.agentContext = await this.contextLoader.loadContext();
    if (this.agentContext) {
      console.log(`[Heartbeat] Loaded ${this.agentContext.length} chars of agent memory`);
    }
  }
}

// In processTask() - after successful task completion:
async processTask(task) {
  // ... existing task processing ...

  // Log what was learned (if response indicates new information)
  if (this.knowledgeLog && response.learned) {
    await this.knowledgeLog.learned(
      response.learned,
      `Task: ${task.title}`,
      response.confidence || 'medium'
    );
  }

  // Log uncertainties that need verification
  if (this.knowledgeLog && response.uncertain) {
    await this.knowledgeLog.uncertain(
      response.uncertain,
      `Task: ${task.title}`,
      { taskId: task.id, roomToken: task.roomToken }
    );

    // Create verification card
    if (this.knowledgeBoard) {
      await this.knowledgeBoard.createVerificationCard({
        title: response.uncertain,
        description: `Uncertainty from task: ${task.title}`,
        source: task.roomToken,
      });
    }
  }
}

// Add new method for periodic knowledge checks:
async checkKnowledgeBoard() {
  if (!this.knowledgeBoard) return;

  try {
    const status = await this.knowledgeBoard.getStatus();
    const pendingCount = (status.stacks['? Uncertain'] || 0) + (status.stacks['⚠️ Stale'] || 0);

    if (pendingCount > 10) {
      console.log(`[Heartbeat] ⚠️ ${pendingCount} knowledge items awaiting verification`);
    }
  } catch (error) {
    console.error('Failed to check knowledge board:', error.message);
  }
}

// In shutdown():
async shutdown() {
  // ... existing shutdown ...

  if (this.knowledgeLog) {
    await this.knowledgeLog.shutdown();
  }
}
```

---

## 5. Module Exports

**File:** `src/lib/knowledge/index.js`

```javascript
/*
 * MoltAgent - Sovereign AI Security Layer
 * Copyright (C) 2026 MoltAgent Contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

const { LearningLog } = require('./learning-log');
const { KnowledgeBoard } = require('./knowledge-board');
const { ContextLoader } = require('./context-loader');

module.exports = {
  LearningLog,
  KnowledgeBoard,
  ContextLoader,
};
```

---

## 6. Test Cases

**File:** `test/knowledge/learning-log.test.js`

```javascript
describe('LearningLog', () => {
  let log;
  let mockNcRequestManager;

  beforeEach(() => {
    mockNcRequestManager = {
      request: jest.fn(),
    };
    log = new LearningLog({ ncRequestManager: mockNcRequestManager });
  });

  afterEach(async () => {
    await log.shutdown();
  });

  describe('log()', () => {
    test('queues entries for batched writing', async () => {
      await log.learned('John leads Q3 Campaign', '@sarah');
      await log.learned('Budget is €50k', '@finance');

      expect(log.pendingWrites).toHaveLength(2);
    });

    test('includes timestamp and metadata', async () => {
      const entry = await log.learned('Test fact', '@user', 'high');

      expect(entry.timestamp).toBeDefined();
      expect(entry.type).toBe('learned');
      expect(entry.confidence).toBe('high');
    });
  });

  describe('uncertain()', () => {
    test('creates entry with low confidence', async () => {
      const entry = await log.uncertain('Q3 timeline unclear', '@pm');

      expect(entry.type).toBe('uncertainty');
      expect(entry.confidence).toBe('low');
    });
  });

  describe('parseLog()', () => {
    test('parses markdown format correctly', () => {
      const markdown = `# MoltAgent Learning Log

## 2026-02-06

### 15:42 - Learned: John leads Q3 Campaign
- **Source:** @sarah
- **Confidence:** High

### 14:20 - Updated: Budget changed to €60k
- **Source:** @finance
- **Confidence:** Medium
`;

      const entries = log.parseLog(markdown, 10);

      expect(entries).toHaveLength(2);
      expect(entries[0].content).toBe('Budget changed to €60k');  // Most recent first
      expect(entries[1].content).toBe('John leads Q3 Campaign');
    });
  });

  describe('flushWrites()', () => {
    test('appends to existing log via WebDAV', async () => {
      mockNcRequestManager.request
        .mockResolvedValueOnce({ ok: true, text: () => '# MoltAgent Learning Log\n\n' })
        .mockResolvedValueOnce({ ok: true });

      await log.learned('Test entry', '@user');
      await log.flushWrites();

      expect(mockNcRequestManager.request).toHaveBeenCalledWith(
        expect.stringContaining('/Memory/LearningLog.md'),
        expect.objectContaining({ method: 'PUT' })
      );
    });

    test('creates new log if none exists', async () => {
      mockNcRequestManager.request
        .mockResolvedValueOnce({ ok: false, status: 404 })
        .mockResolvedValueOnce({ ok: true });

      await log.learned('First entry', '@user');
      await log.flushWrites();

      const putCall = mockNcRequestManager.request.mock.calls[1];
      expect(putCall[1].body).toContain('# MoltAgent Learning Log');
    });
  });
});
```

**File:** `test/knowledge/knowledge-board.test.js`

```javascript
describe('KnowledgeBoard', () => {
  let board;
  let mockDeckClient;

  beforeEach(() => {
    mockDeckClient = {
      getBoards: jest.fn().mockResolvedValue([]),
      createBoard: jest.fn().mockResolvedValue({ id: 1 }),
      createStack: jest.fn().mockResolvedValue({ id: 1 }),
      getStacks: jest.fn().mockResolvedValue([]),
      getCards: jest.fn().mockResolvedValue([]),
      createCard: jest.fn().mockResolvedValue({ id: 100 }),
    };
    board = new KnowledgeBoard({ deckClient: mockDeckClient });
  });

  describe('initialize()', () => {
    test('creates board if it does not exist', async () => {
      await board.initialize();

      expect(mockDeckClient.createBoard).toHaveBeenCalledWith(
        expect.objectContaining({ title: 'MoltAgent Knowledge' })
      );
    });

    test('creates standard stacks', async () => {
      await board.initialize();

      expect(mockDeckClient.createStack).toHaveBeenCalledTimes(4);
      expect(mockDeckClient.createStack).toHaveBeenCalledWith(
        expect.objectContaining({ title: '✓ Verified' })
      );
    });

    test('reuses existing board', async () => {
      mockDeckClient.getBoards.mockResolvedValue([
        { id: 5, title: 'MoltAgent Knowledge' },
      ]);
      mockDeckClient.getStacks.mockResolvedValue([
        { id: 10, title: '✓ Verified' },
      ]);

      await board.initialize();

      expect(mockDeckClient.createBoard).not.toHaveBeenCalled();
      expect(board.boardId).toBe(5);
    });
  });

  describe('createVerificationCard()', () => {
    test('creates card in Uncertain stack', async () => {
      mockDeckClient.createStack.mockResolvedValue({ id: 20 });

      await board.initialize();
      await board.createVerificationCard({
        title: 'Q3 Budget',
        description: 'Is the budget €50k or €60k?',
        source: '@finance',
      });

      expect(mockDeckClient.createCard).toHaveBeenCalledWith(
        expect.objectContaining({
          title: 'Verify: Q3 Budget',
        })
      );
    });

    test('skips duplicate cards', async () => {
      mockDeckClient.getCards.mockResolvedValue([
        { title: 'Verify: Q3 Budget' },
      ]);

      await board.initialize();
      await board.createVerificationCard({ title: 'Q3 Budget', description: 'Test' });

      expect(mockDeckClient.createCard).not.toHaveBeenCalled();
    });
  });
});
```

---

## 7. Wiring in bot.js

**Update:** `src/bot.js` or equivalent entry point

```javascript
const { LearningLog, KnowledgeBoard, ContextLoader } = require('./lib/knowledge');

// In initialization:
const learningLog = new LearningLog({
  ncRequestManager,
  logPath: '/Memory/LearningLog.md',
});

const knowledgeBoard = new KnowledgeBoard({
  deckClient,
});

const contextLoader = new ContextLoader({
  learningLog,
  knowledgeBoard,
});

// Pass to HeartbeatManager:
const heartbeat = new HeartbeatManager({
  // ... existing config ...
  knowledgeLog: learningLog,
  knowledgeBoard: knowledgeBoard,
  contextLoader: contextLoader,
});
```

---

## 8. Exit Criteria

Before calling this session done:

**LearningLog:**
- [ ] `log()` queues entries for batched writing
- [ ] `learned()`, `uncertain()`, `contradiction()` convenience methods work
- [ ] `getRecent()` parses markdown log correctly
- [ ] `flushWrites()` appends to existing log via WebDAV
- [ ] Creates new log file if none exists (404 handling)
- [ ] Debouncing prevents API spam (5-second batches)

**KnowledgeBoard:**
- [ ] `initialize()` creates board and stacks if missing
- [ ] `initialize()` reuses existing board if present
- [ ] `createVerificationCard()` creates card in Uncertain stack
- [ ] Duplicate card detection prevents spam
- [ ] `getPendingVerifications()` returns cards from Uncertain + Stale
- [ ] `getStatus()` returns card counts per stack

**ContextLoader:**
- [ ] `loadContext()` returns formatted context string
- [ ] Recent learnings filtered by confidence
- [ ] Pending verifications included with warnings
- [ ] Empty context handled gracefully

**Heartbeat Integration:**
- [ ] Knowledge board initialized on startup
- [ ] Agent context loaded before processing
- [ ] Task completions logged to learning log
- [ ] Uncertainties create verification cards
- [ ] Shutdown flushes pending writes

**Tests:**
- [ ] All knowledge tests pass
- [ ] No real API calls in tests (mocked)
- [ ] Coverage of error cases (404, network failure)

**Integration:**
- [ ] `npm test` passes (all 1200+ tests)
- [ ] ESLint clean
- [ ] AGPL headers on all new files
- [ ] Commit with descriptive message

---

## 9. What's NOT in Scope

These are **deferred to the full knowledge system (Phase 9)**:

- Entity extraction from text
- Relationship graph (`relationships.json`)
- Wikilink parsing and resolution
- Freshness checking with decay_days
- Automatic stale flagging
- NC Collective integration
- Talk commands (`/know`, `/verify`, `/forget`)
- Confidence-weighted responses
- Propagation engine

This session builds the **foundation** those features will sit on.

---

## 10. What Comes Next

**Session 7:** Collectives self-docs — "What can my agent do?"
**── LAUNCH GATE ──**
**Session 8+:** Skill Forge — Template-based skill generation

---

*Built for MoltAgent Session 6. An agent with memory beats a brilliant amnesiac.*
