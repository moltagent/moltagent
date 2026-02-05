# MoltAgent: Development Sequence & Timeline

**Version:** 1.0  
**Date:** 2026-02-05  
**Status:** Active — tracks current and planned work  
**Purpose:** Single source of truth for what gets built, in what order, by whom  
**Audience:** Fu (planning), Claude Code (execution reference), Claude Opus (architecture)

---

## Current State

### What Exists (Working)

- 3-VM infrastructure on Hetzner (NC Storage Share, Bot VM, Ollama VM)
- MoltAgent user with NC workspace (/Inbox, /Outbox, /Logs, /Memory, /Context, /Federation)
- OpenClaw installed with NC Talk plugin, gateway running
- HeartbeatManager with Deck-based task processing (Inbox → Queued → Working → Done)
- DeckClient (473-line module, working)
- LLMRouter with Ollama integration (DeepSeek-R1)
- Basic credential broker via NC Passwords
- Two custom OpenClaw skills: `nextcloud-files` (working), `moltagent-logging` (partial)
- SOUL.md, IDENTITY.md, TOOLS.md in OpenClaw workspace

### What's In Progress

- NC resilience layer (NCRequestManager — rate-aware queuing, caching, backoff)
- Credential cache with TTL and batch fetch
- Security guards (SecretsGuard, ToolGuard, PromptGuard, PathGuard, EgressGuard)

### What's Documented But Not Built

- Skill Forge (this new spec: `moltagent-skill-forge-spec.md`)
- Email/calendar integration (`moltagent-email-calendar-spec.md`)
- Knowledge system (`moltagent-knowledge-system.md`)
- Federation protocol (`moltagent-federation-spec.md`)
- Full resilience spec (`moltagent-resilience-spec.md`)

---

## Development Tracks

There are three parallel tracks. Track A is the critical path — nothing ships without it. Track B is the product differentiator. Track C is post-launch growth.

```
TRACK A: FOUNDATION (blocks everything)
  NC Resilience → Security Guards → Credential Cache
  
TRACK B: SKILL FORGE (product value)
  Template Engine → Federation Setup → Audit Gate → Talk Engine
  
TRACK C: POST-LAUNCH (growth features)
  Forms Integration → Generic Builder → Email/Calendar → Knowledge System
```

### Dependency Graph

```
                    ┌──────────────────┐
                    │  NC Resilience   │  ◄── ALL NC operations depend on this
                    │  Layer           │
                    └────────┬─────────┘
                             │
                ┌────────────┴────────────┐
                ▼                         ▼
        ┌──────────────┐         ┌──────────────┐
        │  Credential  │         │  Security    │
        │  Cache       │         │  Guards      │
        └──────┬───────┘         └──────┬───────┘
               │                        │
               │         ┌──────────────┘
               │         │
               ▼         ▼
        ┌──────────────────────┐
        │  Security            │
        │  Interceptor         │  ◄── Wires guards into message pipeline
        └──────────┬───────────┘
                   │
          ┌────────┴─────────────────────────────────┐
          ▼                                          ▼
  ┌──────────────────┐                     ┌──────────────────┐
  │  Skill Forge:    │                     │  Email/Calendar  │
  │  Template Engine │                     │  Integration     │
  └──────┬───────────┘                     └──────────────────┘
         │                                   (POST-LAUNCH)
         │
  ┌──────┴───────────┐
  │  Federation      │  ◄── Template distribution to clients
  │  Share Setup     │      Must work before first concierge client
  └──────┬───────────┘
         │
  ┌──────┴───────────┐
  │  Skill Forge:    │
  │  Audit Gate      │  ◄── Security scan + pending review
  └──────┬───────────┘
         │
  ┌──────┴───────────┐
  │  Skill Forge:    │
  │  Talk Engine     │  ◄── Conversational skill setup
  └──────┬───────────┘
         │
         │  (POST-LAUNCH)
         ▼
  ┌──────────────────┐
  │  Generic Builder │  ◄── Custom API skills via conversation
  │  + NC Forms      │
  └──────────────────┘
```

