'use strict';

/**
 * Cleanup: Delete duplicate wiki pages (those with (2), (3), etc. suffixes).
 * Usage: node test/manual/cleanup-duplicate-pages.js
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

async function run() {
  console.log('=== Duplicate Wiki Page Cleanup ===\n');

  const sections = ['Projects', 'Organizations', 'People', 'Documents', 'Research', 'Procedures'];
  let totalDeleted = 0;

  for (const section of sections) {
    let entries;
    try {
      entries = await files.listDirectory(collectivePath + '/' + section);
    } catch {
      continue;
    }

    // Find duplicates: files matching "Name (N).md" pattern
    const dupes = entries.filter(e => /\(\d+\)\.md$/.test(e.name));

    if (dupes.length === 0) continue;

    console.log(`${section}/ — ${dupes.length} duplicates to remove:`);
    for (const dupe of dupes) {
      const fullPath = collectivePath + '/' + section + '/' + dupe.name;
      try {
        await files.deleteFile(fullPath);
        console.log(`  DELETED: ${dupe.name}`);
        totalDeleted++;
      } catch (err) {
        console.log(`  FAILED: ${dupe.name} — ${err.message}`);
      }
    }
  }

  console.log(`\nDone. Deleted ${totalDeleted} duplicate pages.`);
  process.exit(0);
}

run().catch(e => { console.error(e); process.exit(1); });
