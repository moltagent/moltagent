# Moltagent Phase 1 Punch List

**Date:** 2026-02-09
**Purpose:** Everything that needs to work reliably before the first paying client
**Method:** Go through each capability, list what works, what's flaky, what's missing
**Priority:** P0 = blocks first client, P1 = embarrassing but survivable, P2 = nice to have

---

## 1. Ollama / Model Reliability

### What works
- Qwen3 8B tool calling (single + parallel) ✅
- Deck operations (list, move) ✅
- Calendar queries ✅
- German language responses ✅

### What's flaky

| # | Issue | Priority | Description |
|---|-------|----------|-------------|
| 1.1 | **Cold start timeout** | **P0** | Ollama unloads model after 5 min idle. Next message hits cold start (~60s to reload 5.2GB into RAM). If bot HTTP timeout is shorter → "Something went wrong." Client sees broken bot. |
| 1.2 | **4-minute response on warm model** | **P1** | Even warm, Qwen3 8B on CPU takes ~3-4 min per interaction (thinking trace + 11 tok/s). Acceptable for background tasks, frustrating for chat. |
| 1.3 | **Date hallucination** | **P1** | Qwen3 doesn't know today's date. Calendar query returned 1970 dates. System prompt must inject current date. Confirmed fixed in system prompt but needs verification in production. |
| 1.4 | **Stack name guessing** | **P1** | Qwen3 guesses "Inbox" for open tasks. Needs explicit stack name conventions in system prompt. |

### Fixes needed

| Fix | Effort | Approach |
|-----|--------|----------|
| **Keep-alive cron** | 15 min | Cron job every 4 min: `curl -s http://localhost:11434/api/generate -d '{"model":"qwen3:8b","prompt":"hi","stream":false}' > /dev/null`. Keeps model loaded. |
| **Increase bot→Ollama timeout** | 5 min | Change HTTP timeout from 30s/60s to 300s (5 min). Cold starts can take 90s+, inference 30-180s. |
| **Graceful "waking up" message** | 30 min | On Ollama timeout, send Talk message "⏳ Waking up... give me a moment" and retry once. Don't show "Something went wrong." |
| **Date injection verification** | 10 min | Confirm system prompt includes `Today's date is ${ISO date}` and that Qwen3 uses it for calendar queries. |
| **Stack conventions in prompt** | 10 min | Add to system prompt: "Deck stacks are: To Do, Doing, Done. Use 'To Do' for open tasks." (or whatever the actual stack names are) |

---

## 2. Talk Integration (Primary Interface)

