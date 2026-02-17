# Session 26: People Intelligence + Smart Meetings (Foundation Layer)

## Implementation Plan

**Scope:** Foundation layer only. ContactsClient, contacts tools, People page auto-creation, RSVPTracker with HeartbeatManager integration.
**NOT in scope:** MeetingComposer state machine, multi-turn disambiguation, enhanced CalendarHandler, meeting_create tool (those are Session 27).
**Estimated effort:** 3-4 hours
**Date:** 2026-02-09

---

## 1. Files Overview

| # | File Path | Action | Description |
|---|-----------|--------|-------------|
| 1 | `src/lib/integrations/contacts-client.js` | CREATE | CardDAV contacts client. Search, get, parse vCard, TTL cache. |
| 2 | `src/lib/integrations/rsvp-tracker.js` | CREATE | RSVP monitoring. Track pending events, detect PARTSTAT changes, notify via Talk. |
| 3 | `src/lib/agent/tool-registry.js` | MODIFY | Add `_registerContactsTools()` method. Register `contacts_search` and `contacts_get`. Wire into `_registerDefaultTools()`. Accept `contactsClient` in constructor. |
| 4 | `src/lib/integrations/heartbeat-manager.js` | MODIFY | Accept `rsvpTracker` in config. Call `rsvpTracker.checkUpdates()` in `pulse()` at level >= 2. Add `lastRsvpCheck` state field. |
| 5 | `src/lib/config.js` | MODIFY | Add `contacts` config section with `cacheTTLMs`, `addressBook` defaults. Add `cacheTTL.carddav` entry. |
| 6 | `src/lib/nc-request-manager.js` | MODIFY | Add `carddav` endpoint group pattern for `/remote.php/dav/addressbooks/`. |
| 7 | `webhook-server.js` | MODIFY | Import ContactsClient, instantiate, pass to ToolRegistry. Import RSVPTracker, instantiate, pass to HeartbeatManager (via emailMonitor pattern). |
| 8 | `src/bot.js` | MODIFY | Import RSVPTracker, instantiate, pass to HeartbeatManager config. |
| 9 | `test/unit/integrations/contacts-client.test.js` | CREATE | Full unit tests for ContactsClient: constructor, search, get, vCard parsing, caching, error handling. |
| 10 | `test/unit/integrations/rsvp-tracker.test.js` | CREATE | Unit tests for RSVPTracker: trackEvent, checkUpdates, status change detection, notification, cleanup. |
| 11 | `test/unit/agent/contacts-tools.test.js` | CREATE | Unit tests for contacts_search and contacts_get tools via ToolRegistry. |
| 12 | `test/helpers/mock-factories.js` | MODIFY | Add `createMockContactsClient()` and `createMockRSVPTracker()` factories. |
| 13 | `src/security/content-provenance.js` | NO CHANGE | `contacts_search` and `contacts_get` are already listed in `INTERNAL_TOOLS`. No modification needed. |

---

## 2. Phase-by-Phase Implementation

### Phase 1: ContactsClient (CardDAV wrapper)

**File:** `/opt/moltagent/src/lib/integrations/contacts-client.js`
**Pattern:** Follows `collectives-client.js` and `caldav-client.js` structure exactly.

#### Architecture Brief (file header)

```
Problem: MoltAgent cannot resolve human names to email addresses. When a user
says "schedule a meeting with Joao," the agent has no way to find Joao's email.

Pattern: CardDAV REPORT client using NCRequestManager. Search contacts via
addressbook-query, parse vCard responses to extract FN/EMAIL/TEL/ORG fields,
cache results with configurable TTL. People page auto-creation on first
resolution via CollectivesClient.

Key Dependencies:
  - NCRequestManager (all HTTP calls)
  - CollectivesClient (optional, for People page auto-creation)
  - page-templates.js (person template)
  - config.js (contacts.cacheTTLMs, contacts.addressBook)

Data Flow:
  search(query) -> CardDAV REPORT -> _parseMultistatus() -> _parseVCard() -> Contact[]
  resolve(name) -> search() -> 0/1/N match -> { resolved, contact?, options? }
  get(href) -> CardDAV GET -> _parseVCard() -> Contact
```

#### Constructor Signature

```javascript
/**
 * @param {Object} ncRequestManager - NCRequestManager instance
 * @param {Object} [config]
 * @param {string} [config.username] - NC username (for CardDAV path)
 * @param {string} [config.addressBook] - Address book name (default: 'contacts')
 * @param {number} [config.cacheTTLMs] - Cache TTL in ms (default: 3600000 = 1 hour)
 * @param {Object} [config.collectivesClient] - CollectivesClient for People page auto-creation
 * @param {Function} [config.auditLog] - Audit logging function
 */
constructor(ncRequestManager, config = {})
```

#### Key Fields

```javascript
this.nc = ncRequestManager;
this.username = config.username || ncRequestManager.ncUser || 'moltagent';
this.addressBook = config.addressBook || appConfig.contacts?.addressBook || 'contacts';
this.cacheTTLMs = config.cacheTTLMs || appConfig.contacts?.cacheTTLMs || 3600000;
this.collectivesClient = config.collectivesClient || null;
this.auditLog = config.auditLog || (async () => {});

// Cache
this._cache = {
  contacts: null,       // Map<string, Contact> keyed by href
  lastFetched: 0,
  searchIndex: null      // Map<string, Set<href>> normalized name tokens -> hrefs
};
```

#### Method Signatures

```javascript
// === HTTP/CardDAV Layer ===

/**
 * Execute a CardDAV REPORT query for contacts matching a name.
 * Uses addressbook-query with prop-filter on FN (contains match).
 * @param {string} query - Name fragment to search
 * @returns {Promise<Array<Contact>>} Matching contacts
 */
async search(query)
// TODO: Implement -- build XML REPORT body, call _request(), parse multistatus, parse vCards

/**
 * Get a single contact by its CardDAV href.
 * @param {string} href - Full CardDAV href path
 * @returns {Promise<Contact|null>}
 */
async get(href)
// TODO: Implement -- GET the vCard, parse it

/**
 * Resolve a name to a single contact.
 * Returns immediately if exactly one match.
 * Returns disambiguation options if multiple matches.
 * @param {string} name
 * @returns {Promise<{resolved: boolean, contact?: Contact, options?: Contact[], error?: string}>}
 */
async resolve(name)
// TODO: Implement -- call search(), handle 0/1/N cases

/**
 * Fetch all contacts from the address book (for cache warming).
 * Uses PROPFIND to enumerate, then REPORT to fetch address-data.
 * @param {boolean} [forceRefresh=false]
 * @returns {Promise<Array<Contact>>}
 */
async fetchAll(forceRefresh = false)
// TODO: Implement -- full addressbook REPORT, populate cache

/**
 * Force cache invalidation. Call when user says "refresh contacts".
 */
invalidateCache()

// === vCard Parsing (private) ===

/**
 * Parse a multistatus XML response into an array of raw vCard strings.
 * @private
 * @param {string} xml - Raw XML response body
 * @returns {Array<{href: string, etag: string, vcard: string}>}
 */
_parseMultistatus(xml)
// TODO: Implement -- regex extraction similar to caldav-client._parseXML()

/**
 * Parse a single vCard string into a Contact object.
 * Extracts: FN, N, EMAIL (all TYPE variants), TEL, ORG, TITLE, UID, PHOTO (presence only).
 * Handles folded lines (RFC 6350 Section 3.2).
 * @private
 * @param {string} vcardData - Raw vCard text
 * @param {string} [href] - CardDAV href
 * @param {string} [etag] - ETag
 * @returns {Contact}
 */
_parseVCard(vcardData, href = null, etag = null)
// TODO: Implement -- unfold lines, extract fields via regex

/**
 * Unfold vCard continuation lines (lines starting with space/tab).
 * @private
 * @param {string} raw - Raw vCard with possible folded lines
 * @returns {string} Unfolded vCard
 */
_unfoldVCard(raw)

// === CardDAV Request Helpers (private) ===

/**
 * Make a CardDAV request via NCRequestManager.
 * @private
 */
async _request(method, path, { body = null, headers = {}, depth = null } = {})
// Follows caldav-client._request() pattern exactly

// === People Page Auto-Creation (private) ===

/**
 * Create a stub People wiki page for a resolved contact.
 * Only creates if collectivesClient is configured and page doesn't exist.
 * @private
 * @param {Contact} contact - Resolved contact
 * @returns {Promise<void>}
 */
async _ensurePeoplePage(contact)
// TODO: Implement -- check if page exists via collectivesClient.findPageByTitle(),
//       if not, use applyTemplate('person', {...}) and create via wiki
```

