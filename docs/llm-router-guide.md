# MoltAgent LLM Router Guide

**Version:** 2.0
**Status:** Implemented
**Date:** 2026-02-03

---

## Overview

The MoltAgent LLM Router provides intelligent, role-based routing of AI requests to multiple providers with automatic failover, rate limit handling, and budget enforcement.

**Key Features:**
- Role-based routing (not hardcoded providers)
- Predictable provider order (first listed = first tried)
- Automatic failover across provider boundaries
- Rate limit tracking from response headers
- Daily/monthly budget enforcement
- Local fallback always available

---

## Quick Start

### Default Configuration (Ollama Only)

Out of the box, MoltAgent routes all requests to local Ollama:

```javascript
const LLMRouter = require('./src/lib/llm-router');

const router = new LLMRouter({
  ollama: {
    url: 'http://localhost:11434',
    model: 'deepseek-r1:8b'
  }
});

// Use it
const result = await router.route({
  task: 'research',
  content: 'Analyze this topic...',
  requirements: { role: 'value' }
});
```

### Multi-Provider Configuration

Edit `config/moltagent-providers.yaml`:

```yaml
providers:
  ollama-local:
    adapter: ollama
    endpoint: http://localhost:11434
    model: deepseek-r1:8b

  deepseek:
    adapter: deepseek
    credentialName: deepseek-api-key    # From NC Passwords
    model: deepseek-chat

  claude:
    adapter: anthropic
    credentialName: claude-api-key
    model: claude-sonnet-4-20250514

roles:
  sovereign: [ollama-local]
  free: [ollama-local]
  value: [deepseek, ollama-local]
  premium: [claude, deepseek, ollama-local]

fallbackChain:
  claude: [deepseek, ollama-local]
  deepseek: [ollama-local]
  ollama-local: []

budgets:
  daily:
    claude: 2.00      # USD
    deepseek: 1.00
```

---

## Roles

Roles define **what the task needs**, not which provider to use. Users configure which providers fulfill each role.

| Role | Purpose | Typical Providers |
|------|---------|-------------------|
| `sovereign` | Data never leaves infrastructure | Ollama, LM Studio |
| `free` | Zero marginal cost operations | Ollama, NC Assistant |
| `value` | Good quality, low cost - workhorse | DeepSeek, Mistral Small |
| `premium` | Best available quality | Claude, GPT-4 |
| `specialized` | Task-specific capabilities | o1 (reasoning), Whisper |

### Role Usage in Code

```javascript
// Classification (lightweight) - use free tier
await router.route({
  task: 'classify',
  content: 'Is this spam?',
  requirements: { role: 'free', maxTokens: 50 }
});

// Research task - use value tier
await router.route({
  task: 'research',
  content: 'Analyze market trends...',
  requirements: { role: 'value' }
});

// Critical writing - use premium tier
await router.route({
  task: 'writing',
  content: 'Draft investor update...',
  requirements: { role: 'premium' }
});

// Sensitive data - use sovereign (local only)
await router.route({
  task: 'analyze',
  content: credentials,
  requirements: { role: 'sovereign' }
});
```

---

## Provider Order

**Providers are tried in the order listed.** This is predictable and user-controlled.

```yaml
roles:
  value: [deepseek, mistral, ollama-local]
```

Means:
1. Try DeepSeek first
2. If DeepSeek fails (rate limit, budget, error), try Mistral
3. If Mistral fails, try Ollama (local)
4. Local always works (no rate limits, no budget)

### Fallback Chains

Fallback chains extend the provider list when a provider fails:

```yaml
roles:
  premium: [claude]

fallbackChain:
  claude: [deepseek, ollama-local]
```

Result: `claude -> deepseek -> ollama-local`

---

## Available Adapters

| Adapter | Provider | API Style | Default Endpoint |
|---------|----------|-----------|------------------|
| `ollama` | Ollama (local) | Ollama | http://localhost:11434 |
| `openai` | OpenAI | OpenAI | https://api.openai.com/v1 |
| `anthropic` | Claude | Anthropic | https://api.anthropic.com |
| `deepseek` | DeepSeek | OpenAI | https://api.deepseek.com/v1 |
| `mistral` | Mistral | OpenAI | https://api.mistral.ai/v1 |
| `google` | Gemini | Google | https://generativelanguage.googleapis.com |
| `groq` | Groq | OpenAI | https://api.groq.com/openai/v1 |
| `together` | Together | OpenAI | https://api.together.xyz/v1 |

