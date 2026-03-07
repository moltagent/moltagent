/**
 * MoltAgent Centralized Configuration
 *
 * Architecture Brief:
 * -------------------
 * Problem: Hardcoded values (URLs, timeouts, limits) scattered across codebase
 * make deployment configuration difficult and error-prone.
 *
 * Pattern: Single frozen config object with environment variable overrides.
 * All configuration flows from this module; consumers import and use directly.
 *
 * Key Dependencies:
 * - None (leaf module - no internal dependencies)
 *
 * Data Flow:
 * - Environment variables -> defaults -> frozen config object
 * - Consumers import config and access nested properties
 *
 * @module config
 * @version 1.0.0
 */

'use strict';

// -----------------------------------------------------------------------------
// Helper Functions
// -----------------------------------------------------------------------------

/**
 * Parse integer from environment variable with fallback
 * @param {string} envVar - Environment variable name
 * @param {number} defaultValue - Default if not set or invalid
 * @returns {number}
 */
function envInt(envVar, defaultValue) {
  const value = process.env[envVar];
  if (value === undefined || value === '') {
    return defaultValue;
  }
  const parsed = parseInt(value, 10);
  return Number.isNaN(parsed) ? defaultValue : parsed;
}

/**
 * Parse boolean from environment variable with fallback
 * @param {string} envVar - Environment variable name
 * @param {boolean} defaultValue - Default if not set
 * @returns {boolean}
 */
function envBool(envVar, defaultValue) {
  const value = process.env[envVar];
  if (value === undefined || value === '') {
    return defaultValue;
  }
  return value.toLowerCase() === 'true' || value === '1';
}

/**
 * Parse string from environment variable with fallback
 * @param {string} envVar - Environment variable name
 * @param {string} defaultValue - Default if not set
 * @returns {string}
 */
function envStr(envVar, defaultValue) {
  const value = process.env[envVar];
  return (value !== undefined && value !== '') ? value : defaultValue;
}

/**
 * Parse comma-separated list from environment variable
 * @param {string} envVar - Environment variable name
 * @param {string[]} defaultValue - Default if not set
 * @returns {string[]}
 */
function envList(envVar, defaultValue) {
  const value = process.env[envVar];
  if (value === undefined || value === '') {
    return defaultValue;
  }
  return value.split(',').map(s => s.trim()).filter(Boolean);
}

// -----------------------------------------------------------------------------
// Configuration Object
// -----------------------------------------------------------------------------

/**
 * @typedef {Object} NextcloudConfig
 * @property {string} url - Nextcloud base URL
 * @property {string} username - Nextcloud username
 */

/**
 * @typedef {Object} OllamaConfig
 * @property {string} url - Ollama API URL
 * @property {string} model - Default model name
 */

/**
 * @typedef {Object} ServerConfig
 * @property {number} port - HTTP server port
 * @property {string} host - Bind host
 */

/**
 * @typedef {Object} SecurityConfig
 * @property {string[]} allowedBackends - Allowed webhook backend URLs
 * @property {boolean} strictMode - Strict signature verification
 */

/**
 * @typedef {Object} TimeoutsConfig
 * @property {number} httpRequest - HTTP request timeout (ms)
 * @property {number} ollamaHealth - Ollama health check timeout (ms)
 * @property {number} deckApi - Deck API request timeout (ms)
 * @property {number} imapConnection - IMAP connection timeout (ms)
 * @property {number} smtpConnection - SMTP connection timeout (ms)
 */

/**
 * @typedef {Object} ResilienceConfig
 * @property {number} maxConcurrent - Max concurrent NC requests
 * @property {number} defaultRetryAfter - Default backoff on 429 (ms)
 * @property {number} maxQueueSize - Max request queue size
 * @property {number} maxRetries - Default max retries
 */

