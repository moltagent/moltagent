# The Cockpit

The Cockpit is your agent's control panel. It is an ordinary Nextcloud Deck board named **Moltagent Cockpit** that the agent reads on every heartbeat and partly writes back to. You configure behavior, persona, guardrails, and operating mode by editing cards — no code, no config files, no restart.

Three ideas explain the whole board:

- **Labels are state.** The `⚙️` labels on a card are how you set a value. The agent reads the label, not free prose, to decide what is active.
- **Text is documentation (and custom values).** Every card description has a `---` separator. Everything **above** the line is the live value (a style directive, a name, a custom time); everything **below** the line is human-facing help that the agent ignores.
- **The heartbeat is the apply cycle.** On each pulse (default every 5 minutes, `HEARTBEAT_INTERVAL`) the agent invalidates its cache, re-reads the board, and propagates the new settings. Status cards are written back roughly every 15 minutes (every third pulse). There is no save button — edit a card, wait for the next pulse.

The board is created automatically on first boot with all stacks, labels, and default cards. Creation is idempotent: missing cards are added on later boots, and the board survives renames (it is tracked by role, not by title).

## How a card carries state

A small set of labels does all the work. They are created on the board in this order:

| Label | Meaning |
|-------|---------|
| `⚙️1` (red) | Option 1 — first/lowest setting (e.g. off, none, concise) |
| `⚙️2` (yellow) | Option 2 — middle setting (e.g. moderate, balanced) |
| `⚙️3` (green) | Option 3 — highest setting (e.g. on, detailed, generous) |
| `⚙️★` (gold) | **Active** — marks the one starred card in Styles and Modes |
| `⚙️4` (blue) | **Custom** — read the value from the card text above `---` |
| `⏸ PAUSED` (grey) | Disables a Guardrail card without deleting it |
| `⛔ GATE` (red) | Marks a Guardrail that must trigger human approval (HITL) |

To change a setting on a single-dial card, **remove the current `⚙️` label and add the one you want**. To use a custom value, add `⚙️4` and write the value above the `---` line. The labels `⚙️5`–`⚙️9` exist on the board but are reserved and have no effect today.

A card's **direction** is fixed:

- **agent-reads (setting):** you edit it; the agent reads it. Everything in Styles, Persona, Guardrails, Modes, and System.
- **agent-writes (status):** the agent overwrites it on each status pulse. Everything in Status. Editing a Status card is pointless — your text is replaced.

## Card reference

### 💡 Styles

Communication style presets. Exactly one is active — the card carrying `⚙️★`. The text above `---` is injected verbatim at the top of the agent's system prompt as a style directive, so editing it directly changes how the agent writes.

| Card | Default | Direction | How to change | Takes effect |
|------|---------|-----------|---------------|--------------|
| Concise Executive | ★ active | agent-reads | move `⚙️★` to the style you want | next heartbeat |
| Warm Professional | — | agent-reads | move `⚙️★` here | next heartbeat |
| Blunt Analyst | — | agent-reads | move `⚙️★` here | next heartbeat |
| Creative Partner | — | agent-reads | move `⚙️★` here | next heartbeat |
| Warm Teacher | — | agent-reads | move `⚙️★` here | next heartbeat |

Only one style may be starred. If none is starred, no style directive is applied.

### 🎭 Persona

Personality dials. Each is read on the next heartbeat. Persona directives take precedence over the Style preset where they conflict.

| Card | Labels | Default | Direction |
|------|--------|---------|-----------|
| Name | custom text | `Molti` | agent-reads — edit the name above `---` |
| Humor | `⚙️1` none / `⚙️2` light / `⚙️3` playful | `⚙️2` | agent-reads — swap the label |
| Emoji | `⚙️1` none / `⚙️2` minimal / `⚙️3` generous | `⚙️1` | agent-reads — swap the label |
| Language | custom text (ISO codes, e.g. `EN`, `PT`, `DE`, or `EN+PT`) | `EN` | agent-reads — edit text above `---` |
| Verbosity | `⚙️1` concise / `⚙️2` balanced / `⚙️3` detailed | `⚙️1` | agent-reads — swap the label |
| Formality | `⚙️1` formal / `⚙️2` balanced / `⚙️3` casual | `⚙️2` | agent-reads — swap the label |

