/**
 * Placeholder primitive tests (#148)
 *
 * Run: node test/unit/shared/placeholder.test.js
 */

const assert = require('assert');
const { test, summary, exitWithCode } = require('../../helpers/test-runner');
const { isPlaceholder, PLACEHOLDER_MARKER } = require('../../../src/lib/shared/placeholder');

console.log('\n=== Placeholder Primitive Tests ===\n');

test('marker is YOUR_', () => {
  assert.strictEqual(PLACEHOLDER_MARKER, 'YOUR_');
});

test('detects YOUR_* values anywhere in the string', () => {
  assert.strictEqual(isPlaceholder('YOUR_NC_ADMIN_USER'), true);
  assert.strictEqual(isPlaceholder('http://YOUR_OLLAMA_IP:11434'), true);
  assert.strictEqual(isPlaceholder('https://YOUR_NEXTCLOUD_URL'), true);
});

test('real values are not placeholders', () => {
  assert.strictEqual(isPlaceholder('alice'), false);
  assert.strictEqual(isPlaceholder('http://10.0.0.5:11434'), false);
  assert.strictEqual(isPlaceholder(''), false);
});

test('non-strings are not placeholders', () => {
  assert.strictEqual(isPlaceholder(null), false);
  assert.strictEqual(isPlaceholder(undefined), false);
  assert.strictEqual(isPlaceholder(42), false);
  assert.strictEqual(isPlaceholder({}), false);
});

// The canonical primitive is shared with resolveOllamaEndpoint, which re-exports
// it as _isPlaceholder — same behaviour, one definition (TAO: signals keep custody).
test('resolve-ollama-endpoint re-exports the same primitive', () => {
  const { _isPlaceholder } = require('../../../src/lib/shared/resolve-ollama-endpoint');
  assert.strictEqual(_isPlaceholder, isPlaceholder);
});

summary();
exitWithCode();