/**
 * @typedef {Object} CacheTTLConfig
 * @property {number} passwords - NC Passwords cache TTL (ms)
 * @property {number} caldav - CalDAV cache TTL (ms)
 * @property {number} deck - Deck cache TTL (ms)
 * @property {number} webdav - WebDAV cache TTL (ms)
 * @property {number} talk - Talk cache TTL (ms)
 * @property {number} ocs - OCS cache TTL (ms)
 * @property {number} credentials - Credential cache TTL (ms)
 */

/**
 * @typedef {Object} HeartbeatConfig
 * @property {number} intervalMs - Heartbeat interval (ms)
 * @property {number} quietHoursStart - Quiet hours start (24h)
 * @property {number} quietHoursEnd - Quiet hours end (24h)
 * @property {number} maxTasksPerCycle - Max tasks per heartbeat cycle
 * @property {number} calendarLookaheadMinutes - Calendar lookahead (minutes)
 * @property {boolean} deckEnabled - Enable Deck processing
 * @property {boolean} caldavEnabled - Enable CalDAV processing
 */

/**
 * @typedef {Object} EmailMonitorConfig
 * @property {number} initialDelayMs - Initial check delay (ms)
 * @property {number} maxPendingNotifications - Max pending notification queue
 * @property {number} staleNotificationMs - Stale notification threshold (ms)
 * @property {number} maxProcessedEmailIds - Max processed email IDs to track
 */

/**
 * @typedef {Object} DeckConfig
 * @property {number} boardId - Default Deck board ID
 * @property {number} archiveAfterDays - Days before archiving
 */

/**
 * @typedef {Object} LLMConfig
 * @property {number} maxTokens - Default max tokens
 * @property {number} circuitBreakerThreshold - Circuit breaker failure threshold
 * @property {number} circuitBreakerResetMs - Circuit breaker reset timeout (ms)
 * @property {number} loopDetectorWindow - Loop detector window (ms)
 * @property {number} loopDetectorMaxSame - Max same calls before loop detected
 * @property {number} backoffInitialMs - Initial backoff delay (ms)
 * @property {number} backoffMaxMs - Max backoff delay (ms)
 * @property {number} backoffMaxAttempts - Max backoff attempts
 */

/**
 * @typedef {Object} PendingActionsConfig
 * @property {number} confirmationTTLMs - Confirmation expiry time (ms)
 * @property {number} emailReplyTTLMs - Email reply expiry time (ms)
 * @property {number} cleanupIntervalMs - Cleanup interval (ms)
 */

/**
 * @typedef {Object} PortsConfig
 * @property {number} imapDefault - Default IMAP port
 * @property {number} imapTls - IMAP with TLS port
 * @property {number} smtpDefault - Default SMTP port
 * @property {number} smtpTls - SMTP with TLS port
 */

/**
 * @typedef {Object} Config
 * @property {NextcloudConfig} nextcloud
 * @property {OllamaConfig} ollama
 * @property {ServerConfig} server
 * @property {SecurityConfig} security
 * @property {TimeoutsConfig} timeouts
 * @property {ResilienceConfig} resilience
 * @property {CacheTTLConfig} cacheTTL
 * @property {HeartbeatConfig} heartbeat
 * @property {EmailMonitorConfig} emailMonitor
 * @property {DeckConfig} deck
 * @property {LLMConfig} llm
 * @property {PendingActionsConfig} pendingActions
 * @property {PortsConfig} ports
 * @property {boolean} debugMode
 */

