# Nextcloud API Resilience Layer — Implementation Briefing

**For:** Claude Code
**Date:** 2026-02-05
**Priority:** CRITICAL — Blocks all NC operations
**Replaces:** `credential-cache-briefing.md` (now subsumed into this)
**File placement:** Save this to `/docs/nc-resilience-briefing.md`

---

## Problem Statement

Nextcloud rate-limits API requests across ALL endpoints — not just the Passwords app. We are hitting HTTP 429 on CalDAV calendar writes, Deck card moves, Passwords credential fetches, and likely WebDAV file operations under load. Nextcloud applies rate limiting at two levels:

1. **Per-route rate limiting.** App developers annotate controller methods with `@UserRateThrottle(limit=N, period=S)`. Each endpoint has its own independent counter. When exceeded: HTTP 429.

2. **Bruteforce protection.** Failed auth attempts (wrong password, expired token) trigger progressive slowdown up to 30-second delays per request, persisting for 24 hours per IP.

Both are tracked in Nextcloud's memory cache (APCu/Redis). Both return 429. Both can cascade — hitting one 429 often causes retries that hit more 429s.

Our current code makes individual API calls with no awareness of rate limits, no queuing, no backoff, and no caching. Every heartbeat cycle fires dozens of NC requests in a burst. This is unsustainable.

**Solution:** A single `NCRequestManager` that ALL Nextcloud API calls pass through. It provides rate-aware queuing, response caching, automatic backoff, and batch optimization. Every existing NC client (DeckClient, CalDAV, CredentialBroker, WebDAV file ops, Talk client, NC Assistant) must route through it.

---

## Architecture

```
BEFORE (current — every client hits NC directly):

  CredentialBroker ──────► NC Passwords API ──► 429 💥
  CalDAVClient ──────────► NC CalDAV ──────────► 429 💥
  DeckClient ─────────────► NC Deck OCS ───────► 429 💥
  AuditLogger (WebDAV) ──► NC Files API ───────► 429 💥
  TalkClient ─────────────► NC Talk OCS ───────► 429 💥
  NCAssistant ────────────► NC TaskProcessing ─► 429 💥


AFTER (all traffic flows through NCRequestManager):

  CredentialBroker ──┐
  CalDAVClient ──────┤
  DeckClient ────────┤
  AuditLogger ───────┼──► NCRequestManager ──► NC Server
  TalkClient ────────┤        │
  NCAssistant ───────┘        ├─ Request queue with concurrency limit
                              ├─ Per-endpoint rate tracking
                              ├─ Automatic backoff on 429
                              ├─ Response cache (configurable per-endpoint)
                              ├─ Stale-while-revalidate on 429
                              ├─ Batch coalescing where possible
                              └─ Metrics & logging
```

---

## Design Constraints

1. **Single point of NC access.** After this work, NO module should call `fetch()` against the NC server directly. Everything goes through `NCRequestManager`.
2. **Credentials still never touch disk.** The credential cache portion (from the previous briefing) is now a feature of `NCRequestManager`, not a standalone class.
3. **Existing public APIs unchanged.** `CredentialBroker.withCredential()`, `DeckClient.moveCard()`, `CalDAVClient.createEvent()` — all keep their signatures. The resilience layer is injected underneath.
4. **Fail-open for reads, fail-closed for writes.** If we are rate-limited and have a stale cached read, serve it. If we are rate-limited and need to write (create calendar entry, move Deck card), queue it and retry — do NOT silently drop it.
5. **No external dependencies.** Pure Node.js. No Redis, no external queue. In-process `Map` + `Array` only.

---

## What to Build

### File 1: `src/lib/nc-request-manager.js` (CREATE — Core)

This is the central module. All NC API calls flow through it.

#### Internal State

