# MoltAgent Phase 1 Session 5: Calendar Production-Ready Fix

## Architecture Brief

**Problem**: The CalDAV calendar system has three critical bugs preventing production use:
1. HeartbeatManager creates CalDAVClient in legacy mode (passes a plain config object
   instead of NCRequestManager), causing `this.nc = null` which throws on every request.
2. bot.js creates NCRequestManager but never passes it to HeartbeatManager, so
   HeartbeatManager cannot forward it to CalDAVClient.
3. CalendarHandler has no SecurityInterceptor integration, meaning calendar operations
   bypass the central security enforcement pipeline entirely.
4. The integration test script (`scripts/test-caldav.js`) has a hardcoded production
   password on line 21.

**Chosen Pattern**: Minimal surgical edits to fix wiring, plus SecurityInterceptor
integration following the existing before/after execute pattern from `interceptor.js`.

**Key Dependencies**:
- `NCRequestManager` (created in bot.js, must flow to HeartbeatManager -> CalDAVClient)
- `SecurityInterceptor` (must be injected into CalendarHandler constructor)
- `CredentialBroker` (already wired correctly)

**Data Flow (After Fix)**:
```
bot.js creates NCRequestManager
  -> passes to HeartbeatManager config
    -> HeartbeatManager passes to CalDAVClient constructor (new mode)
      -> CalDAVClient.nc is set, _request() works

User message -> CalendarHandler.handle()
  -> security.beforeExecute('calendar_' + action, params, context)
    -> if blocked: return block message
    -> if approval required: return confirmation
  -> execute CalDAV operation
  -> security.afterExecute(operation, responseText, context)
  -> return sanitized result
```

---

## Fix 1: HeartbeatManager CalDAVClient Wiring

### Root Cause

**File**: `/opt/moltagent/src/lib/integrations/heartbeat-manager.js`
**Lines 54-60**: CalDAVClient is constructed with a plain object as the first argument.
CalDAVClient's constructor (line 31 of caldav-client.js) checks
`typeof ncRequestManager.request === 'function'` -- a plain config object fails this
check, so it falls into legacy mode where `this.nc = null`. Every subsequent
`_request()` call throws `'CalDAVClient requires NCRequestManager'`.

### Required Change: Constructor Signature

HeartbeatManager must accept an `ncRequestManager` instance in its config and pass it
as the first argument to the CalDAVClient constructor.

**Edit 1a**: Add `ncRequestManager` to constructor storage (line 34, after credentialBroker)

```
OLD (line 34):
    this.credentialBroker = config.credentialBroker;

NEW:
    this.credentialBroker = config.credentialBroker;
    this.ncRequestManager = config.ncRequestManager;
```

**Edit 1b**: Replace CalDAVClient construction (lines 54-60)

```
OLD (lines 54-60):
    // Initialize CalDAV client with credential broker
    this.caldavClient = new CalDAVClient({
      ncUrl: config.nextcloud.url,
      username: config.nextcloud.username,
      credentialBroker: config.credentialBroker,
      auditLog: this.auditLog
    });

NEW:
    // Initialize CalDAV client with NCRequestManager (new mode)
    if (config.ncRequestManager) {
      this.caldavClient = new CalDAVClient(
        config.ncRequestManager,
        config.credentialBroker,
        {
          ncUrl: config.nextcloud.url,
          username: config.nextcloud.username,
          auditLog: this.auditLog
        }
      );
    } else {
      // Fallback for tests or legacy mode -- will fail on _request()
      this.caldavClient = new CalDAVClient({
        ncUrl: config.nextcloud.url,
        username: config.nextcloud.username,
        credentialBroker: config.credentialBroker,
        auditLog: this.auditLog
      });
      console.warn('[Heartbeat] CalDAVClient created in legacy mode -- calendar operations will fail');
    }
```

**Edit 1c**: Update JSDoc for constructor (lines 19-28)

```
OLD (lines 19-28):
  /**
   * @param {Object} config
   * @param {Object} config.nextcloud - Nextcloud connection config
   * @param {Object} config.deck - Deck configuration
   * @param {Object} config.caldav - CalDAV configuration
   * @param {Object} config.heartbeat - Heartbeat settings
   * @param {Object} config.llmRouter - LLM router instance
   * @param {Function} config.notifyUser - User notification function
   * @param {Function} config.auditLog - Audit logging function
   */

NEW:
  /**
   * @param {Object} config
   * @param {Object} config.nextcloud - Nextcloud connection config
   * @param {Object} config.deck - Deck configuration
   * @param {Object} config.caldav - CalDAV configuration
   * @param {Object} config.heartbeat - Heartbeat settings
   * @param {Object} config.llmRouter - LLM router instance
   * @param {Object} config.ncRequestManager - NCRequestManager instance for CalDAV
   * @param {Function} config.notifyUser - User notification function
   * @param {Function} config.auditLog - Audit logging function
   */
```