### What works
- Receiving messages ✅
- Sending responses ✅
- Agent identity (knows it's Moltagent) ✅
- Multi-turn conversation ✅

### What's flaky

| # | Issue | Priority | Description |
|---|-------|----------|-------------|
| 2.1 | **"Something went wrong" on timeout** | **P0** | Generic error shown to user. Breaks trust. See 1.1 — same root cause but UX layer needs its own fix. |
| 2.2 | **No typing indicator** | **P2** | 3-4 min silence while model thinks. User doesn't know if bot is processing or dead. |
| 2.3 | **Error message is generic** | **P1** | "Something went wrong. Please try again or contact support." — no context. Should distinguish between "model loading" vs "tool failed" vs "unknown error". |

### Fixes needed

| Fix | Effort | Approach |
|-----|--------|----------|
| **Immediate "thinking" reply** | 30 min | On message receipt, immediately send "🤔 Let me check..." to Talk before starting LLM call. Delete or edit this message once real response arrives. |
| **Error differentiation** | 1 hr | Catch specific error types: Ollama timeout → "I'm warming up, trying again..."; tool failure → "Couldn't reach [service], I'll try differently"; unknown → "Something unexpected happened. I've logged it." |
| **Retry on cold start** | 30 min | If Ollama returns timeout/connection error, wait 30s (model loading), retry once. If second attempt also fails, then show error. |

---

## 3. Deck Integration (Task Management)

### What works
- List cards in a stack ✅
- Move cards between stacks ✅
- Create cards from Talk ✅

### What's flaky / missing

| # | Issue | Priority | Description |
|---|-------|----------|-------------|
| 3.1 | **Board discovery** | **P1** | Does the agent know which boards exist? Can user say "check my Marketing board" and agent finds it? Or is it hardcoded to one board? |
| 3.2 | **Stack name mismatch** | **P1** | Agent assumes stack names. If client uses custom names (e.g., "Backlog", "In Progress", "Completed"), agent will fail. Needs dynamic stack discovery. |
| 3.3 | **Card search** | **P1** | Can the agent find a card by partial name? "Move the invoicing task to Done" — does fuzzy matching work? |
| 3.4 | **Deck setup for new clients** | **P0** | When deploying for a new client, who creates the boards/stacks? Is there a setup script? Does the agent create its own workspace boards? |

### Fixes needed

| Fix | Effort | Approach |
|-----|--------|----------|
| **Dynamic stack/board listing** | 1 hr | On first use or `/status`, agent calls Deck API to list boards and stacks. Stores in memory/context. |
| **Fuzzy card search** | Already exists? | Verify `deck_search_cards` tool works. Test with partial names. |
| **Setup script for Deck** | 1 hr | Provisioning script creates default boards: "Moltagent Tasks" (To Do, Doing, Done), "Moltagent Knowledge" (Verified, Uncertain, Stale, Disputed). |

---

## 4. Calendar Integration

### What works
- List events in time range ✅
- Create events (with HITL confirmation) ✅
- CalDAV operations ✅

### What's flaky / missing

| # | Issue | Priority | Description |
|---|-------|----------|-------------|
| 4.1 | **Date parsing from natural language** | **P1** | "This Wednesday" → needs to resolve to correct date. Depends on system prompt date injection (see 1.3). |
| 4.2 | **"Correct the date" failed** | **P0** | Fu tried "Can you correct the date please? It's the entire day of 11th February 2026" → "Something went wrong." This is the cold start issue but also may be a tool error — modifying existing events may not work. |
| 4.3 | **Event modification** | **P1** | Can the agent update an existing event? Move it? Change duration? Or only create new events? |
| 4.4 | **Which calendar?** | **P1** | Agent created event on its own calendar, not the user's. Client expects events on *their* calendar. Need calendar selection logic. |
| 4.5 | **Smart Meetings (v2)** | **P2** | Spec exists but not built. Participant resolution, RSVP, meeting invitations. Important but post-launch. |

### Fixes needed

| Fix | Effort | Approach |
|-----|--------|----------|
| **Test event modification** | 30 min | Verify `calendar_update_event` tool exists and works. If not, add it. |
| **Calendar selection** | 1 hr | Default to user's personal calendar, not moltagent's. Or make configurable. List available calendars on `/status`. |
| **Natural date resolution** | Built into LLM? | Test: "next Tuesday", "this Friday at 3pm", "tomorrow morning". If Qwen3 can't resolve, add a date helper function. |

---

## 5. Memory System

### What works
- Memory storage (write to /Memory/) ✅
- Memory recall (read from /Memory/) ✅

### What's flaky / missing

| # | Issue | Priority | Description |
|---|-------|----------|-------------|
| 5.1 | **How does Molti set up its Decks?** | **P1** | Fu's question: how does the agent organize its own workspace? Does it create boards, stacks, knowledge structures on first run? Or does a human have to set it up? |
| 5.2 | **Memory format** | **P1** | What exactly gets stored? Raw conversation snippets? Structured facts? YAML frontmatter? How does the agent decide what's worth remembering? |
| 5.3 | **Memory retrieval relevance** | **P1** | When user asks a question, does the agent search memory effectively? Or does it load everything? Context window cost? |
| 5.4 | **Learning Log** | **P2** | Spec'd as append-only log of everything learned. Is it working? Is it being written to? |
| 5.5 | **Knowledge Board (Deck)** | **P2** | Spec'd with Verified/Uncertain/Stale/Disputed stacks. Not set up on Prime. |
| 5.6 | **Memory persistence across restarts** | **P0** | Does memory survive service restarts? Where is it stored — Nextcloud files, local disk, in-process? |

### Fixes needed

| Fix | Effort | Approach |
|-----|--------|----------|
| **Test memory persistence** | 15 min | Tell Molti something. Restart service. Ask Molti about it. Does it remember? |
| **Verify memory storage format** | 15 min | Check what's in /Memory/ directory on NC after storing something. |
| **Auto-provisioning on first run** | 2 hrs | Agent checks if its workspace exists on startup. If not, creates: /Inbox, /Outbox, /Memory, /Logs, /Context. Creates Deck boards. Logs "First run setup complete." |

---

## 6. Skill Forge

### What works
- Template engine ✅
- Talk conversation flow for skill setup ✅
- 172 tests passing ✅

### What's flaky / missing

| # | Issue | Priority | Description |
|---|-------|----------|-------------|
| 6.1 | **End-to-end test** | **P1** | Has anyone actually set up a skill via Talk on Prime? Talked through the full flow? |
| 6.2 | **Available templates** | **P1** | Which skill templates are currently available? Just the built-in ones or have any been authored? |
| 6.3 | **Credential verification** | **P1** | Does it actually check NC Passwords for the required API key label? |

### Fixes needed

| Fix | Effort | Approach |
|-----|--------|----------|
| **Live Skill Forge test** | 30 min | In Talk: "I want to connect to [service]". Walk through the full flow. Document what works, what breaks. |

---

## 7. Security Guards

### What works
- 10 security guards, 939 tests ✅
- SecretsGuard, ToolGuard, PromptGuard, PathGuard, EgressGuard ✅
- HITL for destructive operations ✅

### What's flaky / missing

| # | Issue | Priority | Description |
|---|-------|----------|-------------|
| 7.1 | **Credential broker in production** | **P0** | Is the credential broker actually fetching from NC Passwords at runtime? Or using env vars? |
| 7.2 | **Audit trail verification** | **P1** | Are audit logs being written? Where? Can Fu inspect them in NC Files? |
| 7.3 | **HITL flow in Talk** | **P1** | When agent wants to do something destructive, does it actually ask for confirmation in Talk and wait? |

### Fixes needed

| Fix | Effort | Approach |
|-----|--------|----------|
| **Verify credential broker** | 15 min | Check logs for credential fetch operations. Verify NC Passwords entries exist. |
| **Check audit log location** | 10 min | Find where logs are written. Verify they contain actual operation records. |
| **Test HITL** | 15 min | Ask agent to delete a file or modify calendar. Verify it asks for confirmation. |

---

## 8. Error Handling & Resilience

### What's missing

| # | Issue | Priority | Description |
|---|-------|----------|-------------|
| 8.1 | **No user-friendly errors** | **P0** | Every failure shows "Something went wrong." Should differentiate: model loading, tool error, NC API down, timeout. |
| 8.2 | **No retry logic visible to user** | **P1** | If first attempt fails, user doesn't know whether to wait or resend. Agent should communicate: "First attempt failed, retrying..." |
| 8.3 | **Service restart behavior** | **P1** | What happens when the bot service restarts? Does it pick up where it left off? Or lose in-flight messages? |
| 8.4 | **NC rate limiting** | **P1** | NCRequestManager exists with backoff logic (240 tests). But is it wired up in production? Under load, does it actually prevent 429 storms? |

---

## Priority Summary

### P0 — Blocks first client (fix this week)

1. **Cold start timeout** (1.1) → Keep-alive cron + increased timeout
2. **"Something went wrong" UX** (2.1, 8.1) → Graceful messages + retry
3. **Calendar modification failure** (4.2) → Debug the actual error
4. **Deck auto-provisioning** (3.4) → Setup script for new clients
5. **Credential broker verification** (7.1) → Confirm it works in prod
6. **Memory persistence** (5.6) → Verify across restarts

### P1 — Embarrassing but survivable (fix before first demo)

7. Response time (1.2) — accept for now, document for client
8. Date injection (1.3) — verify it's working
9. Stack name discovery (3.2) — dynamic listing
10. Calendar selection (4.4) — use client's calendar, not agent's
11. Memory format (5.2) — understand what's stored
12. Audit trail (7.2) — verify logs exist and are readable
13. Error differentiation (2.3) — specific error messages
14. Auto-provisioning (5.1) — agent sets up its own workspace

### P2 — Nice to have (post-launch)

15. Typing indicator (2.2)
16. Learning Log (5.4)
17. Knowledge Board (5.5)
18. Smart Meetings (4.5)
19. Skill Forge live test (6.1)

---

## Suggested Testing Protocol

For each item, run on Moltagent Prime (not unit tests — real Talk interaction):

```
1. Send message in Talk
2. Wait for response (note timing)
3. Check: Did it work? What error? What logs say?
4. Document result
5. File fix if broken
```

### Test script (run in order):

```
"Hi Moltagent, who are you?"                    → Identity check
"What tasks do I have?"                          → Deck list
"Create a task called Test Punch List"           → Deck create
"Move Test Punch List to Done"                   → Deck move  
"What meetings do I have this week?"             → Calendar list
"Schedule a meeting for tomorrow at 10am"        → Calendar create + HITL
"Change that meeting to 2pm"                     → Calendar modify
"Remember that my favorite color is blue"        → Memory store
[restart service]
"What's my favorite color?"                      → Memory recall after restart
"Delete the Test Punch List task"                → HITL confirmation
```

Run this, document what happens at each step, and we'll know exactly what to fix first.

---

*The goal: a client can chat with Moltagent in Talk and never see "Something went wrong."*
