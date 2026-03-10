// Mock type: LEGACY — TODO: migrate to realistic mocks
/**
 * Job Classification Tests (Session B3)
 *
 * Verifies that all router.route() call sites include an explicit
 * `job: JOBS.X` field and that legacy task-only routing is eliminated.
 *
 * Run: node test/unit/llm/job-classification.test.js
 *
 * @module test/unit/llm/job-classification
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { test, asyncTest, summary, exitWithCode } = require('../../helpers/test-runner');

const LLMRouter = require('../../../src/lib/llm/router');
const { JOBS } = LLMRouter;

// ============================================================
// Spy Router Factory
// ============================================================

function createSpyRouter() {
  const calls = [];
  return {
    _calls: calls,
    route: async (request) => {
      calls.push(request);
      return { result: 'mock response', response: 'mock response', provider: 'mock', tokens: 50 };
    },
    testConnections: async () => ({}),
    getStats: () => ({ totalCalls: 0 })
  };
}

// ============================================================
// JOBS Constant Validation
// ============================================================

console.log('\nJob Classification Tests (Session B3)');
console.log('=====================================\n');

console.log('--- JOBS Constant Values ---\n');

test('TC-CLASS-CONST-001: JOBS values match expected strings', () => {
  assert.strictEqual(JOBS.QUICK, 'quick');
  assert.strictEqual(JOBS.TOOLS, 'tools');
  assert.strictEqual(JOBS.THINKING, 'thinking');
  assert.strictEqual(JOBS.WRITING, 'writing');
  assert.strictEqual(JOBS.RESEARCH, 'research');
  assert.strictEqual(JOBS.CODING, 'coding');
  assert.strictEqual(JOBS.CREDENTIALS, 'credentials');
});

test('TC-CLASS-CONST-002: JOBS is frozen', () => {
  assert.ok(Object.isFrozen(JOBS));
});

// ============================================================
// Integration tests (async — run before summary)
// ============================================================

console.log('\n--- Integration: message-router ---\n');

asyncTest('TC-CLASS-INT-001: message-router chat fallback passes job: JOBS.QUICK', async () => {
  const spy = createSpyRouter();
  const MessageRouter = require('../../../src/lib/handlers/message-router');
  const mr = new MessageRouter({
    llmRouter: spy,
    auditLog: async () => {},
    sendTalkMessage: async () => {},
    ncRequestManager: { ncUrl: 'https://test.example.com', ncUser: 'test', request: async () => ({ status: 200, body: {} }) }
  });

  await mr._handleGeneral('Hello there', { user: 'testuser', roomToken: 'test' });

  assert.ok(spy._calls.length >= 1, 'route() should be called at least once');
  const call = spy._calls[spy._calls.length - 1];
  assert.strictEqual(call.job, JOBS.QUICK, `Expected job QUICK, got ${call.job}`);
  assert.strictEqual(call.task, 'chat');
});

console.log('\n--- Integration: email-handler ---\n');

asyncTest('TC-CLASS-INT-002: email-handler draft passes job: JOBS.WRITING', async () => {
  const spy = createSpyRouter();
  const EmailHandler = require('../../../src/lib/handlers/email-handler');
  const credBroker = { get: async () => null, getNCPassword: () => 'test' };
  const eh = new EmailHandler(credBroker, spy, async () => {});

  try {
    await eh.handleDraftEmail({ to: 'test@test.com', topic: 'test meeting' }, 'testuser', {});
  } catch (e) {
    // May throw due to missing deps, but route() call should have been captured
  }

  const draftCall = spy._calls.find(c => c.task === 'email_draft');
  assert.ok(draftCall, 'email_draft route call should be captured');
  assert.strictEqual(draftCall.job, JOBS.WRITING, `Expected job WRITING, got ${draftCall.job}`);
});

console.log('\n--- Integration: deck-task-processor ---\n');

asyncTest('TC-CLASS-INT-003: deck-task-processor research passes job: JOBS.RESEARCH', async () => {
  const spy = createSpyRouter();
  const DeckTaskProcessor = require('../../../src/lib/integrations/deck-task-processor');
  const dtp = new DeckTaskProcessor(
    { nextcloudUrl: 'https://test.example.com', username: 'test', password: 'test' },
    spy,
    async () => {}
  );

  await dtp._handleResearch({ title: 'Test Research', description: 'Research topic' });

  const call = spy._calls.find(c => c.task === 'research');
  assert.ok(call, 'research route call should be captured');
  assert.strictEqual(call.job, JOBS.RESEARCH, `Expected job RESEARCH, got ${call.job}`);
});

console.log('\n--- Integration: session-persister ---\n');

asyncTest('TC-CLASS-INT-004: session-persister passes job: JOBS.SYNTHESIS without sovereign role', async () => {
  const spy = createSpyRouter();
  const SessionPersister = require('../../../src/lib/integrations/session-persister');
  const sp = new SessionPersister({
    wikiClient: {
      searchPages: async () => [],
      createPage: async () => ({ id: 1 }),
      updatePage: async () => ({})
    },
    llmRouter: spy
  });

  const session = { id: 'test-session', startedAt: Date.now() };
  const messages = [];
  for (let i = 0; i < 8; i++) {
    messages.push({ role: i % 2 === 0 ? 'user' : 'assistant', content: `Message ${i} with some content here` });
  }

  await sp._generateSummary(session, messages);

  assert.ok(spy._calls.length >= 1, 'route() should be called');
  const call = spy._calls[0];
  assert.strictEqual(call.job, JOBS.SYNTHESIS, `Expected job SYNTHESIS, got ${call.job}`);
  assert.strictEqual(call.task, 'session_summary');
  assert.strictEqual(call.requirements, undefined, 'Should not force sovereign role');
});

console.log('\n--- Integration: heartbeat-intelligence ---\n');

asyncTest('TC-CLASS-INT-005: heartbeat-intelligence meeting_prep passes job: JOBS.RESEARCH', async () => {
  const spy = createSpyRouter();
  const { MeetingPreparer } = require('../../../src/lib/integrations/heartbeat-intelligence');
  const mp = new MeetingPreparer({
    caldavClient: null,
    collectivesClient: { findPageByTitle: async () => null },
    contactsClient: { search: async () => [] },
    emailMonitor: null,
    deckClient: null,
    router: spy,
    notifyUser: async () => {}
  });

  const event = {
    summary: 'Test Meeting',
    start: '2026-02-18T10:00:00',
    attendees: [{ email: 'alice@example.com', name: 'Alice' }]
  };
  const context = { wikiPages: [], recentEmails: [], sharedTasks: [], attendees: [] };

  await mp._synthesize(event, context);

  const call = spy._calls.find(c => c.task === 'meeting_prep');
  assert.ok(call, 'meeting_prep route call should be captured');
  assert.strictEqual(call.job, JOBS.RESEARCH, `Expected job RESEARCH, got ${call.job}`);
});

// ============================================================
// Source Code Verification (sync — run immediately)
// ============================================================

console.log('\n--- Source Code Verification ---\n');

test('TC-CLASS-VERIFY-001: no route() calls without job: in source files', () => {
  const srcDir = path.join(__dirname, '../../../src/lib');
  const filesToCheck = [
    'handlers/message-router.js',
    'handlers/email-handler.js',
    'handlers/calendar-handler.js',
    'services/email-monitor.js',
    'integrations/deck-task-processor.js',
    'integrations/heartbeat-intelligence.js',
    'integrations/session-persister.js'
  ];

  for (const file of filesToCheck) {
    const content = fs.readFileSync(path.join(srcDir, file), 'utf8');
    // Find all route() call blocks
    const routeCalls = content.match(/\.route\(\{[\s\S]*?\}\)/g) || [];
    for (const call of routeCalls) {
      assert.ok(
        call.includes('job:'),
        `${file}: Found route() call without job: field:\n${call.substring(0, 100)}...`
      );
    }
  }
});

test('TC-CLASS-VERIFY-002: all modified files import JOBS', () => {
  const srcDir = path.join(__dirname, '../../../src/lib');
  const filesToCheck = [
    'handlers/message-router.js',
    'handlers/email-handler.js',
    'handlers/calendar-handler.js',
    'services/email-monitor.js',
    'integrations/deck-task-processor.js',
    'integrations/heartbeat-intelligence.js',
    'integrations/session-persister.js'
  ];

  for (const file of filesToCheck) {
    const content = fs.readFileSync(path.join(srcDir, file), 'utf8');
    assert.ok(
      content.includes('{ JOBS }') || content.includes('{JOBS}'),
      `${file}: Missing JOBS import`
    );
  }
});

test('TC-CLASS-VERIFY-003: router uses job field when roster is active', () => {
  const router = new LLMRouter();
  // With no roster, _mapLegacyTask is used (tested in B1)
  // When job is provided and roster is active, job should be used directly
  const routerSrc = fs.readFileSync(
    path.join(__dirname, '../../../src/lib/llm/router.js'),
    'utf8'
  );
  // Verify the router checks request.job before falling back to _mapLegacyTask
  assert.ok(
    routerSrc.includes('request.job') || routerSrc.includes('req.job'),
    'Router should check request.job field'
  );
});

test('TC-CLASS-VERIFY-004: session-persister uses synthesis job without sovereign role', () => {
  const content = fs.readFileSync(
    path.join(__dirname, '../../../src/lib/integrations/session-persister.js'),
    'utf8'
  );
  // Session summaries use synthesis job (routes to Haiku when cloud-ok)
  assert.ok(
    content.includes("job: JOBS.SYNTHESIS"),
    'session-persister should use JOBS.SYNTHESIS'
  );
  assert.ok(
    !content.includes("role: 'sovereign'"),
    'session-persister should not force sovereign role'
  );
});

test('TC-CLASS-VERIFY-005: all JOBS values used in source match valid job strings', () => {
  const srcDir = path.join(__dirname, '../../../src/lib');
  const filesToCheck = [
    'handlers/message-router.js',
    'handlers/email-handler.js',
    'handlers/calendar-handler.js',
    'services/email-monitor.js',
    'integrations/deck-task-processor.js',
    'integrations/heartbeat-intelligence.js',
    'integrations/session-persister.js'
  ];

  const usedJobs = new Set();
  for (const file of filesToCheck) {
    const content = fs.readFileSync(path.join(srcDir, file), 'utf8');
    const matches = content.match(/JOBS\.(\w+)/g) || [];
    for (const m of matches) {
      const jobName = m.replace('JOBS.', '');
      usedJobs.add(jobName);
    }
  }

  // Every used JOBS.X should be a valid key
  for (const jobName of usedJobs) {
    assert.ok(
      JOBS[jobName] !== undefined,
      `JOBS.${jobName} is used in source but not defined in JOBS constant`
    );
  }

  // Verify we found the expected jobs
  assert.ok(usedJobs.has('QUICK'), 'QUICK should be used');
  assert.ok(usedJobs.has('TOOLS'), 'TOOLS should be used');
  assert.ok(usedJobs.has('WRITING'), 'WRITING should be used');
  assert.ok(usedJobs.has('RESEARCH'), 'RESEARCH should be used');
  assert.ok(usedJobs.has('THINKING'), 'THINKING should be used');
});

// ============================================================
// Summary (deferred to let async tests complete)
// ============================================================

setTimeout(() => {
  summary();
  exitWithCode();
}, 500);