---

## Fix 2: bot.js NCRequestManager Wiring

### Root Cause

**File**: `/opt/moltagent/src/bot.js`
**Lines 176-188**: HeartbeatManager is constructed without `ncRequestManager` in its
config object. The NCRequestManager instance exists at line 147 as `ncRequestManager`
but is never passed through.

### Required Change

**Edit 2a**: Add ncRequestManager to HeartbeatManager config (line 182, after credentialBroker)

```
OLD (lines 176-188):
  const heartbeat = new HeartbeatManager({
    nextcloud: {
      url: CONFIG.nextcloud.url,
      username: CONFIG.nextcloud.username
      // No password here - use credential broker
    },
    credentialBroker,  // Pass the broker
    deck: CONFIG.deck,
    heartbeat: CONFIG.heartbeat,
    llmRouter,
    notifyUser,
    auditLog
  });

NEW:
  const heartbeat = new HeartbeatManager({
    nextcloud: {
      url: CONFIG.nextcloud.url,
      username: CONFIG.nextcloud.username
      // No password here - use credential broker
    },
    credentialBroker,  // Pass the broker
    ncRequestManager,  // Pass NCRequestManager for CalDAV
    deck: CONFIG.deck,
    heartbeat: CONFIG.heartbeat,
    llmRouter,
    notifyUser,
    auditLog
  });
```

---

## Fix 3: CalendarHandler SecurityInterceptor Integration

### Design

**File**: `/opt/moltagent/src/lib/handlers/calendar-handler.js`

The SecurityInterceptor has two hooks:
- `beforeExecute(operation, params, context)` -> returns `{proceed, decision, reason, approvalRequired, approvalPrompt, modifiedParams}`
- `afterExecute(operation, response, context)` -> returns `{response, sanitized, warnings, blocked, reason}`

CalendarHandler must:
1. Accept an optional SecurityInterceptor in its constructor (4th argument)
2. Call `beforeExecute` before each CalDAV operation in `handle()`
3. Call `afterExecute` on the response message text
4. Handle BLOCK and APPROVAL_REQUIRED decisions gracefully
5. Pass through cleanly when no SecurityInterceptor is set (backward compatible)

### Required Changes

**Edit 3a**: Update constructor to accept SecurityInterceptor (lines 98-109)

```
OLD (lines 98-109):
class CalendarHandler {
  /**
   * Create a new CalendarHandler
   * @param {Object} caldavClient - CalDAV client instance
   * @param {Object} llmRouter - LLM router for intent parsing
   * @param {Function} [auditLog] - Audit logging function
   */
  constructor(caldavClient, llmRouter, auditLog) {
    this.caldav = caldavClient;
    this.llm = llmRouter;
    this.auditLog = auditLog || (async () => {});
  }

NEW:
class CalendarHandler {
  /**
   * Create a new CalendarHandler
   * @param {Object} caldavClient - CalDAV client instance
   * @param {Object} llmRouter - LLM router for intent parsing
   * @param {Function} [auditLog] - Audit logging function
   * @param {Object} [securityInterceptor] - SecurityInterceptor instance for before/after execute hooks
   */
  constructor(caldavClient, llmRouter, auditLog, securityInterceptor) {
    this.caldav = caldavClient;
    this.llm = llmRouter;
    this.auditLog = auditLog || (async () => {});
    this.security = securityInterceptor || null;
  }
```

**Edit 3b**: Add security check in `handle()` method, wrapping the switch block (lines 118-165)

Replace the entire `handle()` method body to add beforeExecute/afterExecute:

