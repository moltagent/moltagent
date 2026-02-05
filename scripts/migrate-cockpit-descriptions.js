#!/usr/bin/env node
'use strict';

/**
 * Cockpit Card Description Migration
 *
 * Updates live Cockpit board card descriptions to match DEFAULT_CARDS.
 * Only updates cards whose descriptions don't already contain '---'.
 * Skips the Status stack (agent-written cards).
 * Preserves labels, assignments, and positions.
 *
 * Usage:
 *   node scripts/migrate-cockpit-descriptions.js
 *   node scripts/migrate-cockpit-descriptions.js --dry-run
 */

const NCRequestManager = require('../src/lib/nc-request-manager');
const DeckClient = require('../src/lib/integrations/deck-client');
const appConfig = require('../src/lib/config');
const { DEFAULT_CARDS, BOARD_TITLE } = require('../src/lib/integrations/cockpit-manager');

const DRY_RUN = process.argv.includes('--dry-run');

// Stacks to migrate (skip 'status' — agent-written)
const MIGRATE_STACKS = ['styles', 'persona', 'guardrails', 'modes', 'system'];

// Stack title → DEFAULT_CARDS key mapping
const STACK_KEY_MAP = {
  'styles': 'styles',
  'persona': 'persona',
  'guardrails': 'guardrails',
  'modes': 'modes',
  'system': 'system'
};

async function main() {
  console.log('╔══════════════════════════════════════════════════════════╗');
  console.log('║     Cockpit Card Description Migration                   ║');
  console.log('╚══════════════════════════════════════════════════════════╝');
  if (DRY_RUN) console.log('\n** DRY RUN — no changes will be made **\n');

  // Initialize
  const nc = new NCRequestManager({
    nextcloud: {
      url: appConfig.nextcloud.url,
      username: appConfig.nextcloud.username
    }
  });
  nc.setBootstrapCredential();

  const deck = new DeckClient(nc, {
    boardName: appConfig.cockpit?.boardTitle || BOARD_TITLE
  });

  // Find the Cockpit board
  const boards = await deck.listBoards();
  const cockpitBoard = boards.find(b =>
    b.title === (appConfig.cockpit?.boardTitle || BOARD_TITLE)
  );

  if (!cockpitBoard) {
    console.error(`Board "${BOARD_TITLE}" not found. Aborting.`);
    process.exit(1);
  }

  console.log(`Board: "${cockpitBoard.title}" (ID: ${cockpitBoard.id})\n`);

  // Get all stacks with cards
  const stacks = await deck.getStacks(cockpitBoard.id);

  let updated = 0;
  let skippedAlready = 0;
  let skippedNoMatch = 0;

  for (const stack of stacks) {
    // Identify which DEFAULT_CARDS key this stack maps to
    const stackKey = MIGRATE_STACKS.find(key => {
      const keyLower = key.toLowerCase();
      const titleLower = (stack.title || '').toLowerCase();
      return titleLower.includes(keyLower);
    });

    if (!stackKey) {
      console.log(`  [skip] Stack "${stack.title}" — not in migration scope`);
      continue;
    }

    const cardDefs = DEFAULT_CARDS[STACK_KEY_MAP[stackKey]] || [];
    if (cardDefs.length === 0) {
      console.log(`  [skip] Stack "${stack.title}" — no DEFAULT_CARDS definitions`);
      continue;
    }

    console.log(`Stack: "${stack.title}" (${(stack.cards || []).length} cards)`);

    for (const card of (stack.cards || [])) {
      // Already has --- separator? Skip.
      if (card.description && card.description.includes('---')) {
        console.log(`  [skip] "${card.title}" — already has --- separator`);
        skippedAlready++;
        continue;
      }

      // Find matching DEFAULT_CARDS entry by title
      const def = cardDefs.find(d =>
        d.title.toLowerCase() === (card.title || '').toLowerCase()
      );

      if (!def) {
        console.log(`  [skip] "${card.title}" — no match in DEFAULT_CARDS`);
        skippedNoMatch++;
        continue;
      }

      // Update the card description
      if (DRY_RUN) {
        console.log(`  [would update] "${card.title}" — new description (${def.description.length} chars)`);
      } else {
        try {
          const path = `/index.php/apps/deck/api/v1.0/boards/${cockpitBoard.id}/stacks/${stack.id}/cards/${card.id}`;
          await nc.request(path, {
            method: 'PUT',
            body: {
              title: card.title,
              type: card.type || 'plain',
              owner: card.owner?.uid || card.owner || '',
              description: def.description,
              duedate: card.duedate || null
            },
            headers: {
              'OCS-APIRequest': 'true',
              'Accept': 'application/json',
              'Content-Type': 'application/json'
            }
          });
          console.log(`  [updated] "${card.title}"`);
        } catch (err) {
          console.error(`  [error] "${card.title}": ${err.message}`);
        }
      }
      updated++;
    }
  }

  console.log('\n' + '='.length ? '=' .repeat(50) : '');
  console.log(`\nDone.`);
  console.log(`  Updated:         ${updated}`);
  console.log(`  Already current: ${skippedAlready}`);
  console.log(`  No match:        ${skippedNoMatch}`);
  if (DRY_RUN) console.log('\n  (Dry run — nothing was changed)');
}

main().catch(err => {
  console.error('Migration failed:', err.message);
  process.exit(1);
});
