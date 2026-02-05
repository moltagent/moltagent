# MoltAgent Cost Optimization Specification

**Version:** 0.1  
**Status:** Draft  
**Context:** Based on real-world OpenClaw cost feedback

---

## The Cost Problem

From OpenClaw users:
> "One message in OpenClaw is not one model call... 5 to 10 calls easily."
> "I sent a one word prompt and it cost 20 cents"

MoltAgent must be **predictable** and **cheap by default**.

---

## Three-Tier LLM Strategy

### Tier 1: Free/Near-Free (Nextcloud AI)
- **Backend:** Nextcloud Assistant (built-in)
- **Cost:** â‚¬0 (included in NC hosting)
- **Use for:** Summaries, text extraction, simple Q&A, file tagging
- **Limitations:** Quality varies, slower, less capable

### Tier 2: Local Sovereign (Ollama)
- **Backend:** DeepSeek-R1:8B or similar
- **Cost:** ~â‚¬15/month fixed (VM cost only)
- **Use for:** Credential operations, untrusted file processing, bulk tasks
- **Limitations:** Quality limited by model size

### Tier 3: Premium External (Claude/GPT)
- **Backend:** Claude Sonnet, GPT-4o
- **Cost:** Pay-per-token (expensive)
- **Use for:** Complex reasoning, quality-critical writing, nuanced tasks
- **Limitations:** Data leaves infrastructure

---

## Routing Decision Tree

```
â”Œâ”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”
â”‚                    INCOMING TASK                                â”‚
â””â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”˜
                              â”‚
                              â–¼
                   â”Œâ”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”
                   â”‚ Contains secrets â”‚â”€â”€YESâ”€â”€â–º OLLAMA (Tier 2)
                   â”‚ or credentials?  â”‚         Never external
                   â””â”€â”€â”€â”€â”€â”€â”€â”€â”¬â”€â”€â”€â”€â”€â”€â”€â”€â”€â”˜
                            â”‚ NO
                            â–¼
                   â”Œâ”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”
                   â”‚ Processing       â”‚â”€â”€YESâ”€â”€â–º OLLAMA (Tier 2)
                   â”‚ untrusted files? â”‚         Prompt injection isolation
                   â””â”€â”€â”€â”€â”€â”€â”€â”€â”¬â”€â”€â”€â”€â”€â”€â”€â”€â”€â”˜
                            â”‚ NO
                            â–¼
                   â”Œâ”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”
                   â”‚ Simple task?     â”‚â”€â”€YESâ”€â”€â–º NC ASSISTANT (Tier 1)
                   â”‚ (summary, tag,   â”‚         Free, good enough
                   â”‚  extract, Q&A)   â”‚
                   â””â”€â”€â”€â”€â”€â”€â”€â”€â”¬â”€â”€â”€â”€â”€â”€â”€â”€â”€â”˜
                            â”‚ NO
                            â–¼
                   â”Œâ”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”
                   â”‚ Bulk operation?  â”‚â”€â”€YESâ”€â”€â–º OLLAMA (Tier 2)
                   â”‚ (>10 items)      â”‚         Fixed cost, no per-call
                   â””â”€â”€â”€â”€â”€â”€â”€â”€â”¬â”€â”€â”€â”€â”€â”€â”€â”€â”€â”˜
                            â”‚ NO
                            â–¼
                   â”Œâ”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”
                   â”‚ Quality-critical?â”‚â”€â”€YESâ”€â”€â–º CLAUDE (Tier 3)
                   â”‚ (client-facing,  â”‚         Worth the cost
                   â”‚  complex reason) â”‚
                   â””â”€â”€â”€â”€â”€â”€â”€â”€â”¬â”€â”€â”€â”€â”€â”€â”€â”€â”€â”˜
                            â”‚ NO
                            â–¼
                      OLLAMA (Tier 2)
                      Default: local
```

---

## Cost Controls

### Hard Limits

