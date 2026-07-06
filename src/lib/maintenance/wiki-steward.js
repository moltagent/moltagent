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
 * WikiSteward — Syntropic orchestrator for the Living Knowledge Architecture.
 *
 * Architecture Brief:
 * - Problem: Three legacy background workers (MetadataGardener, EmbeddingRefresher,
 *   FreshnessChecker) each walk the wiki independently, re-reading every page
 *   through a single narrow lens. They never cross-reference. A broken page type
 *   and a missing embedding and a stale confidence on the same page look like
 *   three unrelated problems instead of one sick organism. This spec absorbs
 *   all three into one orchestrator that walks the garden once and sees the
 *   whole system through rotating stewards.
 * - Pattern: Syntropic stewardship. Three specialized lenses (knowledge,
 *   connection, memory) share one ObservationLog. On each heartbeat pulse,
 *   the steward picks the neediest cluster (most unresolved observations +
 *   longest time since visit), reads its entire neighborhood (pages +
 *   frontmatter + per-page graph connections), assesses it through the active
 *   steward's lens via ONE LLM call, then executes targeted interventions.
 *   Rotation guarantees every lens walks every cluster over time.
 * - Key Dependencies:
 *     CollectivesClient    — list/read/write pages, ensureSection
 *     KnowledgeGraph       — getEntity / relatedTo (public surface only)
 *     VectorStore          — getMetadata(title) keyed by page title (NO hasEmbedding — use getMetadata !== null)
 *     EmbeddingClient      — embed text for un-embedded pages
 *     LLMRouter            — route({ job, content, requirements }) → { result }
 *     ObservationLog       — shared observation journal
 *     WikiSteward is self-sufficient: it uses collectivesClient, knowledgeGraph,
 *     vectorStore, embeddingClient, and llmRouter directly. The legacy
 *     MetadataGardener / EmbeddingRefresher / FreshnessChecker workers have
 *     been deleted and are no longer referenced here.
 * - Data Flow:
 *     heartbeat pulse
 *       → wikiSteward.tend()
 *         → _findNeediest() (observationLog + _lastVisit)
 *         → _nextSteward(cluster.name)  (per-cluster rotation)
 *         → _readNeighborhood(cluster)  (CollectivesClient + KnowledgeGraph + VectorStore)
 *         → _assess(stewardType, neighborhood)  (llmRouter.route, ONE call)
 *         → _intervene(stewardType, assessment, neighborhood)  (per-lens executors)
 *         → _updateSectionSummaries(sections)  (Level 1 refresh if pages changed)
 *         → _updateLandingPage() (Level 0 refresh, throttled by _shouldRefreshIndex)
 *         → observationLog.resolve(cluster, type, pages)  (per executor action)
 *         → _lastVisit.set(cluster, now)
 * - Dependency Map:
 *     heartbeat-manager.js → wiki-steward.js → {
 *       collectives-client.js, knowledge-graph.js, vector-store.js,
 *       embedding-client.js, llm-router.js, observation-log.js
 *     }
 *
 * Language policy: every assessment prompt (knowledge / connection / memory)
 * includes DE + PT + EN examples. There is zero natural-language keyword
 * matching in code — the LLM is the language layer. The only regex is for
 * wikilink syntax `[[...]]`, which is structural markup (not natural language).
 *
 * NOTE ON EMBEDDING CHECK: VectorStore exposes getMetadata(title) keyed by page title (NOT page.id).
 * Implementer must check `vectorStore.getMetadata(page.title) !== null`
 * rather than calling a hasEmbedding method that does not exist.
 *
 * @module maintenance/wiki-steward
 * @version 0.1.0
 */

const fs = require('fs');
const path = require('path');

// Section identity has exactly one derivation, owned by the client (#51 generator).
const { deriveSection } = require('../integrations/collectives-client');

// The Archive section is a Level-1 section, sibling to People/Projects/etc.
// A composted page moves here (#245); its identity survives in NC versioning
// and the Archive copy — there is no delete path.
const ARCHIVE_SECTION = 'Archive';

// The human veto window between marking a page compost_ready (which fires the
// KnowledgeBoard card) and the mover physically archiving it (#245).
const COMPOST_HOLD_MS = 7 * 24 * 60 * 60 * 1000;

// Pulses stay bounded: at most this many pages move to Archive per visit (#245).
const MAX_MOVES_PER_VISIT = 3;

// Persisted steward state (#246): visit timestamps and the per-cluster lens
// ring. Both are behavior-relevant across restarts — losing _lastVisit makes
// every cluster read maximally neglected; losing the ring breaks the
// three-lens rotation invariant at the restart boundary.
const STATE_FILENAME = 'wiki-steward-state.json';

/**
 * @typedef {Object} PageRef
 * @property {string} id
 * @property {string} title
 * @property {string} [section]
 * @property {string} [path]
 */

/**
 * @typedef {Object} EnrichedPage
 * @property {string} id
 * @property {string} title
 * @property {string} [section]
 * @property {string|null} path           - WebDAV path from the single read; the identity handle executors write through.
 * @property {Object} frontmatter
 * @property {string} bodyPreview
 * @property {boolean} hasEmbedding       - Derived from vectorStore.getMetadata(id) !== null.
 * @property {Array}   graphConnections   - [{ predicate, object }, ...]
 * @property {string[]} wikilinks         - Targets extracted from [[...]] markup.
 */

/**
 * @typedef {Object} Neighborhood
 * @property {string} cluster
 * @property {EnrichedPage[]} pages
 * @property {Set<string>} sections
 */

/**
 * @typedef {Object} ClusterSummary
 * @property {string} name
 * @property {number} observationCount
 * @property {number} hoursSinceVisit
 * @property {number} score
 */

/**
 * @typedef {Object} InterventionResult
 * @property {number} pagesModified
 * @property {number} linksAdded
 * @property {number} observationsResolved
 * @property {Array<{type: string, page: string}>} resolutions - What the
 *   executors actually acted on; the only thing tend() resolves.
 */

/**
 * @typedef {Object} TendResult
 * @property {string|null} steward       - Active steward lens, or null if idle.
 * @property {string|null} cluster       - Cluster tended, or null if nothing to do.
 * @property {number} pagesModified
 * @property {number} linksAdded
 * @property {number} observationsResolved
 * @property {number} pagesInNeighborhood - Pages actually read for the tended cluster.
 */

class WikiSteward {
  /**
   * @param {Object} options
   * @param {Object} options.collectivesClient
   * @param {Object} options.knowledgeGraph
   * @param {Object} options.vectorStore
   * @param {Object} options.embeddingClient
   * @param {Object} options.llmRouter - router.route({ job, content, requirements }) → { result }
   * @param {Object} options.observationLog - Shared ObservationLog instance
   * @param {Object} [options.modelScorecard] - ModelScorecard (maturation loop).
   *   Optional and null-safe: when present, every _assess outcome records one
   *   organic (synthesis, model, language) envelope-validity sample. The
   *   steward only testifies; the loop owns selection.
   * @param {Object} [options.knowledgeBoard] - KnowledgeBoard (Deck
   *   verification surface). Optional and null-safe: when present, each
   *   contradiction pair and duplicate pair gets exactly one card in the
   *   disputed stack and each compost candidate one card in the stale stack —
   *   the human surface for findings the page footer only marks in-context.
   *   When absent, behavior is unchanged.
   * @param {Object} [options.logger]
   * @param {string} [options.collectiveId]
   * @param {Object} [options.config={}] - Tuning knobs (indexRefreshIntervalMs, bodyPreviewChars, etc.)
   */
  constructor({
    collectivesClient,
    knowledgeGraph,
    vectorStore,
    embeddingClient,
    llmRouter,
    observationLog,
    modelScorecard,
    knowledgeBoard,
    logger,
    collectiveId,
    config = {},
  } = {}) {
    if (!collectivesClient) throw new Error('WikiSteward requires collectivesClient');
    if (!knowledgeGraph)    throw new Error('WikiSteward requires knowledgeGraph');
    if (!vectorStore)       throw new Error('WikiSteward requires vectorStore');
    if (!embeddingClient)   throw new Error('WikiSteward requires embeddingClient');
    if (!llmRouter)         throw new Error('WikiSteward requires llmRouter');
    if (!observationLog)    throw new Error('WikiSteward requires observationLog');

    this.collectivesClient = collectivesClient;
    this.knowledgeGraph = knowledgeGraph;
    this.vectorStore = vectorStore;
    this.embeddingClient = embeddingClient;
    this.router = llmRouter;
    this.observations = observationLog;
    this.modelScorecard = modelScorecard || null;
    this.knowledgeBoard = knowledgeBoard || null;
    this.logger = logger || console;
    this.collectiveId = collectiveId || null;

    this.config = config || {};

    // Steward rotation — three lenses on the same neighborhood, rotated
    // per cluster. A global index lens-locks every cluster whenever the
    // cluster count is divisible by three (15 clusters × 3 lenses meant
    // People only ever saw the knowledge lens). In-memory, same documented
    // amnesia class as _lastVisit.
    /** @type {Map<string, number>} */
    this._lensIndexByCluster = new Map();
    /** @type {string[]} */
    this._stewards = ['knowledge', 'connection', 'memory'];

    // Track which cluster was visited when — used by _findNeediest to balance
    // observation-driven priority against neglect.
    /** @type {Map<string, number>} */
    this._lastVisit = new Map();

    // Consecutive zero-page neighborhood reads per cluster while the census
    // reports pages. The failure class that hid #51 for a month: a silent
    // section-derivation drift reads as "cluster healthy, nothing to tend".
    // In-memory, same documented amnesia class as _lastVisit.
    /** @type {Map<string, number>} */
    this._zeroPageStreak = new Map();

    // Durable steward state (#246). _lastVisit and _lensIndexByCluster survive
    // restarts via one debounced JSON under data/ (the model-scorecard pattern:
    // atomic tmp+rename, loaded at construction, corrupt/missing starts fresh).
    // _zeroPageStreak stays ephemeral by design — it is a diagnostic, and a
    // fresh start after a restart is the correct behavior for a streak counter.
    this.dataDir = this.config.dataDir === null
      ? null
      : (this.config.dataDir || path.resolve(process.cwd(), 'data'));
    this._stateFile = this.dataDir ? path.join(this.dataDir, STATE_FILENAME) : null;
    this._saveTimer = null;
    this._loadState();

    // Level 0 landing page throttling.
    /** @type {number} */
    this._lastIndexRefresh = 0;
    /** @type {number} */
    this._indexRefreshIntervalMs = Number.isFinite(this.config.indexRefreshIntervalMs)
      ? this.config.indexRefreshIntervalMs
      : 6 * 60 * 60 * 1000; // 6h default
  }

  // ---------------------------------------------------------------------------
  // DURABLE STATE (#246) — modeled on model-scorecard.js load/save shape
  // ---------------------------------------------------------------------------

  /**
   * Load persisted _lastVisit and lens rings at construction. A missing or
   * corrupt file starts fresh — the prior in-memory behavior, so a bad file is
   * never worse than no persistence at all.
   * @private
   */
  _loadState() {
    if (!this._stateFile) return;
    try {
      const parsed = JSON.parse(fs.readFileSync(this._stateFile, 'utf8'));
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return;
      if (parsed.lastVisit && typeof parsed.lastVisit === 'object') {
        for (const [cluster, ts] of Object.entries(parsed.lastVisit)) {
          if (Number.isFinite(ts)) this._lastVisit.set(cluster, ts);
        }
      }
      if (parsed.lensIndex && typeof parsed.lensIndex === 'object') {
        for (const [cluster, idx] of Object.entries(parsed.lensIndex)) {
          if (Number.isInteger(idx) && idx >= 0) {
            this._lensIndexByCluster.set(cluster, idx % this._stewards.length);
          }
        }
      }
      this.logger.info(
        `[WikiSteward] State loaded: ${this._lastVisit.size} visit stamps, ` +
        `${this._lensIndexByCluster.size} lens rings.`
      );
    } catch (_err) {
      // Missing file or corrupt JSON — start fresh (the pre-persistence amnesia).
    }
  }

