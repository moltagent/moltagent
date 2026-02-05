# TalkSignatureVerifier Test Suite Design

## Overview

This document specifies a comprehensive test suite for `/opt/moltagent/src/lib/talk-signature-verifier.js`,
a security-critical component that verifies HMAC-SHA256 signatures for Nextcloud Talk webhooks.

**Component Purpose:** Verify that incoming webhook requests from Nextcloud Talk are authentic
by validating HMAC-SHA256 signatures computed over a random nonce and request body.

**Security Criticality:** HIGH - This component is the primary defense against forged webhook
requests. Failures could allow attackers to inject arbitrary commands or data into the system.

---

## 1. Testable Functions and Methods

### 1.1 Public Methods

| Method | Signature | Description |
|--------|-----------|-------------|
| `constructor` | `(config: Object) => TalkSignatureVerifier` | Initializes verifier with configuration |
| `verify` | `(headers: Object, body: string\|Buffer) => Promise<VerificationResult>` | Main signature verification |
| `createSignature` | `(body: string) => Promise<{random: string, signature: string}>` | Create signature for outgoing messages |
| `addAllowedBackend` | `(backend: string) => void` | Add backend URL to allowlist |
| `removeAllowedBackend` | `(backend: string) => void` | Remove backend URL from allowlist |
| `getStats` | `() => Object` | Get verification statistics |
| `resetStats` | `() => void` | Reset statistics counters |

### 1.2 Private Methods (Tested Indirectly via Public Interface)

| Method | Purpose |
|--------|---------|
| `_validateHeaders` | Check required headers are present |
| `_validateFormats` | Validate signature and random format |
| `_validateBackend` | Check backend against allowlist |
| `_timingSafeCompare` | Constant-time string comparison |
| `_recordFailure` | Record and return failure result |

### 1.3 Exported Classes

| Class | Purpose |
|-------|---------|
| `TalkSignatureVerifier` | Main verifier class |
| `SignatureVerificationError` | Custom error type for verification failures |

---

## 2. Test Case Specifications

### 2.1 Constructor Tests

#### TC-CON-001: Requires getSecret function
- **Category:** Unit
- **Input:** `new TalkSignatureVerifier({})`
- **Expected:** Throws `Error('TalkSignatureVerifier requires a getSecret function')`
- **Priority:** High

#### TC-CON-002: Rejects non-function getSecret
- **Category:** Unit
- **Input:** `new TalkSignatureVerifier({ getSecret: 'not a function' })`
- **Expected:** Throws `Error('TalkSignatureVerifier requires a getSecret function')`
- **Priority:** High

#### TC-CON-003: Accepts valid minimal config
- **Category:** Unit
- **Input:** `new TalkSignatureVerifier({ getSecret: async () => 'secret' })`
- **Expected:** Returns TalkSignatureVerifier instance with default values
- **Priority:** High

#### TC-CON-004: Accepts full configuration
- **Category:** Unit
- **Input:**
```javascript
{
  getSecret: async () => 'secret',
  allowedBackends: ['https://cloud.example.com'],
  auditLog: async (event, data) => {},
  strictMode: true,
  requireBackendValidation: true
}
```
- **Expected:** Instance with all config values properly set
- **Priority:** Medium

#### TC-CON-005: Default values applied correctly
- **Category:** Unit
- **Input:** `new TalkSignatureVerifier({ getSecret: async () => 'secret' })`
- **Expected:**
  - `allowedBackends` = []
  - `strictMode` = true
  - `requireBackendValidation` = true
  - `stats` initialized with zeros
- **Priority:** Medium

---

### 2.2 Valid Signature Verification Tests

