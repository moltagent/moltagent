/*
 * MoltAgent - Sovereign AI Security Layer
 * Copyright (C) 2026 MoltAgent Contributors
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU Affero General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 */

/**
 * Unit Tests for SessionManager Module
 *
 * Tests session isolation, context management, credential tracking,
 * approval workflows, and expiry mechanisms.
 *
 * @module test/unit/security/session-manager.test.js
 */

'use strict';

const assert = require('assert');
const { test, summary, exitWithCode } = require('../../helpers/test-runner');
const SessionManager = require('../../../src/security/session-manager');

// -----------------------------------------------------------------------------
// Mock Audit Logger
// -----------------------------------------------------------------------------

class MockAuditLog {
  constructor() {
    this.logs = [];
  }

  log(eventType, data) {
    this.logs.push({ eventType, data, timestamp: Date.now() });
  }

  reset() {
    this.logs = [];
  }

  getLastLog() {
    return this.logs[this.logs.length - 1];
  }

  getLogsByType(eventType) {
    return this.logs.filter(log => log.eventType === eventType);
  }
}

// -----------------------------------------------------------------------------
// Main Test Runner
// -----------------------------------------------------------------------------

function runTests() {
  console.log('\n=== SessionManager Tests ===\n');

  // ---------------------------------------------------------------------------
  // Constructor Tests
  // ---------------------------------------------------------------------------

  test('TC-SM-001: Constructor sets default sessionTimeoutMs to 24 hours', () => {
    const sm = new SessionManager();
    assert.strictEqual(sm.sessionTimeoutMs, 86400000);
  });

  test('TC-SM-002: Constructor sets default approvalExpiryMs to 5 minutes', () => {
    const sm = new SessionManager();
    assert.strictEqual(sm.approvalExpiryMs, 300000);
  });

  test('TC-SM-003: Constructor sets default maxContextLength to 100', () => {
    const sm = new SessionManager();
    assert.strictEqual(sm.maxContextLength, 100);
  });

  test('TC-SM-004: Constructor accepts custom sessionTimeoutMs', () => {
    const sm = new SessionManager({ sessionTimeoutMs: 60000 });
    assert.strictEqual(sm.sessionTimeoutMs, 60000);
  });

  test('TC-SM-005: Constructor accepts custom approvalExpiryMs', () => {
    const sm = new SessionManager({ approvalExpiryMs: 120000 });
    assert.strictEqual(sm.approvalExpiryMs, 120000);
  });

  test('TC-SM-006: Constructor accepts custom maxContextLength', () => {
    const sm = new SessionManager({ maxContextLength: 50 });
    assert.strictEqual(sm.maxContextLength, 50);
  });

  test('TC-SM-007: Constructor accepts optional auditLog', () => {
    const auditLog = new MockAuditLog();
    const sm = new SessionManager({ auditLog });
    assert.strictEqual(sm.auditLog, auditLog);
  });

  test('TC-SM-008: Constructor initializes empty sessions map', () => {
    const sm = new SessionManager();
    assert.ok(sm.sessions instanceof Map);
    assert.strictEqual(sm.sessions.size, 0);
  });

  test('TC-SM-009: Constructor initializes empty sessionIndex map', () => {
    const sm = new SessionManager();
    assert.ok(sm.sessionIndex instanceof Map);
    assert.strictEqual(sm.sessionIndex.size, 0);
  });

  // ---------------------------------------------------------------------------
  // Session Creation and Retrieval Tests
  // ---------------------------------------------------------------------------

  test('TC-SM-010: getSession creates new session for room+user pair', () => {
    const sm = new SessionManager();
    const session = sm.getSession('room123', 'user1');

    assert.ok(session);
    assert.strictEqual(session.roomToken, 'room123');
    assert.strictEqual(session.userId, 'user1');
    assert.ok(session.id);
    assert.ok(session.createdAt);
    assert.ok(session.lastActivityAt);
  });

  test('TC-SM-011: getSession returns same session for same room+user', () => {
    const sm = new SessionManager();
    const session1 = sm.getSession('room123', 'user1');
    const session2 = sm.getSession('room123', 'user1');

    assert.strictEqual(session1.id, session2.id);
    assert.strictEqual(session1, session2);
  });

  test('TC-SM-012: getSession creates different session for different user', () => {
    const sm = new SessionManager();
    const session1 = sm.getSession('room123', 'user1');
    const session2 = sm.getSession('room123', 'user2');

    assert.notStrictEqual(session1.id, session2.id);
    assert.notStrictEqual(session1, session2);
  });

  test('TC-SM-013: getSession creates different session for different room', () => {
    const sm = new SessionManager();
    const session1 = sm.getSession('room123', 'user1');
    const session2 = sm.getSession('room456', 'user1');

    assert.notStrictEqual(session1.id, session2.id);
    assert.notStrictEqual(session1, session2);
  });

  test('TC-SM-014: Session has UUID format ID', () => {
    const sm = new SessionManager();
    const session = sm.getSession('room123', 'user1');

    // UUID v4 format: xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx
    const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
    assert.ok(uuidRegex.test(session.id));
  });

  test('TC-SM-015: Session initializes with empty context array', () => {
    const sm = new SessionManager();
    const session = sm.getSession('room123', 'user1');

    assert.ok(Array.isArray(session.context));
    assert.strictEqual(session.context.length, 0);
  });

  test('TC-SM-016: Session initializes with empty credentialsAccessed set', () => {
    const sm = new SessionManager();
    const session = sm.getSession('room123', 'user1');

    assert.ok(session.credentialsAccessed instanceof Set);
    assert.strictEqual(session.credentialsAccessed.size, 0);
  });

  test('TC-SM-017: Session initializes with empty pendingApprovals map', () => {
    const sm = new SessionManager();
    const session = sm.getSession('room123', 'user1');

    assert.ok(session.pendingApprovals instanceof Map);
    assert.strictEqual(session.pendingApprovals.size, 0);
  });

  test('TC-SM-018: Session initializes with empty grantedApprovals map', () => {
    const sm = new SessionManager();
    const session = sm.getSession('room123', 'user1');

    assert.ok(session.grantedApprovals instanceof Map);
    assert.strictEqual(session.grantedApprovals.size, 0);
  });

  test('TC-SM-019: getSession updates lastActivityAt on retrieval', () => {
    const sm = new SessionManager();
    const session1 = sm.getSession('room123', 'user1');
    const firstActivity = session1.lastActivityAt;

    // Wait a bit
    const originalNow = Date.now;
    Date.now = () => firstActivity + 1000;

    const session2 = sm.getSession('room123', 'user1');
    Date.now = originalNow;

    assert.ok(session2.lastActivityAt > firstActivity);
  });

  test('TC-SM-020: getSession logs session_created event', () => {
    const auditLog = new MockAuditLog();
    const sm = new SessionManager({ auditLog });

    const session = sm.getSession('room123', 'user1');

    assert.strictEqual(auditLog.logs.length, 1);
    const log = auditLog.getLastLog();
    assert.strictEqual(log.eventType, 'session_created');
    assert.strictEqual(log.data.sessionId, session.id);
    assert.strictEqual(log.data.roomToken, 'room123');
    assert.strictEqual(log.data.userId, 'user1');
  });

  // ---------------------------------------------------------------------------
  // Context Management Tests
  // ---------------------------------------------------------------------------

  test('TC-SM-030: addContext adds entry to session context', () => {
    const sm = new SessionManager();
    const session = sm.getSession('room123', 'user1');

    sm.addContext(session, 'user', 'Hello');

    assert.strictEqual(session.context.length, 1);
    assert.strictEqual(session.context[0].role, 'user');
    assert.strictEqual(session.context[0].content, 'Hello');
    assert.ok(session.context[0].timestamp);
  });

  test('TC-SM-031: addContext preserves multiple entries', () => {
    const sm = new SessionManager();
    const session = sm.getSession('room123', 'user1');

    sm.addContext(session, 'user', 'Hello');
    sm.addContext(session, 'assistant', 'Hi there');
    sm.addContext(session, 'user', 'How are you?');

    assert.strictEqual(session.context.length, 3);
    assert.strictEqual(session.context[0].content, 'Hello');
    assert.strictEqual(session.context[1].content, 'Hi there');
    assert.strictEqual(session.context[2].content, 'How are you?');
  });

  test('TC-SM-032: addContext respects maxContextLength', () => {
    const sm = new SessionManager({ maxContextLength: 3 });
    const session = sm.getSession('room123', 'user1');

    sm.addContext(session, 'user', 'Message 1');
    sm.addContext(session, 'user', 'Message 2');
    sm.addContext(session, 'user', 'Message 3');
    sm.addContext(session, 'user', 'Message 4');

    assert.strictEqual(session.context.length, 3);
    assert.strictEqual(session.context[0].content, 'Message 2');
    assert.strictEqual(session.context[1].content, 'Message 3');
    assert.strictEqual(session.context[2].content, 'Message 4');
  });

  test('TC-SM-033: addContext logs context_trimmed when limit exceeded', () => {
    const auditLog = new MockAuditLog();
    const sm = new SessionManager({ maxContextLength: 2, auditLog });
    const session = sm.getSession('room123', 'user1');

    sm.addContext(session, 'user', 'Message 1');
    sm.addContext(session, 'user', 'Message 2');
    sm.addContext(session, 'user', 'Message 3');

    const trimLogs = auditLog.getLogsByType('context_trimmed');
    assert.strictEqual(trimLogs.length, 1);
    assert.strictEqual(trimLogs[0].data.entriesRemoved, 1);
  });

  test('TC-SM-034: getContext returns context array', () => {
    const sm = new SessionManager();
    const session = sm.getSession('room123', 'user1');

    sm.addContext(session, 'user', 'Test message');

    const context = sm.getContext(session);
    assert.ok(Array.isArray(context));
    assert.strictEqual(context.length, 1);
    assert.strictEqual(context[0].content, 'Test message');
  });

  test('TC-SM-035: addContext updates lastActivityAt', () => {
    const sm = new SessionManager();
    const session = sm.getSession('room123', 'user1');
    const initialActivity = session.lastActivityAt;

    const originalNow = Date.now;
    Date.now = () => initialActivity + 1000;

    sm.addContext(session, 'user', 'Test');

    Date.now = originalNow;

    assert.ok(session.lastActivityAt > initialActivity);
  });

  // ---------------------------------------------------------------------------
  // Context Isolation Tests
  // ---------------------------------------------------------------------------

  test('TC-SM-040: Context is isolated between sessions', () => {
    const sm = new SessionManager();
    const session1 = sm.getSession('room123', 'user1');
    const session2 = sm.getSession('room123', 'user2');

    sm.addContext(session1, 'user', 'Session 1 message');
    sm.addContext(session2, 'user', 'Session 2 message');

    assert.strictEqual(session1.context.length, 1);
    assert.strictEqual(session2.context.length, 1);
    assert.strictEqual(session1.context[0].content, 'Session 1 message');
    assert.strictEqual(session2.context[0].content, 'Session 2 message');
    assert.notStrictEqual(session1.context, session2.context);
  });

  // ---------------------------------------------------------------------------
  // Credential Access Tracking Tests
  // ---------------------------------------------------------------------------

  test('TC-SM-050: recordCredentialAccess returns true on first access', () => {
    const sm = new SessionManager();
    const session = sm.getSession('room123', 'user1');

    const isFirst = sm.recordCredentialAccess(session, 'api_key_1');

    assert.strictEqual(isFirst, true);
    assert.ok(session.credentialsAccessed.has('api_key_1'));
  });

  test('TC-SM-051: recordCredentialAccess returns false on subsequent access', () => {
    const sm = new SessionManager();
    const session = sm.getSession('room123', 'user1');

    const isFirst1 = sm.recordCredentialAccess(session, 'api_key_1');
    const isFirst2 = sm.recordCredentialAccess(session, 'api_key_1');

    assert.strictEqual(isFirst1, true);
    assert.strictEqual(isFirst2, false);
  });

  test('TC-SM-052: recordCredentialAccess tracks multiple credentials', () => {
    const sm = new SessionManager();
    const session = sm.getSession('room123', 'user1');

    sm.recordCredentialAccess(session, 'api_key_1');
    sm.recordCredentialAccess(session, 'api_key_2');
    sm.recordCredentialAccess(session, 'api_key_3');

    assert.strictEqual(session.credentialsAccessed.size, 3);
    assert.ok(session.credentialsAccessed.has('api_key_1'));
    assert.ok(session.credentialsAccessed.has('api_key_2'));
    assert.ok(session.credentialsAccessed.has('api_key_3'));
  });

  test('TC-SM-053: recordCredentialAccess logs first access only', () => {
    const auditLog = new MockAuditLog();
    const sm = new SessionManager({ auditLog });
    const session = sm.getSession('room123', 'user1');

    sm.recordCredentialAccess(session, 'api_key_1');
    sm.recordCredentialAccess(session, 'api_key_1');

    const credLogs = auditLog.getLogsByType('credential_accessed');
    assert.strictEqual(credLogs.length, 1);
    assert.strictEqual(credLogs[0].data.credentialName, 'api_key_1');
    assert.strictEqual(credLogs[0].data.isFirstAccess, true);
  });

  test('TC-SM-054: recordCredentialAccess updates lastActivityAt', () => {
    const sm = new SessionManager();
    const session = sm.getSession('room123', 'user1');
    const initialActivity = session.lastActivityAt;

    const originalNow = Date.now;
    Date.now = () => initialActivity + 1000;

    sm.recordCredentialAccess(session, 'api_key_1');

    Date.now = originalNow;

    assert.ok(session.lastActivityAt > initialActivity);
  });

  // ---------------------------------------------------------------------------
  // Credential Access Isolation Tests
  // ---------------------------------------------------------------------------

  test('TC-SM-060: Credential tracking is isolated between sessions', () => {
    const sm = new SessionManager();
    const session1 = sm.getSession('room123', 'user1');
    const session2 = sm.getSession('room123', 'user2');

    sm.recordCredentialAccess(session1, 'api_key_1');

    assert.ok(session1.credentialsAccessed.has('api_key_1'));
    assert.ok(!session2.credentialsAccessed.has('api_key_1'));
    assert.notStrictEqual(session1.credentialsAccessed, session2.credentialsAccessed);
  });

  test('TC-SM-061: Same credential in different sessions are independent', () => {
    const sm = new SessionManager();
    const session1 = sm.getSession('room123', 'user1');
    const session2 = sm.getSession('room123', 'user2');

    const isFirst1 = sm.recordCredentialAccess(session1, 'api_key_1');
    const isFirst2 = sm.recordCredentialAccess(session2, 'api_key_1');

    assert.strictEqual(isFirst1, true);
    assert.strictEqual(isFirst2, true);
  });

  // ---------------------------------------------------------------------------
  // Approval Request Tests
  // ---------------------------------------------------------------------------

  test('TC-SM-070: requestApproval creates pending approval', () => {
    const sm = new SessionManager();
    const session = sm.getSession('room123', 'user1');

    const requestId = sm.requestApproval(session, 'delete_file');

    assert.ok(requestId);
    assert.strictEqual(session.pendingApprovals.size, 1);
    assert.ok(session.pendingApprovals.has('delete_file'));
  });

  test('TC-SM-071: requestApproval returns UUID request ID', () => {
    const sm = new SessionManager();
    const session = sm.getSession('room123', 'user1');

    const requestId = sm.requestApproval(session, 'delete_file');

    const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
    assert.ok(uuidRegex.test(requestId));
  });

  test('TC-SM-072: requestApproval with target creates scoped key', () => {
    const sm = new SessionManager();
    const session = sm.getSession('room123', 'user1');

    sm.requestApproval(session, 'delete_file', { target: '/etc/passwd' });

    assert.ok(session.pendingApprovals.has('delete_file:/etc/passwd'));
    assert.ok(!session.pendingApprovals.has('delete_file'));
  });

  test('TC-SM-073: requestApproval logs approval_requested event', () => {
    const auditLog = new MockAuditLog();
    const sm = new SessionManager({ auditLog });
    const session = sm.getSession('room123', 'user1');

    const requestId = sm.requestApproval(session, 'delete_file');

    const reqLogs = auditLog.getLogsByType('approval_requested');
    assert.strictEqual(reqLogs.length, 1);
    assert.strictEqual(reqLogs[0].data.operation, 'delete_file');
    assert.strictEqual(reqLogs[0].data.requestId, requestId);
  });

  test('TC-SM-074: requestApproval updates lastActivityAt', () => {
    const sm = new SessionManager();
    const session = sm.getSession('room123', 'user1');
    const initialActivity = session.lastActivityAt;

    const originalNow = Date.now;
    Date.now = () => initialActivity + 1000;

    sm.requestApproval(session, 'delete_file');

    Date.now = originalNow;

    assert.ok(session.lastActivityAt > initialActivity);
  });

  // ---------------------------------------------------------------------------
  // Approval Grant Tests
  // ---------------------------------------------------------------------------

  test('TC-SM-080: grantApproval moves from pending to granted', () => {
    const sm = new SessionManager();
    const session = sm.getSession('room123', 'user1');

    sm.requestApproval(session, 'delete_file');
    sm.grantApproval(session, 'delete_file');

    assert.strictEqual(session.pendingApprovals.size, 0);
    assert.strictEqual(session.grantedApprovals.size, 1);
    assert.ok(session.grantedApprovals.has('delete_file'));
  });

  test('TC-SM-081: grantApproval sets expiry timestamp', () => {
    const sm = new SessionManager({ approvalExpiryMs: 300000 });
    const session = sm.getSession('room123', 'user1');

    const now = Date.now();
    sm.grantApproval(session, 'delete_file');

    const approval = session.grantedApprovals.get('delete_file');
    assert.ok(approval.grantedAt);
    assert.ok(approval.expiresAt);
    assert.ok(approval.expiresAt > now);
    assert.ok(approval.expiresAt <= now + 300000 + 100); // Allow 100ms tolerance
  });

  test('TC-SM-082: grantApproval works without prior request', () => {
    const sm = new SessionManager();
    const session = sm.getSession('room123', 'user1');

    // Grant directly without request
    sm.grantApproval(session, 'delete_file');

    assert.strictEqual(session.grantedApprovals.size, 1);
    assert.ok(session.grantedApprovals.has('delete_file'));
  });

  test('TC-SM-083: grantApproval logs approval_granted event', () => {
    const auditLog = new MockAuditLog();
    const sm = new SessionManager({ auditLog });
    const session = sm.getSession('room123', 'user1');

    sm.grantApproval(session, 'delete_file');

    const grantLogs = auditLog.getLogsByType('approval_granted');
    assert.strictEqual(grantLogs.length, 1);
    assert.strictEqual(grantLogs[0].data.operation, 'delete_file');
  });

  test('TC-SM-084: grantApproval updates lastActivityAt', () => {
    const sm = new SessionManager();
    const session = sm.getSession('room123', 'user1');
    const initialActivity = session.lastActivityAt;

    const originalNow = Date.now;
    Date.now = () => initialActivity + 1000;

    sm.grantApproval(session, 'delete_file');

    Date.now = originalNow;

    assert.ok(session.lastActivityAt > initialActivity);
  });

  // ---------------------------------------------------------------------------
  // Approval Deny Tests
  // ---------------------------------------------------------------------------

  test('TC-SM-090: denyApproval removes from pending', () => {
    const sm = new SessionManager();
    const session = sm.getSession('room123', 'user1');

    sm.requestApproval(session, 'delete_file');
    sm.denyApproval(session, 'delete_file');

    assert.strictEqual(session.pendingApprovals.size, 0);
    assert.strictEqual(session.grantedApprovals.size, 0);
  });

  test('TC-SM-091: denyApproval logs approval_denied event', () => {
    const auditLog = new MockAuditLog();
    const sm = new SessionManager({ auditLog });
    const session = sm.getSession('room123', 'user1');

    sm.requestApproval(session, 'delete_file');
    sm.denyApproval(session, 'delete_file');

    const denyLogs = auditLog.getLogsByType('approval_denied');
    assert.strictEqual(denyLogs.length, 1);
    assert.strictEqual(denyLogs[0].data.operation, 'delete_file');
  });

  test('TC-SM-092: denyApproval works on non-existent approval', () => {
    const sm = new SessionManager();
    const session = sm.getSession('room123', 'user1');

    // Should not throw
    sm.denyApproval(session, 'delete_file');

    assert.strictEqual(session.pendingApprovals.size, 0);
  });

  // ---------------------------------------------------------------------------
  // Approval Check Tests
  // ---------------------------------------------------------------------------

  test('TC-SM-100: isApproved returns false for non-approved operation', () => {
    const sm = new SessionManager();
    const session = sm.getSession('room123', 'user1');

    const approved = sm.isApproved(session, 'delete_file');

    assert.strictEqual(approved, false);
  });

  test('TC-SM-101: isApproved returns true for granted approval', () => {
    const sm = new SessionManager();
    const session = sm.getSession('room123', 'user1');

    sm.grantApproval(session, 'delete_file');
    const approved = sm.isApproved(session, 'delete_file');

    assert.strictEqual(approved, true);
  });

  test('TC-SM-102: isApproved returns false for pending approval', () => {
    const sm = new SessionManager();
    const session = sm.getSession('room123', 'user1');

    sm.requestApproval(session, 'delete_file');
    const approved = sm.isApproved(session, 'delete_file');

    assert.strictEqual(approved, false);
  });

  test('TC-SM-103: isApproved respects target scoping', () => {
    const sm = new SessionManager();
    const session = sm.getSession('room123', 'user1');

    sm.grantApproval(session, 'delete_file', { target: '/tmp/file1' });

    assert.strictEqual(sm.isApproved(session, 'delete_file', { target: '/tmp/file1' }), true);
    assert.strictEqual(sm.isApproved(session, 'delete_file', { target: '/tmp/file2' }), false);
    assert.strictEqual(sm.isApproved(session, 'delete_file'), false);
  });

  // ---------------------------------------------------------------------------
  // Approval Expiry Tests
  // ---------------------------------------------------------------------------

  test('TC-SM-110: isApproved returns false for expired approval', () => {
    const sm = new SessionManager({ approvalExpiryMs: 1000 });
    const session = sm.getSession('room123', 'user1');

    const originalNow = Date.now;
    const baseTime = originalNow();

    // Grant approval at baseTime
    Date.now = () => baseTime;
    sm.grantApproval(session, 'delete_file');

    // Check immediately - should be approved
    assert.strictEqual(sm.isApproved(session, 'delete_file'), true);

    // Move time forward past expiry
    Date.now = () => baseTime + 1001;
    assert.strictEqual(sm.isApproved(session, 'delete_file'), false);

    Date.now = originalNow;
  });

  test('TC-SM-111: isApproved removes expired approval', () => {
    const sm = new SessionManager({ approvalExpiryMs: 1000 });
    const session = sm.getSession('room123', 'user1');

    const originalNow = Date.now;
    const baseTime = originalNow();

    Date.now = () => baseTime;
    sm.grantApproval(session, 'delete_file');

    Date.now = () => baseTime + 1001;
    sm.isApproved(session, 'delete_file');

    Date.now = originalNow;

    assert.strictEqual(session.grantedApprovals.size, 0);
  });

  test('TC-SM-112: isApproved logs approval_expired event', () => {
    const auditLog = new MockAuditLog();
    const sm = new SessionManager({ approvalExpiryMs: 1000, auditLog });
    const session = sm.getSession('room123', 'user1');

    const originalNow = Date.now;
    const baseTime = originalNow();

    Date.now = () => baseTime;
    sm.grantApproval(session, 'delete_file');

    Date.now = () => baseTime + 1001;
    sm.isApproved(session, 'delete_file');

    Date.now = originalNow;

    const expiredLogs = auditLog.getLogsByType('approval_expired');
    assert.strictEqual(expiredLogs.length, 1);
    assert.strictEqual(expiredLogs[0].data.operation, 'delete_file');
  });

  test('TC-SM-113: Approval valid within expiry window', () => {
    const sm = new SessionManager({ approvalExpiryMs: 5000 });
    const session = sm.getSession('room123', 'user1');

    const originalNow = Date.now;
    const baseTime = originalNow();

    Date.now = () => baseTime;
    sm.grantApproval(session, 'delete_file');

    // Check at various points within expiry window
    Date.now = () => baseTime + 1000;
    assert.strictEqual(sm.isApproved(session, 'delete_file'), true);

    Date.now = () => baseTime + 3000;
    assert.strictEqual(sm.isApproved(session, 'delete_file'), true);

    Date.now = () => baseTime + 4999;
    assert.strictEqual(sm.isApproved(session, 'delete_file'), true);

    Date.now = originalNow;
  });

  // ---------------------------------------------------------------------------
  // Approval Isolation Tests
  // ---------------------------------------------------------------------------

  test('TC-SM-120: Approvals are isolated between sessions', () => {
    const sm = new SessionManager();
    const session1 = sm.getSession('room123', 'user1');
    const session2 = sm.getSession('room123', 'user2');

    sm.grantApproval(session1, 'delete_file');

    assert.strictEqual(sm.isApproved(session1, 'delete_file'), true);
    assert.strictEqual(sm.isApproved(session2, 'delete_file'), false);
  });

  test('TC-SM-121: Pending approvals are isolated between sessions', () => {
    const sm = new SessionManager();
    const session1 = sm.getSession('room123', 'user1');
    const session2 = sm.getSession('room123', 'user2');

    sm.requestApproval(session1, 'delete_file');

    assert.strictEqual(session1.pendingApprovals.size, 1);
    assert.strictEqual(session2.pendingApprovals.size, 0);
  });

  // ---------------------------------------------------------------------------
  // Session Expiry Tests
  // ---------------------------------------------------------------------------

  test('TC-SM-130: getSession creates new session after timeout', () => {
    const sm = new SessionManager({ sessionTimeoutMs: 1000 });

    const originalNow = Date.now;
    const baseTime = originalNow();

    Date.now = () => baseTime;
    const session1 = sm.getSession('room123', 'user1');
    const sessionId1 = session1.id;

    // Move past timeout
    Date.now = () => baseTime + 1001;
    const session2 = sm.getSession('room123', 'user1');
    const sessionId2 = session2.id;

    Date.now = originalNow;

    assert.notStrictEqual(sessionId1, sessionId2);
  });

  test('TC-SM-131: Expired session data is not accessible', () => {
    const sm = new SessionManager({ sessionTimeoutMs: 1000 });

    const originalNow = Date.now;
    const baseTime = originalNow();

    Date.now = () => baseTime;
    const session1 = sm.getSession('room123', 'user1');
    sm.addContext(session1, 'user', 'Secret message');

    Date.now = () => baseTime + 1001;
    const session2 = sm.getSession('room123', 'user1');

    Date.now = originalNow;

    assert.strictEqual(session2.context.length, 0);
  });

  test('TC-SM-132: cleanup removes expired sessions', () => {
    const sm = new SessionManager({ sessionTimeoutMs: 1000 });

    const originalNow = Date.now;
    const baseTime = originalNow();

    Date.now = () => baseTime;
    sm.getSession('room123', 'user1');
    sm.getSession('room456', 'user2');

    Date.now = () => baseTime + 1001;
    const result = sm.cleanup();

    Date.now = originalNow;

    assert.strictEqual(result.sessions, 2);
  });

  test('TC-SM-133: cleanup removes expired approvals', () => {
    const sm = new SessionManager({ approvalExpiryMs: 1000 });

    const originalNow = Date.now;
    const baseTime = originalNow();

    Date.now = () => baseTime;
    const session = sm.getSession('room123', 'user1');
    sm.grantApproval(session, 'delete_file');
    sm.grantApproval(session, 'read_file');

    Date.now = () => baseTime + 1001;
    const result = sm.cleanup();

    Date.now = originalNow;

    assert.strictEqual(result.approvals, 2);
    assert.strictEqual(session.grantedApprovals.size, 0);
  });

  test('TC-SM-134: cleanup preserves active sessions', () => {
    const sm = new SessionManager({ sessionTimeoutMs: 5000 });

    const originalNow = Date.now;
    const baseTime = originalNow();

    Date.now = () => baseTime;
    sm.getSession('room123', 'user1');
    sm.getSession('room456', 'user2');

    Date.now = () => baseTime + 1000;
    const result = sm.cleanup();

    Date.now = originalNow;

    assert.strictEqual(result.sessions, 0);
    assert.strictEqual(sm.sessions.size, 2);
  });

  test('TC-SM-135: cleanup logs cleanup_completed event', () => {
    const auditLog = new MockAuditLog();
    const sm = new SessionManager({ sessionTimeoutMs: 1000, auditLog });

    const originalNow = Date.now;
    const baseTime = originalNow();

    Date.now = () => baseTime;
    sm.getSession('room123', 'user1');

    Date.now = () => baseTime + 1001;
    sm.cleanup();

    Date.now = originalNow;

    const cleanupLogs = auditLog.getLogsByType('cleanup_completed');
    assert.strictEqual(cleanupLogs.length, 1);
    assert.strictEqual(cleanupLogs[0].data.sessionsRemoved, 1);
  });

  // ---------------------------------------------------------------------------
  // Session Isolation Verification Tests
  // ---------------------------------------------------------------------------

  test('TC-SM-140: verifyIsolation returns true for different sessions', () => {
    const sm = new SessionManager();
    const session1 = sm.getSession('room123', 'user1');
    const session2 = sm.getSession('room123', 'user2');

    const isolated = sm.verifyIsolation(session1, session2);

    assert.strictEqual(isolated, true);
  });

  test('TC-SM-141: verifyIsolation returns false for same session', () => {
    const sm = new SessionManager();
    const session = sm.getSession('room123', 'user1');

    const isolated = sm.verifyIsolation(session, session);

    assert.strictEqual(isolated, false);
  });

  test('TC-SM-142: verifyIsolation checks context array isolation', () => {
    const sm = new SessionManager();
    const session1 = sm.getSession('room123', 'user1');
    const session2 = sm.getSession('room123', 'user2');

    // Verify context arrays are different objects
    assert.notStrictEqual(session1.context, session2.context);
    assert.strictEqual(sm.verifyIsolation(session1, session2), true);
  });

  test('TC-SM-143: verifyIsolation checks credentials set isolation', () => {
    const sm = new SessionManager();
    const session1 = sm.getSession('room123', 'user1');
    const session2 = sm.getSession('room123', 'user2');

    // Verify credential sets are different objects
    assert.notStrictEqual(session1.credentialsAccessed, session2.credentialsAccessed);
    assert.strictEqual(sm.verifyIsolation(session1, session2), true);
  });

  test('TC-SM-144: verifyIsolation checks pending approvals isolation', () => {
    const sm = new SessionManager();
    const session1 = sm.getSession('room123', 'user1');
    const session2 = sm.getSession('room123', 'user2');

    // Verify pending approvals maps are different objects
    assert.notStrictEqual(session1.pendingApprovals, session2.pendingApprovals);
    assert.strictEqual(sm.verifyIsolation(session1, session2), true);
  });

  test('TC-SM-145: verifyIsolation checks granted approvals isolation', () => {
    const sm = new SessionManager();
    const session1 = sm.getSession('room123', 'user1');
    const session2 = sm.getSession('room123', 'user2');

    // Verify granted approvals maps are different objects
    assert.notStrictEqual(session1.grantedApprovals, session2.grantedApprovals);
    assert.strictEqual(sm.verifyIsolation(session1, session2), true);
  });

  // ---------------------------------------------------------------------------
  // Active Sessions Tests
  // ---------------------------------------------------------------------------

  test('TC-SM-150: getActiveSessions returns all active sessions', () => {
    const sm = new SessionManager();

    sm.getSession('room123', 'user1');
    sm.getSession('room456', 'user2');
    sm.getSession('room789', 'user3');

    const active = sm.getActiveSessions();

    assert.strictEqual(active.length, 3);
  });

  test('TC-SM-151: getActiveSessions excludes expired sessions', () => {
    const sm = new SessionManager({ sessionTimeoutMs: 1000 });

    const originalNow = Date.now;
    const baseTime = originalNow();

    Date.now = () => baseTime;
    sm.getSession('room123', 'user1');
    sm.getSession('room456', 'user2');

    Date.now = () => baseTime + 1001;

    const active = sm.getActiveSessions();

    Date.now = originalNow;

    assert.strictEqual(active.length, 0);
  });

  test('TC-SM-152: getActiveSessions returns empty array when no sessions', () => {
    const sm = new SessionManager();

    const active = sm.getActiveSessions();

    assert.ok(Array.isArray(active));
    assert.strictEqual(active.length, 0);
  });

  // ---------------------------------------------------------------------------
  // Force Expire Session Tests
  // ---------------------------------------------------------------------------

  test('TC-SM-160: expireSession removes session by ID', () => {
    const sm = new SessionManager();
    const session = sm.getSession('room123', 'user1');

    const result = sm.expireSession(session.id);

    assert.strictEqual(result, true);
    assert.strictEqual(sm.sessions.size, 0);
    assert.strictEqual(sm.sessionIndex.size, 0);
  });

  test('TC-SM-161: expireSession returns false for non-existent ID', () => {
    const sm = new SessionManager();

    const result = sm.expireSession('non-existent-id');

    assert.strictEqual(result, false);
  });

  test('TC-SM-162: expireSession logs session_expired event', () => {
    const auditLog = new MockAuditLog();
    const sm = new SessionManager({ auditLog });
    const session = sm.getSession('room123', 'user1');

    sm.expireSession(session.id);

    const expiredLogs = auditLog.getLogsByType('session_expired');
    assert.strictEqual(expiredLogs.length, 1);
    assert.strictEqual(expiredLogs[0].data.sessionId, session.id);
    assert.strictEqual(expiredLogs[0].data.forced, true);
  });

  test('TC-SM-163: Expired session cannot be retrieved', () => {
    const sm = new SessionManager();
    const session = sm.getSession('room123', 'user1');
    const sessionId = session.id;

    sm.expireSession(sessionId);

    const retrieved = sm.getSessionById(sessionId);
    assert.strictEqual(retrieved, null);
  });

  // ---------------------------------------------------------------------------
  // Get Session By ID Tests
  // ---------------------------------------------------------------------------

  test('TC-SM-170: getSessionById returns session by ID', () => {
    const sm = new SessionManager();
    const session = sm.getSession('room123', 'user1');

    const retrieved = sm.getSessionById(session.id);

    assert.strictEqual(retrieved.id, session.id);
    assert.strictEqual(retrieved, session);
  });

  test('TC-SM-171: getSessionById returns null for non-existent ID', () => {
    const sm = new SessionManager();

    const retrieved = sm.getSessionById('non-existent-id');

    assert.strictEqual(retrieved, null);
  });

  test('TC-SM-172: getSessionById returns null for expired session', () => {
    const sm = new SessionManager({ sessionTimeoutMs: 1000 });

    const originalNow = Date.now;
    const baseTime = originalNow();

    Date.now = () => baseTime;
    const session = sm.getSession('room123', 'user1');
    const sessionId = session.id;

    Date.now = () => baseTime + 1001;
    const retrieved = sm.getSessionById(sessionId);

    Date.now = originalNow;

    assert.strictEqual(retrieved, null);
  });

  test('TC-SM-173: getSessionById cleans up orphaned index', () => {
    const sm = new SessionManager();

    // Manually create orphaned index entry
    sm.sessionIndex.set('orphaned-id', 'invalid-key');

    const retrieved = sm.getSessionById('orphaned-id');

    assert.strictEqual(retrieved, null);
    assert.ok(!sm.sessionIndex.has('orphaned-id'));
  });

  // ---------------------------------------------------------------------------
  // Cross-Session Leak Prevention Tests
  // ---------------------------------------------------------------------------

  test('TC-SM-180: No context leakage between sessions', () => {
    const sm = new SessionManager();
    const session1 = sm.getSession('room123', 'user1');
    const session2 = sm.getSession('room123', 'user2');

    sm.addContext(session1, 'user', 'Private data for user1');

    const context1 = sm.getContext(session1);
    const context2 = sm.getContext(session2);

    assert.strictEqual(context1.length, 1);
    assert.strictEqual(context2.length, 0);

    // Verify no shared references
    context1.push({ role: 'test', content: 'test', timestamp: Date.now() });
    assert.strictEqual(sm.getContext(session2).length, 0);
  });

  test('TC-SM-181: No credential tracking leakage between sessions', () => {
    const sm = new SessionManager();
    const session1 = sm.getSession('room123', 'user1');
    const session2 = sm.getSession('room123', 'user2');

    sm.recordCredentialAccess(session1, 'secret_key');

    assert.ok(session1.credentialsAccessed.has('secret_key'));
    assert.ok(!session2.credentialsAccessed.has('secret_key'));

    // Verify no shared references
    session1.credentialsAccessed.add('another_key');
    assert.ok(!session2.credentialsAccessed.has('another_key'));
  });

  test('TC-SM-182: No approval leakage between sessions', () => {
    const sm = new SessionManager();
    const session1 = sm.getSession('room123', 'user1');
    const session2 = sm.getSession('room123', 'user2');

    sm.grantApproval(session1, 'delete_file');

    assert.strictEqual(session1.grantedApprovals.size, 1);
    assert.strictEqual(session2.grantedApprovals.size, 0);

    // Verify no shared references
    sm.grantApproval(session1, 'write_file');
    assert.strictEqual(session2.grantedApprovals.size, 0);
  });

  test('TC-SM-183: Session expiry does not affect other sessions', () => {
    const sm = new SessionManager({ sessionTimeoutMs: 1000 });

    const originalNow = Date.now;
    const baseTime = originalNow();

    Date.now = () => baseTime;
    const session1 = sm.getSession('room123', 'user1');
    sm.addContext(session1, 'user', 'Message 1');

    Date.now = () => baseTime + 500;
    const session2 = sm.getSession('room456', 'user2');
    sm.addContext(session2, 'user', 'Message 2');

    Date.now = () => baseTime + 1001;
    // session1 should be expired, session2 still active

    const retrieved1 = sm.getSessionById(session1.id);
    const retrieved2 = sm.getSessionById(session2.id);

    Date.now = originalNow;

    assert.strictEqual(retrieved1, null);
    assert.ok(retrieved2 !== null);
    assert.strictEqual(retrieved2.context.length, 1);
  });

  // ---------------------------------------------------------------------------
  // Edge Cases and Error Handling
  // ---------------------------------------------------------------------------

  test('TC-SM-190: Handles empty roomToken', () => {
    const sm = new SessionManager();

    const session = sm.getSession('', 'user1');

    assert.ok(session);
    assert.strictEqual(session.roomToken, '');
  });

  test('TC-SM-191: Handles empty userId', () => {
    const sm = new SessionManager();

    const session = sm.getSession('room123', '');

    assert.ok(session);
    assert.strictEqual(session.userId, '');
  });

  test('TC-SM-192: Handles special characters in roomToken', () => {
    const sm = new SessionManager();

    const session = sm.getSession('room:123:abc', 'user1');

    assert.ok(session);
    assert.strictEqual(session.roomToken, 'room:123:abc');
  });

  test('TC-SM-193: Handles very long context entries', () => {
    const sm = new SessionManager();
    const session = sm.getSession('room123', 'user1');

    const longContent = 'x'.repeat(100000);
    sm.addContext(session, 'user', longContent);

    assert.strictEqual(session.context.length, 1);
    assert.strictEqual(session.context[0].content, longContent);
  });

  test('TC-SM-194: Handles multiple cleanup calls', () => {
    const sm = new SessionManager({ sessionTimeoutMs: 1000 });

    const originalNow = Date.now;
    const baseTime = originalNow();

    Date.now = () => baseTime;
    sm.getSession('room123', 'user1');

    Date.now = () => baseTime + 1001;
    const result1 = sm.cleanup();
    const result2 = sm.cleanup();

    Date.now = originalNow;

    assert.strictEqual(result1.sessions, 1);
    assert.strictEqual(result2.sessions, 0);
  });

  test('TC-SM-195: Cleanup does not log when nothing removed', () => {
    const auditLog = new MockAuditLog();
    const sm = new SessionManager({ auditLog });

    sm.cleanup();

    const cleanupLogs = auditLog.getLogsByType('cleanup_completed');
    assert.strictEqual(cleanupLogs.length, 0);
  });

  // ---------------------------------------------------------------------------
  // Pending Clarification Tests
  // ---------------------------------------------------------------------------

  test('TC-SM-200: setPendingClarification() stores object on session', () => {
    const sm = new SessionManager();
    const session = sm.getSession('roomClar', 'userA');

    const before = Date.now();
    sm.setPendingClarification(session, {
      executor: 'calendar',
      action: 'create_event',
      missingFields: ['date'],
      collectedFields: {},
      originalMessage: 'Book a meeting',
    });
    const after = Date.now();

    assert.ok(session.pendingClarification !== null, 'pendingClarification should be set');
    assert.strictEqual(session.pendingClarification.executor, 'calendar');
    assert.strictEqual(session.pendingClarification.action, 'create_event');
    assert.ok(
      session.pendingClarification.askedAt >= before &&
      session.pendingClarification.askedAt <= after,
      'askedAt should be a recent timestamp'
    );
  });

  test('TC-SM-201: getPendingClarification() returns stored object', () => {
    const sm = new SessionManager();
    const session = sm.getSession('roomClar', 'userB');

    sm.setPendingClarification(session, {
      executor: 'email',
      action: 'send',
      missingFields: ['recipient'],
      collectedFields: {},
      originalMessage: 'Send an email',
    });

    const result = sm.getPendingClarification(session);

    assert.ok(result !== null, 'should return the stored clarification');
    assert.strictEqual(result.executor, 'email');
    assert.strictEqual(result.action, 'send');
    assert.ok(Array.isArray(result.missingFields));
    assert.strictEqual(result.missingFields[0], 'recipient');
  });

  test('TC-SM-202: getPendingClarification() returns null when nothing pending', () => {
    const sm = new SessionManager();
    const session = sm.getSession('roomClar', 'userC');

    // Fresh session — pendingClarification starts as null
    const result = sm.getPendingClarification(session);

    assert.strictEqual(result, null);
  });

  test('TC-SM-203: getPendingClarification() returns null when expired', () => {
    const sm = new SessionManager({ approvalExpiryMs: 300000 }); // 5-min TTL
    const session = sm.getSession('roomClar', 'userD');

    sm.setPendingClarification(session, {
      executor: 'calendar',
      action: 'delete_event',
      missingFields: ['eventId'],
      collectedFields: {},
      originalMessage: 'Delete the meeting',
    });

    // Simulate expiry: push askedAt 400 seconds into the past (past 300s TTL)
    session.pendingClarification.askedAt = Date.now() - 400000;

    const result = sm.getPendingClarification(session);

    assert.strictEqual(result, null, 'expired clarification should return null');
    assert.strictEqual(session.pendingClarification, null, 'expired clarification should be cleared');
  });

  test('TC-SM-204: clearPendingClarification() sets to null', () => {
    const sm = new SessionManager();
    const session = sm.getSession('roomClar', 'userE');

    sm.setPendingClarification(session, {
      executor: 'calendar',
      action: 'create_event',
      missingFields: ['time'],
      collectedFields: {},
      originalMessage: 'Schedule something',
    });

    assert.ok(session.pendingClarification !== null, 'should be set before clear');

    sm.clearPendingClarification(session);

    assert.strictEqual(session.pendingClarification, null, 'should be null after clear');
    assert.strictEqual(sm.getPendingClarification(session), null);
  });

  test('TC-SM-205: Clarification is session-scoped', () => {
    const sm = new SessionManager();
    const session1 = sm.getSession('roomClar', 'userF');
    const session2 = sm.getSession('roomClar', 'userG');

    sm.setPendingClarification(session1, {
      executor: 'calendar',
      action: 'create_event',
      missingFields: ['date'],
      collectedFields: {},
      originalMessage: 'Book meeting',
    });

    // session2 must not see session1's clarification
    assert.ok(sm.getPendingClarification(session1) !== null, 'session1 should have clarification');
    assert.strictEqual(sm.getPendingClarification(session2), null, 'session2 should have no clarification');

    // Clearing session1 must not affect session2 (and vice-versa)
    sm.clearPendingClarification(session1);
    assert.strictEqual(sm.getPendingClarification(session1), null);
    assert.strictEqual(sm.getPendingClarification(session2), null);
  });

  test('TC-SM-206: cleanup() clears expired clarifications on active sessions', () => {
    // Use a short sessionTimeout so the session stays alive but use direct
    // timestamp manipulation to make the clarification appear expired.
    const sm = new SessionManager({ sessionTimeoutMs: 3600000, approvalExpiryMs: 300000 });
    const session = sm.getSession('roomClar', 'userH');

    sm.setPendingClarification(session, {
      executor: 'email',
      action: 'send',
      missingFields: ['recipient'],
      collectedFields: {},
      originalMessage: 'Send a note',
    });

    // Push askedAt into the past beyond the 5-min TTL
    session.pendingClarification.askedAt = Date.now() - 400000;

    // Session is still active (lastActivityAt is recent); cleanup should only
    // clear the stale clarification, not remove the session.
    const result = sm.cleanup();

    assert.strictEqual(result.sessions, 0, 'active session should not be removed');
    assert.strictEqual(session.pendingClarification, null, 'expired clarification should be cleared by cleanup');
  });

  // ---------------------------------------------------------------------------
  // Action Ledger Tests (Layer 3)
  // ---------------------------------------------------------------------------

  test('TC-SM-210: recordAction() stores action on session', () => {
    const sm = new SessionManager();
    const session = sm.getSession('roomLedger', 'userA');

    const before = Date.now();
    sm.recordAction(session, { type: 'calendar_create', refs: { uid: 'evt-1', title: 'Test' } });
    const after = Date.now();

    assert.strictEqual(session.actionLedger.length, 1);
    assert.strictEqual(session.actionLedger[0].type, 'calendar_create');
    assert.strictEqual(session.actionLedger[0].refs.uid, 'evt-1');
    assert.ok(session.actionLedger[0].timestamp >= before && session.actionLedger[0].timestamp <= after);
  });

  test('TC-SM-211: getLastAction() returns most recent action', () => {
    const sm = new SessionManager();
    const session = sm.getSession('roomLedger', 'userB');

    sm.recordAction(session, { type: 'calendar_create', refs: { uid: 'evt-1' } });
    sm.recordAction(session, { type: 'calendar_delete', refs: { uid: 'evt-2' } });

    const last = sm.getLastAction(session);
    assert.strictEqual(last.type, 'calendar_delete');
    assert.strictEqual(last.refs.uid, 'evt-2');
  });

  test('TC-SM-212: getLastAction() returns null when ledger empty', () => {
    const sm = new SessionManager();
    const session = sm.getSession('roomLedger', 'userC');

    assert.strictEqual(sm.getLastAction(session), null);
  });

  test('TC-SM-213: getLastAction() filters by domain prefix', () => {
    const sm = new SessionManager();
    const session = sm.getSession('roomLedger', 'userD');

    sm.recordAction(session, { type: 'calendar_create', refs: { uid: 'evt-1' } });
    sm.recordAction(session, { type: 'file_write', refs: { path: '/test.txt' } });
    sm.recordAction(session, { type: 'calendar_delete', refs: { uid: 'evt-2' } });

    const lastFile = sm.getLastAction(session, 'file');
    assert.strictEqual(lastFile.type, 'file_write');
    assert.strictEqual(lastFile.refs.path, '/test.txt');

    const lastCalendar = sm.getLastAction(session, 'calendar');
    assert.strictEqual(lastCalendar.type, 'calendar_delete');
  });

  test('TC-SM-214: getLastAction() returns null for unmatched prefix', () => {
    const sm = new SessionManager();
    const session = sm.getSession('roomLedger', 'userE');

    sm.recordAction(session, { type: 'calendar_create', refs: {} });

    assert.strictEqual(sm.getLastAction(session, 'file'), null);
  });

  test('TC-SM-215: getRecentActions() returns all actions', () => {
    const sm = new SessionManager();
    const session = sm.getSession('roomLedger', 'userF');

    sm.recordAction(session, { type: 'calendar_create', refs: {} });
    sm.recordAction(session, { type: 'file_write', refs: {} });
    sm.recordAction(session, { type: 'wiki_write', refs: {} });

    const all = sm.getRecentActions(session);
    assert.strictEqual(all.length, 3);
  });

  test('TC-SM-216: getRecentActions() filters by domain prefix', () => {
    const sm = new SessionManager();
    const session = sm.getSession('roomLedger', 'userG');

    sm.recordAction(session, { type: 'calendar_create', refs: {} });
    sm.recordAction(session, { type: 'file_write', refs: {} });
    sm.recordAction(session, { type: 'calendar_delete', refs: {} });

    const calActions = sm.getRecentActions(session, 'calendar');
    assert.strictEqual(calActions.length, 2);
    assert.strictEqual(calActions[0].type, 'calendar_create');
    assert.strictEqual(calActions[1].type, 'calendar_delete');
  });

  test('TC-SM-217: getRecentActions() returns empty for no session', () => {
    const sm = new SessionManager();
    assert.deepStrictEqual(sm.getRecentActions(null), []);
  });

  test('TC-SM-218: FIFO cap at 10 entries', () => {
    const sm = new SessionManager();
    const session = sm.getSession('roomLedger', 'userH');

    for (let i = 0; i < 15; i++) {
      sm.recordAction(session, { type: `action_${i}`, refs: { i } });
    }

    assert.strictEqual(session.actionLedger.length, 10);
    assert.strictEqual(session.actionLedger[0].type, 'action_5');
    assert.strictEqual(session.actionLedger[9].type, 'action_14');
  });

  test('TC-SM-219: Action ledger is session-scoped (no leakage)', () => {
    const sm = new SessionManager();
    const session1 = sm.getSession('roomLedger', 'userI');
    const session2 = sm.getSession('roomLedger', 'userJ');

    sm.recordAction(session1, { type: 'calendar_create', refs: { uid: 'evt-1' } });

    assert.strictEqual(sm.getRecentActions(session1).length, 1);
    assert.strictEqual(sm.getRecentActions(session2).length, 0);
  });

  test('TC-SM-220: recordAction() ignores null session or missing type', () => {
    const sm = new SessionManager();
    const session = sm.getSession('roomLedger', 'userK');

    sm.recordAction(null, { type: 'test', refs: {} });
    sm.recordAction(session, null);
    sm.recordAction(session, { refs: {} }); // no type

    assert.strictEqual(session.actionLedger.length, 0);
  });

  test('TC-SM-221: recordAction() initializes ledger if missing', () => {
    const sm = new SessionManager();
    const session = sm.getSession('roomLedger', 'userL');
    delete session.actionLedger; // simulate legacy session

    sm.recordAction(session, { type: 'calendar_create', refs: {} });

    assert.strictEqual(session.actionLedger.length, 1);
  });

  // ---------------------------------------------------------------------------
  // Summary
  // ---------------------------------------------------------------------------

  console.log('\n=== SessionManager Tests Complete ===\n');
  summary();
  exitWithCode();
}

// Run all tests
runTests();
