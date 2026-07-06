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

'use strict';

/*
 * Architecture Brief
 * ------------------
 * Problem: Before the signal-integrity fixes (Phases 3 and 4), every flag
 * idempotency check keyed on strings the medium kept rewriting, so live
 * pages accumulated contradiction-flag walls (one pair reached 179 stacked
 * blocks); NC Text round-trips left escaped wikilinks that re-flooded
 * Related sections; the root-create fallback strewed flat pages at the
 * collective root; and the access_count=0 tautology marked real content
 * pages compost_ready. The steward now writes correctly, but the corpus
 * still carries the old damage.
 *
 * Pattern: One-shot repair script, pin-structural-pages.js lineage.
 * DRY-RUN BY DEFAULT — prints every intended change and writes nothing.
 * The write pass (--write) runs only after human approval of the dry-run
 * report. NC file versioning / trash are the undo.
 *
 * What it does per page (one pass):
 *   1. Collapse steward flag walls to ONE block per (marker, partner) pair —
 *      the Phase 3 key. First occurrence wins; the claim text of dropped
 *      blocks is gone (it was LLM rewording of the same finding).
 *   2. Persist the Phase 4 medium repair: content is read through the
 *      sanitizing chokepoint (attributes, <link href>, escaped wikilinks all
 *      canonicalized) and written back clean.
 *   3. Dedupe Related entries by link target (structural markup matching).
 *   4. Strip stale verification_note frontmatter (Phase 3 deleted the writer).
 *   5. Unmark compost_ready born from the access_count=0 tautology
 *      (compost_ready true while access_count is 0/absent).
 *   6. Trash stray root pages (flat fallback-born .md at the collective
 *      root) — EXCEPT the configured keep-list: the "Moltagent Knowledge"
 *      stray stays until the Phase 5 root-create fallback fix is live,
 *      because deleting it earlier lets the live fallback recreate it.
 *
 * Writes go path-addressed via writePageContent — deliberately NOT
 * writePageWithFrontmatter, whose title lookup falls back to creating
 * root pages on a miss (the Phase 5 wound this corpus documents).
 *
 * Usage (dry run):
 *   NC_CREDENTIAL_FILE=... NC_URL=... NC_USER=... node scripts/cleanup-wiki-signal-integrity.js
 * Write pass (after dry-run approval):
 *   ... node scripts/cleanup-wiki-signal-integrity.js --write
 *
 * @module cleanup-wiki-signal-integrity
 */

const NCRequestManager = require('../src/lib/nc-request-manager');
const CollectivesClient = require('../src/lib/integrations/collectives-client');
const { parseFrontmatter, serializeFrontmatter } = require('../src/lib/knowledge/frontmatter');

const WRITE = process.argv.includes('--write');

// Steward flag markers (system-emitted constants; see wiki-steward.js Phase 3)
const FLAG_MARKERS = [
  { marker: 'Contradiction flagged by Knowledge Steward', partnerRe: /conflicts with \[\[([^\]]+)\]\]|conflicts with \[([^\]]+)\]\(/ },
  { marker: 'Near-duplicate flagged by Connection Steward', partnerRe: /same entity as \[\[([^\]]+)\]\]|same entity as \[([^\]]+)\]\(/ },
];

// Stray root pages that must NOT be touched yet (Phase 5 dependency).
const KEEP_STRAYS = new Set(['Moltagent Knowledge']);

// Bootstrap sections are legitimate root children (proper folder sections).
const BOOTSTRAP_SECTIONS = new Set([
  'People', 'Projects', 'Procedures', 'Research', 'Meta',
  'Components', 'Infrastructure', 'Organizations', 'Agents', 'Documents', 'Sessions',
].map(s => s.toLowerCase()));

/** Collapse flag walls: keep the first line per (marker, partner) pair. */
function collapseFlagWalls(body) {
  const lines = body.split('\n');
  const seenPairs = new Set();
  const out = [];
  let dropped = 0;
  let prevDropped = false;
  for (const line of lines) {
    const flag = FLAG_MARKERS.find(f => line.includes(f.marker));
    if (!flag) {
      // Swallow at most one blank separator following a dropped flag line so
      // collapsed walls don't leave hundreds of empty lines behind.
      if (prevDropped && line.trim() === '') { prevDropped = false; continue; }
      prevDropped = false;
      out.push(line);
      continue;
    }
    const m = flag.partnerRe.exec(line);
    const partner = m ? (m[1] || m[2] || '').trim() : `__unparsed:${line.slice(0, 80)}`;
    const key = `${flag.marker}::${partner}`;
    if (seenPairs.has(key)) { dropped++; prevDropped = true; continue; }
    seenPairs.add(key);
    prevDropped = false;
    out.push(line);
  }
  return { body: out.join('\n'), dropped, pairs: seenPairs.size };
}

