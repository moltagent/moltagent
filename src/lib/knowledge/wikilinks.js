/*
 * MoltAgent - Sovereign AI Security Layer
 * Copyright (C) 2026 MoltAgent Contributors
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU Affero General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 */

'use strict';

/*
 * Architecture Brief
 * ------------------
 * Problem: Wiki pages reference each other via [[wikilinks]] but there's
 * no extraction or processing of these references.
 *
 * Pattern: Lightweight regex extraction of [[Page Name]] patterns.
 * Foundation for future RelationshipGraph module.
 *
 * Data Flow:
 *   extractWikilinks(markdown) -> string[] (unique page names)
 *   replaceWikilinks(markdown, replacer) -> transformed markdown
 *
 * Dependency Map:
 *   wikilinks.js depends on: nothing (leaf module)
 *   Used by: future RelationshipGraph, context-loader.js
 */

const WIKILINK_REGEX = /\[\[([^\]]+)\]\]/g;

/**
 * Extract unique page names from [[wikilink]] references in markdown.
 * @param {string} markdown - Markdown content to scan
 * @returns {string[]} Deduplicated array of page names (trimmed)
 */
function extractWikilinks(markdown) {
  if (!markdown || typeof markdown !== 'string') return [];

  const found = new Set();
  let match;

  // Reset regex lastIndex for safety
  WIKILINK_REGEX.lastIndex = 0;

  while ((match = WIKILINK_REGEX.exec(markdown)) !== null) {
    const name = match[1].trim();
    if (name) {
      found.add(name);
    }
  }

  return Array.from(found);
}

/**
 * Replace [[wikilink]] references in markdown using a replacer function.
 * @param {string} markdown - Markdown content
 * @param {Function} replacer - Called with (pageName) for each link, returns replacement string
 * @returns {string} Transformed markdown
 */
function replaceWikilinks(markdown, replacer) {
  if (!markdown || typeof markdown !== 'string') return markdown || '';
  if (typeof replacer !== 'function') return markdown;

  return markdown.replace(WIKILINK_REGEX, (fullMatch, pageName) => {
    const trimmed = pageName.trim();
    if (!trimmed) return fullMatch;
    return replacer(trimmed);
  });
}

module.exports = { extractWikilinks, replaceWikilinks };
