/**
 * ErrorHandler Unit Tests
 *
 * Comprehensive test suite for the ErrorHandler class and related utilities.
 *
 * Run: node test/unit/errors/error-handler.test.js
 */

const assert = require('assert');
const { test, asyncTest, summary, exitWithCode } = require('../../helpers/test-runner');
const { createMockAuditLog } = require('../../helpers/mock-factories');
const { assertContains, assertNotContains } = require('../../helpers/assertions');

// Import module under test
const {
  ErrorHandler,
  ErrorCategory,
  MoltAgentError,
  createErrorHandler,
  wrapAsync,
  logAndIgnore,
  logAndRethrow
} = require('../../../src/lib/errors/error-handler');

// ============================================================
// Test Suites
// ============================================================

console.log('\n=== ErrorHandler Tests ===\n');

// --- Constructor Tests ---
console.log('\n--- Constructor Tests ---\n');

test('TC-CTOR-001: Default initialization', () => {
  const handler = new ErrorHandler();
  assert.strictEqual(handler.serviceName, 'MoltAgent');
  assert.strictEqual(handler.includeRequestId, false);
  assert.strictEqual(handler.onError, null);
  assert.strictEqual(typeof handler.auditLog, 'function');
});

test('TC-CTOR-002: Custom auditLog', () => {
  const mockAuditLog = createMockAuditLog();
  const handler = new ErrorHandler({ auditLog: mockAuditLog });
  assert.strictEqual(handler.auditLog, mockAuditLog);
});

test('TC-CTOR-003: Custom serviceName', () => {
  const handler = new ErrorHandler({ serviceName: 'EmailHandler' });
  assert.strictEqual(handler.serviceName, 'EmailHandler');
});

test('TC-CTOR-004: includeRequestId enabled', () => {
  const handler = new ErrorHandler({ includeRequestId: true });
  assert.strictEqual(handler.includeRequestId, true);
});

test('TC-CTOR-005: Custom onError callback', () => {
  const callback = async () => {};
  const handler = new ErrorHandler({ onError: callback });
  assert.strictEqual(handler.onError, callback);
});

// --- Error Classification Tests ---
console.log('\n--- Error Classification Tests ---\n');

test('TC-CLASS-001: Classify HTTP 401 as AUTHENTICATION', () => {
  const handler = new ErrorHandler();
  const error = new Error('Unauthorized');
  error.status = 401;
  assert.strictEqual(handler.classify(error), ErrorCategory.AUTHENTICATION);
});

test('TC-CLASS-002: Classify HTTP 403 as AUTHORIZATION', () => {
  const handler = new ErrorHandler();
  const error = new Error('Forbidden');
  error.status = 403;
  assert.strictEqual(handler.classify(error), ErrorCategory.AUTHORIZATION);
});

test('TC-CLASS-003: Classify HTTP 404 as NOT_FOUND', () => {
  const handler = new ErrorHandler();
  const error = new Error('Not Found');
  error.status = 404;
  assert.strictEqual(handler.classify(error), ErrorCategory.NOT_FOUND);
});

test('TC-CLASS-004: Classify HTTP 429 as RATE_LIMITED', () => {
  const handler = new ErrorHandler();
  const error = new Error('Too Many Requests');
  error.status = 429;
  assert.strictEqual(handler.classify(error), ErrorCategory.RATE_LIMITED);
});

test('TC-CLASS-005: Classify HTTP 5xx as EXTERNAL_SERVICE', () => {
  const handler = new ErrorHandler();
  const error = new Error('Internal Server Error');
  error.status = 500;
  assert.strictEqual(handler.classify(error), ErrorCategory.EXTERNAL_SERVICE);
});

test('TC-CLASS-006: Classify ECONNREFUSED as NETWORK', () => {
  const handler = new ErrorHandler();
  const error = new Error('Connection refused');
  error.code = 'ECONNREFUSED';
  assert.strictEqual(handler.classify(error), ErrorCategory.NETWORK);
});

