#!/usr/bin/env node
/**
 * Integration tests for Credential Broker with other components
 */

const CredentialBroker = require('../../src/lib/credential-broker');
const DeckClient = require('../../src/lib/integrations/deck-client');
const CalDAVClient = require('../../src/lib/integrations/caldav-client');
const HeartbeatManager = require('../../src/lib/integrations/heartbeat-manager');

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    const result = fn();
    if (result === true || result === undefined) {
      console.log('  ✓ ' + name);
      passed++;
      return true;
    } else {
      console.log('  ✗ ' + name + ' (returned: ' + result + ')');
      failed++;
      return false;
    }
  } catch (err) {
    console.log('  ✗ ' + name + ' (error: ' + err.message + ')');
    failed++;
    return false;
  }
}

async function asyncTest(name, fn) {
  try {
    const result = await fn();
    if (result === true || result === undefined) {
      console.log('  ✓ ' + name);
      passed++;
      return true;
    } else {
      console.log('  ✗ ' + name + ' (returned: ' + result + ')');
      failed++;
      return false;
    }
  } catch (err) {
    console.log('  ✗ ' + name + ' (error: ' + err.message + ')');
    failed++;
    return false;
  }
}

async function runTests() {
  console.log('╔════════════════════════════════════════════════════════════════╗');
  console.log('║           Credential Broker Integration Tests                  ║');
  console.log('╚════════════════════════════════════════════════════════════════╝');
  console.log('');

  // Set up test environment
  process.env.NC_PASSWORD = 'test-integration-password';

  const credentialBroker = new CredentialBroker({
    ncUrl: 'https://test.example.com',
    ncUsername: 'moltagent',
    auditLog: async () => {}
  });

  console.log('═══════════════════════════════════════════════════════════════');
  console.log('TEST GROUP 1: DeckClient Integration');
  console.log('═══════════════════════════════════════════════════════════════');

  test('DeckClient accepts credential broker', () => {
    const client = new DeckClient({
      nextcloud: {
        url: 'https://test.example.com',
        username: 'moltagent'
      },
      credentialBroker: credentialBroker
    });
    return client.credentialBroker === credentialBroker;
  });

  test('DeckClient stores credential broker reference', () => {
    const client = new DeckClient({
      nextcloud: {
        url: 'https://test.example.com',
        username: 'moltagent'
      },
      credentialBroker: credentialBroker
    });

    // In new architecture, DeckClient uses NCRequestManager which handles credentials
    // This test validates the broker is stored for legacy compatibility
    return client.credentialBroker === credentialBroker;
  });

  test('DeckClient accepts string credential (legacy)', () => {
    const client = new DeckClient({
      nextcloud: {
        url: 'https://test.example.com',
        username: 'moltagent'
      },
      credentialBroker: 'direct-password-string'
    });

    // In new architecture, DeckClient uses NCRequestManager for credentials
    // This test validates legacy config is accepted without error
    return client.credentialBroker === 'direct-password-string';
  });

  console.log('');
  console.log('═══════════════════════════════════════════════════════════════');
  console.log('TEST GROUP 2: CalDAVClient Integration');
  console.log('═══════════════════════════════════════════════════════════════');

  test('CalDAVClient accepts credential broker', () => {
    const client = new CalDAVClient({
      ncUrl: 'https://test.example.com',
      username: 'moltagent',
      credentialBroker: credentialBroker
    });
    return client.credentialBroker === credentialBroker;
  });

  test('CalDAVClient stores credential broker reference', () => {
    const client = new CalDAVClient({
      ncUrl: 'https://test.example.com',
      username: 'moltagent',
      credentialBroker: credentialBroker
    });

    // In new architecture, CalDAVClient uses NCRequestManager which handles credentials
    // This test validates the broker is stored for legacy compatibility
    return client.credentialBroker === credentialBroker;
  });

  test('CalDAVClient accepts direct password (legacy)', () => {
    const client = new CalDAVClient({
      ncUrl: 'https://test.example.com',
      username: 'moltagent',
      password: 'legacy-direct-password'
    });

    // In new architecture, CalDAVClient uses NCRequestManager for credentials
    // This test validates legacy password config is accepted without error
    return client._directPassword === 'legacy-direct-password';
  });

  test('CalDAVClient accepts both broker and password', () => {
    const client = new CalDAVClient({
      ncUrl: 'https://test.example.com',
      username: 'moltagent',
      credentialBroker: credentialBroker,
      password: 'fallback-password'
    });

    // In new architecture, NCRequestManager handles credential precedence
    // This test validates both can be configured without error
    return client.credentialBroker === credentialBroker && client._directPassword === 'fallback-password';
  });

  console.log('');
  console.log('═══════════════════════════════════════════════════════════════');
  console.log('TEST GROUP 3: HeartbeatManager Integration');
  console.log('═══════════════════════════════════════════════════════════════');

  // Mock LLM Router
  const mockLLMRouter = {
    route: async () => ({ result: 'test' }),
    testConnection: async () => ({ connected: true, models: ['test'] })
  };

  test('HeartbeatManager accepts credential broker', () => {
    const manager = new HeartbeatManager({
      nextcloud: {
        url: 'https://test.example.com',
        username: 'moltagent'
      },
      credentialBroker: credentialBroker,
      deck: { boardId: 1 },
      heartbeat: { intervalMs: 60000 },
      llmRouter: mockLLMRouter,
      auditLog: async () => {}
    });
    return manager.credentialBroker === credentialBroker;
  });

  test('HeartbeatManager passes broker to DeckClient', () => {
    const manager = new HeartbeatManager({
      nextcloud: {
        url: 'https://test.example.com',
        username: 'moltagent'
      },
      credentialBroker: credentialBroker,
      deck: { boardId: 1 },
      heartbeat: { intervalMs: 60000 },
      llmRouter: mockLLMRouter,
      auditLog: async () => {}
    });
    return manager.deckClient.credentialBroker === credentialBroker;
  });

  test('HeartbeatManager passes broker to CalDAVClient', () => {
    const manager = new HeartbeatManager({
      nextcloud: {
        url: 'https://test.example.com',
        username: 'moltagent'
      },
      credentialBroker: credentialBroker,
      deck: { boardId: 1 },
      heartbeat: { intervalMs: 60000 },
      llmRouter: mockLLMRouter,
      auditLog: async () => {}
    });
    return manager.caldavClient.credentialBroker === credentialBroker;
  });

  console.log('');
  console.log('═══════════════════════════════════════════════════════════════');
  console.log('TEST GROUP 4: Credential Caching Across Components');
  console.log('═══════════════════════════════════════════════════════════════');

  test('Credential broker shared across multiple clients', () => {
    process.env.NC_PASSWORD = 'cache-test-password';
    const broker = new CredentialBroker({
      ncUrl: 'https://test.example.com',
      ncUsername: 'moltagent'
    });

    const client = new DeckClient({
      nextcloud: { url: 'https://test.example.com', username: 'moltagent' },
      credentialBroker: broker
    });

    // In new architecture, caching happens in CredentialCache, not in clients
    // This test validates broker reference is maintained
    return client.credentialBroker === broker;
  });

  test('Multiple clients share same broker instance', () => {
    process.env.NC_PASSWORD = 'shared-cache-password';
    const sharedBroker = new CredentialBroker({
      ncUrl: 'https://test.example.com',
      ncUsername: 'moltagent'
    });

    const deck = new DeckClient({
      nextcloud: { url: 'https://test.example.com', username: 'moltagent' },
      credentialBroker: sharedBroker
    });

    const caldav = new CalDAVClient({
      ncUrl: 'https://test.example.com',
      username: 'moltagent',
      credentialBroker: sharedBroker
    });

    // In new architecture, broker is shared and handles caching
    return deck.credentialBroker === sharedBroker && caldav.credentialBroker === sharedBroker;
  });

  console.log('');
  console.log('═══════════════════════════════════════════════════════════════');
  console.log('TEST GROUP 5: Security - Credential Discard');
  console.log('═══════════════════════════════════════════════════════════════');

  test('discardAll clears credentials from broker', () => {
    process.env.NC_PASSWORD = 'discard-test';
    const broker = new CredentialBroker({
      ncUrl: 'https://test.example.com',
      ncUsername: 'moltagent'
    });

    // Load credential
    broker.getNCPassword();

    // Discard
    broker.discardAll();

    // Should need to reload (env var still set)
    return broker._bootstrapLoaded === false;
  });

  test('Shutdown sequence clears all credentials', () => {
    process.env.NC_PASSWORD = 'shutdown-test';
    const broker = new CredentialBroker({
      ncUrl: 'https://test.example.com',
      ncUsername: 'moltagent'
    });

    // Simulate usage
    broker.getNCPassword();

    // Simulate shutdown
    broker.discardAll();

    // In new architecture, discardAll clears credentialCache and bootstrap
    return broker._bootstrapLoaded === false;
  });

  console.log('');
  console.log('═══════════════════════════════════════════════════════════════');
  console.log('TEST GROUP 6: bot.js Startup Simulation');
  console.log('═══════════════════════════════════════════════════════════════');

  test('Full startup flow simulation', () => {
    process.env.NC_PASSWORD = 'startup-test-password';

    // Simulate bot.js startup
    const broker = new CredentialBroker({
      ncUrl: 'https://test.example.com',
      ncUsername: 'moltagent',
      auditLog: async () => {}
    });

    // 1. Test bootstrap credential loads
    const ncPassword = broker.getNCPassword();
    if (ncPassword !== 'startup-test-password') return false;

    // 2. Create getter for LLM Router
    const getter = broker.createGetter();
    if (typeof getter !== 'function') return false;

    // 3. Initialize HeartbeatManager
    const manager = new HeartbeatManager({
      nextcloud: {
        url: 'https://test.example.com',
        username: 'moltagent'
      },
      credentialBroker: broker,
      deck: { boardId: 1 },
      heartbeat: { intervalMs: 60000 },
      llmRouter: mockLLMRouter,
      auditLog: async () => {}
    });

    // 4. Verify broker is passed through
    if (manager.credentialBroker !== broker) return false;
    if (manager.deckClient.credentialBroker !== broker) return false;
    if (manager.caldavClient.credentialBroker !== broker) return false;

    // 5. Simulate shutdown
    broker.discardAll();
    if (broker._bootstrapLoaded !== false) return false;

    return true;
  });

  // Clean up
  delete process.env.NC_PASSWORD;

  // Summary
  console.log('');
  console.log('═══════════════════════════════════════════════════════════════');
  if (failed === 0) {
    console.log('RESULTS: ' + passed + ' passed, ' + failed + ' failed ✓');
  } else {
    console.log('RESULTS: ' + passed + ' passed, ' + failed + ' failed ✗');
  }
  console.log('═══════════════════════════════════════════════════════════════');

  process.exit(failed > 0 ? 1 : 0);
}

runTests().catch(err => {
  console.error('Test error:', err);
  process.exit(1);
});
