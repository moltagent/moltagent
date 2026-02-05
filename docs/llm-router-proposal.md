# LLM Router Implementation Proposal

**Based on:** moltagent-resilience-spec.md
**Status:** ✅ IMPLEMENTED - See [llm-router-guide.md](llm-router-guide.md)
**Date:** 2026-02-03

---

## Current State

The current `llm-router.js` is a placeholder that:
- Routes ALL requests to Ollama regardless of requirements
- Ignores `role` and `quality` parameters
- Has no fallback chain
- Has no rate limit tracking
- Has no budget enforcement

```javascript
// Current (line 55-56):
// For now, everything goes to Ollama (local, free, secure)
const result = await this._callOllama(task, content, options);
```

---

## Proposed Architecture

### 1. Role Definitions

Following the spec, we define these roles:

| Role | Purpose | Use Cases |
|------|---------|-----------|
| `sovereign` | Data never leaves infrastructure | Credentials, PII, sensitive content |
| `free` | Zero marginal cost | Heartbeat scans, routine checks |
| `value` | Good quality, low cost | Most tasks, comment classification |
| `premium` | Best quality | Critical tasks, complex writing |
| `specialized` | Task-specific | Reasoning (o1), transcription (Whisper) |

### 2. Provider Interface

Each provider implements a common interface:

```javascript
class Provider {
  constructor(config) {
    this.id = config.id;
    this.type = config.type;           // 'local' | 'api'
    this.endpoint = config.endpoint;
    this.model = config.model;
    this.costModel = config.costModel;
    this.rateLimits = config.rateLimits;
  }

  async generate(task, content, options) {
    // Returns: { result, tokens, headers }
  }

  async testConnection() {
    // Returns: { connected: boolean, error?: string }
  }
}
```

### 3. Built-in Provider Adapters

```
src/lib/llm/
├── providers/
│   ├── base-provider.js      # Abstract base class
│   ├── ollama-provider.js    # Local Ollama
│   ├── openai-provider.js    # OpenAI API (GPT-4, etc.)
│   ├── anthropic-provider.js # Claude API
│   ├── deepseek-provider.js  # DeepSeek API
│   ├── mistral-provider.js   # Mistral API
│   └── google-provider.js    # Gemini API
├── router.js                 # Main router with failover
├── rate-limit-tracker.js     # Track limits per provider
├── budget-enforcer.js        # Budget limits
├── backoff-strategy.js       # Exponential backoff
└── failover-chain.js         # Cross-provider failover
```

### 4. Configuration Structure

Users configure in `moltagent-providers.yaml`:

```yaml
# Provider instances
providers:
  # Local - always available (sovereign/free)
  ollama-local:
    adapter: ollama
    endpoint: http://localhost:11434
    model: deepseek-r1:8b

  # Value tier options
  deepseek:
    adapter: deepseek
    credentialName: deepseek-api-key  # From NC Passwords
    model: deepseek-chat

  mistral:
    adapter: mistral
    credentialName: mistral-api-key
    model: mistral-small-latest

  # Premium tier
  claude:
    adapter: anthropic
    credentialName: claude-api-key
    model: claude-sonnet-4-20250514

  gpt4:
    adapter: openai
    credentialName: openai-api-key
    model: gpt-4o

# Role assignments (preference order)
roles:
  sovereign: [ollama-local]
  free: [ollama-local]
  value: [deepseek, mistral, ollama-local]
  premium: [claude, gpt4, deepseek, ollama-local]

# Fallback chains
fallbackChain:
  claude: [deepseek, ollama-local]
  gpt4: [claude, deepseek, ollama-local]
  deepseek: [mistral, ollama-local]
  mistral: [deepseek, ollama-local]
  ollama-local: []  # Terminal - always works

# Daily budgets (USD)
budgets:
  claude: 2.00
  gpt4: 2.00
  deepseek: 1.00
  mistral: 0.50
```

### 5. Router API

The router exposes a simple API that task code uses:

```javascript
const router = new LLMRouter(config);

// Task code specifies ROLE, not provider
const result = await router.route({
  task: 'research',
  content: 'Analyze this topic...',
  requirements: {
    role: 'value',        // Which role to use
    quality: 'good',      // Hint for response length
    maxTokens: 1024       // Optional limit
  }
});

// Result includes which provider was used
console.log(result.provider);  // 'deepseek'
console.log(result.result);    // The actual response
console.log(result.tokens);    // Token count
console.log(result.cost);      // Estimated cost
console.log(result.failoverPath); // ['claude'] if failover occurred
```

