/**
 * Moltagent Skill Forge Handler
 *
 * Architecture Brief:
 * -------------------
 * Problem: Users need to create and activate skills from templates via
 * natural language conversation in Nextcloud Talk. The process is multi-step
 * (browse catalog, select template, provide parameters, review preview, activate)
 * and requires conversational state management.
 *
 * Pattern: Stateful conversation handler with state machine per user.
 * Each interaction advances the state: idle -> browsing -> selected -> preview -> pending.
 * The handler manages parameter collection step-by-step, assembles skills using
 * TemplateEngine, scans with SecurityScanner, and delegates activation to SkillActivator.
 *
 * Key Dependencies:
 * - src/skill-forge/template-loader.js (load catalog and templates)
 * - src/skill-forge/template-engine.js (assemble skills from templates + params)
 * - src/skill-forge/security-scanner.js (scan generated content for violations)
 * - src/skill-forge/activator.js (save to pending, activate to active folder)
 *
 * Data Flow:
 * - Message -> handle() -> classify sub-intent based on state + message
 * - list: loadCatalog() -> format catalog list
 * - select: load(templatePath) -> begin parameter collection
 * - param response: collect param, advance -> when done: assemble() + scan()
 * - approve: savePending() -> transition to pending state
 * - activate: return requiresConfirmation for HITL
 * - cancel/status: reset state or list pending
 *
 * Integration Points:
 * - Called by MessageRouter when intent is 'skillforge'
 * - Returns { response, requiresConfirmation?, pendingAction? }
 * - HITL confirmation triggers MessageRouter's confirmation flow
 *
 * @module handlers/skill-forge-handler
 * @version 1.0.0
 */

'use strict';

// -----------------------------------------------------------------------------
// Types
// -----------------------------------------------------------------------------

/**
 * @typedef {Object} ConversationState
 * @property {'idle'|'browsing'|'selected'|'preview'|'pending'} state - Current conversation state
 * @property {Object} [template] - The selected template object
 * @property {string} [templatePath] - Path to the selected template file
 * @property {Object} [parameters] - Collected parameter values (id -> value)
 * @property {number} [currentParamIndex] - Index of parameter currently being collected
 * @property {string} [generatedContent] - Assembled SKILL.md content (after preview)
 * @property {Object} [metadata] - Generation metadata from assembly
 * @property {string} [pendingFilename] - Filename of saved pending skill
 */

/**
 * @typedef {Object} SkillForgeHandlerResult
 * @property {boolean} success - True if operation succeeded
 * @property {string} message - User-facing response message
 * @property {boolean} [requiresConfirmation] - True if HITL confirmation needed
 * @property {string} [confirmationType] - Type of confirmation ('activate_skill')
 * @property {Object} [pendingAction] - Action data to execute after confirmation
 */

// -----------------------------------------------------------------------------
// SkillForgeHandler Class
// -----------------------------------------------------------------------------

/**
 * Manages conversational skill creation and activation.
 *
 * Each user has an independent conversation state tracked in a Map.
 * The handler guides users through template selection, parameter collection,
 * skill preview, and activation with HITL approval.
 */
class SkillForgeHandler {
  /**
   * Create a new SkillForgeHandler
   * @param {Object} templateLoader - TemplateLoader instance
   * @param {Object} templateEngine - TemplateEngine instance
   * @param {Object} securityScanner - SecurityScanner instance
   * @param {Object} skillActivator - SkillActivator instance
   * @param {Function} [auditLog] - Audit logging function
   */
  constructor(templateLoader, templateEngine, securityScanner, skillActivator, auditLog) {
    this.templateLoader = templateLoader;
    this.templateEngine = templateEngine;
    this.securityScanner = securityScanner;
    this.skillActivator = skillActivator;
    this.auditLog = auditLog || (async () => {});

    /** @private @type {Map<string, ConversationState>} */
    this.userStates = new Map();

    // Clean up stale sessions every 10 minutes (30 min TTL)
    this._sessionTTLMs = 30 * 60 * 1000;
    this._cleanupInterval = setInterval(() => this._cleanupStaleSessions(), 10 * 60 * 1000);
  }

