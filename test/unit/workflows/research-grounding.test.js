'use strict';

/**
 * Tests for the research grounding block injected by WorkflowEngine._processCard
 * (Part 5 / #188).
 *
 * Strategy: spy on agentLoop.processWorkflowTask to capture systemAddition,
 * then assert the grounding block was (or was not) injected with the right
 * sections.
 *
 * Covers:
 *   - Section A: contact facts template includes the From address from the footer
 *   - Section B: web-research section present when searchPolicy !== 'sovereign'
 *   - Section B: replaced with sovereign note when searchPolicy === 'sovereign'
 *   - Self-scoping: block ABSENT when no From footer in card description
 *   - searchPolicy threaded from cockpitManager through to processWorkflowTask
 */

const assert = require('assert');
const { asyncTest, summary, exitWithCode } = require('../../helpers/test-runner');
const WorkflowEngine = require('../../../src/lib/workflows/workflow-engine');

// ---------------------------------------------------------------------------
// Minimal mock factories
// ---------------------------------------------------------------------------

function makeDeck() {
  return {
    getComments: async () => [],
    addComment:  async () => {},
    getBoard:    async () => ({ labels: [] }),
    _request:    async () => ({}),
    username:    'moltagent',
    stackHasPausedConfig: () => false
  };
}

function makeAgent(searchPolicy, capturedCalls) {
  // Simulate cockpitManager.cachedConfig.system.searchPolicy
  const agent = {
    cockpitManager: {
      cachedConfig: {
        system: { searchPolicy }
      }
    },
    toolRegistry: {
      // No CalDAV client → Section C skipped (tested separately)
      clients: { calDAVClient: null },
      getWorkflowToolDefinitions:      () => [],
      getCloudWorkflowToolDefinitions: () => []
    },
    processWorkflowTask: async (params) => {
      capturedCalls.push(params);
      return 'done';
    }
  };
  return agent;
}

function makeDetector(wb) {
  return {
    getWorkflowBoards: async () => [wb],
    invalidateCache:   () => {}
  };
}

/**
 * Build a minimal workflow board with one card in one stack.
 * The WORKFLOW rules card (rulesCardId) is always present so the board is not
 * treated as PAUSED.
 */
function makeWb({ cardDescription = '' } = {}) {
  const rulesCard = {
    id: 900,
    title: 'WORKFLOW: partner-inquiries',
    description: 'WORKFLOW: Partner Inquiries board',
    labels: []   // no PAUSED label
  };
  const card = {
    id: 100,
    title: 'Inquiry from Acme Corp',
    description: cardDescription,
    labels: [],
    lastModified: new Date(Date.now() - 3600 * 1000).toISOString(), // 1h ago → should process
    duedate: null,
    assignedUsers: []
  };
  const stack = {
    id: 10,
    title: 'Researching',
    cards: [rulesCard, card]
  };
  return {
    boardId: 165,
    board: { id: 165, title: 'Partner Inquiries' },
    description: 'WORKFLOW: Partner Inquiries',
    _plainDescription: 'WORKFLOW: Partner Inquiries',
    stacks: [stack],
    rulesCardId: 900,
    workflowType: 'pipeline'
  };
}

// Post-B2 footer format: no Message-ID line (dropped by _ingestTriggerEmails after #206 fix).
const FROM_FOOTER = '\n\n---\nFrom: Alice Example <alice@acme.com>\nDate: 2026-06-22';
const MAIL_LINK_FOOTER = '\n\n---\nFrom: Alice Example <alice@acme.com>\nDate: 2026-06-22\n[Open the original email in Mail](https://nc.example.com/apps/mail/inbox/1234)';

// ---------------------------------------------------------------------------
// Helper: run engine against one wb, return captured processWorkflowTask calls
// ---------------------------------------------------------------------------
async function runEngine(wb, searchPolicy) {
  const calls = [];
  const agent = makeAgent(searchPolicy, calls);
  const engine = new WorkflowEngine({
    workflowDetector: makeDetector(wb),
    deckClient:       makeDeck(),
    agentLoop:        agent,
    talkSendQueue:    { enqueue: async () => {} },
    talkToken:        'tok'
  });
  await engine.processAll();
  return calls;
}

