# Unified Error Handling Design for Moltagent

## Architecture Brief

**Problem Statement:** The Moltagent codebase exposes internal error details (file paths, stack traces, configuration) to end users, creating a security vulnerability (P0.2). Additionally, multiple empty catch blocks silently swallow errors, making debugging difficult and potentially hiding security issues (P0.3).

**Chosen Pattern:** Centralized Error Handler with Error Classification
- Single module (`error-handler.js`) that acts as the error boundary between internal operations and user-facing output
- Error categories mapped to safe, generic user messages
- Structured internal logging with full context for debugging
- Helper functions for the common "catch and log" pattern

**Key Dependencies:**
- Integrates with existing `auditLog` function pattern used throughout codebase
- Console logging for immediate output (existing pattern)
- Optional file-based error logging for persistence

**Data Flow:**
```
Internal Error -> classify() -> ErrorHandler.handle()
    |                               |
    |                               +--> Log internally (full details)
    |                               +--> Return safe user message
    v
User-facing response (sanitized)
```

---

## Error Categories and Safe User Messages

### Category: `AUTHENTICATION`
**Internal causes:** Invalid credentials, expired tokens, IMAP/SMTP auth failures
**Safe message:** "Authentication failed. Please check your credentials or try again."
**Log level:** WARN

### Category: `AUTHORIZATION`
**Internal causes:** 401/403 from APIs, permission denied on resources
**Safe message:** "You don't have permission to perform this action."
**Log level:** WARN

### Category: `NETWORK`
**Internal causes:** Connection timeout, DNS failures, socket errors, ECONNREFUSED
**Safe message:** "Unable to reach the service. Please try again in a moment."
**Log level:** ERROR

### Category: `RATE_LIMITED`
**Internal causes:** 429 responses, rate limit headers
**Safe message:** "Too many requests. Please wait a moment and try again."
**Log level:** WARN

### Category: `EXTERNAL_SERVICE`
**Internal causes:** Third-party API errors (CalDAV, IMAP, SMTP, Ollama)
**Safe message:** "An external service is temporarily unavailable. Please try again."
**Log level:** ERROR

### Category: `VALIDATION`
**Internal causes:** Invalid input, missing required fields, malformed data
**Safe message:** "The request could not be processed. Please check your input."
**Log level:** INFO

### Category: `NOT_FOUND`
**Internal causes:** Resource not found, credential not in NC Passwords
**Safe message:** "The requested resource was not found."
**Log level:** INFO

### Category: `CONFIGURATION`
**Internal causes:** Missing config, invalid settings, credential not configured
**Safe message:** "This feature is not configured. Please contact your administrator."
**Log level:** ERROR

### Category: `TIMEOUT`
**Internal causes:** Request timeout, operation exceeded time limit
**Safe message:** "The operation took too long. Please try again."
**Log level:** WARN

### Category: `INTERNAL`
**Internal causes:** Unexpected errors, bugs, null pointer, type errors
**Safe message:** "Something went wrong. Please try again or contact support."
**Log level:** ERROR

### Category: `OUTPUT_BLOCKED`
**Internal causes:** OutputVerifier detected dangerous content
**Safe message:** "The response was blocked for safety reasons."
**Log level:** WARN (with security flag)

---

## Module Design: `/opt/moltagent/src/lib/errors/error-handler.js`

### Exports

```javascript
module.exports = {
  ErrorHandler,       // Main class
  ErrorCategory,      // Enum of categories
  MoltAgentError,     // Custom error class
  createErrorHandler, // Factory function
  wrapAsync,          // Higher-order function for async error handling
  logAndIgnore,       // Helper for empty catch replacement
  logAndRethrow       // Helper for logging before rethrowing
};
```

### Class: ErrorHandler

```javascript
class ErrorHandler {
  /**
   * @param {Object} config
   * @param {Function} [config.auditLog] - Async audit logging function
   * @param {string} [config.serviceName] - Name for log prefixes (e.g., 'EmailHandler')
   * @param {boolean} [config.includeRequestId] - Include request ID in user messages
   * @param {Function} [config.onError] - Callback for every error (monitoring integration)
   */
  constructor(config);

  /**
   * Handle an error and return a safe response
   * @param {Error} error - The caught error
   * @param {Object} context - Context about where the error occurred
   * @param {string} context.operation - What operation was being performed
   * @param {string} [context.user] - User who triggered the operation
   * @param {string} [context.requestId] - Request tracking ID
   * @param {Object} [context.metadata] - Additional context (non-sensitive)
   * @returns {Object} - { message: string, category: string, logged: boolean }
   */
  async handle(error, context);

  /**
   * Classify an error into a category
   * @param {Error} error
   * @returns {string} - ErrorCategory value
   */
  classify(error);

  /**
   * Get the safe user message for a category
   * @param {string} category - ErrorCategory value
   * @param {Object} [options] - Optional overrides
   * @param {string} [options.requestId] - Request ID to include
   * @returns {string}
   */
  getUserMessage(category, options);

  /**
   * Log error internally with full details
   * @param {Error} error
   * @param {string} category
   * @param {Object} context
   */
  async logInternal(error, category, context);
}
```

