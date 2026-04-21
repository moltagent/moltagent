---
name: moltagent-dev-rules
description: Moltagent's non-negotiable development rules and Verification Gate convention. This project is LLM-native; conventional coding instincts produce the wrong solutions. Apply whenever touching code that handles natural language, classification, intent detection, keyword extraction, multilingual behavior, trust boundaries, LLM routing, or when adding new features. Load PROACTIVELY at the start of any coding task. The 8-rule checklist and the Verification Gate at the end together form the final gate before committing code or declaring a session done.
---

# Moltagent Development Rules

**Read this before writing ANY code. These rules are non-negotiable.**

This file exists because conventional programming instincts produce the wrong solutions in this architecture. Moltagent is an LLM-native system. The principles below override default coding habits.

---

## Rule 1: The LLM Is the Language Layer

NEVER write code that contains:
- Arrays, Sets, or Maps of words in any language (stop words, keywords, phrases)
- Regex patterns that match natural language content
- Language-specific string comparisons or detection
- Keyword lists for intent classification, entity detection, or meaning extraction
- Hardcoded greeting phrases, question words, or filler verbs
- Any `if (message.includes('...'))` or `if (message.match(/.../)` on user input

If a task requires **understanding** language → use the LLM.
If a task requires **manipulating** strings (URL parsing, date formatting, path handling, JSON construction) → use code.

**The test:** "Does this code need to change when we add a new language?" If yes → it's wrong. Use the LLM.

**The cost argument is invalid.** qwen2.5:3b runs locally in ~100-200ms for free. A stop word list saves 100ms but creates permanent maintenance debt across every language. The LLM call is always cheaper in total cost of ownership.

**Examples:**

| Task | WRONG | RIGHT |
|------|-------|-------|
| Extract search keywords from a message | Stop word list + regex | LLM: "Extract 1-4 noun phrases" |
| Detect if a message is a greeting | `if (GREETINGS.has(msg.toLowerCase()))` | Classifier returns gate: 'greeting' |
| Classify message intent | Keyword matching on action verbs | LLM classifier with multilingual examples |
| Parse entity names from text | Regex for capitalized word pairs | LLM entity extraction |
| Detect language of a message | `if (msg.includes('Hallo'))` | LLM detects language naturally |
| Filter question words from search | `STOP_WORDS = new Set(['what','how','wie','como'])` | LLM extracts only nouns/noun phrases |

---

## Rule 2: Analysis and Synthesis Before Code

When a bug or failure appears:

1. **What CLASS of problem is this?** Not "this string doesn't match" but "why is code parsing natural language?"
2. **What GENERATES this class?** The stop word list generates language-specific edge cases. What generated the stop word list? The assumption that keyword extraction is a code task.
3. **Fix the generator, not the instance.** Don't add more stop words. Replace the stop word approach with an LLM call.

Two instances of the same pattern = stop patching, find the generating function.

If a commit adds more lines than it removes → question whether the fix is at the right altitude.

---

## Rule 3: No Post-Classify Guards

If the LLM classifier returns an incorrect result:
- ✅ Fix the classifier prompt (better examples, clearer rules)
- ✅ Use a better model for classification
- ❌ Do NOT add code that checks the classifier's output and overrides it
- ❌ Do NOT add regex that re-classifies after the LLM already decided

The only acceptable post-classify guard is structural validation (e.g., "the LLM returned an invalid gate name → fall back to default"). Never semantic validation ("the LLM said 'thinking' but I think it should be 'knowledge' because the message contains 'what is'").

---

## Rule 4: Multilingual by Default

Every feature must work in German, English, and Portuguese on day one. French and Spanish are bonus. If it only works in English, it's not a feature — it's a prototype.

This means:
- No English-only examples in LLM prompts (always include DE + PT)
- No language-specific code paths
- No hardcoded day names, month names, or date formats (use `Intl.DateTimeFormat`)
- No language detection in code (the LLM detects language implicitly)
- Feedback messages keyed by the Cockpit language setting, not by detected language

---

## Rule 5: Plumbing vs Intelligence

Before writing any function, ask: "Is this plumbing or intelligence?"

**Plumbing** (code handles this):
- HTTP requests, WebDAV operations, API calls
- File I/O, path manipulation, JSON parsing
- Database queries, cache management
- Authentication, credential brokering
- Rate limiting, retry logic, circuit breakers
- Markdown formatting, link generation
- Date math, timezone conversion
- Queue management, batch processing

