/*
 * MoltAgent - Sovereign AI Security Layer
 * Copyright (C) 2026 MoltAgent Contributors
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

const crypto = require('crypto');
const { EventEmitter } = require('events');

/**
 * SessionManager
 *
 * Tracks ephemeral state per NC Talk room+user pair. Enforces session isolation,
 * manages time-limited approvals, prevents cross-session context leakage.
 *
 * Extends EventEmitter to emit lifecycle events:
 * - 'sessionExpired' (session) — fired during cleanup() for each expired session
 *
 * Critical isolation guarantees:
 * - Never share context between sessions
 * - Never share credential tracking between sessions
 * - Approvals are session-scoped and time-limited
 * - Sessions expire after configurable inactivity period
 *
 * Session schema:
 * {
 *   id: 'uuid',                    // crypto.randomUUID()
 *   roomToken: 'abc123',           // NC Talk room token
 *   userId: 'fu',                  // NC user ID
 *   createdAt: timestamp,
 *   lastActivityAt: timestamp,
 *   context: [],                   // Conversation history [{role, content, timestamp}]
 *   credentialsAccessed: Set(),
 *   pendingApprovals: Map(),       // key → {requestedAt, operation, context}
 *   grantedApprovals: Map()        // key → {grantedAt, expiresAt, context}
 * }
 *
 * @class SessionManager
 */
class SessionManager extends EventEmitter {
  /**
   * Create a SessionManager instance
   *
   * @param {Object} options - Configuration options
   * @param {number} [options.sessionTimeoutMs=86400000] - Session inactivity timeout (default 24h)
   * @param {number} [options.idleTimeoutMs=1800000] - Session idle timeout for warm memory consolidation (default 30min)
   * @param {number} [options.approvalExpiryMs=300000] - Approval time-to-live (default 5min)
   * @param {number} [options.maxContextLength=100] - Maximum context entries per session
   * @param {Object} [options.auditLog] - Optional audit logger
   */
  constructor(options = {}) {
    super();
    this.sessionTimeoutMs = options.sessionTimeoutMs || 86400000; // 24 hours
    this.idleTimeoutMs = options.idleTimeoutMs || 1800000; // 30 minutes
    this.approvalExpiryMs = options.approvalExpiryMs || 300000; // 5 minutes
    this.maxContextLength = options.maxContextLength || 100;
    this.auditLog = options.auditLog || null;

    // Storage: sessionKey → session
    this.sessions = new Map();
    // Index: sessionId → sessionKey
    this.sessionIndex = new Map();
  }

  /**
   * Generate session key from roomToken and userId
   *
   * @private
   * @param {string} roomToken - NC Talk room token
   * @param {string} userId - NC user ID
   * @returns {string} Session key
   */
  _getSessionKey(roomToken, userId) {
    return `${roomToken}:${userId}`;
  }

  /**
   * Generate approval key from operation and context
   *
   * @private
   * @param {string} operation - Operation name
   * @param {Object} [context] - Optional context (may contain target)
   * @returns {string} Approval key
   */
  _getApprovalKey(operation, context = {}) {
    if (context && context.target) {
      return `${operation}:${context.target}`;
    }
    return operation;
  }

  /**
   * Get or create session for room+user pair
   *
   * @param {string} roomToken - NC Talk room token
   * @param {string} userId - NC user ID
   * @returns {Object} Session object
   */
  getSession(roomToken, userId) {
    const sessionKey = this._getSessionKey(roomToken, userId);
    const now = Date.now();

    // Check if session exists
    if (this.sessions.has(sessionKey)) {
      const session = this.sessions.get(sessionKey);

      // Check if session expired
      if (now - session.lastActivityAt > this.sessionTimeoutMs) {
        // Session expired, clean it up and create new one
        this._removeSession(sessionKey);
      } else {
        // Update activity timestamp
        session.lastActivityAt = now;
        return session;
      }
    }

    // Create new session
    const session = {
      id: crypto.randomUUID(),
      roomToken,
      userId,
      createdAt: now,
      lastActivityAt: now,
      context: [],
      credentialsAccessed: new Set(),
      pendingApprovals: new Map(),
      grantedApprovals: new Map(),
      pendingClarification: null,
      artifactFocus: null,
      actionLedger: [],
    };

    this.sessions.set(sessionKey, session);
    this.sessionIndex.set(session.id, sessionKey);

    if (this.auditLog) {
      this.auditLog.log('session_created', {
        sessionId: session.id,
        roomToken,
        userId,
        timestamp: now,
      });
    }

    return session;
  }

