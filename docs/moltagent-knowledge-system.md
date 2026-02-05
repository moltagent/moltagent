# MoltAgent Knowledge System Specification

**Version:** 1.0  
**Status:** Architecture Design  
**Purpose:** Enable MoltAgent to maintain living, verified knowledge through Nextcloud apps

---

## Executive Summary

Traditional RAG treats knowledge as static documents to search. MoltAgent Knowledge System (MKS) treats knowledge as a **living ecosystem** where the agent actively participates in creation, verification, and maintenance.

**The shift:**
```
Traditional:    Docs exist → Agent searches → Maybe finds answer → Forgets
MoltAgent:      Agent notices gap → Documents it → Links relationships → 
                Tracks freshness → Asks humans to verify → Knowledge stays alive
```

**Core insight:** The agent doesn't just *query* knowledge—it *maintains* knowledge.

---

## Design Philosophy

### The Employment Model Extended

If MoltAgent is a digital employee, then:
- Employees **take notes** during meetings → Agent documents what it learns
- Employees **build relationships** → Agent tracks connections between concepts
- Employees **ask colleagues** when uncertain → Agent proactively requests verification
- Employees **notice when info is stale** → Agent flags outdated knowledge
- Employees **maintain their own files** → Agent organizes its knowledge workspace

### Poor Man's Principles

Every feature should be achievable with:
1. **Standard NC apps** (Files, Deck, Talk, Collective)
2. **Simple data formats** (Markdown, JSON, YAML frontmatter)
3. **Basic algorithms** (string matching, graph traversal, timestamp comparison)
4. **No external dependencies** (no graph databases, no vector stores, no ML models)

Advanced features can be added later, but v1 must work with simple tools.

---

## Architecture Overview

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                      MOLTAGENT KNOWLEDGE SYSTEM                             │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│  ┌─────────────────────────────────────────────────────────────────────┐   │
│  │                        KNOWLEDGE LAYER                              │   │
│  │                                                                     │   │
│  │   /Memory/Knowledge/           Structured markdown with frontmatter │   │
│  │   ├── People/                  ├── Wikilinks for relationships     │   │
│  │   ├── Projects/                ├── YAML metadata (confidence, age) │   │
│  │   ├── Policies/                └── Traversable knowledge graph     │   │
│  │   ├── Concepts/                                                     │   │
│  │   └── _index.json              Master index of all knowledge       │   │
│  │                                                                     │   │
│  │   /Memory/relationships.json   Explicit relationship triples       │   │
│  │   /Memory/LearningLog.md       Append-only learning history        │   │
│  │                                                                     │   │
│  └─────────────────────────────────────────────────────────────────────┘   │
│                                    │                                        │
│                                    ▼                                        │
│  ┌─────────────────────────────────────────────────────────────────────┐   │
│  │                       MAINTENANCE LAYER                             │   │
│  │                                                                     │   │
│  │   NC Deck: "MoltAgent Knowledge"                                    │   │
│  │   ┌──────────────┬──────────────┬──────────────┬──────────────┐    │   │
│  │   │   VERIFIED   │  UNCERTAIN   │    STALE     │   DISPUTED   │    │   │
│  │   │      ✓       │      ?       │      ⚠️       │      ✗       │    │   │
│  │   │              │              │              │              │    │   │
│  │   │ Confirmed    │ Needs human  │ Too old,     │ Conflicting  │    │   │
│  │   │ knowledge    │ verification │ needs check  │ information  │    │   │
│  │   └──────────────┴──────────────┴──────────────┴──────────────┘    │   │
│  │                                                                     │   │
│  │   Freshness Checker (runs on heartbeat)                            │   │
│  │   ├── Scans all knowledge items                                    │   │
│  │   ├── Calculates age vs decay_days                                 │   │
│  │   ├── Creates Deck cards for stale items                           │   │
│  │   └── Assigns to last verifier for re-check                        │   │
│  │                                                                     │   │
│  └─────────────────────────────────────────────────────────────────────┘   │
│                                    │                                        │
│                                    ▼                                        │
│  ┌─────────────────────────────────────────────────────────────────────┐   │
│  │                      INTERACTION LAYER                              │   │
│  │                                                                     │   │
│  │   NC Talk: Proactive Verification                                   │   │
│  │   ├── "Hi Sarah! Is John still Marketing Director?"                │   │
│  │   ├── "I'm uncertain about Q3 budget. Can you confirm ~€50k?"      │   │
│  │   └── Tracks questions via Deck cards                              │   │
│  │                                                                     │   │
│  │   NC Collective: Living Wiki (optional)                            │   │
│  │   ├── Human-readable knowledge pages                               │   │
│  │   ├── Agent updates pages when knowledge changes                   │   │
│  │   └── Humans can edit directly                                     │   │
│  │                                                                     │   │
│  └─────────────────────────────────────────────────────────────────────┘   │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
```

---

## Part 1: Knowledge Representation

### 1.1 Directory Structure

```
/moltagent/Memory/
├── Knowledge/
│   ├── People/
│   │   ├── John_Smith.md
│   │   ├── Sarah_Chen.md
│   │   └── _index.json
│   ├── Projects/
│   │   ├── Q3_Campaign.md
│   │   ├── Brand_Refresh.md
│   │   └── _index.json
│   ├── Policies/
│   │   ├── Remote_Work.md
│   │   ├── Expenses.md
│   │   └── _index.json
│   ├── Concepts/
│   │   ├── Marketing_Department.md
│   │   ├── London_Office.md
│   │   └── _index.json
│   └── _master_index.json
├── relationships.json
├── LearningLog.md
└── KnowledgeConfig.yaml
```

### 1.2 Knowledge Item Format

Each knowledge item is a markdown file with YAML frontmatter:

```markdown
---
# Identity
id: "person_john_smith"
type: person
title: "John Smith"
aliases: ["John", "J. Smith", "john.smith@company.com"]

# Verification
created: 2026-01-15T10:30:00Z
verified: 2026-01-28T14:22:00Z
verified_by: sarah
source: "Slack conversation with Sarah"
confidence: high  # high, medium, low, uncertain

# Freshness
decay_days: 90  # Flag for review after this many days
last_checked: 2026-01-28T14:22:00Z
check_count: 2

# Relationships (explicit)
related:
  - type: works_in
    target: "[[Marketing Department]]"
  - type: reports_to
    target: "[[Sarah Chen]]"
  - type: leads
    target: "[[Q3 Campaign]]"
  - type: located_at
    target: "[[London Office]]"

