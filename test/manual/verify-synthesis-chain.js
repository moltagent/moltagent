'use strict';

/**
 * Verify: job→model tier mapping across all presets.
 * Job picks the model tier. Trust boundary picks provider availability.
 */

const Router = require('../../src/lib/llm/router');

function makeRouter() {
  const router = new Router({
    roles: { sovereign: ['ollama-local'], free: ['ollama-local'], value: ['ollama-local'], premium: ['ollama-local'] },
    auditLog: () => {},
    getCredential: () => null
  });
  router.providers.set('ollama-fast', { type: 'local', model: 'qwen2.5:3b', costModel: { outputPer1M: 0 } });
  router.providers.set('ollama-local', { type: 'local', model: 'qwen3:8b', costModel: { outputPer1M: 0 } });
  router.providers.set('claude-haiku', { type: 'cloud', model: 'claude-haiku-4-5', costModel: { outputPer1M: 1.0 } });
  router.providers.set('claude-sonnet', { type: 'cloud', model: 'claude-sonnet-4', costModel: { outputPer1M: 8.0 } });
  return router;
}

const jobs = ['quick', 'classification', 'synthesis', 'decomposition', 'tools', 'thinking', 'research', 'writing', 'coding'];

// Expected first provider per job per preset
const expected = {
  'smart-mix': {
    quick: 'ollama-fast',
    classification: 'ollama-fast',
    synthesis: 'claude-haiku',
    decomposition: 'claude-haiku',
    tools: 'ollama-fast',       // local first, cloud fallback
    thinking: 'claude-sonnet',
    writing: 'claude-sonnet',
    research: 'claude-sonnet',
    coding: 'claude-sonnet',
  },
  'cloud-first': {
    quick: 'claude-haiku',      // no local in cloud-first
    classification: 'claude-haiku',
    synthesis: 'claude-haiku',
    decomposition: 'claude-haiku',
    tools: 'claude-haiku',
    thinking: 'claude-sonnet',
    writing: 'claude-sonnet',
    research: 'claude-sonnet',
    coding: 'claude-sonnet',
  },
  'all-local': {
    quick: 'ollama-fast',
    classification: 'ollama-fast',
    synthesis: 'ollama-fast',     // all-local: fast-first sort applies to QUICK only
    decomposition: 'ollama-fast', // all non-quick: localIds in registration order
    tools: 'ollama-fast',
    thinking: 'ollama-fast',
    writing: 'ollama-fast',
    research: 'ollama-fast',
    coding: 'ollama-fast',
  }
};

let pass = 0, fail = 0;

for (const preset of ['all-local', 'smart-mix', 'cloud-first']) {
  const router = makeRouter();
  router.setPreset(preset);

  console.log(`\n=== ${preset} ===\n`);
  for (const job of jobs) {
    const chain = router._roster[job] || [];
    const first = chain[0] || '(none)';
    const exp = expected[preset][job];
    const ok = first === exp;
    const tag = ok ? 'PASS' : 'FAIL';
    if (ok) pass++; else fail++;
    console.log(`  [${tag}] ${job.padEnd(15)} first: ${first.padEnd(15)} chain: ${chain.join(' → ')}`);
  }
}

console.log(`\n--- ${pass} passed, ${fail} failed ---`);
process.exit(fail > 0 ? 1 : 0);
