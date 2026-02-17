/**
 * MoltAgent Heartbeat Manager
 *
 * Periodic operations that run in the background:
 * - Process Deck inbox tasks
 * - Check upcoming calendar events
 * - Monitor for important notifications
 * - Cost-aware: uses local LLM for scanning
 *
 * @version 1.0.0
 */

const DeckClient = require('./deck-client');
const DeckTaskProcessor = require('./deck-task-processor');
const CalDAVClient = require('./caldav-client');
const appConfig = require('../config');

class HeartbeatManager {
  /**
   * @param {Object} config
   * @param {Object} config.nextcloud - Nextcloud connection config
   * @param {Object} config.deck - Deck configuration
   * @param {Object} config.caldav - CalDAV configuration
   * @param {Object} config.heartbeat - Heartbeat settings
   * @param {Object} config.ncRequestManager - NCRequestManager instance for CalDAV
   * @param {Object} config.llmRouter - LLM router instance
   * @param {Function} config.notifyUser - User notification function
   * @param {Function} config.auditLog - Audit logging function
   * @param {Object} [config.knowledgeLog] - LearningLog instance for agent memory
   * @param {Object} [config.knowledgeBoard] - KnowledgeBoard instance for verification tracking
   * @param {Object} [config.contextLoader] - ContextLoader instance for loading agent context
   * @param {Object} [config.commandHandler] - CapabilitiesCommandHandler for slash command processing
   * @param {Object} [config.capabilityRegistry] - CapabilityRegistry for provider status updates
   * @param {Object} [config.ncFlow] - NC Flow module references
   * @param {Object} [config.ncFlow.activityPoller] - ActivityPoller instance
   * @param {Object} [config.ncFlow.webhookReceiver] - WebhookReceiver instance
   * @param {Object} [config.ncFlow.systemTags] - SystemTagsClient instance
   * @param {Object} [config.cockpitManager] - CockpitManager instance for Deck control plane
   */
  constructor(config) {
    this.config = config;
    this.llmRouter = config.llmRouter;
    this.notifyUser = config.notifyUser || (async () => {});
    this.auditLog = config.auditLog || (async () => {});
    this.credentialBroker = config.credentialBroker;
    this.ncRequestManager = config.ncRequestManager;

    // NC Status Indicator (optional, sets Molti's NC user status)
    this.statusIndicator = config.statusIndicator || null;

    // Capabilities (optional, for command handling and status reporting)
    this.commandHandler = config.commandHandler || null;
    this.capabilityRegistry = config.capabilityRegistry || null;

    // NC Flow modules (optional, for workspace event awareness)
    this.ncFlow = config.ncFlow || null;
    this.externalEventQueue = [];

    // Initialize Deck client — prefer NCRequestManager when available
    const deckConfig = {
      nextcloud: {
        url: config.nextcloud.url,
        username: config.nextcloud.username
      },
      credentialBroker: config.credentialBroker,
      boardId: config.deck?.boardId,
      stacks: config.deck?.stacks,
      auditLog: this.auditLog
    };

    if (config.ncRequestManager) {
      this.deckClient = new DeckClient(config.ncRequestManager, {
        boardName: config.deck?.boardName || 'MoltAgent Tasks',
        stacks: config.deck?.stacks
      });
    } else {
      this.deckClient = new DeckClient(deckConfig);
    }

    // DeckTaskProcessor creates its own internal DeckClient
    this.deckProcessor = new DeckTaskProcessor(deckConfig, this.llmRouter, this.auditLog, {
      routeContext: { trigger: 'heartbeat_deck' }
    });
    // Replace processor's legacy DeckClient with NCRequestManager-backed one
    if (config.ncRequestManager) {
      this.deckProcessor.deck = this.deckClient;
    }

    // Initialize CalDAV client with NCRequestManager (new mode)
    if (config.ncRequestManager) {
      this.caldavClient = new CalDAVClient(
        config.ncRequestManager,
        config.credentialBroker,
        {
          ncUrl: config.nextcloud.url,
          username: config.nextcloud.username,
          auditLog: this.auditLog,
          timezone: config.heartbeat?.timezone ?? appConfig.timezone ?? 'UTC'
        }
      );
    } else {
      // Fallback for tests or legacy mode -- will fail on _request()
      this.caldavClient = new CalDAVClient({
        ncUrl: config.nextcloud.url,
        username: config.nextcloud.username,
        credentialBroker: config.credentialBroker,
        auditLog: this.auditLog,
        timezone: config.heartbeat?.timezone ?? appConfig.timezone ?? 'UTC'
      });
      console.warn('[Heartbeat] CalDAVClient created in legacy mode -- calendar operations will fail');
    }

    // Email monitor (optional, for inbox checking)
    this.emailMonitor = config.emailMonitor || null;

    // RSVP tracking (optional, for meeting attendance monitoring)
    this.rsvpTracker = config.rsvpTracker || null;

    // Budget enforcer (optional, for cost control)
    this.budgetEnforcer = config.budgetEnforcer || config.llmRouter?.budget || null;

    // Cockpit (optional, Deck as control plane)
    this.cockpitManager = config.cockpitManager || null;

    // Bot Enroller (optional, auto-enables Talk bot in rooms)
    this.botEnroller = config.botEnroller || null;
    this.pulseCount = 0;

    // Heartbeat Intelligence components (optional)
    this.meetingPreparer = config.meetingPreparer || null;
    this.hbFreshnessChecker = config.hbFreshnessChecker || null;

    // Workflow Engine (optional, for workflow board processing)
    this.workflowEngine = config.workflowEngine || null;

    // Infrastructure Monitor (optional, for service health probing)
    this.infraMonitor = config.infraMonitor || null;

    // VoiceManager (optional, for mode-aware voice orchestration)
    this.voiceManager = config.voiceManager || null;

    // Knowledge modules (optional, for agent memory)
    this.knowledgeLog = config.knowledgeLog || null;
    this.knowledgeBoard = config.knowledgeBoard || null;
    this.contextLoader = config.contextLoader || null;
    this.freshnessChecker = config.freshnessChecker || null;
    this.agentContext = ''; // Loaded on start()

    // Warm Memory (optional, for M2 micro-consolidation)
    this.warmMemory = config.warmMemory || null;

    // Heartbeat state
    this.state = {
      isRunning: false,
      lastRun: null,
      lastDeckProcess: null,
      lastReviewProcess: null,
      lastCalendarCheck: null,
      lastFlowProcess: null,
      lastFreshnessCheck: null,
      consecutiveFailures: 0,
      tasksProcessedToday: 0,
      reviewFeedbackProcessedToday: 0,
      notificationsSentToday: 0,
      flowEventsProcessedToday: 0,
      lastEmailCheck: null,
      emailsProcessedToday: 0,
      lastRsvpCheck: null,
      rsvpChangesToday: 0
    };

    // Heartbeat settings with defaults
    this.settings = {
      intervalMs: config.heartbeat?.intervalMs || appConfig.heartbeat.intervalMs,
      deckEnabled: config.heartbeat?.deckEnabled ?? appConfig.heartbeat.deckEnabled,
      caldavEnabled: config.heartbeat?.caldavEnabled ?? appConfig.heartbeat.caldavEnabled,
      maxTasksPerCycle: config.heartbeat?.maxTasksPerCycle || appConfig.heartbeat.maxTasksPerCycle,
      calendarLookaheadMinutes: config.heartbeat?.calendarLookaheadMinutes || appConfig.heartbeat.calendarLookaheadMinutes,
      notifyUpcomingMeetings: config.heartbeat?.notifyUpcomingMeetings !== false,
      quietHoursStart: config.heartbeat?.quietHoursStart ?? appConfig.heartbeat.quietHoursStart,
      quietHoursEnd: config.heartbeat?.quietHoursEnd ?? appConfig.heartbeat.quietHoursEnd,
      freshnessCheckIntervalMs: config.heartbeat?.freshnessCheckIntervalMs || appConfig.knowledge?.freshness?.checkIntervalMs || 3600000,
      initiativeLevel: config.heartbeat?.initiativeLevel ?? appConfig.proactive?.initiativeLevel ?? 1,
      timezone: config.heartbeat?.timezone ?? appConfig.timezone ?? 'UTC',
      ...config.heartbeat
    };

    this._intervalHandle = null;
    this._notifiedMeetings = new Set(); // Track notified meeting UIDs

    // Cockpit-propagated runtime config
    this._cockpitWorkingHours = null;   // "HH:MM-HH:MM" string from cockpit
    this._cockpitDailyDigest = null;    // "HH:MM" or "off" from cockpit
  }

