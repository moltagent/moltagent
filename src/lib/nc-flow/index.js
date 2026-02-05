/*
 * Moltagent - Sovereign AI Security Layer
 * Copyright (C) 2026 Moltagent Contributors
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU Affero General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 */

/**
 * NC Flow Module Index
 *
 * Exports all NC Flow integration components:
 * - WebhookReceiver: Dormant HTTP server for NC webhook events (NC 32+)
 * - ActivityPoller: Polls NC Activity API for workspace events (NC 31+)
 * - SystemTagsClient: Read/write NC SystemTags on files via WebDAV
 *
 * Usage:
 *   const { WebhookReceiver, ActivityPoller, SystemTagsClient } = require('./nc-flow');
 *
 * @module nc-flow
 * @version 1.0.0
 */

'use strict';

const { WebhookReceiver } = require('./webhook-receiver');
const { ActivityPoller } = require('./activity-poller');
const { SystemTagsClient } = require('./system-tags');

module.exports = {
  WebhookReceiver,
  ActivityPoller,
  SystemTagsClient,
};
