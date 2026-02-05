# MoltAgent Resilience Specification

**Version:** 1.0  
**Status:** Core Architecture  
**Source:** Real-world OpenClaw failure patterns

---

## Executive Summary

This specification addresses the systemic failures observed in AI agent deployments. Every feature here exists because real users experienced real pain.

**The core problems we solve:**

| Problem | User Experience | Root Cause |
|---------|-----------------|------------|
| Rate limit death spiral | Bot goes offline for hours | No local fallback, no backoff |
| Token bankruptcy | $500/month for basic usage | Heartbeat hits external APIs |
| Ghost messages | Bot stops responding, no explanation | Errors swallowed silently |
| Infinite loops | Burns tokens on repeated failures | No circuit breakers |
| Context bloat | 26K tokens loaded every heartbeat | Load-everything architecture |
| Fallback failures | Backup providers don't engage | Provider-level blocking |

**MoltAgent's answer:** Local-first, cost-aware, failure-transparent architecture.

---

## Part 1: The Provider Architecture

### 1.1 Roles, Not Tiers

MoltAgent uses **roles** (what the task needs) mapped to **providers** (who fulfills it):

```
â”Œâ”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”
â”‚                           PROVIDER ROLES                                    â”‚
â”œâ”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”¤
â”‚                                                                             â”‚
â”‚  SOVEREIGN          Local execution. Data never leaves infrastructure.     â”‚
â”‚  â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€         Required for: credentials, PII, untrusted content      â”‚
â”‚                     Examples: Ollama, LM Studio, LocalAI, llama.cpp        â”‚
â”‚                                                                             â”‚
â”‚  FREE               Zero marginal cost. For high-volume routine tasks.     â”‚
â”‚  â”€â”€â”€â”€               Examples: NC Assistant, Cloudflare Workers AI          â”‚
â”‚                                                                             â”‚
â”‚  VALUE              Good quality, low cost. The workhorse tier.            â”‚
â”‚  â”€â”€â”€â”€â”€              Examples: DeepSeek, Mistral, GPT-4o-mini, Haiku        â”‚
â”‚                                                                             â”‚
â”‚  PREMIUM            Best available quality. For critical tasks only.       â”‚
â”‚  â”€â”€â”€â”€â”€â”€â”€            Examples: Claude Opus, GPT-4.5, Mistral Large          â”‚
â”‚                                                                             â”‚
â”‚  SPECIALIZED        Task-specific capabilities.                            â”‚
â”‚  â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€        Examples: o1 (reasoning), Whisper (transcription)      â”‚
â”‚                                                                             â”‚
â””â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”˜
```

### 1.2 Provider Schema

Every provider declares its capabilities:

```javascript
const providerSchema = {
  // Identity
  id: 'string',           // Unique identifier
  name: 'string',         // Human-readable name
  type: 'local' | 'api',
  
  // Data governance
  dataResidency: 'local' | 'EU' | 'US' | 'CN' | 'unknown',
  compliance: ['GDPR', 'HIPAA', 'SOC2'],
  
  // Capabilities
  capabilities: [
    'text_generation', 'code_generation', 'reasoning',
    'creative_writing', 'vision', 'tool_use', 
    'function_calling', 'long_context', 'streaming'
  ],
  
  // Quality assessment
  qualityTier: 'basic' | 'good' | 'excellent' | 'best',
  
  // Cost model
  costModel: {
    type: 'free' | 'fixed' | 'per_token',
    inputPer1M: 0,      // USD per million input tokens
    outputPer1M: 0,     // USD per million output tokens
    fixedMonthly: 0     // USD for fixed-cost (local)
  },
  
  // Rate limits (known or estimated)
  rateLimits: {
    requestsPerMinute: 60,
    tokensPerMinute: 100000,
    tokensPerDay: 1000000
  },
  
  // Connection
  endpoint: 'string',
  credentialName: 'string',  // Reference in NC Passwords
  model: 'string'
};
```

### 1.3 User Configuration

Users configure their provider preferences:

```yaml
# moltagent-providers.yaml

constraints:
  dataResidency: ['local', 'EU']  # Only these jurisdictions
  compliance: ['GDPR']            # Required certifications
  excludeProviders: []            # Blocklist

providers:
  # Local (Sovereign)
  ollama-local:
    enabled: true
    endpoint: http://localhost:11434
    model: deepseek-r1:8b
    
  # Free tier
  nc-assistant:
    enabled: true
    
  # Value tier
  mistral-small:
    enabled: true
    credentialName: mistral-api-key
    model: mistral-small-latest
    
  deepseek-api:
    enabled: true
    credentialName: deepseek-api-key
    model: deepseek-chat
    
  # Premium tier
  claude-sonnet:
    enabled: true
    credentialName: claude-api-key
    model: claude-sonnet-4-5-20250929

# Role assignments (preference order)
roles:
  sovereign: [ollama-local]
  free: [nc-assistant]
  value: [deepseek-api, mistral-small]
  premium: [claude-sonnet]
  
# Fallback chain (when preferred unavailable)
fallbackChain:
  claude-sonnet: [mistral-small, deepseek-api, ollama-local]
  mistral-small: [deepseek-api, ollama-local]
  deepseek-api: [mistral-small, ollama-local]
  nc-assistant: [ollama-local]
  ollama-local: []  # Terminal - always available

budgets:
  daily:
    claude-sonnet: 2.00   # USD
    mistral-small: 1.00
    deepseek-api: 0.50
```

---

## Part 2: Rate Limit Management

### 2.1 The Problem

