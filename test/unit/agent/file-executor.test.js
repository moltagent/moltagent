'use strict';

const assert = require('assert');
const { asyncTest, summary, exitWithCode } = require('../../helpers/test-runner');
const FileExecutor = require('../../../src/lib/agent/executors/file-executor');

const silentLogger = { log() {}, info() {}, warn() {}, error() {} };

function createMockRouter(extractResult, genResult) {
  let callCount = 0;
  return {
    route: async () => {
      callCount++;
      // First call is extraction, second is content generation
      if (callCount === 1) return extractResult || { result: '{}' };
      return genResult || { result: 'Generated content' };
    }
  };
}

function createMockFilesClient() {
  const files = [];
  const shares = [];
  return {
    writeFile: async (path, content) => { files.push({ path, content }); },
    shareFile: async (path, user) => { shares.push({ path, user }); },
    getFiles: () => files,
    getShares: () => shares
  };
}

// -- Test 1: Writes file with extracted params --
asyncTest('Writes file with extracted params', async () => {
  const filesClient = createMockFilesClient();
  const executor = new FileExecutor({
    router: createMockRouter({
      result: JSON.stringify({ action: 'write', filename: 'notes.txt', content: 'Hello world', folder: 'Documents' })
    }),
    ncFilesClient: filesClient,
    logger: silentLogger
  });

  const result = await executor.execute('Create file notes.txt with Hello world', { userName: 'alice' });
  assert.ok(result.includes('notes.txt'), 'Should confirm filename');
  assert.deepStrictEqual(filesClient.getFiles()[0], { path: 'Documents/notes.txt', content: 'Hello world' });
});

// -- Test 2: Auto-shares after write --
asyncTest('Auto-shares file with requesting user after write', async () => {
  const filesClient = createMockFilesClient();
  const executor = new FileExecutor({
    router: createMockRouter({
      result: JSON.stringify({ action: 'write', filename: 'report.md', content: 'Report content' })
    }),
    ncFilesClient: filesClient,
    logger: silentLogger
  });

  await executor.execute('Write report.md', { userName: 'bob' });
  assert.strictEqual(filesClient.getShares().length, 1);
  assert.strictEqual(filesClient.getShares()[0].user, 'bob');
});

// -- Test 3: Guardrail blocks file_delete --
asyncTest('Guardrail blocks file_delete', async () => {
  const executor = new FileExecutor({
    router: createMockRouter({
      result: JSON.stringify({ action: 'delete', filename: 'important.doc' })
    }),
    ncFilesClient: createMockFilesClient(),
    guardrailEnforcer: {
      check: async (name) => {
        if (name === 'file_delete') return { allowed: false, reason: 'Deletion not allowed' };
        return { allowed: true };
      },
      checkApproval: async () => ({ allowed: true })
    },
    logger: silentLogger
  });

  const result = await executor.execute('Delete important.doc', { userName: 'alice' });
  assert.ok(result.includes('blocked'));
});

// -- Test 4: Falls back on parse failure --
asyncTest('Throws DOMAIN_ESCALATE on parse failure', async () => {
  const executor = new FileExecutor({
    router: createMockRouter({ result: 'cannot parse' }),
    ncFilesClient: createMockFilesClient(),
    logger: silentLogger
  });

  try {
    await executor.execute('Do something weird', { userName: 'alice' });
    assert.fail('Should have thrown');
  } catch (err) {
    assert.strictEqual(err.code, 'DOMAIN_ESCALATE');
  }
});

// -- Test 5: Defaults folder to Outbox --
asyncTest('Defaults folder to Outbox when not specified', async () => {
  const filesClient = createMockFilesClient();
  const executor = new FileExecutor({
    router: createMockRouter({
      result: JSON.stringify({ action: 'write', filename: 'test.txt', content: 'data' })
    }),
    ncFilesClient: filesClient,
    logger: silentLogger
  });

  const result = await executor.execute('Write test.txt', { userName: 'alice' });
  assert.ok(result.includes('Outbox'), 'Should default to Outbox folder');
  assert.strictEqual(filesClient.getFiles()[0].path, 'Outbox/test.txt');
});

setTimeout(() => { summary(); exitWithCode(); }, 500);
