# NC Talk Bot Setup Guide

**Version:** 1.0.0
**Date:** 2026-02-03

---

## Overview

This guide covers setting up MoltAgent as an NC Talk bot. The bot receives messages via webhooks, processes them through the LLM router, and responds in the chat.

**Security Features:**
- HMAC-SHA256 signature verification on all incoming webhooks
- Backend allowlist (only accepts requests from configured Nextcloud instances)
- Credential broker integration (no hardcoded secrets)
- Comprehensive audit logging

---

## Prerequisites

1. **Nextcloud server** with:
   - Talk app installed (version 17.1+ / Nextcloud 27.1+)
   - Admin access (for bot installation)
   - HTTPS enabled

2. **MoltAgent server** with:
   - Node.js 18+
   - Network access from Nextcloud server
   - Valid SSL certificate (or Nextcloud configured to allow HTTP for testing)

3. **Network connectivity:**
   - Nextcloud must be able to reach MoltAgent webhook URL
   - Typically: `https://your-moltbot-server:3000/webhook/nctalk`

---

## Step 1: Generate Shared Secret

Generate a cryptographically secure shared secret (64-128 characters):

```bash
# Generate 64-character hex secret (recommended)
openssl rand -hex 32

# Or generate 128-character secret for extra security
openssl rand -hex 64
```

**Save this secret** - you'll need it for both Nextcloud and MoltAgent.

---

## Step 2: Install Bot on Nextcloud

SSH into your Nextcloud server and run:

```bash
# Basic installation
sudo -u www-data php occ talk:bot:install \
  "MoltAgent" \
  "YOUR_64_CHAR_SECRET_HERE" \
  "https://your-moltbot-server:3000/webhook/nctalk" \
  "MoltAgent assistant bot"

# With features enabled
sudo -u www-data php occ talk:bot:install \
  "MoltAgent" \
  "YOUR_64_CHAR_SECRET_HERE" \
  "https://your-moltbot-server:3000/webhook/nctalk" \
  "MoltAgent assistant bot" \
  --feature response \
  --feature reaction
```

**Parameters:**
- `"MoltAgent"` - Bot display name
- `"YOUR_SECRET"` - Shared secret (same as MoltAgent config)
- `"https://..."` - Webhook URL (must be reachable from Nextcloud)
- `"MoltAgent assistant bot"` - Bot description

**List installed bots:**
```bash
sudo -u www-data php occ talk:bot:list
```

**Remove a bot:**
```bash
sudo -u www-data php occ talk:bot:remove <bot-id>
```

---

## Step 3: Configure MoltAgent

### Option A: Environment Variables (Simple)

```bash
# Required
export NC_PASSWORD="your-nextcloud-password"
export NC_TALK_SECRET="your-64-char-shared-secret"

# Optional
export NC_URL="https://your-nextcloud.com"
export NC_USER="moltagent"
export PORT="3000"
export NC_TALK_BACKENDS="https://your-nextcloud.com"  # Comma-separated allowlist
export STRICT_MODE="true"
```

### Option B: NC Passwords + systemd (Recommended for Production)

1. **Store secret in NC Passwords:**
   - Name: `nc-talk-secret`
   - Value: Your 64-char shared secret
   - Share with: `moltagent` user

2. **Configure systemd:**
   ```ini
   # /etc/systemd/system/moltagent-webhook.service
   [Unit]
   Description=MoltAgent NC Talk Webhook Server
   After=network.target

   [Service]
   Type=simple
   User=moltagent
   WorkingDirectory=/opt/moltagent
   ExecStart=/usr/bin/node webhook-server.js
   Restart=always
   RestartSec=10

   # Security
   LoadCredential=nc-password:/etc/credstore/moltagent-nc-password
   Environment=NC_URL=https://your-nextcloud.com
   Environment=NC_USER=moltagent
   Environment=PORT=3000
   Environment=NC_TALK_BACKENDS=https://your-nextcloud.com

   # Hardening
   NoNewPrivileges=true
   PrivateTmp=true
   ProtectSystem=strict
   ProtectHome=true

   [Install]
   WantedBy=multi-user.target
   ```

3. **Enable and start:**
   ```bash
   sudo systemctl daemon-reload
   sudo systemctl enable moltagent-webhook
   sudo systemctl start moltagent-webhook
   ```

---

## Step 4: Start the Webhook Server

### For Testing

```bash
NC_PASSWORD=test NC_TALK_SECRET=your-secret node webhook-server.js
```

### For Production

