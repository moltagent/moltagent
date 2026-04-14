# CLAUDE.md — Moltagent

## Project

Moltagent (lowercase 'a', never "MoltAgent") is a sovereign AI agent platform built on Nextcloud. Node.js codebase, AGPL-3.0. Entry point: `webhook-server.js`. ~35 modules, ~27,000 lines.

## Architecture in One Sentence

The LLM handles understanding. Code handles plumbing. When in doubt, it's understanding → use the LLM.

## Commands

```bash
# Run
sudo systemctl start moltagent

# Logs
journalctl -u moltagent -f --no-pager

# Test
npm test

# Lint
npm run lint

# Service status
sudo systemctl status moltagent
```

## Git Workflow

- Work on `next` branch. Never commit directly to `main`.
- PRs: `next → main`.
- SSH commit signing with `~/.ssh/id_ed25519_signing`.
- Co-authored-by: `moltagent <github@moltagent.cloud>`.
- Commit messages: imperative, descriptive. Not "fix stuff" — describe what changed and why.

## The Three Non-Negotiable Rules

**1. LLM is the language layer.** Never write Sets, Arrays, or Maps of natural language words. No stop word lists. No keyword matching on user input. No regex on natural language. If the code would need to change when adding a new language → use the LLM instead. qwen2.5:3b runs locally in 100ms for free.

**2. Fix the prompt, not the code around it.** When the LLM produces wrong output: fix the prompt, add multilingual examples, use a better model. Do NOT add post-classify guards that override the LLM in code. The only acceptable post-classify guard is structural validation (invalid gate name → fallback to default).

**3. Multilingual from day one.** Every feature must work in German, English, and Portuguese. All LLM prompts include DE + PT examples. No language-specific code paths. No hardcoded day/month names.

## Before Every Commit

Ask yourself:
- Did I create a Set/Array of natural language words? → Use LLM
- Does this only work in English? → Add DE/PT or use LLM
- Does this commit add more lines than it removes? → Question the altitude
- Am I compensating for an LLM weakness with code? → Strengthen the LLM

## Key Architecture

- **Trust boundary:** `trust: local-only` or `trust: cloud-ok` — one setting, respected everywhere. Never hardcode `role: 'sovereign'` or `forceLocal: true`.
- **Four-gate classifier:** KNOWLEDGE (default), ACTION, COMPOUND, THINKING. Knowledge is the default. Thinking is the rare exception.
- **Model routing:** Jobs & Players v3. Each job has a roster chain per trust level. Synthesis: Haiku → qwen3:8b. Thinking: Opus. Credentials: always local.
- **Wiki:** Collectives-based. Fractal index (Level 0 landing page → Level 1 section parents → Level 2 entity pages). Three stewards maintain it (knowledge, connection, memory).

## Read the Dev Rules

Before ANY coding session, read `.moltagent-dev-rules.md` at the repo root. It contains the full anti-pattern checklist and architecture reference table. This file is the condensed version. The dev rules file has the detailed examples and the "plumbing vs intelligence" decision table.

## Compaction Instructions

When compacting, always preserve:
- The full list of modified files
- Current test status (passing/failing)
- Any uncommitted changes
- Active task description and acceptance criteria
- The three non-negotiable rules above
