'use strict';

/**
 * Manual test: Process 3 specific files through DocumentIngestor.processFile()
 * and inspect wiki state + knowledge graph after processing.
 *
 * Usage: node test/manual/ingest-3-files.js
 */

const fs = require('fs');

// ── Credentials ──
process.env.NC_URL = 'https://nx89136.your-storageshare.de';
process.env.NC_USER = 'moltagent';
const credDir = process.env.CREDENTIALS_DIRECTORY || '/etc/credstore';
try { process.env.NC_PASS = fs.readFileSync(credDir + '/moltagent-nc-password', 'utf8').trim(); } catch {}
if (!process.env.NC_PASS) {
  try { process.env.NC_PASS = fs.readFileSync(credDir + '/nc-password', 'utf8').trim(); } catch {}
}

const NCRequestManager = require('../../src/lib/nc-request-manager');
const { NCFilesClient } = require('../../src/lib/integrations/nc-files-client');
const { TextExtractor } = require('../../src/lib/extraction/text-extractor');
const CollectivesClient = require('../../src/lib/integrations/collectives-client');
const ResilientWikiWriter = require('../../src/lib/integrations/resilient-wiki-writer');
const KnowledgeGraph = require('../../src/lib/memory/knowledge-graph');
const EntityExtractor = require('../../src/lib/memory/entity-extractor');
const DocumentIngestor = require('../../src/lib/integrations/document-ingestor');
const appConfig = require('../../src/lib/config');
const { LLMRouter, loadConfig: loadLLMConfig } = require('../../src/lib/llm');
const CredentialCache = require('../../src/lib/credential-cache');
const CredentialBroker = require('../../src/lib/credential-broker');

// ── Files to ingest ──
const FILES = [
  'Moltagent Development/MOLTAGENT-BRIEFING-v3.md',
  'Moltagent Development/moltagent-cost-optimization.md',
  'Moltagent Development/MoltAgent-Security-Specification-v1.0.docx',
];

