# MoltAgent Skill Forge: Safe Skill Generation & Distribution System

**Version:** 1.0  
**Date:** 2026-02-05  
**Status:** Architecture Defined  
**Purpose:** Claude Code Development Reference  
**Prerequisites:** Read `security-development.md` and `moltagent-architecture-summary.md` first — this document extends both.

---

## Executive Summary

Skill Forge is MoltAgent's answer to ClawHub's security disaster. Instead of letting users install unaudited third-party skills from an open marketplace (where 341+ malicious skills have been found), Skill Forge generates safe skills from pre-validated templates using a conversational Talk interface.

**Core insight:** OpenClaw skills are just SKILL.md files — markdown with YAML frontmatter. They contain no compiled code. The LLM reads them and follows the instructions. This means skills can be *assembled from templates* rather than *downloaded from strangers*.

**The architecture has four components:**

1. **Template Catalog** — Pre-validated YAML templates stored in Nextcloud, distributed via federated sharing
2. **Talk Conversation Engine** — Guided parameter collection via NC Talk (primary UI)
3. **NC Forms Fallback** — Structured forms for onboarding or users who prefer clicking over chatting
4. **Audit Gate** — Review step before any generated skill reaches OpenClaw

**Business model alignment:**

- Open source: Template engine, generic builder, Talk flow
- Paid (Concierge): Curated template catalog via federated share, ongoing template updates
- Premium: Custom template development for client-specific APIs

---

## Table of Contents

1. Problem Statement
2. Architecture Overview
3. Template Format Specification
4. Template Catalog Structure
5. Talk Conversation Engine
6. NC Forms Fallback
7. Audit Gate & Activation
8. Federated Distribution (NC Native CDN)
9. Generic Skill Builder (Custom Skills)
10. Security Model
11. Deployment & Provisioning
12. Implementation Plan
13. File Structure & Checklist

---

## 1. Problem Statement

### 1.1 The ClawHub Disaster

ClawHub is OpenClaw's public skill marketplace with 3,000+ community skills. As of February 2026:

| Issue | Impact |
|-------|--------|
| 341+ malicious skills discovered (ClawHavoc campaign) | AMOS infostealer, reverse shells, credential exfiltration |
| Fake prerequisites trick users into downloading malware | "Install this binary first" pattern |
| Skills run with full system access | No sandboxing, no permission model |
| Open-by-default publishing | Only requirement: 1-week-old GitHub account |
| No pre-publish security scanning | Community reporting only, after the fact |
| Credentials stored in plaintext | `~/.clawdbot/.env` readable by any process |

### 1.2 The UX Problem

Even ignoring security, ClawHub's UX doesn't work for MoltAgent's target customer:

- Skill management is CLI-only (`clawhub install`, `clawhub sync`)
- Requires SSH access to the Bot VM
- No guided setup for credentials or configuration
- No review step before activation
- Non-technical users can't participate

### 1.3 What MoltAgent Customers Actually Need

A non-technical user should be able to say:

> "Hey MoltAgent, I want you to manage my Trello board"

And have a working, secure Trello integration 5 minutes later — without touching a terminal, without visiting ClawHub, without risk.

---

## 2. Architecture Overview

```
┌─────────────────────────────────────────────────────────────────────────────────┐
│                          SKILL FORGE ARCHITECTURE                               │
├─────────────────────────────────────────────────────────────────────────────────┤
│                                                                                 │
│  USER INTERFACES                                                                │
│  ──────────────                                                                 │
│                                                                                 │
│  ┌──────────────────┐     ┌──────────────────┐                                  │
│  │   NC Talk         │     │   NC Forms        │                                 │
│  │   (Primary UI)    │     │   (Fallback UI)   │                                 │
│  │                   │     │                   │                                  │
│  │  Conversational   │     │  Structured       │                                  │
│  │  parameter        │     │  parameter        │                                  │
│  │  collection       │     │  collection       │                                  │
│  └────────┬──────────┘     └────────┬──────────┘                                 │
│           │                         │                                            │
│           └────────────┬────────────┘                                            │
│                        ▼                                                         │
│  TEMPLATE ENGINE                                                                 │
│  ───────────────                                                                 │
│  ┌──────────────────────────────────────────────────────────────────────┐        │
│  │                                                                      │        │
│  │  ┌─────────────┐    ┌─────────────┐    ┌─────────────────────────┐  │        │
│  │  │  Template    │    │  Parameter  │    │  SKILL.md               │  │        │
│  │  │  Catalog     │───▶│  Resolver   │───▶│  Assembler              │  │        │
│  │  │  (YAML)      │    │             │    │                         │  │        │
│  │  └─────────────┘    └─────────────┘    └────────────┬────────────┘  │        │
│  │                                                      │               │        │
│  └──────────────────────────────────────────────────────┼───────────────┘        │
│                                                         ▼                        │
│  AUDIT GATE                                                                      │
│  ──────────                                                                      │
│  ┌──────────────────────────────────────────────────────────────────────┐        │
│  │                                                                      │        │
│  │  ┌─────────────┐    ┌─────────────┐    ┌─────────────────────────┐  │        │
│  │  │  Security    │    │  Pending    │    │  Activation             │  │        │
│  │  │  Scanner     │───▶│  Review     │───▶│  Deployer               │  │        │
│  │  │  (automatic) │    │  (human)    │    │  (→ OpenClaw skills/)   │  │        │
│  │  └─────────────┘    └─────────────┘    └─────────────────────────┘  │        │
│  │                                                                      │        │
│  └──────────────────────────────────────────────────────────────────────┘        │
│                                                                                  │
│  DISTRIBUTION                                                                    │
│  ────────────                                                                    │
│  ┌──────────────────────────────────────────────────────────────────────┐        │
│  │                                                                      │        │
│  │  MoltAgent Prime NC ──── federated share (read-only) ───▶ Client NC │        │
│  │  /SkillTemplates/                                /SkillTemplates/    │        │
│  │                                                                      │        │
│  │  New templates added → all clients see them instantly                │        │
│  │                                                                      │        │
│  └──────────────────────────────────────────────────────────────────────┘        │
│                                                                                  │
└──────────────────────────────────────────────────────────────────────────────────┘
```

### 2.1 Data Flow

```
1. User requests new capability (Talk or Forms)
2. Skill Forge identifies matching template from catalog
3. Conversation/form collects required parameters
4. User stores credentials in NC Passwords (guided)
5. Template engine assembles SKILL.md from template + parameters
6. Security scanner validates output (automatic)
7. Generated skill placed in /Outbox/pending-skills/ for review
8. User (or operator) approves activation
9. Skill deployed to ~/.openclaw/skills/ on Bot VM
10. OpenClaw picks up skill on next session
```

---

## 3. Template Format Specification

### 3.1 Template YAML Schema

Each template is a YAML file that defines everything needed to generate a safe SKILL.md.