#### Contact Type Definition

```javascript
/**
 * @typedef {Object} Contact
 * @property {string} name - Full name (FN)
 * @property {string|null} firstName - Given name (from N)
 * @property {string|null} lastName - Family name (from N)
 * @property {string|null} email - Primary email address
 * @property {Array<{type: string, value: string}>} emails - All email addresses
 * @property {string|null} phone - Primary phone number
 * @property {Array<{type: string, value: string}>} phones - All phone numbers
 * @property {string|null} org - Organization name
 * @property {string|null} title - Job title
 * @property {string|null} uid - vCard UID
 * @property {string|null} href - CardDAV resource href
 * @property {string|null} etag - Resource ETag
 * @property {boolean} hasPhoto - Whether photo is present
 */
```

#### CardDAV XML for Search

The REPORT body for search (from the spec):

```xml
<?xml version="1.0" encoding="UTF-8"?>
<C:addressbook-query xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:carddav">
  <D:prop>
    <D:getetag/>
    <C:address-data/>
  </D:prop>
  <C:filter>
    <C:prop-filter name="FN">
      <C:text-match collation="i;unicode-casemap" match-type="contains">{query}</C:text-match>
    </C:prop-filter>
  </C:filter>
</C:addressbook-query>
```

The CardDAV path is: `/remote.php/dav/addressbooks/users/{username}/{addressBook}/`

---

### Phase 2: RSVPTracker

**File:** `/opt/moltagent/src/lib/integrations/rsvp-tracker.js`

#### Architecture Brief (file header)

```
Problem: After scheduling a meeting with attendees, there is no way to know
if participants accepted, declined, or tentatively accepted. Users must manually
check their calendar app.

Pattern: In-memory tracking of pending events with periodic CalDAV polling.
Compares current PARTSTAT against last-known state. On change, sends proactive
Talk notification. Integrates into HeartbeatManager.pulse() at level >= 2.
Events auto-expire after their end time passes.

Key Dependencies:
  - CalDAVClient (getEvent for PARTSTAT checking)
  - notifyUser function (Talk notifications)
  - auditLog function

Data Flow:
  trackEvent(uid, calendarId, attendees, summary) -> pendingEvents Map
  checkUpdates() -> for each pending: getEvent() -> compare PARTSTAT -> notify
  getStatus(uid) -> current RSVP summary
```

#### Constructor Signature

```javascript
/**
 * @param {Object} config
 * @param {Object} config.caldavClient - CalDAVClient instance
 * @param {Function} config.notifyUser - Notification function (async, receives {type, message, ...})
 * @param {Function} [config.auditLog] - Audit logging function
 * @param {number} [config.checkIntervalMs] - Minimum ms between checks for the same event (default: 300000 = 5min)
 * @param {number} [config.expiryBufferMs] - Time after event end to keep tracking (default: 3600000 = 1hr)
 */
constructor(config)
```

#### Key Fields

```javascript
this.caldavClient = config.caldavClient;
this.notifyUser = config.notifyUser || (async () => {});
this.auditLog = config.auditLog || (async () => {});
this.checkIntervalMs = config.checkIntervalMs || 300000;
this.expiryBufferMs = config.expiryBufferMs || 3600000;

/**
 * @type {Map<string, TrackedEvent>}
 * Key: event UID
 */
this.pendingEvents = new Map();
```

#### TrackedEvent Type

```javascript
/**
 * @typedef {Object} TrackedEvent
 * @property {string} uid - Event UID
 * @property {string} calendarId - Calendar ID where event lives
 * @property {string} summary - Event summary/title
 * @property {string} eventEnd - ISO string of event end time (for expiry)
 * @property {Array<TrackedAttendee>} attendees
 * @property {number} lastChecked - Timestamp of last check (ms)
 * @property {number} trackedSince - Timestamp when tracking started
 */

/**
 * @typedef {Object} TrackedAttendee
 * @property {string} email
 * @property {string} name
 * @property {string} lastStatus - Last known PARTSTAT (NEEDS-ACTION, ACCEPTED, DECLINED, TENTATIVE)
 * @property {string|null} respondedAt - ISO timestamp of when status last changed
 */
```

#### Method Signatures

```javascript
/**
 * Register an event for RSVP tracking.
 * Called after successful meeting creation via scheduleMeeting().
 * @param {string} uid - Event UID
 * @param {string} calendarId - Calendar ID
 * @param {Array<{email: string, name: string}>} attendees - Attendee list
 * @param {string} summary - Event title
 * @param {string} eventEnd - ISO datetime of event end
 */
trackEvent(uid, calendarId, attendees, summary, eventEnd)
// TODO: Implement -- add to pendingEvents Map

/**
 * Untrack an event (e.g., event was cancelled/deleted).
 * @param {string} uid
 * @returns {boolean}
 */
untrackEvent(uid)

/**
 * Check all tracked events for RSVP changes.
 * Called from HeartbeatManager.pulse().
 * Respects checkIntervalMs to avoid hammering CalDAV.
 * @returns {Promise<{checked: number, changes: number, expired: number, errors: string[]}>}
 */
async checkUpdates()
// TODO: Implement -- iterate pendingEvents, getEvent(), compare PARTSTAT, notify, expire

/**
 * Get current RSVP status for a tracked event.
 * @param {string} uid - Event UID
 * @returns {{found: boolean, summary?: string, attendees?: TrackedAttendee[], allResponded?: boolean}}
 */
getStatus(uid)
// TODO: Implement -- look up in pendingEvents, return current state

/**
 * Get summary of all pending events with RSVP tracking.
 * @returns {Array<{uid: string, summary: string, pending: number, accepted: number, declined: number, tentative: number}>}
 */
getPendingSummary()
// TODO: Implement -- iterate pendingEvents, summarize counts

/**
 * Extract PARTSTAT for a specific attendee email from a CalDAV event.
 * @private
 * @param {Object} event - Parsed CalDAV event (from _parseICS)
 * @param {string} email - Attendee email to find
 * @returns {string} PARTSTAT value or 'UNKNOWN'
 */
_extractPartstat(event, email)
// TODO: Implement -- find attendee in event.attendees by email, return status

/**
 * Send proactive notification about an RSVP status change.
 * @private
 * @param {TrackedEvent} tracked - Tracked event
 * @param {TrackedAttendee} attendee - Attendee whose status changed
 * @param {string} oldStatus - Previous PARTSTAT
 * @param {string} newStatus - New PARTSTAT
 */
async _notifyStatusChange(tracked, attendee, oldStatus, newStatus)
// TODO: Implement -- format message with emoji, call notifyUser

/**
 * Remove expired events (event end + buffer has passed).
 * @private
 * @returns {number} Number of events removed
 */
_cleanupExpired()
// TODO: Implement -- check eventEnd + expiryBufferMs against Date.now()

/** @returns {number} Number of events being tracked */
get trackedCount()
```

