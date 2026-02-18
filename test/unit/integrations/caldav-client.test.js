/**
 * CalDAV Client Unit Tests
 *
 * Architecture Brief:
 * -------------------
 * Problem: The CalDAV client needs automated unit tests that verify client logic,
 * parsing, and error handling without requiring a real Nextcloud server.
 *
 * Pattern: Mock-based unit testing with isolated component verification.
 * - Mock NCRequestManager to simulate server responses
 * - Test each public method and key private methods
 * - Verify XML parsing, ICS generation, and date handling
 *
 * Key Dependencies:
 * - NCRequestManager (mocked via createMockNCRequestManager)
 * - No external services required
 *
 * Data Flow:
 * Test -> CalDAVClient -> MockNCRequestManager -> Simulated Response
 *
 * Run: node test/unit/integrations/caldav-client.test.js
 *
 * @module test/unit/integrations/caldav-client
 */

const assert = require('assert');
const { test, asyncTest, summary, exitWithCode } = require('../../helpers/test-runner');
const { createMockNCRequestManager, createMockAuditLog } = require('../../helpers/mock-factories');

// Import module under test
const CalDAVClient = require('../../../src/lib/integrations/caldav-client');

// ============================================================
// Test Fixtures
// ============================================================

/**
 * Sample CalDAV PROPFIND response for calendar discovery
 */
const SAMPLE_CALENDARS_XML = `<?xml version="1.0" encoding="UTF-8"?>
<d:multistatus xmlns:d="DAV:" xmlns:cal="urn:ietf:params:xml:ns:caldav" xmlns:ical="http://apple.com/ns/ical/">
  <d:response>
    <d:href>/remote.php/dav/calendars/testuser/personal/</d:href>
    <d:propstat>
      <d:prop>
        <d:resourcetype><d:collection/><cal:calendar/></d:resourcetype>
        <d:displayname>Personal</d:displayname>
        <ical:calendar-color>#0082c9</ical:calendar-color>
        <cal:supported-calendar-component-set>
          <cal:comp name="VEVENT"/>
          <cal:comp name="VTODO"/>
        </cal:supported-calendar-component-set>
      </d:prop>
    </d:propstat>
  </d:response>
  <d:response>
    <d:href>/remote.php/dav/calendars/testuser/work/</d:href>
    <d:propstat>
      <d:prop>
        <d:resourcetype><d:collection/><cal:calendar/></d:resourcetype>
        <d:displayname>Work</d:displayname>
        <ical:calendar-color>#ff0000</ical:calendar-color>
        <cal:supported-calendar-component-set>
          <cal:comp name="VEVENT"/>
        </cal:supported-calendar-component-set>
      </d:prop>
    </d:propstat>
  </d:response>
</d:multistatus>`;

/**
 * Sample CalDAV REPORT response for events
 */
const SAMPLE_EVENTS_XML = `<?xml version="1.0" encoding="UTF-8"?>
<d:multistatus xmlns:d="DAV:" xmlns:cal="urn:ietf:params:xml:ns:caldav">
  <d:response>
    <d:href>/remote.php/dav/calendars/testuser/personal/event1.ics</d:href>
    <d:propstat>
      <d:prop>
        <d:getetag>"abc123"</d:getetag>
        <cal:calendar-data>BEGIN:VCALENDAR
VERSION:2.0
BEGIN:VEVENT
UID:event1@moltagent
SUMMARY:Team Meeting
DESCRIPTION:Weekly team sync
LOCATION:Conference Room A
DTSTART:20250210T140000Z
DTEND:20250210T150000Z
STATUS:CONFIRMED
END:VEVENT
END:VCALENDAR</cal:calendar-data>
      </d:prop>
    </d:propstat>
  </d:response>
</d:multistatus>`;

/**
 * Sample ICS data for a single event
 */
const SAMPLE_ICS = `BEGIN:VCALENDAR
VERSION:2.0
PRODID:-//Test//Test//EN
BEGIN:VEVENT
UID:test-event-123@moltagent
DTSTAMP:20250205T100000Z
DTSTART:20250210T140000Z
DTEND:20250210T150000Z
SUMMARY:Test Event
DESCRIPTION:Test description with\\nline breaks
LOCATION:Test Location
STATUS:CONFIRMED
SEQUENCE:0
ORGANIZER;CN=John Doe:mailto:john@example.com
ATTENDEE;CUTYPE=INDIVIDUAL;ROLE=REQ-PARTICIPANT;PARTSTAT=NEEDS-ACTION;CN=Jane:mailto:jane@example.com
END:VEVENT
END:VCALENDAR`;

// ============================================================
// Mock Factory Helpers
// ============================================================

/**
 * Create CalDAV-specific mock NCRequestManager
 * @param {Object} overrides - Custom response overrides
 * @returns {Object} Mock NCRequestManager with CalDAV responses
 */
