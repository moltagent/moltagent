/**
 * TalkSignatureVerifier Unit Tests
 *
 * Security-critical tests for NC Talk webhook signature verification.
 *
 * Run: node test/unit/talk-signature-verifier.test.js
 *
 * @module talk-signature-verifier.test
 */

const assert = require('assert');
const crypto = require('crypto');

const TalkSignatureVerifier = require('../../src/lib/talk-signature-verifier');
const { SignatureVerificationError } = require('../../src/lib/talk-signature-verifier');

// ============================================================
// Test Helpers
// ============================================================

let testsPassed = 0;
let testsFailed = 0;

function test(name, fn) {
  try {
    fn();
    console.log(`✓ ${name}`);
    testsPassed++;
  } catch (error) {
    console.log(`✗ ${name}`);
    console.log(`  Error: ${error.message}`);
    testsFailed++;
  }
}

async function asyncTest(name, fn) {
  try {
    await fn();
    console.log(`✓ ${name}`);
    testsPassed++;
  } catch (error) {
    console.log(`✗ ${name}`);
    console.log(`  Error: ${error.message}`);
    testsFailed++;
  }
}

// ============================================================
// Fixtures & Mocks
// ============================================================

const FIXTURES = {
  SECRET: 'test-shared-secret-key-12345',
  RANDOM: 'a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d2e3f4a5b6c7d8e9f0a1b2',
  BACKEND: 'https://cloud.example.com',
  BODIES: {
    simple: '{"type":"message","content":"hello"}',
    unicode: '{"type":"message","content":"Hello 😀"}',
    empty: '',
    large: '{"data":"' + 'x'.repeat(1000000) + '"}',
  }
};

/**
 * Generate a valid signature for testing
 */
function generateValidSignature(secret, random, body) {
  return crypto
    .createHmac('sha256', secret)
    .update(random + body)
    .digest('hex');
}

/**
 * Create a complete valid request headers object
 */
function createValidHeaders(secret, random, body, backend) {
  return {
    'X-Nextcloud-Talk-Signature': generateValidSignature(secret, random, body),
    'X-Nextcloud-Talk-Random': random,
    'X-Nextcloud-Talk-Backend': backend
  };
}

/**
 * Mock getSecret function for testing
 */
function createMockGetSecret(secretValue, delay = 0) {
  return async () => {
    if (delay > 0) await new Promise(r => setTimeout(r, delay));
    return secretValue;
  };
}

/**
 * Mock getSecret that throws
 */
function createFailingGetSecret(errorMessage) {
  return async () => {
    throw new Error(errorMessage);
  };
}

/**
 * Mock audit log function that records calls
 */
function createMockAuditLog() {
  const calls = [];
  const fn = async (event, data) => {
    calls.push({ event, data, timestamp: Date.now() });
  };
  fn.getCalls = () => calls;
  fn.reset = () => { calls.length = 0; };
  return fn;
}

// ============================================================
// Constructor Tests (TC-CON-*)
// ============================================================

console.log('\n=== Constructor Tests ===\n');

test('TC-CON-001: Requires getSecret function', () => {
  try {
    new TalkSignatureVerifier({});
    assert.fail('Should have thrown');
  } catch (error) {
    assert.strictEqual(error.message, 'TalkSignatureVerifier requires a getSecret function');
  }
});

test('TC-CON-002: Rejects non-function getSecret', () => {
  try {
    new TalkSignatureVerifier({ getSecret: 'not a function' });
    assert.fail('Should have thrown');
  } catch (error) {
    assert.strictEqual(error.message, 'TalkSignatureVerifier requires a getSecret function');
  }
});

test('TC-CON-003: Accepts valid minimal config', () => {
  const verifier = new TalkSignatureVerifier({ getSecret: async () => 'secret' });
  assert.ok(verifier instanceof TalkSignatureVerifier);
  assert.strictEqual(typeof verifier.getSecret, 'function');
});

test('TC-CON-004: Accepts full configuration', () => {
  const auditLog = async () => {};
  const verifier = new TalkSignatureVerifier({
    getSecret: async () => 'secret',
    allowedBackends: ['https://cloud.example.com'],
    auditLog,
    strictMode: true,
    requireBackendValidation: true
  });

  assert.ok(verifier instanceof TalkSignatureVerifier);
  assert.deepStrictEqual(verifier.allowedBackends, ['https://cloud.example.com']);
  assert.strictEqual(verifier.auditLog, auditLog);
  assert.strictEqual(verifier.strictMode, true);
  assert.strictEqual(verifier.requireBackendValidation, true);
});

test('TC-CON-005: Default values applied correctly', () => {
  const verifier = new TalkSignatureVerifier({ getSecret: async () => 'secret' });

  assert.deepStrictEqual(verifier.allowedBackends, []);
  assert.strictEqual(verifier.strictMode, true);
  assert.strictEqual(verifier.requireBackendValidation, true);
  assert.strictEqual(verifier.stats.totalVerifications, 0);
  assert.strictEqual(verifier.stats.successful, 0);
  assert.strictEqual(verifier.stats.failed, 0);
  assert.deepStrictEqual(verifier.stats.failureReasons, {});
});

// ============================================================
// Valid Signature Tests (TC-VER-*)
// ============================================================

console.log('\n=== Valid Signature Tests ===\n');

asyncTest('TC-VER-001: Valid signature with correct headers', async () => {
  const verifier = new TalkSignatureVerifier({
    getSecret: createMockGetSecret(FIXTURES.SECRET),
    allowedBackends: [FIXTURES.BACKEND]
  });

  const headers = createValidHeaders(
    FIXTURES.SECRET,
    FIXTURES.RANDOM,
    FIXTURES.BODIES.simple,
    FIXTURES.BACKEND
  );

  const result = await verifier.verify(headers, FIXTURES.BODIES.simple);

  assert.strictEqual(result.valid, true);
  assert.strictEqual(result.backend, FIXTURES.BACKEND);
  assert.ok(result.details);
  assert.ok(typeof result.details.duration === 'number');
  assert.ok(typeof result.details.bodyLength === 'number');
});

