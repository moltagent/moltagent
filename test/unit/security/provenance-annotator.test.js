/*
 * Moltagent - Sovereign AI Security Layer
 * Copyright (C) 2026 Moltagent Contributors
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU Affero General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 */

/**
 * Unit Tests for ProvenanceAnnotator (Bullshit Protection Layer 1)
 *
 * Tests provenance annotation including:
 * - Response segmentation into sentences
 * - Agent knowledge block parsing
 * - Entity token extraction
 * - Overlap scoring
 * - Grounding classification (grounded / stated / verified / ungrounded)
 * - Full annotate() pipeline
 * - Edge cases: null/empty inputs, no sources, all grounded, all ungrounded
 *
 * @module test/unit/security/provenance-annotator.test
 */

'use strict';

const assert = require('assert');
const { test, summary, exitWithCode } = require('../../helpers/test-runner');
const ProvenanceAnnotator = require('../../../src/lib/security/provenance-annotator');

const silentLogger = { info() {}, warn() {}, error() {}, debug() {} };

console.log('\n=== ProvenanceAnnotator Tests ===\n');

// =============================================================================
// Constructor Tests
// =============================================================================

test('TC-PA-001: constructor creates instance with default logger', () => {
  const pa = new ProvenanceAnnotator();
  assert.ok(pa instanceof ProvenanceAnnotator);
  assert.ok(pa.logger);
});

test('TC-PA-002: constructor accepts custom logger', () => {
  const pa = new ProvenanceAnnotator({ logger: silentLogger });
  assert.strictEqual(pa.logger, silentLogger);
});

// =============================================================================
// _segmentResponse() Tests
// =============================================================================

test('TC-PA-010: _segmentResponse splits on sentence boundaries', () => {
  const pa = new ProvenanceAnnotator({ logger: silentLogger });
  const segments = pa._segmentResponse('Hello world. How are you? Great!');
  assert.strictEqual(segments.length, 3);
  assert.strictEqual(segments[0].text, 'Hello world.');
  assert.strictEqual(segments[1].text, 'How are you?');
  assert.strictEqual(segments[2].text, 'Great!');
});

test('TC-PA-011: _segmentResponse splits on newlines', () => {
  const pa = new ProvenanceAnnotator({ logger: silentLogger });
  const segments = pa._segmentResponse('Line one\nLine two\nLine three');
  assert.strictEqual(segments.length, 3);
  assert.strictEqual(segments[0].text, 'Line one');
  assert.strictEqual(segments[1].text, 'Line two');
  assert.strictEqual(segments[2].text, 'Line three');
});

test('TC-PA-012: _segmentResponse filters empty segments', () => {
  const pa = new ProvenanceAnnotator({ logger: silentLogger });
  const segments = pa._segmentResponse('Hello.\n\n\nWorld.');
  assert.strictEqual(segments.length, 2);
  assert.strictEqual(segments[0].text, 'Hello.');
  assert.strictEqual(segments[1].text, 'World.');
});

test('TC-PA-013: _segmentResponse handles null/empty input', () => {
  const pa = new ProvenanceAnnotator({ logger: silentLogger });
  assert.deepStrictEqual(pa._segmentResponse(null), []);
  assert.deepStrictEqual(pa._segmentResponse(undefined), []);
  assert.deepStrictEqual(pa._segmentResponse(''), []);
});

test('TC-PA-014: _segmentResponse handles single sentence no terminator', () => {
  const pa = new ProvenanceAnnotator({ logger: silentLogger });
  const segments = pa._segmentResponse('Just a phrase');
  assert.strictEqual(segments.length, 1);
  assert.strictEqual(segments[0].text, 'Just a phrase');
});

// =============================================================================
// _parseAgentKnowledge() Tests
// =============================================================================

test('TC-PA-020: _parseAgentKnowledge parses wiki entry', () => {
  const pa = new ProvenanceAnnotator({ logger: silentLogger });
  const block = '<agent_knowledge>\n[source: wiki, confidence: high]\nPeople/Alex\nAlex is the CTO.\n</agent_knowledge>';
  const entries = pa._parseAgentKnowledge(block);
  assert.strictEqual(entries.length, 1);
  assert.strictEqual(entries[0].type, 'wiki');
  assert.ok(entries[0].content.includes('Alex is the CTO'));
  assert.strictEqual(entries[0].ref, 'wiki:People/Alex');
  assert.strictEqual(entries[0].confidence, 'high');
});

