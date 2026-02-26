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

/**
 * BaseExecutor — Shared foundation for MicroPipeline parameter-extraction executors.
 *
 * Architecture Brief:
 * - Problem: Local models hallucinate tool calls; need structured extraction + guardrails
 * - Pattern: Extract params via focused LLM prompt → validate → guard → execute
 * - Key Dependencies: LLMRouter (for extraction), ToolGuard, GuardrailEnforcer
 * - Data Flow: message → extractJSON → resolveDate → checkGuardrails → execute
 *
 * @module agent/executors/base-executor
 * @version 1.0.0
 */

const { buildMicroContext } = require('../micro-pipeline-context');

class BaseExecutor {
  /**
   * @param {Object} config
   * @param {Object} config.router - LLMRouter instance
   * @param {Object} [config.guardrailEnforcer] - GuardrailEnforcer for HITL checks
   * @param {Object} [config.toolGuard] - ToolGuard for hardcoded security policy
   * @param {string} [config.timezone] - IANA timezone
   * @param {Object} [config.activityLogger] - ActivityLogger for Layer 1 memory
   * @param {Object} [config.logger] - Logger instance
   */
  constructor(config = {}) {
    if (!config.router) throw new Error('BaseExecutor requires a router');
    this.router = config.router;
    this.guardrailEnforcer = config.guardrailEnforcer || null;
    this.toolGuard = config.toolGuard || null;
    this.activityLogger = config.activityLogger || null;
    this.timezone = config.timezone || 'UTC';
    this.logger = config.logger || console;
  }

  /**
   * Log an activity to the Two-Layer Memory System (Layer 1).
   * @param {string} action - Tool/action name
   * @param {string} summary - Human-readable summary
   * @param {Object} [details] - Structured data for extraction
   * @param {Object} [context] - { userName, roomToken }
   */
  _logActivity(action, summary, details, context) {
    if (this.activityLogger) {
      this.activityLogger.append({
        action,
        summary,
        details,
        user: context?.userName,
        room: context?.roomToken
      });
    }
  }

  /**
   * Extract structured JSON from a message using a focused LLM prompt.
   * Strips markdown fences, parses JSON.
   *
   * @param {string} message - User message
   * @param {string} extractionPrompt - Focused extraction prompt
   * @param {Object} [format] - JSON Schema for Ollama constrained decoding
   * @returns {Promise<Object|null>} Parsed JSON or null on failure
   */
  async _extractJSON(message, extractionPrompt, format) {
    try {
      const requirements = { maxTokens: 300, temperature: 0 };
      if (format) requirements.format = format;

      const result = await this.router.route({
        job: 'quick',
        content: extractionPrompt,
        requirements
      });

      let raw = (result.result || '').trim();

      // Strip markdown fences
      raw = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '');
      raw = raw.trim();

      return JSON.parse(raw);
    } catch (err) {
      this.logger.warn(`[BaseExecutor] JSON extraction failed: ${err.message}`);
      return null;
    }
  }

  /**
   * Check ToolGuard + GuardrailEnforcer chain without executing.
   *
   * @param {string} toolName - Tool to check
   * @param {Object} toolArgs - Tool arguments
   * @param {string|null} roomToken - Talk room for HITL
   * @returns {Promise<{allowed: boolean, reason: string}>}
   */
  async _checkGuardrails(toolName, toolArgs, roomToken) {
    // ToolGuard: hardcoded security policy
    if (this.toolGuard) {
      const guardResult = this.toolGuard.evaluate(toolName);
      if (!guardResult.allowed) {
        if (guardResult.level === 'APPROVAL_REQUIRED' && this.guardrailEnforcer) {
          const approvalResult = await this.guardrailEnforcer.checkApproval(
            toolName, toolArgs, roomToken, []
          );
          if (!approvalResult.allowed) {
            return { allowed: false, reason: approvalResult.reason || 'Approval denied' };
          }
          // Approved — fall through to GuardrailEnforcer.check()
        } else {
          return { allowed: false, reason: guardResult.reason || 'Blocked by security policy' };
        }
      }
    }

    // GuardrailEnforcer: dynamic Cockpit guardrails
    if (this.guardrailEnforcer) {
      const result = await this.guardrailEnforcer.check(toolName, toolArgs, roomToken);
      if (!result.allowed) {
        return { allowed: false, reason: result.reason || 'Blocked by guardrail' };
      }
    }

    return { allowed: true, reason: '' };
  }

  /**
   * Resolve relative date strings to YYYY-MM-DD.
   * Code-based resolution — no LLM call needed.
   *
   * Supports: "today", "tomorrow", day names ("Monday" → next occurrence),
   * YYYY-MM-DD passthrough, DD.MM.YYYY European format.
   *
   * @param {string} dateStr - Date string to resolve
   * @returns {string|null} YYYY-MM-DD or null if unparseable
   */
  _resolveDate(dateStr) {
    if (!dateStr || typeof dateStr !== 'string') return null;

    const cleaned = dateStr.trim().toLowerCase();

    // ISO format passthrough
    if (/^\d{4}-\d{2}-\d{2}$/.test(cleaned)) return cleaned;

    // European DD.MM.YYYY format
    const euroMatch = cleaned.match(/^(\d{1,2})\.(\d{1,2})\.(\d{4})$/);
    if (euroMatch) {
      const day = euroMatch[1].padStart(2, '0');
      const month = euroMatch[2].padStart(2, '0');
      const year = euroMatch[3];
      return `${year}-${month}-${day}`;
    }

    const now = new Date();

    // Today
    if (cleaned === 'today') {
      return this._formatDate(now);
    }

    // Tomorrow
    if (cleaned === 'tomorrow') {
      const tomorrow = new Date(now);
      tomorrow.setDate(tomorrow.getDate() + 1);
      return this._formatDate(tomorrow);
    }

    // Day names → next occurrence
    const dayNames = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
    const dayIndex = dayNames.indexOf(cleaned);
    if (dayIndex !== -1) {
      const current = now.getDay();
      let daysAhead = dayIndex - current;
      if (daysAhead <= 0) daysAhead += 7;
      const target = new Date(now);
      target.setDate(target.getDate() + daysAhead);
      return this._formatDate(target);
    }

    return null;
  }

  /**
   * Format a Date as YYYY-MM-DD.
   * @param {Date} date
   * @returns {string}
   * @private
   */
  _formatDate(date) {
    const y = date.getFullYear();
    const m = String(date.getMonth() + 1).padStart(2, '0');
    const d = String(date.getDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
  }

  /**
   * Build date/time context string for extraction prompts.
   * @returns {string}
   */
  _dateContext() {
    return buildMicroContext(this.timezone);
  }
}

module.exports = BaseExecutor;
