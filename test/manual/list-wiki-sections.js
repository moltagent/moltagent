'use strict';
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

async function run() {
  const collectivePath = 'Collectives/Moltagent Knowledge';
  for (const section of ['Projects', 'Organizations', 'People', 'Documents']) {
    try {
      const entries = await files.listDirectory(collectivePath + '/' + section);
      console.log('\n' + section + '/ (' + entries.length + ' items):');
      for (const e of entries) {
        console.log('  ' + e.name + '  [' + (e.size || '?') + ' bytes]');
      }
    } catch (err) {
      console.log('\n' + section + '/: ' + err.message);
    }
  }
}
run().then(() => process.exit(0)).catch(e => { console.error(e); process.exit(1); });
