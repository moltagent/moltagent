# MoltAgent CalDAV & Heartbeat Integration

## Overview

This package adds calendar capabilities and automated background processing to MoltAgent:

- **CalDAV Client**: Full calendar operations (events, scheduling, availability)
- **Heartbeat Manager**: Periodic processing of Deck tasks and calendar monitoring

## Installation

```bash
# On the bot server
cd /opt/moltagent
tar -xzf moltagent-caldav-heartbeat.tar.gz
cp -r moltagent-caldav/src/lib/integrations/* src/lib/integrations/
```

## CalDAV Client

### Features

| Feature | Description |
|---------|-------------|
| Calendar Discovery | List all calendars (owned + shared) |
| Event CRUD | Create, read, update, delete events |
| Time Range Queries | Get events between dates |
| Availability | Check free/busy status |
| Free Slot Finder | Find available meeting times |
| Meeting Scheduling | Create events with attendees |
| Invitations | Send meeting invites via email |

### Basic Usage

```javascript
const CalDAVClient = require('./src/lib/integrations/caldav-client');

const caldav = new CalDAVClient({
  ncUrl: 'https://nx89136.your-storageshare.de',
  username: 'moltagent',
  password: 'xxx'
});

// List calendars
const calendars = await caldav.getCalendars();

// Get today's events
const events = await caldav.getTodayEvents();

// Create an event
const event = await caldav.createEvent({
  summary: 'Team Meeting',
  start: new Date('2026-02-04T10:00:00'),
  end: new Date('2026-02-04T11:00:00'),
  location: 'Conference Room A',
  description: 'Weekly sync'
});

// Check availability
const available = await caldav.checkAvailability(
  new Date('2026-02-04T14:00:00'),
  new Date('2026-02-04T15:00:00')
);

// Find free 1-hour slots this week
const freeSlots = await caldav.findFreeSlots(
  new Date(),
  new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
  60,
  { workdayStart: 9, workdayEnd: 17, excludeWeekends: true }
);

// Schedule a meeting with attendees
const meeting = await caldav.scheduleMeeting({
  summary: 'Project Review',
  start: new Date('2026-02-05T15:00:00'),
  end: new Date('2026-02-05T16:00:00'),
  attendees: ['alice@example.com', 'bob@example.com'],
  organizerEmail: 'moltagent@yourdomain.com'
});
```

### Calendar Sharing

For the bot to see shared calendars:

1. Go to Nextcloud Calendar app
2. Click the three dots next to a calendar
3. Click "Share"
4. Add "Moltagent" user
5. Set permission (view or edit)

## Heartbeat Manager

The heartbeat runs periodic background operations.

### What It Does

Every 5 minutes (configurable):

1. **Deck Processing**: Checks inbox for new tasks, processes up to 3 per cycle
2. **Calendar Monitoring**: Alerts about meetings starting in the next 15-30 minutes
3. **Context Gathering**: Provides system awareness for LLM operations

### Configuration

```javascript
const HeartbeatManager = require('./src/lib/integrations/heartbeat-manager');

const heartbeat = new HeartbeatManager({
  nextcloud: {
    url: 'https://nx89136.your-storageshare.de',
    username: 'moltagent',
    password: 'xxx'
  },
  deck: {
    boardId: 8
  },
  heartbeat: {
    intervalMs: 5 * 60 * 1000,         // 5 minutes
    deckEnabled: true,
    caldavEnabled: true,
    maxTasksPerCycle: 3,
    calendarLookaheadMinutes: 30,
    notifyUpcomingMeetings: true,
    quietHoursStart: 22,               // 10 PM
    quietHoursEnd: 7                   // 7 AM
  },
  llmRouter: yourLLMRouter,            // For task processing
  notifyUser: async (notification) => {
    // Send to Talk, Telegram, etc.
    console.log(notification.message);
  },
  auditLog: async (event, data) => {
    // Log to /moltagent/Logs/
  }
});

// Start the heartbeat
await heartbeat.start();

// Get status
const status = heartbeat.getStatus();

// Get context for LLM
const context = await heartbeat.getHeartbeatContext();

// Stop when needed
await heartbeat.stop();
```

