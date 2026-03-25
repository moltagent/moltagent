# CLAUDE.md — Moltagent

**Read this entire file at the start of every session.** It tells you how to
work on this codebase, how to behave, and where everything is. Following
these rules prevents the mistakes that waste the operator's time.

---

## 0. How This Project Works

Moltagent is a sovereign AI agent platform built on Nextcloud. Solo founder
(Fu), bootstrapped, built from Portugal. The agent is deployed as a "digital
employee" — it has a real NC identity, workspace, permissions, and instant
revocation.

Three people work on this:

- **Fu** — architect and founder. Writes briefings, defines architecture,
  reviews results, makes final calls on direction.
- **Claude Code (you)** — engineer. Your Architect Agent plans well — use it.
  Analyze the problem, build a solid plan, implement, test, report. You have
  direct filesystem access to the VM and the authority to make implementation
  decisions within the scope of the briefing.
- **Claude Opus (in claude.ai)** — architecture partner and CTO. Reviews plans,
  identifies gaps, writes specs. You may receive briefings that were
  co-authored with Opus.

You have real engineering authority here. Use your Architect Agent to plan,
spot structural issues, and propose better approaches. The guardrails are:
Fu's briefings define *scope* (what to build), the engineering principles
define *standards* (how to build it). Within those boundaries, your judgment
is trusted. When you disagree with the spec, say so — don't silently diverge
and don't silently comply.

---

## 1. Session Protocol

### At Session Start

1. Read this file (automatic)
2. Run `git log --oneline -10` to understand recent context
3. If a briefing was provided, read it fully before writing any code
4. If resuming interrupted work, check `git status` and `git stash list`

### During the Session

- **Investigate, don't ask.** When you need information (paths, config values,
  credential names, file contents, NC state), look it up. Use `find`, `grep`,
  `cat`, `ls`, `curl`, `systemctl show`. The filesystem is the source of truth.
  Do not ask Fu for information that exists on the system.
- **Verify before claiming.** If you say something works, show the evidence.
  Paste the test output. Show the curl response. Don't say "should work" or
  "architecturally in place" — those phrases mean "I didn't verify."
- **Use subagents for parallel work.** When a task has independent parts
  (e.g., write file + write tests + update config), use Claude's agent/task
  tools to parallelize. Don't serialize everything into one long sequence.
- **Stop and ask if the briefing is ambiguous.** It's cheaper to clarify once
  than to implement the wrong thing and rework it.

### At Session End

1. Run the full test suite. Report the result (pass count, any failures).
2. `git add` and `git commit` with a descriptive message.
3. Summarize what was done, what's BUILT, and what remains.
4. If anything in this CLAUDE.md is now wrong (paths changed, new modules
   added, counts shifted), update it in the same commit.

---

## 2. The 4-Agent Pipeline

Four user agents are configured in `/root/.claude/agents/`:

| Agent | Model | Role |
|-------|-------|------|
| **architect** | Opus | Reads the briefing, analyzes the codebase, plans file structure, identifies integration points, confirms the plan before any code is written |
| **implementer** | Sonnet | Builds each module in the order the architect planned, follows specs precisely, writes the code |
| **debugger** | Sonnet | Runs all tests, fixes failures, checks for null-safety, error handling edge cases, missing imports |
| **reviewer** | Opus | Final quality gate — reviews all changes for consistency, test coverage, regressions, and alignment with the briefing's exit criteria |

### When to Use the Pipeline

**Use the full pipeline** for sessions that touch multiple files, introduce
new modules, or refactor existing architecture. The groundbreaking sessions
that built the core platform all used this flow.

**Use a lighter flow** for single-file changes, template additions, or config
work. Not every task needs four agents — but the architect should always run
for anything non-trivial. Planning before building is never overhead.

### The Flow

```
Architect → plan confirmed → Implementer → code written → Debugger → tests green → Reviewer → quality verified
```

The architect uses Opus because planning and structural analysis need deep
reasoning. The implementer and debugger use Sonnet because execution and
fixing are throughput work where Sonnet matches Opus quality at lower cost.
The reviewer uses Opus because the final quality gate needs the same depth
as the initial plan.

Briefings from Fu/Opus may include a "Development Pipeline" section with
agent-specific instructions. Follow those when present. When no pipeline
section exists, apply the default flow above for any session over ~30 minutes.

