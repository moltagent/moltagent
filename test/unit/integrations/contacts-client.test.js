// Mock type: LEGACY — TODO: migrate to realistic mocks
/**
 * ContactsClient Unit Tests
 *
 * Run: node test/unit/integrations/contacts-client.test.js
 *
 * @module test/unit/integrations/contacts-client
 */

const assert = require('assert');
const { test, asyncTest, summary, exitWithCode } = require('../../helpers/test-runner');
const { createMockNCRequestManager, createMockCollectivesClient } = require('../../helpers/mock-factories');

// Import module under test
const ContactsClient = require('../../../src/lib/integrations/contacts-client');
const { ContactsClientError } = ContactsClient;

// ============================================================
// Test Fixtures
// ============================================================

const SAMPLE_VCARD_JOAO = [
  'BEGIN:VCARD',
  'VERSION:3.0',
  'FN:Joao Silva',
  'N:Silva;Joao;;;',
  'EMAIL;TYPE=WORK:joao.silva@company.pt',
  'EMAIL;TYPE=HOME:joao@personal.pt',
  'ORG:Company Name',
  'TEL;TYPE=WORK:+351 912 345 678',
  'TITLE:Engineering Manager',
  'UID:1234-5678-abcd',
  'END:VCARD'
].join('\r\n');

const SAMPLE_VCARD_MINIMAL = [
  'BEGIN:VCARD',
  'VERSION:3.0',
  'FN:Alice',
  'END:VCARD'
].join('\r\n');

const SAMPLE_VCARD_FOLDED = [
  'BEGIN:VCARD',
  'VERSION:3.0',
  'FN:Bob With Very Long',
  ' Name That Is Folded',
  'EMAIL;TYPE=WORK:bob@example.com',
  'END:VCARD'
].join('\r\n');

const SAMPLE_VCARD_WITH_PARAMS = [
  'BEGIN:VCARD',
  'VERSION:3.0',
  'FN;CHARSET=UTF-8:Alex Pereira',
  'N;CHARSET=UTF-8:Pereira;Alex;;;',
  'ORG;CHARSET=UTF-8:Org Corp',
  'TITLE;CHARSET=UTF-8:Director',
  'UID;VALUE=TEXT:uid-carlos-123',
  'EMAIL;TYPE=WORK:carlos@org.pt',
  'END:VCARD'
].join('\r\n');

const SAMPLE_MULTISTATUS_ONE = [
  '<?xml version="1.0" encoding="UTF-8"?>',
  '<d:multistatus xmlns:d="DAV:" xmlns:card="urn:ietf:params:xml:ns:carddav">',
  '  <d:response>',
  '    <d:href>/remote.php/dav/addressbooks/users/moltagent/contacts/1234.vcf</d:href>',
  '    <d:propstat>',
  '      <d:prop>',
  '        <d:getetag>"etag-1234"</d:getetag>',
  '        <card:address-data>BEGIN:VCARD\nVERSION:3.0\nFN:Joao Silva\nEMAIL;TYPE=WORK:joao.silva@company.pt\nEND:VCARD</card:address-data>',
  '      </d:prop>',
  '      <d:status>HTTP/1.1 200 OK</d:status>',
  '    </d:propstat>',
  '  </d:response>',
  '</d:multistatus>'
].join('\n');

const SAMPLE_MULTISTATUS_EMPTY = [
  '<?xml version="1.0" encoding="UTF-8"?>',
  '<d:multistatus xmlns:d="DAV:" xmlns:card="urn:ietf:params:xml:ns:carddav">',
  '</d:multistatus>'
].join('\n');