```
OLD (lines 118-165):
  async handle(message, user, context = {}) {
    // Parse the intent using LLM
    const intent = await this.parseIntent(message);

    console.log(`[Calendar] Intent: ${intent.action}`, JSON.stringify(intent).substring(0, 200));

    try {
      switch (intent.action) {
        case 'query_today':
          return await this.handleQueryToday(intent, user);

        case 'query_tomorrow':
          return await this.handleQueryTomorrow(intent, user);

        case 'query_date':
          return await this.handleQueryDate(intent, user);

        case 'query_upcoming':
          return await this.handleQueryUpcoming(intent, user);

        case 'create_event':
          return await this.handleCreateEvent(intent, user, context);

        case 'find_free_time':
          return await this.handleFindFreeTime(intent, user);

        case 'check_availability':
          return await this.handleCheckAvailability(intent, user);

        default:
          return {
            success: false,
            message: "I didn't understand that calendar request. Try:\n" +
                     "• 'What's on my calendar today?'\n" +
                     "• 'Schedule a meeting tomorrow at 2pm'\n" +
                     "• 'Find a free slot this week'\n" +
                     "• 'Am I free Friday at 3pm?'"
          };
      }
    } catch (error) {
      console.error('[Calendar] Error:', error);
      await this.auditLog('calendar_error', { action: intent.action, error: error.message });
      return {
        success: false,
        message: `Calendar error: ${error.message}`
      };
    }
  }

NEW:
  async handle(message, user, context = {}) {
    // Parse the intent using LLM
    const intent = await this.parseIntent(message);

    console.log(`[Calendar] Intent: ${intent.action}`, JSON.stringify(intent).substring(0, 200));

    // Security: beforeExecute check
    if (this.security) {
      const securityContext = {
        roomToken: context.roomToken || context.token || 'unknown',
        userId: user || 'unknown',
        messageId: context.messageId || null
      };

      const securityResult = await this.security.beforeExecute(
        'calendar_' + intent.action,
        { content: message, ...intent },
        securityContext
      );

      if (!securityResult.proceed) {
        if (securityResult.decision === 'APPROVAL_REQUIRED') {
          return {
            success: true,
            requiresConfirmation: true,
            confirmationType: 'security_approval',
            message: securityResult.approvalPrompt || 'This calendar operation requires approval.',
            pendingAction: { action: intent.action, intent }
          };
        }
        return {
          success: false,
          message: `Calendar operation blocked: ${securityResult.reason || 'security policy'}`
        };
      }
    }

    try {
      let result;

      switch (intent.action) {
        case 'query_today':
          result = await this.handleQueryToday(intent, user);
          break;

        case 'query_tomorrow':
          result = await this.handleQueryTomorrow(intent, user);
          break;

        case 'query_date':
          result = await this.handleQueryDate(intent, user);
          break;

        case 'query_upcoming':
          result = await this.handleQueryUpcoming(intent, user);
          break;

        case 'create_event':
          result = await this.handleCreateEvent(intent, user, context);
          break;

        case 'find_free_time':
          result = await this.handleFindFreeTime(intent, user);
          break;

        case 'check_availability':
          result = await this.handleCheckAvailability(intent, user);
          break;

        default:
          return {
            success: false,
            message: "I didn't understand that calendar request. Try:\n" +
                     "• 'What's on my calendar today?'\n" +
                     "• 'Schedule a meeting tomorrow at 2pm'\n" +
                     "• 'Find a free slot this week'\n" +
                     "• 'Am I free Friday at 3pm?'"
          };
      }

      // Security: afterExecute on the response message
      if (this.security && result.message) {
        const securityContext = {
          roomToken: context.roomToken || context.token || 'unknown',
          userId: user || 'unknown',
          messageId: context.messageId || null
        };

        const afterResult = await this.security.afterExecute(
          'calendar_' + intent.action,
          result.message,
          securityContext
        );

        if (afterResult.blocked) {
          return {
            success: false,
            message: 'Calendar response blocked for security review.'
          };
        }

        result.message = afterResult.response;
      }

      return result;
    } catch (error) {
      console.error('[Calendar] Error:', error);
      await this.auditLog('calendar_error', { action: intent.action, error: error.message });
      return {
        success: false,
        message: `Calendar error: ${error.message}`
      };
    }
  }
```

**Edit 3c**: Add security check in `confirmCreateEvent()` method (lines 510-529)

This is the method that executes the actual event creation after HITL approval. It must
also go through security:

```
OLD (lines 510-529):
  async confirmCreateEvent(eventData, user) {
    const result = await this.caldav.createEvent(eventData);

    await this.auditLog('calendar_event_created', {
      user,
      uid: result.uid,
      summary: eventData.summary,
      start: eventData.start
    });

    return {
      success: true,
      message: `✅ Event created!\n\n` +
               `**${eventData.summary}**\n` +
               `📆 ${this.formatDate(eventData.start)}\n` +
               `🕐 ${this.formatTime(eventData.start)} - ${this.formatTime(eventData.end)}` +
               (eventData.location ? `\n📍 ${eventData.location}` : ''),
      event: result
    };
  }

NEW:
  async confirmCreateEvent(eventData, user, context = {}) {
    // Security: beforeExecute for the confirmed creation
    if (this.security) {
      const securityContext = {
        roomToken: context.roomToken || context.token || 'unknown',
        userId: user || 'unknown',
        messageId: context.messageId || null
      };

      const securityResult = await this.security.beforeExecute(
        'calendar_create_event_confirmed',
        { content: eventData.summary, ...eventData },
        securityContext
      );

      if (!securityResult.proceed) {
        return {
          success: false,
          message: `Event creation blocked: ${securityResult.reason || 'security policy'}`
        };
      }
    }

    const result = await this.caldav.createEvent(eventData);

    await this.auditLog('calendar_event_created', {
      user,
      uid: result.uid,
      summary: eventData.summary,
      start: eventData.start
    });

    return {
      success: true,
      message: `Event created!\n\n` +
               `**${eventData.summary}**\n` +
               `${this.formatDate(eventData.start)}\n` +
               `${this.formatTime(eventData.start)} - ${this.formatTime(eventData.end)}` +
               (eventData.location ? `\n${eventData.location}` : ''),
      event: result
    };
  }
```