---

### Phase 3: Tool Registration (contacts_search, contacts_get)

**File:** `/opt/moltagent/src/lib/agent/tool-registry.js`

#### Changes Required

1. **Constructor:** Add `contactsClient` to the destructured options and `this.clients`.

2. **`_registerDefaultTools()`:** Add call to `this._registerContactsTools()`.

3. **New method `_registerContactsTools()`:** Register two tools.

#### Exact Modification Locations

**Location 1: Constructor (line 29)**

Current:
```javascript
constructor({ deckClient, calDAVClient, systemTagsClient, ncRequestManager, ncFilesClient, ncSearchClient, textExtractor, collectivesClient, learningLog, searxngClient, webReader, logger }) {
    this.clients = { deckClient, calDAVClient, systemTagsClient, ncRequestManager, ncFilesClient, ncSearchClient, textExtractor, collectivesClient, learningLog, searxngClient, webReader };
```

Change to:
```javascript
constructor({ deckClient, calDAVClient, systemTagsClient, ncRequestManager, ncFilesClient, ncSearchClient, textExtractor, collectivesClient, learningLog, searxngClient, webReader, contactsClient, logger }) {
    this.clients = { deckClient, calDAVClient, systemTagsClient, ncRequestManager, ncFilesClient, ncSearchClient, textExtractor, collectivesClient, learningLog, searxngClient, webReader, contactsClient };
```

**Location 2: `_registerDefaultTools()` (line 115, after `_registerWebTools()`)**

Add `this._registerContactsTools();` after `this._registerWebTools();`.

**Location 3: New method `_registerContactsTools()` (insert after `_registerWebTools()` closing brace)**

#### Tool Definitions

```javascript
// ---- CONTACTS TOOLS -------------------------------------------------------

/** @private */
_registerContactsTools() {
  const contacts = this.clients.contactsClient;
  if (!contacts) return;

  this.register({
    name: 'contacts_search',
    description: 'Search Nextcloud Contacts (address book) by name. Returns matching contacts with name, email, phone, and organization. Use when you need to find someone\'s email or contact details.',
    parameters: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'Name or partial name to search for (e.g. "Joao", "Silva", "Joao Silva")'
        }
      },
      required: ['query']
    },
    handler: async (args) => {
      // TODO: Implement -- call contacts.search(args.query)
      // Format results as readable text with name, email, org, phone
      // Handle 0 results: "No contacts found matching ..."
      // Handle 1 result: "Found: Name <email> (Org)"
      // Handle N results: numbered list "1. Name <email> (Org)\n2. ..."
      // Include href in output for contacts_get follow-up
      throw new Error('Not implemented');
    }
  });

  this.register({
    name: 'contacts_get',
    description: 'Get full details for a specific contact by their CardDAV href. Use after contacts_search to get complete contact information.',
    parameters: {
      type: 'object',
      properties: {
        href: {
          type: 'string',
          description: 'CardDAV href path returned from contacts_search'
        }
      },
      required: ['href']
    },
    handler: async (args) => {
      // TODO: Implement -- call contacts.get(args.href)
      // Format full contact details: name, all emails, all phones, org, title
      // Return "Contact not found" if null
      throw new Error('Not implemented');
    }
  });
}
```

---

### Phase 4: HeartbeatManager Integration (RSVPTracker)

**File:** `/opt/moltagent/src/lib/integrations/heartbeat-manager.js`

#### Changes Required

**Location 1: Constructor (after `this.emailMonitor = config.emailMonitor || null;` at line 100)**

Add:
```javascript
// RSVP tracking (optional, for meeting attendance monitoring)
this.rsvpTracker = config.rsvpTracker || null;
```

**Location 2: State object (after `emailsProcessedToday: 0` at line 124)**

Add:
```javascript
lastRsvpCheck: null,
rsvpChangesToday: 0,
```

**Location 3: `pulse()` method -- after email check block (after line 318), before knowledge board block**

Insert:
```javascript
      // Level >= 2: RSVP tracking
      if (level >= 2 && this.rsvpTracker && this.rsvpTracker.trackedCount > 0) {
        try {
          results.rsvp = await this.rsvpTracker.checkUpdates();
          this.state.lastRsvpCheck = new Date();
          this.state.rsvpChangesToday += results.rsvp?.changes || 0;
        } catch (err) {
          console.error('[Heartbeat] RSVP check error:', err.message);
          results.errors.push({ component: 'rsvp', error: err.message });
        }
      }
```

**Location 4: Audit log in `pulse()` (line 349 area)**

Add to the auditLog call object:
```javascript
rsvpChecked: results.rsvp?.checked || 0,
rsvpChanges: results.rsvp?.changes || 0,
```

**Location 5: `getStatus()` method (after `emailsProcessedToday` line ~698)**

Add:
```javascript
lastRsvpCheck: this.state.lastRsvpCheck,
rsvpChangesToday: this.state.rsvpChangesToday,
rsvpTracked: this.rsvpTracker ? this.rsvpTracker.trackedCount : 0,
```

**Location 6: `resetDailyCounters()` (after `this.state.flowEventsProcessedToday = 0;` at line 714)**

Add:
```javascript
this.state.rsvpChangesToday = 0;
```

---

### Phase 5: Config Updates

**File:** `/opt/moltagent/src/lib/config.js`

Add contacts section after the `search` section (after line 345, before the timezone line):

```javascript
  // -------------------------------------------------------------------------
  // Contacts (CardDAV)
  // -------------------------------------------------------------------------
  contacts: {
    addressBook: envStr('CONTACTS_ADDRESS_BOOK', 'contacts'),
    cacheTTLMs: envInt('CONTACTS_CACHE_TTL', 3600000),  // 1 hour
  },
```

Add `carddav` to cacheTTL section (after the `collectives` line at line 276):

```javascript
    carddav: envInt('CACHE_TTL_CARDDAV', 60 * 1000),          // 1 minute
```

**File:** `/opt/moltagent/src/lib/nc-request-manager.js`

