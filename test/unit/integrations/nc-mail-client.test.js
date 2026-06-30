'use strict';

/**
 * NCMailClient Unit Tests
 *
 * Run: node test/unit/integrations/nc-mail-client.test.js
 *
 * @module test/unit/integrations/nc-mail-client
 */

const assert = require('assert');
const { test, asyncTest, summary, exitWithCode } = require('../../helpers/test-runner');
const NCMailClient = require('../../../src/lib/integrations/nc-mail-client');

// ---------------------------------------------------------------------------
// Mock factory helpers
// ---------------------------------------------------------------------------

/** Build a canned NCRequestManager mock. `routes` maps path prefixes to return values. */
function createMockNC(routes = {}, ncUrl = 'https://nc.example.com') {
  return {
    ncUrl,
    request: async (path, _opts) => {
      for (const [prefix, value] of Object.entries(routes)) {
        if (path.startsWith(prefix)) {
          if (value instanceof Error) throw value;
          return value;
        }
      }
      // No match → 404
      return { status: 404, body: null };
    }
  };
}

/** Minimal canned API fixtures */
const ACCOUNTS = [{ id: 7, email: 'bot@example.com' }];
const MAILBOXES_RESP = {
  id: 7,
  email: 'bot@example.com',
  mailboxes: [
    { databaseId: 42, name: 'INBOX', delimiter: '.' },
    { databaseId: 99, name: 'INBOX.INQUIRIES', delimiter: '.' }
  ],
  delimiter: '.'
};
const MESSAGES_RESP = [
  { databaseId: 555, uid: 10, messageId: '<msg1@host>', threadRootId: 555, mailboxId: 99, subject: 'Hello' },
  { databaseId: 556, uid: 11, messageId: '<msg2@host>', threadRootId: 556, mailboxId: 99, subject: 'World' }
];