  /**
   * Coalesce state writes: a tend marks the state dirty and a short unref'd
   * timer flushes it, so a burst of tends costs one disk write and a crash
   * loses at most a second of visit/lens bookkeeping.
   * @private
   */
  _scheduleSave() {
    if (!this._stateFile || this._saveTimer) return;
    this._saveTimer = setTimeout(() => {
      this._saveTimer = null;
      this._persistState();
    }, 1000);
    if (typeof this._saveTimer.unref === 'function') this._saveTimer.unref();
  }

  /** @private */
  _persistState() {
    if (!this._stateFile) return;
    try {
      if (!fs.existsSync(this.dataDir)) fs.mkdirSync(this.dataDir, { recursive: true });
      const state = {
        version: 1,
        lastVisit: Object.fromEntries(this._lastVisit),
        lensIndex: Object.fromEntries(this._lensIndexByCluster),
      };
      const tmp = this._stateFile + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(state, null, 2), 'utf8');
      fs.renameSync(tmp, this._stateFile);
    } catch (err) {
      this.logger.warn(`[WikiSteward] Failed to persist state: ${err.message}`);
    }
  }

  /**
   * Flush any pending debounced write now. Idempotent — safe to call on a
   * double shutdown. Wire into the process shutdown drain.
   */
  flush() {
    if (this._saveTimer) {
      clearTimeout(this._saveTimer);
      this._saveTimer = null;
    }
    this._persistState();
  }

  // ---------------------------------------------------------------------------
  // PUBLIC API
  // ---------------------------------------------------------------------------

  /**
   * Called from HeartbeatManager on every pulse.
   *
   * Orchestration steps (see spec §Part 4):
   *   1. Pick the neediest cluster (observations + neglect).
   *   2. Pick which steward's turn it is (rotation).
   *   3. Read the entire neighborhood of that cluster.
   *   4. Assess it through the active steward's lens (one LLM call).
   *   5. Intervene — execute targeted actions from the assessment.
   *   6. Refresh Level 1 section summaries when pages changed.
   *   7. Periodically refresh Level 0 landing page.
   *   8. Resolve observations per (cluster, type, pages) the executors acted on.
   *   9. Record visit timestamp in _lastVisit.
   *
   * @returns {Promise<TendResult>}
   */
  async tend() {
    const idle = { steward: null, cluster: null, pagesModified: 0, linksAdded: 0, observationsResolved: 0, pagesInNeighborhood: 0 };

    // Step 1: pick the neediest cluster
    let cluster;
    try {
      cluster = await this._findNeediest();
    } catch (err) {
      this.logger.warn(`[WikiSteward] _findNeediest failed: ${err.message}`);
      return { ...idle, skipped: 'findNeediest_error' };
    }

    if (!cluster) {
      this.logger.debug('[WikiSteward] All clusters healthy or none known. Nothing to tend.');
      return { ...idle, skipped: 'idle' };
    }

    // Step 2: pick the active steward lens
    const stewardType = this._nextSteward(cluster.name);

    this.logger.info(
      `[WikiSteward:${stewardType}] Tending cluster "${cluster.name}" ` +
      `(score=${cluster.score}, obsCount=${cluster.observationCount})`
    );

    // Step 3: read the neighborhood
    let neighborhood;
    try {
      neighborhood = await this._readNeighborhood(cluster);
    } catch (err) {
      this.logger.warn(`[WikiSteward:${stewardType}] _readNeighborhood failed for "${cluster.name}": ${err.message}`);
      return { ...idle, steward: stewardType, cluster: cluster.name, skipped: 'neighborhood_error' };
    }

    // Step 3b: count what was actually read against what the census promised.
    // A zero-page neighborhood for a cluster the census counted pages for is
    // the #51 failure shape — instrument it instead of tending silence.
    const pagesInNeighborhood = neighborhood.pages.length;
    this.logger.info(
      `[WikiSteward:${stewardType}] Neighborhood "${cluster.name}": ` +
      `${pagesInNeighborhood} pages (cluster reports ${cluster.pageCount ?? 'unknown'})`
    );
    if (pagesInNeighborhood === 0 && (cluster.pageCount || 0) > 0) {
      const streak = (this._zeroPageStreak.get(cluster.name) || 0) + 1;
      this._zeroPageStreak.set(cluster.name, streak);
      if (streak >= 3) {
        this.logger.error(
          `[WikiSteward:${stewardType}] FLATLINE: cluster "${cluster.name}" read 0 pages ` +
          `for ${streak} consecutive cycles while the census reports ${cluster.pageCount}. ` +
          `First suspects: _getPageSection derivation and the Collectives filePath shape.`
        );
      } else {
        this.logger.warn(
          `[WikiSteward:${stewardType}] SUSPICIOUS EMPTY SET: cluster "${cluster.name}" ` +
          `read 0 pages while the census reports ${cluster.pageCount}. ` +
          `First suspects: _getPageSection derivation and the Collectives filePath shape.`
        );
      }
      this.observations.notice({
        type: 'empty_neighborhood',
        cluster: cluster.name,
        detail: `Read 0 pages; census reports ${cluster.pageCount}`,
      });
    } else if (pagesInNeighborhood > 0) {
      this._zeroPageStreak.delete(cluster.name);
    }

    // Step 4: assess through the steward's lens (one LLM call)
    let assessment;
    try {
      assessment = await this._assess(stewardType, neighborhood);
    } catch (err) {
      this.logger.warn(`[WikiSteward:${stewardType}] _assess failed: ${err.message}`);
      assessment = { actions: [] };
    }

    // Step 5: intervene
    let interventionResult;
    try {
      interventionResult = await this._intervene(stewardType, assessment, neighborhood);
    } catch (err) {
      this.logger.warn(`[WikiSteward:${stewardType}] _intervene failed: ${err.message}`);
      interventionResult = { pagesModified: 0, linksAdded: 0, observationsResolved: 0, resolutions: [] };
    }

    // Step 6: refresh Level 1 summaries if pages were modified. The enriched
    // pages already in hand ground the Level 1 lines without a second read.
    if (interventionResult.pagesModified > 0) {
      try {
        await this._updateSectionSummaries(neighborhood.sections, neighborhood.pages);
      } catch (err) {
        this.logger.warn(`[WikiSteward:${stewardType}] _updateSectionSummaries failed: ${err.message}`);
      }
    }

    // Step 7: periodically refresh Level 0 landing page
    if (this._shouldRefreshIndex()) {
      try {
        await this._updateLandingPage();
      } catch (err) {
        this.logger.warn(`[WikiSteward] _updateLandingPage failed: ${err.message}`);
      }
    }

    // Step 8: resolve exactly what the executors acted on, per (type, pages)
    // group. observationsResolved is the sum of resolve()'s actual transition
    // counts — a tend that performed no action resolves zero (G2, #161 class).
    let observationsResolved = 0;
    try {
      const pagesByType = new Map();
      for (const r of interventionResult.resolutions || []) {
        if (!r || !r.type || !r.page) continue;
        if (!pagesByType.has(r.type)) pagesByType.set(r.type, new Set());
        pagesByType.get(r.type).add(r.page);
      }
      for (const [type, pages] of pagesByType) {
        observationsResolved += this.observations.resolve(cluster.name, type, [...pages]);
      }
    } catch (err) {
      this.logger.warn(`[WikiSteward] observations.resolve failed: ${err.message}`);
    }

    // Step 9: record visit timestamp, then persist visit + lens state (#246).
    // Both the lens ring (step 2) and _lastVisit changed this tend; one
    // debounced write coalesces them.
    this._lastVisit.set(cluster.name, Date.now());
    this._scheduleSave();

    const result = {
      steward: stewardType,
      cluster: cluster.name,
      pagesModified: interventionResult.pagesModified,
      linksAdded: interventionResult.linksAdded,
      observationsResolved,
      pagesInNeighborhood,
      skipped: false,
    };

    this.logger.info(
      `[WikiSteward:${stewardType}] Done. ` +
      `${result.pagesModified} pages modified, ` +
      `${result.linksAdded} links added, ` +
      `${result.observationsResolved} observations resolved.`
    );

    return result;
  }

  /**
   * Force a Level 0 (landing page) rebuild. Used by tests and by the
   * Sleep Cycle ritual — outside the normal throttled schedule.
   *
   * @returns {Promise<{ refreshed: boolean, clusters: number }>}
   */
  async refreshLandingPage() {
    try {
      const outcome = await this._updateLandingPage();
      this._lastIndexRefresh = Date.now();
      return { refreshed: true, clusters: outcome?.clusters || 0 };
    } catch (err) {
      this.logger.warn(`[WikiSteward] refreshLandingPage failed: ${err.message}`);
      return { refreshed: false, clusters: 0 };
    }
  }

  /**
   * Force a Level 1 section parent rebuild for a single section.
   *
   * @param {string} sectionName - Section whose parent page to refresh.
   * @returns {Promise<{ refreshed: boolean, pages: number }>}
   */
  async refreshSectionSummary(sectionName) {
    if (!sectionName || typeof sectionName !== 'string') {
      throw new Error('refreshSectionSummary requires a non-empty sectionName');
    }
    try {
      const sections = new Set([sectionName]);
      const outcome = await this._updateSectionSummaries(sections);
      return { refreshed: true, pages: outcome?.refreshed || 0 };
    } catch (err) {
      this.logger.warn(`[WikiSteward] refreshSectionSummary("${sectionName}") failed: ${err.message}`);
      return { refreshed: false, pages: 0 };
    }
  }

  // ---------------------------------------------------------------------------
  // PRIVATE — ROTATION
  // ---------------------------------------------------------------------------

  /**
   * Rotate through stewards per cluster: each cluster advances its own lens
   * on each of its own visits. Invariant: three consecutive visits to one
   * cluster use three different lenses, regardless of cluster count.
   *
   * @param {string} clusterName
   * @returns {string} One of 'knowledge' | 'connection' | 'memory'
   */
  _nextSteward(clusterName) {
    const idx = this._lensIndexByCluster.get(clusterName) || 0;
    this._lensIndexByCluster.set(clusterName, (idx + 1) % this._stewards.length);
    return this._stewards[idx];
  }

  // ---------------------------------------------------------------------------
  // PRIVATE — NEEDIEST SELECTION
  // ---------------------------------------------------------------------------

  /**
   * Score every cluster by observation count + time since last visit, return
   * the top candidate (or null if nothing is pending).
   *
   * Score formula (from spec): observationCount * 10 + min(hoursSinceVisit, 48).
   * Observations dominate; neglect matters but is capped.
   *
   * @returns {Promise<ClusterSummary|null>}
   */
  async _findNeediest() {
    const observationCounts = this.observations.getNeediest(); // [{cluster, count}]
    const allClusters = await this._listClusters();           // [{name}]

    if (allClusters.length === 0) return null;

    const obsByName = new Map(observationCounts.map(o => [o.cluster, o.count]));

    const scored = allClusters.map(cluster => {
      const obsCount = obsByName.get(cluster.name) || 0;
      const lastVisitMs = this._lastVisit.get(cluster.name) || 0;
      const hoursSinceVisit = (Date.now() - lastVisitMs) / (1000 * 60 * 60);
      const score = obsCount * 10 + Math.min(hoursSinceVisit, 48);
      return { ...cluster, observationCount: obsCount, hoursSinceVisit, score };
    });

    scored.sort((a, b) => b.score - a.score);
    return scored[0]?.score > 0 ? scored[0] : null;
  }

  /**
   * Enumerate clusters known to the system. First attempt: read Level 0
   * landing page and parse its `## Knowledge Domains` `###` headings to get
   * cluster names. Fallback: enumerate unique `section` values from listPages().
   *
   * @returns {Promise<Array<{name: string}>>}
   */
  async _listClusters() {
    // Resolve the collective ID if not cached
    let collectiveId = this.collectiveId;
    if (!collectiveId) {
      try {
        collectiveId = await this.collectivesClient.resolveCollective();
        this.collectiveId = collectiveId;
      } catch (err) {
        this.logger.warn(`[WikiSteward] resolveCollective failed: ${err.message}`);
        return [];
      }
    }

    // Enumerate clusters from real filesystem sections via listPages.
    // Traversal uses filesystem sections (structural truth).
    // Level 0 landing page uses LLM semantic clustering (human view).
    try {
      const pages = await this.collectivesClient.listPages(collectiveId);
      const pageList = Array.isArray(pages) ? pages : [];
      // The landing page has parentId === 0; its direct children are the top-level
      // section pages. Virtual section pages (no backing .md file) return filePath=''
      // from the Collectives API, so we fall back to the title for those.
      const landingPage = pageList.find(p => p.parentId === 0);
      const landingPageId = landingPage?.id;
      const sectionCounts = new Map();
      for (const page of pageList) {
        const section = deriveSection(page, landingPageId);
        if (section) {
          sectionCounts.set(section, (sectionCounts.get(section) || 0) + 1);
        }
      }
      return Array.from(sectionCounts.entries()).map(([name, pageCount]) => ({ name, pageCount }));
    } catch (err) {
      this.logger.warn(`[WikiSteward] _listClusters listPages failed: ${err.message}`);
      return [];
    }
  }

  // ---------------------------------------------------------------------------
  // PRIVATE — NEIGHBORHOOD READ
  // ---------------------------------------------------------------------------

  /**
   * Read every page in the cluster, enrich it with frontmatter, body preview,
   * page path, embedding presence, graph connections, and wikilink targets.
   * This is the single "walk the garden" that all three stewards reuse.
   * One content read per page (_readPage), one client call each.
   *
   * Embedding presence MUST be derived from `vectorStore.getMetadata(page.title) !== null`
   * (VectorStore does NOT expose hasEmbedding; key is page.title, not page.id).
   *
   * @param {{ name: string }} cluster
   * @returns {Promise<Neighborhood>}
   */
  async _readNeighborhood(cluster) {
    if (!cluster || !cluster.name) {
      throw new Error('_readNeighborhood requires a cluster with a name');
    }

    const neighborhood = {
      cluster: cluster.name,
      pages: [],
      sections: new Set(),
    };

    // Resolve collective ID if needed
    let collectiveId = this.collectiveId;
    if (!collectiveId) {
      collectiveId = await this.collectivesClient.resolveCollective();
      this.collectiveId = collectiveId;
    }

    // List pages that belong to this cluster via deriveSection (single chokepoint
    // shared with _listClusters; resilient to Collectives API filePath shape changes).
    let clusterPages = [];
    try {
      const allPages = await this.collectivesClient.listPages(collectiveId);
      const pageList = Array.isArray(allPages) ? allPages : [];
      const clusterName = cluster.name;

      // Root-count assertion (#256): the fractal index has exactly one root
      // page (the Level 0 landing page). A stray at root corrupts section
      // derivation and landing-page identity — the failure class Phase 5's
      // root-create suppression closed. This promotes that one-time manual
      // snapshot to a standing per-tend check, riding the listPages read we
      // already made. Observes only; humans act on the named strays.
      const rootPages = pageList.filter(p => p.parentId === 0);
      if (rootPages.length !== 1) {
        this.logger.warn(
          `[WikiSteward] root page count assertion: expected 1 landing page ` +
          `(parentId=0), found ${rootPages.length}: ` +
          rootPages.map(p => `"${p.title}"`).join(', ')
        );
      }
      const landingPageId = rootPages[0]?.id;

      clusterPages = pageList.filter(p => deriveSection(p, landingPageId) === clusterName);
    } catch (err) {
      this.logger.warn(`[WikiSteward] Failed to list pages for cluster "${cluster.name}": ${err.message}`);
      return neighborhood;
    }

    const bodyPreviewLimit = Number.isFinite(this.config.bodyPreviewChars)
      ? this.config.bodyPreviewChars
      : 500;

    for (const pageRef of clusterPages) {
      try {
        const pageData = await this._readPage(pageRef);
        const frontmatter = pageData?.frontmatter || {};
        const bodyPreview = (pageData?.body || '').slice(0, bodyPreviewLimit);
        const hasEmbedding = this.vectorStore.getMetadata(pageRef.title) !== null;

        // Graph connections: resolve the page title to an entity id first, then 1-hop.
        // KnowledgeGraph triples are keyed by entity id (not display name), so calling
        // relatedTo() with the raw title would silently return nothing.
        let graphConnections = [];
        let entityId = null;
        try {
          const entity = this.knowledgeGraph.getEntity
            ? this.knowledgeGraph.getEntity(pageRef.title)
            : null;
          if (entity && entity.id) {
            entityId = entity.id;
            const related = this.knowledgeGraph.relatedTo(entity.id, 1);
            graphConnections = (related || []).map(r => ({
              predicate: r.predicate,
              object: r.entity?.name || r.entity?.id || '',
            }));
          }
        } catch {
          // If the graph doesn't have this entity, that's fine — empty connections.
        }

        const wikilinks = this._extractWikilinks(bodyPreview);

        // Every page here passed the deriveSection === cluster.name filter
        // above, so the cluster name IS the section — no re-derivation.
        neighborhood.pages.push({
          id: pageRef.id,
          title: pageRef.title,
          entityId,
          section: cluster.name,
          path: pageData?.path || null,
          frontmatter,
          bodyPreview,
          hasEmbedding,
          graphConnections,
          wikilinks,
        });

        neighborhood.sections.add(cluster.name);
      } catch (err) {
        this.logger.warn(`[WikiSteward] Skipping page "${pageRef.title}" due to error: ${err.message}`);
      }
    }

    return neighborhood;
  }

  /**
   * One content read per page: frontmatter, body, and path in a single
   * client call. The preview every consumer needs is a slice of this body.
   *
   * @param {PageRef} page
   * @returns {Promise<{frontmatter: Object, body: string, path: string|null}|null>}
   */
  async _readPage(page) {
    try {
      const result = await this.collectivesClient.readPageWithFrontmatter(page.title);
      if (!result) return null;
      return {
        frontmatter: result.frontmatter || {},
        body: result.body || '',
        path: result.path || null,
      };
    } catch (err) {
      this.logger.debug(`[WikiSteward] _readPage("${page.title}") failed: ${err.message}`);
      return null;
    }
  }

  /**
   * Extract wikilink targets from a body string.
   *
   * NOTE: the regex below targets the STRUCTURAL markup `[[...]]`, not natural
   * language. This is allowed under the language policy — wikilinks are syntax,
   * not vocabulary.
   *
   * @param {string} body
   * @returns {string[]} Unique targets in first-seen order.
   */
  _extractWikilinks(body) {
    if (typeof body !== 'string' || body.length === 0) return [];
    const seen = new Set();
    const results = [];
    // Capture [[Target]] and [[Target|Alias]] — take the target part only.
    const re = /\[\[([^\]\|]+)(?:\|[^\]]+)?\]\]/g;
    let match;
    while ((match = re.exec(body)) !== null) {
      const target = match[1].trim();
      if (target && !seen.has(target)) {
        seen.add(target);
        results.push(target);
      }
    }
    return results;
  }

  // ---------------------------------------------------------------------------
  // PRIVATE — ASSESSMENT (ONE LLM CALL PER TEND)
  // ---------------------------------------------------------------------------

  /**
   * Dispatch the neighborhood to the active steward's prompt builder, call the
   * router, parse JSON. One LLM call per tend() pulse.
   *
   * Router contract: `router.route({ job, content, requirements })` returns
   * `{ result, provider, model, ... }`. Content is in `.result`, NOT `.content`.
   *
   * @param {'knowledge'|'connection'|'memory'} stewardType
   * @param {Neighborhood} neighborhood
   * @returns {Promise<Object>} Parsed assessment, or `{ actions: [] }` on parse failure.
   */
  async _assess(stewardType, neighborhood) {
    let prompt;
    if (stewardType === 'knowledge') {
      prompt = this._knowledgeAssessmentPrompt(neighborhood);
    } else if (stewardType === 'connection') {
      prompt = this._connectionAssessmentPrompt(neighborhood);
    } else {
      prompt = this._memoryAssessmentPrompt(neighborhood);
    }

    const routerResult = await this.router.route({
      job: 'synthesis',
      content: prompt,
      requirements: { maxTokens: 1000 },
      context: { trigger: 'wiki_steward', internal: true, stewardType },
    });

    const raw = routerResult?.result || routerResult?.content || '';

    let parsed = null;
    let parseError = null;
    try {
      parsed = _extractJsonObject(raw);
    } catch (err) {
      parseError = err;
    }

    // Maturation-loop testimony (Layer 2): one organic sample per assessment.
    // Envelope validity is the mechanical signal — the same class IntentRouter
    // records for classification parse failures. Sits outside the fallback
    // return so success and failure each record exactly once.
    const envelopeValid = parsed !== null && typeof parsed === 'object';
    if (this.modelScorecard && routerResult?.model) {
      try {
        // Language omitted on purpose: the scorecard defaults to the cockpit language.
        this.modelScorecard.recordSample('synthesis', routerResult.model, null, envelopeValid);
      } catch (err) {
        this.logger.warn(`[WikiSteward:${stewardType}] recordSample failed: ${err.message}`);
      }
    }

    if (parseError) {
      this.logger.warn(
        `[WikiSteward:${stewardType}] Assessment JSON parse failed (${parseError.message}) — raw (first 400): ${String(raw).slice(0, 400)}`
      );
      return { actions: [] };
    }
    return parsed;
  }

  /**
   * Build the Knowledge Steward assessment prompt.
   *
   * MULTILINGUAL CONTRACT: the prompt includes example phrasings in German
   * and Portuguese alongside English so the LLM can reason over content in any
   * of the three languages without code-level language detection.
   *
   * @param {Neighborhood} neighborhood
   * @returns {string} Prompt text.
   */
  _knowledgeAssessmentPrompt(neighborhood) {
    const pageSummaries = neighborhood.pages.map(p =>
      `### ${p.title}\n` +
      `Type: ${p.frontmatter.type || 'untyped'} | ` +
      `Confidence: ${p.frontmatter.confidence || 'unknown'} | ` +
      `Last verified: ${p.frontmatter.last_verified || 'never'} | ` +
      `Access count: ${p.frontmatter.access_count || 0}\n` +
      `Preview: ${p.bodyPreview.substring(0, 200)}`
    ).join('\n\n');

    // Claim-level facts from the per-page graph connections already in hand —
    // contradiction detection needs facts the 200-char previews cannot carry.
    // Capped at 40 lines to keep the prompt bounded on dense clusters.
    const factLines = [];
    for (const p of neighborhood.pages) {
      for (const c of p.graphConnections || []) {
        if (factLines.length >= 40) break;
        factLines.push(`${p.title} ${c.predicate} ${c.object}`);
      }
      if (factLines.length >= 40) break;
    }
    const factsBlock = factLines.length > 0
      ? `\nKNOWN FACTS from the knowledge graph (claim-level, use them to spot contradictions):\n${factLines.join('\n')}\n`
      : '';

    return `You are the Knowledge Steward. Your purpose is truth maintenance.
You are reviewing the "${neighborhood.cluster}" knowledge cluster.

---
MULTILINGUAL EXAMPLES OF WHAT TO LOOK FOR:

Contradiction example (EN): "Carlos is the Editorial Director at ManeraMedia GmbH." vs "Carlos is the intern at ManeraMedia GmbH."
Contradiction example (DE): "Tobias leitet das Redaktionsteam." vs "Tobias ist Praktikant im Redaktionsteam."
Contradiction example (PT): "Eelco é o Diretor de Pesquisa do DIEM." vs "Eelco é o fundador do DIEM."

Stale example (EN): Page last verified 180 days ago, confidence: low, never accessed.
Stale example (DE): Seite zuletzt vor 180 Tagen überprüft, Konfidenz: niedrig, nie abgerufen.
Stale example (PT): Página verificada pela última vez há 180 dias, confiança: baixa, nunca acessada.

Gap example (EN): Page for "Carlos" mentions "Q2 Editorial Calendar" but no page exists for that entity.
Gap example (DE): Die Seite "Carlos" erwähnt "Q2-Redaktionskalender", aber es existiert keine Seite dafür.
Gap example (PT): A página "Carlos" menciona "Calendário Editorial Q2", mas não existe página para essa entidade.
---

These pages belong to this cluster:

${pageSummaries || '(No pages found in this cluster.)'}
${factsBlock}
Assess this cluster for:
1. CONTRADICTIONS: Do any pages contain claims that conflict with each other?
2. STALENESS: Which pages have outdated information (check last_verified, confidence)?
3. GAPS: Are there entities referenced in page content that don't have their own pages?
4. SUSPECTS: Based on the previews, does anything look factually dubious?

Return JSON only (no prose, no markdown fences):
{
  "contradictions": [{"pageA": "title", "pageB": "title", "claim": "what conflicts"}],
  "stale": [{"page": "title", "reason": "why it's stale"}],
  "gaps": [{"entity": "name", "referencedIn": "page title"}],
  "suspects": [{"page": "title", "concern": "what looks wrong"}],
  "healthy": ["titles of pages that look good"]
}

Respond in the same language as the page content. Assessments should work equally well for German, English, and Portuguese pages.

OUTPUT FORMAT (STRICT): Your entire response must be a single JSON object. The first character must be \`{\` and the last character must be \`}\`. Do NOT wrap the JSON in markdown code fences (no \`\`\`json, no \`\`\`). Do NOT add explanations, prefixes, or trailing notes.`;
  }

  /**
   * Build the Connection Steward assessment prompt.
   *
   * MULTILINGUAL CONTRACT: includes DE + PT + EN example relationships.
   *
   * @param {Neighborhood} neighborhood
   * @returns {string} Prompt text.
   */
  _connectionAssessmentPrompt(neighborhood) {
    // Structural guard: section index / navigation pages are not knowledge
    // entities and must never be link targets. Drop them from the data the LLM
    // sees so it cannot suggest links to "Documents", "People", etc. Index
    // pages carry `type: index`; structural pages carry the `compost: never`
    // pin. The prompt EXCLUSION instruction below is the intelligence-layer
    // counterpart — belt and suspenders.
    const contentPages = neighborhood.pages.filter(p => {
      const fm = p.frontmatter || {};
      return fm.type !== 'index' && fm.compost !== 'never';
    });

    const pageLinks = contentPages.map(p =>
      `### ${p.title}\n` +
      `Graph connections: ${p.graphConnections.map(e => `${e.predicate} → ${e.object}`).join(', ') || 'none'}\n` +
      `Wikilinks in content: ${p.wikilinks.join(', ') || 'none'}`
    ).join('\n\n');

    return `You are the Connection Steward. Your purpose is growing connections in the knowledge graph.
You are reviewing the "${neighborhood.cluster}" knowledge cluster.

---
MULTILINGUAL EXAMPLES OF WHAT TO LOOK FOR:

Missing link (EN): Graph says "Carlos works_at ManeraMedia GmbH" but Carlos's wiki page has no [[ManeraMedia GmbH]] link.
Missing link (DE): Der Graph zeigt "Carlos arbeitet_bei ManeraMedia GmbH", aber Carlos' Seite enthält keinen [[ManeraMedia GmbH]]-Link.
Missing link (PT): O grafo diz "Carlos trabalha_em ManeraMedia GmbH", mas a página de Carlos não contém o link [[ManeraMedia GmbH]].

Orphan (EN): The page "Q2 Editorial Calendar" has no incoming links from any other page.
Orphan (DE): Die Seite "Q2-Redaktionskalender" hat keine eingehenden Links von anderen Seiten.
Orphan (PT): A página "Calendário Editorial Q2" não tem links de entrada de nenhuma outra página.

Near-duplicate (EN): Pages "ManeraMedia GmbH" and "Manera Media GmbH" likely describe the same organization.
Near-duplicate (DE): Die Seiten "ManeraMedia GmbH" und "Manera Media GmbH" beschreiben wahrscheinlich dieselbe Organisation.
Near-duplicate (PT): As páginas "ManeraMedia GmbH" e "Manera Media GmbH" provavelmente descrevem a mesma organização.
---

EXCLUSION: Do NOT suggest links to section index pages. Pages whose type is "index"
or whose title matches a top-level section name (Documents, People, Projects,
Organizations, Research, Procedures, Images, Meta, emails) are structural navigation,
not knowledge entities. They must never appear in missingLinks or orphan suggestions.
Only suggest links between actual knowledge entities (people, projects, documents, concepts).

Here are the pages with their graph connections and wikilinks:

${pageLinks || '(No pages found in this cluster.)'}

Assess this cluster for:
1. MISSING LINKS: Graph says A relates to B, but A's wiki page doesn't contain [[B]]. List them.
2. ORPHANS: Pages with no incoming wikilinks from any other page in this cluster.
3. NEAR DUPLICATES: Pages with very similar titles or descriptions that might be the same entity.
4. CROSS-CLUSTER: Entities that should link to pages in OTHER clusters.

Return JSON only (no prose, no markdown fences):
{
  "missingLinks": [{"page": "title", "shouldLinkTo": "target", "relationship": "predicate type"}],
  "orphans": [{"page": "title", "suggestedConnections": ["possible link targets"]}],
  "nearDuplicates": [{"pageA": "title", "pageB": "title", "similarity": "why they look alike"}],
  "crossCluster": [{"page": "title", "shouldLinkTo": "target", "cluster": "target cluster name"}]
}

Respond in the same language as the page content. Assessments should work equally well for German, English, and Portuguese pages.

OUTPUT FORMAT (STRICT): Your entire response must be a single JSON object. The first character must be \`{\` and the last character must be \`}\`. Do NOT wrap the JSON in markdown code fences (no \`\`\`json, no \`\`\`). Do NOT add explanations, prefixes, or trailing notes.`;
  }

  /**
   * Build the Memory Steward assessment prompt.
   *
   * MULTILINGUAL CONTRACT: includes DE + PT + EN example phrasings for
   * access / decay / composting reasoning.
   *
   * @param {Neighborhood} neighborhood
   * @returns {string} Prompt text.
   */
  _memoryAssessmentPrompt(neighborhood) {
    const pageStats = neighborhood.pages.map(p =>
      `${p.title}: access_count=${p.frontmatter.access_count || 0}, ` +
      `confidence=${p.frontmatter.confidence || 'medium'}, ` +
      `decay_days=${p.frontmatter.decay_days || 90}, ` +
      `last_accessed=${p.frontmatter.last_accessed || 'never'}, ` +
      `has_embedding=${p.hasEmbedding}, ` +
      `body_length=${p.bodyPreview.length}`
    ).join('\n');

    return `You are the Memory Steward. Your purpose is lifecycle management of knowledge pages.
You are reviewing the "${neighborhood.cluster}" knowledge cluster.

---
MULTILINGUAL EXAMPLES OF WHAT TO LOOK FOR:

Strengthen (EN): "This page has been accessed 47 times — it deserves extended decay and high confidence."
Strengthen (DE): "Diese Seite wurde 47 Mal abgerufen — sie verdient verlängerten Verfall und hohe Konfidenz."
Strengthen (PT): "Esta página foi acessada 47 vezes — merece decaimento estendido e alta confiança."

Compost candidate (EN): "This page has not been accessed for 90 days — candidate for composting."
Compost candidate (DE): "Diese Seite wurde seit 90 Tagen nicht aufgerufen — Kompostier-Kandidat."
Compost candidate (PT): "Esta página não é acessada há 90 dias — candidata a compostagem."

Embed (EN): "Page has no vector embedding — it cannot be found via semantic search."
Embed (DE): "Seite hat kein Vektorembedding — sie ist über semantische Suche nicht auffindbar."
Embed (PT): "A página não tem embedding vetorial — não pode ser encontrada por busca semântica."
---

Here are the page lifecycle stats:

${pageStats || '(No pages found in this cluster.)'}

Assess this cluster for:
1. STRENGTHEN: Pages with high access that deserve extended decay and raised confidence.
2. COMPOST: Pages that are never accessed, past decay, low confidence — candidates for archiving.
3. EMBED: Pages that need vector embedding (has_embedding=false).
4. SUCCESSION: What is the overall health of this cluster?
   - NASCENT (few pages, many gaps, needs growth)
   - GROWING (pages being added, connections forming)
   - MATURE (well-connected, actively accessed, stable)
   - DECLINING (stale, rarely accessed, needs pruning)

Return JSON only (no prose, no markdown fences):
{
  "strengthen": [{"page": "title", "reason": "why"}],
  "compost": [{"page": "title", "reason": "why"}],
  "embed": [{"page": "title"}],
  "successionStage": "NASCENT|GROWING|MATURE|DECLINING",
  "recommendation": "one sentence on what this cluster needs most"
}

Respond in the same language as the page content. Assessments should work equally well for German, English, and Portuguese pages.

OUTPUT FORMAT (STRICT): Your entire response must be a single JSON object. The first character must be \`{\` and the last character must be \`}\`. Do NOT wrap the JSON in markdown code fences (no \`\`\`json, no \`\`\`). Do NOT add explanations, prefixes, or trailing notes.`;
  }

  // ---------------------------------------------------------------------------
  // PRIVATE — INTERVENTION
  // ---------------------------------------------------------------------------

  /**
   * Determine whether a page is structural infrastructure that should not be
   * modified by steward interventions. Structural pages serve as navigation
   * scaffolding (section indexes, landing pages, meta pages) — their content
   * is either auto-maintained by the fractal index refresh or intentionally
   * minimal. Frontmatter `type: section|index|meta` marks them by role; the
   * `compost: never` pin marks them by lifecycle policy. Either is sufficient.
   *
   * @param {EnrichedPage} page - Page object from neighborhood.pages
   * @returns {boolean}
   */
  _isStructuralPage(page) {
    if (!page || !page.frontmatter) return false;
    const t = page.frontmatter.type;
    if (t === 'section' || t === 'index' || t === 'meta') return true;
    if (page.frontmatter.compost === 'never') return true;
    return false;
  }

  /**
   * Execute the assessment's recommended actions. Each steward type dispatches
   * to a different set of per-action executors (the "farm hand" operations).
   *
   * @param {'knowledge'|'connection'|'memory'} stewardType
   * @param {Object} assessment
   * @param {Neighborhood} neighborhood
   * @returns {Promise<InterventionResult>}
   */
  async _intervene(stewardType, assessment, neighborhood) {
    const results = {
      pagesModified: 0,
      linksAdded: 0,
      observationsResolved: 0,
      // Link-integrity counters (#255). gapsLogged: targets that resolved to no
      // page (GAP recorded, no link written). deadLinksWritten: links written
      // despite an unresolved target — 0 by construction today; > 0 is the
      // regression signal if the gap branch is ever bypassed.
      gapsLogged: 0,
      deadLinksWritten: 0,
      // (type, page) pairs the executors actually acted on. tend() resolves
      // exactly these — visiting is not resolving (G2, #161 class).
      resolutions: [],
    };

    if (!assessment || typeof assessment !== 'object') {
      return results;
    }

    // Structural pages are infrastructure, not content. Skip all interventions
    // on them — they are maintained by the fractal index refresh cycle, not by
    // steward assessments. Defense in depth alongside the prompt-level
    // exclusion in _connectionAssessmentPrompt and the compost: never pin
    // honored by _markForComposting.
    const structuralTitles = new Set(
      (neighborhood?.pages || [])
        .filter(p => this._isStructuralPage(p))
        .map(p => p.title)
    );

    // Identity custody (G3): every LLM-returned title resolves to a
    // { title, path } handle from the assessed neighborhood before dispatch.
    // Executors write by path, so an intervention can only touch a page that
    // was in the neighborhood it assessed. A hallucinated title resolves to
    // nothing and is skipped with a log line.
    const handleIndex = new Map(
      (neighborhood?.pages || []).map(p => [(p.title || '').toLowerCase().trim(), p])
    );
    const resolve = (title, action) => {
      const handle = title ? handleIndex.get(String(title).toLowerCase().trim()) : null;
      if (!handle || !handle.path) {
        this.logger.info(
          `[WikiSteward:${stewardType}] "${title}" is not an addressable page in the assessed ` +
          `neighborhood — skipping ${action}`
        );
        return null;
      }
      return handle;
    };

    switch (stewardType) {
      case 'knowledge': {
        for (const c of assessment.contradictions || []) {
          if (structuralTitles.has(c.pageA) || structuralTitles.has(c.pageB)) {
            this.logger.info(`[WikiSteward:knowledge] Skipping structural page in contradiction: "${c.pageA}" / "${c.pageB}"`);
            continue;
          }
          const handleA = resolve(c.pageA, 'contradiction flag');
          const handleB = resolve(c.pageB, 'contradiction flag');
          if (!handleA || !handleB) continue;
          try {
            const flagged = await this._flagContradiction(handleA, handleB, c.claim, neighborhood?.cluster);
            if (flagged) {
              results.pagesModified += 2;
              for (const p of [handleA.title, handleB.title]) {
                results.resolutions.push({ type: 'contradiction', page: p });
                results.resolutions.push({ type: 'low_confidence', page: p });
              }
            }
          } catch (err) {
            this.logger.warn(`[WikiSteward:knowledge] _flagContradiction failed: ${err.message}`);
          }
        }
        for (const s of assessment.stale || []) {
          if (structuralTitles.has(s.page)) {
            this.logger.info(`[WikiSteward:knowledge] Skipping structural page "${s.page}" for staleness`);
            continue;
          }
          const handle = resolve(s.page, 'confidence lowering');
          if (!handle) continue;
          try {
            const lowered = await this._lowerConfidence(handle, s.reason);
            if (lowered) {
              results.pagesModified++;
              results.resolutions.push({ type: 'stale_content', page: handle.title });
            }
          } catch (err) {
            this.logger.warn(`[WikiSteward:knowledge] _lowerConfidence("${s.page}") failed: ${err.message}`);
          }
        }
        // _logKnowledgeGap writes to Meta/Pending Questions, not to the
        // referenced page — the gap observation is valid even if the
        // referencing page is structural. No guard needed here.
        for (const g of assessment.gaps || []) {
          try {
            const logged = await this._logKnowledgeGap(g.entity, g.referencedIn);
            if (logged && g.referencedIn) {
              results.resolutions.push({ type: 'gap', page: g.referencedIn });
            }
          } catch (err) {
            this.logger.warn(`[WikiSteward:knowledge] _logKnowledgeGap("${g.entity}") failed: ${err.message}`);
          }
        }
        break;
      }

      case 'connection': {
        for (const m of assessment.missingLinks || []) {
          if (structuralTitles.has(m.page)) {
            this.logger.info(`[WikiSteward:connection] Skipping structural page "${m.page}" for missing link`);
            continue;
          }
          const handle = resolve(m.page, 'missing link');
          if (!handle) continue;
          try {
            const added = await this._addWikilink(handle, m.shouldLinkTo, m.relationship, neighborhood, results);
            if (added) {
              results.linksAdded++;
              results.pagesModified++;
              results.resolutions.push({ type: 'missing_link', page: handle.title });
            }
          } catch (err) {
            this.logger.warn(`[WikiSteward:connection] _addWikilink("${m.page}"→"${m.shouldLinkTo}") failed: ${err.message}`);
          }
        }
        for (const o of assessment.orphans || []) {
          if (structuralTitles.has(o.page)) {
            this.logger.info(`[WikiSteward:connection] Skipping structural page "${o.page}" for orphan resolution`);
            continue;
          }
          const handle = resolve(o.page, 'orphan resolution');
          if (!handle) continue;
          for (const target of o.suggestedConnections || []) {
            try {
              const added = await this._addWikilink(handle, target, 'related', neighborhood, results);
              if (added) {
                results.linksAdded++;
                results.pagesModified++;
                results.resolutions.push({ type: 'orphan_page', page: handle.title });
              }
            } catch (err) {
              this.logger.warn(`[WikiSteward:connection] _addWikilink orphan("${o.page}"→"${target}") failed: ${err.message}`);
            }
          }
        }
        for (const d of assessment.nearDuplicates || []) {
          if (structuralTitles.has(d.pageA) || structuralTitles.has(d.pageB)) {
            this.logger.info(`[WikiSteward:connection] Skipping structural page in duplicate check: "${d.pageA}" / "${d.pageB}"`);
            continue;
          }
          const handleA = resolve(d.pageA, 'duplicate flag');
          const handleB = resolve(d.pageB, 'duplicate flag');
          if (!handleA || !handleB) continue;
          try {
            const flagged = await this._flagDuplicate(handleA, handleB, d.similarity || 0, neighborhood?.cluster);
            if (flagged) {
              results.resolutions.push({ type: 'near_duplicate', page: handleA.title });
              results.resolutions.push({ type: 'near_duplicate', page: handleB.title });
            }
          } catch (err) {
            this.logger.warn(`[WikiSteward:connection] _flagDuplicate failed: ${err.message}`);
          }
        }
        // Link-integrity line (#255): one journal line per connection tend at
        // the link chokepoint. The connection lens is the only path that writes
        // wikilinks, so this is the tend-cycle summary for link integrity.
        // dead_links_written > 0 means the gap branch was bypassed — a WARN.
        {
          const linkLine =
            `[WikiSteward:connection] links: gaps_logged=${results.gapsLogged} ` +
            `dead_links_written=${results.deadLinksWritten}`;
          if (results.deadLinksWritten > 0) this.logger.warn(linkLine);
          else this.logger.info(linkLine);
        }
        break;
      }

      case 'memory': {
        for (const s of assessment.strengthen || []) {
          if (structuralTitles.has(s.page)) {
            this.logger.info(`[WikiSteward:memory] Skipping structural page "${s.page}" for strengthening`);
            continue;
          }
          const handle = resolve(s.page, 'strengthening');
          if (!handle) continue;
          try {
            const strengthened = await this._strengthenPage(handle);
            if (strengthened) {
              results.pagesModified++;
              results.resolutions.push({ type: 'high_access', page: handle.title });
            }
          } catch (err) {
            this.logger.warn(`[WikiSteward:memory] _strengthenPage("${s.page}") failed: ${err.message}`);
          }
        }
        for (const c of assessment.compost || []) {
          if (structuralTitles.has(c.page)) {
            this.logger.info(`[WikiSteward:memory] Skipping structural page "${c.page}" for composting`);
            continue;
          }
          const handle = resolve(c.page, 'composting');
          if (!handle) continue;
          try {
            const marked = await this._markForComposting(handle, c.reason);
            if (marked) results.resolutions.push({ type: 'compost_ready', page: handle.title });
          } catch (err) {
            this.logger.warn(`[WikiSteward:memory] _markForComposting("${c.page}") failed: ${err.message}`);
          }
        }
        for (const e of assessment.embed || []) {
          if (structuralTitles.has(e.page)) {
            this.logger.info(`[WikiSteward:memory] Skipping structural page "${e.page}" for embedding`);
            continue;
          }
          const handle = resolve(e.page, 'embedding');
          if (!handle) continue;
          try {
            const embedded = await this._embedPage(handle);
            if (embedded) results.resolutions.push({ type: 'unembedded', page: handle.title });
          } catch (err) {
            this.logger.warn(`[WikiSteward:memory] _embedPage("${e.page}") failed: ${err.message}`);
          }
        }

        // Fourth memory intervention: the compost MOVER (#245). Unlike the
        // three above, its candidates come from the neighborhood's own
        // frontmatter, not the LLM assessment — a page's compost lifecycle is
        // structural bookkeeping (a flag and a date), not a judgement, so no
        // model call is involved. A page moves to Archive/ when ALL hold:
        // compost_ready, marked 7+ days ago (the human veto window — the
        // KnowledgeBoard card already fired at marking time), not already
        // archived, not structural, not pinned (compost: never lives in
        // structuralTitles). Capped per visit so pulses stay bounded.
        let moved = 0;
        const nowMs = Date.now();
        for (const page of neighborhood?.pages || []) {
          if (moved >= MAX_MOVES_PER_VISIT) break;
          const fm = page.frontmatter || {};
          if (fm.compost_ready !== true) continue;
          if (fm.archived === true) continue;
          if (structuralTitles.has(page.title)) continue;
          const markedAt = Date.parse(fm.compost_marked_at);
          if (!Number.isFinite(markedAt) || (nowMs - markedAt) < COMPOST_HOLD_MS) continue;
          const handle = resolve(page.title, 'archive move');
          if (!handle) continue;
          try {
            const archived = await this._moveToArchive(handle);
            if (archived) {
              moved++;
              // The source section lost a page — drive the Level 1 refresh.
              results.pagesModified++;
            }
          } catch (err) {
            this.logger.warn(`[WikiSteward:memory] _moveToArchive("${page.title}") failed: ${err.message}`);
          }
        }
        if (moved > 0) {
          this.logger.info(
            `[WikiSteward:memory] compost mover: ${moved} page(s) archived this visit ` +
            `(cap ${MAX_MOVES_PER_VISIT}).`
          );
        }
        break;
      }

      default:
        this.logger.warn(`[WikiSteward] Unknown stewardType in _intervene: "${stewardType}"`);
    }

    return results;
  }

  /**
   * Knowledge lens: two pages disagree on a fact. Append a contradiction warning
   * block to each page if not already present, and log LOW_CONFIDENCE observations.
   *
   * Handles, not titles: reads and writes go by path, so a leaf-title
   * collision elsewhere in the collective cannot receive this write.
   *
   * @param {{title: string, path: string, id?: string}} handleA
   * @param {{title: string, path: string, id?: string}} handleB
   * @param {string} claim
   * @param {string} [cluster] - Cluster the assessment ran in; carried on the
   *   notices so they join getNeediest and resolve under Phase 2 semantics.
   * @returns {Promise<boolean>} true if at least one note was persisted.
   */
  async _flagContradiction(handleA, handleB, claim, cluster) {
    if (!handleA?.path || !handleB?.path || !claim) return false;

    const marker = 'Contradiction flagged by Knowledge Steward';

    let modified = false;

    // Dedup keys on (marker, partner title), never on the claim text: the claim
    // is LLM-worded and the link form mutates on write (PR #50 Fix A class).
    // Writes route through the frontmatter-aware path write so [[partner]] resolves.
    for (const [handle, partner] of [[handleA, handleB], [handleB, handleA]]) {
      try {
        const result = await this.collectivesClient.readPageWithFrontmatterAtPath(handle.path);
        if (!result) continue;
        const body = result.body || '';
        if (this._hasFlagForPair(body, marker, partner.title)) continue;
        const flag = `> ⚠️ ${marker}: conflicts with [[${partner.title}]] on "${claim}"`;
        const newBody = body + `\n\n${flag}\n`;
        await this.collectivesClient.writePageWithFrontmatterAtPath(handle.path, result.frontmatter, newBody);
        this.logger.info(`[WikiSteward:knowledge] Flagged contradiction on "${handle.title}" vs "${partner.title}"`);
        modified = true;
      } catch (err) {
        this.logger.warn(`[WikiSteward] _flagContradiction write to "${handle.title}" failed: ${err.message}`);
      }
    }

    // Emit LOW_CONFIDENCE observations for both pages so they surface for verification
    this.observations.notice({ type: 'low_confidence', cluster, page: handleA.title, detail: `Contradiction with ${handleB.title}: ${claim}` });
    this.observations.notice({ type: 'low_confidence', cluster, page: handleB.title, detail: `Contradiction with ${handleA.title}: ${claim}` });

    // Human surface: one card per pair on the KnowledgeBoard's disputed stack.
    // Fires only on a NEW flag (modified) — an already-flagged pair is already
    // carded; the board's title-key dedup is the belt behind this suspender.
    if (modified) {
      await this._createPairCard('Contradiction', handleA, handleB, claim);
    }

    return modified;
  }

  /**
   * One Deck card per (kind, pair) on the KnowledgeBoard — the human surface
   * for steward findings (fact 10: page-footer flags were the only visible
   * trace, and nobody reads footers). Null-safe: no board, no card, no error.
   * The pair is sorted so (A,B) and (B,A) share one card title.
   *
   * @param {'Contradiction'|'Duplicate'} kind
   * @param {{title: string, id?: string}} handleA
   * @param {{title: string, id?: string}} handleB
   * @param {string} claim
   * @returns {Promise<void>}
   */
  async _createPairCard(kind, handleA, handleB, claim) {
    if (!this.knowledgeBoard) return;
    try {
      const [first, second] = [handleA, handleB]
        .sort((a, b) => a.title.localeCompare(b.title));
      await this.knowledgeBoard.createDisputeCard({
        title: `${kind}: ${first.title} vs ${second.title}`,
        sourceA: this._pageLink(first),
        claimA: claim,
        sourceB: this._pageLink(second),
        claimB: claim,
      });
    } catch (err) {
      this.logger.warn(`[WikiSteward] KnowledgeBoard card for "${handleA.title}" vs "${handleB.title}" failed: ${err.message}`);
    }
  }

  /**
   * Markdown link for a page handle when the client can build one, plain
   * title otherwise (mocks, or a handle without an id).
   *
   * @param {{title: string, id?: string|number}} handle
   * @returns {string}
   */
  _pageLink(handle) {
    if (handle.id && typeof this.collectivesClient.buildPageUrl === 'function') {
      try {
        return `[${handle.title}](${this.collectivesClient.buildPageUrl(handle.title, handle.id)})`;
      } catch {
        // fall through to plain title
      }
    }
    return handle.title;
  }

  /**
   * Knowledge lens: a page's confidence should drop.
   *
   * @param {{title: string, path: string}} handle
   * @param {string} reason
   * @returns {Promise<boolean>}
   */
  async _lowerConfidence(handle, reason) {
    if (!handle?.path) return false;

    const result = await this.collectivesClient.readPageWithFrontmatterAtPath(handle.path);
    if (!result) return false;

    const fm = { ...result.frontmatter };
    const confidenceSteps = ['high', 'medium', 'low'];
    const current = fm.confidence || 'medium';
    const idx = confidenceSteps.indexOf(current);
    // Step down one level; if already 'low' or unknown, keep at 'low'.
    fm.confidence = idx >= 0 && idx < confidenceSteps.length - 1
      ? confidenceSteps[idx + 1]
      : 'low';
    fm.last_verification_attempt = new Date().toISOString().split('T')[0];
    // verification_note is gone (gate amendment 1): it was LLM-worded prose,
    // so identical page state produced different bytes on every visit — one
    // live page accumulated 871 NC versions from this alone. Nothing reads
    // the field; the reason stays in the log line below.
    delete fm.verification_note;

    // Equality guard: identical state produces identical bytes — no write,
    // no pagesModified, no spurious Level 1 refresh.
    if (JSON.stringify(fm) === JSON.stringify(result.frontmatter)) return false;

    await this.collectivesClient.writePageWithFrontmatterAtPath(handle.path, fm, result.body || '');
    this.logger.info(`[WikiSteward:knowledge] Lowered confidence for "${handle.title}" to ${fm.confidence}: ${reason}`);
    return true;
  }

  /**
   * Knowledge lens: an entity is referenced but has no wiki page.
   * Appends a line to Meta/Pending Questions.md, deduplicated.
   *
   * @param {string} entity
   * @param {string} referencedIn
   * @returns {Promise<void>}
   */
  async _logKnowledgeGap(entity, referencedIn) {
    if (!entity) return false;

    const pendingQuestionsPath = 'Meta/Pending Questions.md';
    const line = `- ${entity} — referenced in [[${referencedIn || 'unknown'}]], no page yet`;

    let existing = '';
    try {
      existing = await this.collectivesClient.readPageContent(pendingQuestionsPath) || '';
    } catch {
      // File may not exist yet — that's fine, we'll create it
    }

    // Idempotency: skip if this exact entity line is already recorded
    if (existing.includes(`- ${entity} —`)) return false;

    const updated = existing
      ? `${existing.trimEnd()}\n${line}\n`
      : `# Pending Questions\n\n${line}\n`;

    try {
      const resolved = await this._resolveWikilinks(updated);
      await this.collectivesClient.writePageContent(pendingQuestionsPath, resolved);
      this.logger.info(`[WikiSteward:knowledge] Logged knowledge gap: "${entity}" (referenced in ${referencedIn})`);
      return true;
    } catch (err) {
      this.logger.warn(`[WikiSteward:knowledge] _logKnowledgeGap write failed: ${err.message}`);
      return false;
    }
  }

  /**
   * Connection lens: add `[[target]]` to `page` in a context-appropriate line.
   * Only writes if the wikilink is not already present.
   *
   * The target must exist as a page (G4: the model proposes meaning, code
   * validates structure). Resolution order: the neighborhood's own titles
   * first, then a global lookup for cross-cluster targets. A target with no
   * page produces no link write — it produces a GAP observation plus a
   * Pending Questions entry, which is this system's name for exactly that
   * condition. Without this, Related sections accumulate [[Entity]] entries
   * that resolveWikilinks correctly preserves as dead markup forever.
   *
   * @param {{title: string, path: string}} handle - Source page handle from
   *   the assessed neighborhood.
   * @param {string} target
   * @param {string} relationship
   * @param {Neighborhood} [neighborhood] - Assessed neighborhood; provides
   *   the local title index and the cluster for the GAP observation.
   * @param {{gapsLogged: number, deadLinksWritten: number}} [tally] - Optional
   *   link-integrity counters (#255) incremented in place at the two structural
   *   branches: the gap branch and the write site.
   * @returns {Promise<boolean>} true if the wikilink was added.
   */
  async _addWikilink(handle, target, relationship, neighborhood, tally) {
    if (!handle?.path || !target) return false;

    const canonicalTarget = await this._resolveLinkTarget(target, neighborhood);
    // Computed once, read independently at the gap branch and the write site.
    // The dead-link counter reads this fact at the write — so if the gap
    // early-return below is ever removed, an unresolved write is still counted.
    const resolved = !!canonicalTarget;
    if (!resolved) {
      if (tally) tally.gapsLogged++;
      this.observations.notice({
        type: 'gap',
        cluster: neighborhood?.cluster,
        page: handle.title,
        detail: target,
      });
      try {
        await this._logKnowledgeGap(target, handle.title);
      } catch (err) {
        this.logger.warn(`[WikiSteward:connection] gap log for "${target}" failed: ${err.message}`);
      }
      this.logger.info(
        `[WikiSteward:connection] Link target "${target}" has no page — GAP recorded, no link written`
      );
      return false;
    }
    target = canonicalTarget;

    const result = await this.collectivesClient.readPageWithFrontmatterAtPath(handle.path);
    if (!result) return false;

    const body = result.body || '';

    // Idempotency: skip if the link to `target` already appears in the body,
    // in EITHER form. writePageWithFrontmatter() runs resolveWikilinks() before
    // every write, transforming [[target]] into [target](url). On the next
    // heartbeat read only the resolved form remains — so a check for the
    // unresolved form alone passes and appends a duplicate every cycle.
    // Matching `[target](` is structural markdown-link syntax, not natural
    // language, so it is allowed under the language policy.
    if (body.includes(`[[${target}]]`)) return false;
    if (body.includes(`[${target}](`)) return false;

    // Append a Related section entry
    const relLine = `\n- [[${target}]] (${relationship || 'related'})\n`;
    let newBody;

    if (body.includes('\n## Related\n') || body.includes('\n## Related\r\n')) {
      // Insert before the next heading or at end of Related section
      newBody = body.replace(/(\n## Related\n)([\s\S]*?)(\n##\s|\n*$)/, (_, header, section, after) => {
        return `${header}${section}${relLine}${after}`;
      });
    } else {
      // Append a new Related section
      newBody = `${body.trimEnd()}\n\n## Related\n${relLine}`;
    }

    // Regression sensor (#255): a resolved target reaches here today; an
    // unresolved one only can if the gap branch above is bypassed. Count it at
    // the write, independently of that branch.
    if (tally && !resolved) tally.deadLinksWritten++;

    await this.collectivesClient.writePageWithFrontmatterAtPath(handle.path, result.frontmatter, newBody);
    this.logger.info(`[WikiSteward:connection] Added [[${target}]] to "${handle.title}" (${relationship})`);
    return true;
  }

  /**
   * Resolve a proposed link target to the canonical title of an existing page,
   * or null when no page exists. Neighborhood titles answer first (the common
   * case: the LLM links within the cluster it assessed); the global lookup
   * covers cross-cluster targets, the one case the neighborhood cannot answer.
   *
   * @param {string} target - LLM-proposed target title.
   * @param {Neighborhood} [neighborhood]
   * @returns {Promise<string|null>} Canonical page title, or null.
   */
  async _resolveLinkTarget(target, neighborhood) {
    const wanted = target.toLowerCase().trim();
    const local = (neighborhood?.pages || []).find(
      p => (p.title || '').toLowerCase().trim() === wanted
    );
    if (local) return local.title;

    try {
      const found = await this.collectivesClient.findPageByTitle(target);
      if (found?.page?.title) return found.page.title;
    } catch (err) {
      this.logger.warn(`[WikiSteward:connection] findPageByTitle("${target}") failed: ${err.message}`);
    }
    return null;
  }

  /**
   * Connection lens: mark two pages as suspected duplicates.
   *
   * @param {{title: string, path: string, id?: string}} handleA
   * @param {{title: string, path: string, id?: string}} handleB
   * @param {number} similarity - 0..1
   * @param {string} [cluster] - Cluster the assessment ran in; carried on the
   *   notices so they join getNeediest and resolve under Phase 2 semantics.
   * @returns {Promise<boolean>}
   */
  async _flagDuplicate(handleA, handleB, similarity, cluster) {
    if (!handleA?.path || !handleB?.path) return false;

    const simLabel = typeof similarity === 'number'
      ? similarity.toFixed(2)
      : String(similarity || 'unknown');

    // Log observation for both pages
    this.observations.notice({
      type: 'near_duplicate',
      cluster,
      page: handleA.title,
      detail: `Possible duplicate of [[${handleB.title}]] (similarity: ${simLabel})`,
    });
    this.observations.notice({
      type: 'near_duplicate',
      cluster,
      page: handleB.title,
      detail: `Possible duplicate of [[${handleA.title}]] (similarity: ${simLabel})`,
    });

    const marker = 'Near-duplicate flagged by Connection Steward';

    let modified = false;

    for (const [handle, partner] of [[handleA, handleB], [handleB, handleA]]) {
      try {
        const result = await this.collectivesClient.readPageWithFrontmatterAtPath(handle.path);
        if (!result) continue;
        const body = result.body || '';
        // Pair key, not one-flag-ever: a page can be flagged against two
        // different partners while staying idempotent per pair.
        if (this._hasFlagForPair(body, marker, partner.title)) continue;
        const warning = `> ⚠️ ${marker}: possibly the same entity as [[${partner.title}]] (similarity: ${simLabel}). Manual review recommended.`;
        const newBody = body + `\n\n${warning}\n`;
        // Route through the frontmatter-aware path write so the [[other page]]
        // reference is resolved to a live Nextcloud link instead of dead text.
        await this.collectivesClient.writePageWithFrontmatterAtPath(handle.path, result.frontmatter, newBody);
        this.logger.info(`[WikiSteward:connection] Flagged near-duplicate on "${handle.title}" vs "${partner.title}"`);
        modified = true;
      } catch (err) {
        this.logger.warn(`[WikiSteward:connection] _flagDuplicate write to "${handle.title}" failed: ${err.message}`);
      }
    }

    // Human surface: one card per pair, same shape as contradictions.
    if (modified) {
      await this._createPairCard('Duplicate', handleA, handleB,
        `Possibly the same entity (similarity: ${simLabel})`);
    }

    return modified;
  }

  /**
   * Structural idempotency key for pair-keyed steward flags: a flag line for
   * a (marker, partner) pair exists iff some line carries both the invariant
   * marker phrase and the partner title as plain substrings. Both survive
   * wikilink resolution ([[T]] → [T](url)), NC Text round-trips (attribute
   * injection, escaping), and LLM claim rewording — the three rewriters that
   * defeated full-string checks and grew the flag walls (PR #50 Fix A class).
   * Matching a fixed system-emitted marker and a known title is structural
   * markup matching, inside the language policy — same as the existing
   * `[target](` check in _addWikilink.
   *
   * @param {string} body
   * @param {string} markerPhrase - System-emitted constant, e.g. 'Contradiction flagged by Knowledge Steward'
   * @param {string} partnerTitle - Partner page title (plain substring match)
   * @returns {boolean}
   */
  _hasFlagForPair(body, markerPhrase, partnerTitle) {
    if (!body || !markerPhrase || !partnerTitle) return false;
    return body.split('\n').some(
      line => line.includes(markerPhrase) && line.includes(partnerTitle)
    );
  }

  /**
   * Memory lens: a frequently-accessed page. Extend decay, raise confidence, bump access count.
   *
   * @param {{title: string, path: string}} handle
   * @returns {Promise<boolean>}
   */
  async _strengthenPage(handle) {
    if (!handle?.path) return false;

    const result = await this.collectivesClient.readPageWithFrontmatterAtPath(handle.path);
    if (!result) return false;

    const fm = { ...result.frontmatter };

    // Raise confidence (unless already high)
    if (fm.confidence !== 'high') {
      fm.confidence = fm.confidence === 'low' ? 'medium' : 'high';
    }

    // Extend decay_days by 30, capped at 365. -1 means permanent — leave untouched.
    if (fm.decay_days !== -1) {
      const current = Number.isFinite(Number(fm.decay_days)) ? Number(fm.decay_days) : 90;
      fm.decay_days = Math.min(current + 30, 365);
    }

    // Bump access_count
    const currentAccess = Number.isFinite(Number(fm.access_count)) ? Number(fm.access_count) : 0;
    fm.access_count = currentAccess + 1;

    fm.last_verified = new Date().toISOString().split('T')[0];

    await this.collectivesClient.writePageWithFrontmatterAtPath(handle.path, fm, result.body || '');
    this.logger.info(`[WikiSteward:memory] Strengthened "${handle.title}" (confidence=${fm.confidence}, decay=${fm.decay_days})`);
    return true;
  }

  /**
   * Memory lens: flag a page for composting.
   * Sets compost_ready=true and related metadata. The actual page move to
   * Archive/ is done by _moveToArchive on a later visit, once the 7-day human
   * veto window has passed (#245) — this only marks the frontmatter.
   *
   * Honors the `compost: never` frontmatter pin: structural/index pages
   * carry it because their access_count stays at 0 by design (probes target
   * content, not navigation), and the LLM would otherwise tautologically
   * propose them for composting.
   *
   * @param {{title: string, path: string}} handle
   * @param {string} reason
   * @returns {Promise<boolean>}
   */
  async _markForComposting(handle, reason) {
    if (!handle?.path) return false;

    const result = await this.collectivesClient.readPageWithFrontmatterAtPath(handle.path);
    if (!result) return false;

    if (result.frontmatter && result.frontmatter.compost === 'never') {
      this.logger.info(`[WikiSteward:memory] Skipping compost of "${handle.title}" — pinned (compost: never)`);
      return false;
    }

    const fm = { ...result.frontmatter };
    fm.compost_ready = true;
    fm.compost_reason = reason || 'Marked by Memory Steward';
    fm.compost_marked_at = new Date().toISOString();

    // Frontmatter carries the compost state. No inline body annotation:
    // it was redundant with compost_ready/compost_reason/compost_marked_at and
    // disrupted the Connection Steward's `## Related` section regex by inserting
    // content between the heading and EOF. The body holds knowledge only.
    await this.collectivesClient.writePageWithFrontmatterAtPath(handle.path, fm, result.body || '');
    this.logger.info(`[WikiSteward:memory] Marked "${handle.title}" for composting: ${reason}`);

    // Human surface: one card per compost candidate on the stale stack.
    if (this.knowledgeBoard) {
      try {
        await this.knowledgeBoard.createStaleCard({
          title: handle.title,
          description: `${this._pageLink(handle)} was marked compost-ready by the Memory Steward.\n\n**Reason:** ${fm.compost_reason}`,
        });
      } catch (err) {
        this.logger.warn(`[WikiSteward] KnowledgeBoard stale card for "${handle.title}" failed: ${err.message}`);
      }
    }
    return true;
  }

  /**
   * Memory lens: physically move a composted page to the Archive/ section
   * (#245). Called by the mover once compost_ready has aged past the 7-day
   * veto window. Collectives has no re-parent primitive, so the move is
   * create-in-Archive then trash-original: the page is never absent from the
   * wiki at any instant, and NC versioning plus the Archive copy are the only
   * undo. No delete path exists here.
   *
   * @param {{id: string|number, title: string, path: string}} handle - Handle
   *   from the assessed neighborhood (identity custody, G3).
   * @returns {Promise<boolean>} true if the page was archived.
   */
  async _moveToArchive(handle) {
    if (!handle?.path || handle.id == null) return false;

    // Read the FULL body — the neighborhood carries only a truncated preview,
    // and archiving must not write a clipped page.
    const full = await this.collectivesClient.readPageWithFrontmatterAtPath(handle.path);
    if (!full) return false;

    // Defense in depth: never archive a pinned page, even if it slipped the
    // structural filter. Same pin _markForComposting honors.
    if (full.frontmatter && full.frontmatter.compost === 'never') {
      this.logger.info(`[WikiSteward:memory] Skipping archive of "${handle.title}" — pinned (compost: never)`);
      return false;
    }

    const collectiveId = this.collectiveId || await this.collectivesClient.resolveCollective();
    const archiveSection = await this.collectivesClient.ensureSection(collectiveId, ARCHIVE_SECTION);
    if (!archiveSection?.id) {
      this.logger.warn(`[WikiSteward:memory] Archive of "${handle.title}" aborted — no Archive section`);
      return false;
    }

    const leafTitle = String(handle.title).split('/').pop();
    const created = await this.collectivesClient.createPage(collectiveId, archiveSection.id, leafTitle);

    const newPath = (created && (created.fileName || created.filePath))
      ? this.collectivesClient._buildPagePath(created)
      : null;
    if (!newPath) {
      // The created page carries no resolvable path. Trash the stub so it can't
      // collide with a future retry, and leave the original untouched — content
      // is never lost, the move simply doesn't happen this visit.
      if (created && created.id != null) {
        try { await this.collectivesClient.trashPage(collectiveId, created.id); } catch { /* best effort */ }
      }
      this.logger.warn(`[WikiSteward:memory] Archive of "${handle.title}" aborted — created page has no resolvable path`);
      return false;
    }

    // Collectives appends a "(N)" suffix when the Archive section already holds
    // this leaf title (a distinct same-named page, or a stub from an interrupted
    // move). We do NOT assume the existing page is this page's copy — that
    // assumption trashes an original whose content was never archived. We write
    // this page's body into whatever page was just created, suffixed or not: the
    // body is always preserved, and a duplicate title is the worst case.
    // Duplicates are recoverable; lost content is not.
    //
    // Pin the archived copy compost: never so the stewards treat it as inert:
    // it is skipped by the mover (archived) and by every lens (compost: never
    // lands it in the structural set), keeping Archive/ out of the tend churn.
    const fm = {
      ...full.frontmatter,
      archived: true,
      archived_at: new Date().toISOString(),
      compost: 'never',
    };
    await this.collectivesClient.writePageWithFrontmatterAtPath(newPath, fm, full.body || '');
    // Original trashed last — the Archive copy exists before the origin is gone.
    await this.collectivesClient.trashPage(collectiveId, handle.id);

    this.logger.info(`[WikiSteward:memory] Archived "${handle.title}" → ${ARCHIVE_SECTION}/ (original trashed)`);
    return true;
  }

  /**
   * Memory lens: embed a page that has no vector yet.
   *
   * Reads the page body, embeds via embeddingClient, and upserts into vectorStore.
   * If embeddingClient is null, skips gracefully.
   *
   * @param {{title: string, path: string, section?: string}} page - Handle from
   *   the assessed neighborhood.
   * @returns {Promise<boolean>}
   */
  async _embedPage(page) {
    if (!page || !page.title || !page.path) return false;

    // Guard: no embeddingClient available
    if (!this.embeddingClient || typeof this.embeddingClient.embed !== 'function') {
      this.logger.debug(`[WikiSteward:memory] No embeddingClient available — skipping embed for "${page.title}"`);
      return false;
    }

    // Read page content
    let body = '';
    try {
      const result = await this.collectivesClient.readPageWithFrontmatterAtPath(page.path);
      body = result?.body || '';
    } catch (err) {
      this.logger.warn(`[WikiSteward:memory] _embedPage read failed for "${page.title}": ${err.message}`);
      return false;
    }

    if (!body.trim()) return false;

    // Embed and upsert
    try {
      const vector = await this.embeddingClient.embed(body);
      if (!vector) return false;

      this.vectorStore.upsert(page.title, vector, {
        title: page.title,
        section: page.section || '',
        source: 'wiki',
        updated_at: new Date().toISOString(),
      });

      this.logger.info(`[WikiSteward:memory] Embedded "${page.title}"`);
      return true;
    } catch (err) {
      this.logger.warn(`[WikiSteward:memory] _embedPage embed/upsert failed for "${page.title}": ${err.message}`);
      return false;
    }
  }

  // ---------------------------------------------------------------------------
  // PRIVATE — FRACTAL INDEX REFRESH
  // ---------------------------------------------------------------------------

  /**
   * Level 1 refresh. For each changed section, regenerate the section parent
   * page (entity listing) from the current page set via the LLM.
   *
   * The prompt receives GROUNDED inputs: per page, a one-liner sourced from
   * frontmatter.summary or the first non-heading body line, plus the
   * confidence read from frontmatter. The model's task is formatting and
   * ordering, not invention (#38 fabrication class — the old prompt fed it
   * bare titles and asked for descriptions plus confidence labels, so it had
   * to make both up).
   *
   * @param {Set<string>} sections
   * @param {EnrichedPage[]} [enrichedPages] - Pages already read this tend;
   *   their frontmatter/preview ground the lines without a second read.
   *   Pages not in this set are read once via _readPage.
   * @returns {Promise<{ refreshed: number }>}
   */
  async _updateSectionSummaries(sections, enrichedPages = []) {
    if (!sections || typeof sections[Symbol.iterator] !== 'function') {
      return { refreshed: 0 };
    }

    let collectiveId = this.collectiveId;
    if (!collectiveId) {
      try {
        collectiveId = await this.collectivesClient.resolveCollective();
        this.collectiveId = collectiveId;
      } catch (err) {
        this.logger.warn(`[WikiSteward] _updateSectionSummaries: resolveCollective failed: ${err.message}`);
        return { refreshed: 0 };
      }
    }

    const enrichedByTitle = new Map((enrichedPages || []).map(p => [p.title, p]));
    let refreshed = 0;

    for (const sectionName of sections) {
      if (!sectionName) continue;
      try {
        // List pages belonging to this section — exact equality on the
        // derived section. The old lowercase-substring match made a page in
        // "Research Archive" a member of the "Research" summary (#51 class).
        const allPages = await this.collectivesClient.listPages(collectiveId);
        const pageList = Array.isArray(allPages) ? allPages : [];
        const landingPageId = pageList.find(p => p.parentId === 0)?.id;
        const sectionPages = pageList.filter(p =>
          deriveSection(p, landingPageId) === sectionName
        );

        if (sectionPages.length === 0) continue;

        // Resolve the Level 1 parent page BEFORE the LLM call: no parent, no
        // call. Prefer the structural shape (the section folder's Readme)
        // over a bare title match — a flat `<section>.md` stray at root
        // shares the leaf title and must not receive the section index.
        // If not found, skip — do NOT create an orphan page.
        const sectionParent =
          pageList.find(p => p.filePath === sectionName && /^readme\.md$/i.test(p.fileName || '')) ||
          pageList.find(p => p.title === sectionName);

        if (!sectionParent) {
          this.logger.warn(`[WikiSteward] _updateSectionSummaries: no Level 1 parent found for section "${sectionName}" — skipping`);
          continue;
        }

        // Grounded entity lines: the parent page lists its members, not itself.
        const entityPages = sectionPages.filter(p => p.id !== sectionParent.id);
        const entityLines = [];
        for (const p of entityPages) {
          let fm, bodyText;
          const enriched = enrichedByTitle.get(p.title);
          if (enriched) {
            fm = enriched.frontmatter;
            bodyText = enriched.bodyPreview;
          } else {
            const read = await this._readPage(p);
            fm = read?.frontmatter;
            bodyText = read?.body;
          }
          entityLines.push(this._groundedEntityLine(p.title, fm, bodyText));
        }

        if (entityLines.length === 0) continue;

        const prompt = `You are the Connection Steward formatting a Level 1 section index page for a knowledge wiki.

The section is: "${sectionName}"

These entities belong to this section. Each line carries the entity name and, where the wiki knows one, a verified one-line description (from page frontmatter or the page's first line) and a confidence label:

${entityLines.join('\n')}

Write the section page in this format:

# ${sectionName}

## Known Entities

(the entity lines, one per entity, ordered sensibly)

${entityPages.length} entities tracked · Last updated: ${new Date().toISOString().split('T')[0]}

RULES — your task is formatting and ordering, not invention:
- Use ONLY the entity lines given above. Never invent a description, role, or relationship.
- Keep each description as given (whitespace trimming is fine).
- A confidence label appears ONLY where the given line already carries one. Never add one.
- An entity with no description is listed by name alone.
- Wrap each entity name in [[...]] so it links: - **[[EntityName]]** — description

MULTILINGUAL EXAMPLE (formatting only — descriptions arrive in the wiki's language):
English: - **[[Carlos]]** — Editorial Director, ManeraMedia GmbH. (confidence: high)
German:  - **[[Tobias]]** — Betriebsleiter, ManeraMedia GmbH. (confidence: medium)
Portuguese: - **[[Eelco]]** — Investigador, projeto DIEM. (confidence: low)

Only write the markdown — no preamble. Keep the language of the given descriptions.`;

        const routerResult = await this.router.route({
          job: 'synthesis',
          content: prompt,
          requirements: { maxTokens: 800 },
          context: { trigger: 'wiki_steward_level1', internal: true },
        });

        const sectionBody = (routerResult?.result || routerResult?.content || '').trim();
        if (!sectionBody) continue;

        const sectionFm = {
          type: 'index',
          confidence: 'high',
          decay_days: -1,
          auto_maintained: true,
          last_refresh: new Date().toISOString().split('T')[0],
        };

        // Write by path: the resolved parent is the page that gets the index,
        // not whichever page in the collective shares its leaf title.
        await this.collectivesClient.writePageWithFrontmatterAtPath(
          this._pagePathOf(sectionParent), sectionFm, sectionBody
        );
        refreshed++;
        this.logger.info(`[WikiSteward] Refreshed Level 1 summary for section "${sectionName}"`);
      } catch (err) {
        this.logger.warn(`[WikiSteward] _updateSectionSummaries failed for "${sectionName}": ${err.message}`);
      }
    }

    return { refreshed };
  }

  /**
   * One grounded entity line for the Level 1 prompt. The one-liner comes from
   * frontmatter.summary when present, otherwise the first non-heading body
   * line. The confidence label appears only when frontmatter carries one —
   * absence stays absent, so the model has nothing to invent.
   *
   * @param {string} title
   * @param {Object} [frontmatter]
   * @param {string} [bodyText]
   * @returns {string}
   */
  _groundedEntityLine(title, frontmatter, bodyText) {
    const fm = frontmatter || {};
    let oneliner = typeof fm.summary === 'string' && fm.summary.trim()
      ? fm.summary.trim()
      : '';
    if (!oneliner) {
      const firstLine = (bodyText || '')
        .split('\n')
        .map(l => l.trim())
        .find(l => l && !l.startsWith('#'));
      oneliner = firstLine ? firstLine.slice(0, 160) : '';
    }
    const conf = fm.confidence ? ` (confidence: ${fm.confidence})` : '';
    return `- **${title}**${oneliner ? ` — ${oneliner}` : ''}${conf}`;
  }

  /**
   * Level 0 refresh. Ask the LLM to cluster the full entity set into 15–30
   * domain clusters, render as the landing page.
   *
   * @returns {Promise<{ clusters: number }>}
   */
  async _updateLandingPage() {
    let collectiveId = this.collectiveId;
    if (!collectiveId) {
      try {
        collectiveId = await this.collectivesClient.resolveCollective();
        this.collectiveId = collectiveId;
      } catch (err) {
        this.logger.warn(`[WikiSteward] _updateLandingPage: resolveCollective failed: ${err.message}`);
        return { clusters: 0 };
      }
    }

    // Gather all pages for entity summaries
    let allPages = [];
    try {
      const pages = await this.collectivesClient.listPages(collectiveId);
      allPages = Array.isArray(pages) ? pages : [];
    } catch (err) {
      this.logger.warn(`[WikiSteward] _updateLandingPage: listPages failed: ${err.message}`);
      return { clusters: 0 };
    }

    // Build entity listing: group by derived section
    const landingPageId = allPages.find(p => p.parentId === 0)?.id;
    const bySectionMap = new Map();
    for (const page of allPages) {
      const section = deriveSection(page, landingPageId) || 'Uncategorized';
      if (!bySectionMap.has(section)) bySectionMap.set(section, []);
      bySectionMap.get(section).push(page.title);
    }

    const sectionLines = Array.from(bySectionMap.entries()).map(([section, titles]) =>
      `${section} (${titles.length} pages): ${titles.slice(0, 8).join(', ')}${titles.length > 8 ? ', ...' : ''}`
    ).join('\n');

    // Fetch pending knowledge gaps
    let knowledgeGaps = '';
    try {
      const gapObs = this.observations.getByType('gap');
      if (gapObs.length > 0) {
        const gapLines = gapObs.slice(0, 10).map(o =>
          `- ${o.page || o.detail || 'Unknown entity'} — ${o.detail || 'no detail'}`
        ).join('\n');
        knowledgeGaps = `\n\n## Knowledge Gaps\n${gapLines}`;
      }
    } catch {
      // Gaps are optional — don't fail the landing page refresh
    }

    const refreshTs = new Date().toISOString().replace('T', ' ').substring(0, 16) + ' UTC';

    const prompt = `You are the Connection Steward writing the Level 0 landing page (mind map) for a knowledge wiki.

You must cluster these wiki sections and entities into 15-20 meaningful domain clusters BY MEANING, not by section name.
Entities in different sections can belong to the same domain cluster (e.g., a person and their organization belong together).

Here are the current wiki sections and their entities:

${sectionLines || '(No sections found yet.)'}

Do NOT include frontmatter (no --- blocks). Write only the markdown body starting with the # heading.

Write the landing page in this format:

# Moltagent Knowledge

## Knowledge Domains

### [Domain Cluster Name]
[One-sentence description of this domain]
[entity counts: X people · Y projects · Z documents]
Key entities: [comma-separated names]

### [Next Domain Cluster]
...

${knowledgeGaps}

*Auto-maintained by WikiSteward. Last refresh: ${refreshTs}*

MULTILINGUAL EXAMPLE:
English cluster:
### Editorial Media
ManeraMedia GmbH and team. Editorial workflows, content planning for hiphop.de.
3 people · 2 projects · 4 documents
Key contacts: Carlos (Editorial Director), Tobias (Operations)

German cluster:
### Redaktion & Medien
ManeraMedia GmbH und Team. Redaktionsabläufe und Inhaltsplanung für hiphop.de.
3 Personen · 2 Projekte · 4 Dokumente
Hauptkontakte: Carlos (Redaktionsleiter), Tobias (Betrieb)

Portuguese cluster:
### Sistemas Alimentares
Projeto DIEM — resiliência, sustentabilidade, pensamento sistêmico agroalimentar.
2 pessoas · 1 projeto · 8 documentos de referência
Investigador principal: Eelco Dykstra

Only write the full markdown page — no preamble, no extra commentary.
Keep Level 0 under 100 lines total so it loads fast for every query.`;

    const routerResult = await this.router.route({
      job: 'synthesis',
      content: prompt,
      requirements: { maxTokens: 1200 },
      context: { trigger: 'wiki_steward_level0', internal: true },
    });

    let landingBody = (routerResult?.result || routerResult?.content || '').trim();

    // Belt: strip code fences the LLM may wrap around the output despite the prompt
    landingBody = landingBody
      .replace(/^```(?:markdown|yaml|md)?\s*\n?/i, '')
      .replace(/\n?```\s*$/i, '');

    // Belt: strip any frontmatter block the LLM may still emit despite the instruction
    landingBody = landingBody
      .replace(/^---\s*\n[\s\S]*?\n---\s*\n?/, '');

    landingBody = landingBody.trim();

    if (!landingBody) {
      this.logger.warn('[WikiSteward] _updateLandingPage: LLM returned empty body');
      return { clusters: 0 };
    }

    // Count clusters for the return value
    const clusterMatches = landingBody.match(/^###\s+/gm) || [];

    const landingFrontmatter = {
      type: 'index',
      confidence: 'high',
      decay_days: -1,
      auto_maintained: true,
      compost: 'never',
      last_refresh: new Date().toISOString().split('T')[0],
    };

    // The landing page's identity is structural (parentId === 0), never its
    // leaf title: live evidence showed the title-addressed write landing on a
    // root stray that shared the collective's name while the real landing
    // page went stale (#43's page). Address it by path.
    const landing = allPages.find(p => p.parentId === 0);
    if (!landing) {
      this.logger.warn('[WikiSteward] _updateLandingPage: no landing page (parentId === 0) in page list — skipping');
      return { clusters: 0 };
    }
    try {
      await this.collectivesClient.writePageWithFrontmatterAtPath(
        this._pagePathOf(landing),
        landingFrontmatter,
        landingBody
      );
    } catch (err) {
      this.logger.warn(`[WikiSteward] _updateLandingPage write failed: ${err.message}`);
      return { clusters: 0 };
    }

    this._lastIndexRefresh = Date.now();
    this.logger.info(`[WikiSteward] Refreshed Level 0 landing page (${clusterMatches.length} clusters)`);
    return { clusters: clusterMatches.length };
  }

  /**
   * Time-based predicate. Trivial — safe to implement here.
   *
   * @returns {boolean} true if enough time has elapsed since the last Level 0 refresh.
   */
  _shouldRefreshIndex() {
    return (Date.now() - this._lastIndexRefresh) >= this._indexRefreshIntervalMs;
  }

  // ---------------------------------------------------------------------------
  // PRIVATE — UTILITIES
  // ---------------------------------------------------------------------------

  /**
   * Serialize frontmatter + body into a markdown string.
   * Used when we need to write raw content via writePageContent (not writePageWithFrontmatter).
   *
   * @param {Object} frontmatter
   * @param {string} body
   * @returns {string}
   * @private
   */
  _serializeWithFrontmatter(frontmatter, body) {
    try {
      const { serializeFrontmatter } = require('../knowledge/frontmatter');
      return serializeFrontmatter(frontmatter, body);
    } catch {
      // Fallback: manual YAML serialization for simple flat objects
      if (!frontmatter || Object.keys(frontmatter).length === 0) return body;
      const yamlLines = Object.entries(frontmatter).map(([k, v]) => `${k}: ${JSON.stringify(v)}`);
      return `---\n${yamlLines.join('\n')}\n---\n\n${body}`;
    }
  }

  /**
   * WebDAV path for a listPages entry. Delegates to the client's path builder
   * (the client owns the path shape); the inline fallback only serves mocks
   * that don't expose it.
   *
   * @param {{ filePath?: string, fileName?: string, title?: string }} page
   * @returns {string}
   * @private
   */
  _pagePathOf(page) {
    if (typeof this.collectivesClient._buildPagePath === 'function') {
      return this.collectivesClient._buildPagePath(page);
    }
    return page.filePath ? `${page.filePath}/${page.fileName}` : (page.fileName || `${page.title}.md`);
  }

  /**
   * Resolve any `[[wikilinks]]` in a body to live Nextcloud file links.
   * Thin wrapper around collectivesClient.resolveWikilinks() that is safe to
   * call when the client doesn't expose the resolver (older mocks in tests).
   *
   * @param {string} body
   * @returns {Promise<string>}
   * @private
   */
  async _resolveWikilinks(body) {
    if (!body) return body;
    if (typeof this.collectivesClient.resolveWikilinks !== 'function') return body;
    try {
      return await this.collectivesClient.resolveWikilinks(body);
    } catch (err) {
      this.logger.debug?.(`[WikiSteward] _resolveWikilinks failed, writing raw: ${err.message}`);
      return body;
    }
  }
}

/**
 * Extract the first complete JSON object from a string that may be wrapped in
 * markdown code fences, prefixed with prose, or followed by trailing content.
 *
 * Brace-counts from the first `{` to its matching `}`, skipping braces inside
 * JSON strings (and respecting backslash escapes). Throws if no balanced
 * object can be found or if the extracted substring is not valid JSON.
 *
 * @param {string} raw
 * @returns {Object}
 */
function _extractJsonObject(raw) {
  if (typeof raw !== 'string' || raw.length === 0) {
    throw new Error('empty response');
  }
  const start = raw.indexOf('{');
  if (start === -1) throw new Error('no JSON object found');

  let depth = 0;
  let end = -1;
  let inString = false;
  let escape = false;
  for (let i = start; i < raw.length; i++) {
    const ch = raw[i];
    if (escape) { escape = false; continue; }
    if (ch === '\\') { escape = true; continue; }
    if (ch === '"') { inString = !inString; continue; }
    if (inString) continue;
    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) { end = i; break; }
    }
  }
  if (end === -1) throw new Error('unbalanced braces');
  return JSON.parse(raw.slice(start, end + 1));
}

module.exports = { WikiSteward };
