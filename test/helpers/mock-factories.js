/**
 * Mock factory functions for common dependencies
 */

// Audit Log Mock
function createMockAuditLog() {
  const calls = [];
  const auditLog = async (event, data) => {
    calls.push({ event, data, timestamp: Date.now() });
  };
  auditLog.getCalls = () => calls;
  auditLog.reset = () => { calls.length = 0; };
  auditLog.getCallsFor = (event) => calls.filter(c => c.event === event);
  return auditLog;
}

// Credential Broker Mock
function createMockCredentialBroker(credentials = {}) {
  return {
    get: async (name) => credentials[name] || null,
    getNCPassword: () => credentials['nc-password'] || 'test-password',
    prefetchAll: async (names) => {},
    discardAll: () => {}
  };
}

// LLM Router Mock
function createMockLLMRouter(responses = {}) {
  return {
    route: async ({ task, content, requirements }) => {
      if (responses[task]) {
        return typeof responses[task] === 'function'
          ? responses[task](content, requirements)
          : responses[task];
      }
      return { result: 'Mock LLM response', provider: 'mock', tokens: 100 };
    },
    testConnections: async () => ({ 'mock': { connected: true } }),
    getStats: () => ({ totalCalls: 0 })
  };
}

// NC Request Manager Mock
function createMockNCRequestManager(responses = {}) {
  return {
    ncUrl: 'https://cloud.example.com',
    ncUser: 'testuser',
    request: async (path, options = {}) => {
      const key = `${options.method || 'GET'}:${path}`;
      if (responses[key]) {
        return typeof responses[key] === 'function'
          ? responses[key](path, options)
          : responses[key];
      }
      return { status: 200, body: {}, headers: {} };
    },
    getUserEmail: async (userId) => {
      if (responses.userEmails && responses.userEmails[userId]) {
        return responses.userEmails[userId];
      }
      return `${userId}@example.com`;
    },
    getMetrics: () => ({ totalRequests: 0, cacheHits: 0 }),
    invalidateCache: () => {},
    shutdown: async () => {}
  };
}

// Calendar Handler Mock
function createMockCalendarHandler(responses = {}) {
  return {
    handle: async (message) => responses.handle || { message: 'Calendar response' },
    confirmCreateEvent: async (data, user) => responses.confirmCreateEvent || { message: 'Event created' }
  };
}

// Email Handler Mock
function createMockEmailHandler(responses = {}) {
  return {
    handle: async (message, user, context) => responses.handle || { message: 'Email response' },
    confirmSendEmail: async (draft, user) => responses.confirmSendEmail || { message: 'Email sent' }
  };
}

// Notify User Mock
function createMockNotifyUser() {
  const notifications = [];
  const notifyUser = async (notification) => {
    notifications.push({ ...notification, timestamp: Date.now() });
  };
  notifyUser.getNotifications = () => notifications;
  notifyUser.reset = () => { notifications.length = 0; };
  return notifyUser;
}

// CalDAV Client Mock (for CalendarHandler tests)
function createMockCalDAVClient(responses = {}) {
  return {
    getTodaySummary: async () => responses.todaySummary || {
      text: 'No events today.',
      events: []
    },
    getEventCalendars: async () => responses.eventCalendars || [
      { id: 'personal', displayName: 'Personal', supportsEvents: true }
    ],
    getEvents: async (calId, start, end) => responses.events || [],
    getUpcomingEvents: async (hours) => responses.upcomingEvents || [],
    createEvent: async (eventData) => responses.createEvent || {
      uid: 'test-uid-' + Date.now(),
      summary: eventData.summary
    },
    checkAvailability: async (start, end, calId) => responses.availability || {
      isFree: true,
      conflicts: []
    },
    findFreeSlots: async (start, end, duration, options) => responses.freeSlots || [],
    amIFreeAt: async (time) => responses.isFree !== undefined ? responses.isFree : true,
    getCalendars: async () => responses.calendars || [],
    getCalendar: async (id) => responses.calendar || { id, displayName: 'Test' },
    deleteEvent: async (calId, uid) => responses.deleteEvent || { success: true },
    updateEvent: async (calId, uid, data) => responses.updateEvent || { uid, ...data },
    getEvent: async (calId, uid) => {
      if (responses.getEvent === null) return null;
      if (typeof responses.getEvent === 'function') return responses.getEvent(calId, uid);
      return responses.getEvent || null;
    }
  };
}

