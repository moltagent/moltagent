# MoltAgent: The Briefing

**Version:** 0.3  
**Last Updated:** 2026-01-30  
**Status:** Pre-development / Architecture defined  
**Domain:** moltagent.cloud

---

## Executive Summary

MoltAgent is an open-source security layer that transforms Moltbot (the viral AI agent framework) into a trustworthy digital employee by using Nextcloud as both its home and its permission system.

**The core insight:** Instead of giving an AI agent blanket access to your data, MoltAgent treats the AI as a Nextcloud *user* â€” a digital colleague with its own identity, its own folders, and access only to what you explicitly share with it.

**The security innovation:** Credentials are brokered through Nextcloud's Passwords app at runtime. The agent never stores API keys or passwords permanently. It requests credentials when needed, uses them for one operation, then discards them. One click in the Passwords app revokes all access instantly.

**The name:** "MoltAgent" is a wordplay on the Catalan phrase "molta gent" (many people):
- An AI workforce that works like having many people on your team
- Reflects the open-source, community-driven ethos
- Built by many, for many

---

## The Problem We're Solving

### The MoltBot Security Gap

MoltBot is incredible. Within hours of setup, it can build tools, make reservations, manage tasks, and automate workflows. It's the closest thing to a real AI assistant we've seen.

But there's a fundamental security problem. From MoltBot's own FAQ:

> "There is no 'perfectly secure' setup."

The issues:
- **Plain text credentials** stored in config files on disk
- **Permanent access** once granted â€” no easy way to revoke
- **No audit trail** of what the agent accessed
- **Memory files readable** by any process on the machine
- **Single point of failure** â€” one compromise leaks everything
- **No prompt injection protection** â€” malicious file content can hijack the agent

A breach doesn't just expose API keys. It exposes the context of who you are, what you're building, who you work with â€” the raw material for perfect impersonation.

### The Industry's Mistake

Current AI agent security follows the OAuth model: one-time approval, permanent access, fixed scopes.

But AI agents are adaptive and non-deterministic. The approval you gave last week is used in unexpected ways today.

**The real requirement:** Security for agents is not about granting access once. It's about continuously mediating access at runtime for every action and request.

**Our solution:** Build this mediation layer with open-source, self-hosted infrastructure that anyone can run.

---

## Core Security Principles

1. **Zero Trust:** Never trust any input, credential, or external system by default
2. **Least Privilege:** Grant minimum necessary access, expand only when proven necessary
3. **Defense in Depth:** Multiple independent security layers; no single point of failure
4. **Fail Secure:** When in doubt, deny access and alert
5. **Audit Everything:** Every security-relevant action must be logged and traceable

---

## Infrastructure Architecture

### Three-VM Isolation Model

The system consists of three isolated components. Network segmentation ensures that compromise of one component does not automatically compromise others.

