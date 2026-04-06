# Moltagent Documentation

**Sovereign AI agent platform built on Nextcloud.**

Your AI employee. Your infrastructure. Your rules.

---

## Why This Exists

Every AI assistant we tried had the same problem: our data leaves our infrastructure, lives on someone else's servers, under someone else's jurisdiction. No audit trail, no kill switch, no real control.

Moltagent is an AI employee that lives in Nextcloud. It has its own account, files, calendar, task board, and email. You share what you want to share with it, exactly like onboarding a human colleague. And you can revoke all access with one click, exactly like offboarding one.

## Getting Started

- **[Quick Start](quickstart.md)** — Deploy on Hetzner in under an hour
- **[Architecture](architecture.md)** — Three-VM isolation model and software layers
- **[Security Model](security-model.md)** — Trust boundaries, credential brokering, and guardrails
- **[Configuration](configuration.md)** — Provider YAML, Cockpit, workflow labels, and environment
- **[LLM Providers](providers.md)** — 13 adapters, job-based routing, and cost control

## Key Features

- **Provider-agnostic** — 13 LLM adapters out of the box, from Ollama to Claude to DeepSeek
- **Credential brokering** — API keys fetched at moment of use, never stored on disk
- **Air-gapped local inference** — Sensitive operations stay on your Ollama VM
- **Workflow engine** — Kanban-driven automation with human-in-the-loop gates
- **Living memory** — Knowledge graph, vector search, and biological decay model
- **Budget enforcement** — Daily limits with automatic fallback to local models

## License

Moltagent is licensed under [AGPL-3.0](https://github.com/moltagent/moltagent/blob/main/LICENSE). Sovereign infrastructure should be open source.