  /**
   * Handle a skill forge request
   * @param {string} message - User's text message
   * @param {Object} context - Request context
   * @param {string} context.user - User identifier
   * @param {string} [context.token] - Room token
   * @param {string} [context.messageId] - Message ID
   * @returns {Promise<SkillForgeHandlerResult>} Result with response message
   */
  async handle(message, context) {
    const user = context.user || 'unknown';
    const state = this.getState(user);
    state.lastActivity = Date.now();

    console.log(`[SkillForge] User: ${user}, State: ${state.state}, Message: ${message.substring(0, 60)}`);

    try {
      // Classify sub-intent based on current state and message
      const intent = this._classifyIntent(message, state);

      console.log(`[SkillForge] Intent: ${intent}`);

      let result;
      switch (intent) {
        case 'list':
          result = await this._handleList(user, state);
          break;

        case 'select':
          result = await this._handleSelect(message, user, state);
          break;

        case 'param_response':
          result = await this._handleParamResponse(message, user, state);
          break;

        case 'approve':
          result = await this._handleApprove(user, state);
          break;

        case 'activate':
          result = await this._handleActivate(user, state);
          break;

        case 'status':
          result = await this._handleStatus(user, state);
          break;

        case 'cancel':
          result = await this._handleCancel(user, state);
          break;

        default:
          result = {
            success: false,
            message: "I didn't understand that. Try:\n" +
                     "• 'list templates' - Browse available skill templates\n" +
                     "• 'status' - Check pending skills\n" +
                     "• 'cancel' - Cancel current session"
          };
      }

      return result;
    } catch (error) {
      console.error('[SkillForge] Error:', error);
      await this.auditLog('skillforge_error', { user, error: error.message });
      return {
        success: false,
        message: `Skill Forge error: ${error.message}`
      };
    }
  }

  /**
   * Get the current conversation state for a user
   * @param {string} user - User identifier
   * @returns {ConversationState} Current state object
   */
  getState(user) {
    if (!this.userStates.has(user)) {
      this.userStates.set(user, { state: 'idle', lastActivity: Date.now() });
    }
    return this.userStates.get(user);
  }

  /**
   * Reset a user's conversation state to idle
   * @param {string} user - User identifier
   */
  resetState(user) {
    this.userStates.delete(user);
  }

  // ---------------------------------------------------------------------------
  // Intent Classification
  // ---------------------------------------------------------------------------

  /**
   * Classify user intent based on current state and message
   * @private
   * @param {string} message - User's message
   * @param {ConversationState} state - Current conversation state
   * @returns {string} Classified intent
   */
  _classifyIntent(message, state) {
    const lower = message.toLowerCase().trim();

    // Cancel is always available
    if (lower === 'cancel' || lower === 'abort' || lower === 'stop' || lower === 'nevermind') {
      return 'cancel';
    }

    // Status is always available
    if (lower.includes('status') || lower.includes('pending skills') || lower.includes("what's pending")) {
      return 'status';
    }

    // State-specific intents
    switch (state.state) {
      case 'idle':
      case 'browsing':
        if (lower.includes('list') || lower.includes('browse') || lower.includes('templates') ||
            lower.includes('catalog') || lower.includes('what skills') || lower.includes('available')) {
          return 'list';
        }
        // Selection by number (e.g. "1", "2") or skill_id containing a hyphen (e.g. "trello-board")
        if (/^\d+$/.test(lower)) {
          return state.state === 'browsing' ? 'select' : 'list';
        }
        if (/^[a-z0-9]+-[a-z0-9-]+$/.test(lower)) {
          return 'select';
        }
        return 'list'; // Default to list if idle/browsing

      case 'selected':
        // Collecting parameters
        return 'param_response';

      case 'preview':
        // User is reviewing the assembled skill
        if (lower === 'yes' || lower === 'approve' || lower.includes('looks good') ||
            lower === 'confirm' || lower.includes('go ahead')) {
          return 'approve';
        }
        if (lower === 'no' || lower === 'reject') {
          return 'cancel';
        }
        return 'unknown';

      case 'pending':
        // Waiting for activation
        if (lower === 'activate' || lower === 'deploy' || lower.includes('go live')) {
          return 'activate';
        }
        return 'status'; // Show status if unclear

      default:
        return 'unknown';
    }
  }

  // ---------------------------------------------------------------------------
  // Sub-Intent Handlers
  // ---------------------------------------------------------------------------