---

## Fix 4: Integration Test Hardcoded Password

### Root Cause

**File**: `/opt/moltagent/scripts/test-caldav.js`
**Line 21**: Password `uS694pDVvnbQ` is hardcoded as a fallback default.

### Required Change

**Edit 4a**: Remove hardcoded password (lines 17-22)

```
OLD (lines 17-22):
// Configuration from environment or defaults
const config = {
  ncUrl: process.env.NC_URL || 'https://nx89136.your-storageshare.de',
  username: process.env.NC_USER || 'moltagent',
  password: process.env.MOLTAGENT_PASSWORD || 'uS694pDVvnbDpmQ'
};

NEW:
// Configuration from environment (no hardcoded credentials)
const config = {
  ncUrl: process.env.NC_URL,
  username: process.env.NC_USER || 'moltagent',
  password: process.env.MOLTAGENT_PASSWORD
};

if (!config.ncUrl || !config.password) {
  console.error('Required environment variables: NC_URL, MOLTAGENT_PASSWORD');
  console.error('Optional: NC_USER (defaults to moltagent)');
  process.exit(1);
}
```

---

## Fix 5: CalendarHandler Test Suite

### New File

**File**: `/opt/moltagent/test/unit/handlers/calendar-handler.test.js`

This is a NEW file. It must use:
- AGPL-3.0 license header (matching `test/unit/security/interceptor.test.js`)
- `test()` and `asyncTest()` from `test/helpers/test-runner.js`
- `assert` from Node.js
- Mock factories from `test/helpers/mock-factories.js`
- A mock CalDAV client (new mock factory addition)
- A mock SecurityInterceptor (new mock factory addition)

### Mock Factory Additions

**File**: `/opt/moltagent/test/helpers/mock-factories.js`

**Edit 5a**: Add two new mock factories before the `module.exports` block (before line 90)

```
OLD (lines 90-98):
module.exports = {
  createMockAuditLog,
  createMockCredentialBroker,
  createMockLLMRouter,
  createMockNCRequestManager,
  createMockCalendarHandler,
  createMockEmailHandler,
  createMockNotifyUser
};

NEW:
// CalDAV Client Mock (for CalendarHandler tests)
function createMockCalDAVClient(responses = {}) {
  return {
    getTodaySummary: async () => responses.todaySummary || {
      text: 'No events today.',
      events: []
    },
    getEventCalendars: async () => responses.eventCalendars || [
      { id: 'personal', displayName: 'Personal', supportsEvents: true }
    ],
    getEvents: async (calId, start, end) => responses.events || [],
    getUpcomingEvents: async (hours) => responses.upcomingEvents || [],
    createEvent: async (eventData) => responses.createEvent || {
      uid: 'test-uid-' + Date.now(),
      summary: eventData.summary
    },
    checkAvailability: async (start, end, calId) => responses.availability || {
      isFree: true,
      conflicts: []
    },
    findFreeSlots: async (start, end, duration, options) => responses.freeSlots || [],
    amIFreeAt: async (time) => responses.isFree !== undefined ? responses.isFree : true,
    getCalendars: async () => responses.calendars || [],
    getCalendar: async (id) => responses.calendar || { id, displayName: 'Test' },
    deleteEvent: async (calId, uid) => responses.deleteEvent || { success: true },
    updateEvent: async (calId, uid, data) => responses.updateEvent || { uid, ...data }
  };
}

// SecurityInterceptor Mock (for handler tests)
function createMockSecurityInterceptor(overrides = {}) {
  return {
    beforeExecute: async (operation, params, context) => {
      if (overrides.beforeExecute) {
        return typeof overrides.beforeExecute === 'function'
          ? overrides.beforeExecute(operation, params, context)
          : overrides.beforeExecute;
      }
      return {
        proceed: true,
        decision: 'ALLOW',
        reason: null,
        modifiedParams: { ...params },
        approvalRequired: false,
        approvalPrompt: null,
        routeToLocal: false,
        session: {},
        guardResults: { tools: null, prompt: null, secrets: null, paths: null, egress: null }
      };
    },
    afterExecute: async (operation, response, context) => {
      if (overrides.afterExecute) {
        return typeof overrides.afterExecute === 'function'
          ? overrides.afterExecute(operation, response, context)
          : overrides.afterExecute;
      }
      return {
        response,
        sanitized: false,
        warnings: [],
        blocked: false,
        reason: null
      };
    },
    handleApproval: (context, operation, params, approved) => ({
      success: true,
      canProceed: approved,
      message: approved ? 'Approved' : 'Denied'
    }),
    getStatus: () => ({ activeSessions: 0, pendingApprovals: 0, blockedToday: 0, lastMemoryScan: null })
  };
}

module.exports = {
  createMockAuditLog,
  createMockCredentialBroker,
  createMockLLMRouter,
  createMockNCRequestManager,
  createMockCalendarHandler,
  createMockEmailHandler,
  createMockNotifyUser,
  createMockCalDAVClient,
  createMockSecurityInterceptor
};
```