function createCalDAVMockNC(overrides = {}) {
  const defaultResponses = {
    // Calendar discovery
    'PROPFIND:/remote.php/dav/calendars/testuser/': {
      status: 207,
      body: SAMPLE_CALENDARS_XML,
      headers: {}
    },
    // Events query
    'REPORT:/remote.php/dav/calendars/testuser/personal/': {
      status: 207,
      body: SAMPLE_EVENTS_XML,
      headers: {}
    },
    // Single event GET
    'GET:/remote.php/dav/calendars/testuser/personal/event1.ics': {
      status: 200,
      body: SAMPLE_ICS,
      headers: { etag: '"abc123"' }
    },
    // Event creation
    'PUT:/remote.php/dav/calendars/testuser/personal/': {
      status: 201,
      body: '',
      headers: { etag: '"new123"' }
    },
    // Event deletion
    'DELETE:/remote.php/dav/calendars/testuser/personal/': {
      status: 204,
      body: '',
      headers: {}
    }
  };

  const responses = { ...defaultResponses, ...overrides };

  return {
    ncUrl: 'https://cloud.example.com',
    ncUser: 'testuser',
    request: async (path, options = {}) => {
      const method = options.method || 'GET';

      // Try exact match first
      const exactKey = `${method}:${path}`;
      if (responses[exactKey]) {
        return typeof responses[exactKey] === 'function'
          ? responses[exactKey](path, options)
          : responses[exactKey];
      }

      // Try prefix match for dynamic paths
      for (const [key, response] of Object.entries(responses)) {
        if (exactKey.startsWith(key)) {
          return typeof response === 'function'
            ? response(path, options)
            : response;
        }
      }

      // Default 404
      return { status: 404, body: 'Not found', headers: {} };
    },
    getMetrics: () => ({ totalRequests: 0, cacheHits: 0 }),
    invalidateCache: () => {},
    shutdown: async () => {}
  };
}

// ============================================================
// Test Suites
// ============================================================

console.log('\n=== CalDAVClient Tests ===\n');

// --- Constructor Tests ---
console.log('\n--- Constructor Tests ---\n');

test('TC-CTOR-001: Initialize with NCRequestManager', () => {
  const mockNC = createCalDAVMockNC();
  const mockAuditLog = createMockAuditLog();

  const client = new CalDAVClient(mockNC, null, {
    username: 'testuser',
    auditLog: mockAuditLog
  });

  assert.strictEqual(client.nc, mockNC);
  assert.strictEqual(client.username, 'testuser');
  assert.strictEqual(client.defaultCalendar, 'personal');
});

test('TC-CTOR-002: Initialize with default calendar override', () => {
  const mockNC = createCalDAVMockNC();

  const client = new CalDAVClient(mockNC, null, {
    username: 'testuser',
    defaultCalendar: 'work'
  });

  assert.strictEqual(client.defaultCalendar, 'work');
});

test('TC-CTOR-003: Initialize cache with correct TTL', () => {
  const mockNC = createCalDAVMockNC();

  const client = new CalDAVClient(mockNC, null, { username: 'testuser' });

  assert.strictEqual(client._cacheTTL, 60000); // 1 minute
  assert.strictEqual(client._calendarsCache, null);
});

test('TC-CTOR-004: Throws error without NCRequestManager', () => {
  // TODO: Implement - Verify legacy fallback throws appropriate error
  const client = new CalDAVClient(null, null, { ncUrl: 'https://test.com', username: 'test' });

  // Should have null nc (legacy mode)
  assert.strictEqual(client.nc, null);
});

// --- XML Parsing Tests ---
console.log('\n--- XML Parsing Tests ---\n');

test('TC-XML-001: Parse multistatus response with calendars', () => {
  const mockNC = createCalDAVMockNC();
  const client = new CalDAVClient(mockNC, null, { username: 'testuser' });

  const parsed = client._parseXML(SAMPLE_CALENDARS_XML);

  assert.strictEqual(parsed.length, 2);
  assert.strictEqual(parsed[0].displayName, 'Personal');
  assert.strictEqual(parsed[0].isCalendar, true);
  assert.strictEqual(parsed[0].supportsVEVENT, true);
  assert.strictEqual(parsed[0].supportsVTODO, true);
  assert.strictEqual(parsed[1].displayName, 'Work');
  assert.strictEqual(parsed[1].supportsVTODO, false);
});

test('TC-XML-002: Parse multistatus response with events', () => {
  const mockNC = createCalDAVMockNC();
  const client = new CalDAVClient(mockNC, null, { username: 'testuser' });

  const parsed = client._parseXML(SAMPLE_EVENTS_XML);

  assert.strictEqual(parsed.length, 1);
  assert.ok(parsed[0].calendarData.includes('Team Meeting'));
  assert.strictEqual(parsed[0].etag, 'abc123');
});

test('TC-XML-003: Parse empty response', () => {
  const mockNC = createCalDAVMockNC();
  const client = new CalDAVClient(mockNC, null, { username: 'testuser' });

  const parsed = client._parseXML('<d:multistatus></d:multistatus>');

  assert.strictEqual(parsed.length, 0);
});

test('TC-XML-004: Decode XML entities', () => {
  const mockNC = createCalDAVMockNC();
  const client = new CalDAVClient(mockNC, null, { username: 'testuser' });

  const decoded = client._decodeXMLEntities('Test &lt;tag&gt; &amp; &quot;quoted&quot;');

  assert.strictEqual(decoded, 'Test <tag> & "quoted"');
});

// --- ICS Parsing Tests ---
console.log('\n--- ICS Parsing Tests ---\n');

