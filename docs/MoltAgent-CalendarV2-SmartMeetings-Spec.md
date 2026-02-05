# MoltAgent Calendar v2: Smart Meetings Specification

**Version:** 1.0  
**Status:** Specification Ready  
**Priority:** High — Most requested client feature  
**Target:** Session 9 (Post-Launch Enhancement)  
**Author:** Fu + Claude Opus (Architecture Partner)  
**Date:** 2026-02-06  
**LLM Requirement:** Ollama (local) — no cloud API needed for this workflow

---

## 1. Executive Summary

### Problem

Calendar v1 creates solo events on moltagent's personal calendar. When a user says "schedule a meeting with João," the agent doesn't know who João is, can't send invitations, can't track RSVPs, and creates an invisible event on its own calendar instead of a proper multi-participant meeting.

### Solution

Calendar v2 turns MoltAgent into a meeting coordinator that:

1. Resolves participant names via NC Contacts (CardDAV)
2. Disambiguates when multiple matches exist
3. Collects missing information conversationally
4. Checks conflicts on the admin's shared calendar
5. Creates events with proper ATTENDEE properties
6. Lets Nextcloud send iCal invitations with RSVP requests automatically
7. Tracks attendance responses
8. Eventually auto-generates video meeting links (via Skill Forge integrations)

### Why This Matters

This is the single most requested feature from existing clients. A sovereign AI assistant that can't properly schedule meetings with real people is a demo, not a product. This feature transforms MoltAgent from "calendar note-taker" to "executive assistant."

---

## 2. Architecture

### New Components

```
┌─────────────────────────────────────────────────────────────────┐
│                    CALENDAR V2 ADDITIONS                         │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│  ┌─────────────────────────────────────────────────────────┐    │
│  │              ContactsResolver (NEW)                      │    │
│  │                                                         │    │
│  │  • Search NC Contacts via CardDAV                       │    │
│  │  • Fuzzy name matching                                  │    │
│  │  • Disambiguation UI ("Which João?")                    │    │
│  │  • Email extraction from vCard                          │    │
│  │  • Caching (contacts don't change every minute)         │    │
│  │                                                         │    │
│  └─────────────────────────────────────────────────────────┘    │
│                                                                 │
│  ┌─────────────────────────────────────────────────────────┐    │
│  │              MeetingComposer (NEW)                       │    │
│  │                                                         │    │
│  │  • Multi-step conversation state machine                │    │
│  │  • Collects: who, when, where, what                     │    │
│  │  • Generates iCal with ATTENDEE + RSVP properties       │    │
│  │  • HITL review before sending                           │    │
│  │                                                         │    │
│  └─────────────────────────────────────────────────────────┘    │
│                                                                 │
│  ┌─────────────────────────────────────────────────────────┐    │
│  │              RSVPTracker (NEW)                            │    │
│  │                                                         │    │
│  │  • Monitors CalDAV for PARTSTAT changes                 │    │
│  │  • Processes incoming iTIP REPLY messages                │    │
│  │  • Reports attendance status on request                 │    │
│  │  • Proactive notifications for declined/tentative        │    │
│  │                                                         │    │
│  └─────────────────────────────────────────────────────────┘    │
│                                                                 │
│  ┌─────────────────────────────────────────────────────────┐    │
│  │              Enhanced CalendarHandler (MODIFIED)          │    │
│  │                                                         │    │
│  │  • Conflict check on admin's shared calendar            │    │
│  │  • Multi-calendar awareness                             │    │
│  │  • Delegate to MeetingComposer for multi-participant     │    │
│  │  • Share events with internal + federated NC users       │    │
│  │                                                         │    │
│  └─────────────────────────────────────────────────────────┘    │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

### Protocol Dependencies

| Protocol | Purpose | NC App Required |
|----------|---------|-----------------|
| CalDAV | Calendar CRUD, event creation with attendees | Calendar (built-in) |
| CardDAV | Contact search, email resolution | Contacts (built-in) |
| iTIP/iMIP | Invitation sending, RSVP processing | Calendar (built-in, auto) |
| WebDAV | Audit logging, memory storage | Files (built-in) |

### Key Insight: Nextcloud Does the Heavy Lifting

Nextcloud's Calendar app **automatically sends iCal invitations** when an event contains ATTENDEE properties with email addresses. MoltAgent doesn't need to implement email sending for invitations — it just needs to create well-formed iCal events with the right properties. NC handles:

- Sending the initial invitation email with .ics attachment
- Processing incoming REPLY messages (accept/decline/tentative)
- Updating PARTSTAT on the event
- Sending updates when events are modified
- Sending cancellations when events are deleted

---

## 3. Setup Requirements (Concierge Checklist)

### One-Time Configuration

| Step | Action | Why |
|------|--------|-----|
| 1 | Admin shares their Personal calendar with `moltagent` user (read access) | So agent can check the human's real availability |
| 2 | Grant `moltagent` user access to NC Contacts address book (read access) | So agent can resolve names to email addresses |
| 3 | Ensure NC Mail or external SMTP is configured | So NC can send invitation emails |
| 4 | Store CalDAV credentials in NC Passwords (already done in v1) | Agent needs write access to its own calendar |
| 5 | Create a shared "Meetings" calendar (optional) | Cleaner separation: agent creates meetings here, personal events stay separate |

### NC Passwords Entries (New)

| Label | Purpose | Fields |
|-------|---------|--------|
| `carddav-access` | Read NC Contacts | username, password (NC app password) |
| `caldav-admin-calendar` | Admin's calendar URL for conflict check | calendar-url (e.g., `/remote.php/dav/calendars/admin/personal/`) |

---

## 4. Complete Meeting Workflow

### 4.1 The Conversation Flow

```
USER: "Schedule a meeting with João and Maria about the Q1 review on Tuesday at 2pm"