From real user experience:
> "8.5M tokens in one day â†’ constant cooldowns"
> "No fallback = offline for hours"
> "Still hitting rate limits after optimization"

### 2.2 Rate Limit Tracking

Track limits across ALL providers in real-time:

```javascript
class RateLimitTracker {
  constructor() {
    this.limits = new Map();
    this.history = new Map();  // For prediction
  }

  // Update from API response headers
  updateFromResponse(providerId, headers) {
    const limits = {
      // Request limits
      requestsRemaining: this.parseHeader(headers, [
        'x-ratelimit-remaining-requests',
        'x-ratelimit-remaining'
      ]),
      requestsReset: this.parseResetTime(headers, [
        'x-ratelimit-reset-requests',
        'x-ratelimit-reset'
      ]),
      
      // Token limits (per minute)
      tokensRemaining: this.parseHeader(headers, [
        'x-ratelimit-remaining-tokens',
        'anthropic-ratelimit-tokens-remaining'
      ]),
      tokensReset: this.parseResetTime(headers, [
        'x-ratelimit-reset-tokens',
        'anthropic-ratelimit-tokens-reset'
      ]),
      
      // Daily limits (Anthropic-specific)
      dailyTokensRemaining: this.parseHeader(headers, [
        'anthropic-ratelimit-tokens-remaining'
      ]),
      dailyReset: this.parseResetTime(headers, [
        'anthropic-ratelimit-tokens-reset'
      ]),
      
      updatedAt: Date.now()
    };
    
    this.limits.set(providerId, limits);
    this.recordHistory(providerId, limits);
    
    return limits;
  }

  // Check if we can make a request
  canRequest(providerId, estimatedTokens) {
    const limits = this.limits.get(providerId);
    
    if (!limits) return { allowed: true, confidence: 'unknown' };
    
    // Check request limit
    if (limits.requestsRemaining !== null && limits.requestsRemaining < 1) {
      return {
        allowed: false,
        reason: 'request_limit',
        retryAt: limits.requestsReset,
        confidence: 'high'
      };
    }
    
    // Check token limit (with 20% buffer)
    if (limits.tokensRemaining !== null) {
      const safeLimit = limits.tokensRemaining * 0.8;
      if (estimatedTokens > safeLimit) {
        return {
          allowed: false,
          reason: 'token_limit',
          retryAt: limits.tokensReset,
          available: limits.tokensRemaining,
          requested: estimatedTokens,
          confidence: 'high'
        };
      }
    }
    
    // Check daily limit
    if (limits.dailyTokensRemaining !== null) {
      const safeDailyLimit = limits.dailyTokensRemaining * 0.9;
      if (estimatedTokens > safeDailyLimit) {
        return {
          allowed: false,
          reason: 'daily_limit',
          retryAt: limits.dailyReset,
          confidence: 'high'
        };
      }
    }
    
    return { allowed: true, confidence: 'high' };
  }

  // Predict future availability
  predictAvailability(providerId, minutesAhead) {
    const history = this.history.get(providerId) || [];
    if (history.length < 2) return { prediction: 'unknown' };
    
    // Calculate consumption rate
    const recent = history.slice(-10);
    const tokenBurnRate = this.calculateBurnRate(recent);
    
    const limits = this.limits.get(providerId);
    if (!limits) return { prediction: 'unknown' };
    
    const projectedRemaining = limits.tokensRemaining - (tokenBurnRate * minutesAhead);
    
    return {
      prediction: projectedRemaining > 0 ? 'available' : 'exhausted',
      projectedRemaining,
      burnRate: tokenBurnRate,
      exhaustionTime: projectedRemaining > 0 
        ? null 
        : Date.now() + (limits.tokensRemaining / tokenBurnRate * 60000)
    };
  }
}
```

### 2.3 Exponential Backoff with Jitter

When rate limited, back off properly:

```javascript
class BackoffStrategy {
  constructor() {
    this.attempts = new Map();
  }

  async handleRateLimit(providerId, error) {
    const state = this.attempts.get(providerId) || { count: 0 };
    state.count++;
    
    // Parse retry-after if provided
    const serverDelay = this.parseRetryAfter(error);
    
    // Calculate backoff: 2^attempt seconds, max 5 minutes
    const baseDelay = serverDelay || Math.min(
      Math.pow(2, state.count) * 1000,
      300000  // 5 minute cap
    );
    
    // Add jitter: Â±25% to prevent thundering herd
    const jitter = baseDelay * 0.25 * (Math.random() * 2 - 1);
    const finalDelay = Math.round(baseDelay + jitter);
    
    state.nextRetry = Date.now() + finalDelay;
    state.lastError = error.message;
    this.attempts.set(providerId, state);
    
    // Log for visibility
    await auditLog('backoff', {
      provider: providerId,
      attempt: state.count,
      delayMs: finalDelay,
      nextRetry: new Date(state.nextRetry).toISOString(),
      reason: error.message
    });
    
    return {
      shouldWait: state.count <= 5,      // Give up after 5 attempts
      shouldFailover: state.count >= 2,  // Try another provider after 2
      delayMs: finalDelay,
      nextRetry: state.nextRetry
    };
  }

  parseRetryAfter(error) {
    const header = error.headers?.['retry-after'];
    if (!header) return null;
    
    // Could be seconds or HTTP date
    const seconds = parseInt(header);
    if (!isNaN(seconds)) return seconds * 1000;
    
    const date = new Date(header);
    if (!isNaN(date.getTime())) return date.getTime() - Date.now();
    
    return null;
  }

  reset(providerId) {
    this.attempts.delete(providerId);
  }
}
```

### 2.4 Cross-Provider Failover