```javascript
const COST_LIMITS = {
  // Per-request limits
  maxTokensPerRequest: {
    tier1: Infinity,      // NC Assistant - free
    tier2: Infinity,      // Ollama - fixed cost
    tier3: 4000           // Claude - expensive
  },
  
  // Daily limits (Tier 3 only)
  dailyTier3Budget: {
    default: 1.00,        // $1/day default
    warning: 0.75,        // Alert at 75%
    hardStop: 1.00        // Stop at 100%
  },
  
  // Per-task limits
  maxCallsPerTask: {
    simple: 1,            // One-shot tasks
    moderate: 3,          // Tasks with follow-up
    complex: 5            // Multi-step reasoning
  }
};
```

### Budget Tracking

```javascript
class CostTracker {
  constructor() {
    this.dailySpend = 0;
    this.taskSpend = 0;
    this.callCount = 0;
  }
  
  async beforeCall(tier, estimatedTokens) {
    if (tier === 'tier3') {
      const estimatedCost = this.estimateCost(estimatedTokens);
      
      if (this.dailySpend + estimatedCost > COST_LIMITS.dailyTier3Budget.hardStop) {
        throw new BudgetExceeded('Daily Tier 3 budget exceeded');
      }
      
      if (this.dailySpend > COST_LIMITS.dailyTier3Budget.warning) {
        await this.alertUser('Approaching daily budget limit');
      }
    }
    
    this.callCount++;
    return true;
  }
  
  afterCall(tier, actualTokens, actualCost) {
    if (tier === 'tier3') {
      this.dailySpend += actualCost;
      this.taskSpend += actualCost;
    }
    
    auditLog('llm_call', {
      tier,
      tokens: actualTokens,
      cost: actualCost,
      dailyTotal: this.dailySpend
    });
  }
  
  estimateCost(tokens) {
    // Claude Sonnet pricing (approximate)
    const inputCostPer1K = 0.003;
    const outputCostPer1K = 0.015;
    return (tokens / 1000) * ((inputCostPer1K + outputCostPer1K) / 2);
  }
}
```

---

## Context Management (Anti-Bloat)

### The Problem
> "Context growth is the sneakiest cost leak"

### The Solution

```javascript
// 1. Summarize tool outputs immediately
async function executeToolWithSummary(tool, args) {
  const rawOutput = await tool.execute(args);
  
  // If output is large, summarize via Tier 1 (free)
  if (rawOutput.length > 1000) {
    const summary = await ncAssistant.summarize(rawOutput, {
      maxLength: 200,
      preserveKey: ['errors', 'counts', 'names']
    });
    
    return {
      summary: summary,
      fullOutputPath: await saveToFile(rawOutput) // Save full for audit
    };
  }
  
  return rawOutput;
}

// 2. Session-based context (not infinite)
const SESSION_CONFIG = {
  maxContextTokens: 8000,        // Hard limit
  warningThreshold: 6000,        // Start pruning
  pruneStrategy: 'oldest-first', // What to drop
  sessionTimeout: 3600000        // 1 hour, then fresh start
};

// 3. Memory is explicit, not automatic
// Nothing goes to /Memory/ without explicit instruction
// User must say "remember this" or equivalent
```

---

## Task Classification

Before routing, classify the task:

```javascript
const TASK_TYPES = {
  // Tier 1 candidates (NC Assistant)
  simple: [
    'summarize this document',
    'extract key points',
    'what does this say about X',
    'tag this file',
    'translate this text',
    'fix grammar'
  ],
  
  // Tier 2 candidates (Ollama)
  medium: [
    'process these files',
    'analyze this data',
    'draft a response to this email',
    'search my notes for X',
    'organize these items'
  ],
  
  // Tier 3 candidates (Claude)
  complex: [
    'write a proposal for',
    'analyze the implications of',
    'compare and contrast',
    'create a strategy for',
    'review this contract'
  ]
};

function classifyTask(userInput) {
  // Use local classifier (Ollama or pattern matching)
  // NOT external API for classification itself
  
  const input = userInput.toLowerCase();
  
  for (const [tier, patterns] of Object.entries(TASK_TYPES)) {
    if (patterns.some(p => input.includes(p))) {
      return tier;
    }
  }
  
  return 'medium'; // Default to local
}
```

