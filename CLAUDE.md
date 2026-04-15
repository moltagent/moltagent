# CLAUDE.md — Moltagent

# CRITICAL — Read These First
- No regex for intelligence. LLM is the language layer.
- Run production verification before marking complete.
- Push to `next` branch only. Never `main`.

## Project

Moltagent (lowercase 'a', never "MoltAgent") is a sovereign AI agent platform built on Nextcloud. Node.js codebase, AGPL-3.0. Entry point: `webhook-server.js`. ~35 modules, ~27,000 lines.

## Architecture in One Sentence

The LLM handles understanding. Code handles plumbing. When in doubt, it's understanding → use the LLM.

## Commands

    sudo systemctl start moltagent
    journalctl -u moltagent -f --no-pager
    npm test
    npm run lint
    sudo systemctl status moltagent

## Git Workflow

- Work on `next`. PRs: `next → main`. (Pushes to `main` blocked by deny list.)
- SSH commit signing with `~/.ssh/id_ed25519_signing`.
- Co-authored-by: `moltagent <github@moltagent.cloud>`.
- Commit messages: imperative, descriptive — describe what changed and why.

## The Three Non-Negotiable Rules

**1. LLM is the language layer.** Never write Sets, Arrays, or Maps of natural language words. No stop word lists. No keyword matching on user input. No regex on natural language. If the code would need to change when adding a new language → use the LLM instead. qwen2.5:3b runs locally in 100ms for free.

**2. Fix the prompt, not the code around it.** When the LLM produces wrong output: fix the prompt, add multilingual examples, use a better model. Do NOT add post-classify guards that override the LLM in code. The only acceptable post-classify guard is structural validation (invalid gate name → fallback to default).

**3. Multilingual from day one.** Every feature must work in German, English, and Portuguese. All LLM prompts include DE + PT examples. No language-specific code paths. No hardcoded day/month names.

## Before Every Commit

- Did I create a Set/Array of natural language words? → Use LLM
- Does this only work in English? → Add DE/PT or use LLM
- Does this commit add more lines than it removes? → Question the altitude
- Am I compensating for an LLM weakness with code? → Strengthen the LLM

## Key Architecture

- **Trust boundary:** `trust: local-only` or `trust: cloud-ok` — one setting, respected everywhere. Never hardcode `role: 'sovereign'` or `forceLocal: true`.
- **Four-gate classifier:** KNOWLEDGE (default), ACTION, COMPOUND, THINKING. Knowledge is default. Thinking is the rare exception.
- **Model routing:** Jobs & Players v3. Each job has a roster chain per trust level. Synthesis: Haiku → qwen3:8b. Thinking: Opus. Credentials: always local.

## Compaction

When compacting, always preserve:
- The current briefing objectives
- All file paths modified in this session
- Board/config facts (board IDs, stack names, config paths)
- Any "generating function" or systemic analysis from this session

## Dev Rules

Read `.moltagent-dev-rules.md` at repo root before coding. Full anti-pattern checklist and decision tables. This file is the condensed version.

# CRITICAL — Read These Last
- No regex for intelligence. LLM is the language layer.
- Run production verification before marking complete.
- Push to `next` branch only. Never `main`.