  /**
   * Handle list/browse catalog request
   * @private
   */
  async _handleList(user, state) {
    const catalog = await this.templateLoader.loadCatalog();

    await this.auditLog('skillforge_list_catalog', { user, count: catalog.templates.length });

    // Format catalog as numbered list
    const lines = ['**Available Skill Templates:**\n'];

    catalog.templates.forEach((tpl, index) => {
      const num = index + 1;
      const category = tpl.category ? ` [${tpl.category}]` : '';
      lines.push(`[${num}] ${tpl.display_name}${category}`);
      lines.push(`    ${tpl.description}`);
      lines.push('');
    });

    lines.push('Reply with the number of your choice.');

    // Update state to browsing and store catalog
    state.state = 'browsing';
    state.catalog = catalog;

    return {
      success: true,
      message: lines.join('\n')
    };
  }

  /**
   * Handle template selection
   * @private
   */
  async _handleSelect(message, user, state) {
    // Load catalog if not already in state
    if (!state.catalog) {
      const catalog = await this.templateLoader.loadCatalog();
      state.catalog = catalog;
    }

    // Determine which template was selected
    let selectedTemplate = null;
    const trimmed = message.trim();

    // Check if message is a number (1-based index)
    if (/^\d+$/.test(trimmed)) {
      const index = parseInt(trimmed, 10) - 1;
      if (index >= 0 && index < state.catalog.templates.length) {
        selectedTemplate = state.catalog.templates[index];
      } else {
        return {
          success: false,
          message: `Invalid selection. Please choose a number between 1 and ${state.catalog.templates.length}.`
        };
      }
    } else {
      // Try to match by skill_id
      selectedTemplate = state.catalog.templates.find(t => t.skill_id === trimmed);
      if (!selectedTemplate) {
        return {
          success: false,
          message: `Template "${trimmed}" not found. Use 'list' to see available templates.`
        };
      }
    }

    // Load the full template
    const templatePath = selectedTemplate.file;
    const template = await this.templateLoader.load(templatePath);

    await this.auditLog('skillforge_select_template', { user, template_id: template.skill_id });

    // Initialize parameter collection
    state.state = 'selected';
    state.template = template;
    state.templatePath = templatePath;
    state.parameters = {};
    state.currentParamIndex = 0;

    // Separate collectable (user-facing) params from derived params
    const allParams = template.parameters || [];
    state.collectableParams = allParams.filter(p => !p.derived_from);

    // Check if template has collectable parameters
    if (state.collectableParams.length === 0) {
      // No user parameters needed, go straight to assembly
      return await this._assembleAndPreview(user, state);
    }

    // Start parameter collection with first collectable parameter
    const firstParam = state.collectableParams[0];
    const prompt = this._formatParameterPrompt(firstParam, 0, state.collectableParams.length);

    return {
      success: true,
      message: `**${template.display_name}**\n${template.description}\n\n${prompt}`
    };
  }

  /**
   * Handle parameter response during collection
   * @private
   */
  async _handleParamResponse(message, user, state) {
    const collectableParams = state.collectableParams;
    const paramIndex = state.currentParamIndex;
    const param = collectableParams[paramIndex];

    // Resolve select-type parameters: match user input to option value
    let resolvedValue = message.trim();
    if (param.type === 'select' && param.options) {
      resolvedValue = this._resolveSelectValue(resolvedValue, param.options);
    }

    // Store the parameter value
    state.parameters[param.id] = resolvedValue;

    // Move to next parameter
    state.currentParamIndex++;

    // Check if we have more collectable parameters to collect
    if (state.currentParamIndex < collectableParams.length) {
      const nextParam = collectableParams[state.currentParamIndex];
      const prompt = this._formatParameterPrompt(nextParam, state.currentParamIndex, collectableParams.length);

      return {
        success: true,
        message: prompt
      };
    }

    // All parameters collected, assemble and preview
    return await this._assembleAndPreview(user, state);
  }