```yaml
# /SkillTemplates/trello.yaml
# ─────────────────────────────────────────────────────────

# METADATA
# ────────
skill_id: trello                          # Unique identifier, lowercase, no spaces
display_name: "Trello Board Management"   # Human-readable name
description: "Manage Trello cards, lists, and boards via API"
category: productivity                    # productivity | communication | development | custom
emoji: "📋"
version: "1.0"
author: "MoltAgent Forge"
template_version: "1"                     # Schema version for forward compatibility

# REQUIREMENTS
# ────────────
requires:
  bins:
    - curl
    - jq

# SECURITY CONSTRAINTS
# ────────────────────
security:
  allowed_domains:
    - "api.trello.com"
  forbidden_patterns:                     # Never allow these in generated output
    - "wget"
    - "pip install"
    - "npm install"
    - "chmod +x"
    - "eval"
    - "base64 -d"
    - "> /dev/tcp"
    - "nc -e"
    - ".env"
    - "HOME/"
  max_credential_count: 3                 # Max credentials this skill can request
  network_access: outbound_only           # outbound_only | none | bidirectional

# CREDENTIALS
# ────────────
# Each entry defines one credential the user must store in NC Passwords
credentials:
  - id: api_key
    nc_password_name: "trello-api-key"    # Exact name in NC Passwords
    label: "Trello API Key"               # Shown to user during setup
    help_url: "https://trello.com/power-ups/admin"
    help_text: "Go to Power-Up Admin → API Key → copy the key"
    validation_pattern: "^[a-f0-9]{32}$"  # Optional regex to validate format
    
  - id: token
    nc_password_name: "trello-token"
    label: "Trello API Token"
    help_url: "https://trello.com/1/authorize?expiration=never&scope=read,write&response_type=token&key={api_key}"
    help_text: "Click the link above (after getting your API key) → authorize → copy the token"

# PARAMETERS
# ──────────
# Each entry defines one piece of information collected from the user
parameters:
  - id: board_name
    label: "Board name"
    ask: "What's the name of the Trello board you want me to manage?"
    type: text                            # text | select | boolean
    required: true
    example: "Project Phoenix"

  - id: board_id
    label: "Board ID"
    ask: "What's the board ID? (You can find it in the board URL: trello.com/b/XXXXXXXX/...)"
    type: text
    required: true
    example: "a1B2c3D4"
    validation_pattern: "^[a-zA-Z0-9]{8}$"
    help_text: "Open your board in a browser. The ID is the 8 characters after /b/ in the URL."

  - id: enable_webhooks
    label: "Enable notifications"
    ask: "Do you want me to proactively notify you about card changes?"
    type: boolean
    required: false
    default: false

# SKILL TEMPLATE
# ──────────────
# The actual SKILL.md content with {{placeholders}} for parameters
# and {{credential:id}} for credential fetch instructions
skill_template: |
  ---
  name: trello-{{board_name_slug}}
  description: Manage Trello board "{{board_name}}" — list cards, create tasks, move cards between lists
  metadata: {"openclaw":{"emoji":"📋","requires":{"bins":["curl","jq"]}}}
  ---
  # Trello: {{board_name}}

  ## Authentication

  Fetch credentials from NC Passwords at runtime. NEVER store them.

  ```bash
  # Fetch Trello API key
  TRELLO_KEY=$(curl -s -u "$NC_USER:$NC_PASS" \
    -H "OCS-APIRequest: true" -H "Accept: application/json" \
    "{{nc_url}}/index.php/apps/passwords/api/1.0/password/list" \
    | jq -r '.[] | select(.label=="trello-api-key") | .password')

  # Fetch Trello token
  TRELLO_TOKEN=$(curl -s -u "$NC_USER:$NC_PASS" \
    -H "OCS-APIRequest: true" -H "Accept: application/json" \
    "{{nc_url}}/index.php/apps/passwords/api/1.0/password/list" \
    | jq -r '.[] | select(.label=="trello-token") | .password')
  ```

  After each operation, these variables are discarded automatically
  when the shell session ends.

  ## Board: {{board_name}}

  Board ID: `{{board_id}}`
  Base URL: `https://api.trello.com/1`

  ## Operations

  ### List all cards
  ```bash
  curl -s "https://api.trello.com/1/boards/{{board_id}}/cards?key=$TRELLO_KEY&token=$TRELLO_TOKEN" \
    | jq '[.[] | {id, name, idList, due, labels: [.labels[].name]}]'
  ```

  ### List all lists (columns)
  ```bash
  curl -s "https://api.trello.com/1/boards/{{board_id}}/lists?key=$TRELLO_KEY&token=$TRELLO_TOKEN" \
    | jq '[.[] | {id, name}]'
  ```

  ### Create a card
  ```bash
  curl -s -X POST "https://api.trello.com/1/cards" \
    -d "key=$TRELLO_KEY&token=$TRELLO_TOKEN&idList=LIST_ID&name=CARD_NAME&desc=DESCRIPTION"
  ```

  ### Move a card to another list
  ```bash
  curl -s -X PUT "https://api.trello.com/1/cards/CARD_ID" \
    -d "key=$TRELLO_KEY&token=$TRELLO_TOKEN&idList=TARGET_LIST_ID"
  ```

  ### Get card details
  ```bash
  curl -s "https://api.trello.com/1/cards/CARD_ID?key=$TRELLO_KEY&token=$TRELLO_TOKEN" \
    | jq '{name, desc, due, idList, labels: [.labels[].name], url}'
  ```

  ## Tips

  - Always fetch credentials fresh for each operation session
  - URL-encode card names and descriptions with special characters
  - List IDs change if lists are recreated — re-fetch if operations fail
  - Board URL: https://trello.com/b/{{board_id}}

# VERIFICATION
# ────────────
# Test command to verify the skill works after activation
verify:
  command: |
    curl -s "https://api.trello.com/1/boards/{{board_id}}?key=$TRELLO_KEY&token=$TRELLO_TOKEN" \
      | jq '.name'
  expected: "{{board_name}}"
  description: "Fetches board name to verify credentials and access"
