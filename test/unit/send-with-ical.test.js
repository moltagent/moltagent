/**
 * AGPL-3.0 License - MoltAgent
 *
 * sendWithIcal Unit Tests
 *
 * Tests the sendWithIcal method on EmailHandler for structural correctness
 * and input validation without requiring live SMTP credentials.
 *
 * Run: node test/unit/send-with-ical.test.js
 *
 * @module test/unit/send-with-ical
 */

'use strict';

const assert = require('assert');
const { test, asyncTest, summary, exitWithCode } = require('../helpers/test-runner');

// We can't easily unit test sendWithIcal in isolation since it's a method on EmailHandler
// Instead, verify the method exists and has correct structure
const EmailHandler = require('../../src/lib/handlers/email-handler');

// ============================================================
// Tests
// ============================================================

console.log('\n=== sendWithIcal Tests ===\n');

test('EmailHandler class has sendWithIcal method on its prototype', () => {
  assert.strictEqual(typeof EmailHandler.prototype.sendWithIcal, 'function',
    'sendWithIcal must be a function on EmailHandler.prototype');
});

test('sendWithIcal is async — returns a Promise when called', () => {
  // Build a minimal stub instance that satisfies the constructor without live deps.
  // We deliberately supply a credentials stub that will reject so the method
  // exercises input validation before any real I/O.
  const stubCredentials = { get: async () => null };
  const stubLLM = { route: async () => ({ result: '' }) };

  const handler = new EmailHandler(stubCredentials, stubLLM);

  // Call with a valid-looking opts object so it passes the early guard and
  // hits the credentials.get() path — the result is still a Promise.
  const returnValue = handler.sendWithIcal({
    to: 'test@example.com',
    subject: 'Meeting Invite',
    body: 'Please join.',
    icalData: 'BEGIN:VCALENDAR\r\nEND:VCALENDAR'
  });

  assert.ok(returnValue instanceof Promise, 'sendWithIcal must return a Promise');

  // Swallow the expected rejection so the process does not emit an unhandled
  // rejection warning during the test run.
  returnValue.catch(() => {});
});

asyncTest('throws on missing opts — no argument', async () => {
  const handler = new EmailHandler(
    { get: async () => null },
    { route: async () => ({ result: '' }) }
  );

  let caught = null;
  try {
    await handler.sendWithIcal();
  } catch (err) {
    caught = err;
  }

  assert.ok(caught, 'must throw when opts is omitted');
  assert.ok(caught.message.toLowerCase().includes('opts'), `error message should mention "opts", got: ${caught.message}`);
});

asyncTest('throws on missing "to" field', async () => {
  const handler = new EmailHandler(
    { get: async () => null },
    { route: async () => ({ result: '' }) }
  );

  let caught = null;
  try {
    await handler.sendWithIcal({ subject: 'No recipient' });
  } catch (err) {
    caught = err;
  }

  assert.ok(caught, 'must throw when "to" is missing');
  assert.ok(
    caught.message.toLowerCase().includes('to') || caught.message.toLowerCase().includes('subject'),
    `error should mention missing required field, got: ${caught.message}`
  );
});

asyncTest('throws on missing "subject" field', async () => {
  const handler = new EmailHandler(
    { get: async () => null },
    { route: async () => ({ result: '' }) }
  );

  let caught = null;
  try {
    await handler.sendWithIcal({ to: 'someone@example.com' });
  } catch (err) {
    caught = err;
  }

  assert.ok(caught, 'must throw when "subject" is missing');
  assert.ok(
    caught.message.toLowerCase().includes('to') || caught.message.toLowerCase().includes('subject'),
    `error should mention missing required field, got: ${caught.message}`
  );
});

asyncTest('throws on non-object opts (string passed)', async () => {
  const handler = new EmailHandler(
    { get: async () => null },
    { route: async () => ({ result: '' }) }
  );

  let caught = null;
  try {
    await handler.sendWithIcal('bad input');
  } catch (err) {
    caught = err;
  }

  assert.ok(caught, 'must throw when opts is not an object');
  assert.ok(caught.message.toLowerCase().includes('opts'), `error message should mention "opts", got: ${caught.message}`);
});

setTimeout(() => { summary(); exitWithCode(); }, 500);
