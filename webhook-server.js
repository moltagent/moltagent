#!/usr/bin/env node
/**
 * MoltAgent NC Talk Webhook Server
 *
 * Receives messages from NC Talk, routes through LLM, responds.
 * All incoming messages are verified using HMAC-SHA256 signatures.
 *
 * Security features:
 * - Signature verification on all incoming webhooks
 * - Credential broker for secure secret management
 * - Backend allowlist validation
 * - Comprehensive audit logging
 *
 * @version 2.0.0
 */

const http = require('http');
const fs = require('fs');
const path = require('path');

// Load new resilience layer modules
const NCRequestManager = require('./src/lib/nc-request-manager');
const CredentialCache = require('./src/lib/credential-cache');
const CredentialBroker = require('./src/lib/credential-broker');
const TalkSignatureVerifier = require('./src/lib/talk-signature-verifier');
const { createErrorHandler } = require('./src/lib/errors/error-handler');
const { TalkSendQueue } = require('./src/lib/talk/talk-send-queue');
const appConfig = require('./src/lib/config');
const { createServerComponents } = require('./src/lib/server/index');

// Knowledge modules for agent memory context
let ContextLoader, LearningLog, FreshnessChecker;
try {
  ({ ContextLoader } = require('./src/lib/knowledge/context-loader'));
  ({ LearningLog } = require('./src/lib/knowledge/learning-log'));
  ({ FreshnessChecker } = require('./src/lib/knowledge/freshness-checker'));
} catch {
  console.warn('[WARN] Knowledge modules not available, agent memory disabled');
}

// Optional modules - gracefully handle if not present
let LLMRouter, AuditLogger, MessageRouter, CalendarHandler, EmailHandler, CalDAVClient;
try {
  LLMRouter = require('./src/lib/llm-router');
} catch {
  console.warn('[WARN] LLM Router not available, using stub');
  LLMRouter = null;
}

try {
  AuditLogger = require('./lib/audit-logger');
} catch {
  console.warn('[WARN] Audit Logger not available, using console');
  AuditLogger = null;
}

try {
  MessageRouter = require('./src/lib/handlers/message-router');
} catch {
  console.warn('[WARN] Message Router not available');
  MessageRouter = null;
}

try {
  CalDAVClient = require('./src/lib/integrations/caldav-client');
} catch {
  console.warn('[WARN] CalDAV Client not available');
  CalDAVClient = null;
}

try {
  CalendarHandler = require('./src/lib/handlers/calendar-handler');
} catch {
  console.warn('[WARN] Calendar Handler not available');
  CalendarHandler = null;
}

try {
  EmailHandler = require('./src/lib/handlers/email-handler');
} catch {
  console.warn('[WARN] Email Handler not available');
  EmailHandler = null;
}

let DeckClient;
try {
  DeckClient = require('./src/lib/integrations/deck-client');
} catch {
  console.warn('[WARN] Deck Client not available');
  DeckClient = null;
}

let NCFilesClient, NCSearchClient, TextExtractor;
try {
  ({ NCFilesClient } = require('./src/lib/integrations/nc-files-client'));
} catch {
  console.warn('[WARN] NCFilesClient not available');
  NCFilesClient = null;
}
try {
  ({ NCSearchClient } = require('./src/lib/integrations/nc-search-client'));
} catch {
  console.warn('[WARN] NCSearchClient not available');
  NCSearchClient = null;
}
try {
  ({ TextExtractor } = require('./src/lib/extraction/text-extractor'));
} catch {
  console.warn('[WARN] TextExtractor not available');
  TextExtractor = null;
}

let CollectivesClient;
try {
  CollectivesClient = require('./src/lib/integrations/collectives-client');
} catch {
  console.warn('[WARN] CollectivesClient not available');
  CollectivesClient = null;
}

let SearXNGClient, WebReader;
try {
  ({ SearXNGClient } = require('./src/lib/integrations/searxng-client'));
  ({ WebReader } = require('./src/lib/integrations/web-reader'));
} catch {
  console.warn('[WARN] Web tools not available');
  SearXNGClient = null;
  WebReader = null;
}

let ContactsClient;
try {
  ContactsClient = require('./src/lib/integrations/contacts-client');
} catch {
  console.warn('[WARN] ContactsClient not available');
  ContactsClient = null;
}

let CockpitManager;
try {
  CockpitManager = require('./src/lib/integrations/cockpit-manager');
} catch {
  console.warn('[WARN] CockpitManager not available');
  CockpitManager = null;
}

let RSVPTracker;
try {
  RSVPTracker = require('./src/lib/integrations/rsvp-tracker');
} catch {
  console.warn('[WARN] RSVPTracker not available');
  RSVPTracker = null;
}

let BotEnroller;
try {
  BotEnroller = require('./src/lib/integrations/bot-enroller');
} catch {
  console.warn('[WARN] BotEnroller not available');
  BotEnroller = null;
}

let RoomMonitor;
try {
  RoomMonitor = require('./src/lib/integrations/room-monitor');
} catch {
  console.warn('[WARN] RoomMonitor not available');
  RoomMonitor = null;
}

let SessionPersister;
try {
  SessionPersister = require('./src/lib/integrations/session-persister');
} catch {
  console.warn('[WARN] SessionPersister not available');
  SessionPersister = null;
}

let MemorySearcher;
try {
  MemorySearcher = require('./src/lib/integrations/memory-searcher');
} catch {
  console.warn('[WARN] MemorySearcher not available');
  MemorySearcher = null;
}

let WarmMemory;
try {
  WarmMemory = require('./src/lib/integrations/warm-memory');
} catch {
  console.warn('[WARN] WarmMemory not available');
  WarmMemory = null;
}

let NCStatusIndicator;
try {
  NCStatusIndicator = require('./src/lib/integrations/nc-status-indicator');
} catch {
  console.warn('[WARN] NCStatusIndicator not available');
  NCStatusIndicator = null;
}

let HeartbeatManager;
try {
  HeartbeatManager = require('./src/lib/integrations/heartbeat-manager');
} catch {
  console.warn('[WARN] HeartbeatManager not available');
  HeartbeatManager = null;
}

let HeartbeatIntelligence;
try {
  HeartbeatIntelligence = require('./src/lib/integrations/heartbeat-intelligence');
} catch {
  console.warn('[WARN] HeartbeatIntelligence not available');
  HeartbeatIntelligence = null;
}

let WorkflowBoardDetector, WorkflowEngine;
try {
  WorkflowBoardDetector = require('./src/lib/workflows/workflow-board-detector');
  WorkflowEngine = require('./src/lib/workflows/workflow-engine');
} catch {
  console.warn('[WARN] Workflow Engine modules not available');
  WorkflowBoardDetector = null;
  WorkflowEngine = null;
}

// Session 38: Infrastructure Monitor
let InfraMonitor;
try {
  InfraMonitor = require('./src/lib/integrations/infra-monitor');
} catch {
  console.warn('[WARN] InfraMonitor not available');
  InfraMonitor = null;
}

// Self-Heal Daemon Client
let SelfHealClient;
try {
  SelfHealClient = require('./src/lib/clients/self-heal-client');
} catch {
  console.warn('[WARN] SelfHealClient not available');
  SelfHealClient = null;
}

// Session 37: Voice Pipeline
let WhisperClient, AudioConverter;
try {
  WhisperClient = require('./src/lib/providers/whisper-client');
  AudioConverter = require('./src/lib/providers/audio-converter');
} catch {
  console.warn('[WARN] Voice pipeline modules not available');
  WhisperClient = null;
  AudioConverter = null;
}

// V3: LLM Fallback Notifier
let FallbackNotifier;
try {
  FallbackNotifier = require('./src/lib/llm/fallback-notifier');
} catch {
  console.warn('[WARN] FallbackNotifier not available');
  FallbackNotifier = null;
}

// Session V2: Speaches STT/TTS + VoiceManager
let SpeachesClient, VoiceManager;
try {
  ({ SpeachesClient, VoiceManager } = require('./src/lib/voice'));
} catch {
  console.warn('[WARN] VoiceManager modules not available');
  SpeachesClient = null;
  VoiceManager = null;
}

let KnowledgeBoard;
try {
  ({ KnowledgeBoard } = require('./src/lib/knowledge/knowledge-board'));
} catch {
  console.warn('[WARN] KnowledgeBoard not available');
  KnowledgeBoard = null;
}

// NC Flow modules for heartbeat event routing
let ActivityPoller, WebhookReceiver;
try {
  ({ ActivityPoller } = require('./src/lib/nc-flow/activity-poller'));
  ({ WebhookReceiver } = require('./src/lib/nc-flow/webhook-receiver'));
} catch {
  console.warn('[WARN] NC Flow heartbeat modules not available');
  ActivityPoller = null;
  WebhookReceiver = null;
}