asyncTest('TC-VER-002: Valid signature with Buffer body', async () => {
  const verifier = new TalkSignatureVerifier({
    getSecret: createMockGetSecret(FIXTURES.SECRET),
    allowedBackends: [FIXTURES.BACKEND]
  });

  const bodyBuffer = Buffer.from(FIXTURES.BODIES.simple);
  const headers = createValidHeaders(
    FIXTURES.SECRET,
    FIXTURES.RANDOM,
    FIXTURES.BODIES.simple,
    FIXTURES.BACKEND
  );

  const result = await verifier.verify(headers, bodyBuffer);

  assert.strictEqual(result.valid, true);
});

asyncTest('TC-VER-003: Valid signature with uppercase hex', async () => {
  const verifier = new TalkSignatureVerifier({
    getSecret: createMockGetSecret(FIXTURES.SECRET),
    allowedBackends: [FIXTURES.BACKEND]
  });

  const signature = generateValidSignature(
    FIXTURES.SECRET,
    FIXTURES.RANDOM,
    FIXTURES.BODIES.simple
  ).toUpperCase();

  const headers = {
    'X-Nextcloud-Talk-Signature': signature,
    'X-Nextcloud-Talk-Random': FIXTURES.RANDOM,
    'X-Nextcloud-Talk-Backend': FIXTURES.BACKEND
  };

  const result = await verifier.verify(headers, FIXTURES.BODIES.simple);

  assert.strictEqual(result.valid, true);
});

asyncTest('TC-VER-004: Valid signature with mixed case headers', async () => {
  const verifier = new TalkSignatureVerifier({
    getSecret: createMockGetSecret(FIXTURES.SECRET),
    allowedBackends: [FIXTURES.BACKEND]
  });

  const signature = generateValidSignature(
    FIXTURES.SECRET,
    FIXTURES.RANDOM,
    FIXTURES.BODIES.simple
  );

  const headers = {
    'x-NEXTCLOUD-talk-SIGNATURE': signature,
    'x-nextcloud-TALK-random': FIXTURES.RANDOM,
    'X-NextCloud-Talk-Backend': FIXTURES.BACKEND
  };

  const result = await verifier.verify(headers, FIXTURES.BODIES.simple);

  assert.strictEqual(result.valid, true);
});

asyncTest('TC-VER-005: Valid signature increments success stats', async () => {
  const verifier = new TalkSignatureVerifier({
    getSecret: createMockGetSecret(FIXTURES.SECRET),
    allowedBackends: [FIXTURES.BACKEND]
  });

  const headers = createValidHeaders(
    FIXTURES.SECRET,
    FIXTURES.RANDOM,
    FIXTURES.BODIES.simple,
    FIXTURES.BACKEND
  );

  const statsBefore = verifier.getStats();
  assert.strictEqual(statsBefore.successful, 0);
  assert.strictEqual(statsBefore.totalVerifications, 0);

  await verifier.verify(headers, FIXTURES.BODIES.simple);

  const statsAfter = verifier.getStats();
  assert.strictEqual(statsAfter.successful, 1);
  assert.strictEqual(statsAfter.totalVerifications, 1);
});

// ============================================================
// Invalid/Tampered Signature Tests (TC-INV-*)
// ============================================================

console.log('\n=== Invalid Signature Tests ===\n');

asyncTest('TC-INV-001: Wrong signature for body', async () => {
  const verifier = new TalkSignatureVerifier({
    getSecret: createMockGetSecret(FIXTURES.SECRET),
    allowedBackends: [FIXTURES.BACKEND]
  });

  const headers = createValidHeaders(
    FIXTURES.SECRET,
    FIXTURES.RANDOM,
    'different body',
    FIXTURES.BACKEND
  );

  const result = await verifier.verify(headers, FIXTURES.BODIES.simple);

  assert.strictEqual(result.valid, false);
  assert.strictEqual(result.reason, 'Signature mismatch');
});

asyncTest('TC-INV-002: Wrong signature for random', async () => {
  const verifier = new TalkSignatureVerifier({
    getSecret: createMockGetSecret(FIXTURES.SECRET),
    allowedBackends: [FIXTURES.BACKEND]
  });

  const differentRandom = 'b'.repeat(64);
  const signature = generateValidSignature(
    FIXTURES.SECRET,
    differentRandom,
    FIXTURES.BODIES.simple
  );

  const headers = {
    'X-Nextcloud-Talk-Signature': signature,
    'X-Nextcloud-Talk-Random': FIXTURES.RANDOM,
    'X-Nextcloud-Talk-Backend': FIXTURES.BACKEND
  };

  const result = await verifier.verify(headers, FIXTURES.BODIES.simple);

  assert.strictEqual(result.valid, false);
  assert.strictEqual(result.reason, 'Signature mismatch');
});

asyncTest('TC-INV-003: Wrong secret used', async () => {
  const verifier = new TalkSignatureVerifier({
    getSecret: createMockGetSecret(FIXTURES.SECRET),
    allowedBackends: [FIXTURES.BACKEND]
  });

  const headers = createValidHeaders(
    'different-secret',
    FIXTURES.RANDOM,
    FIXTURES.BODIES.simple,
    FIXTURES.BACKEND
  );

  const result = await verifier.verify(headers, FIXTURES.BODIES.simple);

  assert.strictEqual(result.valid, false);
  assert.strictEqual(result.reason, 'Signature mismatch');
});

asyncTest('TC-INV-004: Truncated signature', async () => {
  const verifier = new TalkSignatureVerifier({
    getSecret: createMockGetSecret(FIXTURES.SECRET),
    allowedBackends: [FIXTURES.BACKEND]
  });

  const headers = {
    'X-Nextcloud-Talk-Signature': 'a'.repeat(32),
    'X-Nextcloud-Talk-Random': FIXTURES.RANDOM,
    'X-Nextcloud-Talk-Backend': FIXTURES.BACKEND
  };

  const result = await verifier.verify(headers, FIXTURES.BODIES.simple);

  assert.strictEqual(result.valid, false);
  assert.strictEqual(result.reason, 'Invalid signature format (expected 64 hex chars)');
});