Name and Language carry no `⚙️` label by default; their value is the text above the `---` line.

### 🛡️ Guardrails

Hard behavioral constraints. **Every card in this stack is active** unless it carries `⏸ PAUSED`. Active guardrails are injected into the system prompt as MUST-OBEY rules. A card carrying `⛔ GATE` additionally signals that the operation must pause for explicit human approval.

| Card (default) | Direction |
|----------------|-----------|
| Never delete files without asking | agent-reads |
| Confirm before sending external communications | agent-reads |
| Route credential-sensitive operations through local LLM | agent-reads |
| Maximum 8 tool calls per reasoning cycle | agent-reads |

To **lift** a guardrail: add `⏸ PAUSED` (temporary) or delete the card (permanent). To **add** one: create a new card in this stack; its title and description become the rule. To **require approval** for a rule: add `⛔ GATE`. Changes take effect on the next heartbeat.

### 🌙 Modes

Operating mode. Exactly one is active — the card carrying `⚙️★`. The active mode's behavior is injected prominently into the system prompt and propagated to the message processor.

| Card | Default | Direction | Takes effect |
|------|---------|-----------|--------------|
| Full Auto | ★ active | agent-reads | next heartbeat |
| Focus Mode | — | agent-reads | next heartbeat |
| Meeting Day | — | agent-reads | next heartbeat |
| Creative Session | — | agent-reads | next heartbeat |
| Out of Office | — | agent-reads | next heartbeat |

Move `⚙️★` to the mode you want. Only one mode is active at a time.

### 🔧 System

Runtime settings. Read and propagated on each heartbeat.

| Card | Labels / format | Default | Notes |
|------|-----------------|---------|-------|
| Models | custom text: `trust: local-only` or `cloud-ok`; optional `prefer: speed\|quality\|cost`; optional `roster:` block | `trust: local-only` | The description above `---` is the live config; the agent regenerates the help text below it. `trust: local-only` keeps all inference on your box. The `credentials` job can never be routed to cloud. |
| Daily Digest | `⚙️1` off / `⚙️2` morning 08:00 / `⚙️3` custom | `⚙️2` | For `⚙️3`, write the time (`HH:MM`) above `---`. |
| Initiative Level | `⚙️1` minimal / `⚙️2` moderate / `⚙️3` active / `⚙️4` autonomous | `⚙️2` | How proactive the agent is between conversations. |
| Working Hours | `⚙️1` always / `⚙️2` 09:00–18:00 / `⚙️3` 07:00–22:00 / `⚙️4` custom | `⚙️2` | For `⚙️4`, write `HH:MM-HH:MM` above `---`. Outside these hours the agent still answers direct messages but does no proactive work. |
| 💰 Budget Limits | `⚙️1` no limits / `⚙️2` conservative / `⚙️3` moderate / `⚙️4` custom | `⚙️3` | `⚙️2` = €2/day, €30/month. `⚙️3` = €5/day, €50/month. When a limit is reached the agent switches to local models. For `⚙️4`, write the limit lines above `---`. |
| 🔊 Voice | `⚙️1` off / `⚙️2` listen / `⚙️3` full | `⚙️1` | `listen` transcribes voice and replies as text; `full` also replies with voice. Requires the voice service to be configured, or the setting is inert. |
| Search Policy | custom text: `mode: research` / `internal-first` / `sovereign` | `mode: research` | `research` = internal first, automatic web fallback with source attribution. `internal-first` = internal only, offers web when thin. `sovereign` = never leaves your infrastructure. |

All System cards are agent-reads. Changes take effect on the next heartbeat.

