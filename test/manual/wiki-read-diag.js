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
const CollectivesClient = require('../../src/lib/integrations/collectives-client');

async function test() {
  const nc = new NCRequestManager({
    nextcloud: {
      url: process.env.NC_URL,
      username: process.env.NC_USER,
      password: process.env.NC_PASS
    }
  });
  nc.ncPassword = process.env.NC_PASS;
  const wiki = new CollectivesClient(nc, { collectiveName: 'Moltagent Knowledge' });

  // Manual trace of findPageByTitle logic
  console.log('--- Manual findPageByTitle trace ---');
  try {
    const collectiveId = await wiki.resolveCollective();
    console.log('collectiveId:', collectiveId);

    // Step 1: searchPages (will 500)
    let candidates = [];
    try {
      const results = await wiki.searchPages(collectiveId, 'Christian Fu Mueller');
      console.log('searchPages returned:', Array.isArray(results) ? results.length + ' results' : typeof results);
      if (Array.isArray(results) && results.length > 0) candidates = results;
    } catch (err) {
      console.log('searchPages CAUGHT:', err.message.substring(0, 80));
    }

    // Step 2: listPages fallback
    if (candidates.length === 0) {
      console.log('Falling back to listPages...');
      const allPages = await wiki.listPages(collectiveId);
      console.log('listPages returned:', Array.isArray(allPages) ? allPages.length + ' pages' : typeof allPages, JSON.stringify(allPages).substring(0, 200));
      candidates = Array.isArray(allPages) ? allPages : [];
    }

    // Step 3: exact match
    const leafTitle = 'Christian Fu Mueller';
    const exact = candidates.find(p => (p.title || '').toLowerCase() === leafTitle.toLowerCase());
    console.log('Exact match:', exact ? JSON.stringify({ title: exact.title, id: exact.id }) : 'NONE');
    console.log('All titles:', candidates.map(p => p.title));
  } catch (err) {
    console.log('TRACE ERROR:', err.message, err.statusCode || '');
  }

  console.log('\n--- readPageWithFrontmatter("Christian Fu Mueller") ---');
  try {
    const content = await wiki.readPageWithFrontmatter('Christian Fu Mueller');
    if (content) {
      console.log('CONTENT:', JSON.stringify({
        bodyLength: content.body.length,
        bodyPreview: content.body.substring(0, 200),
        frontmatter: content.frontmatter,
        path: content.path
      }, null, 2));
    } else {
      console.log('NULL (page not found)');
    }
  } catch (err) {
    console.log('ERROR:', err.message, err.statusCode || '');
  }

  process.exit(0);
}

test().catch(e => { console.error('FATAL:', e.message); process.exit(1); });