test('TC-ICS-001: Parse basic event fields', () => {
  const mockNC = createCalDAVMockNC();
  const client = new CalDAVClient(mockNC, null, { username: 'testuser' });

  const event = client._parseICS(SAMPLE_ICS);

  assert.strictEqual(event.uid, 'test-event-123@moltagent');
  assert.strictEqual(event.summary, 'Test Event');
  assert.strictEqual(event.location, 'Test Location');
  assert.strictEqual(event.status, 'CONFIRMED');
  assert.strictEqual(event.sequence, 0);
});

test('TC-ICS-002: Parse event datetime', () => {
  const mockNC = createCalDAVMockNC();
  const client = new CalDAVClient(mockNC, null, { username: 'testuser' });

  const event = client._parseICS(SAMPLE_ICS);

  assert.ok(event.start);
  assert.ok(event.end);
  // Should be ISO string format
  assert.ok(event.start.includes('2025-02-10'));
});

test('TC-ICS-003: Parse event with attendees', () => {
  const mockNC = createCalDAVMockNC();
  const client = new CalDAVClient(mockNC, null, { username: 'testuser' });

  const event = client._parseICS(SAMPLE_ICS);

  assert.strictEqual(event.attendees.length, 1);
  assert.strictEqual(event.attendees[0].email, 'jane@example.com');
  assert.strictEqual(event.attendees[0].name, 'Jane');
  assert.strictEqual(event.attendees[0].status, 'NEEDS-ACTION');
});

test('TC-ICS-004: Parse event with organizer', () => {
  const mockNC = createCalDAVMockNC();
  const client = new CalDAVClient(mockNC, null, { username: 'testuser' });

  const event = client._parseICS(SAMPLE_ICS);

  assert.ok(event.organizer);
  assert.strictEqual(event.organizer.email, 'john@example.com');
  assert.strictEqual(event.organizer.name, 'John Doe');
});

test('TC-ICS-005: Unescape ICS special characters', () => {
  const mockNC = createCalDAVMockNC();
  const client = new CalDAVClient(mockNC, null, { username: 'testuser' });

  const unescaped = client._unescapeICS('Test\\nLine\\,with\\;special');

  assert.strictEqual(unescaped, 'Test\nLine,with;special');
});

test('TC-ICS-006: Parse description with line continuations', () => {
  const mockNC = createCalDAVMockNC();
  const client = new CalDAVClient(mockNC, null, { username: 'testuser' });

  const event = client._parseICS(SAMPLE_ICS);

  // Description should have newlines unescaped
  assert.ok(event.description.includes('line breaks'));
});

// --- ICS Building Tests ---
console.log('\n--- ICS Building Tests ---\n');

test('TC-BUILD-001: Build basic event ICS', () => {
  const mockNC = createCalDAVMockNC();
  const client = new CalDAVClient(mockNC, null, { username: 'testuser' });

  const ics = client._buildICS({
    uid: 'test-uid-123',
    summary: 'Test Event',
    start: new Date('2025-02-10T14:00:00Z'),
    end: new Date('2025-02-10T15:00:00Z')
  });

  assert.ok(ics.includes('BEGIN:VCALENDAR'));
  assert.ok(ics.includes('BEGIN:VEVENT'));
  assert.ok(ics.includes('UID:test-uid-123'));
  assert.ok(ics.includes('SUMMARY:Test Event'));
  assert.ok(ics.includes('END:VEVENT'));
  assert.ok(ics.includes('END:VCALENDAR'));
});

test('TC-BUILD-002: Build event with all fields', () => {
  const mockNC = createCalDAVMockNC();
  const client = new CalDAVClient(mockNC, null, { username: 'testuser' });

  const ics = client._buildICS({
    uid: 'full-event-123',
    summary: 'Full Event',
    description: 'Event description',
    location: 'Conference Room',
    start: new Date('2025-02-10T14:00:00Z'),
    end: new Date('2025-02-10T15:00:00Z'),
    status: 'TENTATIVE',
    sequence: 2
  });

  assert.ok(ics.includes('DESCRIPTION:Event description'));
  assert.ok(ics.includes('LOCATION:Conference Room'));
  assert.ok(ics.includes('STATUS:TENTATIVE'));
  assert.ok(ics.includes('SEQUENCE:2'));
});

test('TC-BUILD-003: Build event with attendees', () => {
  const mockNC = createCalDAVMockNC();
  const client = new CalDAVClient(mockNC, null, { username: 'testuser' });

  const ics = client._buildICS({
    uid: 'meeting-123',
    summary: 'Meeting',
    start: new Date('2025-02-10T14:00:00Z'),
    end: new Date('2025-02-10T15:00:00Z'),
    attendees: [
      { email: 'jane@example.com', name: 'Jane Doe', status: 'ACCEPTED' },
      'bob@example.com' // Simple email string
    ]
  });

  assert.ok(ics.includes('ATTENDEE'));
  assert.ok(ics.includes('jane@example.com'));
  assert.ok(ics.includes('bob@example.com'));
});

test('TC-BUILD-004: Build event with organizer', () => {
  const mockNC = createCalDAVMockNC();
  const client = new CalDAVClient(mockNC, null, { username: 'testuser' });

  const ics = client._buildICS({
    uid: 'organized-123',
    summary: 'Organized Meeting',
    start: new Date('2025-02-10T14:00:00Z'),
    end: new Date('2025-02-10T15:00:00Z'),
    organizer: { email: 'organizer@example.com', name: 'Organizer' }
  });

  assert.ok(ics.includes('ORGANIZER'));
  assert.ok(ics.includes('organizer@example.com'));
});