#### TC-VER-001: Valid signature with correct headers
- **Category:** Unit
- **Input:**
```javascript
const secret = 'shared-secret-key';
const random = 'a'.repeat(64);
const body = '{"type":"message","content":"hello"}';
const signature = crypto.createHmac('sha256', secret).update(random + body).digest('hex');
headers = {
  'X-Nextcloud-Talk-Signature': signature,
  'X-Nextcloud-Talk-Random': random,
  'X-Nextcloud-Talk-Backend': 'https://cloud.example.com'
}
```
- **Expected:** `{ valid: true, backend: 'https://cloud.example.com', details: {...} }`
- **Priority:** Critical

#### TC-VER-002: Valid signature with Buffer body
- **Category:** Unit
- **Input:** Same as TC-VER-001 but body as `Buffer.from('{"type":"message"}')`
- **Expected:** `{ valid: true, ... }`
- **Priority:** High

#### TC-VER-003: Valid signature with uppercase hex
- **Category:** Unit
- **Input:** Signature with uppercase hex characters (e.g., `'ABCDEF...'`)
- **Expected:** `{ valid: true, ... }` (case-insensitive comparison)
- **Priority:** High

#### TC-VER-004: Valid signature with mixed case headers
- **Category:** Unit
- **Input:** Headers with various cases: `'x-NEXTCLOUD-talk-SIGNATURE'`
- **Expected:** `{ valid: true, ... }` (header normalization works)
- **Priority:** Medium

#### TC-VER-005: Valid signature increments success stats
- **Category:** Unit
- **Input:** Valid signature request
- **Expected:** `stats.successful` incremented, `stats.totalVerifications` incremented
- **Priority:** Medium

---

### 2.3 Invalid/Tampered Signature Tests

#### TC-INV-001: Wrong signature for body
- **Category:** Security
- **Input:** Valid format signature but computed with different body
- **Expected:** `{ valid: false, reason: 'Signature mismatch', ... }`
- **Priority:** Critical

#### TC-INV-002: Wrong signature for random
- **Category:** Security
- **Input:** Valid format signature but computed with different random nonce
- **Expected:** `{ valid: false, reason: 'Signature mismatch', ... }`
- **Priority:** Critical

#### TC-INV-003: Wrong secret used
- **Category:** Security
- **Input:** Signature computed with different secret than verifier has
- **Expected:** `{ valid: false, reason: 'Signature mismatch', ... }`
- **Priority:** Critical

#### TC-INV-004: Truncated signature
- **Category:** Security
- **Input:** Signature with only 32 hex characters (half)
- **Expected:** `{ valid: false, reason: 'Invalid signature format (expected 64 hex chars)', ... }`
- **Priority:** High

#### TC-INV-005: Extended signature
- **Category:** Security
- **Input:** Signature with 128 hex characters (double)
- **Expected:** `{ valid: false, reason: 'Invalid signature format (expected 64 hex chars)', ... }`
- **Priority:** High

#### TC-INV-006: Non-hex signature characters
- **Category:** Security
- **Input:** Signature containing 'g', 'z', or special chars
- **Expected:** `{ valid: false, reason: 'Invalid signature format (expected 64 hex chars)', ... }`
- **Priority:** High

#### TC-INV-007: Tampered body increments failure stats
- **Category:** Unit
- **Input:** Invalid signature request
- **Expected:** `stats.failed` incremented, `stats.failureReasons['Signature mismatch']` incremented
- **Priority:** Medium

---

### 2.4 Timing-Safe Comparison Tests

#### TC-TIM-001: Different length strings handled safely
- **Category:** Security
- **Input:** Expected signature length 64, actual length 63
- **Expected:** Returns false, does dummy comparison to maintain constant time
- **Priority:** Critical

#### TC-TIM-002: Equal length different content
- **Category:** Security
- **Input:** Two 64-char strings differing in first character
- **Expected:** Returns false via crypto.timingSafeEqual
- **Priority:** Critical

#### TC-TIM-003: Equal length different at end
- **Category:** Security
- **Input:** Two 64-char strings differing only in last character
- **Expected:** Returns false (constant time regardless of position)
- **Priority:** Critical