```

### 3.2 Template Placeholders

| Placeholder | Source | Description |
|-------------|--------|-------------|
| `{{parameter_id}}` | User input | Direct parameter value |
| `{{parameter_id_slug}}` | Computed | URL/filename-safe version (lowercase, hyphens) |
| `{{nc_url}}` | System config | Client's Nextcloud base URL |
| `{{nc_user}}` | System config | MoltAgent's NC username |
| `{{nc_pass}}` | System config | MoltAgent's NC password (runtime only) |
| `{{date}}` | System | Generation date (ISO 8601) |
| `{{forge_version}}` | System | Template engine version |

### 3.3 Template Validation Rules

A template MUST:

1. Have a unique `skill_id`
2. Define at least one entry in `security.allowed_domains`
3. Not reference any domain not in `allowed_domains` within `skill_template`
4. Not contain any pattern from `security.forbidden_patterns` in `skill_template`
5. Reference credentials only by NC Passwords label names
6. Include credential fetch-and-discard pattern (never store)
7. Use only tools listed in `requires.bins`
8. Include a `verify` section for post-activation testing

A template MUST NOT:

1. Contain hardcoded credentials or API keys
2. Include download instructions for external binaries
3. Reference `~/.clawdbot/`, `~/.openclaw/`, or any config files
4. Include `eval`, `exec`, `source`, or dynamic code execution
5. Write to system paths outside the Nextcloud workspace
6. Include outbound connections to domains not in `allowed_domains`

---

## 4. Template Catalog Structure

### 4.1 Directory Layout

```
/SkillTemplates/                          # Root — federated-shared with clients
├── _catalog.json                         # Master index of all templates
├── _schema.json                          # JSON Schema for template validation
├── _version.txt                          # Catalog version (semver)
│
├── productivity/
│   ├── trello.yaml
│   ├── todoist.yaml
│   ├── notion.yaml
│   ├── google-calendar.yaml
│   ├── google-tasks.yaml
│   └── apple-reminders.yaml
│
├── communication/
│   ├── email-imap.yaml
│   ├── slack-webhook.yaml
│   ├── telegram-bot.yaml
│   └── matrix-room.yaml
│
├── development/
│   ├── github-repo.yaml
│   ├── github-issues.yaml
│   ├── gitlab-project.yaml
│   └── linear-issues.yaml
│
├── data/
│   ├── airtable.yaml
│   ├── google-sheets.yaml
│   └── csv-processor.yaml
│
├── monitoring/
│   ├── uptime-check.yaml
│   ├── rss-feed.yaml
│   └── website-change.yaml
│
├── generic/
│   └── rest-api.yaml                     # The Generic Skill Builder
│
└── _retired/                             # Templates removed from active catalog
    └── deprecated-template.yaml
```

### 4.2 Catalog Index (_catalog.json)

```json
{
  "version": "1.0.0",
  "updated": "2026-02-05T12:00:00Z",
  "author": "MoltAgent Forge",
  "templates": [
    {
      "skill_id": "trello",
      "display_name": "Trello Board Management",
      "category": "productivity",
      "emoji": "📋",
      "description": "Manage Trello cards, lists, and boards",
      "file": "productivity/trello.yaml",
      "version": "1.0",
      "credentials_count": 2,
      "parameters_count": 3,
      "difficulty": "easy",
      "estimated_setup_minutes": 5
    },
    {
      "skill_id": "rest-api",
      "display_name": "Custom REST API Connection",
      "category": "generic",
      "emoji": "🔧",
      "description": "Connect to any REST API — the Generic Skill Builder",
      "file": "generic/rest-api.yaml",
      "version": "1.0",
      "credentials_count": 1,
      "parameters_count": 6,
      "difficulty": "intermediate",
      "estimated_setup_minutes": 15
    }
  ]
}
```

### 4.3 Launch Catalog (First 15 Templates)

Priority order based on expected customer demand:

| # | Template | Category | Difficulty | Why First |
|---|----------|----------|------------|-----------|
| 1 | `rest-api` (Generic Builder) | generic | intermediate | Covers ANY API not in catalog |
| 2 | `email-imap` | communication | easy | Email is universal |
| 3 | `google-calendar` | productivity | easy | Calendar management is core |
| 4 | `trello` | productivity | easy | Popular project management |
| 5 | `github-issues` | development | easy | Dev users are early adopters |
| 6 | `slack-webhook` | communication | easy | Business communication |
| 7 | `todoist` | productivity | easy | Popular task manager |
| 8 | `notion` | productivity | intermediate | Knowledge workers love Notion |
| 9 | `uptime-check` | monitoring | easy | Simple, high-value, no credentials |
| 10 | `rss-feed` | monitoring | easy | Content monitoring, no credentials |
| 11 | `github-repo` | development | easy | File operations on repos |
| 12 | `telegram-bot` | communication | easy | Messaging bridge |
| 13 | `google-sheets` | data | intermediate | Spreadsheet automation |
| 14 | `linear-issues` | development | easy | Startup crowd uses Linear |
| 15 | `website-change` | monitoring | easy | Track competitor pages, no credentials |

---

## 5. Talk Conversation Engine

### 5.1 Overview

The Talk Conversation Engine is the primary UI for Skill Forge. Users interact via NC Talk to request, configure, and activate new skills. The engine handles:

1. Capability discovery ("What can you connect to?")
2. Template matching ("I want Trello" → finds `trello.yaml`)
3. Guided parameter collection (asks questions defined in template)
4. Credential setup guidance (walks user through NC Passwords)
5. Skill assembly and review
6. Activation on approval

### 5.2 Conversation Flow State Machine

```
┌─────────┐    user requests    ┌──────────────┐
│  IDLE   │───────────────────▶│  DISCOVERY    │
└─────────┘    capability       └──────┬───────┘
                                       │
                          ┌────────────┴────────────┐
                          ▼                         ▼
                   ┌──────────────┐         ┌──────────────┐
                   │  TEMPLATE    │         │  GENERIC     │
                   │  MATCHED     │         │  BUILDER     │
                   └──────┬───────┘         └──────┬───────┘
                          │                         │
                          └────────────┬────────────┘
                                       ▼
                                ┌──────────────┐
                                │  COLLECTING   │
                                │  CREDENTIALS  │
                                └──────┬───────┘
                                       │
                                       ▼
                                ┌──────────────┐
                                │  COLLECTING   │
                                │  PARAMETERS   │
                                └──────┬───────┘
                                       │
                                       ▼
                                ┌──────────────┐
                                │  ASSEMBLING   │
                                └──────┬───────┘
                                       │
                                       ▼
                                ┌──────────────┐
                                │  REVIEW       │──── user rejects ────▶ back to
                                └──────┬───────┘                        COLLECTING
                                       │
                                       │ user approves
                                       ▼
                                ┌──────────────┐
                                │  ACTIVATING   │
                                └──────┬───────┘
                                       │
                                       ▼
                                ┌──────────────┐
                                │  VERIFYING    │
                                └──────┬───────┘
                                       │
                                       ▼
                                ┌──────────────┐
                                │  COMPLETE     │
                                └──────────────┘
```

### 5.3 Conversation State Persistence

Store conversation state in `/Memory/SkillForge/` as JSON:

```json
{
  "session_id": "forge-2026-02-05-001",
  "state": "COLLECTING_PARAMETERS",
  "template_id": "trello",
  "started": "2026-02-05T10:30:00Z",
  "user": "Funana",
  "credentials_collected": {
    "api_key": { "stored": true, "nc_password_name": "trello-api-key" },
    "token": { "stored": false }
  },
  "parameters_collected": {
    "board_name": "Project Phoenix",
    "board_id": null,
    "enable_webhooks": null
  },
  "current_step": "parameters.board_id"
}
```

### 5.4 Talk Command Triggers

The engine activates on specific phrases in Talk:

| Trigger Pattern | Action |
|-----------------|--------|
| "connect to [service]", "add [service]", "integrate [service]" | Template lookup → start flow |
| "what can you connect to?", "what skills are available?" | List catalog |
| "I want to connect my own API", "custom API" | Start Generic Builder |
| "show my active skills", "what are you connected to?" | List installed skills |
| "remove [skill]", "disconnect [service]" | Deactivation flow |
| "skill status", "forge status" | Show pending/active/failed skills |

### 5.5 Example Conversation: Known Template

```
User: I want you to manage my Trello board