test('TC-BUILD-005: Escape ICS special characters', () => {
  const mockNC = createCalDAVMockNC();
  const client = new CalDAVClient(mockNC, null, { username: 'testuser' });

  const escaped = client._escapeICS('Test\nLine,with;special');

  assert.strictEqual(escaped, 'Test\\nLine\\,with\\;special');
});

test('TC-BUILD-006: Build all-day event', () => {
  const mockNC = createCalDAVMockNC();
  const client = new CalDAVClient(mockNC, null, { username: 'testuser' });

  const ics = client._buildICS({
    uid: 'allday-123',
    summary: 'All Day Event',
    start: new Date('2025-02-10'),
    end: new Date('2025-02-11'),
    allDay: true
  });

  assert.ok(ics.includes('DTSTART;VALUE=DATE:'));
  assert.ok(ics.includes('DTEND;VALUE=DATE:'));
});

// --- Date Formatting Tests ---
console.log('\n--- Date Formatting Tests ---\n');

test('TC-DATE-001: Format datetime to ICS format', () => {
  const mockNC = createCalDAVMockNC();
  const client = new CalDAVClient(mockNC, null, { username: 'testuser' });

  const formatted = client._formatDateTime(new Date('2025-02-10T14:30:00Z'));

  // Should be YYYYMMDDTHHMMSSZ format
  assert.strictEqual(formatted, '20250210T143000Z');
});

test('TC-DATE-002: Format date only', () => {
  const mockNC = createCalDAVMockNC();
  const client = new CalDAVClient(mockNC, null, { username: 'testuser' });

  const formatted = client._formatDate(new Date('2025-02-10'));

  // Should be YYYYMMDD format
  assert.strictEqual(formatted, '20250210');
});

test('TC-DATE-003: Parse ICS datetime', () => {
  const mockNC = createCalDAVMockNC();
  const client = new CalDAVClient(mockNC, null, { username: 'testuser' });

  const parsed = client._parseICSDateTime('20250210T143000Z');

  assert.ok(parsed.includes('2025-02-10'));
  assert.ok(parsed.includes('14:30:00'));
});

test('TC-DATE-004: Parse ICS date only', () => {
  const mockNC = createCalDAVMockNC();
  const client = new CalDAVClient(mockNC, null, { username: 'testuser' });

  const parsed = client._parseICSDateTime('20250210');

  assert.strictEqual(parsed, '2025-02-10');
});

// --- UID Generation Tests ---
console.log('\n--- UID Generation Tests ---\n');

test('TC-UID-001: Generate unique UID', () => {
  const mockNC = createCalDAVMockNC();
  const client = new CalDAVClient(mockNC, null, { username: 'testuser' });

  const uid1 = client._generateUID();
  const uid2 = client._generateUID();

  assert.notStrictEqual(uid1, uid2);
  assert.ok(uid1.includes('@moltagent'));
  assert.ok(uid2.includes('@moltagent'));
});

// --- Calendar Discovery Tests ---
console.log('\n--- Calendar Discovery Tests ---\n');

asyncTest('TC-CAL-001: Get all calendars', async () => {
  const mockNC = createCalDAVMockNC();
  const client = new CalDAVClient(mockNC, null, { username: 'testuser' });

  const calendars = await client.getCalendars();

  assert.strictEqual(calendars.length, 2);
  assert.strictEqual(calendars[0].id, 'personal');
  assert.strictEqual(calendars[0].displayName, 'Personal');
  assert.strictEqual(calendars[1].id, 'work');
});

asyncTest('TC-CAL-002: Get event calendars only', async () => {
  const mockNC = createCalDAVMockNC();
  const client = new CalDAVClient(mockNC, null, { username: 'testuser' });

  const calendars = await client.getEventCalendars();

  // Both should support events
  assert.strictEqual(calendars.length, 2);
  calendars.forEach(c => assert.strictEqual(c.supportsEvents, true));
});

asyncTest('TC-CAL-003: Get specific calendar by ID', async () => {
  const mockNC = createCalDAVMockNC();
  const client = new CalDAVClient(mockNC, null, { username: 'testuser' });

  const calendar = await client.getCalendar('personal');

  assert.ok(calendar);
  assert.strictEqual(calendar.id, 'personal');
  assert.strictEqual(calendar.displayName, 'Personal');
});

asyncTest('TC-CAL-004: Return null for non-existent calendar', async () => {
  const mockNC = createCalDAVMockNC();
  const client = new CalDAVClient(mockNC, null, { username: 'testuser' });

  const calendar = await client.getCalendar('nonexistent');

  assert.strictEqual(calendar, undefined);
});

asyncTest('TC-CAL-005: Cache calendars response', async () => {
  let requestCount = 0;
  const mockNC = createCalDAVMockNC({
    'PROPFIND:/remote.php/dav/calendars/testuser/': () => {
      requestCount++;
      return { status: 207, body: SAMPLE_CALENDARS_XML, headers: {} };
    }
  });
  const client = new CalDAVClient(mockNC, null, { username: 'testuser' });

  await client.getCalendars();
  await client.getCalendars();

  // Second call should use cache
  assert.strictEqual(requestCount, 1);
});

