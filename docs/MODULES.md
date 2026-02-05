# MoltAgent Module Reference

Quick reference for navigating the codebase. Each module includes its purpose, key exports, and dependencies.

## Directory Structure

```
src/
├── bot.js                    # Main entry point
├── lib/
│   ├── config.js             # Centralized configuration
│   ├── credential-broker.js  # NC Passwords credential management
│   ├── credential-cache.js   # Credential caching layer
│   ├── nc-request-manager.js # Rate-limited NC API client
│   ├── output-verifier.js    # LLM output security scanning
│   ├── pending-action-store.js # HITL confirmation state
│   ├── talk-signature-verifier.js # Webhook signature verification
│   ├── errors/               # Error handling
│   ├── handlers/             # Message routing and handlers
│   ├── integrations/         # External service clients
│   ├── llm/                  # LLM provider abstraction
│   └── server/               # HTTP server components
└── webhook-server.js         # HTTP server entry point
```

---

## Core Modules

### `config.js`
**Purpose:** Centralized configuration with environment variable support.

```javascript
const config = require('./lib/config');
config.nextcloud.url      // NC base URL
config.ollama.url         // Ollama endpoint
config.timeouts.*         // All timeout values
config.cacheTTL.*         // Cache TTL values
```

**Key features:**
- Deep-frozen (immutable at runtime)
- Environment variable overrides
- Type-safe parsing helpers

---

### `credential-broker.js`
**Purpose:** Secure credential retrieval from NC Passwords app.

```javascript
const { CredentialBroker } = require('./lib/credential-broker');
const broker = new CredentialBroker({ nextcloud: { url, username } });
const cred = await broker.getCredential('email/imap');
broker.discardAll(); // Security: clear on shutdown
```

**Key features:**
- Fetches credentials on-demand (not stored)
- Supports systemd credential injection
- Immediate discard capability

---

### `nc-request-manager.js`
**Purpose:** Rate-limited, resilient HTTP client for Nextcloud APIs.

```javascript
const NCRequestManager = require('./lib/nc-request-manager');
const nc = new NCRequestManager({ nextcloud: { url, username } });
const response = await nc.request('/ocs/v2.php/...', { method: 'GET' });
```

**Key features:**
- Concurrency limiting (default: 4)
- Automatic retry with backoff
- 429 rate limit handling
- Request queuing

---

### `pending-action-store.js`
**Purpose:** TTL-based storage for HITL confirmations.

```javascript
const { pendingEmailReplies } = require('./lib/pending-action-store');
pendingEmailReplies.store('email_reply', data, { ttl: 300000 });
const item = pendingEmailReplies.getRecent('email_reply');
```

**Key features:**
- Type-scoped storage
- Automatic expiration cleanup
- Replaces `global.pendingEmailReplies`

---

### `output-verifier.js`
**Purpose:** Security layer scanning LLM outputs before execution.

```javascript
const OutputVerifier = require('./lib/output-verifier');
const verifier = new OutputVerifier({ strictMode: true });
const result = verifier.verify(llmOutput);
if (result.blocked) { /* reject */ }
```

**Detects:**
- Shell injection (`rm -rf`, `curl | sh`)
- Credential patterns
- URL exfiltration attempts
- SQL injection
- Prompt injection

---

### `talk-signature-verifier.js`
**Purpose:** HMAC-SHA256 verification for NC Talk webhooks.

```javascript
const TalkSignatureVerifier = require('./lib/talk-signature-verifier');
const verifier = new TalkSignatureVerifier(secret, { allowedBackends });
const valid = verifier.verify(rawBody, signature, random, backend);
```

**Key features:**
- Timing-safe comparison
- Backend allowlist
- Replay detection

---

## Handlers (`src/lib/handlers/`)

### `message-router.js`
**Purpose:** Routes messages to appropriate handlers based on intent.

```javascript
const MessageRouter = require('./lib/handlers/message-router');
const router = new MessageRouter({ calendarHandler, emailHandler, llmRouter });
const result = await router.route(message, { user, token });
```

**Intents:** `calendar`, `email`, `confirm`, `general`

---

### `email-handler.js`
**Purpose:** Natural language email operations (IMAP/SMTP).

```javascript
const EmailHandler = require('./lib/handlers/email-handler');
const handler = new EmailHandler(credentialBroker, llmRouter);
const result = await handler.handle('check my inbox');
```

**Actions:** `check_inbox`, `search_emails`, `draft_email`, `draft_reply`

---

### `calendar-handler.js`
**Purpose:** Natural language calendar operations (CalDAV).

