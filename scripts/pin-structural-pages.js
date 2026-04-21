#!/usr/bin/env node
/**
 * Moltagent Structural Page Pin Tool
 *
 * Adds `compost: never` to the frontmatter of a Collectives wiki page, so
 * WikiSteward's Memory Steward skips it even when the LLM assessment proposes
 * it for composting (see src/lib/maintenance/wiki-steward.js:_markForComposting).
 *
 * Why this exists: structural pages (section indexes, Meta landing pages)
 * never surface as probe hits — probes target content, not navigation — so
 * their `access_count` stays at 0 by design. Without a pin, the Memory
 * Steward reads 0 and tautologically proposes them for archival.
 *
 * Safety:
 * - Direct WebDAV GET via CollectivesClient.readPageContent — bypasses
 *   writePageWithFrontmatter's wikilink resolution so [[X]] markup in the
 *   body is NOT mutated on round-trip.
 * - Direct WebDAV PUT via writePageContent.
 * - Read-back verification confirms: (a) `compost: never` present after
 *   write, (b) body byte-identical to pre-write, (c) existing frontmatter
 *   fields unchanged on add-only mode.
 *
 * Modes:
 *   add-only     — page already has frontmatter; add `compost: never` alongside
 *   prepend-fm   — page has no frontmatter; prepend `type: meta` + `compost: never`
 *
 * Usage:
 *   sudo systemd-run --pipe --service-type=oneshot \
 *     --property=LoadCredential=nc-password:/etc/credstore/moltagent-nc-password \
 *     --property=Environment=NC_URL=<url> \
 *     --property=Environment=NC_USER=<user> \
 *     --working-directory=/opt/moltagent \
 *     /usr/bin/node scripts/pin-structural-pages.js <id> "<title>" "<path>" <mode>
 *
 * Example (pin the People section index):
 *   node scripts/pin-structural-pages.js 96552 "People" "People.md" add-only
 *
 * @module pin-structural-pages
 */

const NCRequestManager = require('../src/lib/nc-request-manager');
const CollectivesClient = require('../src/lib/integrations/collectives-client');
const { parseFrontmatter, serializeFrontmatter } = require('../src/lib/knowledge/frontmatter');

async function main() {
  const [id, title, webdavPath, mode] = process.argv.slice(2);
  if (!id || !title || !webdavPath || !mode) {
    console.error('Usage: pin-structural-pages.js <id> <title> <path> <add-only|prepend-fm>');
    process.exit(2);
  }
  if (mode !== 'add-only' && mode !== 'prepend-fm') {
    console.error(`Unknown mode: ${mode}. Expected 'add-only' or 'prepend-fm'.`);
    process.exit(2);
  }

  const nc = new NCRequestManager({
    nextcloud: { url: process.env.NC_URL, username: process.env.NC_USER },
  });
  nc.setBootstrapCredential();
  await nc.resolveCanonicalUsername();
  const client = new CollectivesClient(nc, { collectiveName: 'Moltagent Knowledge' });
  await client.resolveCollective();

  console.log(`\n--- Pinning: "${title}" id=${id} path=${webdavPath} mode=${mode} ---`);

  const before = await client.readPageContent(webdavPath);
  if (before === null) throw new Error(`Page not found at path: ${webdavPath}`);
  console.log(`  read: ${before.length} bytes`);

  const { frontmatter: beforeFm, body: beforeBody } = parseFrontmatter(before);
  const hadFm = Object.keys(beforeFm).length > 0;
  console.log(`  had FM: ${hadFm}  (keys: ${Object.keys(beforeFm).join(',') || '(none)'})`);
  console.log(`  body length: ${beforeBody.length}`);

  if (mode === 'add-only' && !hadFm) {
    throw new Error('mode=add-only but page has no frontmatter');
  }
  if (mode === 'prepend-fm' && hadFm) {
    throw new Error('mode=prepend-fm but page already has frontmatter');
  }

  if (beforeFm.compost === 'never') {
    console.log('  SKIP: already pinned (compost: never). No write issued.');
    return;
  }

  let newContent;
  if (mode === 'add-only') {
    const newFm = { ...beforeFm, compost: 'never' };
    newContent = serializeFrontmatter(newFm, beforeBody);
    console.log(`  new FM keys: ${Object.keys(newFm).join(',')}`);
  } else {
    // prepend-fm: body is the entire original content; frontmatter is new.
    // Build the YAML block manually so serializeFrontmatter does not touch
    // the existing body (which must remain byte-identical on round-trip).
    newContent = `---\ntype: meta\ncompost: never\n---\n${before}`;
    console.log('  new FM keys: type,compost');
  }

  console.log(`  new content length: ${newContent.length}`);

  await client.writePageContent(webdavPath, newContent);
  console.log('  write: OK');

  const after = await client.readPageContent(webdavPath);
  if (after === null) throw new Error('read-back returned null — page disappeared?');

  const { frontmatter: afterFm, body: afterBody } = parseFrontmatter(after);

  if (afterFm.compost !== 'never') {
    throw new Error(`read-back FM missing compost:never — got: ${JSON.stringify(afterFm)}`);
  }

  const expectedBody = (mode === 'add-only') ? beforeBody : before;
  if (afterBody !== expectedBody) {
    const maxLen = Math.min(expectedBody.length, afterBody.length);
    let diffAt = -1;
    for (let i = 0; i < maxLen; i++) {
      if (expectedBody.charCodeAt(i) !== afterBody.charCodeAt(i)) { diffAt = i; break; }
    }
    if (diffAt === -1 && expectedBody.length !== afterBody.length) diffAt = maxLen;
    console.error('  BODY MISMATCH');
    console.error('    expected length:', expectedBody.length);
    console.error('    actual length:  ', afterBody.length);
    console.error('    first diff at byte:', diffAt);
    console.error('    expected context:', JSON.stringify(expectedBody.slice(Math.max(0, diffAt - 40), diffAt + 40)));
    console.error('    actual context:  ', JSON.stringify(afterBody.slice(Math.max(0, diffAt - 40), diffAt + 40)));
    throw new Error('BODY CORRUPTED on read-back — STOP');
  }

  if (mode === 'add-only') {
    for (const [k, v] of Object.entries(beforeFm)) {
      if (JSON.stringify(afterFm[k]) !== JSON.stringify(v)) {
        throw new Error(`FM key "${k}" changed on round-trip: before=${JSON.stringify(v)} after=${JSON.stringify(afterFm[k])}`);
      }
    }
  }

  console.log(`  VERIFIED: compost:never present, body byte-identical (${afterBody.length} B), FM preserved`);
}

if (require.main === module) {
  main().catch(e => { console.error('\nFAILED:', e.message); process.exit(1); });
}
