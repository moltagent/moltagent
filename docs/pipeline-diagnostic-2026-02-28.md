# Pipeline Diagnostic — 2026-02-28

## Q1: Message Processing Paths

Production entrypoint: `webhook-server.js` → `MessageProcessor.process()` in `src/lib/server/message-processor.js`

```
Message arrives at webhook-server.js
  ↓
MessageProcessor.process(data)
  ↓
Is it a bot's own message? → YES: Skip
  ↓ NO
Is it a slash command? → YES: PATH 1 (CommandHandler)
  ↓ NO
_shouldUseMicroPipeline()? [AgentLoop.llmProvider.primaryIsLocal]
  → YES: PATH 2 (MicroPipeline local-only)
  ↓ NO
_isSmartMixMode()? [RouterChatBridge with >1 provider]
  → YES: PATH 3 (SmartMix hybrid)
  ↓ NO
AgentLoop available?
  → YES: PATH 4 (AgentLoop cloud)
  ↓ NO
PATH 5 (MessageRouter fallback/legacy)
```

**PATH 2 (MicroPipeline) classification tree:**
- greeting → _handleChat() (no tools)
- chitchat → _handleChat() (no tools)
- question → _handleQuestion() (memory search + synthesis, no tools)
- task → _handleTask() (create deck card, no tools)
- command → _handleChat()
- complex → _handleComplex() (defer or decompose)
- deck/calendar/email/wiki/file/search → _handleDomainTask() (focused tool subset)

**PATH 3 (SmartMix) sub-paths:**
- 3a: useLocal=false → AgentLoop.process() (cloud, full tools)
- 3b: useLocal=true, useDomainTools=false → MicroPipeline (local, no tools)
- 3c: useLocal=true, useDomainTools=true → MicroPipeline domain (local, focused tools)
- Escalation: domain task fails → throws DOMAIN_ESCALATE → AgentLoop.process()

## Q2: Tool Access Per Path

| Path | Handler | Tools? | Which? | Loop? |
|------|---------|--------|--------|-------|
| 1 | CommandHandler | ❌ | Built-in commands only | No |
| 2a | MicroPipeline (chat/question) | ❌ | None | No |
| 2b | MicroPipeline (domain task) | ✅ | 3-8 focused subset | Yes (3 max) |
| 3a | AgentLoop (cloud escalation) | ✅ | Full registry (~68) | Yes (8 max) |
| 3b | MicroPipeline (local chat) | ❌ | None | No |
| 3c | MicroPipeline (local domain) | ✅ | 3-8 focused subset | Yes (3 max) |
| 4 | AgentLoop | ✅ | Full registry (~68) | Yes (8 max) |
| 5 | MessageRouter (legacy) | ❌ | Direct client APIs | No |

## Q3: SOUL.md Loading Per Path

| Path | SOUL.md? | Notes |
|------|----------|-------|
| 1 (commands) | ❌ | No LLM call |
| 2 (MicroPipeline) | ❌ | Uses buildMicroContext() — lightweight domain prompts |
| 3a (SmartMix→cloud) | ✅ | AgentLoop._buildSystemPrompt() includes SOUL.md |
| 3b (SmartMix→local chat) | ❌ | MicroPipeline path |
| 3c (SmartMix→local domain) | ❌ | MicroPipeline path |
| 4 (AgentLoop) | ✅ | Full SOUL.md in system prompt |
| 5 (MessageRouter) | ❌ | No SOUL.md |

SOUL.md loaded once in AgentLoop constructor via `_loadSoul()`, cached in `this.soul`.
System prompt assembly order: Style → Persona → Cockpit overlay → Date → SOUL.md → Memory → Warm Memory → Daily Briefing → Voice context.

## Q4: Post-Response Hook

**EXISTS — fire-and-forget pattern already used.**

After response sent to Talk (message-processor.js ~line 659):
```javascript
// M1: Consolidate warm memory after substantive conversations
this._maybeConsolidate(session).catch(err => {
  console.warn(`[WarmMemory] Post-response consolidation failed: ${err.message}`);
});
```

Full post-response sequence:
1. Layer 3 action ledger capture (sync, during response construction)
2. Session context add + flush flag (sync)
3. Voice reply TTS (async, before text reply)
4. Talk text reply sent (async)
5. Audit logging (async)
6. Warm memory consolidation (async, fire-and-forget)
7. Status indicator update (async)

