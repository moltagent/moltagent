# Moltagent Prime -- Forensic Report

**Generated:** 2026-02-15 01:35 UTC
**By:** Claude Code forensic analysis session
**Scope:** All activity from 2026-02-01 through 2026-02-15

---

## 1. Service Health

| Metric | Value |
|--------|-------|
| **Current status** | `active (running)` -- PID 155901 |
| **Uptime since** | 2026-02-12 02:24:59 UTC (~72 hours) |
| **Total starts (since Feb 1)** | 2,342 |
| **Total failures (since Feb 1)** | 2,230 |
| **Core dumps** | 1 (Feb 9) |
| **Failures since current start** | **0** |
| **Heartbeat interval** | Confirmed ~297s avg (expected: 300s, range: 262-310s) |
| **Heartbeat stability** | Stable -- 1,120 total pulses, 99.7% error-free |
| **Host** | moltagent-bot-01 |

### Crash History

| Period | Failures | Cause |
|--------|----------|-------|
| Feb 2 (15:50-15:54) | ~20 | **EADDRINUSE crash loop** -- port 3000 still occupied on restart |
| Feb 2 (17:10-17:19) | ~30+ | Same EADDRINUSE pattern after stop/restart |
| Feb 4 (00:59-06:03) | ~40+ | Multiple restart cycles during development sessions |
| Feb 4-9 | ~2,100+ | Continued instability during development iterations |
| Feb 9 | 1 core dump | Unspecified |
| **Feb 12-present** | **0** | **Stable** -- service description changed, new deployment |

**Root cause of crash loop:** `throw er; // Unhandled 'error' event` in webhook server startup -- Node.js HTTP server lacking `server.on('error', ...)` handler, combined with `Restart=always` in systemd causing rapid respawn before the port was released.

---

## 2. LLM Usage (Actual Costs)

### LLM Router Calls (chat, email, calendar)

| Metric | Value |
|--------|-------|
| **Total LLM calls** | 72 |
| **Ollama-local calls** | 71 (deepseek-r1:8b) |
| **DeepSeek API calls** | 1 |
| **Claude API calls (via router)** | **0** |
| **Total tokens** | 50,740 |
| **Last LLM call** | 2026-02-08 18:34:44 |

**Calls by task type:**

| Task | Count |
|------|-------|
| chat | 43 |
| email_parse | 12 |
| calendar_parse | 9 |
| email_analyze | 8 |

### Agent Loop Calls (tool-use conversations via Claude)

Starting Feb 9, the agent-loop system (separate from the LLM router) used Claude Sonnet 4 (`claude-sonnet-4-20250514`) for tool-calling conversations. These calls are NOT tracked by the LLM router's budget system.

| Finding | Detail |
|---------|--------|
| Claude agent-loop active | Feb 9 onward |
| Model used | claude-sonnet-4-20250514 |
| Rate limit hits | 4+ occurrences (429 -- org limit: 30,000 input tokens/min) |
| Cost tracking | **NOT tracked** -- agent-loop bypasses BudgetEnforcer |

### Estimated Actual Cost

| Provider | Cost |
|----------|------|
| Ollama-local | **free** (self-hosted deepseek-r1:8b) |
| DeepSeek API | ~$0.000005 |
| Claude API (agent-loop) | **Unknown** -- calls made but not metered by MoltAgent |
| **Total tracked** | **~$0.00** |

### Why Cockpit Shows "Total: 0.00"

**BUG: Data structure mismatch in cockpit-manager.js**

The `_formatCostStatus()` method accesses the wrong field path:

| Location | Code | Expected |
|----------|------|----------|
| `cockpit-manager.js:1068` | `summary?.dailyCost` | `summary?.daily?.cost` |
| `cockpit-manager.js:1072` | `summary?.dailyCalls` | `summary?.daily?.calls` |

The `BudgetEnforcer.getFullReport()` returns a nested structure:
```
providers[id].daily.cost   // correct path
providers[id].dailyCost    // what the formatter reads (undefined)
```

**Irony:** The sister method `_formatDailyCostStatus()` at line 1114 uses the CORRECT path (`summary?.daily?.cost`). Copy-paste inconsistency.

**Fix location:** `/opt/moltagent/src/lib/integrations/cockpit-manager.js:1068,1072`