**Intelligence** (LLM handles this):
- Understanding what the user means
- Classifying intent or document type
- Extracting entities, keywords, or summaries
- Generating natural language responses
- Detecting sentiment, tone, or urgency
- Resolving pronouns or ambiguous references
- Deciding what's relevant or important
- Drafting emails, messages, or content

When in doubt → it's intelligence → use the LLM.

---

## Rule 6: Trust Boundary Is the Single Control

`trust: local-only` or `trust: cloud-ok` is the ONE setting that controls what touches the cloud.

- Do NOT add `role: 'sovereign'` or `forceLocal: true` to individual components
- Do NOT override the trust boundary in specific modules
- The user decided. Every component respects it via the roster chain.
- The ONLY exception: `JOBS.CREDENTIALS` (key material that must never leave the box regardless of trust setting)

---

## Rule 7: Prompt Updates, Not Code Guards

When the LLM produces incorrect output:

1. First check: is the prompt clear enough?
2. Second check: does the prompt have good multilingual examples?
3. Third check: is the right model being used for this task?
4. Last resort: is there a structural issue the code should catch?

The vast majority of LLM output issues are prompt issues. Fix the prompt. Add examples. Clarify the rules. Don't wrap the LLM in code that compensates for a weak prompt.

---

## Rule 8: The Anti-Pattern Checklist

Before committing, check for these. If any are present, reconsider the approach:

- [ ] Did I create a Set, Array, or Map of natural language words? → Use LLM
- [ ] Did I write a regex that matches message content? → Use LLM
- [ ] Does this code only work in English? → Add DE/PT or use LLM
- [ ] Did I add a post-classify guard that overrides the LLM? → Fix the prompt
- [ ] Did I hardcode `role: 'sovereign'` or `forceLocal: true`? → Use the roster
- [ ] Does this commit add more lines than it removes? → Question the altitude
- [ ] Am I adding a code workaround for an LLM weakness? → Strengthen the LLM component
- [ ] Does this code need to change when we add a new language? → Use LLM

---

## Verification Gate (mechanical enforcement)

Every briefing that includes code changes MUST contain a "Verification Gate" section near the end, listing concrete commands or observations that prove the change works in production, not just in tests.

Before declaring a session complete, CC MUST:

1. Run each command listed in the briefing's Verification Gate.
2. Capture actual output — not assumed output.
3. Include `[VERIFIED: <summary>]` somewhere in the final assistant message.

The Stop hook at `.claude/hooks/verify-built.sh` enforces this mechanically. Stop is blocked if the `[VERIFIED:]` marker is absent. This is not optional. BUILT ≠ VERIFIED.

**Rationalization counters** (things the hook exists specifically to prevent):

- *"Tests pass, that's sufficient."* Green tests have masked runtime failures twice with WikiSteward. Run the production check.
- *"The change is too simple to verify."* Simple changes have runtime failures too. The hook is zero friction once the marker is written.
- *"I'll verify in the next session."* The next session starts without this session's context. Verify now or lose the window.
- *"The verification command isn't in the briefing."* Then stop and ask Fu what production-state check would confirm the change worked. Don't assume.

**For sessions with no code changes** (pure discussion, planning, reading), the marker is still required. Use: `[VERIFIED: no code changes in this session]`.

The hook does not distinguish. The Verification Gate rule distinguishes.

---

## Architecture Quick Reference

| Layer | Responsibility | Technology |
|-------|---------------|------------|
| Classification | Understand intent | LLM (Haiku cloud / qwen2.5:3b local) |
| Search term extraction | Extract keywords | LLM (qwen2.5:3b local) |
| Entity extraction | Find named entities | LLM (Haiku cloud / qwen3:8b local) |
| Synthesis | Generate responses | LLM (Haiku cloud / qwen3:8b local) |
| Content creation | Write documents | LLM (Opus cloud / qwen3:8b local) |
| Deep reflection | Opinion, analysis | LLM (Opus cloud) |
| Routing | Match job to model | Code (roster chain from trust boundary) |
| Storage | Read/write wiki, deck, files | Code (WebDAV, OCS, CalDAV) |
| Transport | HTTP, webhooks, email | Code (Node.js) |
| Security | Guards, audit, HITL | Code (ToolGuard, SecretsGuard, etc.) |
| Scheduling | Timers, heartbeat, cron | Code (HeartbeatManager) |

If your new code falls in the left column → it probably needs an LLM.
If it falls in the right column → code is correct.

---

## Naming

The project name is **Moltagent** (lowercase 'a'). Never "MoltAgent". This applies to code, comments, commits, docs, and user-facing strings.

---

*"The right architectural fix replaces five instance-level fixes. If you're adding more code to compensate for a weak AI component, strengthen the AI component instead."*