MoltAgent: I can connect to Trello! 📋

I'll need a couple of things from you. Let's start with credentials.

STEP 1: Get your Trello API Key
  → Go to https://trello.com/power-ups/admin
  → Copy your API key (it's 32 characters, letters and numbers)
  → In your Nextcloud, open the Passwords app
  → Create a new entry called exactly: trello-api-key
  → Paste your API key as the password
  → Save it

Let me know when that's done!

User: Done

MoltAgent: Let me verify... ✅ Found "trello-api-key" in your Passwords.

STEP 2: Get your Trello Token
  → Open this link: https://trello.com/1/authorize?expiration=never&scope=read,write&response_type=token&key=YOUR_KEY
  → Click "Allow"
  → Copy the token
  → Create another Passwords entry called: trello-token
  → Save it

User: Done

MoltAgent: ✅ Found "trello-token" in your Passwords. Credentials are set!

Now a couple of quick questions:

What's the name of the board you want me to manage?

User: Project Phoenix

MoltAgent: And I need the board ID — you can find it in the URL when you open
the board. It looks like trello.com/b/XXXXXXXX/project-phoenix — I need
those 8 characters after /b/.

User: a1B2c3D4

MoltAgent: Got it! One more — do you want me to proactively notify you
about card changes, or only respond when you ask?

User: Just when I ask for now

MoltAgent: Here's what I've prepared:

📋 Skill: trello-project-phoenix
🔗 Connected to: Project Phoenix (a1B2c3D4)
🔑 Credentials: trello-api-key, trello-token (via NC Passwords)
🌐 Allowed domain: api.trello.com only
📡 Notifications: Off

I've placed the skill file in your Outbox for review:
  /Outbox/pending-skills/trello-project-phoenix.md

Want me to activate it now, or do you want to review it first?

User: Activate it!

MoltAgent: Activating... ✅ Skill deployed!

Let me verify it works — fetching your board...
✅ Board "Project Phoenix" found with 3 lists and 12 cards.

You can now ask me things like:
  • "Show my Trello cards"
  • "Create a card called 'Design review' in the To Do list"
  • "Move 'Homepage mockup' to Done"

Anything else you'd like to connect?
```

### 5.6 Example Conversation: Generic Skill Builder

```
User: I want you to connect to our company's internal API

MoltAgent: Sure! I'll set up a custom API connection for you. 🔧

Let's start with the basics:

What's the base URL of the API?

User: https://api.acmecorp.com/v2

MoltAgent: Got it. What authentication method does the API use?
  • API Key in header
  • Bearer token
  • Basic auth (username/password)
  • No auth

User: API Key in header

MoltAgent: What's the header name for the API key?
(Common ones: X-API-Key, Authorization, X-Custom-Key)

User: X-Acme-Auth

MoltAgent: Please store the API key in NC Passwords as "acmecorp-api-key".

User: Done

MoltAgent: ✅ Found it!

Now, what do you want me to be able to do with this API?
Tell me the main operations — I'll ask for the endpoint details one by one.

User: List projects, create tasks, get task details

MoltAgent: Let's define each one.

OPERATION 1: List projects
  What's the endpoint? (e.g., GET /projects)

User: GET /projects

MoltAgent: Does it return JSON?

User: Yes, an array of objects with id, name, status

MoltAgent: OPERATION 2: Create tasks
  What's the endpoint?

User: POST /projects/{project_id}/tasks
  Body is JSON with fields: title, description, assignee

MoltAgent: OPERATION 3: Get task details
  Endpoint?

User: GET /tasks/{task_id}

MoltAgent: Here's what I've built:

🔧 Skill: acmecorp-api
🌐 Base URL: https://api.acmecorp.com/v2
🔑 Auth: X-Acme-Auth header (via NC Passwords: "acmecorp-api-key")
🌐 Allowed domain: api.acmecorp.com ONLY

Operations:
  1. List projects — GET /projects
  2. Create task — POST /projects/{id}/tasks
  3. Get task — GET /tasks/{id}

Placed in /Outbox/pending-skills/acmecorp-api.md for review.
Activate now?
```

---

## 6. NC Forms Fallback

### 6.1 Overview

NC Forms provides a structured alternative for users who prefer form-based interaction or for initial onboarding before Talk is fully configured. Forms are created programmatically during deployment via the NC Forms API.

### 6.2 Forms API Integration

```bash
# Create a form via NC Forms API v3
curl -X POST \
  -u "$NC_ADMIN:$NC_PASS" \
  -H "OCS-APIRequest: true" \
  -H "Content-Type: application/json" \
  -H "Accept: application/json" \
  "https://$NC_URL/ocs/v2.php/apps/forms/api/v3/forms" \
  -d '{
    "title": "MoltAgent — Request New Skill",
    "description": "Tell MoltAgent what service you want to connect"
  }'
```

### 6.3 Provisioned Forms

During deployment, create these forms:

**Form 1: Request a Skill from Catalog**

| Question | Type | Options |
|----------|------|---------|
| "What service do you want to connect?" | Dropdown | (populated from _catalog.json) |
| "Any special requirements?" | Long text | (free form) |

**Form 2: Custom API Connection**

| Question | Type | Options |
|----------|------|---------|
| "API base URL" | Short text | — |
| "Authentication method" | Dropdown | API Key / Bearer / Basic / None |
| "Auth header name (if API key)" | Short text | — |
| "NC Passwords entry name for credential" | Short text | — |
| "Operations (describe what you want to do)" | Long text | — |

### 6.4 Form Submission Processing

MoltAgent polls for new form submissions periodically (as part of the heartbeat cycle):

```bash
# Fetch form submissions
curl -s -u "$NC_USER:$NC_PASS" \
  -H "OCS-APIRequest: true" \
  -H "Accept: application/json" \
  "https://$NC_URL/ocs/v2.php/apps/forms/api/v3/forms/FORM_ID/submissions"
```

New submissions trigger the same template engine flow as Talk — the only difference is where the parameters come from.

---

## 7. Audit Gate & Activation

### 7.1 Security Scanner

Every generated SKILL.md passes through an automated security scan before it reaches the pending review folder.

```javascript
// src/skill-forge/security-scanner.js

class SkillSecurityScanner {
  