Add to ENDPOINT_GROUPS (after `caldav` entry at line 37):

```javascript
  carddav: {
    pattern: /\/remote\.php\/dav\/addressbooks\//,
    cacheTTL: appConfig.cacheTTL.carddav,
    priority: 'normal',
    maxRetries: appConfig.resilience.maxRetries
  },
```

---

### Phase 6: Wiring (webhook-server.js and bot.js)

#### webhook-server.js

**Location 1: Import ContactsClient (after CollectivesClient import block, ~line 119)**

```javascript
let ContactsClient;
try {
  ContactsClient = require('./src/lib/integrations/contacts-client');
} catch {
  console.warn('[WARN] ContactsClient not available');
  ContactsClient = null;
}
```

**Location 2: Import RSVPTracker (after ContactsClient import)**

```javascript
let RSVPTracker;
try {
  RSVPTracker = require('./src/lib/integrations/rsvp-tracker');
} catch {
  console.warn('[WARN] RSVPTracker not available');
  RSVPTracker = null;
}
```

**Location 3: Global variable declarations (after `let collectivesClient = null;` at ~line 207)**

Add:
```javascript
let contactsClient = null;
let rsvpTracker = null;
```

**Location 4: Initialize ContactsClient (after CollectivesClient init block at ~line 451)**

```javascript
  // 7b5. Initialize ContactsClient (CardDAV contacts)
  if (ContactsClient && ncRequestManager) {
    try {
      contactsClient = new ContactsClient(ncRequestManager, {
        collectivesClient: collectivesClient,
        auditLog: auditLogger ? auditLogger.log.bind(auditLogger) : consoleAuditLog
      });
      console.log('[INIT] ContactsClient ready');
    } catch (err) {
      console.warn(`[INIT] ContactsClient failed: ${err.message}`);
    }
  }
```

**Location 5: Initialize RSVPTracker (after ContactsClient init)**

```javascript
  // 7b6. Initialize RSVPTracker
  if (RSVPTracker && caldavClient) {
    try {
      rsvpTracker = new RSVPTracker({
        caldavClient: caldavClient,
        notifyUser: async (notification) => {
          if (defaultTalkToken && talkQueue) {
            await talkQueue.enqueue(defaultTalkToken, notification.message);
          }
        },
        auditLog: auditLogger ? auditLogger.log.bind(auditLogger) : consoleAuditLog
      });
      console.log('[INIT] RSVPTracker ready');
    } catch (err) {
      console.warn(`[INIT] RSVPTracker failed: ${err.message}`);
    }
  }
```

**Location 6: Pass contactsClient to ToolRegistry (in the ToolRegistry constructor at ~line 589)**

Add `contactsClient: contactsClient,` to the ToolRegistry constructor options object.

#### bot.js

**Location 1: Import RSVPTracker (after existing requires, ~line 23)**

```javascript
let RSVPTracker;
try {
  RSVPTracker = require('./lib/integrations/rsvp-tracker');
} catch {
  console.warn('[WARN] RSVPTracker not available');
  RSVPTracker = null;
}
```

**Location 2: Create RSVPTracker and pass to HeartbeatManager**

After the HeartbeatManager is constructed (~line 314), inject the RSVPTracker:

```javascript
  // Initialize RSVPTracker (uses heartbeat's internal CalDAV client)
  if (RSVPTracker && heartbeat.caldavClient) {
    try {
      const rsvpTracker = new RSVPTracker({
        caldavClient: heartbeat.caldavClient,
        notifyUser: notifyUser,
        auditLog: auditLog
      });
      heartbeat.rsvpTracker = rsvpTracker;
      console.log('[INIT] RSVPTracker ready');
    } catch (err) {
      console.warn(`[INIT] RSVPTracker failed: ${err.message}`);
    }
  }
```

---

## 3. Dependency Map (Implementation Order)

```
Phase 1 (no deps):
  config.js modifications
  nc-request-manager.js (add carddav endpoint group)

Phase 2 (depends on Phase 1):
  contacts-client.js (CREATE) -- depends on config.js, nc-request-manager

Phase 3 (depends on Phase 2):
  rsvp-tracker.js (CREATE) -- depends on caldav-client (already exists)

Phase 4 (depends on Phase 2, 3):
  tool-registry.js (MODIFY) -- depends on contacts-client
  heartbeat-manager.js (MODIFY) -- depends on rsvp-tracker

Phase 5 (depends on Phase 2, 3, 4):
  mock-factories.js (MODIFY) -- depends on contacts-client, rsvp-tracker
  test files (CREATE) -- depends on everything above

Phase 6 (depends on all):
  webhook-server.js (MODIFY) -- wiring
  bot.js (MODIFY) -- wiring
```

Recommended implementation order:
1. `src/lib/config.js` + `src/lib/nc-request-manager.js` (config only)
2. `src/lib/integrations/contacts-client.js` (core module)
3. `src/lib/integrations/rsvp-tracker.js` (core module)
4. `src/lib/agent/tool-registry.js` (add contacts tools)
5. `src/lib/integrations/heartbeat-manager.js` (add RSVP pulse)
6. `test/helpers/mock-factories.js` (test infrastructure)
7. `test/unit/integrations/contacts-client.test.js`
8. `test/unit/integrations/rsvp-tracker.test.js`
9. `test/unit/agent/contacts-tools.test.js`
10. `webhook-server.js` + `src/bot.js` (wiring)

---

## 4. Detailed File Skeletons

### 4.1 contacts-client.js Skeleton

