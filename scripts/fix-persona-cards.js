#!/usr/bin/env node
/**
 * One-shot script: Persona Card UX Fix
 *
 * 1. Removes ⚙4 labels from Name and Language cards
 * 2. Adds "To change" instruction to dial card docs (Humor, Emoji, Verbosity, Formality)
 *
 * Usage: CREDENTIALS_DIRECTORY=/run/credentials/moltagent.service node scripts/fix-persona-cards.js
 */

'use strict';

const appConfig = require('../src/lib/config');

// New human-facing docs (below ---) for dial cards
const DIAL_DOCS = {
  Humor: 'How much humor your agent uses in conversation.\n⚙️1 keeps things strictly professional. ⚙️3 allows jokes,\nwordplay, and lighter moments when appropriate.\n\nTo change: remove the current label and add the one you want.',
  Emoji: 'Emoji usage in messages and comments. ⚙️1 means pure text.\n⚙️2 allows occasional emoji for emphasis. ⚙️3 uses them\nfreely for tone and visual scanning.\n\nTo change: remove the current label and add the one you want.',
  Verbosity: 'Response length preference. ⚙️1 gives the shortest useful\nanswer. ⚙️3 provides thorough explanations with context.\n⚙️2 adapts to the complexity of the question.\n\nTo change: remove the current label and add the one you want.',
  Formality: 'Communication tone. ⚙️1 for professional/client-facing work.\n⚙️3 for relaxed, conversational interaction. ⚙️2 reads the\nroom and adjusts.\n\nTo change: remove the current label and add the one you want.'
};

async function main() {
  const CredentialCache = require('../src/lib/credential-cache');
  const CredentialBroker = require('../src/lib/credential-broker');
  const NCRequestManager = require('../src/lib/nc-request-manager');
  const CockpitManager = require('../src/lib/integrations/cockpit-manager');
  const DeckClient = require('../src/lib/integrations/deck-client');

  console.log('[PersonaFix] Initializing...');

  // Set up NC connection
  const credentialCache = new CredentialCache({
    ncUrl: appConfig.nextcloud.url,
    ncUser: appConfig.nextcloud.username,
    cacheTTL: appConfig.cacheTTL.credentials
  });

  const credentialBroker = new CredentialBroker(credentialCache, {
    ncUrl: appConfig.nextcloud.url,
    ncUser: appConfig.nextcloud.username
  });

  const ncPassword = credentialBroker.getNCPassword();
  const ncRequestManager = new NCRequestManager({
    nextcloud: {
      url: appConfig.nextcloud.url,
      username: appConfig.nextcloud.username
    },
    ncResilience: { maxConcurrent: 2, maxQueueSize: 50, maxRetries: 2 }
  });
  ncRequestManager.ncPassword = ncPassword;

  // Initialize CockpitManager to find the board
  const deckClient = new DeckClient(ncRequestManager, {
    boardName: appConfig.cockpit?.boardTitle || 'Moltagent Cockpit'
  });
  const cockpit = new CockpitManager({ deckClient });
  await cockpit.initialize();

  const boardId = cockpit.boardId;
  const personaStackId = cockpit.stacks.persona;
  console.log(`[PersonaFix] Board ID: ${boardId}, Persona stack: ${personaStackId}`);

  // Fetch current cards
  const stacks = await deckClient.getStacks(boardId);
  const personaStack = stacks.find(s => s.id === personaStackId);
  if (!personaStack) {
    console.error('[PersonaFix] Persona stack not found!');
    process.exit(1);
  }

  const cards = personaStack.cards || [];
  console.log(`[PersonaFix] Found ${cards.length} cards in Persona stack`);

  // --- Part 1: Remove ⚙4 labels from Name and Language ---
  const labelRemoveTargets = ['Name', 'Language'];
  for (const title of labelRemoveTargets) {
    const card = cards.find(c => c.title === title);
    if (!card) {
      console.warn(`[PersonaFix] SKIP: Card "${title}" not found`);
      continue;
    }

    const gear4Label = (card.labels || []).find(l => l.title === '⚙️4');
    if (!gear4Label) {
      console.log(`[PersonaFix] OK: "${title}" has no ⚙4 label (already clean)`);
      continue;
    }

    try {
      const removePath = `/index.php/apps/deck/api/v1.0/boards/${boardId}/stacks/${personaStackId}/cards/${card.id}/removeLabel`;
      await deckClient._request('PUT', removePath, { labelId: gear4Label.id });
      console.log(`[PersonaFix] OK: Removed ⚙4 label from "${title}"`);
    } catch (err) {
      console.error(`[PersonaFix] FAIL: Could not remove label from "${title}" — ${err.message}`);
    }
  }

  // --- Part 2: Update dial card descriptions ---
  let updated = 0;
  for (const [title, newDocs] of Object.entries(DIAL_DOCS)) {
    const card = cards.find(c => c.title === title);
    if (!card) {
      console.warn(`[PersonaFix] SKIP: Card "${title}" not found`);
      continue;
    }

    // Preserve behavioral content above ---
    const existingParts = (card.description || '').split('---');
    const behavioral = existingParts[0].trim();
    const newDescription = `${behavioral}\n\n---\n\n${newDocs}`;

    try {
      const updatePath = `/index.php/apps/deck/api/v1.0/boards/${boardId}/stacks/${personaStackId}/cards/${card.id}`;
      await deckClient._request('PUT', updatePath, {
        title: card.title,
        description: newDescription,
        type: 'plain',
        owner: card.owner || 'moltagent'
      });
      console.log(`[PersonaFix] OK: "${title}" description updated`);
      updated++;
    } catch (err) {
      console.error(`[PersonaFix] FAIL: "${title}" — ${err.message}`);
    }
  }

  console.log(`\n[PersonaFix] Done: ${updated} descriptions updated, ${labelRemoveTargets.length} label removals attempted`);

  // Clean up
  ncRequestManager.shutdown();
  credentialBroker.discardAll();
}

main().catch(err => {
  console.error('[PersonaFix] Fatal:', err.message);
  process.exit(1);
});
