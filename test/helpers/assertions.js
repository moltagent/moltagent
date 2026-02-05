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
