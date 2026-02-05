# MoltAgent Test Strategy

## Architecture Brief

**Problem Statement:**
MoltAgent has untested core modules (email-handler, message-router, llm/router, integrations) and a fragmented test directory structure (`test/` for unit tests, `tests/` for integration tests). This creates maintenance overhead and inconsistent testing patterns.

**Chosen Pattern:**
Consolidate to a single `test/` directory with clear subdirectories for different test types. Follow the existing test conventions (custom `test()` and `asyncTest()` helpers, `assert` module, mock factories).

**Key Dependencies:**
- Node.js built-in `assert` module (no external test frameworks)
- Mocking via factory functions (no mocking libraries)
- Direct script execution via `node test/path/to/test.js`

**Data Flow:**
Tests run in isolation with mocked dependencies, verifying input/output contracts and internal state changes.

---

## 1. Directory Consolidation Plan

### Current Structure
```
/opt/moltagent/
+-- test/                           # Unit tests
|   +-- credential-cache.test.js
|   +-- nc-request-manager.test.js
|   +-- unit/
|       +-- output-verifier.test.js
|       +-- talk-signature-verifier.test.js
|       +-- *.design.md files
+-- tests/                          # Integration/manual tests
    +-- test-credential-broker.js
    +-- test-credential-integration.js
    +-- test-output-verifier.js
    +-- test-talk-signature.js
    +-- test-webhook-server.js
```

### Target Structure
```
/opt/moltagent/test/
+-- unit/                           # Fast, isolated unit tests
|   +-- handlers/
|   |   +-- email-handler.test.js
|   |   +-- message-router.test.js
|   +-- llm/
|   |   +-- router.test.js
|   +-- integrations/
|   |   +-- caldav-client.test.js
|   |   +-- deck-client.test.js
|   |   +-- heartbeat-manager.test.js
|   +-- errors/
|   |   +-- error-handler.test.js
|   +-- output-verifier.test.js     # (existing)
|   +-- talk-signature-verifier.test.js  # (existing)
|   +-- nc-request-manager.test.js  # (move from test/)
|   +-- credential-cache.test.js    # (move from test/)
|
+-- integration/                    # Tests requiring external services
|   +-- credential-broker.test.js   # (from tests/test-credential-broker.js)
|   +-- credential-integration.test.js  # (from tests/test-credential-integration.js)
|   +-- webhook-server.test.js      # (from tests/test-webhook-server.js)
|
+-- fixtures/                       # Shared test data
|   +-- emails/                     # Sample email data for email-handler tests
|   |   +-- simple-text.json
|   |   +-- meeting-request.json
|   |   +-- with-attachments.json
|   +-- llm-responses/              # Canned LLM responses for mocking
|   |   +-- intent-parse.json
|   |   +-- email-draft.json
|   |   +-- error-responses.json
|   +-- calendar/                   # Sample calendar data
|   |   +-- events.json
|   |   +-- free-busy.json
|   +-- deck/                       # Sample Deck API responses
|       +-- boards.json
|       +-- cards.json
|
+-- helpers/                        # Shared test utilities
|   +-- test-runner.js              # test() and asyncTest() helpers
|   +-- mock-factories.js           # Mock object factories
|   +-- fixtures-loader.js          # Fixture loading utilities
|   +-- assertions.js               # Custom assertion helpers
|
+-- TEST-STRATEGY.md                # This document
```

### Migration Actions

| From | To | Action |
|------|-------|--------|
| `test/credential-cache.test.js` | `test/unit/credential-cache.test.js` | Move |
| `test/nc-request-manager.test.js` | `test/unit/nc-request-manager.test.js` | Move |
| `test/unit/output-verifier.test.js` | `test/unit/output-verifier.test.js` | Keep |
| `test/unit/talk-signature-verifier.test.js` | `test/unit/talk-signature-verifier.test.js` | Keep |
| `tests/test-credential-broker.js` | `test/integration/credential-broker.test.js` | Move + Rename |
| `tests/test-credential-integration.js` | `test/integration/credential-integration.test.js` | Move + Rename |
| `tests/test-output-verifier.js` | DELETE | Duplicate of unit test |
| `tests/test-talk-signature.js` | DELETE | Duplicate of unit test |
| `tests/test-webhook-server.js` | `test/integration/webhook-server.test.js` | Move + Rename |
| `test/unit/*.design.md` | `test/unit/*.design.md` | Keep (documentation) |
| `tests/` directory | DELETE | After migration complete |

---

## 2. Test Specifications by Module

### 2.1 EmailHandler (`/opt/moltagent/src/lib/handlers/email-handler.js`)

**Test File:** `test/unit/handlers/email-handler.test.js`

**Public API Surface:**
- `constructor(credentialBroker, llmRouter, auditLog)`
- `handle(message, user, context)` - Main entry point
- `confirmSendEmail(draft, user)` - HITL confirmation handler
- `parseIntent(message)` - Intent parsing
- `fallbackIntentParse(message)` - Fallback parser

**Dependencies to Mock:**
- `credentialBroker.get(name)` - Returns mock credentials
- `llmRouter.route(request)` - Returns canned LLM responses
- `auditLog(event, data)` - Track audit calls
- `imap` module - Mock IMAP connection and fetch
- `nodemailer` module - Mock SMTP transport

