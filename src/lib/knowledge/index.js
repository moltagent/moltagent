/*
 * Moltagent - Sovereign AI Security Layer
 * Copyright (C) 2026 Moltagent Contributors
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU Affero General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 */

'use strict';

/**
 * Moltagent Knowledge Module
 *
 * Provides minimum viable agent memory:
 *
 * - LearningLog: Append-only markdown log stored in Nextcloud WebDAV
 * - KnowledgeBoard: Deck board for tracking uncertain knowledge needing verification
 * - ContextLoader: Loads recent learnings into agent context for prompt injection
 *
 * @module knowledge
 */

const { LearningLog } = require('./learning-log');
const { KnowledgeBoard } = require('./knowledge-board');
const { ContextLoader } = require('./context-loader');
const { parseFrontmatter, serializeFrontmatter } = require('./frontmatter');
const { FreshnessChecker } = require('./freshness-checker');
const { TEMPLATES, getTemplate, applyTemplate } = require('./page-templates');
const { extractWikilinks, replaceWikilinks } = require('./wikilinks');

module.exports = {
  LearningLog,
  KnowledgeBoard,
  ContextLoader,
  parseFrontmatter,
  serializeFrontmatter,
  FreshnessChecker,
  TEMPLATES,
  getTemplate,
  applyTemplate,
  extractWikilinks,
  replaceWikilinks
};
