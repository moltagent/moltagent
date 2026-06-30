# F1 Discovery — Tool-Execution Convergence: Divergence Ledger

**Status:** Discovery-only. This document is a map and a plan. No code changed; no behavior changed. The only artifact this session produced is this file.
**Branch:** `next` (working tree only).
**Scope:** the tool-execution layer — Path A (`src/lib/agent/tool-registry.js`, the LLM tool-calling surface) and Path B (`src/lib/agent/executors/*`, the deterministic-intent surface).
**Method:** five parallel read-only forensic passes (one per domain + one cross-cutting), every claim cited by `file:line` read rather than inferred, reconciled at the mapping altitude.

---

## (0) Liveness verdict — stated first, because it determines everything below

**Verdict: VESTIGE under the current `cloud-ok` default.**

Path B (the deterministic executor dispatch) is effectively unreached when the trust boundary is `cloud-ok`, which is Prime's standing default. The journal is decisive.

**Journal evidence (window: 2026-06-04 → 2026-06-30, the cloud-ok era; 397,043 log lines).**

| Signal | Count |
|---|---|
| Smart-mix classifications total | 28 |
| → routed to **cloud** (Path A / AgentLoop) | 22 |
| → routed to **local-tools** | 6 |
| of which `smart_mix_knowledge` (→ `_handleKnowledgeQuery`, not executors) | 5 |
| of which `smart_mix_compound` (→ `_handleCompoundIntent`, not executors) | 1 |
| **Executor success/activity signatures** (`[DeckExec]`, `[CalendarExecutor]`, `[FileExecutor]`, `[WikiExecutor]`) | **0** |
| **`[MicroPipeline] Domain task:` dispatches** (the executor-bearing branch) | **0** |

Every `result.intent` marker in the window resolves to a non-executor handler: `smart_mix_cloud:calendar` (14), `smart_mix_cloud:deck` (6), `smart_mix_knowledge` (5), `smart_mix_compound` (1), `smart_mix_cloud:email` (1). The deck and calendar executors log at `info` on their success paths (e.g. `deck-executor.js:646`, `deck-executor.js:1038`; `calendar-executor.js` create/update/delete), so their total absence from the journal means they did not run — not that they ran silently.

**Why the router starves Path B (code evidence).** Two gates close it off under `cloud-ok`:

1. **The direct executor branch is gated on a local primary.** `message-processor.js:673` routes to `microPipeline.process` only when `_shouldUseMicroPipeline()` is true, and that returns true only when `agentLoop.llmProvider.primaryIsLocal` (`message-processor.js:1653-1657`). Under `cloud-ok` the primary is cloud, so this branch is never taken.
2. **Smart-mix sends direct domain actions to cloud.** Under `cloud-ok` the system is in smart-mix mode (`_isSmartMixMode`, `message-processor.js:1668-1675`: RouterChatBridge with >1 provider). `_smartMixClassify` (`message-processor.js:1804-1824`) returns `useLocal:true` only for `knowledge`, `compound+domain`, and `confirmation_declined`; **everything else — every plain domain action — returns `useLocal:false` → AgentLoop (Path A)** (the `return` at `message-processor.js:1824`, after the comment at `:1804-1806`: *"MicroPipeline only fires in local-only"*).

**The residual reachability (honest caveat).** Path B is *vestige*, not strictly dead. Two narrow indirect routes can still reach an executor under `cloud-ok`:
- **Confirmation-from-context** — `message-processor.js:807` re-runs `microPipeline.process(offerText)` when a user confirms a prior offer; that re-classification can dispatch to an executor.
- **Compound action-steps** — `_handleCompoundIntent` passes `actionExecutor: this.microPipeline` to `decomposer.executePlan` (`message-processor.js:2682`), so a compound plan's action step routes through the executor layer.

Both are rare, and the journal records **zero** executor invocations across all 28 classifications in the window (the lone `smart_mix_compound` event produced no executor log line). So the operative finding stands: **under the current default, Path B carries no live direct traffic.**

**What the verdict means for this document.** Per the briefing, under *vestige* the divergence ledger collapses to a **port-list**: the question is no longer "which path is canonical for each operation" (Path A is canonical by default), but "which Path-B-only operations must be ported to a Path A tool *before* Path B can be deleted." Sections (b) below are therefore port-lists, not A-vs-B reconciliations. ESCALATE rows are few and noted explicitly.

**Reconciliation caveat for the retire-decision (handoff altitude).** Vestige is the finding *under `cloud-ok`*. Path B was built for the all-local-SLM era and remains the structurally-correct home for a future **local-only / non-tool-calling degraded mode**. If `nc-tools-3b` (a tool-calling SLM) matures, the local mode can run on Path A too and Path B retires entirely. Until then, the retire-or-thin-shell call belongs to the architecture review (§9), not to this discovery.

---

## (a)+(b)+(c) Per-domain seam maps, port-lists, and orphan lists

### Deck

**Registry deck tools (Path A) — inventory.** `_registerDeckTools()` `tool-registry.js:686-1704`, by `name:` line: `deck_list_cards` (`:696`), `deck_move_card` (`:790`), `deck_create_card` (`:854`), `deck_list_boards` (`:927`), `deck_get_board` (`:947`), `deck_create_board` (`:978`), `deck_list_stacks` (`:1005`), `deck_create_stack` (`:1033`), `deck_get_card` (`:1061`), `deck_update_card` (`:1111`), `deck_delete_card` (`:1162`), `deck_assign_user` (`:1192`), `deck_unassign_user` (`:1237`), `deck_set_due_date` (`:1271`), `deck_add_label` (`:1323`), `deck_remove_label` (`:1361`), `deck_create_label` (`:1398`), `deck_add_comment` (`:1423`), `deck_list_comments` (`:1450`), `deck_share_board` (`:1487`), `deck_overview` (`:1525`), `deck_my_assigned_cards` (`:1561`), `deck_overdue_cards` (`:1595`), `deck_mark_done` (`:1620`), `deck_complete_task` (`:1662`), `deck_complete_review` (`:1684`). **Count: 26.**

**Executor operations (Path B) — inventory.** 18 actions from `switch (params.action)` at `deck-executor.js:226`: `create_board` (`:262`), `list_boards` (`:296`), `rename_board` (`:322`), `archive_board` (`:356`), `delete_board` (`:386`), `create_stack` (`:437`), `rename_stack` (`:471`), `delete_stack` (`:512`), `setup_workflow` (`:563`), `troubleshoot` (`:731`), `get` (`:992`), `create` (`:1023`), `move` (`:1168`), `update` (`:1205`), `delete` (`:1253`), `assign` (`:1291`), `label` (`:1325`), `list`/`default` (`:965`). **Count: 18.**

