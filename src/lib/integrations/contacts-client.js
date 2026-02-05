/**
 * MoltAgent CardDAV Contacts Client
 *
 * Architecture Brief:
 * -------------------
 * Problem: MoltAgent cannot resolve human names to email addresses for
 * meeting scheduling and people intelligence.
 *
 * Pattern: CardDAV REPORT client using NCRequestManager. Searches contacts
 * via addressbook-query, parses vCard responses (FN, EMAIL, TEL, ORG),
 * caches results with TTL. Optionally creates stub People wiki pages
 * on first contact resolution.
 *
 * Key Dependencies:
 *   - NCRequestManager (HTTP transport)
 *   - CollectivesClient (optional, People page auto-creation)
 *   - page-templates.js (person template)
 *   - config.js (contacts section)
 *
 * Data Flow:
 *   search(query) -> CardDAV REPORT -> _parseMultistatus -> _parseVCard -> Contact[]
 *   resolve(name) -> search() -> 0/1/N -> {resolved, contact?, options?}
 *
 * Dependency Map:
 *   contacts-client.js depends on: nc-request-manager, config
 *   Used by: tool-registry.js (contacts_search, contacts_get handlers)
 *   Optionally uses: collectives-client, page-templates
 *
 * @module integrations/contacts-client
 * @version 1.0.0
 */

'use strict';

const appConfig = require('../config');

/**
 * @typedef {Object} Contact
 * @property {string} name - Full name (FN)
 * @property {string|null} firstName - Given name (from N)
 * @property {string|null} lastName - Family name (from N)
 * @property {string|null} email - Primary email address
 * @property {Array<{type: string, value: string}>} emails - All email addresses
 * @property {string|null} phone - Primary phone number
 * @property {Array<{type: string, value: string}>} phones - All phone numbers
 * @property {string|null} org - Organization name
 * @property {string|null} title - Job title
 * @property {string|null} uid - vCard UID
 * @property {string|null} href - CardDAV resource href
 * @property {string|null} etag - Resource ETag
 * @property {boolean} hasPhoto - Whether photo is present
 */

/**
 * Custom error class for CardDAV contacts errors
 */
class ContactsClientError extends Error {
  /**
   * @param {string} message
   * @param {number} [statusCode=0]
   * @param {*} [response=null]
   */
  constructor(message, statusCode = 0, response = null) {
    super(message);
    this.name = 'ContactsClientError';
    this.statusCode = statusCode;
    this.response = response;
  }
}

class ContactsClient {
  /**
   * @param {Object} ncRequestManager - NCRequestManager instance
   * @param {Object} [config]
   * @param {string} [config.username] - NC username (for CardDAV path)
   * @param {string} [config.addressBook] - Address book name (default: 'contacts')
   * @param {number} [config.cacheTTLMs] - Cache TTL in ms (default: 3600000 = 1 hour)
   * @param {Object} [config.collectivesClient] - CollectivesClient for People page auto-creation
   * @param {Function} [config.auditLog] - Audit logging function
   */
  constructor(ncRequestManager, config = {}) {
    if (!ncRequestManager || typeof ncRequestManager.request !== 'function') {
      throw new Error('ContactsClient requires an NCRequestManager instance');
    }

    this.nc = ncRequestManager;
    this.username = config.username || ncRequestManager.ncUser || 'moltagent';
    this.addressBook = config.addressBook || appConfig.contacts?.addressBook || 'contacts';
    this.cacheTTLMs = config.cacheTTLMs || appConfig.contacts?.cacheTTLMs || 3600000;
    this.collectivesClient = config.collectivesClient || null;
    this.auditLog = config.auditLog || (async () => {});

    // Cache: href -> Contact, and name token index for fast local search
    this._cache = {
      contacts: new Map(),     // href -> Contact
      lastFetched: 0,
      nameIndex: new Map()     // lowercase token -> Set<href>
    };
  }

  // ===========================================================================
  // Public API
  // ===========================================================================

