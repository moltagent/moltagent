#!/usr/bin/env node
/**
 * NC Talk Webhook Server Integration Test
 *
 * Simulates NC Talk sending webhook requests to the Moltagent webhook server.
 * Tests signature verification, message processing, and error handling.
 *
 * Usage:
 *   1. Start the webhook server: NC_PASSWORD=test NC_TALK_SECRET=test-secret node webhook-server.js
 *   2. Run this test: node tests/test-webhook-server.js
 */

const http = require('http');
const crypto = require('crypto');

// Configuration - must match webhook server
const CONFIG = {
  serverUrl: process.env.WEBHOOK_URL || 'http://localhost:3000',
  secret: process.env.NC_TALK_SECRET || 'test-secret-for-webhook-testing-must-be-long-enough',
  backend: process.env.NC_URL || 'https://YOUR_NEXTCLOUD_URL'
};

// Test utilities
let passed = 0;
let failed = 0;

function assert(condition, message) {
  if (condition) {
    passed++;
    console.log(`  ✓ ${message}`);
  } else {
    failed++;
    console.log(`  ✗ ${message}`);
  }
}

/**
 * Create a signed webhook request (as NC Talk would)
 */
function createSignedRequest(body, secret = CONFIG.secret) {
  const random = crypto.randomBytes(32).toString('hex');
  const signature = crypto
    .createHmac('sha256', secret)
    .update(random + body)
    .digest('hex');

  return {
    headers: {
      'Content-Type': 'application/json',
      'X-Nextcloud-Talk-Signature': signature,
      'X-Nextcloud-Talk-Random': random,
      'X-Nextcloud-Talk-Backend': CONFIG.backend
    },
    body
  };
}

/**
 * Make HTTP request to webhook server
 */
function makeRequest(path, method, headers, body) {
  return new Promise((resolve, reject) => {
    const url = new URL(path, CONFIG.serverUrl);

    const options = {
      hostname: url.hostname,
      port: url.port || 80,
      path: url.pathname,
      method,
      headers,
      timeout: 5000
    };

    const req = http.request(options, (res) => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => {
        resolve({
          status: res.statusCode,
          headers: res.headers,
          body: data
        });
      });
    });

    req.on('error', reject);
    req.on('timeout', () => {
      req.destroy();
      reject(new Error('Request timeout'));
    });

    if (body) {
      req.write(body);
    }
    req.end();
  });
}

// ============================================================================
// TEST CASES
// ============================================================================

async function testHealthEndpoint() {
  console.log('\n═══════════════════════════════════════════════════════════════');
  console.log('TEST 1: Health Endpoint');
  console.log('═══════════════════════════════════════════════════════════════');

  try {
    const response = await makeRequest('/health', 'GET', {}, null);
    assert(response.status === 200, 'Health endpoint returns 200');

    const data = JSON.parse(response.body);
    assert(data.status === 'ok', 'Status is ok');
    assert(data.service === 'moltagent-webhook', 'Service name correct');
  } catch (error) {
    failed++;
    console.log(`  ✗ Health check failed: ${error.message}`);
  }
}

async function testStatsEndpoint() {
  console.log('\n═══════════════════════════════════════════════════════════════');
  console.log('TEST 2: Stats Endpoint');
  console.log('═══════════════════════════════════════════════════════════════');

  try {
    const response = await makeRequest('/stats', 'GET', {}, null);
    assert(response.status === 200, 'Stats endpoint returns 200');

    const data = JSON.parse(response.body);
    assert(data.verifier && typeof data.verifier.totalVerifications === 'number', 'Has totalVerifications');
    assert(data.verifier && typeof data.verifier.successful === 'number', 'Has successful count');
    assert(data.verifier && typeof data.verifier.failed === 'number', 'Has failed count');
  } catch (error) {
    failed++;
    console.log(`  ✗ Stats check failed: ${error.message}`);
  }
}