  /**
   * Scans a generated SKILL.md for security violations.
   * Returns { safe: boolean, violations: string[], warnings: string[] }
   */
  scan(skillContent, templateConfig) {
    const violations = [];
    const warnings = [];
    
    // 1. Check for forbidden patterns
    for (const pattern of GLOBAL_FORBIDDEN_PATTERNS) {
      if (skillContent.includes(pattern)) {
        violations.push(`Forbidden pattern found: "${pattern}"`);
      }
    }
    
    // 2. Check domains against allowlist
    const urls = this.extractURLs(skillContent);
    for (const url of urls) {
      const domain = new URL(url).hostname;
      if (!templateConfig.security.allowed_domains.includes(domain)) {
        violations.push(`Unauthorized domain: ${domain}`);
      }
    }
    
    // 3. Check for credential patterns in content (not in fetch blocks)
    const credentialPatterns = [
      /sk-[a-zA-Z0-9]{20,}/,           // API keys
      /ghp_[a-zA-Z0-9]{36}/,           // GitHub tokens
      /xoxb-[0-9]+-[0-9]+-[a-zA-Z0-9]+/, // Slack tokens
      /[A-Za-z0-9+/]{40,}={0,2}/       // Base64 encoded secrets
    ];
    for (const pattern of credentialPatterns) {
      if (pattern.test(skillContent)) {
        violations.push(`Possible hardcoded credential detected`);
      }
    }
    
    // 4. Check binary requirements
    const SAFE_BINS = ['curl', 'jq', 'grep', 'sed', 'awk', 'date', 'echo', 'cat', 'head', 'tail'];
    // ... verify only safe binaries referenced
    
    // 5. Warnings (non-blocking)
    if (skillContent.length > 10000) {
      warnings.push(`Skill is unusually large (${skillContent.length} chars)`);
    }
    
    return {
      safe: violations.length === 0,
      violations,
      warnings
    };
  }
}
```

Global forbidden patterns (applies to ALL skills, including generic builder output):

```javascript
const GLOBAL_FORBIDDEN_PATTERNS = [
  // Arbitrary code execution
  'eval', 'exec', 'source ', './', 'bash -c',
  
  // Binary downloads
  'wget', 'pip install', 'npm install', 'apt install',
  'brew install', 'cargo install', 'go install',
  'chmod +x', 'chmod 777', 'chmod 755',
  
  // Exfiltration channels
  '> /dev/tcp', 'nc -e', 'nc -l',
  'webhook.site', 'requestbin', 'pipedream',
  'pastebin.com', 'transfer.sh',
  
  // Config file access
  '.clawdbot', '.openclaw/config', '.env',
  '/etc/shadow', '/etc/passwd',
  'CREDENTIALS_DIRECTORY',
  
  // Reverse shells
  'mkfifo', '/bin/sh -i', 'python -c',
  'ruby -rsocket', 'perl -e',
  
  // Encoding tricks
  'base64 -d', 'xxd', 'printf.*\\x',
];
```

### 7.2 Pending Review Folder

Generated skills land in `/Outbox/pending-skills/` on the client's NC:

```
/Outbox/pending-skills/
├── trello-project-phoenix.md         # Waiting for activation
├── trello-project-phoenix.meta.json  # Generation metadata
└── acmecorp-api.md                   # Custom skill waiting
```

The `.meta.json` file records:

```json
{
  "generated_at": "2026-02-05T10:45:00Z",
  "template_id": "trello",
  "template_version": "1.0",
  "forge_version": "1.0.0",
  "parameters": {
    "board_name": "Project Phoenix",
    "board_id": "a1B2c3D4"
  },
  "credentials_referenced": ["trello-api-key", "trello-token"],
  "security_scan": {
    "passed": true,
    "violations": [],
    "warnings": [],
    "scanned_at": "2026-02-05T10:45:01Z"
  },
  "status": "pending_review",
  "activated_at": null,
  "activated_by": null
}
```

### 7.3 Activation Flow

```javascript
// src/skill-forge/activator.js

class SkillActivator {
  
  /**
   * Deploys a pending skill to OpenClaw's skill directory.
   * Called when user approves via Talk or Forms.
   */
  async activate(skillFilename) {
    const pendingPath = `/Outbox/pending-skills/${skillFilename}`;
    const metaPath = `/Outbox/pending-skills/${skillFilename.replace('.md', '.meta.json')}`;
    
    // 1. Read and re-scan (defense in depth — file could have been modified)
    const content = await this.ncFiles.read(pendingPath);
    const scanResult = this.scanner.scan(content, this.getTemplateConfig(metaPath));
    
    if (!scanResult.safe) {
      throw new Error(`Security scan failed on activation: ${scanResult.violations.join(', ')}`);
    }
    
    // 2. Extract skill name from YAML frontmatter
    const skillName = this.extractSkillName(content);
    
    // 3. Create skill directory on Bot VM
    const skillDir = `${OPENCLAW_SKILLS_DIR}/${skillName}`;
    await fs.mkdir(skillDir, { recursive: true });
    await fs.writeFile(`${skillDir}/SKILL.md`, content);
    
    // 4. Update metadata
    const meta = JSON.parse(await this.ncFiles.read(metaPath));
    meta.status = 'active';
    meta.activated_at = new Date().toISOString();
    meta.activated_by = this.currentUser;
    await this.ncFiles.write(metaPath, JSON.stringify(meta, null, 2));
    
    // 5. Move to active skills record in NC
    await this.ncFiles.move(pendingPath, `/Memory/ActiveSkills/${skillFilename}`);
    await this.ncFiles.move(metaPath, `/Memory/ActiveSkills/${skillFilename.replace('.md', '.meta.json')}`);
    
    // 6. Log activation
    await this.auditLog.log('SKILL_ACTIVATED', {
      skill: skillName,
      template: meta.template_id,
      user: this.currentUser
    });
    
    // 7. Verify (if template has verify section)
    if (meta.template_id !== 'rest-api') {
      // Run verification command from template
      const verifyResult = await this.runVerification(skillName, meta);
      return { activated: true, verified: verifyResult.success };
    }
    
    return { activated: true, verified: null };
  }
}
```

---

## 8. Federated Distribution (NC Native CDN)

### 8.1 Architecture

```
┌──────────────────────────────────────────────────────────────────────┐
│                       MOLTAGENT PRIME (Your NC)                      │
│                                                                      │
│  /SkillTemplates/  ──── federated share (read-only) ────────────┐   │
│  ├── _catalog.json                                               │   │
│  ├── productivity/trello.yaml                                    │   │
│  ├── productivity/todoist.yaml                                   │   │
│  └── ...                                                         │   │
│                                                                  │   │
│  You add a new template here → all clients see it instantly      │   │
│                                                                  │   │
└──────────────────────────────────────────────────────────────────┘   │
                                                                       │
      ┌────────────────────────────────────────────────────────────────┘
      │
      ▼
┌─────────────────────────┐  ┌─────────────────────────┐
│  CLIENT A's NC           │  │  CLIENT B's NC           │
│                          │  │                          │
│  /SkillTemplates/        │  │  /SkillTemplates/        │
│  (federated, read-only)  │  │  (federated, read-only)  │
│                          │  │                          │
│  Client A's MoltAgent    │  │  Client B's MoltAgent    │
│  reads templates from    │  │  reads templates from    │
│  here during Forge flow  │  │  here during Forge flow  │
│                          │  │                          │
└──────────────────────────┘  └──────────────────────────┘
```

### 8.2 Federation Setup (During Concierge Deployment)

Hetzner Storage Share supports federated sharing using Federated Cloud IDs in the format `User@nxXXXXX.your-storageshare.de`.

Setup steps during deployment:

```bash
# On MoltAgent Prime NC:
# 1. Share /SkillTemplates/ with client's MoltAgent user via federation
#    Share type: federated (remote share)
#    Permission: read-only
#    Target: Moltagent@nxCLIENT.your-storageshare.de

