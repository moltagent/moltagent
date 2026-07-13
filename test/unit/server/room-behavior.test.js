/**
 * SPDX-License-Identifier: AGPL-3.0-only
 * Copyright (C) 2026 Moltagent contributors
 *
 * Group-room addressing gate (#301) + the shared OCS reader.
 *
 * Architecture Brief:
 * - Problem: `_getRoomBehavior` read `response.body?.ocs?.data` without parsing a
 *   raw-string body, so `room` came back undefined and the gate fell open to
 *   respond-to-all in every group room. And it gated on `participantCount`, which
 *   the single-room read does not carry.
 * - Pattern: one tolerant OCS reader both consumers import; gate on `type`
 *   (1 = one-to-one → respond; anything else → require addressing).
 * - Run: node test/unit/server/room-behavior.test.js
 */

'use strict';

const assert = require('assert');
const { test, asyncTest, summary, exitWithCode } = require('../../helpers/test-runner');

const { ocsData } = require('../../../src/lib/shared/ocs-response');
const MessageProcessor = require('../../../src/lib/server/message-processor');

// ── The shared OCS reader ───────────────────────────────────────────────────

test('ocsData: parsed-object body → the .ocs.data payload', () => {
  assert.deepStrictEqual(ocsData({ body: { ocs: { data: { type: 2 } } } }), { type: 2 });
});

test('ocsData: raw-string body is parsed (the #301 case)', () => {
  const room = ocsData({ body: JSON.stringify({ ocs: { data: { type: 2, participantCount: 3 } } }) });
  assert.strictEqual(room.type, 2);
});

test('ocsData: non-JSON string → null', () => {
  assert.strictEqual(ocsData({ body: 'not json' }), null);
});

test('ocsData: missing / non-OCS shapes → null', () => {
  assert.strictEqual(ocsData(null), null);
  assert.strictEqual(ocsData({}), null);
  assert.strictEqual(ocsData({ body: { nope: true } }), null);
});

// ── _getRoomBehavior ────────────────────────────────────────────────────────

/** A MessageProcessor stub whose room GET returns the given body (object or string). */
function makeProcessor(roomBody) {
  const mp = Object.create(MessageProcessor.prototype);
  mp.botUsername = 'moltagent';
  mp.botNames = ['moltagent'];
  mp.ncRequestManager = { request: async () => ({ body: roomBody }) };
  return mp;
}

const msg = (content, extra = {}) => ({ token: 'r', user: 'u', content, _rawMessage: {}, ...extra });

asyncTest('one-to-one (type 1): responds to everything, unaddressed', async () => {
  const mp = makeProcessor({ ocs: { data: { type: 1 } } });
  assert.strictEqual(await mp._getRoomBehavior(msg('lösch die Karte X')), 'respond');
});

asyncTest('group (type 2): silent when NOT addressed', async () => {
  const mp = makeProcessor({ ocs: { data: { type: 2 } } });
  assert.strictEqual(await mp._getRoomBehavior(msg('lösch die Karte X')), 'silent');
});

asyncTest('group (type 2): responds when @mentioned', async () => {
  const mp = makeProcessor({ ocs: { data: { type: 2 } } });
  const m = msg('lösch die Karte X', { _rawMessage: { mentions: [{ id: 'moltagent' }] } });
  assert.strictEqual(await mp._getRoomBehavior(m), 'respond');
});

asyncTest('group (type 2): responds when addressed by name at the start', async () => {
  const mp = makeProcessor({ ocs: { data: { type: 2 } } });
  assert.strictEqual(await mp._getRoomBehavior(msg('Moltagent, lösch die Karte X')), 'respond');
});

asyncTest('#301 regression: raw-string body + group type → silent, not respond', async () => {
  // Before the fix, the unparsed string body made room=undefined → respond.
  const mp = makeProcessor(JSON.stringify({ ocs: { data: { type: 2, participantCount: 3 } } }));
  assert.strictEqual(await mp._getRoomBehavior(msg('lösch die Karte X')), 'silent');
});

asyncTest('type absent: falls back to participantCount (>2 → require addressing)', async () => {
  const mp = makeProcessor({ ocs: { data: { participantCount: 3 } } });
  assert.strictEqual(await mp._getRoomBehavior(msg('lösch die Karte X')), 'silent');
  const mp2 = makeProcessor({ ocs: { data: { participantCount: 2 } } });
  assert.strictEqual(await mp2._getRoomBehavior(msg('lösch die Karte X')), 'respond');
});

asyncTest('room lookup throws → fail toward respond', async () => {
  const mp = Object.create(MessageProcessor.prototype);
  mp.botUsername = 'moltagent';
  mp.botNames = ['moltagent'];
  mp.ncRequestManager = { request: async () => { throw new Error('boom'); } };
  assert.strictEqual(await mp._getRoomBehavior(msg('anything')), 'respond');
});

setTimeout(() => { summary(); exitWithCode(); }, 500);