#### TC-TIM-004: Handles Buffer conversion errors
- **Category:** Edge-Case
- **Input:** Strings that might fail Buffer conversion
- **Expected:** Returns false, no exception thrown
- **Priority:** Medium

---

### 2.5 Backend Allowlist Tests

#### TC-BAK-001: Backend in allowlist passes
- **Category:** Unit
- **Input:** Backend `'https://cloud.example.com'`, allowlist `['https://cloud.example.com']`
- **Expected:** Verification continues, does not fail on backend check
- **Priority:** High

#### TC-BAK-002: Backend not in allowlist fails
- **Category:** Security
- **Input:** Backend `'https://evil.com'`, allowlist `['https://cloud.example.com']`
- **Expected:** `{ valid: false, reason: 'Backend not in allowlist', ... }`
- **Priority:** Critical

#### TC-BAK-003: URL normalization - trailing slash
- **Category:** Unit
- **Input:** Backend `'https://cloud.example.com/'`, allowlist `['https://cloud.example.com']`
- **Expected:** Match succeeds (trailing slash normalized)
- **Priority:** High

#### TC-BAK-004: URL normalization - case insensitivity
- **Category:** Unit
- **Input:** Backend `'https://CLOUD.example.com'`, allowlist `['https://cloud.example.com']`
- **Expected:** Match succeeds (case normalized)
- **Priority:** High

#### TC-BAK-005: Empty allowlist with requireBackendValidation=true
- **Category:** Unit
- **Input:** Empty allowlist, `requireBackendValidation: true`
- **Expected:** Backend validation skipped (no allowed backends defined)
- **Priority:** Medium

#### TC-BAK-006: Backend validation disabled
- **Category:** Unit
- **Input:** `requireBackendValidation: false`, backend not in list
- **Expected:** Verification continues without backend check
- **Priority:** Medium

#### TC-BAK-007: Add backend dynamically
- **Category:** Unit
- **Input:** Call `addAllowedBackend('https://new.example.com')`
- **Expected:** New backend appears in `allowedBackends` array
- **Priority:** Medium

#### TC-BAK-008: Remove backend dynamically
- **Category:** Unit
- **Input:** Call `removeAllowedBackend('https://cloud.example.com')`
- **Expected:** Backend removed from `allowedBackends` array
- **Priority:** Medium

#### TC-BAK-009: Add duplicate backend is idempotent
- **Category:** Unit
- **Input:** Call `addAllowedBackend` twice with same URL
- **Expected:** Backend appears only once in array
- **Priority:** Low

#### TC-BAK-010: Remove non-existent backend is safe
- **Category:** Unit
- **Input:** Call `removeAllowedBackend` with URL not in list
- **Expected:** No error, array unchanged
- **Priority:** Low

---

### 2.6 Missing/Malformed Header Tests

#### TC-HDR-001: Missing signature header
- **Category:** Edge-Case
- **Input:** Headers without `X-Nextcloud-Talk-Signature`
- **Expected:** `{ valid: false, reason: 'Missing X-Nextcloud-Talk-Signature header', ... }`
- **Priority:** High

#### TC-HDR-002: Missing random header
- **Category:** Edge-Case
- **Input:** Headers without `X-Nextcloud-Talk-Random`
- **Expected:** `{ valid: false, reason: 'Missing X-Nextcloud-Talk-Random header', ... }`
- **Priority:** High

#### TC-HDR-003: Missing backend header in strict mode
- **Category:** Edge-Case
- **Input:** Headers without `X-Nextcloud-Talk-Backend`, `strictMode: true`
- **Expected:** `{ valid: false, reason: 'Missing X-Nextcloud-Talk-Backend header', ... }`
- **Priority:** High

#### TC-HDR-004: Missing backend header in non-strict mode
- **Category:** Edge-Case
- **Input:** Headers without `X-Nextcloud-Talk-Backend`, `strictMode: false`
- **Expected:** Verification continues (backend not required)
- **Priority:** Medium

