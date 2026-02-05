/**
 * Deck Self-Assignment Tests
 *
 * Tests that _processCard() calls ensureAssignments after moving to working.
 *
 * Run: node test/unit/integrations/deck-self-assign.test.js
 */

const assert = require('assert');
const { asyncTest, summary, exitWithCode } = require('../../helpers/test-runner');

let DeckTaskProcessor;
try {
  DeckTaskProcessor = require('../../../src/lib/integrations/deck-task-processor');
} catch (err) {
  console.error('Failed to load DeckTaskProcessor:', err.message);
  process.exit(1);
}

(async () => {
  console.log('\n=== Deck Self-Assignment Tests ===\n');

  await asyncTest('_processCard() calls ensureAssignments on working stack after startTask', async () => {
    const assignCalls = [];

    const mockConfig = {
      nextcloud: { url: 'https://test.example.com', username: 'moltagent' },
      credentialBroker: {
        get: async () => null,
        getNCPassword: () => 'test',
        prefetchAll: async () => {},
        discardAll: () => {}
      }
    };

    const mockRouter = {
      route: async () => ({ result: 'Task completed.', provider: 'mock', tokens: 50 })
    };

    const processor = new DeckTaskProcessor(mockConfig, mockRouter, async () => {});

    // Override the DeckClient methods on the processor's internal deck instance
    processor.deck._cache = {
      boardId: 1,
      stacks: { inbox: 1, queued: 2, working: 3, review: 4, done: 5, reference: 6 },
      labels: {},
      lastRefresh: Date.now()
    };

    processor.deck.acceptTask = async () => {};
    processor.deck.startTask = async () => {};
    processor.deck.submitForReview = async () => {};
    processor.deck.moveCard = async () => {};
    processor.deck.addComment = async () => {};
    processor.deck.getCard = async (cardId) => ({
      id: cardId,
      title: 'Test Card',
      type: 'plain',
      owner: { uid: 'creator' }
    });
    processor.deck._request = async () => ({});
    processor.deck.assignUser = async () => {};

    // Track ensureAssignments calls
    processor.deck.ensureAssignments = async (cardId, stackName, creator) => {
      assignCalls.push({ cardId, stackName, creator });
    };

    const card = {
      id: 42,
      title: 'Test Task',
      description: 'Do something',
      labels: [],
      owner: { uid: 'admin' }
    };

    await processor._processCard(card);

    // Should have been called at least twice: once on 'queued' and once on 'working'
    const workingCalls = assignCalls.filter(c => c.stackName === 'working');
    assert.ok(workingCalls.length >= 1, `Expected ensureAssignments on "working", got calls: ${JSON.stringify(assignCalls)}`);
    assert.strictEqual(workingCalls[0].cardId, 42);
  });

  const { passed, failed } = summary();
  exitWithCode();
})();