```
â”Œâ”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”
â”‚                         HETZNER CLOUD                               â”‚
â”‚                                                                     â”‚
â”‚  â”Œâ”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”  â”Œâ”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”  â”Œâ”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â” â”‚
â”‚  â”‚    NC SERVER      â”‚  â”‚    MOLTBOT VM     â”‚  â”‚   OLLAMA VM     â”‚ â”‚
â”‚  â”‚    (CPX21)        â”‚  â”‚    (CPX11)        â”‚  â”‚   (CPX31)       â”‚ â”‚
â”‚  â”‚                   â”‚  â”‚                   â”‚  â”‚                 â”‚ â”‚
â”‚  â”‚  â€¢ Nextcloud      â”‚  â”‚  â€¢ MoltAgent      â”‚  â”‚  â€¢ Local LLM    â”‚ â”‚
â”‚  â”‚  â€¢ Passwords App  â”‚  â”‚    Skill          â”‚  â”‚  â€¢ NO Internet  â”‚ â”‚
â”‚  â”‚  â€¢ NC Talk        â”‚  â”‚  â€¢ Credential     â”‚  â”‚  â€¢ Sensitive    â”‚ â”‚
â”‚  â”‚  â€¢ Identity/Audit â”‚  â”‚    Broker         â”‚  â”‚    operations   â”‚ â”‚
â”‚  â”‚                   â”‚  â”‚  â€¢ NO secrets     â”‚  â”‚    only         â”‚ â”‚
â”‚  â”‚  ~â‚¬8/month        â”‚  â”‚    stored         â”‚  â”‚                 â”‚ â”‚
â”‚  â”‚                   â”‚  â”‚                   â”‚  â”‚  ~â‚¬15/month     â”‚ â”‚
â”‚  â”‚                   â”‚  â”‚  ~â‚¬4/month        â”‚  â”‚                 â”‚ â”‚
â”‚  â””â”€â”€â”€â”€â”€â”€â”€â”€â”€â”¬â”€â”€â”€â”€â”€â”€â”€â”€â”€â”˜  â””â”€â”€â”€â”€â”€â”€â”€â”€â”¬â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”˜  â””â”€â”€â”€â”€â”€â”€â”€â”€â”¬â”€â”€â”€â”€â”€â”€â”€â”€â”˜ â”‚
â”‚            â”‚                     â”‚                      â”‚          â”‚
â”‚            â”‚    HTTPS/443        â”‚                      â”‚          â”‚
â”‚            â”‚    CalDAV/WebDAV    â”‚     Port 11434       â”‚          â”‚
â”‚            â”‚    Passwords API    â”‚     (Ollama API)     â”‚          â”‚
â”‚            â”‚â—„â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”¤â—„â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”¤          â”‚
â”‚            â”‚                     â”‚                      â”‚          â”‚
â”‚            â”‚                     â”‚    Claude/Mistral    â”‚          â”‚
â”‚            â”‚                     â”‚    API (allowlist)   â”‚          â”‚
â”‚            â”‚                     â”œâ”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”¼â”€â”€â–º WAN   â”‚
â”‚            â”‚                     â”‚                      â”‚          â”‚
â”‚            â”‚                     â”‚         âŒ BLOCKED   â”‚          â”‚
â”‚            â”‚                     â”‚                      â”‚          â”‚
â””â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”¼â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”¼â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”¼â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”˜
             â”‚                     â”‚                      â”‚
             â–¼                     â–¼                      â–¼
        Identity &            Agent Logic           Credential-Safe
        Mediation            & Orchestration         LLM Processing
```

### Component Specifications

| Component | Spec | Function | Security Role |
|-----------|------|----------|---------------|
| NC Server | CPX21 (3 vCPU, 4GB) | Nextcloud + Passwords + Talk | Identity, mediation, audit |
| MoltBot VM | CPX11 (2 vCPU, 2GB) | MoltAgent skill + broker | Agent execution, no secrets stored |
| Ollama VM | CPX31 (8 vCPU, 16GB) | Local LLM inference | Credential-sensitive operations |

### Network Segmentation Rules

**MANDATORY firewall configuration:**
- MoltBot VM â†’ NC Server: HTTPS (443), CalDAV, WebDAV, Passwords API only
- MoltBot VM â†’ Ollama VM: Port 11434 (Ollama API) only
- MoltBot VM â†’ External: Claude/Mistral API endpoints only (allowlist)
- Ollama VM â†’ External: **BLOCKED** (no internet access)
- NC Server â†’ External: Standard HTTPS for updates, email

### Encryption Requirements

| Layer | Implementation | Notes |
|-------|----------------|-------|
| Disk (all VMs) | LUKS full-disk encryption | Key in Hetzner Robot, not on VM |
| NC Server-Side | SSE with per-file keys | Enable for Passwords app data |
| Transport | TLS 1.3 everywhere | No exceptions, even internal |
| NC Passwords | AES + optional master password | Enable client-side encryption |

### Monthly Cost