```javascript
/**
 * MoltAgent CardDAV Contacts Client
 *
 * Architecture Brief:
 * -------------------
 * Problem: MoltAgent cannot resolve human names to email addresses for
 * meeting scheduling and people intelligence.
 *
 * Pattern: CardDAV REPORT client using NCRequestManager. Searches contacts
 * via addressbook-query, parses vCard responses (FN, EMAIL, TEL, ORG),
 * caches results with TTL. Optionally creates stub People wiki pages
 * on first contact resolution.
 *
 * Key Dependencies:
 *   - NCRequestManager (HTTP transport)
 *   - CollectivesClient (optional, People page auto-creation)
 *   - page-templates.js (person template)
 *   - config.js (contacts section)
 *
 * Data Flow:
 *   search(query) -> CardDAV REPORT -> _parseMultistatus -> _parseVCard -> Contact[]
 *   resolve(name) -> search() -> 0/1/N -> {resolved, contact?, options?}
 *
 * Dependency Map:
 *   contacts-client.js depends on: nc-request-manager, config
 *   Used by: tool-registry.js (contacts_search, contacts_get handlers)
 *   Optionally uses: collectives-client, page-templates
 *
 * @module integrations/contacts-client
 * @version 1.0.0
 */

'use strict';

const appConfig = require('../config');

class ContactsClientError extends Error {
  constructor(message, statusCode = 0, response = null) {
    super(message);
    this.name = 'ContactsClientError';
    this.statusCode = statusCode;
    this.response = response;
  }
}

class ContactsClient {
  /**
   * @param {Object} ncRequestManager - NCRequestManager instance
   * @param {Object} [config]
   * @param {string} [config.username] - NC username (for CardDAV path)
   * @param {string} [config.addressBook] - Address book name (default: 'contacts')
   * @param {number} [config.cacheTTLMs] - Cache TTL in ms (default: 3600000 = 1 hour)
   * @param {Object} [config.collectivesClient] - CollectivesClient for People page auto-creation
   * @param {Function} [config.auditLog] - Audit logging function
   */
  constructor(ncRequestManager, config = {}) {
    if (!ncRequestManager || typeof ncRequestManager.request !== 'function') {
      throw new Error('ContactsClient requires an NCRequestManager instance');
    }

    this.nc = ncRequestManager;
    this.username = config.username || ncRequestManager.ncUser || 'moltagent';
    this.addressBook = config.addressBook || appConfig.contacts?.addressBook || 'contacts';
    this.cacheTTLMs = config.cacheTTLMs || appConfig.contacts?.cacheTTLMs || 3600000;
    this.collectivesClient = config.collectivesClient || null;
    this.auditLog = config.auditLog || (async () => {});

    // Cache
    this._cache = {
      contacts: new Map(),     // href -> Contact
      lastFetched: 0,
      nameIndex: new Map()     // lowercase token -> Set<href>
    };
  }

  // =========================================================================
  // Public API
  // =========================================================================

  /**
   * Search contacts by name fragment.
   * @param {string} query - Name or partial name to search
   * @returns {Promise<Array<Contact>>}
   */
  async search(query) {
    // TODO: Implement -- Build addressbook-query XML with FN prop-filter,
    //       POST REPORT to /remote.php/dav/addressbooks/users/{username}/{addressBook}/,
    //       parse multistatus, parse each vCard. Update cache with results.
    //       Log via auditLog('contacts_searched', { query, count }).
    throw new Error('Not implemented');
  }

  /**
   * Get a single contact by CardDAV href.
   * @param {string} href - Full CardDAV href path
   * @returns {Promise<Contact|null>}
   */
  async get(href) {
    // TODO: Implement -- Check cache first. If miss, GET the href,
    //       parse vCard. Return Contact or null on 404.
    throw new Error('Not implemented');
  }

  /**
   * Resolve a name to a single contact.
   * @param {string} name
   * @returns {Promise<{resolved: boolean, contact?: Contact, options?: Contact[], error?: string}>}
   */
  async resolve(name) {
    // TODO: Implement -- call search(name).
    //       0 matches: { resolved: false, error: 'no_match' }
    //       1 match: call _ensurePeoplePage(contact), { resolved: true, contact }
    //       N matches: { resolved: false, options: matches }
    throw new Error('Not implemented');
  }

  /**
   * Fetch all contacts for cache warming.
   * @param {boolean} [forceRefresh=false]
   * @returns {Promise<Array<Contact>>}
   */
  async fetchAll(forceRefresh = false) {
    // TODO: Implement -- If cache valid and !forceRefresh, return from cache.
    //       Otherwise, REPORT with no filter to get all contacts.
    //       Populate _cache.contacts and build _cache.nameIndex.
    throw new Error('Not implemented');
  }

  /**
   * Force cache invalidation.
   */
  invalidateCache() {
    this._cache.contacts.clear();
    this._cache.lastFetched = 0;
    this._cache.nameIndex.clear();
  }

  // =========================================================================
  // CardDAV HTTP Layer (private)
  // =========================================================================

  /**
   * Make a CardDAV request via NCRequestManager.
   * @private
   */
  async _request(method, path, { body = null, headers = {}, depth = null } = {}) {
    const requestHeaders = {
      'Content-Type': 'application/xml; charset=utf-8',
      ...headers
    };

    if (depth !== null) {
      requestHeaders['Depth'] = depth.toString();
    }

    const response = await this.nc.request(path, {
      method,
      headers: requestHeaders,
      body
    });

    return {
      status: response.status,
      headers: response.headers,
      body: typeof response.body === 'string' ? response.body : JSON.stringify(response.body)
    };
  }

  // =========================================================================
  // vCard Parsing (private)
  // =========================================================================

  /**
   * Parse multistatus XML into vCard entries.
   * @private
   * @param {string} xml
   * @returns {Array<{href: string, etag: string, vcard: string}>}
   */
  _parseMultistatus(xml) {
    // TODO: Implement -- Extract <d:response> blocks via regex.
    //       For each: extract <d:href>, <d:getetag>, <card:address-data>.
    //       Decode XML entities in address-data.
    //       Return array of {href, etag, vcard} objects.
    throw new Error('Not implemented');
  }

  /**
   * Parse a single vCard string into a Contact object.
   * @private
   * @param {string} vcardData
   * @param {string} [href]
   * @param {string} [etag]
   * @returns {Contact}
   */
  _parseVCard(vcardData, href = null, etag = null) {
    // TODO: Implement -- Call _unfoldVCard() first.
    //       Extract FN via /^FN[;:](.*)$/m
    //       Extract N via /^N[;:](.*)$/m -> split by ; -> [family, given, ...]
    //       Extract all EMAIL lines -> parse TYPE param and value
    //       Extract all TEL lines -> parse TYPE param and value
    //       Extract ORG via /^ORG[;:](.*)$/m
    //       Extract TITLE via /^TITLE[;:](.*)$/m
    //       Extract UID via /^UID[;:](.*)$/m
    //       Check PHOTO presence via /^PHOTO/m
    //       Return Contact object.
    throw new Error('Not implemented');
  }

  /**
   * Unfold vCard continuation lines.
   * @private
   * @param {string} raw
   * @returns {string}
   */
  _unfoldVCard(raw) {
    // TODO: Implement -- return raw.replace(/\r?\n[ \t]/g, '');
    throw new Error('Not implemented');
  }

  /**
   * Decode XML entities.
   * @private
   */
  _decodeXMLEntities(text) {
    return text
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&amp;/g, '&')
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'");
  }

  // =========================================================================
  // People Page Auto-Creation (private)
  // =========================================================================

  /**
   * Create stub People wiki page for a resolved contact. Best-effort.
   * @private
   * @param {Contact} contact
   */
  async _ensurePeoplePage(contact) {
    // TODO: Implement --
    //   1. If !this.collectivesClient, return silently.
    //   2. Try collectivesClient.findPageByTitle(contact.name).
    //   3. If page exists, return.
    //   4. Use applyTemplate('person', { title: contact.name, role: contact.title || '' })
    //      from page-templates.js.
    //   5. Enhance template body by replacing contact section placeholder with real data.
    //   6. Call collectivesClient.resolveCollective() to get collectiveId.
    //   7. Find "People" parent page from listPages().
    //   8. Call collectivesClient.createPage(collectiveId, peopleParentId, contact.name).
    //   9. Call collectivesClient.writePageContent(path, content).
    //   10. Catch all errors, log warning, never throw.
  }

  // =========================================================================
  // Cache Helpers (private)
  // =========================================================================

  /** @private */
  _isCacheValid() {
    return this._cache.lastFetched > 0 &&
           (Date.now() - this._cache.lastFetched) < this.cacheTTLMs;
  }

  /**
   * Update cache with new contact list.
   * @private
   * @param {Array<Contact>} contacts
   */
  _updateCache(contacts) {
    // TODO: Implement -- Clear existing maps. For each contact:
    //   - Add to this._cache.contacts keyed by href.
    //   - Tokenize name to lowercase words, add each token -> Set<href>
    //     in this._cache.nameIndex.
    //   - Set this._cache.lastFetched = Date.now().
  }

  /**
   * Search local cache by query string.
   * @private
   * @param {string} query
   * @returns {Array<Contact>}
   */
  _searchCache(query) {
    // TODO: Implement -- Tokenize query. For each token, find Set<href>
    //       from nameIndex. Intersect sets for multi-word. Return Contact[]
    //       from contacts Map.
    return [];
  }
}

module.exports = ContactsClient;
module.exports.ContactsClientError = ContactsClientError;
```

