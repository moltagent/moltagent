# MoltAgent Email & Calendar Integration Specification

**Version:** 1.0  
**Status:** Implementation Ready  
**Target:** Claude Code Implementation  
**Last Updated:** 2026-02-04

---

## Overview

This specification defines the email and calendar integration for MoltAgent, enabling SMB users to manage their communications and schedules through natural language via NC Talk (or any bridged platform).

### Two Email Modes

MoltAgent supports two email configurations:

| Mode | Description | Use Case |
|------|-------------|----------|
| **Shared Access** | MoltAgent reads user's existing mailbox | User wants AI to help with their email |
| **Dedicated Address** | MoltAgent has its own email (e.g., ai@company.com) | AI as first point of contact, CC recipient |

Both modes can be enabled simultaneously.

---

## Part 1: Architecture

### System Overview

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                           MOLTAGENT CORE                                    │
│                                                                             │
│  ┌─────────────────────────────────────────────────────────────────────┐   │
│  │                      MESSAGE ROUTER                                  │   │
│  │                                                                      │   │
│  │  Incoming message ──► Intent Parser ──► Route to Handler            │   │
│  │                                                                      │   │
│  │  Intents:                                                           │   │
│  │  • calendar.* ──► CalendarHandler                                   │   │
│  │  • email.* ──► EmailHandler                                         │   │
│  │  • task.* ──► DeckHandler                                           │   │
│  │  • file.* ──► FileHandler                                           │   │
│  │  • general ──► ConversationHandler                                  │   │
│  │                                                                      │   │
│  └─────────────────────────────────────────────────────────────────────┘   │
│                                                                             │
│  ┌──────────────────────┐          ┌──────────────────────┐               │
│  │   CalendarHandler    │          │    EmailHandler      │               │
│  │                      │          │                      │               │
│  │  • getEvents()       │          │  • getInbox()        │               │
│  │  • createEvent()     │          │  • searchEmails()    │               │
│  │  • updateEvent()     │          │  • summarizeEmail()  │               │
│  │  • deleteEvent()     │          │  • draftReply()      │               │
│  │  • findFreeTime()    │          │  • sendEmail()       │               │
│  │  • checkConflicts()  │          │  • forwardEmail()    │               │
│  │                      │          │                      │               │
│  └──────────┬───────────┘          └──────────┬───────────┘               │
│             │                                  │                           │
│             ▼                                  ▼                           │
│  ┌──────────────────────┐          ┌──────────────────────┐               │
│  │   CalDAV Client      │          │   Email Client       │               │
│  │                      │          │                      │               │
│  │  Protocol: CalDAV    │          │  Read: IMAP          │               │
│  │  Library: tsdav      │          │  Send: SMTP          │               │
│  │                      │          │  Library: imap,      │               │
│  │                      │          │           nodemailer │               │
│  └──────────┬───────────┘          └──────────┬───────────┘               │
│             │                                  │                           │
│             ▼                                  ▼                           │
│  ┌─────────────────────────────────────────────────────────────────────┐   │
│  │                    CREDENTIAL BROKER                                 │   │
│  │                                                                      │   │
│  │  Fetches credentials from NC Passwords at runtime                   │   │
│  │  Credentials exist in memory ONLY during operation                  │   │
│  │  Immediately cleared after use                                      │   │
│  │                                                                      │   │
│  └─────────────────────────────────────────────────────────────────────┘   │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
                                    │
                                    ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                           NEXTCLOUD                                         │
│                                                                             │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐   │
│  │   Calendar   │  │     Mail     │  │  Passwords   │  │    Files     │   │
│  │    (CalDAV)  │  │   (NC Mail)  │  │ (Credentials)│  │   (Storage)  │   │
│  └──────────────┘  └──────────────┘  └──────────────┘  └──────────────┘   │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
```

### Directory Structure

```
/opt/moltagent/
├── src/
│   ├── index.js                    # Main entry point
│   ├── config/
│   │   └── default.js              # Configuration
│   ├── lib/
│   │   ├── credential-broker.js    # NC Passwords integration
│   │   ├── message-router.js       # Intent routing
│   │   ├── intent-parser.js        # NL to intent
│   │   ├── hitl-manager.js         # Human-in-the-loop
│   │   ├── audit-logger.js         # Audit trail
│   │   ├── calendar/
│   │   │   ├── caldav-client.js    # CalDAV protocol
│   │   │   ├── calendar-handler.js # Business logic
│   │   │   └── calendar-nlp.js     # NL parsing for calendar
│   │   ├── email/
│   │   │   ├── imap-client.js      # IMAP protocol
│   │   │   ├── smtp-client.js      # SMTP protocol
│   │   │   ├── email-handler.js    # Business logic
│   │   │   └── email-nlp.js        # NL parsing for email
│   │   └── talk/
│   │       ├── talk-client.js      # NC Talk API
│   │       └── webhook-server.js   # Incoming webhooks
│   └── utils/
│       ├── date-parser.js          # Natural date parsing
│       └── formatters.js           # Response formatting
├── test/
│   ├── calendar.test.js
│   ├── email.test.js
│   └── integration.test.js
└── package.json
```

---

## Part 2: Credential Management

### Required Credentials in NC Passwords

Users must create these entries and share with `moltagent` user:

| Credential Name | Purpose | Required Fields |
|-----------------|---------|-----------------|
| `caldav-access` | Calendar access | username, password (NC credentials or app password) |
| `email-imap` | Read emails | host, port, username, password, tls |
| `email-smtp` | Send emails | host, port, username, password, tls, from |
| `email-imap-dedicated` | Dedicated mailbox (optional) | host, port, username, password, tls |
| `email-smtp-dedicated` | Dedicated sending (optional) | host, port, username, password, tls, from |

### Credential Broker Implementation

```javascript
// /src/lib/credential-broker.js

const fetch = require('node-fetch');

class CredentialBroker {
  constructor(config) {
    this.ncUrl = config.nextcloud.url;
    this.ncUser = config.nextcloud.user;
    // Bootstrap credential loaded via systemd LoadCredential=
    this.ncPassword = this.loadBootstrapCredential();
  }

  loadBootstrapCredential() {
    const credDir = process.env.CREDENTIALS_DIRECTORY;
    if (!credDir) {
      throw new Error('CREDENTIALS_DIRECTORY not set. Use systemd LoadCredential=');
    }
    const fs = require('fs');
    return fs.readFileSync(`${credDir}/nc-password`, 'utf8').trim();
  }

  /**
   * Fetch a credential from NC Passwords
   * @param {string} name - Credential name (e.g., 'email-imap')
   * @returns {Promise<Object>} - Credential data
   */
  async get(name) {
    const response = await fetch(
      `${this.ncUrl}/index.php/apps/passwords/api/1.0/password/find`,
      {
        method: 'POST',
        headers: {
          'Authorization': `Basic ${Buffer.from(`${this.ncUser}:${this.ncPassword}`).toString('base64')}`,
          'Content-Type': 'application/json',
          'OCS-APIRequest': 'true',
        },
        body: JSON.stringify({ label: name }),
      }
    );

    if (!response.ok) {
      throw new Error(`Failed to fetch credential '${name}': ${response.status}`);
    }

    const data = await response.json();
    
    if (!data || data.length === 0) {
      throw new Error(`Credential '${name}' not found or not shared with moltagent`);
    }

    const credential = data[0];

    // Parse custom fields if present (stored in 'customFields' or 'notes')
    const parsed = this.parseCredential(credential);

    // Log access for audit (but not the credential itself!)
    await this.auditLog('credential_accessed', { name, timestamp: new Date() });

    return parsed;
  }

  parseCredential(credential) {
    // NC Passwords stores custom fields in 'customFields' JSON string
    let customFields = {};
    try {
      if (credential.customFields) {
        customFields = JSON.parse(credential.customFields);
      }
    } catch (e) {
      // Try parsing from notes as key=value pairs
      if (credential.notes) {
        credential.notes.split('\n').forEach(line => {
          const [key, value] = line.split('=');
          if (key && value) {
            customFields[key.trim()] = value.trim();
          }
        });
      }
    }

    return {
      username: credential.username,
      password: credential.password,
      url: credential.url,
      host: customFields.host || this.extractHost(credential.url),
      port: parseInt(customFields.port) || null,
      tls: customFields.tls !== 'false',
      from: customFields.from || credential.username,
      ...customFields,
    };
  }

  extractHost(url) {
    if (!url) return null;
    try {
      return new URL(url).hostname;
    } catch {
      return url; // Might already be just a hostname
    }
  }

  async auditLog(event, details) {
    // Log to NC Files: /moltagent/Logs/credentials.log
    const logEntry = JSON.stringify({
      timestamp: new Date().toISOString(),
      event,
      ...details,
    }) + '\n';

    // Append to log file via WebDAV
    // Implementation in audit-logger.js
  }

  /**
   * Execute an operation with a credential, ensuring cleanup
   * @param {string} name - Credential name
   * @param {Function} operation - Async function receiving credential
   * @returns {Promise<any>} - Operation result
   */
  async withCredential(name, operation) {
    let credential = null;
    try {
      credential = await this.get(name);
      return await operation(credential);
    } finally {
      // Clear credential from memory
      if (credential) {
        credential.password = null;
        credential.username = null;
        credential = null;
      }
    }
  }
}

