'use strict';
const fs = require('fs');
process.env.NC_URL = 'https://YOUR_NEXTCLOUD_URL';
process.env.NC_USER = 'moltagent';
const credDir = process.env.CREDENTIALS_DIRECTORY || '/etc/credstore';
try { process.env.NC_PASS = fs.readFileSync(credDir + '/moltagent-nc-password', 'utf8').trim(); } catch {}
if (!process.env.NC_PASS) {
  try { process.env.NC_PASS = fs.readFileSync(credDir + '/nc-password', 'utf8').trim(); } catch {}
}

const NCRequestManager = require('../../src/lib/nc-request-manager');
const { NCFilesClient } = require('../../src/lib/integrations/nc-files-client');

async function main() {
  const nc = new NCRequestManager({ nextcloud: { url: process.env.NC_URL, username: process.env.NC_USER, password: process.env.NC_PASS } });
  nc.ncPassword = process.env.NC_PASS;
  const files = new NCFilesClient(nc, { username: process.env.NC_USER });

  const root = await files.listDirectory('');
  console.log('ROOT:', root.map(e => e.name + (e.type === 'directory' ? '/' : '')).join(', '));

  for (const dir of root.filter(e => e.type === 'directory')) {
    try {
      const entries = await files.listDirectory(dir.name);
      const matching = entries.filter(e =>
        e.name.toLowerCase().includes('briefing') ||
        e.name.toLowerCase().includes('cost') ||
        e.name.toLowerCase().includes('security-spec')
      );
      if (matching.length > 0) {
        console.log(dir.name + '/ matches:', matching.map(e => e.name));
      }
    } catch (err) {
      // skip
    }
  }
}
main().catch(e => { console.error(e.message); process.exit(1); });
