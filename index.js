/**
 * MoltAgent NC Deck Integration
 * 
 * Provides task management capabilities via Nextcloud Deck.
 * 
 * @example
 * const { DeckClient, DeckTaskProcessor, setupDeckBoard } = require('moltagent-deck');
 * 
 * // Initialize client
 * const deck = new DeckClient(config);
 * await deck.ensureBoard();
 * 
 * // Create a task
 * await deck.createCard('inbox', {
 *   title: 'My Task',
 *   description: 'Details here',
 *   labels: ['research']
 * });
 * 
 * // Or use the task processor for automated handling
 * const processor = new DeckTaskProcessor(config, router, auditLog);
 * await processor.initialize();
 * await processor.processInbox();
 * 
 * @module moltagent-deck
 */

const DeckClient = require('./src/lib/integrations/deck-client');
const DeckTaskProcessor = require('./src/lib/integrations/deck-task-processor');
const setupDeckBoard = require('./scripts/setup-deck-board');

module.exports = {
  // Main client for direct API access
  DeckClient,
  
  // Error class for API errors
  DeckApiError: DeckClient.DeckApiError,
  
  // Task processor for automated handling
  DeckTaskProcessor,
  
  // Error class for human input required
  HumanInputRequired: DeckTaskProcessor.HumanInputRequired,
  
  // Setup function
  setupDeckBoard,
  
  // Verification function
  verifyDeckSetup: setupDeckBoard.verifyDeckSetup
};