asyncTest('TC-CAL-006: Force refresh bypasses cache', async () => {
  let requestCount = 0;
  const mockNC = createCalDAVMockNC({
    'PROPFIND:/remote.php/dav/calendars/testuser/': () => {
      requestCount++;
      return { status: 207, body: SAMPLE_CALENDARS_XML, headers: {} };
    }
  });
  const client = new CalDAVClient(mockNC, null, { username: 'testuser' });

  await client.getCalendars();
  await client.getCalendars(true); // Force refresh

  assert.strictEqual(requestCount, 2);
});

asyncTest('TC-CAL-007: Handle calendar discovery error', async () => {
  const mockNC = createCalDAVMockNC({
    'PROPFIND:/remote.php/dav/calendars/testuser/': {
      status: 500,
      body: 'Server error',
      headers: {}
    }
  });
  const client = new CalDAVClient(mockNC, null, { username: 'testuser' });

  try {
    await client.getCalendars();
    assert.fail('Should have thrown error');
  } catch (error) {
    assert.ok(error.message.includes('500'));
  }
});

// --- Event Operations Tests ---
console.log('\n--- Event Operations Tests ---\n');

asyncTest('TC-EVENT-001: Get events in time range', async () => {
  const mockNC = createCalDAVMockNC();
  const client = new CalDAVClient(mockNC, null, { username: 'testuser' });

  const events = await client.getEvents(
    'personal',
    new Date('2025-02-01'),
    new Date('2025-02-28')
  );

  assert.ok(Array.isArray(events));
  assert.strictEqual(events.length, 1);
  assert.strictEqual(events[0].summary, 'Team Meeting');
});

asyncTest('TC-EVENT-002: Get single event by UID', async () => {
  const mockNC = createCalDAVMockNC({
    'GET:/remote.php/dav/calendars/testuser/personal/event1.ics': {
      status: 200,
      body: SAMPLE_ICS,
      headers: { etag: '"abc123"' }
    }
  });
  const client = new CalDAVClient(mockNC, null, { username: 'testuser' });

  const event = await client.getEvent('personal', 'event1');

  assert.ok(event);
  assert.strictEqual(event.summary, 'Test Event');
});

asyncTest('TC-EVENT-003: Return null for non-existent event', async () => {
  const mockNC = createCalDAVMockNC({
    'GET:/remote.php/dav/calendars/testuser/personal/nonexistent.ics': {
      status: 404,
      body: 'Not found',
      headers: {}
    }
  });
  const client = new CalDAVClient(mockNC, null, { username: 'testuser' });

  const event = await client.getEvent('personal', 'nonexistent');

  assert.strictEqual(event, null);
});

asyncTest('TC-EVENT-004: Create event', async () => {
  let capturedPath = null;
  let capturedBody = null;

  const mockNC = createCalDAVMockNC({
    'PUT:/remote.php/dav/calendars/testuser/personal/': (path, options) => {
      capturedPath = path;
      capturedBody = options.body;
      return { status: 201, body: '', headers: { etag: '"new123"' } };
    }
  });
  const client = new CalDAVClient(mockNC, null, { username: 'testuser' });

  const event = await client.createEvent({
    summary: 'New Event',
    start: new Date('2025-02-15T10:00:00Z'),
    end: new Date('2025-02-15T11:00:00Z'),
    calendarId: 'personal'
  });

  assert.ok(event.uid);
  assert.strictEqual(event.summary, 'New Event');
  assert.ok(capturedPath.includes('personal'));
  assert.ok(capturedBody.includes('New Event'));
});

asyncTest('TC-EVENT-005: Handle event creation error', async () => {
  const mockNC = createCalDAVMockNC({
    'PUT:/remote.php/dav/calendars/testuser/personal/': {
      status: 403,
      body: 'Forbidden',
      headers: {}
    }
  });
  const client = new CalDAVClient(mockNC, null, { username: 'testuser' });

  try {
    await client.createEvent({
      summary: 'New Event',
      start: new Date('2025-02-15T10:00:00Z'),
      end: new Date('2025-02-15T11:00:00Z')
    });
    assert.fail('Should have thrown error');
  } catch (error) {
    assert.ok(error.message.includes('403'));
  }
});

asyncTest('TC-EVENT-006: Delete event', async () => {
  let deleteCalled = false;

  const mockNC = createCalDAVMockNC({
    'DELETE:/remote.php/dav/calendars/testuser/personal/event1.ics': () => {
      deleteCalled = true;
      return { status: 204, body: '', headers: {} };
    }
  });
  const client = new CalDAVClient(mockNC, null, { username: 'testuser' });

  const result = await client.deleteEvent('personal', 'event1');

  assert.strictEqual(result, true);
  assert.strictEqual(deleteCalled, true);
});

// --- Availability Tests ---
console.log('\n--- Availability Tests ---\n');

