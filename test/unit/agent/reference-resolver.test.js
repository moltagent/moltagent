'use strict';

const assert = require('assert');
const { test, asyncTest, summary, exitWithCode } = require('../../helpers/test-runner');
const { ReferenceResolver } = require('../../../src/lib/agent/reference-resolver');

const silentLogger = { log() {}, info() {}, warn() {}, error() {} };

function createMockRouter(response) {
  return {
    route: async () => ({ result: response || 'UNCHANGED' })
  };
}

// -- Test 1: Returns unchanged for explicit messages (contains filename) --
asyncTest('returns unchanged for explicit messages with filename', async () => {
  const resolver = new ReferenceResolver({
    router: createMockRouter('should not be called'),
    logger: silentLogger
  });

  const result = await resolver.resolve('Read Moltagent-Session-FileOps-Briefing.md', {
    recentTurns: [{ role: 'user', content: 'list files' }],
    lastAction: { type: 'file_list' }
  });
  assert.strictEqual(result.wasEnriched, false, 'explicit filename should skip resolution');
});

// -- Test 2: Returns unchanged for messages with no reference patterns --
asyncTest('returns unchanged for messages with no references', async () => {
  const resolver = new ReferenceResolver({
    router: createMockRouter('should not be called'),
    logger: silentLogger
  });

  const result = await resolver.resolve('Create a calendar event Friday 3pm Team Standup', {
    recentTurns: [{ role: 'user', content: 'hello' }],
    lastAction: { type: 'deck_list' }
  });
  assert.strictEqual(result.wasEnriched, false, 'no-reference message should skip');
});

// -- Test 3: Returns unchanged when no context available --
asyncTest('returns unchanged when no context available', async () => {
  const resolver = new ReferenceResolver({
    router: createMockRouter('should not be called'),
    logger: silentLogger
  });

  const result = await resolver.resolve('Read the biggest one', {});
  assert.strictEqual(result.wasEnriched, false, 'no context should skip');
});

// -- Test 4: Resolves superlatives using context --
asyncTest('resolves superlative reference via LLM', async () => {
  const resolver = new ReferenceResolver({
    router: createMockRouter('Read file SkillForge-Brief.md (58.2 KB) from Moltagent DEV/docs'),
    logger: silentLogger
  });

  const result = await resolver.resolve('Read the biggest markdown file', {
    recentTurns: [
      { role: 'user', content: 'list files in Moltagent DEV/docs' },
      { role: 'assistant', content: 'briefing.md — 15KB\nSkillForge-Brief.md — 58.2KB\nroadmap.md — 8KB' }
    ],
    lastAction: { type: 'file_list', refs: { path: 'Moltagent DEV/docs' } }
  });
  assert.strictEqual(result.wasEnriched, true, 'superlative should be resolved');
  assert.ok(result.enrichedMessage.includes('SkillForge'), `expected resolved filename, got: ${result.enrichedMessage}`);
});

// -- Test 5: Resolves cross-domain "save that to wiki" --
asyncTest('resolves cross-domain reference via LLM', async () => {
  const resolver = new ReferenceResolver({
    router: createMockRouter('Save a summary of the Knowledge System Specification to the wiki with title Knowledge System Spec Summary'),
    logger: silentLogger
  });

  const result = await resolver.resolve('Save a summary of that to the wiki', {
    recentTurns: [
      { role: 'user', content: 'read the spec file' },
      { role: 'assistant', content: 'This document covers the Knowledge System Specification...' }
    ],
    lastAssistantMessage: 'This document covers the Knowledge System Specification...'
  });
  assert.strictEqual(result.wasEnriched, true, 'cross-domain ref should be resolved');
  assert.ok(result.enrichedMessage.includes('Knowledge System'), `expected resolved content, got: ${result.enrichedMessage}`);
});

// -- Test 6: Resolves pronoun "it" from conversation --
asyncTest('resolves pronoun from recent turns', async () => {
  const resolver = new ReferenceResolver({
    router: createMockRouter('How long is Moltagent-Session8-SkillForge-Brief.md that was just read?'),
    logger: silentLogger
  });

  const result = await resolver.resolve('How long is it?', {
    recentTurns: [
      { role: 'user', content: 'read Moltagent-Session8-SkillForge-Brief.md' },
      { role: 'assistant', content: 'This is a technical briefing about SkillForge...' }
    ]
  });
  assert.strictEqual(result.wasEnriched, true, 'pronoun should be resolved');
  assert.ok(result.enrichedMessage.includes('SkillForge'), `expected resolved pronoun, got: ${result.enrichedMessage}`);
});

