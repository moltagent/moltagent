# Moltagent — Claude Code Context

**Project:** Moltagent — sovereign AI agent platform on Nextcloud.  
**Language:** Node.js (>= 18), JavaScript. Multilingual by default: DE / EN / PT.  
**License:** AGPL-3.0.

## Repo layout

- `src/` — product code
- `test/` — unit and integration tests
- `scripts/` — ops and setup
- `config/` — runtime configuration, including `SOUL.md` and `system-prompt.md` (the agent's behavioral layer)
- `ansible/`, `deploy/` — infrastructure
- `webhook-server.js` — entry point (large; a split is overdue, out of scope for most sessions)

## Commands

- `npm run lint` — ESLint (`--fix` to auto-correct)
- `npm test` — all tests
- `npm run test:unit` | `test:integration` | `test:llm` | `test:deck` — narrower scopes
- `npm run setup` — Deck board setup (one-off)

After every substantial edit, run `npm run lint`. Before declaring a task done, run the appropriate test scope. Before declaring a session done, produce a `[VERIFIED: ...]` marker per the Verification Gate (see moltagent-dev-rules.md).

## Git workflow

- All work lands on feature branches off `next`.
- PRs merge into `next`. `next` periodically promotes to `main`.
- Commit email: `github@moltagent.cloud`
- Signing key: SSH, `~/.ssh/id_ed25519_signing`
- Co-authored-by: `moltagent <github@moltagent.cloud>`

## The two behavioral layers — know which one applies

This repo contains two parallel behavioral-instruction documents. They serve different systems and are often confused. Choose correctly before editing.

1. **This file (`CLAUDE.md`)** — instructions for Claude Code (the developer tool). How to work on the codebase: commands, rules, conventions, workflow.
2. **`config/SOUL.md`** and **`config/system-prompt.md`** — instructions for the *Moltagent agent itself* (the product). How the agent responds to users, how it handles knowledge gaps, how it reports tool results, how it integrates memory.

When the user reports that the agent is behaving incorrectly — hallucinating roles, overconfident under sparse data, misusing tools, wrong tone — the fix almost always belongs in SOUL.md, not in code. This is Rule 7 (Prompt Updates, Not Code Guards) applied to the agent's own behavior: when an LLM-based system produces wrong output, fix the prompt before reaching for a code guard. Read SOUL.md first when a behavior bug is reported. Most of the time the answer is already there or belongs there.

## Non-negotiable rules (short form — full rules auto-load via skill)

1. **The LLM is the language layer.** Never write code containing word lists, stop words, or regex matching natural language. If code would need to change when we add a new language, it's wrong.
2. **Analysis before fix.** What class of problem is this? What generates it? Fix the generator, not the instance. Two instances of the same pattern = stop patching.
3. **Trust boundary is the single control.** `trust: local-only` vs `cloud-ok` governs every cloud-touching decision. No per-component overrides.
4. **BUILT ≠ VERIFIED.** Features are only complete after confirmed production behavior. Green tests are necessary but not sufficient. The Stop hook enforces this — every session must end with a `[VERIFIED: ...]` marker. See moltagent-dev-rules.md § Verification Gate.
5. **PAUSED always wins.** State-enforcing labels override scheduled actions. Guards belong where the pipe narrows.

The full rule set — with examples, counterexamples, the architecture table, the Verification Gate convention, and the pre-commit anti-pattern checklist — is at `moltagent-dev-rules.md`. The same content is exposed as a skill at `.claude/skills/moltagent-dev-rules/SKILL.md` and auto-loads whenever you touch code that handles natural language, classification, intent detection, LLM routing, trust boundaries, or when adding new features. When the skill loads, read it. It is authoritative.

## Operating discipline

- **Search the codebase before assuming structure.** Never guess file paths, function names, or API shapes. Read before writing.
- **Run the pre-commit checklist** (Rule 8 in the dev-rules skill) before any commit.
- **Run the Verification Gate** (section in moltagent-dev-rules.md) before declaring a session done. The Stop hook will block you if you forget the marker.
- **Use GitHub issues** for anything not in scope for the current briefing. Don't silently expand scope.
- **Zoom out before patching.** Two instances of the same pattern = find the generator.
- **Small commits over large ones.** If a commit adds more lines than it removes, question whether the altitude is right.

## Architecture partnership

Claude (claude.ai, Opus 4.7) operates as the architectural and strategic reasoning layer above CC. CC implements from structured briefings (typically 15–25 KB). Claude synthesizes, diagnoses, and plans at the generator level; CC executes at the instance level with skills loaded for domain grounding. This is the division of labor. Don't try to do both at once in one session.