```javascript
class NCRequestManager {
  constructor(config) {
    this.config = config;
    
    // --- Auth ---
    this.ncUrl = config.nextcloud.url;
    this.ncUser = config.nextcloud.user;
    this.ncPassword = null; // Set via setBootstrapCredential()
    
    // --- Rate tracking (per-endpoint-group) ---
    // Key: endpoint group name (e.g., 'passwords', 'caldav', 'deck', 'webdav', 'talk')
    // Value: { remaining: number|null, resetAt: number|null, lastResponse: number }
    this.rateLimits = new Map();
    
    // --- Request queue ---
    this.queue = [];             // { id, endpoint, options, resolve, reject, priority, addedAt }
    this.activeRequests = 0;
    this.maxConcurrent = config.ncResilience?.maxConcurrent || 4;
    this.processing = false;
    
    // --- Response cache ---
    // Key: cache key (method + url + body hash)
    // Value: { response, fetchedAt, ttlMs, endpointGroup }
    this.cache = new Map();
    
    // --- Backoff state ---
    // Key: endpoint group
    // Value: { backoffUntil: timestamp, consecutiveFailures: number }
    this.backoff = new Map();
    
    // --- Metrics ---
    this.metrics = {
      totalRequests: 0,
      cacheHits: 0,
      cacheMisses: 0,
      rateLimited: 0,
      retries: 0,
      staleServed: 0,
      queueHighWaterMark: 0
    };
    
    // --- Sweep timer ---
    this.sweepTimer = null;
  }
}
```

#### Endpoint Groups

Different NC APIs have different rate limits and caching characteristics. Classify every request into a group:

```javascript
const ENDPOINT_GROUPS = {
  passwords: {
    // NC Passwords app — credential fetching
    pattern: /\/apps\/passwords\//,
    cacheTtlMs: 300000,       // 5 minutes (credentials change rarely)
    cacheable: true,           // GET/POST list/find are cacheable
    maxBurstPerMinute: 20,     // conservative to stay under throttle
    priority: 'high',          // credentials needed before anything else
    retryable: true,
    writeMethods: ['PUT', 'PATCH', 'DELETE'],  // create/update/delete not cacheable
  },
  
  caldav: {
    // CalDAV — calendar read/write
    pattern: /\/remote\.php\/dav\/calendars\//,
    cacheTtlMs: 60000,        // 1 minute (events change more often)
    cacheable: true,           // PROPFIND, REPORT are cacheable reads
    maxBurstPerMinute: 30,
    priority: 'normal',
    retryable: true,
    writeMethods: ['PUT', 'DELETE', 'MKCALENDAR'],
  },
  
  webdav: {
    // WebDAV — file operations (audit logs, memory, inbox/outbox)
    pattern: /\/remote\.php\/dav\/files\//,
    cacheTtlMs: 30000,        // 30 seconds
    cacheable: true,           // GET, PROPFIND are cacheable
    maxBurstPerMinute: 40,
    priority: 'low',           // file ops can wait
    retryable: true,
    writeMethods: ['PUT', 'DELETE', 'MKCOL', 'MOVE', 'COPY'],
  },
  
  deck: {
    // Deck OCS API — kanban card operations
    pattern: /\/apps\/deck\/api\//,
    cacheTtlMs: 30000,        // 30 seconds
    cacheable: true,           // GET board/stack/card listings
    maxBurstPerMinute: 30,
    priority: 'normal',
    retryable: true,
    writeMethods: ['POST', 'PUT', 'DELETE'],
  },
  
  talk: {
    // NC Talk OCS API — chat operations
    pattern: /\/apps\/spreed\//,
    cacheTtlMs: 5000,         // 5 seconds (chat is near-realtime)
    cacheable: true,           // GET message history
    maxBurstPerMinute: 30,
    priority: 'normal',
    retryable: true,
    writeMethods: ['POST', 'PUT', 'DELETE'],
  },
  
  taskprocessing: {
    // NC AI Assistant / Task Processing
    pattern: /\/taskprocessing\//,
    cacheTtlMs: 10000,        // 10 seconds (poll results)
    cacheable: true,           // GET task status
    maxBurstPerMinute: 20,
    priority: 'low',
    retryable: true,
    writeMethods: ['POST'],    // schedule is a write
  },
  
  ocs: {
    // Generic OCS API (user info, capabilities, etc.)
    pattern: /\/ocs\/v[12]\.php\//,
    cacheTtlMs: 60000,
    cacheable: true,
    maxBurstPerMinute: 30,
    priority: 'normal',
    retryable: true,
    writeMethods: ['POST', 'PUT', 'DELETE'],
  }
};
```

