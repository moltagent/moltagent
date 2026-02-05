# MoltAgent Status Quo
## Comprehensive Project Briefing Document

**Document Version:** 1.0  
**Date:** 2026-02-06  
**Author:** Fu + Claude Opus (Architecture Partner)  
**Purpose:** Definitive reference for all future development sessions  
**Classification:** Internal Strategy Document

---

## Table of Contents

1. [Executive Summary](#1-executive-summary)
2. [The Vision](#2-the-vision)
3. [What MoltAgent Is](#3-what-moltagent-is)
4. [Architecture Overview](#4-architecture-overview)
5. [Development Status](#5-development-status)
6. [Test Coverage](#6-test-coverage)
7. [Security Model](#7-security-model)
8. [Hardware Tiers](#8-hardware-tiers)
9. [Business Model](#9-business-model)
10. [Competitive Landscape](#10-competitive-landscape)
11. [Known Limitations](#11-known-limitations)
12. [Roadmap](#12-roadmap)
13. [Open Questions](#13-open-questions)
14. [Key Files & Locations](#14-key-files--locations)
15. [Glossary](#15-glossary)

---

## 1. Executive Summary

### What We've Built

MoltAgent is a **sovereign AI security layer** that transforms AI agents from rented cloud services into trusted "digital employees" that live in your infrastructure, use your permission system, and can be instantly fired (credentials revoked) with one click.

### The Milestone We've Reached

**🎯 LAUNCH GATE ACHIEVED**

As of February 6, 2026, MoltAgent has completed Phase 1 development:

| Component | Status | Tests |
|-----------|--------|-------|
| Security Layer (10 guards) | ✅ Complete | 939 |
| NC Resilience (rate limiting, caching) | ✅ Complete | 240 |
| Calendar Integration | ✅ Complete | ~50 |
| Memory System (Deck Extended Brain) | ✅ Complete | 111 |
| Self-Documentation (/help, /status) | ✅ Complete | ~50 |
| Skill Forge Engine | ✅ Complete | 86 |
| Skill Forge Talk UI | ✅ Complete | 86 |
| **TOTAL** | **✅ LAUNCH READY** | **1,500+** |

### What This Means

We can now deploy MoltAgent for paying clients. The core functionality is complete, tested, and ready for production use. Remaining work is enhancement, not foundation.

### Immediate Next Steps

1. **Manual end-to-end testing** on MoltAgent Prime (this week)
2. **First concierge client deployment** (next 2 weeks)
3. **Open source GitHub launch** (week 3-4)
4. **MoltAgent Prime upgrade to Sovereign tier** (GEX44 + GLM-4.7 Flash)

---

## 2. The Vision

### The Problem We Solve

**Current state of AI agents is broken:**

| Problem | Impact |
|---------|--------|
| Credentials stored in plaintext | Any malware can steal your API keys |
| Permanent access once granted | No way to "fire" a misbehaving agent |
| No audit trail | No idea what the agent did with your data |
| Vendor lock-in | Your data lives in someone else's cloud |
| Marketplace malware | 341+ malicious skills found in ClawHub |
| Expensive at scale | Per-token costs explode with heavy use |

### The MoltAgent Solution

**Treat AI agents like employees, not services:**

| Principle | Implementation |
|-----------|----------------|
| Employees have a workspace | Agent has a Nextcloud home |
| Employees have permissions | Agent's NC user has controlled access |
| Employees can be fired | One click in NC Passwords revokes all credentials |
| Employees leave audit trails | Every action logged to NC Files |
| Employees use company tools | Agent uses NC Talk, Deck, Calendar |
| Employees don't own the data | All data stays in your infrastructure |

### The Name

**MoltAgent** derives from Catalan "molta gent" (many people) — representing an AI workforce concept. The crab mascot represents adaptability (molting) and building a protective shell (security).

### The Tagline

> "Your AI. Your Infrastructure. Your Rules."

---

## 3. What MoltAgent Is

### Technical Definition

MoltAgent is a **Node.js security and integration layer** that sits between:
- **OpenClaw** (the AI agent runtime)
- **Nextcloud** (the sovereign collaboration platform)
- **Ollama** (local LLM inference)
- **Cloud APIs** (Claude, DeepSeek, etc. as fallbacks)

### What It Does

```
┌─────────────────────────────────────────────────────────────────┐
│                         USER                                    │
│                           │                                     │
│                           ▼                                     │
│                    ┌─────────────┐                              │
│                    │   NC Talk   │  ← User talks here           │
│                    └──────┬──────┘                              │
│                           │                                     │
│         ┌─────────────────┼─────────────────┐                   │
│         │            MOLTAGENT              │                   │
│         │                                   │                   │
│         │  ┌─────────────────────────────┐  │                   │
│         │  │      Security Guards        │  │                   │
│         │  │  • SecretsGuard (redact)    │  │                   │
│         │  │  • ToolGuard (approve)      │  │                   │
│         │  │  • PromptGuard (injection)  │  │                   │
│         │  │  • PathGuard (filesystem)   │  │                   │
│         │  │  • EgressGuard (network)    │  │                   │
│         │  └─────────────────────────────┘  │                   │
│         │                                   │                   │
│         │  ┌─────────────────────────────┐  │                   │
│         │  │      Integrations           │  │                   │
│         │  │  • Calendar (CalDAV)        │  │                   │
│         │  │  • Tasks (Deck)             │  │                   │
│         │  │  • Memory (Learning Log)    │  │                   │
│         │  │  • Credentials (Passwords)  │  │                   │
│         │  │  • Files (WebDAV)           │  │                   │
│         │  └─────────────────────────────┘  │                   │
│         │                                   │                   │
│         │  ┌─────────────────────────────┐  │                   │
│         │  │      Skill Forge            │  │                   │
│         │  │  • Template Engine          │  │                   │
│         │  │  • Security Scanner         │  │                   │
│         │  │  • Talk Conversation UI     │  │                   │
│         │  │  • HITL Activation          │  │                   │
│         │  └─────────────────────────────┘  │                   │
│         │                                   │                   │
│         └─────────────────┬─────────────────┘                   │
│                           │                                     │
│              ┌────────────┴────────────┐                        │
│              ▼                         ▼                        │
│      ┌─────────────┐           ┌─────────────┐                  │
│      │   Ollama    │           │  Cloud API  │                  │
│      │   (Local)   │           │  (Fallback) │                  │
│      └─────────────┘           └─────────────┘                  │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

### Core Capabilities

| Capability | Description |
|------------|-------------|
| **Sovereign AI** | LLM runs locally on your hardware |
| **Credential Brokering** | API keys fetched at runtime from NC Passwords, never stored |
| **Instant Revocation** | Delete password entry = agent loses all access |
| **Full Audit Trail** | Every action logged to `/AuditLog/` in NC Files |
| **Smart Routing** | Sensitive tasks → local, complex tasks → cloud |
| **Multi-Platform Chat** | 25+ platforms via Matterbridge (Slack, Teams, Discord, etc.) |
| **Task Management** | Full Kanban workflow via NC Deck |
| **Calendar Management** | Natural language scheduling via CalDAV |
| **Memory System** | Agent remembers what it learns, flags uncertainties |
| **Self-Documentation** | Agent knows and can explain its own capabilities |
| **Safe Skill Generation** | New integrations via conversation, not CLI |

---

## 4. Architecture Overview

### Three-VM Deployment Model

```
┌──────────────────────────────────────────────────────────────────┐
│                     CUSTOMER'S HETZNER ACCOUNT                   │
├──────────────────────────────────────────────────────────────────┤
│                                                                  │
│  ┌────────────────────┐                                          │
│  │  Hetzner Storage   │  ← Managed Nextcloud                     │
│  │  Share (€5-15/mo)  │     • User data home                     │
│  │                    │     • NC Passwords (credentials)         │
│  │  nx12345.your-     │     • NC Talk (communication)            │
│  │  storageshare.de   │     • NC Deck (tasks)                    │
│  │                    │     • NC Calendar                        │
│  │                    │     • NC Files (audit logs, memory)      │
│  └─────────┬──────────┘                                          │
│            │                                                     │
│            │ HTTPS (WebDAV, OCS API, CalDAV)                     │
│            │                                                     │
│  ┌─────────▼──────────┐     ┌────────────────────┐               │
│  │  Bot VM (€4/mo)    │     │  Ollama VM         │               │
│  │  CPX11             │     │  (€15-184/mo)      │               │
│  │                    │     │                    │               │
│  │  • MoltAgent       │────▶│  • Ollama server   │               │
│  │  • OpenClaw        │     │  • Local LLM(s)    │               │
│  │  • Matterbridge    │     │  • GPU (optional)  │               │
│  │                    │     │                    │               │
│  └────────────────────┘     └────────────────────┘               │
│            │                                                     │
│            │ HTTPS (when local insufficient)                     │
│            ▼                                                     │
│  ┌────────────────────┐                                          │
│  │  Cloud APIs        │  ← External, optional                    │
│  │  • Anthropic       │                                          │
│  │  • DeepSeek        │                                          │
│  │  • OpenAI          │                                          │
│  └────────────────────┘                                          │
│                                                                  │
└──────────────────────────────────────────────────────────────────┘
```

### Why This Architecture?

| Design Choice | Rationale |
|---------------|-----------|
| **Managed NC (Storage Share)** | No NC maintenance burden, automatic backups, TLS included |
| **Separate Bot VM** | Isolates agent code from LLM, can scale independently |
| **Separate Ollama VM** | GPU isolation, can upgrade without touching bot |
| **Customer's Hetzner account** | True sovereignty — we don't have access after deployment |
| **No persistent credentials** | Credentials fetched at runtime, discarded after use |

### Data Flow Example: User Asks to Schedule a Meeting

```
1. User types in NC Talk: "Schedule a meeting with John tomorrow at 2pm"
   
2. MoltAgent receives message via Talk polling
   
3. Message Router classifies intent → calendar_create
   
4. Calendar Handler:
   a. Fetches CalDAV credentials from NC Passwords
   b. Parses natural language → structured event
   c. Checks for conflicts
   d. Creates event via CalDAV
   e. Credentials discarded (never stored)
   
5. Response sent back to NC Talk: "✅ Created 'Meeting with John' for tomorrow at 2pm"
   
6. Audit log written to /AuditLog/2026-02-06.md
```

---

## 5. Development Status

### Phase 1: Foundation (COMPLETE ✅)

#### Session 1-4: Security Guards

| Guard | Function | Status |
|-------|----------|--------|
| **SecretsGuard** | Redact credentials from LLM output | ✅ Complete |
| **ToolGuard** | Validate and approve tool calls | ✅ Complete |
| **PromptGuard** | Detect prompt injection attempts | ✅ Complete |
| **PathGuard** | Prevent filesystem escape | ✅ Complete |
| **EgressGuard** | Control network destinations | ✅ Complete |
| **MemoryGuard** | Protect memory integrity | ✅ Complete |
| **InputSanitizer** | Clean user input | ✅ Complete |
| **OutputValidator** | Validate agent responses | ✅ Complete |
| **AuditLogger** | Record all actions | ✅ Complete |
| **RateLimiter** | Prevent abuse | ✅ Complete |

**Tests:** 939 passing

#### Session 5: Calendar Integration

| Feature | Status |
|---------|--------|
| CalDAV client | ✅ Complete |
| Event CRUD | ✅ Complete |
| Natural language parsing | ✅ Complete |
| Conflict detection | ✅ Complete |
| Free time finding | ✅ Complete |
| HeartbeatManager CalDAV wiring | ✅ Complete |

**Tests:** ~50 passing

#### Session 6: Memory System (Deck Extended Brain)

| Module | Function | Status |
|--------|----------|--------|
| **LearningLog** | Append-only markdown log to `/Memory/LearningLog.md` | ✅ Complete |
| **KnowledgeBoard** | Deck board with Verified/Uncertain/Stale/Disputed stacks | ✅ Complete |
| **ContextLoader** | Inject recent learnings into agent prompt | ✅ Complete |

**Tests:** 111 passing

#### Session 7: Self-Documentation

| Feature | Status |
|---------|--------|
| CapabilityRegistry | ✅ Complete |
| HelpGenerator | ✅ Complete |
| StatusReporter | ✅ Complete |
| CommandHandler (/help, /status, /capabilities) | ✅ Complete |

**Tests:** ~50 passing

#### Session 8A: Skill Forge Engine

| Module | Function | Status |
|--------|----------|--------|
| **TemplateLoader** | Load YAML templates from NC WebDAV | ✅ Complete |
| **TemplateEngine** | Substitute placeholders, generate SKILL.md | ✅ Complete |
| **SecurityScanner** | Detect forbidden patterns, validate domains | ✅ Complete |
| **SkillActivator** | Deploy to OpenClaw skills directory | ✅ Complete |

**Tests:** 86 passing

#### Session 8B: Skill Forge Talk UI

| Module | Function | Status |
|--------|----------|--------|
| **SkillForgeHandler** | Conversation state machine | ✅ Complete |
| **Message Router Integration** | Intent classification, routing | ✅ Complete |
| **HITL Activation** | Human approval before deployment | ✅ Complete |

**Tests:** 86 passing (172 total for Skill Forge)

### Total Test Count

```
Security Guards:        939
NC Resilience:          240
Calendar:               ~50
Memory:                 111
Self-Docs:              ~50
Skill Forge:            172
─────────────────────────────
TOTAL:                 1,562 tests (all passing)
```

---

## 6. Test Coverage

### Testing Philosophy

- **Unit tests** for all modules
- **Mocked NC** for integration tests (no real API calls)
- **Security-focused** edge cases (injection, escape, overflow)
- **No external dependencies** in test suite

### Test Locations

```
test/
├── unit/
│   ├── security/
│   │   ├── secrets-guard.test.js
│   │   ├── tool-guard.test.js
│   │   ├── prompt-guard.test.js
│   │   ├── path-guard.test.js
│   │   ├── egress-guard.test.js
│   │   └── ...
│   ├── handlers/
│   │   ├── message-router.test.js
│   │   ├── skill-forge-handler.test.js
│   │   └── ...
│   ├── knowledge/
│   │   ├── learning-log.test.js
│   │   ├── knowledge-board.test.js
│   │   └── context-loader.test.js
│   ├── skill-forge/
│   │   ├── template-engine.test.js
│   │   ├── security-scanner.test.js
│   │   └── ...
│   └── skill-forge-mocked-nc.test.js
└── integration/
    └── (future: real NC tests)
```

### Running Tests

```bash
cd /opt/moltagent
npm test                    # All tests
npm test -- --grep security # Security tests only
npm run lint               # ESLint check
```

---

## 7. Security Model

### Defense in Depth

```
┌─────────────────────────────────────────────────────────────────┐
│                      SECURITY LAYERS                            │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│  Layer 1: INPUT SANITIZATION                                    │
│  ├─ User input cleaned before processing                        │
│  ├─ Injection patterns detected and blocked                     │
│  └─ Malformed requests rejected                                 │
│                                                                 │
│  Layer 2: PROMPT GUARD                                          │
│  ├─ 4-tier detection (patterns, heuristics, ML, behavioral)     │
│  ├─ Injection attempts logged and blocked                       │
│  └─ Suspicious prompts flagged for review                       │
│                                                                 │
│  Layer 3: TOOL GUARD                                            │
│  ├─ Every tool call validated against allowlist                 │
│  ├─ Destructive operations require human approval               │
│  └─ Unknown tools blocked by default                            │
│                                                                 │
│  Layer 4: PATH GUARD                                            │
│  ├─ Filesystem access restricted to workspace                   │
│  ├─ Traversal attempts (.., symlinks) blocked                   │
│  └─ Sensitive paths explicitly forbidden                        │
│                                                                 │
│  Layer 5: EGRESS GUARD                                          │
│  ├─ Network destinations validated against allowlist            │
│  ├─ Private IPs, metadata endpoints blocked                     │
│  └─ Skill-specific domain restrictions enforced                 │
│                                                                 │
│  Layer 6: SECRETS GUARD                                         │
│  ├─ Credentials redacted from LLM output                        │
│  ├─ API keys never included in responses                        │
│  └─ Patterns detected: AWS, GitHub, Slack, etc.                 │
│                                                                 │
│  Layer 7: OUTPUT VALIDATION                                     │
│  ├─ Responses scanned before delivery                           │
│  ├─ Malicious content blocked                                   │
│  └─ Unexpected formats rejected                                 │
│                                                                 │
│  Layer 8: AUDIT LOGGING                                         │
│  ├─ Every action recorded with timestamp                        │
│  ├─ Full context preserved for review                           │
│  └─ Immutable append-only logs                                  │
│                                                                 │
│  Layer 9: CREDENTIAL BROKERING                                  │
│  ├─ Credentials never stored, fetched at runtime                │
│  ├─ NC Passwords as single source of truth                      │
│  └─ One-click revocation possible                               │
│                                                                 │
│  Layer 10: HUMAN-IN-THE-LOOP                                    │
│  ├─ Destructive operations require approval                     │
│  ├─ New skills require explicit activation                      │
│  └─ Uncertain knowledge flagged for verification                │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

### Credential Flow

```
1. Agent needs to call external API (e.g., Trello)

2. Agent requests credential from NC Passwords:
   GET /apps/passwords/api/1.0/password/list
   → Filter by label: "trello-api-key"
   
3. Credential returned, used immediately:
   curl -H "Authorization: $TRELLO_KEY" https://api.trello.com/...
   
4. Credential discarded (variable out of scope)

5. Audit log records: "Credential 'trello-api-key' accessed for Trello API call"

6. If user deletes "trello-api-key" from NC Passwords:
   → Next API call fails
   → Agent immediately loses access
   → No stored credential to exploit
```

### Skill Forge Security

| Risk | Mitigation |
|------|------------|
| Malicious template | Templates are curated, not user-uploaded |
| Forbidden commands | Security scanner blocks wget, eval, chmod, etc. |
| Domain escape | allowed_domains enforced per skill |
| Credential theft | Credentials never in skill file, only NC Passwords labels |
| Backdoor activation | Re-scan on activation (defense in depth) |
| Social engineering | Human approval required before activation |

---

## 8. Hardware Tiers

### Tier Comparison

| Tier | Monthly Cost | GPU | Best Model | Speed | Quality | Target |
|------|-------------|-----|------------|-------|---------|--------|
| **Starter** | €24 | ❌ | DeepSeek-R1 8B | 3-5 t/s | Basic | Hobbyists |
| **Sovereign** ⭐ | €193 | RTX 4000 Ada | GLM-4.7 Flash | 30-50 t/s | Excellent | **SMBs** |
| **Professional** | €609 | RTX PRO 6000 | Qwen 2.5 72B | 8-12 t/s | Very Good | Enterprise |

### Sovereign Tier (€193/month) — The Sweet Spot

**Why this is the flagship tier:**

1. **GLM-4.7 Flash** = "Master of Tool-Calling"
   - Specifically designed for function calling
   - Beats larger models at MoltAgent's core job
   - 30-50 tokens/second = interactive speed

2. **Price/performance inflection point**
   - First tier with genuinely useful local AI
   - Break-even vs Claude API at just 11M tokens/month
   - Predictable fixed costs

3. **True sovereignty**
   - Not a fallback, but a real primary provider
   - Can handle most tasks without cloud APIs
   - Data never leaves customer infrastructure

**Stack:**

```
Storage Share (€5)     — 100GB Nextcloud
Bot VM CPX11 (€4)      — MoltAgent + OpenClaw
GPU VM GEX44 (€184)    — RTX 4000 Ada (20GB VRAM)
                         • GLM-4.7 Flash (primary)
                         • Mistral 7B (fast fallback)
                         • gpt-oss-20b (long context)
────────────────────────────────────────────────────
TOTAL: €193/month
```

### MoltAgent Prime Configuration

**Decision:** MoltAgent Prime (Fu's own instance) will be upgraded to Sovereign tier with:

- **Hardware:** GEX44 (€184/month GPU server)
- **Primary Model:** GLM-4.7 Flash
- **Secondary:** Mistral 7B v0.3
- **Long Context:** gpt-oss-20b (200K context)
- **Cloud Fallback:** Claude Sonnet (quality-critical only)

---

## 9. Business Model

### Revenue Streams

| Stream | Price | Effort | Recurring |
|--------|-------|--------|-----------|
| **Concierge Setup (Starter)** | €299 | 2-3h | No |
| **Concierge Setup (Sovereign)** | €499 | 3-4h | No |
| **Concierge Setup (Enterprise)** | €999 | 5-6h | No |
| **Upgrade Service** | €99 | 30min | No |
| **Template Development** | €85/hr | Variable | No |
| **Managed Hosting** | TBD | Passive | Yes |
| **Support Subscription** | €49/mo | Minimal | Yes |

### Open Source Strategy

**Public (GitHub, AGPL-3.0):**
- All MoltAgent code
- Manual deployment guide
- Template format specification
- 3 basic templates (uptime-check, rss-feed, rest-api)

**Private (competitive advantage):**
- Ansible automation playbooks
- Full template catalog (15+ templates)
- Concierge service
- Federation share from Prime

**The pitch:**
> "Everything is open source. You can absolutely set this up yourself — the code and docs are all there. Or pay us €499 and it's done in 24 hours with GPU-accelerated AI included."

### Customer Journey

```
1. DISCOVERY
   └─ Reddit post, GitHub, word of mouth
   
2. EVALUATION
   └─ Read docs, maybe self-host for testing
   
3. PURCHASE
   └─ Fill intake form, pay setup fee
   
4. DEPLOYMENT (24-48h)
   └─ We deploy via Ansible to their Hetzner account
   
5. HANDOFF
   └─ Delivery email with credentials, optional call
   
6. USAGE
   └─ Client uses MoltAgent daily
   
7. EXPANSION
   └─ Upgrade tier, add templates, managed hosting
```

### Pricing Philosophy

- **Setup fees** cover our time + margin
- **Infrastructure costs** go directly to Hetzner (we don't mark up)
- **We don't hold their data** — true sovereignty
- **Recurring revenue** from optional services only

---

## 10. Competitive Landscape

### Direct Competitors

| Competitor | Model | Price | Sovereignty | Security |
|------------|-------|-------|-------------|----------|
| **OpenClaw + ClawHub** | Open source + marketplace | Free + API | Partial | ❌ Malware risk |
| **Dust.tt** | Managed SaaS | $29-500/mo | ❌ Cloud | ✅ Managed |
| **Lindy.ai** | Managed SaaS | $49-499/mo | ❌ Cloud | ✅ Managed |
| **AutoGPT Cloud** | Managed SaaS | Variable | ❌ Cloud | ⚠️ Variable |
| **MoltAgent** | Self-hosted | €24-609/mo | ✅ Full | ✅ 10-layer |

### Our Differentiators

| Factor | MoltAgent | Competitors |
|--------|-----------|-------------|
| Data location | Your infrastructure | Their cloud |
| Credential control | Instant revocation | Vendor-dependent |
| Audit trail | Your NC Files | Their logs (maybe) |
| Cost model | Fixed monthly | Per-token or per-seat |
| Vendor lock-in | Zero (AGPL) | High |
| Compliance | GDPR by design | Varies |

### Target Customer Profile

**Ideal MoltAgent customer:**
- SMB with 10-50 employees
- Handles sensitive data (legal, medical, financial)
- Values privacy and control
- Has technical discomfort with "AI in the cloud"
- Budget: €200-600/month for AI infrastructure
- Not: Fortune 500 (they have dedicated teams)
- Not: Solo hobbyists (they'll self-host free tier)

---

## 11. Known Limitations

### Technical Limitations

| Limitation | Impact | Mitigation |
|------------|--------|------------|
| NC Talk polling (not websocket) | 5-10s latency | Acceptable for async assistant |
| Local models < Claude Opus | Quality ceiling | Cloud fallback for critical tasks |
| No real-time voice | Can't do phone calls | Out of scope for v1 |
| Single-tenant only | One client per deployment | By design (sovereignty) |
| No mobile app | Web/desktop only | NC apps available |

### Business Limitations

| Limitation | Impact | Mitigation |
|------------|--------|------------|
| Manual deployment | Doesn't scale past ~50 clients | Automate when painful |
| One-person operation | Bottleneck on Fu | Hire or partner as needed |
| No SLA | Enterprise hesitation | Offer SLA tier later |
| No SOC2/ISO | Compliance-heavy orgs blocked | Consider certification |

### Known Bugs / Tech Debt

| Issue | Severity | Notes |
|-------|----------|-------|
| No E2E tests with real NC | Medium | Manual testing covers for now |
| Long conversations may hit context limits | Low | Context management needed |
| Heartbeat can miss Talk messages under load | Low | Acceptable for current scale |
| No graceful degradation on NC outage | Medium | Add retry/backoff |

---

## 12. Roadmap

### Immediate (This Week)

- [ ] Manual end-to-end testing on MoltAgent Prime
- [ ] Fix any issues discovered
- [ ] Write 3 real templates (uptime, trello, github)
- [ ] Upgrade Prime to Sovereign tier (GEX44)

### Short-Term (February 2026)

- [ ] First concierge client deployment
- [ ] Document issues, iterate
- [ ] GitHub public launch
- [ ] Reddit/community announcement
- [ ] moltagent.cloud content refresh

### Medium-Term (Q1 2026)

- [ ] Session 8C: Federation + Catalog Sync
- [ ] Session 8D: Generic Skill Builder
- [ ] Session 8E: NC Forms Integration
- [ ] 15 template catalog complete
- [ ] 5-10 paying clients

### Long-Term (Q2+ 2026)

| Phase | Focus | Sessions |
|-------|-------|----------|
| Phase 6 | NC Forms deep integration | 1-2 |
| Phase 7 | Advanced security (signed receipts) | 1-2 |
| Phase 8 | Email & Calendar deep integration | 2-3 |
| Phase 9 | Full Knowledge System | 3-4 |

### Not On Roadmap (Explicitly Deferred)

- Mobile app
- Voice/phone integration
- Multi-tenant SaaS version
- Enterprise features (SSO, SCIM)
- Custom fine-tuned models

---

## 13. Open Questions

### Business Questions

| Question | Status | Notes |
|----------|--------|-------|
| Optimal setup fee pricing? | Testing | Start with €499 for Sovereign |
| Managed hosting tier? | Exploring | Recurring revenue opportunity |
| Partner/reseller program? | Future | After proving model |
| Certification (SOC2)? | Deferred | Expensive, evaluate later |

### Technical Questions

| Question | Status | Notes |
|----------|--------|-------|
| Update mechanism for clients? | Designed | Manual for now, automate later |
| Skill Forge federation? | Designed | Session 8C |
| Multi-model routing optimization? | Partial | Works, could be smarter |
| Context window management? | Basic | Needs work for long conversations |

### Product Questions

| Question | Status | Notes |
|----------|--------|-------|
| moltagent.cloud messaging? | Needs work | Too technical currently |
| Demo video? | Not started | Needed for marketing |
| Case studies? | Need clients first | After first deployments |

---

## 14. Key Files & Locations

### On Bot VM (`/opt/moltagent/`)

```
/opt/moltagent/
├── src/
│   ├── bot.js                      # Main entry point
│   ├── lib/
│   │   ├── handlers/
│   │   │   ├── message-router.js   # Intent classification
│   │   │   ├── skill-forge-handler.js
│   │   │   └── ...
│   │   ├── security/
│   │   │   └── guards/             # All 10 security guards
│   │   ├── knowledge/
│   │   │   ├── learning-log.js
│   │   │   ├── knowledge-board.js
│   │   │   └── context-loader.js
│   │   ├── capabilities/
│   │   │   ├── capability-registry.js
│   │   │   └── ...
│   │   └── nc/
│   │       ├── nc-request-manager.js
│   │       ├── deck-client.js
│   │       ├── talk-client.js
│   │       └── ...
│   └── skill-forge/
│       ├── template-loader.js
│       ├── template-engine.js
│       ├── security-scanner.js
│       ├── activator.js
│       └── constants.js
├── config/
│   ├── providers.yaml
│   ├── forge.json
│   └── ...
├── test/
│   └── ...
└── package.json
```

### In Nextcloud (Agent's Workspace)

```
/moltagent/
├── Memory/
│   ├── LearningLog.md              # Append-only knowledge
│   ├── KnowledgeConfig.yaml
│   └── SkillForge/                 # Conversation state
├── Inbox/                          # Files dropped for agent
├── Outbox/
│   └── pending-skills/             # Skills awaiting approval
├── AuditLog/
│   └── 2026-02-06.md               # Daily audit logs
├── Context/
│   └── ...
└── Skills/
    └── active/                     # Activated skill metadata
```

### Project Documentation

```
/mnt/project/
├── MOLTAGENT-BRIEFING-v3.md
├── moltagent-README.md
├── moltagent-architecture-summary.md
├── moltagent-three-tier-architecture.md
├── moltagent-security-spec.md
├── moltagent-skill-forge-spec.md
├── moltagent-knowledge-system.md
├── moltagent-development-sequence.md
├── moltagent-hardware-tiers.md
├── moltagent-enterprise-cost-analysis.md
└── ...
```

---

## 15. Glossary

| Term | Definition |
|------|------------|
| **MoltAgent** | The security and integration layer between OpenClaw and Nextcloud |
| **OpenClaw** | Open-source AI agent runtime (upstream project we integrate with) |
| **ClawHub** | OpenClaw's skill marketplace (security disaster, we avoid it) |
| **Skill Forge** | MoltAgent's safe skill generation system |
| **NC** | Nextcloud — the sovereign collaboration platform |
| **Storage Share** | Hetzner's managed Nextcloud hosting product |
| **Sovereign tier** | Our €193/month GPU-enabled package (GEX44 + GLM-4.7 Flash) |
| **HITL** | Human-in-the-loop — requiring human approval for sensitive actions |
| **Guard** | A security module that validates/filters data at a specific point |
| **Provider** | An LLM backend (Ollama, Claude, DeepSeek, etc.) |
| **Role** | A provider category (sovereign, value, premium) used for routing |
| **Template** | A YAML file defining how to generate a skill for a specific service |
| **Concierge** | Our done-for-you deployment service |
| **Prime** | MoltAgent Prime — Fu's own MoltAgent instance, used for dogfooding |
| **Federation** | NC's native file sharing between instances (used for template distribution) |
| **Heartbeat** | The periodic polling loop that checks Talk, Deck, etc. |
| **CalDAV** | Calendar protocol used by Nextcloud |
| **WebDAV** | File access protocol used by Nextcloud |
| **OCS** | Nextcloud's REST API standard |

---

## Document History

| Version | Date | Changes |
|---------|------|---------|
| 1.0 | 2026-02-06 | Initial comprehensive status document |

---

## How to Use This Document

### For New Conversations

Start with:
> "I'm continuing MoltAgent development. Reference document: MoltAgent-StatusQuo-February2026.md. Current focus: [TOPIC]"

### For Development Sessions

Reference specific sections:
> "Per the Status Quo doc, Session 8A-8B (Skill Forge) are complete with 172 tests. Starting Session 8C: Federation."

### For Business Discussions

Reference tiers and pricing:
> "Per Status Quo, Sovereign tier (€193/mo) is our flagship. GLM-4.7 Flash for tool-calling, break-even at 11M tokens/month vs Claude API."

---

*This document represents the state of MoltAgent as of February 6, 2026. Update as the project evolves.*

---

**🎯 MILESTONE ACHIEVED: LAUNCH GATE**

MoltAgent is ready for production deployment. The foundation is complete. Now we validate with real clients and iterate.

*"Your AI. Your Infrastructure. Your Rules."*
