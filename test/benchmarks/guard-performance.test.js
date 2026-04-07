/*
 * Moltagent - Sovereign AI Security Layer
 * Copyright (C) 2026 Moltagent Contributors
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU Affero General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the
 * GNU Affero General Public License for more details.
 */

'use strict';

const assert = require('assert');
const { test, summary, exitWithCode } = require('../helpers/test-runner');
const MemoryIntegrityChecker = require('../../src/security/memory-integrity');
const SessionManager = require('../../src/security/session-manager');

console.log('\n=== Guard Performance Benchmarks ===\n');

// -----------------------------------------------------------------------------
// MemoryIntegrityChecker Benchmarks
// -----------------------------------------------------------------------------

test('BENCH-MI-001: MemoryIntegrityChecker.sanitize < 0.1ms average', () => {
  const checker = new MemoryIntegrityChecker();
  const iterations = 10000;
  const content = 'Here is some normal content about the project. '.repeat(20);

  const start = process.hrtime.bigint();
  for (let i = 0; i < iterations; i++) {
    checker.sanitize(content);
  }
  const elapsed = Number(process.hrtime.bigint() - start) / 1e6;
  const avg = elapsed / iterations;
  console.log(`  → MemoryIntegrityChecker.sanitize: ${avg.toFixed(4)}ms avg`);
  assert.ok(avg < 0.1, `Expected < 0.1ms, got ${avg.toFixed(4)}ms`);
});

test('BENCH-MI-002: MemoryIntegrityChecker.computeHash < 0.01ms average', () => {
  const checker = new MemoryIntegrityChecker();
  const iterations = 10000;
  const content = 'Normal memory file content for hashing. '.repeat(25);

  const start = process.hrtime.bigint();
  for (let i = 0; i < iterations; i++) {
    checker.computeHash(content);
  }
  const elapsed = Number(process.hrtime.bigint() - start) / 1e6;
  const avg = elapsed / iterations;
  console.log(`  → MemoryIntegrityChecker.computeHash: ${avg.toFixed(4)}ms avg`);
  assert.ok(avg < 0.01, `Expected < 0.01ms, got ${avg.toFixed(4)}ms`);
});

// -----------------------------------------------------------------------------
// SessionManager Benchmarks
// -----------------------------------------------------------------------------

test('BENCH-SM-001: SessionManager.getSession < 0.01ms average', () => {
  const manager = new SessionManager();
  const iterations = 10000;

  // Pre-create sessions to simulate realistic conditions
  for (let i = 0; i < 100; i++) {
    manager.getSession(`room${i}`, `user${i % 10}`);
  }

  const start = process.hrtime.bigint();
  for (let i = 0; i < iterations; i++) {
    manager.getSession('room50', 'user5'); // Existing session lookup
  }
  const elapsed = Number(process.hrtime.bigint() - start) / 1e6;
  const avg = elapsed / iterations;
  console.log(`  → SessionManager.getSession: ${avg.toFixed(4)}ms avg`);
  assert.ok(avg < 0.01, `Expected < 0.01ms, got ${avg.toFixed(4)}ms`);
});

test('BENCH-SM-002: SessionManager.isApproved < 0.005ms average', () => {
  const manager = new SessionManager();
  const session = manager.getSession('room1', 'alice');
  manager.grantApproval(session, 'send_email');

  const iterations = 10000;
  const start = process.hrtime.bigint();
  for (let i = 0; i < iterations; i++) {
    manager.isApproved(session, 'send_email');
  }
  const elapsed = Number(process.hrtime.bigint() - start) / 1e6;
  const avg = elapsed / iterations;
  console.log(`  → SessionManager.isApproved: ${avg.toFixed(4)}ms avg`);
  assert.ok(avg < 0.005, `Expected < 0.005ms, got ${avg.toFixed(4)}ms`);
});

test('BENCH-SM-003: SessionManager.addContext < 0.01ms average', () => {
  const manager = new SessionManager();
  const session = manager.getSession('room1', 'alice');

  const iterations = 10000;
  const start = process.hrtime.bigint();
  for (let i = 0; i < iterations; i++) {
    manager.addContext(session, 'user', `Message ${i}`);
  }
  const elapsed = Number(process.hrtime.bigint() - start) / 1e6;
  const avg = elapsed / iterations;
  console.log(`  → SessionManager.addContext: ${avg.toFixed(4)}ms avg`);
  assert.ok(avg < 0.01, `Expected < 0.01ms, got ${avg.toFixed(4)}ms`);
});

