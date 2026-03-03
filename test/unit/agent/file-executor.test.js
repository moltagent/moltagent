'use strict';

const assert = require('assert');
const { asyncTest, summary, exitWithCode } = require('../../helpers/test-runner');
const FileExecutor = require('../../../src/lib/agent/executors/file-executor');

const silentLogger = { log() {}, info() {}, warn() {}, error() {} };

// Layer 3: executors may return {response, actionRecord} objects
function getResponse(result) {
  return typeof result === 'object' && result !== null && result.response ? result.response : result;
}

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
  const deletions = [];
  return {
    writeFile: async (path, content) => { files.push({ path, content }); },
    shareFile: async (path, user, permission) => { shares.push({ path, user, permission }); },
    readFile: async (path) => {
      if (path.includes('nonexistent')) {
        const err = new Error('File not found');
        err.statusCode = 404;
        throw err;
      }
      return { content: `Content of ${path}`, truncated: false, totalSize: 100 };
    },
    readFileBuffer: async (path) => Buffer.from(`Buffer of ${path}`),
    listDirectory: async (dirPath) => {
      if (dirPath.includes('nonexistent')) {
        const err = new Error('Folder not found');
        err.statusCode = 404;
        throw err;
      }
      return [
        { name: 'Documents', type: 'directory', size: 0, modified: '2026-03-01' },
        { name: 'report.pdf', type: 'file', size: 2048, modified: '2026-03-02' },
        { name: 'notes.txt', type: 'file', size: 512, modified: '2026-03-03' }
      ];
    },
    deleteFile: async (path) => {
      if (path.includes('nonexistent')) {
        const err = new Error('File not found');
        err.statusCode = 404;
        throw err;
      }
      deletions.push(path);
      return { success: true };
    },
    getFileInfo: async (path) => ({ name: path.split('/').pop(), size: 1024, modified: '2026-03-01' }),
    getFiles: () => files,
    getShares: () => shares,
    getDeletions: () => deletions
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
  assert.ok(getResponse(result).includes('notes.txt'), 'Should confirm filename');
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
  assert.ok(getResponse(result).includes('blocked'));
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
  assert.ok(getResponse(result).includes('Outbox'), 'Should default to Outbox folder');
  assert.strictEqual(filesClient.getFiles()[0].path, 'Outbox/test.txt');
});

// -- Validation gate tests --

asyncTest('requires_clarification returns structured clarification object', async () => {
  const executor = new FileExecutor({
    router: createMockRouter({
      result: JSON.stringify({ action: 'write', requires_clarification: true, missing_fields: ['filename'] })
    }),
    ncFilesClient: createMockFilesClient(),
    logger: silentLogger
  });

  const result = await executor.execute('Do something with a file', { userName: 'alice' });
  assert.strictEqual(typeof result, 'object', 'Should return structured object');
  assert.ok(result.response.includes('clarify'), `expected clarify message, got: ${result.response}`);
  assert.ok(result.response.includes('filename'), `expected filename in missing fields, got: ${result.response}`);
  assert.ok(result.pendingClarification, 'Should include pendingClarification');
  assert.strictEqual(result.pendingClarification.executor, 'file');
});

asyncTest('rejects empty filename for write action', async () => {
  const executor = new FileExecutor({
    router: createMockRouter({
      result: JSON.stringify({ action: 'write', filename: '' })
    }),
    ncFilesClient: createMockFilesClient(),
    logger: silentLogger
  });

  const result = await executor.execute('Write a file', { userName: 'alice' });
  assert.strictEqual(typeof result, 'object', 'Should return structured object');
  assert.ok(result.response.includes('filename'), `expected filename prompt, got: ${result.response}`);
  assert.ok(result.pendingClarification, 'Should include pendingClarification');
  assert.strictEqual(result.pendingClarification.executor, 'file');
});

asyncTest('rejects filename > 100 chars', async () => {
  const executor = new FileExecutor({
    router: createMockRouter({
      result: JSON.stringify({ action: 'write', filename: 'A'.repeat(101) })
    }),
    ncFilesClient: createMockFilesClient(),
    logger: silentLogger
  });

  const result = await executor.execute('Write something', { userName: 'alice' });
  assert.ok(result.includes('file name'), `expected file name prompt, got: ${result}`);
});

// ===== NEW TESTS: read, list, delete, share =====