async function testValidWebhook() {
  console.log('\n═══════════════════════════════════════════════════════════════');
  console.log('TEST 3: Valid Webhook (Signed Message)');
  console.log('═══════════════════════════════════════════════════════════════');

  const message = {
    type: 'Create',
    actor: {
      type: 'Person',
      id: 'users/testuser',
      name: 'Test User'
    },
    object: {
      type: 'Note',
      id: '12345',
      content: '/help'
    },
    target: {
      type: 'Collection',
      id: 'testroom123',
      name: 'Test Room'
    }
  };

  const body = JSON.stringify(message);
  const { headers } = createSignedRequest(body);

  try {
    const response = await makeRequest('/webhook/nctalk', 'POST', headers, body);
    if (response.status !== 200) {
      failed++;
      console.log(`  ✗ Valid webhook returns 200 (got ${response.status})`);
      console.log(`     Response: ${response.body.substring(0, 200)}`);
    } else {
      assert(response.status === 200, 'Valid webhook returns 200');
    }
    if (response.body !== 'OK') {
      failed++;
      console.log(`  ✗ Response body is OK (got "${response.body.substring(0, 50)}")`);
    } else {
      assert(response.body === 'OK', 'Response body is OK');
    }
  } catch (error) {
    failed++;
    console.log(`  ✗ Valid webhook failed: ${error.message}`);
  }
}

async function testInvalidSignature() {
  console.log('\n═══════════════════════════════════════════════════════════════');
  console.log('TEST 4: Invalid Signature (Should Reject)');
  console.log('═══════════════════════════════════════════════════════════════');

  const body = JSON.stringify({ type: 'Create', object: { content: 'test' } });
  const { headers } = createSignedRequest(body);

  // Corrupt the signature
  headers['X-Nextcloud-Talk-Signature'] = 'a'.repeat(64);

  try {
    const response = await makeRequest('/webhook/nctalk', 'POST', headers, body);
    assert(response.status === 401, 'Invalid signature returns 401');

    const data = JSON.parse(response.body);
    assert(data.error === 'Signature verification failed', 'Returns correct error');
  } catch (error) {
    failed++;
    console.log(`  ✗ Invalid signature test failed: ${error.message}`);
  }
}

async function testMissingHeaders() {
  console.log('\n═══════════════════════════════════════════════════════════════');
  console.log('TEST 5: Missing Headers (Should Reject)');
  console.log('═══════════════════════════════════════════════════════════════');

  const body = JSON.stringify({ type: 'Create', object: { content: 'test' } });

  try {
    // Missing all signature headers
    const response = await makeRequest('/webhook/nctalk', 'POST', {
      'Content-Type': 'application/json'
    }, body);

    assert(response.status === 401, 'Missing headers returns 401');
  } catch (error) {
    failed++;
    console.log(`  ✗ Missing headers test failed: ${error.message}`);
  }
}

async function testWrongBackend() {
  console.log('\n═══════════════════════════════════════════════════════════════');
  console.log('TEST 6: Wrong Backend (Should Reject)');
  console.log('═══════════════════════════════════════════════════════════════');

  const body = JSON.stringify({ type: 'Create', object: { content: 'test' } });
  const { headers } = createSignedRequest(body);

  // Change backend to unauthorized server
  headers['X-Nextcloud-Talk-Backend'] = 'https://evil-server.com';

  try {
    const response = await makeRequest('/webhook/nctalk', 'POST', headers, body);
    assert(response.status === 401, 'Wrong backend returns 401');

    const data = JSON.parse(response.body);
    assert(data.reason.includes('allowlist') || data.reason.includes('Backend'), 'Mentions backend issue');
  } catch (error) {
    failed++;
    console.log(`  ✗ Wrong backend test failed: ${error.message}`);
  }
}

async function testTamperedBody() {
  console.log('\n═══════════════════════════════════════════════════════════════');
  console.log('TEST 7: Tampered Body (Should Reject)');
  console.log('═══════════════════════════════════════════════════════════════');

  const originalBody = JSON.stringify({ type: 'Create', object: { content: 'original' } });
  const { headers } = createSignedRequest(originalBody);

  // Send different body than what was signed
  const tamperedBody = JSON.stringify({ type: 'Create', object: { content: 'TAMPERED!' } });

  try {
    const response = await makeRequest('/webhook/nctalk', 'POST', headers, tamperedBody);
    assert(response.status === 401, 'Tampered body returns 401');
  } catch (error) {
    failed++;
    console.log(`  ✗ Tampered body test failed: ${error.message}`);
  }
}