---

## Phase Schedule

### PHASE 0: NC Resilience + Credential Cache (IN PROGRESS)

**Status:** Active — CCode working on this now  
**Estimated sessions:** 2-3 CCode sessions  
**Spec:** `nc-resilience-briefing.md`

| Deliverable | Owner | Notes |
|-------------|-------|-------|
| `src/lib/nc-request-manager.js` | CCode | Central request queue, rate tracking, backoff |
| `src/lib/credential-cache.js` | CCode | TTL cache, batch prefetch, secure eviction |
| Modify all NC clients to use NCRequestManager | CCode | DeckClient, CalDAV, Talk, WebDAV, NC Assistant |
| `test/nc-request-manager.test.js` | CCode | Mock 429s, verify backoff, cache hits |
| `test/credential-cache.test.js` | CCode | TTL expiry, batch fetch, secure eviction |

**Exit criteria:** Full heartbeat cycle runs with ≤10 NC API calls per cycle (down from 20-40). No 429 errors under normal operation.

---

### PHASE 1: Security Guards

**Status:** Next up  
**Estimated sessions:** 3-4 CCode sessions  
**Spec:** `security-development.md`  
**Depends on:** Phase 0 (guards need working NC operations for audit logging)

**Session 1 — Low-hanging fruit:**

| Deliverable | CCode time est. | Notes |
|-------------|-----------------|-------|
| `src/security/guards/secrets-guard.js` | 45 min | Pattern matching for API keys, tokens, passwords in I/O |
| `src/security/guards/tool-guard.js` | 30 min | Forbidden/approval-required/local-only operation lists |
| `src/security/response-wrapper.js` | 30 min | Output sanitization — single enforcement point |
| Tests for all three | 45 min | Known-good, known-bad test strings |

**Session 2 — Defense in depth:**

| Deliverable | CCode time est. | Notes |
|-------------|-----------------|-------|
| `src/security/guards/prompt-guard.js` | 60 min | 4-layer injection detection (heuristic + statistical) |
| `src/security/guards/path-guard.js` | 30 min | Filesystem access control with wildcards |
| `src/security/guards/egress-guard.js` | 30 min | Outbound domain allowlist |
| Tests for all three | 45 min | Adversarial patterns, SSRF attempts |

**Session 3 — Memory + sessions:**

| Deliverable | CCode time est. | Notes |
|-------------|-----------------|-------|
| `src/security/memory-integrity.js` | 45 min | Scan /Memory/ for injections, quarantine |
| `src/security/session-manager.js` | 45 min | Room-based session isolation for NC Talk |
| Tests | 30 min | Cross-session leak tests, quarantine flow |

**Session 4 — Integration:**

| Deliverable | CCode time est. | Notes |
|-------------|-----------------|-------|
| `src/security/interceptor.js` | 60 min | Wire all guards into beforeExecute/afterExecute |
| `src/security/index.js` | 15 min | Module exports |
| Integration with HeartbeatManager | 45 min | Hook interceptor into message pipeline |
| Red team test suite | 30 min | Adversarial probes document from spec |

**Exit criteria:** All guards pass test suites. Interceptor blocks known attack patterns. Red team probes all caught. Guard overhead < 0.05ms per check.

---

### PHASE 2: Skill Forge — Template Engine

**Status:** Planned  
**Estimated sessions:** 1-2 CCode sessions  
**Spec:** `moltagent-skill-forge-spec.md` (Sections 3, 7, 10)  
**Depends on:** Phase 1 (security scanner reuses guard patterns from PromptGuard/EgressGuard)

**Session 1:**