**Additional issue:** Even when fixed, Ollama costs will always show 0 (costModel = 'free'). Claude agent-loop costs are NOT routed through BudgetEnforcer at all, so they remain invisible.

---

## 3. Wiki Duplicate Bug

### Findings

| Metric | Value |
|--------|-------|
| "Video: 5-minute Moltagent setup" copies | ~10 |
| Creation trigger | Content Pipeline workflow card processing |
| Wiki 500 errors | 60+ (search failures) |
| Wiki bootstrap errors | Multiple (404 on PUT, undefined collective ID) |

### Root Cause: Missing dedup check before createPage()

**File:** `/opt/moltagent/src/lib/agent/tool-registry.js` lines 1618-1701

The `wiki_write` tool handler:
1. **Line 1626:** Checks if page exists via `findPageByTitle()` -- correct
2. **Lines 1644-1657:** If exists, updates it -- correct
3. **Line 1680:** If NOT found, calls `createPage()` -- **no re-check before creation**

**The race condition:**
- Workflow LLM retries call `wiki_write` multiple times for the same page
- `findPageByTitle()` calls `searchPages()` which may timeout (500 error) or return stale results
- Falls back to `listPages()` which may not yet reflect the recently created page (eventual consistency)
- Returns null even though the page was just created by a prior attempt
- `createPage()` creates another duplicate

**Contributing factor:** The Collectives search API returns HTTP 500 frequently (60+ times), forcing fallback to list scanning which is slower and more prone to stale data.

**Fix location:** `/opt/moltagent/src/lib/agent/tool-registry.js:1679` -- add final existence check before `createPage()`

---

## 4. Cockpit Counter Bug -- "Tasks This Week: all zeros"

### Root Cause: Incomplete implementation (TODO not done)

**File:** `/opt/moltagent/src/lib/integrations/heartbeat-manager.js:507`

```javascript
tasks: null, // TODO: Wire to Deck task summary when available
```

**This is not a bug -- it's a missing feature.** The heartbeat explicitly passes `null` for tasks.

### The Missing Wire

| Component | Status | Issue |
|-----------|--------|-------|
| Data source (`DeckClient.getWorkloadSummary`) | Exists | Returns: `{inbox, queued, working, review, done, total}` |
| Wiring in heartbeat (line 507) | **Missing** | Hardcoded `tasks: null` with TODO |
| Display formatter (`_formatTaskStatus`) | Exists | Expects: `{open, inProgress, completed, overdue}` |
| Field transformation | **Missing** | Stack names != status names |

### Why All Zeros

1. HeartbeatManager passes `tasks: null` (line 507)
2. CockpitManager receives null
3. `_formatTaskStatus(null)` evaluates all `null?.field || 0` to `0`
4. Card shows: "Open: 0 -- In Progress: 0 -- Completed: 0 -- Overdue: 0"

### Fix Required

Two changes needed:
1. **heartbeat-manager.js:507** -- Replace `null` with actual `deckClient.getWorkloadSummary()` call
2. **Add transformation** -- Map stack names to status names:
   - `open` = `inbox` + `queued`
   - `inProgress` = `working`
   - `completed` = `done` (filtered by this week)
   - `overdue` = cards with past due dates

---

## 5. Workflow Engine Activity

| Metric | Value |
|--------|-------|
| Boards detected | 6 workflow boards |
| Board names | Demo: Client Onboarding, Content Pipeline, Expense Processing, Sales Pipeline, Support Triage, Weekly Review |
| Total workflow events | 1,120+ DeckProcessor events |
| Cards processed (current period) | 0 |
| Gates resolved (current period) | 0 |
| Failed comment attempts (403) | 46 |
| Deck tool failures (403 auth) | 98 |

**Assessment: Partially functional.** The WorkflowDetector correctly identifies 6 boards every heartbeat. The WorkflowEngine runs every 5 minutes. But the Deck API returns 403 Authentication errors for tool operations (read boards, list stacks, add comments, move cards), blocking all actual card processing.

The DeckProcessor finds 2 cards assigned to MoltAgent each cycle but the heartbeat pulse consistently reports `deckTasksProcessed: 0` because processing attempts hit 403 errors.

**Earlier period (Feb 4-8):** The workflow engine was actively processing demo cards before the 403 errors started. LLM calls for workflow tasks (email_parse, email_analyze, calendar_parse) confirm actual demo processing occurred.

