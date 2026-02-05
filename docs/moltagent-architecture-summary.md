# MoltAgent: Complete Architecture Summary

**Version:** 1.0  
**Date:** 2026-02-02  
**Status:** Architecture Defined

---

## What MoltAgent Is

MoltAgent is an open-source security and resilience layer that transforms AI agents into trustworthy digital employees. It uses Nextcloud as the agent's home and permission system, with a pluggable multi-provider LLM architecture designed for cost control and failure resilience.

**Core differentiators:**
1. **Security:** Credential brokering, not storage. Instant revocation.
2. **Sovereignty:** Your infrastructure, your data, your rules.
3. **Resilience:** Local fallback always available. Never goes dark.
4. **Cost control:** Intelligent routing minimizes spend. Hard budgets.
5. **Transparency:** Users always know what's happening and why.

---

## Architecture Overview

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                           MOLTAGENT ARCHITECTURE                            │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│  USER                                                                       │
│    │                                                                        │
│    ▼                                                                        │
│  ┌─────────────────┐                                                        │
│  │   NC Talk /     │  Chat interface with signed messages                   │
│  │   Telegram      │                                                        │
│  └────────┬────────┘                                                        │
│           │                                                                 │
│           ▼                                                                 │
│  ┌─────────────────────────────────────────────────────────────────────┐   │
│  │                        MOLTAGENT CORE                               │   │
│  │  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐  ┌────────────┐ │   │
│  │  │   Router    │  │  Credential │  │   Budget    │  │   User     │ │   │
│  │  │             │  │   Broker    │  │  Enforcer   │  │  Notifier  │ │   │
│  │  │ • Task      │  │             │  │             │  │            │ │   │
│  │  │   classify  │  │ • NC        │  │ • Daily     │  │ • Rate     │ │   │
│  │  │ • Provider  │  │   Passwords │  │   limits    │  │   limits   │ │   │
│  │  │   select    │  │ • Runtime   │  │ • Monthly   │  │ • Failover │ │   │
│  │  │ • Failover  │  │   fetch     │  │   limits    │  │ • Budget   │ │   │
│  │  │   chain     │  │ • Immediate │  │ • Override  │  │ • Errors   │ │   │
│  │  │             │  │   discard   │  │   support   │  │            │ │   │
│  │  └──────┬──────┘  └─────────────┘  └─────────────┘  └────────────┘ │   │
│  │         │                                                          │   │
│  │  ┌──────┴──────────────────────────────────────────────────────┐  │   │
│  │  │                    RESILIENCE LAYER                         │  │   │
│  │  │  ┌────────────┐  ┌────────────┐  ┌────────────┐            │  │   │
│  │  │  │ Rate Limit │  │  Circuit   │  │    Loop    │            │  │   │
│  │  │  │  Tracker   │  │  Breaker   │  │  Detector  │            │  │   │
│  │  │  └────────────┘  └────────────┘  └────────────┘            │  │   │
│  │  │  ┌────────────┐  ┌────────────┐  ┌────────────┐            │  │   │
│  │  │  │  Backoff   │  │   Task     │  │  Context   │            │  │   │
│  │  │  │  Strategy  │  │   Queue    │  │  Broker    │            │  │   │
│  │  │  └────────────┘  └────────────┘  └────────────┘            │  │   │
│  │  └─────────────────────────────────────────────────────────────┘  │   │
│  └───────────────────────────────────────────────────────────────────┘   │
│           │                                                             │
│           ▼                                                             │
│  ┌─────────────────────────────────────────────────────────────────────┐│
│  │                      PROVIDER LAYER                                 ││
│  │                                                                     ││
│  │  SOVEREIGN        FREE           VALUE          PREMIUM             ││
│  │  (Local)          (No cost)      (Cheap)        (Best)              ││
│  │  ┌─────────┐     ┌─────────┐    ┌─────────┐    ┌─────────┐         ││
│  │  │ Ollama  │     │   NC    │    │DeepSeek │    │ Claude  │         ││
│  │  │         │     │Assistant│    │ API     │    │ Opus    │         ││
│  │  └─────────┘     └─────────┘    └─────────┘    └─────────┘         ││
│  │  ┌─────────┐                    ┌─────────┐    ┌─────────┐         ││
│  │  │  LM     │                    │ Mistral │    │  GPT-   │         ││
│  │  │ Studio  │                    │  API    │    │  4.5    │         ││
│  │  └─────────┘                    └─────────┘    └─────────┘         ││
│  │       ▲                              ▲              ▲               ││
│  │       │                              │              │               ││
│  │       └──────── FALLBACK CHAIN ──────┴──────────────┘               ││
│  │                 (Always ends at local)                              ││
│  └─────────────────────────────────────────────────────────────────────┘│
│                                                                         │
│           │                                                             │
│           ▼                                                             │
│  ┌─────────────────────────────────────────────────────────────────────┐│
│  │                      NEXTCLOUD LAYER                                ││
│  │                                                                     ││
│  │  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐                 ││
│  │  │  Passwords  │  │    Files    │  │    Talk     │                 ││
│  │  │  (Creds)    │  │  (Storage)  │  │   (Chat)    │                 ││
│  │  └─────────────┘  └─────────────┘  └─────────────┘                 ││
│  │  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐                 ││
│  │  │  Calendar   │  │  Assistant  │  │   Audit     │                 ││
│  │  │  (CalDAV)   │  │  (Free AI)  │  │   (Logs)    │                 ││
│  │  └─────────────┘  └─────────────┘  └─────────────┘                 ││
│  └─────────────────────────────────────────────────────────────────────┘│
└─────────────────────────────────────────────────────────────────────────┘
```

---

## Document Index

### Core Specifications

| Document | Purpose | Key Contents |
|----------|---------|--------------|
| **MOLTAGENT-BRIEFING-v3.md** | Project overview | Vision, architecture, business model |
| **MoltAgent-Security-Specification-v1.0.docx** | Security architecture | Threat model, credential management, HITL |
| **moltagent-resilience-spec.md** | Failure handling | Rate limits, failover, queuing, loops |

### Supporting Documents

| Document | Purpose |
|----------|---------|
| **llm-router-guide.md** | LLM Router implementation guide (v2.0) |
| **moltagent-three-tier-architecture.md** | Original three-tier LLM routing |
| **moltagent-cost-optimization.md** | Cost control strategies |
| **moltagent-nc-assistant-integration.md** | Free tier integration guide |

---

## Key Design Decisions

### 1. Roles, Not Hardcoded Providers

**Decision:** Define roles (sovereign, free, value, premium) that users fill with their preferred providers.

**Rationale:** 
- EU companies need EU providers (Mistral, Aleph Alpha)
- Enterprise shops may be locked into Azure/OpenAI
- Privacy maximalists want local-only
- Sovereignty means choice

### 2. Local Fallback Always Available

**Decision:** Every fallback chain MUST end with a local provider.

**Rationale:**
- Local has no rate limits
- Local has no cost (fixed infrastructure)
- Local never "goes dark"
- Worst case = slower, not broken

### 3. Heartbeat is Local-Only

**Decision:** Monitoring/heartbeat operations never hit external APIs.

**Rationale:**
- Heartbeats are frequent (every 5 min = 288/day)
- Context loads are expensive (26K tokens typical)
- 8.5M tokens/day just for monitoring = bankruptcy
- Local scan + selective escalation = 95% cost reduction

### 4. Transparent Failure Communication

**Decision:** Always tell users what's happening. No ghost messages.

**Rationale:**
- "Bot stopped responding" destroys trust
- Users can make decisions with information
- Rate limits aren't failures, they're states
- Queued tasks should be visible

### 5. Hard Budget Enforcement

**Decision:** Budgets actually stop spending, not just warn.

**Rationale:**
- Warnings without enforcement are ignored
- "Override" option preserves user control
- Local fallback means work continues
- Predictable costs enable business planning

### 6. Cross-Provider Failover

**Decision:** Failover chains cross provider boundaries freely.

**Rationale:**
- OpenClaw bug: provider-level failure blocks entire chain
- If Claude is down, try Mistral, not just Claude Haiku
- Different providers have different failure modes
- Diversity = resilience

---

## Cost Model

### Infrastructure (Fixed Monthly)

| Component | Specification | Cost |
|-----------|---------------|------|
| NC Server | Hetzner Storage Share or CPX21 | €8-15 |
| MoltBot VM | CPX11 (2 vCPU, 2GB) | €4 |
| Ollama VM | CPX31 (8 vCPU, 16GB) | €15 |
| **Total Infrastructure** | | **€27-34** |

### API Usage (Variable)

| Tier | Provider Examples | Cost/1M tokens | Typical Use |
|------|-------------------|----------------|-------------|
| Sovereign | Ollama (local) | €0 (fixed) | Credentials, sensitive |
| Free | NC Assistant | €0 | Summaries, tags |
| Value | DeepSeek, Mistral Small | €0.14-0.25 | Workhorse tasks |
| Premium | Claude Sonnet, GPT-4o | €3-15 | Quality-critical |
| Ultra | Claude Opus, GPT-4.5 | €15-75 | Complex reasoning |

### Monthly Projections

| Profile | Infrastructure | API | **Total** |
|---------|---------------|-----|-----------|
| Privacy Max (local only) | €34 | €0 | **€34** |
| Cost Conscious | €30 | €10 | **€40** |
| Balanced | €30 | €30 | **€60** |
| Heavy User | €34 | €100 | **€134** |

---

## Implementation Priority

### Phase 1: Core Infrastructure (MVP)
- [x] Nextcloud setup with moltagent user
- [x] Credential broker via NC Passwords
- [x] Basic router with 2 providers (local + one API)
- [x] NC Talk integration
- [x] Simple budget tracking

### Phase 2: Resilience Layer ✅ IMPLEMENTED
- [x] Rate limit tracking from headers
- [x] Exponential backoff with jitter
- [x] Cross-provider failover
- [x] User notifications
- [ ] Circuit breaker

**Implemented in:** `src/lib/llm/` (see [llm-router-guide.md](llm-router-guide.md))

### Phase 3: Cost Optimization
- [ ] NC Assistant (free tier) integration
- [x] Local-first heartbeat
- [ ] Context broker (search-then-load)
- [ ] Response length enforcement
- [x] Full budget enforcement with overrides

### Phase 4: Advanced Features
- [ ] Task queue for capacity management
- [ ] Loop detection
- [ ] Proactive features with cost-aware routing
- [ ] Multi-provider configuration UI
- [ ] Cost reporting dashboard

---

## The MoltAgent Promise

```
When you deploy MoltAgent, you get:

✓ An AI that never stores your credentials
✓ Instant revocation with one click
✓ Costs that are predictable and controllable
✓ Failures that are visible and explained
✓ A local fallback that always works
✓ Your data on your infrastructure
✓ Provider choice, not provider lock-in

Your AI. Your Infrastructure. Your Rules.
```

---

## Appendix: Lessons from the Field

These design decisions came from real OpenClaw user pain:

| User Problem | Our Solution |
|--------------|--------------|
| "8.5M tokens in one day from heartbeat" | Local-first heartbeat |
| "No fallback = offline for hours" | Local always in fallback chain |
| "Bot just stopped responding, no explanation" | Transparent status notifications |
| "Still hitting rate limits after optimization" | Predictive rate limit tracking |
| "Fallback didn't engage when primary failed" | Cross-provider failover |
| "Same tool call repeated 25+ times" | Loop detection + circuit breaker |
| "Costs were unpredictable" | Hard budgets with override option |
| "$128/month for one monitoring cron" | Free/local tiers for routine work |

---

*MoltAgent: Because your AI assistant shouldn't cost more than a junior employee, and should never just... disappear.*
