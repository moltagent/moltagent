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
 * Trust-Decides-Classifier-Path Tests (#132)
 *
 * The classification path is chosen by the trust boundary (the single control),
 * not by hasCloudPlayers() (a provider-type census). A credential-less cloud
 * entry in providers.json makes hasCloudPlayers() return true but must NOT
 * degrade classification away from the local smart model under trust:local-only.
 *
 *   trust 'cloud-ok'   → router path (Haiku via LLMRouter.route)
 *   trust 'local-only' → local smart model (qwen3:8b) directly, regardless of census
 *   trust null         → legacy fallback to hasCloudPlayers() (boot / direct callers)
 *
 * Run: node test/unit/agent/trust-classifier-path.test.js
 */

'use strict';

const assert = require('assert');
const { asyncTest, summary, exitWithCode } = require('../../helpers/test-runner');
const IntentRouter = require('../../../src/lib/agent/intent-router');

console.log('\n=== Trust-Decides-Classifier-Path Tests (#132) ===\n');

/**
 * Build an IntentRouter whose mocks record which classification path fired.
 * @param {Object} opts
 * @param {string|null} opts.trust   - getTrust() return ('local-only'|'cloud-ok'|null)
 * @param {boolean} opts.hasCloud    - what hasCloudPlayers() reports (the census)
 */
function createRouter({ trust, hasCloud }) {
  const path = { providerModel: null, routerJob: null };
  const provider = {
    chat: async ({ model }) => {
      path.providerModel = model;
      return { content: JSON.stringify({ intent: 'calendar_query' }) };
    }
  };
  const llmRouter = {
    hasCloudPlayers: () => hasCloud,
    route: async ({ job }) => {
      path.routerJob = job;
      return { result: JSON.stringify({ intent: 'calendar_query' }) };
    }
  };
  const router = new IntentRouter({
    provider,
    llmRouter,
    getTrust: () => trust,
    config: { classifyTimeout: 1000, fastModel: 'qwen2.5:3b', smartModel: 'qwen3:8b' }
  });
  return { router, path };
}

// -- trust cloud-ok → router path (Haiku) --
asyncTest('trust:cloud-ok routes classification through the LLM router', async () => {
  const { router, path } = createRouter({ trust: 'cloud-ok', hasCloud: true });
  await router.classify('Do I have any appointments this week?');
  assert.strictEqual(path.routerJob, 'classification', 'router path should fire');
  assert.strictEqual(path.providerModel, null, 'local smart model should NOT fire');
});

// -- trust local-only → local smart model, never the router --
asyncTest('trust:local-only classifies via the local smart model directly', async () => {
  const { router, path } = createRouter({ trust: 'local-only', hasCloud: false });
  await router.classify('Do I have any appointments this week?');
  assert.strictEqual(path.providerModel, 'qwen3:8b', 'smart model should fire');
  assert.strictEqual(path.routerJob, null, 'router path should NOT fire');
});

// -- THE #132 REGRESSION GUARD: phantom cloud entry (census=true) under local-only --
asyncTest('phantom cloud entry does NOT degrade local-only classification', async () => {
  // hasCloudPlayers() === true (a credential-less providers.json cloud entry),
  // but trust is local-only. The verdict must win: local smart model, not the
  // router roster that would fall to qwen2.5:3b.
  const { router, path } = createRouter({ trust: 'local-only', hasCloud: true });
  await router.classify('Do I have any open tasks?');
  assert.strictEqual(path.providerModel, 'qwen3:8b', 'smart model wins over the phantom census');
  assert.strictEqual(path.routerJob, null, 'router path must NOT fire under local-only');
});

// -- trust null + census true → legacy router path preserved --
asyncTest('no resolver (trust null) falls back to the census: cloud present → router', async () => {
  const { router, path } = createRouter({ trust: null, hasCloud: true });
  await router.classify('Do I have any appointments this week?');
  assert.strictEqual(path.routerJob, 'classification', 'census-true → router path');
  assert.strictEqual(path.providerModel, null, 'local smart model should NOT fire');
});

// -- trust null + census false → legacy local path preserved --
asyncTest('no resolver (trust null) falls back to the census: no cloud → local smart', async () => {
  const { router, path } = createRouter({ trust: null, hasCloud: false });
  await router.classify('Do I have any appointments this week?');
  assert.strictEqual(path.providerModel, 'qwen3:8b', 'census-false → local smart model');
  assert.strictEqual(path.routerJob, null, 'router path should NOT fire');
});

setTimeout(() => { summary(); exitWithCode(); }, 500);