| Deliverable | CCode time est. | Notes |
|-------------|-----------------|-------|
| `src/skill-forge/constants.js` | 15 min | Forbidden patterns, safe bins — import from security guards where possible |
| `src/skill-forge/template-loader.js` | 30 min | Read YAML templates from NC via WebDAV |
| `src/skill-forge/template-engine.js` | 45 min | Parameter substitution, slug generation, SKILL.md assembly |
| `src/skill-forge/security-scanner.js` | 30 min | Validate generated skill against forbidden patterns + domain allowlist |
| `src/skill-forge/activator.js` | 30 min | Deploy to ~/.openclaw/skills/, update metadata |
| `src/skill-forge/index.js` | 15 min | Module export |
| `test/template-engine.test.js` | 30 min | Parameter substitution, slug generation |
| `test/security-scanner.test.js` | 30 min | Forbidden patterns, domain validation, hardcoded creds |

**Session 2 (if needed):**

| Deliverable | CCode time est. | Notes |
|-------------|-----------------|-------|
| End-to-end test | 45 min | Template → assembly → scan → activation → OpenClaw picks it up |
| First template: `trello.yaml` | 30 min | Fully working Trello template for validation |
| Second template: `uptime-check.yaml` | 15 min | Simple template, no credentials needed |

**Exit criteria:** Can load a template from NC, substitute parameters, pass security scan, deploy to OpenClaw, and verify OpenClaw recognizes the new skill.

---

### PHASE 3: Federation Setup + Audit Gate

**Status:** Planned  
**Estimated sessions:** 1 CCode session + manual testing by Fu  
**Spec:** `moltagent-skill-forge-spec.md` (Sections 4, 8)  
**Depends on:** Phase 2 (templates need to exist before we distribute them)

This phase is split between CCode work and manual setup because federated sharing requires UI interaction on the Nextcloud side.

**CCode work:**

| Deliverable | CCode time est. | Notes |
|-------------|-----------------|-------|
| `src/skill-forge/catalog-sync.js` | 30 min | Check catalog version during heartbeat, notify on updates |
| `/SkillTemplates/_catalog.json` | 20 min | Initial catalog with first templates |
| `/SkillTemplates/_version.txt` | 5 min | Semver version file |
| `/SkillTemplates/_schema.json` | 30 min | JSON Schema for template validation |

**Fu's manual work:**

| Task | Est. time | Notes |
|------|-----------|-------|
| Create `/SkillTemplates/` folder on MoltAgent Prime NC | 5 min | NC Files UI |
| Upload catalog files and first templates | 10 min | NC Files UI |
| Test federated share to a second Storage Share | 30 min | NC sharing UI, may need to create test instance |
| Verify MoltAgent on client NC can read templates via WebDAV | 15 min | SSH to bot VM, curl test |
| Document federation setup steps for concierge deployment | 30 min | Add to concierge guide |

**Why this is Phase 3 and not later:**

Federation is not a feature — it's the distribution channel. Without it, adding a new template to a client means SSH-ing into their bot VM and manually creating files. With it, you drop a file into your Prime NC and every client has it. This must work before the first concierge client, or you're stuck with per-client manual maintenance forever.

**Exit criteria:** Template catalog on Prime NC. Federated share to test client NC working. MoltAgent on client can read `_catalog.json` and load templates. `catalog-sync.js` detects version changes.

---

### PHASE 4: Skill Forge — Talk Conversation Engine

**Status:** Planned  
**Estimated sessions:** 2-3 CCode sessions  
**Spec:** `moltagent-skill-forge-spec.md` (Section 5)  
**Depends on:** Phase 2 (needs template engine), Phase 3 (needs catalog to list available skills)

This is the user-facing magic. The hardest engineering in Skill Forge.

**Session 1 — State machine and triggers:**

