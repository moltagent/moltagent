# MessageRouter and Webhook Server Decomposition Design

## Problem Statement

Two files in the codebase have grown beyond their original scope:

1. **message-router.js** (615 lines) - The `_handleConfirmation()` method (~290 lines) mixes three distinct confirmation types: email replies, meeting responses, and general pending actions.

2. **webhook-server.js** (769 lines) - Mixes HTTP routing, message processing, command handling, health checks, initialization, and shutdown in a single file.

## Chosen Pattern

**Strategy Pattern + Module Decomposition**

- Extract confirmation handling into strategy handlers, each with a single responsibility
- Extract webhook server concerns into focused handler modules
- Use factory functions to wire dependencies together
- Preserve all existing behavior exactly (refactoring, not rewriting)

## Key Dependencies and Integration Points

### Confirmation Handlers

```
MessageRouter
    |
    +-- _handleConfirmation() delegates to:
        |
        +-- EmailReplyHandler (standard email reply confirmations)
        |       Uses: pendingEmailReplies, emailHandler
        |
        +-- MeetingResponseHandler (meeting invitation responses)
        |       Uses: pendingEmailReplies, emailHandler, calendarClient
        |
        +-- PendingActionHandler (calendar/email from pendingConfirmations Map)
                Uses: pendingConfirmations Map, calendarHandler, emailHandler
```

### Server Handlers

```
webhook-server.js
    |
    +-- createServerComponents() creates:
        |
        +-- WebhookHandler (POST /webhook/nctalk)
        |       Uses: signatureVerifier, messageProcessor
        |
        +-- HealthHandler (GET /health, /stats)
        |       Uses: signatureVerifier, ncRequestManager
        |
        +-- MessageProcessor (process incoming messages)
        |       Uses: messageRouter, commandHandler, sendTalkReply
        |
        +-- CommandHandler (/help, /status, /stats commands)
                Uses: signatureVerifier, messageRouter
```

## Data Flow Summary

### Confirmation Flow

1. User sends "yes"/"decline"/"suggest"/etc. to NC Talk
2. MessageRouter.classifyIntent() returns 'confirm'
3. MessageRouter._handleConfirmation() checks:
   - pendingEmailReplies (email monitor notifications) -> EmailReplyHandler or MeetingResponseHandler
   - pendingConfirmations Map (user-initiated drafts) -> PendingActionHandler
4. Handler executes action (send email, update calendar)
5. Returns response to user

### Webhook Flow

1. NC Talk sends POST to /webhook/nctalk
2. WebhookHandler verifies signature
3. MessageProcessor extracts message data
4. If slash command -> CommandHandler
5. If natural language -> MessageRouter
6. Response sent back to Talk

## Files to Create

### Confirmation Handlers

| File | Purpose | Est. Lines |
|------|---------|------------|
| `src/lib/handlers/confirmation/email-reply-handler.js` | Standard email reply confirmations | 80 |
| `src/lib/handlers/confirmation/meeting-response-handler.js` | Meeting invitation responses | 120 |
| `src/lib/handlers/confirmation/pending-action-handler.js` | General pending confirmations | 60 |
| `src/lib/handlers/confirmation/index.js` | Barrel export + factory | 80 |

### Server Handlers

| File | Purpose | Est. Lines |
|------|---------|------------|
| `src/lib/server/message-processor.js` | Extract and route incoming messages | 100 |
| `src/lib/server/command-handler.js` | Handle slash commands | 70 |
| `src/lib/server/webhook-handler.js` | Handle webhook endpoint | 80 |
| `src/lib/server/health-handler.js` | Handle health/stats endpoints | 50 |
| `src/lib/server/index.js` | Barrel export + factory | 70 |

### Test Files

| File | Purpose |
|------|---------|
| `test/unit/handlers/confirmation/email-reply-handler.test.js` | Tests for email reply handling |
| `test/unit/handlers/confirmation/meeting-response-handler.test.js` | Tests for meeting responses |
| `test/unit/handlers/confirmation/pending-action-handler.test.js` | Tests for pending actions |
| `test/unit/server/message-processor.test.js` | Tests for message processing |
| `test/unit/server/command-handler.test.js` | Tests for slash commands |

## Files to Modify

| File | Changes |
|------|---------|
| `src/lib/handlers/message-router.js` | Refactor `_handleConfirmation()` to delegate to new handlers |
| `webhook-server.js` | Import and use new server components |

## Implementation Order (Dependency Map)

### Phase 1: Confirmation Handlers (no external dependencies)

1. `src/lib/handlers/confirmation/email-reply-handler.js`
2. `src/lib/handlers/confirmation/meeting-response-handler.js`
3. `src/lib/handlers/confirmation/pending-action-handler.js`
4. `src/lib/handlers/confirmation/index.js`
5. Tests for all confirmation handlers
6. Refactor `message-router.js` to use new handlers

### Phase 2: Server Handlers (depends on Phase 1 completion for testing)

1. `src/lib/server/health-handler.js` (simplest, no dependencies on other new modules)
2. `src/lib/server/command-handler.js` (standalone)
3. `src/lib/server/message-processor.js` (uses command-handler)
4. `src/lib/server/webhook-handler.js` (uses message-processor)
5. `src/lib/server/index.js`
6. Tests for all server handlers
7. Refactor `webhook-server.js` to use new components

## Rationale

### Why Strategy Pattern for Confirmations?

- Each confirmation type has distinct:
  - Data sources (pendingEmailReplies vs pendingConfirmations)
  - Actions (email send, calendar update, both)
  - Response patterns (meeting-specific prompts, alternative suggestions)
- Strategy pattern allows adding new confirmation types without modifying router
- Each handler can be tested in isolation

### Why Module Decomposition for Server?

- Webhook, health, and command handling are orthogonal concerns
- Message processing is the core logic that other components need
- Factory function keeps wiring in one place
- Each module can be tested independently

### Preserving Behavior

- All existing regex patterns preserved exactly
- All existing response messages preserved
- All existing error handling patterns preserved
- No new features or functionality added
- Refactoring only - output should be identical

## Testing Strategy

1. **Unit tests** for each new module in isolation
2. **Integration test** verifying webhook-server still works end-to-end
3. **Existing message-router.test.js** should pass unchanged after refactor

## Notes for Implementers

- Extract code verbatim from existing files first
- Then refactor for clarity while preserving behavior
- Use `createMock*` helpers from `test/helpers/mock-factories.js`
- Follow existing patterns in `calendar-handler.js` and `email-handler.js`
- Use centralized config from `src/lib/config.js`
- Use `createErrorHandler()` from `src/lib/errors/error-handler.js`