### 4.2 rsvp-tracker.js Skeleton

```javascript
/**
 * MoltAgent RSVP Tracker
 *
 * Architecture Brief:
 * -------------------
 * Problem: After scheduling a meeting with attendees, there is no mechanism
 * to detect when participants respond (accept/decline/tentative) and proactively
 * notify the user.
 *
 * Pattern: In-memory Map of tracked events. On each heartbeat pulse, queries
 * CalDAV for current PARTSTAT values and compares against last-known state.
 * On change, sends a Talk notification. Auto-expires events after they end.
 *
 * Key Dependencies:
 *   - CalDAVClient.getEvent() (reads PARTSTAT from ATTENDEE properties)
 *   - notifyUser function (Talk notifications)
 *   - HeartbeatManager (calls checkUpdates() in pulse())
 *
 * Data Flow:
 *   trackEvent() -> pendingEvents Map
 *   checkUpdates() -> CalDAV getEvent() -> compare PARTSTAT -> notifyUser()
 *   getStatus() -> read from pendingEvents Map
 *
 * Dependency Map:
 *   rsvp-tracker.js depends on: caldav-client
 *   Used by: heartbeat-manager.js (pulse), tool-registry (future meeting_rsvp_status tool)
 *
 * @module integrations/rsvp-tracker
 * @version 1.0.0
 */

'use strict';

class RSVPTracker {
  /**
   * @param {Object} config
   * @param {Object} config.caldavClient - CalDAVClient instance
   * @param {Function} config.notifyUser - Notification function
   * @param {Function} [config.auditLog] - Audit logging function
   * @param {number} [config.checkIntervalMs] - Min ms between checks per event (default: 300000)
   * @param {number} [config.expiryBufferMs] - Ms after event end to keep tracking (default: 3600000)
   */
  constructor(config = {}) {
    if (!config.caldavClient) {
      throw new Error('RSVPTracker requires a CalDAVClient instance');
    }

    this.caldavClient = config.caldavClient;
    this.notifyUser = config.notifyUser || (async () => {});
    this.auditLog = config.auditLog || (async () => {});
    this.checkIntervalMs = config.checkIntervalMs || 300000;
    this.expiryBufferMs = config.expiryBufferMs || 3600000;

    /** @type {Map<string, TrackedEvent>} */
    this.pendingEvents = new Map();
  }

  // =========================================================================
  // Public API
  // =========================================================================

  /**
   * Register an event for RSVP tracking.
   * @param {string} uid
   * @param {string} calendarId
   * @param {Array<{email: string, name: string}>} attendees
   * @param {string} summary
   * @param {string} eventEnd - ISO datetime
   */
  trackEvent(uid, calendarId, attendees, summary, eventEnd) {
    // TODO: Implement -- Create TrackedEvent, add to this.pendingEvents.
    //       Each attendee starts with lastStatus = 'NEEDS-ACTION', respondedAt = null.
    //       Set lastChecked = 0, trackedSince = Date.now().
    throw new Error('Not implemented');
  }

  /**
   * Stop tracking an event.
   * @param {string} uid
   * @returns {boolean} True if event was being tracked
   */
  untrackEvent(uid) {
    // TODO: Implement -- return this.pendingEvents.delete(uid)
    throw new Error('Not implemented');
  }

  /**
   * Check all tracked events for PARTSTAT changes.
   * @returns {Promise<{checked: number, changes: number, expired: number, errors: string[]}>}
   */
  async checkUpdates() {
    // TODO: Implement --
    //   1. const expired = this._cleanupExpired();
    //   2. For each (uid, tracked) in pendingEvents:
    //      a. Skip if Date.now() - tracked.lastChecked < this.checkIntervalMs
    //      b. Try: event = await this.caldavClient.getEvent(tracked.calendarId, uid)
    //      c. If event null -> this.untrackEvent(uid), continue
    //      d. For each attendee in tracked.attendees:
    //         - currentStatus = this._extractPartstat(event, attendee.email)
    //         - If currentStatus !== attendee.lastStatus && currentStatus !== 'UNKNOWN':
    //           - await this._notifyStatusChange(tracked, attendee, attendee.lastStatus, currentStatus)
    //           - attendee.lastStatus = currentStatus
    //           - attendee.respondedAt = new Date().toISOString()
    //           - changes++
    //      e. tracked.lastChecked = Date.now()
    //      f. If all attendees have lastStatus !== 'NEEDS-ACTION':
    //         - this.pendingEvents.delete(uid) (all responded)
    //   3. Return { checked, changes, expired, errors }
    throw new Error('Not implemented');
  }

  /**
   * Get RSVP status for a specific event.
   * @param {string} uid
   * @returns {{found: boolean, summary?: string, attendees?: Array, allResponded?: boolean}}
   */
  getStatus(uid) {
    // TODO: Implement -- Look up uid in pendingEvents.
    //       Return { found: false } if missing.
    //       Return { found: true, summary, attendees: [...], allResponded } if found.
    throw new Error('Not implemented');
  }

  /**
   * Summary of all pending tracked events.
   * @returns {Array<{uid: string, summary: string, pending: number, accepted: number, declined: number, tentative: number}>}
   */
  getPendingSummary() {
    // TODO: Implement -- Iterate pendingEvents, count statuses per event.
    throw new Error('Not implemented');
  }

  /** @returns {number} */
  get trackedCount() {
    return this.pendingEvents.size;
  }

  // =========================================================================
  // Private Helpers
  // =========================================================================

  /**
   * Extract PARTSTAT for an attendee email from a parsed CalDAV event.
   * @private
   * @param {Object} event - Parsed event with attendees array
   * @param {string} email
   * @returns {string} PARTSTAT or 'UNKNOWN'
   */
  _extractPartstat(event, email) {
    // TODO: Implement -- Normalize both emails (lowercase, strip mailto:).
    //       Find matching attendee in event.attendees.
    //       Return attendee.status or 'UNKNOWN'.
    throw new Error('Not implemented');
  }

  /**
   * Notify user about an RSVP status change.
   * @private
   */
  async _notifyStatusChange(tracked, attendee, oldStatus, newStatus) {
    // TODO: Implement --
    //   const emoji = { ACCEPTED: 'checkmark', DECLINED: 'X', TENTATIVE: 'warning' }
    //   Build message: "{emoji} {name} {status} the **{summary}** meeting."
    //   If DECLINED: append suggestion to find new time or proceed without.
    //   Call this.notifyUser({ type: 'rsvp_update', urgency: ..., message, event: tracked })
    //   Call this.auditLog('rsvp_status_change', { uid, email, oldStatus, newStatus })
    throw new Error('Not implemented');
  }

  /**
   * Remove events past their end time + buffer.
   * @private
   * @returns {number} Count of removed events
   */
  _cleanupExpired() {
    // TODO: Implement --
    //   const now = Date.now();
    //   let removed = 0;
    //   for (const [uid, tracked] of this.pendingEvents) {
    //     const endMs = new Date(tracked.eventEnd).getTime();
    //     if (endMs + this.expiryBufferMs < now) {
    //       this.pendingEvents.delete(uid);
    //       removed++;
    //     }
    //   }
    //   return removed;
    throw new Error('Not implemented');
  }
}

module.exports = RSVPTracker;
```