test('TC-CLASS-007: Classify ENOTFOUND as NETWORK', () => {
  const handler = new ErrorHandler();
  const error = new Error('Host not found');
  error.code = 'ENOTFOUND';
  assert.strictEqual(handler.classify(error), ErrorCategory.NETWORK);
});

test('TC-CLASS-008: Classify ETIMEDOUT as TIMEOUT', () => {
  const handler = new ErrorHandler();
  const error = new Error('Connection timed out');
  error.code = 'ETIMEDOUT';
  assert.strictEqual(handler.classify(error), ErrorCategory.TIMEOUT);
});

test('TC-CLASS-009: Classify MoltAgentError by category', () => {
  const handler = new ErrorHandler();
  const error = new MoltAgentError('Test error', { category: ErrorCategory.VALIDATION });
  assert.strictEqual(handler.classify(error), ErrorCategory.VALIDATION);
});

test('TC-CLASS-010: Classify OutputVerificationError as OUTPUT_BLOCKED', () => {
  const handler = new ErrorHandler();
  const error = new Error('Output blocked');
  error.name = 'OutputVerificationError';
  assert.strictEqual(handler.classify(error), ErrorCategory.OUTPUT_BLOCKED);
});

test('TC-CLASS-011: Classify authentication message as AUTHENTICATION', () => {
  const handler = new ErrorHandler();
  const error = new Error('Authentication failed');
  assert.strictEqual(handler.classify(error), ErrorCategory.AUTHENTICATION);
});

test('TC-CLASS-012: Classify permission message as AUTHORIZATION', () => {
  const handler = new ErrorHandler();
  const error = new Error('Permission denied');
  assert.strictEqual(handler.classify(error), ErrorCategory.AUTHORIZATION);
});

test('TC-CLASS-013: Classify not found message as NOT_FOUND', () => {
  const handler = new ErrorHandler();
  const error = new Error('Resource not found');
  assert.strictEqual(handler.classify(error), ErrorCategory.NOT_FOUND);
});

test('TC-CLASS-014: Classify not configured message as CONFIGURATION', () => {
  const handler = new ErrorHandler();
  const error = new Error('Feature not configured');
  assert.strictEqual(handler.classify(error), ErrorCategory.CONFIGURATION);
});

test('TC-CLASS-015: Classify rate limit message as RATE_LIMITED', () => {
  const handler = new ErrorHandler();
  const error = new Error('Rate limit exceeded');
  assert.strictEqual(handler.classify(error), ErrorCategory.RATE_LIMITED);
});

test('TC-CLASS-016: Classify network message as NETWORK', () => {
  const handler = new ErrorHandler();
  const error = new Error('Network error occurred');
  assert.strictEqual(handler.classify(error), ErrorCategory.NETWORK);
});

test('TC-CLASS-017: Classify timeout message as TIMEOUT', () => {
  const handler = new ErrorHandler();
  const error = new Error('Request timeout');
  assert.strictEqual(handler.classify(error), ErrorCategory.TIMEOUT);
});

test('TC-CLASS-018: Classify validation message as VALIDATION', () => {
  const handler = new ErrorHandler();
  const error = new Error('Invalid input provided');
  assert.strictEqual(handler.classify(error), ErrorCategory.VALIDATION);
});

test('TC-CLASS-019: Default to INTERNAL for unknown error', () => {
  const handler = new ErrorHandler();
  const error = new Error('Some random error');
  assert.strictEqual(handler.classify(error), ErrorCategory.INTERNAL);
});

test('TC-CLASS-020: Handle null error', () => {
  const handler = new ErrorHandler();
  assert.strictEqual(handler.classify(null), ErrorCategory.INTERNAL);
});

// --- User Message Tests ---
console.log('\n--- User Message Tests ---\n');

test('TC-MSG-001: Get AUTHENTICATION message', () => {
  const handler = new ErrorHandler();
  const message = handler.getUserMessage(ErrorCategory.AUTHENTICATION);
  assert.strictEqual(message, 'Authentication failed. Please check your credentials or try again.');
});

