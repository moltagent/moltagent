#!/usr/bin/env node
/**
 * Link Format Diagnostic
 *
 * Creates a test wiki page and a test Deck card with different link formats
 * to determine which render as clickable in the Nextcloud UI.
 *
 * Run: CREDENTIALS_DIRECTORY=/run/credentials/moltagent.service node test/manual/link-format-diagnostic.js
 */

const appConfig = require('../../src/lib/config');
const NCRequestManager = require('../../src/lib/nc-request-manager');
const CollectivesClient = require('../../src/lib/integrations/collectives-client');
const DeckClient = require('../../src/lib/integrations/deck-client');

const NC_URL = appConfig.nextcloud.url;

async function run() {
  console.log('=== Link Format Diagnostic ===\n');

  // Bootstrap NC client
  const nc = new NCRequestManager(appConfig);
  nc.setBootstrapCredential();

  const wiki = new CollectivesClient(nc, { collectiveName: 'Moltagent Knowledge' });
  const deck = new DeckClient(nc, appConfig);

  // --- 1. Wiki page ---
  console.log('1. Creating wiki test page...');
  try {
    const collectiveId = await wiki.resolveCollective();
    const allPages = await wiki.listPages(collectiveId);

    // Find Meta section as parent
    const metaPage = allPages.find(p => (p.title || '').toLowerCase() === 'meta');
    const parentId = metaPage ? metaPage.id : 0;

    // Check if test page already exists
    const existing = allPages.find(p => (p.title || '').toLowerCase() === 'link format test');
    let pagePath;

    if (existing) {
      pagePath = existing.filePath
        ? `${existing.filePath}/${existing.fileName}`
        : existing.fileName || 'Link Format Test.md';
      console.log(`   Page already exists, overwriting at: ${pagePath}`);
    } else {
      const page = await wiki.createPage(collectiveId, parentId, 'Link Format Test');
      pagePath = page.filePath
        ? `${page.filePath}/${page.fileName}`
        : page.fileName || 'Link Format Test.md';
      console.log(`   Created page, path: ${pagePath}`);
    }

    const wikiContent = `# Link Format Test

Testing which link formats render as clickable in Collectives.

## Format 1: Wikilink
[[Pending Questions]]

## Format 2: Relative Markdown Link
[Pending Questions](./Meta/Pending%20Questions)

## Format 3: Absolute Markdown Link
[Pending Questions](${NC_URL}/apps/collectives/Moltagent%20Knowledge/Meta/Pending%20Questions)

## Format 4: Bare URL
${NC_URL}/apps/collectives/Moltagent%20Knowledge/Meta/Pending%20Questions

## Format 5: Relative with .md extension
[Pending Questions](./Meta/Pending%20Questions/Readme.md)

---
Created by link-format-diagnostic.js at ${new Date().toISOString()}
`;

    await wiki.writePageContent(pagePath, wikiContent);
    console.log(`   Wrote content with 5 link formats`);
    console.log(`   View at: ${NC_URL}/apps/collectives/Moltagent%20Knowledge/Link%20Format%20Test\n`);
  } catch (err) {
    console.error(`   Wiki page creation failed: ${err.message}\n`);
  }

  // --- 2. Deck card ---
  console.log('2. Creating Deck test card...');
  try {
    await deck.ensureBoard();

    const cardDescription = `# Link Format Test

Testing which link formats render as clickable in Deck card descriptions.

## Format 1: Wikilink
[[Pending Questions]]

## Format 2: Relative Markdown Link
[Pending Questions](./Meta/Pending%20Questions)

## Format 3: Absolute Markdown Link
[Pending Questions](${NC_URL}/apps/collectives/Moltagent%20Knowledge/Meta/Pending%20Questions)

## Format 4: Bare URL
${NC_URL}/apps/collectives/Moltagent%20Knowledge/Meta/Pending%20Questions

## Format 5: Relative with .md extension
[Pending Questions](./Meta/Pending%20Questions/Readme.md)

---
Created by link-format-diagnostic.js at ${new Date().toISOString()}`;

    const card = await deck.createCard('inbox', {
      title: 'Link Format Test — DELETE ME',
      description: cardDescription
    });

    if (card && card.id) {
      console.log(`   Created card #${card.id}`);
      console.log(`   Open in Deck UI to check which formats render as clickable\n`);
    } else {
      console.log(`   Card creation returned no ID: ${JSON.stringify(card)}\n`);
    }
  } catch (err) {
    console.error(`   Deck card creation failed: ${err.message}\n`);
  }

  // --- 3. Deck comment (same formats) ---
  console.log('3. Adding comment to test card with link formats...');
  try {
    // Find the card we just created
    const allCards = await deck.getAllCards();
    let testCard = null;
    for (const [stack, cards] of Object.entries(allCards)) {
      const found = cards.find(c => c.title === 'Link Format Test — DELETE ME');
      if (found) { testCard = found; break; }
    }

    if (testCard) {
      const commentText = `Link format test in comments:

1. Wikilink: [[Pending Questions]]
2. Relative MD: [Pending Questions](./Meta/Pending%20Questions)
3. Absolute MD: [Pending Questions](${NC_URL}/apps/collectives/Moltagent%20Knowledge/Meta/Pending%20Questions)
4. Bare URL: ${NC_URL}/apps/collectives/Moltagent%20Knowledge/Meta/Pending%20Questions`;

      await deck.addComment(testCard.id, commentText, 'TEST', { prefix: false });
      console.log(`   Comment added to card #${testCard.id}\n`);
    } else {
      console.log('   Could not find test card for comment\n');
    }
  } catch (err) {
    console.error(`   Comment failed: ${err.message}\n`);
  }

  console.log('=== Done ===');
  console.log('Check the Nextcloud UI for both:');
  console.log(`  Wiki: ${NC_URL}/apps/collectives/Moltagent%20Knowledge/Link%20Format%20Test`);
  console.log('  Deck: Open Moltagent Tasks board → Inbox → "Link Format Test — DELETE ME"');
  console.log('\nReport back which formats are clickable in each context.');

  // nc has no explicit stop needed for one-shot usage
}

run().catch(err => {
  console.error('Fatal:', err);
  process.exit(1);
});