// ---------------------------------------------------------------------------
// Self-scoping: no From footer → no grounding block
// ---------------------------------------------------------------------------

asyncTest('no grounding block when card has no From footer', async () => {
  const wb    = makeWb({ cardDescription: 'Just a regular description with no footer.' });
  const calls = await runEngine(wb, 'research');
  assert.ok(calls.length >= 1, 'processWorkflowTask should have been called');
  const sys = calls[0].systemAddition;
  assert.ok(!sys.includes('## Structured Research Grounding'),
    'grounding block should NOT be injected for cards without a From footer');
});

// ---------------------------------------------------------------------------
// Section A: contact facts always present when From footer exists
// ---------------------------------------------------------------------------

asyncTest('Section A includes the email address from the From footer', async () => {
  const wb    = makeWb({ cardDescription: 'Hello\n' + FROM_FOOTER });
  const calls = await runEngine(wb, 'research');
  assert.ok(calls.length >= 1);
  const sys = calls[0].systemAddition;
  assert.ok(sys.includes('## Structured Research Grounding'),
    'grounding block should be present');
  assert.ok(sys.includes('alice@acme.com'),
    `systemAddition should contain the email address, got:\n${sys}`);
});

asyncTest('Section A includes the contact name from the From footer', async () => {
  const wb    = makeWb({ cardDescription: 'Hello\n' + FROM_FOOTER });
  const calls = await runEngine(wb, 'research');
  const sys = calls[0].systemAddition;
  assert.ok(sys.includes('Alice Example'),
    `systemAddition should contain the contact name, got:\n${sys}`);
});

asyncTest('Section A includes the NC Mail link when present in footer', async () => {
  const wb    = makeWb({ cardDescription: 'Hello\n' + MAIL_LINK_FOOTER });
  const calls = await runEngine(wb, 'research');
  const sys = calls[0].systemAddition;
  assert.ok(sys.includes('NC Mail thread'),
    `systemAddition should include NC Mail link reference, got:\n${sys}`);
});

asyncTest('Section A works when From footer has no display name (bare address)', async () => {
  // Post-B2 footer: no Message-ID line.
  const bareAddr = '\n\n---\nFrom: <bareaddr@corp.io>\nDate: 2026-06-22';
  const wb = makeWb({ cardDescription: 'Hello\n' + bareAddr });
  const calls = await runEngine(wb, 'research');
  const sys = calls[0].systemAddition;
  assert.ok(sys.includes('bareaddr@corp.io'),
    `systemAddition should contain bare email address, got:\n${sys}`);
});

asyncTest('custody: decoy From: in quoted body does NOT override the footer address', async () => {
  // A forwarded/quoted inbound email whose BODY contains its own From: line.
  // The machine-authored footer (appended last, after the final \n---\n) is the
  // only trusted source. The body decoy must not become the contact fact or the
  // web_search domain anchor (#188 custody / reintroduced #185 break).
  const bodyWithDecoy =
    'Forwarding the thread below:\n\n' +
    'From: Mallory Attacker <mallory@evil.example>\n' +
    'Subject: Re: partnership\n\n' +
    'original message text';
  const wb    = makeWb({ cardDescription: bodyWithDecoy + FROM_FOOTER });
  const calls = await runEngine(wb, 'research');
  const sys = calls[0].systemAddition;
  assert.ok(sys.includes('alice@acme.com'),
    `Footer address (alice@acme.com) must be the contact fact, got:\n${sys}`);
  assert.ok(!sys.includes('mallory@evil.example'),
    `Decoy body address must NOT appear in the grounding block, got:\n${sys}`);
  assert.ok(!sys.includes('evil.example'),
    `Decoy domain must NOT become the web_search anchor, got:\n${sys}`);
});

