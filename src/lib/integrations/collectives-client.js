/**
 * MoltAgent NC Collectives Client
 *
 * API client for Nextcloud Collectives integration.
 * Enables knowledge wiki management via OCS API and WebDAV.
 *
 * OCS API for page tree structure, WebDAV for page content.
 *
 * @module collectives-client
 * @version 1.0.0
 */

const appConfig = require('../config');

/** Slugify a title for Collectives URLs: non-alphanumeric → hyphens */
function _slugify(text) {
  return (text || '').replace(/[^\w]+/g, '-').replace(/^-+|-+$/g, '');
}

/**
 * Custom error class for Collectives API errors
 */
class CollectivesApiError extends Error {
  constructor(message, statusCode = 0, response = null) {
    super(message);
    this.name = 'CollectivesApiError';
    this.statusCode = statusCode;
    this.response = response;
  }
}

class CollectivesClient {
  /**
   * Create a new Collectives client
   * @param {Object} ncRequestManager - NCRequestManager instance
   * @param {Object} [config] - Configuration object
   * @param {string} [config.collectiveName] - Default collective name
   */
  constructor(ncRequestManager, config = {}) {
    if (!ncRequestManager || typeof ncRequestManager.request !== 'function') {
      throw new Error('CollectivesClient requires an NCRequestManager instance');
    }

    this.nc = ncRequestManager;
    this.baseUrl = this.nc.ncUrl;
    this.username = this.nc.ncUser || 'moltagent';

    // Configuration
    this.collectiveName = config.collectiveName || appConfig.knowledge?.collectiveName || 'Moltagent Knowledge';

    // Cache for collective ID
    this._cache = {
      collectiveId: null,
      collectiveName: null,
      collectivesTTL: 0
    };

    // Cache for wikilink resolution (title → {title, pageId}), populated once per session
    this._wikilinkMap = null;

    // OCS API base path
    this.ocsBase = '/ocs/v2.php/apps/collectives/api/v1.0';
  }

  // ===========================================================================
  // HTTP Layer
  // ===========================================================================

  /**
   * Make an OCS API request to Collectives
   * @private
   * @param {string} method - HTTP method
   * @param {string} path - API path (appended to ocsBase)
   * @param {Object} [body] - Request body
   * @returns {Promise<Object>} Response body
   */
  async _ocsRequest(method, path, body = null) {
    const url = `${this.ocsBase}${path}`;
    const options = {
      method,
      headers: {
        'OCS-APIRequest': 'true',
        'Accept': 'application/json'
      }
    };

    if (body && (method === 'POST' || method === 'PUT')) {
      options.headers['Content-Type'] = 'application/json';
      options.body = JSON.stringify(body);
    }

    const response = await this.nc.request(url, options);

    if (response.status >= 400) {
      throw new CollectivesApiError(
        `Collectives API error: ${response.status} on ${method} ${url}`,
        response.status,
        response.body
      );
    }

    // OCS responses wrap data in ocs.data
    const data = response.body;
    if (data && data.ocs && data.ocs.data !== undefined) {
      return data.ocs.data;
    }
    return data;
  }

  /**
   * Make a WebDAV request for page content
   * @private
   * @param {string} method - HTTP method (GET or PUT)
   * @param {string} filePath - Path relative to user files root
   * @param {string} [content] - Content for PUT requests
   * @returns {Promise<Object>} Response
   */
  async _webdavRequest(method, filePath, content = null) {
    const url = `/remote.php/dav/files/${this.username}/${filePath}`;
    const options = { method };

    if (content !== null && method === 'PUT') {
      options.headers = { 'Content-Type': 'text/markdown' };
      options.body = content;
    }

    const response = await this.nc.request(url, options);

    if (response.status >= 400) {
      throw new CollectivesApiError(
        `WebDAV error: ${response.status} on ${method} ${filePath}`,
        response.status,
        response.body
      );
    }

    return response;
  }

  // ===========================================================================
  // Collective Management
  // ===========================================================================

  /**
   * List all collectives accessible to the user
   * @returns {Promise<Array>} List of collectives
   */
  async listCollectives() {
    const data = await this._ocsRequest('GET', '/collectives');
    // Collectives API nests: ocs.data.collectives → unwrap after _ocsRequest strips ocs.data
    return data?.collectives || data || [];
  }

