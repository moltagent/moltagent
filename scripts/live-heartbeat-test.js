#!/usr/bin/env node
/**
 * Live Heartbeat Test - REAL LLM Processing
 * 
 * Runs a single heartbeat pulse with REAL Ollama calls.
 * Use this to test without starting the full bot.
 */

const HeartbeatManager = require('../src/lib/integrations/heartbeat-manager');
const LLMRouter = require('../src/lib/llm-router');

const CONFIG = {
  nextcloud: {
    url: 'https://YOUR_NEXTCLOUD_URL',
    username: 'moltagent',
    password: process.env.MOLTAGENT_PASSWORD || 'CHANGE_ME'
  },
  ollama: {
    url: process.env.OLLAMA_URL || 'http://YOUR_OLLAMA_IP:11434',
    model: 'qwen3:8b'
  },
  deck: {
    boardId: 8
  }
};

async function main() {
  console.log('');
  console.log('╔════════════════════════════════════════════════════════════════╗');
  console.log('║          LIVE Heartbeat Test - Real LLM Processing             ║');
  console.log('╚════════════════════════════════════════════════════════════════╝');
  console.log('');

  // Initialize LLM Router with REAL Ollama
  console.log('[INIT] Setting up LLM Router (Ollama)...');
  const llmRouter = new LLMRouter({
    ollama: CONFIG.ollama,
    auditLog: async (event, data) => {
      console.log(`  [LLM] ${event}: ${JSON.stringify(data).substring(0, 150)}`);
    }
  });

  // Test Ollama connection
  console.log('[TEST] Checking Ollama connection...');
  const ollamaTest = await llmRouter.testConnection();
  
  if (!ollamaTest.connected) {
    console.error(`[ERROR] Ollama not reachable: ${ollamaTest.error}`);
    console.error('[ERROR] Make sure Ollama VM is running and accessible at', CONFIG.ollama.url);
    process.exit(1);
  }
  
  console.log(`[OK] Ollama connected! Models: ${ollamaTest.models.join(', ')}`);
  console.log('');

  // Initialize Heartbeat Manager
  console.log('[INIT] Setting up Heartbeat Manager...');
  const heartbeat = new HeartbeatManager({
    nextcloud: CONFIG.nextcloud,
    deck: CONFIG.deck,
    heartbeat: {
      quietHoursStart: 99,  // Disable quiet hours for test
      quietHoursEnd: 99,
      maxTasksPerCycle: 1   // Process just 1 task for demo
    },
    llmRouter,
    notifyUser: async (notification) => {
      console.log(`  [NOTIFY] ${notification.type}: ${notification.message}`);
    },
    auditLog: async (event, data) => {
      console.log(`  [AUDIT] ${event}`);
    }
  });

  // Run single pulse
  console.log('');
  console.log('┌────────────────────────────────────────────────────────────────┐');
  console.log('│ Running LIVE heartbeat pulse...                                │');
  console.log('└────────────────────────────────────────────────────────────────┘');
  console.log('');

  const startTime = Date.now();
  const result = await heartbeat.forcePulse();
  const duration = ((Date.now() - startTime) / 1000).toFixed(1);

  console.log('');
  console.log('┌────────────────────────────────────────────────────────────────┐');
  console.log('│ Results                                                        │');
  console.log('└────────────────────────────────────────────────────────────────┘');
  console.log('');
  console.log(`Duration: ${duration}s`);
  console.log('');
  console.log('Deck:', JSON.stringify(result.deck, null, 2));
  console.log('');
  console.log('Calendar:', JSON.stringify(result.calendar, null, 2));
  
  if (result.errors?.length > 0) {
    console.log('');
    console.log('Errors:', JSON.stringify(result.errors, null, 2));
  }

  // Show LLM stats
  console.log('');
  console.log('LLM Stats:', llmRouter.getStats());
  
  console.log('');
  console.log('✓ Done!');
}

main().catch(err => {
  console.error('[FATAL]', err);
  process.exit(1);
});