  /**
   * Start the heartbeat loop
   */
  async start() {
    if (this.state.isRunning) {
      console.log('[Heartbeat] Already running');
      return;
    }

    console.log(`[Heartbeat] Starting with ${this.settings.intervalMs}ms interval`);
    this.state.isRunning = true;

    // Initialize knowledge board (creates Deck board if missing)
    if (this.knowledgeBoard) {
      try {
        await this.knowledgeBoard.initialize();
        console.log('[Heartbeat] Knowledge board initialized');
      } catch (err) {
        console.warn('[Heartbeat] Knowledge board initialization failed:', err.message);
      }
    }

    // Initialize Cockpit manager (Deck control plane)
    if (this.cockpitManager) {
      try {
        await this.cockpitManager.initialize();
        console.log('[Heartbeat] Cockpit manager initialized');
      } catch (err) {
        console.warn('[Heartbeat] Cockpit initialization failed:', err.message);
      }
    }

    // Restore budget state from file
    if (this.budgetEnforcer?.restore) {
      try {
        await this.budgetEnforcer.restore();
      } catch (err) {
        console.warn('[Heartbeat] Budget restore failed:', err.message);
      }
    }

    // Load agent memory context
    if (this.contextLoader) {
      try {
        this.agentContext = await this.contextLoader.loadContext();
        if (this.agentContext) {
          console.log(`[Heartbeat] Loaded ${this.agentContext.length} chars of agent memory`);
        }
      } catch (err) {
        console.warn('[Heartbeat] Context loading failed:', err.message);
      }
    }

    // Run immediately
    await this.pulse();

    // Then schedule
    this._intervalHandle = setInterval(() => {
      this.pulse().catch(err => {
        console.error('[Heartbeat] Pulse error:', err.message);
      });
    }, this.settings.intervalMs);

    await this.auditLog('heartbeat_started', {
      intervalMs: this.settings.intervalMs,
      deckEnabled: this.settings.deckEnabled,
      caldavEnabled: this.settings.caldavEnabled,
      emailEnabled: !!this.emailMonitor,
      initiativeLevel: this.settings.initiativeLevel
    });
  }

