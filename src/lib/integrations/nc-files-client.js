'use strict';

/**
 * NCFilesClient - WebDAV File Operations + OCS Share API
 *
 * Provides file CRUD, metadata, and sharing via Nextcloud WebDAV and OCS APIs.
 * Uses NCRequestManager for all HTTP requests.
 *
 * @module integrations/nc-files-client
 * @version 1.0.0
 */

class NCFilesError extends Error {
  constructor(message, statusCode) {
    super(message);
    this.name = 'NCFilesError';
    this.statusCode = statusCode;
  }
}

class NCFilesClient {
  /**
   * @param {import('../nc-request-manager')} ncRequestManager
   * @param {Object} [config={}]
   * @param {string} [config.username] - NC username (default: from ncRequestManager)
   * @param {number} [config.maxContentSize=51200] - Max text content size (bytes)
   */
  constructor(ncRequestManager, config = {}) {
    this.nc = ncRequestManager;
    this.username = config.username || ncRequestManager.ncUser || 'moltagent';
    this.maxContentSize = config.maxContentSize || 51200; // 50KB

    // Root directory cache for fuzzy path resolution
    this._rootCache = null;
    this._rootCacheExpiry = 0;
    this.ROOT_CACHE_TTL = config.rootCacheTTL || 5 * 60 * 1000; // 5 minutes
  }

  // ===========================================================================
  // Private Helpers
  // ===========================================================================

  /**
   * Build WebDAV path for a relative file path.
   * @param {string} relativePath
   * @returns {string}
   */
  _davPath(relativePath) {
    const clean = (relativePath || '').replace(/^\/+/, '');
    return `/remote.php/dav/files/${this.username}/${clean}`;
  }

  /**
   * Build full URL for MOVE/COPY Destination header.
   * @param {string} relativePath
   * @returns {string}
   */
  _davUrl(relativePath) {
    const clean = (relativePath || '').replace(/^\/+/, '');
    return `${this.nc.ncUrl}/remote.php/dav/files/${this.username}/${clean}`;
  }

  /**
   * Make a request through NCRequestManager with error normalization.
   * NCRequestManager rejects on 403 but resolves on 404.
   * @param {string} path
   * @param {Object} options
   * @returns {Promise<Object>}
   */
  async _request(path, options = {}) {
    try {
      const response = await this.nc.request(path, options);

      // NCRequestManager resolves 404 — convert to error
      if (response.status === 404) {
        throw new NCFilesError('File not found', 404);
      }

      return response;
    } catch (err) {
      // Already an NCFilesError
      if (err instanceof NCFilesError) throw err;

      // NCRequestManager rejects on 403 with "Authentication error: 403"
      const statusMatch = err.message && err.message.match(/(\d{3})/);
      if (statusMatch) {
        const code = parseInt(statusMatch[1], 10);
        if (code === 403) {
          throw new NCFilesError('Permission denied', 403);
        }
        if (code === 401) {
          throw new NCFilesError('Authentication failed', 401);
        }
      }

      throw err;
    }
  }

  /**
   * Parse PROPFIND XML response using regex (follows CalDAVClient pattern).
   * @param {string} xml
   * @returns {Array<Object>}
   */
  _parsePropfindResponse(xml) {
    const entries = [];
    // Split on <d:response> elements
    const responseBlocks = xml.split(/<d:response>/gi).slice(1);

    for (const block of responseBlocks) {
      const entry = {};

      // Extract href
      const hrefMatch = block.match(/<d:href>([^<]+)<\/d:href>/i);
      entry.href = hrefMatch ? decodeURIComponent(hrefMatch[1]) : '';

      // Extract displayname
      const nameMatch = block.match(/<d:displayname>([^<]*)<\/d:displayname>/i);
      entry.displayname = nameMatch ? nameMatch[1] : '';

      // Extract content length
      const sizeMatch = block.match(/<d:getcontentlength>(\d+)<\/d:getcontentlength>/i);
      entry.size = sizeMatch ? parseInt(sizeMatch[1], 10) : 0;

      // Extract oc:size (for directories)
      if (!sizeMatch) {
        const ocSizeMatch = block.match(/<oc:size>(\d+)<\/oc:size>/i);
        entry.size = ocSizeMatch ? parseInt(ocSizeMatch[1], 10) : 0;
      }

      // Extract last modified
      const modMatch = block.match(/<d:getlastmodified>([^<]+)<\/d:getlastmodified>/i);
      entry.lastModified = modMatch ? modMatch[1] : '';

      // Extract content type
      const typeMatch = block.match(/<d:getcontenttype>([^<]+)<\/d:getcontenttype>/i);
      entry.contentType = typeMatch ? typeMatch[1] : '';

      // Extract resource type (directory check)
      entry.isDirectory = /<d:collection\s*\/>/i.test(block);

      // Extract permissions
      const permMatch = block.match(/<oc:permissions>([^<]*)<\/oc:permissions>/i);
      entry.permissions = permMatch ? permMatch[1] : '';

      entries.push(entry);
    }

    return entries;
  }