---

## 6. Error Summary

| Error Pattern | Count | Impact |
|---------------|-------|--------|
| Deck 403 Authentication | ~98 | **HIGH** -- All Deck operations blocked |
| Ollama timeouts (120-300s) | ~75+ | **HIGH** -- Chat/workflow fails silently |
| Wiki search HTTP 500 | ~60+ | **HIGH** -- Knowledge base unreachable |
| Talk 429 rate limit | ~1,857 total | **MEDIUM** -- Self-talk loop cascade (Feb 4) |
| Claude API 429 rate limit | 4+ | **MEDIUM** -- Agent-loop blocked |
| EADDRINUSE crash loop | ~20 | **MEDIUM** (resolved Feb 12) |
| nc-talk-secret not found | ~50+ | **LOW** -- Webhook signature never verified |
| IMAP ECONNREFUSED | few | **LOW** -- Email checking fails |
| Claude 400 empty message | 1 | **LOW** -- Bot-to-bot message |
| Webhook TypeError (.toLowerCase) | 1 | **LOW** -- Missing null check |
| DeckClient init (no NCRequestManager) | 3 | **MEDIUM** -- Heartbeat deck processing broken |

### Critical Discovery: Self-Talk Loop (Feb 4)

On Feb 4 01:22-01:27, the agent entered a **self-talk feedback loop**:
1. Funana sends "Hi, How are you?"
2. Agent responds via LLM
3. Agent receives its OWN response as a new incoming message (via webhook)
4. Agent generates ANOTHER response to its own message
5. Loop repeats 6+ times until hitting 429 rate limits
6. 429 cascade blocked Talk replies, credential lookups, and audit logging simultaneously

**Root cause:** The webhook handler processes messages from ALL users including the bot itself. No self-message filter exists.

---

## 7. Talk Activity

| Metric | Value |
|--------|-------|
| Total chat_incoming events | 422 |
| Messages from Funana | 404 |
| Messages from Moltagent (self) | 8 |
| Messages from bots | 6 |
| Messages from unknown | 2 |
| Messages from guests/system | 2 |
| Talk room token | strte9d4 |
| LLM-powered responses | 72 (all via ollama-local until Feb 8) |
| Failed Talk replies (429) | 5+ |

### Conversation Topics (from Funana)

| Date | Topic |
|------|-------|
| Feb 2 | First test message ("Hello") |
| Feb 4 | "Hi, How are you?" / "How's it going?" / "Can you read the cards in your Deck?" |
| Feb 4 | Email tasks, calendar queries |
| Feb 5-6 | Email analysis, calendar parsing |
| Feb 6 | Chat conversations (5 messages) |
| Feb 8 | Last chat LLM calls (4 calls) |
| Feb 9+ | Agent-loop conversations via Claude (tool use, not chat LLM) |

### Key Behavioral Notes

- The agent used **only Ollama/deepseek-r1:8b** for all chat responses
- When asked "Can you read the cards in your Deck?" the agent said it couldn't (LLM hallucination -- it does have Deck access)
- The self-talk loop caused the agent to generate 6 responses to itself within 2 minutes
- After Feb 8, **zero LLM calls** for chat despite 172 incoming chat events (Feb 9-15)

---

## 8. Source Map