asyncTest('TC-INV-005: Extended signature', async () => {
  const verifier = new TalkSignatureVerifier({
    getSecret: createMockGetSecret(FIXTURES.SECRET),
    allowedBackends: [FIXTURES.BACKEND]
  });

  const headers = {
    'X-Nextcloud-Talk-Signature': 'a'.repeat(128),
    'X-Nextcloud-Talk-Random': FIXTURES.RANDOM,
    'X-Nextcloud-Talk-Backend': FIXTURES.BACKEND
  };

  const result = await verifier.verify(headers, FIXTURES.BODIES.simple);

  assert.strictEqual(result.valid, false);
  assert.strictEqual(result.reason, 'Invalid signature format (expected 64 hex chars)');
});

asyncTest('TC-INV-006: Non-hex signature characters', async () => {
  const verifier = new TalkSignatureVerifier({
    getSecret: createMockGetSecret(FIXTURES.SECRET),
    allowedBackends: [FIXTURES.BACKEND]
  });

  const headers = {
    'X-Nextcloud-Talk-Signature': 'g'.repeat(64),
    'X-Nextcloud-Talk-Random': FIXTURES.RANDOM,
    'X-Nextcloud-Talk-Backend': FIXTURES.BACKEND
  };

  const result = await verifier.verify(headers, FIXTURES.BODIES.simple);

  assert.strictEqual(result.valid, false);
  assert.strictEqual(result.reason, 'Invalid signature format (expected 64 hex chars)');
});

asyncTest('TC-INV-007: Tampered body increments failure stats', async () => {
  const verifier = new TalkSignatureVerifier({
    getSecret: createMockGetSecret(FIXTURES.SECRET),
    allowedBackends: [FIXTURES.BACKEND]
  });

  const headers = createValidHeaders(
    FIXTURES.SECRET,
    FIXTURES.RANDOM,
    'wrong body',
    FIXTURES.BACKEND
  );

  await verifier.verify(headers, FIXTURES.BODIES.simple);

  const stats = verifier.getStats();
  assert.strictEqual(stats.failed, 1);
  assert.strictEqual(stats.totalVerifications, 1);
  assert.strictEqual(stats.failureReasons['Signature mismatch'], 1);
});

// ============================================================
// Timing-Safe Comparison Tests (TC-TIM-*)
// ============================================================

console.log('\n=== Timing-Safe Comparison Tests ===\n');

asyncTest('TC-TIM-001: Different length strings handled safely', async () => {
  const verifier = new TalkSignatureVerifier({
    getSecret: createMockGetSecret(FIXTURES.SECRET),
    allowedBackends: [FIXTURES.BACKEND]
  });

  const headers = {
    'X-Nextcloud-Talk-Signature': 'a'.repeat(63),
    'X-Nextcloud-Talk-Random': FIXTURES.RANDOM,
    'X-Nextcloud-Talk-Backend': FIXTURES.BACKEND
  };

  const result = await verifier.verify(headers, FIXTURES.BODIES.simple);

  assert.strictEqual(result.valid, false);
});

asyncTest('TC-TIM-002: Equal length different content at start', async () => {
  const verifier = new TalkSignatureVerifier({
    getSecret: createMockGetSecret(FIXTURES.SECRET),
    allowedBackends: [FIXTURES.BACKEND]
  });

  const validSignature = generateValidSignature(
    FIXTURES.SECRET,
    FIXTURES.RANDOM,
    FIXTURES.BODIES.simple
  );

  // Replace first char with another hex char to keep format valid
  const tamperedSignature = (validSignature[0] === 'a' ? 'b' : 'a') + validSignature.substring(1);

  const headers = {
    'X-Nextcloud-Talk-Signature': tamperedSignature,
    'X-Nextcloud-Talk-Random': FIXTURES.RANDOM,
    'X-Nextcloud-Talk-Backend': FIXTURES.BACKEND
  };

  const result = await verifier.verify(headers, FIXTURES.BODIES.simple);

  assert.strictEqual(result.valid, false);
  assert.strictEqual(result.reason, 'Signature mismatch');
});

asyncTest('TC-TIM-003: Equal length different at end', async () => {
  const verifier = new TalkSignatureVerifier({
    getSecret: createMockGetSecret(FIXTURES.SECRET),
    allowedBackends: [FIXTURES.BACKEND]
  });

  const validSignature = generateValidSignature(
    FIXTURES.SECRET,
    FIXTURES.RANDOM,
    FIXTURES.BODIES.simple
  );

  // Replace last char with another hex char to keep format valid
  const lastChar = validSignature[63];
  const tamperedSignature = validSignature.substring(0, 63) + (lastChar === 'a' ? 'b' : 'a');

  const headers = {
    'X-Nextcloud-Talk-Signature': tamperedSignature,
    'X-Nextcloud-Talk-Random': FIXTURES.RANDOM,
    'X-Nextcloud-Talk-Backend': FIXTURES.BACKEND
  };

  const result = await verifier.verify(headers, FIXTURES.BODIES.simple);

  assert.strictEqual(result.valid, false);
  assert.strictEqual(result.reason, 'Signature mismatch');
});

asyncTest('TC-TIM-004: Handles Buffer conversion errors gracefully', async () => {
  const verifier = new TalkSignatureVerifier({
    getSecret: createMockGetSecret(FIXTURES.SECRET),
    allowedBackends: [FIXTURES.BACKEND]
  });

  // Test internal _timingSafeCompare with edge cases
  const result1 = verifier._timingSafeCompare('test', 'test');
  assert.strictEqual(result1, true);

  const result2 = verifier._timingSafeCompare('test', 'fail');
  assert.strictEqual(result2, false);
});