  /**
   * Add context entry to session conversation history.
   * Returns a flush signal when context reaches 80% of maxContextLength,
   * allowing the caller to prompt the agent to persist important facts
   * before truncation occurs.
   *
   * When truncation happens (context exceeds maxContextLength), the first 2
   * entries (system prompt + initial context) are preserved, a system marker
   * is inserted, and the most recent entries are kept.
   *
   * @param {Object} session - Session object
   * @param {string} role - Role (e.g., 'user', 'assistant')
   * @param {string} content - Message content
   * @param {Object} [meta] - Optional metadata (Layer 1: provenance tagging)
   * @param {Array} [meta.provenance] - Per-segment provenance annotations
   * @param {number} [meta.groundedRatio] - Fraction of grounded segments (0.0-1.0)
   * @returns {{ flushNeeded: boolean }} Flush signal
   */
  addContext(session, role, content, meta) {
    const now = Date.now();

    const entry = {
      role,
      content,
      timestamp: now,
    };

    // Layer 1 Bullshit Protection: attach provenance metadata to assistant messages
    if (meta && meta.provenance) {
      entry.provenance = meta.provenance;
      entry.groundedRatio = meta.groundedRatio;
    }

    session.context.push(entry);

    session.lastActivityAt = now;

    // Log first context entry per session to confirm map registration
    if (session.context.length === 1) {
      const inMap = this.sessions.has(this._getSessionKey(session.roomToken, session.userId));
      console.log(`[SessionManager] First context for session ${session.id} (room=${session.roomToken}, inMap=${inMap}, mapSize=${this.sessions.size})`);
    }

    // Check if approaching context limit (80% threshold)
    const threshold = Math.floor(this.maxContextLength * 0.8);

    if (session.context.length === threshold && !session._flushRequested) {
      session._flushRequested = true;
      return { flushNeeded: true };
    }

    // Truncate if over limit
    if (session.context.length > this.maxContextLength) {
      const removed = session.context.length - this.maxContextLength;

      // Smart truncation: preserve first 2 entries + system marker + recent
      // Only viable when maxContextLength >= 5 (2 preserved + 1 marker + at least 2 recent)
      if (this.maxContextLength >= 5) {
        const keep = 2; // System prompt + initial context
        const marker = {
          role: 'system',
          content: '[Earlier conversation was summarized. Key context preserved in wiki.]',
          timestamp: now,
        };
        const recentCount = this.maxContextLength - keep - 1; // -1 for the marker
        session.context = [
          ...session.context.slice(0, keep),
          marker,
          ...session.context.slice(-recentCount),
        ];
      } else {
        // Fallback for tiny maxContextLength: simple oldest-first removal
        session.context.splice(0, session.context.length - this.maxContextLength);
      }

      // Reset flush flag so it can trigger again on the next cycle
      session._flushRequested = false;

      if (this.auditLog) {
        this.auditLog.log('context_trimmed', {
          sessionId: session.id,
          entriesRemoved: removed,
          timestamp: now,
        });
      }
    }

    return { flushNeeded: false };
  }

  /**
   * Get conversation context for session
   *
   * @param {Object} session - Session object
   * @returns {Array} Context array
   */
  getContext(session) {
    return session.context;
  }

  /**
   * Record credential access for session
   * Returns true if this is the FIRST access to this credential in this session
   *
   * @param {Object} session - Session object
   * @param {string} credentialName - Credential identifier
   * @returns {boolean} True if first access, false if already accessed
   */
  recordCredentialAccess(session, credentialName) {
    const isFirstAccess = !session.credentialsAccessed.has(credentialName);

    session.credentialsAccessed.add(credentialName);
    session.lastActivityAt = Date.now();

    if (this.auditLog && isFirstAccess) {
      this.auditLog.log('credential_accessed', {
        sessionId: session.id,
        credentialName,
        isFirstAccess,
        timestamp: Date.now(),
      });
    }

    return isFirstAccess;
  }