# On Client NC:
# 2. Accept the incoming federated share
#    This appears in MoltAgent user's file list as /SkillTemplates/

# 3. Verify access from Bot VM
curl -s -u "$NC_USER:$NC_PASS" \
  "$NC_URL/remote.php/dav/files/Moltagent/SkillTemplates/_catalog.json"
```

### 8.3 Template Updates

When you add or update a template on MoltAgent Prime:

1. Edit/add the YAML file in `/SkillTemplates/` on your NC
2. Update `_catalog.json` with new entry or bumped version
3. Bump `_version.txt`
4. All clients see changes on next access (NC federation syncs automatically)

MoltAgent on each client can check for catalog updates during heartbeat:

```javascript
async checkTemplateUpdates() {
  const remoteVersion = await this.ncFiles.read('/SkillTemplates/_version.txt');
  const localVersion = await this.memory.get('forge.catalog_version');
  
  if (remoteVersion !== localVersion) {
    // Re-read catalog
    const catalog = JSON.parse(
      await this.ncFiles.read('/SkillTemplates/_catalog.json')
    );
    await this.memory.set('forge.catalog', catalog);
    await this.memory.set('forge.catalog_version', remoteVersion);
    
    // Optionally notify user
    await this.talk.send(
      `📦 Skill catalog updated to v${remoteVersion} — ` +
      `${catalog.templates.length} templates available. ` +
      `Say "what's new?" to see changes.`
    );
  }
}
```

### 8.4 Business Model Integration

| Tier | Template Access | Distribution |
|------|----------------|--------------|
| Open Source (free) | Template engine + generic builder + 3 basic templates (rest-api, uptime-check, rss-feed) | Included in repo |
| Concierge (paid setup) | Full catalog (15+ templates) | Federated share from Prime |
| Subscription (€49/month) | Full catalog + monthly updates + priority template requests | Federated share from Prime |
| Custom Development (€85/hr) | Custom templates for client-specific APIs | Delivered to client + added to their federated share |

---

## 9. Generic Skill Builder (Custom Skills)

### 9.1 Overview

The Generic Skill Builder (`generic/rest-api.yaml`) is a special meta-template that generates skills for any REST API. It collects API structure information conversationally and produces a safe, constrained SKILL.md.

### 9.2 Template Structure

```yaml
# /SkillTemplates/generic/rest-api.yaml

skill_id: rest-api
display_name: "Custom REST API Connection"
description: "Connect to any REST API — the Generic Skill Builder"
category: generic
emoji: "🔧"
version: "1.0"

requires:
  bins:
    - curl
    - jq

security:
  # allowed_domains is DYNAMIC — set from user input
  allowed_domains: ["{{base_domain}}"]
  forbidden_patterns:
    # Same global list plus:
    - "localhost"
    - "127.0.0.1"
    - "0.0.0.0"
    - "169.254"            # Link-local / metadata
    - "metadata.google"    # Cloud metadata
    - "metadata.hetzner"   # Hetzner metadata
  max_credential_count: 2

credentials:
  - id: api_credential
    nc_password_name: "{{service_slug}}-api-key"
    label: "API credential for {{service_name}}"

parameters:
  - id: service_name
    label: "Service name"
    ask: "What's the name of this service/API?"
    type: text
    required: true

  - id: base_url
    label: "Base URL"
    ask: "What's the base URL of the API?"
    type: text
    required: true
    validation_pattern: "^https://.+"
    help_text: "Must start with https:// — we don't support insecure HTTP connections"

  - id: auth_method
    label: "Authentication method"
    ask: "How does the API authenticate?"
    type: select
    options:
      - value: header_key
        label: "API Key in header"
      - value: bearer
        label: "Bearer token"
      - value: basic
        label: "Basic auth (username/password)"
      - value: none
        label: "No authentication"
    required: true

  - id: auth_header
    label: "Auth header name"
    ask: "What's the header name for the API key?"
    type: text
    required: false
    condition: "auth_method == header_key"
    default: "X-API-Key"

  - id: operations
    label: "Operations"
    ask: "What operations do you want? I'll ask for details one by one."
    type: operation_list
    required: true
    min_items: 1
    max_items: 10

# Dynamic template — assembled by the builder engine
# rather than a single static template string
```

### 9.3 Operation Collection

For each operation, collect:

```yaml
operation:
  name: "List projects"           # Human-readable
  method: "GET"                   # GET | POST | PUT | PATCH | DELETE
  path: "/projects"               # Endpoint path
  query_params: []                # Optional query parameters
  body_type: null                 # null | json | form
  body_fields: []                 # If json: field names and types
  response_description: "Array of project objects"
```

### 9.4 HTTPS-Only Enforcement

The Generic Builder MUST reject non-HTTPS URLs:

```javascript
if (!baseUrl.startsWith('https://')) {
  await this.talk.send(
    "⚠️ I only support HTTPS connections for security reasons. " +
    "Please provide an https:// URL."
  );
  return; // Stay in parameter collection
}
```

Also reject internal/metadata IPs to prevent SSRF:

```javascript
const BLOCKED_DOMAINS = [
  'localhost', '127.0.0.1', '0.0.0.0',
  '169.254.169.254', 'metadata.google.internal',
  'metadata.hetzner.cloud',
  // Block all private ranges
  /^10\./, /^172\.(1[6-9]|2\d|3[01])\./, /^192\.168\./
];
```

---

## 10. Security Model

### 10.1 Security Properties

| Property | Mechanism |
|----------|-----------|
| No arbitrary code execution | Templates only allow `curl` and `jq`; forbidden patterns block `eval`, `exec`, shells |
| No credential exposure | All credentials via NC Passwords; forbidden patterns block `.env`, config files |
| No exfiltration | `allowed_domains` whitelist per skill; forbidden patterns block known exfil services |
| No malware delivery | No binary downloads; forbidden patterns block `wget`, `pip`, `npm`, `chmod +x` |
| No SSRF | Generic builder blocks localhost, private IPs, cloud metadata endpoints |
| Audit trail | Every generation, scan, and activation logged with metadata |
| Human review | Generated skills land in pending folder; activation requires explicit approval |
| Defense in depth | Re-scan on activation (file could have been modified between generation and approval) |

### 10.2 Comparison: Skill Forge vs ClawHub

| Risk | ClawHub | Skill Forge |
|------|---------|-------------|
| Malicious skill in marketplace | 341+ confirmed | Impossible — templates are curated |
| Binary download in prerequisites | Common attack vector | Blocked by forbidden patterns |
| Credential theft | Via plaintext `.env` access | Credentials never in skill file |
| Reverse shell backdoor | Found in 2+ skills | Blocked by forbidden patterns |
| Unaudited third-party code | Default (open publishing) | Every template audited by operator |
| User installs malware unknowingly | "Install this first" social engineering | No installation step — skills are text files |

### 10.3 Integration with Existing Security Layers

Skill Forge integrates with the guards from `security-development.md`:

- **EgressGuard:** `allowed_domains` from templates feed into EgressGuard allowlist
- **ToolGuard:** Generated skills only reference `curl` and `jq` — both on the "allowed" list
- **PathGuard:** Generated skills never reference blocked paths
- **SecretsGuard:** Security scanner catches hardcoded credentials; output guard catches leaked credentials in responses
- **PromptGuard:** Template content is trusted (operator-authored); user parameters are sanitized before injection into templates

---

## 11. Deployment & Provisioning

### 11.1 Concierge Deployment Steps

Add these steps to the existing Ansible playbook:

```yaml
# roles/skill-forge/tasks/main.yml