#### TC-HDR-005: Empty signature header
- **Category:** Edge-Case
- **Input:** `'X-Nextcloud-Talk-Signature': ''`
- **Expected:** `{ valid: false, reason: 'Missing X-Nextcloud-Talk-Signature header', ... }`
- **Priority:** Medium

#### TC-HDR-006: Random header wrong length (63 chars)
- **Category:** Edge-Case
- **Input:** Random header with 63 characters
- **Expected:** `{ valid: false, reason: 'Invalid random format (expected 64 chars)', ... }`
- **Priority:** High

#### TC-HDR-007: Random header wrong length (65 chars)
- **Category:** Edge-Case
- **Input:** Random header with 65 characters
- **Expected:** `{ valid: false, reason: 'Invalid random format (expected 64 chars)', ... }`
- **Priority:** High

#### TC-HDR-008: Empty headers object
- **Category:** Edge-Case
- **Input:** `headers = {}`
- **Expected:** `{ valid: false, reason: 'Missing X-Nextcloud-Talk-Signature header', ... }`
- **Priority:** Medium

---

### 2.7 Error Handling Tests

#### TC-ERR-001: getSecret throws error
- **Category:** Edge-Case
- **Input:** `getSecret: async () => { throw new Error('DB connection failed'); }`
- **Expected:** `{ valid: false, reason: 'Failed to retrieve secret', details: { error: 'DB connection failed' } }`
- **Priority:** High

#### TC-ERR-002: getSecret returns null
- **Category:** Edge-Case
- **Input:** `getSecret: async () => null`
- **Expected:** `{ valid: false, reason: 'Secret not available', ... }`
- **Priority:** High

#### TC-ERR-003: getSecret returns undefined
- **Category:** Edge-Case
- **Input:** `getSecret: async () => undefined`
- **Expected:** `{ valid: false, reason: 'Secret not available', ... }`
- **Priority:** High

#### TC-ERR-004: getSecret returns empty string
- **Category:** Edge-Case
- **Input:** `getSecret: async () => ''`
- **Expected:** `{ valid: false, reason: 'Secret not available', ... }`
- **Priority:** Medium

#### TC-ERR-005: Audit log called on failure
- **Category:** Unit
- **Input:** Invalid signature with custom auditLog function
- **Expected:** auditLog called with 'signature_verification_failed' event
- **Priority:** Medium

#### TC-ERR-006: Audit log called on success
- **Category:** Unit
- **Input:** Valid signature with custom auditLog function
- **Expected:** auditLog called with 'signature_verified' event
- **Priority:** Medium

#### TC-ERR-007: Audit log error during secret retrieval
- **Category:** Unit
- **Input:** getSecret throws, verify auditLog called with 'signature_verification_error'
- **Expected:** auditLog called with error details and phase='get_secret'
- **Priority:** Medium

---

### 2.8 Edge Case Tests

#### TC-EDG-001: Empty body
- **Category:** Edge-Case
- **Input:** `body = ''` with matching signature
- **Expected:** `{ valid: true, ... }` (empty body is valid)
- **Priority:** Medium

#### TC-EDG-002: Very large body (1MB)
- **Category:** Edge-Case
- **Input:** 1MB body with correct signature
- **Expected:** `{ valid: true, ... }` (handles large payloads)
- **Priority:** Medium

#### TC-EDG-003: Unicode in body
- **Category:** Edge-Case
- **Input:** Body with emoji and unicode: `'{"msg": "Hello World! \u{1F600}"}'`
- **Expected:** Signature computed correctly with UTF-8 encoding
- **Priority:** High

#### TC-EDG-004: Binary-like content in body
- **Category:** Edge-Case
- **Input:** Body with null bytes or control characters
- **Expected:** Signature computed correctly
- **Priority:** Medium

#### TC-EDG-005: Null body
- **Category:** Edge-Case
- **Input:** `body = null`
- **Expected:** Graceful handling or clear error
- **Priority:** Medium