**Test Suites:**

| Suite | Test Cases | Priority |
|-------|------------|----------|
| Constructor | Default initialization, custom auditLog, errorHandler creation | Medium |
| Intent Parsing (LLM) | Parse check_inbox, check_unread, search_emails, read_email, summarize_emails, draft_email, draft_reply, unknown action | High |
| Fallback Intent Parse | send/draft detection, reply detection, unread detection, search detection, summarize detection, inbox fallback | High |
| Check Inbox | Fetch emails, empty inbox response, format email list, audit logging | High |
| Check Unread | Unread only filter, empty unread response, format unread list | High |
| Search Emails | Search by from, search by subject, search by query, no criteria error | Medium |
| Read Email | Fetch first unread, context.lastEmail assignment, format full email | Medium |
| Summarize Emails | Search criteria building, LLM summarization call, response formatting | Medium |
| Draft Email | Missing recipient error, LLM body generation, draft preview formatting, requiresConfirmation flag | High |
| Draft Reply | Use context.lastEmail, fetch if no context, reply subject prefix, LLM reply generation | High |
| Confirm Send | SMTP credential lookup, nodemailer transport, email footer handling, audit logging | High |
| Email Footer | Custom footer from credentials, default footer, placeholder replacement, disable marker | Medium |
| Error Handling | IMAP errors, SMTP errors, LLM errors, credential errors | High |
| Formatting Helpers | _formatEmailList, _formatFullEmail, _formatDraftPreview, _formatDate, _formatTimeAgo | Low |

**Estimated Test Count:** 55-65 tests

**Key Mocking Strategy:**
```javascript
// Mock credential broker
const mockCredentialBroker = {
  get: async (name) => {
    if (name === 'email-imap') return { host: 'imap.test.com', username: 'test', password: 'pass', port: 993 };
    if (name === 'email-smtp') return { host: 'smtp.test.com', username: 'test', password: 'pass', port: 587 };
    return null;
  }
};

// Mock LLM router
const mockLLMRouter = {
  route: async ({ task, content }) => {
    if (task === 'email_parse') return { response: '{"action": "check_inbox"}' };
    return { response: 'Mock response' };
  }
};

// Mock IMAP (replace imap module)
class MockImap {
  constructor() { this.handlers = {}; }
  once(event, cb) { this.handlers[event] = cb; return this; }
  connect() { setTimeout(() => this.handlers.ready?.(), 0); }
  openBox(folder, readonly, cb) { cb(null, { messages: { total: 5 } }); }
  search(criteria, cb) { cb(null, [1, 2, 3]); }
  fetch(seqs, opts) { return new MockFetch(); }
  end() {}
}
```

---

### 2.2 MessageRouter (`/opt/moltagent/src/lib/handlers/message-router.js`)

**Test File:** `test/unit/handlers/message-router.test.js`

**Public API Surface:**
- `constructor(options)` - Initialize with handlers
- `classifyIntent(message)` - Classify message intent
- `route(message, context)` - Route to appropriate handler
- `getStats()` - Return router statistics

**Dependencies to Mock:**
- `options.calendarHandler.handle(message)`
- `options.emailHandler.handle(message)`
- `options.emailHandler.confirmSendEmail(draft, user)`
- `options.llmRouter.route(request)`
- `options.calendarClient.respondToMeeting(info, response)`
- `options.auditLog(event, data)`
- `global.pendingEmailReplies` - Map for pending confirmations

**Test Suites:**

| Suite | Test Cases | Priority |
|-------|------------|----------|
| Constructor | Handler registration, errorHandler creation, confirmation cleanup interval | Medium |
| Intent Classification | Calendar keywords detection, email keywords detection, confirmation response detection, general fallback, score-based selection | High |
| Calendar Routing | Handler invocation, requiresConfirmation handling, handler not configured error | High |
| Email Routing | Handler invocation, requiresConfirmation handling, handler not configured error | High |
| Confirmation Handling | Approval flow, rejection flow, edit flow, pending not found | High |
| Meeting Confirmations | Accept meeting, decline meeting, suggest alternatives, accept with conflict | High |
| General Routing | LLM fallback, debug info appending, LLM not available error | Medium |
| Pending Confirmation Store | Store confirmation, retrieve confirmation, cleanup expired | Medium |
| Error Handling | Handler errors, confirmation execution errors, safe error messages | High |

**Estimated Test Count:** 40-50 tests

**Key Mocking Strategy:**
```javascript
const mockCalendarHandler = {
  handle: async (message) => ({ message: 'Calendar response', requiresConfirmation: false }),
  confirmCreateEvent: async (data, user) => ({ message: 'Event created' })
};

const mockEmailHandler = {
  handle: async (message) => ({ message: 'Email response', requiresConfirmation: false }),
  confirmSendEmail: async (draft, user) => ({ message: 'Email sent' })
};

const mockLLMRouter = {
  route: async ({ content }) => ({ result: 'LLM response', provider: 'mock', tokens: 100 })
};
```

---