// SecurityInterceptor Mock (for handler tests)
function createMockSecurityInterceptor(overrides = {}) {
  return {
    beforeExecute: async (operation, params, context) => {
      if (overrides.beforeExecute) {
        return typeof overrides.beforeExecute === 'function'
          ? overrides.beforeExecute(operation, params, context)
          : overrides.beforeExecute;
      }
      return {
        proceed: true,
        decision: 'ALLOW',
        reason: null,
        modifiedParams: { ...params },
        approvalRequired: false,
        approvalPrompt: null,
        routeToLocal: false,
        session: {},
        guardResults: { tools: null, prompt: null, secrets: null, paths: null, egress: null }
      };
    },
    afterExecute: async (operation, response, context) => {
      if (overrides.afterExecute) {
        return typeof overrides.afterExecute === 'function'
          ? overrides.afterExecute(operation, response, context)
          : overrides.afterExecute;
      }
      return {
        response,
        sanitized: false,
        warnings: [],
        blocked: false,
        reason: null
      };
    },
    handleApproval: (context, operation, params, approved) => ({
      success: true,
      canProceed: approved,
      message: approved ? 'Approved' : 'Denied'
    }),
    getStatus: () => ({ activeSessions: 0, pendingApprovals: 0, blockedToday: 0, lastMemoryScan: null })
  };
}

// CollectivesClient Mock (for wiki tool tests)
function createMockCollectivesClient(responses = {}) {
  return {
    resolveCollective: async () => responses.resolveCollective || 10,
    listCollectives: async () => responses.listCollectives || [{ id: 10, name: 'Moltagent Knowledge' }],
    getCollective: async (name) => responses.getCollective || { id: 10, name },
    listPages: async () => responses.listPages || [],
    getPage: async (cId, pageId) => responses.getPage || { id: pageId, title: 'Test' },
    createPage: async (cId, parentId, title) => responses.createPage || { id: 500, title },
    searchPages: async (cId, query) => responses.searchPages || [],
    readPageContent: async (path) => responses.readPageContent || '',
    writePageContent: async (path, content) => responses.writePageContent || undefined,
    touchPage: async () => {},
    findPageByTitle: async (title) => {
      if (responses.findPageByTitle === null) return null;
      return responses.findPageByTitle || null;
    },
    readPageWithFrontmatter: async (title) => {
      if (responses.readPageWithFrontmatter === null) return null;
      return responses.readPageWithFrontmatter || null;
    },
    writePageWithFrontmatter: async (title, fm, body) => responses.writePageWithFrontmatter || 'Test/Readme.md',
    resolveWikilinks: async (content) => responses.resolveWikilinks !== undefined ? responses.resolveWikilinks : content,
    collectiveName: 'Moltagent Knowledge'
  };
}

// SearXNG Client Mock
function createMockSearXNGClient(responses = {}) {
  return {
    search: async (query) => responses.search || { results: [], query, total: 0 },
    healthCheck: async () => responses.health || { ok: true, latencyMs: 50 }
  };
}

// WebReader Mock
function createMockWebReader(responses = {}) {
  return {
    read: async (url) => responses.read || {
      title: 'Test',
      content: 'Test content',
      url,
      extractedAt: new Date().toISOString(),
      bytesFetched: 100,
      truncated: false
    },
    clearCache: () => {}
  };
}

// ContactsClient Mock
function createMockContactsClient(responses = {}) {
  return {
    search: async (query) => responses.search || [],
    get: async (href) => responses.get || null,
    resolve: async (name) => responses.resolve || { resolved: false, error: 'no_match' },
    fetchAll: async () => responses.fetchAll || [],
    invalidateCache: () => {},
    _ensurePeoplePage: async () => {}
  };
}

// RSVPTracker Mock
function createMockRSVPTracker(responses = {}) {
  const pendingEvents = new Map();
  return {
    trackEvent: (uid, calId, attendees, summary, eventEnd) => {
      pendingEvents.set(uid, { uid, calendarId: calId, attendees, summary, eventEnd });
    },
    untrackEvent: (uid) => pendingEvents.delete(uid),
    checkUpdates: async () => responses.checkUpdates || { checked: 0, changes: 0, expired: 0, errors: [] },
    getStatus: (uid) => {
      const tracked = pendingEvents.get(uid);
      return tracked ? { found: true, ...tracked } : { found: false };
    },
    getPendingSummary: () => responses.pendingSummary || [],
    get trackedCount() { return pendingEvents.size; },
    pendingEvents
  };
}

