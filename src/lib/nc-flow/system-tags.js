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
 * NC Flow SystemTags Client
 *
 * Architecture Brief:
 * -------------------
 * Problem: Moltagent needs to tag files with processing status (pending,
 * processed, needs-review, ai-flagged) using NC SystemTags. Tags are
 * managed via WebDAV PROPFIND/PROPPATCH, not OCS, because the OCS endpoint
 * does not support SystemTags operations (confirmed in field testing).
 *
 * Pattern: Stateless client wrapping WebDAV calls via NCRequestManager.
 * Maintains an in-memory tag name-to-ID mapping loaded from config and
 * refreshable at runtime via PROPFIND on /remote.php/dav/systemtags/.
 *
 * Key Dependencies:
 * - NCRequestManager (for WebDAV API calls)
 *
 * Data Flow:
 * - Tag lookup: getTagId(name) -> local Map (no network)
 * - Tag assignment: assignTag(fileId, tagName) -> PUT /remote.php/dav/systemtags-relations/files/{fileId}/{tagId}
 * - Tag removal: removeTag(fileId, tagName) -> DELETE /remote.php/dav/systemtags-relations/files/{fileId}/{tagId}
 * - Tag transition: transitionTags() -> removeTag() then assignTag()
 * - File ID resolution: getFileId(path) -> PROPFIND /remote.php/dav/files/{user}{path}
 * - Tag refresh: refreshTagIds() -> PROPFIND /remote.php/dav/systemtags/
 *
 * Integration Points:
 * - src/lib/nc-flow/index.js (module export)
 * - src/lib/nc-request-manager.js (WebDAV calls)
 * - HeartbeatManager (called when processing files, wired in a separate session)
 *
 * Pre-Created Tags (instance-specific IDs from config):
 * | Tag            | Meaning                          |
 * |----------------|----------------------------------|
 * | pending        | Waiting for Moltagent to process  |
 * | processed      | AI processing complete            |
 * | needs-review   | Human attention required           |
 * | ai-flagged     | Something unusual detected         |
 *
 * @module nc-flow/system-tags
 * @version 1.0.0
 */

'use strict';

class SystemTagsClient {
  /**
   * @param {Object} config - ncFlow.tags config section
   * @param {boolean} [config.enabled=true] - Whether tag operations are enabled
   * @param {Object<string, number>} [config.tagIds={}] - Tag name to ID mapping from deployment
   * @param {Object} ncRequestManager - NCRequestManager instance for WebDAV API calls
   * @param {Object} [logger] - Optional logger (defaults to console)
   */
  constructor(config, ncRequestManager, logger) {
    this.config = config || {};
    this.nc = ncRequestManager;
    this.logger = logger || console;
    this.enabled = this.config.enabled !== false;

    /** @type {Map<string, number>} Tag name -> ID mapping */
    this.tagIds = new Map(Object.entries(this.config.tagIds || {}));

    /** @type {Map<number, string>} Reverse mapping: Tag ID -> name */
    this.tagNames = new Map();
    for (const [name, id] of this.tagIds) {
      this.tagNames.set(id, name);
    }
  }

  /**
   * Get tag ID by name from the local cache.
   * @param {string} name - Tag name (e.g. 'pending')
   * @returns {number|null} Tag ID, or null if not found
   */
  getTagId(name) {
    return this.tagIds.get(name) || null;
  }

  /**
   * Get tag name by ID from the local cache.
   * @param {number} id - Tag ID
   * @returns {string|null} Tag name, or null if not found
   */
  getTagName(id) {
    return this.tagNames.get(id) || null;
  }

  /**
   * Refresh tag ID mapping from the NC server.
   * Performs a PROPFIND on /remote.php/dav/systemtags/ to fetch all tags,
   * then updates the local tagIds and tagNames maps.
   *
   * Call this during startup or if tags are added/modified dynamically.
   *
   * @returns {Promise<Map<string, number>>} Updated tag name-to-ID mapping
   */
  async refreshTagIds() {
    const xml = `<?xml version="1.0"?>
<d:propfind xmlns:d="DAV:" xmlns:oc="http://owncloud.org/ns">
  <d:prop>
    <oc:display-name/>
    <oc:id/>
    <oc:user-visible/>
    <oc:user-assignable/>
  </d:prop>
</d:propfind>`;

    const response = await this.nc.request('/remote.php/dav/systemtags/', {
      method: 'PROPFIND',
      headers: {
        'Content-Type': 'application/xml',
        'Depth': '1'
      },
      body: xml,
      endpointGroup: 'webdav',
      cacheTtlMs: 300000  // Cache tag list for 5 minutes
    });

    const body = typeof response.text === 'function' ? await response.text() : String(response);
    const tags = this._parseTagsPropfind(body);

    this.tagIds.clear();
    this.tagNames.clear();
    for (const tag of tags) {
      this.tagIds.set(tag.name, tag.id);
      this.tagNames.set(tag.id, tag.name);
    }

    this.logger.info(`[SystemTags] Refreshed: ${this.tagIds.size} tags loaded`);
    return this.tagIds;
  }

