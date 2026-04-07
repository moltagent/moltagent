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

/**
 * SecurityInterceptor - Central Security Enforcement Point
 *
 * Architecture Brief:
 * -------------------
 * Problem: Moltagent has 8 discrete security modules (5 guards, ResponseWrapper,
 * MemoryIntegrityChecker, SessionManager) but no single enforcement point that
 * coordinates them into a unified pipeline for every message and operation.
 *
 * Chosen Pattern: Interceptor pattern with before/after hooks. All operations
 * flow through beforeExecute() (pre-check) and afterExecute() (post-check).
 * Guards are invoked in a strict order that maximizes short-circuit efficiency:
 *   1. ToolGuard first (cheapest: Set lookup, blocks FORBIDDEN immediately)
 *   2. PromptGuard second (heuristic + statistical are fast; ML/LLM optional)
 *   3. SecretsGuard third (regex scan on input content)
 *   4. PathGuard fourth (only if params.path present)
 *   5. EgressGuard fifth (only if params.url present)
 *
 * Key Dependencies:
 *   - SecretsGuard: scan() -> {hasSecrets, findings, sanitized, criticalCount}
 *   - ToolGuard: evaluate() -> {allowed, reason, level, requiresAction, approvalPrompt}
 *   - PromptGuard: evaluate() -> {allowed, decision, level, score, layers, categories}
 *   - PathGuard: evaluate() -> {allowed, reason, level, matchedRule}
 *   - EgressGuard: evaluate() -> {allowed, reason, level, category}
 *   - ResponseWrapper: process() -> {safe, response, warnings, originalHadSecrets, truncated}
 *   - MemoryIntegrityChecker: scanAll() -> {scanned, quarantined, warnings, clean, findings}
 *   - SessionManager: getSession(), isApproved(), requestApproval(), grantApproval(),
 *     denyApproval(), addContext(), recordCredentialAccess(), cleanup(), verifyIsolation()
 *
 * Data Flow:
 *   User Message -> beforeExecute() -> [ToolGuard -> PromptGuard -> SecretsGuard
 *     -> PathGuard -> EgressGuard] -> {proceed, decision, routeToLocal}
 *   LLM Response -> afterExecute() -> [ResponseWrapper (incl. SecretsGuard)]
 *     -> {response, sanitized, warnings}
 *
 * @module security/interceptor
 * @version 1.0.0
 */

'use strict';

// -----------------------------------------------------------------------------
// Constants
// -----------------------------------------------------------------------------

/**
 * Operations considered "high stakes" that warrant LLM-as-judge evaluation.
 * @type {string[]}
 */
const HIGH_STAKES_OPERATIONS = [
  'execute_shell',
  'run_command',
  'delete_file',
  'delete_folder',
  'send_email',
  'modify_calendar',
  'access_credential',
  'webhook_call',
];

// -----------------------------------------------------------------------------
// SecurityInterceptor Class
// -----------------------------------------------------------------------------

/**
 * Central enforcement point for all security checks.
 *
 * Every incoming message goes through beforeExecute().
 * Every outgoing response goes through afterExecute().
 * No exceptions.
 */