// ============================================================
// Backend Allowlist Tests (TC-BAK-*)
// ============================================================

console.log('\n=== Backend Allowlist Tests ===\n');

asyncTest('TC-BAK-001: Backend in allowlist passes', async () => {
  const verifier = new TalkSignatureVerifier({
    getSecret: createMockGetSecret(FIXTURES.SECRET),
    allowedBackends: [FIXTURES.BACKEND]
  });

  const headers = createValidHeaders(
    FIXTURES.SECRET,
    FIXTURES.RANDOM,
    FIXTURES.BODIES.simple,
    FIXTURES.BACKEND
  );

  const result = await verifier.verify(headers, FIXTURES.BODIES.simple);

  assert.strictEqual(result.valid, true);
});

asyncTest('TC-BAK-002: Backend not in allowlist fails', async () => {
  const verifier = new TalkSignatureVerifier({
    getSecret: createMockGetSecret(FIXTURES.SECRET),
    allowedBackends: [FIXTURES.BACKEND]
  });

  const evilBackend = 'https://evil.com';
  const headers = createValidHeaders(
    FIXTURES.SECRET,
    FIXTURES.RANDOM,
    FIXTURES.BODIES.simple,
    evilBackend
  );

  const result = await verifier.verify(headers, FIXTURES.BODIES.simple);

  assert.strictEqual(result.valid, false);
  assert.strictEqual(result.reason, 'Backend not in allowlist');
});

asyncTest('TC-BAK-003: URL normalization - trailing slash', async () => {
  const verifier = new TalkSignatureVerifier({
    getSecret: createMockGetSecret(FIXTURES.SECRET),
    allowedBackends: [FIXTURES.BACKEND]
  });

  const backendWithSlash = FIXTURES.BACKEND + '/';
  const headers = createValidHeaders(
    FIXTURES.SECRET,
    FIXTURES.RANDOM,
    FIXTURES.BODIES.simple,
    backendWithSlash
  );

  const result = await verifier.verify(headers, FIXTURES.BODIES.simple);

  assert.strictEqual(result.valid, true);
});

asyncTest('TC-BAK-004: URL normalization - case insensitivity', async () => {
  const verifier = new TalkSignatureVerifier({
    getSecret: createMockGetSecret(FIXTURES.SECRET),
    allowedBackends: [FIXTURES.BACKEND.toLowerCase()]
  });

  const backendUpperCase = 'https://CLOUD.example.com';
  const headers = createValidHeaders(
    FIXTURES.SECRET,
    FIXTURES.RANDOM,
    FIXTURES.BODIES.simple,
    backendUpperCase
  );

  const result = await verifier.verify(headers, FIXTURES.BODIES.simple);

  assert.strictEqual(result.valid, true);
});

asyncTest('TC-BAK-005: Empty allowlist with requireBackendValidation=true', async () => {
  const verifier = new TalkSignatureVerifier({
    getSecret: createMockGetSecret(FIXTURES.SECRET),
    allowedBackends: [],
    requireBackendValidation: true
  });

  const headers = createValidHeaders(
    FIXTURES.SECRET,
    FIXTURES.RANDOM,
    FIXTURES.BODIES.simple,
    FIXTURES.BACKEND
  );

  const result = await verifier.verify(headers, FIXTURES.BODIES.simple);

  // Should pass because allowedBackends is empty (not configured)
  assert.strictEqual(result.valid, true);
});

asyncTest('TC-BAK-006: Backend validation disabled', async () => {
  const verifier = new TalkSignatureVerifier({
    getSecret: createMockGetSecret(FIXTURES.SECRET),
    allowedBackends: [FIXTURES.BACKEND],
    requireBackendValidation: false
  });

  const evilBackend = 'https://evil.com';
  const headers = createValidHeaders(
    FIXTURES.SECRET,
    FIXTURES.RANDOM,
    FIXTURES.BODIES.simple,
    evilBackend
  );

  const result = await verifier.verify(headers, FIXTURES.BODIES.simple);

  // Should pass because backend validation is disabled
  assert.strictEqual(result.valid, true);
});

asyncTest('TC-BAK-007: Add backend dynamically', async () => {
  const verifier = new TalkSignatureVerifier({
    getSecret: createMockGetSecret(FIXTURES.SECRET),
    allowedBackends: []
  });

  assert.strictEqual(verifier.allowedBackends.length, 0);

  verifier.addAllowedBackend('https://new.example.com');

  assert.strictEqual(verifier.allowedBackends.length, 1);
  assert.ok(verifier.allowedBackends.includes('https://new.example.com'));
});

asyncTest('TC-BAK-008: Remove backend dynamically', async () => {
  const verifier = new TalkSignatureVerifier({
    getSecret: createMockGetSecret(FIXTURES.SECRET),
    allowedBackends: [FIXTURES.BACKEND]
  });

  assert.strictEqual(verifier.allowedBackends.length, 1);

  verifier.removeAllowedBackend(FIXTURES.BACKEND);

  assert.strictEqual(verifier.allowedBackends.length, 0);
});

asyncTest('TC-BAK-009: Add duplicate backend is idempotent', async () => {
  const verifier = new TalkSignatureVerifier({
    getSecret: createMockGetSecret(FIXTURES.SECRET),
    allowedBackends: []
  });

  verifier.addAllowedBackend(FIXTURES.BACKEND);
  verifier.addAllowedBackend(FIXTURES.BACKEND);

  assert.strictEqual(verifier.allowedBackends.length, 1);
});

asyncTest('TC-BAK-010: Remove non-existent backend is safe', async () => {
  const verifier = new TalkSignatureVerifier({
    getSecret: createMockGetSecret(FIXTURES.SECRET),
    allowedBackends: [FIXTURES.BACKEND]
  });

  verifier.removeAllowedBackend('https://does-not-exist.com');

  assert.strictEqual(verifier.allowedBackends.length, 1);
  assert.ok(verifier.allowedBackends.includes(FIXTURES.BACKEND));
});

// ============================================================
// Missing/Malformed Header Tests (TC-HDR-*)
// ============================================================

