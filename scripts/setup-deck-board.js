#!/usr/bin/env node
/**
 * MoltAgent Deck Board Setup Script
 * 
 * Creates the MoltAgent Tasks board with proper structure:
 * - Stacks: Inbox, Queued, Working, Done, Reference
 * - Labels: urgent, research, writing, admin, blocked
 * - Welcome card with instructions
 * 
 * Usage:
 *   NC_URL=https://your-nc.example.com \
 *   MOLTAGENT_PASSWORD=your-password \
 *   node scripts/setup-deck-board.js
 * 
 * Or programmatically:
 *   const setupDeckBoard = require('./setup-deck-board');
 *   await setupDeckBoard(config);
 * 
 * @module setup-deck-board
 */

const DeckClient = require('../src/lib/integrations/deck-client');

/**
 * Setup the MoltAgent Tasks board
 * @param {Object} config - Configuration object
 * @param {Object} config.nextcloud - Nextcloud config
 * @param {string} config.nextcloud.url - Nextcloud URL
 * @param {string} [config.nextcloud.username] - Bot username (default: moltagent)
 * @param {Object|string} config.credentialBroker - Credential broker or direct password
 * @param {Object} [config.deck] - Deck-specific config
 * @param {boolean} [options.createWelcomeCard=true] - Create welcome card
 * @param {boolean} [options.verbose=true] - Verbose output
 * @returns {Promise<Object>} Setup result
 */
async function setupDeckBoard(config, options = {}) {
  const verbose = options.verbose !== false;
  const createWelcomeCard = options.createWelcomeCard !== false;
  
  if (verbose) {
    console.log('╔════════════════════════════════════════════════════════════╗');
    console.log('║           MoltAgent Deck Board Setup                       ║');
    console.log('╚════════════════════════════════════════════════════════════╝');
    console.log('');
  }

  const deck = new DeckClient(config);

  // Check if board already exists
  if (verbose) console.log('🔍 Checking for existing board...');
  
  const existingBoard = await deck.findBoard();

  if (existingBoard) {
    if (verbose) {
      console.log(`✓ Board "${deck.boardName}" already exists (ID: ${existingBoard.id})`);
      console.log('  Verifying structure...');
    }
    
    const { boardId, stacks, labels } = await deck.ensureBoard();
    
    if (verbose) {
      console.log('');
      console.log('📋 Board Structure Verified:');
      console.log(`   Board ID: ${boardId}`);
      console.log('   Stacks:');
      for (const [name, id] of Object.entries(stacks)) {
        console.log(`     • ${name}: ${id}`);
      }
      console.log('   Labels:');
      for (const [name, id] of Object.entries(labels)) {
        console.log(`     • ${name}: ${id}`);
      }
      console.log('');
      console.log('✅ Board ready!');
    }
    
    return { 
      boardId, 
      stacks, 
      labels,
      created: false,
      verified: true 
    };
  }

  // Create new board
  if (verbose) console.log(`📝 Creating board: ${deck.boardName}`);
  
  const { boardId, stacks, labels } = await deck.createBoard();

  if (verbose) {
    console.log('');
    console.log('✅ Board created successfully!');
    console.log(`   Board ID: ${boardId}`);
    console.log('   Stacks:');
    for (const [name, id] of Object.entries(stacks)) {
      console.log(`     • ${name}: ${id}`);
    }
    console.log('   Labels:');
    for (const [name, id] of Object.entries(labels)) {
      console.log(`     • ${name}: ${id}`);
    }
  }

  // Create welcome card
  if (createWelcomeCard) {
    if (verbose) console.log('');
    if (verbose) console.log('📝 Creating welcome card...');
    
    await deck.createCard('inbox', {
      title: '👋 Welcome to MoltAgent Tasks!',
      description: `# How to Use This Board

This board is where you assign tasks to your MoltAgent AI assistant.

## Workflow

1. **Create a card** in the **Inbox** column
2. Add a **clear title** describing what you need
3. Add **details** in the description
4. Optionally add **labels**: urgent, research, writing, admin
5. MoltAgent will process it automatically (within 5 minutes)

## Columns

| Column | Purpose |
|--------|---------|
| **Inbox** | New tasks for the bot to pick up |
| **Queued** | Accepted, waiting for capacity |
| **Working** | Currently being processed |
| **Done** | Completed tasks |
| **Reference** | Standing information |

## Labels

- 🔴 **urgent** — Process first
- 🔵 **research** — Research/investigation task
- 🟢 **writing** — Content creation
- ⚫ **admin** — File/organizational tasks
- 🟠 **blocked** — Waiting for human input

## Example Tasks

**Research Task:**
> Title: Find top 5 AI frameworks for enterprise
> Labels: research

**Writing Task:**
> Title: Draft email to client about project delay
> Labels: writing, urgent

## Tips

- Be specific in your task descriptions
- Add context the bot needs to help you
- Check comments on cards for status updates
- Cards with [QUESTION] need your input

---

*Delete this card when you're ready to start!*
`,
      labels: ['admin']
    });
    
    if (verbose) console.log('   Welcome card created!');
  }

  if (verbose) {
    console.log('');
    console.log('╔════════════════════════════════════════════════════════════╗');
    console.log('║  🎉 Setup Complete! Your MoltAgent Tasks board is ready.   ║');
    console.log('╚════════════════════════════════════════════════════════════╝');
    console.log('');
    console.log('Next steps:');
    console.log('  1. Open Nextcloud → Deck app');
    console.log('  2. Find the "MoltAgent Tasks" board');
    console.log('  3. Create your first task card!');
    console.log('');
  }
  
  return { 
    boardId, 
    stacks, 
    labels,
    created: true,
    welcomeCard: createWelcomeCard
  };
}

