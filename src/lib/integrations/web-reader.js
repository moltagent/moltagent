'use strict';

/**
 * WebReader - URL Fetcher with SSRF Protection + Article Extraction
 *
 * Fetches URLs with SSRF protection, extracts readable article content,
 * and returns truncated text. Uses @extractus/article-extractor (ESM)
 * with cheerio fallback.
 *
 * @module integrations/web-reader
 * @version 1.0.0
 */

const dns = require('dns');
const { URL } = require('url');

class WebReaderError extends Error {
  constructor(message, code = 'READER_ERROR') {
    super(message);
    this.name = 'WebReaderError';
    this.code = code;
  }
}

// Private IP ranges for SSRF protection
const PRIVATE_IP_PATTERNS = [
  /^127\./,                          // 127.0.0.0/8 loopback
  /^10\./,                           // 10.0.0.0/8
  /^172\.(1[6-9]|2[0-9]|3[01])\./,  // 172.16.0.0/12
  /^192\.168\./,                     // 192.168.0.0/16
  /^169\.254\./,                     // 169.254.0.0/16 link-local
  /^0\./,                            // 0.0.0.0/8
  /^::1$/,                           // IPv6 loopback
  /^fc/i,                            // fc00::/7 unique local
  /^fe80/i,                          // fe80::/10 link-local
  /^::$/                             // unspecified
];

const BLOCKED_HOSTNAMES = [
  'localhost',
  'metadata.google.internal',
  'metadata.azure.com',
  'metadata.internal'
];

class WebReader {
  /**
   * @param {Object} [options={}]
   * @param {Object} [options.config={}]
   * @param {number} [options.config.timeoutMs=15000]
   * @param {number} [options.config.maxResponseBytes=5242880] - 5MB
   * @param {number} [options.config.maxOutputChars=12000]
   * @param {number} [options.config.cacheTtlMs=3600000] - 1 hour
   * @param {number} [options.config.maxCacheEntries=50]
   * @param {string} [options.config.userAgent='MoltAgent/1.0']
   */
  constructor({ config = {} } = {}) {
    this.timeoutMs = config.timeoutMs || 15000;
    this.maxResponseBytes = config.maxResponseBytes || 5 * 1024 * 1024;
    this.maxOutputChars = config.maxOutputChars || 12000;
    this.cacheTtlMs = config.cacheTtlMs || 60 * 60 * 1000;
    this.maxCacheEntries = config.maxCacheEntries || 50;
    this.userAgent = config.userAgent || 'MoltAgent/1.0';

    // Simple in-memory cache: url -> { result, cachedAt }
    this._cache = new Map();
  }

  /**
   * Fetch and extract readable content from a URL.
   * @param {string} url - URL to read
   * @returns {Promise<{title: string, content: string, url: string, extractedAt: string, bytesFetched: number, truncated: boolean}>}
   */
  async read(url) {
    // 1. Validate URL (SSRF protection)
    await this._validateUrl(url);

    // 2. Check cache
    const cached = this._cache.get(url);
    if (cached && (Date.now() - cached.cachedAt) < this.cacheTtlMs) {
      return cached.result;
    }

    // 3. Fetch with manual redirect handling to re-validate each target
    let response;
    try {
      response = await this._fetchWithRedirects(url);
    } catch (err) {
      if (err instanceof WebReaderError) throw err;
      if (err.name === 'TimeoutError' || err.name === 'AbortError') {
        throw new WebReaderError(`Request timed out after ${this.timeoutMs}ms`, 'TIMEOUT');
      }
      throw new WebReaderError(`Fetch failed: ${err.message}`, 'NETWORK_ERROR');
    }

    if (!response.ok) {
      throw new WebReaderError(`HTTP ${response.status}: ${response.statusText}`, 'HTTP_ERROR');
    }

    // 4. Check Content-Type
    const contentType = (response.headers.get('content-type') || '').toLowerCase();
    const isHtml = contentType.includes('text/html');
    const isPlainText = contentType.includes('text/plain');
    const isJson = contentType.includes('application/json');

    if (!isHtml && !isPlainText && !isJson) {
      throw new WebReaderError(
        `Unsupported content type: ${contentType}. Only text/html, text/plain, and application/json are supported.`,
        'UNSUPPORTED_TYPE'
      );
    }

    // 5. Read body with size limit
    let bodyText;
    let bytesFetched;
    try {
      const bodyBuffer = await this._readLimitedBody(response);
      bytesFetched = bodyBuffer.length;
      bodyText = bodyBuffer.toString('utf-8');
    } catch (err) {
      if (err.code === 'BODY_TOO_LARGE') throw err;
      throw new WebReaderError(`Failed to read response body: ${err.message}`, 'READ_ERROR');
    }

    // 6. Extract content
    let title = '';
    let content = '';

    if (isJson) {
      title = 'JSON Response';
      try {
        const parsed = JSON.parse(bodyText);
        content = JSON.stringify(parsed, null, 2);
      } catch {
        content = bodyText;
      }
    } else if (isHtml) {
      // Try article-extractor first, fall back to cheerio
      const extracted = await this._extractArticle(bodyText);
      if (extracted && extracted.content) {
        title = extracted.title || '';
        content = this._stripHtml(extracted.content);
      } else {
        // Cheerio fallback
        const cheerioResult = this._extractWithCheerio(bodyText);
        title = cheerioResult.title;
        content = cheerioResult.content;
      }
    } else {
      // Plain text
      title = 'Plain Text';
      content = bodyText;
    }

    // 7. Truncate
    const truncated = content.length > this.maxOutputChars;
    if (truncated) {
      content = content.substring(0, this.maxOutputChars) + '\n\n[Content truncated]';
    }

    const result = {
      title: title || url,
      content,
      url,
      extractedAt: new Date().toISOString(),
      bytesFetched,
      truncated
    };

    // 8. Cache
    this._cacheResult(url, result);

    return result;
  }

