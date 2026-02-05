#!/usr/bin/env node

const NCRequestManager = require('../src/lib/nc-request-manager');
const appConfig = require('../src/lib/config');

const DEMO_PREFIX = 'Demo: ';

/**
 * Thin wrapper around NCRequestManager for Deck API calls
 */
class DeckAPI {
  constructor(nc) {
    this.nc = nc;
  }

  async _request(method, path, body = null) {
    const response = await this.nc.request(path, {
      method,
      body,
      headers: {
        'OCS-APIRequest': 'true',
        'Accept': 'application/json',
        'Content-Type': 'application/json'
      }
    });

    if (response.status >= 200 && response.status < 300) {
      return response.body;
    }

    const msg = response.body?.message || `HTTP ${response.status}`;
    throw new Error(`Deck API error: ${msg} (${response.status})`);
  }

  async listBoards() {
    return this._request('GET', '/index.php/apps/deck/api/v1.0/boards');
  }

  async deleteBoard(id) {
    return this._request('DELETE', `/index.php/apps/deck/api/v1.0/boards/${id}`);
  }

  async createBoard(title, color) {
    return this._request('POST', '/index.php/apps/deck/api/v1.0/boards', { title, color });
  }

  async updateBoard(id, data) {
    return this._request('PUT', `/index.php/apps/deck/api/v1.0/boards/${id}`, data);
  }

  async createStack(boardId, title, order) {
    return this._request('POST', `/index.php/apps/deck/api/v1.0/boards/${boardId}/stacks`, { title, order });
  }

  async createLabel(boardId, title, color) {
    return this._request('POST', `/index.php/apps/deck/api/v1.0/boards/${boardId}/labels`, { title, color });
  }

  async createCard(boardId, stackId, card) {
    return this._request('POST', `/index.php/apps/deck/api/v1.0/boards/${boardId}/stacks/${stackId}/cards`, card);
  }

  async assignLabel(boardId, stackId, cardId, labelId) {
    return this._request('PUT', `/index.php/apps/deck/api/v1.0/boards/${boardId}/stacks/${stackId}/cards/${cardId}/assignLabel`, { labelId });
  }

  async assignUser(boardId, stackId, cardId, userId) {
    return this._request('PUT', `/index.php/apps/deck/api/v1.0/boards/${boardId}/stacks/${stackId}/cards/${cardId}/assignUser`, { userId });
  }
}

/**
 * Compute a due date N days from now as ISO string.
 */
function dueDateFromNow(days) {
  return new Date(Date.now() + days * 24 * 60 * 60 * 1000).toISOString();
}

/**
 * Determine due date offset (days from now) based on stack title.
 * Returns null for stacks that already handle their own duedates.
 */
function getDueDaysForStack(stackTitle) {
  const t = stackTitle.toLowerCase();
  if (t.includes('done') || t.includes('resolved') || t.includes('won') || t.includes('live') || t.includes('track')) return 0;
  if (t.includes('review') || t.includes('approve') || t.includes('close')) return 2;
  if (t.includes('intake') || t.includes('inbox') || t.includes('new') || t.includes('lead') || t.includes('ideas')) return 3;
  // Working/Drafting/Setup/Sorted/Negotiation/Plan/Proposal/Publish
  return 7;
}

/**
 * Check if a stack title looks like a GATE/review stack (for user assignment).
 */
function isGateStack(stackTitle) {
  const t = stackTitle.toLowerCase();
  return t.includes('review') || t.includes('approve') || t.includes('close');
}

/**
 * Check if a stack is a Done-type stack.
 */
function isDoneStack(stackTitle) {
  const t = stackTitle.toLowerCase();
  return t.includes('done') || t.includes('resolved') || t.includes('won') || t.includes('live') || t.includes('track');
}

/**
 * All 6 demo board definitions
 */