// ---------------------------------------------------------------------------
// Section B: web research instructions (policy !== 'sovereign')
// ---------------------------------------------------------------------------

asyncTest("Section B: research instructions present when searchPolicy='research'", async () => {
  const wb    = makeWb({ cardDescription: 'Hello\n' + FROM_FOOTER });
  const calls = await runEngine(wb, 'research');
  const sys = calls[0].systemAddition;
  assert.ok(sys.includes('## Research task'),
    `Section B heading not found in:\n${sys}`);
  assert.ok(sys.includes('source URL'),
    `Source-URL attribution requirement not found in:\n${sys}`);
});

asyncTest("Section B: research instructions present when searchPolicy='internal-first'", async () => {
  const wb    = makeWb({ cardDescription: 'Hello\n' + FROM_FOOTER });
  const calls = await runEngine(wb, 'internal-first');
  const sys = calls[0].systemAddition;
  assert.ok(sys.includes('## Research task'),
    `Section B should be present for internal-first policy, got:\n${sys}`);
});

asyncTest("Section B: research instructions present when searchPolicy=undefined (default)", async () => {
  const wb    = makeWb({ cardDescription: 'Hello\n' + FROM_FOOTER });
  const calls = await runEngine(wb, undefined);
  const sys = calls[0].systemAddition;
  assert.ok(sys.includes('## Research task'),
    `Section B should be present when policy is undefined (defaults to research), got:\n${sys}`);
});

// ---------------------------------------------------------------------------
// Section B: sovereign mode — web disabled note
// ---------------------------------------------------------------------------

asyncTest("Section B replaced with sovereign note when searchPolicy='sovereign'", async () => {
  const wb    = makeWb({ cardDescription: 'Hello\n' + FROM_FOOTER });
  const calls = await runEngine(wb, 'sovereign');
  const sys = calls[0].systemAddition;
  assert.ok(!sys.includes('## Research task'),
    `Section B research heading should NOT be present in sovereign mode, got:\n${sys}`);
  assert.ok(sys.includes('sovereign'),
    `Sovereign-mode note should appear in systemAddition, got:\n${sys}`);
  assert.ok(sys.includes('## Research note') || sys.includes('disabled'),
    `Sovereign-mode note (## Research note or "disabled") not found in:\n${sys}`);
});

asyncTest("sovereign mode: Section A contact facts still present", async () => {
  const wb    = makeWb({ cardDescription: 'Hello\n' + FROM_FOOTER });
  const calls = await runEngine(wb, 'sovereign');
  const sys = calls[0].systemAddition;
  assert.ok(sys.includes('alice@acme.com'),
    `Contact address should still be in sovereign mode: got:\n${sys}`);
});

// ---------------------------------------------------------------------------
// searchPolicy threaded to processWorkflowTask
// ---------------------------------------------------------------------------

asyncTest('searchPolicy is passed to processWorkflowTask', async () => {
  const wb    = makeWb({ cardDescription: 'Hello\n' + FROM_FOOTER });
  const calls = await runEngine(wb, 'sovereign');
  assert.ok(calls.length >= 1);
  assert.strictEqual(calls[0].searchPolicy, 'sovereign',
    `searchPolicy 'sovereign' should be forwarded to processWorkflowTask`);
});

asyncTest('searchPolicy research is passed to processWorkflowTask', async () => {
  const wb    = makeWb({ cardDescription: 'Hello\n' + FROM_FOOTER });
  const calls = await runEngine(wb, 'research');
  assert.ok(calls.length >= 1);
  assert.strictEqual(calls[0].searchPolicy, 'research');
});

