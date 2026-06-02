# Quick Start

This guide walks you through deploying Moltagent on Hetzner infrastructure. The recommended setup uses three components: a managed Nextcloud (Storage Share), a Bot VM, and an Ollama VM.

**Time required:** approximately 30-60 minutes for someone comfortable with server administration.

**Monthly cost:** starting at ~30 Euro/month.

## Prerequisites

- A Hetzner Cloud account ([console.hetzner.cloud](https://console.hetzner.cloud))
- SSH key pair for server access
- At least one LLM API key (Anthropic, OpenAI, DeepSeek, etc.) for cloud-assisted mode, or none for local-only mode
- Basic familiarity with Linux, systemd, and SSH

## Step 1: Provision Infrastructure

### Nextcloud (Storage Share)

1. Go to [Hetzner Robot](https://robot.hetzner.com/storage)
2. Order a Storage Share (BX11, 100GB is sufficient, ~5 Euro/month)
3. Choose a datacenter close to you (Falkenstein recommended for EU)
4. Wait for the provisioning email (usually under 1 hour)
5. Note your Storage Share URL, admin username, and password

### Bot VM

1. In [Hetzner Cloud Console](https://console.hetzner.cloud), create a new server:
   - Image: Ubuntu 24.04
   - Type: CPX22 (3 vCPU, 4GB RAM) or larger
   - Location: same datacenter as your Storage Share
   - SSH key: add your public key
2. Note the server's IPv4 address

### Ollama VM

1. Create another server:
   - Image: Ubuntu 24.04
   - Type: CPX31 (8 vCPU, 16GB RAM) or larger
   - Location: same datacenter
   - SSH key: same key
2. Note the server's IPv4 address

## Step 2: Configure Nextcloud

1. Log into your Nextcloud admin panel
2. Install the Nextcloud apps Moltagent uses.

   **Required** — the agent will not start without these:
   - **Passwords** — credential broker (API keys, secrets)
   - **Deck** — Cockpit control plane and Workflow Engine
   - **Collectives** — Living Memory / knowledge wiki
   - **Talk** — chat interface and webhook pipeline

   **Optional** — install only the features you want; the agent runs fine without any of them:
   - **Mail** — email monitoring and drafting (IMAP/SMTP)
   - **Calendar** — CalDAV scheduling and meeting awareness
   - **Contacts** — contact resolution for email and meetings
   - **News** — RSS feeds for content workflows

   If you skip an optional app, the corresponding feature simply stays off. You will see a single log line at startup noting the feature is disabled, and nothing else.

   <!-- Maintainer: this required/optional split is mirrored in deployment.md ("Nextcloud Apps"). Keep both in sync in the same commit until the single-manifest fix lands — see #87. -->
3. Create the `moltagent` user via the Nextcloud admin panel (Settings → Users). On a managed Storage Share, `occ` is not available — use the web interface instead.

4. Create the agent's folder structure:

```bash
# Create these via the Nextcloud Files web UI or WebDAV.
# On a managed Storage Share, occ is not available.
# Folder names are case-sensitive.
```

```bash
# Via WebDAV (replace NC_URL, NC_USER, NC_PASS):
for dir in Moltagent Moltagent/Inbox Moltagent/Outbox Moltagent/Logs Moltagent/Memory Moltagent/SkillTemplates; do
  curl -u "$NC_USER:$NC_PASS" -X MKCOL "https://$NC_URL/remote.php/dav/files/$NC_USER/$dir"
done
```

5. Store your credentials in NC Passwords:
   - Create entries named `claude-api-key`, `deepseek-api-key`, etc. for your LLM API keys
   - You will also create `nc-talk-secret` and `nc-talk-room` in Step 5 (Talk bot registration)
   - Share each entry with the `moltagent` user
   - See the [Credential Format Reference](credentials.md) for the exact fields each credential needs — especially for complex credentials like `email-imap` and `email-smtp`, where the host and port live in specific fields

## Step 3: Set Up Ollama VM

SSH into the Ollama VM:

```bash
ssh root@<OLLAMA_IP>
```

Install Ollama and pull models:

```bash
curl -fsSL https://ollama.com/install.sh | sh
ollama pull qwen3:8b          # General-purpose reasoning
ollama pull qwen2.5:3b        # Fast classification
ollama pull nomic-embed-text   # Embeddings for semantic search
```

Configure Ollama to listen on the private network:

```bash
# Edit /etc/systemd/system/ollama.service.d/override.conf
[Service]
Environment="OLLAMA_HOST=0.0.0.0:11434"
```

**Critical: block all outbound internet access on this VM.**

```bash
ufw default deny outgoing
ufw default deny incoming
ufw allow in from <BOT_VM_IP> to any port 11434
ufw enable
```

## Step 4: Set Up Bot VM

SSH into the Bot VM:

```bash
ssh root@<BOT_IP>
```

Install Node.js and clone the repository:

```bash
# Node.js 22.x LTS recommended (minimum: 18.x)
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
apt-get install -y nodejs
git clone https://github.com/moltagent/moltagent.git /opt/moltagent
cd /opt/moltagent
npm install --omit=dev
```

**If the install fails, or you previously ran `npm audit fix --force`:** that command can introduce breaking major-version upgrades and leave `node_modules` in a state that no longer matches the project's pinned versions. The safest recovery is a clean slate:

```bash
cd /opt/moltagent
rm -rf node_modules package-lock.json
npm install --omit=dev
```

This rebuilds the dependency tree from the project's declared versions.

### Configure credentials

```bash
mkdir -p /etc/credstore
# Store the moltagent user's Nextcloud password
echo -n "YOUR_MOLTAGENT_NC_PASSWORD" > /etc/credstore/moltagent-nc-password
chmod 600 /etc/credstore/moltagent-nc-password
```

### Configure the agent

```bash
# From the repo root (/opt/moltagent if you followed the clone step above):
# Edit the provider configuration with your Ollama VM IP and provider preferences
nano config/moltagent-providers.yaml
```

### Set up the systemd service

```bash
cp deploy/moltagent.service /etc/systemd/system/
# Edit the service file to set your NC_URL, NC_USER, OLLAMA_URL
nano /etc/systemd/system/moltagent.service
```

> **Note on `NC_USER`:** Use the Nextcloud **user ID**, not the display name. You can see the user ID in the Nextcloud admin Users panel (it is the value in the "Username" / account-name column, which may differ from the display name shown elsewhere). A mismatch here surfaces as a `401 Authentication error` against NC Passwords at startup.

```bash
systemctl daemon-reload
systemctl enable moltagent
systemctl start moltagent
```

### Configure firewall

```bash
ufw default deny outgoing
ufw default deny incoming
ufw allow ssh
# Allow inbound webhook from Nextcloud Storage Share
ufw allow in from <NC_STORAGE_SHARE_IP> to any port 3000
ufw allow out to <NC_STORAGE_SHARE_IP> port 443
ufw allow out to <OLLAMA_IP> port 11434
# Allow cloud LLM APIs (skip for local-only mode)
ufw allow out to api.anthropic.com port 443
ufw allow out to api.openai.com port 443
ufw allow out to api.deepseek.com port 443
ufw enable
```

## Step 5: Register the Talk Bot

Registering the bot has two distinct parts, and both are required:

1. **Install** — registers the bot on the Nextcloud server. Makes it *available*.
2. **Enable** — activates the bot in a specific conversation. Makes it *listen*.

Skipping the second part is the most common reason a freshly installed bot stays silent: it is registered, but Nextcloud never delivers webhooks to it, the error count stays at zero, and you see nothing but silence with no clue why.

How you install the bot depends on your deployment. If you **self-host Nextcloud** with shell access, you run one OCC command. If you use a **managed Hetzner Storage Share**, OCC is not exposed and you file a support ticket. The secret generation and the per-conversation enable step are the same for both — follow the path that matches your setup.

### Generate the shared secret

The bot authenticates every webhook with a 128-character hex secret. That secret must be **byte-identical** in two places: the `talk:bot:install` command (which Nextcloud stores) and the `nc-talk-secret` entry in NC Passwords (which the bot reads at runtime). Copy-pasting 128 characters by hand across a terminal and a web form is the single most error-prone step in this guide — a stray newline or a truncated character produces `signature_verification_failed` at runtime with no other clue. Generate the secret once to a file and let both sides read from that file.

```bash
# On the Bot VM — generate the secret and strip the trailing newline
openssl rand -hex 64 | tr -d '\n' > /tmp/moltagent-talk-secret.txt
cat /tmp/moltagent-talk-secret.txt
```

Store this value as `nc-talk-secret` in NC Passwords (Password field only — no quotes, no surrounding whitespace) and share the entry with the `moltagent` user.

### Install the bot — self-hosted Nextcloud

If you run your own Nextcloud and have shell access, install the bot with one command:

```bash
# On your Nextcloud server
sudo -u www-data php occ talk:bot:install \
  --feature=webhook \
  --feature=response \
  "Moltagent" \
  "$(cat /tmp/moltagent-talk-secret.txt)" \
  "http://<bot-vm-ip>:3000/webhook/nctalk" \
  "Moltagent AI Assistant"
```

Note the bot ID in the output (e.g. `Bot installed with id 3`) — you need it for the enable step below. The `$(cat ...)` reads the secret from the same file you stored in NC Passwords, so both sides get identical bytes with no human copying.

### Install the bot — Hetzner Storage Share (managed Nextcloud)

Storage Share does not expose `talk:bot:install` in the OCC dropdown, so you cannot run it yourself. File a support ticket asking Hetzner to run it for you:

```
Subject: Enable NC Talk Bot for Storage Share nxXXXXX

Please run the following OCC command:

sudo -u www-data php occ talk:bot:install \
  --feature=webhook \
  --feature=response \
  "Moltagent" \
  "<YOUR_128_CHAR_SECRET>" \
  "http://<bot-vm-ip>:3000/webhook/nctalk" \
  "Moltagent AI Assistant"

Ich akzeptiere die Bedingungen.

Thank you.
```

Replace `<YOUR_128_CHAR_SECRET>` with the value from your secret file and `<bot-vm-ip>` with your Bot VM's IPv4 address. Ask Hetzner to send back the bot ID from the command output — you need it for the enable step. Support typically responds within a few hours.

### Enable the bot in your conversation

**This step is required regardless of deployment type, and it is the one most setups miss.** Installing the bot makes it *available* on the server; enabling it in a specific conversation makes it *listen*. Until you do this, the bot is registered but deaf.

First, create (or choose) the Talk room the agent should live in, and note its **room token** — the short string after `/call/` in the room's URL. Store that token as an `nc-talk-room` entry in NC Passwords (token in the Password field) and share it with the `moltagent` user. This tells the agent which conversation to listen in.

Then enable the bot in that room:

```bash
# On your Nextcloud server (self-hosted) or via a support ticket (managed)
sudo -u www-data php occ talk:bot:setup <bot-id> <room-token>
```

`<bot-id>` is the ID from the install step; `<room-token>` is the same token you just stored in `nc-talk-room`.

> The exact command name can vary between Talk versions. If `talk:bot:setup` is not found, run `sudo -u www-data php occ list | grep talk:bot` to see the bot commands your version provides.

Alternatively, in newer Talk versions you can skip the command line: open the room's conversation settings (the `···` menu), go to the **Bots** section, and click **Enable** next to Moltagent.

### Verify the webhook is wired

With the bot enabled, tail the bot's log on the Bot VM and send a message in the room:

```bash
systemctl status moltagent
journalctl -u moltagent -f
```

You should see webhook activity appear in the log as you send messages, and the bot should reply in the room. If you see `signature_verification_failed`, the two copies of the secret do not match — regenerate with the file-based method above and re-run `talk:bot:install` (self-hosted) or re-file the ticket (managed) so both sides read identical bytes.

Check the [public dashboard](https://public.moltagent.cloud) architecture view for a reference of what a healthy system looks like.

### Clean up the secret file

Once the bot responds, delete the secret file from any machine it touched:

```bash
rm /tmp/moltagent-talk-secret.txt   # on the Bot VM (and the NC server, if you copied it there)
```

### Share your calendar with Moltagent

For Molti to see your appointments, share your calendar with the `moltagent` user. In the NC Calendar app, click the share icon next to each calendar you want the agent to access and add `moltagent` as a viewer. Without this, calendar queries come back empty even when you have events. The same pattern applies to files and Deck boards — the agent only sees what is shared with it.

## Home-Lab and Single-Server Setup

The three-VM architecture is a production security measure (network isolation). For testing, development, or home-lab use, you can run Moltagent alongside an existing Nextcloud and Ollama installation.

What changes:

- Clone the repo on the same server as Nextcloud (or any machine that can reach your Nextcloud and Ollama instances)
- In `config/moltagent-providers.yaml`, set the Ollama endpoint to your Ollama server's LAN IP (e.g. `http://192.168.1.50:11434`)
- Set up the credential store and systemd service as described in Step 4 above
- Skip the firewall rules — those are for the isolated VM setup

### Running fully local (no cloud LLM)

If you want zero cloud calls, set every role to your local provider in `config/moltagent-providers.yaml`:

```yaml
roles:
  sovereign: [ollama-local]
  free: [ollama-local]
  value: [ollama-local]
  premium: [ollama-local]
```

Remove or comment out the cloud provider blocks (e.g. `anthropic-claude`, `claude-sonnet`). With no cloud provider in any role, the agent never attempts a cloud call and you will not see `credential_error` lines for keys you did not configure. This is equivalent to the **all-local** preset described in [LLM Providers](providers.md).

To verify:

```bash
cd /path/to/moltagent
npm test                      # Run the test suite
node webhook-server.js        # Start the agent directly (foreground, useful for debugging)
```

This skips network isolation and is not suitable for production, but works for development, contribution testing, and home-lab exploration.

## Next Steps

Now that Moltagent is running, see [Getting Started](getting-started.md) for your first steps — your first conversation, sharing your data, and real tasks to try.

- [Getting Started](getting-started.md) - your first hour with Moltagent
- [Deployment Guide](deployment.md) - SearXNG, Speaches, email, credentials, full setup
- [Architecture](architecture.md) - understand the three-VM isolation model
- [Security Model](security-model.md) - trust boundaries and credential brokering
- [Configuration](configuration.md) - full reference for all config options
- [LLM Providers](providers.md) - provider adapters and job routing
