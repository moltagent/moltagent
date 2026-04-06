# Configuration

Moltagent uses YAML-based configuration files. This page documents all available options.

## Configuration Files

| File | Purpose |
|------|---------|
| `config/moltagent-providers.yaml` | LLM provider definitions, role assignments, fallback chains, search config |
| `config/deck.example.yaml` | Template for Deck board configuration (copy and customize) |
| `config/SOUL.md` | Agent personality and behavioral instructions |
| `config/system-prompt.md` | System prompt template |

## Provider Configuration

```yaml
# config/moltagent-providers.yaml

# Provider definitions
providers:
  ollama-local:
    adapter: ollama
    endpoint: http://<OLLAMA_VM_IP>:11434
    model: qwen3:8b

  anthropic-claude:
    adapter: anthropic
    credentialName: claude-api-key    # Name in NC Passwords
    model: claude-opus-4-6
    costModel:
      type: per_token
      inputPer1M: 15.00
      outputPer1M: 75.00

  claude-sonnet:
    adapter: anthropic
    credentialName: claude-api-key
    model: claude-sonnet-4-5-20250929
    costModel:
      type: per_token
      inputPer1M: 3.00
      outputPer1M: 15.00

  claude-haiku:
    adapter: anthropic
    credentialName: claude-api-key
    model: claude-haiku-4-5-20251001
    costModel:
      type: per_token
      inputPer1M: 0.80
      outputPer1M: 4.00

# Role assignments (providers tried in order listed)
roles:
  sovereign: [ollama-local]           # Always local
  free: [ollama-local]                # Zero-cost operations
  value: [claude-sonnet, ollama-local] # Cost-effective cloud
  premium: [anthropic-claude, claude-sonnet, ollama-local]  # Best quality

# Fallback chains
fallbackChain:
  ollama-local: []
  anthropic-claude: [claude-sonnet, ollama-local]
  claude-sonnet: [ollama-local]
  claude-haiku: [ollama-local]

# Search provider configuration
search:
  default_provider: searxng
  searxng:
    url: http://localhost:8080
    engines_default: [duckduckgo, brave, stract, mojeek, wikipedia, stackoverflow]
    timeout_ms: 5000
```

## Cockpit Configuration (Deck)

The Cockpit is a Deck board that controls agent behavior at runtime. It is read by the agent on each heartbeat cycle. Configuration changes take effect on the next heartbeat (typically within seconds).

The Cockpit board contains these stacks:

| Stack | Purpose |
|-------|---------|
| Styles | Communication style cards (tone, formality, humor) |
| Persona | Agent identity and behavioral profile |
| Guardrails | Hard behavioral constraints written in natural language |
| Modes | Contextual behavior profiles (Full Auto, Focus, Out of Office, etc.) |
| System | System settings, LLM preset selection, routing overrides |
| Status | Agent health, recent actions, error reports |

### Guardrail cards

Write guardrails as plain sentences on cards in the Guardrails stack:

```
"Never delete files without asking"
"Always CC me on external emails"
"Max 50 Euro/month on LLM costs"
"Working hours only: 08:00-18:00 CET"
"Never send emails without approval"
```

The agent reads these on heartbeat and treats them as hard constraints.

### Mode cards

Label the active mode card with ⚙️★. The agent reads this label on heartbeat and adapts its behavior accordingly:

- **Full Auto** - maximum initiative, proactive suggestions
- **Focus Mode** - no proactive messages, respond only when spoken to
- **Out of Office** - handle routine items, escalate urgent only

## Workflow Board Configuration

Workflow boards use a special CONFIG card (first card in the first stack) to define processing rules.

The CONFIG card description contains the workflow rules in natural language. The agent reads these rules and applies them to all cards on the board.

### Label semantics

| Label | Meaning |
|-------|---------|
| GATE | Human checkpoint. Agent stops and notifies assigned person |
| APPROVED | Human has approved a GATE card |
| REJECTED | Human has rejected a GATE card |
| PAUSED | Indefinite suspension (human-only, agent never modifies) |
| SCHEDULED | Timed future activation (requires due date) |
| ERROR | Processing failed, retry with backoff |

Priority chain: PAUSED > SCHEDULED > ERROR > GATE > normal processing.

## Environment Variables

Moltagent uses environment variables set in the systemd service file. The primary configuration is file-based (YAML), but key deployment values are set via environment:

| Variable | Purpose | Required |
|----------|---------|----------|
| `NC_URL` | Nextcloud base URL | Yes |
| `NC_USER` | Nextcloud username | Yes |
| `OLLAMA_URL` | Ollama API endpoint | Yes |
| `OLLAMA_MODEL` | Default Ollama model (default: `qwen3:8b` in service template) | No |
| `DECK_BOARD_ID` | Default Deck board ID | Yes |
| `HEARTBEAT_INTERVAL` | Heartbeat cycle interval in ms (default: `300000`) | No |
| `INITIATIVE_LEVEL` | Proactive behavior level 0-3 (default: `2`) | No |
| `SEARXNG_URL` | SearXNG search endpoint | No |
| `KNOWLEDGE_ADMIN_USER` | NC username of the admin/owner | Yes |
| `ADMIN_USER` | Admin user for approval workflows | Yes |
| `CREDENTIALS_DIRECTORY` | Set automatically by systemd `LoadCredential` | Automatic |
| `NODE_ENV` | `production` or `development` | Yes |

All environment variables have sensible defaults in `src/lib/config.js`. See that file for the complete list of ~70 configurable values including cache TTLs, timeouts, and feature flags.

## Systemd Service

```ini
[Unit]
Description=MoltAgent - Nextcloud AI Assistant
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=/opt/moltagent

# Security: Load NC password from secure credential store
LoadCredential=nc-password:/etc/credstore/moltagent-nc-password

# Run the bot
ExecStart=/usr/bin/node /opt/moltagent/webhook-server.js

# Environment (non-sensitive config only)
Environment=NODE_ENV=production
Environment=NC_URL=https://your-nc.storageshare.de
Environment=NC_USER=moltagent
Environment=OLLAMA_URL=http://<OLLAMA_VM_IP>:11434
Environment=OLLAMA_MODEL=qwen3:8b
Environment=DECK_BOARD_ID=8
Environment=HEARTBEAT_INTERVAL=300000
Environment=INITIATIVE_LEVEL=2
Environment=KNOWLEDGE_ADMIN_USER=your-nc-username
Environment=ADMIN_USER=your-nc-username

# Graceful shutdown
TimeoutStopSec=120

# Restart policy
Restart=on-failure
RestartSec=30

# Logging
StandardOutput=journal
StandardError=journal
SyslogIdentifier=moltagent

[Install]
WantedBy=multi-user.target
```

## Next Steps

- [Quick Start](quickstart.md) - step-by-step deployment
- [LLM Providers](providers.md) - provider adapters and job routing
- [Security Model](security-model.md) - trust boundaries and credential brokering
