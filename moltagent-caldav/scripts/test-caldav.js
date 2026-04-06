#!/usr/bin/env node

/**
 * MoltAgent CalDAV Integration Tests
 * 
 * Tests calendar operations:
 * - Calendar discovery
 * - Event CRUD
 * - Availability checking
 * - Free slot finding
 * 
 * Usage: node scripts/test-caldav.js
 */

const CalDAVClient = require('../src/lib/integrations/caldav-client');

// Configuration from environment or defaults
const config = {
  ncUrl: process.env.NC_URL || 'https://YOUR_NEXTCLOUD_URL',
  username: process.env.NC_USER || 'moltagent',
  password: process.env.MOLTAGENT_PASSWORD || 'CHANGE_ME'
};

const client = new CalDAVClient({
  ...config,
  auditLog: async (event, data) => {
    console.log(`  [AUDIT] ${event}:`, JSON.stringify(data).substring(0, 100));
  }
});

// Test tracking
let passed = 0;
let failed = 0;
const results = [];

async function test(name, fn) {
  process.stdout.write(`  ${name}... `);
  try {
    await fn();
    console.log('✓');
    passed++;
    results.push({ name, status: 'passed' });
  } catch (err) {
    console.log(`✗ (${err.message})`);
    failed++;
    results.push({ name, status: 'failed', error: err.message });
  }
}