---

## 3. Anti-Patterns — Things You Keep Getting Wrong

These are real mistakes from past sessions. Don't repeat them.

### Asking for credentials in chat
**Never.** Credentials are in the system. See Section 6 below. If you can't
find them, say so — don't ask Fu to paste them.

### Guessing paths instead of checking
Don't assume `src/lib/lib/` exists. Don't assume `.env` has values. Run `ls`.
Run `find`. The filesystem is right there.

### Saying "architecturally in place" when it doesn't work
"The generators are architecturally in place" ≠ "the generators produce
correct output." BUILT ≠ VERIFIED. If you haven't run it against real data,
say "BUILT, not yet verified." Fu will respect the honesty.

### Adding features without flagging them
The briefing defines the scope. If you see something that *should* be added —
and your Architect Agent often catches real gaps — propose it explicitly.
"I noticed X is missing, I think we need it because Y, here's my suggestion."
Don't silently add it and present it as part of the deliverable.

### Hardcoding English
Every string comparison, keyword list, or language-specific pattern you write
is a bug. The LLM is the language layer. If you're writing code that only
works in English, stop and rethink.

### Over-engineering
If the briefing says ~300 lines and you're at 600, pause and ask whether the
extra complexity is earning its keep. Sometimes it is — your audit of the
OAuth broker caught real gaps that expanded scope. But the default should be
"less code, not more." If the growth is justified, explain why in your summary.

---

## 4. Briefing Execution Protocol

Fu writes detailed briefings with clear structure. Here's how to work with them:

1. **Read the entire briefing** before touching any code. Understand the
   architecture, the build order, the exit criteria, and the verification
   protocol.

2. **Plan before you build.** Use your Architect Agent. If the briefing has
   a build order, understand *why* it's sequenced that way. If you see a
   better order or a structural issue the briefing missed, raise it before
   implementing — your analysis is valued.

3. **Follow the build order unless you have a reason not to.** It exists for
   dependency ordering. If you deviate, explain why in your summary.

4. **Hit every exit criterion.** The briefing defines what "done" looks like.
   If it says "13 tests," write 13 tests. If it says "manual verification
   against real NC," do that, or state clearly that it's not done yet.

5. **Report against the spec.** At session end, map your results back to
   the briefing's requirements. What's VERIFIED, what's BUILT, what's
   incomplete, what diverged from the spec and why.

6. **When you find a gap or disagree with the spec,** say so explicitly.
   "The spec doesn't cover X — here's what I think should happen and why."
   "I think the spec's approach to Y has a problem — here's the issue."
   Don't silently fill gaps with your own design, and don't silently comply
   with something you think is wrong.

---

## 5. Infrastructure

Three Hetzner VMs, network-segmented:

| VM | Role | IP | Spec |
|----|------|----|------|
| NC Storage Share | Managed Nextcloud (identity, mediation, storage) | *(Hetzner-managed, accessed via HTTPS)* | Managed service |
| moltagent-bot-01 | Agent runtime (Node.js) | 116.202.23.5 | CPX22 |
| Ollama VM | Local LLM inference | *(internal only, no internet)* | CPX31 |

Network rules:
- Bot VM → NC: HTTPS/443, CalDAV, WebDAV, Passwords API
- Bot VM → Ollama VM: port 11434 only
- Bot VM → WAN: Claude/Mistral API endpoints only (EgressGuard allowlist)
- Ollama VM → WAN: **BLOCKED**

Cloudflare Tunnels provide permanent subdomains. The agent's public-facing
URL falls back to `CONFIG.nc.url` if `AGENT_PUBLIC_URL` is not explicitly
set in the systemd unit.

Dashboards:
- `dash.moltagent.cloud` — private (Cloudflare Access)
- `public.moltagent.cloud` — trust-signal public view
- Both served from `scripts/dashboard-data-server.js` on port 3099, fed by
  `status-manifest.json`

---

## 6. Credentials — How They Work

### The Rule

**Credentials are NEVER in .env files, environment variables, or config
files.** They are not in this repo. Do not look for them there. Do not ask
the operator to paste them into chat.

### Bootstrap Credential

The single credential that unlocks everything else. Loaded by systemd at
service start:

