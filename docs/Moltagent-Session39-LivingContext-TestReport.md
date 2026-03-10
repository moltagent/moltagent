# Session 39 — Living Context Integration Test Report

**Date:** 2026-03-10
**Commit under test:** `77ab92b` — *Living Context: inject session history into every pipeline component*
**Tester:** Funana (manual, via Nextcloud Talk)
**Observer:** Claude Code (live log analysis)
**Room:** `vj8zm5xk`
**Session ID:** `db4c0d38-da8a-446b-af9e-8576b5734b2c`

---

## 1. Objective

Validate the Living Context commit (`77ab92b`) in production against the conversational amnesia scenarios it was designed to fix:

- Referential messages ("tell me more about that") resolving to prior topics
- Confirmation detection ("yes, do it") escalating to cloud after agent offers
- Card link recall ("give me the link to the card you just created")
- Natural-language admin commands ("persist session") caught pre-classification
- Compound intent decomposition (knowledge + action in one message)

---

## 2. Test Environment

| Component | Value |
|-----------|-------|
| Server | moltagent-bot-01 |
| Node process | PID 1139544, running since 01:33 WET |
| Fast classifier | qwen2.5:3b via ollama-fast |
| Local tools model | qwen3:8b via ollama-local |
| Cloud synthesis | claude-haiku-4-5-20251001 |
| Cloud thinking | claude-opus-4-6 (deck task execution) |
| Deck | 51 cards across 8 boards, 40 stacks |
| Ollama endpoint | 138.201.246.236:11434 |

---

## 3. Test Messages and Results

### Msg 1 — "What do you know about Project Phoenix?"
**Purpose:** Baseline knowledge query, cold start (no prior session context).

| Step | Detail |
|------|--------|
| Classification | `knowledge -> local-tools` (qwen2.5:3b, 17s) |
| Session | First context created (empty live context — expected) |
| Search terms | `[Project Phoenix]` — direct extraction |
| Probes | 5 sources consulted, 4 returned results (wiki_pages, wiki_content, deck, files) |
| Deck | 2/51 cards matched |
| Synthesis | claude-haiku-4-5-20251001, 1786in/118out, $0.0019, 1.6s |
| Provenance | 8 segments, groundedRatio=0.13 |
| Response | "**Project Phoenix** is your Q1 internal tooling initiative led by Fu (Funana)..." |

**Verdict: PASS** — Correct answer with good source coverage.

---

### Msg 2 — "Tell me more about that"
**Purpose:** Test Living Context referential resolution. "That" must resolve to Project Phoenix.

| Step | Detail |
|------|--------|
| Classification | `knowledge -> local-tools` |
| Search terms | `[Tell me more about that, Project Phoenix]` |
| Deck | 10/51 cards matched (broader due to dual terms) |
| Probes | 4 sources, 2 hits (wiki_content, deck) |
| Synthesis | claude-haiku, 1916in/194out, $0.0023, 4.0s |
| Provenance | 15 segments, groundedRatio=0.00 |
| Response | "Based on what I have on Project Phoenix..." (expanded detail) |

**Verdict: PASS** — Living Context correctly injected `Project Phoenix` from session history into search terms. Reference resolution working.

---

### Msg 3 — "yes, do it"
**Purpose:** Test confirmation detection. Short reply after agent offer should escalate to cloud.

| Step | Detail |
|------|--------|
| Classification | `confirmation -> cloud` (correct — Living Context detected short reply after offer) |
| Router | `RouterChatBridge` pre-skipped local providers |
| AgentLoop | Started iteration 1/8 |
| Failure | `OllamaToolsProvider` fetch failed on both `ollama-local` and `ollama-fast` (timeouts) |
| Error | `All providers exhausted for job tools. Tried: ollama-local -> ollama-fast` |
| Stack | `RouterChatBridge.chat()` :296 -> `AgentLoop.process()` :151 -> `MessageProcessor.process()` :815 |

**Verdict: FAIL** — Confirmation detection worked correctly. However, the AgentLoop's `RouterChatBridge` attempted Ollama providers for tool-use instead of routing to Claude API (which was already selected by the classifier as the `cloud` target). Both Ollama providers timed out and no cloud fallback was attempted.

**Root cause:** The `confirmation -> cloud` classification tells the message processor to use cloud, but the AgentLoop's internal RouterChatBridge has its own provider chain that starts with Ollama for tool-calling jobs. When Ollama is unreachable, it doesn't fall through to Claude API for tool execution.