The critical fix - failover MUST cross provider boundaries:

```javascript
class FailoverChain {
  constructor(config, providers, rateLimitTracker, backoff) {
    this.config = config;
    this.providers = providers;
    this.rateLimits = rateLimitTracker;
    this.backoff = backoff;
    this.cooldowns = new Map();
  }

  async execute(task, content, requirements = {}) {
    const chain = this.buildChain(requirements);
    const errors = [];
    
    for (const providerId of chain) {
      // Skip if in cooldown
      if (this.isInCooldown(providerId)) {
        errors.push({ provider: providerId, error: 'in_cooldown' });
        continue;  // TRY NEXT - don't return!
      }
      
      // Check rate limits before attempting
      const canRequest = this.rateLimits.canRequest(
        providerId, 
        this.estimateTokens(content)
      );
      
      if (!canRequest.allowed) {
        errors.push({ provider: providerId, error: canRequest.reason });
        continue;  // TRY NEXT
      }
      
      try {
        const result = await this.providers[providerId].generate(task, content);
        
        // Success! Reset backoff for this provider
        this.backoff.reset(providerId);
        this.cooldowns.delete(providerId);
        
        // Update rate limits from response
        if (result.headers) {
          this.rateLimits.updateFromResponse(providerId, result.headers);
        }
        
        return {
          success: true,
          provider: providerId,
          result: result.content,
          failoverPath: errors.map(e => e.provider)
        };
        
      } catch (error) {
        errors.push({ provider: providerId, error: error.message });
        
        if (this.isRateLimitError(error)) {
          const backoffResult = await this.backoff.handleRateLimit(providerId, error);
          this.setCooldown(providerId, backoffResult.delayMs);
          
          if (backoffResult.shouldFailover) {
            continue;  // Try next provider
          }
        }
        
        if (this.isTransientError(error)) {
          // Brief retry before failover
          await this.sleep(1000);
          try {
            return await this.providers[providerId].generate(task, content);
          } catch {
            continue;  // Failed retry, try next
          }
        }
        
        // Non-transient error (bad request, auth, etc.)
        // Don't failover for these - it won't help
        if (this.isPermanentError(error)) {
          throw error;
        }
        
        continue;  // Unknown error, try next
      }
    }
    
    // All providers exhausted
    return this.handleAllExhausted(task, content, errors);
  }

  buildChain(requirements) {
    const chain = [];
    
    // Start with preferred provider for this role
    const role = requirements.role || 'value';
    const preferred = this.config.roles[role] || [];
    chain.push(...preferred);
    
    // Add fallback chain
    for (const providerId of preferred) {
      const fallbacks = this.config.fallbackChain[providerId] || [];
      for (const fb of fallbacks) {
        if (!chain.includes(fb)) {
          chain.push(fb);
        }
      }
    }
    
    // Always end with local (infinite capacity)
    const localProviders = Object.entries(this.providers)
      .filter(([id, p]) => p.type === 'local')
      .map(([id]) => id);
    
    for (const local of localProviders) {
      if (!chain.includes(local)) {
        chain.push(local);
      }
    }
    
    return chain;
  }

  async handleAllExhausted(task, content, errors) {
    // Find next available time
    const nextAvailable = this.findNextAvailable();
    
    // Notify user with full transparency
    await notifyUser({
      type: 'all_providers_exhausted',
      message: 'âš ï¸ All AI providers are temporarily unavailable.',
      details: {
        attempted: errors.map(e => `${e.provider}: ${e.error}`),
        nextAvailable: new Date(nextAvailable).toLocaleTimeString(),
        action: 'Task queued for automatic retry.'
      }
    });
    
    // Queue for later
    return this.queueTask(task, content, nextAvailable);
  }

  isRateLimitError(error) {
    return error.status === 429 || 
           error.code === 'rate_limit_exceeded' ||
           error.message?.includes('rate limit');
  }

  isTransientError(error) {
    return [500, 502, 503, 504].includes(error.status) ||
           error.code === 'overloaded';
  }

  isPermanentError(error) {
    return [400, 401, 403, 404].includes(error.status);
  }
}
```

---

## Part 3: Heartbeat Architecture

### 3.1 The Problem

From real usage:
> "File scanning: 26K token reads every heartbeat"
> "Context: Loading 5K+ tokens on every startup"
> "Result: 8.5M tokens in one day"

One user's math:
```
Simple monitoring cron (every 5 minutes):
Per check: ~3,700 tokens
Per day: 288 Ã— 3,700 = 1,065,600 tokens
Per month: ~32 million tokens
Cost: ~$128/month FOR ONE CRON JOB
```

### 3.2 The Solution: Local-First Heartbeat