asyncTest('TC-AVAIL-001: Check availability - free slot', async () => {
  // Return empty events for the checked time
  const mockNC = createCalDAVMockNC({
    'REPORT:/remote.php/dav/calendars/testuser/personal/': {
      status: 207,
      body: '<d:multistatus xmlns:d="DAV:"></d:multistatus>',
      headers: {}
    }
  });
  const client = new CalDAVClient(mockNC, null, { username: 'testuser' });

  const availability = await client.checkAvailability(
    new Date('2025-02-20T10:00:00Z'),
    new Date('2025-02-20T11:00:00Z'),
    'personal'
  );

  assert.strictEqual(availability.isFree, true);
  assert.strictEqual(availability.conflicts.length, 0);
});

asyncTest('TC-AVAIL-002: Check availability - conflict exists', async () => {
  const mockNC = createCalDAVMockNC();
  const client = new CalDAVClient(mockNC, null, { username: 'testuser' });

  // Time overlaps with Team Meeting (14:00-15:00)
  const availability = await client.checkAvailability(
    new Date('2025-02-10T14:30:00Z'),
    new Date('2025-02-10T15:30:00Z'),
    'personal'
  );

  assert.strictEqual(availability.isFree, false);
  assert.ok(availability.conflicts.length > 0);
});

asyncTest('TC-AVAIL-003: amIFreeAt returns boolean', async () => {
  const emptyResponse = '<d:multistatus xmlns:d="DAV:"></d:multistatus>';
  const mockNC = createCalDAVMockNC({
    'REPORT:/remote.php/dav/calendars/testuser/personal/': {
      status: 207,
      body: emptyResponse,
      headers: {}
    },
    'REPORT:/remote.php/dav/calendars/testuser/work/': {
      status: 207,
      body: emptyResponse,
      headers: {}
    }
  });
  const client = new CalDAVClient(mockNC, null, { username: 'testuser' });

  const isFree = await client.amIFreeAt(new Date('2025-03-01T10:00:00Z'));

  assert.strictEqual(typeof isFree, 'boolean');
});

// --- Convenience Methods Tests ---
console.log('\n--- Convenience Methods Tests ---\n');

asyncTest('TC-CONV-001: Get today summary with events', async () => {
  // Mock to return events for today
  const today = new Date();
  const todayStr = today.toISOString().slice(0, 10).replace(/-/g, '');

  const todayEvents = `<?xml version="1.0"?>
<d:multistatus xmlns:d="DAV:" xmlns:cal="urn:ietf:params:xml:ns:caldav">
  <d:response>
    <d:href>/test/event.ics</d:href>
    <d:propstat>
      <d:prop>
        <d:getetag>"test"</d:getetag>
        <cal:calendar-data>BEGIN:VCALENDAR
BEGIN:VEVENT
UID:today-event
SUMMARY:Today Meeting
DTSTART:${todayStr}T100000Z
DTEND:${todayStr}T110000Z
END:VEVENT
END:VCALENDAR</cal:calendar-data>
      </d:prop>
    </d:propstat>
  </d:response>
</d:multistatus>`;

  const mockNC = createCalDAVMockNC({
    'REPORT:/remote.php/dav/calendars/testuser/personal/': {
      status: 207,
      body: todayEvents,
      headers: {}
    },
    'REPORT:/remote.php/dav/calendars/testuser/work/': {
      status: 207,
      body: '<d:multistatus xmlns:d="DAV:"></d:multistatus>',
      headers: {}
    }
  });
  const client = new CalDAVClient(mockNC, null, { username: 'testuser' });

  const summary = await client.getTodaySummary();

  assert.ok(summary.text);
  assert.ok(Array.isArray(summary.events));
});

asyncTest('TC-CONV-002: Get today summary with no events', async () => {
  const mockNC = createCalDAVMockNC({
    'REPORT:/remote.php/dav/calendars/testuser/personal/': {
      status: 207,
      body: '<d:multistatus xmlns:d="DAV:"></d:multistatus>',
      headers: {}
    },
    'REPORT:/remote.php/dav/calendars/testuser/work/': {
      status: 207,
      body: '<d:multistatus xmlns:d="DAV:"></d:multistatus>',
      headers: {}
    }
  });
  const client = new CalDAVClient(mockNC, null, { username: 'testuser' });

  const summary = await client.getTodaySummary();

  assert.ok(summary.text.includes('No events'));
  assert.strictEqual(summary.events.length, 0);
});

asyncTest('TC-CONV-003: Quick schedule with no conflict', async () => {
  const futureDate = new Date();
  futureDate.setMonth(futureDate.getMonth() + 1);
  const emptyResponse = '<d:multistatus xmlns:d="DAV:"></d:multistatus>';

  const mockNC = createCalDAVMockNC({
    'REPORT:/remote.php/dav/calendars/testuser/personal/': {
      status: 207,
      body: emptyResponse,
      headers: {}
    },
    'REPORT:/remote.php/dav/calendars/testuser/work/': {
      status: 207,
      body: emptyResponse,
      headers: {}
    },
    'PUT:/remote.php/dav/calendars/testuser/personal/': {
      status: 201,
      body: '',
      headers: {}
    }
  });
  const client = new CalDAVClient(mockNC, null, { username: 'testuser' });

  const result = await client.quickSchedule('Quick Meeting', futureDate, 60);

  assert.strictEqual(result.success, true);
  assert.ok(result.event);
  assert.ok(result.event.uid);
});

// --- Meeting Response Tests ---
console.log('\n--- Meeting Response Tests ---\n');