# Flags
needs_verification: false
disputed: false
---

# John Smith

**Role:** Marketing Director  
**Reports to:** [[Sarah Chen]]  
**Department:** [[Marketing Department]]  
**Location:** [[London Office]]  
**Extension:** 4521  
**Email:** john.smith@company.com

## Current Projects

- [[Q3 Campaign]] - Lead (started Feb 2026)
- [[Brand Refresh]] - Sponsor

## Working Style Notes

- Prefers Slack over email for quick questions
- Usually OOO on Fridays (compressed work week)
- Best time to reach: Tue-Thu mornings

## History

- **2026-01-28:** Confirmed as Marketing Director by [[Sarah Chen]]
- **2026-01-15:** First learned about John from project discussion
```

### 1.3 Confidence Levels

```yaml
# /Memory/KnowledgeConfig.yaml

confidence_levels:
  high:
    description: "Verified by authoritative source"
    decay_days: 90
    color: "#22c55e"  # green
    
  medium:
    description: "Reasonable confidence from indirect source"
    decay_days: 60
    color: "#eab308"  # yellow
    
  low:
    description: "Inferred or from unreliable source"
    decay_days: 30
    color: "#f97316"  # orange
    
  uncertain:
    description: "Needs verification before use"
    decay_days: 7
    color: "#ef4444"  # red
    auto_flag: true   # Automatically creates Deck card
```

### 1.4 Wikilinks and References

The `[[double bracket]]` syntax creates traversable links:

```javascript
// Parse wikilinks from markdown content
function extractWikilinks(content) {
  const pattern = /\[\[([^\]]+)\]\]/g;
  const links = [];
  let match;
  
  while ((match = pattern.exec(content)) !== null) {
    links.push({
      display: match[1],
      normalized: normalizeTitle(match[1])  // "John Smith" → "john_smith"
    });
  }
  
  return links;
}

// Resolve wikilink to knowledge item
async function resolveWikilink(link) {
  const normalized = normalizeTitle(link);
  
  // Check master index
  const index = await loadMasterIndex();
  
  // Try exact match
  if (index[normalized]) {
    return index[normalized];
  }
  
  // Try aliases
  for (const [id, item] of Object.entries(index)) {
    if (item.aliases?.map(normalizeTitle).includes(normalized)) {
      return item;
    }
  }
  
  return null;  // Unknown reference
}
```

### 1.5 Relationship Triples

For explicit, queryable relationships:

```json
// /Memory/relationships.json
{
  "version": "1.0",
  "updated": "2026-02-03T15:30:00Z",
  "triples": [
    {
      "id": "rel_001",
      "subject": "person_john_smith",
      "predicate": "reports_to",
      "object": "person_sarah_chen",
      "verified": "2026-01-28T14:22:00Z",
      "source": "sarah"
    },
    {
      "id": "rel_002",
      "subject": "person_john_smith",
      "predicate": "leads",
      "object": "project_q3_campaign",
      "verified": "2026-01-28T14:22:00Z",
      "source": "sarah"
    },
    {
      "id": "rel_003",
      "subject": "project_q3_campaign",
      "predicate": "has_budget",
      "object": "€50,000",
      "verified": "2026-01-20T09:00:00Z",
      "confidence": "medium",
      "source": "meeting_notes"
    },
    {
      "id": "rel_004",
      "subject": "project_q3_campaign",
      "predicate": "belongs_to",
      "object": "concept_marketing_department",
      "verified": "2026-01-20T09:00:00Z",
      "source": "inferred"
    }
  ],
  
  "predicates": {
    "reports_to": { "inverse": "manages", "domain": "person", "range": "person" },
    "leads": { "inverse": "led_by", "domain": "person", "range": "project" },
    "works_in": { "inverse": "has_member", "domain": "person", "range": "concept" },
    "belongs_to": { "inverse": "contains", "domain": "*", "range": "concept" },
    "has_budget": { "domain": "project", "range": "literal" },
    "located_at": { "inverse": "houses", "domain": "*", "range": "concept" }
  }
}
```

### 1.6 Relationship Queries

```javascript
class RelationshipGraph {
  constructor(triples) {
    this.triples = triples;
    this.bySubject = this.indexBy('subject');
    this.byObject = this.indexBy('object');
    this.byPredicate = this.indexBy('predicate');
  }

  // Find all related entities within N hops
  relatedTo(entityId, maxHops = 2) {
    const visited = new Set();
    const result = [];
    
    const traverse = (id, depth) => {
      if (depth > maxHops || visited.has(id)) return;
      visited.add(id);
      
      // Outgoing relationships
      const outgoing = this.bySubject.get(id) || [];
      for (const triple of outgoing) {
        result.push({ ...triple, direction: 'outgoing', distance: depth });
        traverse(triple.object, depth + 1);
      }
      
      // Incoming relationships
      const incoming = this.byObject.get(id) || [];
      for (const triple of incoming) {
        result.push({ ...triple, direction: 'incoming', distance: depth });
        traverse(triple.subject, depth + 1);
      }
    };
    
    traverse(entityId, 1);
    return result;
  }

  // Find path between two entities
  findPath(fromId, toId, maxDepth = 5) {
    const queue = [[fromId]];
    const visited = new Set([fromId]);
    
    while (queue.length > 0) {
      const path = queue.shift();
      const current = path[path.length - 1];
      
      if (current === toId) return path;
      if (path.length >= maxDepth) continue;
      
      const neighbors = this.getNeighbors(current);
      for (const neighbor of neighbors) {
        if (!visited.has(neighbor)) {
          visited.add(neighbor);
          queue.push([...path, neighbor]);
        }
      }
    }
    
    return null;  // No path found
  }

  // Query by pattern
  query(pattern) {
    // pattern: { subject?: string, predicate?: string, object?: string }
    return this.triples.filter(t => {
      if (pattern.subject && t.subject !== pattern.subject) return false;
      if (pattern.predicate && t.predicate !== pattern.predicate) return false;
      if (pattern.object && t.object !== pattern.object) return false;
      return true;
    });
  }
}
```

---

## Part 2: Learning and Documentation

### 2.1 Learning Log

Append-only log of everything the agent learns:

```markdown
<!-- /Memory/LearningLog.md -->

# MoltAgent Learning Log

## 2026-02-03

### 15:42 - Learned: John leads Q3 Campaign
- **Source:** Conversation with @sarah
- **Confidence:** High
- **Created:** [[John Smith]], [[Q3 Campaign]]
- **Relationship:** John Smith --leads--> Q3 Campaign