```javascript
class HeartbeatManager {
  constructor(config, providers, router) {
    this.config = config;
    this.providers = providers;
    this.router = router;
    this.state = {
      lastCheck: null,
      lastEscalation: null,
      checksWithoutEscalation: 0
    };
  }

  async heartbeat() {
    const startTime = Date.now();
    
    // STEP 1: Minimal local scan (FREE)
    const localProvider = this.providers[this.config.heartbeat.localProvider];
    
    const scanResult = await localProvider.generate({
      task: 'heartbeat_scan',
      prompt: this.config.heartbeat.scanPrompt,
      context: await this.getMinimalContext(),
      maxTokens: this.config.heartbeat.maxScanTokens  // 100-200 max
    });
    
    // STEP 2: Classify urgency (still local)
    const urgency = this.classifyUrgency(scanResult);
    
    // STEP 3: Only escalate if needed
    if (urgency.needsEscalation) {
      await this.escalate(urgency, scanResult);
    }
    
    // STEP 4: Log locally (no API)
    await this.logHeartbeat({
      duration: Date.now() - startTime,
      urgency: urgency.level,
      escalated: urgency.needsEscalation,
      tokensUsed: scanResult.usage?.totalTokens || 0
    });
    
    this.state.lastCheck = Date.now();
    this.state.checksWithoutEscalation++;
  }

  async getMinimalContext() {
    // Load ONLY what's needed for change detection
    const context = {
      // Last known state (stored locally, not re-fetched)
      lastState: this.state.lastKnownState,
      
      // Deltas only
      newEmails: await this.getNewEmailCount(),  // Just count, not content
      calendarNext24h: await this.getUpcomingEvents(),  // Summary only
      fileChanges: await this.getRecentFileChanges(),  // Paths only
      
      // Minimal memory
      priorities: await this.getCurrentPriorities()  // <500 tokens
    };
    
    return this.formatContext(context);  // Target: <2000 tokens
  }

  classifyUrgency(scanResult) {
    const content = scanResult.content.toLowerCase();
    
    // Check for escalation triggers
    const triggers = {
      immediate: ['urgent', 'emergency', 'critical', 'asap', 'deadline today'],
      high: ['important', 'needs attention', 'action required', 'meeting soon'],
      normal: ['update', 'fyi', 'reminder'],
      none: ['none', 'nothing', 'no changes', 'all quiet']
    };
    
    for (const [level, keywords] of Object.entries(triggers)) {
      if (keywords.some(k => content.includes(k))) {
        return {
          level,
          needsEscalation: level !== 'none' && level !== 'normal',
          reason: `Detected: ${keywords.find(k => content.includes(k))}`
        };
      }
    }
    
    return { level: 'none', needsEscalation: false };
  }

  async escalate(urgency, scanResult) {
    // NOW we use the premium provider - but only when necessary
    const escalationResult = await this.router.route({
      task: 'heartbeat_escalation',
      content: {
        scan: scanResult.content,
        urgency: urgency,
        context: await this.getEscalationContext()  // More context for analysis
      },
      requirements: {
        role: urgency.level === 'immediate' ? 'premium' : 'value',
        quality: 'good'
      }
    });
    
    // Notify user
    await notifyUser({
      type: 'heartbeat_alert',
      urgency: urgency.level,
      message: escalationResult.result,
      timestamp: new Date().toISOString()
    });
    
    this.state.lastEscalation = Date.now();
    this.state.checksWithoutEscalation = 0;
  }
}
```

### 3.3 Heartbeat Configuration

```yaml
# Heartbeat settings
heartbeat:
  enabled: true
  interval: 300000  # 5 minutes (ms)
  
  # Local provider for scanning (FREE)
  localProvider: ollama-local
  
  # Scan parameters
  scanPrompt: |
    Quickly check for anything requiring human attention:
    - Urgent emails or messages
    - Calendar conflicts or imminent meetings
    - File changes in watched folders
    - System alerts or errors
    
    Reply with ONE of:
    - "NONE" if nothing needs attention
    - "NORMAL: [brief description]" for low-priority updates
    - "IMPORTANT: [brief description]" for things needing attention soon
    - "URGENT: [brief description]" for immediate attention needed
    
    Be concise. Max 50 words.
  
  maxScanTokens: 150  # Hard cap on scan response
  
  # Context limits
  contextLimits:
    total: 2000           # Max tokens for heartbeat context
    memory: 500           # Max from memory files
    emailSummary: 300     # Max for email summary
    calendar: 200         # Max for calendar
    files: 200            # Max for file changes
  
  # Escalation settings
  escalation:
    provider: value       # Role for escalation (not premium by default)
    premiumTriggers:      # Only use premium for these
      - "URGENT"
      - "deadline"
      - "emergency"
    maxTokens: 500        # Cap escalation response
  
  # Adaptive frequency
  adaptive:
    enabled: true
    quietHoursInterval: 900000   # 15 min during quiet hours (11pm-7am)
    busyInterval: 180000          # 3 min when activity detected
    maxConsecutiveNoChange: 5     # After 5 "no change", slow down
```

### 3.4 Expected Impact

| Metric | Before (External API) | After (Local-First) |
|--------|----------------------|---------------------|
| Tokens per heartbeat | 3,700 | 150 (local) |
| Heartbeats per day | 288 | 288 |
| Daily token cost | 1M+ tokens ($5-10) | ~2K tokens (escalations only) |
| Monthly heartbeat cost | $150-300 | $5-15 |
| Rate limit risk | HIGH | ZERO (local) |

---

## Part 4: Context Management

### 4.1 The Problem

> "Context: Loading 5K+ tokens on every startup"
> "Token Bloat: Responses 400-500 tokens (verbose)"
> "Loading full context to check for changes"

### 4.2 Search-Then-Load Pattern

Don't load everything. Search for relevance, then load only what's needed:

```javascript
class ContextBroker {
  constructor(config, storage) {
    this.config = config;
    this.storage = storage;  // NC WebDAV
    this.cache = new Map();
    this.searchIndex = null;
  }

  async getContext(query, options = {}) {
    const maxTokens = options.maxTokens || this.config.defaults.maxContextTokens;
    
    // STEP 1: Search for relevant content (local operation)
    const relevantPaths = await this.searchRelevant(query, {
      maxResults: options.maxFiles || 5
    });
    
    // STEP 2: Load only relevant portions
    const context = [];
    let totalTokens = 0;
    
    for (const path of relevantPaths) {
      const remainingBudget = maxTokens - totalTokens;
      if (remainingBudget <= 0) break;
      
      const content = await this.loadWithLimit(path, remainingBudget);
      context.push({
        path,
        content,
        tokens: this.estimateTokens(content)
      });
      
      totalTokens += context[context.length - 1].tokens;
    }
    
    return {
      context,
      totalTokens,
      truncated: relevantPaths.length > context.length,
      searchResults: relevantPaths.length
    };
  }

  async searchRelevant(query, options) {
    // Use local search index (no API call)
    if (!this.searchIndex) {
      this.searchIndex = await this.buildSearchIndex();
    }
    
    return this.searchIndex.search(query, options.maxResults);
  }

  async loadWithLimit(path, maxTokens) {
    // Check cache first
    const cached = this.cache.get(path);
    if (cached && cached.expiry > Date.now()) {
      return this.truncateToTokens(cached.content, maxTokens);
    }
    
    // Load from NC
    const content = await this.storage.readFile(path);
    
    // Cache with short expiry
    this.cache.set(path, {
      content,
      expiry: Date.now() + 60000  // 1 minute cache
    });
    
    return this.truncateToTokens(content, maxTokens);
  }

  truncateToTokens(content, maxTokens) {
    const estimated = this.estimateTokens(content);
    if (estimated <= maxTokens) return content;
    
    // Smart truncation: keep start and end, summarize middle
    const ratio = maxTokens / estimated;
    const charLimit = Math.floor(content.length * ratio);
    
    const start = content.slice(0, charLimit * 0.6);
    const end = content.slice(-charLimit * 0.3);
    
    return `${start}\n\n[... truncated ${estimated - maxTokens} tokens ...]\n\n${end}`;
  }

  estimateTokens(text) {
    // Rough estimation: ~4 chars per token for English
    return Math.ceil(text.length / 4);
  }
}
```

### 4.3 Response Length Control

Enforce conciseness at the system level:

```javascript
class ResponseLimiter {
  constructor(config) {
    this.config = config;
    this.limits = config.responseLimits || {
      heartbeat: 150,
      quickAnswer: 256,
      standard: 512,
      detailed: 1024,
      comprehensive: 2048
    };
  }

  getLimitForTask(task, userOverride = null) {
    if (userOverride) return userOverride;
    
    // Map task types to response limits
    const taskLimits = {
      heartbeat_scan: 'heartbeat',
      quick_question: 'quickAnswer',
      summarize: 'standard',
      analyze: 'detailed',
      write_document: 'comprehensive',
      code_generation: 'comprehensive'
    };
    
    const limitKey = taskLimits[task] || 'standard';
    return this.limits[limitKey];
  }

  buildSystemPrompt(task, basePrompt) {
    const limit = this.getLimitForTask(task);
    
    return `${basePrompt}

RESPONSE CONSTRAINTS:
- Maximum response length: ${limit} tokens
- Be concise and direct
- Avoid unnecessary preamble or postamble
- If the answer is simple, keep the response simple
- Only elaborate when the task explicitly requires it`;
  }

  validateResponse(response, task) {
    const limit = this.getLimitForTask(task);
    const tokens = this.estimateTokens(response);
    
    if (tokens > limit * 1.5) {
      // Log violation for analysis
      auditLog('response_limit_exceeded', {
        task,
        limit,
        actual: tokens,
        ratio: tokens / limit
      });
    }
    
    return response;  // Don't truncate, but track
  }
}
```

### 4.4 Startup Context Minimization

Load minimal context on startup, expand on demand:

```javascript
class StartupManager {
  constructor(config, contextBroker) {
    this.config = config;
    this.contextBroker = contextBroker;
  }

  async initialize() {
    // MINIMAL startup context
    const startupContext = await this.loadStartupContext();
    
    return {
      ready: true,
      contextLoaded: startupContext.totalTokens,
      expandableContext: this.config.expandableFiles
    };
  }

  async loadStartupContext() {
    const files = this.config.startup.requiredFiles;
    const limits = this.config.startup.tokenLimits;
    
    const context = {};
    let totalTokens = 0;
    
    for (const [key, path] of Object.entries(files)) {
      const limit = limits[key] || 500;
      
      // Load with strict limit
      context[key] = await this.contextBroker.loadWithLimit(path, limit);
      totalTokens += this.estimateTokens(context[key]);
    }
    
    return { context, totalTokens };
  }
}

// Configuration
const startupConfig = {
  startup: {
    requiredFiles: {
      user: '/moltagent/Memory/USER.md',
      priorities: '/moltagent/Memory/PRIORITIES.md',
      todayLog: '/moltagent/Logs/today.md'
    },
    tokenLimits: {
      user: 500,         // Just the essentials
      priorities: 300,   // Current focus only
      todayLog: 200      // Recent entries only
    }
    // Total: 1000 tokens max on startup
  },
  expandableFiles: {
    fullMemory: '/moltagent/Memory/MEMORY.md',
    agents: '/moltagent/Memory/AGENTS.md',
    projects: '/moltagent/Memory/PROJECTS.md'
    // Loaded on-demand when relevant
  }
};
```

---

## Part 5: Loop Detection and Circuit Breakers

### 5.1 The Problem

From GitHub issues:
> "Agents can get stuck in infinite loops where they repeatedly make the same incorrect tool call despite receiving error feedback"
> "Tool call repeated 25+ times"
> "600s timeout means significant waste before it kicks in"

### 5.2 Loop Detection