  /**
   * Stop the heartbeat loop
   */
  async stop() {
    if (!this.state.isRunning) {
      return;
    }

    console.log('[Heartbeat] Stopping');
    this.state.isRunning = false;

    if (this._intervalHandle) {
      clearInterval(this._intervalHandle);
      this._intervalHandle = null;
    }

    // Flush budget state to file
    if (this.budgetEnforcer?.persist) {
      try {
        await this.budgetEnforcer.persist();
      } catch (err) {
        console.warn('[Heartbeat] Budget persist on shutdown failed:', err.message);
      }
    }

    // Flush pending learning log writes
    if (this.knowledgeLog) {
      try {
        await this.knowledgeLog.shutdown();
        console.log('[Heartbeat] Knowledge log flushed');
      } catch (err) {
        console.warn('[Heartbeat] Knowledge log flush failed:', err.message);
      }
    }

    await this.auditLog('heartbeat_stopped', {
      tasksProcessedToday: this.state.tasksProcessedToday,
      notificationsSentToday: this.state.notificationsSentToday
    });
  }

  /**
   * Single heartbeat pulse
   */
  async pulse() {
    const pulseStart = Date.now();
    const results = {
      deck: null,
      review: null,
      assignments: null,
      calendar: null,
      email: null,
      knowledge: null,
      freshness: null,
      meetingPrep: null,
      botEnroll: null,
      infra: null,
      errors: []
    };

    this.pulseCount++;

    // Set status to heartbeat at start of pulse
    await this.statusIndicator?.setStatus('heartbeat');

    try {
      // STEP 0: Prefetch credentials (1 API call instead of 5-7)
      if (this.credentialBroker?.prefetchAll) {
        try {
          await this.credentialBroker.prefetchAll([
            'email-imap', 'email-smtp', 'claude-api-key', 'deepseek-api-key'
          ]);
        } catch (err) {
          console.warn('[Heartbeat] Credential prefetch error:', err.message);
          // Continue anyway - individual fetches will work
        }
      }

      // Bot enrollment: runs every pulse to catch new rooms quickly.
      // Cache makes this cheap — only new rooms trigger API calls.
      // Full cache reset every 6th pulse (~30 min) to retry failed rooms.
      if (this.botEnroller) {
        try {
          if (this.pulseCount % 6 === 0) {
            this.botEnroller.resetCache();
          }
          results.botEnroll = await this.botEnroller.enrollAll();
          if (results.botEnroll?.enrolled > 0) {
            console.log(`[Heartbeat] Bot enrolled in ${results.botEnroll.enrolled} new room(s)`);
          }
        } catch (err) {
          console.warn('[Heartbeat] Bot enrollment failed:', err.message);
          results.errors.push({ component: 'botEnroller', error: err.message });
        }
      }

      // Check quiet hours and working hours
      if (this._isQuietHours() || !this._isWithinWorkingHours()) {
        console.log('[Heartbeat] Outside active hours - minimal processing');
        this.state.lastRun = new Date();
        // Restore status to ready even during quiet hours (prevents status going stale)
        await this.statusIndicator?.setStatus('ready', { force: true });
        return results;
      }

      const level = this.settings.initiativeLevel;

      // Level >= 2: Deck processing
      if (level >= 2 && this.settings.deckEnabled) {
        try {
          results.deck = await this._processDeck();
          this.state.lastDeckProcess = new Date();
        } catch (err) {
          console.error('[Heartbeat] Deck error:', err.message);
          results.errors.push({ component: 'deck', error: err.message });
        }

        // Process comments from all stacks (not just review)
        try {
          results.review = await this._processReviewFeedback();
          this.state.lastReviewProcess = new Date();
        } catch (err) {
          console.error('[Heartbeat] Comment processing error:', err.message);
          results.errors.push({ component: 'review', error: err.message });
        }

        // Check for cards assigned to MoltAgent that need action
        try {
          results.assignments = await this._processAssignedCards();
          this.state.lastAssignmentCheck = new Date();
        } catch (err) {
          console.error('[Heartbeat] Assignment check error:', err.message);
          results.errors.push({ component: 'assignments', error: err.message });
        }
      }

      // Level >= 2: Calendar
      if (level >= 2 && this.settings.caldavEnabled) {
        try {
          results.calendar = await this._checkCalendar();
          this.state.lastCalendarCheck = new Date();
        } catch (err) {
          console.error('[Heartbeat] Calendar error:', err.message);
          results.errors.push({ component: 'calendar', error: err.message });
        }
      }

      // Level >= 2: Email inbox check
      if (level >= 2 && this.emailMonitor) {
        try {
          results.email = await this.emailMonitor.checkInbox();
          this.state.lastEmailCheck = new Date();
          this.state.emailsProcessedToday += results.email?.processed || 0;
        } catch (err) {
          console.error('[Heartbeat] Email check error:', err.message);
          results.errors.push({ component: 'email', error: err.message });
        }
      }

      // Level >= 2: RSVP tracking
      if (level >= 2 && this.rsvpTracker && this.rsvpTracker.trackedCount > 0) {
        try {
          results.rsvp = await this.rsvpTracker.checkUpdates();
          this.state.lastRsvpCheck = new Date();
          this.state.rsvpChangesToday += results.rsvp?.changes || 0;
        } catch (err) {
          console.error('[Heartbeat] RSVP check error:', err.message);
          results.errors.push({ component: 'rsvp', error: err.message });
        }
      }

      // Level >= 3: Knowledge board
      if (level >= 3 && this.knowledgeBoard) {
        try {
          results.knowledge = await this._checkKnowledgeBoard();
          this.state.lastKnowledgeCheck = new Date();
        } catch (err) {
          console.error('[Heartbeat] Knowledge board error:', err.message);
          results.errors.push({ component: 'knowledge', error: err.message });
        }
      }

      // Level >= 2: Workflow boards
      if (level >= 2 && this.workflowEngine) {
        try {
          results.workflow = await this.workflowEngine.processAll();
        } catch (err) {
          console.error('[Heartbeat] Workflow error:', err.message);
          results.errors.push({ component: 'workflow', error: err.message });
        }
      }

      // Infrastructure health check (every Nth pulse, all levels)
      if (this.infraMonitor && this.infraMonitor.shouldCheck(this.pulseCount)) {
        try {
          const infraResult = await this.infraMonitor.checkAll();
          results.infra = infraResult;
        } catch (err) {
          console.error('[Heartbeat] Infra monitor error:', err.message);
          results.errors.push({ component: 'infra', error: err.message });
        }
      }

      // Level >= 2: NC Flow events (informational, no LLM cost)
      if (level >= 2) {
        try {
          results.flow = this._processFlowEvents();
        } catch (err) {
          console.error('[Heartbeat] NC Flow processing error:', err.message);
          results.errors.push({ component: 'flow', error: err.message });
        }
      }

      // Cockpit: Read config and update status cards (all levels)
      if (this.cockpitManager) {
        try {
          const cockpitConfig = await this.cockpitManager.readConfig();

          // Propagate runtime settings from Cockpit
          if (cockpitConfig && cockpitConfig.system) {
            const newInitiative = cockpitConfig.system.initiativeLevel;
            if (newInitiative && newInitiative !== this.settings.initiativeLevel) {
              console.log(`[Heartbeat] Initiative level changed: ${this.settings.initiativeLevel} -> ${newInitiative}`);
              this.settings.initiativeLevel = newInitiative;
            }

            // Working hours propagation
            if (cockpitConfig.system.workingHours) {
              this._cockpitWorkingHours = cockpitConfig.system.workingHours;
            }

            // Daily digest propagation (stored for future consumer)
            if (cockpitConfig.system.dailyDigest !== undefined) {
              this._cockpitDailyDigest = cockpitConfig.system.dailyDigest;
            }

            // Models/roster propagation (B2)
            if (cockpitConfig.system.modelsConfig && this.llmRouter) {
              const mc = cockpitConfig.system.modelsConfig;
              if (mc.roster && this.llmRouter.setRoster) {
                this.llmRouter.setRoster(mc.roster);
              } else if (mc.preset && this.llmRouter.setPreset) {
                this.llmRouter.setPreset(mc.preset);
              }
            } else if (cockpitConfig.system.llmTier && this.llmRouter?.setTier) {
              // Deprecated fallback for old card format
              this.llmRouter.setTier(cockpitConfig.system.llmTier);
            }
          }

          // Propagate budget settings from Cockpit to BudgetEnforcer
          if (cockpitConfig?.budget && this.budgetEnforcer) {
            this.budgetEnforcer.updateBudgets({
              cloud: {
                daily: cockpitConfig.budget.dailyLimit,
                monthly: cockpitConfig.budget.monthlyLimit
              }
            });
          }

          // Propagate voice mode from Cockpit to VoiceManager
          if (this.voiceManager && cockpitConfig?.system?.voice) {
            this.voiceManager.setMode(cockpitConfig.system.voice);
          }

          // Propagate infra settings from Cockpit to InfraMonitor
          if (cockpitConfig?.system?.infra && this.infraMonitor) {
            const infraConf = cockpitConfig.system.infra;
            if (infraConf.checkInterval && infraConf.checkInterval !== this.infraMonitor.checkInterval) {
              console.log(`[Heartbeat] Infra check interval changed: ${this.infraMonitor.checkInterval} -> ${infraConf.checkInterval}`);
              this.infraMonitor.checkInterval = infraConf.checkInterval;
            }
          }

          // Update status cards with current metrics
          await this.cockpitManager.updateStatus({
            health: this._getCockpitHealthMetrics(results.infra),
            tasks: await this._getDeckTaskSummary(),
            costs: this.budgetEnforcer ? this.budgetEnforcer.getFullReport() : null,
            recentActions: this.state.recentActions || []
          });

          results.cockpit = { read: true, updated: true };
        } catch (err) {
          console.error('[Heartbeat] Cockpit error:', err.message);
          results.errors.push({ component: 'cockpit', error: err.message });
        }
      }

      // Persist budget state after cockpit update
      if (this.budgetEnforcer?.persist) {
        try {
          await this.budgetEnforcer.persist();
        } catch (err) {
          console.warn('[Heartbeat] Budget persist failed:', err.message);
        }
      }

      // Level >= 2: Knowledge freshness (heartbeat-intelligence variant, daily)
      if (level >= 2 && this.hbFreshnessChecker) {
        try {
          results.freshness = await this.hbFreshnessChecker.maybeCheck();
        } catch (err) {
          console.error('[Heartbeat] Freshness check error:', err.message);
          results.errors.push({ component: 'freshness', error: err.message });
        }
      }

      // Level >= 3: Meeting prep
      if (level >= 3 && this.meetingPreparer) {
        try {
          results.meetingPrep = await this.meetingPreparer.checkAndPrep();
        } catch (err) {
          console.error('[Heartbeat] Meeting prep error:', err.message);
          results.errors.push({ component: 'meetingPrep', error: err.message });
        }
      }

      // Update state
      this.state.lastRun = new Date();
      this.state.consecutiveFailures = results.errors.length > 0
        ? this.state.consecutiveFailures + 1
        : 0;

      // Log heartbeat
      await this.auditLog('heartbeat_pulse', {
        durationMs: Date.now() - pulseStart,
        deckTasksProcessed: results.deck?.processed || 0,
        reviewFeedbackProcessed: results.review?.processed || 0,
        assignmentsProcessed: results.assignments?.processed || 0,
        upcomingMeetings: results.calendar?.upcoming?.length || 0,
        emailsChecked: results.email ? 1 : 0,
        rsvpChecked: results.rsvp?.checked || 0,
        rsvpChanges: results.rsvp?.changes || 0,
        knowledgePending: results.knowledge?.pending || 0,
        flowEventsProcessed: results.flow?.processed || 0,
        botEnrolled: results.botEnroll?.enrolled || 0,
        infraChecked: results.infra ? 1 : 0,
        workflowBoards: results.workflow?.boardsProcessed || 0,
        workflowCards: results.workflow?.cardsProcessed || 0,
        cockpitUpdated: results.cockpit?.updated ? 1 : 0,
        freshnessChecked: typeof results.freshness?.checked === 'number' ? results.freshness.checked : (results.freshness?.checked === false ? -1 : 0),
        freshnessFlagged: results.freshness?.flagged || 0,
        meetingsPrepped: results.meetingPrep?.prepped || 0,
        errors: results.errors.length
      });

    } catch (err) {
      console.error('[Heartbeat] Fatal error:', err.message);
      this.state.consecutiveFailures++;
      results.errors.push({ component: 'heartbeat', error: err.message });
    }

    // M2 Future: Micro-consolidation of warm memory from active session context
    // When M2 implements extraction logic, uncomment and implement:
    // if (this.warmMemory) {
    //   try {
    //     await this.warmMemory.microConsolidate(this.agentContext);
    //   } catch (err) {
    //     console.warn('[Heartbeat] Warm memory micro-consolidation error:', err.message);
    //   }
    // }

    // Set status back to ready after pulse completes (force to refresh NC timeout)
    await this.statusIndicator?.setStatus('ready', { force: true });

    return results;
  }