### 2.3 LLMRouter (`/opt/moltagent/src/lib/llm/router.js`)

**Test File:** `test/unit/llm/router.test.js`

**Public API Surface:**
- `constructor(config)` - Initialize with providers and roles
- `route(request)` - Route request to provider
- `testConnections()` - Test all provider connections
- `getStats()` - Return router statistics
- `getAvailableRoles()` - List available roles
- `getProvidersForRole(role)` - Get provider chain for role

**Dependencies to Mock:**
- `createProvider(adapter, config)` - Provider factory
- `RateLimitTracker` - Rate limit state
- `BudgetEnforcer` - Budget tracking
- `BackoffStrategy` - Backoff management
- `CircuitBreaker` - Circuit breaker state
- `LoopDetector` - Loop detection
- `OutputVerifier` - Output verification
- `config.auditLog(event, data)`
- `config.notifyUser(notification)`
- `config.getCredential(name)`

**Test Suites:**

| Suite | Test Cases | Priority |
|-------|------------|----------|
| Constructor | Default configuration, custom roles, fallback chains, component initialization | Medium |
| Provider Initialization | Create providers, handle initialization errors, credential getter setup | High |
| Route - Happy Path | Route to primary provider, response verification, stats update | High |
| Route - Failover | Rate limit failover, budget exhausted failover, circuit open failover, backoff failover | High |
| Route - Errors | Permanent error handling, transient error retry, rate limit error handling | High |
| Loop Detection | Detect repeated calls, block on loop, reset on success | High |
| Output Verification | Block unsafe output, warn on warnings, pass safe output | High |
| Chain Building | Role provider resolution, fallback chain addition, local provider fallback | Medium |
| Rate Limit Handling | Track limits, update from headers, clear on success | Medium |
| Budget Management | Check budget, record spend, handle exhaustion, warning callbacks | Medium |
| Circuit Breaker | Record failures, open circuit, half-open testing, close on success | Medium |
| Statistics | Total calls tracking, success/failure counting, provider breakdown, role breakdown | Low |

**Estimated Test Count:** 60-75 tests

**Key Mocking Strategy:**
```javascript
// Mock provider
const mockProvider = {
  type: 'remote',
  generate: async (task, content, options) => ({
    result: 'Generated response',
    model: 'mock-model',
    tokens: 150,
    inputTokens: 50,
    outputTokens: 100,
    cost: 0.001,
    duration: 500
  }),
  estimateTokens: (content) => content.length / 4,
  estimateCost: (input, output) => (input + output) * 0.00001,
  testConnection: async () => ({ connected: true })
};

// Mock rate limit tracker
const mockRateLimits = {
  canRequest: (providerId, tokens) => ({ allowed: true }),
  updateFromResponse: (providerId, headers) => {},
  markRateLimited: (providerId, seconds) => {},
  clearRetryAfter: (providerId) => {},
  predictAvailability: (providerId) => ({ available: true }),
  getSummary: () => ({})
};
```

---

### 2.4 CalDAVClient (`/opt/moltagent/src/lib/integrations/caldav-client.js`)

**Test File:** `test/unit/integrations/caldav-client.test.js`

**Public API Surface:**
- `constructor(ncRequestManager, credentialBroker, config)`
- `getCalendars(forceRefresh)` - List calendars
- `getEvents(calendarId, start, end)` - Get events in range
- `getTodayEvents(calendarId)` - Get today's events
- `getUpcomingEvents(hours, calendarId)` - Get upcoming events
- `createEvent(event)` - Create calendar event
- `updateEvent(calendarId, uid, updates, etag)` - Update event
- `deleteEvent(calendarId, uid, etag)` - Delete event
- `scheduleMeeting(meeting)` - Schedule with invitations
- `cancelMeeting(calendarId, uid, reason)` - Cancel meeting
- `respondToMeeting(meetingInfo, response, calendarId)` - Respond to invitation
- `checkAvailability(start, end, calendarId)` - Check free/busy
- `findFreeSlots(rangeStart, rangeEnd, durationMinutes, options)` - Find free slots
- `amIFreeAt(dateTime)` - Quick availability check
- `getTodaySummary()` - Human-readable summary
- `quickSchedule(summary, dateTime, durationMinutes, attendees)` - Quick schedule

**Dependencies to Mock:**
- `ncRequestManager.request(path, options)` - HTTP requests
- `config.auditLog(event, data)`

**Test Suites:**

| Suite | Test Cases | Priority |
|-------|------------|----------|
| Constructor | New signature (ncRequestManager), legacy signature, cache initialization | Medium |
| Request Helpers | Make PROPFIND request, make REPORT request, handle response status | Medium |
| XML Parsing | Parse multistatus response, extract href, extract displayname, extract calendar-data | Medium |
| Calendar Discovery | List all calendars, filter event calendars, get specific calendar, cache behavior | High |
| Event Operations | Get events in range, get today events, get upcoming events, create event, update event, delete event | High |
| Scheduling | Schedule meeting with attendees, cancel meeting, organizer validation | High |
| Meeting Response | Accept meeting, decline meeting, tentative response, calendar event creation | High |
| Availability | Check availability, find conflicts, find free slots, am I free at | High |
| ICS Parsing | Parse VEVENT, extract fields, handle all-day events, parse attendees | Medium |
| ICS Building | Build valid ICS, include attendees, include organizer, escape special chars | Medium |
| Date/Time | Format datetime, format date only, parse ICS datetime, timezone handling | Medium |
| Convenience Methods | Today summary, quick schedule with conflict check | Low |
| Error Handling | Network errors, 404 responses, malformed XML | High |