### Test File Content

**New file**: `/opt/moltagent/test/unit/handlers/calendar-handler.test.js`

Full content specified below in the File Manifest section. The test cases are:

#### Constructor Tests
- TC-CH-001: Constructor stores caldavClient, llmRouter, auditLog
- TC-CH-002: Constructor stores securityInterceptor (4th arg)
- TC-CH-003: Constructor defaults auditLog to no-op when null
- TC-CH-004: Constructor defaults security to null when omitted

#### Intent Parsing Tests
- TC-CH-010: parseIntent returns query_today for "today" messages
- TC-CH-011: fallbackIntentParse returns query_today for "today"
- TC-CH-012: fallbackIntentParse returns query_tomorrow for "tomorrow"
- TC-CH-013: fallbackIntentParse returns create_event for "schedule"
- TC-CH-014: fallbackIntentParse returns find_free_time for "free"
- TC-CH-015: fallbackIntentParse returns query_upcoming for "this week"

#### Query Handler Tests
- TC-CH-020: handleQueryToday returns events from CalDAV
- TC-CH-021: handleQueryToday returns "no events" message when empty
- TC-CH-022: handleQueryTomorrow returns tomorrow's events
- TC-CH-023: handleQueryUpcoming returns grouped events by day
- TC-CH-024: handleQueryDate returns events for a specific date

#### Create Event Tests
- TC-CH-030: handleCreateEvent returns requiresConfirmation=true
- TC-CH-031: handleCreateEvent requires start time
- TC-CH-032: handleCreateEvent shows conflict warning
- TC-CH-033: confirmCreateEvent calls caldav.createEvent
- TC-CH-034: confirmCreateEvent returns created event

#### Free Time Tests
- TC-CH-040: handleFindFreeTime returns free slots
- TC-CH-041: handleFindFreeTime returns "no slots" when calendar is packed
- TC-CH-042: handleCheckAvailability returns free when no conflicts
- TC-CH-043: handleCheckAvailability returns conflicts when busy

#### Security Integration Tests
- TC-CH-050: handle() calls security.beforeExecute before CalDAV operation
- TC-CH-051: handle() returns block message when security blocks
- TC-CH-052: handle() returns approval request when security requires approval
- TC-CH-053: handle() calls security.afterExecute on response
- TC-CH-054: handle() returns blocked response when afterExecute blocks
- TC-CH-055: handle() works without security (null interceptor)
- TC-CH-056: confirmCreateEvent() calls security.beforeExecute
- TC-CH-057: confirmCreateEvent() returns block when security blocks

#### Formatting Helper Tests
- TC-CH-060: formatTime returns 12-hour format
- TC-CH-061: formatDate returns short date format
- TC-CH-062: isToday returns true for today
- TC-CH-063: isTomorrow returns true for tomorrow
- TC-CH-064: getTomorrow returns ISO date string

#### Error Handling Tests
- TC-CH-070: handle() returns error message on CalDAV failure
- TC-CH-071: handle() logs error to auditLog on failure

---

## Dependency Map

Implementation order (files that depend on each other):

```
1. test/helpers/mock-factories.js          (no deps, adds createMockCalDAVClient + createMockSecurityInterceptor)
2. scripts/test-caldav.js                  (no deps, remove hardcoded password)
3. src/lib/handlers/calendar-handler.js    (depends on SecurityInterceptor interface knowledge)
4. src/lib/integrations/heartbeat-manager.js (depends on NCRequestManager interface)
5. src/bot.js                              (depends on HeartbeatManager accepting ncRequestManager)
6. test/unit/handlers/calendar-handler.test.js (depends on 1 + 3 being done)
```

---

## File Manifest

### Files to MODIFY

| # | File | Change Summary |
|---|------|---------------|
| 1 | `/opt/moltagent/src/lib/integrations/heartbeat-manager.js` | Store ncRequestManager; construct CalDAVClient in new mode; update JSDoc |
| 2 | `/opt/moltagent/src/bot.js` | Pass `ncRequestManager` into HeartbeatManager config |
| 3 | `/opt/moltagent/src/lib/handlers/calendar-handler.js` | Add SecurityInterceptor as 4th constructor arg; add before/afterExecute in handle(); add security check in confirmCreateEvent() |
| 4 | `/opt/moltagent/scripts/test-caldav.js` | Remove hardcoded password, require env vars |
| 5 | `/opt/moltagent/test/helpers/mock-factories.js` | Add createMockCalDAVClient() and createMockSecurityInterceptor() |

### Files to CREATE