  /**
   * Process Deck inbox tasks
   */
  async _processDeck() {
    try {
      // DeckTaskProcessor handles everything: scan, sort, process
      const processorResult = await this.deckProcessor.processInbox();

      if (processorResult.skipped) {
        return { processed: 0, queued: 0, errors: [], skipped: true };
      }

      // Update state
      this.state.tasksProcessedToday += processorResult.processed || 0;

      return {
        processed: processorResult.processed || 0,
        queued: processorResult.queued || 0,
        errors: processorResult.errors || []
      };

    } catch (err) {
      console.error('[Heartbeat] Deck processing error:', err.message);
      throw err;
    }
  }

  /**
   * Process Review cards with human feedback
   */
  async _processReviewFeedback() {
    try {
      const reviewResult = await this.deckProcessor.processReviewFeedback();

      if (reviewResult.skipped) {
        return { processed: 0, completed: 0, errors: [], skipped: true };
      }

      // Update state
      this.state.reviewFeedbackProcessedToday = (this.state.reviewFeedbackProcessedToday || 0) + (reviewResult.processed || 0);

      return {
        scanned: reviewResult.scanned || 0,
        processed: reviewResult.processed || 0,
        completed: reviewResult.completed || 0,
        errors: reviewResult.errors || []
      };

    } catch (err) {
      console.error('[Heartbeat] Review processing error:', err.message);
      throw err;
    }
  }