```javascript
const CalendarHandler = require('./lib/handlers/calendar-handler');
const handler = new CalendarHandler(caldavClient, llmRouter);
const result = await handler.handle("what's on my calendar today?");
```

**Actions:** `query_today`, `create_event`, `find_free_time`

---

### `handlers/confirmation/`
**Purpose:** Strategy handlers for HITL confirmation responses.

| Module | Purpose |
|--------|---------|
| `email-reply-handler.js` | Handle approve/ignore/edit for emails |
| `meeting-response-handler.js` | Handle accept/decline/suggest for meetings |
| `pending-action-handler.js` | Handle general pending confirmations |
| `index.js` | Factory and pattern matching |

---

## Server (`src/lib/server/`)

### Components

| Module | Purpose | Endpoint |
|--------|---------|----------|
| `webhook-handler.js` | Signature verification, request handling | `POST /webhook/nctalk` |
| `health-handler.js` | Health checks and stats | `GET /health`, `/stats` |
| `command-handler.js` | Slash command processing | `/help`, `/status` |
| `message-processor.js` | Message extraction and routing | - |
| `index.js` | Factory function | - |

```javascript
const { createServerComponents } = require('./lib/server');
const { webhookHandler, healthHandler } = createServerComponents(deps);
```

---

## Integrations (`src/lib/integrations/`)

### `caldav-client.js`
**Purpose:** CalDAV client for calendar operations.

```javascript
const CalDAVClient = require('./lib/integrations/caldav-client');
const client = new CalDAVClient(ncRequestManager);
const events = await client.getEventsForDateRange(start, end);
```

---

### `deck-client.js`
**Purpose:** NC Deck API client for task management.

```javascript
const DeckClient = require('./lib/integrations/deck-client');
const client = new DeckClient(ncRequestManager, { boardName: 'Tasks' });
const cards = await client.getAllCards();
```

---

### `heartbeat-manager.js`
**Purpose:** Periodic task processing (calendar reminders, deck tasks).

```javascript
const HeartbeatManager = require('./lib/integrations/heartbeat-manager');
const hb = new HeartbeatManager({ deckClient, caldavClient, notifyUser });
hb.start();
```

---

## LLM (`src/lib/llm/`)

### `router.js`
**Purpose:** Multi-provider LLM routing with failover.

```javascript
const LLMRouter = require('./lib/llm/router');
const router = new LLMRouter({ providers, outputVerifier });
const response = await router.chat(messages, { task: 'calendar_parse' });
```

**Features:**
- Provider tiers (sovereign → value → premium)
- Automatic failover
- Budget enforcement
- Output verification

---

### Resilience Components

| Module | Purpose |
|--------|---------|
| `circuit-breaker.js` | Prevent cascading failures |
| `backoff-strategy.js` | Exponential backoff with jitter |
| `loop-detector.js` | Detect repeated/stuck requests |

---

## Errors (`src/lib/errors/`)

### `error-handler.js`
**Purpose:** Centralized error classification and safe messaging.

```javascript
const { createErrorHandler } = require('./lib/errors/error-handler');
const handler = createErrorHandler({ auditLog });
const safeMessage = handler.getSafeMessage(error);
```

**Categories:** `NETWORK`, `AUTHENTICATION`, `RATE_LIMIT`, `TIMEOUT`, etc.

---

## Entry Points

### `src/bot.js`
Main application entry. Initializes all components, starts heartbeat.

```bash
NC_PASSWORD=xxx node src/bot.js
```

### `webhook-server.js`
HTTP server for NC Talk webhooks.

```bash
NC_TALK_SECRET=xxx node webhook-server.js
```

---

## Test Structure

```
test/
├── unit/                    # Unit tests (mock dependencies)
│   ├── config.test.js
│   ├── handlers/
│   ├── integrations/
│   ├── llm/
│   └── server/
├── integration/             # Integration tests (real components)
│   ├── credential-broker.test.js
│   └── webhook-server.test.js
├── fixtures/                # Test data
└── helpers/                 # Test utilities
    ├── test-runner.js
    └── mock-factories.js
```

Run tests:
```bash
npm test              # All tests
npm run test:unit     # Unit tests only
npm run lint          # ESLint check
```

---

## Dependency Graph (Simplified)

```
bot.js
  ├── config
  ├── credential-broker
  │     └── nc-request-manager
  ├── heartbeat-manager
  │     ├── deck-client
  │     └── caldav-client
  └── nc-request-manager

webhook-server.js
  ├── config
  ├── talk-signature-verifier
  ├── message-router
  │     ├── calendar-handler
  │     ├── email-handler
  │     └── llm-router
  │           └── output-verifier
  └── nc-request-manager
```