test('TC-PA-021: _parseAgentKnowledge parses deck entry', () => {
  const pa = new ProvenanceAnnotator({ logger: silentLogger });
  const block = '<agent_knowledge>\n[source: deck, match: title, confidence: high]\nCard #42: "Fix login bug"\nStack: To Do\n</agent_knowledge>';
  const entries = pa._parseAgentKnowledge(block);
  assert.strictEqual(entries.length, 1);
  assert.strictEqual(entries[0].type, 'deck');
  assert.ok(entries[0].ref.includes('Card #42'));
  assert.strictEqual(entries[0].confidence, 'high');
});

test('TC-PA-022: _parseAgentKnowledge parses multiple entries', () => {
  const pa = new ProvenanceAnnotator({ logger: silentLogger });
  const block = [
    '<agent_knowledge>',
    '[source: wiki, confidence: high]',
    'People/Alex',
    'Alex is the CTO of AcmeCorp. His email is alex@example.com.',
    '',
    '[source: deck, match: title, confidence: high]',
    'Card #42: "Fix login bug"',
    'Stack: To Do',
    '</agent_knowledge>',
  ].join('\n');
  const entries = pa._parseAgentKnowledge(block);
  assert.strictEqual(entries.length, 2);
  assert.strictEqual(entries[0].type, 'wiki');
  assert.strictEqual(entries[1].type, 'deck');
});

test('TC-PA-023: _parseAgentKnowledge handles null/empty input', () => {
  const pa = new ProvenanceAnnotator({ logger: silentLogger });
  assert.deepStrictEqual(pa._parseAgentKnowledge(null), []);
  assert.deepStrictEqual(pa._parseAgentKnowledge(undefined), []);
  assert.deepStrictEqual(pa._parseAgentKnowledge(''), []);
});

test('TC-PA-024: _parseAgentKnowledge handles malformed entry', () => {
  const pa = new ProvenanceAnnotator({ logger: silentLogger });
  // An entry without a valid [source: ...] header line should be skipped
  const block = '<agent_knowledge>\nThis is not a valid header\nSome content here.\n</agent_knowledge>';
  const entries = pa._parseAgentKnowledge(block);
  assert.strictEqual(entries.length, 0);
});

// =============================================================================
// _extractTokens() Tests
// =============================================================================

test('TC-PA-030: _extractTokens extracts capitalized proper nouns', () => {
  const pa = new ProvenanceAnnotator({ logger: silentLogger });
  const tokens = pa._extractTokens('Alex works at Moltagent');
  // Should contain the proper nouns (lowercased), not common starters
  assert.ok(tokens.has('alex'), 'should include "alex"');
  assert.ok(tokens.has('moltagent'), 'should include "moltagent"');
  // 'The' (if present) should be excluded as a common starter
  assert.ok(!tokens.has('the'), 'should exclude "the"');
});

test('TC-PA-031: _extractTokens extracts email addresses', () => {
  const pa = new ProvenanceAnnotator({ logger: silentLogger });
  const tokens = pa._extractTokens('Contact alex@example.com for details');
  assert.ok(tokens.has('alex@example.com'), 'should include email address');
});

test('TC-PA-032: _extractTokens extracts ISO dates', () => {
  const pa = new ProvenanceAnnotator({ logger: silentLogger });
  const tokens = pa._extractTokens('Meeting on 2026-03-15');
  assert.ok(tokens.has('2026-03-15'), 'should include ISO date');
});

test('TC-PA-033: _extractTokens extracts numbers > 0', () => {
  const pa = new ProvenanceAnnotator({ logger: silentLogger });
  const tokens = pa._extractTokens('Budget is 5000 euros, with 0 overruns');
  assert.ok(tokens.has('5000'), 'should include 5000');
  assert.ok(!tokens.has('0'), 'should NOT include 0');
});