/** Dedupe Related-section entries by link target (first occurrence wins). */
function dedupeRelated(body) {
  const lines = body.split('\n');
  const out = [];
  const seenTargets = new Set();
  let inRelated = false;
  let dropped = 0;
  for (const line of lines) {
    if (/^##\s+Related\s*$/.test(line.trim())) { inRelated = true; out.push(line); continue; }
    if (/^##?#?\s+\S/.test(line) && !/^##\s+Related/.test(line)) inRelated = false;
    if (inRelated) {
      const m = /^\s*-\s*(?:\[\[([^\]]+)\]\]|\[([^\]]+)\]\()/.exec(line);
      if (m) {
        const target = (m[1] || m[2] || '').trim().toLowerCase();
        if (seenTargets.has(target)) { dropped++; continue; }
        seenTargets.add(target);
      }
    }
    out.push(line);
  }
  return { body: out.join('\n'), dropped };
}

async function main() {
  console.log(`=== Cleanup A: wiki signal-integrity repair — ${WRITE ? 'WRITE PASS' : 'DRY RUN (no writes)'} ===\n`);

  const nc = new NCRequestManager({
    nextcloud: { url: process.env.NC_URL, username: process.env.NC_USER },
  });
  nc.setBootstrapCredential();
  await nc.resolveCanonicalUsername();
  const client = new CollectivesClient(nc, { collectiveName: 'Moltagent Knowledge' });
  const collectiveId = await client.resolveCollective();
  const pages = await client.listPages(collectiveId);
  const pageList = Array.isArray(pages) ? pages : [];
  console.log(`collective ${collectiveId}: ${pageList.length} pages\n`);

  const landing = pageList.find(p => p.parentId === 0 || p.parentId == null);

  const bodyRepairs = [];
  const compostUnmarks = [];

  for (const p of pageList) {
    if (landing && p.id === landing.id) continue;
    const pagePath = p.filePath ? `${p.filePath}/${p.fileName}` : p.fileName;
    if (!pagePath) continue;

    let content;
    try {
      // Sanitized read: the Phase 4 chokepoint canonicalizes Tiptap
      // attributes, <link href> marks, and escaped wikilinks right here.
      content = await client.readPageContent(pagePath);
    } catch (err) {
      console.log(`READ FAILED ${pagePath}: ${err.message}`);
      continue;
    }
    if (content == null) continue;

    const { frontmatter, body } = parseFrontmatter(content);

    const walls = collapseFlagWalls(body);
    const related = dedupeRelated(walls.body);

    const fm = { ...frontmatter };
    const fmChanges = [];
    if ('verification_note' in fm) { delete fm.verification_note; fmChanges.push('verification_note stripped'); }
    if (fm.compost_ready === true && !(Number(fm.access_count) > 0)) {
      delete fm.compost_ready;
      delete fm.compost_reason;
      delete fm.compost_marked_at;
      fmChanges.push('compost_ready unmarked (access_count=0 tautology)');
      compostUnmarks.push(p.title);
    }

    const hadFm = Object.keys(frontmatter).length > 0;
    const newContent = hadFm || Object.keys(fm).length > 0
      ? serializeFrontmatter(fm, related.body)
      : related.body;

    if (newContent !== content) {
      bodyRepairs.push({
        id: p.id,
        title: p.title,
        path: pagePath,
        bytesBefore: content.length,
        bytesAfter: newContent.length,
        flagBlocksDropped: walls.dropped,
        flagPairsKept: walls.pairs,
        relatedDupesDropped: related.dropped,
        fmChanges,
      });
      if (WRITE) {
        // Pages are independent: one failed PUT must not abort the rest.
        try {
          await client.writePageContent(pagePath, newContent);
          console.log(`WROTE ${pagePath}`);
        } catch (err) {
          console.log(`WRITE FAILED ${pagePath}: ${err.message}`);
        }
      }
    }
  }

  // Stray root pages: flat fallback-born .md files at the collective root.
  const strays = pageList.filter(p =>
    landing && p.parentId === landing.id &&
    !p.filePath && // flat file at root — proper sections are folders
    !BOOTSTRAP_SECTIONS.has((p.title || '').toLowerCase())
  );

  console.log('--- Body repairs (walls, related dupes, medium, frontmatter) ---');
  console.log('| id | page | bytes before → after | flag blocks dropped | pairs kept | related dupes | frontmatter |');
  console.log('|---|---|---|---|---|---|---|');
  for (const r of bodyRepairs) {
    console.log(`| ${r.id} | ${r.title} | ${r.bytesBefore} → ${r.bytesAfter} | ${r.flagBlocksDropped} | ${r.flagPairsKept} | ${r.relatedDupesDropped} | ${r.fmChanges.join('; ') || '—'} |`);
  }

  console.log('\n--- Stray root pages (flat fallback-born files) ---');
  for (const s of strays) {
    const keep = KEEP_STRAYS.has(s.title);
    const action = keep ? 'KEEP until Phase 5 fallback fix is live' : 'TRASH (soft-delete; NC trash is the undo)';
    console.log(`  id=${s.id} "${s.title}" (${s.fileName}) → ${action}`);
    if (WRITE && !keep) {
      try {
        await client.trashPage(collectiveId, s.id);
        console.log(`  TRASHED ${s.id}`);
      } catch (err) {
        console.log(`  TRASH FAILED ${s.id}: ${err.message}`);
      }
    }
  }

  console.log(`\n--- compost_ready unmarked (${compostUnmarks.length}) ---`);
  for (const t of compostUnmarks) console.log(`  ${t}`);

  console.log(`\n${WRITE ? 'Write pass complete.' : 'Dry run complete — nothing written.'}`);
  console.log(`Pages needing body repair: ${bodyRepairs.length}; strays to trash: ${strays.filter(s => !KEEP_STRAYS.has(s.title)).length}; kept strays: ${strays.filter(s => KEEP_STRAYS.has(s.title)).length}`);
}

main().catch(err => { console.error('CLEANUP FAILED:', err.message); process.exit(1); });
