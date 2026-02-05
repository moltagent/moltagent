# Moltagent: Live Status Indicator via NC User Status API

**Date:** 2026-02-10
**Author:** Fu + Claude Opus
**For:** Claude Code
**Effort:** ~30 minutes
**Depends on:** webhook-server.js (message handling), HeartbeatManager (pulse cycle)

---

## What This Builds

Make Molti's NC user status reflect its real-time state. Users see a live indicator next to Molti's avatar in Talk, Contacts, and the user list — just like seeing a colleague go from "available" to "in a meeting."

---

## NC User Status API

**Set status:**

```
PUT /ocs/v2.php/apps/user_status/api/v1/user_status/status
Headers: OCS-APIRequest: true
Body: {"statusType": "online"}
```

Valid statusType values: `online`, `away`, `dnd`, `invisible`, `offline`

**Set custom message:**

```
PUT /ocs/v2.php/apps/user_status/api/v1/user_status/message/custom
Headers: OCS-APIRequest: true
Body: {
  "statusIcon": "🟢",
  "message": "Ready",
  "clearAt": null
}
```

`clearAt` can be a Unix timestamp to auto-clear, or `null` for persistent.

**Clear custom message:**

```
DELETE /ocs/v2.php/apps/user_status/api/v1/user_status/message
```

All calls authenticated as the Moltagent NC user.

---

## State Mapping

| Molti State | statusType | Icon | Message | When |
|---|---|---|---|---|
| Ready / Idle | `online` | 🟢 | "Ready" | Default state, after processing completes |
| Processing message | `dnd` | 🧠 | "Thinking..." | When webhook received, before LLM call |
| Heartbeat pulse | `online` | 💓 | "Checking in..." | During pulse() execution |
| Error / degraded | `away` | ⚠️ | "Having issues" | After repeated failures |
| Budget exceeded | `away` | 💰 | "Budget limit reached" | When BudgetEnforcer blocks |
| Startup | `online` | 🚀 | "Starting up..." | During initialization |
| Shutdown | `offline` | — | — | On SIGTERM/graceful shutdown |

---

## File: `src/lib/integrations/status-reporter.js` — CREATE

```javascript
class StatusReporter {
  constructor({ ncRequestManager, config }) {
    this.nc = ncRequestManager;
    this.config = config;
    this.currentStatus = null;
    this.enabled = config?.statusReporter?.enabled !== false; // Default: on
  }

  /**
   * Set Molti's NC user status.
   * @param {'ready'|'thinking'|'heartbeat'|'error'|'budget'|'startup'|'shutdown'} state
   */
  async setStatus(state) {
    if (!this.enabled) return;
    if (state === this.currentStatus) return; // No-op if unchanged
    
    const mapping = {
      ready:     { statusType: 'online',  icon: '🟢', message: 'Ready' },
      thinking:  { statusType: 'dnd',     icon: '🧠', message: 'Thinking...' },
      heartbeat: { statusType: 'online',  icon: '💓', message: 'Checking in...' },
      error:     { statusType: 'away',    icon: '⚠️', message: 'Having issues' },
      budget:    { statusType: 'away',    icon: '💰', message: 'Budget limit reached' },
      startup:   { statusType: 'online',  icon: '🚀', message: 'Starting up...' },
      shutdown:  { statusType: 'offline', icon: null,  message: null },
    };
    
    const s = mapping[state];
    if (!s) return;
    
    try {
      // Set presence status
      await this.nc.ocsRequest('PUT', 
        '/apps/user_status/api/v1/user_status/status',
        { statusType: s.statusType }
      );
      
      // Set custom message (or clear on shutdown)
      if (s.message) {
        await this.nc.ocsRequest('PUT',
          '/apps/user_status/api/v1/user_status/message/custom',
          { statusIcon: s.icon, message: s.message, clearAt: null }
        );
      } else {
        await this.nc.ocsRequest('DELETE',
          '/apps/user_status/api/v1/user_status/message'
        );
      }
      
      this.currentStatus = state;
    } catch (err) {
      // Status updates are best-effort — never block main operations
      console.warn(`[Status] Failed to set ${state}:`, err.message);
    }
  }
}

module.exports = StatusReporter;
```

---

## Wiring

### webhook-server.js

```javascript
const StatusReporter = require('./src/lib/integrations/status-reporter');

// During initialization (after ncRequestManager is ready):
const statusReporter = new StatusReporter({ ncRequestManager, config });
await statusReporter.setStatus('startup');

// After server is listening and heartbeat started:
await statusReporter.setStatus('ready');

// In message handler (when webhook arrives with a user message):
await statusReporter.setStatus('thinking');
// ... process message, get LLM response, send reply ...
await statusReporter.setStatus('ready');

// In HeartbeatManager.pulse() — pass statusReporter to HeartbeatManager:
// At pulse start:
await this.statusReporter?.setStatus('heartbeat');
// At pulse end:
await this.statusReporter?.setStatus('ready');

// On BudgetEnforcer block:
await statusReporter.setStatus('budget');

// On shutdown (SIGTERM handler):
await statusReporter.setStatus('shutdown');
```

### HeartbeatManager — accept statusReporter

```javascript
// In constructor:
this.statusReporter = config.statusReporter || null;

// In pulse():
await this.statusReporter?.setStatus('heartbeat');
// ... existing pulse logic ...
await this.statusReporter?.setStatus('ready');
```

### Error handling — set error status on repeated failures

```javascript
// In the webhook handler's catch block, or after N consecutive LLM failures:
if (consecutiveErrors >= 3) {
  await statusReporter.setStatus('error');
}
// Reset on next successful response:
await statusReporter.setStatus('ready');
```

---

## Edge Cases

- **Rapid state changes:** If a message arrives during a heartbeat pulse, status flips thinking→heartbeat→thinking. This is fine — the `currentStatus` check prevents redundant API calls, and NC handles rapid updates gracefully.
- **NC rate limiting:** Status updates are lightweight OCS calls. At worst ~10/hour (2 per message + 2 per pulse). Well within StorageShare limits.
- **Startup before NC is ready:** The first `setStatus('startup')` might fail if NC isn't reachable yet. That's fine — it's best-effort with a try/catch.
- **Status stale after crash:** If the process crashes without graceful shutdown, status stays at last value. NC will eventually show the user as "offline" based on activity timeout, but this could take a while. Not worth solving — crashes should be rare.

---

## Config

```javascript
// config.js:
statusReporter: {
  enabled: envBool('STATUS_REPORTER_ENABLED', true),
}
```

```bash
# .env.example:
# STATUS_REPORTER_ENABLED=true  # Set Molti's NC user status based on activity
```

---

## Tests (~4)

1. setStatus('ready') calls OCS with statusType 'online' and message 'Ready'
2. setStatus() skips API call when state unchanged (no-op optimization)
3. setStatus('shutdown') calls DELETE on custom message
4. setStatus() doesn't throw on API failure (best-effort)

---

## Verification

After deployment:
1. Open NC → Users or Contacts → find Moltagent → status should show 🟢 "Ready"
2. Send a message in Talk → status briefly shows 🧠 "Thinking..." → then back to 🟢 "Ready"
3. Wait for heartbeat pulse → status briefly shows 💓 "Checking in..." → back to 🟢 "Ready"
4. Check Talk conversation list → Molti's avatar should have the green dot

---

*A small touch that makes Molti feel alive. Users see their AI colleague come online, think, and settle back — just like a human teammate.*
