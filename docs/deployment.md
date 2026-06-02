# Deployment Guide

This guide covers the complete Moltagent deployment in detail. For a quick overview, see the [Quick Start](quickstart.md). This document covers every configuration step including services the quickstart does not: SearXNG, Speaches, credential organization, Cockpit setup, and document ingestion.

## Prerequisites

- Three Hetzner VMs provisioned (see [Quick Start](quickstart.md) steps 1-4)
- Moltagent service running on the Bot VM
- Nextcloud Storage Share with the `moltagent` user created
- Talk bot installed and enabled in a conversation — self-hosted via `occ`, or managed via Hetzner support (see [Talk Bot Registration](#talk-bot-registration) below)

## Nextcloud Apps

The following apps must be installed on your Storage Share. Most are pre-installed on Hetzner Storage Share. Check via Settings > Apps.

**Required** — the agent will not start without these:

| App | Purpose |
|-----|---------|
| Passwords | Credential broker. API keys stored here, shared with the moltagent user |
| Deck | Kanban boards for Cockpit (agent control plane) and Workflow Engine |
| Collectives | Wiki for Living Memory / knowledge system |
| Talk | Chat interface, webhook pipeline, human-agent communication |

**Optional** — each enables a feature; absence disables that feature cleanly with one log line, nothing more:

| App | Feature enabled if present |
|-----|---------|
| Mail | Email monitoring, analysis, and draft replies (IMAP/SMTP) |
| Calendar | CalDAV scheduling, meeting awareness, free/busy |
| Contacts | CardDAV contact resolution for meetings and email |
| News | RSS feeds for content discovery and editorial workflows |
| Analytics | Data visualization (not used by the agent directly) |

The agent probes each optional integration at startup. If the app or its credential is not present, that feature is disabled and the agent continues normally. You never need to install an optional app just to make the service boot.

> **Maintainer note — keep this list in sync.** The required/optional split also appears in the [Quick Start](quickstart.md), Step 2. These two copies are hand-synchronized: change one, change the other in the same commit. Collapsing the split into a single declared manifest that both the startup preflight and the docs read from — so the two surfaces can no longer drift — is tracked in [#87](https://github.com/moltagent/moltagent/issues/87). When that lands, this note gets deleted.

## Credential Organization in NC Passwords

Create the following entries in the Passwords app and share them with the `moltagent` user. The folder structure is optional but recommended for organization.

For the exact field-by-field mapping of every credential — which NC Passwords fields the code reads and how — see the [Credential Format Reference](credentials.md). Read it before configuring `email-imap`, `email-smtp`, or `oauth`: the host and port do not go where you might expect, and `key=value` lines in the Notes field are silently ignored.

**LLM Providers (share with moltagent):**

| Entry name | Value | Notes |
|-----------|-------|-------|
| `claude-api-key` | Your Anthropic API key (starts with `sk-ant-`) | Required for smart-mix and cloud-first presets |
| `deepseek-api-key` | Your DeepSeek API key | Optional, cost-effective alternative |

Add entries for any additional providers you want to use (OpenAI, Mistral, Groq, etc.). The entry name must match the `credentialName` in your provider config.

**Communication (share with moltagent):**

| Entry name | Value | Notes |
|-----------|-------|-------|
| `nc-talk-secret` | The 128-char hex secret from Talk bot registration | Generated during setup |
| `nc-talk-room` | The Talk room token (the string after `/call/` in the room URL) | Tells the agent which conversation to listen in |
| `email-imap` | Your IMAP credentials | See Email Setup below and the [Credential Format Reference](credentials.md#email-imap) |
| `email-smtp` | Your SMTP credentials | See Email Setup below and the [Credential Format Reference](credentials.md#email-smtp) |

**Never share with moltagent:**

Keep sensitive credentials (banking, admin passwords, HR systems) in separate folders that are NOT shared with the moltagent user. The agent cannot access what isn't shared with it.

## Talk Bot Registration

The bot reaches Nextcloud Talk through a registered webhook bot. There are two distinct actions, and both are mandatory:

1. **Install** — registers the bot on the server (`talk:bot:install`). Makes it *available*.
2. **Enable** — activates the bot in a specific conversation (`talk:bot:setup`). Makes it *listen*.

A bot that is installed but not enabled in any conversation receives no webhooks at all — the error count stays at zero and the room stays silent. This is the most common "the bot does nothing" cause. How you install depends on your deployment; the secret and the enable step are identical for both.

### Shared secret alignment

The webhook is authenticated with a 128-character hex secret that must be **byte-identical** in two places: the `talk:bot:install` command (stored by Nextcloud) and the `nc-talk-secret` entry in NC Passwords (read by the bot at runtime). Mismatched bytes — a stray newline, a truncated paste — surface only as `signature_verification_failed`. Generate the secret once to a file so both sides read the same bytes instead of copying 128 characters by hand:

```bash
# On the Bot VM
openssl rand -hex 64 | tr -d '\n' > /tmp/moltagent-talk-secret.txt
cat /tmp/moltagent-talk-secret.txt
```

Store the value as `nc-talk-secret` in NC Passwords (Password field, no quotes or whitespace) and share it with the `moltagent` user.

### Install — self-hosted Nextcloud

```bash
sudo -u www-data php occ talk:bot:install \
  --feature=webhook \
  --feature=response \
  "Moltagent" \
  "$(cat /tmp/moltagent-talk-secret.txt)" \
  "http://<bot-vm-ip>:3000/webhook/nctalk" \
  "Moltagent AI Assistant"
```

Record the bot ID from the output (`Bot installed with id N`).

### Install — Hetzner Storage Share (managed)

Storage Share does not expose `talk:bot:install`. File a support ticket asking Hetzner to run the command above on your behalf, including your secret, the webhook URL, and the line `Ich akzeptiere die Bedingungen.` Ask them to return the bot ID. Response time is typically a few hours.

### Enable in a conversation (both deployment types)

Create or choose the Talk room, take its room token (the string after `/call/` in the URL), store it as `nc-talk-room` in NC Passwords, and share it with `moltagent`. Then:

```bash
sudo -u www-data php occ talk:bot:setup <bot-id> <room-token>
```

If `talk:bot:setup` is not present on your version, run `sudo -u www-data php occ list | grep talk:bot` to find the equivalent. In newer Talk versions you can instead enable the bot from the room's conversation settings → **Bots** → **Enable**.

### Verify and clean up

Tail the bot log (`journalctl -u moltagent -f`) and send a message in the room; webhook activity should appear and the bot should reply. A `signature_verification_failed` line means the two secret copies differ — realign them with the file-based method above. Once confirmed, remove the secret file: `rm /tmp/moltagent-talk-secret.txt`.

## Ollama VM: Models

The agent uses several local models for different purposes. SSH into the Ollama VM and pull them:

```bash
ssh root@<OLLAMA_IP>

# Primary local model (classification, tool-calling, general tasks)
ollama pull qwen3:8b

# Fast classifier (intent detection, quick routing decisions)
ollama pull phi4-mini

# Small fast model (synthesis, label detection)
ollama pull qwen2.5:3b

# Embeddings (vector search, semantic similarity)
ollama pull nomic-embed-text
```

Verify all models are available:

```bash
ollama list
```

You should see all four models listed.

### Memory requirements

| Model | RAM when loaded | Role |
|-------|----------------|------|
| qwen3:8b | ~5 GB | Primary local model |
| phi4-mini | ~2.5 GB | Fast classifier |
| qwen2.5:3b | ~2 GB | Synthesis, quick tasks |
| nomic-embed-text | ~300 MB | Embeddings |

Ollama loads models on demand and keeps them warm. On a CPX31 (16 GB RAM), two models can be warm simultaneously without issues. On smaller VMs, expect more model swapping.

## Ollama VM: Speaches (Voice Pipeline)

Speaches provides speech-to-text (Whisper) and text-to-speech (Piper) on the Ollama VM. This is optional but enables voice messages in Talk.

```bash
ssh root@<OLLAMA_IP>

# Install Docker if not already present
curl -fsSL https://get.docker.com | sh

# Run Speaches
docker run -d \
  --name speaches \
  --restart unless-stopped \
  -p 8014:8000 \
  -v speaches-cache:/home/ubuntu/.cache/huggingface/hub \
  ghcr.io/speaches-ai/speaches:latest-cpu
```

Wait 30 seconds for startup, then download the TTS voice model:

```bash
# Download the Piper TTS model (first run only)
docker exec speaches /home/ubuntu/speaches/.venv/bin/python3 -c \
  "from huggingface_hub import snapshot_download; snapshot_download('speaches-ai/piper-en_US-amy-medium')"
```

Verify:

```bash
# Health check
curl http://localhost:8014/health

# Test TTS
curl -X POST http://localhost:8014/v1/audio/speech \
  -H "Content-Type: application/json" \
  -d '{"model":"speaches-ai/piper-en_US-amy-medium","input":"Hello from Moltagent.","voice":"en_US-amy-medium"}' \
  -o /tmp/test.mp3 && file /tmp/test.mp3
```

The Bot VM needs to reach port 8014 on the Ollama VM. Add a firewall rule on the Ollama VM:

```bash
ufw allow in from <BOT_VM_IP> to any port 8014
```

Set the Speaches URL in the Bot VM environment:

```bash
# Add to the moltagent systemd service Environment lines
Environment=SPEACHES_URL=http://<OLLAMA_IP>:8014
```

## Bot VM: SearXNG (Sovereign Search)

SearXNG provides web search without sending queries to Google or any tracking service. It runs as a Docker container on the Bot VM, accessible only from localhost.

```bash
ssh root@<BOT_IP>

# Install Docker if not already present
curl -fsSL https://get.docker.com | sh

# Create SearXNG directory
mkdir -p /opt/searxng/searxng
cd /opt/searxng

# Create docker-compose.yml
cat > docker-compose.yml << 'EOF'
services:
  searxng:
    image: searxng/searxng:latest
    container_name: moltagent-searxng
    ports:
      - "127.0.0.1:8080:8080"
    volumes:
      - ./searxng:/etc/searxng
    environment:
      - SEARXNG_BASE_URL=http://localhost:8080
    restart: unless-stopped
EOF

# Generate a secret key and create settings
SEARXNG_SECRET=$(openssl rand -hex 32)

cat > searxng/settings.yml << EOF
use_default_settings: true

server:
  secret_key: "$SEARXNG_SECRET"
  limiter: false

general:
  instance_name: "Moltagent Search"

search:
  autocomplete: "stract"
  default_lang: "auto"
  formats:
    - html
    - json

engines:
  - name: stract
    disabled: false
    weight: 1.4
  - name: mojeek
    disabled: false
    weight: 1.2
  - name: duckduckgo
    disabled: false
    weight: 1.2
  - name: brave
    disabled: false
    weight: 1.3
  - name: wikipedia
    disabled: false
    weight: 1.0
  - name: google
    disabled: true
  - name: bing
    disabled: true
  - name: yandex
    disabled: true
EOF

# Start SearXNG
docker compose up -d

# Verify
curl -s "http://localhost:8080/search?q=test&format=json" | head -c 200
```

Set the SearXNG URL in the Moltagent environment:

```bash
# Add to the moltagent systemd service Environment lines
Environment=SEARXNG_URL=http://localhost:8080
```

Restart the agent after adding the environment variable:

```bash
systemctl daemon-reload
systemctl restart moltagent
```

### EU-only search configuration

For deployments that require EU-only data jurisdiction, replace the engines section in `settings.yml`:

```yaml
engines:
  - name: stract
    disabled: false
    weight: 1.5       # Denmark, EU-funded, open-source
  - name: qwant
    disabled: false
    weight: 1.3       # France, own index
  - name: mojeek
    disabled: false
    weight: 1.2       # UK, independent index
  - name: metager
    disabled: false
    weight: 1.0       # Germany, non-profit
  - name: wikipedia
    disabled: false
  - name: duckduckgo
    disabled: true
  - name: brave
    disabled: true
  - name: google
    disabled: true
  - name: bing
    disabled: true
```

## Email Setup

Moltagent can read and manage email via IMAP/SMTP. Store credentials in NC Passwords.

> **Field placement matters.** The host goes in the **Website** field, and the port goes in a **custom field** named `port` (or as valid JSON in Notes). Plain `key=value` lines in the Notes field are **ignored** by the code — this is the most common email-setup mistake. The full field-by-field mapping is in the [Credential Format Reference](credentials.md#email-imap).

### Option A: Shared access (read your existing mailbox)

Create two entries in NC Passwords:

**Entry: `email-imap`**
- Username: your email address (e.g. `you@example.com`)
- Password: your email password (or app password for Gmail/Outlook)
- Website: `imap.example.com` (e.g. `imap.gmail.com` — the protocol is stripped automatically)
- Custom field `port`: `993` (TLS is automatic on 993; use `143` with a custom field `starttls` = `true` for STARTTLS)

**Entry: `email-smtp`**
- Username: your email address
- Password: same password
- Website: `smtp.example.com` (e.g. `smtp.gmail.com`)
- Custom field `port`: `587` (STARTTLS) or `465` (implicit TLS)
- Custom field `from` (optional): `Your Name <you@example.com>`

Share both entries with the `moltagent` user.

**Gmail users:** host `imap.gmail.com` / `smtp.gmail.com`. Create an app password at Google Account > Security > 2-Step Verification > App passwords.

**Outlook users:** Use `outlook.office365.com` (IMAP) and `smtp.office365.com` (SMTP), port `993` / `587`.

### Option B: Dedicated email for the agent

Create a separate email address (e.g., `ai@yourcompany.com`) and configure it the same way. This lets people email the agent directly.

## Calendar Setup

The agent integrates with Nextcloud Calendar via CalDAV. To see events the agent creates:

1. In Nextcloud Calendar settings, enable sharing for the `moltagent` user's "Personal" calendar
2. Share it with your admin account (read access is sufficient)

The agent can now:
- Read your calendar for meeting preparation
- Create events (focus blocks, meeting prep reminders)
- Coordinate scheduling via contact resolution

## Cockpit (Agent Control Plane)

The Cockpit is a Deck board that controls the agent's behavior. **It is created automatically on first startup.** You don't need to create it manually.

On first run, the agent:
1. Creates a "Moltagent Cockpit" Deck board
2. Creates 6 stacks: Styles, Persona, Guardrails, Modes, System, Status
3. Populates default cards in each stack
4. Shares the board with the admin user

### What you can configure via the Cockpit

**Styles** - communication presets. Star the active one:
- Concise Executive (default)
- Warm Professional
- Blunt Analyst
- Warm Teacher

**Persona** - personality dimensions (humor, emoji use, formality, verbosity)

**Guardrails** - hard behavioral constraints. Write them in plain language:
- "Never delete files without asking"
- "Confirm before sending external communications"
- "Max 50 Euro/month on LLM costs"
- "Working hours only: 08:00-18:00 CET"

**Modes** - contextual behavior profiles. Star the active one:
- Full Auto (default) - maximum initiative
- Focus Mode - no proactive messages
- Meeting Day - prep notes, hold non-meeting tasks
- Out of Office - handle routine, escalate urgent

**System** - initiative level, notification preferences, cost limits

**Status** - agent health, recent actions, cost reports (updated by the agent)

All changes take effect on the next heartbeat cycle (typically within seconds).

### Environment variable

The agent needs to know who the admin user is to share the Cockpit board:

```bash
Environment=ADMIN_USER=your_nextcloud_username
```

## Knowledge Wiki (Collectives)

The agent uses Nextcloud Collectives as its knowledge wiki. A collective is created automatically on first startup with default sections: People, Projects, Procedures, Research, Meta.

Additional sections (Organizations, Sessions, Documents) are created by the agent as needed.

### Document ingestion

The agent learns from documents you share with it:

1. In Nextcloud Files, select a folder with business documents
2. Share the folder with the `moltagent` user (read access is sufficient)
3. The agent detects the new share within a few minutes
4. Documents are automatically processed: text extracted, entities identified, wiki pages created, embeddings generated

Supported formats: PDF (including scanned via OCR), DOCX, TXT, MD, HTML.

## Verification Checklist

After completing the full deployment, verify each component:

```bash
# Agent is running
systemctl status moltagent

# Ollama models are available
curl http://<OLLAMA_IP>:11434/api/tags

# Speaches is running (if deployed)
curl http://<OLLAMA_IP>:8014/health

# SearXNG is running
curl -s "http://localhost:8080/search?q=test&format=json" | head -c 100
```

Then test via Nextcloud Talk:

```
Hello, what can you do?
```
The agent should respond with an overview of its capabilities.

```
Search the web for Nextcloud 31 release notes
```
Should return web search results (verifies SearXNG).

```
What's on my calendar today?
```
Should check your calendar (verifies CalDAV).

```
Create a task to test the workflow engine
```
Should create a Deck card (verifies Deck integration).

## Firewall Summary

### Bot VM (outbound)

| Destination | Port | Purpose |
|------------|------|---------|
| Nextcloud Storage Share | 443 | HTTPS (all NC APIs) |
| Ollama VM | 11434 | Local LLM inference |
| Ollama VM | 8014 | Speaches STT/TTS (optional) |
| api.anthropic.com | 443 | Claude API |
| api.openai.com | 443 | OpenAI API (if configured) |
| api.deepseek.com | 443 | DeepSeek API (if configured) |
| Everything else | * | BLOCKED |

### Bot VM (inbound)

| Source | Port | Purpose |
|--------|------|---------|
| Nextcloud Storage Share | 3000 | Talk webhook |

### Ollama VM (outbound)

| Destination | Port | Purpose |
|------------|------|---------|
| Nothing | * | BLOCKED (air-gapped) |

### Ollama VM (inbound)

| Source | Port | Purpose |
|--------|------|---------|
| Bot VM | 11434 | Ollama API |
| Bot VM | 8014 | Speaches (optional) |

## Monthly Cost Summary

| Component | Spec | Monthly Cost |
|-----------|------|-------------|
| Nextcloud Storage Share | BX11 (100 GB) | ~5 Euro |
| Bot VM | CPX22 (3 vCPU, 4 GB RAM) | ~8 Euro |
| Ollama VM | CPX31 (8 vCPU, 16 GB RAM) | ~15 Euro |
| Cloud LLM APIs (smart-mix) | Variable | ~3-20 Euro |
| **Total** | | **~31-48 Euro/month** |

For local-only mode, the Cloud LLM cost is zero.

## Next Steps

- [Architecture](architecture.md) - understand the system design
- [Security Model](security-model.md) - trust boundaries and credential brokering
- [Configuration](configuration.md) - full reference for all config options
- [LLM Providers](providers.md) - provider adapters and job routing
