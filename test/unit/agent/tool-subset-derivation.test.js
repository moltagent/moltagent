/**
 * getToolSubset derivation regression tests (#221)
 *
 * getToolSubset no longer reads a hardcoded SUBSETS object; it derives each
 * domain's membership from the `domains`/`universal` metadata every tool
 * declares at its register() site. These tests are the regression oracle for
 * that migration: no tool visible under the old SUBSETS may become invisible,
 * the deliberate corrections must now appear, and workflow-only tools must stay
 * out of every chat subset.
 *
 * Run: node test/unit/agent/tool-subset-derivation.test.js
 */

const assert = require('assert');
const { test, summary, exitWithCode } = require('../../helpers/test-runner');
const { ToolRegistry } = require('../../../src/lib/agent/tool-registry');

const silent = { info() {}, warn() {}, error() {}, debug() {} };

// Truthy stub for every client so every _register*Tools gate passes and the
// full tool surface registers (subset membership is metadata-only; handlers
// are never invoked here).
const stub = () => new Proxy(
  { baseUrl: 'https://nc.example.com', username: 'moltagent' },
  { get(t, p) { return p in t ? t[p] : () => {}; } }
);
const CLIENTS = ['deckClient', 'calDAVClient', 'systemTagsClient', 'ncRequestManager',
  'ncFilesClient', 'ncSearchClient', 'textExtractor', 'collectivesClient', 'learningLog',
  'searxngClient', 'webReader', 'contactsClient', 'memorySearcher', 'searchAdapters',
  'emailHandler', 'resilientWriter', 'newsClient', 'entityExtractor'];

function fullRegistry() {
  const opts = { logger: silent };
  for (const c of CLIENTS) opts[c] = stub();
  return new ToolRegistry(opts);
}

const names = (subset) => subset.map(t => t.function.name);

// The deleted SUBSETS object, verbatim — the regression oracle. Every one of
// these that is registered must remain visible in its domain's derived subset.
const OLD_SUBSETS = {
  deck: ['deck_list_boards', 'deck_create_board', 'deck_create_card', 'deck_assign_user',
    'deck_unassign_user', 'deck_list_cards', 'deck_get_board', 'deck_get_card', 'deck_list_stacks',
    'deck_create_stack', 'deck_rename_stack', 'deck_delete_stack', 'deck_rename_board',
    'deck_archive_board', 'deck_delete_board', 'deck_setup_workflow', 'deck_troubleshoot',
    'deck_create_label', 'deck_remove_label', 'deck_move_card', 'deck_mark_done',
    'deck_complete_task', 'deck_complete_review', 'deck_update_card', 'deck_delete_card',
    'deck_set_due_date', 'deck_add_comment', 'deck_list_comments', 'deck_my_assigned_cards',
    'deck_overdue_cards', 'deck_overview', 'web_search'],
  calendar: ['calendar_list_events', 'calendar_create_event', 'calendar_check_availability',
    'calendar_update_event', 'calendar_delete_event', 'meeting_compose', 'meeting_check_rsvp',
    'web_search'],
  email: ['mail_send', 'contacts_search', 'contacts_get', 'contacts_resolve', 'memory_search',
    'web_search'],
  wiki: ['wiki_read', 'wiki_write', 'wiki_search', 'wiki_list', 'wiki_delete', 'memory_search',
    'web_search'],
  file: ['file_read', 'file_write', 'file_list', 'file_move', 'file_copy', 'file_delete',
    'file_info', 'file_extract', 'file_share', 'web_search'],
  search: ['memory_search', 'memory_recall', 'unified_search', 'contacts_search', 'web_read',
    'wiki_list', 'web_search'],
  news: ['news_get_items', 'news_list_feeds', 'news_mark_read', 'deck_create_card', 'web_search'],
};

// The 5 deliberate corrections (#221): plain omissions now given their domain.
const CORRECTIONS = {
  deck: ['deck_add_label', 'deck_share_board'],
  calendar: ['calendar_cancel_meeting'],
  file: ['file_mkdir', 'tag_file'],
};