module.exports = CredentialBroker;
```

---

## Part 3: Calendar Integration (CalDAV)

### CalDAV Client

```javascript
// /src/lib/calendar/caldav-client.js

const { DAVClient, DAVNamespace } = require('tsdav');
const ICAL = require('ical.js');
const { v4: uuidv4 } = require('uuid');

class CalDAVClient {
  constructor(credentialBroker, config) {
    this.credentials = credentialBroker;
    this.config = config;
    this.client = null;
    this.calendars = [];
  }

  /**
   * Connect to CalDAV server
   */
  async connect() {
    return this.credentials.withCredential('caldav-access', async (cred) => {
      this.client = new DAVClient({
        serverUrl: `${this.config.nextcloud.url}/remote.php/dav`,
        credentials: {
          username: cred.username,
          password: cred.password,
        },
        authMethod: 'Basic',
        defaultAccountType: 'caldav',
      });

      await this.client.login();
      this.calendars = await this.client.fetchCalendars();
      
      return true;
    });
  }

  /**
   * Get list of available calendars
   */
  async getCalendars() {
    if (!this.client) await this.connect();

    return this.calendars.map(cal => ({
      id: cal.url,
      name: cal.displayName,
      color: cal.calendarColor,
      description: cal.calendarDescription,
      writable: !cal.readOnly,
      isDefault: cal.url.includes('/personal/'),
    }));
  }

  /**
   * Get events within a date range
   */
  async getEvents(options = {}) {
    if (!this.client) await this.connect();

    const {
      calendarId = null,  // null = all calendars
      start = new Date(),
      end = null,
      limit = 50,
    } = options;

    // Default end: 7 days from start
    const endDate = end || new Date(start.getTime() + 7 * 24 * 60 * 60 * 1000);

    const calendarsToSearch = calendarId 
      ? this.calendars.filter(c => c.url === calendarId)
      : this.calendars;

    const allEvents = [];

    for (const calendar of calendarsToSearch) {
      try {
        const events = await this.client.fetchCalendarObjects({
          calendar,
          timeRange: {
            start: start.toISOString(),
            end: endDate.toISOString(),
          },
        });

        for (const event of events) {
          const parsed = this.parseICalEvent(event.data, calendar);
          if (parsed) allEvents.push(parsed);
        }
      } catch (e) {
        console.error(`Error fetching from calendar ${calendar.displayName}:`, e.message);
      }
    }

    // Sort by start time
    allEvents.sort((a, b) => new Date(a.start) - new Date(b.start));

    return allEvents.slice(0, limit);
  }

  /**
   * Get events for today
   */
  async getTodayEvents(calendarId = null) {
    const start = new Date();
    start.setHours(0, 0, 0, 0);
    
    const end = new Date();
    end.setHours(23, 59, 59, 999);

    return this.getEvents({ calendarId, start, end });
  }

  /**
   * Get events for tomorrow
   */
  async getTomorrowEvents(calendarId = null) {
    const start = new Date();
    start.setDate(start.getDate() + 1);
    start.setHours(0, 0, 0, 0);
    
    const end = new Date(start);
    end.setHours(23, 59, 59, 999);

    return this.getEvents({ calendarId, start, end });
  }

  /**
   * Get upcoming events
   */
  async getUpcomingEvents(days = 7, calendarId = null) {
    const start = new Date();
    const end = new Date();
    end.setDate(end.getDate() + days);

    return this.getEvents({ calendarId, start, end });
  }

  /**
   * Find a specific event by ID or search criteria
   */
  async findEvent(criteria) {
    if (!this.client) await this.connect();

    const { uid, title, date } = criteria;

    // Search in a reasonable date range
    const searchStart = date ? new Date(date) : new Date();
    searchStart.setMonth(searchStart.getMonth() - 1);
    
    const searchEnd = new Date(searchStart);
    searchEnd.setMonth(searchEnd.getMonth() + 3);

    const events = await this.getEvents({ start: searchStart, end: searchEnd, limit: 200 });

    if (uid) {
      return events.find(e => e.uid === uid);
    }

    if (title) {
      const titleLower = title.toLowerCase();
      return events.find(e => e.title.toLowerCase().includes(titleLower));
    }

    return null;
  }

  /**
   * Create a new event
   */
  async createEvent(eventData) {
    if (!this.client) await this.connect();

    const {
      calendarId = this.getDefaultCalendarId(),
      title,
      start,
      end,
      description = '',
      location = '',
      attendees = [],
      reminders = [{ minutes: 15 }],
      allDay = false,
    } = eventData;

    const calendar = this.calendars.find(c => c.url === calendarId);
    if (!calendar) throw new Error(`Calendar not found: ${calendarId}`);

    const uid = uuidv4();
    const icalString = this.buildICalEvent({
      uid,
      title,
      start: new Date(start),
      end: end ? new Date(end) : this.addHours(new Date(start), 1),
      description,
      location,
      attendees,
      reminders,
      allDay,
    });

    await this.client.createCalendarObject({
      calendar,
      filename: `${uid}.ics`,
      iCalString: icalString,
    });

    return {
      success: true,
      uid,
      event: {
        uid,
        title,
        start,
        end: end || this.addHours(new Date(start), 1).toISOString(),
        location,
        calendar: calendar.displayName,
      },
    };
  }

  /**
   * Update an existing event
   */
  async updateEvent(uid, updates) {
    if (!this.client) await this.connect();

    // Find the event first
    const event = await this.findEvent({ uid });
    if (!event) throw new Error(`Event not found: ${uid}`);

    // Merge updates
    const updated = {
      ...event,
      ...updates,
      uid: event.uid, // Preserve UID
    };

    const icalString = this.buildICalEvent(updated);

    // Find the calendar containing this event
    for (const calendar of this.calendars) {
      try {
        const objects = await this.client.fetchCalendarObjects({ calendar });
        const existing = objects.find(o => o.data.includes(uid));
        
        if (existing) {
          await this.client.updateCalendarObject({
            calendarObject: {
              url: existing.url,
              data: icalString,
              etag: existing.etag,
            },
          });
          
          return { success: true, uid, event: updated };
        }
      } catch (e) {
        continue;
      }
    }

    throw new Error(`Could not update event: ${uid}`);
  }

  /**
   * Delete an event
   */
  async deleteEvent(uid) {
    if (!this.client) await this.connect();

    for (const calendar of this.calendars) {
      try {
        const objects = await this.client.fetchCalendarObjects({ calendar });
        const existing = objects.find(o => o.data.includes(uid));
        
        if (existing) {
          await this.client.deleteCalendarObject({
            calendarObject: { url: existing.url, etag: existing.etag },
          });
          
          return { success: true, uid };
        }
      } catch (e) {
        continue;
      }
    }

    throw new Error(`Event not found: ${uid}`);
  }

  /**
   * Find free time slots
   */
  async findFreeSlots(options = {}) {
    const {
      duration = 60,  // minutes
      startDate = new Date(),
      endDate = null,
      workingHoursStart = 9,
      workingHoursEnd = 17,
      excludeWeekends = true,
    } = options;

    // Default: search next 7 days
    const searchEnd = endDate || new Date(startDate.getTime() + 7 * 24 * 60 * 60 * 1000);

    // Get all events in range
    const events = await this.getEvents({ start: startDate, end: searchEnd, limit: 500 });

    // Build busy times array
    const busyTimes = events.map(e => ({
      start: new Date(e.start),
      end: new Date(e.end),
    }));

    // Find free slots
    const freeSlots = [];
    let currentTime = new Date(startDate);

    while (currentTime < searchEnd && freeSlots.length < 10) {
      // Skip to next working day if needed
      if (excludeWeekends && (currentTime.getDay() === 0 || currentTime.getDay() === 6)) {
        currentTime.setDate(currentTime.getDate() + 1);
        currentTime.setHours(workingHoursStart, 0, 0, 0);
        continue;
      }

      // Skip to working hours
      if (currentTime.getHours() < workingHoursStart) {
        currentTime.setHours(workingHoursStart, 0, 0, 0);
      }
      if (currentTime.getHours() >= workingHoursEnd) {
        currentTime.setDate(currentTime.getDate() + 1);
        currentTime.setHours(workingHoursStart, 0, 0, 0);
        continue;
      }

      // Check if this slot is free
      const slotEnd = new Date(currentTime.getTime() + duration * 60 * 1000);
      
      const conflict = busyTimes.find(busy => 
        (currentTime >= busy.start && currentTime < busy.end) ||
        (slotEnd > busy.start && slotEnd <= busy.end) ||
        (currentTime <= busy.start && slotEnd >= busy.end)
      );

      if (!conflict && slotEnd.getHours() <= workingHoursEnd) {
        freeSlots.push({
          start: new Date(currentTime),
          end: slotEnd,
          duration,
        });
        // Move past this slot
        currentTime = slotEnd;
      } else if (conflict) {
        // Move to end of conflicting event
        currentTime = new Date(conflict.end);
      } else {
        // Move to next day
        currentTime.setDate(currentTime.getDate() + 1);
        currentTime.setHours(workingHoursStart, 0, 0, 0);
      }
    }

    return freeSlots;
  }