  /**
   * Get all tags assigned to a file.
   * @param {number} fileId - NC file ID
   * @returns {Promise<Array<{id: number, name: string}>>} List of tags on the file
   */
  async getFileTags(fileId) {
    const xml = `<?xml version="1.0"?>
<d:propfind xmlns:d="DAV:" xmlns:oc="http://owncloud.org/ns">
  <d:prop>
    <oc:display-name/>
    <oc:id/>
  </d:prop>
</d:propfind>`;

    const response = await this.nc.request(
      `/remote.php/dav/systemtags-relations/files/${fileId}`,
      {
        method: 'PROPFIND',
        headers: {
          'Content-Type': 'application/xml',
          'Depth': '1'
        },
        body: xml,
        endpointGroup: 'webdav'
      }
    );

    const body = typeof response.text === 'function' ? await response.text() : String(response);
    return this._parseTagsPropfind(body);
  }

  /**
   * Assign a tag to a file.
   * Sends PUT to /remote.php/dav/systemtags-relations/files/{fileId}/{tagId}.
   *
   * Handles 409 Conflict gracefully (tag already assigned = success).
   *
   * @param {number} fileId - NC file ID
   * @param {string} tagName - Tag name (e.g. 'processed')
   * @returns {Promise<boolean>} true if tag was assigned (or already assigned), false on error
   */
  async assignTag(fileId, tagName) {
    const tagId = this.getTagId(tagName);
    if (!tagId) {
      this.logger.error(`[SystemTags] Unknown tag: ${tagName}`);
      return false;
    }

    try {
      await this.nc.request(
        `/remote.php/dav/systemtags-relations/files/${fileId}/${tagId}`,
        {
          method: 'PUT',
          endpointGroup: 'webdav'
        }
      );
      this.logger.info(`[SystemTags] Tagged file ${fileId} as '${tagName}'`);
      return true;
    } catch (err) {
      // 409 Conflict means already tagged — that's fine
      if (err.status === 409) {
        this.logger.info(`[SystemTags] File ${fileId} already tagged '${tagName}'`);
        return true;
      }
      this.logger.error(`[SystemTags] Failed to tag file ${fileId}:`, err.message);
      return false;
    }
  }

  /**
   * Remove a tag from a file.
   * Sends DELETE to /remote.php/dav/systemtags-relations/files/{fileId}/{tagId}.
   *
   * Handles 404 gracefully (tag was not assigned = success).
   *
   * @param {number} fileId - NC file ID
   * @param {string} tagName - Tag name
   * @returns {Promise<boolean>} true if tag was removed (or was not assigned), false on error
   */
  async removeTag(fileId, tagName) {
    const tagId = this.getTagId(tagName);
    if (!tagId) {
      this.logger.error(`[SystemTags] Unknown tag: ${tagName}`);
      return false;
    }

    try {
      await this.nc.request(
        `/remote.php/dav/systemtags-relations/files/${fileId}/${tagId}`,
        {
          method: 'DELETE',
          endpointGroup: 'webdav'
        }
      );
      this.logger.info(`[SystemTags] Removed '${tagName}' from file ${fileId}`);
      return true;
    } catch (err) {
      // 404 means tag wasn't assigned — that's fine
      if (err.status === 404) {
        return true;
      }
      this.logger.error(`[SystemTags] Failed to remove tag from file ${fileId}:`, err.message);
      return false;
    }
  }

  /**
   * Transition a file's tag state.
   * Removes old tag(s) and assigns new tag(s) sequentially.
   *
   * Example: transitionTags(fileId, 'pending', 'processed')
   * Example: transitionTags(fileId, 'pending', ['processed', 'ai-flagged'])
   *
   * @param {number} fileId - NC file ID
   * @param {string|string[]} fromTags - Tag(s) to remove
   * @param {string|string[]} toTags - Tag(s) to assign
   * @returns {Promise<boolean>} true if all operations succeeded
   */
  async transitionTags(fileId, fromTags, toTags) {
    const froms = Array.isArray(fromTags) ? fromTags : [fromTags];
    const tos = Array.isArray(toTags) ? toTags : [toTags];

    // Remove old tags
    for (const tag of froms) {
      await this.removeTag(fileId, tag);
    }

    // Assign new tags
    for (const tag of tos) {
      const success = await this.assignTag(fileId, tag);
      if (!success) return false;
    }

    this.logger.info(`[SystemTags] File ${fileId}: ${froms.join(',')} → ${tos.join(',')}`);
    return true;
  }

