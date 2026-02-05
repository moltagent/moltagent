# NC Deck Integration - Task Management

MoltAgent uses Nextcloud Deck as its task management system. This creates a visual kanban board where you can assign tasks to your AI assistant, track progress, and manage your digital employee's workload.

## Overview

```
┌─────────────────────────────────────────────────────────────────────────────┐
│  📋 MOLTAGENT TASKS                                                        │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│   📥 INBOX         ⏳ QUEUED        🔄 WORKING       ✅ DONE      📚 REF   │
│   ──────────       ──────────      ──────────       ──────       ──────    │
│   ┌──────────┐    ┌──────────┐    ┌──────────┐    ┌──────────┐           │
│   │Research  │    │Draft     │    │Analyze   │    │Report    │           │
│   │AI trends │    │email to  │    │competitor│    │completed │           │
│   │          │    │client    │    │pricing   │    │Jan 15    │           │
│   │🔵research│    │🟢writing │    │🔵research│    │          │           │
│   └──────────┘    │🔴urgent  │    └──────────┘    └──────────┘           │
│                   └──────────┘                                            │
│                                                                             │
│   Human creates → Bot accepts → Bot works → Bot completes                  │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
```

## Board Structure

### Columns (Stacks)

| Column | Purpose | Who Uses It |
|--------|---------|-------------|
| **Inbox** | New tasks waiting to be picked up | Human creates, Bot reads |
| **Queued** | Bot accepted, waiting for capacity | Bot manages |
| **Working** | Currently being processed | Bot manages |
| **Done** | Completed tasks | Bot moves here |
| **Reference** | Standing information | Human creates |

### Labels

| Label | Color | Purpose |
|-------|-------|---------|
| 🔴 `urgent` | Red | Process this card first |
| 🔵 `research` | Blue | Research/investigation task |
| 🟢 `writing` | Green | Content creation task |
| ⚫ `admin` | Gray | Administrative/file task |
| 🟠 `blocked` | Orange | Waiting for human input |

## How to Create a Task

### Step 1: Open Deck
1. Log into your Nextcloud
2. Click the Deck app icon (📋) in the top menu
3. Find "MoltAgent Tasks" board

### Step 2: Create a Card
1. Click **+ Add card** in the **Inbox** column
2. Enter a clear, specific title
3. Add details in the description
4. Apply relevant labels
5. Optionally set a due date

### Step 3: Wait for Processing
- Bot checks inbox every 5 minutes (during heartbeat)
- Urgent cards are processed first
- Watch for status updates in card comments

## Task Examples

### Research Task

**Title:** Find top 5 AI agent frameworks for enterprise

**Description:**
```markdown
Looking for established frameworks, not experimental projects.

Focus areas:
- Security features
- Enterprise adoption
- Pricing model
- Integration capabilities

Output: Summary document with comparison table.
```

**Labels:** `research`

---

### Writing Task

**Title:** Draft email to client about project delay

**Description:**
```markdown
Context:
- Project X is 2 weeks behind schedule
- Reason: Waiting for API access from their IT team
- We've been waiting since Jan 10

Tone: Professional but warm, maintain relationship
Include: Apology, explanation, new timeline, next steps
```

**Labels:** `writing`, `urgent`

---

### Admin Task

**Title:** Organize Q4 reports into archive folder

**Description:**
```markdown
Files to move: All PDFs in /documents/reports/ from Oct-Dec 2025
Destination: /archive/2025/Q4/
Naming convention: Keep original names

Note: Bot will ask for confirmation before moving.
```

**Labels:** `admin`

## Understanding Bot Comments

The bot adds comments to cards as it works. Comments are prefixed with tags:

| Tag | Meaning |
|-----|---------|
| `[STATUS]` | General status update |
| `[PROGRESS]` | Work in progress |
| `[DONE]` | Task completed |
| `[QUESTION]` | Bot needs clarification |
| `[ERROR]` | Something went wrong |
| `[BLOCKED]` | Waiting for human input |

### Example Card History