const BOARDS = [
  // Board 1: Client Onboarding
  {
    title: 'Demo: Client Onboarding',
    color: '0082c9',
    description: `WORKFLOW: procedure
TRIGGER: New card in Intake
RULES:
  Process stacks left to right, cards top to bottom.
  At GATE cards: stop, notify human in Talk, wait for ✅ or ❌.
  If label 🟢 EU: standard onboarding flow.
  If label 🔵 International: add "Research local regulations" step before Connect.
  For each new client:
    - Create wiki page [[People/{card title}]] with contact details from card description
    - Create folder /Clients/{card title}/ in Nextcloud Files
    - Send welcome email using template
    - Schedule kickoff meeting in next available slot
  Log every completed step as a card comment with timestamp.`,
    stacks: ['📥 Intake', '🔧 Setup', '📞 Connect', '✋ Review', '✅ Live'],
    labels: [
      { title: 'EU', color: '31b500' },
      { title: 'International', color: '317CCC' }
    ],
    cards: [
      { stack: '📥 Intake', title: 'Acme Corp', description: 'Contact: jane@acme.com · Industry: SaaS · Size: 50 employees · Deal value: €2,400/mo', labels: ['EU'] },
      { stack: '📥 Intake', title: 'Bright Labs', description: 'Contact: awaiting details · Industry: Biotech · Referred by Nordic Health', labels: ['International'] },
      { stack: '🔧 Setup', title: 'Create wiki page', description: 'Create [[People/{client}]] with company info, contact details, deal summary', labels: [] },
      { stack: '🔧 Setup', title: 'Create NC folder', description: 'Create /Clients/{client}/ with subfolders: Documents, Contracts, Notes', labels: [] },
      { stack: '📞 Connect', title: 'Send welcome email', description: 'Use onboarding template. Include portal link and next steps.', labels: [] },
      { stack: '📞 Connect', title: 'Schedule kickoff', description: 'Book 45min in next available slot. Include agenda: intro, goals, timeline.', labels: [] },
      { stack: '✋ Review', title: '⏸️ GATE: Review setup', description: 'Human confirms: wiki page correct, folder structure complete, email sent, meeting scheduled. Reply ✅ to proceed or ❌ with notes.', labels: [] },
      { stack: '✅ Live', title: 'Schedule 30-day check-in', description: 'Add calendar event: "{client} — 30-day check-in". Include link to wiki page.', labels: [] }
    ]
  },

  // Board 2: Expense Processing
  {
    title: 'Demo: Expense Processing',
    color: '0082c9',
    description: `WORKFLOW: pipeline
TRIGGER: New card in Inbox
MODEL: sovereign
RULES:
  For each card in Inbox:
    - Read the card title and description for amount and category
    - Assign the appropriate category label (food, transport, software, supplies)
    - Move to Sorted stack
  When cards accumulate in Sorted:
    - Calculate batch total
    - Create a summary card in Approve with total and breakdown
    - GATE: manager reviews and approves
  After approval:
    - Move approved cards to Done
    - Comment with "Approved on {date}, batch #{number}"
  Flag any single expense over €500 for individual review.`,
    stacks: ['📥 Inbox', '📂 Sorted', '✋ Approve', '✅ Done'],
    labels: [
      { title: 'food', color: 'F4A331' },
      { title: 'transport', color: 'E9B44C' },
      { title: 'software', color: '9C6ADE' },
      { title: 'supplies', color: '317CCC' }
    ],
    cards: [
      { stack: '📥 Inbox', title: 'Coffee Nero', description: '€4.50 · 2026-02-10 · Receipt attached', labels: ['food'] },
      { stack: '📥 Inbox', title: 'Uber to client meeting', description: '€23.40 · 2026-02-09 · Trip: office → Acme Corp', labels: ['transport'] },
      { stack: '📥 Inbox', title: 'Figma yearly renewal', description: '€168.00 · 2026-02-01 · Annual subscription', labels: ['software'] },
      { stack: '📂 Sorted', title: 'Office Supplies — Staples', description: '€89.00 · 2026-02-05 · Printer paper, toner, pens', labels: ['supplies'] },
      { stack: '📂 Sorted', title: 'Team lunch Friday', description: '€156.00 · 2026-02-07 · Restaurant: Cervejaria · 6 people', labels: ['food'] },
      { stack: '📂 Sorted', title: 'AWS January', description: '€1,200.00 · 2026-01-31 · Monthly infrastructure', labels: ['software'] },
      { stack: '✋ Approve', title: '⏸️ GATE: February batch', description: 'Batch total: €412.00 · 3 items pending approval. Manager: review and reply ✅ to approve or ❌ with notes.', labels: [] },
      { stack: '✅ Done', title: 'January supplies batch', description: 'Approved 2026-01-28 · Batch #2026-01 · Total: €347.00', labels: ['supplies'] },
      { stack: '✅ Done', title: 'Team lunch reimbursement', description: 'Approved 2026-01-21 · Reimbursed to petty cash', labels: ['food'] }
    ]
  },

  // Board 3: Support Triage
  {
    title: 'Demo: Support Triage',
    color: '0082c9',
    description: `WORKFLOW: pipeline
TRIGGER: New card in New
RULES:
  For each card in New:
    - Read the issue description
    - Assign urgency label (urgent, medium, low) based on:
        urgent: login failures, data loss, system down
        medium: performance issues, feature gaps
        low: cosmetic, nice-to-have
    - Assign type label (technical, easy, feature)
    - Move to Triaged

  Working stack:
    - Agent investigates and documents findings as card comments
    - If card in Working >48 hours past due: add 🔴 overdue label, notify in Talk

  Review stack:
    - GATE: human confirms resolution is adequate

  Resolved:
    - Comment: "Resolved on {date}. Resolution: {summary}"`,
    stacks: ['🆕 New', '🏷️ Triaged', '🔨 Working', '✋ Review', '✅ Resolved'],
    labels: [
      { title: 'urgent', color: 'ED7272' },
      { title: 'medium', color: 'E9B44C' },
      { title: 'low', color: '31b500' },
      { title: 'technical', color: '317CCC' },
      { title: 'easy', color: '31b500' },
      { title: 'feature', color: '9C6ADE' }
    ],
    cards: [
      { stack: '🆕 New', title: "Can't login since this morning", description: "I've tried resetting my password twice. Chrome and Firefox. Error: 'Authentication service unavailable.'", labels: ['urgent'] },
      { stack: '🆕 New', title: 'Feature request: dark mode', description: 'Would love a dark mode option for the dashboard. Eyes hurt during late shifts.', labels: ['feature'] },
      { stack: '🆕 New', title: 'Search is slow on large datasets', description: 'Searching contacts with >10k records takes 15+ seconds. Was faster last month.', labels: ['medium'] },
      { stack: '🏷️ Triaged', title: 'Password reset — Maria S.', description: 'Standard password reset. User confirmed identity via email.', labels: ['easy', 'urgent'] },
      { stack: '🏷️ Triaged', title: 'Billing question — invoice #2847', description: 'Client asking about line item for API overages. Need to check usage logs.', labels: ['easy', 'medium'] },
      { stack: '🏷️ Triaged', title: 'Dashboard crash on Firefox 128', description: 'Reproducible crash when loading analytics widget. Stack trace attached.', labels: ['technical', 'urgent'] },
      { stack: '🔨 Working', title: 'API timeout in production', description: 'Intermittent 504 errors on /api/v2/contacts endpoint. Started after deploy #847. Investigating connection pool settings.', labels: ['technical', 'medium'] },
      { stack: '✋ Review', title: '⏸️ GATE: QA sign-off', description: 'Resolution ready for review. QA confirms fix works. Reply ✅ to close or ❌ with notes.', labels: [] },
      { stack: '✅ Resolved', title: 'Login fix deployed', description: 'Resolved 2026-02-08. Root cause: auth service memory leak. Fix: increased pod memory limit + added health check.', labels: ['technical'] },
      { stack: '✅ Resolved', title: 'Billing clarified — invoice #2831', description: 'Resolved 2026-02-06. Sent updated invoice with usage breakdown. Client confirmed.', labels: ['easy'] }
    ]
  },

  // Board 4: Weekly Review
  {
    title: 'Demo: Weekly Review',
    color: '0082c9',
    description: `WORKFLOW: procedure
TRIGGER: Monday 08:00
RECURRENCE: weekly
RULES:
  Review stack (process top to bottom):
    - Read this week's calendar events and summarize
    - Check all Deck boards for overdue cards (due date < today)
    - Scan activity log for notable patterns

  Plan stack:
    - Identify top 3 priorities based on due dates and urgency labels
    - Block focus time on calendar for priority items
    - Draft weekly update message

  Done stack:
    - Post the briefing to the team Talk room by 09:00
    - Comment on this board: "Week of {date} review complete"

  Process left to right. Log each step as a card comment.`,
    stacks: ['📖 Review', '📝 Plan', '✅ Done'],
    labels: [],
    cards: [
      { stack: '📖 Review', title: 'Read calendar', description: 'What happened last week? Any meetings that generated action items? Upcoming deadlines?', labels: [] },
      { stack: '📖 Review', title: 'Check overdue tasks', description: 'Scan all Deck boards for cards past their due date. Flag anything >3 days late.', labels: [] },
      { stack: '📖 Review', title: 'Scan activity log', description: 'Look at file changes, Talk messages, email threads. Any notable patterns or items needing attention?', labels: [] },
      { stack: '📝 Plan', title: 'Top 3 priorities', description: 'Based on review: identify the three most important things for this week. Consider urgency + impact.', labels: [] },
      { stack: '📝 Plan', title: 'Schedule focus blocks', description: 'Book 2-hour focus blocks on calendar for each priority. Protect the time.', labels: [] },
      { stack: '📝 Plan', title: 'Draft weekly update', description: 'Write a brief update for the team Talk room. Include: last week highlights, this week priorities, any blockers.', labels: [] },
      { stack: '✅ Done', title: 'Monday briefing sent', description: 'Posted to #general Talk room at 08:47. Week of 2026-02-03.', labels: [] },
      { stack: '✅ Done', title: 'Calendar updated', description: '3 focus blocks added. 1 overdue task flagged to owner.', labels: [] }
    ]
  },

  // Board 5: Content Pipeline
  {
    title: 'Demo: Content Pipeline',
    color: '0082c9',
    description: `WORKFLOW: pipeline
TRIGGER: New card in Ideas
RULES:
  Ideas → Drafting:
    When assigned to the agent, begin drafting.
    Create a wiki page [[Content/{card title}]] with outline.
    Comment with "Draft started: [[Content/{card title}]]"

  Drafting → Review:
    When draft is complete, move to Review.
    GATE: editor reviews and approves content.

  Review → Publish:
    After approval, prepare for publication.
    Format according to content type (blog, newsletter, video script).
    GATE: final visual/formatting check.

  Publish → Track:
    Mark as published with date.
    Set due date for +7 days (performance check-in).

  Labels indicate content type: blog, newsletter, video, comparison.`,
    stacks: ['💡 Ideas', '✍️ Drafting', '👀 Review', '📤 Publish', '📊 Track'],
    labels: [
      { title: 'blog', color: '31b500' },
      { title: 'newsletter', color: '9C6ADE' },
      { title: 'video', color: 'E9B44C' },
      { title: 'comparison', color: '317CCC' }
    ],
    cards: [
      { stack: '💡 Ideas', title: 'AI agents for small business', description: 'Angle: practical guide for non-technical SMB owners. What can an AI agent actually DO for a 10-person company? Real examples, not hype.', labels: ['blog'] },
      { stack: '💡 Ideas', title: 'Deck vs Trello for workflow automation', description: 'Compare: what you can do with Nextcloud Deck + Moltagent vs Trello + Zapier. Honest comparison, acknowledge tradeoffs.', labels: ['comparison'] },
      { stack: '💡 Ideas', title: 'Video: 5-minute Moltagent setup', description: 'Screencast: from zero to working AI employee in 5 minutes. Show the actual terminal, the actual Deck board, the actual Talk message.', labels: ['video'] },
      { stack: '✍️ Drafting', title: 'Workflow boards explainer', description: 'Draft started: [[Content/Workflow boards explainer]]. Target: 1200 words. Audience: Nextcloud users curious about AI automation.', labels: ['blog'] },
      { stack: '✍️ Drafting', title: 'February newsletter draft', description: 'Monthly update: WorkflowEngine launch, new demo boards, community highlights from r/moltagent.', labels: ['newsletter'] },
      { stack: '👀 Review', title: '⏸️ GATE: Editor approval', description: 'Content draft ready for review. Check: accuracy, tone, length, links. Reply ✅ to approve or ❌ with feedback.', labels: [] },
      { stack: '👀 Review', title: '⏸️ GATE: Visual check', description: 'Formatting, images, metadata ready for publication. Final look before going live.', labels: [] },
      { stack: '📤 Publish', title: 'Published: workflow post', description: 'Published 2026-02-09 to blog.moltagent.cloud. Social shares scheduled.', labels: ['blog'] },
      { stack: '📤 Publish', title: 'Newsletter sent', description: 'Sent 2026-02-01 to 47 subscribers. Open rate: pending.', labels: ['newsletter'] },
      {
        stack: '📊 Track',
        title: 'Blog views + shares',
        description: 'Workflow post: 342 views, 12 shares, 3 comments. Check-in due 2026-02-16.',
        labels: ['blog'],
        duedate: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString()
      }
    ]
  },

  // Board 6: Sales Pipeline
  {
    title: 'Demo: Sales Pipeline',
    color: '0082c9',
    description: `WORKFLOW: pipeline
TRIGGER: New card in Lead
RULES:
  Lead → Proposal:
    When lead is qualified (has budget, timeline, need):
    - Research the company (website, LinkedIn, recent news)
    - Create wiki page [[People/{contact name}]] if not exists
    - Draft proposal based on their needs
    - Move to Proposal stack
    - Comment with proposal link

  Proposal → Negotiation:
    When client responds to proposal, move to Negotiation.
    Track counter-offers and concerns as card comments.

  Negotiation → Close:
    When terms are agreed, move to Close.
    GATE: final human sign-off before closing the deal.

  Close → Won:
    After approval:
    - Comment: "Deal closed on {date} — {value}/mo"
    - SPAWN: Create card "{client} Onboarding" in Demo: Client Onboarding board, Intake stack
    - Comment with link to spawned onboarding card

  Labels indicate deal size: small (<€1k/mo), medium (€1-5k/mo), high (>€5k/mo).
  Labels indicate source: inbound, referral, outbound.`,
    stacks: ['🎣 Lead', '📝 Proposal', '🤝 Negotiation', '✋ Close', '🎉 Won'],
    labels: [
      { title: 'small', color: '31b500' },
      { title: 'medium', color: 'E9B44C' },
      { title: 'high', color: 'ED7272' },
      { title: 'inbound', color: '31b500' },
      { title: 'referral', color: '317CCC' },
      { title: 'outbound', color: '9C6ADE' }
    ],
    cards: [
      { stack: '🎣 Lead', title: 'Bright Labs', description: 'Inbound via website contact form. Biotech startup, 25 people. Looking for "AI assistant that doesn\'t leak our research data." Perfect fit.', labels: ['inbound'] },
      { stack: '🎣 Lead', title: 'Jane ref: DataFlow', description: 'Referral from Jane at Acme Corp. DataFlow Inc, 80 people, fintech. Currently using Zapier + ChatGPT, unhappy with security.', labels: ['referral'] },
      { stack: '📝 Proposal', title: 'Acme Corp', description: 'Proposal sent 2026-02-05. Sovereign tier, €2,400/mo. Key selling point: all data stays in their Hetzner account. Decision maker: CTO.', labels: ['medium', 'inbound'] },
      { stack: '📝 Proposal', title: 'Nordic Health', description: 'Proposal sent 2026-02-08. Starter tier, €890/mo. Small team, basic workflow needs. Very price-sensitive.', labels: ['small'] },
      { stack: '🤝 Negotiation', title: 'DataFlow Inc', description: 'Counter-offer: want 3-month trial at reduced rate. Concerned about migration from Zapier. Need migration support plan.', labels: ['high', 'referral'] },
      { stack: '✋ Close', title: '⏸️ GATE: Final sign-off', description: 'Deal terms agreed. Contract ready. Human confirms: pricing correct, terms acceptable, ready to close. Reply ✅ to close and trigger onboarding.', labels: [] },
      { stack: '🎉 Won', title: 'TechStart GmbH', description: 'Closed 2026-01-28. Sovereign tier, €1,800/mo. → Onboarding spawned: card "TechStart GmbH" created in Demo: Client Onboarding.', labels: ['medium', 'inbound'] }
    ]
  }
];