```javascript
class LoopDetector {
  constructor(config) {
    this.config = config;
    this.callHistory = [];
    this.errorPatterns = new Map();
  }

  recordCall(call) {
    this.callHistory.push({
      ...call,
      timestamp: Date.now()
    });
    
    // Keep only recent history
    const cutoff = Date.now() - this.config.historyWindow;
    this.callHistory = this.callHistory.filter(c => c.timestamp > cutoff);
  }

  recordError(call, error) {
    const key = this.getCallSignature(call);
    const count = (this.errorPatterns.get(key) || 0) + 1;
    this.errorPatterns.set(key, count);
    
    // Check for loop
    if (count >= this.config.maxConsecutiveErrors) {
      return {
        loopDetected: true,
        signature: key,
        count,
        recommendation: 'abort_and_report'
      };
    }
    
    return { loopDetected: false };
  }

  checkForLoop(proposedCall) {
    // Check if this call matches recent failed calls
    const signature = this.getCallSignature(proposedCall);
    const errorCount = this.errorPatterns.get(signature) || 0;
    
    if (errorCount >= this.config.maxConsecutiveErrors) {
      return {
        blocked: true,
        reason: `Call blocked: same call failed ${errorCount} times`,
        suggestion: 'Try a different approach or ask for human assistance'
      };
    }
    
    // Check for ping-pong patterns (Aâ†’Bâ†’Aâ†’B...)
    const recentSignatures = this.callHistory
      .slice(-10)
      .map(c => this.getCallSignature(c));
    
    if (this.isPingPong(recentSignatures)) {
      return {
        blocked: true,
        reason: 'Ping-pong loop detected',
        suggestion: 'Agent is oscillating between approaches. Human review needed.'
      };
    }
    
    return { blocked: false };
  }

  getCallSignature(call) {
    // Create a signature that identifies "same" calls
    return JSON.stringify({
      tool: call.tool,
      action: call.action,
      // Normalize parameters to detect similarity
      params: this.normalizeParams(call.params)
    });
  }

  isPingPong(signatures) {
    if (signatures.length < 4) return false;
    
    // Check for A-B-A-B pattern
    const last4 = signatures.slice(-4);
    return last4[0] === last4[2] && last4[1] === last4[3] && last4[0] !== last4[1];
  }

  reset() {
    this.callHistory = [];
    this.errorPatterns.clear();
  }
}
```

### 5.3 Circuit Breaker

```javascript
class CircuitBreaker {
  constructor(config) {
    this.config = config;
    this.state = 'closed';  // closed, open, half-open
    this.failures = 0;
    this.lastFailure = null;
    this.successesSinceHalfOpen = 0;
  }

  async execute(operation) {
    // Check circuit state
    if (this.state === 'open') {
      if (Date.now() - this.lastFailure > this.config.resetTimeout) {
        this.state = 'half-open';
      } else {
        throw new CircuitOpenError('Circuit breaker is open', {
          failures: this.failures,
          retryAt: this.lastFailure + this.config.resetTimeout
        });
      }
    }
    
    try {
      const result = await operation();
      this.onSuccess();
      return result;
    } catch (error) {
      this.onFailure(error);
      throw error;
    }
  }

  onSuccess() {
    if (this.state === 'half-open') {
      this.successesSinceHalfOpen++;
      if (this.successesSinceHalfOpen >= this.config.successThreshold) {
        this.state = 'closed';
        this.failures = 0;
      }
    } else {
      this.failures = 0;
    }
  }

  onFailure(error) {
    this.failures++;
    this.lastFailure = Date.now();
    
    if (this.failures >= this.config.failureThreshold) {
      this.state = 'open';
      
      // Notify user
      notifyUser({
        type: 'circuit_breaker',
        message: `âš ï¸ Operation suspended after ${this.failures} failures. ` +
                 `Will retry in ${this.config.resetTimeout / 1000} seconds.`,
        error: error.message
      });
    }
  }
}

// Configuration
const circuitConfig = {
  failureThreshold: 5,     // Open after 5 failures
  resetTimeout: 60000,     // Try again after 1 minute
  successThreshold: 3      // Need 3 successes to fully close
};
```

---

## Part 6: User Communication

### 6.1 The Problem

> "From the user's perspective, the assistant simply stops responding â€” or worse, sends blank/ghost messages"
> "No indication that credits are exhausted or rate limits have been hit"

### 6.2 Transparent Status Updates