| Component | Specification | Monthly Cost |
|-----------|---------------|--------------|
| NC Server | CPX21 (3 vCPU, 4GB RAM) | ~â‚¬8 |
| Storage Box | 100GB for NC data | ~â‚¬5 |
| MoltBot VM | CPX11 (2 vCPU, 2GB RAM) | ~â‚¬4 |
| Ollama VM | CPX31 (8 vCPU, 16GB RAM) | ~â‚¬15 |
| **TOTAL** | | **~â‚¬32/month** |

---

## Credential Management

The credential management system is the core security innovation of MoltAgent.

### The Bootstrap Credential Problem

MoltAgent needs a credential to access the NC Passwords API. This is a potential single point of failure.

**DO NOT:** Store in environment variables, .env files, or config files.

**DO:** Use systemd LoadCredential= directive:

```ini
[Service]
LoadCredential=nc-passwords-token:/etc/credstore/moltagent

# Access in code via:
# fs.readFileSync(process.env.CREDENTIALS_DIRECTORY + '/nc-passwords-token')
```

### Runtime Credential Flow

For EVERY operation requiring external access:

1. Determine required credential name
2. Request from NC Passwords API (access logged automatically)
3. Verify credential was shared with moltagent user (fail if not)
4. Use credential for single operation
5. Immediately discard from memory (set to null, clear buffer)
6. Log operation completion

**No persistent tokens. No plain text files. Credentials exist in memory only during use.**

### Credential Categories

Organize in NC Passwords:

| Folder | Contents | Share Status |
|--------|----------|--------------|
| MoltAgent Core | NC Files, Calendar, Contacts | Shared with moltagent |
| MoltAgent Communication | Email IMAP/SMTP, Talk bot token | Shared with moltagent |
| MoltAgent LLM | Claude API, Mistral API, Ollama | Shared with moltagent |
| MoltAgent Integrations | Project-specific APIs | Shared selectively |
| RESTRICTED | Finance, HR, Admin credentials | **NEVER** shared with moltagent |

### The Panic Button

If breach suspected, execute in order:

1. **IMMEDIATE:** Unshare all credentials from moltagent user in NC Passwords
2. **IMMEDIATE:** Disable moltagent NC user account
3. Stop MoltBot service
4. Preserve logs before any changes
5. Rotate bootstrap credential
6. Audit access logs for scope of exposure
7. Rotate any credentials accessed during incident window

---

## LLM Routing Strategy

Route operations through appropriate LLM based on sensitivity:

| Operation Type | LLM | Rationale |
|----------------|-----|-----------|
| Complex reasoning, creative tasks | Claude API | Best quality, external |
| Operations involving credentials | Local Ollama | Secrets never leave server |
| Processing user-uploaded files | Local Ollama | Prompt injection isolation |
| Email/message drafting | Claude API | Quality matters, content sanitized |
| Summarizing sensitive documents | Local Ollama | Content stays local |

**The key insight:** External LLMs (Claude, GPT-4) provide superior quality but see your prompts. Local LLMs (Ollama) are less capable but fully private. Route intelligently based on what's in the prompt.

---

## Chat Interface Options

### Option A: NC Talk (Maximum Security)

| Security Aspect | Benefit |
|-----------------|---------|
| Authentication | Same NC user system with 2FA |
| Message signing | Built-in HMAC-SHA256 verification |
| Infrastructure | Your server only, no third parties |
| SIM swap risk | None (not phone-based) |
| Bot installation | Admin-only via OCC CLI |
| Audit logging | Integrated in NC activity log |
| Attack surface | Single system (NC only) |

**Implementation:**
```bash
occ talk:bot:install "MoltAgent" "<64-128 char secret>" \
  "https://moltbot-vm/webhook" "MoltAgent"
```