  /**
   * Process cards assigned to MoltAgent that need action
   */
  async _processAssignedCards() {
    try {
      const assignmentResult = await this.deckProcessor.processAssignedCards();

      if (assignmentResult.skipped) {
        return { scanned: 0, processed: 0, errors: [], skipped: true };
      }

      // Update state
      this.state.assignmentsProcessedToday = (this.state.assignmentsProcessedToday || 0) + (assignmentResult.processed || 0);

      return {
        scanned: assignmentResult.scanned || 0,
        actionNeeded: assignmentResult.actionNeeded || 0,
        processed: assignmentResult.processed || 0,
        byStack: assignmentResult.byStack || {},
        errors: assignmentResult.errors || []
      };

    } catch (err) {
      console.error('[Heartbeat] Assignment processing error:', err.message);
      throw err;
    }
  }

  /**
   * Check knowledge board for pending verifications
   * Logs a warning if there are too many unverified items
   * @returns {Promise<Object>} Knowledge board status
   */
  async _checkKnowledgeBoard() {
    if (!this.knowledgeBoard) return null;

    try {
      const status = await this.knowledgeBoard.getStatus();
      const uncertain = Math.max(0, status.stacks.uncertain || 0);
      const stale = Math.max(0, status.stacks.stale || 0);
      const pendingCount = uncertain + stale;

      if (pendingCount > 10) {
        console.log(`[Heartbeat] ${pendingCount} knowledge items awaiting verification`);
      }

      // Freshness check (rate-limited to once per interval)
      if (this.freshnessChecker && this._shouldRunFreshnessCheck()) {
        try {
          const freshnessResult = await this.freshnessChecker.checkAll();
          this.state.lastFreshnessCheck = new Date();
          if (freshnessResult.stale > 0) {
            console.log(`[Heartbeat] Freshness: ${freshnessResult.stale} stale pages found`);
          }
        } catch (err) {
          console.error('[Heartbeat] Freshness check error:', err.message);
        }
      }

      return {
        verified: Math.max(0, status.stacks.verified || 0),
        pending: pendingCount,
        disputed: Math.max(0, status.stacks.disputed || 0)
      };
    } catch (error) {
      console.error('[Heartbeat] Failed to check knowledge board:', error.message);
      throw error;
    }
  }