ProactiveEvaluator should plug in alongside step 6 using the same `.catch()` pattern.

## Q5: AgentLoop Tool Registry

68 tools across 8 domains:

- **Deck (24):** deck_list_cards, deck_move_card, deck_create_card, deck_create_board, deck_create_stack, deck_get_board, deck_get_card, deck_update_card, deck_delete_card, deck_assign_user, deck_unassign_user, deck_set_due_date, deck_add_label, deck_remove_label, deck_add_comment, deck_list_comments, deck_share_board, deck_overview, deck_my_assigned_cards, deck_overdue_cards, deck_mark_done, deck_complete_task, deck_complete_review, deck_list_stacks, deck_list_boards
- **Calendar (9):** calendar_list_events, calendar_create_event, calendar_check_conflicts, calendar_update_event, calendar_delete_event, calendar_check_availability, calendar_quick_schedule, calendar_schedule_meeting, calendar_cancel_meeting
- **File (9):** file_read, file_list, file_write, file_info, file_move, file_copy, file_delete, file_mkdir, file_share, file_extract
- **Wiki (5):** wiki_read, wiki_write, wiki_search, wiki_list, wiki_delete
- **Search/Memory (5):** unified_search, memory_recall, memory_search, tag_file
- **Web/Contacts (4):** web_search, web_read, contacts_search, contacts_get, contacts_resolve
- **Workflow (4):** workflow_deck_move_card, workflow_deck_add_comment, workflow_deck_create_card, workflow_deck_update_card
- **Email (1):** mail_send

Domain subsets for MicroPipeline (3-8 tools each): deck, calendar, email, wiki, file, search

## Q6: Handler Return Shape

```javascript
{
  response: string,                    // User-facing text → sent to Talk
  pendingClarification?: {             // Layer 1: follow-up question state
    executor: string,                  // 'calendar', 'wiki', 'file'
    action: string,
    missingFields: string[],
    collectedFields: Object,
    originalMessage: string,
    askedAt: number
  },
  actionRecord?: {                     // Layer 3: action ledger entry
    type: string,                      // 'calendar_create', 'deck_move_card', etc.
    refs: Object,                      // { eventId, cardId, summary, etc. }
    timestamp: number
  },
  requiresConfirmation?: boolean,      // HITL approval needed
  error?: boolean,
  intent?: string,
  provider?: string
}
```

Pipeline unwraps: extracts pendingClarification → session, actionRecord → ledger, response → Talk.

## Q7: Session State After Response

```javascript
session = {
  id: string,                          // UUID
  roomToken: string,                   // Talk room
  userId: string,
  createdAt: number,
  lastActivityAt: number,

  // Layer 1: Conversation history
  context: Array<{ role, content, timestamp }>,

  // Layer 1.5: Clarification state
  pendingClarification: Object | null, // 5-min expiry

  // Layer 2: Security
  credentialsAccessed: Set<string>,
  pendingApprovals: Map,
  grantedApprovals: Map,

  // Layer 3: Action ledger (FIFO, last 10)
  actionLedger: Array<{ type, refs, timestamp }>,

  // Internal
  _flushRequested: boolean,
  _pendingFlush: boolean
}
```

Accessors: `sessionManager.getLastAction(session, domainPrefix)`, `getRecentActions(session, domainPrefix)`, `getPendingClarification(session)`.

## Implications for Phase 2

1. **Post-response hook pattern exists** — `_maybeConsolidate()` uses fire-and-forget `.catch()`. ProactiveEvaluator plugs in identically.

2. **Insertion point**: message-processor.js, after Talk reply, alongside warm memory consolidation.

3. **All response paths converge** in message-processor.js before Talk reply — single insertion point covers all paths.

4. **Session has everything needed**: conversation context, action ledger, classification, room token.

5. **TalkSendQueue API**: `talkQueue.enqueue(roomToken, message)` — positional args, not object.

6. **Local LLM for triage**: MicroPipeline already does local classification. Router has `classifyRaw` or `route('quick', prompt)`.

7. **AgentLoop for action**: Has full tool registry (68 tools) including wiki_write, deck_create_card. Use `agentLoop.process()` with custom system prompt addition.

8. **Initiative level**: Available via `appConfig.proactive.initiativeLevel` or heartbeat settings.
