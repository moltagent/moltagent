'use strict';

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
 * OCS response reader — one home for unwrapping the Nextcloud OCS envelope.
 *
 * Architecture Brief:
 * -------------------
 * Problem: an `NCRequestManager.request()` response carries `body` that may be a
 * pre-parsed object OR a raw JSON string, depending on the response. Two
 * consumers read the same shape and diverged: the Talk history reader
 * (`conversation-context.js`) parsed defensively, while the room-behaviour
 * addressing gate (`message-processor._getRoomBehavior`) trusted
 * `response.body?.ocs?.data` directly. When `body` arrived as a string the
 * trusting reader silently got `undefined`, and its addressing gate fell open to
 * respond-to-all in every group room (#301).
 *
 * Pattern: consolidate the read here so both consumers import ONE tolerant
 * reader; a third consumer inherits the tolerance for free. This is the
 * signals-keep-custody archetype (#49 family) applied to a wire shape — a truth
 * read one way in one place and another way in another births exactly this
 * class of divergence.
 *
 * @module shared/ocs-response
 */

/**
 * Unwrap the OCS `.ocs.data` payload from an NCRequestManager response,
 * tolerating `body` as a parsed object or a raw JSON string.
 *
 * @param {{body?: any}|null} response - The NCRequestManager response
 * @returns {any|null} the `.ocs.data` payload (array or object), or null when
 *   the shape is not an OCS envelope (caller decides the fallback)
 */
function ocsData(response) {
  if (!response) return null;

  let body = response.body;
  if (typeof body === 'string') {
    try {
      body = JSON.parse(body);
    } catch {
      return null;
    }
  }

  if (body && typeof body === 'object') {
    return body.ocs?.data ?? null;
  }
  return null;
}

module.exports = { ocsData };