---

## No Autonomous Spending

**Critical principle:** MoltAgent does not spend money without being asked.

```javascript
// DISABLED by default
const AUTONOMY_DEFAULTS = {
  backgroundThinking: false,     // No idle processing
  proactiveFollowUps: false,     // No unsolicited suggestions
  autoMemoryUpdates: false,      // No automatic memory writes
  autoRetries: false,            // Fail, don't retry with more tokens
  autoBrowsing: false,           // No spontaneous web access
  scheduledTasks: false          // No cron jobs hitting APIs
};

// Every API call must trace back to a user command
async function processCommand(command, user) {
  // Verify this is a real user command
  if (!command.initiatedBy || command.initiatedBy !== 'user') {
    throw new Error('All operations must be user-initiated');
  }
  
  // Track the chain
  const requestId = generateRequestId();
  
  auditLog('command_received', {
    requestId,
    user,
    command: command.text,
    timestamp: Date.now()
  });
  
  // ... process ...
}
```

---

## Monthly Cost Projections

### Infrastructure (Fixed)
| Component | Monthly Cost |
|-----------|--------------|
| NC Server (CPX21 or Storage Share) | â‚¬8-15 |
| MoltBot VM (CPX11) | â‚¬4 |
| Ollama VM (CPX31) | â‚¬15 |
| **Infrastructure Total** | **â‚¬27-34** |

### API Usage (Variable)
| Usage Pattern | Tier 3 Calls/Day | Monthly Cost |
|---------------|------------------|--------------|
| Minimal | 5 | ~â‚¬5 |
| Moderate | 20 | ~â‚¬20 |
| Heavy | 50 | ~â‚¬50 |

### Total Monthly Range
- **Careful user:** â‚¬32-39/month
- **Moderate user:** â‚¬47-54/month  
- **Heavy user:** â‚¬77-84/month

Compare to: Enterprise AI assistants at â‚¬20-30/user/month with no sovereignty.

---

## User-Facing Cost Transparency

```javascript
// After every Tier 3 call
async function reportCost(user, task, cost) {
  if (cost > 0.05) { // Only report if notable
    await notifyUser(user, {
      type: 'cost_notification',
      message: `Task completed. API cost: $${cost.toFixed(3)}. ` +
               `Daily total: $${tracker.dailySpend.toFixed(2)}/${COST_LIMITS.dailyTier3Budget.default}`
    });
  }
}

// Daily summary
async function dailyCostSummary(user) {
  const summary = {
    tier1Calls: tracker.tier1Count,  // Free
    tier2Calls: tracker.tier2Count,  // Fixed
    tier3Calls: tracker.tier3Count,  // Variable
    tier3Cost: tracker.dailySpend,
    topExpenses: tracker.getTopExpenses(3)
  };
  
  await saveToFile(`/moltagent/Logs/cost-${today}.json`, summary);
  
  if (user.preferences.dailyCostReport) {
    await notifyUser(user, { type: 'daily_cost_summary', data: summary });
  }
}
```

---

## Implementation Priority

1. **P0:** Budget hard stops (prevent runaway spending)
2. **P0:** Task classification and routing
3. **P1:** NC Assistant integration (Tier 1)
4. **P1:** Cost tracking and reporting
5. **P2:** Context pruning automation
6. **P2:** User cost preferences

---

## Key Insight

> "A boring agent is a cheap agent, and boring is good."

MoltAgent should be:
- **Predictable** â€” Same task, same cost, every time
- **Transparent** â€” User knows what they're paying for
- **Controllable** â€” Hard limits that actually stop
- **Cheap by default** â€” Expensive only when explicitly requested