let SkillForgeHandler, TemplateLoader, TemplateEngine, SecurityScanner, SkillActivator;
try {
  ({ SkillForgeHandler } = require('./src/lib/handlers/skill-forge-handler'));
  ({ TemplateLoader, TemplateEngine, SecurityScanner, SkillActivator } = require('./src/skill-forge'));
} catch {
  console.warn('[WARN] Skill Forge modules not available');
  SkillForgeHandler = null;
}

let EmailMonitor;
try {
  EmailMonitor = require('./src/lib/services/email-monitor');
} catch {
  console.warn('[WARN] Email Monitor not available');
  EmailMonitor = null;
}

let SessionManager;
try {
  SessionManager = require('./src/security/session-manager');
} catch {
  console.warn('[WARN] SessionManager not available');
  SessionManager = null;
}

// Session 14: AgentLoop — tool-calling LLM agent
let DailyBriefing;
try {
  ({ DailyBriefing } = require('./src/lib/agent/daily-briefing'));
} catch {
  console.warn('[WARN] DailyBriefing not available');
  DailyBriefing = null;
}

let AgentLoop, ToolRegistry, OllamaToolsProvider, SecretsGuard, ToolGuard, PromptGuard, SystemTagsClient, ProviderChain, RouterChatBridge, GuardrailEnforcer;
try {
  ({ AgentLoop } = require('./src/lib/agent/agent-loop'));
  ({ ToolRegistry } = require('./src/lib/agent/tool-registry'));
  ({ OllamaToolsProvider } = require('./src/lib/agent/providers/ollama-tools'));
  ({ ProviderChain } = require('./src/lib/agent/providers/provider-chain'));
  ({ RouterChatBridge } = require('./src/lib/agent/providers/router-chat-bridge'));
  ({ SecretsGuard } = require('./src/security/guards/secrets-guard'));
  ({ ToolGuard } = require('./src/security/guards/tool-guard'));
  ({ PromptGuard } = require('./src/security/guards/prompt-guard'));
  ({ SystemTagsClient } = require('./src/lib/nc-flow/system-tags'));
  ({ GuardrailEnforcer } = require('./src/lib/agent/guardrail-enforcer'));
} catch (err) {
  console.warn(`[WARN] AgentLoop modules not fully available: ${err.message}`);
  AgentLoop = null;
}

// Local Intelligence: ModelScout + MicroPipeline + DeferralQueue
let ModelScout, MicroPipeline, DeferralQueue;
try {
  ({ ModelScout } = require('./src/lib/providers/model-scout'));
  MicroPipeline = require('./src/lib/agent/micro-pipeline');
  DeferralQueue = require('./src/lib/agent/deferral-queue');
} catch (err) {
  console.warn(`[WARN] Local Intelligence modules not available: ${err.message}`);
  ModelScout = null;
  MicroPipeline = null;
  DeferralQueue = null;
}

// Configuration (NO secrets - only non-sensitive config)
const CONFIG = {
  port: parseInt(process.env.PORT) || appConfig.server.port,
  nc: {
    url: process.env.NC_URL || appConfig.nextcloud.url,
    username: process.env.NC_USER || appConfig.nextcloud.username
  },
  security: {
    // Backend URLs allowed to send webhooks (populated from config or env)
    allowedBackends: (process.env.NC_TALK_BACKENDS || '')
      .split(',')
      .map(s => s.trim())
      .filter(Boolean),
    strictMode: process.env.STRICT_MODE !== 'false'
  },
  ollama: {
    url: process.env.OLLAMA_URL || appConfig.ollama.url,
    model: process.env.OLLAMA_MODEL || appConfig.ollama.model,
    timeout: appConfig.ollama.timeout
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
  }
};

// Add default backend if none configured
if (CONFIG.security.allowedBackends.length === 0) {
  CONFIG.security.allowedBackends.push(...appConfig.security.allowedBackends);
}

// Global components
let ncRequestManager = null;
let credentialCache = null;
let credentialBroker = null;
let signatureVerifier = null;
let llmRouter = null;
let auditLogger = null;
let messageRouter = null;
let caldavClient = null;
let calendarHandler = null;
let emailHandler = null;
let emailMonitor = null;
let deckClient2 = null; // DeckClient for message routing (separate from heartbeat)
let ncFilesClient = null;
let ncSearchClient = null;
let textExtractor = null;
let collectivesClient = null;
let contactsClient = null;
let rsvpTracker = null;   // Initialized here; consumed by HeartbeatManager in bot.js
let skillForgeHandler = null;
let talkQueue = null;
let defaultTalkToken = appConfig.talk.primaryRoom || null; // Primary room for proactive notifications
let contextLoader = null;
let learningLog = null;
let freshnessChecker = null;
let agentLoop = null; // Session 14: AgentLoop instance
let dailyBriefing = null; // First-message-of-day briefing
let cockpitManager = null; // Session 27: Cockpit (Deck as control plane)
let botEnroller = null; // Auto-enable Talk bot in rooms
let sessionManager = null; // Session 29b: shared session manager
let sessionPersister = null; // Session 29b: persist expired session summaries to wiki
let memorySearcher = null; // Session 29b: keyword-based memory search over wiki pages
let warmMemory = null; // Session M1: warm memory layer (WARM.md)
let sessionCleanupTimer = null; // Periodic SessionManager cleanup
let webhookErrorHandler = null;
let serverComponents = null; // Decomposed server components (webhook, command, health, message processor)
let heartbeatManager = null; // HeartbeatManager instance (proactive operations)
let knowledgeBoard = null; // KnowledgeBoard for verification tracking
let ncFlowActivityPoller = null; // NC Flow activity poller for heartbeat events
let ncFlowWebhookReceiver = null; // NC Flow webhook receiver for heartbeat events
let ncStatusIndicator = null; // NC Status Indicator (sets Molti's NC user status)
let roomMonitor = null; // RoomMonitor (instant welcome messages for new rooms)
let whisperClient = null; // Session 37: WhisperClient for STT transcription
let audioConverter = null; // Session 37: AudioConverter for audio format conversion
let voiceManager = null; // Session V2: VoiceManager for mode-aware voice orchestration
let infraMonitor = null; // Session 38: InfraMonitor for service health probing
let selfHealClient = null; // Self-heal daemon client for remote service restarts
let microPipeline = null; // Local Intelligence: MicroPipeline for local-only mode
let deferralQueue = null; // Local Intelligence: DeferralQueue for deferred complex tasks
let intentRouter = null; // IntentRouter: LLM-powered intent classification

// Simple console audit logger fallback
async function consoleAuditLog(event, data) {
  const timestamp = new Date().toISOString();
  console.log(`[AUDIT] ${timestamp} ${event}:`, JSON.stringify(data).substring(0, 200));
}

/**
 * Extract a named ## section from structured markdown.
 * Returns the content between the named header and the next header (or end).
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

/**
 * User notification (sends to NC Talk primary room)
 */
async function notifyUser(notification) {
  const message = notification.message || JSON.stringify(notification);
  console.log(`[NOTIFY] ${notification.type || 'info'}: ${message}`);

  if (!defaultTalkToken || !talkQueue) {
    if (!defaultTalkToken) {
      console.warn('[NOTIFY] No primary room configured (set TALK_PRIMARY_ROOM or TALK_ROOM_TOKEN)');
    }
    return;
  }

  try {
    const result = await talkQueue.enqueue(defaultTalkToken, message);
    if (!result) {
      console.warn('[NOTIFY] Talk API returned error, message logged only');
    }
  } catch (error) {
    console.warn(`[NOTIFY] Talk delivery failed: ${error.message}`);
  }
}

/**
 * Initialize all components
 */