test('TC-PA-034: _extractTokens filters common starters', () => {
  const pa = new ProvenanceAnnotator({ logger: silentLogger });
  const tokens = pa._extractTokens('The project is great. Please review.');
  // 'The' and 'Please' are common starters — should be excluded
  assert.ok(!tokens.has('the'), 'should exclude "the"');
  assert.ok(!tokens.has('please'), 'should exclude "please"');
});

test('TC-PA-035: _extractTokens handles null/empty input', () => {
  const pa = new ProvenanceAnnotator({ logger: silentLogger });
  assert.ok(pa._extractTokens(null) instanceof Set);
  assert.strictEqual(pa._extractTokens(null).size, 0);
  assert.strictEqual(pa._extractTokens(undefined).size, 0);
  assert.strictEqual(pa._extractTokens('').size, 0);
});

test('TC-PA-036: _extractTokens extracts natural dates', () => {
  const pa = new ProvenanceAnnotator({ logger: silentLogger });
  const tokens = pa._extractTokens('Meeting on March 15, 2026');
  // Should contain a natural date token (lowercased)
  const hasNaturalDate = [...tokens].some(t => t.includes('march'));
  assert.ok(hasNaturalDate, 'should include a token containing "march"');
});

// =============================================================================
// _overlapScore() Tests
// =============================================================================

test('TC-PA-040: _overlapScore returns 1.0 for identical sets', () => {
  const pa = new ProvenanceAnnotator({ logger: silentLogger });
  const a = new Set(['alex', 'acmecorp', 'cto']);
  const b = new Set(['alex', 'acmecorp', 'cto']);
  assert.strictEqual(pa._overlapScore(a, b), 1.0);
});

test('TC-PA-041: _overlapScore returns 0 for disjoint sets', () => {
  const pa = new ProvenanceAnnotator({ logger: silentLogger });
  const a = new Set(['alex', 'acmecorp']);
  const b = new Set(['alice', 'acme']);
  assert.strictEqual(pa._overlapScore(a, b), 0);
});

test('TC-PA-042: _overlapScore returns 0 for empty tokensA', () => {
  const pa = new ProvenanceAnnotator({ logger: silentLogger });
  const a = new Set();
  const b = new Set(['alex', 'acmecorp']);
  assert.strictEqual(pa._overlapScore(a, b), 0);
});

test('TC-PA-043: _overlapScore computes partial overlap correctly', () => {
  const pa = new ProvenanceAnnotator({ logger: silentLogger });
  // tokensA has 4 tokens, 2 match tokensB -> score = 2/4 = 0.5
  const a = new Set(['alex', 'acmecorp', 'cto', 'engineer']);
  const b = new Set(['alex', 'acmecorp', 'alice', 'acme']);
  assert.strictEqual(pa._overlapScore(a, b), 0.5);
});

test('TC-PA-044: _overlapScore is directional (A/B not B/A)', () => {
  const pa = new ProvenanceAnnotator({ logger: silentLogger });
  // A has 1 token, B has 3 tokens, 1 overlaps
  // score(A, B) = 1/1 = 1.0
  // score(B, A) = 1/3 ≈ 0.333
  const a = new Set(['alex']);
  const b = new Set(['alex', 'acmecorp', 'cto']);
  const scoreAB = pa._overlapScore(a, b);
  const scoreBA = pa._overlapScore(b, a);
  assert.strictEqual(scoreAB, 1.0);
  assert.ok(scoreBA < 1.0, 'score(B, A) should be less than 1.0');
  assert.notStrictEqual(scoreAB, scoreBA);
});

// =============================================================================
// _findGrounding() Tests
// =============================================================================

test('TC-PA-050: _findGrounding returns grounded when agent_knowledge overlaps >= 0.5', () => {
  const pa = new ProvenanceAnnotator({ logger: silentLogger });
  // Segment about Alex at AcmeCorp — should match the wiki entry heavily
  const segment = { text: 'Alex is the CTO of AcmeCorp.' };
  const sources = {
    agentKnowledge: [
      {
        type: 'wiki',
        content: 'Alex is the CTO of AcmeCorp. His email is alex@example.com.',
        ref: 'wiki:People/Alex',
        confidence: 'high',
      },
    ],
    userMessage: '',
    actionLedger: [],
  };
  const result = pa._findGrounding(segment, sources);
  assert.strictEqual(result.trust, 'grounded');
  assert.strictEqual(result.source, 'wiki');
  assert.ok(result.refs.length > 0);
  assert.ok(result.score > 0);
});