---

## 5. Test Plan

### 5.1 contacts-client.test.js

**File:** `/opt/moltagent/test/unit/integrations/contacts-client.test.js`
**Run:** `node test/unit/integrations/contacts-client.test.js`

Test cases:

| # | Test Name | Type | Description |
|---|-----------|------|-------------|
| 1 | constructor requires NCRequestManager | sync | Throws if null passed |
| 2 | constructor accepts config | sync | Validates username, addressBook, cacheTTLMs are set |
| 3 | search returns matching contacts | async | Mock REPORT response with 2 vCards, verify parsed contacts |
| 4 | search returns empty array for no matches | async | Mock REPORT with empty multistatus |
| 5 | search handles server error gracefully | async | Mock 500 response, verify error thrown |
| 6 | get returns single contact by href | async | Mock GET vCard response, verify parsed contact |
| 7 | get returns null for 404 | async | Mock 404 response |
| 8 | resolve returns resolved:true for single match | async | 1 search result |
| 9 | resolve returns options for multiple matches | async | 3 search results |
| 10 | resolve returns error for no match | async | 0 search results |
| 11 | _parseVCard extracts FN, EMAIL, TEL, ORG | sync | Sample vCard string |
| 12 | _parseVCard handles multiple emails | sync | vCard with WORK and HOME emails |
| 13 | _parseVCard handles folded lines | sync | vCard with line continuations |
| 14 | _parseVCard handles minimal vCard | sync | Only FN and VERSION |
| 15 | _parseMultistatus extracts vCards from XML | sync | Sample multistatus response |
| 16 | _unfoldVCard unfolds continuation lines | sync | Input with CRLF+space |
| 17 | cache is used on second search call | async | Verify only 1 HTTP call for 2 searches |
| 18 | invalidateCache clears cache | sync | After invalidate, cache reports empty |
| 19 | _ensurePeoplePage creates wiki page (with collectivesClient) | async | Mock collectivesClient, verify createPage called |
| 20 | _ensurePeoplePage skips if no collectivesClient | async | No error when collectivesClient is null |

#### Sample vCard fixtures for tests

```javascript
const SAMPLE_VCARD = `BEGIN:VCARD\r\nVERSION:3.0\r\nFN:Joao Silva\r\nN:Silva;Joao;;;\r\nEMAIL;TYPE=WORK:joao.silva@company.pt\r\nEMAIL;TYPE=HOME:joao@personal.pt\r\nORG:Company Name\r\nTEL;TYPE=WORK:+351 912 345 678\r\nTITLE:Engineering Manager\r\nUID:1234-5678-abcd\r\nEND:VCARD`;

const SAMPLE_MULTISTATUS = `<?xml version="1.0" encoding="UTF-8"?>\n<d:multistatus xmlns:d="DAV:" xmlns:card="urn:ietf:params:xml:ns:carddav">\n  <d:response>\n    <d:href>/remote.php/dav/addressbooks/users/moltagent/contacts/1234.vcf</d:href>\n    <d:propstat>\n      <d:prop>\n        <d:getetag>"etag-1234"</d:getetag>\n        <card:address-data>BEGIN:VCARD\nVERSION:3.0\nFN:Joao Silva\nEMAIL;TYPE=WORK:joao.silva@company.pt\nEND:VCARD</card:address-data>\n      </d:prop>\n      <d:status>HTTP/1.1 200 OK</d:status>\n    </d:propstat>\n  </d:response>\n</d:multistatus>`;
```

### 5.2 rsvp-tracker.test.js

**File:** `/opt/moltagent/test/unit/integrations/rsvp-tracker.test.js`
**Run:** `node test/unit/integrations/rsvp-tracker.test.js`

Test cases:

| # | Test Name | Type | Description |
|---|-----------|------|-------------|
| 1 | constructor requires caldavClient | sync | Throws if missing |
| 2 | trackEvent adds to pendingEvents | sync | Verify trackedCount increments |
| 3 | trackEvent initializes attendees as NEEDS-ACTION | sync | Check attendee lastStatus |
| 4 | untrackEvent removes from pendingEvents | sync | Verify trackedCount decrements |
| 5 | untrackEvent returns false for unknown uid | sync | Non-existent uid |
| 6 | getStatus returns found:false for unknown | sync | Non-tracked uid |
| 7 | getStatus returns attendee details for tracked event | sync | After trackEvent |
| 8 | checkUpdates detects ACCEPTED change | async | Mock getEvent returning ACCEPTED PARTSTAT |
| 9 | checkUpdates detects DECLINED change | async | Mock getEvent returning DECLINED |
| 10 | checkUpdates sends notification on change | async | Verify notifyUser called with correct message |
| 11 | checkUpdates handles deleted event (null) | async | Mock getEvent returning null |
| 12 | checkUpdates respects checkIntervalMs | async | Second check within interval is skipped |
| 13 | _cleanupExpired removes past events | sync | Set eventEnd to past, verify removal |
| 14 | _cleanupExpired keeps future events | sync | Set eventEnd to future, verify retained |
| 15 | _extractPartstat finds attendee by email | sync | Event with 3 attendees |
| 16 | _extractPartstat returns UNKNOWN for missing email | sync | Email not in attendees |
| 17 | getPendingSummary returns counts per event | sync | Multiple tracked events |
| 18 | checkUpdates removes event when all responded | async | All attendees ACCEPTED |
| 19 | notification message includes correct status text for ACCEPTED | async | Verify message format |
| 20 | notification message includes suggestion for DECLINED | async | Verify message includes "find a new time" |

### 5.3 contacts-tools.test.js

**File:** `/opt/moltagent/test/unit/agent/contacts-tools.test.js`
**Run:** `node test/unit/agent/contacts-tools.test.js`

Test cases:

| # | Test Name | Type | Description |
|---|-----------|------|-------------|
| 1 | contacts_search tool is registered when contactsClient provided | sync | Check toolRegistry.has('contacts_search') |
| 2 | contacts_search tool is NOT registered without contactsClient | sync | Null contactsClient |
| 3 | contacts_search returns formatted results | async | Mock search returning 2 contacts |
| 4 | contacts_search returns "no contacts found" for empty | async | Mock search returning [] |
| 5 | contacts_get tool is registered | sync | Check toolRegistry.has('contacts_get') |
| 6 | contacts_get returns formatted contact details | async | Mock get returning full contact |
| 7 | contacts_get returns "not found" for null | async | Mock get returning null |