const config = {
  // -------------------------------------------------------------------------
  // Nextcloud Connection
  // -------------------------------------------------------------------------
  nextcloud: {
    url: envStr('NC_URL', 'https://nx89136.your-storageshare.de'),
    username: envStr('NC_USER', 'moltagent')
  },

  // -------------------------------------------------------------------------
  // Claude Cloud LLM
  // -------------------------------------------------------------------------
  claude: {
    modelPremium: envStr('CLAUDE_MODEL_PREMIUM', 'claude-opus-4-6'),
    modelStandard: envStr('CLAUDE_MODEL_STANDARD', 'claude-sonnet-4-5-20250929')
  },

  // -------------------------------------------------------------------------
  // Ollama LLM
  // -------------------------------------------------------------------------
  ollama: {
    url: envStr('OLLAMA_URL', 'http://138.201.246.236:11434'),
    model: envStr('OLLAMA_MODEL', 'phi4-mini'),
    modelCredential: envStr('OLLAMA_MODEL_CREDENTIAL', null) || envStr('OLLAMA_MODEL', 'phi4-mini'),
    modelFast: envStr('OLLAMA_MODEL_FAST', null) || envStr('OLLAMA_CLASSIFY_MODEL', 'qwen2.5:3b'),
    timeout: envInt('OLLAMA_TIMEOUT', 300000),
    toolTimeout: envInt('OLLAMA_TOOL_TIMEOUT', 60000),
    domainToolTimeout: envInt('OLLAMA_DOMAIN_TOOL_TIMEOUT', 90000),
    classifyTimeout: envInt('OLLAMA_CLASSIFY_TIMEOUT', 30000),
    classifyModel: envStr('OLLAMA_CLASSIFY_MODEL', 'qwen2.5:3b'),
    smartModel: envStr('OLLAMA_SMART_MODEL', 'qwen3:8b')
  },

  // -------------------------------------------------------------------------
  // HTTP Server
  // -------------------------------------------------------------------------
  server: {
    port: envInt('PORT', 3000),
    host: envStr('HOST', '0.0.0.0')
  },

  // -------------------------------------------------------------------------
  // Security
  // -------------------------------------------------------------------------
  security: {
    allowedBackends: envList('NC_TALK_BACKENDS', []),
    strictMode: envBool('STRICT_MODE', true)
  },

  // -------------------------------------------------------------------------
  // Timeouts (milliseconds)
  // -------------------------------------------------------------------------
  timeouts: {
    httpRequest: envInt('TIMEOUT_HTTP_REQUEST', 30000),
    ollamaHealth: envInt('TIMEOUT_OLLAMA_HEALTH', 5000),
    deckApi: envInt('TIMEOUT_DECK_API', 30000),
    imapConnection: envInt('TIMEOUT_IMAP', 30000),
    smtpConnection: envInt('TIMEOUT_SMTP', 30000),
    gracefulShutdown: envInt('TIMEOUT_SHUTDOWN', 30000)
  },

  // -------------------------------------------------------------------------
  // NC Request Manager Resilience
  // -------------------------------------------------------------------------
  resilience: {
    maxConcurrent: envInt('NC_MAX_CONCURRENT', 4),
    defaultRetryAfter: envInt('NC_RETRY_AFTER', 30000),
    maxQueueSize: envInt('NC_MAX_QUEUE', 1000),
    maxRetries: envInt('NC_MAX_RETRIES', 3)
  },

  // -------------------------------------------------------------------------
  // Cache TTLs (milliseconds)
  // -------------------------------------------------------------------------
  cacheTTL: {
    passwords: envInt('CACHE_TTL_PASSWORDS', 5 * 60 * 1000),    // 5 minutes
    caldav: envInt('CACHE_TTL_CALDAV', 1 * 60 * 1000),          // 1 minute
    deck: envInt('CACHE_TTL_DECK', 30 * 1000),                   // 30 seconds
    webdav: envInt('CACHE_TTL_WEBDAV', 30 * 1000),              // 30 seconds
    talk: envInt('CACHE_TTL_TALK', 5 * 1000),                    // 5 seconds
    ocs: envInt('CACHE_TTL_OCS', 30 * 1000),                     // 30 seconds
    credentials: envInt('CACHE_TTL_CREDENTIALS', 30 * 1000),     // 30 seconds
    collectives: envInt('CACHE_TTL_COLLECTIVES', 60 * 1000),     // 1 minute
    carddav: envInt('CACHE_TTL_CARDDAV', 60 * 1000)             // 1 minute
  },

  // -------------------------------------------------------------------------
  // Heartbeat Manager
  // -------------------------------------------------------------------------
  heartbeat: {
    intervalMs: envInt('HEARTBEAT_INTERVAL', 5 * 60 * 1000),     // 5 minutes
    quietHoursStart: envInt('QUIET_START', 22),                   // 10 PM
    quietHoursEnd: envInt('QUIET_END', 7),                        // 7 AM
    maxTasksPerCycle: envInt('HEARTBEAT_MAX_TASKS', 3),
    calendarLookaheadMinutes: envInt('HEARTBEAT_CALENDAR_LOOKAHEAD', 30),
    deckEnabled: envBool('HEARTBEAT_DECK_ENABLED', true),
    caldavEnabled: envBool('HEARTBEAT_CALDAV_ENABLED', true)
  },

  // -------------------------------------------------------------------------
  // Email Monitor
  // -------------------------------------------------------------------------
  emailMonitor: {
    initialDelayMs: envInt('EMAIL_MONITOR_INITIAL_DELAY', 30000), // 30 seconds
    maxPendingNotifications: envInt('EMAIL_MAX_PENDING', 10),
    staleNotificationMs: envInt('EMAIL_STALE_NOTIFICATION', 24 * 60 * 60 * 1000), // 24 hours
    maxProcessedEmailIds: envInt('EMAIL_MAX_PROCESSED_IDS', 1000)
  },

  // -------------------------------------------------------------------------
  // Deck
  // -------------------------------------------------------------------------
  deck: {
    boardId: envInt('DECK_BOARD_ID', 8),
    archiveAfterDays: envInt('DECK_ARCHIVE_AFTER_DAYS', 180),
    taskBoardTitle: envStr('DECK_TASK_BOARD', 'MoltAgent Tasks'),
    cockpitBoardTitle: envStr('DECK_COCKPIT_BOARD', 'Moltagent Cockpit'),
    personalBoardTitle: envStr('DECK_PERSONAL_BOARD', 'Personal')
  },

  // -------------------------------------------------------------------------
  // Knowledge (Collectives Wiki)
  // -------------------------------------------------------------------------
  knowledge: {
    collectiveName: envStr('KNOWLEDGE_COLLECTIVE', 'Moltagent Knowledge'),
    adminUser: envStr('KNOWLEDGE_ADMIN_USER', ''),
    sections: ['People', 'Projects', 'Procedures', 'Research', 'Meta'],
    learningLogPage: 'Meta/Learning Log',
    defaultDecayDays: envInt('KNOWLEDGE_DECAY_DAYS', 90),
    defaultConfidence: envStr('KNOWLEDGE_DEFAULT_CONFIDENCE', 'medium'),
    freshness: {
      enabled: envBool('KNOWLEDGE_FRESHNESS_ENABLED', true),
      checkIntervalMs: envInt('KNOWLEDGE_FRESHNESS_INTERVAL', 60 * 60 * 1000),  // 1 hour
      maxPagesPerScan: envInt('KNOWLEDGE_FRESHNESS_MAX_PAGES', 20)
    }
  },

  // -------------------------------------------------------------------------
  // Web Search & Reading
  // -------------------------------------------------------------------------
  search: {
    searxng: {
      url: envStr('SEARXNG_URL', ''),
      defaultLimit: envInt('SEARXNG_DEFAULT_LIMIT', 5),
      timeoutMs: envInt('SEARXNG_TIMEOUT', 10000),
      defaultEngines: envStr('SEARXNG_DEFAULT_ENGINES', ''),
      defaultLanguage: envStr('SEARXNG_DEFAULT_LANGUAGE', 'en')
    },
    webReader: {
      timeoutMs: envInt('WEB_READER_TIMEOUT', 15000),
      maxResponseBytes: envInt('WEB_READER_MAX_BYTES', 5 * 1024 * 1024),
      maxOutputChars: envInt('WEB_READER_MAX_CHARS', 12000),
      cacheTtlMs: envInt('WEB_READER_CACHE_TTL', 60 * 60 * 1000),
      maxCacheEntries: envInt('WEB_READER_MAX_CACHE', 50),
      userAgent: envStr('WEB_READER_USER_AGENT', 'MoltAgent/1.0')
    }
  },

  // -------------------------------------------------------------------------
  // Contacts (CardDAV)
  // -------------------------------------------------------------------------
  contacts: {
    addressBook: envStr('CONTACTS_ADDRESS_BOOK', 'contacts'),
    cacheTTLMs: envInt('CONTACTS_CACHE_TTL', 3600000)           // 1 hour
  },

  // -------------------------------------------------------------------------
  // Timezone (IANA identifier, e.g. 'Europe/Lisbon')
  // -------------------------------------------------------------------------
  timezone: envStr('TIMEZONE', 'UTC'),

  // -------------------------------------------------------------------------
  // Proactive Operations (Spec C Cost Model)
  // -------------------------------------------------------------------------
  proactive: {
    initiativeLevel: envInt('INITIATIVE_LEVEL', 1),
    dailyCloudBudget: parseFloat(envStr('PROACTIVE_DAILY_BUDGET', '0.50'))
  },

  // -------------------------------------------------------------------------
  // Talk Notifications
  // -------------------------------------------------------------------------
  talk: {
    // Primary room for proactive messages (daily digest, meeting prep, alerts).
    // TALK_PRIMARY_ROOM takes precedence; TALK_ROOM_TOKEN is the legacy alias;
    // NC_TALK_DEFAULT_TOKEN is the oldest alias (kept for backward compat).
    primaryRoom: envStr('TALK_PRIMARY_ROOM', envStr('TALK_ROOM_TOKEN', envStr('NC_TALK_DEFAULT_TOKEN', ''))),
    defaultToken: envStr('NC_TALK_DEFAULT_TOKEN', null),
    botName: envStr('TALK_BOT_NAME', 'Moltagent'),
    conversationContext: {
      enabled: envBool('TALK_CONTEXT_ENABLED', true),
      maxMessages: envInt('TALK_CONTEXT_MAX_MESSAGES', 20),
      maxTokenEstimate: envInt('TALK_CONTEXT_MAX_TOKENS', 4000),
      includeSystemMessages: envBool('TALK_CONTEXT_INCLUDE_SYSTEM', false),
      maxMessageAge: envInt('TALK_CONTEXT_MAX_AGE', 7200000)
    }
  },

  // -------------------------------------------------------------------------
  // NC Flow (workspace event awareness)
  // -------------------------------------------------------------------------
  ncFlow: {
    webhooks: {
      enabled: envBool('NCFLOW_WEBHOOKS_ENABLED', false),
      port: envInt('NCFLOW_WEBHOOKS_PORT', 3100),
      host: envStr('NCFLOW_WEBHOOKS_HOST', '0.0.0.0'),
      secret: envStr('NCFLOW_WEBHOOKS_SECRET', ''),
      trustedIPs: envList('NCFLOW_WEBHOOKS_TRUSTED_IPS', []),
      shutdownTimeoutMs: envInt('NCFLOW_WEBHOOKS_SHUTDOWN_TIMEOUT', 5000)
    },
    activity: {
      enabled: envBool('NCFLOW_ACTIVITY_ENABLED', true),
      pollIntervalMs: envInt('NCFLOW_ACTIVITY_INTERVAL', 60000),
      maxEventsPerPoll: envInt('NCFLOW_ACTIVITY_MAX_EVENTS', 50),
      ignoreOwnEvents: envBool('NCFLOW_ACTIVITY_IGNORE_OWN', true),
      ignoreUsers: envList('NCFLOW_ACTIVITY_IGNORE_USERS', []),
      enabledTypes: envList('NCFLOW_ACTIVITY_ENABLED_TYPES', [
        'file_created', 'file_changed', 'file_deleted', 'file_shared',
        'calendar_event_created', 'calendar_event_changed',
        'deck_card_created', 'deck_card_updated', 'deck_card_moved',
        'deck_comment_added',
        'tag_assigned', 'tag_removed',
        'share_created'
      ])
    },
    tags: {
      enabled: envBool('NCFLOW_TAGS_ENABLED', true),
      tagIds: {
        'pending': envInt('NCFLOW_TAG_PENDING_ID', 2),
        'processed': envInt('NCFLOW_TAG_PROCESSED_ID', 5),
        'needs-review': envInt('NCFLOW_TAG_NEEDS_REVIEW_ID', 8),
        'ai-flagged': envInt('NCFLOW_TAG_AI_FLAGGED_ID', 11)
      }
    }
  },

  // -------------------------------------------------------------------------
  // LLM Router
  // -------------------------------------------------------------------------
  llm: {
    maxTokens: envInt('LLM_MAX_TOKENS', 1024),
    circuitBreakerThreshold: envInt('LLM_CB_THRESHOLD', 5),
    circuitBreakerResetMs: envInt('LLM_CB_RESET', 60000),
    circuitBreakerSuccessThreshold: envInt('LLM_CB_SUCCESS', 3),
    loopDetectorWindow: envInt('LLM_LOOP_WINDOW', 60000),
    loopDetectorMaxSame: envInt('LLM_LOOP_MAX_SAME', 5),
    loopDetectorMaxErrors: envInt('LLM_LOOP_MAX_ERRORS', 3),
    loopDetectorPingPongThreshold: envInt('LLM_LOOP_PINGPONG', 4),
    backoffInitialMs: envInt('LLM_BACKOFF_INITIAL', 1000),
    backoffMaxMs: envInt('LLM_BACKOFF_MAX', 300000),
    backoffMultiplier: envInt('LLM_BACKOFF_MULTIPLIER', 2),
    backoffMaxAttempts: envInt('LLM_BACKOFF_MAX_ATTEMPTS', 5)
  },

  // -------------------------------------------------------------------------
  // Pending Actions (HITL confirmations, email replies)
  // -------------------------------------------------------------------------
  pendingActions: {
    confirmationTTLMs: envInt('PENDING_CONFIRMATION_TTL', 5 * 60 * 1000),  // 5 minutes
    emailReplyTTLMs: envInt('PENDING_EMAIL_REPLY_TTL', 30 * 60 * 1000),    // 30 minutes
    cleanupIntervalMs: envInt('PENDING_CLEANUP_INTERVAL', 5 * 60 * 1000)   // 5 minutes
  },

  // -------------------------------------------------------------------------
  // Default Ports
  // -------------------------------------------------------------------------
  ports: {
    imapDefault: 993,
    imapStarttls: 143,
    smtpDefault: 587,
    smtpTls: 465
  },

  // -------------------------------------------------------------------------
  // Cockpit (Deck as Control Plane)
  // -------------------------------------------------------------------------
  cockpit: {
    adminUser: envStr('ADMIN_USER', ''),
    boardTitle: envStr('COCKPIT_BOARD_TITLE', 'Moltagent Cockpit'),
    cacheTTLMs: envInt('COCKPIT_CACHE_TTL', 5 * 60 * 1000),  // 5 minutes
    enabled: envBool('COCKPIT_ENABLED', true)
  },

  // -------------------------------------------------------------------------
  // Memory Search
  // -------------------------------------------------------------------------
  memorySearch: {
    enabled: envBool('MEMORY_SEARCH_ENABLED', true),
    backend: envStr('MEMORY_SEARCH_BACKEND', 'keyword'),
  },

  // -------------------------------------------------------------------------
  // Room Monitor (instant welcome messages for new rooms)
  // -------------------------------------------------------------------------
  roomMonitor: {
    enabled: envBool('ROOM_MONITOR_ENABLED', true),
    intervalMs: envInt('ROOM_MONITOR_INTERVAL', 60000),           // 60 seconds
  },

  // -------------------------------------------------------------------------
  // NC Status Indicator
  // -------------------------------------------------------------------------
  statusIndicator: {
    enabled: envBool('STATUS_INDICATOR_ENABLED', true),
  },

  // -------------------------------------------------------------------------
  // Voice Pipeline (Whisper STT + call-aware routing)
  // -------------------------------------------------------------------------
  voice: {
    whisperUrl: envStr('WHISPER_URL', 'http://138.201.246.236:8014'),
    whisperTimeout: envInt('WHISPER_TIMEOUT', 60000),
    whisperModel: envStr('WHISPER_MODEL', 'small'),
    ffmpegPath: envStr('FFMPEG_PATH', 'ffmpeg'),
    enabled: envBool('VOICE_ENABLED', true),
    maxAudioDurationSec: envInt('VOICE_MAX_DURATION', 300),
    speachesUrl: envStr('SPEACHES_URL', 'http://138.201.246.236:8014'),
    speachesTimeout: envInt('SPEACHES_TIMEOUT', 30000),
    speachesSttModel: envStr('SPEACHES_STT_MODEL', 'Systran/faster-whisper-small'),
    speachesTtsModel: envStr('SPEACHES_TTS_MODEL', 'piper'),
    speachesTtsVoice: envStr('SPEACHES_TTS_VOICE', 'en_US-amy-medium'),
  },

  // -------------------------------------------------------------------------
  // Text Extraction & OCR
  // -------------------------------------------------------------------------
  extraction: {
    ocrEnabled: envBool('OCR_ENABLED', true),
    ocrLanguages: envStr('OCR_LANGUAGES', 'eng+deu+por'),
    ocrJobs: envInt('OCR_JOBS', 1),
    ocrTimeoutMs: envInt('OCR_TIMEOUT', 120000),
    charsPerPageThreshold: envInt('OCR_CHARS_THRESHOLD', 50)
  },

  // -------------------------------------------------------------------------
  // Infrastructure Monitor
  // -------------------------------------------------------------------------
  infra: {
    enabled: envBool('INFRA_MONITOR_ENABLED', true),
    checkInterval: envInt('INFRA_CHECK_INTERVAL', 3),          // Every Nth pulse (3 = ~15 min)
    probeTimeoutMs: envInt('INFRA_PROBE_TIMEOUT', 8000),       // Per-probe timeout
    selfHealEnabled: envBool('INFRA_SELF_HEAL', true),
    notifyOnFailure: envBool('INFRA_NOTIFY_ON_FAILURE', true),
    heald: {
      url: envStr('HEALD_URL', 'http://138.201.246.236:7867'),
      tokenCredential: envStr('HEALD_TOKEN_CREDENTIAL', 'heald-token'),
      timeoutMs: envInt('HEALD_TIMEOUT', 15000),
    },
  },

  // -------------------------------------------------------------------------
  // Debug Mode
  // -------------------------------------------------------------------------
  debugMode: envBool('DEBUG_MODE', false)
};

// Ensure security.allowedBackends includes nextcloud.url if empty
if (config.security.allowedBackends.length === 0) {
  config.security.allowedBackends.push(config.nextcloud.url);
}

// -----------------------------------------------------------------------------
// Freeze and Export
// -----------------------------------------------------------------------------

/**
 * Deep freeze an object to make it immutable
 * @param {Object} obj - Object to freeze
 * @returns {Object} Frozen object
 */
function deepFreeze(obj) {
  const propNames = Object.getOwnPropertyNames(obj);
  for (const name of propNames) {
    const value = obj[name];
    if (value && typeof value === 'object' && !Object.isFrozen(value)) {
      deepFreeze(value);
    }
  }
  return Object.freeze(obj);
}

// Export frozen config - immutable at runtime
module.exports = deepFreeze(config);
