// Mock type: LEGACY — TODO: migrate to realistic mocks
/**
 * Heartbeat Intelligence Tests
 *
 * Tests for MeetingPreparer, DailyDigester, and FreshnessChecker.
 *
 * Run: node test/unit/integrations/heartbeat-intelligence.test.js
 */

const assert = require('assert');
const { test, asyncTest, summary, exitWithCode } = require('../../helpers/test-runner');

let MeetingPreparer, FreshnessChecker;
try {
  ({ MeetingPreparer, FreshnessChecker } = require('../../../src/lib/integrations/heartbeat-intelligence'));
} catch (err) {
  console.error('Failed to load heartbeat-intelligence:', err.message);
  process.exit(1);
}

// ============================================================================
// Helpers
// ============================================================================

function createMockCalDAV(events = []) {
  return {
    getUpcomingEvents: async (hours) => events
  };
}

function createMockWiki(pages = [], contentMap = {}) {
  return {
    resolveCollective: async () => 10,
    listPages: async () => pages,
    findPageByTitle: async (title) => {
      const page = pages.find(p => p.title === title);
      return page ? { page, path: `${page.title}/Readme.md` } : null;
    },
    readPageContent: async (path) => {
      return contentMap[path] || null;
    },
    readPageWithFrontmatter: async (title) => {
      const page = pages.find(p => p.title === title);
      if (!page) return null;
      const content = contentMap[page.fileName] || contentMap[`${page.title}/Readme.md`];
      if (!content) return null;
      const { parseFrontmatter } = require('../../../src/lib/knowledge/frontmatter');
      const { frontmatter, body } = parseFrontmatter(content);
      return { frontmatter, body, path: page.fileName || `${page.title}.md` };
    },
    writePageWithFrontmatter: async () => {},
  };
}

function createMockContacts(results = []) {
  return {
    search: async (query) => results
  };
}

function createMockDeck(stacks = {}) {
  const createdCards = [];
  return {
    getCardsInStack: async (name) => stacks[name] || [],
    createCard: async (stackName, card) => {
      createdCards.push({ stackName, ...card });
      return { id: 100, ...card };
    },
    _createdCards: createdCards
  };
}

function createMockRouter(response = { result: 'Prep notes here' }) {
  const calls = [];
  return {
    route: async (opts) => {
      calls.push(opts);
      return response;
    },
    _calls: calls,
    budget: {
      getFullReport: () => ({
        providers: {
          ollama: { monthly: { cost: 0 } },
          claude: { monthly: { cost: 1.23 } }
        },
        proactive: { dailyCost: 0.05, dailyCalls: 3 }
      })
    }
  };
}

function createMockNotify() {
  const messages = [];
  const fn = async (notification) => {
    messages.push(notification);
  };
  fn._messages = messages;
  return fn;
}

// ============================================================================
// Main (async)
// ============================================================================