### 14:20 - Updated: Q3 Campaign budget
- **Source:** @finance_team in #budgets channel
- **Previous:** Unknown
- **New value:** ~€50,000 (estimated)
- **Confidence:** Medium (no official document)

### 10:05 - Uncertainty: Remote work policy
- **Question asked:** "What's the current remote work policy?"
- **Found:** Document from 2019 (3 days/week)
- **Concern:** Policy may have changed
- **Action:** Created verification request for @hr

---

## 2026-02-02

### 16:30 - Learned: Sarah Chen is CMO
- **Source:** Email signature in forwarded message
- **Confidence:** High
- **Created:** [[Sarah Chen]]
```

### 2.2 Auto-Documentation Triggers

```javascript
class KnowledgeDocumentor {
  constructor(knowledgeStore, learningLog) {
    this.store = knowledgeStore;
    this.log = learningLog;
  }

  // Trigger: Agent receives new information
  async onNewInformation(info) {
    const { content, source, context } = info;
    
    // Extract entities and relationships
    const entities = await this.extractEntities(content);
    const relationships = await this.extractRelationships(content, entities);
    
    for (const entity of entities) {
      // Check if we already know this
      const existing = await this.store.find(entity.name);
      
      if (existing) {
        // Update existing knowledge
        await this.updateKnowledge(existing, entity, source);
      } else {
        // Create new knowledge item
        await this.createKnowledge(entity, source);
      }
    }
    
    // Record relationships
    for (const rel of relationships) {
      await this.store.addRelationship(rel);
    }
    
    // Log the learning
    await this.log.append({
      timestamp: new Date(),
      type: 'learned',
      entities: entities.map(e => e.name),
      relationships: relationships.length,
      source: source,
      confidence: this.assessConfidence(source)
    });
  }

  // Trigger: Agent is uncertain
  async onUncertainty(query, context) {
    await this.log.append({
      timestamp: new Date(),
      type: 'uncertainty',
      query: query,
      context: context,
      action: 'flagged_for_verification'
    });
    
    // Create verification request
    await this.createVerificationRequest(query, context);
  }

  // Trigger: Agent notices contradiction
  async onContradiction(existing, new_info, source) {
    await this.log.append({
      timestamp: new Date(),
      type: 'contradiction',
      existing: existing,
      new_info: new_info,
      source: source,
      action: 'flagged_as_disputed'
    });
    
    // Flag both as disputed
    await this.store.flagDisputed(existing.id);
    
    // Create Deck card for resolution
    await this.createDisputeCard(existing, new_info, source);
  }

  assessConfidence(source) {
    // Heuristics for confidence level
    if (source.type === 'direct_statement' && source.verified_user) {
      return 'high';
    }
    if (source.type === 'document' && source.official) {
      return 'high';
    }
    if (source.type === 'inference') {
      return 'low';
    }
    return 'medium';
  }
}
```

### 2.3 Entity Extraction (Simple Version)

```javascript
// Poor man's entity extraction - no ML required
function extractEntitiesSimple(text) {
  const entities = [];
  
  // Pattern: "X is the Y" / "X is Y"
  const rolePatterns = [
    /([A-Z][a-z]+ [A-Z][a-z]+) is (?:the )?(\w+ ?\w*)/g,
    /([A-Z][a-z]+ [A-Z][a-z]+), (?:the )?(\w+ ?\w*)/g,
  ];
  
  for (const pattern of rolePatterns) {
    let match;
    while ((match = pattern.exec(text)) !== null) {
      entities.push({
        name: match[1],
        type: 'person',
        attributes: { role: match[2] }
      });
    }
  }
  
  // Pattern: Capitalized phrases (likely names/projects)
  const capitalizedPattern = /\b([A-Z][a-z]+ (?:[A-Z][a-z]+ ?)+)\b/g;
  let match;
  while ((match = capitalizedPattern.exec(text)) !== null) {
    const name = match[1].trim();
    if (!entities.find(e => e.name === name)) {
      entities.push({
        name: name,
        type: 'unknown',
        needs_classification: true
      });
    }
  }
  
  // Pattern: Email addresses
  const emailPattern = /\b([a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,})\b/g;
  while ((match = emailPattern.exec(text)) !== null) {
    entities.push({
      name: match[1],
      type: 'email',
      attributes: { email: match[1] }
    });
  }
  
  return entities;
}

// Relationship extraction
function extractRelationshipsSimple(text, entities) {
  const relationships = [];
  
  const patterns = [
    { regex: /([A-Z][a-z]+ [A-Z][a-z]+) reports to ([A-Z][a-z]+ [A-Z][a-z]+)/gi, pred: 'reports_to' },
    { regex: /([A-Z][a-z]+ [A-Z][a-z]+) leads (?:the )?([A-Z][a-z]+ ?\w*)/gi, pred: 'leads' },
    { regex: /([A-Z][a-z]+ [A-Z][a-z]+) works (?:in|at|for) (?:the )?([A-Z][a-z]+ ?\w*)/gi, pred: 'works_in' },
    { regex: /([A-Z][a-z]+ [A-Z][a-z]+) manages ([A-Z][a-z]+ [A-Z][a-z]+)/gi, pred: 'manages' },
    { regex: /([A-Z][a-z]+ ?\w*) (?:has a )?budget of ([€$£]\d[\d,]*)/gi, pred: 'has_budget' },
  ];
  
  for (const { regex, pred } of patterns) {
    let match;
    while ((match = regex.exec(text)) !== null) {
      relationships.push({
        subject: match[1],
        predicate: pred,
        object: match[2]
      });
    }
  }
  
  return relationships;
}
```

---

## Part 3: Freshness and Verification

### 3.1 Freshness Checker

Runs on heartbeat (local, free):

```javascript
class FreshnessChecker {
  constructor(knowledgeStore, deckClient, config) {
    this.store = knowledgeStore;
    this.deck = deckClient;
    this.config = config;
  }

  async checkAllKnowledge() {
    const items = await this.store.getAllItems();
    const now = Date.now();
    const flagged = [];
    
    for (const item of items) {
      const age = this.daysSince(item.verified || item.created);
      const threshold = item.decay_days || this.config.defaultDecayDays;
      
      if (age > threshold && !item.needs_verification) {
        // Mark as stale
        await this.store.update(item.id, {
          needs_verification: true,
          flagged_stale_at: new Date().toISOString()
        });
        
        // Create Deck card
        await this.createVerificationCard(item, age);
        flagged.push(item);
      }
    }
    
    // Log check
    await this.logCheck(items.length, flagged.length);
    
    return flagged;
  }