// -----------------------------------------------------------------------------
// SecurityInterceptor Pipeline Benchmarks
// -----------------------------------------------------------------------------

const SecurityInterceptor = require('../../src/security/interceptor');
const SecretsGuard = require('../../src/security/guards/secrets-guard');
const ToolGuard = require('../../src/security/guards/tool-guard');
const PromptGuard = require('../../src/security/guards/prompt-guard');
const PathGuard = require('../../src/security/guards/path-guard');
const EgressGuard = require('../../src/security/guards/egress-guard');
const ResponseWrapper = require('../../src/security/response-wrapper');
const { asyncTest } = require('../helpers/test-runner');

function createBenchInterceptor() {
  const sg = new SecretsGuard();
  return new SecurityInterceptor({
    guards: {
      secrets: sg,
      tools: new ToolGuard(),
      prompt: new PromptGuard({ enableML: false }),
      paths: new PathGuard(),
      egress: new EgressGuard({ allowedDomains: ['api.anthropic.com'] }),
    },
    responseWrapper: new ResponseWrapper({ secretsGuard: sg }),
    sessionManager: new SessionManager(),
    config: { strictMode: false, enableML: false, enableLLMJudge: false },
  });
}

asyncTest('BENCH-SI-001: beforeExecute < 1ms average (no ML)', async () => {
  const si = createBenchInterceptor();
  const iterations = 1000;
  const content = 'What meetings do I have tomorrow? Please check my calendar. '.repeat(5);
  const ctx = { roomToken: 'bench-room', userId: 'bench-user' };

  const start = process.hrtime.bigint();
  for (let i = 0; i < iterations; i++) {
    await si.beforeExecute('process_message', { content }, ctx);
  }
  const elapsed = Number(process.hrtime.bigint() - start) / 1e6;
  const avg = elapsed / iterations;
  console.log(`  → SecurityInterceptor.beforeExecute: ${avg.toFixed(4)}ms avg`);
  assert.ok(avg < 1.0, `Expected < 1.0ms, got ${avg.toFixed(4)}ms`);
});

asyncTest('BENCH-SI-002: afterExecute < 0.5ms average', async () => {
  const si = createBenchInterceptor();
  const iterations = 1000;
  const response = 'You have 3 meetings tomorrow: 9am standup, 2pm design review, 4pm 1:1. '.repeat(3);
  const ctx = { roomToken: 'bench-room', userId: 'bench-user' };

  const start = process.hrtime.bigint();
  for (let i = 0; i < iterations; i++) {
    await si.afterExecute('process_message', response, ctx);
  }
  const elapsed = Number(process.hrtime.bigint() - start) / 1e6;
  const avg = elapsed / iterations;
  console.log(`  → SecurityInterceptor.afterExecute: ${avg.toFixed(4)}ms avg`);
  assert.ok(avg < 0.5, `Expected < 0.5ms, got ${avg.toFixed(4)}ms`);
});

asyncTest('BENCH-SI-003: Full pipeline (before + after) < 2ms without ML', async () => {
  const si = createBenchInterceptor();
  const iterations = 500;
  const content = 'Summarize my tasks for today';
  const response = 'You have 5 tasks: review PR, update docs, team meeting, write tests, deploy.';
  const ctx = { roomToken: 'bench-room', userId: 'bench-user' };

  const start = process.hrtime.bigint();
  for (let i = 0; i < iterations; i++) {
    const before = await si.beforeExecute('process_message', { content }, ctx);
    if (before.proceed) {
      await si.afterExecute('process_message', response, ctx);
    }
  }
  const elapsed = Number(process.hrtime.bigint() - start) / 1e6;
  const avg = elapsed / iterations;
  console.log(`  → Full security pipeline: ${avg.toFixed(4)}ms avg`);
  assert.ok(avg < 2.0, `Expected < 2.0ms, got ${avg.toFixed(4)}ms`);
});

// -----------------------------------------------------------------------------
// Summary
// -----------------------------------------------------------------------------

setTimeout(() => {
  console.log('\n=== Guard Performance Benchmarks Complete ===\n');
  summary();
  exitWithCode();
}, 300);