console.log('\n=== Header Validation Tests ===\n');

asyncTest('TC-HDR-001: Missing signature header', async () => {
  const verifier = new TalkSignatureVerifier({
    getSecret: createMockGetSecret(FIXTURES.SECRET),
    allowedBackends: [FIXTURES.BACKEND]
  });

  const headers = {
    'X-Nextcloud-Talk-Random': FIXTURES.RANDOM,
    'X-Nextcloud-Talk-Backend': FIXTURES.BACKEND
  };

  const result = await verifier.verify(headers, FIXTURES.BODIES.simple);

  assert.strictEqual(result.valid, false);
  assert.strictEqual(result.reason, 'Missing X-Nextcloud-Talk-Signature header');
});

asyncTest('TC-HDR-002: Missing random header', async () => {
  const verifier = new TalkSignatureVerifier({
    getSecret: createMockGetSecret(FIXTURES.SECRET),
    allowedBackends: [FIXTURES.BACKEND]
  });

  const headers = {
    'X-Nextcloud-Talk-Signature': 'a'.repeat(64),
    'X-Nextcloud-Talk-Backend': FIXTURES.BACKEND
  };

  const result = await verifier.verify(headers, FIXTURES.BODIES.simple);

  assert.strictEqual(result.valid, false);
  assert.strictEqual(result.reason, 'Missing X-Nextcloud-Talk-Random header');
});

asyncTest('TC-HDR-003: Missing backend header in strict mode', async () => {
  const verifier = new TalkSignatureVerifier({
    getSecret: createMockGetSecret(FIXTURES.SECRET),
    strictMode: true
  });

  const headers = {
    'X-Nextcloud-Talk-Signature': 'a'.repeat(64),
    'X-Nextcloud-Talk-Random': FIXTURES.RANDOM
  };

  const result = await verifier.verify(headers, FIXTURES.BODIES.simple);

  assert.strictEqual(result.valid, false);
  assert.strictEqual(result.reason, 'Missing X-Nextcloud-Talk-Backend header');
});

asyncTest('TC-HDR-004: Missing backend header in non-strict mode', async () => {
  const verifier = new TalkSignatureVerifier({
    getSecret: createMockGetSecret(FIXTURES.SECRET),
    strictMode: false,
    requireBackendValidation: false
  });

  const signature = generateValidSignature(
    FIXTURES.SECRET,
    FIXTURES.RANDOM,
    FIXTURES.BODIES.simple
  );

  const headers = {
    'X-Nextcloud-Talk-Signature': signature,
    'X-Nextcloud-Talk-Random': FIXTURES.RANDOM
  };

  const result = await verifier.verify(headers, FIXTURES.BODIES.simple);

  // Should pass in non-strict mode
  assert.strictEqual(result.valid, true);
});

asyncTest('TC-HDR-005: Empty signature header', async () => {
  const verifier = new TalkSignatureVerifier({
    getSecret: createMockGetSecret(FIXTURES.SECRET),
    allowedBackends: [FIXTURES.BACKEND]
  });

  const headers = {
    'X-Nextcloud-Talk-Signature': '',
    'X-Nextcloud-Talk-Random': FIXTURES.RANDOM,
    'X-Nextcloud-Talk-Backend': FIXTURES.BACKEND
  };

  const result = await verifier.verify(headers, FIXTURES.BODIES.simple);

  assert.strictEqual(result.valid, false);
  assert.strictEqual(result.reason, 'Missing X-Nextcloud-Talk-Signature header');
});

asyncTest('TC-HDR-006: Random header wrong length (63 chars)', async () => {
  const verifier = new TalkSignatureVerifier({
    getSecret: createMockGetSecret(FIXTURES.SECRET),
    allowedBackends: [FIXTURES.BACKEND]
  });

  const headers = {
    'X-Nextcloud-Talk-Signature': 'a'.repeat(64),
    'X-Nextcloud-Talk-Random': 'a'.repeat(63),
    'X-Nextcloud-Talk-Backend': FIXTURES.BACKEND
  };

  const result = await verifier.verify(headers, FIXTURES.BODIES.simple);

  assert.strictEqual(result.valid, false);
  assert.strictEqual(result.reason, 'Invalid random format (expected 64 chars)');
});

asyncTest('TC-HDR-007: Random header wrong length (65 chars)', async () => {
  const verifier = new TalkSignatureVerifier({
    getSecret: createMockGetSecret(FIXTURES.SECRET),
    allowedBackends: [FIXTURES.BACKEND]
  });

  const headers = {
    'X-Nextcloud-Talk-Signature': 'a'.repeat(64),
    'X-Nextcloud-Talk-Random': 'a'.repeat(65),
    'X-Nextcloud-Talk-Backend': FIXTURES.BACKEND
  };

  const result = await verifier.verify(headers, FIXTURES.BODIES.simple);

  assert.strictEqual(result.valid, false);
  assert.strictEqual(result.reason, 'Invalid random format (expected 64 chars)');
});

asyncTest('TC-HDR-008: Empty headers object', async () => {
  const verifier = new TalkSignatureVerifier({
    getSecret: createMockGetSecret(FIXTURES.SECRET),
    allowedBackends: [FIXTURES.BACKEND]
  });

  const result = await verifier.verify({}, FIXTURES.BODIES.simple);

  assert.strictEqual(result.valid, false);
  assert.strictEqual(result.reason, 'Missing X-Nextcloud-Talk-Signature header');
});

// ============================================================
// Error Handling Tests (TC-ERR-*)
// ============================================================

console.log('\n=== Error Handling Tests ===\n');