/**
 * Delete all existing demo boards
 */
async function cleanDemoBoards(api) {
  const boards = await api.listBoards();
  const demoBoards = boards.filter(b => b.title.startsWith(DEMO_PREFIX) && !b.deletedAt);

  for (const board of demoBoards) {
    try {
      await api.deleteBoard(board.id);
      console.log(`  Deleted: ${board.title} (ID: ${board.id})`);
    } catch (err) {
      console.warn(`  Skip: ${board.title} (ID: ${board.id}) — ${err.message}`);
    }
  }

  return demoBoards.length;
}

/**
 * Create a single demo board with all its stacks, labels, and cards
 */
async function createDemoBoard(api, def) {
  // Create board
  const board = await api.createBoard(def.title, def.color);
  const boardId = board.id;

  // Create stacks in order
  const stackMap = {}; // stack title -> stack id
  for (let i = 0; i < def.stacks.length; i++) {
    const stack = await api.createStack(boardId, def.stacks[i], i);
    stackMap[def.stacks[i]] = stack.id;
  }

  // Create labels
  const labelMap = {}; // label title -> label id
  for (const label of def.labels) {
    const created = await api.createLabel(boardId, label.title, label.color);
    labelMap[label.title] = created.id;
  }

  // Create rules card as first card in first stack
  if (def.description) {
    const firstStackId = stackMap[def.stacks[0]];
    const workflowType = (def.description.match(/^WORKFLOW:\s*(\w+)/i) || [])[1] || 'pipeline';
    await api.createCard(boardId, firstStackId, {
      title: `WORKFLOW: ${workflowType}`,
      description: def.description,
      type: 'plain',
      order: -1  // Put at top
    });
  }

  // Create cards
  let cardCount = 0;
  // Group cards by stack to assign order within each stack
  const cardsByStack = {};
  for (const card of def.cards) {
    if (!cardsByStack[card.stack]) cardsByStack[card.stack] = [];
    cardsByStack[card.stack].push(card);
  }

  for (const [stackTitle, cards] of Object.entries(cardsByStack)) {
    const stackId = stackMap[stackTitle];
    if (!stackId) {
      console.warn(`  Warning: Stack "${stackTitle}" not found, skipping cards`);
      continue;
    }

    for (let i = 0; i < cards.length; i++) {
      const card = cards[i];
      const cardData = {
        title: card.title,
        description: card.description || '',
        type: 'plain',
        order: i
      };

      // Due date: use card-level override, else derive from stack position
      if (card.duedate) {
        cardData.duedate = card.duedate;
      } else {
        const dueDays = getDueDaysForStack(stackTitle);
        cardData.duedate = dueDateFromNow(dueDays);
      }

      const created = await api.createCard(boardId, stackId, cardData);

      // Assign labels
      for (const labelTitle of (card.labels || [])) {
        const labelId = labelMap[labelTitle];
        if (labelId) {
          try {
            await api.assignLabel(boardId, stackId, created.id, labelId);
          } catch (e) {
            console.warn(`  Warning: Could not assign label "${labelTitle}": ${e.message}`);
          }
        }
      }

      // Assign user: GATE cards -> admin, active cards -> moltagent, Done -> skip
      if (!isDoneStack(stackTitle)) {
        const isGate = card.title.toLowerCase().includes('gate');
        const userId = (isGate || isGateStack(stackTitle)) ? 'admin' : 'moltagent';
        try {
          await api.assignUser(boardId, stackId, created.id, userId);
        } catch (e) {
          // Non-critical: user may not be board member
        }
      }

      cardCount++;
    }
  }

  console.log(`  Created board: ${def.title} (${def.stacks.length} stacks, ${def.labels.length} labels, ${cardCount} cards)`);
  return { boardId, stackMap, labelMap, cardCount };
}