  /**
   * Search contacts by name fragment via CardDAV REPORT.
   * Uses addressbook-query with prop-filter on FN (contains match).
   * @param {string} query - Name or partial name to search
   * @returns {Promise<Array<Contact>>} Matching contacts
   */
  async search(query) {
    // Fast-path: use local cache if warm
    if (this._isCacheValid()) {
      const cached = this._searchCache(query);
      if (cached.length > 0) {
        await this.auditLog('contacts_searched', { query, count: cached.length, source: 'cache' });
        return cached;
      }
    }

    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<C:addressbook-query xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:carddav">
  <D:prop>
    <D:getetag/>
    <C:address-data/>
  </D:prop>
  <C:filter>
    <C:prop-filter name="FN">
      <C:text-match collation="i;unicode-casemap" match-type="contains">${this._escapeXml(query)}</C:text-match>
    </C:prop-filter>
  </C:filter>
</C:addressbook-query>`;

    try {
      const response = await this._request('REPORT', this._basePath(), {
        body: xml,
        depth: 1
      });

      if (response.status !== 207) {
        throw new ContactsClientError(
          `CardDAV REPORT failed with status ${response.status}`,
          response.status,
          response
        );
      }

      const entries = this._parseMultistatus(response.body);
      const contacts = entries.map(entry =>
        this._parseVCard(entry.vcard, entry.href, entry.etag)
      );

      // Update cache with results
      for (const contact of contacts) {
        if (contact.href) {
          this._cache.contacts.set(contact.href, contact);
        }
      }

      await this.auditLog('contacts_searched', { query, count: contacts.length });

      return contacts;
    } catch (err) {
      if (err instanceof ContactsClientError) {
        throw err;
      }
      throw new ContactsClientError(
        `Failed to search contacts: ${err.message}`,
        err.statusCode || 0,
        err.response
      );
    }
  }

  /**
   * Get a single contact by CardDAV href.
   * @param {string} href - Full CardDAV href path
   * @returns {Promise<Contact|null>} Contact or null if not found
   */
  async get(href) {
    // Validate href stays within expected CardDAV path
    const basePath = `/remote.php/dav/addressbooks/users/`;
    if (!href || !href.startsWith(basePath)) {
      throw new ContactsClientError(
        `Invalid CardDAV href: must start with ${basePath}`,
        0
      );
    }

    // Check cache first
    if (this._cache.contacts.has(href)) {
      return this._cache.contacts.get(href);
    }

    try {
      const response = await this._request('GET', href, {});

      if (response.status === 404) {
        return null;
      }

      if (response.status !== 200) {
        throw new ContactsClientError(
          `Failed to GET contact: status ${response.status}`,
          response.status,
          response
        );
      }

      // Parse the vCard from response body
      const contact = this._parseVCard(response.body, href, response.headers['etag'] || null);

      // Update cache
      this._cache.contacts.set(href, contact);

      return contact;
    } catch (err) {
      if (err instanceof ContactsClientError) {
        throw err;
      }
      throw new ContactsClientError(
        `Failed to get contact: ${err.message}`,
        err.statusCode || 0,
        err.response
      );
    }
  }

  /**
   * Resolve a name to a single contact.
   * Returns immediately if exactly one match.
   * Returns disambiguation options if multiple matches.
   * @param {string} name - Name to resolve
   * @returns {Promise<{resolved: boolean, contact?: Contact, options?: Contact[], error?: string}>}
   */
  async resolve(name) {
    const matches = await this.search(name);

    if (matches.length === 0) {
      return { resolved: false, error: 'no_match' };
    }

    if (matches.length === 1) {
      const contact = matches[0];
      await this._ensurePeoplePage(contact);
      return { resolved: true, contact };
    }

    return { resolved: false, options: matches };
  }

  /**
   * Fetch all contacts from the address book (for cache warming).
   * Uses REPORT with no filter to get all address-data.
   * @param {boolean} [forceRefresh=false]
   * @returns {Promise<Array<Contact>>}
   */
  async fetchAll(forceRefresh = false) {
    if (this._isCacheValid() && !forceRefresh) {
      return Array.from(this._cache.contacts.values());
    }

    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<C:addressbook-query xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:carddav">
  <D:prop>
    <D:getetag/>
    <C:address-data/>
  </D:prop>
</C:addressbook-query>`;

    try {
      const response = await this._request('REPORT', this._basePath(), {
        body: xml,
        depth: 1
      });

      if (response.status !== 207) {
        throw new ContactsClientError(
          `CardDAV REPORT failed with status ${response.status}`,
          response.status,
          response
        );
      }

      const entries = this._parseMultistatus(response.body);
      const contacts = entries.map(entry =>
        this._parseVCard(entry.vcard, entry.href, entry.etag)
      );

      this._updateCache(contacts);

      return Array.from(this._cache.contacts.values());
    } catch (err) {
      if (err instanceof ContactsClientError) {
        throw err;
      }
      throw new ContactsClientError(
        `Failed to fetch all contacts: ${err.message}`,
        err.statusCode || 0,
        err.response
      );
    }
  }

