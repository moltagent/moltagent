---
name: moltagent-dev-rules
description: Development rules for the Moltagent codebase, plus the production Verification Gate. Read this before writing or changing any code, and especially when the work touches natural-language handling, intent or document classification, entity or keyword extraction, LLM routing, prompt design, or the trust boundary, or when adding any feature however small. Covers the core principle that the LLM is the language layer and code is plumbing, generator-level debugging, fixing model output through the prompt rather than code guards, multilingual-by-default (DE/EN/PT), the single trust control, the pre-commit anti-pattern checklist, and the production verification every session must satisfy. Consult this even when the task looks like routine coding, because conventional programming instincts produce the wrong solution in this architecture.
---

# Moltagent Development Rules

Read this before writing or changing any code. These rules are non-negotiable.

This file exists because conventional programming instincts produce the wrong solution in this architecture. Moltagent is LLM-native: the model is the language layer, and code is the plumbing around it. One principle sits under everything below. When an AI component produces the wrong result, strengthen the component: a clearer prompt, better multilingual examples, a stronger model. Wrapping a weak component in code that compensates for it is the mistake these rules name in its various forms.

## The LLM is the language layer

Understanding language is the model's work. Manipulating strings is the code's work.

- Understanding (intent, classification, entity extraction, keywords, summaries, sentiment, language detection, resolving ambiguous references): the LLM.
- Manipulating (URL parsing, date math, path handling, JSON construction, string assembly): code.

The test: if a code path would have to change when you add a language, it belongs in the model.

The cost argument does not apply. A local model (qwen2.5:3b) classifies in roughly 100-200ms for free. A stop-word list saves that 100ms and creates permanent maintenance debt in every language you support. The model call is cheaper in total cost of ownership.

| Task | WRONG | RIGHT |
|------|-------|-------|
| Extract search keywords from a message | Stop-word list plus regex | LLM: "Extract 1-4 noun phrases" |
| Detect whether a message is a greeting | `if (GREETINGS.has(msg.toLowerCase()))` | Classifier returns gate: 'greeting' |
| Classify message intent | Keyword matching on action verbs | LLM classifier with multilingual examples |
| Parse entity names from text | Regex for capitalized word pairs | LLM entity extraction |
| Detect the language of a message | `if (msg.includes('Hallo'))` | LLM detects language naturally |
| Filter question words from search | `STOP_WORDS = new Set(['what','how','wie','como'])` | LLM extracts only noun phrases |

The granular map of which layer owns which job is in the Architecture Quick Reference below.

## Analysis and synthesis before code

When a bug or failure appears:

1. What class of problem is this? Not "this string didn't match" but "why is code parsing natural language at all?"
2. What generates the class? The stop-word list generates language-specific edge cases. What generated the stop-word list? The assumption that keyword extraction is a code task.
3. Fix the generator, not the instance. Don't add more stop words; replace the stop-word approach with a model call.

Two instances of the same pattern mean stop patching and find the generating function. If a commit adds more lines than it removes, question whether the fix is at the right altitude.

## Prompt updates, not code guards

When the model produces the wrong output, the fix is almost always upstream of the code:

1. Is the prompt clear?
2. Does it carry good multilingual examples?
3. Is the right model assigned to this job?
4. Only then: is there a structural issue the code should catch?

Most model-output problems are prompt problems. Clarify the prompt, add examples, route to a stronger model.

Post-classify guards are the canonical version of this mistake. When a classifier returns the wrong gate, fix the prompt or use a stronger model. A second classifier written in regex, or code that reads the model's output and overrides it, only moves the weakness somewhere harder to see.

The one acceptable post-classify guard is structural, not semantic. "The model returned an invalid gate name, fall back to default" is structural and fine. "The model said 'thinking' but the message contains 'what is', so force 'knowledge'" is semantic, and that is the prompt's job, not the code's.

## Multilingual by default

Every feature works in German, English, and Portuguese on day one. French and Spanish are a bonus. A feature that only works in English is a prototype, not a feature.

In practice:

- LLM prompts carry DE and PT examples, not English alone.
- Language stays out of the code paths; the model detects it implicitly.
- Dates and names come from `Intl.DateTimeFormat`, never hardcoded day or month names.
- Feedback messages key off the Cockpit language setting, not a detected language.

## Trust boundary is the single control

`trust: local-only` or `trust: cloud-ok` is the one setting that decides what touches the cloud. The user sets it, and every component inherits it through the roster chain. That is the only place the decision lives.

A per-component override (`role: 'sovereign'`, `forceLocal: true`, a module-level trust flag) is the failure mode, not a feature. The single exception is `JOBS.CREDENTIALS`: key material never leaves the box, regardless of the trust setting.

## The anti-pattern checklist

This is the checklist form of the rules above. Run it before every commit. Each item points back to the rule it enforces.

- [ ] A Set, Array, or Map of natural-language words? → The LLM is the language layer.
- [ ] A regex that matches message content? → The LLM is the language layer.
- [ ] Code that only works in English? → Multilingual by default.
- [ ] A post-classify guard that overrides the model? → Prompt updates, not code guards.
- [ ] A hardcoded `role: 'sovereign'` or `forceLocal: true`? → Trust boundary is the single control.
- [ ] A commit that adds more lines than it removes? → Analysis before code (the altitude check).
- [ ] Code that compensates for a weak model? → Strengthen the component instead.
- [ ] Code that has to change when you add a language? → The LLM is the language layer.

## Verification Gate

Every briefing with code changes carries a Verification Gate section near the end: the concrete commands or observations that prove the change works in production, not just in tests.

Before declaring a session complete:

1. Run each command in the briefing's Verification Gate.
2. Capture the actual output, not the assumed output.
3. Report what you confirmed in a `[VERIFIED: <summary>]` line in the final message.

The marker reports that evidence. The Stop hook (`.claude/hooks/verify-built.sh`) is a mechanical backstop: it can check that the marker is present, not that the verification happened. The hook does not distinguish a real check from an empty one. This rule does. BUILT ≠ VERIFIED.

Rationalization counters, the failures this gate exists to catch:

- "Tests pass, that's sufficient." Green tests have masked runtime failures in WikiSteward twice. Run the production check.
- "The change is too simple to fail." Simple changes have runtime failures too, and the check is near-zero friction once the marker is written.
- "I'll verify next session." The next session starts without this one's context. Verify now or lose the window.
- "The command isn't in the briefing." Then stop and ask which production-state check would confirm the change. Don't assume.

For a session with no code changes (discussion, planning, reading), the marker still closes the session and states that: `[VERIFIED: no code changes this session]`. The content is the truth of the session. That is the point: the marker reports what happened, it is not a password.

## Architecture Quick Reference

| Layer | Responsibility | Technology |
|-------|---------------|------------|
| Classification | Understand intent | LLM (Haiku cloud / qwen2.5:3b local) |
| Search term extraction | Extract keywords | LLM (qwen2.5:3b local) |
| Entity extraction | Find named entities | LLM (Haiku cloud / qwen3:8b local) |
| Synthesis | Generate responses | LLM (Haiku cloud / qwen3:8b local) |
| Content creation | Write documents | LLM (Opus cloud / qwen3:8b local) |
| Deep reflection | Opinion, analysis | LLM (Opus cloud) |
| Routing | Match job to model | Code (roster chain from the trust boundary) |
| Storage | Read/write wiki, deck, files | Code (WebDAV, OCS, CalDAV) |
| Transport | HTTP, webhooks, email | Code (Node.js) |
| Security | Guards, audit, HITL | Code (ToolGuard, SecretsGuard, etc.) |
| Scheduling | Timers, heartbeat, cron | Code (HeartbeatManager) |

The upper rows do understanding and belong to the model. The lower rows do transport, storage, routing, and enforcement, and belong to code. When new code lands in an understanding row, it probably needs the model.

## Naming

The project name is Moltagent, lowercase 'a', never "MoltAgent", in code, comments, commits, docs, and user-facing strings.