┌──────────────────────────────────────────────────────────────────┐
│ STEP 1: INTENT CLASSIFICATION                                    │
│                                                                  │
│ Message Router detects: calendar intent + participant names       │
│ Delegates to: MeetingComposer (not basic CalendarHandler)        │
│ Trigger: presence of "with [name]" pattern                       │
└──────────────────┬───────────────────────────────────────────────┘
                   │
                   ▼
┌──────────────────────────────────────────────────────────────────┐
│ STEP 2: EXTRACT KNOWN FIELDS                                     │
│                                                                  │
│ LLM Parse (Ollama/local):                                        │
│ {                                                                │
│   "action": "create_meeting",                                    │
│   "title": "Q1 Review",                                         │
│   "participants": ["João", "Maria"],                             │
│   "date": "next Tuesday",                                       │
│   "time": "14:00",                                               │
│   "duration": 60,  // default                                    │
│   "location": null,  // not specified                            │
│   "description": null                                            │
│ }                                                                │
└──────────────────┬───────────────────────────────────────────────┘
                   │
                   ▼
┌──────────────────────────────────────────────────────────────────┐
│ STEP 3: RESOLVE PARTICIPANTS via NC Contacts (CardDAV)           │
│                                                                  │
│ ContactsResolver.search("João"):                                 │
│   → 3 matches found:                                             │
│     1. João Silva <joao.silva@company.pt> (Company)              │
│     2. João Santos <j.santos@external.com> (External)            │
│     3. João Mendes <jmendes@partner.org> (Partner Org)           │
│                                                                  │
│ ContactsResolver.search("Maria"):                                │
│   → 1 match found:                                               │
│     1. Maria Costa <maria.costa@company.pt> (Company)            │
│   → Auto-resolved ✓                                              │
└──────────────────┬───────────────────────────────────────────────┘
                   │
                   ▼
┌──────────────────────────────────────────────────────────────────┐
│ STEP 4: DISAMBIGUATE (only if needed)                            │
│                                                                  │
│ AGENT → Talk:                                                    │
│ "I found 3 contacts named João:                                  │
│  1. João Silva (Company) — joao.silva@company.pt                 │
│  2. João Santos (External) — j.santos@external.com               │
│  3. João Mendes (Partner Org) — jmendes@partner.org              │
│  Which João should I invite?"                                    │
│                                                                  │
│ USER: "João Silva"                                               │
│ → Resolved ✓                                                     │
└──────────────────┬───────────────────────────────────────────────┘
                   │
                   ▼