  /**
   * Check whether enough time has elapsed to run a freshness scan.
   * @returns {boolean}
   * @private
   */
  _shouldRunFreshnessCheck() {
    if (!this.state.lastFreshnessCheck) return true;
    return Date.now() - this.state.lastFreshnessCheck.getTime() >= this.settings.freshnessCheckIntervalMs;
  }

  /**
   * Enqueue an external event from NC Flow (ActivityPoller or WebhookReceiver).
   * @param {Object} event - NCFlowEvent object
   */
  enqueueExternalEvent(event) {
    if (!event || !event.type) return;
    this.externalEventQueue.push(event);
    // Cap queue at 500 events — drop oldest if full (informational, not critical)
    if (this.externalEventQueue.length > 500) {
      const dropped = this.externalEventQueue.length - 500;
      this.externalEventQueue.splice(0, dropped);
      console.warn(`[Heartbeat] NC Flow queue overflow: dropped ${dropped} oldest events`);
    }
    if (appConfig.debugMode) {
      console.log(`[Heartbeat] NC Flow event queued: ${event.type} (queue: ${this.externalEventQueue.length})`);
    }
  }

  /**
   * Process queued NC Flow events.
   * Drains the queue atomically, groups by type for summary logging.
   * The parent pulse() method includes the result in its audit log.
   * Does NOT take automated actions yet — that's a future session.
   * @returns {Object} { processed: number, byType: Object }
   * @private
   */
  _processFlowEvents() {
    // Atomic drain
    const events = this.externalEventQueue.splice(0, this.externalEventQueue.length);

    if (events.length === 0) {
      return { processed: 0 };
    }

    // Group by type for summary
    const byType = {};
    for (const event of events) {
      byType[event.type] = (byType[event.type] || 0) + 1;
    }

    // Summary logging
    const typeSummary = Object.entries(byType)
      .map(([type, count]) => `${type}:${count}`)
      .join(', ');
    console.log(`[Heartbeat] Processed ${events.length} NC Flow events: ${typeSummary}`);

    // Update daily counter
    this.state.flowEventsProcessedToday += events.length;
    this.state.lastFlowProcess = new Date();

    return { processed: events.length, byType };
  }

  /**
   * Check calendar for upcoming events
   */
  async _checkCalendar() {
    const result = {
      upcoming: [],
      notified: []
    };

    try {
      // Get events in the next N minutes (exclude cancelled)
      const lookahead = this.settings.calendarLookaheadMinutes;
      const allEvents = await this.caldavClient.getUpcomingEvents(lookahead / 60);
      const events = allEvents.filter(e => e.status !== 'CANCELLED');

      result.upcoming = events;

      // Notify about meetings starting soon
      if (this.settings.notifyUpcomingMeetings) {
        const now = Date.now();
        const notifyWindowMs = 15 * 60 * 1000; // 15 minutes before

        for (const event of events) {
          const eventStart = new Date(event.start).getTime();
          const timeUntil = eventStart - now;

          // Notify if within 15 minutes and not already notified
          if (timeUntil > 0 && timeUntil <= notifyWindowMs) {
            const notifyKey = `${event.uid}-${event.start}`;
            
            if (!this._notifiedMeetings.has(notifyKey)) {
              await this._notifyUpcomingMeeting(event, timeUntil);
              this._notifiedMeetings.add(notifyKey);
              result.notified.push(event);
              this.state.notificationsSentToday++;
            }
          }
        }

        // Clean up old notification keys (older than 1 hour)
        this._cleanupNotifiedMeetings();
      }

    } catch (err) {
      console.error('[Heartbeat] Calendar check error:', err.message);
      throw err;
    }

    return result;
  }