  /**
   * Check if permissions string allows writing.
   * @param {string} permissions
   * @returns {boolean}
   */
  _canWrite(permissions) {
    return (permissions || '').includes('W');
  }

  /**
   * Check if permissions string indicates shared.
   * @param {string} permissions
   * @returns {boolean}
   */
  _isShared(permissions) {
    return (permissions || '').includes('S');
  }

  // ===========================================================================
  // Root Cache & Fuzzy Path Resolution
  // ===========================================================================

  /**
   * Get cached root directory listing (auto-refreshes after TTL).
   * @returns {Promise<Array<{name: string, type: string}>>}
   */
  async getRootListing() {
    if (this._rootCache && Date.now() < this._rootCacheExpiry) {
      return this._rootCache;
    }

    const listing = await this.listDirectory('/');
    this._rootCache = listing;
    this._rootCacheExpiry = Date.now() + this.ROOT_CACHE_TTL;
    return listing;
  }

  /**
   * Invalidate the root directory cache.
   */
  invalidateRootCache() {
    this._rootCache = null;
    this._rootCacheExpiry = 0;
  }

  /**
   * Resolve a path using case-insensitive fuzzy matching.
   * Returns the corrected path if found, null if genuinely not found.
   *
   * @param {string} requestedPath - Path as provided by user/LLM
   * @returns {Promise<string|null>} Corrected path or null
   */
  async resolvePath(requestedPath) {
    if (!requestedPath || requestedPath === '/') return requestedPath;

    // Normalize: strip leading/trailing slashes
    const cleaned = requestedPath.replace(/^\/+|\/+$/g, '');

    // Try exact path first via PROPFIND Depth:0
    try {
      await this.getFileInfo(cleaned);
      return cleaned;
    } catch (err) {
      if (err.statusCode !== 404) throw err;
      // 404 — fall through to fuzzy matching
    }

    // Fuzzy: match first path segment against cached root listing
    const rootListing = await this.getRootListing();
    const segments = cleaned.split('/');
    const firstSegment = segments[0];

    const match = rootListing.find(
      entry => entry.name.toLowerCase() === firstSegment.toLowerCase()
    );

    if (match) {
      segments[0] = match.name;
      const correctedPath = segments.join('/');

      // Verify corrected path exists (for multi-segment paths)
      if (segments.length > 1) {
        try {
          await this.getFileInfo(correctedPath);
        } catch (err) {
          if (err.statusCode === 404) return null;
          throw err;
        }
      }

      return correctedPath;
    }

    return null;
  }

  /**
   * Get available root folder names (for error messages).
   * @returns {Promise<string[]>}
   */
  async getRootFolderNames() {
    const listing = await this.getRootListing();
    return listing.map(e => e.name);
  }

  // ===========================================================================
  // Public Methods
  // ===========================================================================

  /**
   * Read a text file. Returns content truncated at maxContentSize.
   * @param {string} filePath - Relative path
   * @returns {Promise<{content: string, truncated: boolean, totalSize: number}>}
   */
  async readFile(filePath) {
    const response = await this._request(this._davPath(filePath), {
      method: 'GET'
    });

    const body = typeof response.body === 'string'
      ? response.body
      : (response.body ? JSON.stringify(response.body) : '');
    const totalSize = Buffer.byteLength(body, 'utf-8');
    const truncated = totalSize > this.maxContentSize;
    const content = truncated
      ? body.substring(0, this.maxContentSize) + `\n\n[... truncated, showing first ${this.maxContentSize} bytes of ${totalSize}. Use file_info to see full file details.]`
      : body;

    return { content, truncated, totalSize };
  }

  /**
   * Read a file as raw Buffer (for text extraction).
   * @param {string} filePath - Relative path
   * @returns {Promise<Buffer>}
   */
  async readFileBuffer(filePath) {
    const response = await this._request(this._davPath(filePath), {
      method: 'GET',
      rawBuffer: true
    });

    // If body is already a Buffer, return it
    if (Buffer.isBuffer(response.body)) {
      return response.body;
    }

    // Fallback: convert string to buffer
    return Buffer.from(response.body || '', 'utf-8');
  }

  /**
   * Write content to a file (creates or overwrites).
   * @param {string} filePath - Relative path
   * @param {string} content - Text content
   * @returns {Promise<{success: boolean}>}
   */
  async writeFile(filePath, content) {
    await this._request(this._davPath(filePath), {
      method: 'PUT',
      headers: {
        'Content-Type': 'text/plain; charset=utf-8'
      },
      body: content
    });

    return { success: true };
  }