(async () => {
  console.log('\n=== Heartbeat Intelligence Tests ===\n');

  // ==========================================================================
  // MeetingPreparer Tests
  // ==========================================================================

  console.log('--- MeetingPreparer ---\n');

  await asyncTest('checkAndPrep() finds upcoming meeting and gathers context', async () => {
    const events = [{
      uid: 'evt-1',
      summary: 'Team Standup',
      start: new Date(Date.now() + 30 * 60 * 1000).toISOString(),
      attendees: [{ name: 'Alice', email: 'alice@example.com' }]
    }];

    const notifyUser = createMockNotify();
    const router = createMockRouter();
    const wiki = createMockWiki(
      [{ id: 1, title: 'Alice', fileId: 11 }],
      { 'Alice/Readme.md': 'Alice is a developer.' }
    );

    const prep = new MeetingPreparer({
      caldavClient: createMockCalDAV(events),
      collectivesClient: wiki,
      contactsClient: createMockContacts([{ name: 'Alice', email: 'alice@example.com' }]),
      deckClient: createMockDeck({ working: [] }),
      router,
      notifyUser,
      config: {}
    });

    const result = await prep.checkAndPrep();
    assert.strictEqual(result.checked, 1);
    assert.strictEqual(result.prepped, 1);
    assert.strictEqual(notifyUser._messages.length, 1);
    assert.ok(notifyUser._messages[0].message.includes('Team Standup'));
    assert.strictEqual(router._calls.length, 1);
  });

  await asyncTest('checkAndPrep() skips already-prepped meetings', async () => {
    const events = [{
      uid: 'evt-2',
      summary: 'Repeat Meeting',
      start: '2026-03-01T10:00:00Z',
      attendees: [{ name: 'Bob', email: 'bob@example.com' }]
    }];

    const notifyUser = createMockNotify();
    const router = createMockRouter();

    const prep = new MeetingPreparer({
      caldavClient: createMockCalDAV(events),
      collectivesClient: createMockWiki(),
      contactsClient: createMockContacts(),
      deckClient: createMockDeck(),
      router,
      notifyUser,
      config: {}
    });

    prep.preparedMeetings.add('evt-2-2026-03-01T10:00:00Z');

    const result = await prep.checkAndPrep();
    assert.strictEqual(result.prepped, 0);
    assert.strictEqual(notifyUser._messages.length, 0);
  });

  await asyncTest('checkAndPrep() skips events without attendees', async () => {
    const events = [{
      uid: 'evt-3',
      summary: 'Focus Time',
      start: new Date().toISOString(),
      attendees: []
    }, {
      uid: 'evt-4',
      summary: 'Lunch',
      start: new Date().toISOString()
    }];

    const notifyUser = createMockNotify();
    const router = createMockRouter();

    const prep = new MeetingPreparer({
      caldavClient: createMockCalDAV(events),
      collectivesClient: createMockWiki(),
      contactsClient: createMockContacts(),
      deckClient: createMockDeck(),
      router,
      notifyUser,
      config: {}
    });

    const result = await prep.checkAndPrep();
    assert.strictEqual(result.checked, 2);
    assert.strictEqual(result.prepped, 0);
  });

  await asyncTest('_gatherContext() queries wiki, contacts, and deck', async () => {
    const event = {
      attendees: [
        { name: 'Charlie', email: 'charlie@co.com' },
        { name: 'Dana', email: 'dana@co.com' }
      ]
    };

    const wiki = createMockWiki(
      [{ id: 1, title: 'Charlie', fileId: 22 }],
      { 'Charlie/Readme.md': 'Charlie is a PM' }
    );
    const contacts = createMockContacts([{ name: 'Charlie', email: 'charlie@co.com' }]);
    const deck = createMockDeck({
      working: [
        { title: 'Shared task', assignedUsers: [{ participant: { displayname: 'Charlie' } }] }
      ]
    });

    const prep = new MeetingPreparer({
      caldavClient: createMockCalDAV(),
      collectivesClient: wiki,
      contactsClient: contacts,
      deckClient: deck,
      router: createMockRouter(),
      notifyUser: createMockNotify(),
      config: {}
    });

    const ctx = await prep._gatherContext(event);
    assert.strictEqual(ctx.wikiPages.length, 1);
    assert.strictEqual(ctx.wikiPages[0].name, 'Charlie');
    // Mock contacts returns results for every search, so both attendees match
    assert.strictEqual(ctx.attendees.length, 2);
    assert.strictEqual(ctx.sharedTasks.length, 1);
  });

  await asyncTest('_gatherContext() handles individual source failures gracefully', async () => {
    const event = {
      attendees: [{ name: 'Eve', email: 'eve@co.com' }]
    };

    const brokenWiki = {
      findPageByTitle: async () => { throw new Error('wiki fail'); },
      readPageContent: async () => { throw new Error('wiki fail'); }
    };

    const brokenContacts = {
      search: async () => { throw new Error('contacts fail'); }
    };

    const brokenDeck = {
      getCardsInStack: async () => { throw new Error('deck fail'); }
    };

    const prep = new MeetingPreparer({
      caldavClient: createMockCalDAV(),
      collectivesClient: brokenWiki,
      contactsClient: brokenContacts,
      deckClient: brokenDeck,
      router: createMockRouter(),
      notifyUser: createMockNotify(),
      config: {}
    });

    const ctx = await prep._gatherContext(event);
    assert.deepStrictEqual(ctx.wikiPages, []);
    assert.deepStrictEqual(ctx.attendees, []);
    assert.deepStrictEqual(ctx.sharedTasks, []);
  });

  await asyncTest('_synthesize() passes event + context to LLM with correct trigger', async () => {
    const router = createMockRouter();

    const prep = new MeetingPreparer({
      caldavClient: createMockCalDAV(),
      collectivesClient: createMockWiki(),
      contactsClient: createMockContacts(),
      deckClient: createMockDeck(),
      router,
      notifyUser: createMockNotify(),
      config: {}
    });

    const event = {
      summary: 'Sprint Review',
      start: '2026-02-10T14:00:00Z',
      attendees: [{ name: 'Frank', email: 'frank@co.com' }]
    };

    const context = {
      wikiPages: [{ name: 'Frank', content: 'Frank is lead dev' }],
      recentEmails: [],
      sharedTasks: [{ title: 'Fix bug #123' }]
    };

    const result = await prep._synthesize(event, context);
    assert.ok(result !== null);
    assert.ok(result.includes('Sprint Review'));
    assert.strictEqual(router._calls.length, 1);
    assert.strictEqual(router._calls[0].context.trigger, 'heartbeat_meeting_prep');
    assert.strictEqual(router._calls[0].task, 'meeting_prep');
  });

  // ==========================================================================
  // FreshnessChecker Tests
  // ==========================================================================

  console.log('\n--- FreshnessChecker ---\n');

  await asyncTest('maybeCheck() runs once per day', async () => {
    const wiki = createMockWiki([], {});

    const fc = new FreshnessChecker({
      collectivesClient: wiki,
      deckClient: createMockDeck(),
      notifyUser: createMockNotify(),
      config: {}
    });

    const r1 = await fc.maybeCheck();
    assert.ok(r1.checked !== undefined && r1.checked !== false, 'First run should check');

    const r2 = await fc.maybeCheck();
    assert.strictEqual(r2.checked, false, 'Second run same day should skip');
  });

  await asyncTest('maybeCheck() skips if already checked today', async () => {
    const wiki = createMockWiki([], {});

    const fc = new FreshnessChecker({
      collectivesClient: wiki,
      deckClient: createMockDeck(),
      notifyUser: createMockNotify(),
      config: {}
    });

    fc.lastCheckDate = new Date().toISOString().split('T')[0];
    const result = await fc.maybeCheck();
    assert.strictEqual(result.checked, false);
  });

  await asyncTest('checkAll() flags pages past decay_days', async () => {
    const oldDateStr = '2025-01-01';
    const pages = [
      { id: 1, title: 'Stale Page', fileId: 10, fileName: 'Stale Page.md' }
    ];
    const contentMap = {
      'Stale Page.md': `---\nlast_updated: ${oldDateStr}\ndecay_days: 7\nconfidence: high\n---\n# Stale Page\nContent here.`
    };

    const notifyUser = createMockNotify();
    const deck = createMockDeck({ inbox: [] });

    const fc = new FreshnessChecker({
      collectivesClient: createMockWiki(pages, contentMap),
      deckClient: deck,
      notifyUser,
      config: {}
    });

    const result = await fc.checkAll();
    assert.strictEqual(result.checked, 1);
    assert.strictEqual(result.flagged, 1);
    assert.strictEqual(notifyUser._messages.length, 1);
    assert.ok(notifyUser._messages[0].message.includes('verification'), 'Should mention verification');
    assert.strictEqual(deck._createdCards.length, 1);
    assert.ok(deck._createdCards[0].title.includes('Verify: Stale Page'));
  });

  await asyncTest('checkAll() ignores pages without frontmatter', async () => {
    const pages = [
      { id: 1, title: 'No FM', fileId: 10, fileName: 'No FM.md' }
    ];
    const contentMap = {
      'No FM.md': '# Just a heading\nNo frontmatter here.'
    };

    const fc = new FreshnessChecker({
      collectivesClient: createMockWiki(pages, contentMap),
      deckClient: createMockDeck({ inbox: [] }),
      notifyUser: createMockNotify(),
      config: {}
    });

    const result = await fc.checkAll();
    assert.strictEqual(result.checked, 1);
    assert.strictEqual(result.flagged, 0);
  });

  await asyncTest('_createVerificationCard() skips if card already exists', async () => {
    const deck = createMockDeck({
      inbox: [{ title: 'Verify: Old Page' }]
    });

    const fc = new FreshnessChecker({
      collectivesClient: createMockWiki(),
      deckClient: deck,
      notifyUser: createMockNotify(),
      config: {}
    });

    await fc._createVerificationCard({ title: 'Old Page' }, { decay_days: 30 }, 45);
    assert.strictEqual(deck._createdCards.length, 0);
  });

  test('_daysSince() computes correct day difference', () => {
    const fc = new FreshnessChecker({
      collectivesClient: createMockWiki(),
      deckClient: createMockDeck(),
      notifyUser: createMockNotify(),
      config: {}
    });

    const tenDaysAgo = new Date(Date.now() - 10 * 86400000).toISOString().split('T')[0];
    const days = fc._daysSince(tenDaysAgo);
    assert.ok(days >= 9 && days <= 11, `Expected ~10, got ${days}`);

    const today = new Date().toISOString().split('T')[0];
    assert.strictEqual(fc._daysSince(today), 0);
  });

  // ==========================================================================
  // Summary
  // ==========================================================================

  const { passed, failed } = summary();
  exitWithCode();
})();