  /**
   * Assemble skill from template and parameters, scan, and show preview
   * @private
   */
  async _assembleAndPreview(user, state) {
    const template = state.template;
    const parameters = state.parameters;

    // Compute derived parameters before assembly
    for (const paramDef of (template.parameters || [])) {
      if (paramDef.derived_from && parameters[paramDef.derived_from] !== undefined) {
        const sourceValue = parameters[paramDef.derived_from];
        parameters[paramDef.id] = this._applyTransform(sourceValue, paramDef.transform);
      }
    }

    // New format: structured operations → tool definitions
    if (this.templateEngine.isNewFormat(template)) {
      return this._assembleAndPreviewNewFormat(user, state, template, parameters);
    }

    // Assemble the skill
    let assembled;
    try {
      assembled = this.templateEngine.assemble(template, parameters);
    } catch (error) {
      // Assembly failed (validation error, etc.)
      await this.auditLog('skillforge_assembly_failed', { user, template_id: template.skill_id, error: error.message });
      return {
        success: false,
        message: `Failed to assemble skill: ${error.message}\n\nReply 'cancel' to start over.`
      };
    }

    // Resolve placeholders in security config (e.g. {{target_domain}} → actual value)
    const resolvedDomains = (template.security?.allowed_domains || []).map(d =>
      d.replace(/\{\{(\w+)\}\}/g, (_, key) => parameters[key] || d)
    );

    // Scan the assembled content
    const scanResult = this.securityScanner.scan(assembled.content, {
      allowed_domains: resolvedDomains,
      forbidden_patterns: template.security?.forbidden_patterns || []
    });

    if (!scanResult.safe) {
      // Security scan failed
      await this.auditLog('skillforge_security_violation', {
        user,
        template_id: template.skill_id,
        violations: scanResult.violations
      });

      const violationList = scanResult.violations.map(v => `• ${v}`).join('\n');
      return {
        success: false,
        message: `**Security scan failed!**\n\nViolations detected:\n${violationList}\n\nThis skill cannot be created. Please check your parameters and try again, or contact an administrator.`
      };
    }

    // Store assembled content and metadata
    state.generatedContent = assembled.content;
    state.metadata = {
      ...assembled.metadata,
      security_scan: {
        passed: true,
        scanned_at: new Date().toISOString(),
        warnings: scanResult.warnings
      },
      allowed_domains: resolvedDomains
    };

    // Transition to preview state
    state.state = 'preview';

    // Show preview
    const preview = this._formatSkillPreview(assembled.content, scanResult.warnings);

    await this.auditLog('skillforge_preview_generated', { user, template_id: template.skill_id });

    return {
      success: true,
      message: `**Skill Preview:**\n\n${preview}\n\nReply **yes** to save for review, or **no** to cancel.`
    };
  }

  /**
   * Assemble and preview for new-format templates (structured operations).
   * Uses generateToolDefinitions() + scanToolDefinitions() instead of SKILL.md assembly.
   * @private
   */
  async _assembleAndPreviewNewFormat(user, state, template, parameters) {
    let toolDefs;
    try {
      toolDefs = this.templateEngine.generateToolDefinitions(template, parameters);
    } catch (error) {
      await this.auditLog('skillforge_assembly_failed', { user, template_id: template.skill_id, error: error.message });
      return {
        success: false,
        message: `Failed to generate tool definitions: ${error.message}\n\nReply 'cancel' to start over.`
      };
    }

    // Security scan on structured definitions
    const scanResult = this.securityScanner.scanToolDefinitions(toolDefs);

    if (!scanResult.safe) {
      await this.auditLog('skillforge_security_violation', {
        user,
        template_id: template.skill_id,
        violations: scanResult.violations
      });
      const violationList = scanResult.violations.map(v => `• ${v}`).join('\n');
      return {
        success: false,
        message: `**Security scan failed!**\n\nViolations detected:\n${violationList}\n\nThis skill cannot be created. Please check your parameters and try again.`
      };
    }

    // Store for activation
    state.toolDefs = toolDefs;
    state.resolvedParams = parameters;
    state.isNewFormat = true;
    state.metadata = {
      template_id: template.skill_id,
      template_version: template.version,
      security_scan: { passed: true, scanned_at: new Date().toISOString(), warnings: scanResult.warnings },
      allowed_domains: toolDefs.security?.allowedDomains || []
    };

    // Transition to preview
    state.state = 'preview';

    // Build capability list for preview
    const toolList = toolDefs.operations.map(op =>
      `• **${template.skill_id}_${op.name.toLowerCase().replace(/[^a-z0-9]+/g, '_')}** — ${op.description}`
    ).join('\n');

    const warnings = scanResult.warnings.length > 0
      ? `\n\n⚠️ Warnings:\n${scanResult.warnings.map(w => `• ${w}`).join('\n')}`
      : '';

    await this.auditLog('skillforge_preview_generated', { user, template_id: template.skill_id });

    return {
      success: true,
      message: `**Skill Preview: ${toolDefs.displayName}**\n\nAfter activation, I'll be able to:\n${toolList}\n\nThese tools connect to ${toolDefs.apiBase} using your stored credentials.${warnings}\n\nReply **yes** to save for activation, or **no** to cancel.`
    };
  }