  /**
   * Validate URL for SSRF protection.
   * Checks protocol, hostname, and resolved IP.
   * @param {string} urlStr
   * @private
   */
  async _validateUrl(urlStr) {
    if (!urlStr || typeof urlStr !== 'string') {
      throw new WebReaderError('URL is required', 'INVALID_URL');
    }

    let parsed;
    try {
      parsed = new URL(urlStr);
    } catch {
      throw new WebReaderError(`Invalid URL: ${urlStr}`, 'INVALID_URL');
    }

    // Protocol check
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      throw new WebReaderError(
        `Blocked protocol: ${parsed.protocol}. Only http: and https: are allowed.`,
        'BLOCKED_PROTOCOL'
      );
    }

    const hostname = parsed.hostname.toLowerCase();

    // Blocked hostnames
    if (BLOCKED_HOSTNAMES.includes(hostname) || hostname.endsWith('.local')) {
      throw new WebReaderError(
        `Blocked hostname: ${hostname}`,
        'BLOCKED_HOST'
      );
    }

    // Check if hostname is an IP literal
    if (this._isPrivateIp(hostname)) {
      throw new WebReaderError(
        `Blocked private IP: ${hostname}`,
        'BLOCKED_IP'
      );
    }

    // DNS resolution check — resolve hostname and validate IP
    try {
      const { address } = await dns.promises.lookup(hostname);
      if (this._isPrivateIp(address)) {
        throw new WebReaderError(
          `Blocked: ${hostname} resolves to private IP ${address}`,
          'BLOCKED_IP'
        );
      }
    } catch (err) {
      if (err instanceof WebReaderError) throw err;
      throw new WebReaderError(
        `DNS resolution failed for ${hostname}: ${err.message}`,
        'DNS_ERROR'
      );
    }
  }

  /**
   * Fetch with manual redirect handling, re-validating each redirect target.
   * Prevents redirect-based SSRF attacks (e.g. 302 to cloud metadata endpoint).
   * @param {string} url
   * @param {number} [maxRedirects=3]
   * @returns {Promise<Response>}
   * @private
   */
  async _fetchWithRedirects(url, maxRedirects = 3) {
    let currentUrl = url;
    for (let i = 0; i <= maxRedirects; i++) {
      const response = await fetch(currentUrl, {
        method: 'GET',
        headers: {
          'User-Agent': this.userAgent,
          'Accept': 'text/html, text/plain, application/json, */*'
        },
        signal: AbortSignal.timeout(this.timeoutMs),
        redirect: 'manual'
      });

      // Not a redirect — return the response
      if (response.status < 300 || response.status >= 400) {
        return response;
      }

      // Handle redirect
      const location = response.headers.get('location');
      if (!location) {
        return response; // Redirect without Location header — return as-is
      }

      // Resolve relative redirects
      currentUrl = new URL(location, currentUrl).href;

      if (i === maxRedirects) {
        throw new WebReaderError(`Too many redirects (max ${maxRedirects})`, 'TOO_MANY_REDIRECTS');
      }

      // Re-validate the redirect target for SSRF
      await this._validateUrl(currentUrl);
    }

    throw new WebReaderError('Redirect loop', 'TOO_MANY_REDIRECTS');
  }

  /**
   * Check if an IP address is in a private/reserved range.
   * Handles IPv6-mapped IPv4 addresses (::ffff:x.x.x.x).
   * @param {string} ip
   * @returns {boolean}
   * @private
   */
  _isPrivateIp(ip) {
    // Normalize IPv6-mapped IPv4 (e.g. ::ffff:127.0.0.1 → 127.0.0.1)
    let normalized = ip;
    const v4Mapped = ip.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/i);
    if (v4Mapped) {
      normalized = v4Mapped[1];
    }
    return PRIVATE_IP_PATTERNS.some(pattern => pattern.test(normalized));
  }

  /**
   * Read response body with size limit.
   * @param {Response} response
   * @returns {Promise<Buffer>}
   * @private
   */
  async _readLimitedBody(response) {
    // Use arrayBuffer approach for simplicity with size check
    const contentLength = parseInt(response.headers.get('content-length') || '0', 10);
    if (contentLength > this.maxResponseBytes) {
      throw new WebReaderError(
        `Response too large: ${contentLength} bytes exceeds ${this.maxResponseBytes} byte limit`,
        'BODY_TOO_LARGE'
      );
    }

    const chunks = [];
    let totalSize = 0;
    const reader = response.body.getReader();

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      totalSize += value.length;
      if (totalSize > this.maxResponseBytes) {
        reader.cancel();
        throw new WebReaderError(
          `Response too large: exceeded ${this.maxResponseBytes} byte limit`,
          'BODY_TOO_LARGE'
        );
      }
      chunks.push(value);
    }

    return Buffer.concat(chunks);
  }

  /**
   * Try to extract article content using @extractus/article-extractor (ESM).
   * Returns null if module unavailable or extraction fails.
   * IMPORTANT: Pass raw HTML only — never pass the URL, as the library would
   * re-fetch it using its own HTTP client, bypassing our SSRF protections.
   * @param {string} html - Already-fetched HTML content
   * @returns {Promise<{title: string, content: string}|null>}
   * @private
   */
  async _extractArticle(html) {
    try {
      const { extract } = await import('@extractus/article-extractor');
      const article = await extract(html);
      return article;
    } catch {
      return null;
    }
  }

  /**
   * Extract content using cheerio (fallback).
   * @param {string} html
   * @returns {{title: string, content: string}}
   * @private
   */
  _extractWithCheerio(html) {
    try {
      const cheerio = require('cheerio');
      const $ = cheerio.load(html);

      // Remove unwanted elements
      $('script, style, nav, header, footer, iframe, noscript, svg').remove();

      const title = $('title').first().text().trim() ||
                    $('h1').first().text().trim() ||
                    '';

      // Try article or main content first
      let content = '';
      const mainSelectors = ['article', 'main', '[role="main"]', '.content', '.post-content', '#content'];
      for (const sel of mainSelectors) {
        const el = $(sel).first();
        if (el.length && el.text().trim().length > 100) {
          content = el.text().trim();
          break;
        }
      }

      // Fall back to body text
      if (!content) {
        content = $('body').text().trim();
      }

      // Clean up whitespace
      content = content.replace(/\s+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();

      return { title, content };
    } catch {
      // If cheerio fails, strip tags manually
      const title = (html.match(/<title[^>]*>(.*?)<\/title>/i) || [])[1] || '';
      const content = html
        .replace(/<script[\s\S]*?<\/script>/gi, '')
        .replace(/<style[\s\S]*?<\/style>/gi, '')
        .replace(/<[^>]+>/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
      return { title: title.trim(), content };
    }
  }

  /**
   * Strip HTML tags from article-extractor output.
   * @param {string} html
   * @returns {string}
   * @private
   */
  _stripHtml(html) {
    // Simple tag stripping for article-extractor content
    return html
      .replace(/<[^>]+>/g, '')
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&#039;/g, "'")
      .replace(/&nbsp;/g, ' ')
      .replace(/\s+/g, ' ')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
  }

  /**
   * Cache a result with LRU-style eviction.
   * @param {string} url
   * @param {Object} result
   * @private
   */
  _cacheResult(url, result) {
    // Evict oldest entries if at capacity
    if (this._cache.size >= this.maxCacheEntries) {
      const firstKey = this._cache.keys().next().value;
      this._cache.delete(firstKey);
    }
    this._cache.set(url, { result, cachedAt: Date.now() });
  }

  /**
   * Clear the in-memory cache.
   */
  clearCache() {
    this._cache.clear();
  }
}

module.exports = { WebReader, WebReaderError };
