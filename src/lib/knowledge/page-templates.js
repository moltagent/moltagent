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
 * Problem: Wiki pages need consistent structure for machine-readability
 * and human usability. Without templates, pages are freeform and
 * frontmatter is often missing or inconsistent.
 *
 * Pattern: Standard templates per page type (research, person, project,
 * procedure) with default frontmatter and body sections. Templates are
 * applied at write time when the user specifies a page type.
 *
 * Key Dependencies:
 *   - frontmatter.js: serializeFrontmatter() for output formatting
 *
 * Data Flow:
 *   getTemplate(type) -> { frontmatter, body }
 *   applyTemplate(type, data) -> serializeFrontmatter(merged, body)
 *
 * Dependency Map:
 *   page-templates.js depends on: frontmatter.js
 *   Used by: tool-registry.js (wiki_write handler)
 */

const { serializeFrontmatter } = require('./frontmatter');

/**
 * Standard page templates keyed by type.
 * Each template has a frontmatter object and body string.
 */
const TEMPLATES = {
  research: {
    frontmatter: {
      type: 'research',
      query: '',
      confidence: 'medium',
      decay_days: 30,
      sources_count: 0,
      requested_by: '',
      tags: []
    },
    body: `# {title}

## Summary

<!-- Brief summary of findings -->

## Key Findings

-

## Sources

| # | Source | Date | Notes |
|---|--------|------|-------|
| 1 |        |      |       |

## Confidence Assessment

<!-- Why this confidence level? What would change it? -->

## Context

<!-- When was this researched and why? -->
`
  },

  person: {
    frontmatter: {
      type: 'person',
      confidence: 'medium',
      decay_days: 90,
      role: '',
      relationships: [],
      tags: ['team']
    },
    body: `# {title}

## Role & Responsibilities

<!-- Current role and key responsibilities -->

## Contact

<!-- Email, phone, preferred communication channel -->

## Key Projects

<!-- Active projects and involvement -->

## Notes

<!-- Important context, preferences, working style -->
`
  },

  project: {
    frontmatter: {
      type: 'project',
      confidence: 'medium',
      decay_days: 60,
      status: 'active',
      owner: '',
      tags: []
    },
    body: `# {title}

## Overview

<!-- What is this project about? -->

## Current Status

<!-- Where does this stand right now? -->

## Key People

<!-- Who is involved and in what capacity? -->

## Timeline

<!-- Key dates and milestones -->

## Notes

<!-- Additional context -->
`
  },

  procedure: {
    frontmatter: {
      type: 'procedure',
      confidence: 'high',
      decay_days: 180,
      verified_by: '',
      tags: ['procedure']
    },
    body: `# {title}

## Purpose

<!-- What does this procedure accomplish? -->

## Prerequisites

-

## Steps

1.

## Troubleshooting

<!-- Common issues and solutions -->

## Related

<!-- Links to related procedures or pages -->
`
  }
};

/**
 * Get a template by type.
 * @param {string} type - Template type (research, person, project, procedure)
 * @returns {{ frontmatter: Object, body: string } | null}
 */
function getTemplate(type) {
  const template = TEMPLATES[type];
  if (!template) return null;

  // Deep clone to avoid mutation
  return {
    frontmatter: JSON.parse(JSON.stringify(template.frontmatter)),
    body: template.body
  };
}

/**
 * Apply a template with custom data, producing a full markdown string.
 * @param {string} type - Template type
 * @param {Object} [data={}] - Custom data to merge into frontmatter
 * @returns {string|null} Full markdown with frontmatter, or null if type unknown
 */
function applyTemplate(type, data = {}) {
  const template = getTemplate(type);
  if (!template) return null;

  // Merge custom data into frontmatter
  const fm = { ...template.frontmatter, ...data };

  // Set last_verified to today
  fm.last_verified = new Date().toISOString().split('T')[0];

  // Replace {title} placeholder in body
  const title = data.title || data.query || type;
  const body = template.body.replace(/\{title\}/g, title);

  return serializeFrontmatter(fm, body);
}

module.exports = { TEMPLATES, getTemplate, applyTemplate };