  /**
   * Handle approve action (save to pending)
   * @private
   */
  async _handleApprove(user, state) {
    const content = state.generatedContent;
    const metadata = state.metadata;

    // New format: direct activation via ToolActivator (security scan already passed in preview)
    if (state.isNewFormat && !this.toolActivator) {
      return {
        success: false,
        message: '**Activation unavailable:** ToolActivator is not configured. Please contact an administrator.'
      };
    }
    if (state.isNewFormat && this.toolActivator) {
      try {
        const result = await this.toolActivator.activate(state.template, state.resolvedParams);
        await this.auditLog('skillforge_skill_activated', {
          user,
          template_id: metadata.template_id,
          tools: result.toolsRegistered
        });
        this.resetState(user);
        const toolList = result.toolsRegistered.map(t => `• **${t}**`).join('\n');
        return {
          success: true,
          message: `**Connected!** I can now:\n${toolList}\n\nThese tools are active and ready to use.`
        };
      } catch (error) {
        await this.auditLog('skillforge_activation_failed', { user, template_id: metadata.template_id, error: error.message });
        return {
          success: false,
          message: `**Activation failed:** ${error.message}\n\nReply 'cancel' to start over.`
        };
      }
    }

    // Save to pending folder
    const result = await this.skillActivator.savePending(content, metadata);

    await this.auditLog('skillforge_saved_pending', {
      user,
      template_id: metadata.template_id,
      filename: result.filename
    });

    // Transition to pending state
    state.state = 'pending';
    state.pendingFilename = result.filename;

    return {
      success: true,
      message: `**Skill saved for review!**\n\nFilename: ${result.filename}\n\nThe skill is now in your pending folder. Reply **activate** to deploy it, or **cancel** to discard.`
    };
  }

  /**
   * Handle activate request (requires HITL confirmation)
   * @private
   */
  async _handleActivate(user, state) {
    const filename = state.pendingFilename;

    if (!filename) {
      return {
        success: false,
        message: "No pending skill to activate. Use 'list' to create a new skill."
      };
    }

    // Return confirmation request for HITL
    return {
      success: true,
      requiresConfirmation: true,
      confirmationType: 'activate_skill',
      pendingAction: {
        action: 'activate_skill',
        data: { filename }
      },
      message: `**Ready to activate skill: ${filename}**\n\nThis will deploy the skill and make it active.\n\nReply **yes** to confirm activation, or **no** to cancel.`
    };
  }

  /**
   * Handle status request (list pending skills)
   * @private
   */
  async _handleStatus(user, state) {
    const pending = await this.skillActivator.listPending();

    await this.auditLog('skillforge_status_check', { user, count: pending.length });

    if (pending.length === 0) {
      return {
        success: true,
        message: "No pending skills. Use 'list' to create a new skill from a template."
      };
    }

    const lines = [`**Pending Skills (${pending.length}):**\n`];

    pending.forEach((skill, index) => {
      const num = index + 1;
      const templateInfo = skill.template_id ? ` [${skill.template_id}]` : '';
      const created = skill.created ? ` - ${this._formatDate(skill.created)}` : '';
      lines.push(`${num}. ${skill.filename}${templateInfo}${created}`);
    });

    lines.push('\nReply **activate** to deploy the most recent skill, or start a new forge session with **list**.');

    return {
      success: true,
      message: lines.join('\n')
    };
  }

  /**
   * Handle cancel request
   * @private
   */
  async _handleCancel(user, state) {
    await this.auditLog('skillforge_session_cancelled', { user, previous_state: state.state });

    this.resetState(user);

    return {
      success: true,
      message: "Skill Forge session cancelled. Reply 'list' to start a new session."
    };
  }

  /**
   * Execute confirmed skill activation
   * This is called by MessageRouter after HITL approval
   * @param {Object} data - Pending action data
   * @param {string} data.filename - Pending skill filename
   * @param {string} user - User who approved the activation
   * @returns {Promise<SkillForgeHandlerResult>} Response with activation confirmation
   */
  async confirmActivateSkill(data, user) {
    const filename = data.filename;

    try {
      const result = await this.skillActivator.activate(filename);

      await this.auditLog('skillforge_skill_activated', {
        user,
        filename,
        skillName: result.skillName
      });

      // Reset user state to idle
      this.resetState(user);

      return {
        success: true,
        message: `**Skill activated!**\n\nSkill **${result.skillName}** is now active.\n\nThe skill file has been moved to your Memory/ActiveSkills folder.`
      };
    } catch (error) {
      await this.auditLog('skillforge_activation_failed', {
        user,
        filename,
        error: error.message
      });

      return {
        success: false,
        message: `**Activation failed:**\n\n${error.message}\n\nThe skill remains in the pending folder. Please check the error and try again.`
      };
    }
  }