**Estimated Test Count:** 50-60 tests

**Key Mocking Strategy:**
```javascript
const mockNCRequestManager = {
  ncUrl: 'https://cloud.example.com',
  ncUser: 'testuser',
  request: async (path, options) => {
    if (path.includes('/calendars/') && options.method === 'PROPFIND') {
      return { status: 207, body: MOCK_CALENDARS_XML, headers: {} };
    }
    if (options.method === 'REPORT') {
      return { status: 207, body: MOCK_EVENTS_XML, headers: {} };
    }
    return { status: 200, body: '', headers: {} };
  }
};
```

---

### 2.5 DeckClient (`/opt/moltagent/src/lib/integrations/deck-client.js`)

**Test File:** `test/unit/integrations/deck-client.test.js`

**Public API Surface:**
- `constructor(ncRequestManager, config)`
- Board: `listBoards()`, `findBoard()`, `getBoard(boardId)`, `createBoard()`, `ensureBoard()`
- Stack: `getCardsInStack(stackName)`, `getAllCards()`
- Card: `createCard(stackName, card)`, `getCard(cardId, stackName)`, `updateCard(cardId, stackName, updates)`, `moveCard(cardId, fromStack, toStack, order)`, `deleteCard(cardId, stackName)`
- Comments: `addComment(cardId, message, type)`, `getComments(cardId)`
- Labels: `addLabel(cardId, stackName, labelName)`, `removeLabel(cardId, stackName, labelName)`
- Task Management: `scanInbox()`, `getWorkloadSummary()`, `acceptTask(cardId, message)`, `startTask(cardId, message)`, `completeTask(cardId, message)`, `submitForReview(...)`, `scanReviewCards()`, `scanAllStacksForComments(stackNames)`, `scanAssignedCards(stackNames)`, `completeReview(cardId, finalMessage)`, `respondToFeedback(cardId, response, markComplete)`, `blockTask(cardId, question)`, `failTask(cardId, currentStack, errorMessage, moveToInbox)`, `cleanupOldCards()`
- Assignment: `assignUser(cardId, stackName, userId)`, `getAssignedUsers(cardId, stackName)`, `ensureAssignments(cardId, stackName, creator)`
- Cache: `clearCache()`

**Dependencies to Mock:**
- `ncRequestManager.request(path, options)` - HTTP requests

**Test Suites:**

| Suite | Test Cases | Priority |
|-------|------------|----------|
| Constructor | New signature, legacy signature, stack names configuration, label definitions | Medium |
| Board Management | List boards, find board by name, get board details, create board with stacks/labels, ensure board exists | High |
| Stack Operations | Get cards in stack, get all cards, resolve stack ID, unknown stack error | High |
| Card Operations | Create card, get card, update card, move card (reorder workaround), delete card | High |
| Comment Operations | Add comment with type prefix, get comments, OCS API format handling | Medium |
| Label Operations | Add label, remove label, unknown label error | Medium |
| Task Management | Scan inbox, get workload summary, accept task, start task, complete task | High |
| Review Flow | Submit for review, scan review cards, complete review, respond to feedback | High |
| Blocking/Failing | Block task with question, fail task with error | Medium |
| Assignment | Assign user, get assigned users, ensure assignments, case-insensitive matching | Medium |
| Cleanup | Cleanup old cards based on age | Low |
| Cache | Cache refresh, force refresh, clear cache | Medium |
| Error Handling | API errors, DeckApiError class, network errors | High |

**Estimated Test Count:** 55-65 tests

---

### 2.6 HeartbeatManager (`/opt/moltagent/src/lib/integrations/heartbeat-manager.js`)

**Test File:** `test/unit/integrations/heartbeat-manager.test.js`

**Public API Surface:**
- `constructor(config)`
- `start()` - Start heartbeat loop
- `stop()` - Stop heartbeat loop
- `pulse()` - Single heartbeat pulse
- `forcePulse()` - Manual trigger
- `getStatus()` - Get heartbeat status
- `resetDailyCounters()` - Reset daily stats
- `getHeartbeatContext()` - Get system context

**Dependencies to Mock:**
- `DeckClient` - Deck operations
- `DeckTaskProcessor` - Task processing
- `CalDAVClient` - Calendar operations
- `config.llmRouter` - LLM routing
- `config.notifyUser(notification)` - User notifications
- `config.auditLog(event, data)` - Audit logging
- `config.credentialBroker.prefetchAll(names)` - Credential prefetch

**Test Suites:**

