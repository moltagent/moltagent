/**
 * caldav-create-test.js
 *
 * Direct CalDAV event creation test — bypasses LLM to isolate CalDAV issues.
 * Verifies: PUT 201, read-back verification, and cleanup via DELETE.
 *
 * Usage:  node test/manual/caldav-create-test.js
 * Requires: NC_URL, NC_USER, NC_PASSWORD (or credential file) in environment.
 */

'use strict';

(async () => {

const GREEN  = '\x1b[32m';
const RED    = '\x1b[31m';
const YELLOW = '\x1b[33m';
const RESET  = '\x1b[0m';

let passed = 0;
let failed = 0;

function ok(label, condition) {
  if (condition) {
    console.log(`${GREEN}  ✓ ${label}${RESET}`);
    passed++;
  } else {
    console.log(`${RED}  ✗ ${label}${RESET}`);
    failed++;
  }
}

function heading(label) {
  console.log(`\n${YELLOW}── ${label} ──${RESET}`);
}

try {
  // Load project modules
  const CONFIG = require('../../src/lib/config');
  const NCRequestManager = require('../../src/lib/nc-request-manager');
  const CredentialBroker = require('../../src/lib/credential-broker');
  const CalDAVClient = require('../../src/lib/integrations/caldav-client');

  heading('Setup');

  const credentialBroker = new CredentialBroker({
    ncUrl: CONFIG.nextcloud.url,
    ncUsername: CONFIG.nextcloud.username,
    auditLog: async () => {}
  });

  const ncPassword = credentialBroker.getNCPassword();
  ok('Credential loaded', !!ncPassword);

  const ncMgr = new NCRequestManager({
    nextcloud: {
      url: CONFIG.nextcloud.url,
      username: CONFIG.nextcloud.username
    }
  });
  ncMgr.ncPassword = ncPassword;
  await ncMgr.resolveCanonicalUsername();
  ok('NCRequestManager ready', !!ncMgr.ncUser);

  const auditEntries = [];
  const cal = new CalDAVClient(ncMgr, credentialBroker, {
    ncUrl: CONFIG.nextcloud.url,
    username: CONFIG.nextcloud.username,
    defaultCalendar: 'personal',
    auditLog: async (event, data) => {
      auditEntries.push({ event, data });
      console.log(`  [Audit] ${event}: ${JSON.stringify(data).substring(0, 120)}`);
    }
  });

  // ── Test 1: Create a future event ──
  heading('Test 1: Create future event');

  const tomorrow = new Date();
  tomorrow.setDate(tomorrow.getDate() + 1);
  tomorrow.setHours(10, 0, 0, 0);
  const endTime = new Date(tomorrow.getTime() + 60 * 60 * 1000); // 1 hour

  let createdEvent;
  try {
    createdEvent = await cal.createEvent({
      summary: 'CalDAV Direct Test',
      start: tomorrow,
      end: endTime,
      description: 'Automated test event — safe to delete'
    });

    ok('Event created', !!createdEvent);
    ok('Has UID', !!createdEvent?.uid);
    ok('Has href', !!createdEvent?.href);
    ok('Verified by read-back', createdEvent?.verified === true);

    console.log(`  UID: ${createdEvent?.uid}`);
    console.log(`  href: ${createdEvent?.href}`);
    console.log(`  verified: ${createdEvent?.verified}`);
  } catch (err) {
    ok(`Create event (ERROR: ${err.message})`, false);
  }

  // ── Test 2: Read back the event independently ──
  heading('Test 2: Independent read-back');

  if (createdEvent?.uid) {
    try {
      const readBack = await cal.getEvent('personal', createdEvent.uid);
      ok('Read-back found event', !!readBack);
      ok('Summary matches', readBack?.summary === 'CalDAV Direct Test');
      ok('UID matches', readBack?.uid === createdEvent.uid);
      console.log(`  Server summary: ${readBack?.summary}`);
      console.log(`  Server UID: ${readBack?.uid}`);
      console.log(`  Server start: ${readBack?.start}`);
    } catch (err) {
      ok(`Read-back (ERROR: ${err.message})`, false);
    }
  } else {
    console.log('  Skipped — no event to read back');
  }

  // ── Test 3: Cleanup ──
  heading('Test 3: Cleanup');

  if (createdEvent?.uid) {
    try {
      await cal.deleteEvent('personal', createdEvent.uid);
      ok('Test event deleted', true);
    } catch (err) {
      console.log(`${YELLOW}  ⚠ Cleanup failed: ${err.message} — manual cleanup needed${RESET}`);
    }
  }

  // ── Test 4: Audit trail ──
  heading('Test 4: Audit trail');

  const createAudit = auditEntries.find(e => e.event === 'caldav_event_created');
  ok('caldav_event_created audit logged', !!createAudit);
  ok('Audit has verified flag', createAudit?.data?.verified !== undefined);

  // ── Summary ──
  heading('Summary');
  console.log(`${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);

} catch (err) {
  console.error(`${RED}Fatal error: ${err.message}${RESET}`);
  console.error(err.stack);
  process.exit(1);
}

})();