// CockpitManager Mock
function createMockCockpitManager(responses = {}) {
  const defaultConfig = {
    style: { name: 'Concise Executive', description: 'Short, answer-first, data-driven.' },
    persona: {
      name: 'Molti',
      humor: 'light',
      emoji: 'none',
      language: 'EN',
      verbosity: 'concise',
      formality: 'balanced'
    },
    guardrails: [
      { title: 'Never delete files without asking', description: 'Always require explicit user confirmation.' }
    ],
    mode: { name: 'Full Auto', description: 'Maximum initiative.' },
    system: {
      searchProvider: 'searxng',
      llmTier: 'balanced',
      dailyDigest: '08:00',
      autoTagFiles: true,
      initiativeLevel: 2,
      workingHours: '08:00-18:00'
    }
  };

  const config = responses.config || defaultConfig;

  return {
    initialize: async () => responses.initialize || undefined,
    bootstrap: async () => responses.bootstrap || { boardId: 99, stacks: {}, labels: {} },
    readConfig: async () => responses.readConfig || config,
    getActiveStyle: async () => responses.getActiveStyle || config.style,
    getGuardrails: async () => responses.getGuardrails || config.guardrails,
    getActiveMode: async () => responses.getActiveMode || config.mode,
    getPersona: async () => responses.getPersona || config.persona,
    getSystemSettings: async () => responses.getSystemSettings || config.system,
    updateStatus: async (statusData) => responses.updateStatus || undefined,
    buildSystemPromptOverlay: () => {
      if (responses.buildSystemPromptOverlay !== undefined) return responses.buildSystemPromptOverlay;
      return '## Active Configuration (from Cockpit)\n\n### Communication Style: Concise Executive\nShort, answer-first.';
    },
    boardId: responses.boardId || 99,
    cachedConfig: config,
    _initialized: true
  };
}

// BudgetEnforcer Mock
function createMockBudgetEnforcer(overrides = {}) {
  return {
    canSpend: (providerId, cost) => overrides.canSpend || { allowed: true },
    recordSpend: (providerId, cost, tokens) => {},
    canSpendProactive: (cost) => overrides.canSpendProactive || { allowed: true },
    recordProactiveSpend: (cost, tokens) => {},
    classifyOperation: (ctx) => overrides.classifyOperation || 'reactive',
    isProactiveBudgetExhausted: () => overrides.exhausted || false,
    getFullReport: () => overrides.fullReport || {
      date: '2026-02-10',
      month: '2026-02',
      providers: {},
      proactive: { dailyCost: 0, dailyCalls: 0, dailyBudget: 0.50, exhausted: false }
    },
    getUsageSummary: (id) => null,
    exportUsage: () => ({})
  };
}

// MeetingPreparer Mock
function createMockMeetingPreparer(overrides = {}) {
  return {
    checkAndPrep: async () => overrides.checkAndPrep || { checked: 0, prepped: 0 },
    resetDaily: () => {},
    preparedMeetings: new Set()
  };
}

// DailyDigester Mock
function createMockDailyDigester(overrides = {}) {
  return {
    maybeSendDigest: async () => overrides.maybeSendDigest || { sent: false, reason: 'too_early' },
    lastDigestDate: null
  };
}

// FreshnessChecker (heartbeat-intelligence variant) Mock
function createMockHeartbeatFreshnessChecker(overrides = {}) {
  return {
    maybeCheck: async () => overrides.maybeCheck || { checked: false },
    checkAll: async () => overrides.checkAll || { checked: 0, flagged: 0 },
    lastCheckDate: null
  };
}

// BotEnroller Mock
function createMockBotEnroller(overrides = {}) {
  const enrolledRooms = new Set();
  return {
    enrollAll: async () => overrides.enrollAll || { checked: 0, enrolled: 0, skipped: 0, errors: [] },
    resetCache: () => { enrolledRooms.clear(); },
    get botId() { return overrides.botId || null; },
    get enrolledCount() { return enrolledRooms.size; }
  };
}

// InfraMonitor Mock
function createMockInfraMonitor(overrides = {}) {
  return {
    shouldCheck: (pulseCount) => overrides.shouldCheck !== undefined ? overrides.shouldCheck : (pulseCount % 3 === 0),
    checkAll: async () => overrides.checkAll || {
      timestamp: new Date().toISOString(),
      services: { ollama: { ok: true, latencyMs: 50, status: 'up' } },
      transitions: [],
      selfHealAttempts: [],
      systemStats: { ramUsedPct: 45, diskUsedPct: 60, uptimeDays: 5 },
      ollamaStats: null,
      overall: 'ok'
    },
    getSummary: () => overrides.getSummary || { services: {}, systemStats: null, overall: 'unknown' },
    checkInterval: overrides.checkInterval || 3
  };
}