Match incoming requests by testing the URL against patterns, first match wins. If no match, default to `ocs` group.

#### Core Method: `request()`

This is the ONE method everything calls. It replaces all direct `fetch()` calls to NC.

```
async request(url, options = {}) → Response

options: {
  method: 'GET' | 'POST' | 'PUT' | etc.,
  headers: {},
  body: string | object,
  
  // Resilience options (caller can override per-request):
  cacheTtlMs: number | null,    // null = use group default. 0 = skip cache.
  priority: 'high' | 'normal' | 'low',
  skipQueue: boolean,            // true = bypass queue (for bootstrap only)
  retryCount: number,            // internal, tracks retries (default 0)
  maxRetries: number,            // default 3
  cacheKey: string | null,       // custom cache key override
  staleWhileRevalidate: boolean, // default true for reads
}
```

**Flow:**

```
request(url, options):
  1. Classify endpoint group from URL
  2. Build full URL (prepend ncUrl if relative)
  3. Determine if this is a read or write (from method + group.writeMethods)
  4. Add auth headers (Basic auth with bootstrap credential)

  FOR READS:
    5a. Check cache → if hit and fresh → return cached (metrics: cacheHit++)
    5b. If in backoff for this group AND have stale cache entry →
        return stale, log WARNING (metrics: staleServed++)
    5c. Enqueue the request (with priority)

  FOR WRITES:
    5a. Cannot serve from cache
    5b. If in backoff for this group → enqueue (it will wait)
    5c. Enqueue the request (with priority)

  6. Queue processor picks up request when:
     - activeRequests < maxConcurrent
     - endpoint group is not in backoff
     - ordered by priority then FIFO

  7. Execute fetch()
     - On success (2xx): update rate tracking, cache response, return
     - On 429: handle429() → backoff, maybe serve stale, maybe requeue
     - On 5xx: handleServerError() → requeue with exponential backoff
     - On 401/403: handleAuthError() → do NOT requeue (avoid bruteforce)
```

#### 429 Handler

```
handle429(endpointGroup, response, queuedRequest):
  1. Parse Retry-After header (seconds or HTTP-date)
     If absent, default to 30 seconds
  2. Set backoff:
     backoff.set(group, {
       backoffUntil: Date.now() + retryAfterMs,
       consecutiveFailures: current + 1
     })
  3. Log WARNING with group, retry-after, queue depth
  4. metrics.rateLimited++

  FOR READS with stale cache available:
    5a. Return stale cached response
    5b. Requeue a background refresh (lower priority)
    5c. metrics.staleServed++

  FOR READS without cache:
    5a. If retryCount < maxRetries → requeue with delay
    5b. Else → reject with RateLimitError

  FOR WRITES:
    5a. ALWAYS requeue (writes must not be lost)
    5b. If retryCount >= maxRetries → reject with RateLimitError
        AND log ERROR (a write was lost)
```

#### Queue Processor

```
processQueue() — called whenever a request completes or is enqueued:
  while (activeRequests < maxConcurrent && queue.length > 0):
    Sort queue by: priority DESC, then addedAt ASC
    
    Pick first item whose endpoint group is NOT in backoff
    (skip items whose group is still backing off)
    
    If no eligible items → stop (will resume when backoff expires)
    
    activeRequests++
    Execute request in background, on completion:
      activeRequests--
      processQueue()  // process next
```

Start a timer to re-check the queue when the earliest backoff expires:

```javascript
scheduleBackoffResume() {
  const earliest = Math.min(
    ...Array.from(this.backoff.values())
      .map(b => b.backoffUntil)
      .filter(t => t > Date.now())
  );
  if (earliest < Infinity) {
    setTimeout(() => this.processQueue(), earliest - Date.now() + 50);
  }
}
```

#### Cache Key Generation

