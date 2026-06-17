/**
 * EmailHandler._fetchEmails async-ordering regression test
 *
 * Reproduces the resolve-before-async-parse race: imap.search finds a message,
 * but simpleParser is async, so the fetch stream's 'end' event can fire and
 * resolve the promise before any per-message parse completes. The pre-fix code
 * resolved with an empty list even though the message existed.
 *
 * This test does NOT mock _fetchEmails — it mocks the `imap` and `mailparser`
 * modules underneath it and drives the real event sequence, with the parse
 * resolving on a later tick (setImmediate). It MUST fail against the pre-fix
 * code (result length 0) and pass only with the Promise.all(parsePromises)
 * guard in place.
 *
 * Run: node test/unit/handlers/email-fetch-race.test.js
 */

'use strict';

// config.js requires NC_URL; supply a harmless test default (mirrors run-all-tests).
process.env.NC_URL = process.env.NC_URL || 'https://test.example.com';
process.env.NC_USER = process.env.NC_USER || 'tester';

const assert = require('assert');
const { EventEmitter } = require('events');
const util = require('util');
const { asyncTest, summary, exitWithCode } = require('../../helpers/test-runner');

// --- Fake `imap` module: drives the racey event order -----------------------
// connect -> ready -> openBox -> search([1]) -> fetch:
//   emit 'message' (handlers attach), then body/data/attributes/end on the msg,
//   then fetch 'end' SYNCHRONOUSLY after msg 'end'. The msg 'end' handler awaits
//   the async parser, so on pre-fix code fetch 'end' wins and resolves empty.
const RAW = [
  'Message-ID: <race-test@moltagent.test>',
  'From: Sender <sender@example.com>',
  'To: <tester@example.com>',
  'Subject: Race Test',
  '',
  'body text'
].join('\r\n');

function FakeImap() { EventEmitter.call(this); }
util.inherits(FakeImap, EventEmitter);
FakeImap.prototype.connect = function () { process.nextTick(() => this.emit('ready')); };
FakeImap.prototype.end = function () { /* no-op */ };
FakeImap.prototype.openBox = function (folder, readonly, cb) { cb(null, { messages: { total: 1 } }); };
FakeImap.prototype.search = function (criteria, cb) { cb(null, [1]); };
FakeImap.prototype.fetch = function () {
  const fetchEmitter = new EventEmitter();
  process.nextTick(() => {
    const msg = new EventEmitter();
    fetchEmitter.emit('message', msg, 1); // attaches body/attributes/end listeners
    const stream = new EventEmitter();
    msg.emit('body', stream);             // attaches stream 'data' listener
    stream.emit('data', Buffer.from(RAW));
    msg.emit('attributes', { uid: 1, flags: [] });
    msg.emit('end');                      // starts the async simpleParser await
    fetchEmitter.emit('end');             // races ahead of the parse
  });
  return fetchEmitter;
};

// --- Fake `mailparser`: parse resolves ASYNCHRONOUSLY (later macrotask) ------
async function fakeSimpleParser() {
  await new Promise((r) => setImmediate(r)); // defer — this is what hid the bug
  return {
    messageId: '<race-test@moltagent.test>',
    from: { text: 'Sender <sender@example.com>', value: [{ address: 'sender@example.com' }] },
    to: { text: '<tester@example.com>' },
    subject: 'Race Test',
    date: new Date('2026-06-17T10:00:00Z'),
    text: 'body text',
    attachments: []
  };
}

// Inject the fakes into require.cache BEFORE requiring EmailHandler.
const imapPath = require.resolve('imap');
require.cache[imapPath] = { id: imapPath, filename: imapPath, loaded: true, exports: FakeImap };
const mpPath = require.resolve('mailparser');
require.cache[mpPath] = { id: mpPath, filename: mpPath, loaded: true, exports: { simpleParser: fakeSimpleParser } };

const EmailHandler = require('../../../src/lib/handlers/email-handler');

console.log('\n=== EmailHandler _fetchEmails async-ordering race ===\n');

function makeHandler() {
  const broker = { get: async () => ({ host: 'imap.test', port: 993, username: 'tester', password: 'pw', tls: true }) };
  return new EmailHandler(broker, null, () => {});
}

asyncTest('TC-RACE-01: _fetchEmails awaits async parse before resolving (unreadOnly)', async () => {
  const handler = makeHandler();
  const emails = await handler._fetchEmails({ folder: 'INBOX.INQUIRIES', unreadOnly: true, limit: 50 });
  assert.strictEqual(emails.length, 1, 'expected the searched message to survive the async parse (pre-fix returns 0)');
  assert.strictEqual(emails[0].messageId, '<race-test@moltagent.test>');
  assert.strictEqual(emails[0].subject, 'Race Test');
  assert.strictEqual(emails[0].isRead, false);
});

asyncTest('TC-RACE-02: _fetchEmails returns the parsed message for ALL search too', async () => {
  const handler = makeHandler();
  const emails = await handler._fetchEmails({ folder: 'INBOX', unreadOnly: false, limit: 50 });
  assert.strictEqual(emails.length, 1);
  assert.strictEqual(emails[0].messageId, '<race-test@moltagent.test>');
});

setTimeout(() => { summary(); exitWithCode(); }, 500);