### Adding a Provider

```yaml
providers:
  my-provider:
    adapter: openai              # Use OpenAI-compatible adapter
    endpoint: https://my-api.com/v1
    model: my-model-name
    credentialName: my-api-key   # Stored in NC Passwords
    costModel:
      inputPer1M: 1.00           # USD per million input tokens
      outputPer1M: 2.00          # USD per million output tokens
```

---

## Credential Management

API keys are fetched from NC Passwords at runtime via the credential broker.

### Setup

1. Store API key in NC Passwords:
   - Name: `claude-api-key`
   - Value: `sk-ant-...`
   - Share with `moltagent` user

2. Reference in config:
   ```yaml
   providers:
     claude:
       adapter: anthropic
       credentialName: claude-api-key   # Must match NC Passwords name
   ```

3. Pass credential broker to router:
   ```javascript
   const router = new LLMRouter({
     ...config,
     getCredential: async (name) => {
       return await ncPasswords.get(name);
     }
   });
   ```

---

## Budget Enforcement

Set daily and monthly spending limits per provider:

```yaml
budgets:
  daily:
    claude: 2.00      # Max $2/day on Claude
    deepseek: 1.00    # Max $1/day on DeepSeek
  monthly:
    claude: 50.00     # Max $50/month on Claude
```

### Behavior

- When budget is exhausted, provider is skipped in the chain
- Next provider in chain is tried
- User is notified of budget exhaustion
- Local fallback ensures work continues

### Budget Override

Users can reply "OVERRIDE" to temporarily increase budget for critical tasks.

---

## Rate Limit Handling

The router tracks rate limits from response headers and:

1. **Predicts** when limits will be exhausted
2. **Skips** providers approaching limits
3. **Backs off** with exponential delay + jitter
4. **Fails over** to next provider after 2 attempts

### Backoff Configuration

```yaml
rateLimits:
  backoff:
    initialDelayMs: 1000
    maxDelayMs: 300000      # 5 minutes max
    multiplier: 2
    jitterPercent: 25
  maxRetries: 5
  failoverAfterAttempts: 2
```

---

## Circuit Breaker

The circuit breaker prevents cascading failures by temporarily disabling providers that are experiencing issues.

### States

| State | Description | Behavior |
|-------|-------------|----------|
| `closed` | Normal operation | Requests pass through |
| `open` | Too many failures | Requests rejected immediately |
| `half-open` | Testing recovery | Limited requests allowed |

### Configuration

```yaml
circuitBreaker:
  failureThreshold: 5      # Failures before opening circuit
  resetTimeoutMs: 60000    # Time before testing recovery (ms)
  successThreshold: 3      # Successes to close from half-open
```

### Behavior

1. **Closed → Open:** After `failureThreshold` failures, circuit opens
2. **Open → Half-Open:** After `resetTimeoutMs`, circuit allows test requests
3. **Half-Open → Closed:** After `successThreshold` successes, circuit closes
4. **Half-Open → Open:** Any failure returns circuit to open state

### Why This Matters

- **Prevents cascading failures:** Don't keep hammering a failing provider
- **Allows recovery:** Automatically tests if provider has recovered
- **Fast failover:** Open circuit means instant skip to next provider

---

## Loop Detection

Loop detection prevents infinite loops in AI agent operations.

### Detected Patterns

| Pattern | Description | Example |
|---------|-------------|---------|
| **Repetition** | Same call repeated too many times | Same prompt 5 times in 60s |
| **Error loop** | Same call keeps failing | 3 consecutive identical errors |
| **Ping-pong** | Alternating between two calls | A→B→A→B pattern |

### Configuration