### 📊 Status

Written by the agent, not by you. Updated roughly every 15 minutes (every third heartbeat). The agent only writes these three cards — it never creates or deletes cards in this stack.

| Card | What the agent writes | Direction |
|------|-----------------------|-----------|
| Health | Overall status, per-service up/down with latency, RAM warning above 85%, disk warning above 90%, uptime, and last-session request success rate | agent-writes |
| Costs | This month's spend, cloud vs local call counts, local ratio | agent-writes |
| Model Usage | Request count this month and per-provider breakdown | agent-writes |

Do not edit Status cards; your changes are overwritten on the next status pulse.

## Setup: ownership and sharing

The Cockpit board is created and **owned by the bot's Nextcloud user** (`NC_USER`, default `moltagent`). The bot needs to own it so it can read and write cards on every heartbeat.

To see and control the Cockpit yourself, the board must be **shared with your own Nextcloud account**. This is driven by a single setting:

- Set `ADMIN_USER` in the service environment to **your** Nextcloud username.
- On bootstrap the agent shares the board with that user, granting **edit, share, and manage** permission — full read/write control of the control panel.
- If `ADMIN_USER` is empty, the agent logs a warning and **does not share the board**. This is the safe default: no sharing happens unless you name a user.

Set `ADMIN_USER` to your own account, restart, and the Cockpit appears in your Deck.

### Worked example: the unexpected morning share ([BETA-1])

On the NC 34 beta deployment ([BETA-1]), an operator woke to find the Cockpit board already shared — with full edit/share/manage — to a Nextcloud username they did not recognize (`[NAME]`). Nothing was compromised; the board had simply been provisioned from a copied deployment whose `ADMIN_USER` still named a previous install's owner. Because `ADMIN_USER` was non-empty, bootstrap dutifully granted that stranger write access to the control surface.

The fix has two halves:

1. **Correct the setting.** Set `ADMIN_USER` to *your* Nextcloud username (or leave it empty for no sharing), then restart so the warning/skip-or-share logic runs with the right value.
2. **Revoke the inherited share.** In Deck, open the Cockpit board's sharing panel and remove the unrecognized user. Sharing is granted at bootstrap; it is not re-evaluated against `ADMIN_USER` on later boots, so an already-granted share must be removed by hand.

The lesson: `ADMIN_USER` is your account, and an empty value means "share with no one." Treat a populated `ADMIN_USER` you did not set as a share you need to review.

## Troubleshooting

Limited to what the agent actually reports in its logs (`journalctl -u moltagent`).

| You see / observe | Meaning | What to do |
|-------------------|---------|------------|
| `ADMIN_USER not set — Cockpit board is not shared with the instance owner` | No share target configured | Set `ADMIN_USER` to your Nextcloud username and restart |
| `Could not share Cockpit board with <user>` | The share API call failed | Confirm the username exists in Nextcloud and is spelled correctly |
| `Models card content changed, re-parsing` | Informational — your Models edit was picked up | Nothing; confirms the change registered |
| `Custom roster is empty, falling back to local-only` | A custom `roster:` block parsed to nothing | Check the roster syntax (`job: player1, player2`) above `---` |
| `Failed to update <card>` / `updateStatus failed` | A Status card write failed (transient API error) | Usually self-heals next pulse; check Deck/Nextcloud reachability if persistent |
| A card edit hasn't taken effect | Settings apply on the heartbeat | Wait one pulse (default 5 min); Status cards refresh ~every 15 min |
| The board doesn't appear in your Deck | Not shared with your account | See **Setup** above — set `ADMIN_USER` |

Settings that depend on external services (Voice, cloud models) are inert until those services are configured; the board still shows the setting, but it has no effect without the backing service.

## Translations

This documentation is English-first. Moltagent is multilingual by design (the agent speaks DE, EN, and PT), and translations of this guide are welcome. If you'd like to contribute a translation, please open a pull request or comment on the documentation-translation issues in the project tracker.