async function initialize() {
  console.log('');
  console.log('======================================================================');
  console.log('           MoltAgent Webhook Server Initializing...                   ');
  console.log('======================================================================');
  console.log('');

  // 1. Initialize NCRequestManager FIRST (new resilience layer)
  console.log('[INIT] Setting up NC Request Manager...');
  ncRequestManager = new NCRequestManager({
    nextcloud: { url: CONFIG.nc.url, username: CONFIG.nc.username }
    // ncResilience uses config defaults
  });

  try {
    ncRequestManager.setBootstrapCredential();
    await ncRequestManager.resolveCanonicalUsername();
    console.log('[INIT] NC Request Manager ready');
  } catch (err) {
    console.error(`[INIT] NCRequestManager error: ${err.message}`);
    console.error('[INIT] Options:');
    console.error('  1. systemd LoadCredential=nc-password:/path/to/credential');
    console.error('  2. NC_CREDENTIAL_FILE=/path/to/file');
    console.error('  3. NC_PASSWORD=password (not recommended)');
    process.exit(1);
  }

  // 1.1. Initialize Talk Send Queue (serializes outbound Talk messages)
  talkQueue = new TalkSendQueue(ncRequestManager);
  console.log('[INIT] Talk Send Queue ready');

  // 1.2. Initialize NC Status Indicator (sets Molti's NC user status)
  if (NCStatusIndicator && appConfig.statusIndicator.enabled) {
    console.log('[INIT] Setting up NC Status Indicator...');
    ncStatusIndicator = new NCStatusIndicator({
      ncRequestManager: ncRequestManager,
      config: appConfig
    });
    await ncStatusIndicator.setStatus('startup');
    console.log('[INIT] NC Status Indicator ready (startup status set)');
  }

  // 1.5. Initialize Conversation Context (for Talk chat history in LLM prompts)
  console.log('[INIT] Setting up Conversation Context...');
  const { ConversationContext } = require('./src/lib/talk/conversation-context');
  const conversationContext = new ConversationContext(
    appConfig.talk.conversationContext,
    ncRequestManager
  );
  console.log('[INIT] Conversation Context ready');

  // 2. Initialize CredentialCache (uses NCRequestManager)
  console.log('[INIT] Setting up Credential Cache...');
  credentialCache = new CredentialCache(ncRequestManager, {
    // cacheTTL uses config default
    auditLog: consoleAuditLog
  });

  // 3. Initialize Credential Broker (uses CredentialCache)
  console.log('[INIT] Setting up Credential Broker...');
  credentialBroker = new CredentialBroker(credentialCache, {
    ncUrl: CONFIG.nc.url,
    ncUsername: CONFIG.nc.username,
    auditLog: consoleAuditLog
  });
  console.log('[INIT] Credential Broker ready');

  // 3a. Verify Credential Broker connectivity (P0-5)
  console.log('[INIT] Verifying Credential Broker...');
  try {
    const brokerTest = await credentialBroker.testConnection();
    if (brokerTest.connected) {
      console.log(`[INIT] \u2713 NC Passwords connected. ${brokerTest.credentialCount} credential(s) available: ${brokerTest.credentials.join(', ')}`);
    } else {
      console.warn(`[INIT] \u26a0 NC Passwords not available: ${brokerTest.error}`);
      console.warn('[INIT]   Falling back to environment variables');
    }
  } catch (err) {
    console.warn(`[INIT] \u26a0 Credential verification failed: ${err.message}`);
    console.warn('[INIT]   Falling back to environment variables');
  }

  // 2. Initialize Signature Verifier
  console.log('[INIT] Setting up Signature Verifier...');
  signatureVerifier = new TalkSignatureVerifier({
    getSecret: async () => {
      // Try to get from NC Passwords first, fall back to env var
      try {
        const secret = await credentialBroker.get('nc-talk-secret');
        if (secret) return secret;
      } catch {
        // Fall through to systemd credential
      }
      // Try systemd LoadCredential path
      if (process.env.CREDENTIALS_DIRECTORY) {
        try {
          const fs = require('fs');
          const credPath = `${process.env.CREDENTIALS_DIRECTORY}/nc-talk-secret`;
          const secret = fs.readFileSync(credPath, 'utf8').trim();
          if (secret) return secret;
        } catch {
          // Fall through to env var
        }
      }
      // Fallback to environment variable
      if (process.env.NC_TALK_SECRET) {
        return process.env.NC_TALK_SECRET;
      }
      throw new Error('NC Talk secret not configured');
    },
    allowedBackends: CONFIG.security.allowedBackends,
    auditLog: consoleAuditLog,
    strictMode: CONFIG.security.strictMode,
    requireBackendValidation: true
  });

  console.log(`[INIT] Allowed backends: ${CONFIG.security.allowedBackends.join(', ')}`);
  console.log(`[INIT] Strict mode: ${CONFIG.security.strictMode}`);

  // 3.5. Initialize error handler for webhooks
  webhookErrorHandler = createErrorHandler({
    serviceName: 'WebhookServer',
    auditLog: consoleAuditLog
  });
  console.log('[INIT] Error handler ready');

  // 4. Initialize Audit Logger (if available) - uses NCRequestManager
  if (AuditLogger) {
    console.log('[INIT] Setting up Audit Logger...');
    auditLogger = new AuditLogger(ncRequestManager, {
      logPath: '/Logs',
      flushInterval: appConfig.heartbeat.intervalMs,  // Same as heartbeat to reduce NC load
      maxBufferSize: 20
    });
    console.log('[INIT] Audit Logger ready');
  }

  // 5. Initialize LLM Router (if available)
  if (LLMRouter) {
    console.log('[INIT] Setting up LLM Router...');
    llmRouter = new LLMRouter({
      ollama: CONFIG.ollama,
      auditLog: auditLogger ? auditLogger.log.bind(auditLogger) : consoleAuditLog,
      getCredential: credentialBroker.createGetter(),
      proactiveDailyBudget: appConfig.proactive.dailyCloudBudget
    });

    const connectionTest = await llmRouter.testConnection();
    if (connectionTest.connected) {
      console.log(`[INIT] Ollama connected. Models: ${connectionTest.models?.join(', ') || 'N/A'}`);
    } else {
      console.warn(`[INIT] Ollama not available: ${connectionTest.error}`);
    }
  }

  // 6. Initialize CalDAV Client and Calendar Handler (if available) - uses NCRequestManager
  if (CalDAVClient && CalendarHandler) {
    console.log('[INIT] Setting up CalDAV Client...');
    try {
      caldavClient = new CalDAVClient(ncRequestManager, credentialBroker, {
        ncUrl: CONFIG.nc.url,
        username: CONFIG.nc.username,
        auditLog: auditLogger ? auditLogger.log.bind(auditLogger) : consoleAuditLog
      });
      console.log('[INIT] CalDAV Client ready');

      console.log('[INIT] Setting up Calendar Handler...');
      const auditFn = auditLogger ? auditLogger.log.bind(auditLogger) : consoleAuditLog;
      calendarHandler = new CalendarHandler(caldavClient, llmRouter, auditFn);
      console.log('[INIT] Calendar Handler ready');
    } catch (err) {
      console.warn(`[INIT] Calendar setup failed: ${err.message}`);
    }
  }

  // 7. Initialize Email Handler (if available)
  if (EmailHandler) {
    console.log('[INIT] Setting up Email Handler...');
    try {
      const auditFn = auditLogger ? auditLogger.log.bind(auditLogger) : consoleAuditLog;
      emailHandler = new EmailHandler(credentialBroker, llmRouter, auditFn);
      console.log('[INIT] Email Handler ready');
    } catch (err) {
      console.warn(`[INIT] Email Handler failed: ${err.message}`);
    }
  }

  // 7b. Initialize DeckClient for message routing (if available) — before ContextLoader
  if (DeckClient && ncRequestManager) {
    try {
      deckClient2 = new DeckClient(ncRequestManager, {
        boardName: 'MoltAgent Tasks'
      });
      console.log('[INIT] DeckClient (message routing) ready');
    } catch (err) {
      console.warn(`[INIT] DeckClient failed: ${err.message}`);
    }
  }

  // 7b2. Initialize NCFilesClient, NCSearchClient, TextExtractor
  if (NCFilesClient && ncRequestManager) {
    try {
      ncFilesClient = new NCFilesClient(ncRequestManager, { username: CONFIG.nc.username });
      console.log('[INIT] NCFilesClient ready');
    } catch (err) {
      console.warn(`[INIT] NCFilesClient failed: ${err.message}`);
    }
  }
  // Session M1: Initialize WarmMemory (warm layer for cross-session context)
  if (WarmMemory && ncFilesClient) {
    try {
      warmMemory = new WarmMemory({
        ncFilesClient,
        logger: console,
        config: { filePath: 'Memory/WARM.md', maxLines: 200, cacheTTLMs: 60000 }
      });
      await warmMemory.load(); // Creates Memory/ dir + initial WARM.md on first run
      console.log('[INIT] WarmMemory ready');
    } catch (err) {
      console.warn(`[INIT] WarmMemory failed: ${err.message}`);
      warmMemory = null;
    }
  }

  // Session 37: Initialize Voice Pipeline (WhisperClient + AudioConverter)
  if (WhisperClient && AudioConverter && appConfig.voice?.enabled !== false) {
    try {
      whisperClient = new WhisperClient({
        whisperUrl: appConfig.voice.whisperUrl,
        whisperTimeout: appConfig.voice.whisperTimeout,
        whisperModel: appConfig.voice.whisperModel
      });
      audioConverter = new AudioConverter({
        ffmpegPath: appConfig.voice.ffmpegPath
      });
      console.log(`[INIT] Voice pipeline ready (Whisper: ${appConfig.voice.whisperUrl}, model: ${appConfig.voice.whisperModel})`);
    } catch (err) {
      console.warn(`[INIT] Voice pipeline failed: ${err.message}`);
      whisperClient = null;
      audioConverter = null;
    }
  }

  // Session V2: Initialize VoiceManager (Speaches-backed voice orchestration)
  if (SpeachesClient && VoiceManager && appConfig.voice?.enabled !== false) {
    try {
      const speachesClient = new SpeachesClient({
        endpoint: appConfig.voice.speachesUrl,
        sttModel: appConfig.voice.speachesSttModel,
        ttsModel: appConfig.voice.speachesTtsModel,
        ttsVoice: appConfig.voice.speachesTtsVoice,
        timeout: appConfig.voice.speachesTimeout,
      });
      voiceManager = new VoiceManager({
        speachesClient,
        fileClient: ncFilesClient,
        audioConverter: audioConverter,
        ncRequestManager: ncRequestManager,
        config: appConfig.voice,
      });
      // Start in 'listen' mode so voice works before first heartbeat reads Cockpit
      voiceManager.setMode('listen');
      console.log(`[INIT] VoiceManager ready (Speaches: ${appConfig.voice.speachesUrl})`);
    } catch (err) {
      console.warn(`[INIT] VoiceManager failed: ${err.message}`);
      voiceManager = null;
    }
  }

  if (NCSearchClient && ncRequestManager) {
    try {
      ncSearchClient = new NCSearchClient(ncRequestManager);
      console.log('[INIT] NCSearchClient ready');
    } catch (err) {
      console.warn(`[INIT] NCSearchClient failed: ${err.message}`);
    }
  }
  if (TextExtractor) {
    try {
      textExtractor = new TextExtractor();
      console.log('[INIT] TextExtractor ready');
    } catch (err) {
      console.warn(`[INIT] TextExtractor failed: ${err.message}`);
    }
  }

  // 7b3. Initialize CollectivesClient (knowledge wiki)
  if (CollectivesClient && ncRequestManager) {
    try {
      collectivesClient = new CollectivesClient(ncRequestManager, {
        collectiveName: appConfig.knowledge.collectiveName
      });
      console.log('[INIT] CollectivesClient ready');
    } catch (err) {
      console.warn(`[INIT] CollectivesClient failed: ${err.message}`);
    }
  }

  // 7b3a. Wiki bootstrap (non-blocking)
  if (collectivesClient) {
    (async () => {
      try {
        const result = await collectivesClient.bootstrapDefaultPages();
        if (result.created.length > 0) {
          console.log(`[INIT] Wiki bootstrap: created ${result.created.join(', ')}`);
        }
        if (result.skipped.length > 0) {
          console.log(`[INIT] Wiki bootstrap: skipped ${result.skipped.join(', ')} (already exist)`);
        }
        if (result.errors.length > 0) {
          console.warn(`[INIT] Wiki bootstrap errors: ${result.errors.map(e => `${e.title}: ${e.error}`).join('; ')}`);
        }

        const adminUser = appConfig.knowledge.adminUser;
        if (adminUser) {
          const shareResult = await collectivesClient.shareWithAdmin(adminUser);
          console.log(`[INIT] Wiki share with ${adminUser}: ${shareResult.message}`);
        }
      } catch (err) {
        console.warn(`[INIT] Wiki bootstrap failed: ${err.message}`);
      }
    })();
  }

  // 7b4. Initialize SearXNG + WebReader (web tools)
  let searxngClient = null;
  let webReaderInstance = null;
  if (SearXNGClient && appConfig.search.searxng.url) {
    try {
      searxngClient = new SearXNGClient({
        baseUrl: appConfig.search.searxng.url,
        config: appConfig.search.searxng
      });
      console.log(`[INIT] SearXNG client ready (${appConfig.search.searxng.url})`);
    } catch (err) {
      console.warn(`[INIT] SearXNG client failed: ${err.message}`);
    }
  }
  if (WebReader) {
    try {
      webReaderInstance = new WebReader({ config: appConfig.search.webReader });
      console.log('[INIT] WebReader ready');
    } catch (err) {
      console.warn(`[INIT] WebReader failed: ${err.message}`);
    }
  }

  // 7b5. Initialize ContactsClient (CardDAV contacts)
  if (ContactsClient && ncRequestManager) {
    try {
      contactsClient = new ContactsClient(ncRequestManager, {
        collectivesClient: collectivesClient,
        auditLog: auditLogger ? auditLogger.log.bind(auditLogger) : consoleAuditLog
      });
      console.log('[INIT] ContactsClient ready');
    } catch (err) {
      console.warn(`[INIT] ContactsClient failed: ${err.message}`);
    }
  }

  // 7b6a. Initialize CockpitManager (Deck control plane)
  if (CockpitManager && deckClient2 && appConfig.cockpit?.enabled !== false) {
    try {
      cockpitManager = new CockpitManager({
        deckClient: deckClient2,
        config: {
          adminUser: appConfig.cockpit?.adminUser || appConfig.knowledge?.adminUser || '',
          boardTitle: appConfig.cockpit?.boardTitle,
          cacheTTLMs: appConfig.cockpit?.cacheTTLMs
        },
        auditLog: auditLogger ? auditLogger.log.bind(auditLogger) : consoleAuditLog
      });
      console.log('[INIT] CockpitManager ready');
    } catch (err) {
      console.warn(`[INIT] CockpitManager failed: ${err.message}`);
      cockpitManager = null;
    }
  }

  // 7b6. Initialize RSVPTracker
  if (RSVPTracker && caldavClient) {
    try {
      rsvpTracker = new RSVPTracker({
        caldavClient: caldavClient,
        notifyUser: async (notification) => {
          if (defaultTalkToken && talkQueue) {
            await talkQueue.enqueue(defaultTalkToken, notification.message);
          }
        },
        auditLog: auditLogger ? auditLogger.log.bind(auditLogger) : consoleAuditLog
      });
      console.log('[INIT] RSVPTracker ready');
    } catch (err) {
      console.warn(`[INIT] RSVPTracker failed: ${err.message}`);
    }
  }

  // 7b7. Initialize BotEnroller (auto-enable Talk bot in rooms)
  if (BotEnroller && ncRequestManager) {
    try {
      botEnroller = new BotEnroller({
        ncRequestManager,
        botName: appConfig.talk.botName,
        auditLog: auditLogger ? auditLogger.log.bind(auditLogger) : consoleAuditLog
      });
      console.log('[INIT] BotEnroller ready');

      // Run initial enrollment (non-blocking)
      (async () => {
        try {
          const result = await botEnroller.enrollAll();
          if (result.enrolled > 0) {
            console.log(`[INIT] BotEnroller: enabled bot in ${result.enrolled} room(s)`);
          }
          if (result.errors.length > 0) {
            console.warn(`[INIT] BotEnroller errors: ${result.errors.map(e => e.error).join('; ')}`);
          }
        } catch (err) {
          console.warn(`[INIT] BotEnroller initial enrollment failed: ${err.message}`);
        }
      })();
    } catch (err) {
      console.warn(`[INIT] BotEnroller failed: ${err.message}`);
      botEnroller = null;
    }
  }

  // 7b7a. Initialize RoomMonitor (instant welcome messages for new rooms)
  if (RoomMonitor && ncRequestManager && appConfig.roomMonitor?.enabled !== false) {
    try {
      roomMonitor = new RoomMonitor({
        ncRequestManager,
        botEnroller,
        config: appConfig
      });
      console.log('[INIT] RoomMonitor ready');
    } catch (err) {
      console.warn(`[INIT] RoomMonitor failed: ${err.message}`);
      roomMonitor = null;
    }
  }

  // 7b8. Initialize SessionManager, SessionPersister, MemorySearcher (Session 29b)
  if (SessionManager) {
    sessionManager = new SessionManager();
    console.log('[INIT] SessionManager ready');

    // Wire SessionPersister to sessionExpired events
    if (SessionPersister && collectivesClient && llmRouter) {
      try {
        sessionPersister = new SessionPersister({
          wikiClient: collectivesClient,
          llmRouter: llmRouter,
          config: appConfig
        });
        sessionManager.on('sessionExpired', async (session) => {
          try {
            const page = await sessionPersister.persistSession(session);
            if (page) {
              console.log(`[SessionPersister] Saved session summary: ${page}`);
            }

            // M1: Consolidate warm memory from session context directly
            // (Don't depend on lastSummary — it's often null after restarts)
            if (warmMemory && session.context && session.context.length >= 6) {
              try {
                const recentContext = session.context
                  .filter(c => c.role === 'user' || c.role === 'assistant')
                  .slice(-10)
                  .map(c => `${c.role}: ${(c.content || '').substring(0, 200)}`)
                  .join(' | ');

                // Also try to extract structured data from persister if available
                const continuation = (sessionPersister.lastSummary && _extractSection(sessionPersister.lastSummary, 'Continuation'))
                  || recentContext;
                const openItems = sessionPersister.lastSummary
                  ? (_extractSection(sessionPersister.lastSummary, 'Open Items') || '')
                  : '';

                await warmMemory.consolidate({
                  continuation,
                  openItems,
                  timestamp: new Date().toISOString()
                });
                console.log('[WarmMemory] Consolidated from expired session');
              } catch (wmErr) {
                console.error('[WarmMemory] Consolidation failed:', wmErr.message);
              }
            }
          } catch (err) {
            console.error('[SessionPersister] Failed:', err.message);
          }
        });
        console.log('[INIT] SessionPersister ready (wired to sessionExpired events)');
      } catch (err) {
        console.warn(`[INIT] SessionPersister failed: ${err.message}`);
      }
    }
  }

  // 7b9. Initialize MemorySearcher (M2: NC Unified Search)
  if (MemorySearcher && ncSearchClient) {
    try {
      memorySearcher = new MemorySearcher({
        ncSearchClient,
        logger: console
      });
      memorySearcher.discoverProviders().catch(err =>
        console.warn(`[MemorySearcher] Provider discovery failed: ${err.message}`)
      );
      console.log('[INIT] MemorySearcher ready (NC Unified Search)');
    } catch (err) {
      console.warn(`[INIT] MemorySearcher failed: ${err.message}`);
    }
  }

  // 7b10. Start SessionManager periodic cleanup (Session 29b)
  if (sessionManager) {
    sessionCleanupTimer = setInterval(() => {
      try {
        const result = sessionManager.cleanup();
        if (result.sessions > 0 || result.approvals > 0) {
          console.log(`[SessionManager] Cleanup: ${result.sessions} sessions, ${result.approvals} approvals expired`);
        }
      } catch (err) {
        console.error('[SessionManager] Cleanup error:', err.message);
      }
    }, 5 * 60 * 1000); // Every 5 minutes
    console.log('[INIT] SessionManager cleanup timer started (5min interval)');
  }

  // 7c. Initialize ContextLoader for agent memory (if knowledge modules available)
  if (ContextLoader && LearningLog && ncRequestManager) {
    try {
      learningLog = new LearningLog({
        ncRequestManager,
        logPath: '/Memory/LearningLog.md',
        username: CONFIG.nc.username
      });
      contextLoader = new ContextLoader({
        learningLog,
        knowledgeBoard: null,
        deckClient: deckClient2,
        collectivesClient: collectivesClient
      });
      console.log('[INIT] ContextLoader ready (agent memory enabled)');
    } catch (err) {
      console.warn(`[INIT] ContextLoader failed: ${err.message}`);
    }
  }

  // 7c2. Initialize FreshnessChecker (knowledge page staleness detection)
  if (FreshnessChecker && collectivesClient) {
    try {
      freshnessChecker = new FreshnessChecker({
        collectivesClient,
        knowledgeBoard: null,  // Set after KnowledgeBoard is created
        config: {
          maxPagesPerScan: appConfig.knowledge.freshness.maxPagesPerScan,
          defaultDecayDays: appConfig.knowledge.defaultDecayDays
        }
      });
      console.log('[INIT] FreshnessChecker ready');
    } catch (err) {
      console.warn(`[INIT] FreshnessChecker failed: ${err.message}`);
    }
  }

  // 7d. Initialize Skill Forge (if modules available)
  if (SkillForgeHandler && TemplateLoader && ncRequestManager) {
    try {
      const auditFn = auditLogger ? auditLogger.log.bind(auditLogger) : consoleAuditLog;
      const templateLoader = new TemplateLoader({ ncRequestManager, username: CONFIG.nc.username });
      const templateEngine = new TemplateEngine({ ncUrl: CONFIG.nc.url, ncUser: CONFIG.nc.username });
      const securityScanner = new SecurityScanner();
      const skillActivator = new SkillActivator({ ncRequestManager, securityScanner, username: CONFIG.nc.username, ncUrl: CONFIG.nc.url });
      skillForgeHandler = new SkillForgeHandler(templateLoader, templateEngine, securityScanner, skillActivator, auditFn);
      console.log('[INIT] Skill Forge Handler ready');
    } catch (err) {
      console.warn(`[INIT] Skill Forge failed: ${err.message}`);
    }
  }

  // 7e. Initialize AgentLoop (Session 14: tool-calling LLM agent)
  if (AgentLoop && ToolRegistry) {
    try {
      // Read providers.json for config
      const providersPath = path.join(__dirname, 'config', 'providers.json');
      const providersConfig = JSON.parse(fs.readFileSync(providersPath, 'utf-8'));
      const ollamaConfig = providersConfig.providers?.ollama || {};
      const claudeConfig = providersConfig.providers?.claude || {};

      // Build both chat providers (needed by both RouterChatBridge and ProviderChain fallback)
      const { ClaudeToolsProvider } = require('./src/lib/agent/providers/claude-tools');
      const getCredential = credentialBroker.createGetter();

      let ollamaProvider = null;
      if (OllamaToolsProvider) {
        ollamaProvider = new OllamaToolsProvider({
          endpoint: ollamaConfig.endpoint || CONFIG.ollama.url,
          model: ollamaConfig.model || CONFIG.ollama.model,
          timeout: CONFIG.ollama.timeout,
          toolTimeout: CONFIG.ollama.toolTimeout
        });
        console.log(`[INIT] OllamaToolsProvider ready (${ollamaConfig.endpoint || CONFIG.ollama.url}, ${ollamaConfig.model || CONFIG.ollama.model})`);
      }

      // IntentRouter: LLM-powered intent classification with conversation context
      const IntentRouter = require('./src/lib/agent/intent-router');
      intentRouter = ollamaProvider ? new IntentRouter({
        provider: ollamaProvider,
        config: { classifyTimeout: appConfig.ollama.classifyTimeout }
      }) : null;
      if (intentRouter) console.log(`[INIT] IntentRouter ready (${appConfig.ollama.classifyTimeout}ms timeout)`);

      const claudeProvider = new ClaudeToolsProvider({
        model: claudeConfig.model || 'claude-opus-4-6',
        maxTokens: 1024,
        timeout: 30000,
        getApiKey: () => getCredential(claudeConfig.credentialName || 'claude-api-key')
      });
      console.log(`[INIT] ClaudeToolsProvider ready (${claudeConfig.model || 'claude-opus-4-6'})`);

      // Sonnet: workhorse cloud provider (same API key, cheaper model)
      const sonnetProvider = new ClaudeToolsProvider({
        model: 'claude-sonnet-4-5-20250929',
        maxTokens: 1024,
        timeout: 30000,
        getApiKey: () => getCredential('claude-api-key')
      });
      console.log('[INIT] ClaudeToolsProvider ready (claude-sonnet-4-5-20250929)');

      // --- Primary path: RouterChatBridge (LLMRouter v3 routing) ---
      let llmProvider = null;

      if (RouterChatBridge && llmRouter) {
        try {
          // Build chatProviders map: routerProviderId → chatProvider
          const chatProviders = new Map();
          if (ollamaProvider) chatProviders.set('ollama-local', ollamaProvider);
          chatProviders.set('anthropic-claude', claudeProvider);
          chatProviders.set('claude-sonnet', sonnetProvider);

          // Activate smart-mix preset on LLMRouter v3
          llmRouter.router.setPreset('smart-mix');
          console.log('[INIT] LLMRouter preset activated: smart-mix');

          llmProvider = new RouterChatBridge({
            router: llmRouter.router,
            chatProviders,
            logger: console,
            defaultJob: 'tools'
          });
          console.log('[INIT] RouterChatBridge active — routing through LLMRouter v3');
        } catch (bridgeErr) {
          console.warn(`[INIT] RouterChatBridge failed, falling back to ProviderChain: ${bridgeErr.message}`);
          llmProvider = null;
        }
      }

      // --- Fallback path: ProviderChain (dead-code fallback) ---
      if (!llmProvider) {
        const defaultProvider = providersConfig.routing?.default || 'ollama';
        if (defaultProvider === 'claude') {
          llmProvider = new ProviderChain(claudeProvider, ollamaProvider, console, {
            primaryIsLocal: false,
            fallbackIsLocal: !!ollamaProvider
          });
          console.log(`[INIT] Primary LLM: Claude → Ollama fallback (ProviderChain, per routing.default)`);
        } else if (defaultProvider === 'ollama' && ollamaProvider) {
          llmProvider = new ProviderChain(ollamaProvider, claudeProvider, console, {
            primaryIsLocal: true,
            fallbackIsLocal: false
          });
          console.log(`[INIT] Primary LLM: Ollama → Claude fallback (ProviderChain, per routing.default)`);
        } else {
          llmProvider = new ProviderChain(claudeProvider, ollamaProvider, console, {
            primaryIsLocal: false,
            fallbackIsLocal: !!ollamaProvider
          });
          console.log('[INIT] Primary LLM: Claude → Ollama fallback (ProviderChain, Ollama not default)');
        }
      }

      // Wire FallbackNotifier (works with both RouterChatBridge and ProviderChain)
      if (FallbackNotifier && talkQueue && defaultTalkToken) {
        const fallbackNotifier = new FallbackNotifier({
          talkSendQueue: talkQueue,
          primaryRoomToken: defaultTalkToken,
          debounceMinutes: 15
        });
        llmProvider.fallbackNotifier = fallbackNotifier;
        console.log(`[INIT] FallbackNotifier ready (wired to ${llmProvider.constructor.name})`);
      }

      // Build ToolRegistry with all available clients
      let systemTagsClient = null;
      if (SystemTagsClient && ncRequestManager) {
        systemTagsClient = new SystemTagsClient(ncRequestManager);
      }

      const toolRegistry = new ToolRegistry({
        deckClient: deckClient2,
        calDAVClient: caldavClient,
        systemTagsClient: systemTagsClient,
        ncRequestManager: ncRequestManager,
        ncFilesClient: ncFilesClient,
        ncSearchClient: ncSearchClient,
        textExtractor: textExtractor,
        collectivesClient: collectivesClient,
        learningLog: learningLog,
        searxngClient: searxngClient,
        webReader: webReaderInstance,
        contactsClient: contactsClient,
        memorySearcher: memorySearcher,
        emailHandler: emailHandler
      });
      console.log(`[INIT] ToolRegistry ready (${toolRegistry.size} tools)`);

      // Instantiate security guards
      const secretsGuard = SecretsGuard ? new SecretsGuard() : null;
      const toolGuard = ToolGuard ? new ToolGuard() : null;
      const promptGuard = PromptGuard ? new PromptGuard() : null;

      // GuardrailEnforcer: runtime guardrail checks with semantic matching + HITL
      let guardrailEnforcer = null;
      if (GuardrailEnforcer && cockpitManager && talkQueue && conversationContext) {
        guardrailEnforcer = new GuardrailEnforcer({
          cockpitManager,
          talkSendQueue: talkQueue,
          conversationContext,
          ollamaProvider,
          semanticTimeoutMs: 30000
        });
        console.log('[INIT] GuardrailEnforcer ready');
      }

      // First-message-of-day briefing (caldav/deck patched after HeartbeatManager)
      if (DailyBriefing) {
        dailyBriefing = new DailyBriefing({
          deckClient: deckClient2,
          caldavClient: caldavClient,
          budgetEnforcer: llmRouter?.router?.budget || null,
          collectivesClient: collectivesClient,
          timezone: appConfig.timezone
        });
        console.log('[INIT] DailyBriefing ready');
      }

      agentLoop = new AgentLoop({
        toolRegistry,
        conversationContext,
        contextLoader,
        warmMemory,
        cockpitManager,
        dailyBriefing,
        toolGuard,
        secretsGuard,
        promptGuard,
        guardrailEnforcer,
        llmProvider,
        statusIndicator: ncStatusIndicator,
        config: { soulPath: path.join(__dirname, 'config', 'SOUL.md'), timezone: appConfig.timezone }
      });
      console.log('[INIT] AgentLoop ready (tool-calling agent active)');
    } catch (err) {
      console.warn(`[INIT] AgentLoop failed: ${err.message}`);
      agentLoop = null;
    }
  }

  // 7f. Initialize WorkflowEngine (requires AgentLoop + DeckClient)
  let workflowEngine = null;
  if (WorkflowBoardDetector && WorkflowEngine && deckClient2 && agentLoop) {
    try {
      const workflowDetector = new WorkflowBoardDetector({ deckClient: deckClient2 });
      workflowEngine = new WorkflowEngine({
        workflowDetector,
        deckClient: deckClient2,
        agentLoop,
        talkSendQueue: talkQueue,
        talkToken: defaultTalkToken,
        config: { botUsername: CONFIG.nc.username, adminUser: appConfig.cockpit?.adminUser || appConfig.knowledge?.adminUser || '' }
      });
      console.log('[INIT] WorkflowEngine ready');
    } catch (err) {
      console.warn(`[INIT] WorkflowEngine failed: ${err.message}`);
      workflowEngine = null;
    }
  }

  // 7g. Local Intelligence: ModelScout + MicroPipeline + DeferralQueue
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
          console.log(`[INIT] Local roster: ${modelScout.getSummary()}`);
        }
      }).catch(err => {
        console.warn(`[INIT] ModelScout discovery failed: ${err.message}`);
      });
    } catch (err) {
      console.warn(`[INIT] ModelScout failed: ${err.message}`);
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
        console.warn(`[INIT] DeferralQueue load failed: ${err.message}`)
      );
      console.log('[INIT] DeferralQueue ready');
    } catch (err) {
      console.warn(`[INIT] DeferralQueue failed: ${err.message}`);
    }
  }

  if (MicroPipeline && llmRouter) {
    try {
      microPipeline = new MicroPipeline({
        llmRouter: llmRouter.router,
        memorySearcher,
        deckClient: deckClient2,
        calendarClient: caldavClient,
        talkSendQueue: talkQueue,
        deferralQueue,
        domainToolTimeout: appConfig.ollama.domainToolTimeout,
        logger: console
      });
      console.log('[INIT] MicroPipeline ready');
    } catch (err) {
      console.warn(`[INIT] MicroPipeline failed: ${err.message}`);
    }
  }

  // 8. Initialize Message Router (if available)
  if (MessageRouter) {
    console.log('[INIT] Setting up Message Router...');
    messageRouter = new MessageRouter({
      calendarHandler: calendarHandler,
      emailHandler: emailHandler,
      skillForgeHandler: skillForgeHandler,
      deckClient: deckClient2,
      contextLoader: contextLoader,
      conversationContext: conversationContext,
      llmRouter: llmRouter,
      calendarClient: caldavClient, // Direct CalDAV client for meeting calendar updates
      auditLog: auditLogger ? auditLogger.log.bind(auditLogger) : consoleAuditLog
    });

    const stats = messageRouter.getStats();
    console.log(`[INIT] Message Router ready - Calendar: ${stats.handlersConfigured.calendar}, Email: ${stats.handlersConfigured.email}`);
  }

  // 9. Initialize Email Monitor (if available)
  if (EmailMonitor && llmRouter) {
    console.log('[INIT] Setting up Email Monitor...');
    try {
      // Try to get default Talk room token: primaryRoom config > env > NC Passwords
      let defaultRoomToken = appConfig.talk.primaryRoom || process.env.NC_TALK_DEFAULT_TOKEN || null;
      if (!defaultRoomToken) {
        try {
          const roomConfig = await credentialBroker.get('nc-talk-room');
          if (roomConfig) {
            // Could be stored as password field or as an object
            defaultRoomToken = typeof roomConfig === 'string' ? roomConfig : roomConfig.password || roomConfig.token;
            if (defaultRoomToken) {
              console.log('[INIT] Got default Talk room from NC Passwords');
            }
          }
        } catch {
          // No room token configured, will be set when user first messages
        }
      }

      if (defaultRoomToken && !defaultTalkToken) {
        defaultTalkToken = defaultRoomToken;
      }

      emailMonitor = new EmailMonitor({
        credentialBroker: credentialBroker,
        llmRouter: llmRouter,
        calendarClient: caldavClient, // Enable meeting-aware email processing
        auditLog: auditLogger ? auditLogger.log.bind(auditLogger) : consoleAuditLog,
        sendTalkMessage: async (token, message) => {
          return await sendTalkReply(token, message, null);
        },
        defaultToken: defaultRoomToken,
        heartbeatInterval: parseInt(process.env.EMAIL_CHECK_INTERVAL) || 5 * 60 * 1000 // 5 minutes default
      });

      // Start monitoring (will begin after 30 second delay).
      // When HeartbeatManager is present (bot.js), pulse() drives checkInbox() instead.
      emailMonitor.start();
      console.log(`[INIT] Email Monitor started (first check in 30s)${defaultRoomToken ? ', room: ' + defaultRoomToken : ', room: waiting for first message'}`);
    } catch (err) {
      console.warn(`[INIT] Email Monitor failed: ${err.message}`);
    }
  }

  // 10. Initialize Server Components (decomposed handlers)
  console.log('[INIT] Setting up Server Components...');
  // Session 37: Derive bot names from cockpit persona name (if available)
  let botNames = ['moltagent'];
  if (cockpitManager) {
    try {
      // CockpitManager may have cached config from a previous run
      const cockpitConfig = cockpitManager.cachedConfig;
      const personaName = cockpitConfig?.persona?.name || 'Molti';
      botNames = [...new Set([personaName, 'moltagent', personaName.toLowerCase()].filter(Boolean))];
    } catch {
      botNames = ['Molti', 'moltagent', 'molti'];
    }
  } else {
    botNames = ['Molti', 'moltagent', 'molti'];
  }

  // Create SelfHealClient (heald daemon on Ollama VM)
  if (SelfHealClient && appConfig.infra?.heald?.url && credentialBroker) {
    selfHealClient = new SelfHealClient({
      url: appConfig.infra.heald.url,
      tokenCredential: appConfig.infra.heald.tokenCredential,
      timeoutMs: appConfig.infra.heald.timeoutMs,
      credentialBroker
    });
    console.log(`[INIT] SelfHealClient ready → ${appConfig.infra.heald.url}`);
  }

  serverComponents = createServerComponents({
    signatureVerifier: signatureVerifier,
    messageRouter: messageRouter,
    llmRouter: llmRouter,
    ncRequestManager: ncRequestManager,
    conversationContext: conversationContext,
    agentLoop: agentLoop,
    sessionManager: sessionManager,
    statusIndicator: ncStatusIndicator,
    botEnroller: botEnroller,
    filesClient: ncFilesClient,
    whisperClient: whisperClient,
    audioConverter: audioConverter,
    voiceManager: voiceManager,
    microPipeline: microPipeline,
    intentRouter: intentRouter,
    warmMemory: warmMemory,
    botNames: botNames,
    sendTalkReply: sendTalkReply,
    auditLog: auditLogger ? auditLogger.log.bind(auditLogger) : consoleAuditLog,
    botUsername: CONFIG.nc.username,
    allowedBackends: CONFIG.security.allowedBackends,
    selfHealClient,
    adminUser: appConfig.cockpit?.adminUser || '',
    onTokenDiscovered: (token) => {
      // Save token for email monitor notifications (use first room we see)
      if (token && !defaultTalkToken) {
        defaultTalkToken = token;
        if (emailMonitor) {
          emailMonitor.updateConfig('notifyRoom', token);
          console.log(`[Message] Set default notification room: ${token}`);
        }
      }
    }
  });
  console.log('[INIT] Server Components ready');

  // 11. Initialize HeartbeatManager (proactive operations)
  if (HeartbeatManager && ncRequestManager && llmRouter) {
    console.log('[INIT] Setting up Heartbeat Manager...');
    try {
      const auditFn = auditLogger ? auditLogger.log.bind(auditLogger) : consoleAuditLog;

      // Create KnowledgeBoard (verification tracking via Deck)
      if (KnowledgeBoard && DeckClient && ncRequestManager) {
        try {
          const knowledgeDeckClient = new DeckClient(ncRequestManager, {
            boardName: 'MoltAgent Knowledge',
            stacks: {
              verified: 'Verified',
              uncertain: 'Uncertain',
              stale: 'Stale',
              disputed: 'Disputed'
            }
          });
          knowledgeBoard = new KnowledgeBoard({ deckClient: knowledgeDeckClient });
          console.log('[INIT] KnowledgeBoard ready');
        } catch (err) {
          console.warn(`[INIT] KnowledgeBoard failed: ${err.message}`);
        }
      }

      // Create HeartbeatIntelligence components
      let meetingPreparer = null;
      let heartbeatFreshnessChecker = null;

      if (HeartbeatIntelligence) {
        try {
          const { FreshnessChecker: HBFreshnessChecker } = HeartbeatIntelligence;

          if (collectivesClient) {
            heartbeatFreshnessChecker = new HBFreshnessChecker({
              collectivesClient: collectivesClient,
              deckClient: deckClient2,
              notifyUser,
              config: appConfig
            });
          }

          console.log('[INIT] Heartbeat Intelligence components ready');
        } catch (err) {
          console.warn(`[INIT] Heartbeat Intelligence failed: ${err.message}`);
        }
      }

      // Create NC Flow modules for heartbeat event routing
      let ncFlowSystemTags = null;
      if (ActivityPoller && ncRequestManager) {
        try {
          ncFlowActivityPoller = new ActivityPoller(appConfig.ncFlow.activity, ncRequestManager);
          console.log('[INIT] NC Flow ActivityPoller ready (for heartbeat)');
        } catch (err) {
          console.warn(`[INIT] NC Flow ActivityPoller failed: ${err.message}`);
        }
      }
      if (WebhookReceiver) {
        try {
          ncFlowWebhookReceiver = new WebhookReceiver(appConfig.ncFlow.webhooks);
          console.log('[INIT] NC Flow WebhookReceiver ready (for heartbeat)');
        } catch (err) {
          console.warn(`[INIT] NC Flow WebhookReceiver failed: ${err.message}`);
        }
      }
      if (SystemTagsClient && ncRequestManager && appConfig.ncFlow.tags.enabled) {
        try {
          ncFlowSystemTags = new SystemTagsClient(appConfig.ncFlow.tags, ncRequestManager);
          await ncFlowSystemTags.refreshTagIds();
          console.log('[INIT] NC Flow SystemTags ready (for heartbeat)');
        } catch (err) {
          console.warn(`[INIT] NC Flow SystemTags failed: ${err.message}`);
        }
      }

      // Create InfraMonitor (Session 38: Infrastructure Awareness)
      if (InfraMonitor && appConfig.infra?.enabled !== false) {
        infraMonitor = new InfraMonitor({
          services: {
            ollama: { url: CONFIG.ollama.url, selfHeal: 'ollama_reload' },
            whisper: appConfig.voice?.whisperUrl ? { url: appConfig.voice.whisperUrl } : null,
            searxng: appConfig.search?.searxng?.url ? { url: appConfig.search.searxng.url } : null,
            nextcloud: { url: CONFIG.nc.url }
          },
          ollamaModel: CONFIG.ollama.model,
          notifyUser,
          auditLog: auditFn,
          checkInterval: appConfig.infra?.checkInterval || 3,
          probeTimeoutMs: appConfig.infra?.probeTimeoutMs || 8000,
          selfHealEnabled: appConfig.infra?.selfHealEnabled !== false,
          notifyOnFailure: appConfig.infra?.notifyOnFailure !== false,
          selfHealClient
        });
        console.log(`[INIT] InfraMonitor ready (${infraMonitor.probes.length} probes, interval=${infraMonitor.checkInterval})`);
      }

      // Create HeartbeatManager
      heartbeatManager = new HeartbeatManager({
        nextcloud: {
          url: CONFIG.nc.url,
          username: CONFIG.nc.username
        },
        credentialBroker,
        ncRequestManager,
        deck: CONFIG.deck,
        heartbeat: {
          ...CONFIG.heartbeat,
          initiativeLevel: appConfig.proactive.initiativeLevel
        },
        llmRouter,
        notifyUser,
        auditLog: auditFn,
        knowledgeLog: learningLog,
        knowledgeBoard,
        contextLoader,
        freshnessChecker,
        cockpitManager,
        botEnroller,
        statusIndicator: ncStatusIndicator,
        workflowEngine,
        infraMonitor,
        voiceManager,
        warmMemory,
        deferralQueue,
        agentLoop,
        collectivesClient,
        ncFilesClient,
        dailyBriefing,
        talkSendQueue: talkQueue,
        primaryRoomToken: defaultTalkToken,
        ncFlow: ncFlowActivityPoller || ncFlowWebhookReceiver ? {
          activityPoller: ncFlowActivityPoller,
          webhookReceiver: ncFlowWebhookReceiver,
          systemTags: ncFlowSystemTags
        } : null
      });

      // Wire post-construction dependencies using HeartbeatManager's internal clients
      if (rsvpTracker && heartbeatManager.caldavClient) {
        heartbeatManager.rsvpTracker = rsvpTracker;
      }

      // Patch DailyBriefing with heartbeat's caldav/deck clients
      if (dailyBriefing && heartbeatManager.caldavClient) {
        dailyBriefing.caldav = heartbeatManager.caldavClient;
        dailyBriefing.deck = heartbeatManager.deckClient;
      }

      if (HeartbeatIntelligence && heartbeatManager.caldavClient) {
        try {
          const { MeetingPreparer } = HeartbeatIntelligence;

          // Create meeting preparer now that caldav is available
          meetingPreparer = new MeetingPreparer({
            caldavClient: heartbeatManager.caldavClient,
            collectivesClient: collectivesClient,
            contactsClient: contactsClient,
            emailMonitor: emailMonitor,
            deckClient: heartbeatManager.deckClient,
            router: llmRouter,
            notifyUser,
            config: appConfig
          });
          heartbeatManager.meetingPreparer = meetingPreparer;

          // Wire freshness checker
          if (heartbeatFreshnessChecker) {
            heartbeatManager.hbFreshnessChecker = heartbeatFreshnessChecker;
          }

          console.log('[INIT] Heartbeat Intelligence wired to HeartbeatManager');
        } catch (err) {
          console.warn(`[INIT] Heartbeat Intelligence wiring failed: ${err.message}`);
        }
      }

      // Wire NC Flow events into HeartbeatManager
      if (ncFlowActivityPoller) {
        ncFlowActivityPoller.on('event', (event) => heartbeatManager.enqueueExternalEvent(event));
      }
      if (ncFlowWebhookReceiver) {
        ncFlowWebhookReceiver.on('event', (event) => heartbeatManager.enqueueExternalEvent(event));
      }

      console.log('[INIT] HeartbeatManager ready');
    } catch (err) {
      console.warn(`[INIT] HeartbeatManager setup failed: ${err.message}`);
      heartbeatManager = null;
    }
  }

  console.log('[INIT] Initialization complete');
}

