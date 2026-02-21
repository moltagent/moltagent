# Moltagent Wiring Audit Report

Generated: 2026-02-21T23:39:04.551Z

## Scanner 1: Orphaned Client Methods

- ℹ DeckClient.classifyBoard() — internal use only (called by other methods in same class)
- ℹ DeckClient.getClassifiedBoards() — internal use only (called by other methods in same class)
- ⚠ DeckClient.getBoardType() — no external references found
- ℹ DeckClient.findBoard() — internal use only (called by other methods in same class)
- ℹ DeckClient.createBoard() — internal use only (called by other methods in same class)
- ⚠ DeckClient.completeTask() — no external references found
- ⚠ DeckClient.completeReview() — no external references found
- ⚠ DeckClient.clearCache() — no external references found
- ⚠ DeckClient.getAssignedUsers() — no external references found
- ℹ CalDAVClient.getCalendars() — internal use only (called by other methods in same class)
- ⚠ CalDAVClient.getCalendar() — no external references found
- ℹ CalDAVClient.getTodayEvents() — internal use only (called by other methods in same class)
- ⚠ CalDAVClient.scheduleMeeting() — no external references found
- ⚠ CalDAVClient.cancelMeeting() — no external references found
- ⚠ CalDAVClient.amIFreeAt() — no external references found
- ⚠ CalDAVClient.quickSchedule() — no external references found
- ℹ CollectivesClient.listCollectives() — internal use only (called by other methods in same class)
- ℹ CollectivesClient.getCollective() — internal use only (called by other methods in same class)
- ℹ CollectivesClient.createCollective() — internal use only (called by other methods in same class)
- ⚠ CollectivesClient.getPage() — no external references found
- ⚠ CollectivesClient.setPageEmoji() — no external references found
- ℹ CollectivesClient.resolveWikilinks() — internal use only (called by other methods in same class)
- ℹ CollectivesClient.getCollectiveCircleId() — internal use only (called by other methods in same class)
- ℹ CollectivesClient.addTeamMember() — internal use only (called by other methods in same class)
- ⚠ ContactsClient.resolve() — no external references found
- ⚠ ContactsClient.fetchAll() — no external references found
- ℹ NCFilesClient.getRootListing() — internal use only (called by other methods in same class)
- ⚠ NCFilesClient.invalidateRootCache() — no external references found
- ⚠ SearXNGClient.healthCheck() — no external references found
- ⚠ WebReader.clearCache() — no external references found
- ⚠ SelfHealClient.health() — no external references found

## Scanner 2: Unguarded Tools

- ℹ send_email — in REQUIRES_APPROVAL but not registered as a tool (may be intentional guard for future or external ops)
- ℹ send_message_external — in REQUIRES_APPROVAL but not registered as a tool (may be intentional guard for future or external ops)
- ℹ webhook_call — in REQUIRES_APPROVAL but not registered as a tool (may be intentional guard for future or external ops)
- ℹ delete_file — in REQUIRES_APPROVAL but not registered as a tool (may be intentional guard for future or external ops)
- ℹ delete_files — in REQUIRES_APPROVAL but not registered as a tool (may be intentional guard for future or external ops)
- ℹ delete_folder — in REQUIRES_APPROVAL but not registered as a tool (may be intentional guard for future or external ops)
- ℹ modify_calendar — in REQUIRES_APPROVAL but not registered as a tool (may be intentional guard for future or external ops)
- ℹ delete_calendar_event — in REQUIRES_APPROVAL but not registered as a tool (may be intentional guard for future or external ops)
- ℹ modify_contacts — in REQUIRES_APPROVAL but not registered as a tool (may be intentional guard for future or external ops)
- ℹ execute_shell — in REQUIRES_APPROVAL but not registered as a tool (may be intentional guard for future or external ops)
- ℹ run_command — in REQUIRES_APPROVAL but not registered as a tool (may be intentional guard for future or external ops)
- ℹ access_new_credential — in REQUIRES_APPROVAL but not registered as a tool (may be intentional guard for future or external ops)
- ℹ external_api_call — in REQUIRES_APPROVAL but not registered as a tool (may be intentional guard for future or external ops)
- ℹ notification_send — in REQUIRES_APPROVAL but not registered as a tool (may be intentional guard for future or external ops)
- ℹ deck_delete_card — in REQUIRES_APPROVAL but not in SENSITIVE_TOOLS (bypasses Cockpit GATE flow, uses ToolGuard HITL only)
- ℹ deck_share_board — in REQUIRES_APPROVAL but not in SENSITIVE_TOOLS (bypasses Cockpit GATE flow, uses ToolGuard HITL only)
- ℹ file_share — in REQUIRES_APPROVAL but not in SENSITIVE_TOOLS (bypasses Cockpit GATE flow, uses ToolGuard HITL only)