### 5.4 mock-factories.js additions

Add two new factory functions at the end of the file:

```javascript
// ContactsClient Mock
function createMockContactsClient(responses = {}) {
  return {
    search: async (query) => responses.search || [],
    get: async (href) => responses.get || null,
    resolve: async (name) => responses.resolve || { resolved: false, error: 'no_match' },
    fetchAll: async () => responses.fetchAll || [],
    invalidateCache: () => {},
    _ensurePeoplePage: async () => {}
  };
}

// RSVPTracker Mock
function createMockRSVPTracker(responses = {}) {
  const pendingEvents = new Map();
  return {
    trackEvent: (uid, calId, attendees, summary, eventEnd) => {
      pendingEvents.set(uid, { uid, calendarId: calId, attendees, summary, eventEnd });
    },
    untrackEvent: (uid) => pendingEvents.delete(uid),
    checkUpdates: async () => responses.checkUpdates || { checked: 0, changes: 0, expired: 0, errors: [] },
    getStatus: (uid) => {
      const tracked = pendingEvents.get(uid);
      return tracked ? { found: true, ...tracked } : { found: false };
    },
    getPendingSummary: () => responses.pendingSummary || [],
    get trackedCount() { return pendingEvents.size; },
    pendingEvents
  };
}
```

Add to `module.exports`:
```javascript
  createMockContactsClient,
  createMockRSVPTracker
```

---

## 6. Verification Steps

After all files are created/modified, run these checks:

### Module Load Checks

```bash
# Verify ContactsClient loads without error
node -e "const C = require('./src/lib/integrations/contacts-client'); console.log('ContactsClient:', typeof C);"

# Verify RSVPTracker loads without error
node -e "const R = require('./src/lib/integrations/rsvp-tracker'); console.log('RSVPTracker:', typeof R);"

# Verify config loads with new contacts section
node -e "const c = require('./src/lib/config'); console.log('contacts config:', JSON.stringify(c.contacts));"

# Verify ToolRegistry still loads (no import errors)
node -e "const { ToolRegistry } = require('./src/lib/agent/tool-registry'); console.log('ToolRegistry:', typeof ToolRegistry);"

# Verify HeartbeatManager still loads
node -e "const H = require('./src/lib/integrations/heartbeat-manager'); console.log('HeartbeatManager:', typeof H);"
```

### Test Execution

```bash
# Run all new tests
node test/unit/integrations/contacts-client.test.js
node test/unit/integrations/rsvp-tracker.test.js
node test/unit/agent/contacts-tools.test.js

# Run existing tests to check for regressions
node test/unit/agent/tool-registry.test.js
node test/unit/integrations/collectives-client.test.js
node test/unit/integrations/caldav-client.test.js
node test/unit/integrations/heartbeat-initiative.test.js
```

### Wiring Verification

```bash
# Verify webhook-server.js still parses (syntax check)
node -c webhook-server.js

# Verify bot.js still parses
node -c src/bot.js
```

---

## 7. Key Design Decisions

### D1: CardDAV REPORT vs NC OCS Contacts API

**Decision:** Use CardDAV REPORT directly (not NC's OCS contacts API).
**Rationale:** CardDAV is the standard protocol, works with any address book (including shared ones), returns full vCard data, and the existing codebase uses DAV protocols (CalDAV) consistently. The NC OCS contacts API is less documented and may not expose all fields.

### D2: vCard Parsing -- Regex vs Library

**Decision:** Hand-written regex parser (like caldav-client ICS parser).
**Rationale:** No external vCard library dependency needed. The project already parses ICS with regex in `caldav-client.js`. We only need FN, N, EMAIL, TEL, ORG, TITLE, UID -- a small subset. RFC 6350 line folding is the only tricky part.

### D3: Cache Strategy -- Full Fetch vs Per-Query

**Decision:** Dual approach. `search()` uses CardDAV REPORT with filter for the query (server-side filtering). `fetchAll()` loads the complete address book into memory for fast local search. The cache is shared.
**Rationale:** Server-side search is faster for single lookups. Local cache enables fuzzy matching and repeated lookups without network calls. Contacts change infrequently, so a 1-hour TTL is safe.

### D4: People Page Auto-Creation -- Synchronous vs Background

**Decision:** Best-effort async in `resolve()`, never blocks or throws.
**Rationale:** Page creation is a nice-to-have side effect. If CollectivesClient is unavailable or the page already exists, we silently skip. The primary purpose of `resolve()` is returning contact data fast.

### D5: RSVPTracker State -- In-Memory vs Persistent

**Decision:** In-memory only for Session 26.
**Rationale:** Simplicity. If the server restarts, tracked RSVPs are lost. This is acceptable because: (a) meetings are still in CalDAV and can be re-tracked, (b) persistence adds complexity (Deck cards, WebDAV files), (c) Session 27 may introduce persistence. The Map is small (tracking ~10 events at most).

### D6: RSVPTracker in HeartbeatManager -- New Step vs Piggyback on Calendar

**Decision:** Separate step in `pulse()`, not piggybacked on `_checkCalendar()`.
**Rationale:** Separation of concerns. Calendar check is about upcoming event notifications. RSVP tracking is about attendance changes on already-created events. They have different check frequencies and different failure modes.

### D7: ContactsClient in ToolRegistry vs Separate Handler

**Decision:** Register as ToolRegistry tools (`contacts_search`, `contacts_get`), not as a separate handler in MessageRouter.
**Rationale:** The agent should be able to search contacts as a tool during any conversation, not just meeting-related ones. This matches how wiki, files, and calendar are exposed as tools. The MeetingComposer (Session 27) will call `contacts_search` internally via the tool system.

---

## 8. Edge Cases Handled in Design

| Case | How Handled |
|------|-------------|
| Address book does not exist | `search()` returns empty array, logs warning |
| Contact has no email | Contact object has `email: null`, tools format as "(no email)" |
| Multiple email addresses | All stored in `emails[]`, primary is first `email` field |
| vCard with folded long lines | `_unfoldVCard()` handles RFC 6350 line folding |
| Unicode names (Joao, Mueller) | CardDAV `i;unicode-casemap` collation handles server-side |
| RSVP event deleted before response | `checkUpdates()` detects null getEvent, auto-untracks |
| All attendees respond | Event auto-removed from tracking after all non-NEEDS-ACTION |
| Server restart loses RSVP state | Accepted risk for Session 26 (see D5) |
| collectivesClient not available | `_ensurePeoplePage()` silently skips |
| Contacts search during quiet hours | RSVP checking skipped during quiet hours (via heartbeat), but interactive search always works |

---

## 9. What This Unlocks for Session 27

With this foundation in place, Session 27 (MeetingComposer + Enhanced CalendarHandler) can:

1. **Call `contacts_search` tool** to resolve participant names during meeting composition
2. **Call `contacts_get` tool** to get full contact details for disambiguation
3. **Use RSVPTracker.trackEvent()** after meeting creation to begin monitoring
4. **Use RSVPTracker.getStatus()** when user asks "who's coming to..."
5. **People wiki pages exist** for resolved contacts, enriching agent memory
6. **No new infrastructure needed** -- just the state machine and enhanced handler on top
