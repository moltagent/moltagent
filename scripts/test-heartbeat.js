#!/usr/bin/env node

/**
 * Moltagent Heartbeat Integration Tests
 * 
 * Tests the heartbeat manager with Deck and CalDAV integration
 * 
 * Usage: node scripts/test-heartbeat.js
 */

const HeartbeatManager = require('../src/lib/integrations/heartbeat-manager');

// Configuration
const config = {
  nextcloud: {
    url: process.env.NC_URL || 'https://YOUR_NEXTCLOUD_URL',
    username: process.env.NC_USER || 'moltagent',
    password: process.env.MOLTAGENT_PASSWORD || 'CHANGE_ME'
  },
  deck: {
    boardId: 8,
    stacks: {
      inbox: 20,
      queued: 23,
      working: 26,
      done: 29,
      reference: 32
    }
  },
  heartbeat: {
    intervalMs: 60000, // 1 minute for testing
    deckEnabled: true,
    caldavEnabled: true,
    maxTasksPerCycle: 2,
    calendarLookaheadMinutes: 60,
    notifyUpcomingMeetings: true
  }
};

// Mock LLM router for testing
const mockLLMRouter = {
  async route(task, content, requirements) {
    console.log(`    [Mock LLM] Task: ${task.type || 'unknown'}`);
    return {
      result: `Mock response for: ${content.substring(0, 50)}...`,
      provider: 'mock'
    };
  }
};

// Track notifications
const notifications = [];
const auditLogs = [];

const heartbeat = new HeartbeatManager({
  ...config,
  llmRouter: mockLLMRouter,
  notifyUser: async (notification) => {
    console.log(`    [NOTIFY] ${notification.type}: ${notification.message?.substring(0, 50)}...`);
    notifications.push(notification);
  },
  auditLog: async (event, data) => {
    auditLogs.push({ event, data, timestamp: new Date() });
  }
});

async function runTests() {
  console.log('╔════════════════════════════════════════════════════════════════╗');
  console.log('║          Moltagent Heartbeat Integration Tests                 ║');
  console.log('╚════════════════════════════════════════════════════════════════╝');
  console.log('');
  console.log(`NC URL: ${config.nextcloud.url}`);
  console.log(`User: ${config.nextcloud.username}`);
  console.log('');

  let passed = 0;
  let failed = 0;

  async function test(name, fn) {
    process.stdout.write(`  ${name}... `);
    try {
      await fn();
      console.log('✓');
      passed++;
    } catch (err) {
      console.log(`✗ (${err.message})`);
      failed++;
    }
  }

  // ============================================================
  // Initialization Tests
  // ============================================================
  console.log('┌────────────────────────────────────────────────────────────────┐');
  console.log('│ Initialization                                                 │');
  console.log('└────────────────────────────────────────────────────────────────┘');

  await test('Heartbeat manager created', async () => {
    if (!heartbeat) throw new Error('Manager not created');
  });

  await test('Initial status is not running', async () => {
    const status = heartbeat.getStatus();
    if (status.isRunning) throw new Error('Should not be running initially');
  });

  // ============================================================
  // Single Pulse Test
  // ============================================================
  console.log('');
  console.log('┌────────────────────────────────────────────────────────────────┐');
  console.log('│ Single Pulse (Manual Trigger)                                  │');
  console.log('└────────────────────────────────────────────────────────────────┘');

  await test('Force single pulse', async () => {
    const result = await heartbeat.forcePulse();
    
    console.log('');
    console.log('    Pulse Results:');
    console.log(`    - Deck tasks processed: ${result.deck?.processed || 0}`);
    console.log(`    - Deck tasks queued: ${result.deck?.queued || 0}`);
    console.log(`    - Calendar events upcoming: ${result.calendar?.upcoming?.length || 0}`);
    console.log(`    - Errors: ${result.errors?.length || 0}`);
    
    if (result.errors && result.errors.length > 0) {
      console.log('    - Error details:');
      result.errors.forEach(e => console.log(`      ${e.component}: ${e.error}`));
    }
  });

  await test('Status updated after pulse', async () => {
    const status = heartbeat.getStatus();
    if (!status.lastRun) throw new Error('lastRun not updated');
  });

  // ============================================================
  // Context Retrieval
  // ============================================================
  console.log('');
  console.log('┌────────────────────────────────────────────────────────────────┐');
  console.log('│ Heartbeat Context                                              │');
  console.log('└────────────────────────────────────────────────────────────────┘');

  await test('Get heartbeat context', async () => {
    const context = await heartbeat.getHeartbeatContext();
    
    console.log('');
    console.log('    Context:');
    console.log(`    - Calendar: ${context.calendar?.summary?.split('\n')[0] || context.calendar?.error || 'N/A'}`);
    console.log(`    - Deck inbox: ${context.deck?.inboxCount ?? context.deck?.error ?? 'N/A'} cards`);
    console.log(`    - Urgent tasks: ${context.deck?.urgentCount ?? 0}`);
    
    if (!context.timestamp) throw new Error('Context missing timestamp');
  });

  // ============================================================
  // Start/Stop Test
  // ============================================================
  console.log('');
  console.log('┌────────────────────────────────────────────────────────────────┐');
  console.log('│ Start/Stop Cycle                                               │');
  console.log('└────────────────────────────────────────────────────────────────┘');

  await test('Start heartbeat', async () => {
    await heartbeat.start();
    const status = heartbeat.getStatus();
    if (!status.isRunning) throw new Error('Should be running');
  });

  await test('Stop heartbeat', async () => {
    await heartbeat.stop();
    const status = heartbeat.getStatus();
    if (status.isRunning) throw new Error('Should not be running');
  });

  // ============================================================
  // Audit Logs
  // ============================================================
  console.log('');
  console.log('┌────────────────────────────────────────────────────────────────┐');
  console.log('│ Audit Trail                                                    │');
  console.log('└────────────────────────────────────────────────────────────────┘');

  await test('Audit logs recorded', async () => {
    if (auditLogs.length === 0) throw new Error('No audit logs recorded');
    console.log(`\n    ${auditLogs.length} audit entries recorded:`);
    auditLogs.slice(-5).forEach(log => {
      console.log(`    - ${log.event}`);
    });
  });

  // ============================================================
  // Summary
  // ============================================================
  console.log('');
  console.log('════════════════════════════════════════════════════════════════');
  console.log(`  Results: ${passed} passed, ${failed} failed`);
  console.log('════════════════════════════════════════════════════════════════');

  if (notifications.length > 0) {
    console.log('');
    console.log(`  Notifications sent: ${notifications.length}`);
    notifications.forEach(n => {
      console.log(`    - [${n.type}] ${n.message?.substring(0, 50)}...`);
    });
  }

  console.log('');
  return failed === 0;
}

// Run tests
runTests()
  .then(success => {
    process.exit(success ? 0 : 1);
  })
  .catch(err => {
    console.error('Test suite error:', err);
    process.exit(1);
  });
