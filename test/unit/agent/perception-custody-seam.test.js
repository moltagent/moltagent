/**
 * Perception Custody seam integration — drives the REAL AgentLoop.process() and
 * captures the messages array the model actually receives, proving the M1
 * (ceremony exclusion / state line), M2 (correction replacement) and M3
 * (recordless-confirmation injection) wiring end to end at the assembly seam.
 *
 * Run: node test/unit/agent/perception-custody-seam.test.js
 */

const assert = require('assert');
const path = require('path');
const fs = require('fs');
const { AgentLoop } = require('../../../src/lib/agent/agent-loop');
const { PerceptionCustody, NO_ACTION_PERCEPTION } = require('../../../src/lib/agent/perception-custody');

const silent = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {}, log: () => {} };

const soulPath = path.join(__dirname, 'test-soul-perception.md');
try { fs.writeFileSync(soulPath, 'You are a test agent.'); } catch { /* ignore */ }

let passed = 0;
let failed = 0;
async function asyncTest(name, fn) {
  try { await fn(); console.log(`✓ ${name}`); passed++; }
  catch (err) { console.log(`✗ ${name}\n  ${err.message}`); failed++; }
}

// A provider that records the messages array of its first chat() call.
function capturingProvider() {
  const cap = { messages: null };
  return {
    provider: {
      chat: async ({ messages }) => { if (!cap.messages) cap.messages = messages; return { content: 'ok', toolCalls: null }; },
      resetConversation: () => {}
    },
    cap
  };
}

function enforcerWith(perception, pendingRecords = []) {
  return {
    perceptionCustody: perception,
    getPendingRecords: () => pendingRecords
  };
}

function loopWith({ history = [], enforcer = null, provider }) {
  return new AgentLoop({
    toolRegistry: { getToolDefinitions: () => [], hasDomainTools: () => false, isMutating: () => true },
    conversationContext: { getHistory: async () => history },
    guardrailEnforcer: enforcer,
    llmProvider: provider,
    config: { soulPath },
    logger: silent
  });
}

function userContents(messages) {
  return messages.filter(m => m.role !== 'system').map(m => m.content);
}
function systemContents(messages) {
  return messages.filter(m => m.role === 'system').map(m => m.content);
}