---

### Msg 4 — "What's Carlos's email address?"
**Purpose:** Direct knowledge lookup with entity extraction.

| Step | Detail |
|------|--------|
| Classification | `knowledge -> local-tools` (27s — slow, Ollama likely still recovering) |
| Search terms | `[Carlos, s Carlos, Carlos's email address]` |
| Deck | 6/51 matched |
| Local results | 1 (insufficient) -> web fallback added 3 |
| Probes | 6 sources, 3 hits (wiki_content, deck, web) |
| Synthesis | claude-haiku, 1980in/44out, $0.0018, 0.9s |
| Provenance | 3 segments, groundedRatio=0.00 |
| Response | "carlos@thecatalyne.com — Carlos is your contact at TheCatalyne..." |

**Verdict: PASS** — Correct answer. Minor issue: possessive parsing produces spurious `s Carlos` term from `Carlos's`.

---

### Msg 5 — "Who else do we know at TheCatalyne?"
**Purpose:** Follow-up entity query building on prior conversation.

| Step | Detail |
|------|--------|
| Classification | `knowledge -> local-tools` (4s — fast, Ollama warmed) |
| Search terms | `[TheCatalyne]` — direct mention, no context expansion needed |
| Deck | 0 matched (entity too specific) |
| Local results | 1 (insufficient) -> web fallback +3 |
| Probes | 6 sources, 2 hits (wiki_content, web) |
| Synthesis | claude-haiku, 1647in/91out, $0.0017, 1.6s |
| Provenance | 4 segments, groundedRatio=0.75 |
| Response | "Carlos is the only contact I have verified at TheCatalyne." |

**Verdict: PASS** — Honest, grounded answer (75% provenance). No hallucinated contacts.

---

### Msg 6 — "What's the weather in Lisbon right now?"
**Purpose:** Real-time query that should ideally route directly to web.

| Step | Detail |
|------|--------|
| Classification | `knowledge -> local-tools` |
| Search terms | `[Lisbon, the weather in Lisbon right now]` |
| Deck | 1/51 matched (Lisbon-related card) |
| Local results | 0 (insufficient) -> web fallback +3 |
| Probes | 6 sources, 3 hits (wiki_content, deck, web) |
| Synthesis | claude-haiku, 2186in/76out, $0.0021, 1.2s |
| Provenance | 5 segments, groundedRatio=0.00 |
| Response | "Rain ending this evening... Low 47F, wind 10-15mph..." |

**Verdict: PASS** — Correct answer via web fallback. Classification as `knowledge` is suboptimal for real-time queries (wasted ~2s on empty local probes before web fallback triggered), but the result was correct.

---

### Msg 7 — "What is that in Celsius and km/h?"
**Purpose:** Test Living Context reference resolution across a topic shift (weather, not Phoenix).

| Step | Detail |
|------|--------|
| Classification | `knowledge -> local-tools` (21s) |
| Search terms | `[Celsius, that in Celsius and km/h, Lisbon, the weather in Lisbon right now]` |
| Deck | 5/51 matched |
| Local results | 0 -> web fallback +3 |
| Probes | 6 sources, 3 hits (wiki_content, deck, web) |
| Synthesis | claude-haiku, 2249in/48out, $0.0020, 1.7s |
| Provenance | 3 segments, groundedRatio=0.00 |
| Response | "47F = 8C, 10-15 mph = 16-24 km/h" |

**Verdict: PASS** — Living Context correctly expanded "that" to the Lisbon weather context from the prior exchange, not the earlier Project Phoenix topic. Context-aware term injection working across topic boundaries.

---

### Msg 8 — "Create a task to review the Paradiesgarten WordPress plugins"
**Purpose:** Action request (deck card creation) with domain-specific terms.

| Step | Detail |
|------|--------|
| Classification | `wiki -> local-tools` (WRONG — should be `deck` or `action`) |
| Execution | qwen3:8b attempted wiki-domain handling |
| Enrichment | 5 matches for "Paradiesgarten WordPress", CoAccessGraph 303->305 edges |
| Response | "Could you clarify: content?" |

**Verdict: FAIL** — The classifier was misled by "WordPress" triggering wiki-domain association, overriding the clear action verb "Create a task". The Three-Gate classifier does not have a strong enough signal for action verbs when domain-specific nouns are present.

---