/**
 * Verify board exists and is healthy
 * @param {Object} config - Configuration
 * @returns {Promise<Object>} Health check result
 */
async function verifyDeckSetup(config) {
  const deck = new DeckClient(config);
  
  try {
    const board = await deck.findBoard();
    if (!board) {
      return { healthy: false, error: 'Board not found' };
    }
    
    const { stacks, labels } = await deck.ensureBoard();
    const requiredStacks = ['inbox', 'queued', 'working', 'done', 'reference'];
    const requiredLabels = ['urgent', 'research', 'writing', 'admin', 'blocked'];
    
    const missingStacks = requiredStacks.filter(s => !stacks[s]);
    const missingLabels = requiredLabels.filter(l => !labels[l]);
    
    if (missingStacks.length > 0 || missingLabels.length > 0) {
      return {
        healthy: false,
        error: 'Missing components',
        missingStacks,
        missingLabels
      };
    }
    
    return {
      healthy: true,
      boardId: board.id,
      stacks,
      labels
    };
    
  } catch (error) {
    return {
      healthy: false,
      error: error.message
    };
  }
}

// ============================================================
// CLI EXECUTION
// ============================================================

if (require.main === module) {
  // Parse environment variables
  const ncUrl = process.env.NC_URL;
  const password = process.env.MOLTAGENT_PASSWORD;
  const username = process.env.MOLTAGENT_USERNAME || 'moltagent';
  
  if (!ncUrl || !password) {
    console.error('Error: Missing required environment variables');
    console.error('');
    console.error('Usage:');
    console.error('  NC_URL=https://your-nc.example.com \\');
    console.error('  MOLTAGENT_PASSWORD=your-password \\');
    console.error('  [MOLTAGENT_USERNAME=moltagent] \\');
    console.error('  node scripts/setup-deck-board.js');
    console.error('');
    process.exit(1);
  }

  // Build config
  const config = {
    nextcloud: {
      url: ncUrl,
      username: username
    },
    credentialBroker: password, // Direct password for CLI
    deck: {
      boardName: process.env.DECK_BOARD_NAME || 'MoltAgent Tasks',
      archiveAfterDays: parseInt(process.env.DECK_ARCHIVE_DAYS) || 180
    }
  };

  // Run setup
  setupDeckBoard(config)
    .then(result => {
      console.log('');
      console.log('Result:', JSON.stringify(result, null, 2));
      process.exit(0);
    })
    .catch(error => {
      console.error('');
      console.error('❌ Setup failed:', error.message);
      if (error.statusCode) {
        console.error(`   HTTP Status: ${error.statusCode}`);
      }
      if (error.response) {
        console.error('   Response:', JSON.stringify(error.response, null, 2));
      }
      process.exit(1);
    });
}

module.exports = setupDeckBoard;
module.exports.verifyDeckSetup = verifyDeckSetup;