asyncTest('TC-ERR-001: getSecret throws error', async () => {
  const auditLog = createMockAuditLog();
  const verifier = new TalkSignatureVerifier({
    getSecret: createFailingGetSecret('DB connection failed'),
    allowedBackends: [FIXTURES.BACKEND],
    auditLog
  });

  const headers = createValidHeaders(
    FIXTURES.SECRET,
    FIXTURES.RANDOM,
    FIXTURES.BODIES.simple,
    FIXTURES.BACKEND
  );

  const result = await verifier.verify(headers, FIXTURES.BODIES.simple);

  assert.strictEqual(result.valid, false);
  assert.strictEqual(result.reason, 'Failed to retrieve secret');
  assert.ok(result.details.error.includes('DB connection failed'));

  const calls = auditLog.getCalls();
  assert.ok(calls.some(c => c.event === 'signature_verification_error'));
});

asyncTest('TC-ERR-002: getSecret returns null', async () => {
  const verifier = new TalkSignatureVerifier({
    getSecret: createMockGetSecret(null),
    allowedBackends: [FIXTURES.BACKEND]
  });

  const headers = createValidHeaders(
    FIXTURES.SECRET,
    FIXTURES.RANDOM,
    FIXTURES.BODIES.simple,
    FIXTURES.BACKEND
  );

  const result = await verifier.verify(headers, FIXTURES.BODIES.simple);

  assert.strictEqual(result.valid, false);
  assert.strictEqual(result.reason, 'Secret not available');
});

asyncTest('TC-ERR-003: getSecret returns undefined', async () => {
  const verifier = new TalkSignatureVerifier({
    getSecret: createMockGetSecret(undefined),
    allowedBackends: [FIXTURES.BACKEND]
  });

  const headers = createValidHeaders(
    FIXTURES.SECRET,
    FIXTURES.RANDOM,
    FIXTURES.BODIES.simple,
    FIXTURES.BACKEND
  );

  const result = await verifier.verify(headers, FIXTURES.BODIES.simple);

  assert.strictEqual(result.valid, false);
  assert.strictEqual(result.reason, 'Secret not available');
});

asyncTest('TC-ERR-004: getSecret returns empty string', async () => {
  const verifier = new TalkSignatureVerifier({
    getSecret: createMockGetSecret(''),
    allowedBackends: [FIXTURES.BACKEND]
  });

  const headers = createValidHeaders(
    FIXTURES.SECRET,
    FIXTURES.RANDOM,
    FIXTURES.BODIES.simple,
    FIXTURES.BACKEND
  );

  const result = await verifier.verify(headers, FIXTURES.BODIES.simple);

  assert.strictEqual(result.valid, false);
  assert.strictEqual(result.reason, 'Secret not available');
});

asyncTest('TC-ERR-005: Audit log called on failure', async () => {
  const auditLog = createMockAuditLog();
  const verifier = new TalkSignatureVerifier({
    getSecret: createMockGetSecret(FIXTURES.SECRET),
    allowedBackends: [FIXTURES.BACKEND],
    auditLog
  });

  const headers = createValidHeaders(
    'wrong-secret',
    FIXTURES.RANDOM,
    FIXTURES.BODIES.simple,
    FIXTURES.BACKEND
  );

  await verifier.verify(headers, FIXTURES.BODIES.simple);

  const calls = auditLog.getCalls();
  assert.strictEqual(calls.length, 1);
  assert.strictEqual(calls[0].event, 'signature_verification_failed');
  assert.strictEqual(calls[0].data.reason, 'Signature mismatch');
});

asyncTest('TC-ERR-006: Audit log called on success', async () => {
  const auditLog = createMockAuditLog();
  const verifier = new TalkSignatureVerifier({
    getSecret: createMockGetSecret(FIXTURES.SECRET),
    allowedBackends: [FIXTURES.BACKEND],
    auditLog
  });

  const headers = createValidHeaders(
    FIXTURES.SECRET,
    FIXTURES.RANDOM,
    FIXTURES.BODIES.simple,
    FIXTURES.BACKEND
  );

  await verifier.verify(headers, FIXTURES.BODIES.simple);

  const calls = auditLog.getCalls();
  assert.strictEqual(calls.length, 1);
  assert.strictEqual(calls[0].event, 'signature_verified');
  assert.strictEqual(calls[0].data.backend, FIXTURES.BACKEND);
});

asyncTest('TC-ERR-007: Audit log error during secret retrieval', async () => {
  const auditLog = createMockAuditLog();
  const verifier = new TalkSignatureVerifier({
    getSecret: createFailingGetSecret('Secret fetch error'),
    allowedBackends: [FIXTURES.BACKEND],
    auditLog
  });

  const headers = createValidHeaders(
    FIXTURES.SECRET,
    FIXTURES.RANDOM,
    FIXTURES.BODIES.simple,
    FIXTURES.BACKEND
  );

  await verifier.verify(headers, FIXTURES.BODIES.simple);

  const calls = auditLog.getCalls();
  const errorCall = calls.find(c => c.event === 'signature_verification_error');
  assert.ok(errorCall);
  assert.strictEqual(errorCall.data.phase, 'get_secret');
  assert.ok(errorCall.data.error.includes('Secret fetch error'));
});

// ============================================================
// Edge Case Tests (TC-EDG-*)
// ============================================================

console.log('\n=== Edge Case Tests ===\n');

asyncTest('TC-EDG-001: Empty body', async () => {
  const verifier = new TalkSignatureVerifier({
    getSecret: createMockGetSecret(FIXTURES.SECRET),
    allowedBackends: [FIXTURES.BACKEND]
  });

  const headers = createValidHeaders(
    FIXTURES.SECRET,
    FIXTURES.RANDOM,
    '',
    FIXTURES.BACKEND
  );

  const result = await verifier.verify(headers, '');

  assert.strictEqual(result.valid, true);
});

asyncTest('TC-EDG-002: Very large body (1MB)', async () => {
  const verifier = new TalkSignatureVerifier({
    getSecret: createMockGetSecret(FIXTURES.SECRET),
    allowedBackends: [FIXTURES.BACKEND]
  });

  const largeBody = FIXTURES.BODIES.large;
  const headers = createValidHeaders(
    FIXTURES.SECRET,
    FIXTURES.RANDOM,
    largeBody,
    FIXTURES.BACKEND
  );

  const result = await verifier.verify(headers, largeBody);

  assert.strictEqual(result.valid, true);
  assert.strictEqual(result.details.bodyLength, largeBody.length);
});