| Suite | Test Cases | Priority |
|-------|------------|----------|
| Constructor | Default settings, custom settings, component initialization | Medium |
| Start/Stop | Start loop, prevent double start, stop loop, interval cleanup | High |
| Pulse | Execute all checks, handle quiet hours, track state, handle errors | High |
| Deck Processing | Process inbox tasks, update stats, handle processor errors | High |
| Review Processing | Process review feedback, track processed count | High |
| Assignment Processing | Process assigned cards, track by stack | Medium |
| Calendar Checking | Check upcoming events, meeting notifications, notification tracking | High |
| Meeting Notifications | Notify upcoming meeting, urgency levels, cleanup old notifications | Medium |
| Quiet Hours | Detect quiet hours, midnight spanning, minimal processing | Medium |
| Status | Get running status, timestamps, counters, settings | Low |
| Daily Reset | Reset counters, clear notification tracking | Low |
| Heartbeat Context | Build context object, handle errors in context gathering | Medium |

**Estimated Test Count:** 40-50 tests

**Key Mocking Strategy:**
```javascript
const mockDeckProcessor = {
  processInbox: async () => ({ processed: 2, queued: 1, errors: [] }),
  processReviewFeedback: async () => ({ scanned: 5, processed: 1, completed: 1, errors: [] }),
  processAssignedCards: async () => ({ scanned: 10, actionNeeded: 2, processed: 2, byStack: {}, errors: [] })
};

const mockCalDAVClient = {
  getUpcomingEvents: async (hours) => ([
    { uid: 'event-1', summary: 'Meeting', start: new Date(Date.now() + 600000).toISOString(), location: 'Room 1' }
  ]),
  getTodaySummary: async () => ({ text: 'No events', events: [] })
};
```

---

### 2.7 ErrorHandler (`/opt/moltagent/src/lib/errors/error-handler.js`)

**Test File:** `test/unit/errors/error-handler.test.js`

**Public API Surface:**
- `ErrorHandler` class
  - `constructor(config)`
  - `handle(error, context)` - Handle error and return safe response
  - `classify(error)` - Classify error into category
  - `getUserMessage(category, options)` - Get safe user message
  - `logInternal(error, category, context)` - Log error internally
- `MoltAgentError` class - Custom error with category
- `createErrorHandler(config)` - Factory function
- `wrapAsync(fn, handler, defaultContext)` - Async wrapper
- `logAndIgnore(handler, operation, level)` - Log and continue
- `logAndRethrow(handler, operation)` - Log and rethrow
- `ErrorCategory` enum

**Dependencies to Mock:**
- `config.auditLog(event, data)`
- `config.onError(error, category, context)` - Error callback

**Test Suites:**

| Suite | Test Cases | Priority |
|-------|------------|----------|
| Constructor | Default configuration, custom auditLog, serviceName, includeRequestId, onError callback | Medium |
| Error Classification | HTTP status codes (401, 403, 404, 429, 5xx), error codes (ECONNREFUSED, ETIMEDOUT), message patterns, MoltAgentError, OutputVerificationError, default to INTERNAL | High |
| User Messages | Category-specific messages, request ID inclusion, custom userMessage override | High |
| Handle Method | Classify error, return safe message, log internally, call onError callback | High |
| Internal Logging | Build log entry, console output, audit log call | Medium |
| MoltAgentError Class | Constructor, properties (category, userMessage, cause, metadata), timestamp | Medium |
| createErrorHandler | Factory returns ErrorHandler instance | Low |
| wrapAsync | Wrap function, catch and handle errors, rethrow with safe message | Medium |
| logAndIgnore | Return catch handler, log error, continue execution | Low |
| logAndRethrow | Return catch handler, log error, rethrow original | Low |

**Estimated Test Count:** 35-45 tests

**Key Test Cases:**
```javascript
// Classification tests
test('classify HTTP 401 as AUTHENTICATION', () => {
  const handler = createErrorHandler();
  const error = new Error('Unauthorized');
  error.status = 401;
  assert.strictEqual(handler.classify(error), ErrorCategory.AUTHENTICATION);
});

// Safe message tests
test('handle returns safe message for internal error', async () => {
  const handler = createErrorHandler();
  const error = new Error('Database connection failed at postgres:5432');
  const result = await handler.handle(error, { operation: 'db_query' });
  assert.strictEqual(result.message, 'Something went wrong. Please try again or contact support.');
  assert.ok(!result.message.includes('postgres'));
});
```

---

## 3. Shared Test Infrastructure

### 3.1 Test Runner (`test/helpers/test-runner.js`)

```javascript
/**
 * Shared test runner utilities
 *
 * Provides consistent test() and asyncTest() helpers used across all test files.
 */

let testsPassed = 0;
let testsFailed = 0;
const testResults = [];

function test(name, fn) {
  try {
    fn();
    console.log(`[PASS] ${name}`);
    testsPassed++;
    testResults.push({ name, passed: true });
  } catch (error) {
    console.log(`[FAIL] ${name}`);
    console.log(`  Error: ${error.message}`);
    testsFailed++;
    testResults.push({ name, passed: false, error: error.message });
  }
}

async function asyncTest(name, fn) {
  try {
    await fn();
    console.log(`[PASS] ${name}`);
    testsPassed++;
    testResults.push({ name, passed: true });
  } catch (error) {
    console.log(`[FAIL] ${name}`);
    console.log(`  Error: ${error.message}`);
    testsFailed++;
    testResults.push({ name, passed: false, error: error.message });
  }
}

function summary() {
  console.log('\n=================================');
  console.log(`Tests passed: ${testsPassed}`);
  console.log(`Tests failed: ${testsFailed}`);
  console.log('=================================\n');
  return { passed: testsPassed, failed: testsFailed, results: testResults };
}

function reset() {
  testsPassed = 0;
  testsFailed = 0;
  testResults.length = 0;
}

function exitWithCode() {
  process.exit(testsFailed > 0 ? 1 : 0);
}

module.exports = { test, asyncTest, summary, reset, exitWithCode };
```