class SecurityInterceptor {
  /**
   * Create a new SecurityInterceptor instance.
   *
   * @param {Object} options - Configuration options
   * @param {Object} options.guards - Guard instances
   * @param {import('./guards/secrets-guard')} options.guards.secrets - SecretsGuard instance
   * @param {import('./guards/tool-guard')} options.guards.tools - ToolGuard instance
   * @param {import('./guards/prompt-guard')} options.guards.prompt - PromptGuard instance
   * @param {import('./guards/path-guard')} options.guards.paths - PathGuard instance
   * @param {import('./guards/egress-guard')} options.guards.egress - EgressGuard instance
   * @param {import('./response-wrapper')} options.responseWrapper - ResponseWrapper instance
   * @param {import('./memory-integrity')} options.memoryChecker - MemoryIntegrityChecker instance
   * @param {import('./session-manager')} options.sessionManager - SessionManager instance
   * @param {Object} [options.auditLog] - Audit logger with log(eventType, data) method
   * @param {Object} [options.notifier] - NC Talk notifier with send(roomToken, msg) method
   * @param {Object} [options.config] - Additional configuration
   * @param {boolean} [options.config.strictMode=true] - Block on any guard REVIEW result
   * @param {boolean} [options.config.enableML=false] - Enable PromptGuard Layer 3 (Ollama)
   * @param {boolean} [options.config.enableLLMJudge=false] - Enable PromptGuard Layer 4 (Claude)
   */
  constructor(options) {
    if (!options || !options.guards) {
      throw new Error('SecurityInterceptor requires options.guards');
    }

    this.guards = {
      secrets: options.guards.secrets,
      tools: options.guards.tools,
      prompt: options.guards.prompt,
      paths: options.guards.paths,
      egress: options.guards.egress,
    };

    this.responseWrapper = options.responseWrapper;
    this.memoryChecker = options.memoryChecker || null;
    this.sessionManager = options.sessionManager;
    this.auditLog = options.auditLog || null;
    this.notifier = options.notifier || null;

    this.config = {
      strictMode: true,
      enableML: false,
      enableLLMJudge: false,
      ...(options.config || {}),
    };

    // Internal counters for status reporting
    this._blockedCount = 0;
    this._lastMemoryScan = null;
  }

  // ---------------------------------------------------------------------------
  // beforeExecute — Pre-execution security pipeline
  // ---------------------------------------------------------------------------

