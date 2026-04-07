'use strict';

/**
 * Phase 1 Wiki Cleanup: Delete garbage pages, duplicates, and bulk sections.
 *
 * Usage: node test/manual/wiki-cleanup-phase1.js [--dry-run]
 *
 * Actions:
 *   1. Delete ALL pages in Documents/, Projects/ (except Paradiesgarten, Project Phoenix),
 *      Agents/, Organizations/
 *   2. Delete all "(2)" and "(3)" suffix pages across all sections
 *   3. Delete specific garbage pages (CISoar Team, moltagent-moltagent, jordan duplicate)
 *   4. Delete empty pages (only frontmatter, no body)
 *   5. Report totals
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
const DRY_RUN = process.argv.includes('--dry-run');

// Pages to keep in Projects/ (manually created, not from ingestion)
const KEEP_IN_PROJECTS = new Set(['paradiesgarten.md', 'project phoenix.md']);

// Specific garbage pages to delete (section/filename pairs)
const GARBAGE_PAGES = [
  { section: 'People', name: 'CISoar Team.md' },
  { section: 'People', name: 'CISoar Team (2).md' },
  { section: 'Organizations', name: 'CISoar Team.md' },
  { section: 'Agents', name: 'CISoar Team.md' },
  { section: 'Projects', name: 'moltagent-moltagent.md' },
  { section: 'Documents', name: 'moltagent-moltagent.md' },
  { section: 'People', name: 'jordan.md' },  // Keep Jordan.md (capital F)
];

const stats = {
  bulkDeleted: 0,
  dupesDeleted: 0,
  garbageDeleted: 0,
  emptyDeleted: 0,
  errors: 0,
  kept: 0
};

async function listSection(section) {
  try {
    return await files.listDirectory(collectivePath + '/' + section);
  } catch {
    return [];
  }
}

async function deletePage(section, filename, reason) {
  const fullPath = collectivePath + '/' + section + '/' + filename;
  if (DRY_RUN) {
    console.log(`  [DRY-RUN] Would delete: ${section}/${filename} (${reason})`);
    return true;
  }
  try {
    await files.deleteFile(fullPath);
    console.log(`  DELETED: ${section}/${filename} (${reason})`);
    return true;
  } catch (err) {
    console.log(`  FAILED: ${section}/${filename} — ${err.message}`);
    stats.errors++;
    return false;
  }
}

async function readPageContent(section, filename) {
  const fullPath = collectivePath + '/' + section + '/' + filename;
  try {
    const result = await nc.request(
      `/remote.php/dav/files/${process.env.NC_USER}/${fullPath}`,
      { method: 'GET' }
    );
    return result?.body || '';
  } catch {
    return '';
  }
}

function isEmptyPage(content) {
  if (!content || content.trim().length === 0) return true;
  // Strip frontmatter
  const stripped = content.replace(/^---[\s\S]*?---\s*/, '').trim();
  // Strip heading (# Title)
  const noHeading = stripped.replace(/^#[^\n]*\n?/, '').trim();
  return noHeading.length < 10;
}