### Quiet Hours

During quiet hours (default 10 PM - 7 AM), the heartbeat runs in minimal mode:
- No task processing
- No meeting notifications
- Just status updates

## Testing

```bash
# On the bot server
cd /opt/moltagent

# Test CalDAV
node scripts/test-caldav.js

# Test Heartbeat
node scripts/test-heartbeat.js
```

## Integration with Main Bot

Add to your main bot initialization:

```javascript
const { CalDAVClient, HeartbeatManager } = require('./moltagent-caldav');

// Initialize
const heartbeat = new HeartbeatManager({ ... });

// Start with the bot
await heartbeat.start();

// In Talk command handler
if (command === '/calendar') {
  const summary = await heartbeat.caldavClient.getTodaySummary();
  return summary.text;
}

if (command === '/status') {
  const status = heartbeat.getStatus();
  return `Heartbeat: ${status.isRunning ? 'Running' : 'Stopped'}
Last run: ${status.lastRun}
Tasks today: ${status.tasksProcessedToday}
Notifications: ${status.notificationsSentToday}`;
}
```

## API Reference

### CalDAVClient

| Method | Description |
|--------|-------------|
| `getCalendars()` | List all calendars |
| `getEventCalendars()` | List calendars that support events |
| `getCalendar(id)` | Get specific calendar |
| `getEvents(calId, start, end)` | Get events in time range |
| `getTodayEvents()` | Get today's events |
| `getUpcomingEvents(hours)` | Get events in next N hours |
| `getEvent(calId, uid)` | Get specific event |
| `createEvent(event)` | Create new event |
| `updateEvent(calId, uid, updates)` | Update existing event |
| `deleteEvent(calId, uid)` | Delete event |
| `checkAvailability(start, end)` | Check if time slot is free |
| `findFreeSlots(start, end, duration)` | Find available slots |
| `amIFreeAt(datetime)` | Quick free/busy check |
| `scheduleMeeting(meeting)` | Create event with attendees |
| `cancelMeeting(calId, uid)` | Cancel meeting |
| `getTodaySummary()` | Human-readable today summary |
| `quickSchedule(summary, time, duration)` | Quick event creation |

### HeartbeatManager

| Method | Description |
|--------|-------------|
| `start()` | Start the heartbeat loop |
| `stop()` | Stop the heartbeat loop |
| `pulse()` | Run single heartbeat cycle |
| `forcePulse()` | Force immediate pulse |
| `getStatus()` | Get current status |
| `getHeartbeatContext()` | Get context for LLM |
| `resetDailyCounters()` | Reset daily stats |

## Architecture

```
┌─────────────────────────────────────────────────────────────────────────┐
│                        HEARTBEAT MANAGER                                │
│                                                                         │
│  ┌─────────────────┐     ┌─────────────────┐     ┌─────────────────┐  │
│  │  Deck Client    │     │  CalDAV Client  │     │   LLM Router    │  │
│  │                 │     │                 │     │                 │  │
│  │  • Get inbox    │     │  • Get events   │     │  • Process task │  │
│  │  • Move cards   │     │  • Check free   │     │  • Classify     │  │
│  │  • Add comments │     │  • Create event │     │  • Generate     │  │
│  └────────┬────────┘     └────────┬────────┘     └────────┬────────┘  │
│           │                       │                       │            │
│           └───────────────────────┼───────────────────────┘            │
│                                   │                                    │
│                           ┌───────┴───────┐                            │
│                           │  Pulse Loop   │                            │
│                           │  (5 min)      │                            │
│                           └───────────────┘                            │
│                                   │                                    │
│                           ┌───────┴───────┐                            │
│                           │ Notifications │                            │
│                           │ Audit Logs    │                            │
│                           └───────────────┘                            │
└─────────────────────────────────────────────────────────────────────────┘
```

## Cost Notes

- **CalDAV operations**: Free (local API calls to your NC)
- **Heartbeat scanning**: Uses local LLM or NC Assistant (no external API cost)
- **Task processing**: Routed per task type (research→value tier, writing→premium if client-facing)

The heartbeat is designed to be cost-efficient by doing most work locally.