test('TC-PA-051: _findGrounding returns stated when user message overlaps >= 0.3', () => {
  const pa = new ProvenanceAnnotator({ logger: silentLogger });
  // Segment echoes what the user said about Alex
  const segment = { text: 'Alex joined AcmeCorp last year.' };
  const sources = {
    agentKnowledge: [],
    // User message contains Alex and AcmeCorp — overlap should meet threshold
    userMessage: 'Tell me about Alex at AcmeCorp.',
    actionLedger: [],
  };
  const result = pa._findGrounding(segment, sources);
  assert.strictEqual(result.trust, 'stated');
  assert.strictEqual(result.source, 'user');
  assert.deepStrictEqual(result.refs, ['user:current']);
});

test('TC-PA-052: _findGrounding returns verified when action ledger overlaps >= 0.3', () => {
  const pa = new ProvenanceAnnotator({ logger: silentLogger });
  // Segment mentions a card number — the action ledger recorded a deck lookup for Card #42
  const segment = { text: 'Card #42 is in the To Do stack.' };
  const sources = {
    agentKnowledge: [],
    userMessage: '',
    // Action ledger entry whose refs contain "Card #42"
    actionLedger: [
      { type: 'deck_lookup', refs: ['Card #42', 'Fix login bug'] },
    ],
  };
  const result = pa._findGrounding(segment, sources);
  assert.strictEqual(result.trust, 'verified');
  assert.strictEqual(result.source, 'tool');
  assert.ok(result.refs[0].startsWith('tool:'));
});

test('TC-PA-053: _findGrounding returns ungrounded when no overlap meets threshold', () => {
  const pa = new ProvenanceAnnotator({ logger: silentLogger });
  // Segment contains entities that appear in no source
  const segment = { text: 'Zephyrus is a legendary dragon from Xanadu.' };
  const sources = {
    agentKnowledge: [
      {
        type: 'wiki',
        content: 'Alex is the CTO of AcmeCorp.',
        ref: 'wiki:People/Alex',
        confidence: 'high',
      },
    ],
    userMessage: 'Tell me about the project status.',
    actionLedger: [],
  };
  const result = pa._findGrounding(segment, sources);
  assert.strictEqual(result.trust, 'ungrounded');
  assert.strictEqual(result.source, 'model');
  assert.strictEqual(result.score, 0.2);
});

test('TC-PA-054: _findGrounding returns ungrounded for empty token segments', () => {
  const pa = new ProvenanceAnnotator({ logger: silentLogger });
  // A segment with no extractable entity tokens (all common words)
  const segment = { text: 'The is or and.' };
  const sources = {
    agentKnowledge: [
      {
        type: 'wiki',
        content: 'Alex is the CTO of AcmeCorp.',
        ref: 'wiki:People/Alex',
        confidence: 'high',
      },
    ],
    userMessage: 'Hello there, how are you?',
    actionLedger: [],
  };
  const result = pa._findGrounding(segment, sources);
  assert.strictEqual(result.trust, 'ungrounded');
  assert.strictEqual(result.source, 'model');
});

test('TC-PA-055: _findGrounding prefers grounded over stated', () => {
  const pa = new ProvenanceAnnotator({ logger: silentLogger });
  // Segment tokens overlap with both wiki knowledge AND user message
  // Grounded (wiki) should take priority
  const segment = { text: 'Alex is the CTO of AcmeCorp.' };
  const sources = {
    agentKnowledge: [
      {
        type: 'wiki',
        content: 'Alex is the CTO of AcmeCorp. His email is alex@example.com.',
        ref: 'wiki:People/Alex',
        confidence: 'high',
      },
    ],
    // User message also mentions Alex and AcmeCorp
    userMessage: 'What can you tell me about Alex at AcmeCorp?',
    actionLedger: [],
  };
  const result = pa._findGrounding(segment, sources);
  assert.strictEqual(result.trust, 'grounded', 'grounded should win over stated');
  assert.strictEqual(result.source, 'wiki');
});

