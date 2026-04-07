#!/usr/bin/env node
/**
 * MoltAgent Credential Broker Test
 */

const CredentialBroker = require('./lib/credential-broker');

// Configuration - UPDATE THESE VALUES
const config = {
  ncUrl: process.env.NC_URL || 'https://YOUR_NEXTCLOUD_URL',
  username: process.env.NC_USER || 'moltagent',
  password: process.env.NC_PASSWORD || 'YOUR_NC_PASSWORD_HERE'
};

async function main() {
  console.log('=== MoltAgent Credential Broker Test ===\n');

  // Check if password is set
  if (config.password === 'YOUR_NC_PASSWORD_HERE') {
    console.log('ERROR: Set NC_PASSWORD environment variable or edit this file');
    console.log('Usage: NC_PASSWORD=yourpassword node test-broker.js');
    process.exit(1);
  }

  const broker = new CredentialBroker(config);

  // Test 1: List available credentials
  console.log('1. Listing available credentials...');
  try {
    const labels = await broker.listLabels();
    console.log('   Available credentials:', labels);
  } catch (error) {
    console.log('   ERROR:', error.message);
  }
  console.log();

  // Test 2: Check broker status
  console.log('2. Broker Status:');
  console.log(JSON.stringify(broker.getStatus(), null, 2));
  console.log();

  // Test 3: Check if test-credential exists
  console.log('3. Checking if "test-credential" exists...');
  try {
    const exists = await broker.exists('test-credential');
    console.log('   Exists:', exists);
  } catch (error) {
    console.log('   ERROR:', error.message);
  }
  console.log();

  // Test 4: Fetch the test credential
  console.log('4. Fetching "test-credential"...');
  try {
    const secret = await broker.get('test-credential');
    console.log('   Retrieved secret:', secret.substring(0, 3) + '***');  // Only show first 3 chars
    console.log('   (Full value retrieved but not displayed for security)');
  } catch (error) {
    console.log('   ERROR:', error.message);
  }
  console.log();

  // Test 5: Try to fetch non-existent credential
  console.log('5. Fetching non-existent credential...');
  try {
    await broker.get('does-not-exist');
  } catch (error) {
    console.log('   Expected error:', error.message);
  }
  console.log();

  // Test 6: Access log
  console.log('6. Access Log:');
  const log = broker.getAccessLog(10);
  for (const entry of log) {
    console.log(`   ${entry.timestamp} | ${entry.success ? '✓' : '✗'} | ${entry.label} | ${entry.reason}`);
  }
  console.log();

  console.log('=== Tests Complete ===');
}

main().catch(console.error);