  /**
   * Force cache invalidation. Call when user says "refresh contacts".
   */
  invalidateCache() {
    this._cache.contacts.clear();
    this._cache.lastFetched = 0;
    this._cache.nameIndex.clear();
  }

  // ===========================================================================
  // CardDAV HTTP Layer (private)
  // ===========================================================================

  /**
   * Make a CardDAV request via NCRequestManager.
   * Follows the same pattern as caldav-client._request().
   * @private
   * @param {string} method - HTTP method (REPORT, GET, PROPFIND)
   * @param {string} path - Request path
   * @param {Object} [opts]
   * @param {string} [opts.body] - Request body (XML)
   * @param {Object} [opts.headers] - Additional headers
   * @param {number} [opts.depth] - WebDAV Depth header value
   * @returns {Promise<{status: number, headers: Object, body: string}>}
   */
  async _request(method, path, { body = null, headers = {}, depth = null } = {}) {
    const requestHeaders = {
      'Content-Type': 'application/xml; charset=utf-8',
      ...headers
    };

    if (depth !== null) {
      requestHeaders['Depth'] = depth.toString();
    }

    const response = await this.nc.request(path, {
      method,
      headers: requestHeaders,
      body
    });

    return {
      status: response.status,
      headers: response.headers,
      body: typeof response.body === 'string' ? response.body : JSON.stringify(response.body)
    };
  }

  /**
   * Build the CardDAV base path for this user's address book.
   * @private
   * @returns {string} e.g. "/remote.php/dav/addressbooks/users/moltagent/contacts/"
   */
  _basePath() {
    return `/remote.php/dav/addressbooks/users/${this.username}/${this.addressBook}/`;
  }

  // ===========================================================================
  // vCard Parsing (private)
  // ===========================================================================