### 3.2 Mock Factories (`test/helpers/mock-factories.js`)

```javascript
/**
 * Mock factory functions for common dependencies
 */

// Audit Log Mock
function createMockAuditLog() {
  const calls = [];
  const auditLog = async (event, data) => {
    calls.push({ event, data, timestamp: Date.now() });
  };
  auditLog.getCalls = () => calls;
  auditLog.reset = () => { calls.length = 0; };
  auditLog.getCallsFor = (event) => calls.filter(c => c.event === event);
  return auditLog;
}

// Credential Broker Mock
function createMockCredentialBroker(credentials = {}) {
  return {
    get: async (name) => credentials[name] || null,
    getNCPassword: () => credentials['nc-password'] || 'test-password',
    prefetchAll: async (names) => {},
    discardAll: () => {}
  };
}

// LLM Router Mock
function createMockLLMRouter(responses = {}) {
  return {
    route: async ({ task, content, requirements }) => {
      if (responses[task]) {
        return typeof responses[task] === 'function'
          ? responses[task](content, requirements)
          : responses[task];
      }
      return { result: 'Mock LLM response', provider: 'mock', tokens: 100 };
    },
    testConnections: async () => ({ 'mock': { connected: true } }),
    getStats: () => ({ totalCalls: 0 })
  };
}

// NC Request Manager Mock
function createMockNCRequestManager(responses = {}) {
  return {
    ncUrl: 'https://cloud.example.com',
    ncUser: 'testuser',
    request: async (path, options = {}) => {
      const key = `${options.method || 'GET'}:${path}`;
      if (responses[key]) {
        return typeof responses[key] === 'function'
          ? responses[key](path, options)
          : responses[key];
      }
      return { status: 200, body: {}, headers: {} };
    },
    getMetrics: () => ({ totalRequests: 0, cacheHits: 0 }),
    invalidateCache: () => {},
    shutdown: async () => {}
  };
}

// Calendar Handler Mock
function createMockCalendarHandler(responses = {}) {
  return {
    handle: async (message) => responses.handle || { message: 'Calendar response' },
    confirmCreateEvent: async (data, user) => responses.confirmCreateEvent || { message: 'Event created' }
  };
}

// Email Handler Mock
function createMockEmailHandler(responses = {}) {
  return {
    handle: async (message, user, context) => responses.handle || { message: 'Email response' },
    confirmSendEmail: async (draft, user) => responses.confirmSendEmail || { message: 'Email sent' }
  };
}

// Notify User Mock
function createMockNotifyUser() {
  const notifications = [];
  const notifyUser = async (notification) => {
    notifications.push({ ...notification, timestamp: Date.now() });
  };
  notifyUser.getNotifications = () => notifications;
  notifyUser.reset = () => { notifications.length = 0; };
  return notifyUser;
}

module.exports = {
  createMockAuditLog,
  createMockCredentialBroker,
  createMockLLMRouter,
  createMockNCRequestManager,
  createMockCalendarHandler,
  createMockEmailHandler,
  createMockNotifyUser
};
```

### 3.3 Fixtures Loader (`test/helpers/fixtures-loader.js`)

```javascript
/**
 * Fixture loading utilities
 */
const fs = require('fs');
const path = require('path');

const FIXTURES_DIR = path.join(__dirname, '..', 'fixtures');

function loadFixture(relativePath) {
  const fullPath = path.join(FIXTURES_DIR, relativePath);
  const content = fs.readFileSync(fullPath, 'utf8');
  if (fullPath.endsWith('.json')) {
    return JSON.parse(content);
  }
  return content;
}

function loadEmailFixture(name) {
  return loadFixture(`emails/${name}.json`);
}

function loadLLMResponseFixture(name) {
  return loadFixture(`llm-responses/${name}.json`);
}

function loadCalendarFixture(name) {
  return loadFixture(`calendar/${name}.json`);
}

function loadDeckFixture(name) {
  return loadFixture(`deck/${name}.json`);
}

module.exports = {
  loadFixture,
  loadEmailFixture,
  loadLLMResponseFixture,
  loadCalendarFixture,
  loadDeckFixture,
  FIXTURES_DIR
};
```

### 3.4 Custom Assertions (`test/helpers/assertions.js`)