// -- Test 9: read action reads text file and returns content --
asyncTest('read action reads text file and returns content', async () => {
  const filesClient = createMockFilesClient();
  const executor = new FileExecutor({
    router: createMockRouter({
      result: JSON.stringify({ action: 'read', path: 'Documents/notes.txt' })
    }),
    ncFilesClient: filesClient,
    logger: silentLogger
  });

  const result = await executor.execute('Read Documents/notes.txt', { userName: 'alice' });
  assert.strictEqual(typeof result, 'object');
  assert.ok(result.response.includes('Content of Documents/notes.txt'), `expected file content, got: ${result.response}`);
  assert.strictEqual(result.actionRecord.type, 'file_read');
  assert.strictEqual(result.actionRecord.refs.path, 'Documents/notes.txt');
});

// -- Test 10: read action uses TextExtractor for .pdf files --
asyncTest('read action uses TextExtractor for .pdf files', async () => {
  const filesClient = createMockFilesClient();
  const mockExtractor = {
    extract: async (buffer, path) => ({ text: 'Extracted PDF text', pages: 5 })
  };

  const executor = new FileExecutor({
    router: createMockRouter({
      result: JSON.stringify({ action: 'read', path: 'Reports/annual.pdf' })
    }),
    ncFilesClient: filesClient,
    textExtractor: mockExtractor,
    logger: silentLogger
  });

  const result = await executor.execute('Read Reports/annual.pdf', { userName: 'alice' });
  assert.ok(getResponse(result).includes('Extracted PDF text'), `expected extracted text, got: ${getResponse(result)}`);
  assert.ok(getResponse(result).includes('5 pages'), `expected page count, got: ${getResponse(result)}`);
});

// -- Test 11: read action returns clarification when no filename --
asyncTest('read action returns clarification when no filename', async () => {
  const executor = new FileExecutor({
    router: createMockRouter({
      result: JSON.stringify({ action: 'read' })
    }),
    ncFilesClient: createMockFilesClient(),
    logger: silentLogger
  });

  const result = await executor.execute('Read a file', { userName: 'alice' });
  assert.strictEqual(typeof result, 'object');
  assert.ok(result.response.includes('Which file'), `expected clarification, got: ${result.response}`);
  assert.ok(result.pendingClarification, 'Should include pendingClarification');
  assert.strictEqual(result.pendingClarification.executor, 'file');
  assert.strictEqual(result.pendingClarification.action, 'read');
});

// -- Test 12: list action returns formatted directory listing --
asyncTest('list action returns formatted directory listing', async () => {
  const filesClient = createMockFilesClient();
  const executor = new FileExecutor({
    router: createMockRouter({
      result: JSON.stringify({ action: 'list', folder: 'Projects' })
    }),
    ncFilesClient: filesClient,
    logger: silentLogger
  });

  const result = await executor.execute('List files in Projects', { userName: 'alice' });
  const response = getResponse(result);
  assert.ok(response.includes('Documents'), `expected directory name, got: ${response}`);
  assert.ok(response.includes('report.pdf'), `expected file name, got: ${response}`);
  assert.ok(response.includes('notes.txt'), `expected second file, got: ${response}`);
  assert.strictEqual(result.actionRecord.type, 'file_list');
});

// -- Test 13: list action defaults to root when no folder --
asyncTest('list action defaults to root when no folder', async () => {
  const filesClient = createMockFilesClient();
  let listedPath = null;
  filesClient.listDirectory = async (dirPath) => {
    listedPath = dirPath;
    return [{ name: 'test.txt', type: 'file', size: 100, modified: '2026-03-01' }];
  };

  const executor = new FileExecutor({
    router: createMockRouter({
      result: JSON.stringify({ action: 'list' })
    }),
    ncFilesClient: filesClient,
    logger: silentLogger
  });

  await executor.execute('List my files', { userName: 'alice' });
  assert.strictEqual(listedPath, '/', `expected root path, got: ${listedPath}`);
});

// -- Test 14: delete action calls deleteFile and confirms --
asyncTest('delete action calls deleteFile and confirms', async () => {
  const filesClient = createMockFilesClient();
  const executor = new FileExecutor({
    router: createMockRouter({
      result: JSON.stringify({ action: 'delete', path: 'Outbox/draft.txt' })
    }),
    ncFilesClient: filesClient,
    logger: silentLogger
  });

  const result = await executor.execute('Delete Outbox/draft.txt', { userName: 'alice' });
  const response = getResponse(result);
  assert.ok(response.includes('Deleted'), `expected deletion confirmation, got: ${response}`);
  assert.ok(response.includes('draft.txt'), `expected filename in confirmation, got: ${response}`);
  assert.deepStrictEqual(filesClient.getDeletions(), ['Outbox/draft.txt']);
  assert.strictEqual(result.actionRecord.type, 'file_delete');
});

