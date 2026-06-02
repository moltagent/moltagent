# Getting Started

You've installed Moltagent and the service is running. Now what?

This guide is about your **first hour** with Moltagent — not a complete manual, just enough to get from "the bot replies" to "the bot is useful." The quickstart got you to a running service; this gets you to actual work.

Throughout, "Molti" is just the friendly short name for your Moltagent agent.

## Your first conversation

Open the Talk room where Moltagent is enabled and type:

> What can you do for me?

Molti will describe its own capabilities. This isn't a canned answer — the agent reads its own tool registry and tells you what's available **on this specific setup**. If you skipped the optional Calendar or Mail apps during setup, those features won't appear in the answer. What it lists is what it can actually do for you right now.

Then just talk to it. Moltagent is built around natural conversation in German, English, or Portuguese — you don't need commands or a special syntax. Ask it something, tell it to do something, or ask what it remembers.

## Share your data

Here's the single most important thing to understand: **Moltagent can only see what's shared with it.** It runs as its own Nextcloud user (`moltagent`), with its own storage, its own calendar, its own boards. Your data stays yours until you explicitly share it. That's the sovereignty model — and it means a fresh agent starts out knowing nothing about your world.

So spend a few minutes giving it something to work with.

**Calendar.** In the Nextcloud Calendar app, click the share icon next to a calendar and add the `moltagent` user as a viewer. Then ask:

> What's on my schedule this week?

**Files.** Share a folder or document with the `moltagent` user (read access is enough). Then ask Molti to read or summarize it. It reads documents for *understanding* — it'll tell you what a file contains in plain language rather than dumping the raw text.

**Deck.** The agent creates its own boards automatically (its task board and a Cockpit control board). You can also share an existing Deck board with the `moltagent` user. Ask it to create a task and it lands on its board:

> Create a task to review the quarterly report by Friday.

The rule of thumb: if Molti says it can't see something, the fix is almost always "share it with the `moltagent` user."

## Try five real things

Type each of these into your Talk room. The expected outcome is on the right — and a note on what to check if it doesn't work.

1. **"Create a task: Review the Q3 budget"**
   → Molti creates a Deck card in its Inbox and confirms with the card number.

2. **"What's on my calendar tomorrow?"**
   → Molti reads your calendar and summarizes the events.
   *Requires that you shared a calendar with the `moltagent` user.*

3. **"Summarize the document in Projects/proposal.pdf"**
   → Molti extracts the text (PDF, DOCX, etc.) and tells you what's in it.
   *Requires that the file or its folder is shared with the `moltagent` user.*

4. **"Schedule a meeting with [name] on Thursday at 2pm"**
   → Molti looks up the contact's email, checks for conflicts, and creates the event. Nextcloud sends the invitation.
   *Requires the Calendar app, and a Contacts entry for the person.*

5. **"What have we discussed so far?"**
   → Molti recalls the conversation and earlier sessions from its memory.

If any of these comes back empty or says it lacks access, the usual cause is that the relevant data hasn't been shared with the `moltagent` user yet — or the matching optional app (Calendar, Contacts, Mail) wasn't installed during setup.

## A few more things it can do

Beyond the five above, Moltagent can:

- **Manage tasks fully** — move cards between stacks, set due dates, assign people, add comments, mark things done, give you a board overview or your overdue items.
- **Work with files** — read, extract, list, move, copy, and share files. When it creates a file for you, it shares a link rather than dumping it into your folders (more on that limit below).
- **Search and research** — search across your whole Nextcloud workspace, and search and read the web when a topic warrants it. It cites web sources and flags claims it isn't sure about.
- **Draft and send email** — compose replies and send mail. Every send requires your approval first, and outgoing mail carries an AI-disclosure footer.
- **Keep a knowledge wiki** — write and read pages about people, projects, procedures, and research (see below).
- **Run workflow boards** — a Deck board whose description begins with `WORKFLOW:` becomes an automated pipeline the agent processes card-by-card. This is Moltagent's signature feature; the [Deployment Guide](deployment.md) and architecture docs cover it in depth.

## How Moltagent learns

Moltagent is not a stateless chatbot. The more you work with it, the more useful it gets, because it builds a memory of your world:

- **The knowledge wiki** (Nextcloud Collectives) is its long-term memory. It organizes what it learns into sections — People, Projects, Procedures, Research, Meta — and creates pages as topics come up. When you tell it something worth keeping ("remember that the deadline is March 15"), it writes it down.
- **It notices gaps.** When a person or topic comes up repeatedly that it has no notes on, it'll offer to create a page for it.
- **It consolidates.** A daily digest summarizes activity across rooms, so "where were we?" has a real answer the next day.

You can watch this happen: ask it about someone you've mentioned a few times, and it'll either tell you what it has stored or admit it doesn't know yet and offer to learn. It's designed to **say what it knows and name what it doesn't** — never to fill a gap with a confident guess.

## Multiple rooms

You can add Moltagent to more than one Talk room, and each room keeps its own conversation context. A common pattern is one room for work tasks, another for personal planning, another shared with a project team.

To add Molti to a new room, open the room's conversation settings (the `···` menu) → **Bots** → **Enable** next to Moltagent. (On older Talk versions, or from the command line, this is the `talk:bot:setup` step from the [Quick Start](quickstart.md#step-5-register-the-talk-bot).)

## What Moltagent can't do (yet)

Being honest about the edges saves you frustration:

- **One agent per Nextcloud user.** Moltagent isn't multi-tenant yet — it's a single digital employee, not a fleet.
- **It can't push files into your space.** It can read files you share with it, and it can create files in *its own* storage and share a link back to you — but it won't write directly into your private folders.
- **Voice is experimental.** Voice messages need the Whisper/Speaches pipeline set up (see the [Deployment Guide](deployment.md)); without it, Moltagent is text-only.
- **Response quality depends on the model.** Moltagent runs on local models (via Ollama) and optionally cloud models. A fully local setup is private and free to run but answers more simply than a cloud-assisted one. You choose the balance.

## Easing it into a production Nextcloud

If you already run a Nextcloud with real business data and you want to introduce Moltagent carefully rather than all at once:

1. Keep Moltagent on a separate lab or test Nextcloud instance to start.
2. Use Nextcloud **federation** to share specific calendars, files, or folders from production into the lab.
3. Let Molti work with that subset first, so you can see how it behaves on real content with limited exposure.
4. Expand what you share as your trust in it grows.
5. When you're ready, move the agent onto production — or keep the federated setup as the permanent architecture.

This protects production data while still giving the agent genuine content to be useful with.

---

Next: the [Deployment Guide](deployment.md) covers the optional pieces (web search, voice, email, the Cockpit control board), and the [Architecture](architecture.md) explains the three-VM isolation model behind all of this.