```javascript
function cacheKey(method, url, body) {
  // Only cache safe methods
  // POST is also cached for NC APIs that use POST for queries
  // (like Passwords find, Deck search)
  const normalized = `${method}:${url}:${typeof body === 'string' ? body : JSON.stringify(body || '')}`;
  // Simple hash to keep map keys short
  return crypto.createHash('sha256').update(normalized).digest('hex').slice(0, 16);
}
```

For write methods (PUT, DELETE, MKCOL, etc.): never cache, and **invalidate** any cached entry for that URL on success.

#### Auth Header Injection

Every request gets auth headers automatically:

```javascript
injectAuth(headers) {
  const auth = Buffer.from(`${this.ncUser}:${this.ncPassword}`).toString('base64');
  return {
    ...headers,
    'Authorization': `Basic ${auth}`,
    'OCS-APIRequest': 'true',  // required for all OCS endpoints
  };
}
```

The bootstrap credential (`this.ncPassword`) is set once at startup via `setBootstrapCredential()` which reads from `process.env.CREDENTIALS_DIRECTORY`.

#### Shutdown

```javascript
async shutdown() {
  // 1. Stop accepting new requests
  this.accepting = false;
  
  // 2. Wait for active requests to finish (with timeout)
  await this.drainQueue(5000);
  
  // 3. Reject any remaining queued items
  for (const item of this.queue) {
    item.reject(new Error('NCRequestManager shutting down'));
  }
  this.queue = [];
  
  // 4. Secure-evict all cached data
  for (const [key, entry] of this.cache) {
    this.secureEvict(entry);
  }
  this.cache.clear();
  
  // 5. Clear timers
  clearInterval(this.sweepTimer);
  
  // 6. Log final metrics
  this.logMetrics();
}
```

---

### File 2: `src/lib/credential-cache.js` (CREATE — Credential-Specific Cache Logic)

This is now a **thin wrapper** that adds credential-specific semantics on top of `NCRequestManager`'s general cache. It handles:

- **Prefetch batching:** `prefetchAll()` calls the `password/list` endpoint once, caches each result individually.
- **Secure eviction:** Nulls out password/username fields (not just drops the reference).
- **Credential-specific TTL:** Overrides the generic passwords group TTL per-credential-name.

```
class CredentialCache {
  constructor(ncRequestManager, config) {
    this.nc = ncRequestManager;
    this.config = config;
    this.credentialTtls = config.credentialBroker?.perCredentialTtl || {};
    this.defaultTtl = config.credentialBroker?.cache?.defaultTtlMs || 300000;
    
    // In-memory map of parsed credentials (separate from HTTP response cache)
    // Key: credential name (e.g., 'claude-api-key')
    // Value: { credential: Object, fetchedAt: number, ttlMs: number }
    this.parsed = new Map();
  }

  async get(name)          // returns parsed credential or null if expired
  async prefetchAll(names) // batch fetch via password/list
  invalidate(name)         // secure-evict one credential
  invalidateAll()          // panic button
  shutdown()               // alias for invalidateAll + cleanup
}
```

**prefetchAll() detail:**

```
async prefetchAll(names):
  1. Filter names → only those not in this.parsed or expired
  2. If none needed → return early (all cached)
  3. Call this.nc.request('/index.php/apps/passwords/api/1.0/password/list', {
       method: 'POST',
       body: {},
       cacheTtlMs: 0  // don't cache the raw list response, we cache parsed
     })
  4. Match returned passwords by label against requested names
  5. Parse each matched credential (same parseCredential() logic as before)
  6. Store each in this.parsed with its TTL
  7. Return { refreshed: [...], cachedValid: [...], notFound: [...] }
```

**Secure eviction for credentials:**

```javascript
secureEvictCredential(entry) {
  if (entry?.credential) {
    Object.keys(entry.credential).forEach(key => {
      if (typeof entry.credential[key] === 'string') {
        entry.credential[key] = '';  // overwrite with empty before null
      }
      entry.credential[key] = null;
    });
    entry.credential = null;
  }
}
```

---

### File 3: Modify `src/lib/credential-broker.js` (MODIFY)

Integrate with `CredentialCache` and `NCRequestManager`:

