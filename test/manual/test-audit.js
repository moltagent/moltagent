#!/usr/bin/env node
/**
 * Moltagent Audit Logger Test
 */

const AuditLogger = require('./lib/audit-logger');

const config = {
  ncUrl: process.env.NC_URL || 'https://YOUR_NEXTCLOUD_URL',
  username: process.env.NC_USER || 'moltagent',
  password: process.env.NC_PASSWORD,
  logPath: '/Logs',
  flushInterval: 2000,  // 2 seconds for testing
  maxBufferSize: 5
};

async function main() {
  console.log('=== Moltagent Audit Logger Test ===\n');

  if (!config.password) {
    console.log('ERROR: Set NC_PASSWORD environment variable');
    process.exit(1);
  }

  const logger = new AuditLogger(config);

  // Test 1: Ensure log directory exists
  console.log('1. Ensuring log directory exists...');
  try {
    await logger.ensureLogDirectory();
    console.log('   ✓ Log directory ready:', config.logPath);
  } catch (error) {
    console.log('   ✗ Error:', error.message);
  }
  console.log();

  // Test 2: Log various events
  console.log('2. Logging test events...');
  
  await logger.log('test_event', { message: 'Hello from test script' });
  console.log('   ✓ Logged: test_event');
  
  await logger.logCredentialAccess('claude-api-key', true);
  console.log('   ✓ Logged: credential_access');
  
  await logger.logLLMRequest('ollama', 'test', 150, 0, true);
  console.log('   ✓ Logged: llm_request (ollama)');
  
  await logger.logLLMRequest('claude', 'chat', 500, 0.0012, true);
  console.log('   ✓ Logged: llm_request (claude)');
  
  await logger.logSecurityEvent('credential_detected', { 
    action: 'routed_to_local',
    pattern: 'api_key'
  });
  console.log('   ✓ Logged: security event');
  
  await logger.logBudgetEvent('claude', 0.50, 2.00, 'warning');
  console.log('   ✓ Logged: budget event');
  console.log();

  // Test 3: Force flush
  console.log('3. Flushing logs to NC Files...');
  await logger.flush();
  console.log('   ✓ Logs flushed');
  console.log();

  // Wait a moment for write to complete
  await new Promise(r => setTimeout(r, 1000));

  // Test 4: Read back logs
  console.log('4. Reading logs back from NC Files...');
  try {
    const logs = await logger.getRecentLogs(1);
    console.log('   ✓ Retrieved', logs.length, 'log entries');
    console.log('   Recent entries:');
    logs.slice(-5).forEach(entry => {
      console.log(`     - ${entry.timestamp} | ${entry.event}`);
    });
  } catch (error) {
    console.log('   ✗ Error reading logs:', error.message);
  }
  console.log();

  // Test 5: Get summary
  console.log('5. Getting log summary...');
  try {
    const summary = await logger.getSummary(1);
    console.log('   Summary:', JSON.stringify(summary, null, 2));
  } catch (error) {
    console.log('   ✗ Error:', error.message);
  }
  console.log();

  // Shutdown
  await logger.shutdown();
  console.log('=== Tests Complete ===');
}

main().catch(console.error);