| Component | File | Key Function | Status | Bug? |
|-----------|------|-------------|--------|------|
| Heartbeat | `src/lib/integrations/heartbeat-manager.js` | `pulse()` | Working | Tasks wiring TODO (line 507) |
| Cockpit updater | `src/lib/integrations/cockpit-manager.js` | `updateStatus()`, `_formatCostStatus()`, `_formatTaskStatus()` | Broken | Cost: wrong field path (line 1068). Tasks: receives null |
| Wiki writer | `src/lib/agent/tool-registry.js` | `wiki_write` handler (line 1618) | Broken | Missing dedup check before createPage (line 1679) |
| Cost tracker | `src/lib/llm/budget-enforcer.js` | `recordSpend()`, `getFullReport()` | Working | Data correctly recorded, display broken in cockpit |
| Workflow engine | `src/lib/workflows/workflow-engine.js` | `processBoards()`, `_processCard()` | Working | Blocked by Deck 403 auth errors |
| Workflow detector | `src/lib/workflows/workflow-board-detector.js` | `detect()` | Working | Correctly finds 6 boards |
| Provider router | `src/lib/llm/router.js` | `route()` | Working | Only ollama-local configured |
| Agent loop | `src/lib/agent/agent-loop.js` | `process()` | Working | Claude agent-loop active but costs untracked |
| Talk handler | `src/lib/server/webhook-handler.js` | webhook processing | Bug | No self-message filter (self-talk loop) |
| Collectives client | `src/lib/integrations/collectives-client.js` | `findPageByTitle()` | Fragile | Search fails (500), race condition on creation |
| Email monitor | `src/lib/services/email-monitor.js` | `checkInbox()` | Working | Runs every 5 min, 7 emails total, 0 new |
| Deck client | `src/lib/integrations/deck-client.js` | `getWorkloadSummary()` | Exists | Not wired to heartbeat/cockpit |
| Bot enroller | `src/lib/integrations/bot-enroller.js` | bot list | Broken | 403 auth errors |

---

## 9. Recommendations

### Priority 1 (Critical -- Fix First)

1. **Fix Deck 403 authentication** -- Regenerate/verify the Nextcloud app token for the moltagent bot user. This single fix unblocks: workflow card processing, task counting, bot enrollment, and the entire Deck integration.

2. **Wire tasks to cockpit** -- Replace `tasks: null` at heartbeat-manager.js:507 with actual `DeckClient.getWorkloadSummary()` call + field transformation. Simple 10-line change.

3. **Fix cost display field path** -- Change cockpit-manager.js:1068 from `summary?.dailyCost` to `summary?.daily?.cost` (and line 1072). One-line fix.

### Priority 2 (Important -- Fix Next)

4. **Add self-message filter** -- In the webhook handler, skip processing messages where `actorId === botUserId`. Prevents self-talk loops and wasted LLM calls.

5. **Add wiki dedup check** -- Before `createPage()` in tool-registry.js:1679, re-check existence. Prevents duplicate pages on retry/concurrent calls.

6. **Track agent-loop costs** -- The Claude agent-loop bypasses BudgetEnforcer entirely. Add cost tracking for tool-use conversations to get real cost visibility.

### Priority 3 (Hardening)

7. **Add graceful shutdown** -- `server.close()` handler + `SO_REUSEADDR` to prevent EADDRINUSE crash loops.

8. **Fix Collectives search** -- Investigate why searchPages returns HTTP 500. The `undefined` collective ID in ContextLoader suggests a config/init-order issue.

9. **Add Ollama health check** -- Timeouts (75+) suggest the Ollama host is intermittently slow. Add a pre-flight ping before routing LLM calls.

10. **Enable Claude in providers.yaml** -- Claude is commented out. If intended as fallback for when Ollama is unavailable, uncomment and configure budget limits.

---

## Appendix: Timeline of Events

| Date | Event |
|------|-------|
| Feb 2 15:43 | First service start |
| Feb 2 15:50-15:54 | EADDRINUSE crash loop (~20 restarts) |
| Feb 2 17:10-17:19 | Second crash loop (~30+ restarts) |
| Feb 2 17:22 | First successful LLM call (deepseek API, "Hello" test) |
| Feb 4 01:20 | Funana's first real conversation (5 messages) |
| Feb 4 01:22-01:27 | Self-talk loop triggers 429 cascade |
| Feb 4 12:23-19:12 | Active development: chat, email, calendar tasks |
| Feb 5-6 | Email analysis, calendar parsing |
| Feb 8 18:34 | Last LLM router call (chat via ollama) |
| Feb 9 00:56 | ClaudeToolsProvider (agent-loop) first activated |
| Feb 9 13:25-17:03 | Claude API 429 rate limits hit (4+ times) |
| Feb 9 22:06-23:36 | Wiki bootstrap attempts, 500/400/404 errors |
| Feb 10 02:22 | Service restart |
| Feb 10 12:57 | First heartbeat pulse recorded |
| Feb 12 02:24 | Current stable deployment begins |
| Feb 12-15 | Stable operation: heartbeat every 5 min, 6 boards scanned, 0 cards processed (403 auth), 0 LLM calls |

---

*"The agent runs. It just doesn't do much."*
*Diagnosis before treatment. Always.*