async function run() {
  console.log(`=== Phase 1: Wiki Cleanup ${DRY_RUN ? '(DRY RUN)' : ''} ===\n`);

  // ── Step 1: Bulk delete entire sections ──
  console.log('--- Step 1: Bulk section cleanup ---\n');

  // Documents/ — delete ALL
  const docEntries = await listSection('Documents');
  console.log(`Documents/ — ${docEntries.length} pages`);
  for (const entry of docEntries) {
    if (entry.type === 'directory') continue;
    if (entry.name === 'Readme.md' || entry.name === 'readme.md') { stats.kept++; continue; }
    if (await deletePage('Documents', entry.name, 'bulk section clear')) stats.bulkDeleted++;
  }

  // Agents/ — delete ALL
  const agentEntries = await listSection('Agents');
  console.log(`\nAgents/ — ${agentEntries.length} pages`);
  for (const entry of agentEntries) {
    if (entry.type === 'directory') continue;
    if (entry.name === 'Readme.md' || entry.name === 'readme.md') { stats.kept++; continue; }
    if (await deletePage('Agents', entry.name, 'bulk section clear')) stats.bulkDeleted++;
  }

  // Organizations/ — delete ALL
  const orgEntries = await listSection('Organizations');
  console.log(`\nOrganizations/ — ${orgEntries.length} pages`);
  for (const entry of orgEntries) {
    if (entry.type === 'directory') continue;
    if (entry.name === 'Readme.md' || entry.name === 'readme.md') { stats.kept++; continue; }
    if (await deletePage('Organizations', entry.name, 'bulk section clear')) stats.bulkDeleted++;
  }

  // Projects/ — delete all EXCEPT Paradiesgarten and Project Phoenix
  const projEntries = await listSection('Projects');
  console.log(`\nProjects/ — ${projEntries.length} pages`);
  for (const entry of projEntries) {
    if (entry.type === 'directory') continue;
    if (entry.name === 'Readme.md' || entry.name === 'readme.md') { stats.kept++; continue; }
    if (KEEP_IN_PROJECTS.has(entry.name.toLowerCase())) {
      console.log(`  KEPT: ${entry.name} (manually created)`);
      stats.kept++;
      continue;
    }
    if (await deletePage('Projects', entry.name, 'bulk section clear')) stats.bulkDeleted++;
  }

  // ── Step 2: Delete (N) duplicates across ALL sections ──
  console.log('\n--- Step 2: Delete (N) duplicates across all sections ---\n');

  const allSections = ['People', 'Research', 'Procedures', 'Sessions', 'Meta'];
  for (const section of allSections) {
    const entries = await listSection(section);
    const dupes = entries.filter(e => /\(\d+\)\.md$/.test(e.name));
    if (dupes.length === 0) continue;
    console.log(`${section}/ — ${dupes.length} duplicates`);
    for (const dupe of dupes) {
      if (await deletePage(section, dupe.name, 'duplicate suffix')) stats.dupesDeleted++;
    }
  }

  // ── Step 3: Delete specific garbage pages ──
  console.log('\n--- Step 3: Delete specific garbage pages ---\n');

  for (const garbage of GARBAGE_PAGES) {
    const entries = await listSection(garbage.section);
    const found = entries.find(e => e.name.toLowerCase() === garbage.name.toLowerCase());
    if (found) {
      if (await deletePage(garbage.section, found.name, 'garbage page')) stats.garbageDeleted++;
    }
  }

  // ── Step 4: Delete empty pages (across non-bulk sections) ──
  console.log('\n--- Step 4: Delete empty pages ---\n');

  for (const section of ['People', 'Research', 'Procedures']) {
    const entries = await listSection(section);
    for (const entry of entries) {
      if (entry.type === 'directory') continue;
      if (entry.name === 'Readme.md' || entry.name === 'readme.md') continue;
      if (/\(\d+\)\.md$/.test(entry.name)) continue; // Already handled in step 2

      const content = await readPageContent(section, entry.name);
      if (isEmptyPage(content)) {
        console.log(`  Empty: ${section}/${entry.name}`);
        if (await deletePage(section, entry.name, 'empty page')) stats.emptyDeleted++;
      }
    }
  }

  // ── Summary ──
  console.log('\n=== Cleanup Summary ===');
  console.log(`Bulk section pages deleted:  ${stats.bulkDeleted}`);
  console.log(`Duplicate (N) pages deleted: ${stats.dupesDeleted}`);
  console.log(`Garbage pages deleted:       ${stats.garbageDeleted}`);
  console.log(`Empty pages deleted:         ${stats.emptyDeleted}`);
  console.log(`Total deleted:               ${stats.bulkDeleted + stats.dupesDeleted + stats.garbageDeleted + stats.emptyDeleted}`);
  console.log(`Kept (protected):            ${stats.kept}`);
  console.log(`Errors:                      ${stats.errors}`);
  if (DRY_RUN) console.log('\n(Dry run — no pages were actually deleted)');
  process.exit(0);
}

run().catch(e => { console.error(e); process.exit(1); });
