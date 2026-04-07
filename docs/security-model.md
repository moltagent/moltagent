# Security Model

Moltagent treats security as a structural property, not a feature layer. The architecture is designed so that security failures degrade gracefully rather than catastrophically.

## Core Principles

1. **Zero Trust** - never trust any input, credential, or external system by default
2. **Least Privilege** - grant minimum necessary access, expand only when proven necessary
3. **Defense in Depth** - multiple independent security layers, no single point of failure
4. **Fail Secure** - when in doubt, deny access and alert
5. **Audit Everything** - every security-relevant action must be logged and traceable

## Trust Boundaries

Every piece of data the agent processes is classified:

```
TRUSTED INPUT                      UNTRUSTED INPUT
-----------------                  -----------------
  System prompts                     User-uploaded files
  Hardcoded instructions             Email content
  Admin configuration                Web page content
  Authenticated NC Talk              Calendar descriptions
    from user allowlist              RSS feed content
  Cockpit card content               Any external data
```

The trust classification determines how data is handled:
- Trusted input can trigger tool calls and actions directly
- Untrusted input is sanitized before reaching the LLM and cannot trigger sensitive operations without human approval

## Credential Brokering

This is the core security innovation. Credentials are never stored on the Bot VM. They exist in memory only during use.

### How it works

1. The agent determines which credential it needs for an operation
2. It fetches the credential from the Nextcloud Passwords API (this access is logged automatically by Nextcloud)
3. It verifies the credential was explicitly shared with the `moltagent` user (rejects if not shared)
4. It uses the credential for a single operation
5. It immediately discards the credential from memory
6. It logs the operation completion

### The bootstrap credential

The agent needs one credential to access Nextcloud: its own account password. This is loaded via systemd's `LoadCredential=` directive, which reads from a protected credential store on disk. It is never stored in environment variables, .env files, or config files.

```ini
# /etc/systemd/system/moltagent.service
[Service]
LoadCredential=nc-password:/etc/credstore/moltagent-nc-password
```

### Credential organization in Nextcloud Passwords

Credentials in NC Passwords are accessed by name. The folder structure below is a recommended organizational convention — the agent performs flat name-based lookups, so folders are optional:

```
NC Passwords/
  Moltagent Core/              Shared with moltagent user
    nc-files-token
    nc-calendar-token
    nc-contacts-token
  Moltagent Communication/     Shared with moltagent user
    email-imap
    email-smtp
    talk-bot-secret
  Moltagent LLM/               Shared with moltagent user
    claude-api-key
    deepseek-api-key
    ollama-url
  Moltagent Integrations/      Shared selectively
    project-specific-apis
  RESTRICTED/                  NEVER shared with moltagent
    banking-credentials
    admin-passwords
    hr-systems
```

You control exactly what the agent can access by sharing or unsharing entries in NC Passwords. No code changes required.

### Revocation

**Full revocation (under 60 seconds):**
1. Disable the `moltagent` user in Nextcloud Admin
2. All API access stops immediately
3. Stop the systemd service

**Selective revocation:**
- Unshare a single credential in NC Passwords
- The agent loses access to that specific service on the next operation attempt

## Guardrail Enforcer

All inputs and outputs pass through five runtime security guards. Total overhead: under 0.05ms per check.

| Guard | What it checks |
|-------|---------------|
| **ToolGuard** | Validates tool calls against allowed operations |
| **SecretsGuard** | Prevents credential leakage in LLM outputs |
| **PromptGuard** | Four-layer prompt injection detection (heuristic, statistical, ML classifier, LLM-as-judge) |
| **PathGuard** | Prevents path traversal and unauthorized file access |
| **EgressGuard** | Blocks unauthorized outbound data transmission |

The guards run on every request, not just on untrusted input. Defense in depth means the security layer doesn't trust the classification layer.

## Prompt Injection Defense

The PromptGuard uses four layers of detection:

| Layer | Method | Latency |
|-------|--------|---------|
| Layer 1: Heuristic | Pattern matching (~80 patterns across attack categories) | < 0.001ms |
| Layer 2: Statistical | Content structure analysis (entropy, instruction density) | < 0.01ms |
| Layer 3: ML Classifier | Local Ollama classification | ~1-5ms |
| Layer 4: LLM-as-Judge | Cloud LLM analysis for ambiguous cases | ~500ms |

Layers 3 and 4 are only invoked when layers 1 and 2 produce ambiguous scores. Most requests are resolved in under 0.01ms.

Decision thresholds:
- Score >= 0.5: **BLOCK** (reject the input)
- Score >= 0.3: **REVIEW** (log and alert, still process with caution)
- Score < 0.3: **ALLOW**

## LLM Trust Routing

The LLM routing system enforces a hard rule: **credential operations always stay local**, regardless of which preset the user has chosen.

When the agent needs to process something involving secrets (API keys, passwords, tokens), it routes exclusively to the air-gapped Ollama VM. This means credential-sensitive reasoning never touches a cloud API, and the data never leaves your infrastructure.

For all other operations, the user's chosen preset (all-local, smart-mix, cloud-first) determines routing. See [LLM Providers](providers.md) for details.

## Budget Enforcement

The BudgetEnforcer tracks LLM costs in real time:

- Per-model daily spending limits configurable via the Cockpit
- Automatic fallback to local Ollama when daily budget is exhausted
- Cost notifications posted to NC Talk
- Full cost transparency: the user always knows what they're spending

Budget exhaustion is a graceful degradation, not a failure. The agent continues working on local models until the next budget cycle.

## Audit Logging

Every security-relevant operation is logged in append-only JSONL format to the Nextcloud file system. Nextcloud's built-in versioning provides a basic tamper-detection mechanism (previous versions are preserved).

Logged events include:
- Credential access (which credential, which operation, when)
- Tool calls (which tool, which parameters, result)
- Trust boundary decisions (what was classified as trusted/untrusted)
- Guardrail triggers (which guard fired, on what input)
- Budget events (spend tracking, fallback triggers)
- Human-in-the-loop decisions (what was approved/rejected)

## Threat Model

| Threat | Vector | Mitigation |
|--------|--------|------------|
| Bootstrap key theft | VM compromise | systemd LoadCredential=, not env vars |
| Prompt injection | Malicious file/email content | Four-layer PromptGuard + trust boundaries |
| Memory poisoning | Write to wiki | Memory integrity checks |
| NC Passwords vulnerability | App zero-day | Update policy, monitoring, VM isolation |
| Talk session hijack | NC account compromise | 2FA, user allowlist, rate limiting |
| LLM provider breach | External API compromise | Local Ollama for sensitive ops |
| Credential exfiltration via LLM output | Malicious model response | SecretsGuard + EgressGuard + network allowlist |
| Data exfiltration via tool calls | Compromised tool definition | ToolGuard + Skill Forge validation |

## Human-in-the-Loop

Certain operations require explicit human approval before execution:

- Sending emails
- Deleting files
- External API calls (configurable)
- Calendar modifications (configurable)

The agent requests approval via NC Talk, waits for the human response, and only proceeds on explicit confirmation. Approval timeout is configurable (default: 5 minutes). If no approval is received, the operation is cancelled and logged.

In the workflow engine, GATE labels serve as human checkpoints. The agent stops processing at GATE cards and notifies the assigned human. Processing resumes only after the human approves or rejects.