| Deliverable | CCode time est. | Notes |
|-------------|-----------------|-------|
| `src/skill-forge/talk-patterns.js` | 30 min | Trigger phrase matching for Forge activation |
| `src/skill-forge/conversation-state.js` | 30 min | State persistence to /Memory/SkillForge/ |
| `src/skill-forge/credential-verifier.js` | 30 min | Check NC Passwords for label existence (not value) |
| `src/skill-forge/talk-engine.js` (skeleton) | 60 min | State machine with DISCOVERY, COLLECTING_CREDENTIALS, COLLECTING_PARAMETERS, ASSEMBLING, REVIEW, ACTIVATING states |

**Session 2 — Integration and flow completion:**

| Deliverable | CCode time est. | Notes |
|-------------|-----------------|-------|
| Complete `talk-engine.js` | 60 min | Full conversation flow for known templates |
| Hook into HeartbeatManager message pipeline | 45 min | Route Forge triggers to talk-engine |
| `test/talk-engine.test.js` | 45 min | State transitions, trigger matching, credential verification |

**Session 3 (if needed) — Polish and edge cases:**

| Deliverable | CCode time est. | Notes |
|-------------|-----------------|-------|
| Conversation timeout handling | 20 min | Expire incomplete sessions after 24h |
| Error recovery | 30 min | What happens when credential verification fails, API is down |
| Multi-skill flow | 30 min | "Anything else you'd like to connect?" continuation |
| End-to-end test via actual Talk | 60 min | Live test on bot VM |

**Exit criteria:** User can say "connect to Trello" in NC Talk, get guided through credential setup and parameter collection, review the generated skill, approve activation, and use the new skill immediately.

---

### PHASE 5: Template Authoring (Fu's Work)

**Status:** Planned — runs in parallel with Phases 3-4  
**Owner:** Fu (not CCode)  
**Estimated time:** 15-20 hours over 2 weeks

This is the work only you can do. Each template requires:

1. Reading the service's API documentation
2. Testing every curl command against the real API
3. Writing the YAML template with correct endpoints
4. Running the generated SKILL.md through the security scanner
5. Verifying the skill works in OpenClaw

**Template writing sequence (prioritized):**

| # | Template | Est. time | Credentials needed | Notes |
|---|----------|-----------|-------------------|-------|
| 1 | `uptime-check.yaml` | 30 min | None | Simplest possible template. Just curl a URL and check status. Good first template to validate the engine. |
| 2 | `rss-feed.yaml` | 30 min | None | No auth, curl + XML parsing. Second no-auth template. |
| 3 | `website-change.yaml` | 30 min | None | Hash page content, compare. Third no-auth. |
| 4 | `trello.yaml` | 60 min | API key + token | First auth template. Well-documented API. Already drafted in spec. |
| 5 | `todoist.yaml` | 45 min | Bearer token | Simple REST API, good docs. |
| 6 | `github-issues.yaml` | 45 min | Personal access token | Familiar territory for dev users. |
| 7 | `email-imap.yaml` | 90 min | IMAP credentials | More complex — needs IMAP via curl or dedicated tool. May need `openssl s_client` as allowed binary. |
| 8 | `slack-webhook.yaml` | 30 min | Webhook URL | Send-only. Very simple. |
| 9 | `google-calendar.yaml` | 90 min | OAuth token or service account | Google APIs are verbose. May need refresh token handling. |
| 10 | `telegram-bot.yaml` | 45 min | Bot token | Simple HTTP API, good docs. |
| 11 | `notion.yaml` | 60 min | Integration token | Notion API is well-documented but verbose. |
| 12 | `github-repo.yaml` | 45 min | Personal access token | File operations on repos. |
| 13 | `google-sheets.yaml` | 75 min | OAuth/service account | Similar complexity to Google Calendar. |
| 14 | `linear-issues.yaml` | 45 min | API key | GraphQL API — slightly different pattern. |
| 15 | `rest-api.yaml` (Generic) | 90 min | Dynamic | The meta-template. Hardest to get right. Write last. |

**Total: ~13 hours of template authoring.**

