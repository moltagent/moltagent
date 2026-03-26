#!/usr/bin/env node
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
 * Resolve duplicate wiki pages using LLM-assisted entity resolution.
 *
 * Usage:
 *   node scripts/resolve-wiki-duplicates.js --scan     # Show merge plan (default)
 *   node scripts/resolve-wiki-duplicates.js --merge    # Execute merges
 *   node scripts/resolve-wiki-duplicates.js --section People  # One section only
 *
 * The scan step uses the LLM to identify duplicate groups.
 * The merge step requires explicit --merge flag (destructive, but composted).
 *
 * Always run --scan first and review the output before --merge.
 */

'use strict';

const fs = require('fs');
const path = require('path');

// ============================================================
// Credential bootstrap (same as CLAUDE.md Section 6)
// ============================================================

function loadCredentials() {
  const credDir = process.env.CREDENTIALS_DIRECTORY || '/run/credentials/moltagent.service';
  let ncPass;
  try {
    ncPass = fs.readFileSync(path.join(credDir, 'nc-password'), 'utf8').trim();
  } catch {
    ncPass = fs.readFileSync('/etc/credstore/moltagent-nc-password', 'utf8').trim();
  }

  // Load NC_URL and NC_USER from systemd environment
  const { execSync } = require('child_process');
  const envLine = execSync('systemctl show moltagent.service --property=Environment', { encoding: 'utf8' });
  const env = {};
  const matches = envLine.matchAll(/(\w+)=([^\s]+)/g);
  for (const m of matches) {
    env[m[1]] = m[2];
  }

  // Export all systemd env vars so Ollama URL, model, etc. are available
  for (const [key, val] of Object.entries(env)) {
    if (!process.env[key]) process.env[key] = val;
  }

  return {
    ncUrl: env.NC_URL || process.env.NC_URL,
    ncUser: env.NC_USER || process.env.NC_USER,
    ncPass,
  };
}

// ============================================================
// Wiki API client (lightweight, script-only)
// ============================================================

class WikiClient {
  constructor({ ncUrl, ncUser, ncPass }) {
    this.ncUrl = ncUrl;
    this.ncUser = ncUser;
    this.ncPass = ncPass;
    this.auth = Buffer.from(`${ncUser}:${ncPass}`).toString('base64');
    this.collectiveId = null;
  }

  async _request(method, apiPath, body = null) {
    const base = this.ncUrl.startsWith('http') ? this.ncUrl : `https://${this.ncUrl}`;
    const url = `${base}${apiPath}`;
    const headers = {
      'Authorization': `Basic ${this.auth}`,
      'OCS-APIRequest': 'true',
      'Accept': 'application/json',
      'Content-Type': 'application/json',
    };
    const options = { method, headers };
    if (body) options.body = JSON.stringify(body);

    const response = await fetch(url, options);
    if (!response.ok) {
      throw new Error(`${method} ${apiPath} → ${response.status}`);
    }
    const text = await response.text();
    try {
      return JSON.parse(text);
    } catch {
      return text;
    }
  }

  async _webdavRequest(method, davPath, body = null) {
    const base = this.ncUrl.startsWith('http') ? this.ncUrl : `https://${this.ncUrl}`;
    const url = `${base}${davPath}`;
    const headers = {
      'Authorization': `Basic ${this.auth}`,
    };
    if (body) headers['Content-Type'] = 'text/markdown';
    const options = { method, headers };
    if (body) options.body = body;

    const response = await fetch(url, options);
    if (!response.ok && response.status !== 404) {
      throw new Error(`${method} ${davPath} → ${response.status}`);
    }
    if (response.status === 404) return null;
    return await response.text();
  }

