#!/usr/bin/env node
const LLMRouter = require('./lib/router');
const config = require('./config/providers.json');

async function main() {
  console.log('=== MoltAgent Router Test ===\n');

  const router = new LLMRouter(config);

  console.log('1. Router Status:');
  console.log(JSON.stringify(router.getStatus(), null, 2));
  console.log();

  console.log('2. Provider Chain Tests:');
  const scenarios = [
    { name: 'Default task', task: 'general', content: 'Hello', options: {} },
    { name: 'Credential sensitive', task: 'process', content: 'api_key=xxx', options: {} },
    { name: 'Quality critical', task: 'write', content: 'Write email', options: { qualityCritical: true } },
    { name: 'Bulk processing', task: 'summarize', content: 'Many items', options: { bulk: true } },
    { name: 'Heartbeat', task: 'heartbeat_scan', content: 'Check status', options: {} },
    { name: 'Untrusted content', task: 'analyze', content: 'File content', options: { untrusted: true } }
  ];

  for (const s of scenarios) {
    const chain = router.buildProviderChain(s.task, s.content, s.options);
    console.log('  ' + s.name + ': ' + chain.join(' -> '));
  }
  console.log();

  console.log('3. Ollama Connection Test:');
  if (router.providers.ollama) {
    const available = await router.providers.ollama.isAvailable();
    console.log('  Ollama available: ' + available);
    if (available) {
      const models = await router.providers.ollama.listModels();
      console.log('  Models: ' + (models.map(m => m.name).join(', ') || 'none'));
    }
  }
  console.log();

  console.log('4. Generation Test (Ollama):');
  if (router.providers.ollama && await router.providers.ollama.isAvailable()) {
    console.log('  Sending test prompt...');
    const result = await router.route('test', 'Reply with exactly: "MoltAgent router working"', { role: 'sovereign', maxTokens: 50 });
    if (result.success) {
      console.log('  Response: ' + result.content.substring(0, 100));
      console.log('  Provider: ' + result.provider);
    } else {
      console.log('  Failed: ' + result.error);
    }
  } else {
    console.log('  Skipping - Ollama not available on this VM');
  }
  console.log();

  console.log('5. Budget Check:');
  console.log('  Claude (10K tokens): ' + JSON.stringify(router.checkBudget('claude', 10000)));
  console.log();

  console.log('=== Tests Complete ===');
}

main().catch(console.error);