### Enum: ErrorCategory

```javascript
const ErrorCategory = {
  AUTHENTICATION: 'AUTHENTICATION',
  AUTHORIZATION: 'AUTHORIZATION',
  NETWORK: 'NETWORK',
  RATE_LIMITED: 'RATE_LIMITED',
  EXTERNAL_SERVICE: 'EXTERNAL_SERVICE',
  VALIDATION: 'VALIDATION',
  NOT_FOUND: 'NOT_FOUND',
  CONFIGURATION: 'CONFIGURATION',
  TIMEOUT: 'TIMEOUT',
  INTERNAL: 'INTERNAL',
  OUTPUT_BLOCKED: 'OUTPUT_BLOCKED'
};
```

### Class: MoltAgentError

```javascript
class MoltAgentError extends Error {
  /**
   * @param {string} message - Internal error message (for logs)
   * @param {Object} options
   * @param {string} options.category - ErrorCategory value
   * @param {string} [options.userMessage] - Override safe user message
   * @param {Error} [options.cause] - Original error
   * @param {Object} [options.metadata] - Additional context
   */
  constructor(message, options);

  // Properties
  category;     // ErrorCategory
  userMessage;  // Optional override
  cause;        // Original error
  metadata;     // Additional context
  timestamp;    // When error was created
}
```

### Helper: wrapAsync

```javascript
/**
 * Wrap an async function with error handling
 * @param {Function} fn - Async function to wrap
 * @param {ErrorHandler} handler - Error handler instance
 * @param {Object} defaultContext - Default context for errors
 * @returns {Function} - Wrapped function
 */
function wrapAsync(fn, handler, defaultContext);

// Usage:
const safeFetch = wrapAsync(fetchEmails, errorHandler, { operation: 'fetch_emails' });
```

### Helper: logAndIgnore

```javascript
/**
 * Log an error and continue (replacement for empty catch)
 * @param {ErrorHandler} handler - Error handler instance
 * @param {string} operation - What was being attempted
 * @param {string} [level='warn'] - Log level
 * @returns {Function} - Catch handler function
 */
function logAndIgnore(handler, operation, level);

// Usage in catch block:
try {
  await someOperation();
} catch (error) {
  logAndIgnore(errorHandler, 'calendar_decline_logging', 'warn')(error);
}
```

### Helper: logAndRethrow

```javascript
/**
 * Log an error and rethrow it (for error enrichment)
 * @param {ErrorHandler} handler - Error handler instance
 * @param {string} operation - What was being attempted
 * @returns {Function} - Catch handler function
 */
function logAndRethrow(handler, operation);
```

---

## Error Classification Logic

The `classify()` method uses the following heuristics:

```javascript
classify(error) {
  const msg = (error.message || '').toLowerCase();
  const code = error.code || '';
  const status = error.status || error.statusCode;

  // Check for custom MoltAgentError
  if (error instanceof MoltAgentError) {
    return error.category;
  }

  // Check for OutputVerificationError
  if (error.name === 'OutputVerificationError') {
    return ErrorCategory.OUTPUT_BLOCKED;
  }

  // HTTP status codes
  if (status === 401) return ErrorCategory.AUTHENTICATION;
  if (status === 403) return ErrorCategory.AUTHORIZATION;
  if (status === 404) return ErrorCategory.NOT_FOUND;
  if (status === 429) return ErrorCategory.RATE_LIMITED;
  if (status >= 500) return ErrorCategory.EXTERNAL_SERVICE;

  // Error codes
  if (code === 'ECONNREFUSED' || code === 'ENOTFOUND' || code === 'ETIMEDOUT') {
    return ErrorCategory.NETWORK;
  }
  if (code === 'ETIMEDOUT' || msg.includes('timeout')) {
    return ErrorCategory.TIMEOUT;
  }

  // Message patterns
  if (msg.includes('authentication') || msg.includes('auth failed') ||
      msg.includes('invalid credentials') || msg.includes('login failed')) {
    return ErrorCategory.AUTHENTICATION;
  }
  if (msg.includes('permission') || msg.includes('forbidden') || msg.includes('not authorized')) {
    return ErrorCategory.AUTHORIZATION;
  }
  if (msg.includes('not found') || msg.includes('does not exist')) {
    return ErrorCategory.NOT_FOUND;
  }
  if (msg.includes('not configured') || msg.includes('missing config') ||
      msg.includes('please add') || msg.includes('please configure')) {
    return ErrorCategory.CONFIGURATION;
  }
  if (msg.includes('rate limit') || msg.includes('too many requests')) {
    return ErrorCategory.RATE_LIMITED;
  }
  if (msg.includes('network') || msg.includes('connection') || msg.includes('socket')) {
    return ErrorCategory.NETWORK;
  }
  if (msg.includes('invalid') || msg.includes('required') || msg.includes('malformed')) {
    return ErrorCategory.VALIDATION;
  }

  // Default
  return ErrorCategory.INTERNAL;
}
```