┌──────────────────────────────────────────────────────────────────┐
│ STEP 5: CHECK CONFLICTS                                          │
│                                                                  │
│ Query admin's shared calendar (CalDAV):                           │
│   Tuesday 14:00-15:00 → No conflicts ✓                           │
│                                                                  │
│ (If conflict found):                                             │
│ "You have 'Board Meeting' from 14:00-15:30 on Tuesday.           │
│  Should I schedule at 16:00 instead, or find the next free       │
│  slot for all of us?"                                            │
└──────────────────┬───────────────────────────────────────────────┘
                   │
                   ▼
┌──────────────────────────────────────────────────────────────────┐
│ STEP 6: ASK FOR MISSING FIELDS                                   │
│                                                                  │
│ Location not specified. Agent asks:                               │
│                                                                  │
│ AGENT → Talk:                                                    │
│ "Where should the meeting take place?                             │
│  • In person (specify room/address)                              │
│  • Video call (I can generate a link if a video skill is set up) │
│  • No location needed"                                           │
│                                                                  │
│ USER: "Conference Room B"                                        │
│                                                                  │
│ (Future: if video meeting skill is active)                       │
│ USER: "Video call"                                               │
│ → Agent calls video meeting skill → generates Zoom/Teams link     │
│ → Link added to event description and LOCATION field             │
└──────────────────┬───────────────────────────────────────────────┘
                   │
                   ▼
┌──────────────────────────────────────────────────────────────────┐
│ STEP 7: HITL REVIEW                                              │
│                                                                  │
│ AGENT → Talk:                                                    │
│ "📅 Here's the meeting draft:                                    │
│                                                                  │
│  **Q1 Review**                                                   │
│  📆 Tuesday, Feb 11, 2026                                       │
│  🕐 14:00 – 15:00 (WET)                                         │
│  📍 Conference Room B                                            │
│  👥 Participants:                                                │
│     • You (organizer)                                            │
│     • João Silva — joao.silva@company.pt                         │
│     • Maria Costa — maria.costa@company.pt                       │
│  ✉️  Calendar invitations will be sent with RSVP request         │
│                                                                  │
│  Reply **yes** to send, or tell me what to change."              │
│                                                                  │
│ USER: "yes" / "Change time to 3pm" / "Add Pedro too" / "cancel" │
└──────────────────┬───────────────────────────────────────────────┘
                   │ (user confirms "yes")
                   ▼
┌──────────────────────────────────────────────────────────────────┐
│ STEP 8: CREATE EVENT + SEND INVITATIONS                          │
│                                                                  │
│ CalDAV PUT with iCal containing:                                 │
│   ORGANIZER;CN=Admin Name:mailto:admin@company.pt                │
│   ATTENDEE;ROLE=REQ-PARTICIPANT;PARTSTAT=NEEDS-ACTION;           │
│     RSVP=TRUE;CN=João Silva:mailto:joao.silva@company.pt        │
│   ATTENDEE;ROLE=REQ-PARTICIPANT;PARTSTAT=NEEDS-ACTION;           │
│     RSVP=TRUE;CN=Maria Costa:mailto:maria.costa@company.pt      │
│                                                                  │
│ NC Calendar auto-sends invitation emails with .ics attachment    │
│ Each invitation includes RSVP buttons (Accept/Decline/Tentative) │
│                                                                  │
│ For internal NC users: also share via NC calendar sharing         │
│ For federated NC users: send via NC federation                    │
└──────────────────┬───────────────────────────────────────────────┘
                   │
                   ▼
