# MoltAgent: Three-Tier LLM Architecture

**The Cheap & Fast Optimization**

---

## The Insight

From the OpenClaw community (emphasis mine):

> "One message in OpenClaw is not one model call... **5 to 10 calls easily**."
> 
> "A **boring agent is a cheap agent**, and boring is good."
> 
> "Treat OpenClaw like an **employee, not an app**."

MoltAgent was already designed with the employment model. Now we optimize for cost.

---

## Three-Tier LLM Strategy

```
┌─────────────────────────────────────────────────────────────────────────┐
│                          MOLTAGENT LLM TIERS                            │
├─────────────────────────────────────────────────────────────────────────┤
│                                                                         │
│   TIER 1: NC ASSISTANT           TIER 2: OLLAMA           TIER 3: CLAUDE│
│   ═══════════════════           ═════════════           ═══════════════ │
│   Cost: FREE                    Cost: ~€15/mo fixed     Cost: $/token   │
│   Quality: Basic                Quality: Good           Quality: Best   │
│   Location: Your NC             Location: Your VM       Location: Cloud │
│                                                                         │
│   • Summarize                   • Credential ops        • Complex reason│
│   • Extract topics              • Untrusted files       • Creative write│
│   • Generate headlines          • Sensitive docs        • Client-facing │
│   • Proofread/grammar           • Bulk processing       • Nuanced tasks │
│   • Simple translations         • Default fallback                      │
│   • Tone adjustment                                                     │
│                                                                         │
│   ↓ Fallback                    ↓ Fallback              ↓ No fallback   │
│   Ollama                        Claude (if allowed)     (Quality-critical)│
│                                                                         │
└─────────────────────────────────────────────────────────────────────────┘
```

---

## Decision Flow

```
                         ┌─────────────────┐
                         │ INCOMING TASK   │
                         └────────┬────────┘
                                  │
                    ┌─────────────▼─────────────┐
                    │ Contains credentials or   │
                    │ secrets in the prompt?    │
                    └─────────────┬─────────────┘
                           │YES         │NO
                           ▼            ▼
                    ┌──────────┐  ┌─────────────────────┐
                    │ OLLAMA   │  │ Untrusted file/     │
                    │ (Tier 2) │  │ email/web content?  │
                    └──────────┘  └─────────┬───────────┘
                                     │YES         │NO
                                     ▼            ▼
                              ┌──────────┐  ┌─────────────────────┐
                              │ OLLAMA   │  │ Simple task?        │
                              │ (Tier 2) │  │ (summary/tag/proof) │
                              └──────────┘  └─────────┬───────────┘
                                               │YES         │NO
                                               ▼            ▼
                                        ┌────────────┐ ┌────────────────────┐
                                        │NC ASSISTANT│ │ Quality critical?  │
                                        │ (Tier 1)   │ │ (client/complex)   │
                                        └────────────┘ └─────────┬──────────┘
                                                          │YES         │NO
                                                          ▼            ▼
                                                   ┌──────────┐  ┌──────────┐
                                                   │ CLAUDE   │  │ OLLAMA   │
                                                   │ (Tier 3) │  │ (Tier 2) │
                                                   └──────────┘  └──────────┘
```

---

## Tier Details

### Tier 1: Nextcloud Assistant (FREE)

**What it is:** Built-in AI capabilities in your Nextcloud instance via the Task Processing API.

**API Endpoint:** `/ocs/v2.php/taskprocessing/schedule`

**Available Tasks:**
| Task Type | Purpose |
|-----------|---------|
| `core:text2text:summary` | Summarize text |
| `core:text2text:headline` | Generate headline/title |
| `core:text2text:topics` | Extract keywords/tags |
| `core:text2text:proofread` | Grammar/spelling check |
| `core:text2text:simplification` | Make text simpler |
| `core:text2text:changetone` | Formal ↔ casual |
| `core:text2text:translate` | Language translation |
| `core:text2text` | Free-form prompt |

**Best For:**
- Summarizing documents
- Generating email subject lines
- Auto-tagging files
- Quick proofreading
- Simple translations
- Non-critical Q&A

**Limitations:**
- Asynchronous (2-30 second latency)
- Quality depends on NC backend config
- No streaming
- Limited reasoning capability

---

### Tier 2: Local Ollama (FIXED COST)

**What it is:** Self-hosted LLM on your Ollama VM with air-gapped network.

**Cost:** ~€15/month (VM) regardless of usage

**Model:** DeepSeek-R1:8B or similar

**Best For:**
- ANY operation involving credentials
- Processing untrusted files (prompt injection isolation)
- Sensitive document analysis
- Bulk operations (pay once, run many)
- Default fallback for everything

