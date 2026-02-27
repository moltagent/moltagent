#!/usr/bin/env node
/**
 * MoltAgent Bot - Main Entry Point
 *
 * Starts the heartbeat manager for automated task processing.
 * Uses credential broker for secure credential management.
 *
 * @version 2.0.0
 */

const fs = require('fs');
const path = require('path');

// Load integrations
const HeartbeatManager = require('./lib/integrations/heartbeat-manager');
const DeckClient = require('./lib/integrations/deck-client');
const LLMRouter = require('./lib/llm-router');
const CredentialBroker = require('./lib/credential-broker');
const NCRequestManager = require('./lib/nc-request-manager');
const { LearningLog, KnowledgeBoard, ContextLoader, FreshnessChecker } = require('./lib/knowledge');
const { CapabilityRegistry, HelpGenerator, StatusReporter, CapabilitiesCommandHandler } = require('./lib/capabilities');
const { WebhookReceiver, ActivityPoller, SystemTagsClient } = require('./lib/nc-flow');
const appConfig = require('./lib/config');
const { TalkSendQueue } = require('./lib/talk/talk-send-queue');

let RSVPTracker;
try {
  RSVPTracker = require('./lib/integrations/rsvp-tracker');
} catch {
  console.warn('[WARN] RSVPTracker not available');
  RSVPTracker = null;
}

let CockpitManager;
try {
  CockpitManager = require('./lib/integrations/cockpit-manager');
} catch {
  console.warn('[WARN] CockpitManager not available');
  CockpitManager = null;
}

let BotEnroller;
try {
  BotEnroller = require('./lib/integrations/bot-enroller');
} catch {
  console.warn('[WARN] BotEnroller not available');
  BotEnroller = null;
}

let HeartbeatIntelligence;
try {
  HeartbeatIntelligence = require('./lib/integrations/heartbeat-intelligence');
} catch {
  console.warn('[WARN] HeartbeatIntelligence not available');
  HeartbeatIntelligence = null;
}

let DailyBriefing;
try {
  ({ DailyBriefing } = require('./lib/agent/daily-briefing'));
} catch {
  console.warn('[WARN] DailyBriefing not available');
  DailyBriefing = null;
}

let SessionManager;
try {
  SessionManager = require('../src/security/session-manager');
} catch {
  try {
    SessionManager = require('./security/session-manager');
  } catch {
    console.warn('[WARN] SessionManager not available');
    SessionManager = null;
  }
}

let SessionPersister;
try {
  SessionPersister = require('./lib/integrations/session-persister');
} catch {
  console.warn('[WARN] SessionPersister not available');
  SessionPersister = null;
}

let MemorySearcher;
try {
  MemorySearcher = require('./lib/integrations/memory-searcher');
} catch {
  console.warn('[WARN] MemorySearcher not available');
  MemorySearcher = null;
}

let NCFilesClient;
try {
  ({ NCFilesClient } = require('./lib/integrations/nc-files-client'));
} catch {
  console.warn('[WARN] NCFilesClient not available (bot)');
  NCFilesClient = null;
}

let NCSearchClient;
try {
  ({ NCSearchClient } = require('./lib/integrations/nc-search-client'));
} catch {
  console.warn('[WARN] NCSearchClient not available (bot)');
  NCSearchClient = null;
}

let WarmMemory;
try {
  WarmMemory = require('./lib/integrations/warm-memory');
} catch {
  console.warn('[WARN] WarmMemory not available (bot)');
  WarmMemory = null;
}

// Local Intelligence: ModelScout + MicroPipeline + DeferralQueue
let ModelScout, MicroPipeline, DeferralQueue;
try {
  ({ ModelScout } = require('./lib/providers/model-scout'));
  MicroPipeline = require('./lib/agent/micro-pipeline');
  DeferralQueue = require('./lib/agent/deferral-queue');
} catch (err) {
  console.warn(`[WARN] Local Intelligence modules not available: ${err.message}`);
  ModelScout = null;
  MicroPipeline = null;
  DeferralQueue = null;
}

// Session 37: Voice Pipeline
let WhisperClient, AudioConverter;
try {
  WhisperClient = require('./lib/providers/whisper-client');
  AudioConverter = require('./lib/providers/audio-converter');
} catch {
  console.warn('[WARN] Voice pipeline modules not available');
  WhisperClient = null;
  AudioConverter = null;
}