  /**
   * Check for conflicts with a proposed time
   */
  async checkConflicts(start, end) {
    const startDate = new Date(start);
    const endDate = new Date(end);

    const events = await this.getEvents({ 
      start: new Date(startDate.getTime() - 60 * 60 * 1000), // 1 hour before
      end: new Date(endDate.getTime() + 60 * 60 * 1000),     // 1 hour after
    });

    return events.filter(event => {
      const eventStart = new Date(event.start);
      const eventEnd = new Date(event.end);
      
      return (startDate >= eventStart && startDate < eventEnd) ||
             (endDate > eventStart && endDate <= eventEnd) ||
             (startDate <= eventStart && endDate >= eventEnd);
    });
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Helper Methods
  // ─────────────────────────────────────────────────────────────────────────

  parseICalEvent(icalString, calendar) {
    try {
      const jcal = ICAL.parse(icalString);
      const comp = new ICAL.Component(jcal);
      const vevent = comp.getFirstSubcomponent('vevent');
      
      if (!vevent) return null;

      const event = new ICAL.Event(vevent);
      
      return {
        uid: event.uid,
        title: event.summary || '(No title)',
        description: event.description || '',
        location: event.location || '',
        start: event.startDate.toJSDate().toISOString(),
        end: event.endDate.toJSDate().toISOString(),
        allDay: event.startDate.isDate,
        calendar: calendar.displayName,
        calendarId: calendar.url,
        attendees: this.parseAttendees(vevent),
        organizer: event.organizer,
        recurrence: vevent.getFirstPropertyValue('rrule')?.toString(),
      };
    } catch (e) {
      console.error('Failed to parse iCal event:', e.message);
      return null;
    }
  }

  parseAttendees(vevent) {
    const attendees = vevent.getAllProperties('attendee');
    return attendees.map(a => ({
      email: a.getFirstValue().replace('mailto:', ''),
      name: a.getParameter('cn'),
      status: a.getParameter('partstat'),
    }));
  }

  buildICalEvent(event) {
    const comp = new ICAL.Component(['vcalendar', [], []]);
    comp.updatePropertyWithValue('prodid', '-//MoltAgent//Calendar//EN');
    comp.updatePropertyWithValue('version', '2.0');

    const vevent = new ICAL.Component('vevent');
    
    vevent.updatePropertyWithValue('uid', event.uid);
    vevent.updatePropertyWithValue('summary', event.title);
    vevent.updatePropertyWithValue('dtstamp', ICAL.Time.now());

    if (event.allDay) {
      const startDate = ICAL.Time.fromJSDate(new Date(event.start), true);
      startDate.isDate = true;
      vevent.updatePropertyWithValue('dtstart', startDate);
      
      const endDate = ICAL.Time.fromJSDate(new Date(event.end), true);
      endDate.isDate = true;
      vevent.updatePropertyWithValue('dtend', endDate);
    } else {
      vevent.updatePropertyWithValue('dtstart', ICAL.Time.fromJSDate(new Date(event.start)));
      vevent.updatePropertyWithValue('dtend', ICAL.Time.fromJSDate(new Date(event.end)));
    }

    if (event.description) {
      vevent.updatePropertyWithValue('description', event.description);
    }
    if (event.location) {
      vevent.updatePropertyWithValue('location', event.location);
    }

    // Add attendees
    if (event.attendees && event.attendees.length > 0) {
      for (const attendee of event.attendees) {
        const prop = new ICAL.Property('attendee');
        prop.setValue(`mailto:${attendee.email || attendee}`);
        if (attendee.name) prop.setParameter('cn', attendee.name);
        prop.setParameter('partstat', 'NEEDS-ACTION');
        vevent.addProperty(prop);
      }
    }

    // Add reminders
    if (event.reminders && event.reminders.length > 0) {
      for (const reminder of event.reminders) {
        const valarm = new ICAL.Component('valarm');
        valarm.updatePropertyWithValue('action', 'DISPLAY');
        valarm.updatePropertyWithValue('description', 'Reminder');
        valarm.updatePropertyWithValue('trigger', `-PT${reminder.minutes}M`);
        vevent.addSubcomponent(valarm);
      }
    }

    comp.addSubcomponent(vevent);
    return comp.toString();
  }

  getDefaultCalendarId() {
    const personal = this.calendars.find(c => c.url.includes('/personal/'));
    return personal ? personal.url : this.calendars[0]?.url;
  }

  addHours(date, hours) {
    return new Date(date.getTime() + hours * 60 * 60 * 1000);
  }
}

module.exports = CalDAVClient;
```

### Calendar Handler (Business Logic)

```javascript
// /src/lib/calendar/calendar-handler.js

const CalDAVClient = require('./caldav-client');
const CalendarNLP = require('./calendar-nlp');
const { formatDate, formatTime, formatDuration } = require('../../utils/formatters');

class CalendarHandler {
  constructor(credentialBroker, config, llmClient) {
    this.caldav = new CalDAVClient(credentialBroker, config);
    this.nlp = new CalendarNLP(llmClient);
    this.config = config;
  }