test('TC-MSG-002: Get AUTHORIZATION message', () => {
  const handler = new ErrorHandler();
  const message = handler.getUserMessage(ErrorCategory.AUTHORIZATION);
  assert.strictEqual(message, "You don't have permission to perform this action.");
});

test('TC-MSG-003: Get NETWORK message', () => {
  const handler = new ErrorHandler();
  const message = handler.getUserMessage(ErrorCategory.NETWORK);
  assert.strictEqual(message, 'Unable to reach the service. Please try again in a moment.');
});

test('TC-MSG-004: Get RATE_LIMITED message', () => {
  const handler = new ErrorHandler();
  const message = handler.getUserMessage(ErrorCategory.RATE_LIMITED);
  assert.strictEqual(message, 'Too many requests. Please wait a moment and try again.');
});

test('TC-MSG-005: Get INTERNAL message', () => {
  const handler = new ErrorHandler();
  const message = handler.getUserMessage(ErrorCategory.INTERNAL);
  assert.strictEqual(message, 'Something unexpected went wrong on my end. Please try again in a moment.');
});

test('TC-MSG-006: Include request ID when enabled', () => {
  const handler = new ErrorHandler({ includeRequestId: true });
  const message = handler.getUserMessage(ErrorCategory.INTERNAL, { requestId: 'req-123' });
  assertContains(message, '(Reference: req-123)');
});

test('TC-MSG-007: No request ID when disabled', () => {
  const handler = new ErrorHandler({ includeRequestId: false });
  const message = handler.getUserMessage(ErrorCategory.INTERNAL, { requestId: 'req-123' });
  assertNotContains(message, 'req-123');
});

test('TC-MSG-008: Get OUTPUT_BLOCKED message', () => {
  const handler = new ErrorHandler();
  const message = handler.getUserMessage(ErrorCategory.OUTPUT_BLOCKED);
  assert.strictEqual(message, 'The response was blocked for safety reasons.');
});

// --- Handle Method Tests ---
console.log('\n--- Handle Method Tests ---\n');

asyncTest('TC-HANDLE-001: Handle error and return safe message', async () => {
  const handler = new ErrorHandler();
  const error = new Error('Database query failed at postgres:5432');
  const result = await handler.handle(error, { operation: 'db_query' });

  assert.strictEqual(result.message, 'Something unexpected went wrong on my end. Please try again in a moment.');
  assert.ok(!result.message.includes('postgres'));
  assert.strictEqual(result.category, ErrorCategory.INTERNAL);
  assert.strictEqual(result.logged, true);
});

asyncTest('TC-HANDLE-002: Classify error correctly', async () => {
  const handler = new ErrorHandler();
  const error = new Error('Authentication failed');
  const result = await handler.handle(error, { operation: 'login' });

  assert.strictEqual(result.category, ErrorCategory.AUTHENTICATION);
  assertContains(result.message, 'Authentication failed');
});

asyncTest('TC-HANDLE-003: Call audit log', async () => {
  const mockAuditLog = createMockAuditLog();
  const handler = new ErrorHandler({ auditLog: mockAuditLog });
  const error = new Error('Test error');

  await handler.handle(error, { operation: 'test_op' });

  const calls = mockAuditLog.getCallsFor('error_logged');
  assert.strictEqual(calls.length, 1);
  assert.strictEqual(calls[0].data.operation, 'test_op');
});

asyncTest('TC-HANDLE-004: Call onError callback', async () => {
  let callbackCalled = false;
  let callbackError = null;
  let callbackCategory = null;

  const onError = async (error, category, context) => {
    callbackCalled = true;
    callbackError = error;
    callbackCategory = category;
  };

  const handler = new ErrorHandler({ onError });
  const error = new Error('Test error');

  await handler.handle(error, { operation: 'test_op' });

  assert.strictEqual(callbackCalled, true);
  assert.strictEqual(callbackError, error);
  assert.strictEqual(callbackCategory, ErrorCategory.INTERNAL);
});