#### TC-EDG-006: Undefined body
- **Category:** Edge-Case
- **Input:** `body = undefined`
- **Expected:** Graceful handling or clear error
- **Priority:** Medium

#### TC-EDG-007: Headers with extra whitespace in values
- **Category:** Edge-Case
- **Input:** `'X-Nextcloud-Talk-Signature': '  abc123...  '`
- **Expected:** Validation fails on format (whitespace not stripped)
- **Priority:** Low

---

### 2.9 Statistics Tests

#### TC-STA-001: Initial stats are zero
- **Category:** Unit
- **Input:** New verifier instance
- **Expected:** `{ totalVerifications: 0, successful: 0, failed: 0, failureReasons: {} }`
- **Priority:** Medium

#### TC-STA-002: Stats updated on success
- **Category:** Unit
- **Input:** Valid verification
- **Expected:** `totalVerifications++`, `successful++`
- **Priority:** Medium

#### TC-STA-003: Stats updated on failure
- **Category:** Unit
- **Input:** Invalid verification
- **Expected:** `totalVerifications++`, `failed++`, `failureReasons[reason]++`
- **Priority:** Medium

#### TC-STA-004: getStats includes success rate
- **Category:** Unit
- **Input:** After 10 verifications (8 success, 2 fail)
- **Expected:** `successRate: '80.00%'`
- **Priority:** Low

#### TC-STA-005: getStats with no verifications
- **Category:** Unit
- **Input:** New instance, call getStats
- **Expected:** `successRate: 'N/A'`
- **Priority:** Low

#### TC-STA-006: resetStats clears all counters
- **Category:** Unit
- **Input:** After verifications, call resetStats()
- **Expected:** All counters back to initial state
- **Priority:** Low

---

### 2.10 createSignature Tests

#### TC-SIG-001: Creates valid signature format
- **Category:** Unit
- **Input:** `createSignature('{"message": "hello"}')`
- **Expected:** Returns `{ random: <64 hex chars>, signature: <64 hex chars> }`
- **Priority:** High

#### TC-SIG-002: Random is unique per call
- **Category:** Unit
- **Input:** Two consecutive calls to createSignature
- **Expected:** Different random values returned
- **Priority:** High

#### TC-SIG-003: Signature verifies correctly
- **Category:** Unit
- **Input:** Create signature, then verify with same secret
- **Expected:** Round-trip verification succeeds
- **Priority:** Critical

#### TC-SIG-004: Throws when secret unavailable
- **Category:** Edge-Case
- **Input:** `getSecret: async () => null`, call createSignature
- **Expected:** Throws `Error('Secret not available for signing')`
- **Priority:** High

#### TC-SIG-005: Handles empty body
- **Category:** Edge-Case
- **Input:** `createSignature('')`
- **Expected:** Returns valid signature structure
- **Priority:** Medium

---

### 2.11 SignatureVerificationError Tests

#### TC-SVE-001: Error has correct properties
- **Category:** Unit
- **Input:** `new SignatureVerificationError('test', { reason: 'r', backend: 'b' })`
- **Expected:**
  - `name = 'SignatureVerificationError'`
  - `code = 'SIGNATURE_INVALID'`
  - `reason = 'r'`
  - `backend = 'b'`
- **Priority:** Low

#### TC-SVE-002: Error extends Error
- **Category:** Unit
- **Input:** `new SignatureVerificationError('test')`
- **Expected:** `instanceof Error === true`
- **Priority:** Low

---

## 3. Mock and Fixture Requirements

### 3.1 Mock Functions

```javascript
/**
 * Mock getSecret function for testing
 * @param {string} secretValue - The secret to return
 * @param {number} [delay=0] - Optional delay in ms
 */
function createMockGetSecret(secretValue, delay = 0) {
  return async () => {
    if (delay > 0) await new Promise(r => setTimeout(r, delay));
    return secretValue;
  };
}

/**
 * Mock getSecret that throws
 * @param {string} errorMessage - Error message
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
```