  async resolveCollective() {
    if (this.collectiveId) return this.collectiveId;
    const data = await this._request('GET', '/ocs/v2.php/apps/collectives/api/v1.0/collectives');
    const ocsData = data?.ocs?.data || {};
    const collectives = Array.isArray(ocsData) ? ocsData : (ocsData.collectives || []);
    const found = collectives.find(c => c.name?.toLowerCase().includes('moltagent'));
    if (!found) throw new Error('Moltagent collective not found');
    this.collectiveId = found.id;
    return found.id;
  }

  async listAllPages() {
    const id = await this.resolveCollective();
    const data = await this._request('GET', `/ocs/v2.php/apps/collectives/api/v1.0/collectives/${id}/pages`);
    const ocsData = data?.ocs?.data || {};
    return Array.isArray(ocsData) ? ocsData : (ocsData.pages || []);
  }

  async readPageContent(pagePath) {
    const davBase = `/remote.php/dav/files/${this.ncUser}/.Collectives/Moltagent Knowledge`;
    return await this._webdavRequest('GET', `${davBase}/${pagePath}`);
  }

  async writePageContent(pagePath, content) {
    const davBase = `/remote.php/dav/files/${this.ncUser}/.Collectives/Moltagent Knowledge`;
    await this._webdavRequest('PUT', `${davBase}/${pagePath}`, content);
  }

  async createPage(parentId, title) {
    const id = await this.resolveCollective();
    const data = await this._request('POST',
      `/ocs/v2.php/apps/collectives/api/v1.0/collectives/${id}/pages/${parentId}`,
      { title });
    return data?.ocs?.data?.page || data?.ocs?.data || data;
  }

  async trashPage(pageId) {
    const id = await this.resolveCollective();
    await this._request('DELETE', `/ocs/v2.php/apps/collectives/api/v1.0/collectives/${id}/pages/${pageId}`);
  }
}

// ============================================================
// String normalization (mirrors document-ingestor.js)
// ============================================================

function normalizeEntityName(name) {
  if (!name) return '';
  let n = name.toLowerCase().trim()
    .replace(/\s+/g, ' ')
    .replace(/\s*\(\d+\)$/, '');
  n = n.replace(/^(?:the|an?|die|de[rs]|das|eine?|os?|as?|uma?)\s+/i, '');
  n = n.replace(/^(?:from|about|regarding|re:)\s+/i, '');
  n = n.normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  n = n.replace(/[.,;:!?]+$/, '');
  return n;
}

// ============================================================
// LLM pairwise entity resolution (local Ollama)
// ============================================================

/**
 * Pre-filter candidates that could plausibly match a title.
 * Reduces LLM hallucinations by only sending plausible candidates.
 *
 * Keeps a candidate if:
 * - Any word (≥3 chars) appears in both titles
 * - The new title looks like initials of the candidate (all caps, ≤5 chars)
 * - One title is a substring of the other
 * - They share a significant acronym
 */
function preFilterCandidates(newTitle, candidates) {
  const newLower = newTitle.toLowerCase();
  const newWords = newLower.split(/[\s,.()\-]+/).filter(w => w.length >= 3);
  const isInitials = /^[A-Z]{2,5}$/.test(newTitle.trim());

  return candidates.filter(candidate => {
    const candLower = candidate.toLowerCase();
    const candWords = candLower.split(/[\s,.()\-]+/).filter(w => w.length >= 3);

    // Substring check
    if (newLower.includes(candLower) || candLower.includes(newLower)) return true;

    // Shared words check
    if (newWords.some(w => candWords.includes(w))) return true;
    if (candWords.some(w => newWords.includes(w))) return true;

    // Initials check: "EHD" could match "Eelco H. Dykstra"
    if (isInitials) {
      const initials = candidate.split(/[\s.]+/)
        .filter(w => w.length > 0)
        .map(w => w[0].toUpperCase())
        .join('');
      if (initials === newTitle.trim()) return true;
    }

    // Check if candidate looks like initials of new title
    if (/^[A-Z]{2,5}$/.test(candidate.trim())) {
      const initials = newTitle.split(/[\s.]+/)
        .filter(w => w.length > 0)
        .map(w => w[0].toUpperCase())
        .join('');
      if (initials === candidate.trim()) return true;
    }

    // Edit distance check for short names (OCR variants like Ilco/Ilko)
    if (newLower.length <= 10 && candLower.length <= 10) {
      let same = 0;
      for (let i = 0; i < Math.min(newLower.length, candLower.length); i++) {
        if (newLower[i] === candLower[i]) same++;
      }
      if (same >= Math.min(newLower.length, candLower.length) * 0.6) return true;
    }

    return false;
  });
}