const SAMPLE_MULTISTATUS_TWO = [
  '<?xml version="1.0" encoding="UTF-8"?>',
  '<d:multistatus xmlns:d="DAV:" xmlns:card="urn:ietf:params:xml:ns:carddav">',
  '  <d:response>',
  '    <d:href>/remote.php/dav/addressbooks/users/moltagent/contacts/1234.vcf</d:href>',
  '    <d:propstat>',
  '      <d:prop>',
  '        <d:getetag>"etag-1234"</d:getetag>',
  '        <card:address-data>BEGIN:VCARD\nVERSION:3.0\nFN:Joao Silva\nEMAIL;TYPE=WORK:joao@company.pt\nEND:VCARD</card:address-data>',
  '      </d:prop>',
  '    </d:propstat>',
  '  </d:response>',
  '  <d:response>',
  '    <d:href>/remote.php/dav/addressbooks/users/moltagent/contacts/5678.vcf</d:href>',
  '    <d:propstat>',
  '      <d:prop>',
  '        <d:getetag>"etag-5678"</d:getetag>',
  '        <card:address-data>BEGIN:VCARD\nVERSION:3.0\nFN:Maria Costa\nEMAIL;TYPE=WORK:maria@company.pt\nEND:VCARD</card:address-data>',
  '      </d:prop>',
  '    </d:propstat>',
  '  </d:response>',
  '</d:multistatus>'
].join('\n');

// ============================================================
// Mock NC Request Manager for CardDAV
// ============================================================

function createCardDAVMockNC(overrides = {}) {
  const defaultResponses = {
    'REPORT:/remote.php/dav/addressbooks/users/testuser/contacts/': {
      status: 207,
      body: SAMPLE_MULTISTATUS_ONE,
      headers: {}
    }
  };

  const responses = { ...defaultResponses, ...overrides };

  return createMockNCRequestManager(responses);
}

// ============================================================
// Tests
// ============================================================

console.log('ContactsClient Unit Tests');
console.log('=========================\n');

// --- Constructor tests ---

test('constructor requires NCRequestManager', () => {
  assert.throws(() => new ContactsClient(null), /requires an NCRequestManager/);
  assert.throws(() => new ContactsClient({}), /requires an NCRequestManager/);
});

test('constructor accepts config', () => {
  const nc = createMockNCRequestManager();
  const client = new ContactsClient(nc, {
    username: 'alice',
    addressBook: 'personal',
    cacheTTLMs: 60000
  });

  assert.strictEqual(client.username, 'alice');
  assert.strictEqual(client.addressBook, 'personal');
  assert.strictEqual(client.cacheTTLMs, 60000);
});

test('constructor uses NC user as default username', () => {
  const nc = createMockNCRequestManager();
  const client = new ContactsClient(nc);
  assert.strictEqual(client.username, 'testuser');
});

test('constructor sets collectivesClient if provided', () => {
  const nc = createMockNCRequestManager();
  const wiki = createMockCollectivesClient();
  const client = new ContactsClient(nc, { collectivesClient: wiki });
  assert.strictEqual(client.collectivesClient, wiki);
});

test('constructor defaults collectivesClient to null', () => {
  const nc = createMockNCRequestManager();
  const client = new ContactsClient(nc);
  assert.strictEqual(client.collectivesClient, null);
});

// --- ContactsClientError ---

test('ContactsClientError has correct properties', () => {
  const err = new ContactsClientError('test error', 404, { body: 'not found' });
  assert.strictEqual(err.name, 'ContactsClientError');
  assert.strictEqual(err.message, 'test error');
  assert.strictEqual(err.statusCode, 404);
  assert.deepStrictEqual(err.response, { body: 'not found' });
  assert.ok(err instanceof Error);
});

// --- _request helper ---

asyncTest('_request calls NCRequestManager with correct params', async () => {
  let capturedPath = null;
  let capturedOptions = null;

  const nc = {
    ncUrl: 'https://cloud.example.com',
    ncUser: 'testuser',
    request: async (path, options) => {
      capturedPath = path;
      capturedOptions = options;
      return { status: 207, body: '<xml/>', headers: {} };
    }
  };

  const client = new ContactsClient(nc);
  const result = await client._request('REPORT', '/test/path', {
    body: '<query/>',
    depth: 1
  });

  assert.strictEqual(capturedPath, '/test/path');
  assert.strictEqual(capturedOptions.method, 'REPORT');
  assert.strictEqual(capturedOptions.headers['Depth'], '1');
  assert.strictEqual(capturedOptions.body, '<query/>');
  assert.strictEqual(result.status, 207);
});

// --- _basePath ---

test('_basePath returns correct CardDAV path', () => {
  const nc = createMockNCRequestManager();
  const client = new ContactsClient(nc, { username: 'alice', addressBook: 'work' });
  assert.strictEqual(client._basePath(), '/remote.php/dav/addressbooks/users/alice/work/');
});

// --- _escapeXml ---