let CollectivesClient;
try {
  CollectivesClient = require('./lib/integrations/collectives-client');
} catch {
  console.warn('[WARN] CollectivesClient not available');
  CollectivesClient = null;
}

let ContactsClient;
try {
  ContactsClient = require('./lib/integrations/contacts-client');
} catch {
  console.warn('[WARN] ContactsClient not available');
  ContactsClient = null;
}

// Configuration (NO secrets here - only non-sensitive config)
const CONFIG = {
  nextcloud: {
    url: process.env.NC_URL || appConfig.nextcloud.url,
    username: process.env.NC_USER || appConfig.nextcloud.username
    // NOTE: Password comes from credential broker, NOT here
  },
  claude: {
    modelPremium: process.env.CLAUDE_MODEL_PREMIUM || appConfig.claude.modelPremium,
    modelStandard: process.env.CLAUDE_MODEL_STANDARD || appConfig.claude.modelStandard
  },
  ollama: {
    url: process.env.OLLAMA_URL || appConfig.ollama.url,
    model: process.env.OLLAMA_MODEL || appConfig.ollama.model,
    modelCredential: process.env.OLLAMA_MODEL_CREDENTIAL || process.env.OLLAMA_MODEL || appConfig.ollama.modelCredential
  },
  deck: {
    boardId: parseInt(process.env.DECK_BOARD_ID) || appConfig.deck.boardId
  },
  heartbeat: {
    intervalMs: parseInt(process.env.HEARTBEAT_INTERVAL) || appConfig.heartbeat.intervalMs,
    quietHoursStart: parseInt(process.env.QUIET_START) || appConfig.heartbeat.quietHoursStart,
    quietHoursEnd: parseInt(process.env.QUIET_END) || appConfig.heartbeat.quietHoursEnd,
    deckEnabled: appConfig.heartbeat.deckEnabled,
    caldavEnabled: appConfig.heartbeat.caldavEnabled,
    maxTasksPerCycle: appConfig.heartbeat.maxTasksPerCycle
  },
  talk: {
    // Primary room for proactive messages; falls back to legacy defaultToken
    primaryRoom: appConfig.talk?.primaryRoom || appConfig.talk?.defaultToken || null
  }
};

/**
 * Extract a named ## section from structured markdown.
 * @param {string} markdown
 * @param {string} sectionName
 * @returns {string|null}
 */
function _extractSection(markdown, sectionName) {
  if (!markdown) return null;
  const pattern = new RegExp(`## ${sectionName}\\s*\\n([\\s\\S]*?)(?=\\n## |$)`, 'i');
  const match = markdown.match(pattern);
  return match ? match[1].trim() : null;
}

// Global credential broker (initialized in main)
let credentialBroker = null;
let ncRequestManager = null;
let talkQueue = null;

// Audit log to Nextcloud Files
async function auditLog(event, data) {
  const timestamp = new Date().toISOString();
  const logLine = JSON.stringify({ timestamp, event, ...data }) + '\n';

  // Console output
  console.log(`[AUDIT] ${event}:`, JSON.stringify(data).substring(0, 200));

  // Could also write to NC Files here via WebDAV
}

// User notification (sends to NC Talk if configured)
async function notifyUser(notification) {
  const message = notification.message || JSON.stringify(notification);

  // Always log to console
  console.log(`[NOTIFY] ${notification.type || 'info'}: ${message}`);

  // If Talk not configured, console logging is sufficient
  if (!CONFIG.talk.primaryRoom || !ncRequestManager || !talkQueue) {
    if (!CONFIG.talk.primaryRoom) {
      console.warn('[NOTIFY] No primary room configured (set TALK_PRIMARY_ROOM or TALK_ROOM_TOKEN)');
    }
    return;
  }

  try {
    const result = await talkQueue.enqueue(CONFIG.talk.primaryRoom, message);
    if (!result) {
      console.warn('[NOTIFY] Talk API returned error, message logged only');
    }
  } catch (error) {
    console.warn(`[NOTIFY] Talk delivery failed: ${error.message}`);
  }
}