## Scanner 3: Inconsistent Error Handling

- ✓ No findings

## Scanner 4: SOUL.md ↔ Code Drift

- ✓ No findings

## Scanner 5: Tool Subset Gaps

- ℹ deck_move_card — prefix suggests 'deck' subset but NOT included (subset has 5/5 slots)
- ℹ deck_list_boards — prefix suggests 'deck' subset but NOT included (subset has 5/5 slots)
- ℹ deck_create_board — prefix suggests 'deck' subset but NOT included (subset has 5/5 slots)
- ℹ deck_create_stack — prefix suggests 'deck' subset but NOT included (subset has 5/5 slots)
- ℹ deck_get_card — prefix suggests 'deck' subset but NOT included (subset has 5/5 slots)
- ℹ deck_update_card — prefix suggests 'deck' subset but NOT included (subset has 5/5 slots)
- ℹ deck_delete_card — prefix suggests 'deck' subset but NOT included (subset has 5/5 slots)
- ℹ deck_unassign_user — prefix suggests 'deck' subset but NOT included (subset has 5/5 slots)
- ℹ deck_set_due_date — prefix suggests 'deck' subset but NOT included (subset has 5/5 slots)
- ℹ deck_add_label — prefix suggests 'deck' subset but NOT included (subset has 5/5 slots)
- ℹ deck_remove_label — prefix suggests 'deck' subset but NOT included (subset has 5/5 slots)
- ℹ deck_add_comment — prefix suggests 'deck' subset but NOT included (subset has 5/5 slots)
- ℹ deck_list_comments — prefix suggests 'deck' subset but NOT included (subset has 5/5 slots)
- ℹ deck_share_board — prefix suggests 'deck' subset but NOT included (subset has 5/5 slots)
- ℹ deck_overview — prefix suggests 'deck' subset but NOT included (subset has 5/5 slots)
- ℹ deck_my_assigned_cards — prefix suggests 'deck' subset but NOT included (subset has 5/5 slots)
- ℹ deck_overdue_cards — prefix suggests 'deck' subset but NOT included (subset has 5/5 slots)
- ℹ deck_mark_done — prefix suggests 'deck' subset but NOT included (subset has 5/5 slots)
- ℹ file_info — prefix suggests 'file' subset but NOT included (subset has 5/5 slots)
- ℹ file_copy — prefix suggests 'file' subset but NOT included (subset has 5/5 slots)
- ℹ file_mkdir — prefix suggests 'file' subset but NOT included (subset has 5/5 slots)
- ℹ file_share — prefix suggests 'file' subset but NOT included (subset has 5/5 slots)
- ℹ file_extract — prefix suggests 'file' subset but NOT included (subset has 5/5 slots)
- ℹ memory_recall — prefix suggests 'search' subset but NOT included (subset has 5/5 slots)
- ℹ wiki_list — prefix suggests 'wiki' subset but NOT included (subset has 5/5 slots)
- ℹ contacts_get — prefix suggests 'search' subset but NOT included (subset has 5/5 slots)

## Scanner 6: Approval Path Completeness

- ✓ No findings

---
**Summary:** 18 warnings, 56 info items