  /**
   * Parse a multistatus XML response into an array of raw vCard entries.
   * @private
   * @param {string} xml - Raw XML response body
   * @returns {Array<{href: string, etag: string, vcard: string}>}
   */
  _parseMultistatus(xml) {
    const results = [];
    const responsePattern = /<d:response[^>]*>([\s\S]*?)<\/d:response>/gi;
    let responseMatch;

    while ((responseMatch = responsePattern.exec(xml)) !== null) {
      const responseBlock = responseMatch[1];

      // Extract href
      const hrefMatch = responseBlock.match(/<d:href[^>]*>(.*?)<\/d:href>/i);
      if (!hrefMatch) continue;
      const href = this._decodeXMLEntities(hrefMatch[1].trim());

      // Extract etag
      const etagMatch = responseBlock.match(/<d:getetag[^>]*>(.*?)<\/d:getetag>/i);
      const etag = etagMatch ? this._decodeXMLEntities(etagMatch[1].trim()).replace(/"/g, '') : '';

      // Extract address-data (try both card: and C: namespace prefixes)
      const addressDataMatch = responseBlock.match(/<(?:card|C):address-data[^>]*>([\s\S]*?)<\/(?:card|C):address-data>/i);
      if (!addressDataMatch) {
        // Skip responses without address-data (e.g., the collection itself)
        continue;
      }

      const vcard = this._decodeXMLEntities(addressDataMatch[1].trim());

      results.push({ href, etag, vcard });
    }

    return results;
  }

  /**
   * Parse a single vCard string into a Contact object.
   * Extracts: FN, N, EMAIL (all TYPE variants), TEL, ORG, TITLE, UID.
   * Handles RFC 6350 folded lines.
   * @private
   * @param {string} vcardData - Raw vCard text
   * @param {string} [href] - CardDAV href
   * @param {string} [etag] - ETag
   * @returns {Contact}
   */
  _parseVCard(vcardData, href = null, etag = null) {
    const unfolded = this._unfoldVCard(vcardData);

    // Extract FN (full name) — regex skips optional parameters before ':'
    const fnMatch = unfolded.match(/^FN(?:;[^:]*)?:(.*)$/m);
    const name = fnMatch ? fnMatch[1].trim() : 'Unknown';

    // Extract N (structured name: Family;Given;Middle;Prefix;Suffix)
    const nMatch = unfolded.match(/^N(?:;[^:]*)?:(.*)$/m);
    let firstName = null;
    let lastName = null;
    if (nMatch) {
      const parts = nMatch[1].split(';');
      lastName = parts[0] ? parts[0].trim() : null;
      firstName = parts[1] ? parts[1].trim() : null;
    }

    // Extract all EMAIL lines
    const emails = [];
    const emailPattern = /^EMAIL([^:]*):(.*)$/gm;
    let emailMatch;
    while ((emailMatch = emailPattern.exec(unfolded)) !== null) {
      const fullLine = emailMatch[0];
      const value = emailMatch[2].trim();
      const type = this._extractType(fullLine);
      emails.push({ type, value });
    }
    const email = emails.length > 0 ? emails[0].value : null;

    // Extract all TEL lines
    const phones = [];
    const telPattern = /^TEL([^:]*):(.*)$/gm;
    let telMatch;
    while ((telMatch = telPattern.exec(unfolded)) !== null) {
      const fullLine = telMatch[0];
      const value = telMatch[2].trim();
      const type = this._extractType(fullLine);
      phones.push({ type, value });
    }
    const phone = phones.length > 0 ? phones[0].value : null;

    // Extract ORG
    const orgMatch = unfolded.match(/^ORG(?:;[^:]*)?:(.*)$/m);
    const org = orgMatch ? orgMatch[1].trim() : null;

    // Extract TITLE
    const titleMatch = unfolded.match(/^TITLE(?:;[^:]*)?:(.*)$/m);
    const title = titleMatch ? titleMatch[1].trim() : null;

    // Extract UID
    const uidMatch = unfolded.match(/^UID(?:;[^:]*)?:(.*)$/m);
    const uid = uidMatch ? uidMatch[1].trim() : null;

    // Detect PHOTO presence
    const hasPhoto = /^PHOTO/m.test(unfolded);

    return {
      name,
      firstName,
      lastName,
      email,
      emails,
      phone,
      phones,
      org,
      title,
      uid,
      href,
      etag,
      hasPhoto
    };
  }

  /**
   * Unfold vCard continuation lines (lines starting with space/tab per RFC 6350).
   * @private
   * @param {string} raw - Raw vCard with possible folded lines
   * @returns {string} Unfolded vCard
   */
  _unfoldVCard(raw) {
    return raw.replace(/\r?\n[ \t]/g, '');
  }

  /**
   * Extract TYPE parameter from a vCard property line.
   * @private
   * @param {string} line - Full property line (e.g. "EMAIL;TYPE=WORK:addr@co.com")
   * @returns {string} Type value or 'OTHER'
   */
  _extractType(line) {
    const match = line.match(/TYPE=([^;:]+)/i);
    return match ? match[1].toUpperCase() : 'OTHER';
  }

  /**
   * Escape text for safe interpolation into XML.
   * @private
   * @param {string} text
   * @returns {string}
   */
  _escapeXml(text) {
    return text
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  /**
   * Decode XML entities in text.
   * @private
   * @param {string} text
   * @returns {string}
   */
  _decodeXMLEntities(text) {
    return text
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&amp;/g, '&')
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'");
  }

  // ===========================================================================
  // People Page Auto-Creation (private)
  // ===========================================================================

  /**
   * Create a stub People wiki page for a resolved contact.
   * Only creates if collectivesClient is configured and page doesn't exist.
   * Best-effort: never throws, logs warnings on failure.
   * @private
   * @param {Contact} contact - Resolved contact
   * @returns {Promise<void>}
   */
  async _ensurePeoplePage(contact) {
    if (!this.collectivesClient) {
      return;
    }

    try {
      // Check if page already exists
      const existingPage = await this.collectivesClient.findPageByTitle(contact.name);
      if (existingPage) {
        return;
      }

      // Lazy-load page templates
      const { applyTemplate } = require('../knowledge/page-templates');

      // Apply person template
      const baseContent = applyTemplate('person', {
        title: contact.name,
        role: contact.title || ''
      });

      // Enhance with contact details
      let contactSection = '\n## Contact\n\n';
      if (contact.email) {
        contactSection += `- **Email:** ${contact.email}\n`;
      }
      if (contact.phone) {
        contactSection += `- **Phone:** ${contact.phone}\n`;
      }
      if (contact.org) {
        contactSection += `- **Organization:** ${contact.org}\n`;
      }

      const content = baseContent + contactSection;

      // Get collective ID
      const collectiveId = await this.collectivesClient.resolveCollective();

      // Find People parent page
      const allPages = await this.collectivesClient.listPages(collectiveId);
      const peoplePage = allPages.find(p => p.title === 'People');
      const peopleParentId = peoplePage ? peoplePage.id : 0;

      // Create the page
      await this.collectivesClient.createPage(
        collectiveId,
        peopleParentId,
        contact.name
      );

      // Write content
      await this.collectivesClient.writePageContent(
        `${contact.name}/Readme.md`,
        content
      );

      await this.auditLog('people_page_created', { name: contact.name });
    } catch (err) {
      console.warn('[ContactsClient] People page creation failed:', err.message);
    }
  }

  // ===========================================================================
  // Cache Helpers (private)
  // ===========================================================================

  /**
   * Check whether the full-fetch cache is still valid.
   * @private
   * @returns {boolean}
   */
  _isCacheValid() {
    return this._cache.lastFetched > 0 &&
           (Date.now() - this._cache.lastFetched) < this.cacheTTLMs;
  }

  /**
   * Update cache with a new list of contacts.
   * @private
   * @param {Array<Contact>} contacts
   */
  _updateCache(contacts) {
    // Clear existing cache
    this._cache.contacts.clear();
    this._cache.nameIndex.clear();

    // Populate cache
    for (const contact of contacts) {
      if (contact.href) {
        this._cache.contacts.set(contact.href, contact);

        // Tokenize name for search index
        const tokens = contact.name.toLowerCase().split(/\s+/).filter(t => t.length > 0);
        for (const token of tokens) {
          if (!this._cache.nameIndex.has(token)) {
            this._cache.nameIndex.set(token, new Set());
          }
          this._cache.nameIndex.get(token).add(contact.href);
        }
      }
    }

    this._cache.lastFetched = Date.now();
  }

  /**
   * Search local cache by query string.
   * @private
   * @param {string} query
   * @returns {Array<Contact>}
   */
  _searchCache(query) {
    const tokens = query.toLowerCase().split(/\s+/).filter(t => t.length > 0);

    if (tokens.length === 0) {
      return [];
    }

    // Get matching href sets for each token
    const sets = tokens.map(token => {
      // Find all index entries that contain this token as a substring
      const matchingHrefs = new Set();
      for (const [indexToken, hrefSet] of this._cache.nameIndex.entries()) {
        if (indexToken.includes(token)) {
          for (const href of hrefSet) {
            matchingHrefs.add(href);
          }
        }
      }
      return matchingHrefs;
    });

    // Intersect all sets for multi-word queries
    let resultHrefs = sets[0];
    for (let i = 1; i < sets.length; i++) {
      const intersection = new Set();
      for (const href of resultHrefs) {
        if (sets[i].has(href)) {
          intersection.add(href);
        }
      }
      resultHrefs = intersection;
    }

    // Map hrefs to Contact objects
    const results = [];
    for (const href of resultHrefs) {
      const contact = this._cache.contacts.get(href);
      if (contact) {
        results.push(contact);
      }
    }

    return results;
  }
}

module.exports = ContactsClient;
module.exports.ContactsClientError = ContactsClientError;