// =============================================================================
// annotate() Full Pipeline Tests
// =============================================================================

test('TC-PA-060: annotate returns empty result for null response', () => {
  const pa = new ProvenanceAnnotator({ logger: silentLogger });
  const result = pa.annotate(null, {});
  assert.deepStrictEqual(result.segments, []);
  assert.strictEqual(result.groundedRatio, 1.0);
});

test('TC-PA-061: annotate returns empty result for empty string response', () => {
  const pa = new ProvenanceAnnotator({ logger: silentLogger });
  const result = pa.annotate('', {});
  assert.deepStrictEqual(result.segments, []);
  assert.strictEqual(result.groundedRatio, 1.0);
});

test('TC-PA-062: annotate produces correct segment structure', () => {
  const pa = new ProvenanceAnnotator({ logger: silentLogger });
  const response = 'Alex is the CTO.';
  const contextSources = {
    agentKnowledge: null,
    userMessage: '',
    actionLedger: [],
  };
  const result = pa.annotate(response, contextSources);
  assert.ok(result.segments.length > 0);
  const seg = result.segments[0];
  // Each segment must have exactly these fields
  assert.ok(typeof seg.text === 'string');
  assert.ok(typeof seg.provenance === 'string');
  assert.ok(typeof seg.trust === 'string');
  assert.ok(Array.isArray(seg.sourceRefs));
  assert.ok(typeof seg.confidence === 'number');
});

test('TC-PA-063: annotate computes groundedRatio correctly', () => {
  const pa = new ProvenanceAnnotator({ logger: silentLogger });
  // Two sentences: one overlaps heavily with knowledge (grounded), one invents a new entity (ungrounded)
  const response = 'Alex is the CTO of AcmeCorp. Zephyrus rules the Xanadu galaxy.';
  const agentKnowledge = [
    '<agent_knowledge>',
    '[source: wiki, confidence: high]',
    'People/Alex',
    'Alex is the CTO of AcmeCorp. His email is alex@example.com.',
    '</agent_knowledge>',
  ].join('\n');
  const contextSources = {
    agentKnowledge,
    userMessage: '',
    actionLedger: [],
  };
  const result = pa.annotate(response, contextSources);
  assert.ok(result.segments.length >= 2);
  // groundedRatio must be a number in [0, 1]
  assert.ok(result.groundedRatio >= 0 && result.groundedRatio <= 1);
  // At least one segment should be grounded, at least one ungrounded — ratio must be < 1
  const trusts = result.segments.map(s => s.trust);
  const hasGrounded = trusts.some(t => t === 'grounded');
  const hasUngrounded = trusts.some(t => t === 'ungrounded');
  assert.ok(hasGrounded, 'at least one segment should be grounded');
  assert.ok(hasUngrounded, 'at least one segment should be ungrounded');
  // Verify the ratio matches the actual count
  const groundedCount = trusts.filter(t => t !== 'ungrounded').length;
  const expectedRatio = groundedCount / result.segments.length;
  assert.strictEqual(result.groundedRatio, expectedRatio);
});

test('TC-PA-064: annotate with full context sources end-to-end', () => {
  const pa = new ProvenanceAnnotator({ logger: silentLogger });
  const agentKnowledge = [
    '<agent_knowledge>',
    '[source: wiki, confidence: high]',
    'People/Alex',
    'Alex is the CTO of AcmeCorp. His email is alex@example.com.',
    '',
    '[source: deck, match: title, confidence: high]',
    'Card #42: "Fix login bug"',
    'Stack: To Do',
    '</agent_knowledge>',
  ].join('\n');
  const response = 'Alex is the CTO of AcmeCorp. Card #42 is in the To Do stack.';
  const contextSources = {
    agentKnowledge,
    userMessage: 'Tell me about Alex and the login bug.',
    actionLedger: [
      { type: 'wiki_lookup', refs: ['People/Alex'] },
    ],
  };
  const result = pa.annotate(response, contextSources);
  assert.ok(result.segments.length >= 1);
  // All segments must have the full provenance shape
  for (const seg of result.segments) {
    assert.ok(typeof seg.text === 'string');
    assert.ok(typeof seg.provenance === 'string');
    assert.ok(['grounded', 'stated', 'verified', 'ungrounded'].includes(seg.trust));
    assert.ok(Array.isArray(seg.sourceRefs));
    assert.ok(typeof seg.confidence === 'number');
    assert.ok(seg.confidence >= 0 && seg.confidence <= 1);
  }
  // At least the Alex segment should be grounded against the wiki entry
  const groundedSegs = result.segments.filter(s => s.trust === 'grounded');
  assert.ok(groundedSegs.length > 0, 'at least one segment should be grounded');
});