┌──────────────────────────────────────────────────────────────────┐
│ STEP 9: CONFIRMATION + RSVP TRACKING                             │
│                                                                  │
│ AGENT → Talk:                                                    │
│ "✅ Meeting created and invitations sent!                         │
│                                                                  │
│  **Q1 Review** — Tue Feb 11, 14:00-15:00                        │
│  📧 Invitations sent to:                                        │
│     • João Silva (awaiting response)                             │
│     • Maria Costa (awaiting response)                            │
│                                                                  │
│  I'll notify you when they respond."                             │
│                                                                  │
│ RSVPTracker begins monitoring for PARTSTAT changes               │
└──────────────────────────────────────────────────────────────────┘
```

### 4.2 RSVP Tracking Flow

```
┌──────────────────────────────────────────────────────────────────┐
│ RSVP MONITORING (Background — runs in heartbeat cycle)           │
│                                                                  │
│ RSVPTracker checks CalDAV for PARTSTAT changes on events         │
│ that have pending RSVPs.                                         │
│                                                                  │
│ When João accepts:                                               │
│   PARTSTAT changes from NEEDS-ACTION → ACCEPTED                  │
│                                                                  │
│ AGENT → Talk (proactive notification):                           │
│ "✅ João Silva accepted the Q1 Review meeting (Tue Feb 11, 14:00)"│
│                                                                  │
│ When Maria declines:                                             │
│   PARTSTAT changes from NEEDS-ACTION → DECLINED                  │
│                                                                  │
│ AGENT → Talk (proactive notification):                           │
│ "❌ Maria Costa declined the Q1 Review meeting (Tue Feb 11, 14:00)│
│  Would you like me to:                                           │
│  • Find a new time that works for everyone?                      │
│  • Proceed without Maria?                                        │
│  • Cancel the meeting?"                                          │
│                                                                  │
│ When someone responds TENTATIVE:                                 │
│ "⚠️ João Silva tentatively accepted the Q1 Review meeting.       │
│  They may not be able to attend."                                │
└──────────────────────────────────────────────────────────────────┘
```

### 4.3 User Can Query RSVP Status Anytime

```
USER: "Who's coming to the Q1 review meeting?"

AGENT:
"📋 RSVP Status for **Q1 Review** (Tue Feb 11, 14:00):

 ✅ João Silva — Accepted
 ❌ Maria Costa — Declined
 ⏳ Pedro Alves — No response yet

 1 of 3 confirmed. Would you like me to follow up with Pedro?"
```

---

## 5. Technical Implementation

### 5.1 NC Contacts Integration (CardDAV)

#### API: Search Contacts

```
REPORT /remote.php/dav/addressbooks/users/{username}/contacts/
Content-Type: application/xml

<?xml version="1.0" encoding="UTF-8"?>
<C:addressbook-query xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:carddav">
  <D:prop>
    <D:getetag/>
    <C:address-data/>
  </D:prop>
  <C:filter>
    <C:prop-filter name="FN">
      <C:text-match collation="i;unicode-casemap" match-type="contains">João</C:text-match>
    </C:prop-filter>
  </C:filter>
</C:addressbook-query>
```

#### Parsing vCard Response

```javascript
// Example vCard data returned
// BEGIN:VCARD
// VERSION:3.0
// FN:João Silva
// N:Silva;João;;;
// EMAIL;TYPE=WORK:joao.silva@company.pt
// ORG:Company Name
// TEL;TYPE=WORK:+351 912 345 678
// END:VCARD

class ContactsResolver {
  /**
   * Search contacts by name
   * @param {string} query - Name to search for
   * @returns {Array<{name, email, org, phone}>}
   */
  async search(query) {
    // 1. Fetch CardDAV credentials from NC Passwords
    // 2. Execute REPORT query against contacts addressbook
    // 3. Parse vCard responses
    // 4. Return structured contact list
  }