/**
 * Send a reply to NC Talk - uses NCRequestManager
 */
async function sendTalkReply(token, message, replyTo) {
  try {
    return await talkQueue.enqueue(token, message, replyTo);
  } catch (error) {
    console.error('[Talk] Reply error:', error.message);
    return false;
  }
}

/**
 * Process an incoming message
 * Delegates to MessageProcessor from server components
 */
async function processMessage(data) {
  if (serverComponents && serverComponents.messageProcessor) {
    return await serverComponents.messageProcessor.process(data);
  }

  // Fallback if server components not initialized (shouldn't happen)
  console.error('[Process] Server components not initialized');
  return null;
}

/**
 * HTTP request handler
 * Delegates to appropriate server component handlers
 */
async function handleRequest(req, res) {
  // Health check endpoint
  if (req.method === 'GET' && req.url === '/health') {
    if (serverComponents && serverComponents.healthHandler) {
      serverComponents.healthHandler.handleHealth(req, res);
    } else {
      // Fallback if not initialized
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        status: 'ok',
        service: 'moltagent-webhook',
        version: '2.0.0',
        verifications: signatureVerifier.getStats().totalVerifications
      }));
    }
    return;
  }

  // Stats endpoint
  if (req.method === 'GET' && req.url === '/stats') {
    if (serverComponents && serverComponents.healthHandler) {
      serverComponents.healthHandler.handleStats(req, res);
    } else {
      // Fallback if not initialized
      const stats = {
        verifier: signatureVerifier.getStats(),
        ncRequestManager: ncRequestManager ? ncRequestManager.getMetrics() : null
      };
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(stats, null, 2));
    }
    return;
  }

  // NC Talk webhook endpoint
  if (req.method === 'POST' && req.url === '/webhook/nctalk') {
    if (serverComponents && serverComponents.webhookHandler) {
      await serverComponents.webhookHandler.handle(req, res);
    } else {
      // Fallback if not initialized
      res.writeHead(503, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Server not ready' }));
    }
    return;
  }

  // 404 for unknown routes
  res.writeHead(404, { 'Content-Type': 'text/plain' });
  res.end('Not found');
}

