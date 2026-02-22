/*
 * MoltAgent - Sovereign AI Security Layer
 * Copyright (C) 2026 MoltAgent Contributors
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU Affero General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 */

'use strict';

// Hardcoded operation categories (never modifiable at runtime)
const FORBIDDEN = [
  // Self-modification (prevents "soul-evil" attacks)
  'modify_system_prompt', 'modify_soul', 'replace_instructions',
  'modify_config', 'enable_hook', 'disable_sandbox', 'disable_guard',
  'bypass_security', 'modify_permissions', 'elevate_privileges',

  // Marketplace/plugin attacks
  'install_skill', 'install_plugin',

  // Evidence destruction
  'delete_logs', 'modify_audit', 'clear_history',

  // Cross-session attacks
  'access_other_session', 'export_credentials',
];

const REQUIRES_APPROVAL = [
  // External communication
  'send_email', 'send_message_external', 'webhook_call',

  // Destructive file operations
  'delete_file', 'delete_files', 'delete_folder', 'file_delete',

  // Calendar/contact modification
  'modify_calendar', 'delete_calendar_event', 'modify_contacts',

  // Calendar scheduling (sends external invitations/cancellations)
  'calendar_quick_schedule', 'calendar_schedule_meeting', 'calendar_cancel_meeting',

  // System-level operations
  'execute_shell', 'run_command',

  // Credential access
  'access_new_credential',

  // External API calls
  'external_api_call',

  // Destructive deck operations
  'deck_delete_card',

  // Destructive wiki operations
  'wiki_delete',

  // Sensitive deck operations (sharing data)
  'deck_share_board',

  // Sensitive file operations (sharing data)
  'file_share',

  // Phase 2: External communication
  // mail_send — handled by SOUL.md instruction (LLM must confirm with user before calling)
  // wiki_write — moved to GuardrailEnforcer SENSITIVE_TOOLS (Cockpit-governed, not hardcoded)
  'notification_send',    // Pushing notifications — prevent spam
];

const LOCAL_LLM_ONLY = [
  // Operations where credentials are in context
  'process_credential', 'process_untrusted_file',

  // Sensitive content
  'process_email_content', 'process_web_content',
  'process_user_upload',

  // Memory operations
  'update_memory',

  // PII processing
  'process_pii',
];

/**
 * ToolGuard - Evaluates tool/operation security levels
 * Implements defense-in-depth against malicious prompts and plugins
 */
class ToolGuard {
  /**
   * @param {Object} options - Configuration options
   * @param {string[]} options.additionalForbidden - Extra forbidden operations
   * @param {string[]} options.additionalApproval - Extra approval-required operations
   * @param {string[]} options.additionalLocal - Extra local-only operations
   */
  constructor(options = {}) {
    // Build combined lists with additional operations
    this._forbidden = new Set([
      ...FORBIDDEN,
      ...(options.additionalForbidden || []),
    ].map(this._normalizeOperation));

    this._approval = new Set([
      ...REQUIRES_APPROVAL,
      ...(options.additionalApproval || []),
    ].map(this._normalizeOperation));

    this._local = new Set([
      ...LOCAL_LLM_ONLY,
      ...(options.additionalLocal || []),
    ].map(this._normalizeOperation));
  }

  /**
   * Normalize operation name for fuzzy matching
   * Converts "Send Email", "send-email", "SEND_EMAIL" to "send_email"
   * @param {string} operation - Raw operation name
   * @returns {string} Normalized operation name
   * @private
   */
  _normalizeOperation(operation) {
    return String(operation)
      .toLowerCase()
      .replace(/[\s-]/g, '_');
  }

