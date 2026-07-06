'use strict';

/**
 * WikiSteward — compost mover (#245), durable state (#246), and the two
 * link/root guards (#255, #256).
 *
 * Custom test runner (test/asyncTest/summary/exitWithCode + assert), not
 * jest/mocha. Self-contained inline mocks; does not touch mock-factories.js.
 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { test, asyncTest, summary, exitWithCode } = require('../../helpers/test-runner');
const { WikiSteward } = require('../../../src/lib/maintenance/wiki-steward');
const { ObservationLog } = require('../../../src/lib/maintenance/observation-log');

const silentLogger = { debug() {}, info() {}, warn() {}, error() {} };

// A logger that records every line so guard assertions can inspect them.
function makeSpyLogger() {
  const lines = { info: [], warn: [], error: [], debug: [] };
  return {
    debug: (m) => lines.debug.push(m),
    info: (m) => lines.info.push(m),
    warn: (m) => lines.warn.push(m),
    error: (m) => lines.error.push(m),
    _lines: lines,
    _all: () => [...lines.info, ...lines.warn, ...lines.error, ...lines.debug],
  };
}

const DAY_MS = 24 * 60 * 60 * 1000;
const daysAgoISO = (n) => new Date(Date.now() - n * DAY_MS).toISOString();

// Mock CollectivesClient with the move primitives the mover flows through.
function makeMoverClient({ pagesByPath = {}, suffixCollision = false } = {}) {
  const created = [];
  const trashed = [];
  const written = {};
  let nextId = 5000;
  return {
    _created: created,
    _trashed: trashed,
    _written: written,
    resolveCollective: async () => 10,
    ensureSection: async (_cid, name) => ({ id: 999, title: name, parentId: 1 }),
    createPage: async (_cid, parentId, title) => {
      const t = suffixCollision ? `${title} (2)` : title;
      const page = { id: ++nextId, title: t, parentId, filePath: 'Archive', fileName: `${t}.md` };
      created.push(page);
      return page;
    },
    _buildPagePath: (p) => (p.fileName
      ? (p.filePath ? `${p.filePath}/${p.fileName}` : p.fileName)
      : `${p.title}.md`),
    trashPage: async (_cid, id) => { trashed.push(id); },
    readPageWithFrontmatterAtPath: async (p) => (pagesByPath[p] ? { ...pagesByPath[p] } : null),
    writePageWithFrontmatterAtPath: async (p, fm, body) => { written[p] = { frontmatter: fm, body }; return p; },
  };
}

function makeDeps(overrides = {}) {
  return {
    collectivesClient: makeMoverClient(),
    knowledgeGraph: { getEntity: () => null, relatedTo: () => [] },
    vectorStore: { getMetadata: () => null, upsert: () => {}, count: () => 0 },
    embeddingClient: { embed: async () => [0.1] },
    llmRouter: { route: async () => ({ result: '{}' }) },
    observationLog: new ObservationLog({ logger: silentLogger }),
    logger: silentLogger,
    config: { dataDir: null }, // in-memory: no state file in most tests
    ...overrides,
  };
}

// Build a neighborhood page carrying frontmatter, plus register its full body
// on the client so _moveToArchive's re-read succeeds.
function makePage(client, title, frontmatter, { section = 'People', body = `# ${title}\n\nbody` } = {}) {
  const p = `${section}/${title}.md`;
  client._pagesByPath = client._pagesByPath || {};
  // Wire the read map used by readPageWithFrontmatterAtPath.
  const readMap = client.__readMap || (client.__readMap = {});
  readMap[p] = { frontmatter: { ...frontmatter }, body, path: p };
  const origRead = client.readPageWithFrontmatterAtPath;
  client.readPageWithFrontmatterAtPath = async (path_) => (readMap[path_] ? { ...readMap[path_] } : origRead(path_));
  return { id: `id-${title}`, title, path: p, section, frontmatter: { ...frontmatter }, bodyPreview: body.slice(0, 20), wikilinks: [], graphConnections: [], hasEmbedding: true };
}

function neighborhoodOf(pages, cluster = 'People') {
  return { cluster, sections: new Set([cluster]), pages };
}

const EMPTY_MEMORY_ASSESSMENT = { strengthen: [], compost: [], embed: [] };

// ---------------------------------------------------------------------------
// A. COMPOST MOVER (#245)
// ---------------------------------------------------------------------------

asyncTest('mover: an eligible page moves to Archive/, stamped archived, original trashed', async () => {
  const client = makeMoverClient();
  const steward = new WikiSteward(makeDeps({ collectivesClient: client }));
  const page = makePage(client, 'Old Contact', { compost_ready: true, compost_marked_at: daysAgoISO(8) });
  const res = await steward._intervene('memory', EMPTY_MEMORY_ASSESSMENT, neighborhoodOf([page]));

  assert.strictEqual(client._created.length, 1, 'one Archive page created');
  assert.strictEqual(client._created[0].parentId, 999, 'created under Archive section');
  const wroteTo = Object.keys(client._written)[0];
  assert.ok(/^Archive\//.test(wroteTo), 'written under Archive/');
  assert.strictEqual(client._written[wroteTo].frontmatter.archived, true, 'archived:true stamped');
  assert.ok(client._written[wroteTo].frontmatter.archived_at, 'archived_at stamped');
  assert.strictEqual(client._written[wroteTo].frontmatter.compost, 'never', 'archived copy pinned inert');
  assert.ok(client._trashed.includes('id-Old Contact'), 'original trashed');
  assert.strictEqual(res.pagesModified, 1, 'pagesModified bumped for Level 1 refresh');
});

asyncTest('mover: full body is preserved (not the truncated preview)', async () => {
  const client = makeMoverClient();
  const steward = new WikiSteward(makeDeps({ collectivesClient: client }));
  const longBody = '# Title\n\n' + 'x'.repeat(2000);
  const page = makePage(client, 'Long Page', { compost_ready: true, compost_marked_at: daysAgoISO(10) }, { body: longBody });
  await steward._intervene('memory', EMPTY_MEMORY_ASSESSMENT, neighborhoodOf([page]));
  const wroteTo = Object.keys(client._written)[0];
  assert.strictEqual(client._written[wroteTo].body, longBody, 'full body written to Archive copy');
});

// Eligibility matrix — each condition individually BLOCKS the move.
asyncTest('mover blocked: compost_ready absent', async () => {
  const client = makeMoverClient();
  const steward = new WikiSteward(makeDeps({ collectivesClient: client }));
  const page = makePage(client, 'Not Ready', { compost_marked_at: daysAgoISO(30) });
  await steward._intervene('memory', EMPTY_MEMORY_ASSESSMENT, neighborhoodOf([page]));
  assert.strictEqual(client._created.length, 0, 'no move without compost_ready');
});

asyncTest('mover blocked: marked less than 7 days ago (veto window)', async () => {
  const client = makeMoverClient();
  const steward = new WikiSteward(makeDeps({ collectivesClient: client }));
  const page = makePage(client, 'Too Fresh', { compost_ready: true, compost_marked_at: daysAgoISO(3) });
  await steward._intervene('memory', EMPTY_MEMORY_ASSESSMENT, neighborhoodOf([page]));
  assert.strictEqual(client._created.length, 0, 'no move inside the 7-day veto window');
});

asyncTest('mover blocked: already archived', async () => {
  const client = makeMoverClient();
  const steward = new WikiSteward(makeDeps({ collectivesClient: client }));
  const page = makePage(client, 'Already Gone', { compost_ready: true, compost_marked_at: daysAgoISO(30), archived: true });
  await steward._intervene('memory', EMPTY_MEMORY_ASSESSMENT, neighborhoodOf([page]));
  assert.strictEqual(client._created.length, 0, 'no re-move of an archived page');
});

asyncTest('mover blocked: structural page (type: section)', async () => {
  const client = makeMoverClient();
  const steward = new WikiSteward(makeDeps({ collectivesClient: client }));
  const page = makePage(client, 'People', { type: 'section', compost_ready: true, compost_marked_at: daysAgoISO(30) });
  await steward._intervene('memory', EMPTY_MEMORY_ASSESSMENT, neighborhoodOf([page]));
  assert.strictEqual(client._created.length, 0, 'structural page never moved');
});

asyncTest('mover blocked: pinned (compost: never)', async () => {
  const client = makeMoverClient();
  const steward = new WikiSteward(makeDeps({ collectivesClient: client }));
  const page = makePage(client, 'Pinned', { compost: 'never', compost_ready: true, compost_marked_at: daysAgoISO(30) });
  await steward._intervene('memory', EMPTY_MEMORY_ASSESSMENT, neighborhoodOf([page]));
  assert.strictEqual(client._created.length, 0, 'pinned page never moved');
});

asyncTest('mover blocked: compost_marked_at malformed', async () => {
  const client = makeMoverClient();
  const steward = new WikiSteward(makeDeps({ collectivesClient: client }));
  const page = makePage(client, 'Bad Date', { compost_ready: true, compost_marked_at: 'not-a-date' });
  await steward._intervene('memory', EMPTY_MEMORY_ASSESSMENT, neighborhoodOf([page]));
  assert.strictEqual(client._created.length, 0, 'unparseable marked_at blocks the move');
});

asyncTest('mover: cap of 3 moves per visit', async () => {
  const client = makeMoverClient();
  const steward = new WikiSteward(makeDeps({ collectivesClient: client }));
  const pages = [];
  for (let i = 0; i < 5; i++) {
    pages.push(makePage(client, `Stale ${i}`, { compost_ready: true, compost_marked_at: daysAgoISO(30) }));
  }
  const res = await steward._intervene('memory', EMPTY_MEMORY_ASSESSMENT, neighborhoodOf(pages));
  assert.strictEqual(client._created.length, 3, 'exactly 3 moved, cap enforced');
  assert.strictEqual(res.pagesModified, 3);
  assert.strictEqual(client._trashed.length, 3, 'exactly 3 originals trashed');
});

asyncTest('_moveToArchive: leaf-title collision preserves content at the suffixed path', async () => {
  // A distinct same-named page already lives in Archive, so createPage returns
  // a "(2)" title. Content MUST be written (never trashed uncopied) — the
  // regression the reviewer caught: a blind trash-both loses the body.
  const client = makeMoverClient({ suffixCollision: true });
  const steward = new WikiSteward(makeDeps({ collectivesClient: client }));
  const body = '# Dup Page\n\nunique content that must survive';
  const page = makePage(client, 'Dup Page', { compost_ready: true, compost_marked_at: daysAgoISO(9) }, { body });
  const ok = await steward._moveToArchive({ id: page.id, title: page.title, path: page.path });
  assert.strictEqual(ok, true, 'move reported complete');
  const wroteTo = Object.keys(client._written)[0];
  assert.ok(/Dup Page \(2\)/.test(wroteTo), 'written to the suffixed Archive path');
  assert.strictEqual(client._written[wroteTo].body, body, 'body preserved, not lost');
  assert.ok(client._trashed.includes('id-Dup Page'), 'original trashed only after content is written');
});

asyncTest('_moveToArchive: created page with no resolvable path trashes the stub, keeps original', async () => {
  const client = makeMoverClient();
  // createPage returns a page lacking fileName/filePath — an unbuildable path.
  client.createPage = async () => ({ id: 7777, title: 'Stubby' });
  const steward = new WikiSteward(makeDeps({ collectivesClient: client }));
  const page = makePage(client, 'Stubby', { compost_ready: true, compost_marked_at: daysAgoISO(9) });
  const ok = await steward._moveToArchive({ id: page.id, title: page.title, path: page.path });
  assert.strictEqual(ok, false, 'move aborted');
  assert.ok(client._trashed.includes(7777), 'empty stub trashed so it cannot collide on retry');
  assert.ok(!client._trashed.includes('id-Stubby'), 'original left in place — content preserved');
  assert.strictEqual(Object.keys(client._written).length, 0, 'no write when path unresolvable');
});

asyncTest('_moveToArchive: defense-in-depth honors compost: never even off the loop', async () => {
  const client = makeMoverClient();
  const steward = new WikiSteward(makeDeps({ collectivesClient: client }));
  const page = makePage(client, 'Pinned Direct', { compost: 'never' });
  const ok = await steward._moveToArchive({ id: page.id, title: page.title, path: page.path });
  assert.strictEqual(ok, false, 'pinned page refused');
  assert.strictEqual(client._created.length, 0);
});

// ---------------------------------------------------------------------------
// B. DURABLE STATE (#246)
// ---------------------------------------------------------------------------

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'wiki-steward-state-'));
}

asyncTest('persistence: _lastVisit and lens rings round-trip across a restart', async () => {
  const dir = tmpDir();
  const s1 = new WikiSteward(makeDeps({ config: { dataDir: dir } }));
  s1._lastVisit.set('People', 1720000000000);
  s1._nextSteward('People'); // advance lens ring: 0 -> 1
  s1._nextSteward('Projects'); // 0 -> 1
  s1.flush();

  const stateFile = path.join(dir, 'wiki-steward-state.json');
  assert.ok(fs.existsSync(stateFile), 'state file written on flush');

  const s2 = new WikiSteward(makeDeps({ config: { dataDir: dir } }));
  assert.strictEqual(s2._lastVisit.get('People'), 1720000000000, '_lastVisit restored');
  assert.strictEqual(s2._lensIndexByCluster.get('People'), 1, 'People lens ring restored');
  assert.strictEqual(s2._lensIndexByCluster.get('Projects'), 1, 'Projects lens ring restored');
  // Continuity: ring is at index 1, so the next lens is 'connection' (returns
  // then advances), NOT a reset to 'knowledge' (index 0).
  assert.strictEqual(s2._nextSteward('People'), 'connection', 'rotation continues rather than resetting');
});

asyncTest('persistence: corrupt state file starts fresh, no throw', async () => {
  const dir = tmpDir();
  fs.writeFileSync(path.join(dir, 'wiki-steward-state.json'), '{ this is not json', 'utf8');
  let steward;
  assert.doesNotThrow(() => { steward = new WikiSteward(makeDeps({ config: { dataDir: dir } })); });
  assert.strictEqual(steward._lastVisit.size, 0, 'fresh _lastVisit');
  assert.strictEqual(steward._lensIndexByCluster.size, 0, 'fresh lens rings');
});

asyncTest('persistence: dataDir null is in-memory (no file, flush is a no-op)', async () => {
  const steward = new WikiSteward(makeDeps({ config: { dataDir: null } }));
  steward._lastVisit.set('People', 123);
  assert.doesNotThrow(() => steward.flush());
  assert.strictEqual(steward._stateFile, null, 'no state file path when dataDir null');
});

asyncTest('persistence: flush is idempotent (double shutdown safe)', async () => {
  const dir = tmpDir();
  const steward = new WikiSteward(makeDeps({ config: { dataDir: dir } }));
  steward._lastVisit.set('People', 999);
  steward.flush();
  assert.doesNotThrow(() => steward.flush(), 'second flush is safe');
});

// ---------------------------------------------------------------------------
// C1. LINK-INTEGRITY COUNTER (#255)
// ---------------------------------------------------------------------------

asyncTest('#255: gap branch increments gaps_logged, no dead link written', async () => {
  const client = makeMoverClient();
  // No resolvable target: findPageByTitle absent, neighborhood has no such title.
  client.findPageByTitle = async () => null;
  client.readPageContent = async () => '';
  client.writePageContent = async () => {};
  const steward = new WikiSteward(makeDeps({ collectivesClient: client }));
  const tally = { gapsLogged: 0, deadLinksWritten: 0 };
  const handle = { title: 'Source', path: 'People/Source.md' };
  const added = await steward._addWikilink(handle, 'Ghost Entity', 'related', neighborhoodOf([]), tally);
  assert.strictEqual(added, false, 'no link written to a non-existent target');
  assert.strictEqual(tally.gapsLogged, 1, 'gaps_logged incremented');
  assert.strictEqual(tally.deadLinksWritten, 0, 'no dead link written (healthy signature)');
});

asyncTest('#255: resolved target writes a link, dead_links_written stays 0', async () => {
  const client = makeMoverClient();
  const targetPage = makePage(client, 'Target', {});
  const sourcePath = 'People/Source.md';
  client.__readMap[sourcePath] = { frontmatter: {}, body: '# Source\n', path: sourcePath };
  const steward = new WikiSteward(makeDeps({ collectivesClient: client }));
  const tally = { gapsLogged: 0, deadLinksWritten: 0 };
  const handle = { title: 'Source', path: sourcePath };
  const added = await steward._addWikilink(handle, 'Target', 'related', neighborhoodOf([targetPage]), tally);
  assert.strictEqual(added, true, 'link written to a resolvable target');
  assert.strictEqual(tally.gapsLogged, 0);
  assert.strictEqual(tally.deadLinksWritten, 0, 'dead_links_written is 0 for a resolved write');
});

// ---------------------------------------------------------------------------
// C2. ROOT-COUNT ASSERTION (#256)
// ---------------------------------------------------------------------------

asyncTest('#256: two root pages trigger a WARN naming the strays', async () => {
  const spy = makeSpyLogger();
  const client = makeMoverClient();
  client.listPages = async () => ([
    { id: 1, title: 'Landing', parentId: 0 },
    { id: 2, title: 'Stray Root', parentId: 0 },
    { id: 3, title: 'People', parentId: 1 },
  ]);
  const steward = new WikiSteward(makeDeps({ collectivesClient: client, logger: spy }));
  steward.collectiveId = 10;
  await steward._readNeighborhood({ name: 'People' });
  const warn = spy._lines.warn.find(l => /root page count assertion/.test(l));
  assert.ok(warn, 'root-count WARN emitted');
  assert.ok(/found 2/.test(warn), 'reports the count');
  assert.ok(/"Landing"/.test(warn) && /"Stray Root"/.test(warn), 'names the stray pages');
});

asyncTest('#256: exactly one root page emits no WARN', async () => {
  const spy = makeSpyLogger();
  const client = makeMoverClient();
  client.listPages = async () => ([
    { id: 1, title: 'Landing', parentId: 0 },
    { id: 3, title: 'People', parentId: 1 },
  ]);
  const steward = new WikiSteward(makeDeps({ collectivesClient: client, logger: spy }));
  steward.collectiveId = 10;
  await steward._readNeighborhood({ name: 'People' });
  assert.ok(!spy._lines.warn.some(l => /root page count assertion/.test(l)), 'no WARN when exactly one root');
});

setTimeout(() => { summary(); exitWithCode(); }, 500);