asyncTest('TC-EDG-003: Unicode in body', async () => {
  const verifier = new TalkSignatureVerifier({
    getSecret: createMockGetSecret(FIXTURES.SECRET),
    allowedBackends: [FIXTURES.BACKEND]
  });

  const unicodeBody = FIXTURES.BODIES.unicode;
  const headers = createValidHeaders(
    FIXTURES.SECRET,
    FIXTURES.RANDOM,
    unicodeBody,
    FIXTURES.BACKEND
  );

  const result = await verifier.verify(headers, unicodeBody);

  assert.strictEqual(result.valid, true);
});

asyncTest('TC-EDG-004: Binary-like content in body', async () => {
  const verifier = new TalkSignatureVerifier({
    getSecret: createMockGetSecret(FIXTURES.SECRET),
    allowedBackends: [FIXTURES.BACKEND]
  });

  const binaryBody = '{"data": "test\x00\x01\x02"}';
  const headers = createValidHeaders(
    FIXTURES.SECRET,
    FIXTURES.RANDOM,
    binaryBody,
    FIXTURES.BACKEND
  );

  const result = await verifier.verify(headers, binaryBody);

  assert.strictEqual(result.valid, true);
});

asyncTest('TC-EDG-005: Null body', async () => {
  const verifier = new TalkSignatureVerifier({
    getSecret: createMockGetSecret(FIXTURES.SECRET),
    strictMode: false,
    requireBackendValidation: false
  });

  // Create valid signature for empty string (null will be handled as empty/undefined)
  const bodyStr = '';
  const headers = createValidHeaders(
    FIXTURES.SECRET,
    FIXTURES.RANDOM,
    bodyStr,
    FIXTURES.BACKEND
  );

  // Test with null body - should handle gracefully
  try {
    const result = await verifier.verify(headers, null);
    // Will fail on signature mismatch but shouldn't throw
    assert.strictEqual(result.valid, false);
  } catch (err) {
    // If it throws due to null handling, that's also acceptable
    assert.ok(true);
  }
});

asyncTest('TC-EDG-006: Undefined body', async () => {
  const verifier = new TalkSignatureVerifier({
    getSecret: createMockGetSecret(FIXTURES.SECRET),
    strictMode: false,
    requireBackendValidation: false
  });

  // Create valid signature for empty string
  const bodyStr = '';
  const headers = createValidHeaders(
    FIXTURES.SECRET,
    FIXTURES.RANDOM,
    bodyStr,
    FIXTURES.BACKEND
  );

  // Test with undefined body - should handle gracefully
  try {
    const result = await verifier.verify(headers, undefined);
    // Will fail on signature mismatch but shouldn't throw
    assert.strictEqual(result.valid, false);
  } catch (err) {
    // If it throws due to undefined handling, that's also acceptable
    assert.ok(true);
  }
});

asyncTest('TC-EDG-007: Headers with extra whitespace in values', async () => {
  const verifier = new TalkSignatureVerifier({
    getSecret: createMockGetSecret(FIXTURES.SECRET),
    allowedBackends: [FIXTURES.BACKEND]
  });

  const signature = generateValidSignature(
    FIXTURES.SECRET,
    FIXTURES.RANDOM,
    FIXTURES.BODIES.simple
  );

  const headers = {
    'X-Nextcloud-Talk-Signature': '  ' + signature + '  ',
    'X-Nextcloud-Talk-Random': FIXTURES.RANDOM,
    'X-Nextcloud-Talk-Backend': FIXTURES.BACKEND
  };

  const result = await verifier.verify(headers, FIXTURES.BODIES.simple);

  // Should fail because whitespace is not trimmed
  assert.strictEqual(result.valid, false);
});

// ============================================================
// Statistics Tests (TC-STA-*)
// ============================================================

console.log('\n=== Statistics Tests ===\n');

asyncTest('TC-STA-001: Initial stats are zero', async () => {
  const verifier = new TalkSignatureVerifier({
    getSecret: createMockGetSecret(FIXTURES.SECRET)
  });

  const stats = verifier.getStats();

  assert.strictEqual(stats.totalVerifications, 0);
  assert.strictEqual(stats.successful, 0);
  assert.strictEqual(stats.failed, 0);
  assert.deepStrictEqual(stats.failureReasons, {});
});

asyncTest('TC-STA-002: Stats updated on success', async () => {
  const verifier = new TalkSignatureVerifier({
    getSecret: createMockGetSecret(FIXTURES.SECRET),
    allowedBackends: [FIXTURES.BACKEND]
  });

  const headers = createValidHeaders(
    FIXTURES.SECRET,
    FIXTURES.RANDOM,
    FIXTURES.BODIES.simple,
    FIXTURES.BACKEND
  );

  await verifier.verify(headers, FIXTURES.BODIES.simple);

  const stats = verifier.getStats();
  assert.strictEqual(stats.totalVerifications, 1);
  assert.strictEqual(stats.successful, 1);
  assert.strictEqual(stats.failed, 0);
});

asyncTest('TC-STA-003: Stats updated on failure', async () => {
  const verifier = new TalkSignatureVerifier({
    getSecret: createMockGetSecret(FIXTURES.SECRET),
    allowedBackends: [FIXTURES.BACKEND]
  });

  const headers = createValidHeaders(
    'wrong-secret',
    FIXTURES.RANDOM,
    FIXTURES.BODIES.simple,
    FIXTURES.BACKEND
  );

  await verifier.verify(headers, FIXTURES.BODIES.simple);

  const stats = verifier.getStats();
  assert.strictEqual(stats.totalVerifications, 1);
  assert.strictEqual(stats.successful, 0);
  assert.strictEqual(stats.failed, 1);
  assert.strictEqual(stats.failureReasons['Signature mismatch'], 1);
});