  /**
   * Resolve a name to a single contact
   * Returns immediately if only one match
   * Returns disambiguation options if multiple matches
   * @param {string} name
   * @returns {{resolved: boolean, contact?: Object, options?: Array}}
   */
  async resolve(name) {
    const matches = await this.search(name);
    if (matches.length === 0) return { resolved: false, error: 'no_match' };
    if (matches.length === 1) return { resolved: true, contact: matches[0] };
    return { resolved: false, options: matches };
  }
}
```

#### Caching Strategy

Contacts change infrequently. Cache the full address book with a 1-hour TTL:

```javascript
// On first access: fetch all contacts, build name→contact index
// On subsequent searches: search in-memory index
// Every 60 minutes OR on cache miss: refresh from CardDAV
// On "contacts updated" hint from user: force refresh
```

### 5.2 iCal Event with Attendees + RSVP

#### Minimum Viable iCal for Meeting Invitation

```
BEGIN:VCALENDAR
VERSION:2.0
PRODID:-//MoltAgent//Calendar v2//EN
METHOD:REQUEST
BEGIN:VEVENT
UID:meeting-{uuid}@moltagent
DTSTART:20260211T140000Z
DTEND:20260211T150000Z
SUMMARY:Q1 Review
DESCRIPTION:Quarterly review meeting
LOCATION:Conference Room B
ORGANIZER;CN=Admin Name:mailto:admin@company.pt
ATTENDEE;ROLE=REQ-PARTICIPANT;PARTSTAT=NEEDS-ACTION;RSVP=TRUE;CN=João Silva:mailto:joao.silva@company.pt
ATTENDEE;ROLE=REQ-PARTICIPANT;PARTSTAT=NEEDS-ACTION;RSVP=TRUE;CN=Maria Costa:mailto:maria.costa@company.pt
ATTENDEE;ROLE=REQ-PARTICIPANT;PARTSTAT=ACCEPTED;CN=Admin Name:mailto:admin@company.pt
END:VEVENT
END:VCALENDAR
```

#### Key iCal Properties

| Property | Purpose | Values |
|----------|---------|--------|
| `METHOD:REQUEST` | Marks this as an invitation (not just an event) | REQUEST, CANCEL, REPLY |
| `ORGANIZER` | Who's hosting | `mailto:` URI with CN |
| `ATTENDEE` | Each participant | `mailto:` URI with CN, ROLE, PARTSTAT, RSVP |
| `RSVP=TRUE` | Request response from attendee | TRUE/FALSE |
| `PARTSTAT` | Participation status | NEEDS-ACTION, ACCEPTED, DECLINED, TENTATIVE |
| `ROLE` | Participant role | REQ-PARTICIPANT, OPT-PARTICIPANT, NON-PARTICIPANT, CHAIR |

### 5.3 RSVP Tracking Implementation

#### How NC Handles RSVP

When an attendee responds to an invitation (via email client or NC Calendar):

1. Their client sends an iTIP REPLY back
2. NC Calendar processes the REPLY
3. NC updates the PARTSTAT on the ATTENDEE property in the event
4. The change is visible via CalDAV REPORT on the event

#### RSVPTracker Module

```javascript
class RSVPTracker {
  constructor({ caldavClient, talkClient, auditLog }) {
    this.pendingEvents = new Map(); // uid → {attendees, lastChecked}
  }

  /**
   * Register an event for RSVP tracking
   * Called after successful meeting creation
   */
  trackEvent(uid, attendees) {
    this.pendingEvents.set(uid, {
      attendees: attendees.map(a => ({
        email: a.email,
        name: a.name,
        lastStatus: 'NEEDS-ACTION'
      })),
      lastChecked: new Date()
    });
  }

  /**
   * Check for RSVP changes (called from heartbeat)
   * Compares current PARTSTAT against last known state
   */
  async checkUpdates() {
    for (const [uid, tracking] of this.pendingEvents) {
      const event = await this.caldavClient.getEvent(uid);
      if (!event) continue;

      for (const attendee of tracking.attendees) {
        const current = this.extractPartstat(event, attendee.email);
        if (current !== attendee.lastStatus) {
          await this.notifyStatusChange(uid, attendee, current);
          attendee.lastStatus = current;
        }
      }

      // Remove from tracking if all responded
      const allResponded = tracking.attendees.every(
        a => a.lastStatus !== 'NEEDS-ACTION'
      );
      if (allResponded) this.pendingEvents.delete(uid);
    }
  }