/**
 * Main entry point
 */
async function main() {
  const args = process.argv.slice(2);
  const validFlags = ['--clean-only', '--reset'];
  const unknown = args.filter(a => !validFlags.includes(a));
  if (unknown.length) {
    console.error(`Unknown flag(s): ${unknown.join(', ')}`);
    console.error('Usage: node scripts/create-demo-boards.js [--clean-only | --reset]');
    process.exit(1);
  }
  const cleanOnly = args.includes('--clean-only');

  console.log('╔══════════════════════════════════════════════════════════╗');
  console.log('║          Demo Workflow Boards Setup                      ║');
  console.log('╚══════════════════════════════════════════════════════════╝');
  console.log('');

  // Initialize NCRequestManager
  const nc = new NCRequestManager({
    nextcloud: {
      url: appConfig.nextcloud.url,
      username: appConfig.nextcloud.username
    }
  });
  nc.setBootstrapCredential();

  const api = new DeckAPI(nc);

  // Clean existing demo boards
  console.log('Cleaning existing demo boards...');
  const deleted = await cleanDemoBoards(api);
  console.log(deleted > 0 ? `  Removed ${deleted} demo board(s)` : '  No existing demo boards found');
  console.log('');

  if (cleanOnly) {
    console.log('--clean-only: Done.');
    process.exit(0);
  }

  // Create demo boards
  console.log(`Creating ${BOARDS.length} demo boards...`);
  console.log('');

  for (const def of BOARDS) {
    await createDemoBoard(api, def);
  }

  console.log('');
  console.log('Done! All demo boards created.');
  process.exit(0);
}

main().catch(err => {
  console.error('Fatal:', err.message);
  process.exit(1);
});