  /**
   * Pre-execution security check. Call before ANY operation.
   *
   * Guard evaluation order (short-circuits on BLOCK):
   *   1. ToolGuard.evaluate() — operation-level decision (FORBIDDEN/APPROVAL/LOCAL/ALLOWED)
   *   2. PromptGuard.evaluate() — prompt injection detection (if params.content)
   *   3. SecretsGuard.scan() — secrets in input (if params.content)
   *   4. PathGuard.evaluate() — filesystem access control (if params.path)
   *   5. EgressGuard.evaluate() — outbound network control (if params.url)
   *
   * @param {string} operation - Operation name (e.g., 'process_message', 'send_email', 'read_file')
   * @param {Object} params - Operation parameters
   * @param {string} [params.content] - Message/file content (for prompt injection + secrets check)
   * @param {string} [params.path] - File path (for path guard check)
   * @param {string} [params.url] - URL (for egress guard check)
   * @param {string} [params.credentialName] - Credential name (for credential tracking)
   * @param {Object} context - Execution context
   * @param {string} context.roomToken - NC Talk room token
   * @param {string} context.userId - NC user ID
   * @param {string} [context.messageId] - Message ID for audit tracking
   * @returns {Promise<{
   *   proceed: boolean,
   *   decision: 'ALLOW'|'BLOCK'|'APPROVAL_REQUIRED',
   *   reason: string|null,
   *   modifiedParams: Object,
   *   approvalRequired: boolean,
   *   approvalPrompt: string|null,
   *   routeToLocal: boolean,
   *   session: Object,
   *   guardResults: {
   *     tools: {allowed: boolean, reason: string|null, level: string, requiresAction: string|null, approvalPrompt: string|null},
   *     prompt: {allowed: boolean, decision: string, level: string, score: number, layers: Object, categories: string[]}|null,
   *     secrets: {hasSecrets: boolean, findings: Array, sanitized: string, criticalCount: number}|null,
   *     paths: {allowed: boolean, reason: string|null, level: string, matchedRule: string|null}|null,
   *     egress: {allowed: boolean, reason: string|null, level: string, category: string|null}|null
   *   }
   * }>}
   */
  async beforeExecute(operation, params, context) {
    // 1. Get or create session
    const session = this.sessionManager.getSession(context.roomToken, context.userId);

    // 2. Initialize result
    const result = {
      proceed: true,
      decision: 'ALLOW',
      reason: null,
      modifiedParams: { ...params },
      approvalRequired: false,
      approvalPrompt: null,
      routeToLocal: false,
      session,
      guardResults: {
        tools: null,
        prompt: null,
        secrets: null,
        paths: null,
        egress: null,
      },
    };

    // 3. Check ToolGuard FIRST — operation-level decisions
    const toolResult = this.guards.tools.evaluate(operation, context);
    result.guardResults.tools = toolResult;

    if (toolResult.level === 'FORBIDDEN') {
      result.proceed = false;
      result.decision = 'BLOCK';
      result.reason = toolResult.reason;
      await this.logDecision('BLOCK', operation, toolResult, context);
      return result;
    }

    if (toolResult.level === 'ROUTE_LOCAL') {
      result.routeToLocal = true;
    }

    if (toolResult.level === 'APPROVAL_REQUIRED') {
      // Check if already approved in this session
      if (!this.sessionManager.isApproved(session, operation, params)) {
        result.proceed = false;
        result.decision = 'APPROVAL_REQUIRED';
        result.approvalRequired = true;
        result.approvalPrompt = toolResult.approvalPrompt;
        this.sessionManager.requestApproval(session, operation, params);
        return result;
      }
      // Already approved — continue
    }

    // 4. Check PromptGuard if content is present
    if (params.content) {
      const promptResult = await this.guards.prompt.evaluate(params.content, {
        enableML: this.config.enableML,
        enableLLMJudge: this.config.enableLLMJudge && this.isHighStakes(operation),
      });
      result.guardResults.prompt = promptResult;

      if (promptResult.decision === 'BLOCK') {
        result.proceed = false;
        result.decision = 'BLOCK';
        result.reason = `Prompt injection detected: ${promptResult.categories.join(', ')}`;
        await this.logDecision('BLOCK', operation, promptResult, context);
        return result;
      }

      if (promptResult.decision === 'REVIEW') {
        // Log for review but allow (unless strictMode)
        await this.logDecision('REVIEW', operation, promptResult, context);
        if (this.config.strictMode) {
          result.proceed = false;
          result.decision = 'BLOCK';
          result.reason = 'Content flagged for review (strict mode)';
          return result;
        }
      }
    }

    // 5. Check SecretsGuard on input (scan for secrets user might be trying to exfiltrate)
    if (params.content) {
      const secretsResult = this.guards.secrets.scan(params.content);
      result.guardResults.secrets = secretsResult;

      if (secretsResult.hasSecrets) {
        // Don't block, but sanitize the input and log
        result.modifiedParams.content = secretsResult.sanitized;
        await this.logDecision('SANITIZED_INPUT', operation, secretsResult, context);
      }
    }

    // 6. Check PathGuard if path is present
    if (params.path) {
      const pathResult = this.guards.paths.evaluate(params.path, context);
      result.guardResults.paths = pathResult;

      if (!pathResult.allowed) {
        result.proceed = false;
        result.decision = 'BLOCK';
        result.reason = pathResult.reason;
        await this.logDecision('BLOCK', operation, pathResult, context);
        return result;
      }
    }

    // 7. Check EgressGuard if URL is present
    if (params.url) {
      const egressResult = this.guards.egress.evaluate(params.url, context);
      result.guardResults.egress = egressResult;

      if (!egressResult.allowed) {
        result.proceed = false;
        result.decision = 'BLOCK';
        result.reason = egressResult.reason;
        await this.logDecision('BLOCK', operation, egressResult, context);
        return result;
      }
    }

    // 8. Record credential access if this is a credential operation
    if (operation === 'access_credential' && params.credentialName) {
      const isFirstAccess = this.sessionManager.recordCredentialAccess(session, params.credentialName);
      if (isFirstAccess && this.notifier) {
        await this.notifier.send(context.roomToken,
          `🔑 First-time credential access: ${params.credentialName}`);
      }
    }

    // 9. All checks passed
    await this.logDecision('ALLOW', operation, result.guardResults, context);
    return result;
  }

