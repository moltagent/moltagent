/**
 * MoltAgent CalDAV & Heartbeat Integration
 * 
 * Exports:
 * - CalDAVClient: Full calendar operations
 * - HeartbeatManager: Periodic background operations
 */

const CalDAVClient = require('./src/lib/integrations/caldav-client');
const HeartbeatManager = require('./src/lib/integrations/heartbeat-manager');

module.exports = {
  CalDAVClient,
  HeartbeatManager
};
