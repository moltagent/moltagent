'use strict';

/**
 * Manual script: Create Organizations/ wiki section and move Hetzner Cloud there.
 *
 * Usage: node test/manual/create-organizations-section.js
 */

const fs = require('fs');

// ── Credentials ──
process.env.NC_URL = 'https://YOUR_NEXTCLOUD_URL';
process.env.NC_USER = 'moltagent';
const credDir = process.env.CREDENTIALS_DIRECTORY || '/etc/credstore';
try { process.env.NC_PASS = fs.readFileSync(credDir + '/moltagent-nc-password', 'utf8').trim(); } catch {}
if (!process.env.NC_PASS) {
  try { process.env.NC_PASS = fs.readFileSync(credDir + '/nc-password', 'utf8').trim(); } catch {}
}

const NCRequestManager = require('../../src/lib/nc-request-manager');
const { NCFilesClient } = require('../../src/lib/integrations/nc-files-client');
const CollectivesClient = require('../../src/lib/integrations/collectives-client');
const appConfig = require('../../src/lib/config');

async function main() {
  console.log('=== Create Organizations/ section & move Hetzner Cloud ===\n');

  const nc = new NCRequestManager({
    nextcloud: {
      url: process.env.NC_URL,
      username: process.env.NC_USER,
      password: process.env.NC_PASS
    }
  });
  nc.ncPassword = process.env.NC_PASS;

  const ncFilesClient = new NCFilesClient(nc, { username: process.env.NC_USER });
  const collectivesClient = new CollectivesClient(nc, {
    collectiveName: appConfig.knowledge?.collectiveName || 'Moltagent Knowledge'
  });

  const collectivePath = 'Collectives/' + (appConfig.knowledge?.collectiveName || 'Moltagent Knowledge');

  // ── 0. Create Agents/ section ──
  const agentsPath = collectivePath + '/Agents';
  console.log(`Creating directory: ${agentsPath}`);
  try {
    await ncFilesClient.mkdir(agentsPath);
    console.log('  OK Agents/ directory created (or already exists)');
  } catch (err) {
    console.log(`  Error: ${err.message}`);
  }
  try {
    await ncFilesClient.writeFile(agentsPath + '/Readme.md', '# Agents\n\nAI assistants, language models, bots, and artificial persons.\n');
    console.log('  OK Agents/Readme.md created');
  } catch (err) {
    console.log(`  Landing page error: ${err.message}`);
  }

  // Move Claude Opus and Claude Code from People/ to Agents/
  for (const name of ['Claude Opus', 'Claude Code']) {
    const src = collectivePath + '/People/' + name + '.md';
    try {
      const result = await ncFilesClient.readFile(src);
      if (result.content) {
        await ncFilesClient.writeFile(agentsPath + '/' + name + '.md', result.content);
        await ncFilesClient.deleteFile(src);
        console.log(`  OK Moved ${name} from People/ to Agents/`);
      }
    } catch (err) {
      console.log(`  ${name}: ${err.message}`);
    }
  }

  // ── 1. Create Organizations/ section via WebDAV mkdir ──
  const orgPath = collectivePath + '/Organizations';
  console.log(`Creating directory: ${orgPath}`);
  try {
    await ncFilesClient.mkdir(orgPath);
    console.log('  OK Organizations/ directory created (or already exists)');
  } catch (err) {
    console.log(`  Error: ${err.message}`);
  }

  // Create a landing page so the section shows up in Collectives UI
  const landingContent = '# Organizations\n\nCompanies, vendors, clients, and institutional partners.\n';
  try {
    await ncFilesClient.writeFile(orgPath + '/Readme.md', landingContent);
    console.log('  OK Organizations/Readme.md created');
  } catch (err) {
    console.log(`  Landing page error: ${err.message}`);
  }

  // ── 2. Read Hetzner Cloud from People/ ──
  const hetznerSrc = collectivePath + '/People/Hetzner Cloud.md';
  let hetznerContent = null;
  try {
    const result = await ncFilesClient.readFile(hetznerSrc);
    hetznerContent = result.content;
    console.log(`\nHetzner Cloud in People/: ${hetznerContent.length} chars`);
  } catch (err) {
    console.log(`\nHetzner Cloud not found in People/: ${err.message}`);
  }

  // ── 3. Move Hetzner Cloud to Organizations/ ──
  if (hetznerContent) {
    const hetznerDst = orgPath + '/Hetzner Cloud.md';
    try {
      await ncFilesClient.writeFile(hetznerDst, hetznerContent);
      console.log('  OK Hetzner Cloud written to Organizations/');

      // Delete from People/
      await ncFilesClient.deleteFile(hetznerSrc);
      console.log('  OK Hetzner Cloud removed from People/');
    } catch (err) {
      console.log(`  Move error: ${err.message}`);
    }
  }

  // ── 4. Verify ──
  console.log('\n--- Verification ---');
  try {
    const entries = await ncFilesClient.listDirectory(orgPath);
    console.log(`Organizations/ contents (${entries.length} items):`);
    for (const e of entries) {
      console.log(`  - ${e.name || e.filename}`);
    }
  } catch (err) {
    console.log(`Listing error: ${err.message}`);
  }

  process.exit(0);
}

main().catch(err => {
  console.error('FATAL:', err.message, err.stack);
  process.exit(1);
});