test('_escapeXml escapes all XML special characters', () => {
  const nc = createMockNCRequestManager();
  const client = new ContactsClient(nc);
  assert.strictEqual(client._escapeXml('<script>alert("xss")</script>'), '&lt;script&gt;alert(&quot;xss&quot;)&lt;/script&gt;');
  assert.strictEqual(client._escapeXml("it's & done"), "it&#39;s &amp; done");
  assert.strictEqual(client._escapeXml('plain text'), 'plain text');
});

// --- _decodeXMLEntities ---

test('_decodeXMLEntities decodes standard entities', () => {
  const nc = createMockNCRequestManager();
  const client = new ContactsClient(nc);
  assert.strictEqual(client._decodeXMLEntities('&lt;b&gt;test&amp;run&lt;/b&gt;'), '<b>test&run</b>');
  assert.strictEqual(client._decodeXMLEntities('&quot;hello&quot;'), '"hello"');
  assert.strictEqual(client._decodeXMLEntities('it&#39;s'), "it's");
});

// --- _unfoldVCard ---

test('_unfoldVCard joins continuation lines (RFC 6350: leading space consumed)', () => {
  const nc = createMockNCRequestManager();
  const client = new ContactsClient(nc);
  // RFC 6350: continuation line starts with single space/tab which is part of the fold
  const folded = 'FN:Bob With Very Long\r\n Name That Is Folded';
  const result = client._unfoldVCard(folded);
  // The \r\n plus the single leading space are all removed by the unfold
  assert.strictEqual(result, 'FN:Bob With Very LongName That Is Folded');
});

// --- _parseVCard tests ---

test('_parseVCard parses full vCard with all fields', () => {
  const nc = createMockNCRequestManager();
  const client = new ContactsClient(nc);
  const contact = client._parseVCard(SAMPLE_VCARD_JOAO, '/contacts/1234.vcf', 'etag-1234');

  assert.strictEqual(contact.name, 'Joao Silva');
  assert.strictEqual(contact.firstName, 'Joao');
  assert.strictEqual(contact.lastName, 'Silva');
  assert.strictEqual(contact.email, 'joao.silva@company.pt');
  assert.strictEqual(contact.emails.length, 2);
  assert.strictEqual(contact.emails[0].type, 'WORK');
  assert.strictEqual(contact.emails[0].value, 'joao.silva@company.pt');
  assert.strictEqual(contact.emails[1].type, 'HOME');
  assert.strictEqual(contact.emails[1].value, 'joao@personal.pt');
  assert.strictEqual(contact.phone, '+351 912 345 678');
  assert.strictEqual(contact.phones[0].type, 'WORK');
  assert.strictEqual(contact.org, 'Company Name');
  assert.strictEqual(contact.title, 'Engineering Manager');
  assert.strictEqual(contact.uid, '1234-5678-abcd');
  assert.strictEqual(contact.href, '/contacts/1234.vcf');
  assert.strictEqual(contact.etag, 'etag-1234');
  assert.strictEqual(contact.hasPhoto, false);
});

test('_parseVCard handles minimal vCard', () => {
  const nc = createMockNCRequestManager();
  const client = new ContactsClient(nc);
  const contact = client._parseVCard(SAMPLE_VCARD_MINIMAL);

  assert.strictEqual(contact.name, 'Alice');
  assert.strictEqual(contact.firstName, null);
  assert.strictEqual(contact.lastName, null);
  assert.strictEqual(contact.email, null);
  assert.strictEqual(contact.emails.length, 0);
  assert.strictEqual(contact.phone, null);
  assert.strictEqual(contact.org, null);
  assert.strictEqual(contact.title, null);
  assert.strictEqual(contact.uid, null);
});

test('_parseVCard handles folded lines (RFC 6350)', () => {
  const nc = createMockNCRequestManager();
  const client = new ContactsClient(nc);
  const contact = client._parseVCard(SAMPLE_VCARD_FOLDED);

  // RFC 6350: fold = CRLF + single SP/HTAB. The entire fold sequence is removed.
  assert.strictEqual(contact.name, 'Bob With Very LongName That Is Folded');
  assert.strictEqual(contact.email, 'bob@example.com');
});