  /**
   * Check if a file has a specific tag.
   * @param {number} fileId - NC file ID
   * @param {string} tagName - Tag name to check
   * @returns {Promise<boolean>} true if the file has the tag
   */
  async hasTag(fileId, tagName) {
    const tags = await this.getFileTags(fileId);
    return tags.some(t => t.name === tagName);
  }

  /**
   * Get the NC file ID for a given WebDAV path.
   * Needed because tag operations use numeric file IDs, not paths.
   *
   * Sends PROPFIND to /remote.php/dav/files/{user}{filePath} requesting oc:fileid.
   *
   * @param {string} filePath - Path relative to user root (e.g. '/Inbox/report.pdf')
   * @param {string} [user] - NC username (defaults to ncRequestManager's configured user)
   * @returns {Promise<number|null>} File ID, or null if file not found or error
   */
  async getFileId(filePath, user) {
    const ncUser = user || this.nc.config?.nextcloud?.user || 'moltagent';

    const xml = `<?xml version="1.0"?>
<d:propfind xmlns:d="DAV:" xmlns:oc="http://owncloud.org/ns">
  <d:prop>
    <oc:fileid/>
  </d:prop>
</d:propfind>`;

    try {
      const response = await this.nc.request(
        `/remote.php/dav/files/${encodeURI(ncUser)}${encodeURI(filePath)}`,
        {
          method: 'PROPFIND',
          headers: {
            'Content-Type': 'application/xml',
            'Depth': '0'
          },
          body: xml,
          endpointGroup: 'webdav'
        }
      );

      const body = typeof response.text === 'function' ? await response.text() : String(response);
      const match = body.match(/<oc:fileid>(\d+)<\/oc:fileid>/);
      return match ? parseInt(match[1], 10) : null;
    } catch (err) {
      this.logger.error(`[SystemTags] Failed to get file ID for ${filePath}:`, err.message);
      return null;
    }
  }

  /**
   * Convenience: Tag a file by its WebDAV path (resolves file ID automatically).
   * @param {string} filePath - Path relative to user root
   * @param {string} tagName - Tag name to assign
   * @returns {Promise<boolean>} true if successful
   */
  async tagFileByPath(filePath, tagName) {
    const fileId = await this.getFileId(filePath);
    if (!fileId) {
      this.logger.error(`[SystemTags] Could not resolve file ID for: ${filePath}`);
      return false;
    }
    return this.assignTag(fileId, tagName);
  }

  /**
   * Convenience: Transition tags on a file identified by its WebDAV path.
   * @param {string} filePath - Path relative to user root
   * @param {string|string[]} fromTags - Tag(s) to remove
   * @param {string|string[]} toTags - Tag(s) to assign
   * @returns {Promise<boolean>} true if successful
   */
  async transitionTagsByPath(filePath, fromTags, toTags) {
    const fileId = await this.getFileId(filePath);
    if (!fileId) {
      this.logger.error(`[SystemTags] Could not resolve file ID for: ${filePath}`);
      return false;
    }
    return this.transitionTags(fileId, fromTags, toTags);
  }

  /**
   * Parse a WebDAV PROPFIND multistatus XML response for tag data.
   * Extracts oc:display-name and oc:id from each d:response block.
   *
   * @param {string} xml - Raw XML response body
   * @returns {Array<{id: number, name: string}>} Parsed tags
   * @private
   */
  _parseTagsPropfind(xml) {
    const tags = [];
    // Match all response blocks that contain tag data
    const responseRegex = /<d:response>([\s\S]*?)<\/d:response>/g;
    let match;

    while ((match = responseRegex.exec(xml)) !== null) {
      const block = match[1];

      // Extract display-name and id
      const nameMatch = block.match(/<oc:display-name>(.*?)<\/oc:display-name>/);
      const idMatch = block.match(/<oc:id>(\d+)<\/oc:id>/);

      if (nameMatch && idMatch) {
        tags.push({
          name: nameMatch[1],
          id: parseInt(idMatch[1], 10)
        });
      }
    }

    return tags;
  }
}

module.exports = { SystemTagsClient };