```yaml
loopDetector:
  maxConsecutiveErrors: 3  # Errors before blocking
  maxSameCall: 5           # Identical calls before blocking
  historyWindowMs: 60000   # Time window for history (ms)
  pingPongThreshold: 4     # Min calls to detect ping-pong
```

### Behavior

1. **Before each call:** Check if this call would create a loop
2. **On failure:** Track error patterns
3. **On loop detected:** Block call, notify user, suggest alternative

### Why This Matters

- **Prevents infinite loops:** Agent can't get stuck repeating the same action
- **Saves money:** Stop before burning through API budget on futile retries
- **User notification:** Human is alerted to take over

---

## Output Verification

Output verification checks all LLM responses before they are returned, blocking suspicious patterns that could indicate security issues.

### Detection Categories

| Category | Severity | Examples |
|----------|----------|----------|
| `shellInjection` | Critical | `curl ... \| sh`, backticks, `$()` |
| `destructive` | Critical | `rm -rf`, `chmod 777`, `mkfs` |
| `credentialPatterns` | Critical | API keys (sk-...), private keys, JWTs |
| `systemPaths` | High | Writes to `/etc/`, `/root/`, `~/.ssh/` |
| `codeExecution` | High | `eval()`, `child_process`, `exec()` |
| `urlExfiltration` | High | webhook.site, ngrok, credentials in URLs |
| `sqlInjection` | Medium | `DROP TABLE`, `UNION SELECT` |
| `promptInjection` | Medium | "ignore previous instructions" |

### Configuration

```yaml
outputVerifier:
  strictMode: false          # Block medium severity patterns too
  allowedDomains:            # Only allow URLs to these domains
    - example.com
    - api.mycompany.com
```

### Behavior

1. **Critical/High severity:** Immediately blocked, error thrown
2. **Medium severity (normal mode):** Warning logged, output allowed
3. **Medium severity (strict mode):** Blocked

### Response Format

Successful responses include verification status:

```javascript
{
  result: "...",
  verified: true,
  warnings: []  // Any medium-severity warnings
}
```

### Custom Patterns

Add custom patterns or whitelists programmatically:

```javascript
// Block custom pattern
router.outputVerifier.addPattern(/CONFIDENTIAL/i);

// Whitelist pattern (bypasses all checks)
router.outputVerifier.addAllowPattern(/^TRUSTED:/);

// Allow specific domain
router.outputVerifier.addAllowedDomain('internal.company.com');
```

---

## User Notifications

The router notifies users of important events:

| Event | Message |
|-------|---------|
| Rate limit | "Rate limit reached on Claude. Switching to DeepSeek." |
| Failover | "Switched from Claude to DeepSeek. Processing continues." |
| Budget warning | "Budget alert: $1.60/$2.00 (80%) used today." |
| Budget exhausted | "Daily budget reached for Claude. Switching to local." |
| Circuit opened | "Circuit breaker opened for Claude after 5 failures." |
| Loop detected | "Loop detected: same call made 5 times. Human review needed." |
| Output blocked | "Output blocked: Credential pattern detected in response." |
| All exhausted | "All providers unavailable. Task queued." |

---

## File Structure

```
src/lib/
├── output-verifier.js          # Output security verification
└── llm/
    ├── index.js                # Module exports
    ├── router.js               # Main router with failover
    ├── config-loader.js        # YAML config loader
    ├── rate-limit-tracker.js   # Track API rate limits
    ├── budget-enforcer.js      # Daily/monthly budgets
    ├── backoff-strategy.js     # Exponential backoff
    ├── circuit-breaker.js      # Circuit breaker for cascading failure prevention
    ├── loop-detector.js        # Loop detection for infinite loop prevention
    └── providers/
        ├── index.js            # Provider registry
        ├── base-provider.js    # Abstract base class
        ├── ollama-provider.js  # Local Ollama
        ├── openai-compatible-provider.js
        ├── anthropic-provider.js   # Claude
        └── google-provider.js      # Gemini
```

---

## API Reference

### LLMRouter