(async () => {
  console.log('\n=== Perception Custody seam (AgentLoop) ===\n');

  // M1 gated OFF: the ceremony reaches the model unchanged.
  await asyncTest('M1 off: ceremony text reaches the model', async () => {
    const pc = new PerceptionCustody({ logger: silent });
    pc.noteCeremony('room1', 500, { recordId: 'r1', label: 'Delete Deck card' });
    const { provider, cap } = capturingProvider();
    const history = [{ id: 500, role: 'assistant', content: '🔐 Approve deletion? yes/no' }];
    const loop = loopWith({ history, enforcer: enforcerWith(pc, [{ id: 'r1' }]), provider });
    await loop.process('follow up', 'room1', {});
    assert.ok(userContents(cap.messages).some(c => c.includes('Approve deletion')), 'ceremony present when gate off');
  });

  // M1 ON + pending: the model perceives the state line, never the template.
  await asyncTest('M1 on + pending record: model sees the state line, not the ceremony', async () => {
    const pc = new PerceptionCustody({ logger: silent });
    pc.setCeremonyExclusion(true);
    pc.noteCeremony('room1', 500, { recordId: 'r1', label: 'Delete Deck card' });
    const { provider, cap } = capturingProvider();
    const history = [{ id: 500, role: 'assistant', content: '🔐 Approve deletion? yes/no' }];
    const loop = loopWith({ history, enforcer: enforcerWith(pc, [{ id: 'r1' }]), provider });
    await loop.process('follow up', 'room1', {});
    const contents = userContents(cap.messages);
    assert.ok(contents.some(c => c === '[approval pending: Delete Deck card — awaiting human decision]'), 'state line present');
    assert.ok(!contents.some(c => c.includes('Approve deletion')), 'no ceremony template in perception');
  });

  // M1 ON + resolved: the ceremony is gone with no replacement.
  await asyncTest('M1 on + resolved record: ceremony excluded, no replacement', async () => {
    const pc = new PerceptionCustody({ logger: silent });
    pc.setCeremonyExclusion(true);
    pc.noteCeremony('room1', 500, { recordId: 'r1', label: 'Delete Deck card' });
    const { provider, cap } = capturingProvider();
    const history = [
      { id: 500, role: 'assistant', content: '🔐 Approve deletion? yes/no' },
      { id: 501, role: 'user', content: 'ja' },
      { id: 502, role: 'assistant', content: 'Done.' }
    ];
    const loop = loopWith({ history, enforcer: enforcerWith(pc, []), provider }); // record no longer pending
    await loop.process('and now?', 'room1', {});
    const contents = userContents(cap.messages);
    assert.ok(!contents.some(c => c.includes('Approve deletion')), 'ceremony gone');
    assert.ok(!contents.some(c => c.includes('approval pending')), 'no state line once resolved');
    assert.ok(contents.some(c => c === 'Done.'), 'the real outcome message survives');
  });

  // M2: a corrected message id is perceived as the correction (poisoning cut).
  await asyncTest('M2: the model perceives the correction, not its own false claim', async () => {
    const pc = new PerceptionCustody({ logger: silent });
    pc.noteCorrection('room1', 900, NO_ACTION_PERCEPTION);
    const { provider, cap } = capturingProvider();
    const history = [{ id: 900, role: 'assistant', content: 'Pronto, o cartão foi deletado.' }];
    const loop = loopWith({ history, enforcer: enforcerWith(pc, []), provider });
    await loop.process('e agora?', 'room1', {});
    const contents = userContents(cap.messages);
    assert.ok(contents.some(c => c === NO_ACTION_PERCEPTION), 'correction perceived');
    assert.ok(!contents.some(c => /deletado/i.test(c)), 'no fiction perceivable');
  });

  // M3: gate=confirmation + no pending record → truth injected before generation.
  await asyncTest('M3: recordless confirmation injects the grounding truth', async () => {
    const pc = new PerceptionCustody({ logger: silent });
    const { provider, cap } = capturingProvider();
    const loop = loopWith({ history: [], enforcer: enforcerWith(pc, []), provider }); // no pending records
    await loop.process('ja', 'room1', { gate: 'confirmation' });
    const sys = systemContents(cap.messages);
    assert.ok(sys.some(c => c.includes('No pending action exists in this conversation')), 'truth injected');
  });

  // M3 negative: a pending record exists → NOT injected (would be a false claim).
  await asyncTest('M3: confirmation WITH a pending record does not inject', async () => {
    const pc = new PerceptionCustody({ logger: silent });
    const { provider, cap } = capturingProvider();
    const loop = loopWith({ history: [], enforcer: enforcerWith(pc, [{ id: 'r1' }]), provider });
    await loop.process('ja', 'room1', { gate: 'confirmation' });
    const sys = systemContents(cap.messages);
    assert.ok(!sys.some(c => c.includes('No pending action exists')), 'no injection when a record is pending');
  });

  // M3 negative: non-confirmation gate never injects.
  await asyncTest('M3: a non-confirmation turn never injects', async () => {
    const pc = new PerceptionCustody({ logger: silent });
    const { provider, cap } = capturingProvider();
    const loop = loopWith({ history: [], enforcer: enforcerWith(pc, []), provider });
    await loop.process('what is on my board?', 'room1', { gate: 'knowledge' });
    const sys = systemContents(cap.messages);
    assert.ok(!sys.some(c => c.includes('No pending action exists')), 'knowledge turn not injected');
  });

  try { fs.unlinkSync(soulPath); } catch { /* ignore */ }

  console.log('\n=================================');
  console.log(`Tests passed: ${passed}`);
  console.log(`Tests failed: ${failed}`);
  console.log('=================================\n');
  process.exit(failed > 0 ? 1 : 0);
})();