  /**
   * Get a collective by name from the list
   * @param {string} name - Collective name
   * @returns {Promise<Object|null>} Collective object or null
   */
  async getCollective(name) {
    const collectives = await this.listCollectives();
    if (!Array.isArray(collectives)) return null;
    return collectives.find(c => c.name === name) || null;
  }

  /**
   * Create a new collective
   * @param {string} name - Collective name
   * @returns {Promise<Object>} Created collective
   */
  async createCollective(name) {
    const data = await this._ocsRequest('POST', '/collectives', { name });
    return data?.collective || data;
  }

  /**
   * Resolve the default collective: find or create, cache ID
   * @returns {Promise<number>} Collective ID
   */
  async resolveCollective() {
    // Return cached if valid
    if (this._cache.collectiveId && this._cache.collectiveName === this.collectiveName &&
        Date.now() < this._cache.collectivesTTL) {
      return this._cache.collectiveId;
    }

    // Try to find existing
    let collective = await this.getCollective(this.collectiveName);

    if (!collective) {
      // Create it
      collective = await this.createCollective(this.collectiveName);
    }

    // Cache the ID (5 minute TTL)
    this._cache.collectiveId = collective.id;
    this._cache.collectiveName = this.collectiveName;
    this._cache.collectivesTTL = Date.now() + 5 * 60 * 1000;

    return collective.id;
  }

  // ===========================================================================
  // Page Tree (OCS API)
  // ===========================================================================

  /**
   * List all pages in a collective
   * @param {number} collectiveId - Collective ID
   * @returns {Promise<Array>} List of pages
   */
  async listPages(collectiveId) {
    const data = await this._ocsRequest('GET', `/collectives/${collectiveId}/pages`);
    return data?.pages || data || [];
  }

  /**
   * Get a single page by ID
   * @param {number} collectiveId - Collective ID
   * @param {number} pageId - Page ID
   * @returns {Promise<Object>} Page object
   */
  async getPage(collectiveId, pageId) {
    const data = await this._ocsRequest('GET', `/collectives/${collectiveId}/pages/${pageId}`);
    return data?.page || data;
  }

  /**
   * Create a new page under a parent
   * @param {number} collectiveId - Collective ID
   * @param {number} parentId - Parent page ID
   * @param {string} title - Page title
   * @returns {Promise<Object>} Created page
   */
  async createPage(collectiveId, parentId, title) {
    const data = await this._ocsRequest('POST', `/collectives/${collectiveId}/pages/${parentId}`, { title });
    // Invalidate wikilink cache so new pages get picked up
    this._wikilinkMap = null;
    return data?.page || data;
  }

  /**
   * Search pages in a collective via NC Unified Search.
   * The Collectives OCS search endpoint (/collectives/{id}/search) returns HTTP 500,
   * so we use the NC Unified Search provider 'collectives-page-content' instead.
   * Falls back to listPages + client-side filter if Unified Search fails.
   * @param {number} collectiveId - Collective ID (unused — Unified Search searches all collectives)
   * @param {string} query - Search query
   * @returns {Promise<Array>} Matching pages with at least { title }
   */
  async searchPages(collectiveId, query) {
    try {
      const response = await this.nc.request(
        `/ocs/v2.php/search/providers/collectives-page-content/search?term=${encodeURIComponent(query)}&limit=10`,
        { method: 'GET', headers: { 'OCS-APIRequest': 'true', 'Accept': 'application/json' } }
      );
      const entries = response.body?.ocs?.data?.entries;
      if (Array.isArray(entries) && entries.length > 0) {
        return entries.map(e => ({
          title: e.title || '',
          excerpt: e.subline || '',
          resourceUrl: e.resourceUrl || ''
        }));
      }
    } catch {
      // Unified Search failed — fall through to listPages filter
    }

    // Fallback: list all pages + client-side title filter
    const allPages = await this.listPages(collectiveId);
    const queryLower = (query || '').toLowerCase();
    return (allPages || []).filter(p =>
      (p.title || '').toLowerCase().includes(queryLower)
    );
  }

  /**
   * Set emoji on a page
   * @param {number} collectiveId - Collective ID
   * @param {number} pageId - Page ID
   * @param {string} emoji - Emoji character
   * @returns {Promise<Object>} Updated page
   */
  async setPageEmoji(collectiveId, pageId, emoji) {
    return await this._ocsRequest('PUT', `/collectives/${collectiveId}/pages/${pageId}/emoji`, { emoji });
  }