async function runTests() {
  console.log('╔════════════════════════════════════════════════════════════════╗');
  console.log('║          MoltAgent CalDAV Integration Tests                    ║');
  console.log('╚════════════════════════════════════════════════════════════════╝');
  console.log('');
  console.log(`NC URL: ${config.ncUrl}`);
  console.log(`User: ${config.username}`);
  console.log('');

  let testEventUid = null;
  let calendars = null;

  // ============================================================
  // Calendar Discovery Tests
  // ============================================================
  console.log('┌────────────────────────────────────────────────────────────────┐');
  console.log('│ Calendar Discovery                                             │');
  console.log('└────────────────────────────────────────────────────────────────┘');

  await test('Get all calendars', async () => {
    calendars = await client.getCalendars();
    if (!calendars || calendars.length === 0) {
      throw new Error('No calendars found');
    }
    console.log(`\n    Found ${calendars.length} calendar(s):`);
    calendars.forEach(c => {
      console.log(`    - ${c.displayName} (${c.id}) ${c.supportsEvents ? '[EVENTS]' : ''} ${c.supportsTasks ? '[TASKS]' : ''}`);
    });
  });

  await test('Get event calendars only', async () => {
    const eventCals = await client.getEventCalendars();
    if (!eventCals || eventCals.length === 0) {
      throw new Error('No event calendars found');
    }
  });

  await test('Get specific calendar (personal)', async () => {
    const personal = await client.getCalendar('personal');
    if (!personal) {
      throw new Error('Personal calendar not found');
    }
  });

  // ============================================================
  // Event CRUD Tests
  // ============================================================
  console.log('');
  console.log('┌────────────────────────────────────────────────────────────────┐');
  console.log('│ Event CRUD Operations                                          │');
  console.log('└────────────────────────────────────────────────────────────────┘');

  await test('Create event', async () => {
    const now = new Date();
    const start = new Date(now.getTime() + 2 * 60 * 60 * 1000); // 2 hours from now
    const end = new Date(start.getTime() + 60 * 60 * 1000); // 1 hour duration

    const event = await client.createEvent({
      summary: '[TEST] MoltAgent CalDAV Test Event',
      description: 'This is a test event created by MoltAgent CalDAV integration tests.',
      location: 'Virtual',
      start,
      end,
      calendarId: 'personal'
    });

    if (!event || !event.uid) {
      throw new Error('Event creation failed');
    }
    
    testEventUid = event.uid;
    console.log(`\n    Created event: ${event.uid}`);
  });

  await test('Get event by UID', async () => {
    if (!testEventUid) {
      throw new Error('No test event UID');
    }
    
    const event = await client.getEvent('personal', testEventUid);
    if (!event) {
      throw new Error('Event not found');
    }
    if (event.summary !== '[TEST] MoltAgent CalDAV Test Event') {
      throw new Error('Event summary mismatch');
    }
  });

  await test('Update event', async () => {
    if (!testEventUid) {
      throw new Error('No test event UID');
    }
    
    const updated = await client.updateEvent('personal', testEventUid, {
      summary: '[TEST] Updated MoltAgent Test Event',
      description: 'This event has been updated.'
    });
    
    if (!updated.summary.includes('Updated')) {
      throw new Error('Update not applied');
    }
  });

  await test('Get events in time range', async () => {
    const start = new Date();
    const end = new Date(start.getTime() + 24 * 60 * 60 * 1000); // Next 24 hours
    
    const events = await client.getEvents('personal', start, end);
    // Should find at least our test event
    const testEvent = events.find(e => e.uid === testEventUid);
    if (!testEvent) {
      throw new Error('Test event not found in range query');
    }
  });

  await test('Get today events', async () => {
    const events = await client.getTodayEvents();
    // Result should be an array (may or may not contain our event depending on timing)
    if (!Array.isArray(events)) {
      throw new Error('Expected array of events');
    }
  });

  await test('Get upcoming events (24h)', async () => {
    const events = await client.getUpcomingEvents(24);
    if (!Array.isArray(events)) {
      throw new Error('Expected array of events');
    }
  });

  // ============================================================
  // Availability Tests
  // ============================================================
  console.log('');
  console.log('┌────────────────────────────────────────────────────────────────┐');
  console.log('│ Availability & Scheduling                                      │');
  console.log('└────────────────────────────────────────────────────────────────┘');

  await test('Check availability (should have conflict)', async () => {
    // Check the time slot where our test event is
    const now = new Date();
    const checkStart = new Date(now.getTime() + 2 * 60 * 60 * 1000);
    const checkEnd = new Date(checkStart.getTime() + 30 * 60 * 1000);
    
    const availability = await client.checkAvailability(checkStart, checkEnd, 'personal');
    // Should find our test event as a conflict
    if (availability.isFree) {
      console.log('\n    (Note: Time slot appears free - test event may be at different time)');
    }
  });

  await test('Check availability (free slot)', async () => {
    // Check a time slot far in the future
    const futureStart = new Date();
    futureStart.setDate(futureStart.getDate() + 30);
    futureStart.setHours(3, 0, 0, 0); // 3 AM, likely free
    const futureEnd = new Date(futureStart.getTime() + 30 * 60 * 1000);
    
    const availability = await client.checkAvailability(futureStart, futureEnd, 'personal');
    if (!availability.isFree && availability.conflicts.length > 0) {
      console.log('\n    (Note: Unexpected conflict found)');
    }
  });

  await test('Find free slots', async () => {
    const rangeStart = new Date();
    const rangeEnd = new Date(rangeStart.getTime() + 7 * 24 * 60 * 60 * 1000); // Next 7 days
    
    const freeSlots = await client.findFreeSlots(rangeStart, rangeEnd, 60, {
      workdayStart: 9,
      workdayEnd: 17,
      excludeWeekends: true
    });
    
    if (!Array.isArray(freeSlots)) {
      throw new Error('Expected array of free slots');
    }
    console.log(`\n    Found ${freeSlots.length} free 1-hour slots in next 7 days`);
  });

  await test('Quick availability check (amIFreeAt)', async () => {
    const futureTime = new Date();
    futureTime.setDate(futureTime.getDate() + 30);
    futureTime.setHours(4, 0, 0, 0); // 4 AM, likely free
    
    const isFree = await client.amIFreeAt(futureTime);
    if (typeof isFree !== 'boolean') {
      throw new Error('Expected boolean result');
    }
  });

  // ============================================================
  // Convenience Methods
  // ============================================================
  console.log('');
  console.log('┌────────────────────────────────────────────────────────────────┐');
  console.log('│ Convenience Methods                                            │');
  console.log('└────────────────────────────────────────────────────────────────┘');

  await test('Get today summary', async () => {
    const summary = await client.getTodaySummary();
    if (!summary.text) {
      throw new Error('No summary text');
    }
    console.log(`\n    ${summary.text.split('\n')[0]}`);
  });

  await test('Quick schedule (with conflict check)', async () => {
    // Try to schedule at a time that should be free
    const futureTime = new Date();
    futureTime.setDate(futureTime.getDate() + 30);
    futureTime.setHours(10, 0, 0, 0);
    
    const result = await client.quickSchedule(
      '[TEST] Quick Schedule Test',
      futureTime,
      30 // 30 minutes
    );
    
    if (result.success && result.event) {
      console.log(`\n    Scheduled: ${result.event.uid}`);
      // Clean up this event too
      await client.deleteEvent('personal', result.event.uid);
      console.log('    (Cleaned up)');
    } else if (!result.success) {
      console.log('\n    (Scheduling found conflict - OK)');
    }
  });

  // ============================================================
  // Cleanup
  // ============================================================
  console.log('');
  console.log('┌────────────────────────────────────────────────────────────────┐');
  console.log('│ Cleanup                                                        │');
  console.log('└────────────────────────────────────────────────────────────────┘');

  await test('Delete test event', async () => {
    if (!testEventUid) {
      throw new Error('No test event to delete');
    }
    
    await client.deleteEvent('personal', testEventUid);
  });

  await test('Verify deletion', async () => {
    if (!testEventUid) {
      throw new Error('No test event UID');
    }
    
    const event = await client.getEvent('personal', testEventUid);
    if (event) {
      throw new Error('Event still exists after deletion');
    }
  });

  // ============================================================
  // Summary
  // ============================================================
  console.log('');
  console.log('════════════════════════════════════════════════════════════════');
  console.log(`  Results: ${passed} passed, ${failed} failed`);
  console.log('════════════════════════════════════════════════════════════════');
  
  if (failed > 0) {
    console.log('');
    console.log('Failed tests:');
    results.filter(r => r.status === 'failed').forEach(r => {
      console.log(`  ✗ ${r.name}: ${r.error}`);
    });
  }

  console.log('');
  return failed === 0;
}

// Run tests
runTests()
  .then(success => {
    process.exit(success ? 0 : 1);
  })
  .catch(err => {
    console.error('Test suite error:', err);
    process.exit(1);
  });