```
Changes:
  - Constructor takes NCRequestManager + config (not raw ncUrl/ncUser)
  - Remove direct fetch() calls
  - get(name) → checks CredentialCache first, then requests via NCRequestManager
  - withCredential(name, operation) → unchanged public API
  - Add prefetchAll() → delegates to CredentialCache
  - Remove loadBootstrapCredential() → NCRequestManager owns auth
  - Remove auditLog direct WebDAV call → route through NCRequestManager
```

The key insight: `CredentialBroker` becomes a **thin API** on top of `CredentialCache` and `NCRequestManager`. It no longer handles HTTP, auth, or caching itself.

---

### File 4: Modify ALL NC clients to use NCRequestManager (MODIFY)

Every module that talks to Nextcloud must be refactored to call `ncRequestManager.request()` instead of `fetch()`.

#### `src/lib/calendar/caldav-client.js`

The tsdav library creates its own HTTP client internally. We have two options:

**Option A (Preferred):** Configure tsdav with a custom `fetchFn`:
```javascript
// tsdav supports passing a custom fetch function
this.client = new DAVClient({
  serverUrl: `${this.config.nextcloud.url}/remote.php/dav`,
  credentials: { username: cred.username, password: cred.password },
  authMethod: 'Basic',
  defaultAccountType: 'caldav',
  fetchFn: (url, init) => this.ncRequestManager.request(url, init),
});
```

If tsdav does not support `fetchFn`, use **Option B:** Wrap the CalDAV operations at the handler level. Before each `tsdav` method call, check `NCRequestManager` for backoff on the `caldav` group. If in backoff, queue the operation. This is messier but still works.

**Investigate which approach tsdav supports and document your findings in a comment.**

#### `src/lib/deck-client.js` (or wherever DeckClient lives)

DeckClient already uses `fetch()` with manual auth headers. Replace:
```javascript
// BEFORE:
const response = await fetch(`${this.baseUrl}/api/v1/boards/${boardId}/stacks`, {
  headers: this.authHeaders,
});

// AFTER:
const response = await this.nc.request(
  `/index.php/apps/deck/api/v1.0/boards/${boardId}/stacks`,
  { method: 'GET' }
);
```

The `NCRequestManager` handles auth injection, so remove manual auth header construction from DeckClient.

#### `src/lib/audit-logger.js` (WebDAV writes)

Audit log appends go through NCRequestManager's `webdav` group:
```javascript
// BEFORE:
await fetch(`${ncUrl}/remote.php/dav/files/moltagent/Logs/audit.jsonl`, {
  method: 'PUT', headers: authHeaders, body: logContent
});

// AFTER:
await this.nc.request(
  `/remote.php/dav/files/moltagent/Logs/audit.jsonl`,
  { method: 'PUT', body: logContent, cacheTtlMs: 0 }
);
```

**Important:** Audit log writes should NOT be silently dropped on 429. They must be queued and retried. The NCRequestManager's write handling already ensures this.

#### `src/lib/talk/talk-client.js`

Same pattern — replace direct `fetch()` with `this.nc.request()`.

#### `src/lib/nc-assistant.js` (NC Task Processing)

Same pattern. The polling loop (`waitForCompletion`) naturally benefits from NCRequestManager's queue since each poll is a separate request that respects rate limits.

---

### File 5: `src/lib/nc-request-manager.js` — Config