| # | File | Description |
|---|------|-------------|
| 6 | `/opt/moltagent/test/unit/handlers/calendar-handler.test.js` | Full unit test suite for CalendarHandler (34 test cases) |

---

## Exact Edit Instructions Summary

### Edit 1a -- heartbeat-manager.js line 34
**old_string**: `    this.credentialBroker = config.credentialBroker;`
**new_string**:
```javascript
    this.credentialBroker = config.credentialBroker;
    this.ncRequestManager = config.ncRequestManager;
```

### Edit 1b -- heartbeat-manager.js lines 54-60
**old_string**:
```javascript
    // Initialize CalDAV client with credential broker
    this.caldavClient = new CalDAVClient({
      ncUrl: config.nextcloud.url,
      username: config.nextcloud.username,
      credentialBroker: config.credentialBroker,
      auditLog: this.auditLog
    });
```
**new_string**:
```javascript
    // Initialize CalDAV client with NCRequestManager (new mode)
    if (config.ncRequestManager) {
      this.caldavClient = new CalDAVClient(
        config.ncRequestManager,
        config.credentialBroker,
        {
          ncUrl: config.nextcloud.url,
          username: config.nextcloud.username,
          auditLog: this.auditLog
        }
      );
    } else {
      // Fallback for tests or legacy mode -- will fail on _request()
      this.caldavClient = new CalDAVClient({
        ncUrl: config.nextcloud.url,
        username: config.nextcloud.username,
        credentialBroker: config.credentialBroker,
        auditLog: this.auditLog
      });
      console.warn('[Heartbeat] CalDAVClient created in legacy mode -- calendar operations will fail');
    }
```

### Edit 1c -- heartbeat-manager.js lines 24-25
**old_string**:
```javascript
   * @param {Object} config.caldav - CalDAV configuration
   * @param {Object} config.heartbeat - Heartbeat settings
```
**new_string**:
```javascript
   * @param {Object} config.caldav - CalDAV configuration
   * @param {Object} config.heartbeat - Heartbeat settings
   * @param {Object} config.ncRequestManager - NCRequestManager instance for CalDAV
```

### Edit 2a -- bot.js lines 182-183
**old_string**:
```javascript
    credentialBroker,  // Pass the broker
    deck: CONFIG.deck,
```
**new_string**:
```javascript
    credentialBroker,  // Pass the broker
    ncRequestManager,  // Pass NCRequestManager for CalDAV
    deck: CONFIG.deck,
```

### Edit 3a -- calendar-handler.js lines 99-109
**old_string**:
```javascript
  /**
   * Create a new CalendarHandler
   * @param {Object} caldavClient - CalDAV client instance
   * @param {Object} llmRouter - LLM router for intent parsing
   * @param {Function} [auditLog] - Audit logging function
   */
  constructor(caldavClient, llmRouter, auditLog) {
    this.caldav = caldavClient;
    this.llm = llmRouter;
    this.auditLog = auditLog || (async () => {});
  }
```
**new_string**:
```javascript
  /**
   * Create a new CalendarHandler
   * @param {Object} caldavClient - CalDAV client instance
   * @param {Object} llmRouter - LLM router for intent parsing
   * @param {Function} [auditLog] - Audit logging function
   * @param {Object} [securityInterceptor] - SecurityInterceptor instance for before/after execute hooks
   */
  constructor(caldavClient, llmRouter, auditLog, securityInterceptor) {
    this.caldav = caldavClient;
    this.llm = llmRouter;
    this.auditLog = auditLog || (async () => {});
    this.security = securityInterceptor || null;
  }
```