  /**
   * Send proactive Talk notification on status change
   */
  async notifyStatusChange(uid, attendee, newStatus) {
    const emoji = {
      'ACCEPTED': '✅',
      'DECLINED': '❌',
      'TENTATIVE': '⚠️'
    }[newStatus] || '❓';

    const event = await this.caldavClient.getEvent(uid);
    const summary = event.summary || 'Unknown event';

    let message = `${emoji} ${attendee.name} ${newStatus.toLowerCase()} the **${summary}** meeting.`;

    if (newStatus === 'DECLINED') {
      message += '\nWould you like me to find a new time or proceed without them?';
    }

    await this.talkClient.sendMessage(message);
    await this.auditLog('rsvp_update', {
      uid, attendee: attendee.email, status: newStatus
    });
  }

  /**
   * Get current RSVP status for an event
   * Called when user asks "who's coming to..."
   */
  async getStatus(uid) {
    const event = await this.caldavClient.getEvent(uid);
    // Parse ATTENDEE properties, return status array
  }
}
```

### 5.4 MeetingComposer State Machine

```
States:
  IDLE → COLLECTING → RESOLVING → REVIEWING → CONFIRMED → DONE

Transitions:
  IDLE → COLLECTING:       User says "schedule meeting with..."
  COLLECTING → RESOLVING:  All required fields collected (who, when)
  RESOLVING → COLLECTING:  Need disambiguation ("which João?")
  RESOLVING → REVIEWING:   All participants resolved
  REVIEWING → COLLECTING:  User requests changes
  REVIEWING → CONFIRMED:   User says "yes"
  CONFIRMED → DONE:        Event created + invitations sent

Required fields:
  - title (extracted or generated from context)
  - participants[] (at least one, each needs email)
  - start (date + time)
  - duration (default 60 min)

Optional fields:
  - location (in-person address or video link)
  - description (notes/agenda)
  - recurrence (weekly, monthly, etc.)

Timeout: 15 minutes of inactivity → cancel with message
```

### 5.5 Sharing with NC Users (Internal + Federated)

#### Internal NC Users

If a participant's email matches an NC user on the same instance, MoltAgent can additionally share the event via NC Calendar's sharing API:

```
POST /ocs/v1.php/apps/calendar/api/v1/calendars/{calendarId}/shares
{ "shareType": 0, "shareWith": "username" }
```

#### Federated NC Users

For participants on federated Nextcloud instances (detected by federated cloud ID pattern `user@remote-nc.example.com`), MoltAgent creates the event with the federated sharing protocol:

```
ATTENDEE;CUTYPE=INDIVIDUAL;PARTSTAT=NEEDS-ACTION;RSVP=TRUE;
  CN=Remote User;SCHEDULE-AGENT=SERVER:mailto:user@remote-nc.example.com
```

NC handles the federation protocol automatically.

#### Detection Logic

```javascript
async function classifyParticipant(contact) {
  // Check if email matches a local NC user
  const localUser = await ncAPI.getUserByEmail(contact.email);
  if (localUser) return { type: 'internal', ncUser: localUser.id };

  // Check if email matches a federated cloud ID pattern
  const federatedMatch = contact.cloudId || null;
  if (federatedMatch) return { type: 'federated', cloudId: federatedMatch };

  // External participant — invitation via email only
  return { type: 'external', email: contact.email };
}
```

---

## 6. Edge Cases and Error Handling

### 6.1 Participant Resolution Failures

| Scenario | Agent Behavior |
|----------|---------------|
| No contact match for "João" | "I couldn't find 'João' in your contacts. Can you give me their email address?" |
| Multiple matches, user gives ambiguous answer | "I still have two Joãos. Could you specify their last name or email?" |
| Contact has no email address | "I found João Silva in your contacts but there's no email address. Can you provide one?" |
| User provides email directly | Skip contact search, use directly: "schedule meeting with joao@company.pt" |

### 6.2 Calendar Conflicts

| Scenario | Agent Behavior |
|----------|---------------|
| Admin has conflict | "You have 'Board Meeting' at that time. Want me to find the next free slot?" |
| Requested time is in the past | "That time has already passed. Did you mean next Tuesday?" |
| Weekend/holiday detected | "Feb 11 is a Saturday. Schedule anyway, or move to Monday?" |

### 6.3 RSVP Edge Cases

| Scenario | Agent Behavior |
|----------|---------------|
| No response after 24h | "⏳ Still waiting for João's response to the Q1 Review meeting. Want me to send a reminder?" |
| All declined | "❌ All participants declined the Q1 Review meeting. Want me to propose new times?" |
| Event deleted before responses | Remove from tracking, no notifications |
| User asks about non-tracked event | "I don't have RSVP tracking for that event. It may have been created before this feature was enabled." |

### 6.4 Video Meeting Integration (Future)

When a video meeting skill is active (Zoom, Teams, Jitsi, etc.):

```
USER: "Video call" (in response to location prompt)

