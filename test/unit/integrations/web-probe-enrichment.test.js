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

const assert = require('assert');
const { test, asyncTest, summary, exitWithCode } = require('../../helpers/test-runner');

/**
 * Tests for _probeWeb enrichment with WebReader.
 *
 * Creates a minimal MessageProcessor-like object with _probeWeb
 * wired to mock SearXNG + mock WebReader to verify the enrichment logic.
 */

// Extract _probeWeb by creating a minimal stand-in
// We test the method in isolation with controlled mocks.

function createProbeWeb({ searxng, webReader }) {
  // Minimal object that mirrors MessageProcessor's _probeWeb dependencies
  const obj = {
    agentLoop: {
      toolRegistry: {
        clients: {
          searxngClient: searxng || null,
          webReader: webReader || null
        }
      }
    }
  };

  // Bind the actual _probeWeb from message-processor
  const MessageProcessor = require('../../../src/lib/server/message-processor');
  const proto = MessageProcessor.prototype;
  obj._probeWeb = proto._probeWeb.bind(obj);
  return obj;
}

// --- Mock factories ---

function mockSearxng(results) {
  return {
    search: async () => ({
      results: results.map(r => ({
        title: r.title || 'Test',
        url: r.url || 'https://example.com',
        content: r.snippet || 'A snippet'
      }))
    })
  };
}

function mockWebReader(pages) {
  return {
    read: async (url) => {
      const page = pages.find(p => p.url === url);
      if (!page) throw new Error('Not found');
      return {
        title: page.title || 'Page Title',
        content: page.content,
        url,
        extractedAt: new Date().toISOString(),
        bytesFetched: (page.content || '').length,
        truncated: false
      };
    }
  };
}

// --- Tests ---

asyncTest('WPE-01: _probeWeb returns search results without webReader', async () => {
  const probe = createProbeWeb({
    searxng: mockSearxng([
      { title: 'Result 1', url: 'https://example.com/1', snippet: 'Snippet one' },
      { title: 'Result 2', url: 'https://example.com/2', snippet: 'Snippet two' }
    ]),
    webReader: null
  });

  const results = await probe._probeWeb('test query');
  assert.strictEqual(results.length, 2);
  assert.strictEqual(results[0].snippet, 'Snippet one');
  assert.strictEqual(results[0].hasFullContent, undefined, 'No enrichment without webReader');
});

asyncTest('WPE-02: _probeWeb enriches results with page content when webReader available', async () => {
  const probe = createProbeWeb({
    searxng: mockSearxng([
      { title: 'Article', url: 'https://example.com/article', snippet: 'Short snippet' }
    ]),
    webReader: mockWebReader([
      { url: 'https://example.com/article', content: 'This is the full article content with many details about the topic at hand.' }
    ])
  });

  const results = await probe._probeWeb('test query');
  assert.strictEqual(results.length, 1);
  assert.strictEqual(results[0].hasFullContent, true);
  assert.ok(results[0].content.includes('full article content'));
});

asyncTest('WPE-03: enrichment keeps snippet when page content is shorter', async () => {
  const longSnippet = 'This is a long detailed snippet from SearXNG that has plenty of information already.';
  const probe = createProbeWeb({
    searxng: mockSearxng([
      { title: 'Page', url: 'https://example.com/page', snippet: longSnippet }
    ]),
    webReader: mockWebReader([
      { url: 'https://example.com/page', content: 'Short.' }
    ])
  });

  const results = await probe._probeWeb('test query');
  assert.strictEqual(results[0].hasFullContent, undefined, 'Not enriched — page content shorter than snippet');
  assert.strictEqual(results[0].snippet, longSnippet);
});