asyncTest('TC-MEET-001: Accept meeting creates event', async () => {
  const mockNC = createCalDAVMockNC({
    'PUT:/remote.php/dav/calendars/testuser/personal/': {
      status: 201,
      body: '',
      headers: {}
    }
  });
  const client = new CalDAVClient(mockNC, null, { username: 'testuser' });

  const result = await client.respondToMeeting({
    summary: 'Invited Meeting',
    start: new Date('2025-03-01T10:00:00Z'),
    end: new Date('2025-03-01T11:00:00Z'),
    organizerEmail: 'organizer@example.com'
  }, 'ACCEPTED');

  assert.strictEqual(result.success, true);
  assert.strictEqual(result.action, 'accepted');
  assert.ok(result.event);
});

asyncTest('TC-MEET-002: Decline meeting does not create event', async () => {
  const mockNC = createCalDAVMockNC();
  const client = new CalDAVClient(mockNC, null, { username: 'testuser' });

  const result = await client.respondToMeeting({
    summary: 'Declined Meeting',
    start: new Date('2025-03-01T10:00:00Z'),
    organizerEmail: 'organizer@example.com'
  }, 'DECLINED');

  assert.strictEqual(result.success, true);
  assert.strictEqual(result.action, 'declined');
  assert.ok(!result.event);
});

asyncTest('TC-MEET-003: Tentative meeting creates tentative event', async () => {
  const mockNC = createCalDAVMockNC({
    'PUT:/remote.php/dav/calendars/testuser/personal/': {
      status: 201,
      body: '',
      headers: {}
    }
  });
  const client = new CalDAVClient(mockNC, null, { username: 'testuser' });

  const result = await client.respondToMeeting({
    summary: 'Maybe Meeting',
    start: new Date('2025-03-01T10:00:00Z'),
    organizerEmail: 'organizer@example.com'
  }, 'TENTATIVE');

  assert.strictEqual(result.success, true);
  assert.strictEqual(result.action, 'tentative');
});

asyncTest('TC-MEET-004: Invalid response type throws error', async () => {
  const mockNC = createCalDAVMockNC();
  const client = new CalDAVClient(mockNC, null, { username: 'testuser' });

  try {
    await client.respondToMeeting({
      summary: 'Meeting',
      start: new Date(),
      organizerEmail: 'test@example.com'
    }, 'INVALID');
    assert.fail('Should have thrown error');
  } catch (error) {
    assert.ok(error.message.includes('Invalid response type'));
  }
});

// --- Error Handling Tests ---
console.log('\n--- Error Handling Tests ---\n');

asyncTest('TC-ERR-001: Throws when NCRequestManager not provided', async () => {
  const client = new CalDAVClient(null, null, { ncUrl: 'https://test.com', username: 'test' });

  try {
    await client.getCalendars();
    assert.fail('Should have thrown error');
  } catch (error) {
    assert.ok(error.message.includes('requires NCRequestManager'));
  }
});

asyncTest('TC-ERR-002: Audit log is called on operations', async () => {
  const auditCalls = [];
  const mockAuditLog = async (event, data) => {
    auditCalls.push({ event, data });
  };

  const mockNC = createCalDAVMockNC();
  const client = new CalDAVClient(mockNC, null, {
    username: 'testuser',
    auditLog: mockAuditLog
  });

  await client.getCalendars();

  assert.ok(auditCalls.length > 0);
  assert.strictEqual(auditCalls[0].event, 'caldav_calendars_listed');
});

// ============================================================
// Session 24 GAP-9: Timezone in CalDAV ICS Generation
// ============================================================

console.log('\n--- GAP-9: CalDAV Timezone Tests ---\n');

test('_formatDateTimeLocal produces local datetime without Z suffix', () => {
  const client = new CalDAVClient(null, null, {
    username: 'testuser',
    timezone: 'Europe/Lisbon'
  });

  // 2026-02-06T12:00:00Z — Lisbon is UTC+0 in winter
  const result = client._formatDateTimeLocal(new Date('2026-02-06T12:00:00Z'));

  // Should be YYYYMMDDTHHMMSS without Z
  assert.ok(/^\d{8}T\d{6}$/.test(result), `Expected local datetime format, got: ${result}`);
  assert.ok(!result.endsWith('Z'), 'Should not end with Z');
});

test('_formatDateTimeLocal respects timezone offset', () => {
  // Use a timezone with a known offset
  const client = new CalDAVClient(null, null, {
    username: 'testuser',
    timezone: 'America/New_York'
  });

  // 2026-07-15T18:00:00Z = 2026-07-15T14:00:00 EDT (UTC-4 in summer)
  const result = client._formatDateTimeLocal(new Date('2026-07-15T18:00:00Z'));

  assert.ok(result.includes('T14'), `Expected 14:00 in NYC, got: ${result}`);
});

test('_buildICS uses TZID for non-UTC timezone', () => {
  const client = new CalDAVClient(null, null, {
    username: 'testuser',
    timezone: 'Europe/Lisbon'
  });

  const ics = client._buildICS({
    uid: 'test-uid-123',
    start: new Date('2026-02-10T10:00:00Z'),
    end: new Date('2026-02-10T11:00:00Z'),
    summary: 'Test Meeting',
    allDay: false
  });

  assert.ok(ics.includes('TZID=Europe/Lisbon'), `ICS should include TZID, got: ${ics}`);
  assert.ok(!ics.includes('DTSTART:2026'), 'Non-UTC ICS should not use bare DTSTART');
});