```
📝 Card: "Research competitor pricing"

[STATUS] Task accepted, queued for processing.
[PROGRESS] Starting work on this task...
[PROGRESS] Found 5 competitor websites, analyzing pricing pages...
[DONE] Research completed. Found pricing for 5 competitors. 
       Summary: Prices range from $29-299/month. See attached doc.
```

## Working with Blocked Tasks

When a card has a `[QUESTION]` comment:

1. Read the bot's question
2. Add your answer as a new comment
3. Remove the `blocked` label
4. Move the card back to **Inbox**

The bot will pick it up again with your new input.

## Configuration

### Archive Period

Completed cards are automatically archived after 180 days by default. Change this in your config:

```yaml
deck:
  archiveAfterDays: 180  # Set to 0 to disable
```

### Processing Limits

Control how many cards are processed per heartbeat:

```yaml
deck:
  processing:
    maxCardsPerCycle: 5
```

### Custom Labels

Add your own labels in the config:

```yaml
deck:
  labels:
    - title: "urgent"
      color: "ED1C24"
    - title: "customer"      # Custom label
      color: "9B59B6"        # Purple
```

## Best Practices

### Writing Good Task Titles

✅ Good:
- "Research competitor pricing for enterprise tier"
- "Draft follow-up email to John about contract renewal"
- "Summarize Q4 sales report into bullet points"

❌ Poor:
- "Help me"
- "Do the thing"
- "Email"

### Providing Context

The more context you give, the better the results:

```markdown
Good description:
- What specifically you need
- Any constraints or requirements
- Expected format of the output
- Background information the bot needs

Example:
"Write a product announcement for our new API feature.
Target audience: Technical developers
Tone: Excited but professional
Include: Key benefits, code example, link to docs
Length: 2-3 paragraphs"
```

### Using Labels Effectively

- **Research** - When you need information gathered
- **Writing** - When you need content created
- **Admin** - For file organization tasks
- **Urgent** - Only when truly time-sensitive

## Troubleshooting

### Card stuck in Inbox

1. Check if the card has a `blocked` label
2. Look at the Logs folder for errors
3. Verify the bot service is running
4. Check heartbeat status

### Bot asked a question I already answered

Make sure you:
1. Added your answer as a comment
2. Removed the `blocked` label
3. Moved the card to Inbox (not Queued)

### Card completed but result is wrong

1. Create a new card referencing the original
2. Be more specific about what you need
3. Add examples of desired output

## API Reference

For automation, you can interact with Deck programmatically:

```bash
# Create a card
curl -u "moltagent:PASSWORD" \
  -H "OCS-APIRequest: true" \
  -H "Content-Type: application/json" \
  -X POST \
  "https://your-nc.example.com/index.php/apps/deck/api/v1.0/boards/{boardId}/stacks/{stackId}/cards" \
  -d '{"title": "My Task", "description": "Details here"}'

# List cards in a stack
curl -u "moltagent:PASSWORD" \
  -H "OCS-APIRequest: true" \
  -H "Accept: application/json" \
  "https://your-nc.example.com/index.php/apps/deck/api/v1.0/boards/{boardId}/stacks/{stackId}"
```

See the [NC Deck API documentation](https://deck.readthedocs.io/en/latest/API/) for full reference.

## Setup

### Automated Setup (Concierge)

If you're using the Concierge service, Deck is set up automatically during deployment.

### Manual Setup

1. **Enable Deck app** in Nextcloud (Settings → Apps → Deck)

2. **Run the setup script:**
   ```bash
   NC_URL=https://your-nc.example.com \
   MOLTAGENT_PASSWORD=your-bot-password \
   node scripts/setup-deck-board.js
   ```

3. **Verify the setup:**
   ```bash
   NC_URL=https://your-nc.example.com \
   MOLTAGENT_PASSWORD=your-bot-password \
   node scripts/test-deck-integration.js
   ```

The setup script creates:
- MoltAgent Tasks board
- All required stacks (Inbox, Queued, Working, Done, Reference)
- All labels (urgent, research, writing, admin, blocked)
- A welcome card with instructions