```javascript
/**
 * Custom assertion helpers
 */
const assert = require('assert');

function assertHasProperty(obj, prop, message) {
  assert.ok(prop in obj, message || `Expected object to have property '${prop}'`);
}

function assertIsFunction(value, message) {
  assert.strictEqual(typeof value, 'function', message || 'Expected a function');
}

function assertIsAsync(fn, message) {
  assert.ok(fn.constructor.name === 'AsyncFunction', message || 'Expected an async function');
}

function assertContains(str, substring, message) {
  assert.ok(str.includes(substring), message || `Expected '${str}' to contain '${substring}'`);
}

function assertNotContains(str, substring, message) {
  assert.ok(!str.includes(substring), message || `Expected '${str}' to not contain '${substring}'`);
}

function assertThrowsAsync(fn, errorType, message) {
  return fn()
    .then(() => assert.fail(message || 'Expected function to throw'))
    .catch(err => {
      if (errorType && !(err instanceof errorType)) {
        assert.fail(`Expected ${errorType.name} but got ${err.constructor.name}`);
      }
    });
}

function assertAuditLogCalled(mockAuditLog, event, message) {
  const calls = mockAuditLog.getCallsFor(event);
  assert.ok(calls.length > 0, message || `Expected audit log to be called with event '${event}'`);
}

module.exports = {
  assertHasProperty,
  assertIsFunction,
  assertIsAsync,
  assertContains,
  assertNotContains,
  assertThrowsAsync,
  assertAuditLogCalled
};
```

---

## 4. Implementation Priority Order

### Phase 1: Infrastructure (Week 1)

1. Create `test/helpers/` directory and shared utilities
2. Create `test/fixtures/` directory with initial fixtures
3. Move existing tests to new structure
4. Delete `tests/` directory after verification

### Phase 2: Core Error Handling (Week 2)

1. `test/unit/errors/error-handler.test.js` - Foundation for all other tests
   - Error classification is used throughout the codebase
   - Safe message generation is critical for user-facing responses

### Phase 3: Handlers (Weeks 3-4)

1. `test/unit/handlers/message-router.test.js` - Central routing logic
   - Must work before email/calendar handlers
   - Tests confirmation flow that spans handlers

2. `test/unit/handlers/email-handler.test.js` - Email operations
   - Complex LLM integration
   - HITL confirmation flow

### Phase 4: LLM (Week 5)

1. `test/unit/llm/router.test.js` - LLM routing and failover
   - Complex failover chains
   - Multiple safety mechanisms

### Phase 5: Integrations (Weeks 6-7)

1. `test/unit/integrations/caldav-client.test.js` - Calendar operations
2. `test/unit/integrations/deck-client.test.js` - Task management
3. `test/unit/integrations/heartbeat-manager.test.js` - Background processing
   - Depends on Deck and CalDAV clients being stable

### Phase 6: Integration Tests (Week 8)

1. Update integration tests in `test/integration/`
2. Add end-to-end flow tests

---

## 5. Test Conventions

### Naming Conventions

- Test files: `{module-name}.test.js`
- Test IDs: `TC-{CATEGORY}-{NUMBER}` (e.g., `TC-CTOR-001`, `TC-ROUTE-015`)
- Describe blocks: `{Module} - {Feature}`

### Test Structure

```javascript
/**
 * {Module} Unit Tests
 *
 * Run: node test/unit/{path}/{module}.test.js
 */

const assert = require('assert');
const { test, asyncTest, summary, exitWithCode } = require('../../helpers/test-runner');
const { createMockAuditLog, /* ... */ } = require('../../helpers/mock-factories');

// Import module under test
const ModuleUnderTest = require('../../../src/lib/path/to/module');

// ============================================================
// Test Suites
// ============================================================

console.log('\n=== {Module} Tests ===\n');

// --- Constructor Tests ---
console.log('\n--- Constructor Tests ---\n');

test('TC-CTOR-001: Description', () => {
  // Arrange
  // Act
  // Assert
});

// --- Feature Tests ---
console.log('\n--- Feature Tests ---\n');

asyncTest('TC-FEAT-001: Description', async () => {
  // Arrange
  // Act
  // Assert
});

// Summary
setTimeout(() => {
  summary();
  exitWithCode();
}, 100);
```

### Mocking Guidelines

1. **Prefer factory functions** over inline mocks
2. **Track calls** for verification (e.g., `auditLog.getCalls()`)
3. **Support reset** for test isolation
4. **Default to success** - explicit failure configuration
5. **No external dependencies** - pure Node.js mocking

### Coverage Goals

- **Critical paths**: 90%+ coverage
- **Error handling**: 100% coverage (all error categories)
- **Edge cases**: Documented and tested
- **Integration points**: Contract tests for all dependencies

---

## 6. Fixture Specifications

### Email Fixtures (`test/fixtures/emails/`)

```json
// simple-text.json
{
  "uid": "email-001",
  "from": "sender@example.com",
  "fromName": "Test Sender",
  "to": "recipient@example.com",
  "subject": "Test Subject",
  "date": "2025-02-05T10:00:00Z",
  "body": "This is a test email body.",
  "isRead": false,
  "hasAttachments": false
}

// meeting-request.json
{
  "uid": "email-002",
  "from": "organizer@example.com",
  "fromName": "Meeting Organizer",
  "subject": "Meeting Request: Project Sync",
  "date": "2025-02-05T10:00:00Z",
  "body": "Please join our meeting...",
  "isMeetingRequest": true,
  "meetingDetails": {
    "start": "2025-02-06T14:00:00Z",
    "end": "2025-02-06T15:00:00Z",
    "location": "Conference Room A"
  }
}
```