Start with templates 1-3 (no auth) to validate the engine works. Then 4-6 (simple auth) to validate credential flow. The rest can roll out over weeks.

**Template testing checklist (use for every template):**

```
[ ] All curl commands tested against real API with real credentials
[ ] Credential fetch pattern works with NC Passwords
[ ] Generated SKILL.md passes security scanner with zero violations
[ ] OpenClaw recognizes and loads the generated skill
[ ] Agent can successfully execute at least one operation from the skill
[ ] Verification command from template succeeds
[ ] All domains in skill match allowed_domains exactly
[ ] No forbidden patterns present
```

---

## Post-Launch Track (PHASE 6+)

These are valuable but not required for first concierge clients.

### Phase 6: NC Forms Integration

**Estimated:** 1 CCode session  
**Spec:** `moltagent-skill-forge-spec.md` (Section 6)

| Deliverable | Notes |
|-------------|-------|
| `src/skill-forge/forms-poller.js` | Poll NC Forms API for submissions |
| `src/skill-forge/forms-adapter.js` | Convert form data to template parameters |
| `scripts/provision-forge-forms.sh` | Create forms during deployment |
| Add to Ansible playbook | Auto-create forms in concierge deployment |

### Phase 7: Generic Skill Builder

**Estimated:** 2-3 CCode sessions  
**Spec:** `moltagent-skill-forge-spec.md` (Section 9)

| Deliverable | Notes |
|-------------|-------|
| `src/skill-forge/generic-builder.js` | Extended Talk flow for custom APIs |
| `src/skill-forge/operation-collector.js` | Structured operation definition collection |
| SSRF protection | Block private IPs, metadata endpoints |
| HTTPS-only enforcement | Reject http:// URLs |
| `generic/rest-api.yaml` meta-template | The template that generates templates |

### Phase 8: Email & Calendar Integration

**Estimated:** 3-4 CCode sessions  
**Spec:** `moltagent-email-calendar-spec.md`

Separate from Skill Forge — these are deep integrations, not skill templates.

### Phase 9: Knowledge System

**Estimated:** 3-4 CCode sessions  
**Spec:** `moltagent-knowledge-system.md`

### Phase 10: Advanced Security (Signed Receipts)

**Estimated:** 1-2 CCode sessions  
**Spec:** `security-development.md` (Section 8)

| Deliverable | Notes |
|-------------|-------|
| `src/security/receipts.js` | Ed25519 signed audit receipts |
| Key generation and storage | Keypair in NC Passwords |

---

## Timeline Summary

Realistic calendar assuming 1-2 CCode sessions per day when actively developing, with breaks for testing and Fu's manual work.

```
WEEK 1 (current)
├── Phase 0: NC Resilience + Credential Cache ............. [IN PROGRESS]
└── Phase 1, Session 1: SecretsGuard, ToolGuard, ResponseWrapper

WEEK 2
├── Phase 1, Sessions 2-3: Remaining guards + memory integrity
├── Phase 1, Session 4: Interceptor integration
└── Phase 2, Session 1: Template engine core

WEEK 3
├── Phase 2, Session 2: End-to-end template test
├── Phase 3: Federation setup + catalog sync
├── Fu: First 6 templates (no-auth + simple auth)
└── Fu: Test federated sharing between two NC instances

WEEK 4
├── Phase 4, Sessions 1-2: Talk conversation engine
├── Fu: Templates 7-12
└── Fu: End-to-end testing: Talk → template → skill → working

WEEK 5
├── Phase 4, Session 3: Polish, edge cases, error recovery
├── Fu: Templates 13-15
├── Fu: Update concierge deployment guide with Forge steps
└── READY FOR FIRST CONCIERGE CLIENT

WEEK 6+
├── Phase 6: NC Forms integration
├── Phase 7: Generic Skill Builder
└── Phase 8+: Email, calendar, knowledge system
```