  async createVerificationCard(item, age) {
    // Check if card already exists
    const existingCards = await this.deck.searchCards({
      board: this.config.knowledgeBoardId,
      title: `Verify: ${item.title}`
    });
    
    if (existingCards.length > 0) {
      return;  // Don't duplicate
    }
    
    await this.deck.createCard({
      boardId: this.config.knowledgeBoardId,
      stackId: this.config.staleStackId,
      title: `Verify: ${item.title}`,
      description: this.buildVerificationDescription(item, age),
      dueDate: this.addDays(new Date(), 7),
      assignedUsers: item.verified_by ? [item.verified_by] : []
    });
  }

  buildVerificationDescription(item, age) {
    return `## Knowledge Verification Request

**Item:** ${item.title}
**Type:** ${item.type}
**Last verified:** ${age} days ago
**Verified by:** ${item.verified_by || 'Unknown'}
**Confidence:** ${item.confidence}

### Current Information

${this.summarizeItem(item)}

### Please Confirm

1. Is this information still accurate?
2. If not, what has changed?
3. Who can provide updated information?

---
*This card was auto-generated by MoltAgent's freshness checker.*
*Path: ${item.path}*`;
  }

  daysSince(dateStr) {
    if (!dateStr) return Infinity;
    const date = new Date(dateStr);
    const now = new Date();
    return Math.floor((now - date) / (1000 * 60 * 60 * 24));
  }

  addDays(date, days) {
    const result = new Date(date);
    result.setDate(result.getDate() + days);
    return result;
  }
}
```

### 3.2 NC Deck Board Structure

```javascript
// Setup script for Knowledge Board
async function setupKnowledgeBoard(deckClient) {
  // Create board
  const board = await deckClient.createBoard({
    title: 'MoltAgent Knowledge',
    color: '0082c9'  // NC blue
  });
  
  // Create stacks
  const stacks = [
    { title: '✓ Verified', order: 0 },
    { title: '? Uncertain', order: 1 },
    { title: '⚠️ Stale', order: 2 },
    { title: '✗ Disputed', order: 3 },
    { title: '📋 Awaiting Response', order: 4 }
  ];
  
  const stackIds = {};
  for (const stack of stacks) {
    const created = await deckClient.createStack({
      boardId: board.id,
      ...stack
    });
    stackIds[stack.title] = created.id;
  }
  
  return { board, stackIds };
}
```

### 3.3 Verification Flow

```
┌─────────────────┐
│ Knowledge Item  │
│ (verified)      │
└────────┬────────┘
         │
         │ Time passes (> decay_days)
         ▼
┌─────────────────┐
│ Freshness Check │ ◄─── Runs on heartbeat
└────────┬────────┘
         │
         │ Creates Deck card
         ▼
┌─────────────────┐
│ ⚠️ Stale Stack  │
│ (Deck card)     │
│ Assigned to     │
│ last verifier   │
└────────┬────────┘
         │
         │ Human responds
         ▼
    ┌────┴────┐
    │         │
    ▼         ▼
┌───────┐ ┌───────────┐
│ Still │ │ Changed   │
│ Valid │ │ (update)  │
└───┬───┘ └─────┬─────┘
    │           │
    │           │ Agent updates knowledge
    │           │ Logs change
    │           │
    ▼           ▼
┌─────────────────┐
│ ✓ Verified      │
│ Reset decay     │
│ Increment       │
│ check_count     │
└─────────────────┘
```

### 3.4 Handling Verification Responses

```javascript
class VerificationHandler {
  constructor(deckClient, knowledgeStore, talkClient) {
    this.deck = deckClient;
    this.store = knowledgeStore;
    this.talk = talkClient;
  }

  // Called when a Deck card is moved or commented
  async onCardUpdate(event) {
    const card = event.card;
    
    // Check if it's a verification card
    if (!card.title.startsWith('Verify: ')) return;
    
    const itemTitle = card.title.replace('Verify: ', '');
    const item = await this.store.findByTitle(itemTitle);
    
    if (!item) return;
    
    // Card moved to Verified stack
    if (event.newStack === 'verified') {
      await this.confirmVerification(item, event.user);
    }
    
    // Card has new comment (possible update)
    if (event.type === 'comment') {
      await this.processComment(item, event.comment, event.user);
    }
  }

  async confirmVerification(item, user) {
    await this.store.update(item.id, {
      verified: new Date().toISOString(),
      verified_by: user,
      needs_verification: false,
      check_count: (item.check_count || 0) + 1
    });
    
    // Log
    await this.logVerification(item, user, 'confirmed');
  }

  async processComment(item, comment, user) {
    const text = comment.text.toLowerCase();
    
    // Check for update indicators
    const updatePatterns = [
      /changed to/i,
      /now is/i,
      /updated?/i,
      /no longer/i,
      /left the company/i,
      /new (role|position|title)/i
    ];
    
    if (updatePatterns.some(p => p.test(text))) {
      // Extract the update and ask for confirmation
      await this.proposeUpdate(item, comment, user);
    }
    
    // Check for confirmation
    if (/still (correct|accurate|valid|true)/i.test(text) || 
        /confirmed?/i.test(text)) {
      await this.confirmVerification(item, user);
    }
  }

  async proposeUpdate(item, comment, user) {
    // Ask the agent (via local LLM) to extract the update
    const extraction = await this.extractUpdate(item, comment.text);
    
    // Create a Talk message to confirm
    await this.talk.sendMessage({
      room: user.talkRoom,
      message: `Thanks @${user.name}! I understood the update as:\n\n` +
               `**Before:** ${extraction.before}\n` +
               `**After:** ${extraction.after}\n\n` +
               `Is this correct? Reply YES to confirm, or clarify if I misunderstood.`
    });
    
    // Store pending update
    await this.storePendingUpdate(item.id, extraction, user);
  }
}
```

---

## Part 4: Proactive Knowledge Gathering

### 4.1 Proactive Asker

```javascript
class ProactiveAsker {
  constructor(talkClient, deckClient, knowledgeStore, config) {
    this.talk = talkClient;
    this.deck = deckClient;
    this.store = knowledgeStore;
    this.config = config;
    this.pendingQuestions = new Map();
  }

