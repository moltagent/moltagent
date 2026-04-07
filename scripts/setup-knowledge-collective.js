#!/usr/bin/env node
/**
 * Moltagent Knowledge Collective Setup Script
 *
 * Creates the Moltagent Knowledge collective and page structure:
 * - Sections: People, Projects, Procedures, Research, Meta
 * - Meta subpages: Learning Log, Pending Questions, Knowledge Stats
 * - Root Readme.md with overview
 *
 * Requires Nextcloud with Collectives (and Teams/Circles) app installed.
 * Idempotent: re-running skips existing pages.
 *
 * Usage:
 *   NC_URL=https://your-nc.example.com \
 *   MOLTAGENT_PASSWORD=your-password \
 *   node scripts/setup-knowledge-collective.js
 *
 * @module setup-knowledge-collective
 */

const NCRequestManager = require('../src/lib/nc-request-manager');
const CollectivesClient = require('../src/lib/integrations/collectives-client');
const appConfig = require('../src/lib/config');

async function setupKnowledgeCollective(options = {}) {
  const verbose = options.verbose !== false;
  const collectiveName = options.collectiveName || appConfig.knowledge.collectiveName;

  if (verbose) {
    console.log('╔════════════════════════════════════════════════════════════╗');
    console.log('║      Moltagent Knowledge Collective Setup                  ║');
    console.log('╚════════════════════════════════════════════════════════════╝');
    console.log('');
  }

  // 1. Initialize NCRequestManager
  if (verbose) console.log('🔧 Setting up NC Request Manager...');
  const ncRequestManager = new NCRequestManager({
    nextcloud: {
      url: process.env.NC_URL || appConfig.nextcloud.url,
      username: process.env.NC_USER || appConfig.nextcloud.username
    }
  });
  ncRequestManager.setBootstrapCredential();
  await ncRequestManager.resolveCanonicalUsername();
  if (verbose) console.log(`✓ Connected as ${ncRequestManager.ncUser}`);

  // 2. Create CollectivesClient
  const client = new CollectivesClient(ncRequestManager, { collectiveName });

  // 3. Find or create collective
  if (verbose) console.log(`\n🔍 Resolving collective "${collectiveName}"...`);
  const collectiveId = await client.resolveCollective();
  if (verbose) console.log(`✓ Collective ready (ID: ${collectiveId})`);

  // 4. Create section subpages
  const sections = appConfig.knowledge.sections;
  if (verbose) console.log('\n📂 Creating section pages...');

  const pages = await client.listPages(collectiveId);
  const existingTitles = new Set((pages || []).map(p => p.title));

  // Find the landing page (root page, ID usually matches collective or is the first)
  const landingPage = (pages || []).find(p => !p.parentId || p.parentId === 0);
  const rootParentId = landingPage ? landingPage.id : 0;

  for (const section of sections) {
    if (existingTitles.has(section)) {
      if (verbose) console.log(`  ✓ ${section} (exists)`);
    } else {
      await client.createPage(collectiveId, rootParentId, section);
      if (verbose) console.log(`  📝 ${section} (created)`);
    }
  }

  // 5. Create Meta subpages
  if (verbose) console.log('\n📂 Creating Meta subpages...');
  const refreshedPages = await client.listPages(collectiveId);
  const metaPage = (refreshedPages || []).find(p => p.title === 'Meta');
  const metaSubpages = {
    'Learning Log': `---
type: log
confidence: high
---
# Learning Log

This page tracks what Moltagent has learned over time.

## Recent Entries

_No entries yet. The agent will add learnings as it works._
`,
    'Pending Questions': `---
type: meta
confidence: high
---
# Pending Questions

Questions the agent wants to verify with humans.

_No pending questions yet._
`,
    'Knowledge Stats': `---
type: meta
confidence: high
---
# Knowledge Stats

Overview of the knowledge base.

| Section | Pages | Last Updated |
|---------|-------|--------------|
| People | 0 | - |
| Projects | 0 | - |
| Procedures | 0 | - |
| Research | 0 | - |
| Meta | 3 | Initial setup |
`
  };

  if (metaPage) {
    const existingChildren = (refreshedPages || []).filter(p => p.parentId === metaPage.id);
    const childTitles = new Set(existingChildren.map(p => p.title));

    for (const [title, content] of Object.entries(metaSubpages)) {
      if (childTitles.has(title)) {
        if (verbose) console.log(`  ✓ Meta/${title} (exists)`);
      } else {
        await client.createPage(collectiveId, metaPage.id, title);
        // Write content via WebDAV
        try {
          await client.writePageContent(`Meta/${title}/Readme.md`, content);
          if (verbose) console.log(`  📝 Meta/${title} (created with content)`);
        } catch (err) {
          if (verbose) console.log(`  📝 Meta/${title} (created, content write deferred: ${err.message})`);
        }
      }
    }
  }

  // 6. Write root Readme.md
  if (verbose) console.log('\n📄 Writing root overview...');
  const rootContent = `---
type: overview
confidence: high
---
# ${collectiveName}

This is the knowledge base for Moltagent — a living wiki where the agent stores and organizes what it learns.

## Sections

- **[[People]]** — Contacts, team members, stakeholders
- **[[Projects]]** — Active and past projects, campaigns, initiatives
- **[[Procedures]]** — How-to guides, workflows, standard operating procedures
- **[[Research]]** — Research findings, market analysis, competitive intelligence
- **[[Meta]]** — Learning log, pending questions, knowledge stats

## How It Works

- The agent creates and updates pages as it learns new information
- Each page has frontmatter metadata (type, confidence, tags)
- Pages link to each other using [[wikilinks]]
- Humans can edit any page — the agent respects human edits
- Stale pages are flagged for review based on decay settings

## Confidence Levels

| Level | Meaning |
|-------|---------|
| **high** | Verified by human or from authoritative source |
| **medium** | Learned from conversation, not yet verified |
| **low** | Inferred or uncertain, needs verification |
`;

  try {
    await client.writePageContent('Readme.md', rootContent);
    if (verbose) console.log('  ✓ Root overview written');
  } catch (err) {
    if (verbose) console.log(`  ⚠ Root overview write deferred: ${err.message}`);
  }

  // 7. Done
  if (verbose) {
    console.log('');
    console.log('╔════════════════════════════════════════════════════════════╗');
    console.log('║  ✅ Knowledge Collective setup complete!                   ║');
    console.log('╚════════════════════════════════════════════════════════════╝');
    console.log('');
    console.log(`Collective: ${collectiveName} (ID: ${collectiveId})`);
    console.log(`Sections: ${sections.join(', ')}`);
    console.log('');
  }

  // Cleanup
  await ncRequestManager.shutdown();

  return { collectiveId, collectiveName, sections };
}

// CLI execution
if (require.main === module) {
  setupKnowledgeCollective()
    .then(result => {
      console.log('Result:', JSON.stringify(result, null, 2));
      process.exit(0);
    })
    .catch(err => {
      console.error('');
      console.error('❌ Setup failed:', err.message);
      if (err.statusCode) {
        console.error(`   HTTP Status: ${err.statusCode}`);
      }
      console.error('');
      console.error('Make sure:');
      console.error('  1. Nextcloud Collectives app is installed and enabled');
      console.error('  2. Nextcloud Teams (Circles) app is installed and enabled');
      console.error('  3. Credentials are configured (NC_PASSWORD or systemd credential)');
      process.exit(1);
    });
}

module.exports = setupKnowledgeCollective;