**Why It's Special:**
- **Secrets never leave your infrastructure**
- **Prompt injection attacks can't exfiltrate**
- **No per-token cost**
- **Predictable monthly spend**

---

### Tier 3: Claude API (VARIABLE COST)

**What it is:** Anthropic's Claude API for premium quality.

**Cost:** ~$3/million input tokens, ~$15/million output tokens

**Model:** claude-sonnet-4-20250514 (or latest)

**Best For:**
- Complex multi-step reasoning
- Client-facing content
- Creative writing requiring nuance
- Tasks where quality directly impacts outcomes
- Anything that requires the best available model

**Cost Controls (MANDATORY):**
```javascript
const CLAUDE_LIMITS = {
  maxTokensPerRequest: 4000,
  dailyBudget: 1.00,        // USD
  warningAt: 0.75,          // 75% of budget
  requireApproval: ['send_email', 'publish', 'client_facing']
};
```

---

## Implementation

### Config Structure

```json
{
  "llm": {
    "tiers": {
      "ncAssistant": {
        "enabled": true,
        "url": "https://nx89136.your-storageshare.de",
        "timeout": 60000,
        "fallback": "ollama"
      },
      "ollama": {
        "enabled": true,
        "url": "http://ollama-vm:11434",
        "model": "deepseek-r1:8b",
        "fallback": null
      },
      "claude": {
        "enabled": true,
        "credentialName": "claude-api-key",
        "model": "claude-sonnet-4-20250514",
        "dailyBudget": 1.00,
        "fallback": "ollama"
      }
    },
    "routing": {
      "credentialSensitive": "ollama",
      "untrustedContent": "ollama",
      "simpleTasks": "ncAssistant",
      "qualityCritical": "claude",
      "default": "ollama"
    }
  }
}
```

### Router Implementation

```javascript
class ThreeTierRouter {
  constructor(ncAssistant, ollama, claude, costTracker) {
    this.tiers = { ncAssistant, ollama, claude };
    this.costTracker = costTracker;
  }

  async route(task, content, options = {}) {
    // 1. Security overrides everything
    if (this.isSensitive(content)) {
      return this.execute('ollama', task, content);
    }

    // 2. Untrusted content stays local
    if (this.isUntrusted(content)) {
      return this.execute('ollama', task, content);
    }

    // 3. Try free tier for simple tasks
    if (this.isSimpleTask(task) && !options.highQuality) {
      try {
        return await this.execute('ncAssistant', task, content);
      } catch (e) {
        console.log(`NC Assistant failed: ${e.message}, falling back`);
        return this.execute('ollama', task, content);
      }
    }

    // 4. Quality-critical goes to Claude (with budget check)
    if (options.highQuality || options.clientFacing) {
      if (await this.costTracker.canSpend('claude')) {
        return this.execute('claude', task, content);
      } else {
        console.log('Claude budget exceeded, using Ollama');
        return this.execute('ollama', task, content);
      }
    }

    // 5. Default: local Ollama
    return this.execute('ollama', task, content);
  }

  async execute(tier, task, content) {
    const start = Date.now();
    
    try {
      const result = await this.tiers[tier].generate(task, content);
      
      await this.costTracker.record({
        tier,
        task,
        duration: Date.now() - start,
        success: true
      });
      
      return result;
    } catch (e) {
      await this.costTracker.record({
        tier,
        task,
        duration: Date.now() - start,
        success: false,
        error: e.message
      });
      
      throw e;
    }
  }

  isSensitive(content) {
    const patterns = [
      /api[_-]?key/i, /password/i, /secret/i, /token/i,
      /bearer\s+\S+/i, /sk-[a-zA-Z0-9]{20,}/, /credential/i
    ];
    const str = typeof content === 'string' ? content : JSON.stringify(content);
    return patterns.some(p => p.test(str));
  }

  isUntrusted(content) {
    if (typeof content === 'object') {
      return content._untrusted || content._source === 'file' || content._source === 'email';
    }
    return false;
  }

  isSimpleTask(task) {
    return ['summarize', 'headline', 'topics', 'proofread', 'simplify', 'translate', 'tone'].includes(task);
  }
}
```

---

## Cost Tracking