  /**
   * Handle a natural language calendar request
   */
  async handle(message, userId, context = {}) {
    // Parse the intent
    const intent = await this.nlp.parseIntent(message);
    
    console.log(`[Calendar] Intent: ${intent.action}`, intent);

    switch (intent.action) {
      case 'query_today':
        return this.handleQueryToday(intent, userId);
      
      case 'query_tomorrow':
        return this.handleQueryTomorrow(intent, userId);
      
      case 'query_date':
        return this.handleQueryDate(intent, userId);
      
      case 'query_upcoming':
        return this.handleQueryUpcoming(intent, userId);
      
      case 'create_event':
        return this.handleCreateEvent(intent, userId, context);
      
      case 'update_event':
        return this.handleUpdateEvent(intent, userId, context);
      
      case 'delete_event':
        return this.handleDeleteEvent(intent, userId, context);
      
      case 'find_free_time':
        return this.handleFindFreeTime(intent, userId);
      
      case 'check_conflicts':
        return this.handleCheckConflicts(intent, userId);
      
      default:
        return {
          success: false,
          message: "I didn't understand that calendar request. Try:\n" +
                   "• 'What's on my calendar today?'\n" +
                   "• 'Schedule a meeting tomorrow at 2pm'\n" +
                   "• 'Find a free slot this week'",
        };
    }
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Query Handlers
  // ─────────────────────────────────────────────────────────────────────────

  async handleQueryToday(intent, userId) {
    const events = await this.caldav.getTodayEvents();
    
    if (events.length === 0) {
      return {
        success: true,
        message: "📅 Your calendar is clear today! No events scheduled.",
      };
    }

    const formatted = this.formatEventList(events, 'Today');
    return {
      success: true,
      message: formatted,
      events,
    };
  }

  async handleQueryTomorrow(intent, userId) {
    const events = await this.caldav.getTomorrowEvents();
    
    if (events.length === 0) {
      return {
        success: true,
        message: "📅 Your calendar is clear tomorrow!",
      };
    }

    const formatted = this.formatEventList(events, 'Tomorrow');
    return {
      success: true,
      message: formatted,
      events,
    };
  }

  async handleQueryDate(intent, userId) {
    const date = new Date(intent.date);
    const start = new Date(date);
    start.setHours(0, 0, 0, 0);
    const end = new Date(date);
    end.setHours(23, 59, 59, 999);

    const events = await this.caldav.getEvents({ start, end });
    
    const dateStr = formatDate(date);
    
    if (events.length === 0) {
      return {
        success: true,
        message: `📅 No events on ${dateStr}.`,
      };
    }

    const formatted = this.formatEventList(events, dateStr);
    return {
      success: true,
      message: formatted,
      events,
    };
  }

  async handleQueryUpcoming(intent, userId) {
    const days = intent.days || 7;
    const events = await this.caldav.getUpcomingEvents(days);
    
    if (events.length === 0) {
      return {
        success: true,
        message: `📅 No events scheduled in the next ${days} days.`,
      };
    }

    const formatted = this.formatEventList(events, `Next ${days} days`);
    return {
      success: true,
      message: formatted,
      events,
    };
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Create/Update/Delete Handlers
  // ─────────────────────────────────────────────────────────────────────────

  async handleCreateEvent(intent, userId, context) {
    // Check for conflicts
    const conflicts = await this.caldav.checkConflicts(intent.start, intent.end);
    
    let conflictWarning = '';
    if (conflicts.length > 0) {
      conflictWarning = '\n\n⚠️ **Conflicts detected:**\n' +
        conflicts.map(c => `• ${formatTime(c.start)} - ${c.title}`).join('\n');
    }

    // Build confirmation message
    const preview = this.formatEventPreview(intent);
    
    return {
      success: true,
      requiresConfirmation: true,
      confirmationType: 'create_event',
      pendingAction: {
        action: 'create_event',
        data: intent,
      },
      message: `📅 I'll create this event:${conflictWarning}\n\n${preview}\n\n` +
               `Reply **yes** to confirm, **no** to cancel, or tell me what to change.`,
    };
  }

  async confirmCreateEvent(eventData) {
    const result = await this.caldav.createEvent(eventData);
    
    return {
      success: true,
      message: `✅ Event created!\n\n` +
               `**${eventData.title}**\n` +
               `📆 ${formatDate(eventData.start)}\n` +
               `🕐 ${formatTime(eventData.start)} - ${formatTime(eventData.end)}` +
               (eventData.location ? `\n📍 ${eventData.location}` : ''),
      event: result.event,
    };
  }

  async handleUpdateEvent(intent, userId, context) {
    // Find the event to update
    const event = await this.caldav.findEvent({
      title: intent.eventTitle,
      date: intent.originalDate,
    });

    if (!event) {
      return {
        success: false,
        message: `❌ Couldn't find an event matching "${intent.eventTitle}". ` +
                 `Can you be more specific?`,
      };
    }

    const updates = {};
    if (intent.newStart) updates.start = intent.newStart;
    if (intent.newEnd) updates.end = intent.newEnd;
    if (intent.newTitle) updates.title = intent.newTitle;
    if (intent.newLocation) updates.location = intent.newLocation;

    const preview = this.formatUpdatePreview(event, updates);

    return {
      success: true,
      requiresConfirmation: true,
      confirmationType: 'update_event',
      pendingAction: {
        action: 'update_event',
        uid: event.uid,
        updates,
      },
      message: `📅 Update this event?\n\n${preview}\n\n` +
               `Reply **yes** to confirm or **no** to cancel.`,
    };
  }

  async confirmUpdateEvent(uid, updates) {
    const result = await this.caldav.updateEvent(uid, updates);
    
    return {
      success: true,
      message: `✅ Event updated!`,
      event: result.event,
    };
  }

  async handleDeleteEvent(intent, userId, context) {
    const event = await this.caldav.findEvent({
      title: intent.eventTitle,
      date: intent.date,
    });

    if (!event) {
      return {
        success: false,
        message: `❌ Couldn't find an event matching "${intent.eventTitle}".`,
      };
    }

    return {
      success: true,
      requiresConfirmation: true,
      confirmationType: 'delete_event',
      pendingAction: {
        action: 'delete_event',
        uid: event.uid,
      },
      message: `🗑️ Delete this event?\n\n` +
               `**${event.title}**\n` +
               `📆 ${formatDate(event.start)} at ${formatTime(event.start)}\n\n` +
               `Reply **yes** to delete or **no** to keep it.`,
    };
  }

  async confirmDeleteEvent(uid) {
    await this.caldav.deleteEvent(uid);
    
    return {
      success: true,
      message: `✅ Event deleted.`,
    };
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Free Time Handlers
  // ─────────────────────────────────────────────────────────────────────────

  async handleFindFreeTime(intent, userId) {
    const slots = await this.caldav.findFreeSlots({
      duration: intent.duration || 60,
      startDate: intent.startDate ? new Date(intent.startDate) : new Date(),
      endDate: intent.endDate ? new Date(intent.endDate) : null,
    });

    if (slots.length === 0) {
      return {
        success: true,
        message: `😅 Couldn't find any free ${intent.duration || 60}-minute slots. ` +
                 `Your calendar looks pretty full! Want me to search further out?`,
      };
    }

    const formatted = slots.slice(0, 5).map((slot, i) => 
      `${i + 1}. **${formatDate(slot.start)}** at ${formatTime(slot.start)} - ${formatTime(slot.end)}`
    ).join('\n');

    return {
      success: true,
      message: `🔍 Found these free slots:\n\n${formatted}\n\n` +
               `Which one works? Or tell me a different time.`,
      slots,
    };
  }

  async handleCheckConflicts(intent, userId) {
    const conflicts = await this.caldav.checkConflicts(intent.start, intent.end);

    if (conflicts.length === 0) {
      return {
        success: true,
        message: `✅ No conflicts! That time is free.`,
      };
    }

    const formatted = conflicts.map(c =>
      `• **${c.title}** (${formatTime(c.start)} - ${formatTime(c.end)})`
    ).join('\n');

    return {
      success: true,
      message: `⚠️ Found ${conflicts.length} conflict(s):\n\n${formatted}`,
      conflicts,
    };
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Formatting Helpers
  // ─────────────────────────────────────────────────────────────────────────

  formatEventList(events, dateLabel) {
    const lines = [`📅 **${dateLabel}** (${events.length} event${events.length !== 1 ? 's' : ''}):\n`];

    for (const event of events) {
      const time = event.allDay 
        ? '📌 All day' 
        : `🕐 ${formatTime(event.start)} - ${formatTime(event.end)}`;
      
      lines.push(`**${event.title}**`);
      lines.push(time);
      if (event.location) lines.push(`📍 ${event.location}`);
      lines.push('');
    }

    return lines.join('\n').trim();
  }

  formatEventPreview(event) {
    const lines = [
      `**${event.title || 'New Event'}**`,
      `📆 ${formatDate(event.start)}`,
      `🕐 ${formatTime(event.start)} - ${formatTime(event.end || this.addHours(event.start, 1))}`,
    ];

    if (event.location) lines.push(`📍 ${event.location}`);
    if (event.attendees?.length) {
      lines.push(`👥 ${event.attendees.join(', ')}`);
    }

    return lines.join('\n');
  }

  formatUpdatePreview(original, updates) {
    const lines = [`**${updates.title || original.title}**\n`];

    if (updates.start) {
      lines.push(`📆 ${formatDate(original.start)} → **${formatDate(updates.start)}**`);
      lines.push(`🕐 ${formatTime(original.start)} → **${formatTime(updates.start)}**`);
    }

    if (updates.location) {
      lines.push(`📍 ${original.location || '(none)'} → **${updates.location}**`);
    }

    return lines.join('\n');
  }

  addHours(date, hours) {
    return new Date(new Date(date).getTime() + hours * 60 * 60 * 1000);
  }
}

module.exports = CalendarHandler;
```

### Calendar NLP Parser

```javascript
// /src/lib/calendar/calendar-nlp.js

class CalendarNLP {
  constructor(llmClient) {
    this.llm = llmClient;
  }

  /**
   * Parse a natural language calendar request into structured intent
   */
  async parseIntent(message) {
    const prompt = `Parse this calendar request into a structured action.

User request: "${message}"

Current date/time: ${new Date().toISOString()}

Return JSON only (no markdown, no explanation):
{
  "action": "query_today|query_tomorrow|query_date|query_upcoming|create_event|update_event|delete_event|find_free_time|check_conflicts",
  "title": "event title if creating/updating",
  "start": "ISO datetime string",
  "end": "ISO datetime string (optional)",
  "duration": "duration in minutes if mentioned",
  "date": "specific date if querying",
  "days": "number of days for upcoming query",
  "location": "location if mentioned",
  "attendees": ["list", "of", "attendees"],
  "eventTitle": "title of existing event if updating/deleting",
  "originalDate": "date of existing event if updating",
  "newStart": "new start time if updating",
  "newEnd": "new end time if updating",
  "newTitle": "new title if updating",
  "newLocation": "new location if updating"
}

Only include fields that are relevant to the request.

Examples:
- "what's on my calendar today" → {"action": "query_today"}
- "schedule a meeting tomorrow at 2pm" → {"action": "create_event", "title": "Meeting", "start": "2026-02-05T14:00:00"}
- "move my 3pm meeting to 4pm" → {"action": "update_event", "originalDate": "...", "eventTitle": "meeting", "newStart": "...T16:00:00"}
- "find time for a 30 minute call this week" → {"action": "find_free_time", "duration": 30}`;

    const response = await this.llm.generate(prompt, {
      maxTokens: 500,
      temperature: 0.1, // Low temperature for consistent parsing
    });

    try {
      // Clean up response (remove markdown if present)
      const cleaned = response
        .replace(/```json\n?/g, '')
        .replace(/```\n?/g, '')
        .trim();
      
      return JSON.parse(cleaned);
    } catch (e) {
      console.error('Failed to parse calendar intent:', e.message, response);
      return { action: 'unknown', raw: message };
    }
  }
}

module.exports = CalendarNLP;
```

---

## Part 4: Email Integration (IMAP/SMTP)

### IMAP Client

```javascript
// /src/lib/email/imap-client.js

const Imap = require('imap');
const { simpleParser } = require('mailparser');
const { EventEmitter } = require('events');

class IMAPClient extends EventEmitter {
  constructor(credentialBroker, config) {
    super();
    this.credentials = credentialBroker;
    this.config = config;
    this.connection = null;
  }

  /**
   * Connect to IMAP server
   */
  async connect(credentialName = 'email-imap') {
    return this.credentials.withCredential(credentialName, async (cred) => {
      return new Promise((resolve, reject) => {
        this.connection = new Imap({
          user: cred.username,
          password: cred.password,
          host: cred.host,
          port: cred.port || 993,
          tls: cred.tls !== false,
          tlsOptions: { rejectUnauthorized: false },
        });

        this.connection.once('ready', () => {
          resolve(true);
        });

        this.connection.once('error', (err) => {
          reject(err);
        });

        this.connection.connect();
      });
    });
  }

  /**
   * Disconnect from IMAP server
   */
  disconnect() {
    if (this.connection) {
      this.connection.end();
      this.connection = null;
    }
  }

  /**
   * Get emails from a folder
   */
  async getEmails(options = {}) {
    const {
      folder = 'INBOX',
      limit = 20,
      unreadOnly = false,
      since = null,
      from = null,
      subject = null,
    } = options;

    await this.ensureConnected();

    return new Promise((resolve, reject) => {
      this.connection.openBox(folder, true, (err, box) => {
        if (err) return reject(err);

        // Build search criteria
        const criteria = [];
        if (unreadOnly) criteria.push('UNSEEN');
        else criteria.push('ALL');
        
        if (since) criteria.push(['SINCE', since]);
        if (from) criteria.push(['FROM', from]);
        if (subject) criteria.push(['SUBJECT', subject]);

        this.connection.search(criteria, (err, results) => {
          if (err) return reject(err);
          if (results.length === 0) return resolve([]);

          // Get latest emails
          const toFetch = results.slice(-limit);
          const emails = [];

          const fetch = this.connection.fetch(toFetch, {
            bodies: '',
            struct: true,
          });

          fetch.on('message', (msg, seqno) => {
            let buffer = '';
            
            msg.on('body', (stream) => {
              stream.on('data', (chunk) => {
                buffer += chunk.toString('utf8');
              });
            });

            msg.once('attributes', (attrs) => {
              msg.once('end', async () => {
                try {
                  const parsed = await simpleParser(buffer);
                  emails.push({
                    id: attrs.uid,
                    seqno,
                    messageId: parsed.messageId,
                    from: parsed.from?.text || '',
                    fromAddress: parsed.from?.value?.[0]?.address || '',
                    to: parsed.to?.text || '',
                    subject: parsed.subject || '(No subject)',
                    date: parsed.date,
                    snippet: this.getSnippet(parsed.text, 200),
                    body: parsed.text || '',
                    htmlBody: parsed.html || '',
                    hasAttachments: (parsed.attachments?.length || 0) > 0,
                    attachments: parsed.attachments?.map(a => ({
                      filename: a.filename,
                      contentType: a.contentType,
                      size: a.size,
                    })) || [],
                    flags: attrs.flags,
                    isRead: attrs.flags.includes('\\Seen'),
                    isStarred: attrs.flags.includes('\\Flagged'),
                  });
                } catch (e) {
                  console.error('Failed to parse email:', e.message);
                }
              });
            });
          });

          fetch.once('end', () => {
            // Sort by date descending (newest first)
            emails.sort((a, b) => new Date(b.date) - new Date(a.date));
            resolve(emails);
          });

          fetch.once('error', reject);
        });
      });
    });
  }

  /**
   * Get a single email by ID
   */
  async getEmail(id, folder = 'INBOX') {
    const emails = await this.getEmails({ folder, limit: 1000 });
    return emails.find(e => e.id === id || e.messageId === id);
  }

  /**
   * Get unread count
   */
  async getUnreadCount(folder = 'INBOX') {
    await this.ensureConnected();

    return new Promise((resolve, reject) => {
      this.connection.openBox(folder, true, (err, box) => {
        if (err) return reject(err);
        
        this.connection.search(['UNSEEN'], (err, results) => {
          if (err) return reject(err);
          resolve(results.length);
        });
      });
    });
  }

  /**
   * Search emails
   */
  async search(query, options = {}) {
    const { folder = 'INBOX', limit = 50 } = options;
    
    // Search in subject and body
    // IMAP search is limited, so we fetch and filter
    const emails = await this.getEmails({ folder, limit: 200 });
    
    const queryLower = query.toLowerCase();
    
    return emails.filter(e => 
      e.subject.toLowerCase().includes(queryLower) ||
      e.body.toLowerCase().includes(queryLower) ||
      e.from.toLowerCase().includes(queryLower)
    ).slice(0, limit);
  }

  /**
   * Mark email as read
   */
  async markAsRead(id, folder = 'INBOX') {
    await this.ensureConnected();

    return new Promise((resolve, reject) => {
      this.connection.openBox(folder, false, (err) => {
        if (err) return reject(err);
        
        this.connection.addFlags(id, ['\\Seen'], (err) => {
          if (err) return reject(err);
          resolve(true);
        });
      });
    });
  }

  /**
   * Move email to folder (e.g., archive)
   */
  async moveToFolder(id, targetFolder, sourceFolder = 'INBOX') {
    await this.ensureConnected();

    return new Promise((resolve, reject) => {
      this.connection.openBox(sourceFolder, false, (err) => {
        if (err) return reject(err);
        
        this.connection.move(id, targetFolder, (err) => {
          if (err) return reject(err);
          resolve(true);
        });
      });
    });
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Helper Methods
  // ─────────────────────────────────────────────────────────────────────────

  async ensureConnected() {
    if (!this.connection || this.connection.state !== 'authenticated') {
      await this.connect();
    }
  }

  getSnippet(text, maxLength) {
    if (!text) return '';
    
    // Clean up the text
    const cleaned = text
      .replace(/\r\n/g, '\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
    
    if (cleaned.length <= maxLength) return cleaned;
    
    return cleaned.slice(0, maxLength).trim() + '...';
  }
}

module.exports = IMAPClient;
```

### SMTP Client

```javascript
// /src/lib/email/smtp-client.js

const nodemailer = require('nodemailer');

class SMTPClient {
  constructor(credentialBroker, config) {
    this.credentials = credentialBroker;
    this.config = config;
  }

  /**
   * Send an email
   * IMPORTANT: This should only be called after HITL approval!
   */
  async send(email, credentialName = 'email-smtp') {
    return this.credentials.withCredential(credentialName, async (cred) => {
      const transporter = nodemailer.createTransport({
        host: cred.host,
        port: cred.port || 587,
        secure: cred.port === 465,
        auth: {
          user: cred.username,
          pass: cred.password,
        },
      });

      const mailOptions = {
        from: email.from || cred.from || cred.username,
        to: email.to,
        cc: email.cc,
        bcc: email.bcc,
        subject: email.subject,
        text: email.body,
        html: email.htmlBody,
        replyTo: email.replyTo,
        attachments: email.attachments,
      };

      const result = await transporter.sendMail(mailOptions);

      return {
        success: true,
        messageId: result.messageId,
        accepted: result.accepted,
        rejected: result.rejected,
      };
    });
  }

  /**
   * Verify SMTP connection
   */
  async verify(credentialName = 'email-smtp') {
    return this.credentials.withCredential(credentialName, async (cred) => {
      const transporter = nodemailer.createTransport({
        host: cred.host,
        port: cred.port || 587,
        secure: cred.port === 465,
        auth: {
          user: cred.username,
          pass: cred.password,
        },
      });

      await transporter.verify();
      return true;
    });
  }
}

module.exports = SMTPClient;
```

### Email Handler (Business Logic)

```javascript
// /src/lib/email/email-handler.js

const IMAPClient = require('./imap-client');
const SMTPClient = require('./smtp-client');
const EmailNLP = require('./email-nlp');
const { formatDate, formatTime } = require('../../utils/formatters');

class EmailHandler {
  constructor(credentialBroker, config, llmClient, hitlManager) {
    this.imap = new IMAPClient(credentialBroker, config);
    this.smtp = new SMTPClient(credentialBroker, config);
    this.nlp = new EmailNLP(llmClient);
    this.llm = llmClient;
    this.hitl = hitlManager;
    this.config = config;
    
    // Track which credential set to use
    this.mode = config.email?.mode || 'shared'; // 'shared' or 'dedicated'
  }

  /**
   * Handle a natural language email request
   */
  async handle(message, userId, context = {}) {
    const intent = await this.nlp.parseIntent(message);
    
    console.log(`[Email] Intent: ${intent.action}`, intent);

    switch (intent.action) {
      case 'check_inbox':
        return this.handleCheckInbox(intent, userId);
      
      case 'check_unread':
        return this.handleCheckUnread(intent, userId);
      
      case 'search_emails':
        return this.handleSearchEmails(intent, userId);
      
      case 'read_email':
        return this.handleReadEmail(intent, userId);
      
      case 'summarize_emails':
        return this.handleSummarizeEmails(intent, userId);
      
      case 'draft_email':
        return this.handleDraftEmail(intent, userId, context);
      
      case 'draft_reply':
        return this.handleDraftReply(intent, userId, context);
      
      case 'send_email':
        return this.handleSendEmail(intent, userId, context);
      
      case 'forward_email':
        return this.handleForwardEmail(intent, userId, context);
      
      default:
        return {
          success: false,
          message: "I didn't understand that email request. Try:\n" +
                   "• 'Check my inbox'\n" +
                   "• 'Search for emails from John'\n" +
                   "• 'Summarize emails about the project'\n" +
                   "• 'Draft a reply to Sarah's email'",
        };
    }
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Query Handlers
  // ─────────────────────────────────────────────────────────────────────────

  async handleCheckInbox(intent, userId) {
    const emails = await this.imap.getEmails({
      limit: intent.limit || 10,
      unreadOnly: false,
    });

    const unreadCount = emails.filter(e => !e.isRead).length;
    
    if (emails.length === 0) {
      return {
        success: true,
        message: "📭 Your inbox is empty!",
      };
    }

    const formatted = this.formatEmailList(emails, unreadCount);
    
    return {
      success: true,
      message: formatted,
      emails: emails.map(e => ({ id: e.id, subject: e.subject, from: e.from })),
    };
  }

  async handleCheckUnread(intent, userId) {
    const count = await this.imap.getUnreadCount();
    
    if (count === 0) {
      return {
        success: true,
        message: "✅ No unread emails! You're all caught up.",
      };
    }

    const emails = await this.imap.getEmails({
      limit: Math.min(count, 10),
      unreadOnly: true,
    });

    const formatted = this.formatEmailList(emails, count, true);
    
    return {
      success: true,
      message: formatted,
      emails: emails.map(e => ({ id: e.id, subject: e.subject, from: e.from })),
    };
  }

  async handleSearchEmails(intent, userId) {
    let emails;

    if (intent.from) {
      emails = await this.imap.getEmails({
        from: intent.from,
        limit: intent.limit || 20,
      });
    } else if (intent.subject) {
      emails = await this.imap.getEmails({
        subject: intent.subject,
        limit: intent.limit || 20,
      });
    } else if (intent.query) {
      emails = await this.imap.search(intent.query, {
        limit: intent.limit || 20,
      });
    } else {
      return {
        success: false,
        message: "What would you like to search for? You can search by sender, subject, or keywords.",
      };
    }

    if (emails.length === 0) {
      return {
        success: true,
        message: `🔍 No emails found matching your search.`,
      };
    }

    const formatted = this.formatEmailList(emails, 0, false, `Search results`);
    
    return {
      success: true,
      message: formatted,
      emails: emails.map(e => ({ id: e.id, subject: e.subject, from: e.from })),
    };
  }

  async handleReadEmail(intent, userId) {
    // Find the email
    let email;
    
    if (intent.emailId) {
      email = await this.imap.getEmail(intent.emailId);
    } else if (intent.from || intent.subject) {
      const emails = await this.imap.search(intent.from || intent.subject, { limit: 5 });
      email = emails[0];
    }

    if (!email) {
      return {
        success: false,
        message: "❌ Couldn't find that email. Can you be more specific?",
      };
    }

    // Mark as read
    await this.imap.markAsRead(email.id);

    const formatted = this.formatFullEmail(email);
    
    return {
      success: true,
      message: formatted,
      email: { id: email.id, subject: email.subject, from: email.from },
    };
  }

  async handleSummarizeEmails(intent, userId) {
    let emails;

    if (intent.from) {
      emails = await this.imap.getEmails({ from: intent.from, limit: 20 });
    } else if (intent.subject || intent.topic) {
      emails = await this.imap.search(intent.subject || intent.topic, { limit: 20 });
    } else if (intent.timeframe === 'today') {
      const today = new Date();
      today.setHours(0, 0, 0, 0);
      emails = await this.imap.getEmails({ since: today, limit: 50 });
    } else if (intent.timeframe === 'week') {
      const weekAgo = new Date();
      weekAgo.setDate(weekAgo.getDate() - 7);
      emails = await this.imap.getEmails({ since: weekAgo, limit: 50 });
    } else {
      emails = await this.imap.getEmails({ limit: 10 });
    }

    if (emails.length === 0) {
      return {
        success: true,
        message: "No emails found to summarize.",
      };
    }

    // Use LLM to summarize
    const summary = await this.summarizeWithLLM(emails, intent);
    
    return {
      success: true,
      message: summary,
      emailCount: emails.length,
    };
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Draft & Send Handlers
  // ─────────────────────────────────────────────────────────────────────────

  async handleDraftEmail(intent, userId, context) {
    const draft = {
      to: intent.to,
      cc: intent.cc,
      subject: intent.subject || '',
      body: intent.body || '',
    };

    // If we have enough info, generate a draft
    if (intent.to && (intent.subject || intent.topic)) {
      const generatedBody = await this.generateEmailBody(intent);
      draft.body = generatedBody;
    }

    const preview = this.formatDraftPreview(draft);
    
    return {
      success: true,
      requiresConfirmation: true,
      confirmationType: 'send_email',
      pendingAction: {
        action: 'send_email',
        data: draft,
      },
      message: `📝 Here's your draft:\n\n${preview}\n\n` +
               `Reply **yes** to send, **edit** to modify, or **no** to cancel.`,
      draft,
    };
  }

  async handleDraftReply(intent, userId, context) {
    // Find the original email
    let original;
    
    if (intent.emailId) {
      original = await this.imap.getEmail(intent.emailId);
    } else if (intent.from || intent.subject) {
      const emails = await this.imap.search(intent.from || intent.subject, { limit: 5 });
      original = emails[0];
    } else if (context.lastEmailId) {
      original = await this.imap.getEmail(context.lastEmailId);
    }

    if (!original) {
      return {
        success: false,
        message: "❌ Couldn't find the email to reply to. Can you be more specific?",
      };
    }

    // Generate reply
    const replyBody = await this.generateReplyBody(original, intent);
    
    const draft = {
      to: original.fromAddress,
      subject: original.subject.startsWith('Re:') ? original.subject : `Re: ${original.subject}`,
      body: replyBody,
      replyTo: original.messageId,
      inReplyTo: original,
    };

    const preview = this.formatDraftPreview(draft);
    
    return {
      success: true,
      requiresConfirmation: true,
      confirmationType: 'send_email',
      pendingAction: {
        action: 'send_email',
        data: draft,
      },
      message: `📝 Here's your reply draft:\n\n${preview}\n\n` +
               `Reply **yes** to send, **edit** to modify, or **no** to cancel.`,
      draft,
    };
  }

  async handleSendEmail(intent, userId, context) {
    // This should only be called after HITL confirmation
    // The actual sending is done via confirmSendEmail
    
    if (!intent.confirmed) {
      // Need to create draft first
      return this.handleDraftEmail(intent, userId, context);
    }

    return this.confirmSendEmail(intent.draft, userId);
  }

  /**
   * Actually send the email (after HITL approval)
   */
  async confirmSendEmail(draft, userId) {
    // Determine which SMTP credentials to use
    const credentialName = this.mode === 'dedicated' 
      ? 'email-smtp-dedicated' 
      : 'email-smtp';

    const result = await this.smtp.send(draft, credentialName);

    // Log the sent email
    await this.auditLog('email_sent', {
      to: draft.to,
      subject: draft.subject,
      messageId: result.messageId,
      userId,
    });

    return {
      success: true,
      message: `✅ Email sent to ${draft.to}!`,
      messageId: result.messageId,
    };
  }

  async handleForwardEmail(intent, userId, context) {
    // Find the original email
    let original;
    
    if (intent.emailId) {
      original = await this.imap.getEmail(intent.emailId);
    } else if (intent.from || intent.subject) {
      const emails = await this.imap.search(intent.from || intent.subject, { limit: 5 });
      original = emails[0];
    }

    if (!original) {
      return {
        success: false,
        message: "❌ Couldn't find the email to forward. Can you be more specific?",
      };
    }

    if (!intent.to) {
      return {
        success: false,
        message: "Who would you like to forward this to?",
        pendingAction: {
          action: 'forward_email',
          emailId: original.id,
        },
      };
    }

    const forwardBody = `
---------- Forwarded message ----------
From: ${original.from}
Date: ${formatDate(original.date)} ${formatTime(original.date)}
Subject: ${original.subject}

${original.body}
`;

    const draft = {
      to: intent.to,
      subject: `Fwd: ${original.subject}`,
      body: (intent.message || '') + forwardBody,
    };

    const preview = this.formatDraftPreview(draft);
    
    return {
      success: true,
      requiresConfirmation: true,
      confirmationType: 'send_email',
      pendingAction: {
        action: 'send_email',
        data: draft,
      },
      message: `📝 Forward this email?\n\n${preview}\n\n` +
               `Reply **yes** to send or **no** to cancel.`,
      draft,
    };
  }

  // ─────────────────────────────────────────────────────────────────────────
  // LLM Integration
  // ─────────────────────────────────────────────────────────────────────────

  async summarizeWithLLM(emails, intent) {
    const emailSummaries = emails.slice(0, 20).map(e => 
      `From: ${e.from}\nSubject: ${e.subject}\nDate: ${formatDate(e.date)}\nSnippet: ${e.snippet}`
    ).join('\n\n---\n\n');

    const prompt = `Summarize these emails${intent.from ? ` from ${intent.from}` : ''}${intent.topic ? ` about "${intent.topic}"` : ''}:

${emailSummaries}

Provide a concise summary organized by topic or sender. Highlight:
- Key action items
- Important deadlines
- Urgent matters
- Decisions needed

Format nicely with bullet points and bold for emphasis.`;

    return this.llm.generate(prompt, {
      maxTokens: 1000,
    });
  }

  async generateEmailBody(intent) {
    const prompt = `Draft a professional email:

To: ${intent.to}
Subject: ${intent.subject || intent.topic}
Tone: ${intent.tone || 'professional'}
Key points: ${intent.keyPoints || intent.body || 'none specified'}

Write only the email body (no greeting line needed - I'll add that).
Keep it concise but complete.`;

    return this.llm.generate(prompt, {
      maxTokens: 500,
    });
  }

  async generateReplyBody(original, intent) {
    const prompt = `Draft a reply to this email:

Original email from ${original.from}:
Subject: ${original.subject}
Body: ${original.snippet}

User wants to: ${intent.content || intent.response || 'reply appropriately'}
Tone: ${intent.tone || 'professional'}

Write only the reply body. Be concise but complete.
Don't include the quoted original - I'll handle that.`;

    return this.llm.generate(prompt, {
      maxTokens: 500,
    });
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Formatting Helpers
  // ─────────────────────────────────────────────────────────────────────────

  formatEmailList(emails, unreadCount, showUnreadOnly = false, title = null) {
    const header = title 
      ? `📬 **${title}** (${emails.length} emails):\n\n`
      : `📬 **Inbox** (${unreadCount} unread):\n\n`;

    const lines = [header];

    for (let i = 0; i < Math.min(emails.length, 10); i++) {
      const e = emails[i];
      const unreadMarker = e.isRead ? '' : '🔴 ';
      const attachMarker = e.hasAttachments ? '📎 ' : '';
      const timeAgo = this.formatTimeAgo(e.date);
      
      lines.push(`${unreadMarker}${attachMarker}**${e.from.split('<')[0].trim()}** (${timeAgo})`);
      lines.push(`"${e.subject}"`);
      lines.push('');
    }

    if (emails.length > 10) {
      lines.push(`\n...and ${emails.length - 10} more emails.`);
    }

    lines.push(`\nWould you like me to read or summarize any of these?`);

    return lines.join('\n');
  }

  formatFullEmail(email) {
    return `📧 **${email.subject}**

**From:** ${email.from}
**Date:** ${formatDate(email.date)} at ${formatTime(email.date)}
${email.hasAttachments ? `**Attachments:** ${email.attachments.map(a => a.filename).join(', ')}\n` : ''}
───────────────────

${email.body.slice(0, 2000)}${email.body.length > 2000 ? '\n\n...(truncated)' : ''}

───────────────────
Would you like to reply, forward, or archive this email?`;
  }

  formatDraftPreview(draft) {
    return `───────────────────
**To:** ${draft.to}
${draft.cc ? `**CC:** ${draft.cc}\n` : ''}**Subject:** ${draft.subject}

${draft.body}
───────────────────`;
  }

  formatTimeAgo(date) {
    const now = new Date();
    const diff = now - new Date(date);
    const minutes = Math.floor(diff / 60000);
    const hours = Math.floor(diff / 3600000);
    const days = Math.floor(diff / 86400000);

    if (minutes < 1) return 'just now';
    if (minutes < 60) return `${minutes}m ago`;
    if (hours < 24) return `${hours}h ago`;
    if (days < 7) return `${days}d ago`;
    return formatDate(date);
  }

  async auditLog(event, details) {
    // Implementation in audit-logger.js
    console.log(`[Audit] ${event}:`, details);
  }
}

module.exports = EmailHandler;
```

### Email NLP Parser

```javascript
// /src/lib/email/email-nlp.js

class EmailNLP {
  constructor(llmClient) {
    this.llm = llmClient;
  }

  /**
   * Parse a natural language email request into structured intent
   */
  async parseIntent(message) {
    const prompt = `Parse this email request into a structured action.

User request: "${message}"

Return JSON only (no markdown, no explanation):
{
  "action": "check_inbox|check_unread|search_emails|read_email|summarize_emails|draft_email|draft_reply|send_email|forward_email",
  "to": "recipient email if sending",
  "cc": "cc recipient if mentioned",
  "subject": "subject if mentioned",
  "body": "body content if provided",
  "from": "sender to search for",
  "query": "search query",
  "topic": "topic to search or summarize",
  "emailId": "specific email ID if referenced",
  "timeframe": "today|week|month if mentioned",
  "limit": "number of emails if mentioned",
  "content": "what to say in reply",
  "response": "type of response (approve, decline, etc.)",
  "tone": "formal|casual|friendly if mentioned"
}

Only include relevant fields.

Examples:
- "check my inbox" → {"action": "check_inbox"}
- "any unread emails?" → {"action": "check_unread"}
- "find emails from John" → {"action": "search_emails", "from": "John"}
- "summarize emails about the project" → {"action": "summarize_emails", "topic": "project"}
- "draft a reply saying I approve" → {"action": "draft_reply", "content": "approval"}
- "send an email to john@example.com about the meeting" → {"action": "draft_email", "to": "john@example.com", "topic": "meeting"}`;

    const response = await this.llm.generate(prompt, {
      maxTokens: 500,
      temperature: 0.1,
    });

    try {
      const cleaned = response
        .replace(/```json\n?/g, '')
        .replace(/```\n?/g, '')
        .trim();
      
      return JSON.parse(cleaned);
    } catch (e) {
      console.error('Failed to parse email intent:', e.message, response);
      return { action: 'unknown', raw: message };
    }
  }
}

module.exports = EmailNLP;
```

---

## Part 5: Human-in-the-Loop (HITL) Manager

```javascript
// /src/lib/hitl-manager.js

const { EventEmitter } = require('events');

class HITLManager extends EventEmitter {
  constructor(talkClient, config) {
    super();
    this.talk = talkClient;
    this.config = config;
    this.pendingApprovals = new Map();
    this.pendingActions = new Map(); // userId -> pending action
  }

  /**
   * Request approval from user for a sensitive action
   */
  async requestApproval(userId, request) {
    const approvalId = this.generateId();
    
    const pending = {
      id: approvalId,
      userId,
      request,
      createdAt: Date.now(),
      timeout: request.timeout || 300000, // 5 min default
      status: 'pending',
    };

    this.pendingApprovals.set(approvalId, pending);
    this.pendingActions.set(userId, pending);

    // Send the approval request message
    await this.talk.sendMessage(userId, request.message);

    // Set timeout
    setTimeout(() => {
      if (pending.status === 'pending') {
        pending.status = 'timeout';
        this.pendingApprovals.delete(approvalId);
        this.pendingActions.delete(userId);
        this.emit('timeout', pending);
      }
    }, pending.timeout);

    // Return a promise that resolves when user responds
    return new Promise((resolve) => {
      pending.resolve = resolve;
    });
  }

  /**
   * Process a user response to a pending approval
   */
  processResponse(userId, message) {
    const pending = this.pendingActions.get(userId);
    
    if (!pending || pending.status !== 'pending') {
      return null; // No pending action
    }

    const response = message.trim().toUpperCase();
    
    // Check for approval responses
    if (['YES', 'Y', 'CONFIRM', 'SEND', 'OK', 'APPROVE'].includes(response)) {
      pending.status = 'approved';
      pending.response = 'YES';
    } else if (['NO', 'N', 'CANCEL', 'ABORT', 'STOP'].includes(response)) {
      pending.status = 'rejected';
      pending.response = 'NO';
    } else if (['EDIT', 'CHANGE', 'MODIFY'].includes(response)) {
      pending.status = 'edit';
      pending.response = 'EDIT';
    } else {
      // Unknown response - treat as modification
      pending.status = 'edit';
      pending.response = 'EDIT';
      pending.modification = message;
    }

    // Clean up
    this.pendingApprovals.delete(pending.id);
    this.pendingActions.delete(userId);

    // Resolve the promise
    if (pending.resolve) {
      pending.resolve(pending);
    }

    return pending;
  }

  /**
   * Check if user has a pending action
   */
  hasPendingAction(userId) {
    return this.pendingActions.has(userId);
  }

  /**
   * Get pending action for user
   */
  getPendingAction(userId) {
    return this.pendingActions.get(userId);
  }

  /**
   * Cancel a pending action
   */
  cancelPending(userId) {
    const pending = this.pendingActions.get(userId);
    if (pending) {
      pending.status = 'cancelled';
      this.pendingApprovals.delete(pending.id);
      this.pendingActions.delete(userId);
      if (pending.resolve) {
        pending.resolve(pending);
      }
    }
  }

  generateId() {
    return `hitl_${Date.now()}_${Math.random().toString(36).slice(2)}`;
  }
}

module.exports = HITLManager;
```

---

## Part 6: Configuration

### Default Configuration

```javascript
// /src/config/default.js

module.exports = {
  // Nextcloud connection
  nextcloud: {
    url: process.env.NC_URL || 'https://your-nc.storageshare.de',
    user: process.env.NC_USER || 'moltagent',
    // Password loaded via systemd LoadCredential=
  },

  // NC Talk settings
  talk: {
    webhookPort: process.env.WEBHOOK_PORT || 3000,
    webhookPath: '/webhook',
    // Secret loaded via systemd LoadCredential=
  },

  // Email settings
  email: {
    // 'shared' = access user's mailbox
    // 'dedicated' = MoltAgent has its own email
    // 'both' = both modes enabled
    mode: process.env.EMAIL_MODE || 'shared',
    
    // For dedicated mode, the email address
    dedicatedAddress: process.env.EMAIL_DEDICATED_ADDRESS || null,
  },

  // Calendar settings
  calendar: {
    // Default calendar to use for new events
    defaultCalendar: 'personal',
    
    // Working hours for free/busy
    workingHours: {
      start: 9,
      end: 17,
    },
    
    // Exclude weekends from free slot search
    excludeWeekends: true,
  },

  // LLM settings
  llm: {
    // Primary provider
    provider: process.env.LLM_PROVIDER || 'ollama',
    
    // Ollama settings
    ollama: {
      url: process.env.OLLAMA_URL || 'http://localhost:11434',
      model: process.env.OLLAMA_MODEL || 'deepseek-r1:8b',
    },
    
    // Claude fallback (for quality-critical)
    claude: {
      credentialName: 'claude-api-key',
      model: 'claude-sonnet-4-20250514',
    },
  },

  // Human-in-the-loop settings
  hitl: {
    // Actions that require approval
    requireApproval: [
      'send_email',
      'forward_email',
      'delete_event',
      'create_event', // Optional: can be disabled
    ],
    
    // Timeout for approval requests (ms)
    approvalTimeout: 300000, // 5 minutes
  },

  // Audit logging
  audit: {
    enabled: true,
    logPath: '/moltagent/Logs',
    retentionDays: 90,
  },
};
```

### Systemd Service File

```ini
# /etc/systemd/system/moltagent.service

[Unit]
Description=MoltAgent AI Assistant
After=network.target

[Service]
Type=simple
User=moltagent
Group=moltagent
WorkingDirectory=/opt/moltagent

# Load credentials securely
LoadCredential=nc-password:/etc/credstore/moltagent/nc-password
LoadCredential=nc-talk-secret:/etc/credstore/moltagent/nc-talk-secret

# Environment
Environment=NODE_ENV=production
Environment=NC_URL=https://your-nc.storageshare.de
Environment=NC_USER=moltagent

# Start command
ExecStart=/usr/bin/node src/index.js

# Restart policy
Restart=always
RestartSec=10

# Security hardening
NoNewPrivileges=true
ProtectSystem=strict
ProtectHome=true
PrivateTmp=true

[Install]
WantedBy=multi-user.target
```

---

## Part 7: Setup Guide for Users

### Email Setup Options

#### Option A: Shared Access (Read User's Mailbox)

MoltAgent reads and helps manage your existing email account.

**Setup:**

1. Open NC Passwords app
2. Create entry: `email-imap`
   - Username: your email address
   - Password: your email password (or app password for Gmail)
   - In Notes field:
     ```
     host=imap.gmail.com
     port=993
     tls=true
     ```
3. Create entry: `email-smtp`
   - Username: your email address
   - Password: same password
   - In Notes field:
     ```
     host=smtp.gmail.com
     port=587
     tls=true
     from=Your Name <you@gmail.com>
     ```
4. Share both entries with `moltagent` user

**For Gmail users:**
- Go to Google Account → Security → 2-Step Verification → App passwords
- Create an app password for "Mail"
- Use this password instead of your regular password

**For Outlook/Office365:**
- Use your regular email and password
- Host: outlook.office365.com (IMAP) / smtp.office365.com (SMTP)

#### Option B: Dedicated Email Address

MoltAgent has its own email (e.g., ai@yourcompany.com) that people can CC or email directly.

**Setup:**

1. Create an email account for MoltAgent with your provider
2. In NC Passwords, create `email-imap-dedicated` and `email-smtp-dedicated`
3. Share with `moltagent` user
4. Set `EMAIL_MODE=dedicated` in MoltAgent config

**Use cases:**
- CC ai@company.com on emails you want MoltAgent to track
- Forward newsletters to ai@company.com for summarization
- Let customers email ai@company.com for initial triage

#### Option C: Both Modes

MoltAgent can access your mailbox AND have its own address.

Set `EMAIL_MODE=both` and configure both credential sets.

---

### Calendar Setup

Calendar access uses your Nextcloud credentials (already configured).

**To verify:**
1. Test: `@MoltAgent what's on my calendar today?`

**To share additional calendars:**
1. Open NC Calendar app
2. Click ⋮ next to the calendar
3. Share with `moltagent` user

---

## Part 8: Testing

### Test Commands

```bash
# Test calendar
@MoltAgent what's on my calendar today?
@MoltAgent schedule a test meeting tomorrow at 3pm
@MoltAgent find a free 30-minute slot this week
@MoltAgent delete the test meeting

# Test email
@MoltAgent check my inbox
@MoltAgent how many unread emails do I have?
@MoltAgent search for emails from [sender]
@MoltAgent summarize emails from this week
@MoltAgent draft a reply to the last email saying thanks

# Test HITL
# When MoltAgent asks for confirmation:
yes  → proceed with action
no   → cancel
edit → modify the draft
```

### Integration Test Script

```javascript
// /test/integration.test.js

const assert = require('assert');
const CalendarHandler = require('../src/lib/calendar/calendar-handler');
const EmailHandler = require('../src/lib/email/email-handler');

describe('Calendar Integration', () => {
  it('should fetch today events', async () => {
    const result = await calendarHandler.handle("what's on my calendar today?", 'testuser');
    assert(result.success);
  });

  it('should create event with confirmation', async () => {
    const result = await calendarHandler.handle(
      "schedule a meeting tomorrow at 2pm for 1 hour",
      'testuser'
    );
    assert(result.requiresConfirmation);
    assert(result.pendingAction.action === 'create_event');
  });

  it('should find free slots', async () => {
    const result = await calendarHandler.handle(
      "find a free 30 minute slot this week",
      'testuser'
    );
    assert(result.success);
    assert(result.slots.length > 0);
  });
});

describe('Email Integration', () => {
  it('should check inbox', async () => {
    const result = await emailHandler.handle("check my inbox", 'testuser');
    assert(result.success);
  });

  it('should search emails', async () => {
    const result = await emailHandler.handle("find emails from test@example.com", 'testuser');
    assert(result.success);
  });

  it('should draft reply with confirmation', async () => {
    const result = await emailHandler.handle(
      "draft a reply to the last email saying I agree",
      'testuser'
    );
    assert(result.requiresConfirmation);
    assert(result.draft);
  });
});
```

---

## Part 9: Security Considerations

### Credential Security

1. **No credentials in code or config files** - All credentials fetched from NC Passwords at runtime
2. **Immediate cleanup** - Credentials cleared from memory after use
3. **Minimal retention** - Credentials exist only during the operation
4. **Audit trail** - All credential access logged (without the credential values)

### Email Security

1. **HITL for all outgoing email** - MoltAgent NEVER sends email without explicit user approval
2. **Draft preview** - User sees exactly what will be sent before confirming
3. **Audit logging** - All sent emails logged with recipient, subject, timestamp
4. **No automatic forwarding** - Cannot be configured to auto-forward sensitive emails

### Calendar Security

1. **HITL for modifications** - Creating/updating/deleting events requires confirmation
2. **Read access by default** - Query operations don't require approval
3. **Conflict warnings** - User alerted before creating conflicting events

### Data Sovereignty

1. **All data in NC** - Emails, calendars, logs stored in user's Nextcloud
2. **No external storage** - MoltAgent doesn't store data outside NC
3. **Local LLM option** - Sensitive content processed by local Ollama
4. **GDPR compliant** - Data stays in user-controlled infrastructure

---

## Appendix A: Provider-Specific Email Setup

### Gmail

```
IMAP:
  host: imap.gmail.com
  port: 993
  tls: true

SMTP:
  host: smtp.gmail.com
  port: 587
  tls: true

Notes:
- Enable "Less secure app access" OR
- Create App Password (recommended):
  1. Enable 2-Step Verification
  2. Go to Security → App passwords
  3. Create password for "Mail"
  4. Use this as password in NC Passwords
```

### Outlook/Office 365

```
IMAP:
  host: outlook.office365.com
  port: 993
  tls: true

SMTP:
  host: smtp.office365.com
  port: 587
  tls: true

Notes:
- Use regular email/password
- May need to enable IMAP in Outlook settings
```

### Custom/Self-hosted

```
IMAP:
  host: mail.yourdomain.com
  port: 993 (or 143 for non-TLS)
  tls: true/false

SMTP:
  host: mail.yourdomain.com
  port: 587 (or 465 for SSL, 25 for non-TLS)
  tls: true/false

Notes:
- Check with your email provider for exact settings
- Some providers require specific security settings
```

---

## Appendix B: Dependencies

```json
{
  "dependencies": {
    "tsdav": "^2.1.0",
    "ical.js": "^1.5.0",
    "imap": "^0.8.19",
    "mailparser": "^3.6.5",
    "nodemailer": "^6.9.8",
    "node-fetch": "^2.7.0",
    "uuid": "^9.0.0",
    "express": "^4.18.2"
  },
  "devDependencies": {
    "mocha": "^10.2.0"
  }
}
```

---

*End of Specification*