**Shell/core seam.** Extraction at `deck-executor.js:190` (`_extractJSON(... DECK_SCHEMA)`); clarification guard `:208-224`; seam = the dispatch switch at **`:226`**. (Note: `ToolRegistry.execute()` `:346-388` does not itself guard; Path A's chokepoint is `AgentLoop._executeWithGuards`, `agent-loop.js:623-671`, upstream of every deck tool.)

**Pairing table.**

| Executor operation | Executor core | Paired Path-A tool / **PORT** | Resolution logic | Substrate | Guard A | Guard B (`_checkGuardrails`) | Ledger B | Multilingual | Verdict |
|---|---|---|---|---|---|---|---|---|---|
| `list` | `deck-executor.js:965` | `deck_list_cards` `:696` | SAME-ish: B normalizes stack via `_normalizeStackName` (alias table) then delegates to A's resolver | `toolRegistry.execute('deck_list_cards')` | ALLOWED | N | Y/Y | DIFFERS: B `STACK_ALIASES` keyword map | CANONICAL=A |
| `get` | `deck-executor.js:992` | `deck_get_card` `:1061` | SAME (delegates, A `_resolveCardOnBoard`) | `deck_get_card` | yes | N | Y/Y | none | CANONICAL=A |
| `create` | `deck-executor.js:1023` | `deck_create_card` `:854` | SAME resolution (A `_resolveBoard`); B adds title-gen + board defaulting | `deck_create_card`→`deck_set_due_date`/`deck_assign_user`; `deckClient.markCardDone` (`:1136`) | yes | **Y** (`:1044`) | Y/Y | DIFFERS: `isVagueTitle` EN regex `:1028` | CANONICAL=A |
| `move` | `deck-executor.js:1168` | `deck_move_card` `:790` | SAME (delegates); B pre-normalizes target stack | `deck_move_card` | yes | N | Y/Y | DIFFERS: `_normalizeStackName`, `_resolveCardReference` EN regex | CANONICAL=A |
| `update` | `deck-executor.js:1205` | `deck_update_card` `:1111` | SAME (delegates) | `deck_update_card` | yes | N | Y/Y | DIFFERS: `_resolveCardReference` EN | CANONICAL=A |
| `delete` | `deck-executor.js:1253` | `deck_delete_card` `:1162` | SAME (delegates) | `deck_delete_card` | **yes** APPROVAL | **Y** (`:1259`) | Y/Y | DIFFERS: `_resolveCardReference` | CANONICAL=A |
| `assign` | `deck-executor.js:1291` | `deck_assign_user` `:1192` | SAME (delegates) | `deck_assign_user` | yes | N | Y/Y | DIFFERS: `_resolveCardReference` | CANONICAL=A |
| `label` | `deck-executor.js:1325` | `deck_add_label` `:1323` | SAME (delegates) | `deck_add_label` | yes | N | Y/Y | none | CANONICAL=A |
| `list_boards` | `deck-executor.js:296` | `deck_list_boards` `:927` | DIFFERS: B `deckClient.listBoards()` + filters archived | `deckClient.listBoards` | yes | N | Y/Y | none | CANONICAL=A |
| `create_board` | `deck-executor.js:262` | `deck_create_board` `:978` | DIFFERS: B name-gen + auto-share-with-admin; A bare POST | `createNewBoard`, `shareBoardWithUser` (`:841`) | ALLOWED | N | Y/Y | none | CANONICAL=A (A omits auto-share) |
| `create_stack` | `deck-executor.js:437` | `deck_create_stack` `:1033` | DIFFERS: B own fuzzy `_resolveBoard`; A registry `_resolveBoard` | `deckClient.createStack` | yes | N | Y/Y | none | CANONICAL=A |
| `rename_board` | `deck-executor.js:322` | **PORT** (no A board-rename) | B own `_resolveBoard` | `deckClient.updateBoard` | n/a | N | Y/Y | none | **PORT-needed** |
| `archive_board` | `deck-executor.js:356` | **PORT** (no A archive) | B `_resolveBoard` | `deckClient.archiveBoard` | n/a | **N** (mutating, ungated) | Y/Y | none | **PORT-needed** |
| `delete_board` | `deck-executor.js:386` | **PORT** (no A board-delete) | B `_resolveBoard` | `deckClient.getStacks`, `deleteBoard` | n/a | Y (`:398`) — but ToolGuard has **no policy** for `deck_delete_board` → toothless | Y/Y | none | **PORT (ESCALATE: destructive, HITL-uncovered)** |
| `rename_stack` | `deck-executor.js:471` | **PORT** (no A stack-rename) | B `_resolveBoard`+`_resolveStack` | `deckClient.updateStack` | n/a | N | Y/Y | none | **PORT-needed** |
| `delete_stack` | `deck-executor.js:512` | **PORT** (no A stack-delete) | B `_resolveBoard`+`_resolveStack` | `deckClient.deleteStack` | n/a | Y (`:531`) — ToolGuard **no policy** → toothless | Y/Y | none | **PORT (ESCALATE: destructive, HITL-uncovered)** |
| `setup_workflow` | `deck-executor.js:563` | **PORT** (compound; no A equiv) | LLM-planned; B `_resolveBoard` for share | `createNewBoard`,`createStack`,`createCardOnBoard`,`shareBoardWithUser` (`:647`) | n/a | **N** (board+stacks+cards+share, all ungated) | Y/Y | none | **PORT (ESCALATE: bypasses create_card + share guards)** |
| `troubleshoot` | `deck-executor.js:731` | **PORT** (diagnostic compound) | B `_resolveBoard` | `listBoards`, `shareBoardWithUser` (`:756/:805`) | n/a | **N** (shares boards ungated) | Y/Y | none | **PORT (ESCALATE: shares boards ToolGuard marks APPROVAL)** |

**Port-list (7 operations).** Deck operations existing ONLY in the executor — no Path-A tool — must be ported before Path B deletion: `rename_board` (`updateBoard`), `archive_board` (`archiveBoard`), `delete_board` (`deleteBoard`), `rename_stack` (`updateStack`), `delete_stack` (`deleteStack`), `setup_workflow` (compound create), `troubleshoot` (access-repair compound). The other 11 executor ops all have a canonical Path-A tool. **Critical:** the destructive ports (`delete_board`, `delete_stack`, the sharing inside `setup_workflow`/`troubleshoot`) must be added to ToolGuard's `REQUIRES_APPROVAL` policy when created — Path B's own guards on them are toothless (the tool names aren't in `tool-guard.js` policy, so `evaluate()` defaults them to `ALLOWED`).

**Registry-only orphans (Path-A-only, 15):** `deck_get_board` (`:947`), `deck_list_stacks` (`:1005`), `deck_unassign_user` (`:1237`), `deck_set_due_date` (`:1271`, standalone; executor only sets due dates inside create/update), `deck_remove_label` (`:1361`), `deck_create_label` (`:1398`), `deck_add_comment` (`:1423`), `deck_list_comments` (`:1450`), `deck_share_board` (`:1487`, executor shares only as a side-effect), `deck_overview` (`:1525`), `deck_my_assigned_cards` (`:1561`), `deck_overdue_cards` (`:1595`), `deck_mark_done` (`:1620`, executor covers via `move`-to-Done), `deck_complete_task` (`:1662`), `deck_complete_review` (`:1684`). Path A is substantially richer — comments, label create/remove, overview/overdue/assigned reporting, and the review/completion lifecycle exist only on Path A.

**Asymmetries (Deck).**
- *Guardrail:* B calls `_checkGuardrails` in only 4 places (`:398/:531/:1044/:1259`); 11 other mutating ops call it nowhere. The dangerous answer to "a mutating Path-B op lacking a guard that Path A *would* gate?" is **yes — board sharing**: ToolGuard's `REQUIRES_APPROVAL` lists `deck_share_board` (`tool-guard.js:59`), yet B shares boards via `shareBoardWithUser` in `troubleshoot` (`:756/:805`), `create_board`→`_shareBoardWithAdmin` (`:841`), and `setup_workflow` (`:647`) with no guard. Compounding it, the guards B *does* place on `delete_board`/`delete_stack` are toothless (names absent from `tool-guard.js:30-59`; `evaluate()` defaults `ALLOWED`, `:228`). These are gaps on the (vestige) Path B; their relevance is forward-looking — the ports must carry real Path-A guard policy.
- *Ledger:* B emits `actionRecord` 25× and `_logActivity` 19× (e.g. `:288/:314/:348/:378/:425/:463/:504`). Registry deck section (`:686-1704`) has **0** of either — handlers return plain strings/`{text,card}`. Canonicalizing on A drops the structured ledger for all deck ops unless re-homed at the chokepoint.
- *Multilingual:* **Non-empty (finding, Rule-1).** B carries the language-as-code smells: `STACK_ALIASES` EN keyword map (`:35-59`) via `_normalizeStackName` (`:1452-1456`); EN vague-title regex `:1028-1030`; EN pronoun/format regex in `_resolveCardReference` (`:1371/:1401/:1404`); inherited `_isMetaInstruction` (`base-executor.js:341`). All silently fail for DE/PT. Path A is clean (structured args only). Any ported op should let the LLM extraction layer carry stack-name/reference resolution, not these keyword tables.

### Calendar (+ Meeting)

**Registry calendar+meeting tools (Path A) — inventory.**

Calendar (`_registerCalendarTools`, `tool-registry.js:1709`): `calendar_list_events` (`:1715`), `calendar_create_event` (`:1751`), `calendar_update_event` (`:1886`), `calendar_delete_event` (`:1993`), `calendar_check_availability` (`:2023`), `calendar_cancel_meeting` (`:2071`). *(`calendar_quick_schedule` / `calendar_schedule_meeting` retired per #169 — comment at `:2066-2068`.)*
Meeting (`_registerMeetingTools`, `:2098`): `meeting_compose` (`:2103`), `meeting_check_rsvp` (`:2139`).
**Count: calendar 6, meeting 2 (8 total).**

**Executor operations (Path B) — inventory.** `calendar-executor.js::execute()` dispatches to four substrate operations, each implemented as an op-level method taking already-structured `(params, context)`:
- **create** — `_executeCreate` (`:218`), substrate `calendarClient.createEvent` (`:266`); dispatched `:207`.
- **list/query** — `queryEvents` (`:570`), substrate `getTodayEvents`/`getUpcomingEvents`/`getEventCalendars`/`getEvents` (`:582-594`); dispatched `:193`.
- **update** — `updateEvent` (`:323`), substrate `calendarClient.updateEvent(calendarId, uid, updates)` (`:437`); dispatched `:198`.
- **delete** — `deleteEvent` (`:462`), substrate `calendarClient.deleteEvent(calendarId, uid)` (`:498`); dispatched `:202`.
- Support (not standalone ops): `_findEventByTitle` (`:529`), `resumeWithClarification` (`:761`).
No RSVP / cancel-meeting / availability-check operation exists in the executor.

**Shell/core seam.** Shell (extraction + validation/clarification) runs `:50-204`: prompt build (`:76-124`), `_extractJSON` (`:126`), clarification gate (`:135-148`), title/date validation (`:155-189`). Seam = the dispatch block `:192-207`. **Architecturally significant:** calendar is *already* factored into shell + op-level cores — each of `queryEvents`/`updateEvent`/`deleteEvent`/`_executeCreate` takes structured `(params, context)`, the same shape a registry handler's `(args)` has, so each is a near-drop-in for porting. Caveat: the guardrail call still lives *inside* each core (`:253`, `:425`, `:487`), so the core is not purely substrate — it carries Path-B's guard responsibility (which a shared core would lift to the shell).

**Pairing table.**

| Executor operation | Executor core | Paired Path-A tool | Resolution logic | Substrate | Guard A | Guard B (`_checkGuardrails`) | Ledger B | Multilingual | Verdict |
|---|---|---|---|---|---|---|---|---|---|
| create | `calendar-executor.js:218` | `calendar_create_event` `tool-registry.js:1751` | DIFFERS: B resolves date/time in code (`:220,228`), auto-adds requester by name (`:238`); A takes ISO start/end, resolves requester *email* via `ncMgr.getUserEmail` (`:1829`) | same client method (`createEvent`) — B `:266`, A `:1866` | chokepoint (SENSITIVE) | Y `:253` | Y `:309` | DIFFERS: B prompt action-rule examples English-only `:80-123` | CANONICAL=A |
| list/query | `calendar-executor.js:570` | `calendar_list_events` `tool-registry.js:1715` | DIFFERS: B has 6 `query_type`s w/ code range resolution (`_resolveQueryRange:630`); A takes only a `hours` window (`:1729`) | partial overlap (both use `getUpcomingEvents`) | read, ungated | N (read) | Y `:615` | DIFFERS: `_formatEventList` hardcodes "Today/Tomorrow/This week" + `'en-US'` `:700-727` | CANONICAL=A (richer query shapes are read-only convenience) |
| update | `calendar-executor.js:323` | `calendar_update_event` `tool-registry.js:1886` | DIFFERS: B `update_type` enum + "self"→userName (`:360-362`), passes NO etag (`:437`); A raw field overrides + passes `etag` (`:1973`) | same method, A adds etag arg | chokepoint | Y `:425` | Y `:451` | DIFFERS: prompt English-only `:100-108` | CANONICAL=A (A's etag = optimistic-concurrency safety) |
| delete | `calendar-executor.js:462` | `calendar_delete_event` `tool-registry.js:1993` | DIFFERS: B search window −7/+14d (`:471`), no etag; A window +30/−7d, passes etag (`:2010`) | same method, A adds etag | chokepoint | Y `:487` | Y `:518` | none | CANONICAL=A |

**Port-list: EMPTY.** All four executor operations have Path-A equivalents calling the same CalDAVClient methods. The only things lost on deletion are *shell affordances*, not operations: the multi-`query_type` range resolution (A expresses any window via `hours`), the `resumeWithClarification` slot-filling UX, and `update_type`-driven attendee add/remove-by-name (A handles attendees via explicit email arrays). None is a new substrate operation.

**Registry-only orphans (Path-A-only):** `calendar_check_availability` (`:2023`), `calendar_cancel_meeting` (`:2071`), `meeting_compose` (`:2103`), `meeting_check_rsvp` (`:2139`).

**Asymmetries (Calendar).**
- *Guardrail:* No Path-B gap — all three mutating ops gate (`:253/:425/:487`), read correctly ungated. A gates the same three structurally (SENSITIVE_TOOLS; standing note `tool-registry.js:2196-2197`). Same coverage, different mechanism.
- *Ledger:* Sharpest asymmetry. B emits `actionRecord` from every op (`:309/:451/:518/:615`) plus `_logActivity` (`:294/:444/:510/:602`). A's handlers return plain strings — **no `actionRecord`, no `_logActivity`** (`:1881/:1988/:2014`). Deleting B drops structured calendar-mutation ledger unless A (or a wrapper) is taught to emit it.
- *Multilingual:* **Non-empty (finding).** B is English-pinned in shell + formatters: extraction prompt `:80-123`, `_formatNoEvents` `:677-685`, `_formatEventList` labels `:700-703` and forced `'en-US'` locale `:710/:727/:736`, `_askForField` `:820-826`; `base-executor._resolveDate` matches English day names `:199` (also accepts ISO + DD.MM.YYYY `:173-182`). A defers language to the LLM and locale-default formatting (`meeting_compose` explicitly EN/DE/PT, `:2104`). Path A is the healthier language layer here.

### File

**Registry file tools (Path A) — inventory.** `_registerFileTools()` `tool-registry.js:2200-2545`: `file_read` (`:2205`), `file_list` (`:2242`), `file_write` (`:2306`), `file_info` (`:2350`), `file_move` (`:2391`), `file_copy` (`:2413`), `file_delete` (`:2435`), `file_mkdir` (`:2456`), `file_share` (`:2477`), `file_extract` (`:2503`, conditional on `clients.textExtractor`, `:2500-2501`). **Count: 10.** All bind `this.clients.ncFilesClient` (`:2201`).

**Executor operations (Path B) — inventory.** `switch (params.action)` at `file-executor.js:186-194`, enum constrained to 5 (`:114`): **write** `_executeWrite` `:200` (`writeFile :264`, auto-share `shareFile :269`); **read** `_executeRead` `:385` (`readFileBuffer :431/:478`, `textExtractor.extract :479`, `readFile :483`, OCR `_ocrImage :570`, LLM synth `_synthesizeFileContent :512`); **list** `_executeList` `:612` (`listDirectory :624`); **delete** `_executeDelete` `:706` (`deleteFile :729`); **share** `_executeShare` `:752` (`shareFile :789`). **Count: 5.**

**Shell/core seam.** Extraction completes `:157`; validation/clarification `:159-183`; dispatch seam = `switch` at `:186`. Per-op, guard→substrate boundary is inside each handler (write guards `:258` then `:264`; delete `:723`→`:729`; share `:783`→`:789`). Read/list have no `_checkGuardrails` before substrate (`:478-483`, `:624`).

**Pairing table.**

| Operation | Registry tool | Executor op | Resolution/path logic | Substrate | Guard A | Guard B | Ledger B | Multilingual | Verdict |
|---|---|---|---|---|---|---|---|---|---|
| read | `file_read` `:2205` (+`file_extract` `:2503`) | `_executeRead` `:385` | DIFFERS: A `resolvePath` (fuzzy) `:2216`; B `_buildPath` `:400` + last-listing-dir heuristic `:410-419` | A `readFile`; B `readFileBuffer`/`readFile`/`extract` | No | N (`:478-483`) | Y (`:494/549/562`) | DIFFERS: `RAW_CONTENT_PATTERN` EN regex `:56`; `extMatch` EN list `:336` | **ESCALATE**: B folds OCR (`:570`) + LLM synthesis (`:512`) + hallucination guard (`:422`) that A's split read/extract lack |
| list | `file_list` `:2242` | `_executeList` `:612` | DIFFERS: A fuzzy `resolvePath` `:2257`; B raw `:613` | both `listDirectory` | No | N | Y (`:682`) | none | CANONICAL=A |
| write | `file_write` `:2306` | `_executeWrite` `:200` | DIFFERS: A ensures parent via `mkdir` `:2325`; B defaults folder→`Outbox` `:218` | both `writeFile`(+`shareFile`) | **No** (not in SENSITIVE) | **Y (`:258`)** | Y (`:283`) | none | CANONICAL=A — but flag `file_write` ungated on A |
| delete | `file_delete` `:2435` | `_executeDelete` `:706` | DIFFERS: A raw path; B `_buildPath` `:720` | both `deleteFile` | **Yes** SENSITIVE (`guardrail-enforcer.js:21`), HITL | Y (`:723`) | Y (`:745`) | none | CANONICAL=A |
| share | `file_share` `:2477` | `_executeShare` `:752` | DIFFERS: A raw; B `_buildPath` `:778` | both `shareFile` | **Yes** APPROVAL/HIGH_SEVERITY (`guardrail-enforcer.js:75`) | Y (`:783`) | Y (`:805`) | none | CANONICAL=A |
| move | `file_move` `:2391` | **ORPHAN-A** | — | `moveFile` `:2403` | **Yes** SENSITIVE (`guardrail-enforcer.js:22`) | — | — | none | CANONICAL=A (Path-A-only) |
| copy | `file_copy` `:2413` | **ORPHAN-A** | — | `copyFile` `:2425` | No | — | — | none | CANONICAL=A |
| info | `file_info` `:2350` | **ORPHAN-A** | A fuzzy `resolvePath` `:2361` | `getFileInfo` `:2371` | No | — | — | none | CANONICAL=A |
| mkdir | `file_mkdir` `:2456` | **ORPHAN-A** | — | `mkdir` `:2467` | No | — | — | none | CANONICAL=A |
| extract | `file_extract` `:2503` | folded into B read (`:478-479`) | — | `readFileBuffer`+`extract` | No | — | — | none | CANONICAL=A (discrete tool) |

**Port-list: EMPTY.** Every Path-B op (write/read/list/delete/share) has a Path-A equivalent on the same `ncFilesClient` methods. The only B-exclusive behavior is *enrichment* of `read` (OCR + LLM synthesis + listing-hallucination guard) — not a distinct operation; see the ESCALATE row.

**Registry-only orphans (Path-A-only):** `file_move` (`:2391`, confirmed), `file_copy` (`:2413`), `file_info` (`:2350`), `file_mkdir` (`:2456`), `file_extract` (`:2503`, as a discrete tool).

**Asymmetries (File).**
- *Guardrail:* B guards write/delete/share (`:258/:723/:783`). Sharp point: `file_write` is guarded by B but **not** by A — absent from `SENSITIVE_TOOLS`/`HIGH_SEVERITY_TOOLS`/`TOOL_APPROVAL_LABELS` (`guardrail-enforcer.js:19-100`). Conversely `file_move` *is* A-gated (`:22`) but has no B op. (See the cross-path gap analysis in §3.)
- *Ledger:* `actionRecord` is Path-B-only (`:283/494/549/562/682/745/805` + `_logActivity` base `:56`). A's emission lives upstream in AgentLoop, not the handler — so B's `actionRecord` + `_summarizeLastAction` (`:814`) + `_checkFileExistsInListing` (`:305`) machinery is structurally absent from the registry layer.
- *Multilingual:* **Non-empty (finding).** Code-level English branches in B: `RAW_CONTENT_PATTERN` `:56`, extension/filter regex `:336`, inherited `_isMetaInstruction` `base-executor.js:339-341`. A's file tools have no NL-classification regex (only English *response* strings = presentation). A is the healthier language layer.

**Pilot suitability:** File is the **clean pilot**. One-to-one substrate mapping onto the same `ncFilesClient` methods, empty port-list, A a strict superset (10 tools ≥ 5 ops), only **1 ESCALATE** row (read enrichment) and one centralized-policy note (`file_write` ungated on A). Under the vestige finding even the enrichment reaches no user today.

### Wiki

**Registry wiki tools (Path A) — inventory.** `_registerWikiTools()` `tool-registry.js:2696`: `wiki_read` (`:2702`), `wiki_write` (`:2743`), `wiki_search` (`:2893`), `wiki_list` (`:2981`), `wiki_delete` (`:3040`). **Count: 5.**

**Executor operations (Path B) — inventory.** `execute()` dispatcher `wiki-executor.js:69`, action switch `:132`: **read** `_executeRead` `:157` (`wiki_read :171`, fuzzy `memory_search :187`, warm-memory synthesis `:205`); **write** `_executeWrite` `:274` (`wiki_write :299`); **append** `_executeAppend` `:341` (`wiki_read :353` → merge `:357` → `wiki_write :367`); **remember** `_executeRemember` `:411` (`wiki_write :431`); **introspect** `_executeIntrospect` `:473` (`wiki_read` per hardcoded section `:480`, `memory_search :492`). Helpers: `_extractEntityInfo` `:545`, `_formatKnowledgePage` `:610`, `_autoCategory` `:692` over `CATEGORY_MAP :29`.
**Path-B-only knowledge-graph side-effect:** `entityExtractor.extractFromPage` fires after every successful mutation — write `:319`, append `:387`, remember `:446` (late-bound `config.entityExtractor :59`). **Path A has no equivalent** — `entityExtractor`/`extractFromPage` is absent from `tool-registry.js` (grep: zero hits). The registry `wiki_write` handler (`:2755-2889`) updates the page + learning log only; it never feeds the knowledge graph.

**Shell/core seam.** Extraction/validation shell ends at the action switch `:132`. Per-op guard (`_checkGuardrails`) lives inside each mutating handler (`:291/:361/:423`), after a second LLM call (`_extractEntityInfo`) in write/remember.

**Pairing table.**

| Executor operation | Executor core | Paired Path-A tool | Resolution logic | Substrate | Guard A | Guard B | Ledger B | Multilingual | Verdict |
|---|---|---|---|---|---|---|---|---|---|
| read | `wiki-executor.js:157` | `wiki_read` `:2702` | DIFFERS: B adds possessive-strip `:166`, `memory_search` fuzzy fallback `:187`, warm-memory LLM synth `:205` | `wiki_read`/`memory_search`/`router.route` | n/a (read) | N | Y (`:181/199/258`) | none | CANONICAL=A (substrate identical) |
| write | `wiki-executor.js:274` | `wiki_write` `:2743` | DIFFERS: B prepends `_extractEntityInfo` `:286`, `_formatKnowledgePage` `:297`, `_autoCategory` `:288`, then **entityExtractor `:319`** | same `wiki_write` | chokepoint | Y `:291` | Y `:329` | DIFFERS: `_autoCategory`/CATEGORY_MAP EN keywords `:29/692` | **PORT-needed** (entity-graph `:319` absent in A) |
| append | `wiki-executor.js:341` | **PORT** (no A append; `wiki_write` overwrites `:2782-2807`) | DIFFERS: B read→merge→write `:353-367` | `wiki_read`+`wiki_write` | chokepoint | Y `:361` | Y `:395` | DIFFERS: `_autoCategory` EN `:359` | **PORT-needed** (read-merge-write + entity-graph `:387`) |
| remember | `wiki-executor.js:411` | `wiki_write` `:2743` | DIFFERS: proactive-fact path, same entity/frontmatter pipeline, default title `'Notes'` `:420` | same `wiki_write` | chokepoint | Y `:423` | Y `:462` | DIFFERS: `_autoCategory` EN `:421` | **PORT-needed** (carries entity-graph `:446`) |
| introspect | `wiki-executor.js:473` | `wiki_list` `:2981` (approx) | DIFFERS: B probes 8 hardcoded section names + `memory_search '*'`; A enumerates real tree via `listPages`/parentId | `wiki_read`×8, `memory_search` | n/a (read) | N | Y (`:507/533`) | none | CANONICAL=A (introspect is a weaker reimpl of `wiki_list`) |

**Port-list (non-empty — wiki is the one domain with real ports):**
1. **Knowledge-graph entity extraction** — `entityExtractor.extractFromPage` (`:319/387/446`). **No Path-A `wiki_write` tool feeds the knowledge graph after a write** — the *synchronous* chat-write→graph link is Path-B-only. **Scoped, not global:** `extractFromPage` has two other live callers — `heartbeat-extractor.js:259` (sweeps heartbeat-written People/Preferences/Decisions pages) and `document-ingestor.js` (ingested documents) — so the graph is **not** dead. Production confirms it: over the cloud-ok era the graph is actively fed (`[KnowledgeGraph]` 120×, DocumentIngestor 470×, latest Jun 26), while the `wiki_write` tool fired **0×** — the synchronous gap has had **zero live blast radius**. **Verdict: the port can ride with the retirement, not urgent.** When `wiki_write` is the canonical write path, wire `extractFromPage` into its handler/caller so chat-driven wiki writes populate the graph too.
2. **Append semantics** — `_executeAppend` (`:341`) read-merge-write. Path-A `wiki_write` overwrites; there is no additive path. Either port a `wiki_append` tool or document append as unsupported.
3. *(Soft)* **Auto-frontmatter / entity-typing** — `_extractEntityInfo` (`:545`) + `_formatKnowledgePage` (`:610`). Registry `wiki_write` applies a static template only when `type` is passed (`:2768`); it never derives `entity_type`/fields from content.

Read and introspect do **not** need porting (read's substrate = `wiki_read`; introspect is strictly weaker than `wiki_list`).

**Registry-only orphans (Path-A-only):** `wiki_delete` (`:3040`, confirmed — executor never deletes), `wiki_search` (`:2893`, executor uses `memory_search` instead), `wiki_list` (`:2981`, executor reimplements listing via `wiki_read`+`memory_search`).

**Asymmetries (Wiki).**
- *Guardrail:* B guards all three write-variants (write `:291`, append `:361`, remember `:423`); read/introspect ungated (correct). Audit claim ("executor guards write") verified and broader. A gates `wiki_write`/`wiki_delete` structurally at the chokepoint — and since B's writes go *through* `toolRegistry.execute('wiki_write')`, a Path-B write is in practice double-guarded.
- *Ledger:* Different books. B returns in-band `actionRecord` on every op (`:181/199/258/329/395/462/507/533`) + `_logActivity`. A's `wiki_write` writes the *learning log* (`learningLog.logKnowledgeChange` `:2801/2876`), not an `actionRecord`. **`wiki_delete` (`:3049-3069`) writes no learning-log entry — deletions are unledgered on A.**
- *Multilingual:* **Non-empty (finding, Rule-1).** `CATEGORY_MAP` (`:29-48`) is an English-keyword→section table consumed by `_autoCategory` via `includes(keyword)` substring matching (`:692-700`) — a DE ("Besprechung") or PT ("reunião") fact would not auto-categorize. Executor-only; deleting Path B removes (rather than ports) this English-only branch. A's `wiki_write` takes `parent` explicitly and does no keyword categorization.

### Full registry inventory — count reconciliation (67/67)

Group dispatch at `tool-registry.js:441-453`. Static count = **67** `register()` calls (the briefing's "70" is **stale**).

| Group method | Line | Count | Has executor? |
|---|---|---|---|
| `_registerDeckTools` | 686 | 26 | ✔ deck-executor |
| `_registerCalendarTools` | 1709 | 6 | ✔ calendar-executor |
| `_registerMeetingTools` | 2098 | 2 | ✘ Path-A-only |
| `_registerFileTools` | 2200 | 10 | ✔ file-executor |
| `_registerSearchTools` | 2550 | 1 (`unified_search`) | ✘ |
| `_registerTagTools` | 2616 | 1 (`tag_file`) | ✘ |
| `_registerMemoryTools` | 2652 | 1 (`memory_recall`) | ✘ |
| `_registerWikiTools` | 2696 | 5 | ✔ wiki-executor |
| `_registerWebTools` | 3076 | 2 (`web_search`, `web_read`) | ✘ |
| `_registerContactsTools` | 3220 | 3 (`contacts_search/get/resolve`) | ✘ |
| `_registerMemorySearchTools` | 3365 | 1 (`memory_search`) | ✘ |
| `_registerWorkflowDeckTools` | 3435 | 9 (`workflow_deck_*` ×5, `mail_send`, `news_*` ×3) | ✘ |
| **TOTAL** | | **67** | |

**Reconciliation (67/67 accounted).** Every registry tool is paired-to-an-executor-op or listed as an orphan: Deck 11 paired + 15 orphan = 26; Calendar 4 paired + 2 orphan (`check_availability`, `cancel_meeting`) = 6; Meeting 0 paired + 2 orphan = 2; File 5 paired + 5 orphan (`move/copy/info/mkdir/extract`) = 10; Wiki 2 paired (`wiki_read`,`wiki_write`) + 3 orphan (`wiki_search/list/delete`) = 5; and the 8 executor-less groups (search 1, tag 1, memory 1, web 2, contacts 3, memory-search 1, plus meeting 2 above, workflow-deck 9) = 20 Path-A-only. Sum 26+6+2+10+5+18 = 67. ✔

**Runtime caveat (not a discrepancy).** 67 is the *static* registry floor. `ToolActivator` (Skill Forge) registers more at boot — `webhook-server.js:1834-1916` (`reloadAll()` + `autoDiscover()`), and the log at `:1910` reports `toolRegistry.size > 67`. The live count is environment-dependent; 67 is the count of hand-authored tools in the file.

### Registry-only domains (Path-A-only surface)

Only deck/calendar/file/wiki have executors. The other 8 groups (28 tools, ~42% of the surface) are reachable **only** via the tool-calling path: `unified_search`, `tag_file`, `memory_recall`, `web_search`, `web_read`, `contacts_search/get/resolve`, `memory_search`, `meeting_compose`, `meeting_check_rsvp`, and the 9 `_registerWorkflowDeckTools` (the workflow-engine's own tool surface + `mail_send` + news). This is structural proof of the vestige verdict from the *other* direction: **Path A is the strictly-larger surface by construction** — Path B's four executors reach a subset of what Path A already covers, and even within deck/calendar/file/wiki the executors front a narrower action set than the registry exposes (deck 18 ops vs 26 tools, file 5 vs 10).

---

## 3. The three asymmetries — cross-domain synthesis

**A. Guardrail enforcement is inverted between paths — and Path A has one real gap.**
Path A gates exhaustively at a single chokepoint: `agent-loop.js::_executeWithGuards` and `micro-pipeline.js::_executeWithGuards` wrap every dispatch (`ToolGuard.evaluate` → `GuardrailEnforcer.check` → `toolRegistry.execute`). Path B gates selectively via hand-inserted `base-executor._checkGuardrails` per operation — omission-prone by construction. Per-domain, B's coverage is uneven: calendar/file/wiki guard all their mutating ops, but **deck guards only 4 of 15 mutating ops** (`_checkGuardrails` at `deck-executor.js:398/531/1044/1259` only), and two of those four (`delete_board`, `delete_stack`) are *toothless* because the tool names are absent from `tool-guard.js` policy and `evaluate()` defaults them to `ALLOWED` (`:228`). Intersecting `ToolGuard` policy × the operation inventory surfaces two findings:

1. **`file_write` — a live Path-A gap.** Guarded inline by the (vestige) Path B, but **absent from Path A's HITL policy on both sides** — not in `src/security/guards/tool-guard.js` `REQUIRES_APPROVAL` (`:30-66`; only `deck_delete_card` `:53`, `deck_share_board` `:59`, etc.), and not in `src/lib/agent/guardrail-enforcer.js` `SENSITIVE_TOOLS`/`HIGH_SEVERITY_TOOLS`/approval labels (`:19-100`; `file_delete` `:21`, `file_move` `:22`, `file_share` `:75` are listed — `file_write` is not). Because Path A is what actually runs, file *writes* go ungated on the live path today. **Verified directly.** (Note: `file_write` *does* appear at `tool-registry.js:204` — but that is workflow-board capability-narrowing, i.e. which tools a workflow board may use, **not** the HITL gate; it does not contradict this finding.) Whether a write deserves HITL is a policy call — file it as a finding to evaluate, not a confirmed defect; highest-priority of the four because it is on the live path.
2. **Deck board-sharing / board-deletion — forward-looking.** Path B shares and deletes boards/stacks without effective guards. These are Path-B-only operations (no Path-A tool exists — they are on the deck port-list), so they are not *live* gaps; the requirement is that when ported to Path A they carry real `REQUIRES_APPROVAL` policy. `deck_share_board` is already in ToolGuard policy (`tool-guard.js:59`); the new `deck_delete_board`/`deck_delete_stack` ports must be added.

The convergence implication is unchanged: a shared core stays guard-free; Path B's scattered per-op guards lift to one chokepoint at the shell entry (matching A), and `file_write` + the destructive deck ports are added to the central policy.

**B. Action ledger — Path A records nothing; deleting Path B loses nothing it had, but exposes that A never recorded.**
`actionRecord` is a Path-B-only construct: executors emit one per op (~45 references in `deck-executor.js`; calendar/file/wiki likewise) plus `_logActivity`. `tool-registry.js` and `agent-loop.js` contain **zero** `actionRecord`/`recordAction` references (verified by grep). In `message-processor.js`, `_captureActionRecord` is called only on the microPipeline / knowledge / compound / thinking branches — **never on the nine `agentLoop.process` branches** (e.g. `:716/784/831/864/908/953/983/1037/1073`). So actions taken on Path A — the path that actually runs (22/28 → cloud in the journal) — produce **no** session action-ledger entry. This is the action-ledger gap, confirmed in production: the live path is the unledgered one. A shared core emitting ledger records once would *add* ledger coverage to Path A — a desirable behavior change to state explicitly in the migration plan.

**C. Parameter acquisition — the SLM-accommodation, contingent on the verdict.**
Executors extract params from a message (`base-executor._extractJSON`); registry handlers receive structured args already extracted by the tool-calling LLM. This asymmetry exists *because* Path B was built for models that could not tool-call. Under the vestige verdict it is **the thing that deletes**, not a seam to preserve: there is one surviving shell (Path A), and Path B's `_extractJSON` NL extraction, per-op guard insertions, and clarification dialogue are removed rather than kept beside a shared core. (It would become a permanent seam only under a fast-path or fallback verdict — which the journal does not support.)

---

## 4. (d) DI / construction gap

**Executor constructor deps.** `BaseExecutor` (`base-executor.js:38-47`): **`router`** (hard — throws at `:39`), then optional `cloudProvider`/`claudeProvider` (`:41`), `guardrailEnforcer` (`:42`), `toolGuard` (`:43`), `activityLogger` (`:44`), `timezone` (`:45`), `logger` (`:46`). Domain additions: Deck (`deck-executor.js:69-76`) adds `toolRegistry`, `deckClient`, `adminUser`, `boardMapProvider`; Calendar (`:39-43`) adds `calendarClient`; File (`:65-69`) adds `ncFilesClient`, `textExtractor`; Wiki (`:51-59`) adds `toolRegistry`, `entityExtractor`.

**Construction sites.** Path A: `new ToolRegistry({...})` `webhook-server.js:1813-1832` (all NC clients); `new AgentLoop({...})` `:1958-1973` (`toolRegistry`, `llmProvider`, `toolGuard` `:1959`, `guardrailEnforcer` `:1962`, `activityLogger` `:1963`, config `:1972`). Path B: executors instantiated lazily in `message-processor.js:1567-1629`, fed from `microPipeline` refs (router, cloudProvider, guardrailEnforcer, toolGuard, activityLogger, timezone) + clients re-read from `toolRegistry.clients` (e.g. `ncFilesClient` `:1583`, `deckClient` `:1616`).

| Dependency | Required by executors? | Supplied at A's construction site? | Delta for a shared core |
|---|---|---|---|
| `router` (LLMRouter) | YES (hard, `base-executor.js:39`) | Not directly; AgentLoop carries `llmProvider` (`:1969`); router reaches executors via microPipeline (`message-processor.js:1568`) | **Needs a single LLM-handle convention** |
| `cloudProvider` | optional | AgentLoop `llmProvider`; executors `microPipeline.cloudToolsProvider` | Name/shape mismatch — two cloud handles |
| `guardrailEnforcer` | optional | YES — AgentLoop `:1962` | aligned |
| `toolGuard` | optional | YES — AgentLoop `:1959` | aligned |
| `activityLogger` | optional | YES — AgentLoop `:1963` | aligned (but only Path B *uses* it for ledger) |
| `timezone`/`logger` | optional | YES (`:1972` / implicit console) | aligned |
| `toolRegistry` | YES (Deck/Wiki) | YES — same singleton | already shared |
| `deckClient`/`calDAVClient`/`ncFilesClient`/`textExtractor` | per domain | YES — ToolRegistry `:1814-1819` (executors re-read via `toolRegistry.clients.*`) | already shared (two handles to same client) |
| `entityExtractor` | Wiki optional (`:58`) | **NOT supplied to either site** | dangling — never wired (ties to the Wiki port-list) |
| `boardMapProvider`, `adminUser` | Deck optional | Path B only (`message-processor.js:1620/1625`) | Path-B-specific enrichment hooks |

**Implication.** Both sites already converge on the same `toolRegistry`, domain clients, `guardrailEnforcer`, `toolGuard`, `activityLogger`. The only genuine deltas are (1) the **LLM handle** (AgentLoop carries `llmProvider`; executors carry `router` + `cloudToolsProvider` — a shared core needs one convention) and (2) the **Path-B-only hooks** (`boardMapProvider`, `adminUser`, `entityExtractor`) a unified core would absorb as optional. Notably, `entityExtractor` is required by the Wiki port yet **is not supplied at either construction site** today — confirming the knowledge-graph wiring is the loose end the Wiki port-list flags.

---

## 5. (e) Proposed collapse / retirement sequence

Under the **vestige** verdict the deliverable is a *retirement* plan, not a domain-by-domain unify pilot. The collapse PR must be **net-negative in lines** (if net-positive, the duplicated core was wrapped, not removed — the audit's standing guardrail).

**Sequencing — easiest-to-retire first, by port-list size:**

1. **File** (port-list empty) — delete `file-executor.js`. Pre-delete checklist: (i) decide whether `read` enrichment (OCR + LLM synthesis + listing-hallucination guard) is worth porting onto `file_read`/`file_extract`, or accept its loss (it reaches no user today); (ii) add `file_write` to the central `SENSITIVE_TOOLS`/approval policy so the gap B was covering is closed at the chokepoint. The clean pilot.
2. **Calendar** (port-list empty) — delete `calendar-executor.js`. Pre-delete: confirm no consumer depends on the multi-`query_type` formatting or the `resumeWithClarification` slot-filling UX; accept loss of English-pinned formatters (a multilingual *improvement*). Note the op-level core shape (`updateEvent`/`deleteEvent`/`queryEvents`) as the reference for what a clean handler looks like.
3. **Wiki** (3 ports) — delete `wiki-executor.js` **only after** the port-list is satisfied: (1) wire `entityExtractor.extractFromPage` into the `wiki_write` handler/caller (non-negotiable — graph population stops otherwise; note `entityExtractor` is currently not wired at *either* construction site, §4), (2) add a `wiki_append` tool or document append as unsupported, (3) optionally port content-derived auto-frontmatter.
4. **Deck** (7 ports — largest surface) — delete `deck-executor.js` last, after its ports land as Path-A tools: `rename_board`/`archive_board`/`delete_board` (board lifecycle), `rename_stack`/`delete_stack` (stack lifecycle), `setup_workflow` + `troubleshoot` (compounds). The two destructive ports (`delete_board`, `delete_stack`) and the board-sharing inside the compounds **must** be added to ToolGuard `REQUIRES_APPROVAL` when created — Path B's guards on them are toothless today.

Wiki and Deck both gate the program: each has operations where deletion-without-port is a regression (Wiki: knowledge-graph population; Deck: board/stack lifecycle the tool-calling LLM currently cannot perform at all).

**Cross-cutting, do once (not per domain):**
- Lift the ledger decision: if Path A should record actions, add `actionRecord` emission at the AgentLoop dispatch (or a shared post-dispatch hook) — this closes asymmetry B for all domains at once.
- Collapse the two `_executeWithGuards` copies (`agent-loop.js` + `micro-pipeline.js`) into one shared wrapper — a small rule-5 cleanup riding alongside, independent of executor retirement.
- Retire the SLM-accommodation stratum (§Appendix) as a coordinated follow-up, so the program removes the whole dead-weight class rather than just the executors.

---

## 6. (7) Multilingual pass (DE / EN / PT)

The expected healthy result is an empty column. It is **not** empty — every executor (Path B) carries English-only branches, and in each case Path A is the healthier language layer:

| Domain | Finding | Location | Class |
|---|---|---|---|
| Wiki | `CATEGORY_MAP` English-keyword→section table, `includes()` substring match | `wiki-executor.js:29-48`, `:692-700` | **Rule-1 violation** (word-list standing in for comprehension) — DE/PT facts mis-categorize |
| File | `RAW_CONTENT_PATTERN` EN verb regex; extension-filter EN regex | `file-executor.js:56`, `:336` | Rule-1 (NL classification in code) |
| Calendar | English-pinned shell prompt + formatters + forced `'en-US'` locale | `calendar-executor.js:80-123`, `:677-727` | hardcoded language strings + locale pinning |
| Base | `_resolveDate` matches English day names; `_isMetaInstruction` EN regex | `base-executor.js:199`, `:339-341` | Rule-1 (inherited by all executors) |

These are **not** findings to fix in place — under the vestige verdict they *delete* with Path B. They are recorded because they confirm the architectural reading: the deterministic executors are the residue of the pre-tool-calling era, and they carry exactly the language-layer-in-code anti-patterns the platform has since routed to the LLM. Path A's handlers carry no NL-classification branches (only presentation strings). **The migration is also a multilingual cleanup.**

---

## 7. (Appendix) SLM-accommodation stratum — flag, do not fix here

The executor shell is not the only artifact of the all-local-SLM era. Two siblings exist for the same generating function — *make a non-tool-calling small local model behave like a tool-calling one*. Both become dead weight if the system commits to tool-calling models (cloud Haiku today; `nc-tools-3b` locally tomorrow). Listed for the same retirement question, **not changed here.**

- **`agent-loop.js::_parseToolCallFromText` (`:863`) + `_resolveToolName` (`:926`).** Scrapes a tool call out of raw model *text* when the model failed to emit a structured tool call — matches `{"name","arguments"|"parameters"}` (`:872`), function-style `tool(args)` (`:885`), keyword-arg form (`:897`); `_resolveToolName` adds fuzzy suffix matching (`list_cards`→`deck_list_cards`, `:929-938`). Called from `agent-loop.js:190` and `:525`. Accommodates SLMs that describe a tool call in prose instead of using the tool-call channel. (The #164 raw-envelope leak originated here.)
- **`guardrail-enforcer.js::_keywordFallback` (`:372`) + `_getConfirmationPatterns` (`:782`).** `_keywordFallback` keyword-matches a guardrail title against `KEYWORD_FALLBACK_MAP[toolName]` (`:373-382`) when the semantic classifier is unavailable; `_getConfirmationPatterns` is a per-tool hardcoded regex table (`deck_delete_card`, `file_delete`, `wiki_delete`, `deck_share_board`…) for reading HITL yes/no without an LLM. A Rule-1 "regex standing in for comprehension" layer beneath the semantic check, justified only by the local-model floor.

These three (executor shell, text-parse fallback, keyword guard fallback) are one stratum. Retiring only the executors leaves the stratum half-removed; the follow-up should pose the retirement question for all three together, gated on the same `nc-tools-3b` milestone.

---

## 8. Verification gate (discovery-adapted)

- **Step 0 liveness verdict recorded with journal evidence** — VESTIGE; executor dispatch 0/28 over 2026-06-04→06-30 under `cloud-ok`; router code paths (`message-processor.js:673/1653/1804-1824`) explain why. ✔
- **Every registry tool paired-or-orphaned; count reconciles** — **67/67** accounted (briefing's "70" was stale). ✔
- **Every ledger/port-list row cites both sources by `file:line`, read not inferred** — ✔ (five independent reads).
- **Three asymmetries characterized per domain** — guardrail/ledger/multilingual tables in each domain section + §3 synthesis. ✔
- **Action-ledger gap confirmed in journal/code** — Path A handlers + `agent-loop.js` carry zero `actionRecord`; agentLoop branches never call `_captureActionRecord`; live traffic (22/28 → cloud) is unledgered. ✔

**`[VERIFIED: discovery]`** Path B liveness = **vestige** (journal: executor dispatch **0/28** smart-mix classifications over 2026-06-04→2026-06-30 under `cloud-ok`; 22→cloud, 6→local-tools all knowledge/compound, **zero** executor signatures, zero `[MicroPipeline] Domain task` dispatches; residual reachability via confirmation-replay/compound observed 0×); **67/67** registry tools paired-or-orphaned (count reconciled; briefing's "70" stale); ledger collapses to a **port-list of 10 ops** — Deck 7 (`rename_board`,`archive_board`,`delete_board`,`rename_stack`,`delete_stack`,`setup_workflow`,`troubleshoot`) + Wiki 3 (entity-extraction, append, auto-frontmatter); Calendar/File port-lists **empty**; **2 ESCALATE-class findings** (live `file_write` ungated on Path A; Wiki knowledge-graph population Path-B-only); guardrail/ledger/param asymmetries characterized per domain; action-ledger gap confirmed in code+journal (tool-calling actions **absent** from the session ledger); DI delta recorded (§4 — `entityExtractor` dangling, LLM-handle convention the only real gap).

---

## 9. Handoff

This document goes to architecture-altitude review. That review makes two calls discovery deliberately did not:

1. **Retire vs thin-shell Path B.** The vestige finding supports retirement under `cloud-ok`. The counter-argument is the local-only / non-tool-calling degraded mode, for which Path B is the structurally-correct home until `nc-tools-3b` (a tool-calling SLM) can run that mode on Path A. Decide: delete now, or keep a thin shell over a shared core until `nc-tools-3b` lands.
2. **Ledger parity (asymmetry B).** Decide whether Path A should record actions; if yes, that is a one-place change at the AgentLoop dispatch, independent of executor retirement.

**Issues to file from this discovery** (each through the public-content privacy pass — `next` issues are public; host placeholders, no IPs/client names):
- **`file_write` ungated on Path A** — guarded by the (vestige) executor but absent from `guardrail-enforcer.js` `SENSITIVE_TOOLS`/approval policy; the live path does not gate file writes. *(Likely the highest-priority finding — a real safety asymmetry on the path that runs.)*
- **Wiki knowledge-graph population — synchronous chat-write path is Path-B-only** — `entityExtractor.extractFromPage` is not called by the Path-A `wiki_write` handler. **Verified in production (no longer hypothetical):** the graph is alive via `heartbeat-extractor.js:259` + `document-ingestor.js` (`[KnowledgeGraph]` 120×, DocumentIngestor 470× over the cloud-ok era), and the `wiki_write` tool fired 0× live — so the gap is **dormant, not urgent**. File as a *port-with-retirement* tracking item, not a live-degradation incident.
- **Multilingual executor residue** — the Rule-1 branches in §6, as the multilingual half of the retirement.
- **SLM-accommodation stratum** — §Appendix, as a coordinated follow-up retirement.

**Migration guardrail (carried from the audit):** the collapse PR is **net-negative in lines.** Net-positive means the duplicated core was wrapped, not removed.