```javascript
class CostTracker {
  constructor(config) {
    this.config = config;
    this.daily = { claude: 0, calls: { ncAssistant: 0, ollama: 0, claude: 0 } };
    this.resetTime = this.getNextMidnight();
  }

  async canSpend(tier) {
    this.checkReset();
    
    if (tier === 'claude') {
      return this.daily.claude < this.config.llm.tiers.claude.dailyBudget;
    }
    return true; // NC Assistant and Ollama are always available
  }

  async record(entry) {
    this.checkReset();
    this.daily.calls[entry.tier]++;
    
    if (entry.tier === 'claude' && entry.success) {
      // Estimate cost (actual would come from API response)
      const estimatedCost = 0.01; // ~$0.01 per call estimate
      this.daily.claude += estimatedCost;
    }

    // Persist to NC folder for audit
    await this.persistLog(entry);
  }

  checkReset() {
    if (Date.now() > this.resetTime) {
      this.saveDailySummary();
      this.daily = { claude: 0, calls: { ncAssistant: 0, ollama: 0, claude: 0 } };
      this.resetTime = this.getNextMidnight();
    }
  }

  async saveDailySummary() {
    const summary = {
      date: new Date().toISOString().split('T')[0],
      ...this.daily,
      totalCalls: Object.values(this.daily.calls).reduce((a, b) => a + b, 0)
    };
    
    // Save to /moltagent/Logs/cost-YYYY-MM-DD.json
    await ncFiles.writeFile(
      `/moltagent/Logs/cost-${summary.date}.json`,
      JSON.stringify(summary, null, 2)
    );
  }

  getDailyReport() {
    return {
      tier1_free: this.daily.calls.ncAssistant,
      tier2_fixed: this.daily.calls.ollama,
      tier3_variable: this.daily.calls.claude,
      tier3_spend: this.daily.claude,
      tier3_remaining: this.config.llm.tiers.claude.dailyBudget - this.daily.claude
    };
  }

  getNextMidnight() {
    const tomorrow = new Date();
    tomorrow.setDate(tomorrow.getDate() + 1);
    tomorrow.setHours(0, 0, 0, 0);
    return tomorrow.getTime();
  }
}
```

---

## Monthly Cost Projection

### Infrastructure (Fixed)
| Component | Monthly |
|-----------|---------|
| NC (Storage Share or CPX21) | €8-15 |
| MoltBot VM (CPX11) | €4 |
| Ollama VM (CPX31) | €15 |
| **Subtotal** | **€27-34** |

### API (Variable, with Three-Tier)
| Usage Pattern | Tier 3 Calls/Day | API Cost |
|---------------|------------------|----------|
| Careful | 5 | ~€5/mo |
| Moderate | 15 | ~€15/mo |
| Heavy | 30 | ~€30/mo |

### Total Monthly Range
| Profile | Infrastructure | API | **Total** |
|---------|---------------|-----|-----------|
| Minimal | €27 | €5 | **€32** |
| Typical | €30 | €15 | **€45** |
| Heavy | €34 | €30 | **€64** |

**Compare to:** Enterprise AI assistants at €20-50/user/month with zero sovereignty.

---

## Implementation Checklist

### Phase 1: NC Assistant (Tier 1)
- [ ] Test if Storage Share has Task Processing API
- [ ] Create NCAssistant client class
- [ ] Map common tasks to NC Assistant task types
- [ ] Test summary, headline, topics endpoints
- [ ] Add fallback to Ollama on failure

### Phase 2: Cost Tracking
- [ ] Implement CostTracker class
- [ ] Add daily budget limits for Claude
- [ ] Create daily cost log files
- [ ] Add budget warning notifications

### Phase 3: Router Update
- [ ] Implement ThreeTierRouter
- [ ] Update task classification logic
- [ ] Add security checks (credential detection)
- [ ] Add untrusted content marking

### Phase 4: Testing
- [ ] Test routing decisions are correct
- [ ] Verify no credentials sent to external APIs
- [ ] Confirm budget limits enforce
- [ ] Validate cost tracking accuracy

---

## Key Principles

From the Reddit wisdom, translated to MoltAgent:

| Principle | Implementation |
|-----------|----------------|
| "Set a mental ceiling" | Hard daily budget on Tier 3 |
| "Save expensive models for when quality matters" | Three-tier routing |
| "Autonomy is a cost multiplier" | No background thinking, command-driven only |
| "Tools return huge outputs" | Summarize tool outputs via Tier 1 before storing |
| "Context growth is sneaky" | Session-based, explicit memory writes |
| "Separate agents for experimenting" | Different permission levels via NC users |
| "Treat like employee, not app" | Permission boundaries, HITL, audit trails |

---

## The Boring Agent Manifesto

> A boring agent is a cheap agent.
> 
> MoltAgent doesn't think when you don't ask it to.  
> It doesn't browse when you haven't told it to browse.  
> It doesn't remember unless you say "remember this."  
> It doesn't spend money unless the task requires it.
> 
> It waits in its room until you bring work to it.  
> It uses the cheapest tool that gets the job done.  
> It tells you what it costs before it spends.  
> It stops at the budget you set.
> 
> Boring is predictable.  
> Predictable is trustworthy.  
> Trustworthy is what you want in an employee.

---

*Document Version: 0.1*  
*Last Updated: 2026-01-30*