### 3.2 Fixture Data

```javascript
const FIXTURES = {
  // Standard test secret
  SECRET: 'test-shared-secret-key-12345',

  // Standard 64-char random nonce
  RANDOM: 'a1b2c3d4e5f6g7h8i9j0k1l2m3n4o5p6q7r8s9t0u1v2w3x4y5z6a7b8c9d0e1f2',

  // Standard backend URL
  BACKEND: 'https://cloud.example.com',

  // Sample webhook bodies
  BODIES: {
    simple: '{"type":"message","content":"hello"}',
    unicode: '{"type":"message","content":"Hello \u{1F600}"}',
    empty: '',
    large: '{"data":"' + 'x'.repeat(1000000) + '"}',
  },

  // Pre-computed valid signatures (for specific secret+random+body combos)
  // These should be computed during test setup, not hardcoded
};

/**
 * Generate a valid signature for testing
 */
function generateValidSignature(secret, random, body) {
  const crypto = require('crypto');
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
```

### 3.3 Timing Attack Test Helpers

```javascript
/**
 * Measure execution time with high precision
 * For timing attack tests
 */
async function measureExecutionTime(fn, iterations = 1000) {
  const times = [];
  for (let i = 0; i < iterations; i++) {
    const start = process.hrtime.bigint();
    await fn();
    const end = process.hrtime.bigint();
    times.push(Number(end - start));
  }
  return {
    mean: times.reduce((a, b) => a + b, 0) / times.length,
    median: times.sort((a, b) => a - b)[Math.floor(times.length / 2)],
    min: Math.min(...times),
    max: Math.max(...times),
    stdDev: Math.sqrt(
      times.reduce((acc, t) => acc + Math.pow(t - (times.reduce((a, b) => a + b, 0) / times.length), 2), 0) / times.length
    )
  };
}
```

---

## 4. Recommended Test File Structure

```
test/
  unit/
    talk-signature-verifier.test.js        # Main test file
    talk-signature-verifier.test.design.md # This design document
  fixtures/
    talk-signature-fixtures.js             # Shared test fixtures
  helpers/
    test-helpers.js                        # Shared test utilities (test, asyncTest)
    crypto-test-helpers.js                 # Crypto-specific test helpers
```

### 4.1 Main Test File Structure

```javascript
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

// TODO: Implement - Copy test/asyncTest helpers from existing tests

// ============================================================
// Fixtures & Mocks
// ============================================================

// TODO: Implement - Mock functions as specified in section 3.1

// ============================================================
// Constructor Tests (TC-CON-*)
// ============================================================

console.log('\n=== Constructor Tests ===\n');

// TODO: Implement - TC-CON-001 through TC-CON-005

// ============================================================
// Valid Signature Tests (TC-VER-*)
// ============================================================

console.log('\n=== Valid Signature Tests ===\n');

// TODO: Implement - TC-VER-001 through TC-VER-005

// ============================================================
// Invalid/Tampered Signature Tests (TC-INV-*)
// ============================================================

console.log('\n=== Invalid Signature Tests ===\n');

// TODO: Implement - TC-INV-001 through TC-INV-007

// ============================================================
// Timing-Safe Comparison Tests (TC-TIM-*)
// ============================================================

console.log('\n=== Timing-Safe Comparison Tests ===\n');

// TODO: Implement - TC-TIM-001 through TC-TIM-004

// ============================================================
// Backend Allowlist Tests (TC-BAK-*)
// ============================================================

console.log('\n=== Backend Allowlist Tests ===\n');

// TODO: Implement - TC-BAK-001 through TC-BAK-010

// ============================================================
// Missing/Malformed Header Tests (TC-HDR-*)
// ============================================================

console.log('\n=== Header Validation Tests ===\n');

// TODO: Implement - TC-HDR-001 through TC-HDR-008

// ============================================================
// Error Handling Tests (TC-ERR-*)
// ============================================================

console.log('\n=== Error Handling Tests ===\n');

// TODO: Implement - TC-ERR-001 through TC-ERR-007

// ============================================================
// Edge Case Tests (TC-EDG-*)
// ============================================================

console.log('\n=== Edge Case Tests ===\n');

// TODO: Implement - TC-EDG-001 through TC-EDG-007

// ============================================================
// Statistics Tests (TC-STA-*)
// ============================================================

console.log('\n=== Statistics Tests ===\n');

// TODO: Implement - TC-STA-001 through TC-STA-006

// ============================================================
// createSignature Tests (TC-SIG-*)
// ============================================================

console.log('\n=== createSignature Tests ===\n');

// TODO: Implement - TC-SIG-001 through TC-SIG-005

// ============================================================
// SignatureVerificationError Tests (TC-SVE-*)
// ============================================================

console.log('\n=== SignatureVerificationError Tests ===\n');

// TODO: Implement - TC-SVE-001 through TC-SVE-002

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
```