```javascript
// These go in the main MoltAgent config:
{
  ncResilience: {
    maxConcurrent: 4,           // max parallel requests to NC
    defaultMaxRetries: 3,       // per-request retry limit
    sweepIntervalMs: 60000,     // clean stale cache entries
    
    // Per-group overrides (merged with ENDPOINT_GROUPS defaults)
    groups: {
      passwords: {
        cacheTtlMs: 300000,     // 5 min for credentials
        maxBurstPerMinute: 20,
      },
      caldav: {
        cacheTtlMs: 60000,      // 1 min for calendar data
        maxBurstPerMinute: 30,
      },
      deck: {
        cacheTtlMs: 30000,
        maxBurstPerMinute: 30,
      },
      webdav: {
        cacheTtlMs: 30000,
        maxBurstPerMinute: 40,
      },
      talk: {
        cacheTtlMs: 5000,
        maxBurstPerMinute: 30,
      },
      taskprocessing: {
        cacheTtlMs: 10000,
        maxBurstPerMinute: 20,
      }
    }
  },
  
  credentialBroker: {
    cache: {
      enabled: true,
      defaultTtlMs: 300000,
    },
    perCredentialTtl: {
      'claude-api-key': 600000,
      'email-smtp': 300000,
      'caldav-access': 300000,
    },
    prefetchOnHeartbeat: [
      'nc-files-token',
      'caldav-access',
      'claude-api-key',
      'deepseek-api-key',
      'email-imap',
      'email-smtp'
    ]
  }
}
```

---

### File 6: Modify HeartbeatManager (MODIFY)

```javascript
async heartbeat() {
  // STEP 0: Prefetch credentials for this cycle (1 API call)
  await this.credentialBroker.prefetchAll(
    this.config.credentialBroker.prefetchOnHeartbeat
  );

  // STEP 1: Minimal local scan (existing code, unchanged)
  // ...
  
  // All subsequent operations (Deck, Calendar, Files, Talk)
  // now go through NCRequestManager automatically
  // because each client was refactored to use it.
}
```

---

### File 7: `docs/rate-limit-tuning.md` (CREATE — Deployment Guide)

Include these sections:

#### For Hetzner Storage Share Users

```bash
# Set Passwords app performance to high
# (Run via konsoleH → Settings → Configuration → OCC)
occ config:app:set passwords performance --value=5
```

Values: 0 = very low (aggressive throttling), 5 = high (relaxed), 6 = no restrictions. Recommend 5.

**Note:** Hetzner Storage Share does NOT expose `config.php` for editing. Rate limit overrides that require `config.php` changes are NOT available on Storage Share. The resilience layer in MoltAgent is the primary mitigation.

#### For Self-Hosted Nextcloud Users

Users with `config.php` access can override rate limits per-route. First find the route names:

```bash
occ router:list | grep -E "passwords|deck|spreed|dav"
```

Then add to `config.php`:

```php
'ratelimit_overwrite' => [
  // NC Passwords API — credential operations
  'passwords.password_api.list' => [
    'user' => ['limit' => 120, 'period' => 60],
  ],
  'passwords.password_api.find' => [
    'user' => ['limit' => 120, 'period' => 60],
  ],
  'passwords.password_api.show' => [
    'user' => ['limit' => 120, 'period' => 60],
  ],
  'passwords.session_api.open' => [
    'user' => ['limit' => 30, 'period' => 60],
  ],
  
  // Deck API — task management
  'deck.board_api.index' => [
    'user' => ['limit' => 60, 'period' => 60],
  ],
  'deck.stack_api.index' => [
    'user' => ['limit' => 60, 'period' => 60],
  ],
  'deck.card_api.update' => [
    'user' => ['limit' => 60, 'period' => 60],
  ],
],
```

**Important:** Route names must exactly match output of `occ router:list`. If wrong, the override is silently ignored. The names above are best-guess and must be verified per installation.

#### Bruteforce Protection Warning

If the MoltAgent bootstrap credential ever fails auth (e.g., password changed in NC but not in `/etc/credstore/`), Nextcloud's bruteforce protection will throttle ALL requests from the MoltBot VM IP. Recovery:

```bash
occ security:bruteforce:reset <MOLTBOT_VM_IP>
```

MoltAgent should alert immediately on any 401/403 from NC rather than retrying, to avoid triggering bruteforce escalation.

#### Monitoring

Include guidance to set the alert condition from the existing spec:

> Credential request rate > 50/hour (baseline ~20)

After this work, the baseline will drop to ~12/hour for credentials and the total NC request rate should stay under 200/hour. Update the alert threshold to:

- Total NC requests > 300/hour → WARNING
- Any 429 received → WARNING
- 5+ consecutive 429s on same endpoint group → ERROR
- Any 401/403 → CRITICAL (possible bootstrap credential failure)