**Message verification (mandatory):**
```javascript
const digest = crypto.createHmac('sha256', SHARED_SECRET)
  .update(req.headers['x-nextcloud-talk-random'] + JSON.stringify(req.body))
  .digest('hex');

if (!crypto.timingSafeEqual(
  Buffer.from(digest),
  Buffer.from(req.headers['x-nextcloud-talk-signature'].toLowerCase())
)) {
  reject();
}
```

### Option B: Telegram/Signal (Convenience)

- Easier setup
- Better mobile experience
- Familiar interface
- Requires additional security measures:
  - User allowlist (only respond to approved user IDs)
  - Message signing (implement manually)
  - Rate limiting
  - Command timeout

**Trade-off:** More convenient but larger attack surface, second authentication system to manage.

---

## Prompt Injection Defenses

AI agents processing untrusted content are vulnerable to prompt injection. MoltAgent implements four-layer defense:

### A. Input Sanitization

Before any untrusted content reaches the LLM:
- Strip markdown formatting that could hide instructions
- Remove HTML comments and invisible characters
- Decode and inspect base64 content
- Flag content with instruction-like patterns

### B. Prompt Separation

- System prompt clearly delineates trusted vs untrusted content
- User content wrapped in explicit delimiters
- Instructions to ignore commands within user content
- Never concatenate trusted and untrusted without separation

### C. Human-in-the-Loop (HITL)

Require explicit confirmation for:
- Send emails (show draft first)
- Delete files (list files, require confirmation)
- Access new credential (alert first time)
- External API calls (log and alert)
- Modify calendar/contacts (show changes first)

### D. Output Verification

- Check LLM outputs against expected patterns before execution
- Reject outputs containing suspicious commands or URLs
- Log all LLM responses for forensic analysis

---

## Audit and Monitoring

Every security-relevant action must be logged. Logs protected from tampering, retained 90+ days.

### Log Sources

| Source | Events | Location |
|--------|--------|----------|
| NC Activity Log | File access, shares, user actions | NC database + /var/log/nextcloud |
| NC Passwords | Credential retrieval, share changes | Built-in access log |
| NC Talk | Bot commands, user messages | Talk activity log |
| MoltAgent | Operations, LLM calls, errors | /moltagent/Logs/ (NC folder) |
| System | SSH, auth failures, network | /var/log/auth.log, journald |

### Alert Conditions

Configure alerts for:
- Credential access outside normal hours
- Credential request rate > 50/hour (baseline ~20)
- Access to previously unused credential
- Failed authentication attempts > 5 in 10 minutes
- Bot commands from unrecognized user ID
- Prompt injection patterns detected
- LLM response containing suspicious patterns

---

## Threat Matrix

| Scenario | Vector | Impact | Mitigation |
|----------|--------|--------|------------|
| Bootstrap key theft | VM compromise, env dump | All shared credentials | systemd LoadCredential= |
| Prompt injection | Malicious file content | Unauthorized actions | Sanitization + HITL |
| Memory poisoning | Write to /Memory/ | Persistent manipulation | Memory integrity checks |
| NC Passwords vuln | App zero-day | Credential exposure | Update policy, monitoring |
| Talk session hijack | NC account compromise | Agent control | 2FA, user allowlist |
| LLM provider breach | External API compromise | Data in prompts exposed | Ollama for sensitive ops |

---

## Comparison: MoltAgent vs Alternatives

### vs Raw MoltBot

| Security Property | Raw MoltBot | MoltAgent |
|-------------------|-------------|-----------|
| Credentials encrypted at rest | âŒ | âœ… |
| Runtime credential requests | âŒ | âœ… |
| Per-operation access | âŒ | âœ… |
| One-click revocation | âŒ | âœ… |
| Granular permissions | âŒ | âœ… |
| Full audit trail | âŒ | âœ… |
| Chat interface security (signed messages) | âŒ | âœ… (NC Talk) |
| Prompt injection mitigations | âŒ | âœ… |
| Human-in-the-loop for sensitive ops | âŒ | âœ… |
| Local LLM for credential operations | âŒ | âœ… (Ollama) |
| Self-hosted | âœ… | âœ… |
| Open source | âœ… | âœ… |