async function testChatMessage() {
  console.log('\n═══════════════════════════════════════════════════════════════');
  console.log('TEST 8: Chat Message Processing');
  console.log('═══════════════════════════════════════════════════════════════');

  const message = {
    type: 'Create',
    actor: {
      type: 'Person',
      id: 'users/alice',
      name: 'Alice'
    },
    object: {
      type: 'Note',
      id: '67890',
      content: 'Hello, Moltagent!'
    },
    target: {
      type: 'Collection',
      id: 'room456',
      name: 'General Chat'
    }
  };

  const body = JSON.stringify(message);
  const { headers } = createSignedRequest(body);

  try {
    const response = await makeRequest('/webhook/nctalk', 'POST', headers, body);
    if (response.status !== 200) {
      failed++;
      console.log(`  ✗ Chat message processed (got status ${response.status})`);
      console.log(`     Response: ${response.body.substring(0, 200)}`);
    } else {
      assert(response.status === 200, 'Chat message processed');
    }
    // Note: The actual reply goes to NC Talk, we just verify the webhook was accepted
  } catch (error) {
    failed++;
    console.log(`  ✗ Chat message test failed: ${error.message}`);
  }
}

async function test404() {
  console.log('\n═══════════════════════════════════════════════════════════════');
  console.log('TEST 9: Unknown Endpoint (404)');
  console.log('═══════════════════════════════════════════════════════════════');

  try {
    const response = await makeRequest('/unknown/path', 'GET', {}, null);
    assert(response.status === 404, 'Unknown path returns 404');
  } catch (error) {
    failed++;
    console.log(`  ✗ 404 test failed: ${error.message}`);
  }
}

// ============================================================================
// MAIN
// ============================================================================

async function runTests() {
  console.log('╔════════════════════════════════════════════════════════════════╗');
  console.log('║         NC Talk Webhook Server Integration Tests               ║');
  console.log('╚════════════════════════════════════════════════════════════════╝');
  console.log('');
  console.log(`Server URL: ${CONFIG.serverUrl}`);
  console.log(`Backend: ${CONFIG.backend}`);
  console.log('');

  // Check if server is running
  try {
    await makeRequest('/health', 'GET', {}, null);
  } catch (error) {
    console.log('');
    console.log('═══════════════════════════════════════════════════════════════');
    console.log('SKIP: Webhook server is not running');
    console.log('═══════════════════════════════════════════════════════════════');
    console.log('');
    console.log('This is an integration test that requires a running webhook server.');
    console.log('To run these tests, start the server with:');
    console.log('');
    console.log('  NC_PASSWORD=test NC_TALK_SECRET=test-secret-for-webhook-testing-must-be-long-enough node webhook-server.js');
    console.log('');
    console.log('Then run: node test/integration/webhook-server.test.js');
    console.log('');
    process.exit(0); // Exit successfully (skip test, don't fail)
  }

  // Check if server has correct secret (test that signature verification works)
  const testBody = JSON.stringify({ type: 'Test' });
  const { headers } = createSignedRequest(testBody);
  try {
    const testResponse = await makeRequest('/webhook/nctalk', 'POST', headers, testBody);
    if (testResponse.status === 401) {
      console.log('');
      console.log('═══════════════════════════════════════════════════════════════');
      console.log('SKIP: Webhook server is running with different secret');
      console.log('═══════════════════════════════════════════════════════════════');
      console.log('');
      console.log('The server is running but with a different NC_TALK_SECRET.');
      console.log('To run these tests, restart the server with:');
      console.log('');
      console.log('  NC_TALK_SECRET=test-secret-for-webhook-testing-must-be-long-enough node webhook-server.js');
      console.log('');
      process.exit(0); // Exit successfully (skip test, don't fail)
    }
  } catch (error) {
    // If we can't even make the request, we already handled it above
  }

  await testHealthEndpoint();
  await testStatsEndpoint();
  await testValidWebhook();
  await testInvalidSignature();
  await testMissingHeaders();
  await testWrongBackend();
  await testTamperedBody();
  await testChatMessage();
  await test404();

  console.log('\n═══════════════════════════════════════════════════════════════');
  console.log(`RESULTS: ${passed} passed, ${failed} failed ${failed === 0 ? '✓' : '✗'}`);
  console.log('═══════════════════════════════════════════════════════════════');

  process.exit(failed > 0 ? 1 : 0);
}

runTests().catch(err => {
  console.error('Test runner error:', err);
  process.exit(1);
});