  // Ask when uncertain during a task
  async askForClarification(topic, context, urgency = 'normal') {
    // Find the right person to ask
    const expert = await this.findExpert(topic);
    
    if (!expert) {
      // No expert found - create general question card
      return await this.createQuestionCard(topic, context, null);
    }
    
    // Rate limit: Don't spam the same person
    if (this.recentlyAsked(expert.id, topic)) {
      return { status: 'rate_limited', expert: expert.name };
    }
    
    // Send Talk message
    const message = this.buildQuestion(topic, context, urgency);
    await this.talk.sendMessage({
      room: expert.talkRoom || this.config.defaultRoom,
      message: message
    });
    
    // Track the question
    const questionId = this.generateQuestionId();
    await this.trackQuestion(questionId, topic, expert, context);
    
    // Create Deck card to track response
    await this.deck.createCard({
      boardId: this.config.knowledgeBoardId,
      stackId: this.config.awaitingResponseStackId,
      title: `Asked ${expert.name}: ${this.truncate(topic, 30)}`,
      description: `**Question:** ${message}\n\n**Asked:** ${new Date().toISOString()}\n**Context:** ${context}`,
      dueDate: this.addDays(new Date(), 3),
      assignedUsers: [expert.id]
    });
    
    return { status: 'asked', expert: expert.name, questionId };
  }

  async findExpert(topic) {
    // Strategy 1: Who verified related knowledge last?
    const relatedKnowledge = await this.store.search(topic);
    for (const item of relatedKnowledge) {
      if (item.verified_by) {
        const user = await this.store.findPerson(item.verified_by);
        if (user) return user;
      }
    }
    
    // Strategy 2: Who is connected to this topic?
    const relationships = await this.store.queryRelationships({
      object: topic
    });
    for (const rel of relationships) {
      if (rel.predicate === 'expert_in' || rel.predicate === 'works_on') {
        const user = await this.store.findById(rel.subject);
        if (user?.type === 'person') return user;
      }
    }
    
    // Strategy 3: Fall back to configured default
    if (this.config.defaultExpert) {
      return await this.store.findPerson(this.config.defaultExpert);
    }
    
    return null;
  }

  buildQuestion(topic, context, urgency) {
    const greeting = this.getTimeAppropriateGreeting();
    const urgencyPrefix = urgency === 'high' ? '🔴 ' : '';
    
    return `${greeting}! ${urgencyPrefix}Quick question about **${topic}**:\n\n` +
           `I'm working on: ${context}\n\n` +
           `Could you help me understand this? ` +
           `Even a quick "it's X" or "ask @someone" would be helpful! 🙏`;
  }

  getTimeAppropriateGreeting() {
    const hour = new Date().getHours();
    if (hour < 12) return 'Good morning';
    if (hour < 17) return 'Hi';
    return 'Hi';
  }

  recentlyAsked(userId, topic) {
    const key = `${userId}:${this.normalizeTitle(topic)}`;
    const lastAsked = this.pendingQuestions.get(key);
    if (!lastAsked) return false;
    
    const hoursSince = (Date.now() - lastAsked) / (1000 * 60 * 60);
    return hoursSince < this.config.minHoursBetweenQuestions;  // Default: 24
  }
}
```

### 4.2 Proactive Refresh

Periodically refresh high-value knowledge:

```javascript
class ProactiveRefresher {
  constructor(knowledgeStore, asker, config) {
    this.store = knowledgeStore;
    this.asker = asker;
    this.config = config;
  }

  async refreshCriticalKnowledge() {
    // Find knowledge that:
    // 1. Is frequently accessed (high value)
    // 2. Hasn't been verified recently
    // 3. Has medium confidence
    
    const candidates = await this.store.query({
      access_count: { $gt: 10 },
      confidence: { $in: ['medium', 'low'] },
      verified: { $lt: this.daysAgo(30) }
    });
    
    // Sort by access count (most valuable first)
    candidates.sort((a, b) => b.access_count - a.access_count);
    
    // Refresh top N (don't spam)
    const toRefresh = candidates.slice(0, this.config.maxProactiveRefreshPerDay);
    
    for (const item of toRefresh) {
      await this.initiateRefresh(item);
    }
    
    return toRefresh;
  }

  async initiateRefresh(item) {
    // Don't refresh if already pending
    if (item.needs_verification) return;
    
    // Ask the last verifier
    if (item.verified_by) {
      await this.asker.askForClarification(
        item.title,
        `Routine check - I use this info often and want to make sure it's still accurate`,
        'normal'
      );
    }
    
    // Mark as pending
    await this.store.update(item.id, {
      needs_verification: true,
      flagged_reason: 'proactive_refresh'
    });
  }
}
```

---

## Part 5: Context Bundles

### 5.1 Quantum-Inspired Context Retrieval

Instead of retrieving isolated facts, retrieve relationship clusters:

```javascript
class ContextBundler {
  constructor(knowledgeStore, relationshipGraph) {
    this.store = knowledgeStore;
    this.graph = relationshipGraph;
  }

  async getContextBundle(query, options = {}) {
    const maxHops = options.maxHops || 2;
    const maxTokens = options.maxTokens || 2000;
    
    // 1. Find primary matches
    const primary = await this.store.search(query);
    if (primary.length === 0) {
      return { 
        found: false, 
        suggestion: 'No knowledge found. Should I ask someone?' 
      };
    }
    
    // 2. Expand via relationships
    const expanded = new Set();
    const relationships = [];
    
    for (const item of primary) {
      expanded.add(item.id);
      
      const related = this.graph.relatedTo(item.id, maxHops);
      for (const rel of related) {
        relationships.push(rel);
        expanded.add(rel.subject);
        expanded.add(rel.object);
      }
    }
    
    // 3. Load expanded items
    const items = [];
    for (const id of expanded) {
      const item = await this.store.findById(id);
      if (item) items.push(item);
    }
    
    // 4. Get recent changes to any of these
    const changes = await this.getRecentChanges(Array.from(expanded));
    
    // 5. Calculate confidence
    const avgConfidence = this.calculateAverageConfidence(items);
    const hasStale = items.some(i => i.needs_verification);
    
    // 6. Build bundle
    return {
      found: true,
      primary: primary,
      related: items.filter(i => !primary.find(p => p.id === i.id)),
      relationships: relationships,
      recentChanges: changes,
      confidence: {
        average: avgConfidence,
        hasStale: hasStale,
        stalest: this.findStalest(items)
      },
      tokens: this.estimateTokens(items),
      warnings: this.generateWarnings(items, relationships)
    };
  }