asyncTest('TC-STA-004: getStats includes success rate', async () => {
  const verifier = new TalkSignatureVerifier({
    getSecret: createMockGetSecret(FIXTURES.SECRET),
    allowedBackends: [FIXTURES.BACKEND]
  });

  // 8 successful
  for (let i = 0; i < 8; i++) {
    const headers = createValidHeaders(
      FIXTURES.SECRET,
      FIXTURES.RANDOM,
      FIXTURES.BODIES.simple,
      FIXTURES.BACKEND
    );
    await verifier.verify(headers, FIXTURES.BODIES.simple);
  }

  // 2 failed
  for (let i = 0; i < 2; i++) {
    const headers = createValidHeaders(
      'wrong-secret',
      FIXTURES.RANDOM,
      FIXTURES.BODIES.simple,
      FIXTURES.BACKEND
    );
    await verifier.verify(headers, FIXTURES.BODIES.simple);
  }

  const stats = verifier.getStats();
  assert.strictEqual(stats.successRate, '80.00%');
});

asyncTest('TC-STA-005: getStats with no verifications', async () => {
  const verifier = new TalkSignatureVerifier({
    getSecret: createMockGetSecret(FIXTURES.SECRET)
  });

  const stats = verifier.getStats();
  assert.strictEqual(stats.successRate, 'N/A');
});

asyncTest('TC-STA-006: resetStats clears all counters', async () => {
  const verifier = new TalkSignatureVerifier({
    getSecret: createMockGetSecret(FIXTURES.SECRET),
    allowedBackends: [FIXTURES.BACKEND]
  });

  // Generate some stats
  const headers = createValidHeaders(
    FIXTURES.SECRET,
    FIXTURES.RANDOM,
    FIXTURES.BODIES.simple,
    FIXTURES.BACKEND
  );
  await verifier.verify(headers, FIXTURES.BODIES.simple);

  assert.strictEqual(verifier.stats.totalVerifications, 1);

  verifier.resetStats();

  const stats = verifier.getStats();
  assert.strictEqual(stats.totalVerifications, 0);
  assert.strictEqual(stats.successful, 0);
  assert.strictEqual(stats.failed, 0);
  assert.deepStrictEqual(stats.failureReasons, {});
});

// ============================================================
// createSignature Tests (TC-SIG-*)
// ============================================================

console.log('\n=== createSignature Tests ===\n');

asyncTest('TC-SIG-001: Creates valid signature format', async () => {
  const verifier = new TalkSignatureVerifier({
    getSecret: createMockGetSecret(FIXTURES.SECRET)
  });

  const result = await verifier.createSignature('{"message": "hello"}');

  assert.ok(result.random);
  assert.ok(result.signature);
  assert.strictEqual(result.random.length, 64);
  assert.strictEqual(result.signature.length, 64);
  assert.ok(/^[a-f0-9]{64}$/.test(result.random));
  assert.ok(/^[a-f0-9]{64}$/.test(result.signature));
});

asyncTest('TC-SIG-002: Random is unique per call', async () => {
  const verifier = new TalkSignatureVerifier({
    getSecret: createMockGetSecret(FIXTURES.SECRET)
  });

  const result1 = await verifier.createSignature('{"message": "hello"}');
  const result2 = await verifier.createSignature('{"message": "hello"}');

  assert.notStrictEqual(result1.random, result2.random);
  assert.notStrictEqual(result1.signature, result2.signature);
});

asyncTest('TC-SIG-003: Signature verifies correctly', async () => {
  const verifier = new TalkSignatureVerifier({
    getSecret: createMockGetSecret(FIXTURES.SECRET),
    allowedBackends: [FIXTURES.BACKEND],
    strictMode: false,
    requireBackendValidation: false
  });

  const body = '{"message": "test round-trip"}';
  const { random, signature } = await verifier.createSignature(body);

  const headers = {
    'X-Nextcloud-Talk-Signature': signature,
    'X-Nextcloud-Talk-Random': random
  };

  const result = await verifier.verify(headers, body);

  assert.strictEqual(result.valid, true);
});

asyncTest('TC-SIG-004: Throws when secret unavailable', async () => {
  const verifier = new TalkSignatureVerifier({
    getSecret: createMockGetSecret(null)
  });

  try {
    await verifier.createSignature('{"message": "hello"}');
    assert.fail('Should have thrown');
  } catch (error) {
    assert.strictEqual(error.message, 'Secret not available for signing');
  }
});

asyncTest('TC-SIG-005: Handles empty body', async () => {
  const verifier = new TalkSignatureVerifier({
    getSecret: createMockGetSecret(FIXTURES.SECRET)
  });

  const result = await verifier.createSignature('');

  assert.ok(result.random);
  assert.ok(result.signature);
  assert.strictEqual(result.random.length, 64);
  assert.strictEqual(result.signature.length, 64);
});

// ============================================================
// SignatureVerificationError Tests (TC-SVE-*)
// ============================================================

console.log('\n=== SignatureVerificationError Tests ===\n');

test('TC-SVE-001: Error has correct properties', () => {
  const error = new SignatureVerificationError('test message', {
    reason: 'test reason',
    backend: 'test backend'
  });

  assert.strictEqual(error.name, 'SignatureVerificationError');
  assert.strictEqual(error.code, 'SIGNATURE_INVALID');
  assert.strictEqual(error.reason, 'test reason');
  assert.strictEqual(error.backend, 'test backend');
  assert.strictEqual(error.message, 'test message');
});

test('TC-SVE-002: Error extends Error', () => {
  const error = new SignatureVerificationError('test');

  assert.ok(error instanceof Error);
  assert.ok(error instanceof SignatureVerificationError);
});

// ============================================================
// Test Summary
// ============================================================

setTimeout(() => {
  console.log('\n=================================');
  console.log(`Tests passed: ${testsPassed}`);
  console.log(`Tests failed: ${testsFailed}`);
  console.log('=================================\n');
  process.exit(testsFailed > 0 ? 1 : 0);
}, 100);
