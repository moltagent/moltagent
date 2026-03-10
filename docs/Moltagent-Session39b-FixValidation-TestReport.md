# Moltagent Session 39b — Fix Validation Test Report

**Date:** 2026-03-10 (11:33–11:54 WET)
**Commit under test:** `0fa3344` (Session 39 fixes)
**Room:** `vj8zm5xk`
**Tester:** Funana
**Observer:** Claude Code (log monitoring)
**Purpose:** Validate 5 fixes deployed from Session 39a test round

---

## Fix Reminder

| Fix | Description | Target Bug |
|-----|-------------|------------|
| FIX 1A | Card link short-circuit before classification | Card link denial |
| FIX 1B | Clickable markdown links in all deck responses | Plain text card refs |
| FIX 2 | Confirmation bypass (skip AgentLoop, execute from context) | Confirmation timeout |
| FIX 3 | Action verb priority guards in classifier | "Create a task" misclassified as wiki |
| FIX 4 | Visible web fallback feedback ("Also checking the web...") | Silent web fallback |
| FIX 5 | Tools roster → local+haiku only (no Opus for CRUD) | Opus used for card creation |

---

## Test Messages (12 total)

### MSG-1: "What do you know about Project Phoenix?"
- **Time:** 11:35:33
- **Classification:** `knowledge → local-tools`
- **Probes:** 5 sources, 4 returned (wiki_pages, wiki_content, deck, files)
- **Synthesis:** Haiku, 1870 tokens, 1.1s
- **Response:** Project Phoenix summary with details
- **Verdict:** PASS — baseline knowledge query working correctly

### MSG-2: "Tell me more about that"
- **Time:** 11:36:45
- **Classification:** `knowledge → local-tools`
- **Probes:** 4 sources, 2 returned (wiki_content, deck)
- **Synthesis:** Haiku, 2096 tokens, 2.1s
- **Response:** Expanded Project Phoenix details
- **Verdict:** PASS — Living Context correctly expanded vague reference to prior topic

### MSG-3: "Create a task to review the Paradiesgarten WordPress plugins"
- **Time:** 11:37:15
- **Classification:** `deck → local-tools`
- **Response:** `Created [Review the Paradiesgarten WordPress plugins](https://nx89136.your-storageshare.de/apps/deck...)`
- **Verdict:** PASS — **FIX 3 CONFIRMED** (action verb guard caught "Create a task" → deck). **FIX 1B CONFIRMED** (clickable markdown link in response)

### MSG-4: "What's the weather in Berlin (DE) right now?"
- **Time:** 11:38:41
- **Classification:** `knowledge → local-tools`
- **Probes:** 6 sources, 3 returned (wiki_content, deck, web) — **web fallback triggered** (0 local results)
- **Web results:** 3 added
- **Synthesis:** Haiku, 2283 tokens, 1.3s
- **Response:** Current Berlin weather (54°F / 12°C, wind, humidity)
- **Verdict:** PASS — **FIX 4 CONFIRMED** (web fallback with feedback emoji)

### MSG-5: "What is that in Celsius and km/h?"
- **Time:** 11:43:23
- **Classification:** `knowledge → local-tools`
- **Probes:** 6 sources, 3 returned (wiki_content, deck, web) — web fallback again
- **Synthesis:** Haiku, 2375 tokens, 2.5s
- **Response:** Converted to Celsius + km/h using Berlin context
- **Verdict:** PASS — Living Context correctly resolved "that" to Berlin weather from prior exchange

### MSG-6: "What do we know about Paradiesgarten and create a task to check their WordPress version"
- **Time:** 11:46:01
- **Classification:** `deck → local-tools [COMPOUND]`
- **Decomposition:** IntentDecomposer (qwen2.5:3b) → **"Invalid plan structure"** → fallback to knowledge
- **Probes:** 5 sources, 3 returned (wiki_direct, wiki_content, deck)
- **Synthesis:** Haiku, 2183 tokens, 2.1s — 1 output warning (SQL comment false positive)
- **Response:** Paradiesgarten knowledge dump, task creation part dropped
- **Verdict:** PARTIAL — Classifier correctly detected compound + deck domain. Decomposer still fails on qwen2.5:3b. Fallback only serves knowledge half, action half lost.

### MSG-7: "Give it the due date tomorrow at 15:00"
- **Time:** 11:47:23
- **Classification:** `knowledge → local-tools`
- **Probes:** 4 sources, 2 returned (wiki_content, deck)
- **Response:** "I need to set a due date on the task we just created..." — acknowledged intent but didn't execute
- **Verdict:** FAIL
  - **Root cause:** "Give it" not matched by action verb guards (`/\b(create|make|add|set up)\s+/`). Needs patterns for card mutation verbs: "give it", "set", "change", "update", "assign".
  - **Secondary:** Even after correct classification, there's no `deck_update_card` tool that can set due dates on existing cards.

