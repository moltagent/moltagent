# Architecture

Moltagent separates concerns across three network-isolated components. Compromise of one does not automatically compromise the others.

## Infrastructure: Three-VM Isolation

```
┌────────────────────────────────────────────────────────────────────────┐
│                         YOUR INFRASTRUCTURE                            │
│                                                                        │
│  ┌──────────────────┐   ┌──────────────────┐   ┌──────────────────┐   │
│  │   NEXTCLOUD       │   │   MOLTAGENT VM   │   │   OLLAMA VM      │   │
│  │   (Storage Share) │   │   (Bot)          │   │   (Local LLM)    │   │
│  │                   │   │                  │   │                  │   │
│  │  • Identity       │   │  • Agent runtime │   │  • Air-gapped    │   │
│  │  • Files (WebDAV) │   │  • No secrets    │   │  • Handles       │   │
│  │  • Passwords      │   │    stored        │   │    credential-   │   │
│  │  • Calendar       │   │  • Guardrails    │   │    sensitive     │   │
│  │  • Wiki           │   │  • Budget        │   │    operations    │   │
│  │  • Deck (kanban)  │   │    enforcement   │   │  • Embeddings    │   │
│  │  • Talk (chat)    │   │                  │   │                  │   │
│  │  • Audit logs     │   │                  │   │                  │   │
│  └────────┬──────────┘   └────────┬─────────┘   └────────┬─────────┘   │
│           │                      │                      │             │
│           │◄─────────────────────┤◄─────────────────────┤             │
│           │    HTTPS only        │   Port 11434 only    │             │
│           │                      │                      │             │
│           │                      ├──────────────────────►  WAN        │
│           │                      │  Cloud LLM APIs only │             │
│           │                      │  (allowlisted)       │             │
│           │                      │                      │             │
│           │                      │         ✗ BLOCKED    │             │
│           │                      │                      │             │
└───────────┴──────────────────────┴──────────────────────┴─────────────┘
```

### Nextcloud (Storage Share)

The agent's home. A managed Nextcloud instance on Hetzner Storage Share provides identity, file storage, and all business applications. EU data jurisdiction.

Nextcloud apps used:
- **Passwords** - credential broker (API keys fetched at runtime, never stored on the Bot VM)
- **Deck** - kanban boards for workflow engine and agent configuration (Cockpit)
- **Collectives** - wiki for Living Memory / knowledge system
- **Talk** - chat interface and webhook pipeline
- **Calendar** - CalDAV integration for smart meetings
- **Files** - WebDAV file operations, document ingestion, audit logs

### Moltagent VM (Bot)

The agent runtime. A lightweight VM (CPX22) that runs the Node.js application as a systemd service. This VM holds no secrets. All credentials are fetched from Nextcloud Passwords at the moment of use and immediately discarded.

### Ollama VM (Local LLM)

Local inference server. This VM has **no internet access** (air-gapped). It handles:
- Credential-sensitive operations (secrets never leave your infrastructure)
- Embeddings via nomic-embed-text
- Fast classification via phi4-mini or qwen2.5:3b
- Full local-only mode when cloud providers are unavailable or budget is exhausted

## Software Architecture

The agent is organized in six layers:

### Interface Layer

How messages enter and leave the system.

- **NC Talk** - webhook pipeline for chat messages. The primary human-agent interface
- **Speaches** - speech-to-text via Whisper, text-to-speech for voice messages
- **WebDAV** - file operations and workspace access
- **Cockpit** - Deck-based control plane where the human configures the agent's behavior (personality, guardrails, modes, models)

### Agent Core

The central nervous system.

- **AgentLoop** - receives all messages, routes intent, dispatches tool calls
- **Heartbeat** - periodic task orchestrator. Runs knowledge freshness checks, embedding updates, daily briefings, and workflow engine cycles
- **Four-Gate Classifier** - intent classification with compound intent detection
- **LLM Router** - routes LLM calls to the right provider based on job type, with circuit breakers and fallback chains
- **Clarifier** - manages pending clarification state across conversation turns