asyncTest('TC-HANDLE-005: Continue if onError callback fails', async () => {
  const onError = async () => {
    throw new Error('Callback error');
  };

  const handler = new ErrorHandler({ onError });
  const error = new Error('Test error');

  const result = await handler.handle(error, { operation: 'test_op' });
  assert.strictEqual(result.logged, true);
});

// --- Internal Logging Tests ---
console.log('\n--- Internal Logging Tests ---\n');

asyncTest('TC-LOG-001: Build complete log entry', async () => {
  const mockAuditLog = createMockAuditLog();
  const handler = new ErrorHandler({ auditLog: mockAuditLog, serviceName: 'TestService' });
  const error = new Error('Test error');
  error.code = 'ETEST';

  await handler.logInternal(error, ErrorCategory.INTERNAL, {
    operation: 'test_op',
    requestId: 'req-123',
    user: 'testuser',
    metadata: { key: 'value' }
  });

  const calls = mockAuditLog.getCallsFor('error_logged');
  assert.strictEqual(calls.length, 1);

  const logEntry = calls[0].data;
  assert.strictEqual(logEntry.service, 'TestService');
  assert.strictEqual(logEntry.operation, 'test_op');
  assert.strictEqual(logEntry.category, ErrorCategory.INTERNAL);
  assert.strictEqual(logEntry.requestId, 'req-123');
  assert.strictEqual(logEntry.user, 'testuser');
  assert.strictEqual(logEntry.error.name, 'Error');
  assert.strictEqual(logEntry.error.message, 'Test error');
  assert.strictEqual(logEntry.error.code, 'ETEST');
  assert.strictEqual(logEntry.metadata.key, 'value');
});

asyncTest('TC-LOG-002: Handle audit log failure gracefully', async () => {
  const failingAuditLog = async () => {
    throw new Error('Audit log failed');
  };

  const handler = new ErrorHandler({ auditLog: failingAuditLog });
  const error = new Error('Test error');

  // Should not throw
  await handler.logInternal(error, ErrorCategory.INTERNAL, { operation: 'test_op' });
});

// --- MoltAgentError Class Tests ---
console.log('\n--- MoltAgentError Class Tests ---\n');

test('TC-MAERRR-001: Create MoltAgentError with category', () => {
  const error = new MoltAgentError('Internal error', { category: ErrorCategory.VALIDATION });

  assert.strictEqual(error.name, 'MoltAgentError');
  assert.strictEqual(error.message, 'Internal error');
  assert.strictEqual(error.category, ErrorCategory.VALIDATION);
  assert.strictEqual(error.userMessage, null);
  assert.strictEqual(error.cause, null);
  assert.deepStrictEqual(error.metadata, {});
  assert.ok(error.timestamp);
});

test('TC-MAERRR-002: MoltAgentError with userMessage override', () => {
  const error = new MoltAgentError('Internal details', {
    category: ErrorCategory.INTERNAL,
    userMessage: 'Custom user message'
  });

  assert.strictEqual(error.userMessage, 'Custom user message');
});

test('TC-MAERRR-003: MoltAgentError with cause', () => {
  const originalError = new Error('Original error');
  const error = new MoltAgentError('Wrapped error', {
    category: ErrorCategory.NETWORK,
    cause: originalError
  });

  assert.strictEqual(error.cause, originalError);
});

test('TC-MAERRR-004: MoltAgentError with metadata', () => {
  const error = new MoltAgentError('Error', {
    category: ErrorCategory.TIMEOUT,
    metadata: { timeout: 5000, endpoint: '/api/test' }
  });

  assert.deepStrictEqual(error.metadata, { timeout: 5000, endpoint: '/api/test' });
});

test('TC-MAERRR-005: MoltAgentError defaults to INTERNAL category', () => {
  const error = new MoltAgentError('Error');
  assert.strictEqual(error.category, ErrorCategory.INTERNAL);
});