- name: Create Skill Forge directories on NC
  include_tasks: nc-webdav-mkdir.yml
  loop:
    - /Memory/SkillForge
    - /Memory/ActiveSkills
    - /Outbox/pending-skills
    - /Context/SkillTemplates   # Only if not using federation

- name: Accept federated share from MoltAgent Prime
  # This step requires the operator to initiate the share from Prime
  # and the client to accept it. Document in handoff email.
  debug:
    msg: "Federated share setup requires manual step — see delivery email template"

- name: Create NC Forms for Skill Forge
  include_tasks: create-forge-forms.yml
  when: nc_forms_installed | default(true)

- name: Deploy Skill Forge engine to Bot VM
  copy:
    src: "{{ moltagent_src }}/src/skill-forge/"
    dest: /opt/moltagent/src/skill-forge/
    owner: moltagent
    group: moltagent
    mode: '0755'

- name: Update MoltAgent config with Forge settings
  template:
    src: forge-config.json.j2
    dest: /opt/moltagent/config/forge.json
    owner: moltagent
    group: moltagent
    mode: '0600'
```

### 11.2 Forge Configuration

```json
{
  "forge": {
    "enabled": true,
    "templateSource": "nextcloud",
    "templatePath": "/SkillTemplates",
    "pendingPath": "/Outbox/pending-skills",
    "activeSkillsPath": "/Memory/ActiveSkills",
    "statePath": "/Memory/SkillForge",
    "openclawSkillsDir": "/root/.openclaw/skills",
    "autoActivate": false,
    "scanOnActivation": true,
    "notifyOnCatalogUpdate": true,
    "formsIntegration": {
      "enabled": true,
      "pollIntervalSeconds": 300,
      "skillRequestFormId": null,
      "customApiFormId": null
    }
  }
}
```

### 11.3 NC Forms Provisioning Script

```bash
#!/bin/bash
# scripts/provision-forge-forms.sh
# Creates NC Forms for Skill Forge during deployment

NC_URL="$1"
NC_ADMIN="$2"
NC_PASS="$3"

HEADERS='-H "OCS-APIRequest: true" -H "Content-Type: application/json" -H "Accept: application/json"'

# Create "Request a Skill" form
FORM_RESPONSE=$(curl -s -X POST \
  -u "$NC_ADMIN:$NC_PASS" \
  -H "OCS-APIRequest: true" \
  -H "Content-Type: application/json" \
  -H "Accept: application/json" \
  "$NC_URL/ocs/v2.php/apps/forms/api/v3/forms" \
  -d '{"title":"MoltAgent — Request New Skill","description":"Tell MoltAgent what service you want to connect. Your request will be processed and you will be guided through the setup."}')

FORM_ID=$(echo "$FORM_RESPONSE" | jq -r '.ocs.data.id')

# Add questions to form
# Question 1: Service selection
curl -s -X POST \
  -u "$NC_ADMIN:$NC_PASS" \
  -H "OCS-APIRequest: true" \
  -H "Content-Type: application/json" \
  -H "Accept: application/json" \
  "$NC_URL/ocs/v2.php/apps/forms/api/v3/forms/$FORM_ID/questions" \
  -d '{"type":"short","text":"What service do you want to connect? (e.g., Trello, Google Calendar, Slack, or describe your own API)","isRequired":true}'

# Question 2: What do you want to do?
curl -s -X POST \
  -u "$NC_ADMIN:$NC_PASS" \
  -H "OCS-APIRequest: true" \
  -H "Content-Type: application/json" \
  -H "Accept: application/json" \
  "$NC_URL/ocs/v2.php/apps/forms/api/v3/forms/$FORM_ID/questions" \
  -d '{"type":"long","text":"What do you want MoltAgent to do with this service? (e.g., manage cards, read emails, track tasks)","isRequired":true}'

# Question 3: Priority
curl -s -X POST \
  -u "$NC_ADMIN:$NC_PASS" \
  -H "OCS-APIRequest: true" \
  -H "Content-Type: application/json" \
  -H "Accept: application/json" \
  "$NC_URL/ocs/v2.php/apps/forms/api/v3/forms/$FORM_ID/questions" \
  -d '{"type":"short","text":"Priority (nice to have / important / urgent)","isRequired":false}'

echo "Created Skill Request form: ID=$FORM_ID"
echo "Update forge.json with: \"skillRequestFormId\": $FORM_ID"
```

---

## 12. Implementation Plan

### 12.1 Phase 1: Template Engine Core (MVP)

**Goal:** Assemble SKILL.md from template + parameters. No Talk UI yet — manual parameter input via config files for testing.

```
Files to create:
├── src/skill-forge/
│   ├── index.js                    # Main Forge module export
│   ├── template-loader.js          # Read & validate templates from NC
│   ├── template-engine.js          # Parameter resolution & SKILL.md assembly
│   ├── security-scanner.js         # Pre-activation security scan
│   ├── activator.js                # Deploy to OpenClaw skills directory
│   └── constants.js                # Forbidden patterns, safe bins list

Test:
  1. Create trello.yaml template manually
  2. Call template engine with hardcoded params
  3. Verify generated SKILL.md passes security scan
  4. Activate and verify OpenClaw picks it up
```

**Implementation details for Claude Code:**

- Use Node.js (consistent with existing MoltAgent codebase)
- Zero external dependencies — use built-in `fs`, `path`, `crypto`
- Template loading via existing `ncFiles` client (WebDAV)
- YAML parsing: use the `yaml` npm package (already available, or use simple regex for basic frontmatter)
- Template variable substitution: simple `{{placeholder}}` replacement with escaping
- Slug generation: lowercase, replace spaces/special chars with hyphens
- All file paths relative to NC workspace root

### 12.2 Phase 2: Talk Conversation Engine

**Goal:** Conversational skill setup via NC Talk.

```
Files to create:
├── src/skill-forge/
│   ├── talk-engine.js              # Conversation state machine
│   ├── talk-patterns.js            # Trigger phrase matching
│   ├── credential-verifier.js      # Check NC Passwords for stored creds
│   └── conversation-state.js       # State persistence to /Memory/SkillForge/

Integration:
  Hook into existing Talk message handler (HeartbeatManager / message processor)
  When incoming message matches forge trigger patterns → route to talk-engine
```

**Implementation details for Claude Code:**

- State machine pattern: switch on `state` field from conversation state JSON
- Trigger matching: simple string includes/regex, not NLP (keep it deterministic)
- Credential verification: query NC Passwords API to check if label exists (don't read the value)
- State persistence: read/write JSON to `/Memory/SkillForge/session-{id}.json` via ncFiles
- Conversation timeout: expire incomplete sessions after 24 hours

### 12.3 Phase 3: NC Forms Integration

**Goal:** Forms as alternative input + form provisioning during deployment.

```
Files to create:
├── src/skill-forge/
│   ├── forms-poller.js             # Poll NC Forms API for submissions
│   └── forms-adapter.js            # Convert form submissions to template params