### vs Native NC AI Assistant

| Aspect | NC AI Assistant | MoltAgent |
|--------|-----------------|-----------|
| LLM quality | Local/limited models | Claude + Ollama hybrid |
| Interface | NC UI only | NC Talk / Telegram / Signal |
| Proactive | No (reactive only) | Yes (cron jobs, monitoring) |
| External reach | NC ecosystem only | Web, email, any API |
| Memory | Session only | Persistent long-term |

---

## Business Model

### What's Open Source (Free)

- MoltAgent skill code
- NC Passwords integration
- Credential broker logic
- Documentation
- Setup guides

**Why free:** Builds community, creates trust, generates the funnel for services.

### What's Paid (Services)

| Service | Price | Description |
|---------|-------|-------------|
| **Setup Concierge** | â‚¬399 | Full 3-VM stack setup on customer's Hetzner |
| **Pro Setup** | â‚¬799 | Setup + custom integrations + training |
| **Managed Hosting** | â‚¬149/month | We run everything, they use it |
| **Custom Development** | â‚¬85/hour | Custom skills and integrations |
| **Security Audit** | â‚¬299 | Review and harden existing setup |
| **Priority Support** | â‚¬49/month | Fast response, direct access |

### Target Revenue (12 months)

| Source | Volume | Monthly Revenue |
|--------|--------|-----------------|
| Setup Concierge | 4/month | â‚¬1,600 |
| Pro Setup | 2/month | â‚¬1,600 |
| Managed Hosting | 15 clients | â‚¬2,235 |
| Custom work | 15 hrs/month | â‚¬1,275 |
| **Total** | | **â‚¬6,710/month** |

---

## Technical Roadmap

### MVP (v0.1)

- [ ] 3-VM infrastructure setup (NC, MoltBot, Ollama)
- [ ] MoltAgent NC user with folder structure
- [ ] Credential broker via NC Passwords API
- [ ] Bootstrap credential via systemd LoadCredential=
- [ ] File operations (inbox/outbox pattern)
- [ ] Basic audit logging
- [ ] NC Talk interface with message signing

### v0.2

- [ ] Calendar integration (CalDAV)
- [ ] Email integration (IMAP/SMTP)
- [ ] LLM routing (Claude vs Ollama)
- [ ] Prompt injection sanitization
- [ ] Human-in-the-loop confirmations
- [ ] Memory persistence in NC

### v0.3

- [ ] Telegram/Signal interface option
- [ ] NC Deck integration (task management)
- [ ] Progressive trust UI
- [ ] Alert system for anomalies
- [ ] Setup wizard

### v1.0

- [ ] Full documentation
- [ ] One-click installer
- [ ] Admin dashboard
- [ ] Comprehensive test suite
- [ ] Security audit completed

---

## Implementation Checklist

### Infrastructure
- [ ] LUKS full-disk encryption on all VMs
- [ ] Firewall rules enforcing network segmentation
- [ ] Ollama VM has no internet access
- [ ] TLS 1.3 on all connections
- [ ] NC Server-Side Encryption enabled

### Nextcloud Configuration
- [ ] moltagent user created with minimal group membership
- [ ] NC Passwords app installed, client-side encryption enabled
- [ ] NC Talk bot installed via OCC
- [ ] Dedicated Talk room for MoltAgent commands
- [ ] 2FA enforced for all users
- [ ] RESTRICTED credential folder exists and is NOT shared

### MoltAgent Code
- [ ] Bootstrap credential via systemd LoadCredential=
- [ ] All credentials discarded immediately after use
- [ ] NC Talk message signature verification
- [ ] User allowlist enforced
- [ ] Input sanitization for untrusted content
- [ ] Human-in-the-loop for sensitive operations
- [ ] LLM routing based on operation sensitivity
- [ ] Comprehensive logging to /moltagent/Logs/