  /**
   * Check if operation is approved for session
   * Respects approval expiry time
   *
   * @param {Object} session - Session object
   * @param {string} operation - Operation name
   * @param {Object} [context] - Optional context (may contain target)
   * @returns {boolean} True if approved and not expired
   */
  isApproved(session, operation, context = {}) {
    const approvalKey = this._getApprovalKey(operation, context);
    const now = Date.now();

    if (!session.grantedApprovals.has(approvalKey)) {
      return false;
    }

    const approval = session.grantedApprovals.get(approvalKey);

    // Check if expired
    if (now > approval.expiresAt) {
      // Remove expired approval
      session.grantedApprovals.delete(approvalKey);

      if (this.auditLog) {
        this.auditLog.log('approval_expired', {
          sessionId: session.id,
          operation,
          context,
          approvalKey,
          timestamp: now,
        });
      }

      return false;
    }

    return true;
  }

  /**
   * Request approval for operation
   * Creates pending approval entry
   *
   * @param {Object} session - Session object
   * @param {string} operation - Operation name
   * @param {Object} [context] - Optional context (may contain target)
   * @returns {string} Approval request ID
   */
  requestApproval(session, operation, context = {}) {
    const approvalKey = this._getApprovalKey(operation, context);
    const now = Date.now();
    const requestId = crypto.randomUUID();

    session.pendingApprovals.set(approvalKey, {
      requestId,
      requestedAt: now,
      operation,
      context,
    });

    session.lastActivityAt = now;

    if (this.auditLog) {
      this.auditLog.log('approval_requested', {
        sessionId: session.id,
        requestId,
        operation,
        context,
        approvalKey,
        timestamp: now,
      });
    }

    return requestId;
  }

  /**
   * Grant approval for operation
   * Moves from pending to granted with expiry timestamp
   *
   * @param {Object} session - Session object
   * @param {string} operation - Operation name
   * @param {Object} [context] - Optional context (may contain target)
   */
  grantApproval(session, operation, context = {}) {
    const approvalKey = this._getApprovalKey(operation, context);
    const now = Date.now();

    // Remove from pending (if exists)
    session.pendingApprovals.delete(approvalKey);

    // Add to granted with expiry
    session.grantedApprovals.set(approvalKey, {
      grantedAt: now,
      expiresAt: now + this.approvalExpiryMs,
      context,
    });

    session.lastActivityAt = now;

    if (this.auditLog) {
      this.auditLog.log('approval_granted', {
        sessionId: session.id,
        operation,
        context,
        approvalKey,
        expiresAt: now + this.approvalExpiryMs,
        timestamp: now,
      });
    }
  }

  /**
   * Deny approval for operation
   * Removes from pending approvals
   *
   * @param {Object} session - Session object
   * @param {string} operation - Operation name
   * @param {Object} [context] - Optional context (may contain target)
   */
  denyApproval(session, operation, context = {}) {
    const approvalKey = this._getApprovalKey(operation, context);
    const now = Date.now();

    session.pendingApprovals.delete(approvalKey);
    session.lastActivityAt = now;

    if (this.auditLog) {
      this.auditLog.log('approval_denied', {
        sessionId: session.id,
        operation,
        context,
        approvalKey,
        timestamp: now,
      });
    }
  }

  /**
   * Store a pending clarification on a session.
   * The clarification object tracks which executor asked the question and
   * what fields are still missing so the next user reply can bypass
   * classification and resume directly.
   *
   * @param {Object} session - Session object
   * @param {Object} clarification - { executor, action, missingFields, collectedFields, originalMessage }
   */
  setPendingClarification(session, clarification) {
    if (!session || !clarification) return;
    session.pendingClarification = { ...clarification, askedAt: Date.now() };
    session.lastActivityAt = Date.now();
  }

  /**
   * Retrieve a pending clarification from a session.
   * Returns null if nothing is pending or if the clarification has expired
   * (older than approvalExpiryMs, default 5 minutes).
   *
   * @param {Object} session - Session object
   * @returns {Object|null} Stored clarification or null
   */
  getPendingClarification(session) {
    if (!session || !session.pendingClarification) return null;
    const age = Date.now() - session.pendingClarification.askedAt;
    if (age > this.approvalExpiryMs) {
      session.pendingClarification = null;
      return null;
    }
    return session.pendingClarification;
  }

