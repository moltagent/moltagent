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
const { MODES, normalizeModeName } = require('./cockpit-modes');

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
    this.routerChatBridge = config.routerChatBridge || null;
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

    // CostTracker (optional, for per-call audit logging + JSONL flush)
    this.costTracker = config.costTracker || null;

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

    // MessageProcessor (optional, for mode propagation to OOO auto-responder)
    this.messageProcessor = config.messageProcessor || null;

    // Active Cockpit mode (defaults to Full Auto)
    this._activeMode = MODES.FULL_AUTO;

    // Knowledge modules (optional, for agent memory)
    this.knowledgeLog = config.knowledgeLog || null;
    this.knowledgeBoard = config.knowledgeBoard || null;
    this.contextLoader = config.contextLoader || null;
    this.freshnessChecker = config.freshnessChecker || null;
    this.agentContext = ''; // Loaded on start()

    // Warm Memory (optional, for M2 micro-consolidation)
    this.warmMemory = config.warmMemory || null;

    // DeferralQueue + AgentLoop (optional, for Local Intelligence deferred task processing)
    this.deferralQueue = config.deferralQueue || null;
    this.agentLoop = config.agentLoop || null;

    // Collectives + NC Files (optional, for LearningLog sync to wiki)
    this.collectivesClient = config.collectivesClient || null;
    this.ncFilesClient = config.ncFilesClient || null;
    this._lastLearningLogHash = null;
    this._lastStatsHash = null;
    this._lastFreshnessResult = null;

    // DailyBriefing (optional, for daily digest poster)
    this.dailyBriefing = config.dailyBriefing || null;
    this.talkSendQueue = config.talkSendQueue || null;
    this.primaryRoomToken = config.primaryRoomToken || null;
    this._lastDigestDate = null;

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

    // Flush CostTracker audit log
    if (this.costTracker?.flush) {
      try {
        await this.costTracker.flush();
      } catch (err) {
        console.warn('[Heartbeat] CostTracker flush on shutdown failed:', err.message);
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
            'email-imap', 'email-smtp', 'claude-api-key'
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

      // @Mention handling runs regardless of quiet hours — a user tapping
      // Molti on the shoulder shouldn't have to wait until morning.
      // Mode-gated: skipped in Focus Mode and Out of Office.
      if (!this._isModeGated('flow')) {
        try {
          results.flow = await this._processFlowEvents();
        } catch (err) {
          console.warn('[Heartbeat] NC Flow processing error:', err.message);
          results.errors.push({ component: 'flow', error: err.message });
        }
      }

      // Read cockpit working hours + mode before the quiet hours gate so the
      // user's configured schedule and mode are authoritative from the first pulse.
      if (this.cockpitManager && !this._cockpitWorkingHours) {
        try {
          const cockpitConfig = await this.cockpitManager.readConfig();
          if (cockpitConfig?.system?.workingHours) {
            this._cockpitWorkingHours = cockpitConfig.system.workingHours;
          }
          // Early mode extraction so gating is active from the first pulse
          if (cockpitConfig?.mode) {
            const earlyMode = normalizeModeName(cockpitConfig.mode.name);
            if (earlyMode !== this._activeMode) {
              console.log(`[Heartbeat] Mode changed: ${this._activeMode} -> ${earlyMode}`);
              this._activeMode = earlyMode;
            }
            if (this.messageProcessor && this.messageProcessor.setMode) {
              this.messageProcessor.setMode(earlyMode);
            }
          }
        } catch {
          // Non-fatal — quiet hours fallback still works
        }
      }

      // Check quiet hours and working hours.
      // Cockpit working hours override hardcoded quiet hours when set.
      const cockpitHoursSet = !!this._cockpitWorkingHours;
      const outsideActiveHours = cockpitHoursSet
        ? !this._isWithinWorkingHours()   // cockpit is authoritative
        : this._isQuietHours();           // fallback to config quiet hours
      if (outsideActiveHours) {
        console.log('[Heartbeat] Outside active hours - minimal processing');
        this.state.lastRun = new Date();
        // Restore status to ready even during quiet hours (prevents status going stale)
        await this.statusIndicator?.setStatus('ready', { force: true });
        return results;
      }

      const level = this.settings.initiativeLevel;

      // Level >= 2: Deck processing
      if (level >= 2 && this.settings.deckEnabled && !this._isModeGated('deck')) {
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
      if (level >= 2 && this.settings.caldavEnabled && !this._isModeGated('calendar')) {
        try {
          results.calendar = await this._checkCalendar();
          this.state.lastCalendarCheck = new Date();
        } catch (err) {
          console.error('[Heartbeat] Calendar error:', err.message);
          results.errors.push({ component: 'calendar', error: err.message });
        }
      }

      // Level >= 2: Email inbox check
      if (level >= 2 && this.emailMonitor && !this._isModeGated('email')) {
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
      if (level >= 2 && this.rsvpTracker && this.rsvpTracker.trackedCount > 0 && !this._isModeGated('rsvp')) {
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
      if (level >= 3 && this.knowledgeBoard && !this._isModeGated('knowledge')) {
        try {
          results.knowledge = await this._checkKnowledgeBoard();
          this.state.lastKnowledgeCheck = new Date();
        } catch (err) {
          console.error('[Heartbeat] Knowledge board error:', err.message);
          results.errors.push({ component: 'knowledge', error: err.message });
        }
      }

      // Level >= 2: Workflow boards
      if (level >= 2 && this.workflowEngine && !this._isModeGated('workflow')) {
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

      // NC Flow events already processed above (before quiet hours gate)

      // Cockpit: Read config and update status cards (all levels)
      if (this.cockpitManager) {
        try {
          // Invalidate cache so card edits are picked up within one heartbeat
          this.cockpitManager.invalidateCache();
          const cockpitConfig = await this.cockpitManager.readConfig();

          // Propagate active mode from Cockpit
          if (cockpitConfig?.mode) {
            const newMode = normalizeModeName(cockpitConfig.mode.name);
            if (newMode !== this._activeMode) {
              console.log(`[Heartbeat] Mode changed: ${this._activeMode} -> ${newMode}`);
              this._activeMode = newMode;
            }
            // Propagate to MessageProcessor
            if (this.messageProcessor && this.messageProcessor.setMode) {
              this.messageProcessor.setMode(newMode);
            }
          }

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

              // Handle null (parse error) — keep current config
              if (mc === null) {
                console.warn('[Heartbeat] Models card parse error. Keeping current configuration.');
              } else if (mc.changed === false) {
                // Content unchanged — skip redundant propagation
              } else if (mc.players) {
                // Custom roster with player definitions — register providers
                await this._handleModelsUpdate(mc);
              } else if (mc.roster) {
                this.llmRouter.setRoster(mc.roster);
              } else if (mc.preset) {
                this.llmRouter.setPreset(mc.preset);
              }
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

          // Enrich cost report with provider type info (local vs cloud)
          const providerTypes = this._getProviderTypes();
          let costs = null;
          if (this.budgetEnforcer) {
            costs = this.budgetEnforcer.getFullReport();
            costs._providerTypes = providerTypes;
          }

          // Get router stats for Model Usage card
          let routerStats = null;
          if (this.llmRouter?.getStats) {
            routerStats = this.llmRouter.getStats();
            routerStats._providerTypes = providerTypes;
            // Attach budget provider data for monthly call counts
            if (costs?.providers) {
              routerStats.budget = { providers: costs.providers };
            }
          }

          // Enrich health with request success rate
          const health = this._getCockpitHealthMetrics(results.infra);
          // Use inner router stats if available (legacy wrapper exposes _router)
          const routerStats_ = this.llmRouter?._router?.stats || this.llmRouter?.stats;
          if (routerStats_ && routerStats_.totalCalls != null) {
            const total = routerStats_.totalCalls;
            const succeeded = routerStats_.successfulCalls || 0;
            health.requestStats = {
              total,
              succeeded,
              rate: total > 0 ? Math.round((succeeded / total) * 100) : 100
            };
          }

          // Update status cards with current metrics
          await this.cockpitManager.updateStatus({ health, costs, routerStats, costTracker: this.costTracker });

          // Flush CostTracker audit log to Nextcloud JSONL file
          if (this.costTracker) {
            try {
              await this.costTracker.flush();
            } catch (err) {
              console.error('[Heartbeat] Cost log flush failed:', err.message);
            }
          }

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
          if (results.freshness) {
            this._lastFreshnessResult = results.freshness;
          }
        } catch (err) {
          console.error('[Heartbeat] Freshness check error:', err.message);
          results.errors.push({ component: 'freshness', error: err.message });
        }
      }

      // Sync LearningLog to Collectives wiki (every pulse, hash-gated)
      if (this.collectivesClient && this.ncFilesClient) {
        try {
          const logFile = await this.ncFilesClient.readFile('Memory/LearningLog.md');
          if (logFile && logFile.content) {
            const hash = this._simpleHash(logFile.content);
            if (hash !== this._lastLearningLogHash) {
              await this.collectivesClient.writePageContent('Meta/Learning Log/Readme.md', logFile.content);
              this._lastLearningLogHash = hash;
              console.log('[Heartbeat] Synced LearningLog to Collectives');
            }
          }
        } catch (err) {
          // Silent on 404 (file doesn't exist yet) — warn on anything else
          if (!err.message?.includes('404')) {
            console.warn(`[Heartbeat] LearningLog sync failed: ${err.message}`);
          }
        }
      }

      // Knowledge Stats: auto-update Meta/Knowledge Stats wiki page (hash-gated)
      if (this.collectivesClient) {
        try {
          await this._updateKnowledgeStats();
        } catch (err) {
          if (!err.message?.includes('404')) {
            console.warn(`[Heartbeat] Knowledge stats update failed: ${err.message}`);
          }
        }
      }

      // Daily Digest poster: post morning summary to Talk at configured time
      if (this._cockpitDailyDigest && this._cockpitDailyDigest !== 'off' &&
          this.dailyBriefing && this.talkSendQueue && this.primaryRoomToken) {
        try {
          const today = this._todayDate();
          if (this._lastDigestDate !== today) {
            const targetHour = parseInt(this._cockpitDailyDigest.split(':')[0], 10);
            const now = new Date();
            const currentHour = parseInt(now.toLocaleTimeString('en-GB', {
              hour: '2-digit', hour12: false,
              timeZone: this.settings.timezone
            }), 10);

            if (currentHour === targetHour) {
              // Build briefing (temporarily clear date lock, restore in finally)
              const savedDate = this.dailyBriefing.lastBriefingDate;
              let briefing;
              try {
                this.dailyBriefing.lastBriefingDate = null;
                briefing = await this.dailyBriefing.checkAndBuild();
              } finally {
                this.dailyBriefing.lastBriefingDate = savedDate;
              }

              if (briefing) {
                const talkMessage = this._formatDigestForTalk(briefing);
                await this.talkSendQueue.enqueue(this.primaryRoomToken, talkMessage);
                this._lastDigestDate = today;
                console.log('[Heartbeat] Daily digest posted to Talk');
              }
            }
          }
        } catch (err) {
          console.warn(`[Heartbeat] Daily digest failed: ${err.message}`);
        }
      }

      // Level >= 3: Meeting prep
      if (level >= 3 && this.meetingPreparer && !this._isModeGated('meetingPrep')) {
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

      // Include active mode in results
      results.activeMode = this._activeMode;

      // Log heartbeat
      await this.auditLog('heartbeat_pulse', {
        durationMs: Date.now() - pulseStart,
        activeMode: this._activeMode,
        deckTasksProcessed: results.deck?.processed || 0,
        reviewFeedbackProcessed: results.review?.processed || 0,
        assignmentsProcessed: results.assignments?.processed || 0,
        upcomingMeetings: results.calendar?.upcoming?.length || 0,
        emailsChecked: results.email ? 1 : 0,
        rsvpChecked: results.rsvp?.checked || 0,
        rsvpChanges: results.rsvp?.changes || 0,
        knowledgePending: results.knowledge?.pending || 0,
        flowEventsProcessed: results.flow?.processed || 0,
        mentionsHandled: results.flow?.mentionsHandled || 0,
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

    // Local Intelligence: Process deferred tasks when cloud is available
    if (this.deferralQueue && !this._isModeGated('deferral')) {
      try {
        const deferralResult = await this.deferralQueue.processNext(this.agentLoop, 2);
        if (deferralResult.processed > 0) {
          results.deferral = deferralResult;
          console.log(`[Heartbeat] DeferralQueue: processed ${deferralResult.processed} task(s)`);
        }
      } catch (err) {
        console.warn(`[Heartbeat] DeferralQueue error: ${err.message}`);
        results.errors.push({ component: 'deferralQueue', error: err.message });
      }
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
  async _processFlowEvents() {
    // Atomic drain
    const events = this.externalEventQueue.splice(0, this.externalEventQueue.length);

    if (events.length === 0) {
      return { processed: 0, mentionsHandled: 0 };
    }

    // Group by type for summary
    const byType = {};
    for (const event of events) {
      byType[event.type] = (byType[event.type] || 0) + 1;
    }

    // Route deck_comment_added events to @mention handler
    let mentionsHandled = 0;
    const commentEvents = events.filter(e => e.type === 'deck_comment_added');
    for (const event of commentEvents) {
      try {
        const result = await this.deckProcessor.processMention(event, { agentLoop: this.agentLoop });
        if (result.handled) {
          mentionsHandled++;
        }
      } catch (err) {
        console.warn(`[Heartbeat] @mention processing error: ${err.message}`);
      }
    }

    // Summary logging
    const typeSummary = Object.entries(byType)
      .map(([type, count]) => `${type}:${count}`)
      .join(', ');
    console.log(`[Heartbeat] Processed ${events.length} NC Flow events: ${typeSummary}${mentionsHandled > 0 ? ` (${mentionsHandled} mentions handled)` : ''}`);

    // Update daily counter
    this.state.flowEventsProcessedToday += events.length;
    this.state.lastFlowProcess = new Date();

    return { processed: events.length, byType, mentionsHandled };
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
   * Check whether the given subsystem should be skipped under the active mode.
   *
   * @param {string} subsystem - One of: deck, calendar, email, rsvp, workflow,
   *   knowledge, meetingPrep, flow, deferral, infra, cockpit
   * @returns {boolean} true if the subsystem should be skipped
   * @private
   */
  _isModeGated(subsystem) {
    const mode = this._activeMode;
    if (mode === MODES.FULL_AUTO || mode === MODES.CREATIVE_SESSION) return false;
    if (mode === MODES.FOCUS_MODE) return subsystem !== 'cockpit' && subsystem !== 'infra';
    if (mode === MODES.MEETING_DAY) return !['cockpit', 'infra', 'calendar', 'rsvp', 'meetingPrep', 'flow'].includes(subsystem);
    if (mode === MODES.OUT_OF_OFFICE) return subsystem !== 'cockpit' && subsystem !== 'infra';
    return false;
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
    if (!parsed) return true; // fail-open: no cockpit config → always on

    // "00:00-00:00" means 24h availability
    if (parsed.start === parsed.end) return true;

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
   * Get provider type mapping (local vs cloud) from the LLM router.
   * Used to enrich cost and router stats for Cockpit display.
   * @private
   * @returns {Object} Map of providerId -> 'local' | 'cloud'
   */
  _getProviderTypes() {
    if (!this.llmRouter?.providers) return {};
    const types = {};
    // providers may be a Map or plain object
    const entries = this.llmRouter.providers instanceof Map
      ? this.llmRouter.providers
      : Object.entries(this.llmRouter.providers);
    for (const [id, provider] of entries) {
      types[id] = (typeof provider.isLocal === 'function' ? provider.isLocal() : provider.isLocal) ? 'local' : 'cloud';
    }
    return types;
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

  /**
   * Update the "Meta/Knowledge Stats" wiki page with page counts by section.
   * Only writes when stats have changed (hash-gated, excludes timestamp).
   * @private
   */
  async _updateKnowledgeStats() {
    const collectiveId = await this.collectivesClient.resolveCollective();
    const pages = await this.collectivesClient.listPages(collectiveId);
    if (!Array.isArray(pages)) return;

    // Count pages by section from filePath
    const META_OR_ROOT = new Set(['Meta', '']);
    const sectionCounts = {};
    let contentPages = 0;
    let totalPages = 0;

    for (const page of pages) {
      totalPages++;
      // filePath is like "People" or "Projects" or "Meta" or "" (root)
      const section = (page.filePath || '').split('/')[0] || '(root)';
      sectionCounts[section] = (sectionCounts[section] || 0) + 1;
      if (!META_OR_ROOT.has(section) && section !== '(root)') {
        contentPages++;
      }
    }

    const stats = { totalPages, contentPages, sectionCounts };

    // Hash comparison excluding timestamp
    const statsHash = this._simpleHash(JSON.stringify(stats));
    if (statsHash === this._lastStatsHash) return;

    // Format and write
    const markdown = this._formatKnowledgeStats(stats);
    await this.collectivesClient.writePageContent('Meta/Knowledge Stats/Readme.md', markdown);
    this._lastStatsHash = statsHash;
    console.log('[Heartbeat] Updated Knowledge Stats wiki page');
  }

  /**
   * Format knowledge stats into a markdown page.
   * @private
   * @param {Object} stats - { totalPages, contentPages, sectionCounts }
   * @returns {string} Markdown content
   */
  _formatKnowledgeStats(stats) {
    const now = new Date().toISOString().replace('T', ' ').substring(0, 19);
    let md = `# Knowledge Stats\n\n`;
    md += `*Auto-updated by Heartbeat — ${now} UTC*\n\n`;

    // Overview
    md += `## Overview\n\n`;
    md += `| Metric | Count |\n`;
    md += `|--------|-------|\n`;
    md += `| Total pages | ${stats.totalPages} |\n`;
    md += `| Content pages | ${stats.contentPages} |\n`;
    md += `| Sections | ${Object.keys(stats.sectionCounts).length} |\n\n`;

    // Pages by section
    md += `## Pages by Section\n\n`;
    md += `| Section | Pages |\n`;
    md += `|---------|-------|\n`;
    const sorted = Object.entries(stats.sectionCounts)
      .sort((a, b) => b[1] - a[1]);
    for (const [section, count] of sorted) {
      md += `| ${section} | ${count} |\n`;
    }

    // Freshness health (if available)
    if (this._lastFreshnessResult && this._lastFreshnessResult.checked !== false) {
      md += `\n## Freshness Health\n\n`;
      md += `| Metric | Value |\n`;
      md += `|--------|-------|\n`;
      md += `| Pages checked | ${this._lastFreshnessResult.checked || 0} |\n`;
      md += `| Flagged stale | ${this._lastFreshnessResult.flagged || 0} |\n`;
      if (this._lastFreshnessResult.updated) {
        md += `| Updated | ${this._lastFreshnessResult.updated} |\n`;
      }
    }

    return md;
  }

  /**
   * Simple string hash for change detection (djb2 variant).
   * @private
   * @param {string} str
   * @returns {number}
   */
  _simpleHash(str) {
    let hash = 0;
    for (let i = 0; i < str.length; i++) {
      hash = ((hash << 5) - hash) + str.charCodeAt(i);
      hash |= 0;
    }
    return hash;
  }

  /**
   * Get today's date string in the configured timezone (YYYY-MM-DD).
   * @private
   * @returns {string}
   */
  _todayDate() {
    const now = new Date();
    try {
      return now.toLocaleDateString('sv-SE', { timeZone: this.settings.timezone });
    } catch {
      return now.toISOString().split('T')[0];
    }
  }

  /**
   * Handle a Models card update with player definitions.
   * Registers new providers, removes stale ones, and updates the roster.
   * @private
   * @param {Object} modelsConfig - Parsed models config with players and roster
   */
  async _handleModelsUpdate(modelsConfig) {
    if (!modelsConfig?.players || !this.llmRouter) return;

    const { getProviderDefaults } = require('../providers/known-providers');
    const { OpenAIToolsProvider } = require('../agent/providers/openai-tools');
    const { ClaudeToolsProvider } = require('../agent/providers/claude-tools');
    const { OllamaToolsProvider } = require('../agent/providers/ollama-tools');

    // Track what we register for roster building
    const registeredIds = new Set();

    for (const [name, playerDef] of Object.entries(modelsConfig.players)) {
      // Build a provider ID from the player name
      const providerId = name;

      try {
        // Look up provider defaults
        const defaults = getProviderDefaults(playerDef.type);
        const adapter = defaults?.adapter || 'openai-compatible';
        const endpoint = playerDef.endpoint || defaults?.endpoint || null;
        const protocol = defaults?.protocol || 'openai';
        const isLocal = playerDef.local || defaults?.local || false;

        // Fetch API key if needed
        let apiKey = null;
        if (playerDef.credentialLabel && this.credentialBroker) {
          apiKey = await this.credentialBroker.get(playerDef.credentialLabel);
          if (!apiKey) {
            console.warn(
              `[Heartbeat] API key '${playerDef.credentialLabel}' not found in NC Passwords. ` +
              `Player '${name}' unavailable. Store the key and the agent will pick it up on next heartbeat.`
            );
            continue;
          }
        }

        // For local providers (ollama), use the configured ollama URL
        const effectiveEndpoint = isLocal
          ? (endpoint || this.config?.heartbeat?.ollamaUrl || 'http://localhost:11434')
          : endpoint;

        if (!isLocal && !effectiveEndpoint) {
          console.warn(`[Heartbeat] No endpoint for provider '${playerDef.type}'. Player '${name}' skipped.`);
          continue;
        }

        // Register base provider with router
        const apiKeySnapshot = apiKey;
        const getCredential = apiKeySnapshot ? (async () => apiKeySnapshot) : (async () => null);
        this.llmRouter.registerProvider(providerId, {
          adapter,
          endpoint: effectiveEndpoint,
          model: playerDef.model,
          type: isLocal ? 'local' : 'api',
          getCredential,
          costModel: isLocal ? { type: 'free' } : undefined,
        });

        // Register chat provider with RouterChatBridge
        if (this.routerChatBridge) {
          let chatProvider;
          if (isLocal && (playerDef.type === 'ollama' || playerDef.type === 'llama-cpp' || playerDef.type === 'vllm')) {
            chatProvider = new OllamaToolsProvider({
              endpoint: effectiveEndpoint,
              model: playerDef.model,
            });
          } else if (protocol === 'anthropic') {
            chatProvider = new ClaudeToolsProvider({
              model: playerDef.model,
              getApiKey: async () => apiKeySnapshot,
            });
          } else {
            chatProvider = new OpenAIToolsProvider({
              endpoint: effectiveEndpoint,
              model: playerDef.model,
              getApiKey: async () => apiKeySnapshot,
            });
          }
          this.routerChatBridge.registerChatProvider(providerId, chatProvider);
        }

        registeredIds.add(providerId);
        console.log(`[Heartbeat] Registered player: ${name} (${playerDef.type})`);
      } catch (err) {
        console.error(`[Heartbeat] Failed to register player '${name}': ${err.message}`);
      }
    }

    // Update roster if provided
    if (modelsConfig.roster && Object.keys(modelsConfig.roster).length > 0) {
      this.llmRouter.setRoster(modelsConfig.roster);
    }
  }

  /**
   * Format a DailyBriefing XML block into a readable Talk message.
   * @private
   * @param {string} briefing - The <daily_briefing> block from DailyBriefing.checkAndBuild()
   * @returns {string}
   */
  _formatDigestForTalk(briefing) {
    // Strip the XML tags and LLM instructions, keep data lines.
    // Keep top-level bullets ("- Calendar:") AND indented sub-lines ("  09:00 -- Meeting")
    const allLines = briefing
      .replace(/<\/?daily_briefing>/g, '')
      .split('\n');

    const lines = [];
    let inDataSection = false;
    for (const raw of allLines) {
      const trimmed = raw.trim();
      if (trimmed.startsWith('- ')) {
        inDataSection = true;
        lines.push(trimmed);
      } else if (inDataSection && raw.startsWith('  ') && trimmed.length > 0) {
        // Indented sub-line (e.g. calendar event times)
        lines.push('  ' + trimmed);
      } else if (trimmed === '') {
        inDataSection = false;
      }
    }

    let message = 'Good morning! Here\'s your daily briefing:\n\n';
    for (const line of lines) {
      message += line + '\n';
    }
    if (lines.length === 0) {
      message += '- All clear today\n';
    }
    message += '\nLet me know if you need anything!';
    return message;
  }
}

module.exports = HeartbeatManager;
