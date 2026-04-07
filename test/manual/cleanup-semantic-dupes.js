'use strict';

/**
 * Comprehensive wiki cleanup: remove semantic duplicates and misplaced pages.
 *
 * Duplicates fall into categories:
 * 1. Model ID variants (qwen3:8b vs Qwen3 8B vs qwen38b)
 * 2. Case/punctuation variants (Claude Code vs claude-code)
 * 3. Cross-section duplicates (CrewAI in both Agents/ and Organizations/)
 * 4. Garbage pages (moltagent-moltagent, countries-as-orgs, metadata endpoints)
 * 5. Internal modules misclassified as agents (BudgetEnforcer, DailyDigester)
 *
 * Usage: node test/manual/cleanup-semantic-dupes.js [--dry-run]
 */

const fs = require('fs');
process.env.NC_URL = 'https://YOUR_NEXTCLOUD_URL';
process.env.NC_USER = 'moltagent';
const credDir = process.env.CREDENTIALS_DIRECTORY || '/etc/credstore';
try { process.env.NC_PASS = fs.readFileSync(credDir + '/moltagent-nc-password', 'utf8').trim(); } catch {}
if (!process.env.NC_PASS) { try { process.env.NC_PASS = fs.readFileSync(credDir + '/nc-password', 'utf8').trim(); } catch {} }

const NCRequestManager = require('../../src/lib/nc-request-manager');
const { NCFilesClient } = require('../../src/lib/integrations/nc-files-client');
const nc = new NCRequestManager({ nextcloud: { url: process.env.NC_URL, username: process.env.NC_USER, password: process.env.NC_PASS } });
nc.ncPassword = process.env.NC_PASS;
const files = new NCFilesClient(nc, { username: process.env.NC_USER });

const collectivePath = 'Collectives/Moltagent Knowledge';
const dryRun = process.argv.includes('--dry-run');

// ── DELETION LISTS ──────────────────────────────────────────────────────────

// Agents/: Keep ONE canonical page per model/tool, delete the rest.
// Format: page names to DELETE (without .md suffix — we handle both with/without)
const AGENTS_DELETE = [
  // Claude variants — keep "Claude Opus.md", "Claude Sonnet.md", "Claude Haiku.md", "Claude Code.md"
  'claude-code', 'claude-opus-4-6', 'Claude Sonnet 4.6', 'Sonnet', 'Claude', 'Claude API',
  // Qwen variants — keep "Qwen3 8B.md" and "Qwen 2.5 3B.md" concept (qwen2.5:3b)
  'Qwen 8B', 'Qwen', 'Qwen3', 'Qwen314b', 'Qwen3:14b',
  'qwen2.5', 'qwen2.53b', 'qwen2.5:3b', 'qwen3', 'qwen38b', 'qwen3:8b',
  // DeepSeek variants — keep "DeepSeek.md"
  'deepseek-r1', 'deepseek-r18b', 'deepseek-r1:8b',
  // GLM variants — keep "GLM4.md"
  'GLM-4.7', 'glm4', 'glm49b', 'glm4:9b',
  // GPT variants — keep "GPT-4o.md"
  'GPT', 'GPT-5.2', 'gpt-5.2',
  // Mistral variants — keep "Mistral.md"
  'Mistral Small 3.2', 'mistral-small', 'mistral-small:latest', 'mistral-smalllatest',
  // Phi variants — keep "Phi-4.md"
  'phi3', 'phi3:mini', 'phi3mini', 'phi4-mini',
  // Granite variants — keep "Granite3.2:8b.md"
  'Granite3.28b',
  // OpenInterpreter variants — keep "Open Interpreter.md"
  'OpenInterpreter',
  // Moltbot/Moltagent variants — keep "MoltAgent.md"
  'MoltBot', 'Moltbot', 'Moltagent Prime', 'Molti', 'MoltAgent Forge', 'moltagent', 'moltagent-demos',
  // Internal modules that aren't agents
  'BudgetEnforcer', 'DailyDigester', 'FreshnessChecker', 'HeartbeatManager', 'MeetingPreparer',
  // Misc
  "Cisco's AI security team",
  // Cross-section dupes (already in Organizations/)
  'Azure OpenAI', 'CrewAI', 'Perplexity',
];

// Organizations/: merge duplicates
const ORGS_DELETE = [
  // Hetzner variants — keep "Hetzner.md"
  'Hetzner Cloud', 'Hetzner Storage Share', 'Hetzner StorageShare', 'Storage Share', 'StorageShare',
  // Catalyne — keep "Catalyne.md"
  '@user-123',
  // Stanford compound page
  'Stanford-Northwestern-Harvard',
  // Not organizations
  'France', 'Germany', 'AWS metadata', 'GCP metadata',
  // Moltagent dupe — keep in Projects/
  'moltagent.cloud',
];

// Projects/: remove duplicates without colons (keep "Demo: ..." versions)
const PROJECTS_DELETE = [
  'Demo Client Onboarding', 'Demo Expense Processing', 'Demo Support Triage', 'Demo Weekly Review',
  'Layer 2 Context-Aware Classification',
  'Session 17b Post-FileOps Hardening',
  'Meta-Knowledge Stats',
  'moltagent-moltagent',
];

// People/: cleanup
const PEOPLE_DELETE = [
  'Claude Code',   // already in Agents/
  'jordan',         // keep "Jordan" (proper case)
  'Sarah',          // keep "Sarah Chen.md"
];

async function deletePage(section, name) {
  // Try with .md extension first, then without
  for (const suffix of ['.md', '']) {
    const fullPath = `${collectivePath}/${section}/${name}${suffix}`;
    try {
      if (dryRun) {
        console.log(`  [DRY-RUN] Would delete: ${section}/${name}${suffix}`);
        return true;
      }
      await files.deleteFile(fullPath);
      console.log(`  DELETED: ${section}/${name}${suffix}`);
      return true;
    } catch {
      // try next suffix
    }
  }
  console.log(`  SKIP (not found): ${section}/${name}`);
  return false;
}

async function run() {
  console.log(`=== Semantic Duplicate Cleanup ${dryRun ? '(DRY RUN)' : ''} ===\n`);

  const tasks = [
    ['Agents', AGENTS_DELETE],
    ['Organizations', ORGS_DELETE],
    ['Projects', PROJECTS_DELETE],
    ['People', PEOPLE_DELETE],
  ];

  let totalDeleted = 0;
  let totalSkipped = 0;

  for (const [section, deleteList] of tasks) {
    console.log(`\n── ${section}/ (${deleteList.length} targets) ──`);
    for (const name of deleteList) {
      const ok = await deletePage(section, name);
      if (ok) totalDeleted++;
      else totalSkipped++;
    }
  }

  console.log(`\n=== Summary ===`);
  console.log(`Deleted: ${totalDeleted}`);
  console.log(`Skipped: ${totalSkipped}`);
  if (dryRun) console.log('(DRY RUN — nothing was actually deleted)');
  process.exit(0);
}

run().catch(e => { console.error(e); process.exit(1); });