// --- createErrorHandler Factory Tests ---
console.log('\n--- createErrorHandler Factory Tests ---\n');

test('TC-FACTORY-001: Create ErrorHandler instance', () => {
  const handler = createErrorHandler();
  assert.ok(handler instanceof ErrorHandler);
});

test('TC-FACTORY-002: Create with config', () => {
  const handler = createErrorHandler({ serviceName: 'TestService' });
  assert.strictEqual(handler.serviceName, 'TestService');
});

// --- wrapAsync Tests ---
console.log('\n--- wrapAsync Tests ---\n');

asyncTest('TC-WRAP-001: Execute wrapped function successfully', async () => {
  const handler = new ErrorHandler();
  const fn = async (x) => x * 2;
  const wrapped = wrapAsync(fn, handler, { operation: 'test' });

  const result = await wrapped(5);
  assert.strictEqual(result, 10);
});

asyncTest('TC-WRAP-002: Catch and handle errors', async () => {
  const handler = new ErrorHandler();
  const fn = async () => {
    throw new Error('Function failed');
  };
  const wrapped = wrapAsync(fn, handler, { operation: 'test' });

  try {
    await wrapped();
    assert.fail('Should have thrown');
  } catch (error) {
    assert.strictEqual(error.message, 'Something unexpected went wrong on my end. Please try again in a moment.');
  }
});

asyncTest('TC-WRAP-003: Rethrow with safe message', async () => {
  const handler = new ErrorHandler();
  const fn = async () => {
    const error = new Error('Database password is: secret123');
    throw error;
  };
  const wrapped = wrapAsync(fn, handler, { operation: 'test' });

  try {
    await wrapped();
    assert.fail('Should have thrown');
  } catch (error) {
    assertNotContains(error.message, 'secret123');
    assertNotContains(error.message, 'Database password');
  }
});

// --- logAndIgnore Tests ---
console.log('\n--- logAndIgnore Tests ---\n');

asyncTest('TC-IGNORE-001: Log error and continue', async () => {
  const mockAuditLog = createMockAuditLog();
  const handler = new ErrorHandler({ auditLog: mockAuditLog });
  const error = new Error('Non-critical error');

  const catchHandler = logAndIgnore(handler, 'background_task');
  await catchHandler(error);

  const calls = mockAuditLog.getCallsFor('error_logged');
  assert.strictEqual(calls.length, 1);
  assert.strictEqual(calls[0].data.operation, 'background_task');
});

asyncTest('TC-IGNORE-002: Do not rethrow error', async () => {
  const handler = new ErrorHandler();
  const error = new Error('Non-critical error');

  const catchHandler = logAndIgnore(handler, 'background_task');
  const result = await catchHandler(error);

  assert.strictEqual(result, undefined);
});

// --- logAndRethrow Tests ---
console.log('\n--- logAndRethrow Tests ---\n');

asyncTest('TC-RETHROW-001: Log error and rethrow', async () => {
  const mockAuditLog = createMockAuditLog();
  const handler = new ErrorHandler({ auditLog: mockAuditLog });
  const error = new Error('Critical error');

  const catchHandler = logAndRethrow(handler, 'critical_op');

  try {
    await catchHandler(error);
    assert.fail('Should have rethrown');
  } catch (thrownError) {
    assert.strictEqual(thrownError, error);
  }

  const calls = mockAuditLog.getCallsFor('error_logged');
  assert.strictEqual(calls.length, 1);
});

asyncTest('TC-RETHROW-002: Rethrow original error', async () => {
  const handler = new ErrorHandler();
  const error = new Error('Original error message');

  const catchHandler = logAndRethrow(handler, 'critical_op');

  try {
    await catchHandler(error);
    assert.fail('Should have rethrown');
  } catch (thrownError) {
    assert.strictEqual(thrownError.message, 'Original error message');
  }
});

// Summary
setTimeout(() => {
  summary();
  exitWithCode();
}, 100);
