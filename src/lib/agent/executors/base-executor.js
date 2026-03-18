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
    this.claudeProvider = config.claudeProvider || null;
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
   * @param {string} [job='tools'] - Router job name (defaults to 'tools' per roster)
   * @returns {Promise<Object|null>} Parsed JSON or null on failure
   */
  async _extractJSON(message, extractionPrompt, format, job = 'tools') {
    try {
      let raw;

      if (this.claudeProvider) {
        // Direct path — bypasses legacy router chain, uses Haiku for reliable structured output
        const result = await this.claudeProvider.chat({
          system: 'Extract parameters as JSON. Return ONLY valid JSON, no markdown, no explanation.',
          messages: [{ role: 'user', content: extractionPrompt }],
        });
        raw = (result.content || '').trim();
      } else {
        // Fallback: router path (local-only mode)
        const requirements = { maxTokens: 500, temperature: 0 };
        if (format) requirements.format = format;
        const result = await this.router.route({
          job,
          task: `extract_${this.constructor.name || 'base'}`,
          content: extractionPrompt,
          requirements
        });
        raw = (result.result || '').trim();
      }

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

    // ISO format passthrough (YYYY-MM-DD or YYYY-MM-DDT...)
    if (/^\d{4}-\d{2}-\d{2}/.test(cleaned)) return cleaned.substring(0, 10);

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
   * Parse natural-language time strings to HH:MM (24-hour).
   * Handles: "3pm", "3:30pm", "3 PM", "15:00", "3:00 p.m.", "noon", "midnight".
   * @param {string} timeStr - Time string to parse
   * @returns {string|null} "HH:MM" or null if unparseable
   */
  _parseTime(timeStr) {
    if (!timeStr || typeof timeStr !== 'string') return null;
    const cleaned = timeStr.trim().toLowerCase().replace(/\./g, '');

    // Already HH:MM or H:MM (24-hour, no am/pm)
    if (/^\d{1,2}:\d{2}$/.test(cleaned) && !cleaned.includes('am') && !cleaned.includes('pm')) {
      const [h, m] = cleaned.split(':').map(Number);
      if (h >= 0 && h <= 23 && m >= 0 && m <= 59) {
        return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
      }
      return null;
    }

    // Named times
    if (cleaned === 'noon' || cleaned === 'midday') return '12:00';
    if (cleaned === 'midnight') return '00:00';

    // 12-hour formats: "3pm", "3:30pm", "3 pm", "3:30 p.m.", "11:00am"
    const match = cleaned.match(/^(\d{1,2})(?::(\d{2}))?\s*(am|pm)$/);
    if (match) {
      let h = parseInt(match[1], 10);
      const m = match[2] ? parseInt(match[2], 10) : 0;
      const period = match[3];
      if (h < 1 || h > 12 || m < 0 || m > 59) return null;
      if (period === 'am' && h === 12) h = 0;
      if (period === 'pm' && h !== 12) h += 12;
      return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
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
  /**
   * Resume an executor after the user answers a clarification question.
   * Default implementation: fills the first missing field with userResponse,
   * then either asks for the next missing field or re-runs execute().
   *
   * Executors can override this for domain-specific merge logic.
   *
   * @param {Object} clarification - { collectedFields, userResponse, missingFields, action, executor, originalMessage }
   * @param {Object} context - { userName, roomToken }
   * @returns {Promise<{ response: string, pendingClarification?: Object }>}
   */
  async resumeWithClarification(clarification, context) {
    const { collectedFields, userResponse } = clarification;
    const missingFields = Array.isArray(clarification.missingFields) ? clarification.missingFields : [];
    if (missingFields.length === 0) {
      const result = await this.execute(clarification.originalMessage, context);
      if (typeof result === 'object' && result !== null && result.response !== undefined) {
        return result;
      }
      return { response: typeof result === 'string' ? result : 'Done.' };
    }

    const firstMissing = missingFields[0];

    // Determine what value to store for this field.
    // If the user gave a meta-instruction ("you pick", "propose a name", etc.),
    // ask the executor subclass to generate a default instead of storing it literally.
    let fieldValue = userResponse;
    if (this._isMetaInstruction(userResponse)) {
      const generated = this._generateDefaultValue(firstMissing, collectedFields, clarification.originalMessage);
      if (generated !== null && generated !== undefined) {
        fieldValue = generated;
      }
      // If no default could be generated, fall through and store the literal reply —
      // the executor's execute() will deal with it (e.g. re-ask).
    }

    const updatedFields = { ...collectedFields, [firstMissing]: fieldValue };
    const stillMissing = missingFields.slice(1);

    if (stillMissing.length > 0) {
      return {
        response: this._askForField(stillMissing[0]),
        pendingClarification: {
          executor: clarification.executor,
          action: clarification.action,
          missingFields: stillMissing,
          collectedFields: updatedFields,
          originalMessage: clarification.originalMessage,
        }
      };
    }

    // All fields collected — re-execute with the original message
    const result = await this.execute(clarification.originalMessage, context);
    if (typeof result === 'object' && result !== null && result.response !== undefined) {
      return result;
    }
    return { response: typeof result === 'string' ? result : 'Done.' };
  }

  /**
   * Detect meta-instructions where the user defers the decision to the agent
   * ("you pick", "propose a name", "whatever", etc.).
   *
   * @param {string} reply - User's clarification reply
   * @returns {boolean}
   */
  _isMetaInstruction(reply) {
    if (!reply || typeof reply !== 'string') return false;
    return /\b(propose|suggest|pick|choose|generate|you decide|make one|come up with|whatever|any\b.*\bname|default|you.?(?:re|'re) the (?:ai|bot|agent)|up to you|your (?:choice|call))\b/i.test(reply);
  }

  /**
   * Generate a default value for a missing field when the user issued a meta-instruction.
   * Base implementation always returns null (no opinion).
   * Executor subclasses should override this to provide domain-specific defaults.
   *
   * @param {string} fieldName - Name of the field that needs a value
   * @param {Object} collectedFields - Fields already collected so far
   * @param {string} originalMessage - The original user message that started the flow
   * @returns {string|null} A default value string, or null if no default can be derived
   */
  _generateDefaultValue(fieldName, collectedFields, originalMessage) { // eslint-disable-line no-unused-vars
    return null;
  }

  /**
   * Generate a user-friendly question for a missing field.
   * Executors can override for domain-specific phrasing.
   *
   * @param {string} fieldName
   * @returns {string}
   */
  _askForField(fieldName) {
    return `What's the ${fieldName}?`;
  }
}

module.exports = BaseExecutor;