### Security Layer

All inputs and outputs pass through the security layer.

- **GuardrailEnforcer** - five runtime guards (ToolGuard, SecretsGuard, PromptGuard, PathGuard, EgressGuard). Under 0.05ms overhead per check
- **BudgetEnforcer** - real-time LLM cost tracking with daily limits and automatic fallback to local when budget is exhausted

### Services Layer

Integrations with Nextcloud and external systems.

- **Skill Forge** - YAML-based tool templates with HttpToolExecutor for API integrations
- **DeckClient** - kanban API layer for Deck boards
- **Collectives** - wiki API layer for knowledge pages
- **CalDAV** - calendar and scheduling
- **SearXNG** - sovereign search (SearXNG + Stract + Mojeek federation)
- **DocIngestor** - document classification, text extraction, wiki routing
- **WorkflowEngine** - process automation driven by kanban boards

### Memory Layer

How the agent learns and remembers.

- **KnowledgeGraph** - entity-relationship storage backed by the wiki
- **VectorStore** - SQLite cosine similarity embeddings
- **NC Keyword Search** - Nextcloud Unified Search as a keyword channel
- **Three-Channel Fusion** - combines keyword, vector, and graph search with competitive suppression (winners suppress related losers)
- **DailyBriefing / DailyDigest** - episodic daily summaries with job-based routing
- **CoAccessGraph** - decay-weighted co-access tracking
- **ProactiveEvaluator** - post-response knowledge gap evaluation

### Infrastructure Layer

The physical and virtual resources.

- **Moltagent VM** - Hetzner Cloud, EU
- **Ollama VM** - Hetzner Cloud, EU, local inference
- **NC Storage** - Hetzner Storage Share, EU jurisdiction

## Network Segmentation

Firewall rules restrict each component to only the connections it needs.

**Moltagent VM outbound:**
- Nextcloud: HTTPS (port 443) only
- Ollama VM: port 11434 only
- Cloud LLM APIs: allowlisted domains only (api.anthropic.com, api.openai.com, api.deepseek.com, etc.)
- Everything else: blocked

**Ollama VM outbound:**
- Nothing. No internet access. Default deny.

**Nextcloud:**
- Standard HTTPS for Talk webhooks, email, updates

## Encryption

| Layer | Implementation | Notes |
|-------|----------------|-------|
| Disk (all VMs) | LUKS full-disk encryption | Key in Hetzner Robot, not on VM |
| NC Server-Side | Server-side encryption with per-file keys | Enabled for Passwords app data |
| Transport | TLS 1.3 | No exceptions, including internal traffic |
| NC Passwords | AES + optional master password | Client-side encryption available |

**Do not use** Nextcloud End-to-End Encryption for folders the agent needs to access. E2E breaks the agent workflow.

## Credential Flow

Credentials are never stored on the Bot VM. The flow for every operation:

1. Agent determines which credential it needs
2. Fetches credential from NC Passwords API (access logged automatically)
3. Verifies credential was explicitly shared with the `moltagent` user
4. Uses credential for a single operation
5. Immediately discards from memory
6. Logs operation completion

The agent's bootstrap credential (Nextcloud password) is loaded via systemd's `LoadCredential=` directive, not environment variables or config files.

## Recommended Specifications

| Component | Spec | Monthly Cost |
|-----------|------|-------------|
| Nextcloud | Hetzner Storage Share BX11 (100GB) | ~5 Euro |
| Moltagent VM | CPX22 (3 vCPU, 4GB RAM) | ~8 Euro |
| Ollama VM | CPX31 (8 vCPU, 16GB RAM) | ~15 Euro |
| **Total** | | **~28 Euro/month** |

These are minimum specs. The Ollama VM benefits from more RAM for larger local models. For serious business use, a dedicated GPU server improves local inference quality.

## Live Architecture View

The architecture graph is visible at [public.moltagent.cloud](https://public.moltagent.cloud) (Architecture tab), updated live from the production VM. Every component shows its verification status and line count.