asyncTest('WPE-04: enrichment handles webReader failure gracefully', async () => {
  const probe = createProbeWeb({
    searxng: mockSearxng([
      { title: 'Page', url: 'https://example.com/fail', snippet: 'Original snippet' }
    ]),
    webReader: {
      read: async () => { throw new Error('Network timeout'); }
    }
  });

  const results = await probe._probeWeb('test query');
  assert.strictEqual(results.length, 1);
  assert.strictEqual(results[0].snippet, 'Original snippet');
  assert.strictEqual(results[0].hasFullContent, undefined, 'Failed fetch — no enrichment');
});

asyncTest('WPE-05: enrichment processes up to 3 URLs', async () => {
  const urls = [1, 2, 3, 4].map(i => `https://example.com/${i}`);
  const probe = createProbeWeb({
    searxng: mockSearxng(urls.map((url, i) => ({
      title: `Page ${i + 1}`, url, snippet: `Snippet ${i + 1}`
    }))),
    webReader: mockWebReader(urls.map(url => ({
      url, content: `Full content for ${url} with lots of detail`
    })))
  });

  const results = await probe._probeWeb('test query');
  // SearXNG limit is 3 (in the actual code: search(query, {limit: 3}))
  // But even if 4 returned, only first 3 URLs are fetched by webReader
  const enriched = results.filter(r => r.hasFullContent);
  assert.ok(enriched.length <= 3, `At most 3 enriched, got ${enriched.length}`);
});

asyncTest('WPE-06: _probeWeb returns empty array when searxng unavailable', async () => {
  const probe = createProbeWeb({ searxng: null, webReader: null });
  const results = await probe._probeWeb('test query');
  assert.deepStrictEqual(results, []);
});

asyncTest('WPE-07: _probeWeb returns empty array when search returns no results', async () => {
  const probe = createProbeWeb({
    searxng: { search: async () => ({ results: [] }) },
    webReader: mockWebReader([])
  });
  const results = await probe._probeWeb('test query');
  assert.deepStrictEqual(results, []);
});

asyncTest('WPE-08: enriched content is truncated to 5000 chars', async () => {
  const longContent = 'x'.repeat(8000);
  const probe = createProbeWeb({
    searxng: mockSearxng([
      { title: 'Long', url: 'https://example.com/long', snippet: 'Short' }
    ]),
    webReader: mockWebReader([
      { url: 'https://example.com/long', content: longContent }
    ])
  });

  const results = await probe._probeWeb('test query');
  assert.strictEqual(results[0].hasFullContent, true);
  assert.strictEqual(results[0].content.length, 5000, 'Content truncated to 5000 chars');
});

asyncTest('WPE-09: non-http URLs are not fetched', async () => {
  let fetchAttempted = false;
  const probe = createProbeWeb({
    searxng: mockSearxng([
      { title: 'FTP', url: 'ftp://example.com/file', snippet: 'An FTP link' }
    ]),
    webReader: {
      read: async () => { fetchAttempted = true; return null; }
    }
  });

  const results = await probe._probeWeb('test query');
  assert.strictEqual(fetchAttempted, false, 'Non-HTTP URL should not be fetched');
  assert.strictEqual(results[0].snippet, 'An FTP link');
});

asyncTest('WPE-10: aggregation prefers content over snippet for web results', async () => {
  // Test that _aggregateProbeResults uses result.content when available
  const MessageProcessor = require('../../../src/lib/server/message-processor');
  const proto = MessageProcessor.prototype;

  const probeResults = [{
    provenance: 'web_search',
    results: [{
      title: 'Weather Berlin',
      snippet: 'Check weather at...',
      content: 'Berlin today: 15°C, partly cloudy, wind 12 km/h from west.',
      url: 'https://weather.example.com/berlin'
    }]
  }];

  const aggregated = proto._aggregateProbeResults(probeResults);
  assert.ok(aggregated.includes('15°C'), 'Aggregation should use content field, not snippet');
  assert.ok(!aggregated.includes('Check weather at'), 'Snippet should not appear when content is available');
});

setTimeout(() => { summary(); exitWithCode(); }, 500);