---

## 5. Dependency Map

### 5.1 File Dependencies

```
talk-signature-verifier.js
  <- depends on: crypto (Node.js built-in)

talk-signature-verifier.test.js
  <- depends on: assert (Node.js built-in)
  <- depends on: crypto (Node.js built-in)
  <- depends on: talk-signature-verifier.js
  <- depends on: talk-signature-fixtures.js (optional)

talk-signature-fixtures.js
  <- depends on: crypto (Node.js built-in)
```

### 5.2 Implementation Order

1. **test/helpers/test-helpers.js** (if extracting shared helpers)
   - Basic test framework functions

2. **test/fixtures/talk-signature-fixtures.js**
   - Mock functions
   - Fixture data
   - Crypto helpers

3. **test/unit/talk-signature-verifier.test.js**
   - All test cases in order listed above

---

## 6. Test Categories Summary

| Category | Count | Priority |
|----------|-------|----------|
| Unit | 35 | Standard |
| Security | 9 | Critical |
| Edge-Case | 15 | High |

**Total Test Cases:** 59

---

## 7. Security Testing Notes

### 7.1 Timing Attack Considerations

The `_timingSafeCompare` method is critical for preventing timing attacks.
While full timing attack testing requires specialized statistical analysis,
the following should be verified:

1. Method uses `crypto.timingSafeEqual` for actual comparison
2. Different-length strings still perform constant-time work
3. No early returns that could leak information

### 7.2 Test Data Security

- Never commit real secrets to test files
- Use obviously fake secrets like `'test-shared-secret-key-12345'`
- Ensure test fixtures are clearly marked as test data

### 7.3 Signature Validation Strictness

Verify that the implementation:

1. Rejects signatures that are too short or too long
2. Rejects non-hex characters in signatures
3. Rejects incorrect random nonce lengths
4. Properly validates backend URLs when configured

---

## 8. Revision History

| Version | Date | Author | Changes |
|---------|------|--------|---------|
| 1.0.0 | 2026-02-05 | Architect | Initial test design |

---

## Appendix A: Quick Reference - Expected Failure Reasons

| Reason String | When Returned |
|---------------|---------------|
| `'Missing X-Nextcloud-Talk-Signature header'` | Signature header absent or empty |
| `'Missing X-Nextcloud-Talk-Random header'` | Random header absent or empty |
| `'Missing X-Nextcloud-Talk-Backend header'` | Backend header absent (strict mode) |
| `'Invalid signature format (expected 64 hex chars)'` | Signature wrong length or non-hex |
| `'Invalid random format (expected 64 chars)'` | Random wrong length |
| `'Backend not in allowlist'` | Backend URL not in allowed list |
| `'Secret not available'` | getSecret returned null/undefined/empty |
| `'Failed to retrieve secret'` | getSecret threw an error |
| `'Signature mismatch'` | HMAC comparison failed |