AGENT:
1. Calls video meeting skill to generate a link
2. Adds link to LOCATION field: "https://zoom.us/j/123456789"
3. Adds link to DESCRIPTION: "Join video call: https://zoom.us/j/123456789"
4. Includes in HITL review:
   "📍 Video call: https://zoom.us/j/123456789"
```

---

## 7. LLM Usage

### What Needs LLM (Ollama — Local)

| Task | Why LLM | Model |
|------|---------|-------|
| Parse meeting request | Extract participants, date, time, title from natural language | DeepSeek-R1 8B / GLM-4.7 Flash |
| Generate meeting title | When user says "meeting with João about sales" → "Sales Review" | Same |
| Disambiguation phrasing | Natural language for "which João?" questions | Same |
| Conflict resolution suggestions | "How about Thursday at 10am instead?" | Same |

### What Does NOT Need LLM (Direct Code)

| Task | Why No LLM |
|------|------------|
| Contact search | Direct CardDAV REPORT query |
| Email extraction | vCard parsing — structured data |
| Conflict checking | CalDAV time-range query — boolean result |
| iCal generation | Template-based string construction |
| RSVP monitoring | CalDAV PROPFIND — compare PARTSTAT values |
| Invitation sending | NC handles automatically on CalDAV PUT |
| Participant classification | Pattern matching on email/cloudId |

### Cost Implication

This feature is well-suited for the Starter tier (CPU-only Ollama). The LLM is only needed for the initial parse of the meeting request — everything else is direct API calls. Even a slow R1-8B can handle "extract names and time from this sentence" in under 30s.

---

## 8. Data Model

### Meeting State (In-Memory During Composition)

```javascript
{
  id: "meeting-uuid",
  state: "REVIEWING",
  title: "Q1 Review",
  organizer: { name: "Admin", email: "admin@company.pt" },
  participants: [
    { name: "João Silva", email: "joao.silva@company.pt", type: "internal", resolved: true },
    { name: "Maria Costa", email: "maria.costa@company.pt", type: "external", resolved: true }
  ],
  start: "2026-02-11T14:00:00",
  end: "2026-02-11T15:00:00",
  timezone: "Europe/Lisbon",
  location: "Conference Room B",
  description: null,
  videoLink: null,
  recurrence: null,
  conflictsChecked: true,
  conflicts: []
}
```

### RSVP Tracking State (Persisted to Memory/LearningLog)

```javascript
// Stored as a Deck card on a "Pending RSVPs" stack
{
  eventUid: "meeting-uuid@moltagent",
  summary: "Q1 Review",
  date: "2026-02-11",
  attendees: [
    { email: "joao.silva@company.pt", name: "João Silva", status: "ACCEPTED", respondedAt: "2026-02-07T10:30:00Z" },
    { email: "maria.costa@company.pt", name: "Maria Costa", status: "NEEDS-ACTION", respondedAt: null }
  ],
  trackingSince: "2026-02-06T19:00:00Z",
  lastChecked: "2026-02-07T11:00:00Z"
}
```

---

## 9. Testing Plan

### Unit Tests

| Module | Test Cases |
|--------|------------|
| ContactsResolver | Search with 0/1/N matches, fuzzy matching, missing email, cache invalidation |
| MeetingComposer | State transitions, field extraction, disambiguation flow, timeout handling |
| RSVPTracker | Status change detection, notification formatting, tracking cleanup |
| iCal Generator | Valid VCALENDAR output, ATTENDEE properties, RSVP=TRUE, METHOD:REQUEST |
| CalendarHandler v2 | Delegation to MeetingComposer, conflict checking on shared calendar |

### Integration Tests (Mocked NC)

| Scenario | Validates |
|----------|-----------|
| Full meeting creation flow | End-to-end from parse → contacts → HITL → CalDAV PUT |
| Disambiguation conversation | Multi-turn state machine with contact resolution |
| RSVP change detection | Mock CalDAV PROPFIND returning changed PARTSTAT |
| Conflict with reschedule | Calendar query returns conflict, user accepts suggestion |

### Manual Tests (MoltAgent Prime)

| Test | Command |
|------|---------|
| Simple meeting | "Schedule a meeting with [real contact] tomorrow at 2pm" |
| Disambiguation | "Meeting with João on Monday" (where multiple Joãos exist) |
| Conflict detection | Schedule over known existing event |
| RSVP check | "Who's coming to the [meeting name]?" |
| Location prompt | "Schedule a meeting" without specifying location |
| Direct email | "Meeting with joao@example.com on Friday at 10am" |

---

## 10. Implementation Estimate

| Module | Effort | Session |
|--------|--------|---------|
| ContactsResolver (CardDAV client + vCard parser) | 2-3 hours | Session 9A |
| MeetingComposer (state machine + conversation flow) | 3-4 hours | Session 9A |
| Enhanced CalendarHandler (delegation, shared calendar conflict check) | 2 hours | Session 9B |
| iCal Generator (ATTENDEE, ORGANIZER, RSVP properties) | 1-2 hours | Session 9B |
| RSVPTracker (heartbeat integration, notifications) | 2-3 hours | Session 9C |
| NC sharing integration (internal + federated) | 1-2 hours | Session 9C |
| Tests (unit + mocked integration) | 3-4 hours | Across all |
| **Total** | **~16-20 hours** | **3 sessions** |

---

## 11. Dependencies and Prerequisites

| Dependency | Status | Notes |
|------------|--------|-------|
| Calendar v1 (CalDAV CRUD) | ✅ Complete | Working in production |
| NC Contacts app installed | ✅ Default in NC | No additional setup |
| NC Mail or SMTP configured | ⚠️ Check per client | Required for sending invitations |
| Credential brokering | ✅ Complete | Need to add `carddav-access` label |
| HITL confirmation flow | ✅ Complete | Reuse from Calendar v1 |
| MeetingComposer state machine | 🔨 New | Similar pattern to SkillForge conversation |
| Video meeting Skill Forge template | 📋 Future | Optional — location works without it |

---

## 12. Open Questions

| Question | Options | Recommendation |
|----------|---------|----------------|
| Separate "Meetings" calendar or personal? | Separate cleaner, personal simpler | Start with personal, add option later |
| RSVP poll frequency? | Every heartbeat (5min) or dedicated timer? | Piggyback on heartbeat — low overhead |
| Reminder emails? | "João hasn't responded in 24h" → auto-send reminder? | Ask user first, don't auto-send |
| Recurring meeting support in v2? | Weekly standup, monthly 1:1 | Include basic RRULE support |
| Group contact resolution? | "Meeting with the Sales team" → expand group | Future — nice to have but complex |

---

## Document History

| Version | Date | Changes |
|---------|------|---------|
| 1.0 | 2026-02-06 | Initial specification |

---

*This specification is ready for implementation in Session 9 (post-launch). The architecture leverages NC's native CalDAV/CardDAV/iTIP capabilities to minimize custom code while delivering a complete meeting coordination experience.*

*"Your meetings. Your contacts. Your calendar. Your rules."*
