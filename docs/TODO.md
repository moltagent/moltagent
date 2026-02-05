# MoltAgent TODO List

**Generated:** 2026-02-03
**Based on:** Full documentation analysis

---

## 🔴 URGENT & IMPORTANT (Security/Core Function)

| # | Item | Why Urgent | Location | Status |
|---|------|------------|----------|--------|
| 1 | **Circuit Breaker** | Prevents cascading failures - documented but NOT implemented | resilience-spec.md Part 5 | ✅ DONE |
| 2 | **Loop Detection** | Prevents infinite tool calls (25+ repeats observed in field) | resilience-spec.md Part 5 | ✅ DONE |
| 3 | **NC Talk Message Signature Verification** | Security critical - code shown in docs but implementation unclear | README security section | ✅ DONE |
| 4 | **Credential Broker** | Core security - ensure systemd LoadCredential= actually works | Need to check bot.js | ✅ DONE |
| 5 | **Output Verification** | Block suspicious LLM outputs before execution | README Layer 4 defense | ✅ DONE |

**Estimated effort:** 2-3 days

---

## 🟡 IMPORTANT (Cost Control / Production Ready)

| # | Item | Impact | Status |
|---|------|--------|--------|
| 6 | **NC Assistant Integration (Tier 1)** | -€100+/month - FREE tier for simple tasks | ⬜ TODO |
| 7 | **Context Broker (Search-then-load)** | -30% token usage per heartbeat | ⬜ TODO |
| 8 | **Response Length Enforcement** | Prevents verbose 400-500 token responses | ⬜ TODO |
| 9 | **Task Queue** | Handles "all providers exhausted" gracefully | ⬜ TODO |
| 10 | **Heartbeat Optimization Verification** | Confirm local-first actually implemented | ⬜ TODO |
| 11 | **Cost Tracking Dashboard** | User visibility into spending | ⬜ TODO |

**Estimated effort:** 1-2 weeks

---

## 🟢 NICE TO HAVE (Polish / Future)

| # | Item | Notes | Status |
|---|------|-------|--------|
| 12 | Email Integration (IMAP/SMTP) | Credentials documented, workflow not | ⬜ TODO |
| 13 | Calendar/Contacts API Integration | Mentioned but no implementation details | ⬜ TODO |
| 14 | Monitoring & Alerting | Alert conditions documented, no integration | ⬜ TODO |
| 15 | Deck Board Setup Scripts | Referenced but not provided | ⬜ TODO |
| 16 | Multi-provider Config UI | Phase 4 item | ⬜ TODO |
| 17 | Memory Integrity Checks | Threat matrix mentions, no implementation | ⬜ TODO |
| 18 | User Workflow Guides | Documentation gap | ⬜ TODO |
| 19 | Troubleshooting Runbooks | Documentation gap | ⬜ TODO |

---

## Summary

| Priority | Count | Description |
|----------|-------|-------------|
| 🔴 Urgent & Important | 0 remaining | **5 of 5 done** |
| 🟡 Important | 6 | **Affects cost & reliability** |
| 🟢 Nice to Have | 8 | **Polish & expansion** |

---

## Implementation Notes

### Circuit Breaker (Item #1)
- Location: `src/lib/llm/circuit-breaker.js`
- States: closed → open → half-open
- Config: failureThreshold=5, resetTimeout=60s, successThreshold=3
- Integration: Wrap provider calls in router.js

### Loop Detection (Item #2)
- Location: `src/lib/llm/loop-detector.js`
- Detects: Same call repeated, ping-pong patterns (A→B→A→B)
- Config: maxConsecutiveErrors=3, historyWindow=60s
- Integration: Check before each tool/provider call

### NC Talk Signature Verification (Item #3)
- Location: `src/lib/talk-signature-verifier.js`
- Algorithm: HMAC-SHA256 with message = random + body
- Headers: `X-Nextcloud-Talk-Signature`, `X-Nextcloud-Talk-Random`, `X-Nextcloud-Talk-Backend`
- Secret: Fetched from NC Passwords (`nc-talk-secret`) or env var fallback
- Features: Backend allowlist, timing-safe comparison, statistics tracking
- Integration: Verifies all webhooks before processing in `webhook-server.js`

### NC Assistant (Item #6)
- Endpoint: `/ocs/v2.php/taskprocessing`
- Task types: core:text2text, core:text2text:summary, core:text2text:headline
- Cost: FREE (included with Nextcloud)
- Fallback: Ollama if NC Assistant unavailable

---

## Changelog

- **2026-02-03:** Implemented NC Talk Message Signature Verification (item #3)
  - Created `src/lib/talk-signature-verifier.js` - HMAC-SHA256 signature verification
  - Features: Backend allowlist, timing-safe comparison, format validation, statistics
  - Updated `webhook-server.js` - Integrated verifier, removed hardcoded secrets
  - Secret from NC Passwords via credential broker (fallback: env var)
  - 61 tests passing in `tests/test-talk-signature.js`
- **2026-02-03:** Implemented Output Verification (item #5)
  - Created `src/lib/output-verifier.js` - Comprehensive output security checks
  - Detects: shell injection, destructive commands, credential patterns, URL exfiltration, code execution
  - Integrated into LLM Router - all outputs verified before return
  - 52 tests passing in `tests/test-output-verifier.js`
- **2026-02-03:** Implemented Credential Broker (item #4)
  - Created `src/lib/credential-broker.js` - NC Passwords integration
  - Updated `bot.js` - Removed hardcoded credentials, uses credential broker
  - Updated `heartbeat-manager.js` - Passes credential broker to clients
  - Updated `caldav-client.js` - Uses credential broker for authentication
  - Created `deploy/moltagent.service` - systemd unit with LoadCredential
  - Created `deploy/setup-credentials.sh` - Credential setup script
- **2026-02-03:** Implemented Circuit Breaker and Loop Detection (items #1, #2)
  - Created `src/lib/llm/circuit-breaker.js` - Prevents cascading failures
  - Created `src/lib/llm/loop-detector.js` - Detects repetition/ping-pong patterns
  - Integrated both into LLM Router
- **2026-02-03:** Initial TODO list created from documentation analysis