### Msg 9 — "What do we know about Paradiesgarten and create a task to check their WordPress version"
**Purpose:** Compound intent (knowledge + action in one message).

| Step | Detail |
|------|--------|
| Classification | `wiki -> local-tools [COMPOUND]` — compound flag detected |
| Decomposition | qwen2.5:3b `intent_decompose` job, 15s, 966in/60out |
| Decompose result | **Invalid plan structure** — failed |
| Fallback | Knowledge-only path |
| Search terms | `[Paradiesgarten, WordPress, Paradiesgarten and create a task to check their WordPress version]` |
| Deck | 18/51 matched |
| Probes | 5 sources, 3 hits (wiki_direct, wiki_content, deck) |
| Synthesis | claude-haiku, 1937in/243out, $0.0025, 3.8s |
| Provenance | 25 segments, groundedRatio=0.16 |
| Output warning | SQL injection false positive on markdown `--` separator |
| Response | Full Paradiesgarten knowledge summary (domain, WP type, hosting details) — but NO task created |

**Verdict: PARTIAL** — Compound detection worked. Knowledge half delivered well. But decomposition failed because qwen2.5:3b couldn't produce a valid plan structure, so the action half (task creation) was silently dropped. The user got information but not the task they asked for.

---

### Msg 10 — "due date is tomorrow, 13h. Yes, create it"
**Purpose:** Follow-up confirmation with temporal parameters, after compound failure.

| Step | Detail |
|------|--------|
| Classification | `deck -> local-tools` (correct gate) |
| Execution | qwen3:8b tools, 36s |
| Deck action | Card created: ID 1408, stack: inbox |
| Card title | "due date is tomorrow, 13h" (raw message text) |
| Due date | Not set |
| Response | `Created "due date is tomorrow, 13h" (card #1408) in Inbox.` |

**Verdict: PARTIAL** — Classification correct. Card created. But:
1. Card title should have been derived from Living Context (e.g., "Review Paradiesgarten WordPress plugins") — instead it used the raw message.
2. Due date "tomorrow, 13h" was not parsed or applied to the card.
3. qwen3:8b's tool-use didn't leverage session context for card metadata.

**Post-creation lifecycle (automated):**
- Card 1408 moved through: inbox -> queued -> working -> review
- Opus 4.6 thinking used for task execution ($0.029)
- Assignment completed (double-assign attempt returned HTTP 400 — benign)

---

### Msg 11 — "Can you give me the link to the card you just created?"
**Purpose:** Core Living Context test — card link recall after agent creation.

| Step | Detail |
|------|--------|
| Classification | `knowledge -> local-tools` |
| Search terms | `[Can you give me the link to the card you just created]` — NO context expansion |
| Deck | 13/51 matched (noisy, unfocused) |
| Local results | 0 -> web fallback +3 (web search for a Deck card link) |
| Probes | 5 sources, 3 hits (wiki_content, deck, web) |
| Synthesis | claude-haiku, 1995in/140out, $0.0022 |
| Provenance | 7 segments, groundedRatio=0.00 |
| Response | "I don't have a direct link to card #1408..." |

**Verdict: FAIL** — This is the exact scenario the commit was designed to fix. `buildLiveContext()` does detect `card_created` actions and extracts `cardId`, but:
1. The knowledge path didn't use `lastAssistantAction.cardId` to construct a Deck URL.
2. Search terms were not enriched with the card reference.
3. The synthesis prompt received the card info in context but Haiku still denied the ability to provide a link.
4. The agent knows the NC base URL and the card ID — it has everything needed to construct `https://nx89136.your-storageshare.de/apps/deck/card/1408`.

---

### Msg 12 — "persist session"
**Purpose:** Natural-language admin command interception.

| Step | Detail |
|------|--------|
| Interception | Caught **before classification** (no `Smart-mix classification:` log line) |
| Persist | Session written to `Sessions/2026-03-10-vj8zm5xk` |
| Execution | qwen3:8b credentials call (session summary), 1746in/545out |
| Response | "Session persisted: **Sessions/2026-03-10-vj8zm5xk** — Commitments detected and captured (if any)." |

**Verdict: PASS** — Admin command correctly intercepted before classifier, session persisted with commitment extraction.

---

## 4. Scorecard

