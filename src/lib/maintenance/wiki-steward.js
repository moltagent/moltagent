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
 *   frontmatter + graph edges + deck cards), assesses it through the active
 *   steward's lens via ONE LLM call, then executes targeted interventions.
 *   Rotation guarantees every lens walks every cluster over time.
 * - Key Dependencies:
 *     CollectivesClient    — list/read/write pages, ensureSection
 *     KnowledgeGraph       — _entities / _triples / relatedTo / getEntity
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
 *         → _nextSteward()  (rotation)
 *         → _readNeighborhood(cluster)  (CollectivesClient + KnowledgeGraph + VectorStore)
 *         → _assess(stewardType, neighborhood)  (llmRouter.route, ONE call)
 *         → _intervene(stewardType, assessment, neighborhood)  (per-lens executors)
 *         → _updateSectionSummaries(sections)  (Level 1 refresh if pages changed)
 *         → _updateLandingPage() (Level 0 refresh, throttled by _shouldRefreshIndex)
 *         → observationLog.resolve(cluster, resolvedTypes)
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
 * @property {Array} graphEdges
 * @property {Set<string>} sections
 * @property {Array} deckCards
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
 * @property {string[]} resolvedTypes
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
    this.logger = logger || console;
    this.collectiveId = collectiveId || null;

    this.config = config || {};

    // Steward rotation — three lenses on the same neighborhood.
    /** @type {number} */
    this._stewardIndex = 0;
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

    // Level 0 landing page throttling.
    /** @type {number} */
    this._lastIndexRefresh = 0;
    /** @type {number} */
    this._indexRefreshIntervalMs = Number.isFinite(this.config.indexRefreshIntervalMs)
      ? this.config.indexRefreshIntervalMs
      : 6 * 60 * 60 * 1000; // 6h default
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
   *   8. Mark observations as resolved for (cluster, resolvedTypes).
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
    const stewardType = this._nextSteward();

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
      interventionResult = { pagesModified: 0, linksAdded: 0, observationsResolved: 0, resolvedTypes: [] };
    }

    // Step 6: refresh Level 1 summaries if pages were modified
    if (interventionResult.pagesModified > 0) {
      try {
        await this._updateSectionSummaries(neighborhood.sections);
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

    // Step 8: resolve handled observations
    try {
      if (interventionResult.resolvedTypes && interventionResult.resolvedTypes.length > 0) {
        this.observations.resolve(cluster.name, interventionResult.resolvedTypes);
      }
    } catch (err) {
      this.logger.warn(`[WikiSteward] observations.resolve failed: ${err.message}`);
    }

    // Step 9: record visit timestamp
    this._lastVisit.set(cluster.name, Date.now());

    const result = {
      steward: stewardType,
      cluster: cluster.name,
      pagesModified: interventionResult.pagesModified,
      linksAdded: interventionResult.linksAdded,
      observationsResolved: interventionResult.observationsResolved,
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
   * Rotate through stewards. Each pulse, the next lens walks.
   * Trivial ring rotation — safe to implement here.
   *
   * @returns {string} One of 'knowledge' | 'connection' | 'memory'
   */
  _nextSteward() {
    const steward = this._stewards[this._stewardIndex];
    this._stewardIndex = (this._stewardIndex + 1) % this._stewards.length;
    return steward;
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
   * Return the section name for a page, or null if no section can be derived.
   *
   * Chain:
   *   1. page.section (truthy) — returned directly; defensive for future API restores.
   *   2. page.filePath (non-empty string) — first non-empty segment after split('/').
   *   3. page.parentId === landingPageId (direct child of landing) — page.title.
   *   4. null — landing page itself (parentId===0, empty filePath) and orphans.
   *
   * @param {{ section?: string, filePath?: string, parentId?: number, title?: string }} page
   * @param {number|undefined} landingPageId
   * @returns {string|null}
   */
  _getPageSection(page, landingPageId) {
    if (page.section) return page.section;
    if (page.filePath) {
      const parts = page.filePath.split('/').filter(Boolean);
      return parts[0] || null;
    }
    if (landingPageId && page.parentId === landingPageId && page.title) {
      return page.title;
    }
    return null;
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
        const section = this._getPageSection(page, landingPageId);
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
   * embedding presence, graph edges, and wikilink targets. This is the single
   * "walk the garden" that all three stewards reuse.
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
      graphEdges: [],
      sections: new Set(),
      deckCards: [],
    };

    // Resolve collective ID if needed
    let collectiveId = this.collectiveId;
    if (!collectiveId) {
      collectiveId = await this.collectivesClient.resolveCollective();
      this.collectiveId = collectiveId;
    }

    // List pages that belong to this cluster via _getPageSection (single chokepoint
    // shared with _listClusters; resilient to Collectives API filePath shape changes).
    let clusterPages = [];
    try {
      const allPages = await this.collectivesClient.listPages(collectiveId);
      const pageList = Array.isArray(allPages) ? allPages : [];
      const clusterName = cluster.name;

      const landingPage = pageList.find(p => p.parentId === 0);
      const landingPageId = landingPage?.id;
      clusterPages = pageList.filter(p => this._getPageSection(p, landingPageId) === clusterName);
    } catch (err) {
      this.logger.warn(`[WikiSteward] Failed to list pages for cluster "${cluster.name}": ${err.message}`);
      return neighborhood;
    }

    const bodyPreviewLimit = Number.isFinite(this.config.bodyPreviewChars)
      ? this.config.bodyPreviewChars
      : 500;

    for (const pageRef of clusterPages) {
      try {
        const frontmatter = await this._readFrontmatter(pageRef);
        const bodyPreview = await this._readBodyPreview(pageRef, bodyPreviewLimit);
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

        neighborhood.pages.push({
          id: pageRef.id,
          title: pageRef.title,
          entityId,
          section: pageRef.section || pageRef.filePath || cluster.name,
          frontmatter,
          bodyPreview,
          hasEmbedding,
          graphConnections,
          wikilinks,
        });

        if (pageRef.section || pageRef.filePath) {
          neighborhood.sections.add(pageRef.section || pageRef.filePath);
        }
      } catch (err) {
        this.logger.warn(`[WikiSteward] Skipping page "${pageRef.title}" due to error: ${err.message}`);
      }
    }

    // Collect graph edges across all cluster pages for neighborhood-level context.
    // Match on entity IDs (not titles) — that is how KnowledgeGraph stores triples.
    const entityIds = new Set(
      neighborhood.pages.map(p => p.entityId).filter(Boolean)
    );
    neighborhood.graphEdges = (this.knowledgeGraph._triples || []).filter(t =>
      entityIds.has(t.subject) || entityIds.has(t.object)
    );

    return neighborhood;
  }

  /**
   * @param {PageRef} page
   * @returns {Promise<Object>} Parsed YAML frontmatter (possibly empty).
   */
  async _readFrontmatter(page) {
    try {
      const result = await this.collectivesClient.readPageWithFrontmatter(page.title);
      return result?.frontmatter || {};
    } catch (err) {
      this.logger.debug(`[WikiSteward] _readFrontmatter("${page.title}") failed: ${err.message}`);
      return {};
    }
  }

  /**
   * @param {PageRef} page
   * @param {number} limit - Max chars to read.
   * @returns {Promise<string>}
   */
  async _readBodyPreview(page, limit) {
    try {
      const result = await this.collectivesClient.readPageWithFrontmatter(page.title);
      if (!result) return '';
      // body is already stripped of frontmatter by readPageWithFrontmatter
      const body = result.body || '';
      return body.slice(0, limit);
    } catch (err) {
      this.logger.debug(`[WikiSteward] _readBodyPreview("${page.title}") failed: ${err.message}`);
      return '';
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

    try {
      return _extractJsonObject(raw);
    } catch (err) {
      this.logger.warn(
        `[WikiSteward:${stewardType}] Assessment JSON parse failed (${err.message}) — raw (first 400): ${String(raw).slice(0, 400)}`
      );
      return { actions: [] };
    }
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
      resolvedTypes: [],
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

    switch (stewardType) {
      case 'knowledge': {
        for (const c of assessment.contradictions || []) {
          if (structuralTitles.has(c.pageA) || structuralTitles.has(c.pageB)) {
            this.logger.info(`[WikiSteward:knowledge] Skipping structural page in contradiction: "${c.pageA}" / "${c.pageB}"`);
            continue;
          }
          try {
            const flagged = await this._flagContradiction(c.pageA, c.pageB, c.claim);
            if (flagged) results.pagesModified += 2;
          } catch (err) {
            this.logger.warn(`[WikiSteward:knowledge] _flagContradiction failed: ${err.message}`);
          }
        }
        for (const s of assessment.stale || []) {
          if (structuralTitles.has(s.page)) {
            this.logger.info(`[WikiSteward:knowledge] Skipping structural page "${s.page}" for staleness`);
            continue;
          }
          try {
            const lowered = await this._lowerConfidence(s.page, s.reason);
            if (lowered) results.pagesModified++;
          } catch (err) {
            this.logger.warn(`[WikiSteward:knowledge] _lowerConfidence("${s.page}") failed: ${err.message}`);
          }
        }
        // _logKnowledgeGap writes to Meta/Pending Questions, not to the
        // referenced page — the gap observation is valid even if the
        // referencing page is structural. No guard needed here.
        for (const g of assessment.gaps || []) {
          try {
            await this._logKnowledgeGap(g.entity, g.referencedIn);
          } catch (err) {
            this.logger.warn(`[WikiSteward:knowledge] _logKnowledgeGap("${g.entity}") failed: ${err.message}`);
          }
        }
        results.resolvedTypes = ['contradiction', 'stale_content', 'gap', 'low_confidence'];
        break;
      }

      case 'connection': {
        for (const m of assessment.missingLinks || []) {
          if (structuralTitles.has(m.page)) {
            this.logger.info(`[WikiSteward:connection] Skipping structural page "${m.page}" for missing link`);
            continue;
          }
          try {
            const added = await this._addWikilink(m.page, m.shouldLinkTo, m.relationship);
            if (added) {
              results.linksAdded++;
              results.pagesModified++;
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
          for (const target of o.suggestedConnections || []) {
            try {
              const added = await this._addWikilink(o.page, target, 'related');
              if (added) {
                results.linksAdded++;
                results.pagesModified++;
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
          try {
            await this._flagDuplicate(d.pageA, d.pageB, d.similarity || 0);
          } catch (err) {
            this.logger.warn(`[WikiSteward:connection] _flagDuplicate failed: ${err.message}`);
          }
        }
        results.resolvedTypes = ['missing_link', 'orphan_page', 'near_duplicate', 'section_stale'];
        break;
      }

      case 'memory': {
        for (const s of assessment.strengthen || []) {
          if (structuralTitles.has(s.page)) {
            this.logger.info(`[WikiSteward:memory] Skipping structural page "${s.page}" for strengthening`);
            continue;
          }
          try {
            const strengthened = await this._strengthenPage(s.page);
            if (strengthened) results.pagesModified++;
          } catch (err) {
            this.logger.warn(`[WikiSteward:memory] _strengthenPage("${s.page}") failed: ${err.message}`);
          }
        }
        for (const c of assessment.compost || []) {
          if (structuralTitles.has(c.page)) {
            this.logger.info(`[WikiSteward:memory] Skipping structural page "${c.page}" for composting`);
            continue;
          }
          try {
            await this._markForComposting(c.page, c.reason);
          } catch (err) {
            this.logger.warn(`[WikiSteward:memory] _markForComposting("${c.page}") failed: ${err.message}`);
          }
        }
        for (const e of assessment.embed || []) {
          if (structuralTitles.has(e.page)) {
            this.logger.info(`[WikiSteward:memory] Skipping structural page "${e.page}" for embedding`);
            continue;
          }
          // Find the full pageRef from neighborhood so _embedPage has path/section
          const pageRef = neighborhood.pages.find(p => p.title === e.page) || { id: null, title: e.page };
          try {
            await this._embedPage(pageRef);
          } catch (err) {
            this.logger.warn(`[WikiSteward:memory] _embedPage("${e.page}") failed: ${err.message}`);
          }
        }
        results.resolvedTypes = ['unembedded', 'never_accessed', 'compost_ready', 'high_access'];
        break;
      }

      default:
        this.logger.warn(`[WikiSteward] Unknown stewardType in _intervene: "${stewardType}"`);
    }

    results.observationsResolved = results.resolvedTypes.length;
    return results;
  }

  /**
   * Knowledge lens: two pages disagree on a fact. Append a contradiction warning
   * block to each page if not already present, and log LOW_CONFIDENCE observations.
   *
   * @param {string} pageA
   * @param {string} pageB
   * @param {string} claim
   * @returns {Promise<boolean>} true if at least one note was persisted.
   */
  async _flagContradiction(pageA, pageB, claim) {
    if (!pageA || !pageB || !claim) return false;

    const flagA = `> ⚠️ Contradiction flagged by Knowledge Steward: conflicts with [[${pageB}]] on "${claim}"`;
    const flagB = `> ⚠️ Contradiction flagged by Knowledge Steward: conflicts with [[${pageA}]] on "${claim}"`;

    let modified = false;

    // Write to pageA — route through writePageWithFrontmatter so [[pageB]] is resolved.
    try {
      const resultA = await this.collectivesClient.readPageWithFrontmatter(pageA);
      if (resultA) {
        const body = resultA.body || '';
        if (!body.includes(flagA)) {
          const newBody = body + `\n\n${flagA}\n`;
          await this.collectivesClient.writePageWithFrontmatter(pageA, resultA.frontmatter, newBody);
          modified = true;
        }
      }
    } catch (err) {
      this.logger.warn(`[WikiSteward] _flagContradiction write to "${pageA}" failed: ${err.message}`);
    }

    // Write to pageB — route through writePageWithFrontmatter so [[pageA]] is resolved.
    try {
      const resultB = await this.collectivesClient.readPageWithFrontmatter(pageB);
      if (resultB) {
        const body = resultB.body || '';
        if (!body.includes(flagB)) {
          const newBody = body + `\n\n${flagB}\n`;
          await this.collectivesClient.writePageWithFrontmatter(pageB, resultB.frontmatter, newBody);
          modified = true;
        }
      }
    } catch (err) {
      this.logger.warn(`[WikiSteward] _flagContradiction write to "${pageB}" failed: ${err.message}`);
    }

    // Emit LOW_CONFIDENCE observations for both pages so they surface for verification
    this.observations.notice({ type: 'low_confidence', page: pageA, detail: `Contradiction with ${pageB}: ${claim}` });
    this.observations.notice({ type: 'low_confidence', page: pageB, detail: `Contradiction with ${pageA}: ${claim}` });

    return modified;
  }

  /**
   * Knowledge lens: a page's confidence should drop.
   *
   * @param {string} page
   * @param {string} reason
   * @returns {Promise<boolean>}
   */
  async _lowerConfidence(page, reason) {
    if (!page) return false;

    const result = await this.collectivesClient.readPageWithFrontmatter(page);
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
    fm.verification_note = reason || 'Confidence lowered by Knowledge Steward';

    await this.collectivesClient.writePageWithFrontmatter(page, fm, result.body || '');
    this.logger.info(`[WikiSteward:knowledge] Lowered confidence for "${page}" to ${fm.confidence}: ${reason}`);
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
    if (!entity) return;

    const pendingQuestionsPath = 'Meta/Pending Questions.md';
    const line = `- ${entity} — referenced in [[${referencedIn || 'unknown'}]], no page yet`;

    let existing = '';
    try {
      existing = await this.collectivesClient.readPageContent(pendingQuestionsPath) || '';
    } catch {
      // File may not exist yet — that's fine, we'll create it
    }

    // Idempotency: skip if this exact entity line is already recorded
    if (existing.includes(`- ${entity} —`)) return;

    const updated = existing
      ? `${existing.trimEnd()}\n${line}\n`
      : `# Pending Questions\n\n${line}\n`;

    try {
      const resolved = await this._resolveWikilinks(updated);
      await this.collectivesClient.writePageContent(pendingQuestionsPath, resolved);
      this.logger.info(`[WikiSteward:knowledge] Logged knowledge gap: "${entity}" (referenced in ${referencedIn})`);
    } catch (err) {
      this.logger.warn(`[WikiSteward:knowledge] _logKnowledgeGap write failed: ${err.message}`);
    }
  }

  /**
   * Connection lens: add `[[target]]` to `page` in a context-appropriate line.
   * Only writes if the wikilink is not already present.
   *
   * @param {string} page
   * @param {string} target
   * @param {string} relationship
   * @returns {Promise<boolean>} true if the wikilink was added.
   */
  async _addWikilink(page, target, relationship) {
    if (!page || !target) return false;

    const result = await this.collectivesClient.readPageWithFrontmatter(page);
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

    await this.collectivesClient.writePageWithFrontmatter(page, result.frontmatter, newBody);
    this.logger.info(`[WikiSteward:connection] Added [[${target}]] to "${page}" (${relationship})`);
    return true;
  }

  /**
   * Connection lens: mark two pages as suspected duplicates.
   *
   * @param {string} pageA
   * @param {string} pageB
   * @param {number} similarity - 0..1
   * @returns {Promise<boolean>}
   */
  async _flagDuplicate(pageA, pageB, similarity) {
    if (!pageA || !pageB) return false;

    const simLabel = typeof similarity === 'number'
      ? similarity.toFixed(2)
      : String(similarity || 'unknown');

    // Log observation for both pages
    this.observations.notice({
      type: 'near_duplicate',
      page: pageA,
      detail: `Possible duplicate of [[${pageB}]] (similarity: ${simLabel})`,
    });
    this.observations.notice({
      type: 'near_duplicate',
      page: pageB,
      detail: `Possible duplicate of [[${pageA}]] (similarity: ${simLabel})`,
    });

    const warningBlock = `> ⚠️ Near-duplicate flagged by Connection Steward: possibly the same entity as [[${pageB}]] (similarity: ${simLabel}). Manual review recommended.`;
    const warningBlockB = `> ⚠️ Near-duplicate flagged by Connection Steward: possibly the same entity as [[${pageA}]] (similarity: ${simLabel}). Manual review recommended.`;

    let modified = false;

    for (const [pageName, warning] of [[pageA, warningBlock], [pageB, warningBlockB]]) {
      try {
        const result = await this.collectivesClient.readPageWithFrontmatter(pageName);
        if (!result) continue;
        const body = result.body || '';
        if (body.includes('Near-duplicate flagged by Connection Steward')) continue; // already flagged
        const newBody = body + `\n\n${warning}\n`;
        // Route through writePageWithFrontmatter so the [[other page]] reference
        // is resolved to a live Nextcloud link instead of dead text.
        await this.collectivesClient.writePageWithFrontmatter(pageName, result.frontmatter, newBody);
        modified = true;
      } catch (err) {
        this.logger.warn(`[WikiSteward:connection] _flagDuplicate write to "${pageName}" failed: ${err.message}`);
      }
    }

    return modified;
  }

  /**
   * Memory lens: a frequently-accessed page. Extend decay, raise confidence, bump access count.
   *
   * @param {string} page
   * @returns {Promise<boolean>}
   */
  async _strengthenPage(page) {
    if (!page) return false;

    const result = await this.collectivesClient.readPageWithFrontmatter(page);
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

    await this.collectivesClient.writePageWithFrontmatter(page, fm, result.body || '');
    this.logger.info(`[WikiSteward:memory] Strengthened "${page}" (confidence=${fm.confidence}, decay=${fm.decay_days})`);
    return true;
  }

  /**
   * Memory lens: flag a page for composting.
   * Sets compost_ready=true and related metadata. The actual page move
   * is done by the Sleep Cycle — this only marks the frontmatter.
   *
   * Honors the `compost: never` frontmatter pin: structural/index pages
   * carry it because their access_count stays at 0 by design (probes target
   * content, not navigation), and the LLM would otherwise tautologically
   * propose them for composting.
   *
   * @param {string} page
   * @param {string} reason
   * @returns {Promise<boolean>}
   */
  async _markForComposting(page, reason) {
    if (!page) return false;

    const result = await this.collectivesClient.readPageWithFrontmatter(page);
    if (!result) return false;

    if (result.frontmatter && result.frontmatter.compost === 'never') {
      this.logger.info(`[WikiSteward:memory] Skipping compost of "${page}" — pinned (compost: never)`);
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
    await this.collectivesClient.writePageWithFrontmatter(page, fm, result.body || '');
    this.logger.info(`[WikiSteward:memory] Marked "${page}" for composting: ${reason}`);
    return true;
  }

  /**
   * Memory lens: embed a page that has no vector yet.
   *
   * Reads the page body, embeds via embeddingClient, and upserts into vectorStore.
   * If embeddingClient is null, skips gracefully.
   *
   * @param {PageRef} page
   * @returns {Promise<boolean>}
   */
  async _embedPage(page) {
    if (!page || !page.title) return false;

    // Guard: no embeddingClient available
    if (!this.embeddingClient || typeof this.embeddingClient.embed !== 'function') {
      this.logger.debug(`[WikiSteward:memory] No embeddingClient available — skipping embed for "${page.title}"`);
      return false;
    }

    // Read page content
    let body = '';
    try {
      const result = await this.collectivesClient.readPageWithFrontmatter(page.title);
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
   * @param {Set<string>} sections
   * @returns {Promise<{ refreshed: number }>}
   */
  async _updateSectionSummaries(sections) {
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

    let refreshed = 0;

    for (const sectionName of sections) {
      if (!sectionName) continue;
      try {
        // List pages belonging to this section
        const allPages = await this.collectivesClient.listPages(collectiveId);
        const pageList = Array.isArray(allPages) ? allPages : [];
        const sectionNameLower = sectionName.toLowerCase();
        const sectionPages = pageList.filter(p =>
          ((p.section || p.filePath || '').toLowerCase()).includes(sectionNameLower)
        );

        if (sectionPages.length === 0) continue;

        // Build entity summaries for the prompt
        const entityLines = sectionPages.map(p => `- **${p.title}**`).join('\n');

        const prompt = `You are the Connection Steward writing a Level 1 section index page for a knowledge wiki.

The section is: "${sectionName}"

The following entities belong to this section:

${entityLines}

Write a section landing page in this format:

# ${sectionName}

## Known Entities

- **EntityName** — one-line description, role or context. [[Related Entity]] (confidence level)
- (repeat for each entity)

${sectionPages.length} entities tracked · Last updated: ${new Date().toISOString().split('T')[0]}

MULTILINGUAL EXAMPLE:
English: - **Carlos** — Editorial Director, ManeraMedia GmbH. Primary contact for hiphop.de. [[ManeraMedia GmbH]] (high confidence)
German:  - **Tobias** — Betriebsleiter, ManeraMedia GmbH. Zuständig für Infrastruktur. [[ManeraMedia GmbH]] (hohe Konfidenz)
Portuguese: - **Eelco** — Investigador, projeto DIEM. Foco em sistemas alimentares. [[DIEM]] (confiança média)

Only write the markdown — no preamble. Use the language of the section content.
Respond in the same language as the entity names and context imply.`;

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

        // Resolve the Level 1 parent page: find a page whose title matches the section
        // name and whose parentId is 0 (root-level section parent), or whose filePath
        // looks like a section index (e.g., "People/Readme.md" or "People.md").
        // If not found, skip — do NOT create an orphan page.
        const allPagesForWrite = await this.collectivesClient.listPages(collectiveId);
        const pageListForWrite = Array.isArray(allPagesForWrite) ? allPagesForWrite : [];
        const sectionParent = pageListForWrite.find(p => {
          if (p.title === sectionName) return true;
          if (p.filePath && (
            p.filePath === `${sectionName}.md` ||
            p.filePath === `${sectionName}/Readme.md` ||
            p.filePath === `${sectionName}/README.md`
          )) return true;
          return false;
        });

        if (!sectionParent) {
          this.logger.warn(`[WikiSteward] _updateSectionSummaries: no Level 1 parent found for section "${sectionName}" — skipping`);
          continue;
        }

        await this.collectivesClient.writePageWithFrontmatter(sectionParent.title, sectionFm, sectionBody);
        refreshed++;
        this.logger.info(`[WikiSteward] Refreshed Level 1 summary for section "${sectionName}"`);
      } catch (err) {
        this.logger.warn(`[WikiSteward] _updateSectionSummaries failed for "${sectionName}": ${err.message}`);
      }
    }

    return { refreshed };
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

    // Build entity listing: group by section
    const bySectionMap = new Map();
    for (const page of allPages) {
      const section = page.section || page.filePath || 'Uncategorized';
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

    // Write the landing page — it's the root page of the collective
    // writePageWithFrontmatter resolves [[wikilinks]] internally; no explicit pre-resolve needed.
    try {
      const landingPageTitle = this.collectivesClient.collectiveName || 'Moltagent Knowledge';
      await this.collectivesClient.writePageWithFrontmatter(
        landingPageTitle,
        landingFrontmatter,
        landingBody
      );
    } catch (err) {
      // Fallback: try with the literal known title
      try {
        await this.collectivesClient.writePageWithFrontmatter(
          'Moltagent Knowledge',
          landingFrontmatter,
          landingBody
        );
      } catch (err2) {
        this.logger.warn(`[WikiSteward] _updateLandingPage write failed: ${err2.message}`);
        return { clusters: 0 };
      }
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