```ini
# /etc/systemd/system/moltagent.service
[Service]
LoadCredential=nc-password:/etc/credstore/moltagent-nc-password
```

Node.js reads it at runtime:

```javascript
const token = fs.readFileSync(
  process.env.CREDENTIALS_DIRECTORY + '/nc-password', 'utf8'
).trim();
```

### Quick Reference: Getting NC Access from the CLI

Copy-paste this block. It works.

```bash
# Read the bootstrap credential
NC_PASS=$(cat /run/credentials/moltagent.service/nc-password)

# Load NC_URL and NC_USER from the systemd environment
eval $(systemctl show moltagent.service --property=Environment | sed 's/Environment=//')

# Verify
echo "NC_URL=$NC_URL  NC_USER=$NC_USER  NC_PASS is $([ -n "$NC_PASS" ] && echo 'set' || echo 'NOT set')"
```

If the service isn't running (credential directory doesn't exist):

```bash
# Fallback: read credstore directly
NC_PASS=$(cat /etc/credstore/moltagent-nc-password)

# NC_URL and NC_USER from systemd unit (works even when service is stopped)
systemctl show moltagent.service --property=Environment
# Then export the values shown
```

### Runtime Credential Flow

All other credentials (API keys, email, calendar, OAuth tokens) live in
NC Passwords. The agent fetches them on demand via the credential broker:

1. `credentialBroker.get(name)` → NC Passwords API → parsed credential
2. Used for single operation
3. Securely evicted (overwrite with empty, then null)
4. Never stored on disk, never logged

Complex credentials (email-imap, caldav, oauth-*) have structured data
in the `notes` field parsed by `CredentialCache`.

### Uploading Files to NC via WebDAV

```bash
# Read credentials as shown above, then:
curl -u "$NC_USER:$NC_PASS" \
  -T /opt/moltagent/path/to/file.yaml \
  "https://$NC_URL/remote.php/dav/files/$NC_USER/Moltagent/SkillTemplates/file.yaml"
```

### Listing NC Directories

```bash
curl -u "$NC_USER:$NC_PASS" -X PROPFIND \
  -H "Depth: 1" \
  "https://$NC_URL/remote.php/dav/files/$NC_USER/Moltagent/" \
  | xmllint --format - 2>/dev/null | grep '<d:href>'
```

---

## 7. Codebase Layout

Largest files: tool-registry.js, cockpit-manager.js, heartbeat-manager.js,
agent-loop.js, router.js. When orienting, start there.

```
/opt/moltagent/
├── config/                           # Runtime config (no secrets here)
│   ├── skill-templates/              # YAML skill templates (local copies)
│   └── ...
├── src/
│   ├── lib/
│   │   ├── nc-request-manager.js     # Central NC HTTP — rate-limit, cache, retry
│   │   ├── credential-cache.js       # Parsed credential cache with secure eviction
│   │   ├── credential-broker.js      # Credential lifecycle (get, withCredential)
│   │   ├── server/
│   │   │   └── webhook-handler.js    # Talk webhook listener (port 3000)
│   │   ├── agent/
│   │   │   ├── agent-loop.js         # Central dispatcher
│   │   │   ├── micro-pipeline.js     # Execution context
│   │   │   ├── intent-router.js      # Intent routing
│   │   │   ├── guardrail-enforcer.js # Security gate
│   │   │   └── tool-registry.js      # Tool registry (largest file)
│   │   ├── llm/
│   │   │   ├── router.js             # LLM routing (presets + job chains)
│   │   │   ├── budget-enforcer.js    # Cost metering
│   │   │   └── circuit-breaker.js    # LLM circuit breaker
│   │   ├── integrations/
│   │   │   ├── heartbeat-manager.js  # Background scheduler
│   │   │   ├── cockpit-manager.js    # Deck control plane
│   │   │   ├── deck-client.js        # Deck kanban
│   │   │   ├── caldav-client.js      # Calendar (CalDAV)
│   │   │   ├── collectives-client.js # Wiki (Collectives)
│   │   │   ├── memory-searcher.js    # NC Unified Search wrapper
│   │   │   └── nc-files-client.js    # WebDAV file I/O + TextExtractor
│   │   ├── memory/
│   │   │   ├── knowledge-graph.js    # Entity-relationship graph
│   │   │   └── vector-store.js       # SQLite vector store
│   │   └── workflows/
│   │       └── workflow-engine.js    # Workflow engine
│   ├── security/
│   │   ├── interceptor.js            # Security interceptor
│   │   ├── session-manager.js        # Session isolation (per Talk room)
│   │   ├── memory-integrity.js       # Memory integrity scanning
│   │   └── guards/                   # 5 guards:
│   │       ├── secrets-guard.js
│   │       ├── tool-guard.js
│   │       ├── prompt-guard.js
│   │       ├── path-guard.js
│   │       └── egress-guard.js
│   └── skill-forge/
│       ├── template-engine.js        # YAML → skill generation
│       ├── template-loader.js        # Load templates from NC WebDAV
│       ├── activator.js              # Deploy skill + update metadata
│       ├── oauth-broker.js           # OAuth 2.0 token lifecycle
│       ├── http-tool-executor.js     # Generic HTTP tool executor
│       ├── security-scanner.js       # Skill security validation
│       └── index.js                  # Exports
├── scripts/
│   └── dashboard-data-server.js      # Dashboard API (port 3099)
├── test/
│   ├── helpers/test-runner.js        # Custom test runner
│   ├── unit/                         # Unit tests
│   └── manual/                       # Manual verification scripts
├── webhook-server.js                 # Express server (Talk webhook + OAuth callback)
└── index.js                          # Entry point
```