  generateWarnings(items, relationships) {
    const warnings = [];
    
    // Check for stale items
    const stale = items.filter(i => i.needs_verification);
    if (stale.length > 0) {
      warnings.push({
        type: 'stale',
        message: `${stale.length} item(s) need verification`,
        items: stale.map(i => i.title)
      });
    }
    
    // Check for low confidence
    const lowConf = items.filter(i => i.confidence === 'low' || i.confidence === 'uncertain');
    if (lowConf.length > 0) {
      warnings.push({
        type: 'low_confidence',
        message: `${lowConf.length} item(s) have low confidence`,
        items: lowConf.map(i => i.title)
      });
    }
    
    // Check for disputed
    const disputed = items.filter(i => i.disputed);
    if (disputed.length > 0) {
      warnings.push({
        type: 'disputed',
        message: `${disputed.length} item(s) have conflicting information`,
        items: disputed.map(i => i.title)
      });
    }
    
    return warnings;
  }
}
```

### 5.2 Disambiguation

When a term could mean multiple things:

```javascript
class Disambiguator {
  constructor(knowledgeStore) {
    this.store = knowledgeStore;
  }

  async disambiguate(term, context) {
    // Find all possible matches
    const matches = await this.store.searchAll(term);
    
    if (matches.length === 0) {
      return { status: 'unknown', term };
    }
    
    if (matches.length === 1) {
      return { status: 'unique', match: matches[0] };
    }
    
    // Multiple matches - try to disambiguate via context
    if (context) {
      const scored = matches.map(match => ({
        match,
        score: this.contextScore(match, context)
      }));
      
      scored.sort((a, b) => b.score - a.score);
      
      // If clear winner (2x score of next), use it
      if (scored.length >= 2 && scored[0].score > scored[1].score * 2) {
        return { 
          status: 'disambiguated', 
          match: scored[0].match,
          confidence: 'high',
          alternatives: scored.slice(1).map(s => s.match)
        };
      }
      
      // If top match is significantly better
      if (scored[0].score > 0.5) {
        return {
          status: 'likely',
          match: scored[0].match,
          confidence: 'medium',
          alternatives: scored.slice(1).map(s => s.match)
        };
      }
    }
    
    // Can't disambiguate - return all options
    return {
      status: 'ambiguous',
      matches: matches,
      suggestion: `"${term}" could refer to: ${matches.map(m => m.title).join(', ')}. Which one?`
    };
  }

  contextScore(match, context) {
    let score = 0;
    const contextLower = context.toLowerCase();
    
    // Check type hints
    if (contextLower.includes('person') && match.type === 'person') score += 0.3;
    if (contextLower.includes('project') && match.type === 'project') score += 0.3;
    if (contextLower.includes('team') && match.type === 'concept') score += 0.3;
    
    // Check related terms mentioned
    for (const rel of match.related || []) {
      if (contextLower.includes(rel.target.toLowerCase())) {
        score += 0.2;
      }
    }
    
    // Check if any aliases match context
    for (const alias of match.aliases || []) {
      if (contextLower.includes(alias.toLowerCase())) {
        score += 0.3;
      }
    }
    
    return Math.min(score, 1.0);
  }
}
```

---

## Part 6: Propagation Rules

### 6.1 Change Propagation

When something changes, what else is affected?

```javascript
const PROPAGATION_RULES = {
  // When a person leaves
  person_leaves: {
    trigger: (item, change) => item.type === 'person' && change.field === 'status' && change.newValue === 'inactive',
    actions: [
      {
        type: 'invalidate',
        targets: ['role', 'extension', 'email', 'access_permissions'],
        reason: 'Person no longer at company'
      },
      {
        type: 'flag_review',
        query: { related_to: '$item.id', predicate: { $in: ['reports_to', 'led_by', 'owned_by'] } },
        reason: 'Successor may be needed'
      },
      {
        type: 'notify',
        targets: ['direct_reports', 'manager'],
        message: '$item.title has left the company. Please update any dependencies.'
      }
    ]
  },
  
  // When a project is cancelled
  project_cancelled: {
    trigger: (item, change) => item.type === 'project' && change.field === 'status' && change.newValue === 'cancelled',
    actions: [
      {
        type: 'invalidate',
        targets: ['timeline', 'budget_allocation', 'deliverables', 'milestones'],
        reason: 'Project cancelled'
      },
      {
        type: 'flag_review',
        query: { subject: '$item.id', predicate: 'depends_on' },
        reason: 'Dependent items may need replanning'
      }
    ]
  },
  
  // When a policy changes
  policy_updated: {
    trigger: (item, change) => item.type === 'policy' && change.field === 'content',
    actions: [
      {
        type: 'flag_review',
        query: { references: '$item.id' },
        reason: 'Referenced policy has changed'
      },
      {
        type: 'notify',
        targets: ['all_users'],
        message: 'Policy "$item.title" has been updated. Please review.',
        urgent: false
      }
    ]
  },
  
  // When org structure changes
  reports_to_changed: {
    trigger: (item, change) => item.type === 'person' && change.field === 'reports_to',
    actions: [
      {
        type: 'update_relationship',
        old: { subject: '$item.id', predicate: 'reports_to', object: '$change.oldValue' },
        new: { subject: '$item.id', predicate: 'reports_to', object: '$change.newValue' }
      },
      {
        type: 'flag_review',
        query: { subject: '$item.id', predicate: 'access_granted_by' },
        reason: 'Manager change may affect access permissions'
      }
    ]
  }
};

class PropagationEngine {
  constructor(knowledgeStore, rules) {
    this.store = knowledgeStore;
    this.rules = rules;
  }

  async processChange(item, change) {
    const triggered = [];
    
    for (const [ruleName, rule] of Object.entries(this.rules)) {
      if (rule.trigger(item, change)) {
        triggered.push(ruleName);
        await this.executeActions(item, change, rule.actions);
      }
    }
    
    // Log propagation
    if (triggered.length > 0) {
      await this.logPropagation(item, change, triggered);
    }
    
    return triggered;
  }

  async executeActions(item, change, actions) {
    for (const action of actions) {
      switch (action.type) {
        case 'invalidate':
          await this.invalidateFields(item, action.targets, action.reason);
          break;
        case 'flag_review':
          await this.flagForReview(item, action.query, action.reason);
          break;
        case 'notify':
          await this.sendNotifications(item, action.targets, action.message, action.urgent);
          break;
        case 'update_relationship':
          await this.updateRelationship(item, change, action.old, action.new);
          break;
      }
    }
  }
}
```

---

## Part 7: NC App Integration

### 7.1 NC Collective Integration (Optional)

Use NC Collective as a human-readable wiki alongside the structured knowledge:

```javascript
class CollectiveIntegration {
  constructor(collectiveClient, knowledgeStore) {
    this.collective = collectiveClient;
    this.store = knowledgeStore;
  }