  // ---------------------------------------------------------------------------
  // afterExecute — Post-execution response sanitization
  // ---------------------------------------------------------------------------

  /**
   * Post-execution security check. Call after LLM response, before sending to user.
   *
   * Pipeline:
   *   1. ResponseWrapper.process() — scans for secrets, suspicious patterns, truncation
   *   2. SessionManager.addContext() — records sanitized response in session
   *
   * @param {string} operation - Operation name
   * @param {string} response - Raw LLM response text
   * @param {Object} context - Execution context (same shape as beforeExecute)
   * @param {string} context.roomToken - NC Talk room token
   * @param {string} context.userId - NC user ID
   * @param {string} [context.messageId] - Message ID for audit tracking
   * @returns {Promise<{
   *   response: string,
   *   sanitized: boolean,
   *   warnings: Array<{type: string, severity: string, action: string}>,
   *   blocked: boolean,
   *   reason: string|null
   * }>}
   */
  async afterExecute(operation, response, context) {
    const result = {
      response,
      sanitized: false,
      warnings: [],
      blocked: false,
      reason: null,
    };

    // 1. Get session (should exist from beforeExecute)
    const session = this.sessionManager.getSession(context.roomToken, context.userId);

    // 2. Run through ResponseWrapper (which uses SecretsGuard internally)
    const wrapperResult = await this.responseWrapper.process(response, context);

    result.response = wrapperResult.response;
    result.sanitized = wrapperResult.originalHadSecrets;
    result.warnings = wrapperResult.warnings;

    if (!wrapperResult.safe) {
      // CRITICAL secrets found — even after redaction, this is suspicious
      await this.logDecision('OUTPUT_BLOCKED', operation, wrapperResult, context);

      if (this.config.strictMode) {
        result.blocked = true;
        result.reason = 'Response contained critical secrets';
        result.response = '⚠️ Response blocked for security review.';
      }
    }

    // 3. Add to session context (sanitized version)
    this.sessionManager.addContext(session, 'assistant', result.response);

    // 4. Log if anything was sanitized
    if (result.sanitized) {
      await this.logDecision('OUTPUT_SANITIZED', operation, wrapperResult, context);
    }

    return result;
  }

  // ---------------------------------------------------------------------------
  // handleApproval — Process user approval/denial response
  // ---------------------------------------------------------------------------

  /**
   * Handle approval response from user.
   *
   * When beforeExecute() returns decision='APPROVAL_REQUIRED', the caller
   * presents the approvalPrompt to the user. When the user responds, call
   * this method to record the decision.
   *
   * @param {Object} context - Execution context
   * @param {string} context.roomToken - NC Talk room token
   * @param {string} context.userId - NC user ID
   * @param {string} operation - Operation that was pending approval
   * @param {Object} params - Original operation params
   * @param {boolean} approved - User's decision (true=approve, false=deny)
   * @returns {{
   *   success: boolean,
   *   canProceed: boolean,
   *   message: string
   * }}
   */
  handleApproval(context, operation, params, approved) {
    const session = this.sessionManager.getSession(context.roomToken, context.userId);

    if (approved) {
      this.sessionManager.grantApproval(session, operation, params);
      return {
        success: true,
        canProceed: true,
        message: `✅ Approved: ${operation}. You can now proceed.`,
      };
    } else {
      this.sessionManager.denyApproval(session, operation, params);
      return {
        success: true,
        canProceed: false,
        message: `❌ Denied: ${operation}. Operation will not be performed.`,
      };
    }
  }

  // ---------------------------------------------------------------------------
  // runMemoryCheck — Delegated to MemoryIntegrityChecker
  // ---------------------------------------------------------------------------