Agent workspace on NC (WebDAV paths under `/Moltagent/`):

```
/Moltagent/
├── SkillTemplates/   # EXISTS — actively used
│   ├── _catalog.json
│   ├── bluesky.yaml
│   └── monitoring/
│       └── uptime-check.yaml
│
│   PLANNED (not yet created on NC):
├── Context/
├── Federation/
├── Inbox/
├── Logs/
├── Memory/
├── Outbox/
└── Talk/
```

---

## 8. LLM Routing

The router uses **presets** (`all-local`, `smart-mix`, `cloud-first`) with
**job-based provider chains** and multi-tier fallback. Each job type
(quick, tools, thinking, writing, research, coding) has its own provider
chain that determines which models are tried in order.

Key routing rules:
- Operations involving credentials or user-uploaded files → local Ollama
  (secrets never leave the server)
- Classification and heartbeat → local (fast, free)
- Standard tool calls → cloud (Haiku/Sonnet)
- Deep reasoning and writing → Opus

Local models: multiple available (check `OLLAMA_MODEL` in systemd env —
default is `qwen3:8b`; smaller models used for lightweight classification).

Budget enforcement is live — when daily budget is exceeded, the agent
degrades gracefully to local models. It never goes dark.

---

## 9. Testing

```bash
# Run all tests
cd /opt/moltagent
find test/unit -name "*.test.js" -exec node {} \;

# Run a specific test file
node test/unit/oauth-broker.test.js

# Run manual verification scripts
node test/manual/verify-oauth-broker.js
```

Tests use a custom runner at `test/helpers/test-runner.js`, not Jest or
Mocha. Follow the existing patterns when writing new tests.

---

## 10. Common Tasks

### Restarting the agent

```bash
sudo systemctl restart moltagent
sudo systemctl status moltagent
journalctl -u moltagent -f  # tail logs
```

### Checking what's running

```bash
systemctl is-active moltagent
curl -s http://localhost:3000/health 2>/dev/null  # webhook server health
curl -s http://localhost:3099/status 2>/dev/null   # dashboard data server
```

### Uploading a skill template to NC

```bash
# 1. Read credentials (see Section 6 Quick Reference)
# 2. Upload
curl -u "$NC_USER:$NC_PASS" \
  -T src/skill-forge/templates/my-template.yaml \
  "https://$NC_URL/remote.php/dav/files/$NC_USER/Moltagent/SkillTemplates/my-template.yaml"
```

### Checking NC Passwords entries

```bash
curl -s -u "$NC_USER:$NC_PASS" \
  -H "OCS-APIRequest: true" \
  -H "Accept: application/json" \
  "https://$NC_URL/index.php/apps/passwords/api/1.0/password/list" \
  -X POST -d '{}' | jq '.[].label'
```

### Checking Deck boards