// Main startup
async function main() {
  console.log('');
  console.log('======================================================================');
  console.log('               MoltAgent Bot Starting...                              ');
  console.log('======================================================================');
  console.log('');
  console.log(`NC URL: ${CONFIG.nextcloud.url}`);
  console.log(`NC User: ${CONFIG.nextcloud.username}`);
  console.log(`Ollama: ${CONFIG.ollama.url} (${CONFIG.ollama.model})`);
  console.log(`Deck Board ID: ${CONFIG.deck.boardId}`);
  console.log(`Heartbeat: every ${CONFIG.heartbeat.intervalMs / 1000}s`);
  console.log(`Quiet Hours: ${CONFIG.heartbeat.quietHoursStart}:00 - ${CONFIG.heartbeat.quietHoursEnd}:00`);
  console.log(`Initiative Level: ${appConfig.proactive.initiativeLevel}`);
  console.log(`Proactive Budget: $${appConfig.proactive.dailyCloudBudget}/day`);
  console.log('');

  // Initialize Credential Broker
  console.log('[INIT] Setting up Credential Broker...');
  credentialBroker = new CredentialBroker({
    ncUrl: CONFIG.nextcloud.url,
    ncUsername: CONFIG.nextcloud.username,
    auditLog
  });

  // Test credential broker / NC Passwords connection
  try {
    // This tests that we can authenticate with NC
    const ncPassword = credentialBroker.getNCPassword();
    console.log('[INIT] Bootstrap credential loaded');

    // Optionally test NC Passwords API
    if (process.env.TEST_NC_PASSWORDS !== 'false') {
      const pwdTest = await credentialBroker.testConnection();
      if (pwdTest.connected) {
        console.log(`[INIT] NC Passwords connected. Available credentials: ${pwdTest.credentialCount}`);
      } else {
        console.warn(`[INIT] NC Passwords test failed: ${pwdTest.error}`);
        console.warn('[INIT] Continuing without NC Passwords integration...');
      }
    }
  } catch (err) {
    console.error(`[INIT] Credential broker error: ${err.message}`);
    console.error('[INIT] Check your bootstrap credential configuration.');
    console.error('[INIT] Options:');
    console.error('  1. systemd LoadCredential=nc-password:/path/to/credential');
    console.error('  2. NC_CREDENTIAL_FILE=/path/to/file');
    console.error('  3. NC_PASSWORD=password (not recommended for production)');
    process.exit(1);
  }

  // Initialize NC Request Manager for notifications
  ncRequestManager = new NCRequestManager({
    nextcloud: {
      url: CONFIG.nextcloud.url,
      username: CONFIG.nextcloud.username
    }
  });
  ncRequestManager.ncPassword = credentialBroker.getNCPassword();
  await ncRequestManager.resolveCanonicalUsername();
  talkQueue = new TalkSendQueue(ncRequestManager);
  console.log('[INIT] NC Request Manager ready for notifications');

  // Initialize NCFilesClient + WarmMemory (Session M1)
  let ncFilesClient = null;
  let warmMemory = null;
  if (NCFilesClient && ncRequestManager) {
    try {
      ncFilesClient = new NCFilesClient(ncRequestManager, { username: CONFIG.nextcloud.username });
    } catch (err) {
      console.warn(`[INIT] NCFilesClient (bot) failed: ${err.message}`);
    }
  }
  if (WarmMemory && ncFilesClient) {
    try {
      warmMemory = new WarmMemory({ ncFilesClient, logger: console });
      await warmMemory.load();
      console.log('[INIT] WarmMemory ready (bot)');
    } catch (err) {
      console.warn(`[INIT] WarmMemory (bot) failed: ${err.message}`);
      warmMemory = null;
    }
  }

  // Initialize NC Flow modules
  console.log('[INIT] Setting up NC Flow modules...');
  const webhookReceiver = new WebhookReceiver(appConfig.ncFlow.webhooks);
  const activityPoller = new ActivityPoller(
    appConfig.ncFlow.activity, ncRequestManager
  );
  const systemTags = new SystemTagsClient(
    appConfig.ncFlow.tags, ncRequestManager
  );

  // Refresh tag IDs from NC on startup
  if (appConfig.ncFlow.tags.enabled) {
    try {
      await systemTags.refreshTagIds();
      console.log('[INIT] SystemTags refreshed');
    } catch (err) {
      console.warn('[INIT] SystemTags refresh failed:', err.message);
    }
  }

  console.log('[INIT] NC Flow modules ready');

  // Initialize LLM Router with credential broker
  console.log('[INIT] Setting up LLM Router...');
  const llmRouter = new LLMRouter({
    ollama: CONFIG.ollama,
    auditLog,
    // Provide credential getter for API keys
    getCredential: credentialBroker.createGetter(),
    proactiveDailyBudget: appConfig.proactive.dailyCloudBudget
  });

  // Test Ollama connection
  const ollamaTest = await llmRouter.testConnection();
  if (ollamaTest.connected) {
    console.log(`[INIT] Ollama connected. Models: ${ollamaTest.models.join(', ')}`);
  } else {
    console.error(`[INIT] Ollama connection failed: ${ollamaTest.error}`);
    console.error('[INIT] Continuing anyway - will retry on heartbeat...');
  }

  // Initialize Knowledge modules (agent memory)
  console.log('[INIT] Setting up Knowledge modules...');
  const learningLog = new LearningLog({
    ncRequestManager,
    logPath: '/Memory/LearningLog.md',
    username: CONFIG.nextcloud.username
  });

  // Knowledge board uses a SEPARATE DeckClient configured for the knowledge board
  const knowledgeDeckClient = new DeckClient(ncRequestManager, {
    boardName: 'MoltAgent Knowledge',
    stacks: {
      verified: 'Verified',
      uncertain: 'Uncertain',
      stale: 'Stale',
      disputed: 'Disputed'
    }
  });

  const knowledgeBoard = new KnowledgeBoard({
    deckClient: knowledgeDeckClient
  });

  const contextLoader = new ContextLoader({
    learningLog,
    knowledgeBoard
  });

  // Initialize FreshnessChecker for stale page detection
  let freshnessChecker = null;
  try {
    freshnessChecker = new FreshnessChecker({
      collectivesClient: null,  // CollectivesClient not available in bot.js
      knowledgeBoard,
      config: {
        maxPagesPerScan: appConfig.knowledge.freshness.maxPagesPerScan,
        defaultDecayDays: appConfig.knowledge.defaultDecayDays
      }
    });
  } catch (err) {
    console.warn('[INIT] FreshnessChecker failed:', err.message);
  }

  console.log('[INIT] Knowledge modules ready');

  // Initialize Capabilities (agent self-documentation)
  console.log('[INIT] Setting up Capabilities...');
  const capabilityRegistry = new CapabilityRegistry();
  capabilityRegistry.initialize();

  // Register integrations based on config
  if (CONFIG.heartbeat.deckEnabled) {
    capabilityRegistry.registerIntegration({
      name: 'deck',
      description: 'Nextcloud Deck task management and processing',
      enabled: true
    });
  }

  if (CONFIG.heartbeat.caldavEnabled) {
    capabilityRegistry.registerIntegration({
      name: 'calendar',
      description: 'CalDAV calendar integration (events, reminders)',
      enabled: true
    });
  }

  capabilityRegistry.registerIntegration({
    name: 'knowledge',
    description: 'Agent memory via LearningLog and KnowledgeBoard',
    enabled: true
  });

  // Set initial provider statuses based on connection tests
  capabilityRegistry.setProviderStatus(
    'ollama',
    ollamaTest.connected ? 'online' : 'offline',
    ollamaTest.connected ? `Models: ${ollamaTest.models.join(', ')}` : ollamaTest.error || 'Connection failed'
  );
  capabilityRegistry.setProviderStatus('nextcloud', 'online', CONFIG.nextcloud.url);

  const helpGenerator = new HelpGenerator(capabilityRegistry);
  const statusReporter = new StatusReporter(capabilityRegistry, {
    knowledgeBoard
    // heartbeat is set after HeartbeatManager is created (see below)
  });
  const capabilitiesCommandHandler = new CapabilitiesCommandHandler({
    registry: capabilityRegistry,
    helpGenerator,
    statusReporter
  });

  console.log(`[INIT] Capabilities registered: ${capabilityRegistry.getAllCapabilities().length}`);

  // Initialize CockpitManager (Deck as control plane)
  let cockpitManager = null;
  if (CockpitManager && ncRequestManager && appConfig.cockpit?.enabled !== false) {
    try {
      const cockpitDeckClient = new DeckClient(ncRequestManager, {
        boardName: appConfig.cockpit?.boardTitle || 'Moltagent Cockpit'
      });
      cockpitManager = new CockpitManager({
        deckClient: cockpitDeckClient,
        config: {
          adminUser: appConfig.cockpit?.adminUser || appConfig.knowledge?.adminUser || '',
          boardTitle: appConfig.cockpit?.boardTitle,
          cacheTTLMs: appConfig.cockpit?.cacheTTLMs
        },
        auditLog
      });
      console.log('[INIT] CockpitManager ready');
    } catch (err) {
      console.warn(`[INIT] CockpitManager failed: ${err.message}`);
    }
  }

  // Initialize Heartbeat Intelligence components
  let meetingPreparer = null;
  let heartbeatFreshnessChecker = null;
  let collectivesClient = null;
  let contactsClient = null;

  if (CollectivesClient && ncRequestManager) {
    try {
      collectivesClient = new CollectivesClient(ncRequestManager, {
        collectiveName: appConfig.knowledge?.collectiveName || 'Moltagent Knowledge'
      });
      console.log('[INIT] CollectivesClient (bot) ready');
    } catch (err) {
      console.warn(`[INIT] CollectivesClient (bot) failed: ${err.message}`);
    }
  }

  if (ContactsClient && ncRequestManager) {
    try {
      contactsClient = new ContactsClient(ncRequestManager, {
        collectivesClient: collectivesClient,
        auditLog
      });
      console.log('[INIT] ContactsClient (bot) ready');
    } catch (err) {
      console.warn(`[INIT] ContactsClient (bot) failed: ${err.message}`);
    }
  }

  // Initialize Session Manager and Persister (Session 29b)
  let sessionMgr = null;
  let memorySearcher = null;
  let sessionCleanupTimer = null;

  if (SessionManager) {
    sessionMgr = new SessionManager();

    if (SessionPersister && collectivesClient && llmRouter) {
      try {
        const persister = new SessionPersister({
          wikiClient: collectivesClient,
          llmRouter: llmRouter,
          config: appConfig
        });
        sessionMgr.on('sessionExpired', async (session) => {
          try {
            const page = await persister.persistSession(session);
            if (page) {
              console.log(`[SessionPersister] Saved session summary: ${page}`);
              // NC Unified Search manages its own index — no cache to invalidate

              // M1: Consolidate warm memory from session summary
              if (warmMemory && persister.lastSummary) {
                try {
                  const continuation = _extractSection(persister.lastSummary, 'Continuation');
                  const openItems = _extractSection(persister.lastSummary, 'Open Items');
                  await warmMemory.consolidate({
                    continuation: continuation || '',
                    openItems: openItems || '',
                    timestamp: new Date().toISOString()
                  });
                  console.log('[WarmMemory] Consolidated from session summary (bot)');
                } catch (wmErr) {
                  console.error('[WarmMemory] Consolidation failed:', wmErr.message);
                }
              }
            }
          } catch (err) {
            console.error('[SessionPersister] Failed:', err.message);
          }
        });
        console.log('[INIT] SessionPersister ready (bot, wired to sessionExpired events)');
      } catch (err) {
        console.warn(`[INIT] SessionPersister (bot) failed: ${err.message}`);
      }
    }

    // Start periodic cleanup timer
    sessionCleanupTimer = setInterval(() => {
      try {
        const result = sessionMgr.cleanup();
        if (result.sessions > 0 || result.approvals > 0) {
          console.log(`[SessionManager] Cleanup: ${result.sessions} sessions, ${result.approvals} approvals expired`);
        }
      } catch (err) {
        console.error('[SessionManager] Cleanup error:', err.message);
      }
    }, 5 * 60 * 1000);
    console.log('[INIT] SessionManager ready (bot, cleanup timer started)');
  }

  // Initialize MemorySearcher (M2: NC Unified Search)
  let ncSearchClient = null;
  if (NCSearchClient && ncRequestManager) {
    try {
      ncSearchClient = new NCSearchClient(ncRequestManager);
    } catch (err) {
      console.warn(`[INIT] NCSearchClient (bot) failed: ${err.message}`);
    }
  }
  if (MemorySearcher && ncSearchClient) {
    try {
      memorySearcher = new MemorySearcher({
        ncSearchClient,
        logger: console
      });
      memorySearcher.discoverProviders().catch(err =>
        console.warn(`[MemorySearcher] Provider discovery failed (bot): ${err.message}`)
      );
      console.log('[INIT] MemorySearcher ready (bot, NC Unified Search)');
    } catch (err) {
      console.warn(`[INIT] MemorySearcher (bot) failed: ${err.message}`);
    }
  }

  if (HeartbeatIntelligence) {
    try {
      const { MeetingPreparer, FreshnessChecker: HBFreshnessChecker } = HeartbeatIntelligence;

      // MeetingPreparer needs caldav - we'll wire it after HeartbeatManager creates its caldav

      if (collectivesClient) {
        heartbeatFreshnessChecker = new HBFreshnessChecker({
          collectivesClient: collectivesClient,
          deckClient: knowledgeDeckClient,
          notifyUser,
          config: appConfig
        });
      }

      console.log('[INIT] Heartbeat Intelligence components ready');
    } catch (err) {
      console.warn(`[INIT] Heartbeat Intelligence failed: ${err.message}`);
    }
  }

  // Initialize BotEnroller (auto-enable Talk bot in rooms)
  let botEnrollerInstance = null;
  if (BotEnroller && ncRequestManager) {
    try {
      botEnrollerInstance = new BotEnroller({
        ncRequestManager,
        botName: appConfig.talk.botName,
        auditLog
      });
      console.log('[INIT] BotEnroller ready');
    } catch (err) {
      console.warn(`[INIT] BotEnroller failed: ${err.message}`);
    }
  }

  // Local Intelligence: ModelScout + MicroPipeline + DeferralQueue
  let deferralQueue = null;
  if (ModelScout) {
    try {
      const modelScout = new ModelScout({
        ollamaEndpoint: CONFIG.ollama.url,
        logger: console
      });

      modelScout.discover().then(() => {
        const localRoster = modelScout.generateLocalRoster();
        if (localRoster && llmRouter) {
          llmRouter.router.setLocalRoster(localRoster);
          console.log(`[INIT] Local roster (bot): ${modelScout.getSummary()}`);
        }
      }).catch(err => {
        console.warn(`[INIT] ModelScout discovery failed (bot): ${err.message}`);
      });
    } catch (err) {
      console.warn(`[INIT] ModelScout failed (bot): ${err.message}`);
    }
  }

  if (DeferralQueue && ncFilesClient && llmRouter) {
    try {
      deferralQueue = new DeferralQueue({
        ncFilesClient,
        llmRouter: llmRouter.router,
        logger: console
      });
      deferralQueue.load().catch(err =>
        console.warn(`[INIT] DeferralQueue load failed (bot): ${err.message}`)
      );
      console.log('[INIT] DeferralQueue ready (bot)');
    } catch (err) {
      console.warn(`[INIT] DeferralQueue failed (bot): ${err.message}`);
    }
  }

  // Initialize Heartbeat Manager with credential broker
  console.log('[INIT] Setting up Heartbeat Manager...');
  const heartbeat = new HeartbeatManager({
    nextcloud: {
      url: CONFIG.nextcloud.url,
      username: CONFIG.nextcloud.username
      // No password here - use credential broker
    },
    credentialBroker,  // Pass the broker
    ncRequestManager,  // Pass NCRequestManager for CalDAV
    deck: CONFIG.deck,
    heartbeat: {
      ...CONFIG.heartbeat,
      initiativeLevel: appConfig.proactive.initiativeLevel
    },
    llmRouter,
    notifyUser,
    auditLog,
    knowledgeLog: learningLog,
    knowledgeBoard,
    contextLoader,
    freshnessChecker,
    commandHandler: capabilitiesCommandHandler,
    capabilityRegistry,
    cockpitManager,
    meetingPreparer,
    botEnroller: botEnrollerInstance,
    deferralQueue,
    ncFlow: { activityPoller, webhookReceiver, systemTags },
    talkSendQueue: talkQueue,
    primaryRoomToken: CONFIG.talk.primaryRoom
  });

  // Initialize RSVPTracker (uses heartbeat's internal CalDAV client)
  if (RSVPTracker && heartbeat.caldavClient) {
    try {
      const rsvpTracker = new RSVPTracker({
        caldavClient: heartbeat.caldavClient,
        notifyUser: notifyUser,
        auditLog: auditLog
      });
      heartbeat.rsvpTracker = rsvpTracker;
      console.log('[INIT] RSVPTracker ready');
    } catch (err) {
      console.warn(`[INIT] RSVPTracker failed: ${err.message}`);
    }
  }

  // Wire Heartbeat Intelligence components with HeartbeatManager's caldav
  if (HeartbeatIntelligence && heartbeat.caldavClient) {
    try {
      const { MeetingPreparer } = HeartbeatIntelligence;

      // Create meeting preparer now that we have caldav
      meetingPreparer = new MeetingPreparer({
        caldavClient: heartbeat.caldavClient,
        collectivesClient: collectivesClient,
        contactsClient: contactsClient,
        emailMonitor: null,
        deckClient: heartbeat.deckClient,
        router: llmRouter,
        notifyUser,
        config: appConfig
      });
      heartbeat.meetingPreparer = meetingPreparer;

      // Wire freshness checker
      if (heartbeatFreshnessChecker) {
        heartbeat.hbFreshnessChecker = heartbeatFreshnessChecker;
      }

      console.log('[INIT] Heartbeat Intelligence wired to HeartbeatManager');
    } catch (err) {
      console.warn(`[INIT] Heartbeat Intelligence wiring failed: ${err.message}`);
    }
  }

  // Wire DailyBriefing for morning digest poster
  if (DailyBriefing) {
    try {
      heartbeat.dailyBriefing = new DailyBriefing({
        caldavClient: heartbeat.caldavClient,
        deckClient: heartbeat.deckClient,
        budgetEnforcer: llmRouter.budget,
        collectivesClient: collectivesClient,
        timezone: heartbeat.settings.timezone
      });
      console.log('[INIT] DailyBriefing wired to HeartbeatManager');
    } catch (err) {
      console.warn(`[INIT] DailyBriefing wiring failed: ${err.message}`);
    }
  }

  // Wire heartbeat reference into StatusReporter (circular dependency resolved here)
  statusReporter.heartbeat = heartbeat;

  // Wire NC Flow events into HeartbeatManager
  const handleFlowEvent = (event) => heartbeat.enqueueExternalEvent(event);
  activityPoller.on('event', handleFlowEvent);
  webhookReceiver.on('event', handleFlowEvent);

  // Register NC Flow integration in capabilities
  capabilityRegistry.registerIntegration({
    name: 'nc-flow',
    description: 'Nextcloud workspace event awareness (activity polling, system tags)',
    enabled: appConfig.ncFlow.activity.enabled || appConfig.ncFlow.webhooks.enabled
  });

  // Handle shutdown gracefully
  let shuttingDown = false;

  async function shutdown(signal) {
    if (shuttingDown) return;
    shuttingDown = true;

    console.log('');
    console.log(`[SHUTDOWN] Received ${signal}, stopping gracefully...`);

    // Stop SessionManager cleanup timer
    if (sessionCleanupTimer) {
      clearInterval(sessionCleanupTimer);
      sessionCleanupTimer = null;
      console.log('[SHUTDOWN] SessionManager cleanup timer stopped');
    }

    // Stop NC Flow modules before heartbeat
    activityPoller.stop();
    await webhookReceiver.stop();
    console.log('[SHUTDOWN] NC Flow modules stopped.');

    await heartbeat.stop();

    // Note: learningLog.shutdown() is already called by heartbeat.stop()

    // Drain Talk queue before discarding credentials
    if (talkQueue) {
      await talkQueue.shutdown();
      console.log('[SHUTDOWN] Talk Send Queue drained.');
    }

    // Security: Discard all cached credentials
    if (credentialBroker) {
      credentialBroker.discardAll();
      console.log('[SHUTDOWN] Credentials discarded.');
    }

    if (ncRequestManager) {
      await ncRequestManager.shutdown();
      console.log('[SHUTDOWN] NC Request Manager shutdown.');
    }

    console.log('[SHUTDOWN] Heartbeat stopped.');
    console.log('[SHUTDOWN] Goodbye!');
    process.exit(0);
  }

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));

  // Start the heartbeat
  console.log('[INIT] Starting heartbeat...');
  await heartbeat.start();

  // Start NC Flow modules
  await webhookReceiver.start();
  activityPoller.start();
  console.log('[INIT] NC Flow modules started');

  console.log('');
  console.log('======================================================================');
  console.log('               MoltAgent Bot Running!                                 ');
  console.log('======================================================================');
  console.log('');
  console.log('Press Ctrl+C to stop.');
  console.log('');

  // Keep process running
  // The heartbeat interval keeps the event loop alive
}

// Run
main().catch(err => {
  console.error('[FATAL]', err);
  // Discard credentials on crash
  if (credentialBroker) {
    credentialBroker.discardAll();
  }
  process.exit(1);
});