```bash
sudo systemctl start moltagent-webhook
sudo systemctl status moltagent-webhook
```

### Verify Server is Running

```bash
# Health check
curl http://localhost:3000/health

# Should return:
# {"status":"ok","service":"moltagent-webhook","version":"2.0.0","verifications":0}

# Stats
curl http://localhost:3000/stats
```

---

## Step 5: Add Bot to a Talk Room

1. Open NC Talk in your browser
2. Create a new room or open an existing one
3. Go to Room Settings → Bots
4. Add "MoltAgent" to the room
5. Send a test message: `/help`

---

## Step 6: Test the Integration

### From Nextcloud Talk

Send these test messages in the room:

```
/help          → Shows available commands
/status        → Shows server status
/stats         → Shows verification statistics
Hello!         → Gets AI response (if LLM configured)
```

### From Command Line (Simulated Webhook)

```bash
# Run the integration test
NC_TALK_SECRET=your-secret node tests/test-webhook-server.js
```

---

## Troubleshooting

### Bot Not Responding

1. **Check webhook server is running:**
   ```bash
   curl http://your-moltbot:3000/health
   ```

2. **Check Nextcloud can reach webhook:**
   ```bash
   # From Nextcloud server
   curl -I https://your-moltbot:3000/health
   ```

3. **Check bot is installed:**
   ```bash
   sudo -u www-data php occ talk:bot:list
   ```

4. **Check bot is added to room:**
   - Go to Room Settings → Bots
   - Verify MoltAgent is listed

### Signature Verification Failed

1. **Check secrets match:**
   - Secret in `occ talk:bot:install` must match `NC_TALK_SECRET`

2. **Check backend allowlist:**
   - `NC_TALK_BACKENDS` must include your Nextcloud URL

3. **Check server logs:**
   ```bash
   journalctl -u moltagent-webhook -f
   ```

### Connection Refused

1. **Check firewall:**
   ```bash
   sudo ufw allow 3000/tcp
   ```

2. **Check SSL certificate:**
   - Nextcloud Talk requires valid HTTPS for webhook URLs
   - For testing, you can use Let's Encrypt or self-signed + trust

3. **Check reverse proxy (if using):**
   - Ensure proxy passes all headers including `X-Nextcloud-Talk-*`

---

## Security Considerations

### Required

- [ ] Use HTTPS for webhook URL
- [ ] Use strong shared secret (64+ chars)
- [ ] Enable strict mode (`STRICT_MODE=true`)
- [ ] Configure backend allowlist

### Recommended

- [ ] Store secret in NC Passwords
- [ ] Use systemd with LoadCredential
- [ ] Enable 2FA for NC users
- [ ] Monitor audit logs
- [ ] Set up firewall rules

### User Allowlist (Optional)

To restrict which users can interact with the bot, add to webhook-server.js:

```javascript
const ALLOWED_USERS = ['admin', 'alice', 'bob'];

// In processMessage():
if (!ALLOWED_USERS.includes(user)) {
  await consoleAuditLog('user_rejected', { user });
  return; // Silently ignore
}
```

---

## Bot Commands Reference

| Command | Description |
|---------|-------------|
| `/help` | Show available commands |
| `/status` | Show server status and config |
| `/stats` | Show signature verification statistics |
| (any text) | Send to LLM and get response |

---

## Architecture

```
┌─────────────────┐     HTTPS      ┌─────────────────────────┐
│   NC Talk       │───────────────▶│   MoltAgent Webhook     │
│   (Browser)     │                │   Server                │
└─────────────────┘                │                         │
        │                          │  1. Verify signature    │
        │                          │  2. Check backend       │
        │                          │  3. Process message     │
        │                          │  4. Route to LLM        │
        │                          │  5. Send reply          │
        │                          └───────────┬─────────────┘
        │                                      │
        │         ┌────────────────────────────┘
        │         │
        │         ▼
        │    ┌─────────────────┐
        │    │   Ollama LLM    │
        │    │   (Local)       │
        │    └─────────────────┘
        │
        ▼
┌─────────────────┐
│   NC Server     │
│   + Passwords   │
│   + Talk        │
└─────────────────┘
```

---

## Files Reference

| File | Purpose |
|------|---------|
| `webhook-server.js` | Main webhook server |
| `src/lib/talk-signature-verifier.js` | Signature verification |
| `src/lib/credential-broker.js` | Secret management |
| `tests/test-talk-signature.js` | Unit tests (61 tests) |
| `tests/test-webhook-server.js` | Integration tests |

---

## Changelog

- **2026-02-03:** Initial version