```bash
curl -s -u "$NC_USER:$NC_PASS" \
  -H "OCS-APIRequest: true" \
  -H "Accept: application/json" \
  "https://$NC_URL/index.php/apps/deck/api/v1.0/boards" | jq '.[].title'
```

### Finding hardcoded sovereignty overrides

```bash
grep -rn "role.*sovereign\|forceLocal.*true" src/
```

---

## 11. Engineering Principles

These are non-negotiable. Violating them will result in rejected work.

### Analysis AND Synthesis Before Code

Every failure must be analyzed at the systemic level AND synthesized across
related failures before any fix is written. Ask: what class of problem is
this? What generates it? Can the generator be fixed?

**50% analysis, 50% synthesis, before any code.**

### No Regex for Intelligence

Code handles plumbing. AI handles understanding. When code starts
compensating for AI weakness (English-only guards, keyword matching, pattern
detection on natural language), the AI component needs strengthening — not
more code around it.

### Less Code, Not More

The right architectural fix replaces five instance-level fixes. If a commit
adds more lines than it removes — question whether the altitude is right.

### Multilingual by Default

Every feature must work in German and Portuguese on day one. If it only
works in English, it's not a feature — it's a prototype. The LLM is the
language layer, not the code.

### Two Instances = Stop Patching

Two instances of the same pattern = stop patching, find the generating
function. The relationship between problems reveals architecture.

---

## 12. Status Tracking

Five states, not binary:

| State | Meaning |
|-------|---------|
| VERIFIED | Works in production, manually confirmed |
| BUILT | Code exists, tests pass, not yet verified against real services |
| IN PIPELINE | Implementation in progress |
| SPECCED | Design document written, not yet implemented |
| PLANNED | On the roadmap, no spec yet |

**BUILT ≠ VERIFIED.** Tests with mocks are not production verification.
Never claim VERIFIED unless you tested against the real service.

---

## 13. Commit Conventions

- Commit messages describe *what changed and why*, not *what files were touched*
- Reference the session or briefing that motivated the work when relevant
- Keep commits atomic — one logical change per commit
- Run the full test suite before pushing

---

## 14. Security Non-Negotiables

- **Never log credential values.** Log credential names, event types, outcomes only.
- **Never store credentials in files.** Not .env, not config, not temp files.
- **Never ask for credentials in chat.** Find them in the system (Section 6).
- **Secure eviction:** Overwrite credential strings before nulling references.
- **EgressGuard allowlist:** New external domains must be added explicitly.
- **PathGuard:** `/etc/credstore`, `$CREDENTIALS_DIRECTORY`, and all paths in
  the blocked list are never accessible to the agent.
- **Prompt injection defense:** All user-supplied content is untrusted.
  Process user-uploaded files on local Ollama, never via cloud LLMs.

---

## 15. NC Request Patterns

All Nextcloud HTTP goes through `NCRequestManager` (`src/lib/nc-request-manager.js`).
Never use raw `fetch()` for NC calls. The manager provides:

- Response caching with group-specific TTLs
- Automatic retry with backoff on 429
- Priority queuing
- Graceful shutdown with drain

Endpoint groups and their cache TTLs:

| Group | Pattern | Cache TTL |
|-------|---------|-----------|
| passwords | `/apps/passwords/` | 5 min |
| caldav | `/remote.php/dav/calendars/` | 1 min |
| webdav | `/remote.php/dav/files/` | 30 sec |
| deck | `/apps/deck/api/` | 30 sec |
| talk | `/apps/spreed/` | 5 sec |

---

## 16. OAuth Broker

For OAuth 2.0 integrations (Google Calendar, Microsoft Graph, etc.):

- Token lifecycle managed by `OAuthBroker` in `src/skill-forge/oauth-broker.js`
- Pending auth state persisted to NC Passwords (`oauth-pending-*` entries)
- Token refresh automatic with 60-second pre-expiry buffer
- 401 retry: cache invalidate → forceRefresh → retry once → fail with message
- Two flows: `authorization_code` (with PKCE + consent) and `client_credentials`
  (automatic, no consent)
- NC Passwords `notes` field is the token state store (read-modify-write discipline)
- `cleanExpiredPending()` runs on heartbeat cycle

---

*This document must stay accurate. If something is wrong, fix it and commit
the correction — don't work around it. If a path, name, or count has changed,
update it here in the same commit.*