  /**
   * Trash (soft-delete) a page
   * @param {number} collectiveId - Collective ID
   * @param {number} pageId - Page ID
   * @returns {Promise<Object>} Result
   */
  async trashPage(collectiveId, pageId) {
    return await this._ocsRequest('DELETE', `/collectives/${collectiveId}/pages/${pageId}`);
  }

  // ===========================================================================
  // Content Sanitization
  // ===========================================================================

  /**
   * Sanitize content by stripping Tiptap/Prosemirror internal tags and
   * stray HTML, converting them to clean markdown equivalents.
   * @private
   * @param {string} content - Raw content that may contain HTML/Tiptap tags
   * @returns {string} Clean markdown content
   */
  _sanitizeContent(content) {
    if (!content || typeof content !== 'string') return content || '';

    let s = content;

    // Tiptap heading wrappers → markdown headings
    s = s.replace(/<heading\s+level="(\d)">([\s\S]*?)<\/heading>/gi,
      (_, lvl, text) => '#'.repeat(parseInt(lvl)) + ' ' + text.trim());

    // Tiptap paragraph wrappers → plain text + newline
    s = s.replace(/<paragraph>([\s\S]*?)<\/paragraph>/gi, '$1\n');

    // Tiptap list wrappers
    s = s.replace(/<bulletlist>/gi, '');
    s = s.replace(/<\/bulletlist>/gi, '');
    s = s.replace(/<orderedlist>/gi, '');
    s = s.replace(/<\/orderedlist>/gi, '');
    s = s.replace(/<listitem><paragraph>([\s\S]*?)<\/paragraph><\/listitem>/gi, '- $1\n');
    s = s.replace(/<listitem>([\s\S]*?)<\/listitem>/gi, '- $1\n');

    // Tiptap hardbreak
    s = s.replace(/<hardbreak\s*\/?>/gi, '\n');

    // Standard HTML tags that might leak through
    s = s.replace(/<h([1-6])[^>]*>([\s\S]*?)<\/h\1>/gi,
      (_, lvl, text) => '#'.repeat(parseInt(lvl)) + ' ' + text.trim());
    s = s.replace(/<p[^>]*>([\s\S]*?)<\/p>/gi, '$1\n');
    s = s.replace(/<br\s*\/?>/gi, '\n');
    s = s.replace(/<ul[^>]*>/gi, '');
    s = s.replace(/<\/ul>/gi, '');
    s = s.replace(/<ol[^>]*>/gi, '');
    s = s.replace(/<\/ol>/gi, '');
    s = s.replace(/<li[^>]*>([\s\S]*?)<\/li>/gi, '- $1\n');
    s = s.replace(/<strong[^>]*>([\s\S]*?)<\/strong>/gi, '**$1**');
    s = s.replace(/<b[^>]*>([\s\S]*?)<\/b>/gi, '**$1**');
    s = s.replace(/<em[^>]*>([\s\S]*?)<\/em>/gi, '*$1*');
    s = s.replace(/<i[^>]*>([\s\S]*?)<\/i>/gi, '*$1*');
    s = s.replace(/<code[^>]*>([\s\S]*?)<\/code>/gi, '`$1`');
    s = s.replace(/<a[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi, '[$2]($1)');
    s = s.replace(/<blockquote[^>]*>([\s\S]*?)<\/blockquote>/gi, '> $1');

    // Strip any remaining unknown tags
    s = s.replace(/<\/?[a-zA-Z][a-zA-Z0-9]*(?:\s[^>]*)?\/?>/g, '');

    // Fix excess newlines introduced by replacements
    s = s.replace(/\n{3,}/g, '\n\n');

    return s.trim();
  }

  // ===========================================================================
  // Page Content (WebDAV)
  // ===========================================================================

  /**
   * Read page content via WebDAV
   * @param {string} pagePath - Path relative to Collectives folder (e.g., "People/John Smith/Readme.md")
   * @returns {Promise<string|null>} Page content or null if not found
   */
  async readPageContent(pagePath) {
    if (pagePath.includes('..')) throw new CollectivesApiError('Path traversal not allowed');
    const fullPath = `Collectives/${this.collectiveName}/${pagePath}`;
    try {
      const response = await this._webdavRequest('GET', fullPath);
      const raw = typeof response.body === 'string' ? response.body : (response.body ? String(response.body) : '');
      return this._sanitizeContent(raw);
    } catch (err) {
      if (err.statusCode === 404) return null;
      throw err;
    }
  }

  /**
   * Write page content via WebDAV
   * @param {string} pagePath - Path relative to Collectives folder
   * @param {string} content - Markdown content
   * @returns {Promise<void>}
   */
  async writePageContent(pagePath, content) {
    if (pagePath.includes('..')) throw new CollectivesApiError('Path traversal not allowed');
    const fullPath = `Collectives/${this.collectiveName}/${pagePath}`;
    const sanitized = this._sanitizeContent(content);
    await this._webdavRequest('PUT', fullPath, sanitized);
  }

  /**
   * Touch a page via OCS API to invalidate NC Text editor cache.
   * Call after WebDAV writes so the Collectives UI re-reads the .md file.
   * @param {number} collectiveId - Collective ID
   * @param {number} pageId - Page ID
   * @returns {Promise<void>}
   */
  async touchPage(collectiveId, pageId) {
    try {
      await this._ocsRequest('GET', `/collectives/${collectiveId}/pages/${pageId}`);
    } catch {
      // Best effort — don't fail the write because of a cache touch
    }
  }

  // ===========================================================================
  // High-Level Helpers
  // ===========================================================================

  /**
   * Find a page by title using search (with listPages fallback)
   * @param {string} title - Page title to find (e.g. "John Smith" or "People/John Smith")
   * @returns {Promise<{page: Object, path: string}|null>} Page info or null
   */
  async findPageByTitle(title) {
    const collectiveId = await this.resolveCollective();

    // Handle slash-separated titles: "People/John Smith" → search for "John Smith"
    const parts = title.split('/');
    const leafTitle = parts[parts.length - 1];

    // listPages provides full metadata (fileName, filePath) needed by _buildPagePath.
    // Unified Search results lack these fields, so we go direct to listPages.
    const allPages = await this.listPages(collectiveId);
    const candidates = Array.isArray(allPages) ? allPages : [];

    // Exact title match on the leaf name (case-insensitive)
    const exact = candidates.find(p =>
      (p.title || '').toLowerCase() === leafTitle.toLowerCase()
    );

    if (!exact) return null;

    const pagePath = this._buildPagePath(exact);
    return { page: exact, path: pagePath };
  }

  /**
   * Build WebDAV path for a page from its API metadata
   * @private
   * @param {Object} page - Page object with fileName and filePath from API
   * @returns {string} WebDAV-relative path
   */
  _buildPagePath(page) {
    // Use API-provided filePath and fileName when available
    if (page.fileName) {
      return page.filePath
        ? `${page.filePath}/${page.fileName}`
        : page.fileName;
    }
    // Legacy fallback
    const title = page.title || 'Untitled';
    return `${title}.md`;
  }

  /**
   * Read a page with parsed frontmatter
   * @param {string} title - Page title
   * @returns {Promise<{frontmatter: Object, body: string, path: string}|null>}
   */
  async readPageWithFrontmatter(title) {
    const found = await this.findPageByTitle(title);
    if (!found) return null;

    const content = await this.readPageContent(found.path);
    if (content === null) return null;

    // Lazy-load frontmatter parser to avoid circular dependency
    const { parseFrontmatter } = require('../knowledge/frontmatter');
    const { frontmatter, body } = parseFrontmatter(content);

    return { frontmatter, body, path: found.path };
  }

  /**
   * Build an absolute Collectives deep-link URL for a page.
   * Format: /apps/collectives/{collective-slug}-{collectiveId}/{page-slug}-{pageId}
   * Example: /apps/collectives/Moltagent-Knowledge-10/Carlos-26950
   *
   * @param {string} pageTitle - Page title (e.g. "Carlos" or "John Smith")
   * @param {number} pageId - Page ID from the Collectives API
   * @returns {string} Full clickable URL
   */
  buildPageUrl(pageTitle, pageId) {
    const collectiveId = this._cache.collectiveId;
    if (!collectiveId || !pageId) {
      return `${this.baseUrl}/apps/collectives/${encodeURIComponent(this.collectiveName)}`;
    }
    const collectiveSlug = _slugify(this.collectiveName);
    const pageSlug = _slugify(pageTitle);
    return `${this.baseUrl}/apps/collectives/${collectiveSlug}-${collectiveId}/${pageSlug}-${pageId}`;
  }

  /**
   * Ensure the wikilink title→{title, pageId} cache is populated.
   * Loads all pages from listPages() once per session.
   * Stores the page title and ID for deep-link URL construction.
   * @private
   */
  async _ensureWikilinkCache() {
    if (this._wikilinkMap) return;
    this._wikilinkMap = new Map();
    try {
      await this.resolveCollective();
      const pages = await this.listPages(this._cache.collectiveId);
      const pageList = Array.isArray(pages) ? pages : [];

      for (const page of pageList) {
        if (!page.title || !page.id) continue;
        this._wikilinkMap.set(page.title.toLowerCase(), { title: page.title, pageId: page.id });
      }
    } catch {
      // Cache stays empty — resolveWikilinks will fall back to plain text
    }
  }

  /**
   * Resolve [[wikilink]] patterns to absolute Collectives deep links.
   * [[Page/Name]] → [Name](https://ncUrl/apps/collectives/Collective-Slug-ID/Page-Slug-PageID)
   * If page not found: Page/Name (page not found)
   * @param {string} content - Markdown content with potential wikilinks
   * @returns {Promise<string>} Content with wikilinks resolved
   */
  async resolveWikilinks(content) {
    const matches = [...content.matchAll(/\[\[([^\]]+)\]\]/g)];
    if (matches.length === 0) return content;

    await this._ensureWikilinkCache();

    let result = content;
    // Process in reverse order to preserve match indices during replacement
    for (let i = matches.length - 1; i >= 0; i--) {
      const match = matches[i];
      const target = match[1];
      const label = target.includes('/') ? target.split('/').pop() : target;
      const leafTitle = label.toLowerCase();

      const cached = this._wikilinkMap.get(leafTitle);
      const replacement = cached
        ? `[${label}](${this.buildPageUrl(cached.title, cached.pageId)})`
        : `${target} (page not found)`;

      result = result.slice(0, match.index) + replacement + result.slice(match.index + match[0].length);
    }
    return result;
  }