### 6. Task-to-Role Mapping

The deck-task-processor already specifies roles correctly:

| Task | Current Role | Correct? |
|------|--------------|----------|
| Research (urgent) | `premium` | Yes |
| Research (normal) | `value` | Yes |
| Writing | `premium` | Yes |
| Admin | `value` | Yes |
| Comment classify | `value` + `fast` | Should be `free` |
| Followup response | `value` | Yes |
| Heartbeat scan | (not set) | Should be `free` or `sovereign` |

**Recommendation:** Add `free` role for lightweight operations:

```javascript
// Comment classification - use free tier
const result = await this.router.route({
  task: 'classify',
  content: classificationPrompt,
  requirements: {
    role: 'free',      // Changed from 'value'
    quality: 'fast'
  }
});
```

### 7. Failover Flow

```
Request (role: value)
       │
       ▼
┌──────────────────┐
│ Get providers    │  roles.value = [deepseek, mistral, ollama-local]
│ for role         │
└────────┬─────────┘
         │
         ▼
┌──────────────────┐
│ Check budget     │  budgets.deepseek > spent?
│ for deepseek     │
└────────┬─────────┘
         │ Yes
         ▼
┌──────────────────┐
│ Check rate limit │  rateLimits.canRequest(deepseek)?
│ for deepseek     │
└────────┬─────────┘
         │ Yes
         ▼
┌──────────────────┐
│ Call deepseek    │───────────────────┐
└────────┬─────────┘                   │
         │                             │ Error (429)
         │ Success                     │
         ▼                             ▼
┌──────────────────┐         ┌──────────────────┐
│ Return result    │         │ Backoff + try    │
│ provider:deepseek│         │ next: mistral    │
└──────────────────┘         └────────┬─────────┘
                                      │
                                      ▼
                             ┌──────────────────┐
                             │ ... same checks  │
                             │ for mistral      │
                             └────────┬─────────┘
                                      │
                                      ▼
                             ┌──────────────────┐
                             │ ollama-local     │
                             │ (always works)   │
                             └──────────────────┘
```

### 8. Implementation Plan

**Phase 1: Provider Adapters**
- Create base provider class
- Implement Ollama adapter (already working)
- Implement Anthropic adapter (Claude)
- Implement OpenAI adapter
- Implement DeepSeek adapter

**Phase 2: Core Router**
- Rate limit tracker
- Budget enforcer
- Backoff strategy
- Failover chain
- Main router class

**Phase 3: Configuration**
- YAML config loader
- Credential broker integration (NC Passwords)
- Validation

**Phase 4: Integration**
- Update deck-task-processor to use new router
- Update heartbeat to use `free` role
- Add audit logging for provider selection

---

## Questions for Review

1. **Credential storage:** Should API keys come from NC Passwords (via credential broker) or from environment variables?

2. **Default config:** What should happen if no `moltagent-providers.yaml` exists? Default to Ollama-only?

3. **Provider priority within role:** If multiple providers are configured for `value`, should we:
   - Round-robin for load balancing?
   - Always try first one first?
   - Pick based on current rate limit headroom?

4. **Specialized role:** Should we implement task-specific routing (e.g., `o1` for complex reasoning)?

---

## File Changes Required

| File | Change |
|------|--------|
| `src/lib/llm-router.js` | Replace with new implementation |
| `src/lib/llm/providers/*.js` | New provider adapters |
| `src/lib/llm/rate-limit-tracker.js` | New |
| `src/lib/llm/budget-enforcer.js` | New |
| `src/lib/llm/failover-chain.js` | New |
| `config/moltagent-providers.yaml` | New config file |
| `src/lib/integrations/deck-task-processor.js` | Update role assignments |
| `src/lib/integrations/heartbeat-manager.js` | Use `free` role for scans |

---

## Summary

This proposal implements the resilience spec's provider architecture:

- **Roles define intent**, providers fulfill it
- **Users configure** which providers serve which roles
- **Failover chains** ensure graceful degradation
- **Local always works** - ends every fallback chain
- **Budgets enforced** - prevents runaway costs
- **Rate limits tracked** - prevents death spirals
- **Transparent** - audit log shows which provider handled each task