| # | Message | Classification | Living Context Used? | Grade |
|---|---------|---------------|---------------------|-------|
| 1 | What do you know about Project Phoenix? | knowledge | N/A (cold start) | **PASS** |
| 2 | Tell me more about that | knowledge | Yes — "Project Phoenix" injected | **PASS** |
| 3 | yes, do it | confirmation -> cloud | Yes — offer detected | **FAIL** |
| 4 | What's Carlos's email address? | knowledge | No (direct query) | **PASS** |
| 5 | Who else do we know at TheCatalyne? | knowledge | No (direct mention) | **PASS** |
| 6 | What's the weather in Lisbon? | knowledge -> web fallback | No (direct query) | **PASS** |
| 7 | What is that in Celsius and km/h? | knowledge | Yes — "Lisbon weather" injected | **PASS** |
| 8 | Create task for Paradiesgarten WP | wiki (wrong) | No | **FAIL** |
| 9 | Compound: know + create task | compound (decompose fail) | Partial | **PARTIAL** |
| 10 | due date tomorrow, Yes create it | deck | Not used for title/date | **PARTIAL** |
| 11 | Link to card you just created? | knowledge | Not used (card_created ignored) | **FAIL** |
| 12 | persist session | admin (pre-classifier) | N/A | **PASS** |

**Final score: 7 PASS / 2 PARTIAL / 3 FAIL**

---

## 5. What Worked

1. **Referential resolution (msgs 2, 7):** `buildLiveContext()` correctly injects prior topic terms when the current message uses pronouns ("that", "it"). Works across topic shifts (Phoenix -> Lisbon weather).

2. **Confirmation detection (msg 3):** Short reply after agent offer correctly classified as `confirmation -> cloud`. The Living Context `lastAssistantAction.offer` detection works.

3. **Admin command interception (msg 12):** "persist session" caught before classification. No wasted LLM call.

4. **Web fallback (msgs 4, 5, 6, 7):** Knowledge-insufficient threshold correctly triggers web search when local sources have < 2 results.

5. **Provenance honesty (msg 5):** 75% grounded ratio, honest "Carlos is the only contact I have verified" — no hallucination.

6. **WarmMemory consolidation:** Triggered after substantive conversation (after msg 4 and msg 10).

7. **Compound detection (msg 9):** The "and" + mixed intent pattern was caught and flagged `[COMPOUND]`.

---

## 6. Issues Found

### P0 — Critical

**BUG-1: AgentLoop cloud path exhausts Ollama instead of Claude API**
- **Trigger:** `confirmation -> cloud` classification
- **Location:** `router-chat-bridge.js:296` -> `agent-loop.js:151`
- **Symptom:** RouterChatBridge tries `ollama-local` then `ollama-fast` for tool-use, both timeout. Never reaches Claude API.
- **Impact:** All `confirmation -> cloud` messages fail when Ollama is slow or unreachable.
- **Fix:** When the classifier selects `cloud`, the AgentLoop's RouterChatBridge must either skip Ollama providers or include Claude API in the tool-use provider chain.

**BUG-2: Card link denial despite Living Context detecting card_created**
- **Trigger:** "Give me the link to the card you just created" after agent creates a card
- **Location:** `message-processor.js` — `buildLiveContext()` detects card creation but the knowledge path doesn't use `lastAssistantAction.cardId` to construct a URL.
- **Symptom:** Agent says "I don't have a direct link" while holding the card ID and NC base URL.
- **Impact:** Core Living Context use case (the commit message specifically mentions this scenario) remains broken.
- **Fix:** When `liveContext.lastAssistantAction.type === 'card_created'` and the user asks about "card"/"link"/"created", short-circuit to construct `{NC_URL}/apps/deck/card/{cardId}` instead of running knowledge probes.

### P1 — High

**BUG-3: "Create a task" misclassified as `wiki` when domain terms present**
- **Trigger:** "Create a task to review the Paradiesgarten WordPress plugins"
- **Symptom:** `wiki -> local-tools` instead of `deck` or `action`
- **Impact:** Action verbs ("create", "make", "add") lose to domain noun association ("WordPress" -> wiki).
- **Fix:** Add action-verb priority rules to the Three-Gate classifier prompt. "Create/make/add a task/card" should always route to `deck` regardless of other terms.

**BUG-4: Compound decomposition produces invalid plan on qwen2.5:3b**
- **Trigger:** Compound intent with knowledge + action parts
- **Location:** `IntentDecomposer` — qwen2.5:3b `intent_decompose` job
- **Symptom:** `Invalid plan structure` — falls back to knowledge-only, silently dropping the action half
- **Impact:** Users who combine "what do we know about X and do Y" only get the knowledge part.
- **Fix:** Either (a) improve the decomposition prompt for qwen2.5:3b, (b) fall back to qwen3:8b for decomposition, or (c) escalate compound intents to cloud for plan generation.