// Workflow-only tools: declared domains:['workflow'], never in a chat subset.
const WORKFLOW_ONLY = ['workflow_deck_move_card', 'workflow_deck_add_comment',
  'workflow_deck_create_card', 'workflow_deck_update_card', 'workflow_deck_assign_label'];

const CHAT_DOMAINS = Object.keys(OLD_SUBSETS);

// ---- Regression: nothing that was visible becomes invisible ----

test('every OLD_SUBSETS tool that is registered stays visible in its derived subset', () => {
  const reg = fullRegistry();
  for (const [domain, tools] of Object.entries(OLD_SUBSETS)) {
    const derived = names(reg.getToolSubset(domain));
    for (const tool of tools) {
      if (!reg.has(tool)) continue; // e.g. meeting_* never register (no meetingComposer)
      assert.ok(derived.includes(tool),
        `REGRESSION: ${tool} was visible in old SUBSETS.${domain} but is missing from the derived subset`);
    }
  }
});

// ---- The corrections now appear ----

test('the 5 previously-omitted chat tools now appear in their domains', () => {
  const reg = fullRegistry();
  for (const [domain, tools] of Object.entries(CORRECTIONS)) {
    const derived = names(reg.getToolSubset(domain));
    for (const tool of tools) {
      assert.ok(reg.has(tool), `${tool} should be registered`);
      assert.ok(derived.includes(tool),
        `${tool} (correction) should now be visible in subset ${domain}`);
    }
  }
});

// ---- Workflow tools stay out of every chat subset ----

test('workflow_deck_* tools carry domains:[workflow] and appear in no chat subset', () => {
  const reg = fullRegistry();
  for (const tool of WORKFLOW_ONLY) {
    assert.ok(reg.has(tool), `${tool} should be registered`);
    assert.deepStrictEqual(reg.tools.get(tool).domains, ['workflow'],
      `${tool} should declare domains:['workflow']`);
    for (const domain of CHAT_DOMAINS) {
      assert.ok(!names(reg.getToolSubset(domain)).includes(tool),
        `${tool} must not leak into chat subset ${domain}`);
    }
  }
});

// ---- Universal helper is in every domain subset ----

test('web_search (universal) is present in every domain subset', () => {
  const reg = fullRegistry();
  assert.strictEqual(reg.tools.get('web_search').universal, true);
  for (const domain of CHAT_DOMAINS) {
    assert.ok(names(reg.getToolSubset(domain)).includes('web_search'),
      `web_search should be in subset ${domain}`);
  }
});

// ---- Unknown / empty intent yields no subset (hasDomainTools stays honest) ----

test('unknown, empty, and non-chat intents yield an empty subset', () => {
  const reg = fullRegistry();
  assert.deepStrictEqual(reg.getToolSubset('bogus-domain'), []);
  assert.deepStrictEqual(reg.getToolSubset(''), []);
  assert.deepStrictEqual(reg.getToolSubset(undefined), []);
  assert.strictEqual(reg.hasDomainTools('bogus-domain'), false);
  assert.strictEqual(reg.hasDomainTools(''), false);
  // A universal helper alone never constitutes a domain.
  for (const domain of ['bogus-domain', '']) {
    assert.ok(!names(reg.getToolSubset(domain)).includes('web_search'),
      'universal helper must not surface for an unknown domain');
  }
});

// ---- Cross-domain tools belong to each declared domain ----

test('cross-domain tools appear in every domain they declare', () => {
  const reg = fullRegistry();
  // deck_create_card: ['deck', 'news'] ; contacts_search: ['email', 'search'] ; wiki_list: ['wiki', 'search']
  assert.ok(names(reg.getToolSubset('deck')).includes('deck_create_card'));
  assert.ok(names(reg.getToolSubset('news')).includes('deck_create_card'));
  assert.ok(names(reg.getToolSubset('email')).includes('contacts_search'));
  assert.ok(names(reg.getToolSubset('search')).includes('contacts_search'));
  assert.ok(names(reg.getToolSubset('wiki')).includes('wiki_list'));
  assert.ok(names(reg.getToolSubset('search')).includes('wiki_list'));
});

setTimeout(() => {
  summary();
  exitWithCode();
}, 500);