**Total CCode sessions to first client: ~12-14 sessions**  
**Total Fu manual work to first client: ~20-25 hours**  
**Calendar time to first client: ~5 weeks from now**

---

## What Ships With First Concierge Client

The minimum viable MoltAgent that a paying customer receives:

```
INFRASTRUCTURE
✅ 3-VM setup (NC Storage Share + Bot VM + Ollama VM)
✅ Firewall rules and network segmentation
✅ MoltAgent NC user with workspace folders
✅ OpenClaw with NC Talk plugin

SECURITY
✅ NC Resilience layer (rate-aware, cached)
✅ Credential broker with TTL cache
✅ All 5 security guards active
✅ Security interceptor wired into pipeline
✅ Memory integrity scanning

SKILL FORGE
✅ Template engine (assemble skills from templates)
✅ Security scanner (validate before activation)
✅ Audit gate (pending review folder)
✅ Federation share from Prime (template distribution)
✅ Catalog sync (automatic template updates)
✅ Talk conversation engine (guided skill setup)
✅ 10-15 pre-validated skill templates

CORE CAPABILITIES
✅ Deck-based task processing
✅ Ollama local LLM
✅ NC Talk interface
✅ Audit logging
```

### What Does NOT Ship With First Client

```
❌ NC Forms integration (Talk is sufficient)
❌ Generic Skill Builder (curated templates only at launch)
❌ Email integration (Phase 8)
❌ Calendar integration (Phase 8)
❌ Knowledge system (Phase 9)
❌ Signed receipts (Phase 10)
❌ Federation protocol for agent-to-agent (separate roadmap)
```

---

## Risk Register

| Risk | Impact | Likelihood | Mitigation |
|------|--------|------------|------------|
| NC Forms API bugs on Storage Share | Forms fallback unavailable | Medium | Talk engine is primary UI anyway; Forms is post-launch |
| Federated sharing rate limits or delays | Template updates slow to propagate | Low | Templates change infrequently; cache locally |
| OpenClaw update breaks skill loading | Generated skills stop working | Medium | Pin OpenClaw version; test after updates |
| Hetzner Storage Share blocks NC app we need | Missing capability | Low | Forms and Talk are standard apps, should be fine |
| Template for complex API (Google, OAuth) takes too long | Launch catalog smaller than 15 | High | Launch with 10 templates, add rest post-launch |
| Talk conversation engine has UX issues in practice | Users confused by flow | Medium | Start with simple templates; iterate on conversation design |
| CCode sessions take longer than estimated | Timeline slips | Medium | Phases are independent — can ship Phase 2 without Phase 4 if needed |

---

## Decision Log

| Date | Decision | Rationale |
|------|----------|-----------|
| 2026-02-05 | Skill Forge over ClawHub | ClawHub has 341+ malicious skills; template-based generation is inherently safe |
| 2026-02-05 | Talk as primary UI, Forms as fallback | Talk is more natural; Forms has API bugs; Talk is already working |
| 2026-02-05 | Federation in Phase 3, not post-launch | It's the distribution channel, not a feature. Every template update depends on it. |
| 2026-02-05 | Generic Builder is post-launch | Curated templates cover 80% of use cases; generic builder adds complexity and risk |
| 2026-02-05 | Zero external dependencies for Forge | Same principle as security modules — minimize supply chain risk |
| 2026-02-05 | Templates authored by Fu, not AI-generated | LLMs hallucinate API endpoints; every curl command must be manually verified |

---

## How to Use This Document

**Fu:** This is your project plan. Update the status fields as work completes. Use the risk register to make scope decisions if timeline pressure hits.

**Claude Code:** Read this for build sequence. Check which phase you're in. Read the corresponding spec document for implementation details. Don't jump ahead — dependencies exist for good reasons.

**Claude Opus (this project):** Reference this for context on what's built, what's planned, and what's blocking.

---

*MoltAgent development: Honest timelines, clear dependencies, no surprises.*