  /**
   * Run memory integrity check (call from heartbeat).
   *
   * Delegates to MemoryIntegrityChecker.scanAll() and normalizes the result
   * into {clean, issues, quarantined} shape expected by the heartbeat hooks.
   *
   * @returns {Promise<{
   *   clean: boolean,
   *   issues: Array<{file: string, severity: string, categories: string[]}>,
   *   quarantined: string[]
   * }>}
   */
  async runMemoryCheck() {
    if (!this.memoryChecker) {
      return { clean: true, issues: [], quarantined: [] };
    }

    const scanResult = await this.memoryChecker.scanAll();

    // Map to expected return shape
    const result = {
      clean: scanResult.quarantined === 0 && scanResult.warnings === 0,
      issues: scanResult.findings,
      quarantined: scanResult.findings
        .filter(f => f.severity === 'CRITICAL' || f.severity === 'HIGH')
        .map(f => f.file),
    };

    this._lastMemoryScan = new Date();
    return result;
  }

  // ---------------------------------------------------------------------------
  // runSessionCleanup — Delegated to SessionManager
  // ---------------------------------------------------------------------------

  /**
   * Run session cleanup (call from heartbeat).
   *
   * Delegates to SessionManager.cleanup() which removes expired sessions
   * and expired approvals within active sessions.
   *
   * @returns {{
   *   expiredSessions: number,
   *   expiredApprovals: number
   * }}
   */
  runSessionCleanup() {
    const result = this.sessionManager.cleanup();
    return {
      expiredSessions: result.sessions,
      expiredApprovals: result.approvals,
    };
  }

  // ---------------------------------------------------------------------------
  // getStatus — Monitoring/debugging snapshot
  // ---------------------------------------------------------------------------

  /**
   * Get security status summary for monitoring and debugging.
   *
   * @returns {{
   *   activeSessions: number,
   *   pendingApprovals: number,
   *   blockedToday: number,
   *   lastMemoryScan: Date|null
   * }}
   */
  getStatus() {
    const activeSessions = this.sessionManager.getActiveSessions();

    // Count pending approvals across all active sessions
    let pendingApprovals = 0;
    for (const session of activeSessions) {
      pendingApprovals += session.pendingApprovals.size;
    }

    return {
      activeSessions: activeSessions.length,
      pendingApprovals,
      blockedToday: this._blockedCount,
      lastMemoryScan: this._lastMemoryScan,
    };
  }

  // ---------------------------------------------------------------------------
  // Helper Methods
  // ---------------------------------------------------------------------------

  /**
   * Determine if an operation is "high stakes" (warrants LLM-as-judge in L4).
   *
   * @param {string} operation - Operation name
   * @returns {boolean} True if operation is high stakes
   */
  isHighStakes(operation) {
    return HIGH_STAKES_OPERATIONS.includes(operation);
  }

  /**
   * Log a security decision to the audit trail.
   *
   * @param {string} decision - Decision type: 'ALLOW'|'BLOCK'|'REVIEW'|'SANITIZED_INPUT'|'OUTPUT_BLOCKED'|'OUTPUT_SANITIZED'
   * @param {string} operation - Operation name
   * @param {Object} details - Guard result details
   * @param {Object} context - Execution context
   * @param {string} context.roomToken - NC Talk room token
   * @param {string} context.userId - NC user ID
   * @param {string} [context.messageId] - Message ID
   * @returns {Promise<void>}
   */
  async logDecision(decision, operation, details, context) {
    if (this.auditLog) {
      await this.auditLog.log('security_decision', {
        decision,
        operation,
        details,
        context: {
          roomToken: context.roomToken,
          userId: context.userId,
          messageId: context.messageId,
          timestamp: new Date().toISOString(),
        },
      });
    }

    if (decision === 'BLOCK') {
      this._blockedCount++;
    }
  }
}

// -----------------------------------------------------------------------------
// Exports
// -----------------------------------------------------------------------------

module.exports = SecurityInterceptor;