  /**
   * List directory contents.
   * @param {string} [dirPath='/'] - Relative path
   * @returns {Promise<Array<{name: string, type: string, size: number, modified: string, permissions: string}>>}
   */
  async listDirectory(dirPath = '/') {
    // Nextcloud requires trailing slash for Depth:1 PROPFIND directory listing
    const normalizedPath = dirPath === '/' ? '/' : dirPath.replace(/\/+$/, '') + '/';

    const propfindBody = `<?xml version="1.0"?>
<d:propfind xmlns:d="DAV:" xmlns:oc="http://owncloud.org/ns">
  <d:prop>
    <d:displayname/><d:getcontentlength/><d:getlastmodified/>
    <d:getetag/><d:getcontenttype/><d:resourcetype/><oc:permissions/><oc:size/>
  </d:prop>
</d:propfind>`;

    const response = await this._request(this._davPath(normalizedPath), {
      method: 'PROPFIND',
      headers: {
        'Content-Type': 'application/xml',
        'Depth': '1'
      },
      body: propfindBody
    });

    const xml = typeof response.body === 'string' ? response.body : '';
    const entries = this._parsePropfindResponse(xml);

    // Skip the first entry (parent directory itself)
    const items = entries.slice(1).map(e => {
      // Derive name from href (last path segment)
      const segments = e.href.replace(/\/+$/, '').split('/');
      const name = segments[segments.length - 1] || e.displayname;

      return {
        name: decodeURIComponent(name),
        type: e.isDirectory ? 'directory' : 'file',
        size: e.size,
        modified: e.lastModified,
        permissions: e.permissions
      };
    });

    return items;
  }

  /**
   * Get file metadata via PROPFIND Depth:0.
   * @param {string} filePath - Relative path
   * @returns {Promise<{name: string, size: number, modified: string, contentType: string, shared: boolean, canWrite: boolean}>}
   */
  async getFileInfo(filePath) {
    const propfindBody = `<?xml version="1.0"?>
<d:propfind xmlns:d="DAV:" xmlns:oc="http://owncloud.org/ns">
  <d:prop>
    <d:displayname/><d:getcontentlength/><d:getlastmodified/>
    <d:getetag/><d:getcontenttype/><d:resourcetype/><oc:permissions/><oc:size/>
  </d:prop>
</d:propfind>`;

    const response = await this._request(this._davPath(filePath), {
      method: 'PROPFIND',
      headers: {
        'Content-Type': 'application/xml',
        'Depth': '0'
      },
      body: propfindBody
    });

    const xml = typeof response.body === 'string' ? response.body : '';
    const entries = this._parsePropfindResponse(xml);

    if (entries.length === 0) {
      throw new NCFilesError('File not found', 404);
    }

    const e = entries[0];
    return {
      name: e.displayname || filePath.split('/').pop(),
      size: e.size,
      modified: e.lastModified,
      contentType: e.contentType,
      shared: this._isShared(e.permissions),
      canWrite: this._canWrite(e.permissions)
    };
  }

  /**
   * Move/rename a file.
   * @param {string} fromPath
   * @param {string} toPath
   * @returns {Promise<{success: boolean}>}
   */
  async moveFile(fromPath, toPath) {
    await this._request(this._davPath(fromPath), {
      method: 'MOVE',
      headers: {
        'Destination': this._davUrl(toPath),
        'Overwrite': 'T'
      }
    });

    return { success: true };
  }

  /**
   * Copy a file.
   * @param {string} fromPath
   * @param {string} toPath
   * @returns {Promise<{success: boolean}>}
   */
  async copyFile(fromPath, toPath) {
    await this._request(this._davPath(fromPath), {
      method: 'COPY',
      headers: {
        'Destination': this._davUrl(toPath),
        'Overwrite': 'T'
      }
    });

    return { success: true };
  }

  /**
   * Delete a file or folder.
   * @param {string} filePath
   * @returns {Promise<{success: boolean}>}
   */
  async deleteFile(filePath) {
    await this._request(this._davPath(filePath), {
      method: 'DELETE'
    });

    return { success: true };
  }

  /**
   * Create a directory. Handles 405 (already exists) gracefully.
   * @param {string} dirPath
   * @returns {Promise<{success: boolean}>}
   */
  async mkdir(dirPath) {
    try {
      await this._request(this._davPath(dirPath), {
        method: 'MKCOL'
      });
    } catch (err) {
      // 405 means the directory already exists — that's fine
      if (err.message && err.message.includes('405')) {
        return { success: true };
      }
      throw err;
    }

    return { success: true };
  }

  /**
   * Share a file with a user via OCS Share API.
   * @param {string} filePath - Relative path
   * @param {string} shareWith - NC username
   * @param {string} [permission='read'] - 'read' or 'edit'
   * @returns {Promise<{shareId: number}>}
   */
  async shareFile(filePath, shareWith, permission = 'read') {
    const permissions = permission === 'edit' ? 15 : 1; // 1=read, 15=all
    const sharePath = '/' + (filePath || '').replace(/^\/+/, '');

    const response = await this._request(
      '/ocs/v2.php/apps/files_sharing/api/v1/shares',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'OCS-APIRequest': 'true'
        },
        body: {
          path: sharePath,
          shareType: 0, // user share
          shareWith: shareWith,
          permissions: permissions
        }
      }
    );

    const shareId = response.body?.ocs?.data?.id ||
                    response.body?.ocs?.data?.token ||
                    null;

    return { shareId };
  }
}

module.exports = { NCFilesClient, NCFilesError };
