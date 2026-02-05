# Fix: Auto-Enroll Bot in New Rooms

**Problem:** When the Moltagent USER is added to a new Talk room, the Moltagent BOT 
(webhook endpoint) is not automatically enabled in that room. The user can see the room 
and participate, but webhooks don't fire — so Molti can't hear messages.

**Why:** NC Talk has two separate concepts:
- **User participant** — the Moltagent NC user, added to rooms like any human
- **Bot registration** — the webhook endpoint registered via Bot Management API, must be 
  explicitly enabled per room

BotEnroller currently runs once at startup: discovers rooms the user is in, enables the 
bot in any that don't have it. But after startup, new rooms are never checked.

**Fix: Add periodic room scanning to the heartbeat pulse.**

The heartbeat already runs every 5 minutes. Add a lightweight room check that:
1. Lists all rooms the Moltagent user is in (GET /apps/spreed/api/v4/room)
2. For each room, checks if bot is enabled
3. Enables bot in any room where it's missing

This is exactly what BotEnroller already does — we just need to call it periodically 
instead of only at startup.

## Implementation

### Option A: Run BotEnroller on heartbeat (simplest)

In HeartbeatManager.pulse(), call BotEnroller.enrollAll() on every pulse (or every Nth pulse 
to reduce API calls):

```javascript
// In pulse(), add:
if (this.pulseCount % 6 === 0 && this.botEnroller) {  // Every 30 minutes (6 * 5min)
  try {
    const enrolled = await this.botEnroller.enrollAll();
    if (enrolled > 0) {
      console.log(`[Heartbeat] Bot enrolled in ${enrolled} new room(s)`);
    }
  } catch (err) {
    console.warn('[Heartbeat] Bot enrollment check failed:', err.message);
  }
}
```

Pass botEnroller to HeartbeatManager during construction in webhook-server.js.

### Option B: Check on every incoming webhook (alternative)

When a webhook arrives and signature verification fails OR when processing a message 
from an unknown room, try to enroll the bot. This is more reactive but only triggers 
when messages are actually sent.

### Recommendation: Option A

Option A is simpler and catches rooms even before anyone sends a message. The API cost 
is minimal — one room list call every 30 minutes.

### Wiring in webhook-server.js

```javascript
// Where HeartbeatManager is constructed, pass botEnroller:
const heartbeatManager = new HeartbeatManager({
  // ... existing deps ...
  botEnroller,  // ADD THIS
});
```

### HeartbeatManager changes

```javascript
// In constructor:
this.botEnroller = config.botEnroller || null;
this.pulseCount = 0;

// In pulse():
this.pulseCount++;

// Every 30 minutes, check for new rooms needing bot enrollment
if (this.pulseCount % 6 === 0 && this.botEnroller) {
  try {
    const result = await this.botEnroller.enrollAll();
    if (result.enrolled > 0) {
      console.log(`[Heartbeat] Bot enrolled in ${result.enrolled} new room(s)`);
    }
  } catch (err) {
    console.warn('[Heartbeat] Bot enrollment failed:', err.message);
    results.errors.push({ component: 'botEnroller', error: err.message });
  }
}
```

## Verification

1. Start service, confirm existing rooms work
2. Create a new room in NC Talk, add Moltagent user
3. Wait up to 30 minutes (or restart service for immediate enrollment)
4. Send message in new room → Molti should respond
5. Check logs for "[Heartbeat] Bot enrolled in 1 new room(s)"

## Note on Timing

The 30-minute interval means there's a delay between adding Molti to a room and the bot 
becoming active. For immediate enrollment, the user can restart the service or send a 
message that triggers the webhook (which will fail but can trigger a retry). 

If faster response is needed, reduce the interval to every pulse (5 minutes) — the API 
cost is just one GET call per cycle.
