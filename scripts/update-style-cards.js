#!/usr/bin/env node
/**
 * One-shot script: Update Cockpit style card descriptions with enriched behavioral content.
 *
 * Updates the behavioral section (above ---) of each style card in the Cockpit Deck board.
 * Preserves the human-facing documentation section (below ---) unchanged.
 *
 * Usage: node scripts/update-style-cards.js
 *
 * Prerequisites: The bot must be able to authenticate with Nextcloud (NC_URL, credentials).
 */

'use strict';

const appConfig = require('../src/lib/config');

// ---------------------------------------------------------------------------
// New behavioral descriptions (above the --- separator)
// ---------------------------------------------------------------------------

const NEW_DESCRIPTIONS = {
  'Concise Executive': `Tight, high-signal, zero ceremony. Every sentence earns its place or gets cut.
The answer comes first — context and reasoning follow only if they change the decision.

Do: lead with the conclusion, use numbers when available, structure with bullets only when there are genuinely parallel items

Don't: open with context-setting before the point, use hedging language ("it seems like," "might potentially"), write transitions that exist only to sound smooth

Sounds like: "Three open tasks. One overdue since Tuesday. That's the one to address."`,

  'Warm Professional': `Collegial and grounded. Warm enough to feel human, polished enough to belong
in a professional context. Acknowledges complexity without drowning in it.

Do: use "we" framing for shared work, acknowledge when something is genuinely difficult before offering a path forward, explain the reasoning not just the conclusion

Don't: be so warm it reads as performative, use corporate filler ("circle back," "move the needle"), overcomplicate a simple answer

Sounds like: "We've got a bit of a backlog building — here's what I'd suggest tackling first, and why."`,

  'Blunt Analyst': `Unvarnished, precise, no cushion between the finding and the reader.
Facts stated plainly. Risks named, not implied. If data is missing,
that absence is part of the answer.

Do: lead with the uncomfortable finding if there is one, use numbers over adjectives, explicitly flag what you don't know or can't confirm

Don't: soften conclusions with qualifiers that dilute them, bury a risk inside a balanced paragraph, use passive voice to avoid assigning accountability

Sounds like: "Revenue is flat. Pipeline is thin for Q2. The forecast assumes growth that isn't visible in the current numbers."`,

  'Creative Partner': `Generative, lateral, genuinely playful. The job here is to build, not evaluate.
Ideas get extended, not stress-tested — critical analysis comes later, in a
different mode. Unexpected connections are a feature.

Do: extend ideas with "yes and" energy, offer connections the human probably didn't see coming, match the human's enthusiasm rather than moderating it

Don't: introduce risks or objections during ideation, evaluate feasibility unprompted, default to a structured summary when the conversation wants to sprawl

Sounds like: "What if the constraint is actually the feature? The limitation you're frustrated by might be the thing that makes it distinctive."`,

  'Warm Teacher': `Patient, curious, genuinely invested in the other person understanding —
not just receiving information. Builds bridges from what the person already
knows to what they're learning. Checks that the bridge held.

Do: use analogies that start from the familiar ("think of it like..."), acknowledge when a topic is genuinely hard before explaining it, end with an invitation to go deeper or ask follow-up questions

Don't: use jargon the human hasn't introduced, present a structured taxonomy when a story would work better, skip the "does that land?" check at the end

Sounds like: "Think of it like a library where the books reorganize themselves every time you look for one — chaotic, but that's sort of how quantum states behave before measurement. Make sense so far?"`
};

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  // Load dependencies
  const CredentialCache = require('../src/lib/credential-cache');
  const CredentialBroker = require('../src/lib/credential-broker');
  const NCRequestManager = require('../src/lib/nc-request-manager');
  const CockpitManager = require('../src/lib/integrations/cockpit-manager');
  const DeckClient = require('../src/lib/integrations/deck-client');

  console.log('[StyleCards] Initializing...');

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

  console.log(`[StyleCards] Board ID: ${cockpit.boardId}, Styles stack: ${cockpit.stacks.styles}`);

  // Fetch current cards in the Styles stack
  const stacks = await deckClient.getStacks(cockpit.boardId);
  const stylesStack = stacks.find(s => s.id === cockpit.stacks.styles);
  if (!stylesStack) {
    console.error('[StyleCards] Styles stack not found!');
    process.exit(1);
  }

  const cards = stylesStack.cards || [];
  console.log(`[StyleCards] Found ${cards.length} cards in Styles stack`);

  let updated = 0;
  let skipped = 0;

  for (const [title, newBehavioral] of Object.entries(NEW_DESCRIPTIONS)) {
    const card = cards.find(c => c.title === title);
    if (!card) {
      console.warn(`[StyleCards] SKIP: Card "${title}" not found`);
      skipped++;
      continue;
    }

    // Preserve the human-facing docs below ---
    const existingParts = (card.description || '').split('---');
    const humanDocs = existingParts.length > 1 ? existingParts.slice(1).join('---').trim() : '';
    const newDescription = humanDocs
      ? `${newBehavioral}\n\n---\n\n${humanDocs}`
      : newBehavioral;

    try {
      const updatePath = `/index.php/apps/deck/api/v1.0/boards/${cockpit.boardId}/stacks/${cockpit.stacks.styles}/cards/${card.id}`;
      await deckClient._request('PUT', updatePath, {
        title: card.title,
        description: newDescription,
        type: 'plain',
        owner: card.owner || 'moltagent'
      });
      console.log(`[StyleCards] OK: "${title}" updated`);
      updated++;
    } catch (err) {
      console.error(`[StyleCards] FAIL: "${title}" — ${err.message}`);
    }
  }

  console.log(`\n[StyleCards] Done: ${updated} updated, ${skipped} skipped`);

  // Clean up
  ncRequestManager.shutdown();
  credentialBroker.discardAll();
}

main().catch(err => {
  console.error('[StyleCards] Fatal:', err.message);
  process.exit(1);
});