/**
 * Ask the LLM whether a new title matches any existing title in the group.
 * Pairwise approach — more reliable than batch grouping with small models.
 *
 * @param {string} newTitle - Title to check
 * @param {string[]} existingTitles - Titles in the candidate group
 * @param {string} section - Section name for context
 * @returns {Promise<{match: boolean, matchedTitle: string|null, reason: string}>}
 */
async function llmPairwiseCheck(newTitle, existingTitles, section) {
  const ollamaUrl = process.env.OLLAMA_URL || 'http://10.0.0.3:11434';
  const model = process.env.ENTITY_RESOLVE_MODEL || 'qwen2.5:3b';

  const titleList = existingTitles.map((t, i) => `${i + 1}. "${t}"`).join('\n');

  const prompt = `Does this new entity match any existing entity in the list?

Section: ${section}
New entity: "${newTitle}"

Existing entities:
${titleList}

Examples of matches:
- "EHD" matches "Eelco H. Dykstra" (initials of first letters: E.H.D.)
- "Eelco H. Dykstra, M.D." matches "Eelco H. Dykstra" (same person with title)
- "Eelco H. Dykstra (ocr-uncertain)" matches "Eelco H. Dykstra" (same with OCR flag)
- "Christian Mueller" matches "Christian Fu Mueller" (partial name)
- "CEN TC 391" matches "CEN Technical Committee TC 391" (abbreviation)
- "SVDC" matches "SVDC (www.svdc.nl)" (URL variant)
- "South East Asia" matches "Southeast Asia" (spacing variant)
- "transition collective" matches "Transition Collective" (case variant)
- "SVDC" does NOT match "South America" (different entities)

Respond ONLY with JSON:
{"match": true, "index": 1, "reason": "same person"}
or
{"match": false}`;

  const response = await fetch(`${ollamaUrl}/api/generate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model,
      prompt,
      stream: false,
      options: { temperature: 0.0, num_predict: 100 },
    }),
  });

  if (!response.ok) {
    throw new Error(`Ollama ${response.status}`);
  }

  const data = await response.json();
  const raw = data.response || '';
  const cleaned = raw.replace(/```json?\s*/gi, '').replace(/```/g, '').trim();

  try {
    const parsed = JSON.parse(cleaned.match(/\{[^}]+\}/)?.[0] || '{}');
    if (parsed.match && typeof parsed.index === 'number' &&
        parsed.index >= 1 && parsed.index <= existingTitles.length) {
      return {
        match: true,
        matchedTitle: existingTitles[parsed.index - 1],
        reason: parsed.reason || 'matched',
      };
    }
  } catch { /* parse failed = no match */ }

  return { match: false, matchedTitle: null, reason: 'no match' };
}

// ============================================================
// Build merge groups using normalization + pairwise LLM
// ============================================================

/**
 * Group titles by entity using two passes:
 * 1. String normalization (free, instant)
 * 2. LLM pairwise comparison (for remaining ungrouped titles)
 *
 * @param {string[]} titles - Page titles in a section
 * @param {string} section - Section name
 * @returns {Promise<Array<{canonical: string, titles: string[]}>>}
 */
async function buildMergeGroups(titles, section) {
  const groups = []; // Array of { canonical, titles: string[] }
  const assigned = new Set();

  // Pass 1: String normalization
  const normMap = new Map(); // normalized → first title seen
  for (const title of titles) {
    const norm = normalizeEntityName(title);
    if (!norm) continue;

    if (normMap.has(norm)) {
      // Find or create group for this normalized name
      const existing = normMap.get(norm);
      let group = groups.find(g => g.titles.includes(existing));
      if (!group) {
        group = { canonical: existing, titles: [existing] };
        groups.push(group);
        assigned.add(existing);
      }
      group.titles.push(title);
      assigned.add(title);
    } else {
      normMap.set(norm, title);
    }
  }

  // Pass 2: LLM pairwise for remaining ungrouped titles
  // For each ungrouped title, ask the LLM if it matches any group canonical
  // or any other ungrouped title not yet assigned.

  for (const title of titles) {
    // Skip if already assigned to a group in this pass or the normalization pass
    if (assigned.has(title)) continue;

    // Build candidate list: group canonicals + unassigned titles (excluding self)
    const candidates = [
      ...groups.map(g => g.canonical),
      ...titles.filter(t => t !== title && !assigned.has(t) &&
        !groups.some(g => g.canonical === t)),
    ];

    if (candidates.length === 0) continue;

    // Pre-filter to plausible candidates — prevents LLM hallucinations
    const filtered = preFilterCandidates(title, candidates);
    if (filtered.length === 0) continue;

    try {
      const result = await llmPairwiseCheck(title, filtered, section);
      if (result.match && result.matchedTitle) {
        // Hallucination guard: verify matchedTitle is in our candidate list
        if (!candidates.includes(result.matchedTitle)) {
          console.log(`    LLM hallucination: "${title}" → "${result.matchedTitle}" (not in candidates)`);
          continue;
        }

        // Find existing group or create one
        let group = groups.find(g =>
          g.canonical === result.matchedTitle || g.titles.includes(result.matchedTitle)
        );
        if (!group) {
          group = { canonical: result.matchedTitle, titles: [result.matchedTitle] };
          groups.push(group);
          assigned.add(result.matchedTitle);
        }
        if (!group.titles.includes(title)) {
          group.titles.push(title);
        }
        assigned.add(title);
        console.log(`    LLM: "${title}" → "${result.matchedTitle}" (${result.reason})`);
      }
    } catch (err) {
      console.log(`    LLM error for "${title}": ${err.message}`);
    }
  }

  // Pick canonical: longest title in each group (usually the most complete name)
  for (const group of groups) {
    // Prefer the title without (ocr-uncertain), without trailing punctuation
    const clean = group.titles.filter(t => !t.includes('(ocr-uncertain)'));
    const sorted = (clean.length > 0 ? clean : group.titles)
      .sort((a, b) => b.length - a.length);
    group.canonical = sorted[0];
  }

  // Only return groups with 2+ titles
  return groups.filter(g => g.titles.length >= 2);
}

// ============================================================
// Content merging
// ============================================================

function extractUniqueSentences(keeperContent, dupeContent) {
  if (!dupeContent?.trim()) return [];

  const dupeSentences = dupeContent
    .split(/[.!?]+/)
    .map(s => s.trim())
    .filter(s => s.length > 20);

  const keeperLower = (keeperContent || '').toLowerCase();
  return dupeSentences.filter(s =>
    !keeperLower.includes(s.toLowerCase().substring(0, 40))
  );
}

function extractSourceReferences(content) {
  if (!content) return [];
  return content.split('\n').filter(line =>
    line.startsWith('*Extracted from:') ||
    line.startsWith('*Also referenced in:')
  );
}

function parseFrontmatter(content) {
  if (!content || !content.startsWith('---')) {
    return { frontmatter: {}, body: content || '' };
  }
  const endIdx = content.indexOf('---', 3);
  if (endIdx === -1) return { frontmatter: {}, body: content };

  const fmBlock = content.substring(3, endIdx).trim();
  const fm = {};
  for (const line of fmBlock.split('\n')) {
    const colonIdx = line.indexOf(':');
    if (colonIdx > 0) {
      const key = line.substring(0, colonIdx).trim();
      let val = line.substring(colonIdx + 1).trim();
      // Parse numbers
      if (/^\d+$/.test(val)) val = parseInt(val, 10);
      // Strip quotes
      else if (/^".*"$/.test(val) || /^'.*'$/.test(val)) val = val.slice(1, -1);
      fm[key] = val;
    }
  }
  const body = content.substring(endIdx + 3).trim();
  return { frontmatter: fm, body };
}

// ============================================================
// Core logic
// ============================================================

async function scanSection(wiki, allPages, sectionTitle, sectionPage) {
  // Find pages under this section
  const children = allPages.filter(p => p.parentId === sectionPage.id);
  if (children.length < 2) {
    console.log(`\nSection: ${sectionTitle} (${children.length} page${children.length === 1 ? '' : 's'}) — skip (< 2 pages)`);
    return { section: sectionTitle, groups: [], pageCount: children.length };
  }

  const titles = children.map(p => p.title);
  console.log(`\nSection: ${sectionTitle} (${titles.length} pages)`);

  // Build merge groups using normalization + pairwise LLM
  let groups;
  try {
    groups = await buildMergeGroups(titles, sectionTitle);
  } catch (err) {
    console.error(`  ERROR: Grouping failed: ${err.message}`);
    return { section: sectionTitle, groups: [], pageCount: titles.length, error: err.message };
  }

  // Display results
  for (const g of groups) {
    console.log(`  GROUP: "${g.canonical}" ← [${g.titles.join(', ')}]`);
  }

  // Count unique pages (not in any group)
  const groupedTitles = new Set(groups.flatMap(g => g.titles));
  const uniqueCount = titles.filter(t => !groupedTitles.has(t)).length;
  if (uniqueCount > 0) {
    console.log(`  UNIQUE: ${uniqueCount} page${uniqueCount === 1 ? '' : 's'} (no duplicates)`);
  }

  // Attach page metadata to groups for merge phase
  for (const g of groups) {
    g.pages = g.titles.map(t => {
      const page = children.find(c => c.title === t);
      return page || { title: t, id: null };
    });
  }

  return { section: sectionTitle, groups, pageCount: titles.length };
}

async function mergeGroup(wiki, allPages, group, sectionPage) {
  const pages = [];

  // Load content and frontmatter for each page
  for (const page of group.pages) {
    if (!page.id) {
      console.log(`  SKIP: "${page.title}" — no page ID`);
      continue;
    }

    // Build page path from filePath or title
    const filePath = page.filePath || page.fileName;
    let pagePath;
    if (filePath) {
      // filePath is like "People/Eelco H. Dykstra/Readme.md" — use as-is
      pagePath = filePath;
    } else {
      // Construct from section + title
      const sectionTitle = allPages.find(p => p.id === page.parentId)?.title || 'Unknown';
      pagePath = `${sectionTitle}/${page.title}/Readme.md`;
    }

    let content = '';
    try {
      content = await wiki.readPageContent(pagePath) || '';
    } catch (err) {
      console.log(`  WARN: Could not read "${page.title}": ${err.message}`);
    }

    const { frontmatter, body } = parseFrontmatter(content);
    pages.push({
      ...page,
      content,
      body,
      frontmatter,
      pagePath,
      accessCount: parseInt(frontmatter.access_count, 10) || 0,
    });
  }

  if (pages.length < 2) {
    console.log(`  SKIP: Group "${group.canonical}" — fewer than 2 readable pages`);
    return null;
  }

  // Sort: highest access_count → longest content → most recently modified
  pages.sort((a, b) => {
    if (b.accessCount !== a.accessCount) return b.accessCount - a.accessCount;
    const aLen = (a.content || '').length;
    const bLen = (b.content || '').length;
    if (bLen !== aLen) return bLen - aLen;
    return new Date(b.lastModified || 0) - new Date(a.lastModified || 0);
  });

  const keeper = pages[0];
  const duplicates = pages.slice(1);

  console.log(`  Keeping: "${keeper.title}" (id=${keeper.id}, access=${keeper.accessCount})`);

  let totalMergedSentences = 0;
  let totalMergedSources = 0;
  let summedAccess = keeper.accessCount;

  for (const dupe of duplicates) {
    console.log(`  Merging: "${dupe.title}" (id=${dupe.id}, access=${dupe.accessCount})`);
    summedAccess += dupe.accessCount;

    // 1. Find unique sentences from duplicate
    const uniqueSentences = extractUniqueSentences(keeper.content, dupe.body);
    totalMergedSentences += uniqueSentences.length;

    // 2. Find new source references
    const newSources = extractSourceReferences(dupe.content)
      .filter(s => !(keeper.content || '').includes(s));
    totalMergedSources += newSources.length;

    // 3. Build additions
    let additions = '';
    if (uniqueSentences.length > 0) {
      additions += `\n\n*Additional context (merged from "${dupe.title}"):*\n${uniqueSentences.join('. ')}.`;
    }
    if (newSources.length > 0) {
      additions += '\n' + newSources.join('\n');
    }

    // 4. Append to keeper if there's new content
    if (additions) {
      const updatedContent = (keeper.content || '') + additions;
      try {
        await wiki.writePageContent(keeper.pagePath, updatedContent);
        keeper.content = updatedContent;
        console.log(`    Added ${uniqueSentences.length} sentences, ${newSources.length} sources`);
      } catch (err) {
        console.error(`    ERROR writing to keeper: ${err.message}`);
      }
    }

    // 5. Compost the duplicate (move to Meta/Archive)
    try {
      await compostPage(wiki, allPages, dupe, `Merged into "${keeper.title}"`);
      console.log(`    Composted: "${dupe.title}"`);
    } catch (err) {
      console.error(`    ERROR composting "${dupe.title}": ${err.message}`);
    }
  }

  // 6. Update keeper's access_count
  if (summedAccess > keeper.accessCount) {
    try {
      const { frontmatter, body } = parseFrontmatter(keeper.content);
      frontmatter.access_count = summedAccess;

      // Rebuild content with updated frontmatter
      const fmLines = Object.entries(frontmatter).map(([k, v]) =>
        `${k}: ${typeof v === 'string' && v.includes(' ') ? `"${v}"` : v}`
      );
      const newContent = `---\n${fmLines.join('\n')}\n---\n\n${body}`;
      await wiki.writePageContent(keeper.pagePath, newContent);
    } catch (err) {
      console.error(`    ERROR updating access_count: ${err.message}`);
    }
  }

  return {
    kept: keeper.title,
    merged: duplicates.map(d => d.title),
    canonical: group.canonical,
    mergedSentences: totalMergedSentences,
    mergedSources: totalMergedSources,
    totalAccess: summedAccess,
  };
}

async function compostPage(wiki, allPages, page, reason) {
  // Ensure Meta section exists
  const landingPage = allPages.find(p => p.parentId === 0);
  let metaSection = allPages.find(p =>
    p.title?.toLowerCase() === 'meta' && p.parentId === landingPage?.id
  );
  if (!metaSection) {
    metaSection = await wiki.createPage(landingPage.id, 'Meta');
    allPages.push(metaSection);
  }

  // Ensure Archive sub-section exists
  let archiveSection = allPages.find(p =>
    p.title?.toLowerCase() === 'archive' && p.parentId === metaSection?.id
  );
  if (!archiveSection) {
    archiveSection = await wiki.createPage(metaSection.id, 'Archive');
    allPages.push(archiveSection);
  }

  // Create archive page
  const archiveContent = `---
title: "${page.title}"
archived: true
archived_reason: "${reason}"
archived_at: "${new Date().toISOString()}"
original_id: ${page.id}
---

*This page was archived because: ${reason}*

${page.content || ''}`;

  const archivePage = await wiki.createPage(archiveSection.id, page.title);
  const archivePath = `Meta/Archive/${page.title}/Readme.md`;
  await wiki.writePageContent(archivePath, archiveContent);

  // Trash the original
  await wiki.trashPage(page.id);
}

// ============================================================
// Main
// ============================================================

/**
 * Apply corrections to scan results:
 * - removeGroups: remove entire groups by canonical name
 * - removeTitles: remove specific titles from groups (by section)
 * - addGroups: add manual groups (by section)
 *
 * @param {Array} allResults - Scan results
 * @param {Object} corrections - Corrections object
 * @param {Array} allPages - All wiki pages (for resolving page metadata)
 */
function applyCorrections(allResults, corrections, allPages) {
  if (!corrections) return;

  // Remove groups by canonical name
  for (const remove of (corrections.removeGroups || [])) {
    for (const result of allResults) {
      if (remove.section && result.section !== remove.section) continue;
      const before = result.groups.length;
      result.groups = result.groups.filter(g => g.canonical !== remove.canonical);
      if (result.groups.length < before) {
        console.log(`  CORRECTION: Removed group "${remove.canonical}" from ${result.section}`);
      }
    }
  }

  // Remove specific titles from groups
  for (const split of (corrections.removeTitles || [])) {
    for (const result of allResults) {
      if (split.section && result.section !== split.section) continue;
      for (const group of result.groups) {
        const before = group.titles.length;
        group.titles = group.titles.filter(t => !split.titles.includes(t));
        group.pages = (group.pages || []).filter(p => !split.titles.includes(p.title));
        if (group.titles.length < before) {
          console.log(`  CORRECTION: Removed [${split.titles.join(', ')}] from group "${group.canonical}"`);
        }
      }
      // Drop groups that fell to < 2 titles
      result.groups = result.groups.filter(g => g.titles.length >= 2);
    }
  }

  // Add manual groups
  for (const add of (corrections.addGroups || [])) {
    let result = allResults.find(r => r.section === add.section);
    if (!result) continue;

    // Resolve page metadata for each title
    const sectionPages = allPages.filter(p => {
      const parent = allPages.find(pp => pp.id === p.parentId);
      return parent && parent.title === add.section;
    });

    const pages = add.titles.map(t => {
      const page = sectionPages.find(sp => sp.title === t);
      return page || { title: t, id: null };
    }).filter(p => p.id !== null);

    if (pages.length < 2) {
      console.log(`  CORRECTION: Skipped manual group "${add.canonical}" — fewer than 2 pages found in wiki`);
      continue;
    }

    // Check if any of these titles are already in an existing group — merge into it
    let existingGroup = null;
    for (const g of result.groups) {
      if (add.titles.some(t => g.titles.includes(t))) {
        existingGroup = g;
        break;
      }
    }

    if (existingGroup) {
      // Merge new titles into existing group
      for (const t of add.titles) {
        if (!existingGroup.titles.includes(t)) {
          existingGroup.titles.push(t);
          const page = pages.find(p => p.title === t);
          if (page) existingGroup.pages.push(page);
        }
      }
      existingGroup.canonical = add.canonical;
      console.log(`  CORRECTION: Extended group "${add.canonical}" ← [${existingGroup.titles.join(', ')}]`);
    } else {
      // Create new group
      result.groups.push({
        canonical: add.canonical,
        titles: pages.map(p => p.title),
        pages,
      });
      console.log(`  CORRECTION: Added group "${add.canonical}" ← [${pages.map(p => p.title).join(', ')}]`);
    }
  }
}

async function main() {
  const args = process.argv.slice(2);
  const doMerge = args.includes('--merge');
  const sectionFilter = args.includes('--section')
    ? args[args.indexOf('--section') + 1]
    : null;
  const correctionsPath = args.includes('--corrections')
    ? args[args.indexOf('--corrections') + 1]
    : null;

  console.log(`=== Wiki Duplicate Resolution ===`);
  console.log(`Mode: ${doMerge ? 'MERGE (will modify wiki)' : 'SCAN (read-only)'}`);
  if (sectionFilter) console.log(`Section filter: ${sectionFilter}`);
  if (correctionsPath) console.log(`Corrections: ${correctionsPath}`);
  console.log('');

  // Load credentials
  const creds = loadCredentials();
  if (!creds.ncUrl || !creds.ncUser || !creds.ncPass) {
    console.error('ERROR: Could not load NC credentials');
    process.exit(1);
  }

  const wiki = new WikiClient(creds);
  const allPages = await wiki.listAllPages();
  console.log(`Total wiki pages: ${allPages.length}`);

  // Find section pages (children of landing page)
  const landingPage = allPages.find(p => p.parentId === 0);
  if (!landingPage) {
    console.error('ERROR: No landing page found');
    process.exit(1);
  }

  const sections = allPages.filter(p => p.parentId === landingPage.id);
  const targetSections = sectionFilter
    ? sections.filter(s => s.title?.toLowerCase() === sectionFilter.toLowerCase())
    : sections;

  if (targetSections.length === 0) {
    console.error(`No sections found${sectionFilter ? ` matching "${sectionFilter}"` : ''}`);
    process.exit(1);
  }

  // Phase: Scan
  const allResults = [];
  for (const section of targetSections) {
    const result = await scanSection(wiki, allPages, section.title, section);
    allResults.push(result);
  }

  // Apply corrections if provided
  if (correctionsPath) {
    console.log(`\n=== Applying Corrections ===`);
    try {
      const corrections = JSON.parse(fs.readFileSync(correctionsPath, 'utf8'));
      applyCorrections(allResults, corrections, allPages);
    } catch (err) {
      console.error(`ERROR loading corrections: ${err.message}`);
      process.exit(1);
    }
  }

  // Summary
  const totalGroups = allResults.reduce((sum, r) => sum + r.groups.length, 0);
  const totalDuplicates = allResults.reduce((sum, r) =>
    sum + r.groups.reduce((s, g) => s + g.titles.length - 1, 0), 0);
  const totalPages = allResults.reduce((sum, r) => sum + r.pageCount, 0);

  console.log(`\n=== Summary ===`);
  console.log(`Sections scanned: ${allResults.length}`);
  console.log(`Total pages: ${totalPages}`);
  console.log(`Merge groups: ${totalGroups}`);
  console.log(`Pages to archive: ${totalDuplicates}`);
  console.log(`Pages remaining: ${totalPages - totalDuplicates}`);

  if (!doMerge) {
    if (totalGroups > 0) {
      console.log(`\nRun with --merge to execute. Review the groups above first.`);
    }
    return;
  }

  // Phase: Merge
  console.log(`\n=== Executing Merges ===`);
  let mergesPerformed = 0;
  let pagesArchived = 0;

  for (const result of allResults) {
    if (result.groups.length === 0) continue;
    console.log(`\nMerging section: ${result.section}`);

    for (const group of result.groups) {
      console.log(`\n  Merge group: "${group.canonical}"`);
      const mergeResult = await mergeGroup(wiki, allPages, group,
        targetSections.find(s => s.title === result.section));

      if (mergeResult) {
        mergesPerformed++;
        pagesArchived += mergeResult.merged.length;
      }
    }
  }

  console.log(`\n=== Merge Complete ===`);
  console.log(`Merges performed: ${mergesPerformed}`);
  console.log(`Pages archived: ${pagesArchived}`);
}

main().catch(err => {
  console.error(`FATAL: ${err.message}`);
  console.error(err.stack);
  process.exit(1);
});