  /**
   * Write a page with frontmatter
   * @param {string} title - Page title
   * @param {Object} frontmatter - Frontmatter metadata
   * @param {string} body - Page body content
   * @returns {Promise<string>} Path written to
   */
  async writePageWithFrontmatter(title, frontmatter, body) {
    const { serializeFrontmatter } = require('../knowledge/frontmatter');

    // Resolve [[wikilinks]] to Nextcloud file links before writing
    const resolved = await this.resolveWikilinks(body);

    const content = serializeFrontmatter(frontmatter, resolved);

    // Try to find existing page path
    const found = await this.findPageByTitle(title);
    const pagePath = found ? found.path : `${title}.md`;

    await this.writePageContent(pagePath, content);
    return pagePath;
  }

  // ===========================================================================
  // Wiki Bootstrap
  // ===========================================================================

  /**
   * Bootstrap default wiki section pages and meta subpages.
   * Safe to call repeatedly — skips pages that already exist.
   * @returns {Promise<{created: string[], skipped: string[], errors: Array<{title: string, error: string}>}>}
   */
  async bootstrapDefaultPages() {
    const { serializeFrontmatter } = require('../knowledge/frontmatter');
    const created = [];
    const skipped = [];
    const errors = [];

    const collectiveId = await this.resolveCollective();
    const pages = await this.listPages(collectiveId);
    const pageList = Array.isArray(pages) ? pages : [];
    const existingTitles = new Set(
      pageList.map(p => (p.title || '').toLowerCase())
    );

    // The landing page (parentId 0) is the root — section pages go under it
    const landingPage = pageList.find(p => p.parentId === 0);
    const rootParentId = landingPage ? landingPage.id : 0;

    const sections = appConfig.knowledge?.sections || [
      'People', 'Projects', 'Procedures', 'Research', 'Meta',
      'Components', 'Infrastructure', 'Organizations', 'Agents', 'Documents', 'Sessions',
    ];

    // Track created pages locally (API may not reflect them immediately)
    let metaPageRef = pageList.find(p => (p.title || '').toLowerCase() === 'meta') || null;

    // Create top-level section pages
    for (const section of sections) {
      if (existingTitles.has(section.toLowerCase())) {
        skipped.push(section);
        continue;
      }
      try {
        const page = await this.createPage(collectiveId, rootParentId, section);
        const content = serializeFrontmatter(
          { type: 'section' },
          `# ${section}\n`
        );
        // New pages are flat .md files; use fileName from API response
        const writePath = page.filePath
          ? `${page.filePath}/${page.fileName}`
          : page.fileName || `${section}.md`;
        await this.writePageContent(writePath, content);
        created.push(section);
        // Track Meta page locally for subpage creation below
        if (section.toLowerCase() === 'meta') {
          metaPageRef = page;
        }
      } catch (err) {
        errors.push({ title: section, error: err.message });
      }
    }

    // Create meta subpages
    if (metaPageRef) {
      const metaSubpages = [
        { title: 'Learning Log', purpose: 'Agent learning journal' },
        { title: 'Pending Questions', purpose: 'Unresolved questions awaiting verification' },
        { title: 'Knowledge Stats', purpose: 'Wiki health and usage statistics' }
      ];

      // Build set of existing children under Meta from initial page list
      const existingMetaChildren = new Set(
        pageList
          .filter(p => p.parentId === metaPageRef.id)
          .map(p => (p.title || '').toLowerCase())
      );

      for (const sub of metaSubpages) {
        const fullTitle = `Meta/${sub.title}`;
        if (existingMetaChildren.has(sub.title.toLowerCase())) {
          skipped.push(fullTitle);
          continue;
        }
        try {
          const page = await this.createPage(collectiveId, metaPageRef.id, sub.title);
          const content = serializeFrontmatter(
            { type: 'meta', purpose: sub.purpose },
            `# ${sub.title}\n`
          );
          // Subpages may be flat .md or folder/Readme.md; use API response
          const writePath = page.filePath
            ? `${page.filePath}/${page.fileName}`
            : page.fileName || `${sub.title}.md`;
          await this.writePageContent(writePath, content);
          created.push(fullTitle);
        } catch (err) {
          errors.push({ title: fullTitle, error: err.message });
        }
      }
    }

    return { created, skipped, errors };
  }