### MSG-8: "check online for today date, use internal search to find the card you just created"
- **Time:** 11:48:50
- **Classification:** `knowledge → local-tools`
- **Probes:** 5 sources, 3 returned (wiki_content, deck, web)
- **Response:** Found the card "Check WordPress version for Paradiesgarten" in Deck, but couldn't execute the date update
- **Verdict:** PARTIAL — Knowledge probes found the right card via Deck search. But the user was giving a multi-step instruction ("check online" AND "find the card") which is effectively a compound action. Agent treated it as a knowledge query.

### MSG-9: "what is your Server time?"
- **Time:** 11:49:52
- **Classification:** `knowledge → local-tools`
- **Probes:** 6 sources, 3 returned (wiki_content, deck, web)
- **Response:** "I don't have access to my Nextcloud server's current time."
- **Verdict:** FAIL — Agent has no introspection tool for system clock. This is a missing capability, not a routing bug.

### MSG-10: "today is March 10 2026"
- **Time:** 11:50:33
- **Classification:** `knowledge → local-tools`
- **Probes:** 6 sources, 3 returned (wiki_content, deck, web)
- **Response:** "Confirmed. Today is Tuesday, March 10, 2026 — the 69th day of the year, week 11. I can now set..."
- **Verdict:** PASS (context) — Correctly absorbed date info. Offered to proceed with due date setting.

### MSG-11: "tomorrow, 15:00"
- **Time:** 11:51:07
- **Classification:** `knowledge → local-tools`
- **Probes:** 5 sources, 3 returned (wiki_content, deck, web)
- **Response:** "Setting due date for 'Check WordPress version for Paradiesgarten' to tomorrow (March 11, 2026)..."
- **Verdict:** FAIL
  - **Root cause 1:** Short reply after agent offer — should have triggered confirmation handler (FIX 2), but didn't because the prior response wasn't tagged as an `offer` in session buffer. The agent said "I can now set..." which is an offer, but Living Context `offer` detection may not have caught it.
  - **Root cause 2:** Even if routed correctly, no `deck_update_card` / `deck_set_duedate` tool exists. Agent verbalized the intent but had no way to execute it.

### MSG-12: "persist session"
- **Time:** 11:51:37–11:54:20
- **Classification:** `/persist` slash command (caught before classification)
- **Session summary:** 23 trust-gated messages → qwen2.5:3b (154s — very slow, with 1 retry)
- **Commitments:** 3 cards created on Personal board
- **Response:** "Session persisted: Sessions/2026-03-10-vj8zm5xk"
- **Verdict:** PASS (command routing) / **BUG** (commitment extraction)
  - The 3 commitment cards created have agent response fragments as titles: "To proceed, I need: 1. Today's date...", "Confirm the date and I'll update the card immediately.", "Let me check your Deck board first." — these are not real commitments, they're agent response snippets that the SessionPersister misidentified.
  - Session summary took **154 seconds** on qwen2.5:3b with a retry — too slow for an interactive command.

---

## Fix Validation Summary

| Fix | Status | Evidence |
|-----|--------|----------|
| FIX 1A (card link short-circuit) | NOT TESTED | No "where's the link?" follow-up was attempted |
| FIX 1B (clickable markdown links) | **CONFIRMED** | MSG-3: response includes full `[title](url)` markdown link |
| FIX 2 (confirmation bypass) | **NOT TRIGGERED** | MSG-11 "tomorrow, 15:00" should have been a confirmation but wasn't detected as one. Offer detection in Living Context may need broader patterns. |
| FIX 3 (action verb guards) | **CONFIRMED** | MSG-3: "Create a task" → `deck → local-tools` (was `wiki` before fix) |
| FIX 4 (web fallback feedback) | **CONFIRMED** | MSG-4, MSG-5: web fallback fired with visible feedback |
| FIX 5 (tools roster local-only) | **CONFIRMED** (indirect) | MSG-3 deck response came from `local-tools` provider, no Opus calls in logs for deck operations |