### LLM Response Fixtures (`test/fixtures/llm-responses/`)

```json
// intent-parse.json
{
  "check_inbox": {"action": "check_inbox"},
  "check_unread": {"action": "check_unread"},
  "draft_email": {"action": "draft_email", "to": "test@example.com", "subject": "Test"},
  "unknown": {"action": "unknown"}
}

// email-draft.json
{
  "formal": "Dear Sir/Madam,\n\nI hope this email finds you well...",
  "casual": "Hey!\n\nJust wanted to reach out..."
}
```

### Calendar Fixtures (`test/fixtures/calendar/`)

```json
// events.json
{
  "today": [
    {"uid": "event-1", "summary": "Morning Meeting", "start": "2025-02-05T09:00:00Z", "end": "2025-02-05T10:00:00Z"},
    {"uid": "event-2", "summary": "Lunch", "start": "2025-02-05T12:00:00Z", "end": "2025-02-05T13:00:00Z"}
  ]
}

// free-busy.json
{
  "busy": [
    {"start": "2025-02-05T09:00:00Z", "end": "2025-02-05T10:00:00Z"},
    {"start": "2025-02-05T14:00:00Z", "end": "2025-02-05T15:00:00Z"}
  ]
}
```

### Deck Fixtures (`test/fixtures/deck/`)

```json
// boards.json
{
  "boards": [
    {"id": 1, "title": "MoltAgent Tasks", "color": "0082c9"}
  ]
}

// cards.json
{
  "inbox": [
    {"id": 101, "title": "Research topic X", "description": "...", "labels": [{"title": "research"}]},
    {"id": 102, "title": "Urgent: Fix bug", "description": "...", "labels": [{"title": "urgent"}]}
  ]
}
```

---

## 7. Estimated Total Effort

| Module | Estimated Tests | Complexity | Effort (days) |
|--------|-----------------|------------|---------------|
| Infrastructure | N/A | Medium | 2 |
| error-handler | 35-45 | Low | 1 |
| message-router | 40-50 | High | 3 |
| email-handler | 55-65 | High | 4 |
| llm/router | 60-75 | Very High | 5 |
| caldav-client | 50-60 | Medium | 3 |
| deck-client | 55-65 | Medium | 3 |
| heartbeat-manager | 40-50 | Medium | 2 |
| Integration tests | 20-30 | Medium | 2 |
| **Total** | **355-440** | | **25 days** |

---

## 8. Success Criteria

1. **All tests pass** with exit code 0
2. **Directory structure** matches target layout
3. **No duplicate test files** between test/ and tests/
4. **Shared helpers** used consistently across all test files
5. **Fixtures** cover all critical test scenarios
6. **Error handling** paths fully tested
7. **Documentation** updated with test run instructions

---

## 9. Implementation Status (Updated 2026-02-05)

### Completed Tasks

| Task | Status | Tests |
|------|--------|-------|
| Directory consolidation | Done | N/A |
| Shared test infrastructure (`test/helpers/`) | Done | N/A |
| `test/unit/errors/error-handler.test.js` | Done | 32 tests |
| `test/unit/handlers/message-router.test.js` | Done | 45 tests (40 passing, 5 known issues) |
| `test/unit/handlers/email-handler.test.js` | Done | 61 tests |
| `test/unit/llm/router.test.js` | Done | 59 tests |
| `test/unit/output-verifier.test.js` | Done | 66 tests |
| `test/unit/talk-signature-verifier.test.js` | Done | 129 tests |
| `test/unit/credential-cache.test.js` | Done | 16 tests |
| `test/unit/nc-request-manager.test.js` | Done | 54 tests |
| Fixture files (`test/fixtures/`) | Done | N/A |
| Test runner script (`npm test`) | Done | N/A |

### Summary

- **Total Tests:** 462 (457 passing, 5 known issues)
- **Test Files:** 8 unit test files, 3 integration test files
- **Fixture Categories:** emails, llm-responses, calendar, deck

### Known Issues

The following tests in `message-router.test.js` are failing due to incomplete meeting handling implementation:
- TC-MEETING-002: Decline meeting invitation
- TC-MEETING-003: Suggest alternative times
- TC-MEETING-004: Accept with conflict
- TC-MEETING-005: Ignore email reply
- TC-MEETING-006: Edit email reply

These tests depend on global state (`pendingEmailReplies`) handling that may need implementation fixes.

### Remaining Work

1. **Integration tests for CalDAV, Deck, and Heartbeat** - Not yet implemented
2. **Fix meeting confirmation tests** - Requires implementation changes
3. **Add more fixture files** as needed for new tests

### Running Tests

```bash
# Run all tests
npm test

# Run unit tests only
npm run test:unit

# Run specific test modules
npm run test:handlers   # message-router + email-handler
npm run test:llm        # LLM router
npm run test:errors     # error handler
```