// -- Test 7: LLM returns UNCHANGED for no-op messages --
asyncTest('LLM UNCHANGED response returns original', async () => {
  const resolver = new ReferenceResolver({
    router: createMockRouter('UNCHANGED'),
    logger: silentLogger
  });

  const result = await resolver.resolve('What is that?', {
    recentTurns: [{ role: 'user', content: 'hello' }]
  });
  assert.strictEqual(result.wasEnriched, false, 'UNCHANGED should not enrich');
});

// -- Test 8: Graceful on LLM failure --
asyncTest('returns original on LLM failure', async () => {
  const resolver = new ReferenceResolver({
    router: { route: async () => { throw new Error('Model overloaded'); } },
    logger: silentLogger
  });

  const result = await resolver.resolve('Read the biggest one', {
    recentTurns: [{ role: 'user', content: 'list files' }],
    lastAction: { type: 'file_list' }
  });
  assert.strictEqual(result.wasEnriched, false, 'LLM failure should return original');
});

// -- Test 9: Handles null/empty context fields --
asyncTest('handles null and empty context fields', async () => {
  const resolver = new ReferenceResolver({
    router: createMockRouter('UNCHANGED'),
    logger: silentLogger
  });

  // null message
  const r1 = await resolver.resolve(null, {});
  assert.strictEqual(r1.wasEnriched, false);

  // empty string
  const r2 = await resolver.resolve('', {});
  assert.strictEqual(r2.wasEnriched, false);

  // partial context
  const r3 = await resolver.resolve('Read that file', {
    recentTurns: null,
    lastAction: { type: 'file_list' }
  });
  assert.strictEqual(r3.wasEnriched, false, 'UNCHANGED from LLM');
});

// -- Test 10: Router not available -- graceful no-op --
asyncTest('no-op when router is null', async () => {
  const resolver = new ReferenceResolver({ router: null, logger: silentLogger });

  const result = await resolver.resolve('Read the biggest one', {
    recentTurns: [{ role: 'user', content: 'list files' }],
    lastAction: { type: 'file_list' }
  });
  assert.strictEqual(result.wasEnriched, false, 'null router should skip');
});

// -- Test 11: _hasReferences detects all pattern types --
test('_hasReferences detects reference patterns', () => {
  const resolver = new ReferenceResolver({ router: null, logger: silentLogger });

  assert.ok(resolver._hasReferences('Read that file'), 'pronoun "that"');
  assert.ok(resolver._hasReferences('Read the biggest one'), 'superlative');
  assert.ok(resolver._hasReferences('Do it again'), 'repetition');
  assert.ok(resolver._hasReferences('Save it there'), 'action + pronoun');
  assert.ok(resolver._hasReferences('The previous report'), 'temporal');
  assert.ok(!resolver._hasReferences('Create a new file'), 'no references');
  assert.ok(!resolver._hasReferences('Hello'), 'greeting');
});

// -- Test 12: _isExplicit detects explicit messages --
test('_isExplicit detects filenames and paths', () => {
  const resolver = new ReferenceResolver({ router: null, logger: silentLogger });

  assert.ok(resolver._isExplicit('Read Moltagent-FileOps-Briefing.md'), 'filename with .md');
  assert.ok(resolver._isExplicit('Read docs/report.pdf'), 'path with extension');
  assert.ok(resolver._isExplicit('Search for "Knowledge System Specification"'), 'quoted string');
  assert.ok(!resolver._isExplicit('Read the biggest one'), 'vague reference');
  assert.ok(!resolver._isExplicit('Save that to the wiki'), 'cross-domain ref');
});

// -- Test 13: Strips quotes from LLM response --
asyncTest('strips wrapping quotes from LLM response', async () => {
  const resolver = new ReferenceResolver({
    router: createMockRouter('"Read file SkillForge-Brief.md from docs"'),
    logger: silentLogger
  });

  const result = await resolver.resolve('Read the biggest one', {
    recentTurns: [{ role: 'assistant', content: 'SkillForge-Brief.md — 58KB' }],
    lastAction: { type: 'file_list' }
  });
  assert.strictEqual(result.wasEnriched, true);
  assert.ok(!result.enrichedMessage.startsWith('"'), 'should strip leading quote');
  assert.ok(!result.enrichedMessage.endsWith('"'), 'should strip trailing quote');
});

setTimeout(() => { summary(); exitWithCode(); }, 500);