// -- Test 15: share action calls shareFile with permission --
asyncTest('share action calls shareFile with permission', async () => {
  const filesClient = createMockFilesClient();
  const executor = new FileExecutor({
    router: createMockRouter({
      result: JSON.stringify({ action: 'share', path: 'Documents/spec.md', share_with: 'carol', permission: 'edit' })
    }),
    ncFilesClient: filesClient,
    logger: silentLogger
  });

  const result = await executor.execute('Share Documents/spec.md with carol', { userName: 'alice' });
  const response = getResponse(result);
  assert.ok(response.includes('Shared'), `expected share confirmation, got: ${response}`);
  assert.ok(response.includes('carol'), `expected username, got: ${response}`);
  assert.ok(response.includes('edit'), `expected permission, got: ${response}`);
  assert.strictEqual(filesClient.getShares().length, 1);
  assert.strictEqual(filesClient.getShares()[0].user, 'carol');
  assert.strictEqual(filesClient.getShares()[0].permission, 'edit');
  assert.strictEqual(result.actionRecord.type, 'file_share');
});

// -- Test 16: share action returns clarification when no share_with --
asyncTest('share action returns clarification when no share_with', async () => {
  const executor = new FileExecutor({
    router: createMockRouter({
      result: JSON.stringify({ action: 'share', path: 'Documents/spec.md' })
    }),
    ncFilesClient: createMockFilesClient(),
    logger: silentLogger
  });

  const result = await executor.execute('Share Documents/spec.md', { userName: 'alice' });
  assert.strictEqual(typeof result, 'object');
  assert.ok(result.response.includes('Who'), `expected clarification, got: ${result.response}`);
  assert.ok(result.pendingClarification, 'Should include pendingClarification');
  assert.strictEqual(result.pendingClarification.executor, 'file');
  assert.strictEqual(result.pendingClarification.action, 'share');
  assert.ok(result.pendingClarification.missingFields.includes('share_with'));
});

// -- Test 17: _buildPath rejects path traversal with .. --
asyncTest('_buildPath rejects path traversal with ..', async () => {
  const executor = new FileExecutor({
    router: createMockRouter({
      result: JSON.stringify({ action: 'read', path: '../../../etc/passwd' })
    }),
    ncFilesClient: createMockFilesClient(),
    logger: silentLogger
  });

  try {
    await executor.execute('Read ../../../etc/passwd', { userName: 'alice' });
    assert.fail('Should have thrown');
  } catch (err) {
    assert.strictEqual(err.code, 'DOMAIN_ESCALATE');
    assert.ok(err.message.includes('traversal'), `expected traversal message, got: ${err.message}`);
  }
});

// -- Test 18: _buildPath rejects absolute paths --
asyncTest('_buildPath rejects leading / in path', async () => {
  const executor = new FileExecutor({
    router: createMockRouter({
      result: JSON.stringify({ action: 'read', path: '/etc/shadow' })
    }),
    ncFilesClient: createMockFilesClient(),
    logger: silentLogger
  });

  try {
    await executor.execute('Read /etc/shadow', { userName: 'alice' });
    assert.fail('Should have thrown');
  } catch (err) {
    assert.strictEqual(err.code, 'DOMAIN_ESCALATE');
  }
});

// -- Test 19: list rejects path traversal --
asyncTest('list action rejects path traversal', async () => {
  const executor = new FileExecutor({
    router: createMockRouter({
      result: JSON.stringify({ action: 'list', path: '../../etc' })
    }),
    ncFilesClient: createMockFilesClient(),
    logger: silentLogger
  });

  try {
    await executor.execute('List ../../etc', { userName: 'alice' });
    assert.fail('Should have thrown');
  } catch (err) {
    assert.strictEqual(err.code, 'DOMAIN_ESCALATE');
  }
});

// -- Test 20: read returns "File not found" on 404 --
asyncTest('read action returns friendly message on 404', async () => {
  const executor = new FileExecutor({
    router: createMockRouter({
      result: JSON.stringify({ action: 'read', path: 'nonexistent/file.txt' })
    }),
    ncFilesClient: createMockFilesClient(),
    logger: silentLogger
  });

  const result = await executor.execute('Read nonexistent/file.txt', { userName: 'alice' });
  assert.ok(typeof result === 'string', 'Should return plain string on 404');
  assert.ok(result.includes('File not found'), `expected not found message, got: ${result}`);
});

setTimeout(() => { summary(); exitWithCode(); }, 500);