test('_buildICS uses UTC format when timezone is UTC', () => {
  const client = new CalDAVClient(null, null, {
    username: 'testuser',
    timezone: 'UTC'
  });

  const ics = client._buildICS({
    uid: 'test-uid-456',
    start: new Date('2026-02-10T10:00:00Z'),
    end: new Date('2026-02-10T11:00:00Z'),
    summary: 'UTC Meeting',
    allDay: false
  });

  assert.ok(!ics.includes('TZID='), 'UTC ICS should not include TZID');
  assert.ok(ics.includes('DTSTART:'), 'UTC ICS should use plain DTSTART');
});

test('_buildICS all-day events ignore timezone', () => {
  const client = new CalDAVClient(null, null, {
    username: 'testuser',
    timezone: 'Europe/Lisbon'
  });

  const ics = client._buildICS({
    uid: 'test-uid-789',
    start: new Date('2026-02-10'),
    end: new Date('2026-02-11'),
    summary: 'All Day Event',
    allDay: true
  });

  assert.ok(ics.includes('DTSTART;VALUE=DATE:'), 'All-day events should use DATE format');
  assert.ok(!ics.includes('TZID='), 'All-day events should not include TZID');
});

test('CalDAV constructor stores timezone config', () => {
  const client = new CalDAVClient(null, null, {
    username: 'testuser',
    timezone: 'Asia/Tokyo'
  });

  assert.strictEqual(client.timezone, 'Asia/Tokyo');
});

test('CalDAV constructor defaults to UTC', () => {
  const client = new CalDAVClient(null, null, {
    username: 'testuser'
  });

  assert.strictEqual(client.timezone, 'UTC');
});

// --- iTIP Compliance Tests ---
console.log('\n--- iTIP Compliance Tests ---\n');

test('TC-ITIP-001: _buildICS includes METHOD:REQUEST when attendees present', () => {
  const mockNC = createCalDAVMockNC();
  const client = new CalDAVClient(mockNC, null, { username: 'testuser' });

  const ics = client._buildICS({
    uid: 'itip-test-001',
    summary: 'Team Sync',
    start: new Date('2025-03-01T10:00:00Z'),
    end: new Date('2025-03-01T11:00:00Z'),
    attendees: [
      { email: 'alice@example.com', name: 'Alice' }
    ]
  });

  assert.ok(ics.includes('METHOD:REQUEST'), 'ICS with attendees must include METHOD:REQUEST');
  assert.ok(ics.includes('ORGANIZER'), 'ICS with attendees must include ORGANIZER');
});

test('TC-ITIP-002: _buildICS does NOT include METHOD:REQUEST when no attendees', () => {
  const mockNC = createCalDAVMockNC();
  const client = new CalDAVClient(mockNC, null, { username: 'testuser' });

  const ics = client._buildICS({
    uid: 'itip-test-002',
    summary: 'Solo Focus Time',
    start: new Date('2025-03-01T14:00:00Z'),
    end: new Date('2025-03-01T15:00:00Z')
  });

  assert.ok(!ics.includes('METHOD:REQUEST'), 'ICS without attendees must NOT include METHOD:REQUEST');
});

test('TC-ITIP-003: _buildICS preserves explicit ORGANIZER when attendees present', () => {
  const mockNC = createCalDAVMockNC();
  const client = new CalDAVClient(mockNC, null, { username: 'testuser' });

  const ics = client._buildICS({
    uid: 'itip-test-003',
    summary: 'Organized Meeting',
    start: new Date('2025-03-01T10:00:00Z'),
    end: new Date('2025-03-01T11:00:00Z'),
    organizer: { email: 'boss@example.com', name: 'Boss' },
    attendees: [
      { email: 'alice@example.com', name: 'Alice' }
    ]
  });

  assert.ok(ics.includes('METHOD:REQUEST'), 'Should have METHOD:REQUEST');
  assert.ok(ics.includes('boss@example.com'), 'Should use explicit organizer');
  // Should NOT have a second auto-generated ORGANIZER
  const organizerCount = (ics.match(/ORGANIZER/g) || []).length;
  assert.strictEqual(organizerCount, 1, 'Should have exactly one ORGANIZER line');
});

test('TC-ITIP-004: _buildICS auto-sets ORGANIZER when attendees present but no organizer given', () => {
  const mockNC = createCalDAVMockNC();
  const client = new CalDAVClient(mockNC, null, { username: 'testuser' });

  const ics = client._buildICS({
    uid: 'itip-test-004',
    summary: 'Auto-Org Meeting',
    start: new Date('2025-03-01T10:00:00Z'),
    end: new Date('2025-03-01T11:00:00Z'),
    attendees: [
      { email: 'bob@example.com', name: 'Bob' }
    ]
  });

  assert.ok(ics.includes('ORGANIZER'), 'Should auto-set ORGANIZER when attendees present');
  assert.ok(ics.includes('CN=testuser'), 'Auto-ORGANIZER should use username as CN');
});

// --- Summary ---
setTimeout(() => {
  summary();
  exitWithCode();
}, 100);