asyncTest('searchPolicy defaults to "research" when cockpitManager absent', async () => {
  const wb    = makeWb({ cardDescription: 'Hello\n' + FROM_FOOTER });
  const calls = [];
  // Agent with NO cockpitManager
  const agent = {
    cockpitManager: null,
    toolRegistry: {
      clients: { calDAVClient: null },
      getWorkflowToolDefinitions:      () => [],
      getCloudWorkflowToolDefinitions: () => []
    },
    processWorkflowTask: async (params) => { calls.push(params); return 'done'; }
  };
  const engine = new WorkflowEngine({
    workflowDetector: makeDetector(wb),
    deckClient:       makeDeck(),
    agentLoop:        agent,
    talkSendQueue:    { enqueue: async () => {} },
    talkToken:        'tok'
  });
  await engine.processAll();
  assert.ok(calls.length >= 1);
  assert.strictEqual(calls[0].searchPolicy, 'research',
    `Default searchPolicy should be 'research' when cockpitManager absent`);
});

// ---------------------------------------------------------------------------
// B1: wiki_write URL directive (#206 — no [[wikilink]] for Collectives link)
// ---------------------------------------------------------------------------

asyncTest('B1: grounding instructs to use the exact wiki_write returned URL for Collectives link', async () => {
  // Both non-sovereign and sovereign branches must carry the directive.
  const wb    = makeWb({ cardDescription: 'Hello\n' + FROM_FOOTER });
  const calls = await runEngine(wb, 'research');
  assert.ok(calls.length >= 1);
  const sys = calls[0].systemAddition;
  assert.ok(
    sys.includes('wiki_write'),
    `systemAddition must reference wiki_write tool so model knows to use its returned URL; got:\n${sys}`
  );
  assert.ok(
    sys.includes('[View](') || sys.includes('[View](...)'),
    `systemAddition must reference the [View](...) URL pattern from wiki_write result; got:\n${sys}`
  );
});

asyncTest('B1-sovereign: sovereign branch also carries the wiki_write URL directive', async () => {
  const wb    = makeWb({ cardDescription: 'Hello\n' + FROM_FOOTER });
  const calls = await runEngine(wb, 'sovereign');
  assert.ok(calls.length >= 1);
  const sys = calls[0].systemAddition;
  assert.ok(
    sys.includes('wiki_write'),
    `sovereign systemAddition must reference wiki_write tool; got:\n${sys}`
  );
});

asyncTest('B1: grounding forbids [[wikilink]] syntax for the Collectives link', async () => {
  const wb    = makeWb({ cardDescription: 'Hello\n' + FROM_FOOTER });
  const calls = await runEngine(wb, 'research');
  assert.ok(calls.length >= 1);
  const sys = calls[0].systemAddition;
  // The prohibition must be present so the model knows not to construct [[...]] links.
  assert.ok(
    sys.includes('[[wikilink]]') || sys.includes('[['),
    `systemAddition must name the [[...]] pattern to forbid it; got:\n${sys}`
  );
  // The instruction must forbid it, not recommend it.
  // We check for the prohibition phrase that the implementation uses.
  assert.ok(
    sys.includes('Do NOT construct a [[wikilink]]') ||
    sys.includes('Do NOT construct') ||
    sys.includes('wikilink resolver'),
    `systemAddition must contain a prohibition on [[wikilink]] construction; got:\n${sys}`
  );
});

// ---------------------------------------------------------------------------
// B2: no Message-ID in assembled grounding (#192 / #206)
// ---------------------------------------------------------------------------

asyncTest('B2: assembled systemAddition contains no Message-ID substring (B2 removal)', async () => {
  // The card description uses a post-B2 footer (no Message-ID line).
  // The grounding block (Sections A+B) must not include Message-ID either.
  const wb    = makeWb({ cardDescription: 'Hello\n' + FROM_FOOTER });
  const calls = await runEngine(wb, 'research');
  assert.ok(calls.length >= 1);
  const sys = calls[0].systemAddition;
  assert.ok(
    !sys.includes('Message-ID'),
    `systemAddition must contain no "Message-ID" substring after B2 removal; got:\n${sys}`
  );
});

setTimeout(() => { summary(); exitWithCode(); }, 500);