```javascript
class UserCommunicator {
  constructor(config, channel) {
    this.config = config;
    this.channel = channel;  // NC Talk, Telegram, etc.
    this.statusHistory = [];
  }

  // Always explain what's happening
  async notifyStatus(status) {
    const message = this.formatStatus(status);
    
    if (message) {
      await this.channel.send(message);
      this.statusHistory.push({ ...status, sentAt: Date.now() });
    }
  }

  formatStatus(status) {
    switch (status.type) {
      case 'rate_limit':
        return this.formatRateLimit(status);
      case 'failover':
        return this.formatFailover(status);
      case 'all_exhausted':
        return this.formatAllExhausted(status);
      case 'budget_warning':
        return this.formatBudgetWarning(status);
      case 'budget_exhausted':
        return this.formatBudgetExhausted(status);
      case 'task_queued':
        return this.formatTaskQueued(status);
      case 'circuit_open':
        return this.formatCircuitOpen(status);
      case 'loop_detected':
        return this.formatLoopDetected(status);
      default:
        return null;
    }
  }

  formatRateLimit(status) {
    return `â³ Rate limit reached on ${status.provider}. ` +
           `Switching to ${status.fallback}. Your task continues automatically.`;
  }

  formatFailover(status) {
    return `ðŸ”„ Switched from ${status.from} to ${status.to}. ` +
           `Reason: ${status.reason}. Processing continues.`;
  }

  formatAllExhausted(status) {
    return `âš ï¸ All AI providers temporarily unavailable.\n\n` +
           `Tried: ${status.attempted.join(', ')}\n` +
           `Next available: ${status.nextAvailable}\n\n` +
           `Your task has been queued and will complete automatically.`;
  }

  formatBudgetWarning(status) {
    return `ðŸ’° Budget alert: ${status.spent}/${status.budget} ` +
           `(${Math.round(status.percent)}%) used today.\n` +
           `Remaining: ${status.remaining}`;
  }

  formatBudgetExhausted(status) {
    return `ðŸ’° Daily budget reached for ${status.tier}.\n\n` +
           `Spent: ${status.spent}\n` +
           `Resets: ${status.resetTime}\n\n` +
           `Switching to local models. Reply OVERRIDE for one-time budget increase.`;
  }

  formatTaskQueued(status) {
    return `ðŸ“‹ Task queued (position ${status.position}).\n` +
           `Estimated completion: ${status.estimatedTime}\n` +
           `Reason: ${status.reason}`;
  }

  formatCircuitOpen(status) {
    return `ðŸ”Œ Operations paused after ${status.failures} consecutive errors.\n` +
           `Will retry automatically in ${Math.round(status.retryIn / 1000)} seconds.\n` +
           `Last error: ${status.lastError}`;
  }

  formatLoopDetected(status) {
    return `ðŸ”„ Loop detected: Same operation failing repeatedly.\n\n` +
           `Operation: ${status.operation}\n` +
           `Attempts: ${status.count}\n\n` +
           `Stopping to prevent waste. Please provide different instructions ` +
           `or try a different approach.`;
  }

  // Suppress duplicate notifications
  shouldNotify(status) {
    const recent = this.statusHistory.filter(
      s => s.type === status.type && 
           Date.now() - s.sentAt < this.config.suppressDuplicateWindow
    );
    return recent.length === 0;
  }
}
```

---

## Part 7: Budget Enforcement

### 7.1 Hard Limits That Actually Stop

```javascript
class BudgetEnforcer {
  constructor(config, storage) {
    this.config = config;
    this.storage = storage;
    this.usage = new Map();  // provider -> { tokens, cost, calls }
  }

  async canSpend(providerId, estimatedTokens) {
    const budget = this.config.budgets[providerId];
    if (!budget) return { allowed: true };  // No budget = unlimited
    
    const usage = await this.getUsage(providerId);
    const estimatedCost = this.estimateCost(providerId, estimatedTokens);
    
    // Check daily limit
    if (usage.dailyCost + estimatedCost > budget.daily) {
      return {
        allowed: false,
        reason: 'daily_budget_exceeded',
        spent: usage.dailyCost,
        budget: budget.daily,
        resetAt: this.getNextReset()
      };
    }
    
    // Check monthly limit
    if (budget.monthly && usage.monthlyCost + estimatedCost > budget.monthly) {
      return {
        allowed: false,
        reason: 'monthly_budget_exceeded',
        spent: usage.monthlyCost,
        budget: budget.monthly
      };
    }
    
    // Warning threshold (80%)
    const percentUsed = (usage.dailyCost + estimatedCost) / budget.daily;
    if (percentUsed > 0.8) {
      await this.notifyWarning(providerId, percentUsed, budget);
    }
    
    return { allowed: true, percentUsed };
  }

  async recordSpend(providerId, tokens, cost) {
    const usage = await this.getUsage(providerId);
    
    usage.dailyTokens += tokens;
    usage.dailyCost += cost;
    usage.monthlyCost += cost;
    usage.calls++;
    usage.lastCall = Date.now();
    
    this.usage.set(providerId, usage);
    await this.persistUsage();
  }

  async handleOverride(providerId, amount) {
    // User explicitly requested budget override
    const budget = this.config.budgets[providerId];
    if (!budget) return;
    
    // Temporary increase for this task only
    budget.daily += amount;
    
    await auditLog('budget_override', {
      provider: providerId,
      amount,
      newLimit: budget.daily,
      approvedBy: 'user_explicit_request'
    });
    
    // Reset after task completes
    setTimeout(() => {
      budget.daily -= amount;
    }, 300000);  // 5 minute window
  }

  estimateCost(providerId, tokens) {
    const provider = this.config.providers[providerId];
    if (!provider || provider.costModel.type !== 'per_token') {
      return 0;
    }
    
    // Assume 30% input, 70% output ratio
    const inputTokens = tokens * 0.3;
    const outputTokens = tokens * 0.7;
    
    return (inputTokens * provider.costModel.inputPer1M / 1000000) +
           (outputTokens * provider.costModel.outputPer1M / 1000000);
  }
}
```

---

## Part 8: Task Queue

### 8.1 Queue for Capacity Management

When all providers are exhausted, queue tasks instead of failing:

```javascript
class TaskQueue {
  constructor(config, storage, executor) {
    this.config = config;
    this.storage = storage;
    this.executor = executor;
    this.queue = [];
    this.processing = false;
  }

  async enqueue(task) {
    const queuedTask = {
      id: this.generateId(),
      ...task,
      queuedAt: Date.now(),
      status: 'pending',
      attempts: 0
    };
    
    this.queue.push(queuedTask);
    await this.persistQueue();
    
    // Start processor if not running
    this.startProcessor();
    
    return {
      queued: true,
      id: queuedTask.id,
      position: this.queue.length,
      estimatedWait: this.estimateWait()
    };
  }

  async startProcessor() {
    if (this.processing) return;
    this.processing = true;
    
    while (this.queue.length > 0) {
      const task = this.queue[0];
      
      // Wait for capacity
      const available = await this.waitForCapacity(task);
      if (!available) {
        await this.sleep(10000);  // Check again in 10s
        continue;
      }
      
      // Execute
      try {
        task.status = 'processing';
        task.attempts++;
        
        const result = await this.executor.execute(task);
        
        task.status = 'completed';
        task.result = result;
        task.completedAt = Date.now();
        
        // Notify user
        await notifyUser({
          type: 'queued_task_complete',
          taskId: task.id,
          result: result.summary || 'Task completed successfully'
        });
        
        this.queue.shift();  // Remove from queue
        
      } catch (error) {
        task.status = 'failed';
        task.lastError = error.message;
        
        if (task.attempts >= this.config.maxAttempts) {
          // Give up
          this.queue.shift();
          await notifyUser({
            type: 'queued_task_failed',
            taskId: task.id,
            error: error.message,
            attempts: task.attempts
          });
        }
        // Otherwise, stays in queue for retry
      }
      
      await this.persistQueue();
    }
    
    this.processing = false;
  }

  async waitForCapacity(task) {
    const check = await this.executor.checkCapacity(task.requirements);
    return check.available;
  }

  estimateWait() {
    if (this.queue.length === 0) return 0;
    
    // Rough estimate based on queue length and average processing time
    return this.queue.length * this.config.averageTaskTime;
  }
}
```

---

## Part 9: Configuration Reference

### 9.1 Complete Configuration Schema

```yaml
# moltagent-config.yaml

# Provider definitions
providers:
  ollama-local:
    type: local
    endpoint: http://localhost:11434
    model: deepseek-r1:8b
    
  nc-assistant:
    type: local
    endpoint: /ocs/v2.php/taskprocessing
    
  deepseek-api:
    type: api
    endpoint: https://api.deepseek.com
    credentialName: deepseek-api-key
    model: deepseek-chat
    costModel:
      inputPer1M: 0.14
      outputPer1M: 2.19
      
  claude-sonnet:
    type: api
    endpoint: https://api.anthropic.com
    credentialName: claude-api-key
    model: claude-sonnet-4-5-20250929
    costModel:
      inputPer1M: 3
      outputPer1M: 15

# Role assignments
roles:
  sovereign: [ollama-local]
  free: [nc-assistant, ollama-local]
  value: [deepseek-api, nc-assistant, ollama-local]
  premium: [claude-sonnet, deepseek-api, ollama-local]

# Fallback chains
fallbackChain:
  claude-sonnet: [deepseek-api, ollama-local]
  deepseek-api: [nc-assistant, ollama-local]
  nc-assistant: [ollama-local]
  ollama-local: []

# Budget limits
budgets:
  daily:
    claude-sonnet: 2.00
    deepseek-api: 1.00
  monthly:
    claude-sonnet: 50.00
    deepseek-api: 20.00

# Rate limit handling
rateLimits:
  backoff:
    initialDelayMs: 1000
    maxDelayMs: 300000
    multiplier: 2
    jitterPercent: 25
  maxRetries: 5
  failoverAfterAttempts: 2

# Circuit breaker
circuitBreaker:
  failureThreshold: 5
  resetTimeoutMs: 60000
  successThreshold: 3

# Loop detection
loopDetection:
  maxConsecutiveErrors: 3
  historyWindowMs: 60000
  pingPongThreshold: 4

# Heartbeat
heartbeat:
  enabled: true
  intervalMs: 300000
  localProvider: ollama-local
  maxScanTokens: 150
  contextLimits:
    total: 2000
    memory: 500
    email: 300
    calendar: 200
  escalation:
    role: value
    premiumTriggers: [URGENT, emergency, deadline]
    maxTokens: 500

# Context management
context:
  startup:
    maxTokens: 1000
    files:
      user: 500
      priorities: 300
      todayLog: 200
  searchBeforeLoad: true
  cacheTimeMs: 60000

# Response limits
responseLimits:
  heartbeat: 150
  quickAnswer: 256
  standard: 512
  detailed: 1024
  comprehensive: 2048

# User communication
communication:
  notifyOnRateLimit: true
  notifyOnFailover: true
  notifyOnBudgetWarning: true
  budgetWarningThreshold: 0.8
  suppressDuplicateWindowMs: 60000

# Task queue
taskQueue:
  enabled: true
  maxAttempts: 3
  persistPath: /moltagent/queue.json
  averageTaskTimeMs: 30000
```

---

## Summary: Lessons Learned

From real OpenClaw user pain, MoltAgent implements:

| Problem | Solution | Section |
|---------|----------|---------|
| Rate limit death spiral | Exponential backoff + cross-provider failover | Part 2 |
| No local fallback | Local tier always available, ends every fallback chain | Part 1 |
| 8.5M tokens/day from heartbeat | Local-first heartbeat, escalate only when needed | Part 3 |
| 26K context loads | Search-then-load, minimal startup context | Part 4 |
| Infinite tool loops | Loop detection + circuit breakers | Part 5 |
| Ghost messages | Always explain what's happening to user | Part 6 |
| Runaway costs | Hard budget limits that actually stop | Part 7 |
| Total failure when exhausted | Task queue with automatic retry | Part 8 |

**The philosophy:**

> MoltAgent fails gracefully, communicates transparently, and always has a local escape hatch.
> 
> When the cloud fails, local keeps working.
> When budgets exhaust, users know why.
> When loops occur, they're caught and stopped.
> When everything breaks, tasks queue for later.
>
> Your agent should never just... stop responding.