### P2 — Medium

**BUG-5: Deck card title uses raw message instead of context-derived title**
- **Trigger:** "due date is tomorrow, 13h. Yes, create it" -> card titled "due date is tomorrow, 13h"
- **Impact:** Card titles are garbage when the user gives parameters in a follow-up rather than restating the task.
- **Fix:** When `liveContext` contains a prior discussion about task creation, extract the task description from context for the card title.

**BUG-6: Due date not parsed from natural language**
- **Trigger:** "tomorrow, 13h" not applied to card 1408
- **Impact:** Users must manually set due dates on cards the agent creates.
- **Fix:** Parse relative time expressions ("tomorrow", "next Monday", "in 2 hours") and pass `duedate` to `DeckClient.createCard()`.

### P3 — Low

**BUG-7: Possessive parsing artifact**
- **Trigger:** `"Carlos's"` produces `s Carlos` as a search term alongside `Carlos`
- **Impact:** Slightly noisier search results (matched 6 cards instead of ~3).
- **Fix:** Strip possessive suffixes (`'s`, `'s`) before term extraction.

**BUG-8: SQL injection false positive on markdown**
- **Trigger:** Haiku synthesis output contains `--` (markdown separator)
- **Symptom:** `output_warning: sqlInjection` with `medium` severity
- **Impact:** Log noise only — output still delivered. But could trigger alerts in monitoring.
- **Fix:** Exclude `--` when preceded by newline or in a markdown-formatted context from the SQL injection pattern.

---

## 7. Performance Profile

| Metric | Value |
|--------|-------|
| Messages processed | 12 (11 user + 1 admin) |
| Total session duration | ~12 minutes (10:22:14 — 10:36:19) |
| Avg classification time (qwen2.5:3b) | ~15s (range: 4s — 27s, depends on Ollama warmth) |
| Avg synthesis time (Haiku) | ~2s |
| Total cloud cost | **$0.05** (dominated by Opus 4.6 card execution at $0.029) |
| Haiku synthesis calls | 7 x ~$0.002 = ~$0.014 |
| Ollama calls | 8 (free) |
| Web fallback triggers | 4 of 7 knowledge queries |
| Deck cards created | 1 (ID 1408) |
| Session persisted | Yes (Sessions/2026-03-10-vj8zm5xk) |

---

## 8. Recommendations

### Immediate fixes (before next test round)
1. **BUG-1:** Add Claude API as fallback in RouterChatBridge's tool-use provider chain, or honour the classifier's `cloud` selection in the AgentLoop.
2. **BUG-2:** Add a card-link short-circuit in the knowledge path when `liveContext.lastAssistantAction.type === 'card_created'` and message contains card/link keywords.
3. **BUG-3:** Strengthen action-verb detection in classifier prompt to override domain-noun associations.

### Next sprint
4. **BUG-4:** Improve compound decomposition (better prompt or model upgrade for plan generation).
5. **BUG-5/6:** Wire Living Context into deck card creation for title derivation and due date parsing.

### Backlog
6. **BUG-7/8:** Minor parsing and pattern improvements.

---

## 9. Living Context Feature Assessment

| Feature | Status | Evidence |
|---------|--------|----------|
| `buildLiveContext()` construction | Working | Produces exchanges, lastAssistantAction, entity refs |
| Referential term expansion | **Working** | Msgs 2, 7: "that" resolved to prior topic |
| Confirmation detection | **Working** (classification) | Msg 3: short reply -> cloud escalation |
| Confirmation execution | **Broken** | Msg 3: cloud path fails in AgentLoop |
| Card creation recall | **Broken** | Msg 11: card_created detected but not used |
| Admin command interception | **Working** | Msg 12: caught pre-classifier |
| Compound detection | **Working** (detection) | Msg 9: [COMPOUND] flag set |
| Compound decomposition | **Broken** | Msg 9: invalid plan, fallback loses action |
| Context in synthesis prompt | **Working** | Msgs 2, 7: RECENT CONVERSATION block injected |
| Web fallback threshold (admittedIgnorance) | Not tested | No prior ignorance admission in this session |

**Overall: The detection/classification half of Living Context works well. The execution/action half has gaps — the system recognises context but doesn't always act on it.**