---

## Internal Logging Format

Logs should include:
```javascript
{
  timestamp: new Date().toISOString(),
  level: 'ERROR',           // ERROR, WARN, INFO
  service: 'EmailHandler',  // From config.serviceName
  operation: 'send_email',  // From context
  category: 'NETWORK',
  requestId: 'abc-123',     // If available
  user: 'john',             // If available
  error: {
    name: 'Error',
    message: 'ECONNREFUSED',
    code: 'ECONNREFUSED',
    stack: '...'            // Full stack trace
  },
  metadata: { ... }         // Additional context
}
```

Console output format:
```
[EmailHandler] ERROR send_email: NETWORK - ECONNREFUSED (reqId: abc-123)
```

---

## Changes Required by File

### 1. `/opt/moltagent/src/lib/handlers/message-router.js`

**Current problematic code (line 149):**
```javascript
return {
  response: `Sorry, I encountered an error: ${error.message}`,
  error: true
};
```

**Required change:**
```javascript
// At top of file
const { createErrorHandler, ErrorCategory } = require('../errors/error-handler');

// In constructor
this.errorHandler = createErrorHandler({
  serviceName: 'MessageRouter',
  auditLog: options.auditLog
});

// In catch block (around line 149)
const { message } = await this.errorHandler.handle(error, {
  operation: `handle_${intent}`,
  user
});
return {
  response: message,
  error: true
};
```

**Additional locations in message-router.js:**
- Line 303: `return { response: \`Failed to send decline: ${error.message}\`, error: true };`
- Line 334: `return { response: \`Failed to send alternatives: ${error.message}\`, error: true };`
- Line 386: `return { response: \`Failed to send acceptance: ${error.message}\`, error: true };`
- Line 420-421: `return { response: \`Failed to send reply: ${error.message}\`, error: true };`
- Line 489: `return { response: \`Failed to execute action: ${error.message}\`, error: true };`

All should use `errorHandler.handle()` pattern.

---

### 2. `/opt/moltagent/webhook-server.js` (lines 448, 474, 498)

**Current problematic code (line 448):**
```javascript
const errorResponse = `Sorry, something went wrong: ${error.message}`;
```

**Required change:**
```javascript
// At top of file, after imports
const { createErrorHandler } = require('./src/lib/errors/error-handler');

// After initialization, create handler
let webhookErrorHandler = null;

// In initialize() function, after other inits
webhookErrorHandler = createErrorHandler({
  serviceName: 'WebhookServer',
  auditLog: consoleAuditLog
});

// In processMessage catch block (around line 448)
const { message } = await webhookErrorHandler.handle(error, {
  operation: 'process_message',
  user,
  metadata: { token }
});
const errorResponse = message;
```

**Same pattern for lines 474 and 498** in the fallback LLM routing path.

---

### 3. `/opt/moltagent/src/lib/nc-request-manager.js` (line 281)

**Current problematic code (line 281):**
```javascript
try {
  const date = new Date(retryAfter);
  const ms = date.getTime() - Date.now();
  return Math.max(ms, 1000);
} catch {
  return this.defaultRetryAfter;
}
```

**Analysis:** This empty catch is acceptable as it's a parsing fallback, but should log.

**Required change:**
```javascript
// At top of file
const { logAndIgnore, createErrorHandler } = require('./errors/error-handler');

// In constructor, add error handler
this.errorHandler = createErrorHandler({ serviceName: 'NCRequestManager' });

// Line 281
} catch (error) {
  // Failed to parse Retry-After as HTTP date, using default
  console.debug('[NCRequestManager] Could not parse Retry-After header:', retryAfter);
  return this.defaultRetryAfter;
}
```

---

### 4. `/opt/moltagent/src/lib/handlers/email-handler.js` (line 710)

**Current problematic code (lines 710-714):**
```javascript
} catch {
  // No custom footer configured, use default
}
```