---

## Files Summary

| File | Action | Description |
|------|--------|-------------|
| `src/lib/nc-request-manager.js` | **CREATE** | Central NC API gateway with queue, cache, backoff |
| `src/lib/credential-cache.js` | **CREATE** | Credential-specific cache with prefetch and secure eviction |
| `src/lib/credential-broker.js` | **MODIFY** | Remove direct fetch, delegate to CredentialCache + NCRequestManager |
| `src/lib/calendar/caldav-client.js` | **MODIFY** | Route through NCRequestManager (via fetchFn or wrapper) |
| `src/lib/deck-client.js` | **MODIFY** | Replace fetch() with nc.request() |
| `src/lib/audit-logger.js` | **MODIFY** | Replace fetch() with nc.request() |
| `src/lib/talk/talk-client.js` | **MODIFY** | Replace fetch() with nc.request() |
| `src/lib/nc-assistant.js` | **MODIFY** | Replace fetch() with nc.request() |
| `src/lib/heartbeat-manager.js` | **MODIFY** | Add prefetchAll() at cycle start |
| `test/nc-request-manager.test.js` | **CREATE** | Unit tests |
| `test/credential-cache.test.js` | **CREATE** | Unit tests |
| `docs/rate-limit-tuning.md` | **CREATE** | Deployment guide |

---

## Test Requirements

### nc-request-manager.test.js

Mock `fetch()` globally. Test:

1. **Basic request routing.** Call `nc.request('/apps/deck/api/...')` — verify it matches the `deck` group.
2. **Auth injection.** Verify every request gets Basic auth + OCS-APIRequest header.
3. **Read caching.** GET same URL twice — verify only 1 fetch, second served from cache.
4. **Cache expiry.** GET, advance time past TTL, GET again — verify 2 fetches.
5. **Write-through.** PUT to a URL — verify it is NOT cached, and any cached GET for that URL is invalidated.
6. **429 with stale cache (read).** Seed cache, expire it, mock 429 — verify stale response returned.
7. **429 without cache (read).** Mock 429, no cache — verify requeue, then eventual delivery or RateLimitError after maxRetries.
8. **429 on write.** Mock 429 on PUT — verify requeue, eventual delivery, write NOT dropped.
9. **Concurrency limit.** Fire 10 requests — verify only maxConcurrent execute simultaneously.
10. **Priority ordering.** Queue 3 low + 1 high — verify high executes first.
11. **Backoff respects group isolation.** 429 on `deck` group — verify `caldav` group continues unaffected.
12. **401/403 NOT retried.** Mock 401 — verify no requeue, immediate rejection, metrics track it.
13. **Shutdown drains.** Queue 5 requests, call shutdown() — verify active ones complete, queued ones rejected.
14. **Metrics counters.** Verify hits, misses, rateLimited, staleServed all count correctly.

### credential-cache.test.js

1. **prefetchAll() batching.** Call with 5 names — verify 1 HTTP call to `password/list`.
2. **prefetchAll() skips cached.** Pre-populate 2, request 5 — verify only 1 HTTP call, 2 not re-parsed.
3. **get() returns parsed credential.** Verify username/password/customFields all parsed.
4. **Secure eviction.** Invalidate a credential — verify the original object's fields are null.
5. **invalidateAll().** Store 5, invalidateAll() — verify all objects nulled, map empty.
6. **TTL per-credential.** Two credentials with different TTLs expire independently.
7. **Stale credential on 429.** Expire a credential, mock 429 on refetch — verify stale returned.

---

## Dependency Injection Wiring

At startup (in `index.js` or wherever the app boots):