**Fixes confirmed: 3/5 (FIX 1B, FIX 3, FIX 4)**
**Fixes not testable: 1 (FIX 1A — needs specific card-link follow-up)**
**Fixes partially working: 1 (FIX 2 — confirmation handler exists but offer detection didn't fire)**

---

## New Bugs Found

### BUG-R2-1: Card mutation verbs not in action guards (HIGH)
- **Messages:** MSG-7 "Give it the due date tomorrow at 15:00"
- **Expected:** `deck → local-tools`
- **Got:** `knowledge → local-tools`
- **Fix:** Add mutation verbs to action verb guards: `give it`, `set`, `change`, `update`, `assign`, `move`

### BUG-R2-2: No deck_update_card / deck_set_duedate tool (HIGH)
- **Messages:** MSG-7, MSG-8, MSG-11
- **Impact:** Even when the agent understands the intent, it cannot update existing cards (due dates, descriptions, labels, assignments). It can only create.
- **Fix:** Add `deck_update_card` and `deck_assign_duedate` tools to tool-registry

### BUG-R2-3: Confirmation handler not triggered for contextual offers (MEDIUM)
- **Messages:** MSG-11 "tomorrow, 15:00" after agent said "I can now set..."
- **Root cause:** Living Context `offer` detection didn't tag the prior response as an offer. The pattern may only detect explicit "shall I...?" / "want me to...?" phrasing, not "I can now set..." which is an implicit offer.
- **Fix:** Broaden offer detection patterns in `buildLiveContext()` to catch "I can [verb]", "I'll [verb] if you", "ready to [verb]"

### BUG-R2-4: Compound decomposition still broken (MEDIUM — known)
- **Messages:** MSG-6
- **Status:** Known from Round 1. IntentDecomposer on qwen2.5:3b returns invalid plan structure.
- **Fix:** Either fix prompt template for qwen2.5:3b, use qwen3:8b for decomposition, or implement a regex-based fallback splitter for simple "X and Y" compounds.

### BUG-R2-5: SessionPersister creates bogus commitment cards (MEDIUM)
- **Messages:** MSG-12
- **Impact:** 3 cards created with agent response text as titles instead of actual actionable commitments
- **Cards created:** "To proceed, I need: 1. Today's date...", "Confirm the date and I'll update the card immediately.", "Let me check your Deck board first."
- **Fix:** Commitment extraction prompt needs tighter criteria — only extract concrete action items the agent committed to, not conditional/hypothetical statements.

### BUG-R2-6: Session summary too slow (154s) (LOW)
- **Messages:** MSG-12
- **Impact:** `/persist` takes 2.5 minutes to complete. User sees no feedback during this time.
- **Details:** qwen2.5:3b took 154s with 1 retry for 23 messages. May be due to context length or Ollama load.
- **Fix:** Consider streaming feedback ("Persisting...") and/or using Haiku for session summaries.

### BUG-R2-7: No system clock introspection (LOW)
- **Messages:** MSG-9
- **Impact:** Agent cannot report its own server time, making date-relative operations unreliable
- **Fix:** Add a `system_time` tool or inject current datetime into pipeline context

---

## Scorecard

| # | Message | Routing | Response | Score |
|---|---------|---------|----------|-------|
| 1 | Project Phoenix query | Correct | Correct | PASS |
| 2 | "Tell me more" (vague) | Correct | Context-expanded | PASS |
| 3 | Create a task | Correct (fixed!) | Clickable link | PASS |
| 4 | Berlin weather | Correct + web | Accurate | PASS |
| 5 | Unit conversion | Correct + web | Context-expanded | PASS |
| 6 | Compound: know + create | Correct detection, decompose fail | Knowledge only | PARTIAL |
| 7 | "Give it the due date" | Wrong (knowledge) | Acknowledged, no action | FAIL |
| 8 | Multi-step instruction | Wrong (knowledge) | Found card, no action | PARTIAL |
| 9 | "What is your server time?" | Correct (knowledge) | Missing capability | FAIL |
| 10 | "Today is March 10 2026" | Correct | Absorbed + offered | PASS |
| 11 | "Tomorrow, 15:00" | Wrong (knowledge) | Verbalized, no action | FAIL |
| 12 | "persist session" | Correct (slash cmd) | Persisted + bogus cards | PARTIAL |

**Final Score: 6 PASS / 3 PARTIAL / 3 FAIL (50% clean pass rate)**

---

## Round-over-Round Comparison

| Metric | Round 1 (77ab92b) | Round 2 (0fa3344) |
|--------|-------------------|-------------------|
| Messages tested | 12 | 12 |
| Clean PASS | 7 (58%) | 6 (50%) |
| PARTIAL | 2 (17%) | 3 (25%) |
| FAIL | 3 (25%) | 3 (25%) |
| Fixes validated | — | 3 of 5 |
| New bugs found | 8 | 7 |

**Note:** Round 2 tested harder scenarios (card mutation, multi-step instructions, compound actions) which are genuinely more difficult than Round 1's test set. The 3 confirmed fixes (FIX 1B, FIX 3, FIX 4) are solid. The remaining failures are primarily about **missing tools** (no card update API) and **missing verb patterns** rather than regression.

---

## Priority Fix Queue (Next Session)

1. **deck_update_card tool** — enables due dates, label changes, card edits (unlocks MSG-7, MSG-8, MSG-11)
2. **Card mutation verb guards** — "give it", "set", "change", "update", "assign" → deck intent
3. **Broader offer detection** — catch "I can [verb]", "I'll [verb]" patterns for confirmation handler
4. **Compound decomposer fix** — regex fallback for "X and Y" pattern when LLM fails
5. **Commitment extraction quality** — tighter prompt to avoid agent-response-as-commitment
6. **System clock injection** — `new Date().toISOString()` in pipeline context