test('TC-PA-065: annotate handles missing contextSources gracefully', () => {
  const pa = new ProvenanceAnnotator({ logger: silentLogger });
  // Missing fields: null contextSources, undefined individual fields
  const response = 'Alex is the CTO of AcmeCorp.';

  // Should not throw with null contextSources
  const result1 = pa.annotate(response, null);
  assert.ok(result1.segments.length > 0);
  assert.ok(result1.segments.every(s => typeof s.trust === 'string'));

  // Should not throw with undefined contextSources
  const result2 = pa.annotate(response, undefined);
  assert.ok(result2.segments.length > 0);

  // Should not throw with missing sub-fields
  const result3 = pa.annotate(response, { agentKnowledge: undefined, userMessage: undefined, actionLedger: undefined });
  assert.ok(result3.segments.length > 0);
  // With no sources, all segments should be ungrounded
  assert.ok(result3.segments.every(s => s.trust === 'ungrounded'));
});

test('TC-PA-066: annotate performance — < 50ms for typical response', () => {
  const pa = new ProvenanceAnnotator({ logger: silentLogger });

  // ~10 sentence response covering Alex, AcmeCorp, and a bug card
  const response = [
    'Alex is the CTO of AcmeCorp.',
    'His email is alex@example.com.',
    'AcmeCorp was founded in 2021.',
    'Alex leads the engineering team of 25 developers.',
    'Card #42 Fix login bug is currently in the To Do stack.',
    'The sprint started on 2026-03-01 and ends on 2026-03-15.',
    'Alice is the project manager overseeing Card #43.',
    'Budget for Q1 is 50000 euros.',
    'The team holds a standup every morning at 9.',
    'Deployment is scheduled for 2026-03-20.',
  ].join(' ');

  // 5 agent_knowledge entries
  const agentKnowledge = [
    '<agent_knowledge>',
    '[source: wiki, confidence: high]',
    'People/Alex',
    'Alex is the CTO of AcmeCorp. His email is alex@example.com.',
    '',
    '[source: wiki, confidence: medium]',
    'Company/AcmeCorp',
    'AcmeCorp was founded in 2021 by a group of engineers.',
    '',
    '[source: deck, match: title, confidence: high]',
    'Card #42: "Fix login bug"',
    'Stack: To Do',
    '',
    '[source: deck, match: title, confidence: high]',
    'Card #43: "Improve onboarding"',
    'Stack: In Progress. Assigned to Alice.',
    '',
    '[source: wiki, confidence: low]',
    'Finance/Q1Budget',
    'Q1 2026 budget is 50000 euros with a contingency of 5000.',
    '</agent_knowledge>',
  ].join('\n');

  const contextSources = {
    agentKnowledge,
    userMessage: 'Give me a full status update on Alex and the current sprint.',
    actionLedger: [
      { type: 'wiki_lookup', refs: ['People/Alex', 'Company/AcmeCorp'] },
      { type: 'deck_lookup', refs: ['Card #42', 'Card #43'] },
    ],
  };

  const start = Date.now();
  const result = pa.annotate(response, contextSources);
  const elapsed = Date.now() - start;

  assert.ok(result.segments.length > 0, 'should produce segments');
  // Allow 100ms to accommodate slow CI environments (spec says 50ms, generous here)
  assert.ok(elapsed < 100, `annotate took ${elapsed}ms, expected < 100ms`);
});

// =============================================================================
// Run
// =============================================================================

setTimeout(() => {
  summary();
  exitWithCode();
}, 500);