function makeRoutes() {
  return {
    '/index.php/apps/mail/api/accounts': { status: 200, body: JSON.stringify(ACCOUNTS) },
    '/index.php/apps/mail/api/mailboxes': { status: 200, body: JSON.stringify(MAILBOXES_RESP) },
    '/index.php/apps/mail/api/messages': { status: 200, body: JSON.stringify(MESSAGES_RESP) }
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

(async () => {
  console.log('\n=== NCMailClient Unit Tests ===\n');

  // TC-MAIL-01: resolveThreadUrl — full happy path resolves correct deep-link URL.
  await asyncTest('TC-MAIL-01: resolveThreadUrl resolves correct deep-link URL', async () => {
    const nc = createMockNC(makeRoutes(), 'https://nc.example.com');
    const client = new NCMailClient(nc);

    const url = await client.resolveThreadUrl('INBOX.INQUIRIES', '<msg1@host>');

    assert.strictEqual(
      url,
      'https://nc.example.com/apps/mail/box/99/thread/555',
      'should return the deep-link URL with correct mailboxId and databaseId'
    );
  });

  // TC-MAIL-02: resolveThreadUrl — message found when caller omits angle brackets.
  await asyncTest('TC-MAIL-02: resolveThreadUrl matches Message-ID without angle brackets', async () => {
    const nc = createMockNC(makeRoutes(), 'https://nc.example.com');
    const client = new NCMailClient(nc);

    const url = await client.resolveThreadUrl('INBOX.INQUIRIES', 'msg2@host');

    assert.strictEqual(
      url,
      'https://nc.example.com/apps/mail/box/99/thread/556',
      'should strip angle brackets from stored messageId for comparison'
    );
  });

  // TC-MAIL-03: resolveThreadUrl — returns null when folder not found in any account.
  await asyncTest('TC-MAIL-03: resolveThreadUrl returns null when folder not found', async () => {
    const nc = createMockNC(makeRoutes());
    const client = new NCMailClient(nc);

    const url = await client.resolveThreadUrl('INBOX.NONEXISTENT', '<msg1@host>');

    assert.strictEqual(url, null, 'should return null when folder has no matching mailbox');
  });

  // TC-MAIL-04: resolveThreadUrl — returns null when message not in mailbox.
  await asyncTest('TC-MAIL-04: resolveThreadUrl returns null when message not found', async () => {
    const nc = createMockNC(makeRoutes());
    const client = new NCMailClient(nc);

    const url = await client.resolveThreadUrl('INBOX.INQUIRIES', '<unknown@host>');

    assert.strictEqual(url, null, 'should return null when messageId has no match in messages list');
  });

  // TC-MAIL-05: resolveThreadUrl — returns null when accounts request errors (throws).
  await asyncTest('TC-MAIL-05: resolveThreadUrl returns null when accounts request throws', async () => {
    const routes = {
      '/index.php/apps/mail/api/accounts': new Error('network failure')
    };
    const nc = createMockNC(routes);
    const client = new NCMailClient(nc);

    let url;
    let threw = false;
    try {
      url = await client.resolveThreadUrl('INBOX.INQUIRIES', '<msg1@host>');
    } catch (_) {
      threw = true;
    }

    assert.strictEqual(threw, false, 'should never throw');
    assert.strictEqual(url, null, 'should return null on network error');
  });

  // TC-MAIL-06: resolveThreadUrl — returns null when folder/messageId are falsy.
  await asyncTest('TC-MAIL-06: resolveThreadUrl returns null for falsy inputs', async () => {
    const nc = createMockNC(makeRoutes());
    const client = new NCMailClient(nc);

    assert.strictEqual(await client.resolveThreadUrl(null, '<msg1@host>'), null);
    assert.strictEqual(await client.resolveThreadUrl('INBOX.INQUIRIES', null), null);
    assert.strictEqual(await client.resolveThreadUrl('', ''), null);
  });

  // TC-MAIL-07: resolveThreadUrl — returns null when accounts returns non-2xx.
  await asyncTest('TC-MAIL-07: resolveThreadUrl returns null on non-2xx accounts response', async () => {
    const nc = createMockNC({
      '/index.php/apps/mail/api/accounts': { status: 503, body: null }
    });
    const client = new NCMailClient(nc);

    const url = await client.resolveThreadUrl('INBOX.INQUIRIES', '<msg1@host>');
    assert.strictEqual(url, null, 'should return null on 503 from accounts');
  });

  // TC-MAIL-08: resolveMailbox — returns {accountId, mailboxId} on match.
  await asyncTest('TC-MAIL-08: resolveMailbox returns correct accountId and mailboxId', async () => {
    const nc = createMockNC(makeRoutes());
    const client = new NCMailClient(nc);

    const result = await client.resolveMailbox('INBOX.INQUIRIES');

    assert.ok(result, 'should return a result');
    assert.strictEqual(result.accountId, 7);
    assert.strictEqual(result.mailboxId, 99);
  });

  // TC-MAIL-09: resolveMailbox — returns null when no account has the folder.
  await asyncTest('TC-MAIL-09: resolveMailbox returns null when folder absent from all accounts', async () => {
    const nc = createMockNC(makeRoutes());
    const client = new NCMailClient(nc);

    const result = await client.resolveMailbox('INBOX.MISSING');
    assert.strictEqual(result, null);
  });

  // TC-MAIL-10: resolveMessageDatabaseId — matches with angle-bracket normalization.
  await asyncTest('TC-MAIL-10: resolveMessageDatabaseId matches angle-bracket variants', async () => {
    const nc = createMockNC(makeRoutes());
    const client = new NCMailClient(nc);

    // Both with and without brackets should resolve to databaseId 555
    const withBrackets = await client.resolveMessageDatabaseId(99, '<msg1@host>');
    const withoutBrackets = await client.resolveMessageDatabaseId(99, 'msg1@host');

    assert.strictEqual(withBrackets, 555, 'with angle brackets');
    assert.strictEqual(withoutBrackets, 555, 'without angle brackets');
  });

  // TC-MAIL-11: _getJson — returns null (not throw) when body is malformed JSON.
  await asyncTest('TC-MAIL-11: _getJson returns null on malformed JSON body', async () => {
    const nc = {
      ncUrl: 'https://nc.example.com',
      request: async () => ({ status: 200, body: 'NOT JSON {{{' })
    };
    const client = new NCMailClient(nc);

    let result;
    let threw = false;
    try {
      result = await client._getJson('/index.php/apps/mail/api/accounts');
    } catch (_) {
      threw = true;
    }

    assert.strictEqual(threw, false, '_getJson must not throw');
    assert.strictEqual(result, null, '_getJson should return null on parse error');
  });

  // TC-MAIL-12: resolveThreadUrl issues a sync POST for the resolved mailbox
  // before looking up the message (closes the heartbeat-vs-background-sync race).
  await asyncTest('TC-MAIL-12: resolveThreadUrl syncs the mailbox before lookup', async () => {
    const calls = [];
    const nc = {
      ncUrl: 'https://nc.example.com',
      request: async (path, opts) => {
        calls.push({ path, method: (opts && opts.method) || 'GET' });
        if (path.startsWith('/index.php/apps/mail/api/accounts')) return { status: 200, body: JSON.stringify(ACCOUNTS) };
        if (path.includes('/sync')) return { status: 200, body: JSON.stringify({ newMessages: [] }) };
        if (path.startsWith('/index.php/apps/mail/api/mailboxes')) return { status: 200, body: JSON.stringify(MAILBOXES_RESP) };
        if (path.startsWith('/index.php/apps/mail/api/messages')) return { status: 200, body: JSON.stringify(MESSAGES_RESP) };
        return { status: 404, body: null };
      }
    };
    const client = new NCMailClient(nc);

    const url = await client.resolveThreadUrl('INBOX.INQUIRIES', '<msg1@host>');
    assert.strictEqual(url, 'https://nc.example.com/apps/mail/box/99/thread/555');

    const syncCall = calls.find(c => c.path.includes('/index.php/apps/mail/api/mailboxes/99/sync'));
    assert.ok(syncCall, 'a sync POST should be issued for the resolved mailbox (id 99)');
    assert.strictEqual(syncCall.method, 'POST', 'sync must be a POST');
    // The sync must precede the messages lookup.
    const syncIdx = calls.findIndex(c => c.path.includes('/sync'));
    const msgIdx = calls.findIndex(c => c.path.startsWith('/index.php/apps/mail/api/messages'));
    assert.ok(syncIdx >= 0 && msgIdx >= 0 && syncIdx < msgIdx, 'sync must precede the messages lookup');
  });

  // TC-MAIL-13: a failed sync does NOT block resolution (best-effort).
  await asyncTest('TC-MAIL-13: resolveThreadUrl still resolves when the sync POST fails', async () => {
    const nc = {
      ncUrl: 'https://nc.example.com',
      request: async (path) => {
        if (path.includes('/sync')) throw new Error('sync boom');
        if (path.startsWith('/index.php/apps/mail/api/accounts')) return { status: 200, body: JSON.stringify(ACCOUNTS) };
        if (path.startsWith('/index.php/apps/mail/api/mailboxes')) return { status: 200, body: JSON.stringify(MAILBOXES_RESP) };
        if (path.startsWith('/index.php/apps/mail/api/messages')) return { status: 200, body: JSON.stringify(MESSAGES_RESP) };
        return { status: 404, body: null };
      }
    };
    const client = new NCMailClient(nc);

    const url = await client.resolveThreadUrl('INBOX.INQUIRIES', '<msg1@host>');
    assert.strictEqual(url, 'https://nc.example.com/apps/mail/box/99/thread/555', 'resolution proceeds despite sync failure');
  });

  setTimeout(() => { summary(); exitWithCode(); }, 500);
})();