```javascript
// 1. Create the central request manager
const ncRequestManager = new NCRequestManager(config);
ncRequestManager.setBootstrapCredential(); // reads from CREDENTIALS_DIRECTORY

// 2. Create credential cache (uses ncRequestManager)
const credentialCache = new CredentialCache(ncRequestManager, config);

// 3. Create credential broker (uses credentialCache)
const credentialBroker = new CredentialBroker(credentialCache, config);

// 4. Create all NC clients (each receives ncRequestManager)
const deckClient = new DeckClient(ncRequestManager, config);
const caldavClient = new CalDAVClient(ncRequestManager, credentialBroker, config);
const talkClient = new TalkClient(ncRequestManager, config);
const auditLogger = new AuditLogger(ncRequestManager, config);
const ncAssistant = new NCAssistant(ncRequestManager, credentialBroker, config);

// 5. Create heartbeat manager (uses all of the above)
const heartbeat = new HeartbeatManager(config, credentialBroker, ...);

// 6. Register shutdown hook
process.on('SIGTERM', async () => {
  await credentialCache.shutdown();
  await ncRequestManager.shutdown();
  process.exit(0);
});
```

---

## Implementation Order

1. `src/lib/nc-request-manager.js` — core module, no dependencies on existing code
2. `test/nc-request-manager.test.js` — verify it works in isolation with mocked fetch
3. `src/lib/credential-cache.js` — builds on NCRequestManager
4. `test/credential-cache.test.js` — verify credential-specific logic
5. Modify `src/lib/credential-broker.js` — integrate with new modules
6. Modify `src/lib/deck-client.js` — swap fetch for nc.request
7. Modify `src/lib/calendar/caldav-client.js` — investigate tsdav fetchFn, integrate
8. Modify `src/lib/audit-logger.js` — swap fetch for nc.request
9. Modify `src/lib/talk/talk-client.js` — swap fetch for nc.request
10. Modify `src/lib/nc-assistant.js` — swap fetch for nc.request
11. Modify `src/lib/heartbeat-manager.js` — add prefetchAll at cycle start
12. Wire up in `index.js` (or startup module)
13. Shutdown hooks
14. `docs/rate-limit-tuning.md`
15. Integration test: run a full heartbeat cycle with mocked NC, verify total request count ≤ expected

---

## Security Tradeoff Documentation

Add as header comment in `nc-request-manager.js`:

```
SECURITY TRADEOFF: RESPONSE CACHING

This module caches Nextcloud API responses in process memory.

What this means:
- Read responses (calendar events, deck cards, file listings) may be
  up to [cacheTtlMs] old.
- Credential data cached by CredentialCache may be up to [defaultTtlMs]
  old (default 5 minutes).
- If access is revoked in NC, cached data remains usable until TTL
  expiry.

Why this is acceptable:
- Caching reduces NC API calls from 300+/hr to ~30/hr, preventing
  rate-limit lockouts that would ALSO delay revocation detection.
- Credentials still never touch disk.
- The process can be killed instantly (systemctl stop moltagent).
- For immediate revocation: disable the moltagent NC user account
  (occ user:disable moltagent) — this invalidates the bootstrap
  credential and stops ALL operations regardless of cache state.
- TTL is configurable per endpoint group and per credential.

For maximum security at the cost of more API calls:
  Set all cacheTtlMs values to 10000 (10 seconds).
```

---

## Do NOT Change

- The bootstrap credential mechanism (systemd LoadCredential=)
- The `withCredential(name, operation)` public API signature
- The credential organization in NC Passwords (folder structure)
- Network segmentation or firewall rules
- The HeartbeatManager's scan/escalation logic
- The LLM routing table (which operations go to Ollama vs Claude)
- Any security guards (PromptGuard, SecretsGuard, etc.)

---

## Expected Outcome

After implementation, a full heartbeat cycle that currently generates 20-40 individual NC API calls will generate:

| Phase | Before | After |
|-------|--------|-------|
| Credential fetch | 5-7 calls | 1 call (password/list via prefetchAll) |
| Deck board scan | 3-4 calls | 0-1 (cached from previous cycle) |
| Calendar check | 2-3 calls | 0-1 (cached) |
| File operations | 3-5 calls | 1-3 (writes go through, reads cached) |
| Talk polling | 2-3 calls | 1-2 (short TTL, near-realtime) |
| Audit log writes | 2-3 calls | 2-3 (writes always go through) |
| **Total per cycle** | **20-40** | **5-10** |
| **Per hour (5-min cycle)** | **240-480** | **60-120** |