**Required change:**
```javascript
// At top of file
const { logAndIgnore, createErrorHandler } = require('../errors/error-handler');

// In constructor
this.errorHandler = createErrorHandler({
  serviceName: 'EmailHandler',
  auditLog: this.auditLog
});

// Line 710
} catch (error) {
  // No custom footer configured, use default
  // Only log if it's not a "not found" error (which is expected)
  if (!error.message?.includes('not found')) {
    console.debug('[EmailHandler] Could not load custom footer:', error.message);
  }
}
```

**Additional location in email-handler.js (line 68-70):**
```javascript
// Current code
return {
  success: false,
  message: `Email error: ${error.message}`
};
```

**Required change:**
```javascript
const { message } = await this.errorHandler.handle(error, {
  operation: intent.action,
  user
});
return {
  success: false,
  message
};
```

---

### 5. `/opt/moltagent/src/lib/output-verifier.js` (line 347)

**Current problematic code (lines 346-349):**
```javascript
} catch {
  return false; // Invalid URL
}
```

**Analysis:** This is URL parsing - empty catch is defensible but should log in debug mode.

**Required change:**
```javascript
} catch (error) {
  // Invalid URL format - treat as disallowed for safety
  console.debug('[OutputVerifier] Invalid URL format:', url);
  return false;
}
```

---

### 6. `/opt/moltagent/src/lib/credential-cache.js` (lines 201, 219)

**Current problematic code (line 201):**
```javascript
} catch {
  return url;
}
```

**Current problematic code (line 219):**
```javascript
} catch {
  // Not JSON, ignore
}
```

**Required changes:**

Line 201:
```javascript
} catch (error) {
  // URL parsing failed, return original
  console.debug('[CredentialCache] Could not parse URL:', url);
  return url;
}
```

Line 219:
```javascript
} catch (error) {
  // Notes field is not JSON, which is normal for plain text notes
  // Only log if it looks like it might be malformed JSON
  if (entry.notes.trim().startsWith('{')) {
    console.debug('[CredentialCache] Notes field looks like JSON but failed to parse');
  }
}
```

---

## File Structure

```
/opt/moltagent/src/lib/errors/
  error-handler.js       # Main module (to be implemented)
  error-handler.design.md  # This design document
```

---

## Dependency Map and Implementation Order

1. **Create** `/opt/moltagent/src/lib/errors/error-handler.js`
   - No dependencies on other modified files
   - Must be implemented first

2. **Update** `/opt/moltagent/src/lib/credential-cache.js`
   - Simple logging changes (no dependency on error-handler)
   - Can be done in parallel with #1

3. **Update** `/opt/moltagent/src/lib/output-verifier.js`
   - Simple logging changes (no dependency on error-handler)
   - Can be done in parallel with #1

4. **Update** `/opt/moltagent/src/lib/nc-request-manager.js`
   - Simple logging changes (no dependency on error-handler)
   - Can be done in parallel with #1

5. **Update** `/opt/moltagent/src/lib/handlers/email-handler.js`
   - Depends on error-handler.js
   - Must wait for #1

6. **Update** `/opt/moltagent/src/lib/handlers/message-router.js`
   - Depends on error-handler.js
   - Must wait for #1

7. **Update** `/opt/moltagent/webhook-server.js`
   - Depends on error-handler.js
   - Must wait for #1

---

## Testing Considerations

Each error category should be testable:

```javascript
// Test cases needed:
describe('ErrorHandler', () => {
  it('should classify 401 errors as AUTHENTICATION');
  it('should classify 403 errors as AUTHORIZATION');
  it('should classify ECONNREFUSED as NETWORK');
  it('should classify "not configured" as CONFIGURATION');
  it('should classify OutputVerificationError as OUTPUT_BLOCKED');
  it('should never expose stack traces in user messages');
  it('should never expose file paths in user messages');
  it('should log full error details internally');
  it('should call auditLog with error details');
});
```

---

## Security Considerations

1. **Never include in user messages:**
   - Stack traces
   - File paths (`/opt/moltagent/...`)
   - Internal hostnames or IPs
   - Credential names or values
   - Configuration details
   - Database queries or table names

2. **Always sanitize before logging:**
   - Remove passwords/tokens from metadata
   - Truncate overly long error messages
   - Redact email addresses in production if privacy required

3. **Request ID strategy:**
   - Generate unique ID per request
   - Include in user message: "Something went wrong. Reference: REQ-abc123"
   - Allows users to report issues with traceable ID
   - Enables log correlation

---

## Migration Notes

- Existing code uses `console.error('[Module] Error:', error.message)` pattern
- New pattern: Use ErrorHandler for user-facing errors, keep console for internal
- Empty catches should become `logAndIgnore()` or explicit debug logging
- All `${error.message}` in user responses must be replaced with safe messages
