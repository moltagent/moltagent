TAO.md is why these rules are shaped this way. Read it first.

# Moltagent: Claude Code Context

**Project:** Moltagent, a sovereign AI agent platform on Nextcloud.  
**Language:** Node.js (>= 18), JavaScript. Multilingual by default: DE / EN / PT.  
**License:** AGPL-3.0.

## Repo layout

- `src/`: product code
- `test/`: unit and integration tests
- `scripts/`: ops and setup
- `config/`: runtime configuration, including `SOUL.md` and `system-prompt.md` (the agent's behavioral layer)
- `ansible/`, `deploy/`: infrastructure
- `webhook-server.js`: entry point (large; a split is overdue, out of scope for most sessions)

## Commands

- `npm run lint`: ESLint (`--fix` to auto-correct)
- `npm test`: all tests
- `npm run test:unit` | `test:integration` | `test:llm` | `test:deck`: narrower scopes
- `npm run setup`: Deck board setup (one-off)

After every substantial edit, run `npm run lint`. Before declaring a task done, run the appropriate test scope. Before declaring a session done, run the Verification Gate (in the dev-rules skill).

## Git workflow

- All work lands on feature branches off `next`.
- PRs merge into `next`. `next` periodically promotes to `main`.
- Commit email: `github@moltagent.cloud`
- Signing key: SSH, `~/.ssh/id_ed25519_signing`
- Co-authored-by: `moltagent <github@moltagent.cloud>`

## Two behavioral layers: know which one you're editing

Two instruction sets live in this repo and get confused. Pick the right one before editing.

- **`CLAUDE.md`** (this file): how to work on the codebase. Commands, rules, workflow. For Claude Code, the dev tool.
- **`config/SOUL.md`** and **`config/system-prompt.md`**: how the agent behaves toward users. Tone, knowledge gaps, tool reporting, memory. For the product.

A reported behavior bug (hallucinated roles, overconfidence under sparse data) almost always belongs in SOUL.md, not code. The agent is LLM-based, so you fix its prompt before reaching for a code guard. This is the Prompt-Updates rule. Read SOUL.md first; the answer is usually already there or belongs there.

## Architectural Principles

1. **FIRST SYNTHESIS THEN ANALYSIS BEFORE CODE.** Every failure must be analyzed at the systemic level AND synthesized across related failures before any fix is written. Ask: what class of problem is this? What generates it? Can the generator be fixed? Instance-level fixes are only acceptable after the class-level analysis confirms they're the right altitude.

2. **NO REGEX FOR INTELLIGENCE.** Code handles plumbing. AI handles understanding. When code starts compensating for AI weakness (English-only guards, keyword matching, pattern detection on natural language), the AI component needs strengthening, not more code around it.

3. **ZOOM IN AND OUT.** 50% analysis, 50% synthesis. Neither reductionist nor holistic alone. The relationship between problems reveals architecture. Two instances of the same pattern = stop patching, find the generating function.

4. **LESS CODE, NOT MORE.** The right architectural fix replaces five instance-level fixes. If a commit adds more lines than it removes, question whether the altitude is right.

5. **MULTILINGUAL BY DEFAULT.** Every feature must work in German and Portuguese on day one. If it only works in English, it's not a feature, it's a prototype. The LLM is the language layer, not the code.

6. **Trust boundary is the single control.** `trust: local-only` or `cloud-ok` decides every cloud-touching call, and the router is the only place that decision is made. A per-component override that *loosens* trust toward cloud (`role: 'sovereign'`, a flag routing to cloud outside the roster) is the failure mode, not a feature. Trust-*tightening* overrides (`forceLocal: true`, pinning to local for sensitive data) are legitimate: they can only narrow the boundary, never widen it. `JOBS.CREDENTIALS` is exempt either way: key material never leaves the box.

7. **BUILT ≠ VERIFIED.** A feature is complete only after its behavior is confirmed in production. Green tests are necessary, not sufficient. Close each session with a marker stating what you confirmed and how. See the Verification Gate in the dev-rules skill.

8. **Guards belong where the pipe narrows.** Enforce once, at the chokepoint where all paths converge, not scattered down the call stack. The same guard at three call sites is a guard in the wrong place.

The full rule set is the auto-loaded skill at `.claude/skills/moltagent-dev-rules/SKILL.md`: examples, counterexamples, the architecture table, the Verification Gate, and the pre-commit anti-pattern checklist. It loads whenever you touch code for natural language, classification, intent detection, LLM routing, or trust boundaries, and when adding features. It is the single source of truth for these rules; `moltagent-dev-rules.md` at the repo root is only a pointer to it. When the skill loads, read it. It is authoritative.

## Operating discipline

- **Read before writing.** Paths, names, and API shapes come from the codebase, not memory. Search first.
- **Run the pre-commit checklist** (the Anti-Pattern Checklist in the dev-rules skill) before any commit.
- **Run the Verification Gate** (in the dev-rules skill) before declaring a session done.
- **Run the privacy pass** (see `.claude/skills/public-content-discipline/SKILL.md`) before drafting any content bound for a public surface: GitHub issues, PRs, README, docs, external communications, **and commit messages** (they are public on `next`/`main`). Abstract named individuals, client organizations, internal codenames, and knowledge-base quotes before they enter a public draft, not after. In `[VERIFIED]` blocks, name hosts as placeholders (`[OLLAMA_HOST]`, `[NC_HOST]`) — never literal IPs or hostnames; a production IP in a public commit message is a leak (commit `23a5496` carries one).
- **File issues for anything outside the current briefing.** Scope is the briefing.

## Architecture partnership

Claude (claude.ai) operates as the architectural and strategic layer above CC. CC implements from structured briefings (typically 15-25 KB). Claude synthesizes, diagnoses, and plans at the generator level; CC executes at the instance level with skills loaded for domain grounding. One altitude per session.
