#!/usr/bin/env node
/**
 * MoltAgent Deck Integration Test Script
 * 
 * Tests all Deck API operations to verify the integration works correctly.
 * 
 * Usage:
 *   NC_URL=https://your-nc.example.com \
 *   MOLTAGENT_PASSWORD=your-password \
 *   node scripts/test-deck-integration.js
 */

const DeckClient = require('../src/lib/integrations/deck-client');

// ANSI colors for output
const colors = {
  reset: '\x1b[0m',
  green: '\x1b[32m',
  red: '\x1b[31m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  dim: '\x1b[2m'
};

function log(symbol, message, color = colors.reset) {
  console.log(`${color}${symbol}${colors.reset} ${message}`);
}

function pass(message) { log('✓', message, colors.green); }
function fail(message) { log('✗', message, colors.red); }
function info(message) { log('→', message, colors.blue); }
function warn(message) { log('!', message, colors.yellow); }

async function runTests(config) {
  console.log('');
  console.log('╔════════════════════════════════════════════════════════════╗');
  console.log('║         MoltAgent Deck Integration Tests                   ║');
  console.log('╚════════════════════════════════════════════════════════════╝');
  console.log('');

  const deck = new DeckClient(config);
  const results = { passed: 0, failed: 0, tests: [] };
  let testCardId = null;
  
  // Helper to run a test
  async function test(name, fn) {
    process.stdout.write(`  Testing: ${name}... `);
    try {
      await fn();
      console.log(`${colors.green}PASS${colors.reset}`);
      results.passed++;
      results.tests.push({ name, status: 'pass' });
    } catch (error) {
      console.log(`${colors.red}FAIL${colors.reset}`);
      console.log(`    ${colors.dim}Error: ${error.message}${colors.reset}`);
      results.failed++;
      results.tests.push({ name, status: 'fail', error: error.message });
    }
  }

  // ──────────────────────────────────────────────────────────
  console.log('📋 Board Operations');
  console.log('');

  await test('List boards', async () => {
    const boards = await deck.listBoards();
    if (!Array.isArray(boards)) throw new Error('Expected array of boards');
  });

  await test('Ensure board exists', async () => {
    const { boardId, stacks, labels } = await deck.ensureBoard();
    if (!boardId) throw new Error('No board ID returned');
    if (!stacks.inbox) throw new Error('Missing inbox stack');
    if (!stacks.review) throw new Error('Missing review stack');
    if (!stacks.done) throw new Error('Missing done stack');
  });

  await test('Get board details', async () => {
    const { boardId } = await deck.ensureBoard();
    const board = await deck.getBoard(boardId);
    if (board.title !== deck.boardName) throw new Error('Board name mismatch');
  });

  // ──────────────────────────────────────────────────────────
  console.log('');
  console.log('📝 Card Operations');
  console.log('');

  await test('Create card in inbox', async () => {
    const card = await deck.createCard('inbox', {
      title: '🧪 Test Card - ' + new Date().toISOString(),
      description: 'This is a test card created by the integration test.\n\nIt will be deleted automatically.',
      labels: ['admin']
    });
    if (!card.id) throw new Error('No card ID returned');
    testCardId = card.id;
  });

  await test('Get cards in inbox', async () => {
    const cards = await deck.getCardsInStack('inbox');
    if (!Array.isArray(cards)) throw new Error('Expected array of cards');
    const found = cards.find(c => c.id === testCardId);
    if (!found) throw new Error('Test card not found in inbox');
  });

  await test('Move card to working', async () => {
    await deck.moveCard(testCardId, 'inbox', 'working');
    deck.clearCache(); // Force fresh data
    await new Promise(r => setTimeout(r, 500)); // Brief delay for API
    const cards = await deck.getCardsInStack('working');
    const found = cards.find(c => c.id === testCardId);
    if (!found) throw new Error('Card not found in working stack');
  });

  await test('Add comment to card', async () => {
    await deck.addComment(testCardId, 'This is a test comment from the integration test.', 'STATUS');
  });

  await test('Get comments', async () => {
    const comments = await deck.getComments(testCardId);
    // Note: Comments API may return empty on some NC versions
    // Just verify we get a response without error
  });

  await test('Move card to done', async () => {
    await deck.moveCard(testCardId, 'working', 'done');
    deck.clearCache();
    await new Promise(r => setTimeout(r, 500));
    const cards = await deck.getCardsInStack('done');
    const found = cards.find(c => c.id === testCardId);
    if (!found) throw new Error('Card not found in done stack');
  });

  await test('Delete test card', async () => {
    await deck.deleteCard(testCardId, 'done');
    testCardId = null;
  });

  // ──────────────────────────────────────────────────────────
  console.log('');
  console.log('📊 Status Operations');
  console.log('');

  await test('Get workload summary', async () => {
    const summary = await deck.getWorkloadSummary();
    if (typeof summary.inbox !== 'number') throw new Error('Invalid summary format');
    if (typeof summary.total !== 'number') throw new Error('Missing total count');
  });

  await test('Scan inbox', async () => {
    const tasks = await deck.scanInbox();
    if (!Array.isArray(tasks)) throw new Error('Expected array of tasks');
  });

  await test('Get all cards', async () => {
    const allCards = await deck.getAllCards();
    if (typeof allCards !== 'object') throw new Error('Expected object with stacks');
  });

  // ──────────────────────────────────────────────────────────
  console.log('');
  console.log('🔄 Task Flow Operations');
  console.log('');

  // Create a card for flow testing
  let flowCardId = null;
  
  await test('Create task for flow test', async () => {
    const card = await deck.createCard('inbox', {
      title: '🔄 Flow Test - ' + Date.now(),
      description: 'Testing the task flow methods.'
    });
    flowCardId = card.id;
  });

  await test('Accept task (inbox → queued)', async () => {
    await deck.acceptTask(flowCardId, 'Test acceptance');
    deck.clearCache();
    await new Promise(r => setTimeout(r, 500));
    const cards = await deck.getCardsInStack('queued');
    if (!cards.find(c => c.id === flowCardId)) throw new Error('Card not in queued');
  });

  await test('Start task (queued → working)', async () => {
    await deck.startTask(flowCardId, 'Starting test...');
    deck.clearCache();
    await new Promise(r => setTimeout(r, 500));
    const cards = await deck.getCardsInStack('working');
    if (!cards.find(c => c.id === flowCardId)) throw new Error('Card not in working');
  });

  await test('Complete task (working → done)', async () => {
    await deck.completeTask(flowCardId, 'Test completed successfully!');
    deck.clearCache();
    await new Promise(r => setTimeout(r, 500));
    const cards = await deck.getCardsInStack('done');
    if (!cards.find(c => c.id === flowCardId)) throw new Error('Card not in done');
  });

  await test('Cleanup flow test card', async () => {
    await deck.deleteCard(flowCardId, 'done');
    flowCardId = null;
  });

  // ──────────────────────────────────────────────────────────
  console.log('');
  console.log('📝 Review Flow Operations');
  console.log('');

  // Create a card for review flow testing
  let reviewCardId = null;

  await test('Create task for review flow test', async () => {
    const card = await deck.createCard('inbox', {
      title: '📝 Review Flow Test - ' + Date.now(),
      description: 'Testing the review workflow.\n\nThis task should go through the review flow.'
    });
    reviewCardId = card.id;
  });

  await test('Move to working (simulating processing)', async () => {
    await deck.moveCard(reviewCardId, 'inbox', 'working');
    deck.clearCache();
    await new Promise(r => setTimeout(r, 500));
    const cards = await deck.getCardsInStack('working');
    if (!cards.find(c => c.id === reviewCardId)) throw new Error('Card not in working');
  });

  await test('Submit for review (working → review)', async () => {
    const originalDesc = 'Testing the review workflow.\n\nThis task should go through the review flow.';
    const llmResponse = 'This is the simulated LLM response.\n\n- Point 1\n- Point 2\n- Point 3';
    await deck.submitForReview(reviewCardId, 'working', originalDesc, llmResponse, 'Task processed, awaiting review.');
    deck.clearCache();
    await new Promise(r => setTimeout(r, 500));
    const cards = await deck.getCardsInStack('review');
    if (!cards.find(c => c.id === reviewCardId)) throw new Error('Card not in review');
  });

  await test('Verify card description updated', async () => {
    deck.clearCache();
    const card = await deck.getCard(reviewCardId, 'review');
    if (!card.description.includes('## Original Task')) throw new Error('Original task section missing');
    if (!card.description.includes('## MoltAgent Response')) throw new Error('Response section missing');
  });

  await test('Scan review cards', async () => {
    const reviewCards = await deck.scanReviewCards();
    // Note: Our test card won't have human comments yet, so it may not appear
    if (!Array.isArray(reviewCards)) throw new Error('Expected array');
  });

  await test('Complete review (review → done)', async () => {
    await deck.completeReview(reviewCardId, 'Review test completed!');
    deck.clearCache();
    await new Promise(r => setTimeout(r, 500));
    const cards = await deck.getCardsInStack('done');
    if (!cards.find(c => c.id === reviewCardId)) throw new Error('Card not in done');
  });

  await test('Cleanup review test card', async () => {
    await deck.deleteCard(reviewCardId, 'done');
    reviewCardId = null;
  });

  // ──────────────────────────────────────────────────────────
  // Summary
  console.log('');
  console.log('════════════════════════════════════════════════════════════');
  console.log('');
  
  const total = results.passed + results.failed;
  const pct = Math.round((results.passed / total) * 100);
  
  if (results.failed === 0) {
    console.log(`${colors.green}✓ All ${total} tests passed!${colors.reset}`);
  } else {
    console.log(`${colors.yellow}Results: ${results.passed}/${total} passed (${pct}%)${colors.reset}`);
    console.log('');
    console.log('Failed tests:');
    results.tests.filter(t => t.status === 'fail').forEach(t => {
      console.log(`  ${colors.red}✗${colors.reset} ${t.name}: ${t.error}`);
    });
  }
  
  console.log('');
  
  return results;
}

// Cleanup function for interrupted tests
async function cleanup(deck, cardIds) {
  for (const { id, stack } of cardIds) {
    try {
      await deck.deleteCard(id, stack);
      console.log(`Cleaned up card ${id}`);
    } catch (e) {
      // Ignore cleanup errors
    }
  }
}

// ============================================================
// CLI EXECUTION
// ============================================================

if (require.main === module) {
  const ncUrl = process.env.NC_URL;
  const password = process.env.MOLTAGENT_PASSWORD;
  const username = process.env.MOLTAGENT_USERNAME || 'moltagent';
  
  if (!ncUrl || !password) {
    console.error('Error: Missing required environment variables');
    console.error('');
    console.error('Usage:');
    console.error('  NC_URL=https://your-nc.example.com \\');
    console.error('  MOLTAGENT_PASSWORD=your-password \\');
    console.error('  node scripts/test-deck-integration.js');
    console.error('');
    process.exit(1);
  }

  const config = {
    nextcloud: {
      url: ncUrl,
      username: username
    },
    credentialBroker: password,
    deck: {
      boardName: process.env.DECK_BOARD_NAME || 'MoltAgent Tasks',
      archiveAfterDays: 180
    }
  };

  runTests(config)
    .then(results => {
      process.exit(results.failed > 0 ? 1 : 0);
    })
    .catch(error => {
      console.error('');
      console.error('❌ Test suite failed:', error.message);
      process.exit(1);
    });
}

module.exports = runTests;