  /**
   * Clean up stale user sessions (older than TTL)
   * @private
   */
  _cleanupStaleSessions() {
    const cutoff = Date.now() - this._sessionTTLMs;
    for (const [user, state] of this.userStates.entries()) {
      if (state.lastActivity && state.lastActivity < cutoff) {
        this.userStates.delete(user);
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Formatting Helpers
  // ---------------------------------------------------------------------------

  /**
   * Apply a transform to derive a parameter value from a source value.
   * @private
   */
  _applyTransform(sourceValue, transform) {
    switch (transform) {
      case 'domain':
        try {
          return new URL(sourceValue).hostname;
        } catch {
          // If URL parsing fails, try extracting domain-like string
          const match = sourceValue.match(/(?:https?:\/\/)?([^\/:\s]+)/);
          return match ? match[1] : sourceValue;
        }
      default:
        return sourceValue;
    }
  }

  /**
   * Resolve user input for a select-type parameter to the option value.
   * Accepts: exact value, exact label (case-insensitive), or 1-based index.
   * @private
   */
  _resolveSelectValue(input, options) {
    const normalized = input.toLowerCase();

    // Pass 1: exact value or exact label (case-insensitive)
    for (const opt of options) {
      const label = typeof opt === 'object' ? opt.label : String(opt);
      const value = typeof opt === 'object' ? opt.value : String(opt);

      if (input === value) return value;
      if (label.toLowerCase() === normalized) return value;
    }

    // Pass 2: partial match — label contains input or input contains label keyword
    const partialMatches = [];
    for (const opt of options) {
      const label = typeof opt === 'object' ? opt.label : String(opt);
      const value = typeof opt === 'object' ? opt.value : String(opt);
      const lowerLabel = label.toLowerCase();

      if (lowerLabel.includes(normalized) || normalized.includes(lowerLabel)) {
        partialMatches.push(value);
      }
    }
    if (partialMatches.length === 1) return partialMatches[0];

    // Pass 3: 1-based numeric index
    if (/^\d+$/.test(input)) {
      const idx = parseInt(input, 10) - 1;
      if (idx >= 0 && idx < options.length) {
        const opt = options[idx];
        return typeof opt === 'object' ? opt.value : String(opt);
      }
    }

    // No match — return as-is (validation will catch it)
    return input;
  }

  /**
   * Format a parameter prompt
   * @private
   */
  _formatParameterPrompt(param, index, total) {
    const lines = [];

    lines.push(`**Parameter ${index + 1} of ${total}: ${param.label || param.id}**`);

    if (param.ask) {
      lines.push(param.ask);
    }

    if (param.type === 'select' && param.options) {
      lines.push('');
      param.options.forEach((opt, i) => {
        const label = typeof opt === 'object' ? opt.label : opt;
        lines.push(`[${i + 1}] ${label}`);
      });
      lines.push('\nReply with the number of your choice.');
    }

    if (param.example) {
      lines.push(`\nExample: ${param.example}`);
    }

    const defaultVal = param.default_value || param.default;
    if (!param.required && defaultVal) {
      lines.push(`\n(Optional - default: ${defaultVal})`);
    }

    lines.push('\nYour response:');

    return lines.join('\n');
  }

  /**
   * Format a skill preview
   * @private
   */
  _formatSkillPreview(content, warnings) {
    const lines = [];

    // Extract skill name from frontmatter
    const nameMatch = content.match(/^---\n[\s\S]*?name:\s*(.+?)\n/);
    const skillName = nameMatch ? nameMatch[1].trim() : 'unknown';

    lines.push(`**Skill Name:** ${skillName}`);
    lines.push('');

    // Show first 600 characters of content
    const preview = content.length > 600
      ? content.substring(0, 600) + '...\n\n(truncated)'
      : content;

    lines.push('```');
    lines.push(preview);
    lines.push('```');

    if (warnings && warnings.length > 0) {
      lines.push('\n**Warnings:**');
      warnings.forEach(w => lines.push(`• ${w}`));
    }

    return lines.join('\n');
  }

  /**
   * Format date for display
   * @private
   */
  _formatDate(isoString) {
    const date = new Date(isoString);
    return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
  }
}

module.exports = { SkillForgeHandler };