  // ===========================================================================
  // Collective Sharing (Circles/Teams API)
  // ===========================================================================

  /**
   * Get the Circles/Teams circle ID for the configured collective
   * @returns {Promise<string>} Circle ID
   */
  async getCollectiveCircleId() {
    const collective = await this.getCollective(this.collectiveName);
    if (!collective) {
      throw new CollectivesApiError(`Collective "${this.collectiveName}" not found`);
    }
    return collective.circleId;
  }

  /**
   * Add a user to a Circles/Teams circle
   * @param {string} circleId - Circle ID
   * @param {string} userId - User ID to add
   * @param {number} [memberType=1] - Member type (1 = user)
   * @returns {Promise<Object>} API response
   */
  async addTeamMember(circleId, userId, memberType = 1) {
    const url = `/ocs/v2.php/apps/circles/circles/${circleId}/members`;
    const options = {
      method: 'POST',
      headers: {
        'OCS-APIRequest': 'true',
        'Accept': 'application/json',
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ userId, type: memberType })
    };

    let response;
    try {
      response = await this.nc.request(url, options);
    } catch (err) {
      // NCRequestManager rejects 400s — check if it's "already member"
      if (err.message && err.message.includes('400')) {
        return { status: 400, _alreadyMember: true };
      }
      throw err;
    }

    if (response.status === 409) {
      response._alreadyMember = true;
    }

    return response;
  }

  /**
   * Share the collective with an admin user by adding them to the backing circle
   * @param {string} adminUsername - Admin user to add
   * @returns {Promise<{success: boolean, message: string}>}
   */
  async shareWithAdmin(adminUsername) {
    if (!adminUsername) {
      return { success: false, message: 'No admin username provided' };
    }

    try {
      const circleId = await this.getCollectiveCircleId();
      const response = await this.addTeamMember(circleId, adminUsername);

      if (response._alreadyMember) {
        return { success: true, message: `${adminUsername} is already a member` };
      }

      return { success: true, message: `Added ${adminUsername} to collective` };
    } catch (err) {
      return { success: false, message: err.message };
    }
  }
}

module.exports = CollectivesClient;
module.exports.CollectivesApiError = CollectivesApiError;