  /**
   * Get reason string for forbidden operation
   * @param {string} operation - Original operation name
   * @param {string} normalized - Normalized operation name
   * @returns {string} Reason message
   * @private
   */
  _getForbiddenReason(operation, normalized) {
    // Determine category for better error messages
    const selfModOps = ['modify_system_prompt', 'modify_soul', 'replace_instructions',
                        'modify_config', 'enable_hook', 'disable_sandbox', 'disable_guard',
                        'bypass_security', 'modify_permissions', 'elevate_privileges'];
    const marketplaceOps = ['install_skill', 'install_plugin'];
    const evidenceOps = ['delete_logs', 'modify_audit', 'clear_history'];
    const crossSessionOps = ['access_other_session', 'export_credentials'];

    let category = 'security violation';
    if (selfModOps.includes(normalized)) {
      category = 'self-modification prohibited';
    } else if (marketplaceOps.includes(normalized)) {
      category = 'unauthorized plugin installation';
    } else if (evidenceOps.includes(normalized)) {
      category = 'audit tampering prohibited';
    } else if (crossSessionOps.includes(normalized)) {
      category = 'cross-session access prohibited';
    }

    return `Operation "${operation}" is forbidden: ${category}`;
  }

  /**
   * Build approval prompt with optional target context
   * @param {string} operation - Original operation name
   * @param {Object} context - Evaluation context
   * @returns {string} Approval prompt
   * @private
   */
  _buildApprovalPrompt(operation, context) {
    let prompt = `⚠️ MoltAgent wants to: ${operation}`;

    if (context && context.target) {
      prompt += ` (target: ${context.target})`;
    }

    prompt += '. Reply "approve" to allow or "deny" to block.';
    return prompt;
  }

  /**
   * Evaluate operation security level
   * Checks in order: FORBIDDEN → APPROVAL_REQUIRED → LOCAL_LLM_ONLY → ALLOWED
   *
   * @param {string} operation - Operation name to evaluate
   * @param {Object} context - Optional context (may include target, user, etc.)
   * @returns {Object} Evaluation result
   * @property {boolean} allowed - Whether operation can proceed
   * @property {string|null} reason - Human-readable reason if blocked/routed
   * @property {string} level - Security level: FORBIDDEN | APPROVAL_REQUIRED | ROUTE_LOCAL | ALLOWED
   * @property {string|null} requiresAction - Action needed: null | 'await_approval' | 'use_ollama'
   * @property {string|null} approvalPrompt - User prompt if approval needed
   */
  evaluate(operation, context = {}) {
    const normalized = this._normalizeOperation(operation);

    // Check FORBIDDEN first
    if (this._forbidden.has(normalized)) {
      return {
        allowed: false,
        reason: this._getForbiddenReason(operation, normalized),
        level: 'FORBIDDEN',
        requiresAction: null,
        approvalPrompt: null,
      };
    }

    // Check REQUIRES_APPROVAL
    if (this._approval.has(normalized)) {
      return {
        allowed: false,
        reason: `Operation "${operation}" requires human approval`,
        level: 'APPROVAL_REQUIRED',
        requiresAction: 'await_approval',
        approvalPrompt: this._buildApprovalPrompt(operation, context),
      };
    }

    // Check LOCAL_LLM_ONLY
    if (this._local.has(normalized)) {
      return {
        allowed: true,
        reason: `Operation "${operation}" routed to local LLM for security`,
        level: 'ROUTE_LOCAL',
        requiresAction: 'use_ollama',
        approvalPrompt: null,
      };
    }

    // Default: ALLOWED
    return {
      allowed: true,
      reason: null,
      level: 'ALLOWED',
      requiresAction: null,
      approvalPrompt: null,
    };
  }

  /**
   * Check if operation requires local LLM routing
   * @param {string} operation - Operation name
   * @returns {boolean} True if must use local LLM
   */
  needsLocalLLM(operation) {
    const normalized = this._normalizeOperation(operation);
    return this._local.has(normalized);
  }

  /**
   * Get list of forbidden operations
   * @returns {string[]} Array of forbidden operation names
   */
  getForbiddenList() {
    return Array.from(this._forbidden);
  }

  /**
   * Get all operation lists
   * @returns {Object} Object with forbidden, approval, and local arrays
   */
  getAllLists() {
    return {
      forbidden: Array.from(this._forbidden),
      approval: Array.from(this._approval),
      local: Array.from(this._local),
    };
  }
}

module.exports = ToolGuard;
module.exports.ToolGuard = ToolGuard;