### Edit 3b -- calendar-handler.js lines 118-165 (entire handle method)
**old_string**:
```javascript
  async handle(message, user, context = {}) {
    // Parse the intent using LLM
    const intent = await this.parseIntent(message);

    console.log(`[Calendar] Intent: ${intent.action}`, JSON.stringify(intent).substring(0, 200));

    try {
      switch (intent.action) {
        case 'query_today':
          return await this.handleQueryToday(intent, user);

        case 'query_tomorrow':
          return await this.handleQueryTomorrow(intent, user);

        case 'query_date':
          return await this.handleQueryDate(intent, user);

        case 'query_upcoming':
          return await this.handleQueryUpcoming(intent, user);

        case 'create_event':
          return await this.handleCreateEvent(intent, user, context);

        case 'find_free_time':
          return await this.handleFindFreeTime(intent, user);

        case 'check_availability':
          return await this.handleCheckAvailability(intent, user);

        default:
          return {
            success: false,
            message: "I didn't understand that calendar request. Try:\n" +
                     "• 'What's on my calendar today?'\n" +
                     "• 'Schedule a meeting tomorrow at 2pm'\n" +
                     "• 'Find a free slot this week'\n" +
                     "• 'Am I free Friday at 3pm?'"
          };
      }
    } catch (error) {
      console.error('[Calendar] Error:', error);
      await this.auditLog('calendar_error', { action: intent.action, error: error.message });
      return {
        success: false,
        message: `Calendar error: ${error.message}`
      };
    }
  }
```
**new_string**:
```javascript
  async handle(message, user, context = {}) {
    // Parse the intent using LLM
    const intent = await this.parseIntent(message);

    console.log(`[Calendar] Intent: ${intent.action}`, JSON.stringify(intent).substring(0, 200));

    // Security: beforeExecute check
    if (this.security) {
      const securityContext = {
        roomToken: context.roomToken || context.token || 'unknown',
        userId: user || 'unknown',
        messageId: context.messageId || null
      };

      const securityResult = await this.security.beforeExecute(
        'calendar_' + intent.action,
        { content: message, ...intent },
        securityContext
      );

      if (!securityResult.proceed) {
        if (securityResult.decision === 'APPROVAL_REQUIRED') {
          return {
            success: true,
            requiresConfirmation: true,
            confirmationType: 'security_approval',
            message: securityResult.approvalPrompt || 'This calendar operation requires approval.',
            pendingAction: { action: intent.action, intent }
          };
        }
        return {
          success: false,
          message: `Calendar operation blocked: ${securityResult.reason || 'security policy'}`
        };
      }
    }

    try {
      let result;

      switch (intent.action) {
        case 'query_today':
          result = await this.handleQueryToday(intent, user);
          break;

        case 'query_tomorrow':
          result = await this.handleQueryTomorrow(intent, user);
          break;

        case 'query_date':
          result = await this.handleQueryDate(intent, user);
          break;

        case 'query_upcoming':
          result = await this.handleQueryUpcoming(intent, user);
          break;

        case 'create_event':
          result = await this.handleCreateEvent(intent, user, context);
          break;

        case 'find_free_time':
          result = await this.handleFindFreeTime(intent, user);
          break;

        case 'check_availability':
          result = await this.handleCheckAvailability(intent, user);
          break;

        default:
          return {
            success: false,
            message: "I didn't understand that calendar request. Try:\n" +
                     "• 'What's on my calendar today?'\n" +
                     "• 'Schedule a meeting tomorrow at 2pm'\n" +
                     "• 'Find a free slot this week'\n" +
                     "• 'Am I free Friday at 3pm?'"
          };
      }

      // Security: afterExecute on the response message
      if (this.security && result.message) {
        const securityContext = {
          roomToken: context.roomToken || context.token || 'unknown',
          userId: user || 'unknown',
          messageId: context.messageId || null
        };

        const afterResult = await this.security.afterExecute(
          'calendar_' + intent.action,
          result.message,
          securityContext
        );

        if (afterResult.blocked) {
          return {
            success: false,
            message: 'Calendar response blocked for security review.'
          };
        }

        result.message = afterResult.response;
      }

      return result;
    } catch (error) {
      console.error('[Calendar] Error:', error);
      await this.auditLog('calendar_error', { action: intent.action, error: error.message });
      return {
        success: false,
        message: `Calendar error: ${error.message}`
      };
    }
  }
```

### Edit 3c -- calendar-handler.js lines 510-529 (confirmCreateEvent)
**old_string**:
```javascript
  async confirmCreateEvent(eventData, user) {
    const result = await this.caldav.createEvent(eventData);

    await this.auditLog('calendar_event_created', {
      user,
      uid: result.uid,
      summary: eventData.summary,
      start: eventData.start
    });

    return {
      success: true,
      message: `✅ Event created!\n\n` +
               `**${eventData.summary}**\n` +
               `📆 ${this.formatDate(eventData.start)}\n` +
               `🕐 ${this.formatTime(eventData.start)} - ${this.formatTime(eventData.end)}` +
               (eventData.location ? `\n📍 ${eventData.location}` : ''),
      event: result
    };
  }
```
**new_string**:
```javascript
  async confirmCreateEvent(eventData, user, context = {}) {
    // Security: beforeExecute for the confirmed creation
    if (this.security) {
      const securityContext = {
        roomToken: context.roomToken || context.token || 'unknown',
        userId: user || 'unknown',
        messageId: context.messageId || null
      };

      const securityResult = await this.security.beforeExecute(
        'calendar_create_event_confirmed',
        { content: eventData.summary, ...eventData },
        securityContext
      );

      if (!securityResult.proceed) {
        return {
          success: false,
          message: `Event creation blocked: ${securityResult.reason || 'security policy'}`
        };
      }
    }

    const result = await this.caldav.createEvent(eventData);

    await this.auditLog('calendar_event_created', {
      user,
      uid: result.uid,
      summary: eventData.summary,
      start: eventData.start
    });

    return {
      success: true,
      message: `Event created!\n\n` +
               `**${eventData.summary}**\n` +
               `${this.formatDate(eventData.start)}\n` +
               `${this.formatTime(eventData.start)} - ${this.formatTime(eventData.end)}` +
               (eventData.location ? `\n${eventData.location}` : ''),
      event: result
    };
  }
```

