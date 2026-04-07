#!/usr/bin/env node
/**
 * Moltagent Integrated Test
 * Tests the full pipeline: Router + Credential Broker + LLM Providers
 */

const LLMRouter = require('./lib/router');
const CredentialBroker = require('./lib/credential-broker');
const config = require('./config/providers.json');

// NC Configuration
const ncConfig = {
  ncUrl: process.env.NC_URL || 'https://YOUR_NEXTCLOUD_URL',
  username: process.env.NC_USER || 'moltagent',
  password: process.env.NC_PASSWORD
};

async function main() {
  console.log('=== Moltagent Integrated Test ===\n');

  if (!ncConfig.password) {
    console.log('ERROR: Set NC_PASSWORD environment variable');
    console.log('Usage: NC_PASSWORD=yourpassword node test-integrated.js');
    process.exit(1);
  }

  // Initialize credential broker
  console.log('1. Initializing Credential Broker...');
  const broker = new CredentialBroker(ncConfig);
  
  // Verify credentials are available
  const labels = await broker.listLabels();
  console.log('   Available credentials:', labels);
  console.log();

  // Initialize router with broker
  console.log('2. Initializing Router with Credential Broker...');
  const router = new LLMRouter(config, broker);
  console.log('   Router initialized with providers:', Object.keys(router.providers));
  console.log();

  // Test 1: Ollama (no credentials needed)
  console.log('3. Testing Ollama (local, no credentials)...');
  const ollamaResult = await router.route(
    'test',
    'Reply with exactly one word: "Hello"',
    { role: 'sovereign', maxTokens: 20 }
  );
  if (ollamaResult.success) {
    console.log('   ✓ Provider:', ollamaResult.provider);
    console.log('   ✓ Response:', ollamaResult.content.trim().substring(0, 50));
  } else {
    console.log('   ✗ Failed:', ollamaResult.error);
  }
  console.log();

  // Test 2: DeepSeek (requires API key from NC Passwords)
  console.log('4. Testing DeepSeek (API key from NC Passwords)...');
  try {
    const deepseekResult = await router.route(
      'test',
      'Reply with exactly one word: "Working"',
      { role: 'value', maxTokens: 20 }
    );
    if (deepseekResult.success) {
      console.log('   ✓ Provider:', deepseekResult.provider);
      console.log('   ✓ Response:', deepseekResult.content.trim().substring(0, 50));
      console.log('   ✓ Cost: $' + (deepseekResult.cost || 0).toFixed(6));
    } else {
      console.log('   ✗ Failed:', deepseekResult.error);
      if (deepseekResult.failoverPath) {
        console.log('   Failover attempted:', deepseekResult.failoverPath);
      }
    }
  } catch (error) {
    console.log('   ✗ Error:', error.message);
  }
  console.log();

  // Test 3: Claude (requires API key from NC Passwords)
  console.log('5. Testing Claude (API key from NC Passwords)...');
  try {
    const claudeResult = await router.route(
      'test',
      'Reply with exactly one word: "Success"',
      { role: 'premium', maxTokens: 20 }
    );
    if (claudeResult.success) {
      console.log('   ✓ Provider:', claudeResult.provider);
      console.log('   ✓ Response:', claudeResult.content.trim().substring(0, 50));
      console.log('   ✓ Cost: $' + (claudeResult.cost || 0).toFixed(6));
    } else {
      console.log('   ✗ Failed:', claudeResult.error);
      if (claudeResult.failoverPath) {
        console.log('   Failover attempted:', claudeResult.failoverPath);
      }
    }
  } catch (error) {
    console.log('   ✗ Error:', error.message);
  }
  console.log();

  // Test 4: Security routing - credential in content should go to Ollama only
  console.log('6. Testing Security Routing (credential detection)...');
  const securityResult = await router.route(
    'analyze',
    'My api_key is sk-1234567890abcdef, is it secure?',
    { maxTokens: 50 }
  );
  console.log('   Content contains "api_key" - should route to Ollama only');
  console.log('   ✓ Provider used:', securityResult.provider);
  console.log('   ✓ Correct routing:', securityResult.provider === 'ollama' ? 'YES' : 'NO - SECURITY ISSUE!');
  console.log();

  // Summary
  console.log('7. Final Status:');
  console.log(JSON.stringify(router.getStatus(), null, 2));
  console.log();

  console.log('8. Credential Access Log:');
  const accessLog = broker.getAccessLog(10);
  for (const entry of accessLog) {
    console.log(`   ${entry.timestamp} | ${entry.success ? '✓' : '✗'} | ${entry.label}`);
  }
  console.log();

  console.log('=== Tests Complete ===');
}

main().catch(console.error);