Scripts:
├── scripts/
│   └── provision-forge-forms.sh    # Create forms during deployment
```

### 12.4 Phase 4: Federated Distribution

**Goal:** Template catalog shared from Prime to all clients.

```
Tasks:
  1. Set up /SkillTemplates/ on MoltAgent Prime NC
  2. Create _catalog.json with launch templates
  3. Write 15 launch templates
  4. Test federated sharing with test client
  5. Add catalog version checking to heartbeat
  6. Document federation setup in concierge guide

Files to create:
├── src/skill-forge/
│   └── catalog-sync.js             # Check for template catalog updates
```

### 12.5 Phase 5: Generic Skill Builder

**Goal:** Custom API skill generation via conversation.

```
Files to create:
├── src/skill-forge/
│   ├── generic-builder.js          # Extended conversation flow for custom APIs
│   └── operation-collector.js      # Structured operation definition collection
```

---

## 13. File Structure & Checklist

### 13.1 Complete File Tree

```
src/skill-forge/
├── index.js                        # Module export, init, config
├── constants.js                    # Forbidden patterns, safe bins, blocked domains
├── template-loader.js              # Load templates from NC via WebDAV
├── template-engine.js              # Parameter resolution, SKILL.md assembly
├── security-scanner.js             # Pre-activation security validation
├── activator.js                    # Deploy skill to OpenClaw directory
├── talk-engine.js                  # Conversation state machine for Talk UI
├── talk-patterns.js                # Trigger phrase recognition
├── conversation-state.js           # State persistence to NC Memory
├── credential-verifier.js          # Verify credentials exist in NC Passwords
├── forms-poller.js                 # Poll NC Forms for submissions
├── forms-adapter.js                # Convert form data to template parameters
├── catalog-sync.js                 # Federated catalog version checking
├── generic-builder.js              # Custom API conversation flow
└── operation-collector.js          # REST operation definition collection

scripts/
├── provision-forge-forms.sh        # Create NC Forms during deployment
└── setup-federation-share.sh       # Document/automate federation share setup

config/
└── forge.json                      # Forge configuration

tests/
├── template-engine.test.js         # Template assembly tests
├── security-scanner.test.js        # Security scan tests
├── talk-engine.test.js             # Conversation flow tests
└── generic-builder.test.js         # Generic builder tests
```

### 13.2 Implementation Checklist

```
Phase 1: Template Engine Core
[ ] Create src/skill-forge/ directory structure
[ ] Implement constants.js with forbidden patterns and safe bins
[ ] Implement template-loader.js — read YAML from NC WebDAV
[ ] Implement template-engine.js — parameter substitution, slug generation
[ ] Implement security-scanner.js — pattern matching, domain validation
[ ] Implement activator.js — deploy to OpenClaw, update metadata
[ ] Write trello.yaml as first test template
[ ] Write template-engine.test.js
[ ] Write security-scanner.test.js
[ ] End-to-end test: template → generated SKILL.md → security scan → activation

Phase 2: Talk Conversation Engine
[ ] Implement talk-patterns.js — trigger recognition
[ ] Implement conversation-state.js — state read/write to NC
[ ] Implement credential-verifier.js — NC Passwords label check
[ ] Implement talk-engine.js — state machine with all states
[ ] Hook into HeartbeatManager message processing
[ ] Write talk-engine.test.js
[ ] End-to-end test: Talk message → conversation → generated skill → activation

Phase 3: NC Forms Integration
[ ] Implement forms-poller.js — NC Forms API polling
[ ] Implement forms-adapter.js — submission to parameters conversion
[ ] Write provision-forge-forms.sh — deployment-time form creation
[ ] Test form creation on Storage Share
[ ] Test submission polling and processing

Phase 4: Federated Distribution
[ ] Create /SkillTemplates/ on MoltAgent Prime NC
[ ] Write _catalog.json schema and initial content
[ ] Write launch templates (target: 15)
[ ] Test federated sharing between two Storage Share instances
[ ] Implement catalog-sync.js — version check in heartbeat
[ ] Update concierge deployment guide with federation steps
[ ] Update delivery email template with federation info

Phase 5: Generic Skill Builder
[ ] Write generic/rest-api.yaml meta-template
[ ] Implement generic-builder.js — extended conversation flow
[ ] Implement operation-collector.js — structured operation collection
[ ] SSRF protection: block private IPs, metadata endpoints
[ ] HTTPS-only enforcement
[ ] Write generic-builder.test.js
[ ] End-to-end test: "connect to my API" → conversation → safe skill
```

---

## Appendix A: Security Rationale

### Why Not Just Audit ClawHub Skills?

Auditing skills from ClawHub is insufficient because:

1. **Volume:** 3,000+ skills, growing daily. Manual audit doesn't scale.
2. **Updates:** Skills can be updated after audit. No mechanism to detect changes.
3. **Execution model:** Skills can include shell scripts and binary invocations that are hard to fully audit.
4. **Trust transitivity:** A safe skill can depend on unsafe prerequisites.
5. **Social engineering:** Malicious skills use legitimate-looking setup instructions.

Skill Forge eliminates these risks by generating skills from trusted templates where every command is pre-validated and credentials always flow through NC Passwords.

### Why Templates Instead of AI-Generated Skills?

Using an LLM to generate skills from natural language descriptions would introduce:

1. **Hallucinated endpoints:** LLMs invent plausible-looking but wrong API URLs.
2. **Incorrect auth patterns:** LLMs may generate insecure authentication flows.
3. **Unpredictable output:** Same prompt can produce different skills with different security properties.
4. **Bypass potential:** Prompt injection could manipulate the generation to include malicious patterns.

Templates eliminate these risks: the LLM handles conversation (which it's good at) while the technical content comes from human-authored, pre-validated templates.

---

## Appendix B: Template Writing Guide

For operators creating new templates:

### Rules

1. Test every curl command manually before including in template
2. Verify all API endpoints against official documentation
3. Always use NC Passwords for credential access — never hardcode
4. Always specify `allowed_domains` — be as restrictive as possible
5. Always include a `verify` section
6. Keep skills focused — one service, specific operations
7. Include `help_url` for every credential (user needs to know where to get it)
8. Include `help_text` for any non-obvious parameter
9. Test generated output through security scanner before publishing

### Template Testing Checklist

```
[ ] All curl commands tested against real API
[ ] Credential fetch pattern works with NC Passwords
[ ] Security scanner passes with zero violations
[ ] Generated SKILL.md renders correctly in OpenClaw
[ ] Verification command succeeds with valid credentials
[ ] All placeholder values substituted correctly
[ ] Slug generation produces valid filesystem names
[ ] No domain references outside allowed_domains
```

---

*Skill Forge: Because your AI agent's capabilities should be assembled from trusted blueprints, not downloaded from strangers.*