  /**
   * Clear a pending clarification from a session.
   *
   * @param {Object} session - Session object
   */
  clearPendingClarification(session) {
    if (!session) return;
    session.pendingClarification = null;
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Artifact Focus
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Set the active artifact focus for this session.
   * When the user is discussing a specific card, wiki page, file, or event,
   * this records that artifact so subsequent messages are grounded to it.
   *
   * @param {Object} session
   * @param {Object} focus - { type, id, boardId?, stackId?, title, description?, source }
   */
  setArtifactFocus(session, focus) {
    if (!session || !focus || !focus.type || focus.id == null) return;
    session.artifactFocus = {
      type: focus.type,
      id: focus.id,
      boardId: focus.boardId || null,
      stackId: focus.stackId || null,
      title: focus.title || '',
      description: typeof focus.description === 'string' ? focus.description.substring(0, 500) : null,
      source: focus.source || 'tool_result',
      setAt: Date.now(),
    };
  }

  /**
   * Get the current artifact focus, or null if expired.
   * Focus expires after maxAgeMs of inactivity (no messages in the session).
   * If the user is still actively messaging, focus stays valid regardless of age.
   *
   * @param {Object} session
   * @param {number} [maxAgeMs=600000] - 10 minutes default
   * @returns {Object|null}
   */
  getArtifactFocus(session, maxAgeMs = 600000) {
    if (!session || !session.artifactFocus) return null;

    const lastActivity = session.lastActivityAt || session.artifactFocus.setAt;
    const age = Date.now() - Math.max(session.artifactFocus.setAt, lastActivity);
    if (age > maxAgeMs) {
      session.artifactFocus = null;
      return null;
    }

    return session.artifactFocus;
  }

  /**
   * Clear the active artifact focus.
   * @param {Object} session
   */
  clearArtifactFocus(session) {
    if (session) session.artifactFocus = null;
  }

  // ---------------------------------------------------------------------------
  // Layer 3: Action Ledger
  // ---------------------------------------------------------------------------

  /**
   * Record an action in the session's ledger.
   * @param {Object} session
   * @param {Object} record - { type: string, refs: Object }
   */
  recordAction(session, record) {
    if (!session || !record || !record.type) return;
    if (!session.actionLedger) session.actionLedger = [];

    session.actionLedger.push({
      ...record,
      timestamp: Date.now()
    });

    // FIFO: keep only last 10 actions
    if (session.actionLedger.length > 10) {
      session.actionLedger = session.actionLedger.slice(-10);
    }
  }

  /**
   * Get the most recent action matching a domain prefix.
   * @param {Object} session
   * @param {string} [domainPrefix] - e.g. 'calendar', 'deck', 'file'
   * @returns {Object|null}
   */
  getLastAction(session, domainPrefix) {
    if (!session || !session.actionLedger || session.actionLedger.length === 0) return null;

    if (!domainPrefix) {
      return session.actionLedger[session.actionLedger.length - 1];
    }

    for (let i = session.actionLedger.length - 1; i >= 0; i--) {
      if (session.actionLedger[i].type.startsWith(domainPrefix)) {
        return session.actionLedger[i];
      }
    }
    return null;
  }

  /**
   * Get all recent actions, optionally filtered by domain.
   * @param {Object} session
   * @param {string} [domainPrefix]
   * @returns {Array}
   */
  getRecentActions(session, domainPrefix) {
    if (!session || !session.actionLedger) return [];
    if (!domainPrefix) return [...session.actionLedger];
    return session.actionLedger.filter(a => a.type.startsWith(domainPrefix));
  }

  /**
   * Clean up expired sessions and approvals.
   * Emits 'sessionExpired' event for each expired session before removal,
   * enabling transcript persistence and other post-expiry workflows.
   *
   * @returns {Object} Counts of cleaned items {sessions, approvals}
   */
  cleanup() {
    const now = Date.now();
    let sessionsRemoved = 0;
    let approvalsRemoved = 0;
    const expired = [];

    // Collect expired and idle sessions (avoid modifying map during iteration)
    const idle = [];
    for (const [sessionKey, session] of this.sessions.entries()) {
      if (now - session.lastActivityAt > this.sessionTimeoutMs) {
        expired.push({ sessionKey, session });
      } else {
        // Detect idle sessions (inactive > idleTimeoutMs, not yet marked)
        if (!session._idleEmitted &&
            session.context && session.context.length >= 4 &&
            now - session.lastActivityAt > this.idleTimeoutMs) {
          session._idleEmitted = true;
          idle.push(session);
        } else if (session._idleEmitted && now - session.lastActivityAt < this.idleTimeoutMs) {
          // Reset idle flag when session becomes active again
          session._idleEmitted = false;
        }
        // Clean expired approvals within active sessions
        for (const [approvalKey, approval] of session.grantedApprovals.entries()) {
          if (now > approval.expiresAt) {
            session.grantedApprovals.delete(approvalKey);
            approvalsRemoved++;
          }
        }
        // Clean expired pending clarifications
        if (session.pendingClarification &&
            now - session.pendingClarification.askedAt > this.approvalExpiryMs) {
          session.pendingClarification = null;
        }
      }
    }

    // Remove expired sessions and emit events
    for (const { sessionKey, session } of expired) {
      this._removeSession(sessionKey);
      sessionsRemoved++;
      this.emit('sessionExpired', session);
    }

    // Emit idle events for sessions that went quiet (consolidation trigger)
    for (const session of idle) {
      this.emit('sessionIdle', session);
    }

    if (this.auditLog && (sessionsRemoved > 0 || approvalsRemoved > 0)) {
      this.auditLog.log('cleanup_completed', {
        sessionsRemoved,
        approvalsRemoved,
        timestamp: now,
      });
    }

    return { sessions: sessionsRemoved, approvals: approvalsRemoved, idle: idle.length };
  }

  /**
   * Return all active sessions. Used for graceful shutdown persistence —
   * sessions live in-memory and vanish on restart unless persisted.
   *
   * @returns {Object[]} Array of all session objects
   */
  getAllSessions() {
    return Array.from(this.sessions.values());
  }

  /**
   * Verify isolation between two sessions
   * Checks that no data structures are shared by reference
   *
   * @param {Object} session1 - First session
   * @param {Object} session2 - Second session
   * @returns {boolean} True if properly isolated, false if shared references detected
   */
  verifyIsolation(session1, session2) {
    // Sessions must be different objects
    if (session1 === session2) {
      return false;
    }

    // Context arrays must be different objects
    if (session1.context === session2.context) {
      return false;
    }

    // Credential sets must be different objects
    if (session1.credentialsAccessed === session2.credentialsAccessed) {
      return false;
    }

    // Pending approvals maps must be different objects
    if (session1.pendingApprovals === session2.pendingApprovals) {
      return false;
    }

    // Granted approvals maps must be different objects
    if (session1.grantedApprovals === session2.grantedApprovals) {
      return false;
    }

    // Action ledgers must be different objects
    if (session1.actionLedger === session2.actionLedger) {
      return false;
    }

    return true;
  }

  /**
   * Get list of active sessions
   *
   * @returns {Array} Array of session objects
   */
  getActiveSessions() {
    const now = Date.now();
    const activeSessions = [];

    for (const session of this.sessions.values()) {
      if (now - session.lastActivityAt <= this.sessionTimeoutMs) {
        activeSessions.push(session);
      }
    }

    return activeSessions;
  }

  /**
   * Force-expire a session by ID
   *
   * @param {string} sessionId - Session UUID
   * @returns {boolean} True if session was found and expired
   */
  expireSession(sessionId) {
    const sessionKey = this.sessionIndex.get(sessionId);

    if (!sessionKey) {
      return false;
    }

    const session = this.sessions.get(sessionKey);
    if (!session) {
      return false;
    }

    this._removeSession(sessionKey);

    if (this.auditLog) {
      this.auditLog.log('session_expired', {
        sessionId,
        forced: true,
        timestamp: Date.now(),
      });
    }

    return true;
  }

  /**
   * Look up session by ID
   *
   * @param {string} sessionId - Session UUID
   * @returns {Object|null} Session object or null if not found
   */
  getSessionById(sessionId) {
    const sessionKey = this.sessionIndex.get(sessionId);

    if (!sessionKey) {
      return null;
    }

    const session = this.sessions.get(sessionKey);

    if (!session) {
      // Clean up orphaned index entry
      this.sessionIndex.delete(sessionId);
      return null;
    }

    // Check if expired
    const now = Date.now();
    if (now - session.lastActivityAt > this.sessionTimeoutMs) {
      this._removeSession(sessionKey);
      return null;
    }

    return session;
  }

  /**
   * Remove session and clean up indices
   *
   * @private
   * @param {string} sessionKey - Session key
   */
  _removeSession(sessionKey) {
    const session = this.sessions.get(sessionKey);

    if (session) {
      this.sessionIndex.delete(session.id);
      this.sessions.delete(sessionKey);
    }
  }
}

module.exports = SessionManager;