### Monitoring
- [ ] Uptime monitoring configured
- [ ] Alert conditions configured
- [ ] Log retention policy (90+ days)
- [ ] Daily log backup to separate storage
- [ ] Incident response procedure documented

### Testing
- [ ] Panic button procedure tested quarterly
- [ ] Prompt injection test suite run monthly
- [ ] Credential rotation tested
- [ ] Backup restoration tested

---

## Go-to-Market Strategy

### Phase 1: Build & Validate (Weeks 1-4)

- [ ] Set up 3-VM infrastructure on Hetzner
- [ ] Implement credential broker with NC Passwords
- [ ] Implement NC Talk interface with signing
- [ ] Test core flows (files, calendar, email)
- [ ] Document the setup process
- [ ] Validate with personal use

### Phase 2: Soft Launch (Weeks 5-8)

- [ ] Create landing page at moltagent.cloud
- [ ] Publish GitHub repo
- [ ] Write launch blog post
- [ ] Post to r/selfhosted, r/nextcloud
- [ ] Share in Moltbot community
- [ ] Collect feedback, iterate

### Phase 3: Service Launch (Weeks 9-12)

- [ ] Productize setup process
- [ ] Create service packages
- [ ] First paying customers
- [ ] Case studies / testimonials
- [ ] Refine based on customer needs

### Marketing Angles

**For privacy crowd:**
> "Your AI assistant that never phones home. Self-hosted. Open source. Your data stays yours."

**For security crowd:**
> "Runtime credential mediation. Network-isolated LLM routing. Cryptographically signed commands. This is how AI agents should work."

**For Nextcloud users:**
> "Turn your Nextcloud into an AI-powered workspace. MoltAgent lives in your cloud like a digital employee."

**For MoltBot users:**
> "Love MoltBot but worried about security? MoltAgent adds the trust layer."

---

## The Vision

> "MoltAgent lives in your Nextcloud like a ghost in the machine. It has a room, a mailbox, a desk, and a calendar. It doesn't snoop â€” it waits in shared spaces, ready to help when you bring something to it.
>
> You CC it on emails like a junior colleague. You drop files in its inbox. You assign it tasks. It remembers everything you've shared. It forgets what you haven't.
>
> It's not AI with access to your company. It's your company's digital employee â€” with the same permission boundaries as any new hire, and better security hygiene than most humans."

---

## Appendix A: Name Etymology

**MoltAgent** â€” a wordplay on the Catalan phrase "molta gent" (many people):

1. **Molt** â€” From MoltBot, named after the Lobster shell (molt = to shed an outer layer)
2. **Agent** â€” An AI agent that acts autonomously
3. **"Molta gent"** â€” Catalan for "many people"

The name captures three ideas:
- **Technical heritage:** Built on MoltBot
- **Workforce multiplier:** Like having many people on your team
- **Community ethos:** Built by many, for many â€” open source at its core

---

## Appendix B: Document History

| Version | Date | Changes |
|---------|------|---------|
| 0.1 | 2026-01-30 | Initial draft |
| 0.2 | 2026-01-30 | Corrected Catalan etymology, added workforce interpretation |
| 0.3 | 2026-01-30 | Incorporated Security Specification v1.0: 3-VM architecture, NC Talk, LLM routing, prompt injection defenses, threat matrix, implementation checklist |

---

## How to Use This Document

**For new chat sessions with AI assistants:**
Paste this document at the start of the conversation to provide full context.

**For human collaborators:**
Share as the project overview and technical specification.

**For investors/partners:**
Use Executive Summary + Business Model + Vision sections.

**For developers:**
Focus on Infrastructure Architecture + Credential Management + Implementation Checklist.

**For security review:**
Reference this alongside the detailed Security Specification v1.0.

---

*This document is the authoritative briefing for the MoltAgent project. It should be provided to any new team member, AI assistant, or collaborator as the starting context for understanding the project.*