  // Sync knowledge item to Collective page
  async syncToCollective(item) {
    const pagePath = this.getPagePath(item);
    const content = this.renderAsWiki(item);
    
    // Check if page exists
    const existing = await this.collective.getPage(pagePath);
    
    if (existing) {
      // Update if changed
      if (existing.content !== content) {
        await this.collective.updatePage(pagePath, {
          content,
          lastModified: new Date().toISOString(),
          modifiedBy: 'MoltAgent'
        });
      }
    } else {
      // Create new page
      await this.collective.createPage({
        path: pagePath,
        title: item.title,
        content,
        createdBy: 'MoltAgent'
      });
    }
  }

  getPagePath(item) {
    // Map knowledge types to Collective paths
    const typeMap = {
      person: 'People',
      project: 'Projects',
      policy: 'Policies',
      concept: 'Concepts'
    };
    
    const folder = typeMap[item.type] || 'Other';
    return `MoltAgent/${folder}/${this.slugify(item.title)}`;
  }

  renderAsWiki(item) {
    let content = `# ${item.title}\n\n`;
    
    // Metadata box
    content += `> **Type:** ${item.type}  \n`;
    content += `> **Confidence:** ${item.confidence}  \n`;
    content += `> **Last verified:** ${item.verified || 'Never'}  \n`;
    content += `> **By:** ${item.verified_by || 'Unknown'}  \n\n`;
    
    // Main content (from markdown body)
    content += item.content + '\n\n';
    
    // Relationships section
    if (item.related && item.related.length > 0) {
      content += `## Relationships\n\n`;
      for (const rel of item.related) {
        content += `- **${rel.type}:** [[${rel.target}]]\n`;
      }
    }
    
    // Footer
    content += `\n---\n*This page is maintained by MoltAgent. `;
    content += `Last sync: ${new Date().toISOString()}*\n`;
    
    return content;
  }

  // Watch for human edits in Collective and sync back
  async onCollectiveEdit(pagePath, newContent, editor) {
    if (editor === 'MoltAgent') return;  // Ignore own edits
    
    const item = await this.findItemByPath(pagePath);
    if (!item) return;
    
    // Parse changes from wiki format
    const changes = this.parseWikiChanges(item, newContent);
    
    // Apply changes to knowledge store
    for (const change of changes) {
      await this.store.update(item.id, {
        [change.field]: change.value,
        verified: new Date().toISOString(),
        verified_by: editor,
        source: 'collective_edit'
      });
    }
    
    // Log the sync
    await this.logCollectiveSync(item, changes, editor);
  }
}
```

### 7.2 NC Talk Bot Commands

```javascript
// Knowledge-related Talk commands
const KNOWLEDGE_COMMANDS = {
  '/know': {
    description: 'Query knowledge about a topic',
    handler: async (args, context) => {
      const bundle = await contextBundler.getContextBundle(args.join(' '));
      
      if (!bundle.found) {
        return `I don't have any knowledge about "${args.join(' ')}". Should I ask someone?`;
      }
      
      let response = `Here's what I know about **${args.join(' ')}**:\n\n`;
      
      for (const item of bundle.primary) {
        response += `**${item.title}** (${item.confidence} confidence)\n`;
        response += `${item.summary || item.content.slice(0, 200)}...\n\n`;
      }
      
      if (bundle.warnings.length > 0) {
        response += `⚠️ *Note: ${bundle.warnings.map(w => w.message).join('; ')}*`;
      }
      
      return response;
    }
  },
  
  '/learn': {
    description: 'Teach the agent something new',
    handler: async (args, context) => {
      const text = args.join(' ');
      await knowledgeDocumentor.onNewInformation({
        content: text,
        source: { type: 'direct_statement', user: context.user, verified_user: true },
        context: context
      });
      
      return `Got it! I've recorded this and will remember it. ` +
             `You can verify or update my knowledge anytime with /know.`;
    }
  },
  
  '/verify': {
    description: 'Verify or update knowledge',
    handler: async (args, context) => {
      const topic = args.join(' ');
      const items = await knowledgeStore.search(topic);
      
      if (items.length === 0) {
        return `I don't have any knowledge about "${topic}" to verify.`;
      }
      
      // Create verification card
      for (const item of items.slice(0, 3)) {
        await deckClient.createCard({
          boardId: config.knowledgeBoardId,
          stackId: config.uncertainStackId,
          title: `Verify: ${item.title}`,
          description: `Verification requested by @${context.user}`,
          assignedUsers: [context.user]
        });
      }
      
      return `I've created verification cards for ${items.length} item(s). ` +
             `Check the MoltAgent Knowledge board in Deck.`;
    }
  },
  
  '/forget': {
    description: 'Remove knowledge (requires confirmation)',
    handler: async (args, context) => {
      const topic = args.join(' ');
      const items = await knowledgeStore.search(topic);
      
      if (items.length === 0) {
        return `I don't have any knowledge about "${topic}".`;
      }
      
      // Request confirmation
      return `Found ${items.length} item(s) matching "${topic}":\n` +
             items.map(i => `- ${i.title}`).join('\n') + `\n\n` +
             `Reply "/forget-confirm ${items[0].id}" to delete, or be more specific.`;
    }
  }
};
```

---

## Part 8: Implementation Phases

### Phase 1: Foundation (1-2 weeks)

**Goal:** Basic knowledge storage with markdown files

**Tasks:**
- [ ] Create `/Memory/Knowledge/` directory structure
- [ ] Implement KnowledgeStore class (CRUD operations)
- [ ] Implement markdown parser with YAML frontmatter
- [ ] Implement wikilink extraction and resolution
- [ ] Create `LearningLog.md` append function
- [ ] Basic Talk commands: `/know`, `/learn`

**Deliverable:** Agent can store and retrieve knowledge items

### Phase 2: Relationships (1-2 weeks)

**Goal:** Traversable knowledge graph

**Tasks:**
- [ ] Implement `relationships.json` storage
- [ ] Implement RelationshipGraph class
- [ ] Add relationship queries (relatedTo, findPath)
- [ ] Simple entity/relationship extraction from text
- [ ] Context bundle generation

**Deliverable:** Agent can follow relationships to gather context

### Phase 3: Verification (1-2 weeks)

**Goal:** Knowledge freshness tracking

**Tasks:**
- [ ] Set up NC Deck board ("MoltAgent Knowledge")
- [ ] Implement FreshnessChecker (runs on heartbeat)
- [ ] Create verification cards automatically
- [ ] Handle card movements (verified/disputed)
- [ ] Process comments for updates

**Deliverable:** Stale knowledge automatically flagged for review

### Phase 4: Proactive Gathering (2-3 weeks)

**Goal:** Agent asks when uncertain

**Tasks:**
- [ ] Implement ProactiveAsker
- [ ] Expert finding algorithm
- [ ] Talk integration for questions
- [ ] Rate limiting (don't spam)
- [ ] Track pending questions

**Deliverable:** Agent proactively seeks verification

### Phase 5: Propagation (1-2 weeks)

**Goal:** Changes ripple through knowledge

**Tasks:**
- [ ] Define propagation rules
- [ ] Implement PropagationEngine
- [ ] Test with common scenarios (person leaves, project cancelled)
- [ ] Notification integration

**Deliverable:** Dependent knowledge flagged when source changes

### Phase 6: Polish (1-2 weeks)

**Goal:** Integration and UX

**Tasks:**
- [ ] NC Collective integration (optional)
- [ ] Full Talk command set
- [ ] Disambiguation handling
- [ ] Confidence-weighted responses
- [ ] Documentation and testing

**Deliverable:** Complete knowledge system

---

## Appendix A: API Reference

### NC Deck API Patterns

```javascript
// Create board
POST /index.php/apps/deck/api/v1.0/boards
{ "title": "MoltAgent Knowledge", "color": "0082c9" }

