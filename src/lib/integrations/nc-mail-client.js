/*
 * Moltagent - Sovereign AI Security Layer
 * Copyright (C) 2026 Moltagent Contributors
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU Affero General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the
 * GNU Affero General Public License for more details.
 */

/**
 * Moltagent NC Mail Client
 *
 * Architecture Brief:
 * -------------------
 * Problem: Email-trigger-ingested Deck cards need a best-effort deep link back
 * to the original message in the Nextcloud Mail app so operators can open the
 * source email in one click from the card description.
 *
 * Pattern: Thin API client over NCRequestManager — same structure as
 * NewsClient and DeckClient. All methods are best-effort: every error path
 * returns null rather than throwing, so the caller (WorkflowEngine) can always
 * continue card ingestion even when the Mail API is unavailable or the message
 * has not yet synced.
 *
 * Key Dependencies:
 *   - NCRequestManager (injected): .request(path, opts) for all API calls;
 *     .ncUrl exposed as the Nextcloud base URL for link construction.
 *
 * Data Flow:
 *   resolveMailbox(folder)
 *     → GET /index.php/apps/mail/api/accounts          (list accounts)
 *     → GET /index.php/apps/mail/api/mailboxes?accountId={id}
 *       (find mailbox whose name === folder, return {accountId, mailboxId})
 *
 *   resolveMessageDatabaseId(mailboxId, messageId)
 *     → GET /index.php/apps/mail/api/messages?mailboxId={id}&limit=50
 *       (find message by normalized Message-ID header, return databaseId)
 *
 *   resolveThreadUrl(folder, messageId)
 *     → resolveMailbox + resolveMessageDatabaseId
 *     → {ncUrl}/apps/mail/box/{mailboxId}/thread/{databaseId}
 *
 * Dependency Map:
 *   NCMailClient
 *     ← WorkflowEngine (_ingestTriggerEmails: append link to card description)
 *     → NCRequestManager (all HTTP calls)
 *
 * @module integrations/nc-mail-client
 * @version 1.0.0
 */

'use strict';

class NCMailClient {
  /**
   * Create a new NC Mail client.
   * @param {Object} ncRequestManager - NCRequestManager instance with .request() method and .ncUrl string
   */
  constructor(ncRequestManager) {
    this.nc = ncRequestManager;
  }

  /**
   * Issue a GET request to a NC Mail API path and return the parsed JSON body,
   * or null on any non-2xx status or parse/network error. Never throws.
   * @param {string} path - Full API path, e.g. '/index.php/apps/mail/api/accounts'
   * @returns {Promise<*|null>} Parsed JSON value or null
   * @private
   */
  async _getJson(path) {
    try {
      const response = await this.nc.request(path, {
        method: 'GET',
        headers: {
          'OCS-APIRequest': 'true',
          'Accept': 'application/json'
        }
      });
      if (!response || response.status < 200 || response.status >= 300) {
        return null;
      }
      const raw = response.body;
      if (raw === null || raw === undefined) return null;
      if (typeof raw === 'string') {
        return JSON.parse(raw);
      }
      // Already parsed (some NCRequestManager implementations return an object)
      return raw;
    } catch (_) {
      return null;
    }
  }

  /**
   * Resolve the numeric mailbox id for a given IMAP folder name.
   *
   * Iterates all accounts, then for each account fetches the mailbox list and
   * looks for a mailbox whose `name` exactly matches `folder`. Returns on the
   * first match across all accounts.
   *
   * @param {string} folder - Full IMAP folder path, e.g. 'INBOX.INQUIRIES'
   * @returns {Promise<{accountId: number, mailboxId: number}|null>}
   */
  async resolveMailbox(folder) {
    const accounts = await this._getJson('/index.php/apps/mail/api/accounts');
    if (!Array.isArray(accounts)) return null;

    for (const account of accounts) {
      const accountId = account && account.id;
      if (accountId == null) continue;

      const mbData = await this._getJson(
        `/index.php/apps/mail/api/mailboxes?accountId=${encodeURIComponent(accountId)}`
      );
      // The mailboxes endpoint returns an object with a `mailboxes` array.
      const mailboxes = mbData && Array.isArray(mbData.mailboxes) ? mbData.mailboxes : null;
      if (!mailboxes) continue;

      for (const mb of mailboxes) {
        if (mb && mb.name === folder) {
          return { accountId, mailboxId: mb.databaseId };
        }
      }
    }
    return null;
  }

  /**
   * Find the numeric database id of a message in a given mailbox by its
   * RFC 822 Message-ID header value.
   *
   * Normalization: trim whitespace and strip ONE layer of surrounding angle
   * brackets from both the stored `messageId` field and the caller-supplied
   * `messageId` before comparing, so `<abc@host>` and `abc@host` both match.
   *
   * @param {number} mailboxId - The mailbox databaseId returned by resolveMailbox
   * @param {string} messageId - RFC 822 Message-ID value (with or without angle brackets)
   * @returns {Promise<number|null>} The message's databaseId, or null if not found
   */
  async resolveMessageDatabaseId(mailboxId, messageId) {
    // Best-effort: scan the most recent 50 messages (newest-first). A just-
    // ingested email is near the top; a Message-ID older than this window
    // won't resolve and the caller keeps the Message-ID footer as fallback.
    const messages = await this._getJson(
      `/index.php/apps/mail/api/messages?mailboxId=${encodeURIComponent(mailboxId)}&limit=50`
    );
    if (!Array.isArray(messages)) return null;

    const normalize = (id) => {
      if (!id) return '';
      const trimmed = String(id).trim();
      // Strip one layer of surrounding angle brackets
      return trimmed.startsWith('<') && trimmed.endsWith('>')
        ? trimmed.slice(1, -1)
        : trimmed;
    };

    const needle = normalize(messageId);
    for (const msg of messages) {
      if (msg && normalize(msg.messageId) === needle) {
        return msg.databaseId;
      }
    }
    return null;
  }

  /**
   * Best-effort: resolve a deep-link URL to a message thread in NC Mail.
   *
   * Returns null (never throws) on any error, missing account/mailbox, or
   * message not yet synced. The caller keeps the existing footer as-is when
   * null is returned.
   *
   * @param {string} folder   - IMAP folder name from the TRIGGER: line locator
   * @param {string} messageId - RFC 822 Message-ID header value of the email
   * @returns {Promise<string|null>} Deep-link URL or null
   */
  async resolveThreadUrl(folder, messageId) {
    if (!folder || !messageId) return null;
    try {
      const mailbox = await this.resolveMailbox(folder);
      if (!mailbox) return null;

      const databaseId = await this.resolveMessageDatabaseId(mailbox.mailboxId, messageId);
      if (databaseId == null) return null;

      return `${this.nc.ncUrl}/apps/mail/box/${mailbox.mailboxId}/thread/${databaseId}`;
    } catch (_) {
      return null;
    }
  }
}

module.exports = NCMailClient;