  /**
   * Notify user about upcoming meeting
   */
  async _notifyUpcomingMeeting(event, timeUntilMs) {
    const minutesUntil = Math.round(timeUntilMs / 60000);
    const startTime = new Date(event.start).toLocaleTimeString('en-US', {
      hour: '2-digit',
      minute: '2-digit'
    });

    let message = `📅 Upcoming in ${minutesUntil} minutes:\n`;
    message += `**${event.summary}**\n`;
    message += `⏰ ${startTime}`;
    
    if (event.location) {
      message += `\n📍 ${event.location}`;
    }

    if (event.attendees && event.attendees.length > 0) {
      message += `\n👥 ${event.attendees.length} attendee(s)`;
    }

    await this.notifyUser({
      type: 'calendar_reminder',
      urgency: minutesUntil <= 5 ? 'high' : 'normal',
      message,
      event
    });

    await this.auditLog('calendar_reminder_sent', {
      eventUid: event.uid,
      summary: event.summary,
      minutesUntil
    });
  }

  /**
   * Check if we're in quiet hours (timezone-aware)
   */
  _isQuietHours() {
    // Use configured timezone for hour calculation
    const tz = this.settings.timezone || 'UTC';
    let hour;
    try {
      const hourStr = new Intl.DateTimeFormat('en-US', {
        hour: 'numeric', hour12: false, timeZone: tz
      }).format(new Date());
      hour = parseInt(hourStr, 10);
    } catch {
      // Fallback if timezone is invalid
      hour = new Date().getHours();
    }
    const start = this.settings.quietHoursStart;
    const end = this.settings.quietHoursEnd;

    if (start > end) {
      // Quiet hours span midnight (e.g., 22:00 - 07:00)
      return hour >= start || hour < end;
    } else {
      // Quiet hours within same day
      return hour >= start && hour < end;
    }
  }

  /**
   * Parse a "HH:MM-HH:MM" working hours string into start/end hour integers.
   * @param {string} str - e.g. "08:00-18:00"
   * @returns {{start: number, end: number}|null} Parsed hours or null on invalid input
   */
  _parseWorkingHours(str) {
    if (!str || typeof str !== 'string') return null;
    const match = str.match(/^(\d{1,2}):(\d{2})\s*-\s*(\d{1,2}):(\d{2})$/);
    if (!match) return null;
    const start = parseInt(match[1], 10);
    const end = parseInt(match[3], 10);
    if (start < 0 || start > 23 || end < 0 || end > 23) return null;
    return { start, end };
  }

  /**
   * Check if current time is within configured working hours.
   * Uses cockpit-propagated working hours if set. Fail-open: returns true
   * if no working hours are configured (i.e., always within working hours).
   * @returns {boolean}
   */
  _isWithinWorkingHours() {
    const parsed = this._parseWorkingHours(this._cockpitWorkingHours);
    if (!parsed) return true; // fail-open

    const tz = this.settings.timezone || 'UTC';
    let hour;
    try {
      const hourStr = new Intl.DateTimeFormat('en-US', {
        hour: 'numeric', hour12: false, timeZone: tz
      }).format(new Date());
      hour = parseInt(hourStr, 10);
    } catch {
      hour = new Date().getHours();
    }

    if (parsed.start <= parsed.end) {
      return hour >= parsed.start && hour < parsed.end;
    } else {
      // Wraps midnight (e.g. 22:00-06:00)
      return hour >= parsed.start || hour < parsed.end;
    }
  }

  /**
   * Clean up old notification tracking
   */
  _cleanupNotifiedMeetings() {
    // Keep only the last 100 entries to prevent memory growth
    if (this._notifiedMeetings.size > 100) {
      const entries = Array.from(this._notifiedMeetings);
      this._notifiedMeetings = new Set(entries.slice(-50));
    }
  }

  /**
   * Get Deck task summary, transformed for Cockpit display.
   * Maps DeckClient stack counts to the format _formatTaskStatus expects.
   * @private
   * @returns {Promise<Object|null>} {open, inProgress, completed, overdue} or null
   */
  async _getDeckTaskSummary() {
    if (!this.deckClient) return null;
    try {
      const summary = await this.deckClient.getWorkloadSummary();
      return {
        open: (summary.inbox || 0) + (summary.queued || 0),
        inProgress: summary.working || 0,
        completed: summary.done || 0,
        overdue: 0
      };
    } catch {
      return null;
    }
  }