// Create stack
POST /index.php/apps/deck/api/v1.0/boards/{boardId}/stacks
{ "title": "Verified", "order": 0 }

// Create card
POST /index.php/apps/deck/api/v1.0/boards/{boardId}/stacks/{stackId}/cards
{ "title": "Verify: John Smith", "description": "...", "duedate": "2026-02-10" }

// Move card
PUT /index.php/apps/deck/api/v1.0/boards/{boardId}/stacks/{stackId}/cards/{cardId}/reorder
{ "stackId": newStackId, "order": 0 }

// Add comment
POST /index.php/apps/deck/api/v1.0/cards/{cardId}/comments
{ "message": "Still valid as of today" }
```

### NC Talk API Patterns

```javascript
// Send message
POST /ocs/v2.php/apps/spreed/api/v1/chat/{token}
{ "message": "Hi! Quick question about..." }

// Get messages
GET /ocs/v2.php/apps/spreed/api/v1/chat/{token}?lookIntoFuture=0&limit=50

// Mention user
{ "message": "Hi @{user-id}! ..." }
```

### NC Files API Patterns

```javascript
// Read file (WebDAV)
GET /remote.php/dav/files/{user}/{path}

// Write file (WebDAV)
PUT /remote.php/dav/files/{user}/{path}
Content-Type: text/markdown

// List directory (WebDAV PROPFIND)
PROPFIND /remote.php/dav/files/{user}/{path}
Depth: 1
```

---

## Appendix B: Example Knowledge Items

### Person

```markdown
---
id: person_sarah_chen
type: person
title: Sarah Chen
aliases: [Sarah, sarah.chen@company.com, CMO]
created: 2026-01-10T09:00:00Z
verified: 2026-02-01T11:30:00Z
verified_by: john
confidence: high
decay_days: 90
related:
  - type: role
    target: "[[CMO]]"
  - type: manages
    target: "[[Marketing Department]]"
  - type: manages
    target: "[[John Smith]]"
---

# Sarah Chen

**Role:** Chief Marketing Officer (CMO)
**Department:** [[Marketing Department]]
**Location:** [[San Francisco Office]]
**Email:** sarah.chen@company.com

## Direct Reports
- [[John Smith]] - Marketing Director
- [[Emily Wong]] - Brand Manager

## Notes
- Key decision maker for marketing budget
- Prefers data-driven proposals
- Weekly 1:1 on Mondays at 10am PT
```

### Project

```markdown
---
id: project_q3_campaign
type: project
title: Q3 Campaign
aliases: [Q3, Q3 Marketing Campaign, Summer Campaign]
created: 2026-01-20T09:00:00Z
verified: 2026-01-28T14:22:00Z
verified_by: sarah
confidence: medium
decay_days: 30
related:
  - type: led_by
    target: "[[John Smith]]"
  - type: belongs_to
    target: "[[Marketing Department]]"
  - type: has_budget
    target: "€50,000"
---

# Q3 Campaign

**Status:** Planning
**Lead:** [[John Smith]]
**Department:** [[Marketing Department]]
**Budget:** ~€50,000 (estimated, needs confirmation)
**Timeline:** July - September 2026

## Objectives
- Increase brand awareness in EU market
- Support product launch in August
- Generate 500 qualified leads

## Key Milestones
- [ ] Creative brief approval (Feb 15)
- [ ] Agency selection (Mar 1)
- [ ] Campaign launch (Jul 1)

## Dependencies
- Depends on: [[Product Launch]] timing
- Blocks: [[Q4 Planning]]
```

---

## Appendix C: Configuration Template

```yaml
# /Memory/KnowledgeConfig.yaml

# General settings
knowledge:
  root_path: "/moltagent/Memory/Knowledge"
  learning_log: "/moltagent/Memory/LearningLog.md"
  relationships_file: "/moltagent/Memory/relationships.json"
  default_decay_days: 90

# Confidence levels
confidence:
  high:
    decay_days: 90
    color: "#22c55e"
  medium:
    decay_days: 60
    color: "#eab308"
  low:
    decay_days: 30
    color: "#f97316"
  uncertain:
    decay_days: 7
    color: "#ef4444"
    auto_flag: true

# NC Deck integration
deck:
  board_name: "MoltAgent Knowledge"
  stacks:
    verified: "✓ Verified"
    uncertain: "? Uncertain"
    stale: "⚠️ Stale"
    disputed: "✗ Disputed"
    awaiting: "📋 Awaiting Response"

# Proactive asking
proactive:
  enabled: true
  min_hours_between_questions: 24
  max_questions_per_day: 5
  default_expert: "admin"
  default_room: "moltagent-knowledge"

# Freshness checking
freshness:
  enabled: true
  check_on_heartbeat: true
  max_flags_per_check: 10

# Propagation
propagation:
  enabled: true
  notify_on_propagation: true

# NC Collective (optional)
collective:
  enabled: false
  sync_to_wiki: true
  root_path: "MoltAgent"
```

---

*MoltAgent Knowledge System: Where knowledge stays alive because the agent cares for it.*
