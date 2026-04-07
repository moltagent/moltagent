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
2. Install required apps: **Passwords**, **Deck**, **Collectives**, **Talk**, **Mail**, **Calendar**, **Contacts**
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

5. Store your LLM API keys in NC Passwords:
   - Create entries named `claude-api-key`, `deepseek-api-key`, etc.
   - Share each entry with the `moltagent` user

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
npm install --production
```

### Configure credentials

```bash
mkdir -p /etc/credstore
# Store the moltagent user's Nextcloud password
echo -n "YOUR_MOLTAGENT_NC_PASSWORD" > /etc/credstore/moltagent-nc-password
chmod 600 /etc/credstore/moltagent-nc-password
```

### Configure the agent

```bash
# Edit the provider configuration with your Ollama VM IP and provider preferences
nano config/moltagent-providers.yaml
```

### Set up the systemd service

```bash
cp deploy/moltagent.service /etc/systemd/system/
# Edit the service file to set your NC_URL, NC_USER, OLLAMA_URL
nano /etc/systemd/system/moltagent.service
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

Hetzner Storage Share does not allow running arbitrary OCC commands. You need to file a support ticket.

### Generate the bot secret

On the Bot VM:

```bash
# Generate 128-character hex secret
openssl rand -hex 64
```

Save this output. You will need it in two places:
- Store it as `nc-talk-secret` in NC Passwords and share with the `moltagent` user
- Include it in the Hetzner support ticket below

### Request bot registration from Hetzner

File a support ticket at Hetzner with the following:

```
Subject: Enable NC Talk Bot for Storage Share nxXXXXX

Please run the following OCC command:

sudo -u www-data php occ talk:bot:install \
  --feature=webhook \
  --feature=response \
  "Moltagent" \
  "<YOUR_128_CHAR_SECRET>" \
  "http://<BOT_VM_IP>:3000/webhook/nctalk" \
  "Moltagent AI Assistant"

Thank you.
```

Replace `<YOUR_128_CHAR_SECRET>` with the secret you generated and `<BOT_VM_IP>` with your Bot VM's IPv4 address. Hetzner support typically responds within a few hours.

### Configure the Talk room

Once Hetzner confirms the bot is registered:

1. Create a new Talk room in Nextcloud (or use an existing one)
2. Add the Moltagent bot to the room
3. Note the room token from the URL (the part after `/call/`)
4. Ensure your Bot VM firewall allows inbound connections from the Storage Share IP on port 3000

### Test

Check that the service is running:

```bash
systemctl status moltagent
journalctl -u moltagent -f
```

Send a message in the Talk room. If the webhook is configured correctly, the bot will respond.

Check the [public dashboard](https://public.moltagent.cloud) architecture view for a reference of what a healthy system looks like.

## Single-VM Development Setup

For development and testing, you can run everything on a single machine:

1. Install Ollama locally
2. Point the config at a Nextcloud instance (can be a test Storage Share or local Nextcloud)
3. Run `npm test` to verify the test suite
4. Run the agent directly with `node webhook-server.js`

This skips network isolation and is not suitable for production, but it's sufficient for development and contribution testing.

## Next Steps

- [Deployment Guide](deployment.md) - SearXNG, Speaches, email, credentials, full setup
- [Architecture](architecture.md) - understand the three-VM isolation model
- [Security Model](security-model.md) - trust boundaries and credential brokering
- [Configuration](configuration.md) - full reference for all config options
- [LLM Providers](providers.md) - provider adapters and job routing