// NCFilesClient Mock (in-memory file store)
function createMockNCFilesClient(overrides = {}) {
  const store = overrides._store || {};
  return {
    readFile: overrides.readFile || (async (filePath) => {
      if (store[filePath] !== undefined) {
        return { content: store[filePath], truncated: false, totalSize: store[filePath].length };
      }
      const err = new Error('File not found');
      err.statusCode = 404;
      throw err;
    }),
    writeFile: overrides.writeFile || (async (filePath, content) => {
      store[filePath] = content;
      return { success: true };
    }),
    mkdir: overrides.mkdir || (async () => ({ success: true })),
    listDirectory: overrides.listDirectory || (async () => []),
    _store: store,
    ...overrides
  };
}

// WarmMemory Mock
function createMockWarmMemory(overrides = {}) {
  let content = overrides.content || '# Working Memory\n\n## Where We Left Off\nNo previous sessions yet.\n\n## Open Items\nNo open items.\n\n## Key Context\nNo context recorded yet.';
  return {
    load: overrides.load || (async () => content),
    save: overrides.save || (async (c) => { content = c; }),
    consolidate: overrides.consolidate || (async () => content),
    invalidateCache: overrides.invalidateCache || (() => {}),
    ...overrides
  };
}

// NCSearchClient Mock (for MemorySearcher / Unified Search tests)
function createMockNCSearchClient(overrides = {}) {
  const defaultProviders = [
    { id: 'collectives_pages', name: 'Collectives Pages' },
    { id: 'collectives_pages_content', name: 'Collectives Page Content' },
    { id: 'talk-message', name: 'Talk Messages' },
    { id: 'files', name: 'Files' },
    { id: 'deck', name: 'Deck' },
    { id: 'calendar', name: 'Calendar' },
  ];
  return {
    getProviders: overrides.getProviders || (async () => overrides.providers || defaultProviders),
    searchProvider: overrides.searchProvider || (async (providerId, term, limit, options) => {
      if (overrides.searchResults && overrides.searchResults[providerId]) {
        return overrides.searchResults[providerId];
      }
      return [];
    }),
    search: overrides.search || (async (term, providerIds, limit) => []),
    _providersCache: null,
    _providersCacheExpiry: 0
  };
}

// ModelScout Mock
function createMockModelScout(overrides = {}) {
  return {
    discover: overrides.discover || (async () => overrides.discovered || []),
    generateLocalRoster: overrides.generateLocalRoster || (() => overrides.roster || null),
    getSummary: overrides.getSummary || (() => 'Mock fleet summary'),
    hasModel: overrides.hasModel || (() => false),
    _discovered: overrides.discovered || null,
    _roster: overrides.roster || null
  };
}

// MicroPipeline Mock
function createMockMicroPipeline(overrides = {}) {
  return {
    process: overrides.process || (async (message) => overrides.response || 'Mock micro-pipeline response'),
    getStats: overrides.getStats || (() => ({ processed: 0, byIntent: {}, deferred: 0, errors: 0 }))
  };
}

// DeferralQueue Mock
function createMockDeferralQueue(overrides = {}) {
  const tasks = [];
  return {
    enqueue: overrides.enqueue || (async (task) => { tasks.push(task); }),
    processNext: overrides.processNext || (async () => ({ processed: 0, skipped: 0, errors: [] })),
    load: overrides.load || (async () => {}),
    getStatus: overrides.getStatus || (() => ({ total: tasks.length, queued: tasks.length, processing: 0, done: 0, failed: 0, stats: { enqueued: tasks.length, processed: 0, failed: 0 } })),
    _queue: tasks
  };
}

module.exports = {
  createMockAuditLog,
  createMockCredentialBroker,
  createMockLLMRouter,
  createMockNCRequestManager,
  createMockCalendarHandler,
  createMockEmailHandler,
  createMockNotifyUser,
  createMockCalDAVClient,
  createMockSecurityInterceptor,
  createMockCollectivesClient,
  createMockSearXNGClient,
  createMockWebReader,
  createMockContactsClient,
  createMockRSVPTracker,
  createMockCockpitManager,
  createMockBudgetEnforcer,
  createMockMeetingPreparer,
  createMockDailyDigester,
  createMockHeartbeatFreshnessChecker,
  createMockBotEnroller,
  createMockInfraMonitor,
  createMockNCFilesClient,
  createMockWarmMemory,
  createMockNCSearchClient,
  createMockModelScout,
  createMockMicroPipeline,
  createMockDeferralQueue
};