### Edit 4a -- test-caldav.js lines 17-22
**old_string**:
```javascript
// Configuration from environment or defaults
const config = {
  ncUrl: process.env.NC_URL || 'https://nx89136.your-storageshare.de',
  username: process.env.NC_USER || 'moltagent',
  password: process.env.MOLTAGENT_PASSWORD || 'uS694pDVvnbDpmQ'
};
```
**new_string**:
```javascript
// Configuration from environment (no hardcoded credentials)
const config = {
  ncUrl: process.env.NC_URL,
  username: process.env.NC_USER || 'moltagent',
  password: process.env.MOLTAGENT_PASSWORD
};

if (!config.ncUrl || !config.password) {
  console.error('Required environment variables: NC_URL, MOLTAGENT_PASSWORD');
  console.error('Optional: NC_USER (defaults to moltagent)');
  process.exit(1);
}
```

### Edit 5a -- mock-factories.js (before module.exports)
**old_string**:
```javascript
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
**new_string**:
```javascript
// CalDAV Client Mock (for CalendarHandler tests)
function createMockCalDAVClient(responses = {}) {
  return {
    getTodaySummary: async () => responses.todaySummary || {
      text: 'No events today.',
      events: []
    },
    getEventCalendars: async () => responses.eventCalendars || [
      { id: 'personal', displayName: 'Personal', supportsEvents: true }
    ],
    getEvents: async (calId, start, end) => responses.events || [],
    getUpcomingEvents: async (hours) => responses.upcomingEvents || [],
    createEvent: async (eventData) => responses.createEvent || {
      uid: 'test-uid-' + Date.now(),
      summary: eventData.summary
    },
    checkAvailability: async (start, end, calId) => responses.availability || {
      isFree: true,
      conflicts: []
    },
    findFreeSlots: async (start, end, duration, options) => responses.freeSlots || [],
    amIFreeAt: async (time) => responses.isFree !== undefined ? responses.isFree : true,
    getCalendars: async () => responses.calendars || [],
    getCalendar: async (id) => responses.calendar || { id, displayName: 'Test' },
    deleteEvent: async (calId, uid) => responses.deleteEvent || { success: true },
    updateEvent: async (calId, uid, data) => responses.updateEvent || { uid, ...data }
  };
}

// SecurityInterceptor Mock (for handler tests)
function createMockSecurityInterceptor(overrides = {}) {
  return {
    beforeExecute: async (operation, params, context) => {
      if (overrides.beforeExecute) {
        return typeof overrides.beforeExecute === 'function'
          ? overrides.beforeExecute(operation, params, context)
          : overrides.beforeExecute;
      }
      return {
        proceed: true,
        decision: 'ALLOW',
        reason: null,
        modifiedParams: { ...params },
        approvalRequired: false,
        approvalPrompt: null,
        routeToLocal: false,
        session: {},
        guardResults: { tools: null, prompt: null, secrets: null, paths: null, egress: null }
      };
    },
    afterExecute: async (operation, response, context) => {
      if (overrides.afterExecute) {
        return typeof overrides.afterExecute === 'function'
          ? overrides.afterExecute(operation, response, context)
          : overrides.afterExecute;
      }
      return {
        response,
        sanitized: false,
        warnings: [],
        blocked: false,
        reason: null
      };
    },
    handleApproval: (context, operation, params, approved) => ({
      success: true,
      canProceed: approved,
      message: approved ? 'Approved' : 'Denied'
    }),
    getStatus: () => ({ activeSessions: 0, pendingApprovals: 0, blockedToday: 0, lastMemoryScan: null })
  };
}

module.exports = {
  createMockAuditLog,
  createMockCredentialBroker,
  createMockLLMRouter,
  createMockNCRequestManager,
  createMockCalendarHandler,
  createMockEmailHandler,
  createMockNotifyUser,
  createMockCalDAVClient,
  createMockSecurityInterceptor
};
```

### New File 6 -- test/unit/handlers/calendar-handler.test.js

See full content in the companion test file below.

---

## Verification Checklist

After implementing all edits, verify:

1. `node -c src/lib/integrations/heartbeat-manager.js` -- syntax check passes
2. `node -c src/bot.js` -- syntax check passes
3. `node -c src/lib/handlers/calendar-handler.js` -- syntax check passes
4. `node -c scripts/test-caldav.js` -- syntax check passes
5. `node -c test/helpers/mock-factories.js` -- syntax check passes
6. `node test/unit/handlers/calendar-handler.test.js` -- all tests pass
7. `node test/unit/integrations/caldav-client.test.js` -- existing tests still pass
8. `node test/unit/handlers/message-router.test.js` -- existing tests still pass
