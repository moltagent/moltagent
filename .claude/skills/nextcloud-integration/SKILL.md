---
name: nextcloud-integration
description: >
  Nextcloud API patterns for Moltagent. Triggers when working on Collectives,
  Deck, Talk, Calendar, Mail, Files, Contacts, or any NC integration.
  Also triggers on: WebDAV, OCS, CalDAV, CardDAV, ActivityPoller, NC API,
  remote.php, ocs/v2.php, collective, deck board, talk room.
---

# Nextcloud Integration Patterns

## API Conventions

All NC APIs use the Moltagent service account credentials from environment:
```javascript
const auth = `${process.env.NC_USER}:${process.env.NC_PASSWORD}`;
const baseUrl = process.env.NC_URL; // e.g., https://nextcloud.example.com
```

### OCS API (Deck, Talk, Forms, Contacts)
```javascript
// Always include OCS-APIRequest header
headers: { 'OCS-APIRequest': 'true' }
// Base: ${NC_URL}/ocs/v2.php/apps/{app}/api/v1/
// Response format: { ocs: { data: ... } }
```

### WebDAV (Files, Collectives pages)
```javascript
// Base: ${NC_URL}/remote.php/dav/files/${NC_USER}/
// Methods: GET (read), PUT (write), MKCOL (mkdir), DELETE, PROPFIND
// Collectives pages: ${NC_URL}/remote.php/dav/files/${NC_USER}/Collectives/...
```

### CalDAV (Calendar)
```javascript
// Base: ${NC_URL}/remote.php/dav/calendars/${NC_USER}/
// Uses iCal format (.ics)
```

### CardDAV (Contacts)
```javascript
// Base: ${NC_URL}/remote.php/dav/addressbooks/users/${NC_USER}/
// Uses vCard format (.vcf)
```

## Collectives Wiki

- Collective name: "Moltagent Knowledge"
- Pages are markdown files accessed via WebDAV
- Frontmatter uses YAML between `---` delimiters
- Page creation: PUT to WebDAV path
- Page listing: PROPFIND on collective directory
- Sections are subfolders: People/, Projects/, Components/, etc.
- The `(2)` suffix means Collectives created a collision — your dedup missed

## Deck Boards

- MoltAgent Tasks board (ID 8): agent's work queue
- Content Pipeline board (ID 144): content workflow
- Cockpit board (ID 14): agent configuration
- Cards have: title, description, labels, due dates, assigned users
- Stacks: Inbox → Queued → Working → Review → Done → Reference
- Labels are STATE, not tags: GATE, APPROVED, REJECTED, PAUSED, SCHEDULED, ERROR
- PAUSED always wins over SCHEDULED

## Talk

- Webhook-based message receiving
- Bot registration required for each room
- Messages sent via OCS Talk API
- @mention pipeline wired to processMessage()
- Markdown formatting supported

## Common Gotchas

- **Collectives page titles with special characters** get URL-encoded in WebDAV paths
- **OCS API returns 200 even for errors** — always check the response body
- **WebDAV PUT creates OR overwrites** — no built-in conflict detection
- **Deck card search** matches title AND description — can return too many results
- **Talk bot messages** must not exceed NC's message length limit
- **ActivityPoller** runs on 60s cycle — file changes aren't instant
- **StorageShare instances** don't support all NC apps — verify before assuming availability