/**
 * Graceful shutdown
 */
async function shutdown(signal) {
  console.log('');
  console.log(`[SHUTDOWN] Received ${signal}, stopping gracefully...`);

  // Set status to shutdown at start
  if (ncStatusIndicator) {
    await ncStatusIndicator.setStatus('shutdown');
    console.log('[SHUTDOWN] Status set to Shutdown');
  }

  // Stop SessionManager cleanup timer
  if (sessionCleanupTimer) {
    clearInterval(sessionCleanupTimer);
    sessionCleanupTimer = null;
    console.log('[SHUTDOWN] SessionManager cleanup timer stopped');
  }

  // Stop NC Flow modules
  if (ncFlowActivityPoller) {
    ncFlowActivityPoller.stop();
    console.log('[SHUTDOWN] NC Flow ActivityPoller stopped');
  }
  if (ncFlowWebhookReceiver) {
    try { await ncFlowWebhookReceiver.stop(); } catch {}
    console.log('[SHUTDOWN] NC Flow WebhookReceiver stopped');
  }

  // Stop RoomMonitor
  if (roomMonitor) {
    roomMonitor.stop();
    console.log('[SHUTDOWN] RoomMonitor stopped');
  }

  // Stop heartbeat
  if (heartbeatManager) {
    try { await heartbeatManager.stop(); } catch {}
    console.log('[SHUTDOWN] HeartbeatManager stopped');
  }

  // Stop email monitor
  if (emailMonitor) {
    emailMonitor.stop();
    console.log('[SHUTDOWN] Email Monitor stopped');
  }

  // Log final stats
  const stats = signatureVerifier.getStats();
  console.log(`[SHUTDOWN] Final stats: ${stats.totalVerifications} verifications, ${stats.successRate} success rate`);

  // Log NCRequestManager metrics
  if (ncRequestManager) {
    const ncMetrics = ncRequestManager.getMetrics();
    console.log(`[SHUTDOWN] NC Request metrics: ${ncMetrics.totalRequests} requests, ${ncMetrics.hitRate} cache hit rate`);
  }

  // Flush audit logs
  if (auditLogger && auditLogger.shutdown) {
    await auditLogger.shutdown();
    console.log('[SHUTDOWN] Audit logs flushed');
  }

  // Drain Talk queue before discarding credentials
  if (talkQueue) {
    await talkQueue.shutdown();
    console.log('[SHUTDOWN] Talk Send Queue drained');
  }

  // Shutdown credential cache
  if (credentialCache) {
    credentialCache.shutdown();
    console.log('[SHUTDOWN] Credential cache cleared');
  }

  // Shutdown NCRequestManager
  if (ncRequestManager) {
    await ncRequestManager.shutdown();
    console.log('[SHUTDOWN] NC Request Manager shutdown');
  }

  // Discard credentials
  if (credentialBroker) {
    credentialBroker.discardAll();
    console.log('[SHUTDOWN] Credentials discarded');
  }

  console.log('[SHUTDOWN] Goodbye!');
  process.exit(0);
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

/**
 * Start the server
 */
async function start() {
  try {
    await initialize();

    const server = http.createServer(handleRequest);

    server.listen(CONFIG.port, '0.0.0.0', async () => {
      console.log('');
      console.log('======================================================================');
      console.log('           MoltAgent Webhook Server Running!                          ');
      console.log('======================================================================');
      console.log('');
      console.log(`Webhook URL: http://0.0.0.0:${CONFIG.port}/webhook/nctalk`);
      console.log(`Health check: http://0.0.0.0:${CONFIG.port}/health`);
      console.log(`Stats: http://0.0.0.0:${CONFIG.port}/stats`);
      console.log('');
      console.log('Ready to receive NC Talk messages');
      console.log('Press Ctrl+C to stop');
      console.log('');

      // Start HeartbeatManager after server is listening (NC API clients ready)
      if (heartbeatManager) {
        try {
          console.log('[INIT] Starting heartbeat...');
          await heartbeatManager.start();
          console.log(`[INIT] Heartbeat running (interval: ${CONFIG.heartbeat.intervalMs / 1000}s, initiative: ${appConfig.proactive.initiativeLevel})`);
        } catch (err) {
          console.error(`[INIT] Heartbeat start failed: ${err.message}`);
        }
      }

      // Start RoomMonitor (after heartbeat, so BotEnroller has initial data)
      if (roomMonitor) {
        try {
          await roomMonitor.start();
          console.log('[INIT] RoomMonitor started');
        } catch (err) {
          console.warn(`[INIT] RoomMonitor start failed: ${err.message}`);
        }
      }

      // Start NC Flow modules
      if (ncFlowWebhookReceiver) {
        try {
          await ncFlowWebhookReceiver.start();
          console.log('[INIT] NC Flow WebhookReceiver started');
        } catch (err) {
          console.warn(`[INIT] NC Flow WebhookReceiver start failed: ${err.message}`);
        }
      }
      if (ncFlowActivityPoller) {
        ncFlowActivityPoller.start();
        console.log('[INIT] NC Flow ActivityPoller started');
      }

      // Set status to ready after all initialization complete
      if (ncStatusIndicator) {
        await ncStatusIndicator.setStatus('ready');
        console.log('[INIT] Status set to Ready');
      }
    });

  } catch (error) {
    console.error('[FATAL] Failed to start:', error);
    if (credentialBroker) {
      credentialBroker.discardAll();
    }
    process.exit(1);
  }
}

// Run
start();