test('_parseVCard handles properties with parameters (CHARSET etc)', () => {
  const nc = createMockNCRequestManager();
  const client = new ContactsClient(nc);
  const contact = client._parseVCard(SAMPLE_VCARD_WITH_PARAMS);

  // With the fixed regex, params should NOT be captured as part of the value
  assert.strictEqual(contact.name, 'Alex Pereira');
  assert.strictEqual(contact.firstName, 'Alex');
  assert.strictEqual(contact.lastName, 'Pereira');
  assert.strictEqual(contact.org, 'Org Corp');
  assert.strictEqual(contact.title, 'Director');
  assert.strictEqual(contact.uid, 'uid-carlos-123');
});

// --- _extractType ---

test('_extractType extracts TYPE parameter', () => {
  const nc = createMockNCRequestManager();
  const client = new ContactsClient(nc);
  assert.strictEqual(client._extractType('EMAIL;TYPE=WORK:test@co.com'), 'WORK');
  assert.strictEqual(client._extractType('TEL;TYPE=HOME:+1234'), 'HOME');
  assert.strictEqual(client._extractType('EMAIL:test@co.com'), 'OTHER');
});

// --- _parseMultistatus tests ---

test('_parseMultistatus parses single response', () => {
  const nc = createMockNCRequestManager();
  const client = new ContactsClient(nc);
  const entries = client._parseMultistatus(SAMPLE_MULTISTATUS_ONE);

  assert.strictEqual(entries.length, 1);
  assert.strictEqual(entries[0].href, '/remote.php/dav/addressbooks/users/moltagent/contacts/1234.vcf');
  assert.strictEqual(entries[0].etag, 'etag-1234');
  assert.ok(entries[0].vcard.includes('FN:Joao Silva'));
});

test('_parseMultistatus parses empty response', () => {
  const nc = createMockNCRequestManager();
  const client = new ContactsClient(nc);
  const entries = client._parseMultistatus(SAMPLE_MULTISTATUS_EMPTY);
  assert.strictEqual(entries.length, 0);
});

test('_parseMultistatus parses two responses', () => {
  const nc = createMockNCRequestManager();
  const client = new ContactsClient(nc);
  const entries = client._parseMultistatus(SAMPLE_MULTISTATUS_TWO);

  assert.strictEqual(entries.length, 2);
  assert.ok(entries[0].vcard.includes('Joao Silva'));
  assert.ok(entries[1].vcard.includes('Maria Costa'));
  assert.strictEqual(entries[1].href, '/remote.php/dav/addressbooks/users/moltagent/contacts/5678.vcf');
});

// --- search() ---

asyncTest('search() sends REPORT request and returns contacts', async () => {
  const nc = createCardDAVMockNC();
  const client = new ContactsClient(nc);
  const results = await client.search('Joao');

  assert.strictEqual(results.length, 1);
  assert.strictEqual(results[0].name, 'Joao Silva');
  assert.strictEqual(results[0].email, 'joao.silva@company.pt');
});

asyncTest('search() escapes XML in query (no injection)', async () => {
  let capturedBody = null;
  const nc = {
    ncUrl: 'https://cloud.example.com',
    ncUser: 'testuser',
    request: async (path, options) => {
      capturedBody = options.body;
      return { status: 207, body: SAMPLE_MULTISTATUS_EMPTY, headers: {} };
    }
  };

  const client = new ContactsClient(nc);
  await client.search('<script>alert("xss")</script>');

  assert.ok(capturedBody.includes('&lt;script&gt;'));
  assert.ok(!capturedBody.includes('<script>'));
});

asyncTest('search() returns empty array on no matches', async () => {
  const nc = createCardDAVMockNC({
    'REPORT:/remote.php/dav/addressbooks/users/testuser/contacts/': {
      status: 207,
      body: SAMPLE_MULTISTATUS_EMPTY,
      headers: {}
    }
  });
  const client = new ContactsClient(nc);
  const results = await client.search('Nobody');
  assert.strictEqual(results.length, 0);
});

asyncTest('search() throws ContactsClientError on non-207', async () => {
  const nc = createCardDAVMockNC({
    'REPORT:/remote.php/dav/addressbooks/users/testuser/contacts/': {
      status: 500,
      body: 'Internal Server Error',
      headers: {}
    }
  });
  const client = new ContactsClient(nc);

  try {
    await client.search('test');
    assert.fail('Should have thrown');
  } catch (err) {
    assert.ok(err instanceof ContactsClientError);
    assert.strictEqual(err.statusCode, 500);
  }
});