async function main() {
  console.log('=== DocumentIngestor: 3-file manual test ===\n');

  // ── 1. Wire up real services ──
  const nc = new NCRequestManager({
    nextcloud: {
      url: process.env.NC_URL,
      username: process.env.NC_USER,
      password: process.env.NC_PASS
    }
  });
  nc.ncPassword = process.env.NC_PASS;

  const ncFilesClient = new NCFilesClient(nc, { username: process.env.NC_USER });
  const textExtractor = new TextExtractor();
  const collectivesClient = new CollectivesClient(nc, {
    collectiveName: appConfig.knowledge?.collectiveName || 'Moltagent Knowledge'
  });
  const resilientWriter = new ResilientWikiWriter({
    collectivesClient,
    ncFilesClient,
    collectivePath: 'Collectives/' + (appConfig.knowledge?.collectiveName || 'Moltagent Knowledge'),
    logger: console,
    ocsTimeoutMs: 10000
  });

  const knowledgeGraph = new KnowledgeGraph({ ncFilesClient, logger: console });

  // LLM Router with real credential broker (for cloud provider API keys)
  const ollamaUrl = process.env.OLLAMA_URL || appConfig.ollama?.url || 'http://localhost:11434';
  console.log(`[INIT] Ollama URL: ${ollamaUrl}`);

  const credentialCache = new CredentialCache(nc);
  const credentialBroker = new CredentialBroker(credentialCache, {
    ncUrl: process.env.NC_URL,
    ncUsername: process.env.NC_USER,
    auditLog: () => {}
  });

  const getCredential = credentialBroker.createGetter();
  const loadedConfig = loadLLMConfig({ getCredential });

  // Apply ollama settings (mirrors legacy wrapper constructor logic)
  const ollamaModel = appConfig.ollama?.model || 'qwen2.5:3b';
  loadedConfig.providers['ollama-local'] = {
    adapter: 'ollama',
    endpoint: ollamaUrl,
    model: ollamaModel
  };
  const credModel = appConfig.ollama?.modelCredential || ollamaModel;
  if (credModel !== ollamaModel) {
    loadedConfig.providers['ollama-credential'] = {
      adapter: 'ollama',
      endpoint: ollamaUrl,
      model: credModel
    };
  }

  const llmRouter = new LLMRouter({
    ...loadedConfig,
    auditLog: () => {},  // silent
    proactiveDailyBudget: 0
  });

  // Activate smart-mix preset so synthesis job gets the cloud chain
  llmRouter.setPreset('smart-mix');
  console.log(`[INIT] Preset: smart-mix`);
  const roster = llmRouter.getRoster();
  if (roster) {
    console.log(`[INIT] Synthesis chain: ${roster.synthesis?.join(' → ') || 'none'}`);
  }

  // Wrap router to log synthesis calls
  const innerRouter = llmRouter;
  const debugRouter = {
    route: async (req) => {
      console.log(`  [DEBUG] Router call: job=${req.job}, contentLen=${(req.content || '').length}`);
      try {
        const result = await innerRouter.route(req);
        const raw = result.result || '';
        console.log(`  [DEBUG] Router result: provider=${result.provider}, resultLen=${raw.length}`);
        console.log(`  [DEBUG] First 300 chars: ${raw.substring(0, 300)}`);
        console.log(`  [DEBUG] Last 200 chars: ${raw.substring(raw.length - 200)}`);
        return result;
      } catch (err) {
        console.log(`  [DEBUG] Router error: ${err.message}`);
        throw err;
      }
    }
  };

  const entityExtractor = new EntityExtractor({
    knowledgeGraph,
    llmRouter: debugRouter,
    logger: console
  });

  const ingestor = new DocumentIngestor({
    ncFilesClient,
    textExtractor,
    entityExtractor,
    knowledgeGraph,
    wikiWriter: resilientWriter,
    logger: console
  });

  // ── 2. Process each file (clear processed set to allow re-runs) ──
  ingestor._processed.clear();
  for (const file of FILES) {
    console.log(`\n${'='.repeat(60)}`);
    console.log(`Processing: ${file}`);
    console.log('='.repeat(60));

    try {
      const result = await ingestor.processFile(file);

      if (result.skipped) {
        console.log(`  SKIPPED: ${result.reason}`);
        continue;
      }

      console.log(`  Text length: ${result.textLength} chars`);
      console.log(`  Summary: ${(result.summary || '').substring(0, 200)}...`);
      console.log(`  Entities found: ${result.entitiesFound}`);
      console.log(`  Entity pages created: ${result.entityPagesCreated}`);
      console.log(`  Wiki result: ${JSON.stringify(result.wikiResult)}`);
    } catch (err) {
      console.error(`  ERROR: ${err.message}`);
    }
  }

  // ── 3. Inspect knowledge graph ──
  console.log(`\n${'='.repeat(60)}`);
  console.log('KNOWLEDGE GRAPH STATE');
  console.log('='.repeat(60));

  const entities = Array.from(knowledgeGraph._entities.values());
  console.log(`\nTotal entities in graph: ${entities.length}`);
  if (entities.length > 0) {
    console.log('\nEntity list (name → type):');
    for (const e of entities) {
      console.log(`  - ${e.name} → ${e.type}`);
    }
  }

  const triples = knowledgeGraph._triples || [];
  console.log(`\nTotal triples: ${triples.length}`);
  if (triples.length > 0) {
    console.log('\nRelationships:');
    for (const t of triples) {
      console.log(`  ${t.from} --[${t.predicate}]--> ${t.to}`);
    }
  }

  // ── 4. Check wiki state ──
  console.log(`\n${'='.repeat(60)}`);
  console.log('WIKI STATE');
  console.log('='.repeat(60));

  // List all pages via OCS and show structure
  try {
    const collectiveId = await collectivesClient.resolveCollective();
    const allPages = await collectivesClient.listPages(collectiveId);
    console.log(`\nTotal wiki pages: ${allPages.length}`);

    // Group by top-level section
    const bySection = {};
    for (const p of allPages) {
      const fp = p.filePath || p.path || '';
      const parts = fp.split('/').filter(Boolean);
      const section = parts.length > 1 ? parts[parts.length - 2] : '(root)';
      if (!bySection[section]) bySection[section] = [];
      bySection[section].push(p.title || p.name || fp);
    }

    for (const [section, pages] of Object.entries(bySection)) {
      console.log(`\n${section}/ (${pages.length} pages):`);
      for (const title of pages) {
        console.log(`  - ${title}`);
      }
    }
  } catch (err) {
    console.log(`Wiki listing error: ${err.message}`);

    // Fallback: try WebDAV listing
    console.log('\nFallback: WebDAV listing...');
    const sections = ['Documents', 'People', 'Projects', 'Research', 'Images'];
    for (const section of sections) {
      try {
        const fullPath = 'Collectives/Moltagent Knowledge/' + section;
        const entries = await ncFilesClient.listDirectory(fullPath);
        if (entries && entries.length > 0) {
          console.log(`\n${section}/ (${entries.length} pages):`);
          for (const e of entries) {
            console.log(`  - ${e.name}`);
          }
        } else {
          console.log(`\n${section}/ (empty)`);
        }
      } catch (err2) {
        console.log(`\n${section}/ (error: ${err2.message})`);
      }
    }
  }

  // ── 5. Validation summary ──
  console.log(`\n${'='.repeat(60)}`);
  console.log('VALIDATION CHECKLIST');
  console.log('='.repeat(60));

  // Re-read entities from graph after processing
  const allEntities = Array.from(knowledgeGraph._entities.values());

  // Check Nextcloud typing
  const nextcloudEntity = allEntities.find(e => e.name.toLowerCase() === 'nextcloud');
  if (nextcloudEntity) {
    const isCorrectType = nextcloudEntity.type === 'tool' || nextcloudEntity.type === 'product';
    console.log(`\n[${isCorrectType ? 'PASS' : 'FAIL'}] "Nextcloud" typed as: ${nextcloudEntity.type} (expected: tool/product, NOT person)`);
  } else {
    console.log('\n[INFO] "Nextcloud" not found in graph entities');
  }

  // Check Claude Sonnet is graph-only (no wiki page)
  const claudeEntity = allEntities.find(e => e.name.toLowerCase().includes('claude'));
  if (claudeEntity) {
    console.log(`[INFO] "Claude" entity in graph: ${claudeEntity.name} (${claudeEntity.type})`);
  }

  // Check tool entities don't have wiki pages (shouldCreateWikiPage filters them)
  const toolEntities = allEntities.filter(e => e.type === 'tool');
  if (toolEntities.length > 0) {
    console.log(`\n[INFO] Tool entities (graph-only, no wiki page expected):`);
    for (const t of toolEntities) {
      console.log(`  - ${t.name} (${t.type})`);
    }
  }

  process.exit(0);
}

main().catch(err => {
  console.error('FATAL:', err.message, err.stack);
  process.exit(1);
});