  /**
   * Build health metrics for Cockpit status card.
   * @private
   * @param {Object} [infraResult] - InfraMonitor checkAll() result, if available
   * @returns {Object} Health metrics object
   */
  _getCockpitHealthMetrics(infraResult) {
    const startedAt = this._startedAt || Date.now();
    const uptimeMs = Date.now() - startedAt;
    const uptimeHours = Math.floor(uptimeMs / (1000 * 60 * 60));
    const uptimeDays = Math.floor(uptimeHours / 24);

    const base = {
      status: this.state.consecutiveFailures > 3 ? 'ERROR' : 'OK',
      uptimeDays,
      uptimeHours: uptimeHours % 24,
      lastError: this.state.lastError || 'none'
    };

    if (infraResult) {
      base.infra = infraResult;
    }

    return base;
  }

  /**
   * Get heartbeat status
   */
  getStatus() {
    return {
      isRunning: this.state.isRunning,
      lastRun: this.state.lastRun,
      lastDeckProcess: this.state.lastDeckProcess,
      lastReviewProcess: this.state.lastReviewProcess,
      lastCalendarCheck: this.state.lastCalendarCheck,
      lastFlowProcess: this.state.lastFlowProcess,
      lastEmailCheck: this.state.lastEmailCheck,
      consecutiveFailures: this.state.consecutiveFailures,
      tasksProcessedToday: this.state.tasksProcessedToday,
      reviewFeedbackProcessedToday: this.state.reviewFeedbackProcessedToday,
      notificationsSentToday: this.state.notificationsSentToday,
      emailsProcessedToday: this.state.emailsProcessedToday,
      lastRsvpCheck: this.state.lastRsvpCheck,
      rsvpChangesToday: this.state.rsvpChangesToday,
      rsvpTracked: this.rsvpTracker ? this.rsvpTracker.trackedCount : 0,
      flowEventsProcessedToday: this.state.flowEventsProcessedToday,
      flowQueueLength: this.externalEventQueue.length,
      lastFreshnessCheck: this.hbFreshnessChecker?.lastCheckDate || null,
      meetingsPrepped: this.meetingPreparer?.preparedMeetings?.size || 0,
      initiativeLevel: this.settings.initiativeLevel,
      cockpitWorkingHours: this._cockpitWorkingHours,
      cockpitDailyDigest: this._cockpitDailyDigest,
      settings: this.settings
    };
  }

  /**
   * Reset daily counters (call at midnight)
   */
  resetDailyCounters() {
    this.state.tasksProcessedToday = 0;
    this.state.reviewFeedbackProcessedToday = 0;
    this.state.notificationsSentToday = 0;
    this.state.emailsProcessedToday = 0;
    this.state.rsvpChangesToday = 0;
    this.state.flowEventsProcessedToday = 0;
    this._notifiedMeetings.clear();
    this.meetingPreparer?.resetDaily();
    this.workflowEngine?.resetState();
  }

  /**
   * Force a single pulse (for testing or manual trigger)
   */
  async forcePulse() {
    return this.pulse();
  }

  /**
   * Get a summary of current system state for heartbeat context
   * (Used by the LLM for awareness)
   */
  async getHeartbeatContext() {
    const context = {
      timestamp: new Date().toISOString(),
      heartbeat: this.getStatus()
    };

    try {
      // Get today's calendar summary
      const calendarSummary = await this.caldavClient.getTodaySummary();
      context.calendar = {
        summary: calendarSummary.text,
        eventCount: calendarSummary.events.length
      };
    } catch (err) {
      context.calendar = { error: err.message };
    }

    try {
      // Get Deck inbox summary
      const inboxCards = await this.deckClient.scanInbox();
      context.deck = {
        inboxCount: inboxCards.length,
        urgentCount: inboxCards.filter(c =>
          c.labels?.some(l => l.title.toLowerCase() === 'urgent')
        ).length
      };

      // Get review cards summary
      const reviewCards = await this.deckClient.scanReviewCards();
      context.deck.reviewCount = reviewCards.length;
      context.deck.reviewWithFeedback = reviewCards.filter(c => c.humanComments?.length > 0).length;
    } catch (err) {
      context.deck = { error: err.message };
    }

    // Knowledge memory context
    if (this.knowledgeBoard) {
      try {
        const kbStatus = await this.knowledgeBoard.getStatus();
        context.knowledge = {
          verified: kbStatus.stacks.verified || 0,
          uncertain: kbStatus.stacks.uncertain || 0,
          stale: kbStatus.stacks.stale || 0,
          disputed: kbStatus.stacks.disputed || 0
        };
      } catch (err) {
        context.knowledge = { error: err.message };
      }
    }

    // NC Flow metrics
    if (this.ncFlow) {
      context.ncFlow = {
        queueLength: this.externalEventQueue.length,
        flowEventsProcessedToday: this.state.flowEventsProcessedToday
      };
      if (this.ncFlow.activityPoller?.getMetrics) {
        context.ncFlow.activityPoller = this.ncFlow.activityPoller.getMetrics();
      }
      if (this.ncFlow.webhookReceiver) {
        context.ncFlow.webhookEnabled = this.ncFlow.webhookReceiver.enabled || false;
      }
    }

    // Agent memory context string
    if (this.agentContext) {
      context.agentMemoryLength = this.agentContext.length;
    }

    return context;
  }
}

module.exports = HeartbeatManager;