asyncTest('search() uses cache fast-path when cache is warm', async () => {
  let reportCalls = 0;
  const nc = {
    ncUrl: 'https://cloud.example.com',
    ncUser: 'testuser',
    request: async (path, options) => {
      if (options.method === 'REPORT') reportCalls++;
      return { status: 207, body: SAMPLE_MULTISTATUS_ONE, headers: {} };
    }
  };

  const client = new ContactsClient(nc, { cacheTTLMs: 60000 });

  // Warm the cache via fetchAll
  await client.fetchAll(true);
  assert.strictEqual(reportCalls, 1);

  // Search should use cache, not make another REPORT
  const results = await client.search('Joao');
  assert.strictEqual(reportCalls, 1); // No extra REPORT
  assert.strictEqual(results.length, 1);
  assert.strictEqual(results[0].name, 'Joao Silva');
});

// --- get() ---

asyncTest('get() validates href prefix', async () => {
  const nc = createMockNCRequestManager();
  const client = new ContactsClient(nc);

  try {
    await client.get('/etc/passwd');
    assert.fail('Should have thrown');
  } catch (err) {
    assert.ok(err instanceof ContactsClientError);
    assert.ok(err.message.includes('Invalid CardDAV href'));
  }
});

asyncTest('get() returns null for 404', async () => {
  const nc = createMockNCRequestManager({
    'GET:/remote.php/dav/addressbooks/users/testuser/contacts/missing.vcf': {
      status: 404,
      body: 'Not Found',
      headers: {}
    }
  });
  const client = new ContactsClient(nc);
  const result = await client.get('/remote.php/dav/addressbooks/users/testuser/contacts/missing.vcf');
  assert.strictEqual(result, null);
});

asyncTest('get() returns contact from vCard response', async () => {
  const nc = createMockNCRequestManager({
    'GET:/remote.php/dav/addressbooks/users/testuser/contacts/1234.vcf': {
      status: 200,
      body: SAMPLE_VCARD_JOAO,
      headers: { etag: '"etag-1234"' }
    }
  });
  const client = new ContactsClient(nc);
  const contact = await client.get('/remote.php/dav/addressbooks/users/testuser/contacts/1234.vcf');

  assert.strictEqual(contact.name, 'Joao Silva');
  assert.strictEqual(contact.email, 'joao.silva@company.pt');
});

asyncTest('get() uses cache on second call', async () => {
  let getCalls = 0;
  const nc = {
    ncUrl: 'https://cloud.example.com',
    ncUser: 'testuser',
    request: async () => {
      getCalls++;
      return { status: 200, body: SAMPLE_VCARD_JOAO, headers: { etag: '"etag"' } };
    }
  };
  const client = new ContactsClient(nc);
  const href = '/remote.php/dav/addressbooks/users/testuser/contacts/1.vcf';

  await client.get(href);
  await client.get(href);
  assert.strictEqual(getCalls, 1); // Second call served from cache
});

// --- resolve() ---

asyncTest('resolve() returns resolved contact for single match', async () => {
  const nc = createCardDAVMockNC();
  const client = new ContactsClient(nc);
  const result = await client.resolve('Joao');

  assert.strictEqual(result.resolved, true);
  assert.strictEqual(result.contact.name, 'Joao Silva');
});

asyncTest('resolve() returns options for multiple matches', async () => {
  const nc = createCardDAVMockNC({
    'REPORT:/remote.php/dav/addressbooks/users/testuser/contacts/': {
      status: 207,
      body: SAMPLE_MULTISTATUS_TWO,
      headers: {}
    }
  });
  const client = new ContactsClient(nc);
  const result = await client.resolve('company');

  assert.strictEqual(result.resolved, false);
  assert.ok(Array.isArray(result.options));
  assert.strictEqual(result.options.length, 2);
});

asyncTest('resolve() returns error for no matches', async () => {
  const nc = createCardDAVMockNC({
    'REPORT:/remote.php/dav/addressbooks/users/testuser/contacts/': {
      status: 207,
      body: SAMPLE_MULTISTATUS_EMPTY,
      headers: {}
    }
  });
  const client = new ContactsClient(nc);
  const result = await client.resolve('Nobody');

  assert.strictEqual(result.resolved, false);
  assert.strictEqual(result.error, 'no_match');
});