```javascript
const { LLMRouter, loadConfig } = require('./src/lib/llm');

// Load config from YAML
const config = loadConfig({ configDir: './config' });

// Create router
const router = new LLMRouter({
  ...config,
  auditLog: async (event, data) => { /* ... */ },
  notifyUser: async (notification) => { /* ... */ },
  getCredential: async (name) => { /* ... */ }
});

// Route a request
const result = await router.route({
  task: 'research',
  content: 'Analyze this...',
  requirements: {
    role: 'value',
    maxTokens: 1024,
    temperature: 0.7
  }
});

// Result
{
  result: "Analysis: ...",
  provider: "deepseek",
  model: "deepseek-chat",
  tokens: 523,
  inputTokens: 150,
  outputTokens: 373,
  cost: 0.0001,
  duration: 2341,
  failoverPath: ["claude"]  // If failover occurred
}
```

### Testing Connections

```javascript
const results = await router.testConnections();
// { 'ollama-local': { connected: true }, 'claude': { connected: true } }
```

### Getting Stats

```javascript
const stats = router.getStats();
// {
//   totalCalls, successfulCalls, failovers, errors,
//   byProvider, byRole,
//   rateLimits,      // Rate limit status per provider
//   budget,          // Budget usage per provider
//   circuitBreaker,  // Circuit state per provider (closed/open/half-open)
//   loopDetector     // Recent call history and error patterns
// }
```

---

## Migration from Old Router

The old `llm-router.js` is now a backward-compatible wrapper. Existing code continues to work:

```javascript
// Old code still works
const LLMRouter = require('./src/lib/llm-router');
const router = new LLMRouter({
  ollama: { url: 'http://localhost:11434', model: 'deepseek-r1:8b' }
});
```

To access new features, use the new module:

```javascript
// New code with full features
const { LLMRouter, loadConfig } = require('./src/lib/llm');
const config = loadConfig();
const router = new LLMRouter(config);
```

---

## Deployment Checklist

1. **Install dependencies:**
   ```bash
   npm install js-yaml
   ```

2. **Create config file:**
   ```bash
   cp config/moltagent-providers.yaml.example config/moltagent-providers.yaml
   ```

3. **Store API keys in NC Passwords:**
   - Create credentials with matching names
   - Share with `moltagent` user

4. **Configure roles and fallback chains:**
   - Edit `config/moltagent-providers.yaml`
   - Set providers for each role
   - Define fallback chains

5. **Set budgets (optional but recommended):**
   - Add daily/monthly limits in config

6. **Test connections:**
   ```bash
   node -e "
   const { LLMRouter, loadConfig } = require('./src/lib/llm');
   const router = new LLMRouter(loadConfig());
   router.testConnections().then(console.log);
   "
   ```

---

## Troubleshooting

### "No providers available for role"

Check that:
- Role is defined in `config/moltagent-providers.yaml`
- At least one provider is listed for the role
- Provider is defined in the `providers` section

### "No API key available"

Check that:
- Credential name in config matches NC Passwords entry
- Credential is shared with `moltagent` user
- `getCredential` function is provided to router

### "All providers exhausted"

This means every provider in the chain failed. Check:
- Rate limits (wait and retry)
- Budget limits (increase or wait for reset)
- Network connectivity
- API key validity

### Config not loading

```bash
# Check if js-yaml is installed
npm list js-yaml

# Check config file location
ls -la config/moltagent-providers.yaml
```

### "Circuit breaker is open"

This means a provider has failed too many times:
- Wait for `resetTimeoutMs` (default 60s) for automatic recovery test
- Check provider status/health
- Use `router.circuitBreaker.reset(providerId)` to force reset

### "Loop detected"

The router detected a repetitive pattern:
- Check if the task is getting stuck on invalid input
- Review the pattern in logs (`loopDetector.getSummary()`)
- Use `router.loopDetector.reset()` to clear history

---

## Best Practices

1. **Always include local in fallback chains** - ensures work continues even when APIs fail

2. **Use `free` role for lightweight tasks** - classification, tagging, quick checks

3. **Use `sovereign` for sensitive data** - credentials, PII, confidential content

4. **Set conservative budgets initially** - increase based on actual usage

5. **Monitor failover paths** - frequent failovers indicate primary provider issues

6. **Test connections on startup** - fail fast if providers are misconfigured