// --- _searchCache ---

test('_searchCache returns matches from cached contacts', () => {
  const nc = createMockNCRequestManager();
  const client = new ContactsClient(nc);

  // Manually populate cache
  const contacts = [
    { href: '/1', name: 'Alice Smith', email: 'alice@co.com' },
    { href: '/2', name: 'Bob Jones', email: 'bob@co.com' },
    { href: '/3', name: 'Alice Cooper', email: 'cooper@co.com' }
  ];
  client._updateCache(contacts);

  const results = client._searchCache('alice');
  assert.strictEqual(results.length, 2);

  const names = results.map(c => c.name).sort();
  assert.deepStrictEqual(names, ['Alice Cooper', 'Alice Smith']);
});

test('_searchCache returns empty for no matches', () => {
  const nc = createMockNCRequestManager();
  const client = new ContactsClient(nc);
  client._updateCache([{ href: '/1', name: 'Alice Smith' }]);

  const results = client._searchCache('nobody');
  assert.strictEqual(results.length, 0);
});

test('_searchCache intersects multi-word queries', () => {
  const nc = createMockNCRequestManager();
  const client = new ContactsClient(nc);
  client._updateCache([
    { href: '/1', name: 'Alice Smith' },
    { href: '/2', name: 'Alice Jones' },
    { href: '/3', name: 'Bob Smith' }
  ]);

  const results = client._searchCache('alice smith');
  assert.strictEqual(results.length, 1);
  assert.strictEqual(results[0].name, 'Alice Smith');
});

// --- Cache helpers ---

test('invalidateCache clears all cache state', () => {
  const nc = createMockNCRequestManager();
  const client = new ContactsClient(nc);

  client._cache.contacts.set('test', { name: 'Test' });
  client._cache.lastFetched = Date.now();
  client._cache.nameIndex.set('test', new Set(['test']));

  client.invalidateCache();

  assert.strictEqual(client._cache.contacts.size, 0);
  assert.strictEqual(client._cache.lastFetched, 0);
  assert.strictEqual(client._cache.nameIndex.size, 0);
});

test('_isCacheValid returns false when cache is empty', () => {
  const nc = createMockNCRequestManager();
  const client = new ContactsClient(nc);
  assert.strictEqual(client._isCacheValid(), false);
});

test('_isCacheValid returns true when cache is fresh', () => {
  const nc = createMockNCRequestManager();
  const client = new ContactsClient(nc, { cacheTTLMs: 60000 });
  client._cache.lastFetched = Date.now();
  assert.strictEqual(client._isCacheValid(), true);
});

test('_isCacheValid returns false when cache is expired', () => {
  const nc = createMockNCRequestManager();
  const client = new ContactsClient(nc, { cacheTTLMs: 1 });
  client._cache.lastFetched = Date.now() - 1000;
  assert.strictEqual(client._isCacheValid(), false);
});

// --- _ensurePeoplePage ---

asyncTest('_ensurePeoplePage does nothing when collectivesClient is null', async () => {
  const nc = createMockNCRequestManager();
  const client = new ContactsClient(nc);
  await client._ensurePeoplePage({ name: 'Test Person', email: 'test@example.com' });
});

asyncTest('_ensurePeoplePage skips if page already exists', async () => {
  const nc = createMockNCRequestManager();
  let createCalled = false;
  const wiki = createMockCollectivesClient({
    findPageByTitle: { id: 1, title: 'Alice' }
  });
  wiki.createPage = async () => { createCalled = true; return { id: 500 }; };
  const client = new ContactsClient(nc, { collectivesClient: wiki });
  await client._ensurePeoplePage({ name: 'Alice', email: 'alice@co.com' });
  assert.strictEqual(createCalled, false);
});

// --- Module export ---

test('module exports ContactsClient and ContactsClientError', () => {
  const mod = require('../../../src/lib/integrations/contacts-client');
  assert.strictEqual(typeof mod, 'function');
  assert.strictEqual(mod.name, 'ContactsClient');
  assert.strictEqual(typeof mod.ContactsClientError, 'function');
});

// ============================================================
// Summary
// ============================================================

setTimeout(() => {
  summary();
  exitWithCode();
}, 100);
