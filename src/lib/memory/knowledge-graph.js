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

/**
 * KnowledgeGraph — In-memory entity/triple graph with file persistence.
 *
 * Architecture Brief:
 * - Problem: Keyword and vector search cannot traverse entity relationships
 * - Pattern: In-memory graph with BFS traversal, persisted as JSON file via NCFilesClient
 * - Key Dependencies: NCFilesClient (file persistence at Memory/_index.json)
 * - Data Flow: addEntity/addTriple → in-memory graph → flush() → JSON file
 * - Dependency Map: entity-extractor.js → knowledge-graph.js → nc-files-client.js
 *
 * @module memory/knowledge-graph
 * @version 1.1.0
 */

const FILE_PATH = 'Memory/_index.json';
const FILE_DIR = 'Memory';
const VALID_PREDICATES = new Set([
  'reports_to', 'leads', 'led_by', 'managed_by', 'works_on', 'works_at',
  'belongs_to', 'located_at', 'employed_by', 'affiliated_with',
  'client_of', 'contacts', 'contact_for', 'responsible_for',
  'depends_on', 'related_to', 'references',
  'has_goal', 'has_status', 'has_deadline', 'blocks'
]);
const MAX_HOPS = 10;

// Type specificity ranking — domain types beat generic types
const TYPE_PRIORITY = {
  project: 3, procedure: 3, decision: 3, tool: 3, research: 3, organization: 3,
  person: 2, team: 2,
  page: 1, concept: 1, note: 1
};

class KnowledgeGraph {
  /**
   * @param {Object} deps
   * @param {Object} deps.ncFilesClient - NCFilesClient with readFile/writeFile/mkdir
   * @param {Object} [deps.wikiClient] - DEPRECATED: use ncFilesClient instead
   * @param {Object} [deps.logger]
   */
  constructor({ ncFilesClient, wikiClient, logger } = {}) {
    this.filesClient = ncFilesClient || null;
    this.wiki = wikiClient || null;
    if (!this.filesClient && !this.wiki) {
      throw new Error('KnowledgeGraph requires ncFilesClient (or legacy wikiClient)');
    }
    this.logger = logger || console;

    /** @type {Map<string, { id: string, name: string, type: string, created: string }>} */
    this._entities = new Map(); // id → { id, name, type, created }

    /** @type {Array<{ subject: string, predicate: string, object: string, verified: string }>} */
    this._triples = []; // [{ subject, predicate, object, verified }]

    this._loaded = false;
    this._dirty = false;
  }

  // ===========================================================================
  // Persistence
  // ===========================================================================

  /**
   * Load graph from the wiki page at Memory/_index.
   * Expects content to contain a ```json ... ``` code block.
   * On any error or missing page, starts with an empty graph.
   *
   * @returns {Promise<void>}
   */
  async load() {
    try {
      let raw = null;

      if (this.filesClient) {
        // NCFilesClient path: read plain JSON file
        const result = await this.filesClient.readFile(FILE_PATH);
        raw = result && result.content ? result.content : null;
      } else {
        // Legacy CollectivesClient path: extract JSON from markdown code fence
        const content = await this.wiki.readPageContent('Memory/_index');
        if (content) {
          const match = content.match(/```json\s*\n([\s\S]*?)\n```/);
          raw = match ? match[1] : null;
        }
      }

      if (raw) {
        const parsed = JSON.parse(raw);

        // Replay entities through addEntity() to collapse cross-type duplicates.
        // addEntity() handles name-based dedup and keeps the most specific type.
        this._loaded = true; // enable addEntity() before the loop
        const idRemap = new Map(); // old id → new id (after dedup)

        if (Array.isArray(parsed.entities)) {
          for (const entity of parsed.entities) {
            if (!entity || !entity.name || !entity.type) continue;
            const newId = this.addEntity(entity.name, entity.type, { created: entity.created });
            if (entity.id && newId && entity.id !== newId) {
              idRemap.set(entity.id, newId);
            }
          }
        }

        if (Array.isArray(parsed.triples)) {
          this._triples = parsed.triples
            .filter(t => t && t.subject && t.predicate && t.object)
            .map(t => ({
              ...t,
              subject: idRemap.get(t.subject) || t.subject,
              object: idRemap.get(t.object) || t.object
            }));
        }

        // If dedup collapsed entities, mark dirty so next flush writes clean data
        if (idRemap.size > 0) {
          this._dirty = true;
          this.logger.info(
            `[KnowledgeGraph] Load dedup: collapsed ${idRemap.size} duplicate(s)`
          );
        }
      }
    } catch (err) {
      // 404 on first run, parse error — start with empty graph
      this._entities = new Map();
      this._triples = [];
    }

    this._loaded = true;
    this.logger.info(
      `[KnowledgeGraph] Loaded — ${this._entities.size} entities, ${this._triples.length} triples`
    );
  }

  /**
   * Flush the in-memory graph to the wiki page as a JSON code block.
   * No-op if graph is not dirty.
   *
   * @returns {Promise<void>}
   */
  async flush() {
    if (!this._dirty) return;

    if (this._entities.size === 0 && this._triples.length === 0) {
      // Nothing meaningful to flush — don't write an empty index
      this._dirty = false;
      return;
    }

    const data = {
      entities: Array.from(this._entities.values()),
      triples: this._triples,
      lastFlushed: new Date().toISOString()
    };

    const jsonContent = JSON.stringify(data, null, 2);

    try {
      if (this.filesClient) {
        // NCFilesClient path: ensure directory exists, write plain JSON
        try { await this.filesClient.mkdir(FILE_DIR); } catch (_mkdirErr) { /* already exists */ }
        await this.filesClient.writeFile(FILE_PATH, jsonContent);
      } else {
        // Legacy CollectivesClient path: wrap in markdown code fence
        const content = `# Knowledge Graph Index\n\n\`\`\`json\n${jsonContent}\n\`\`\`\n`;
        await this.wiki.writePageContent('Memory/_index', content);
      }
      this._dirty = false;
      this.logger.info(
        `[KnowledgeGraph] Flushed — ${this._entities.size} entities, ${this._triples.length} triples`
      );
    } catch (err) {
      this.logger.error(
        `[KnowledgeGraph] Flush FAILED: ${err.message} ` +
        `(${this._entities.size} entities, ${this._triples.length} triples at risk)`
      );
      throw err; // propagate so heartbeat/shutdown can log it
    }
  }

  // ===========================================================================
  // Mutation API
  // ===========================================================================

  /**
   * Add a named entity of a given type to the graph.
   * Deduplicates by normalized name across types — keeps the most specific type.
   * Type priority: domain types (project, procedure, decision, tool, research,
   * organization) > person > generic (page, concept, note).
   *
   * @param {string} name - Human-readable entity name
   * @param {string} type - Entity type (e.g. 'person', 'project', 'team')
   * @param {Object} [options]
   * @param {string} [options.created] - ISO timestamp; defaults to now
   * @returns {string|null} The entity id, or null if inputs are invalid
   */
  addEntity(name, type, options = {}) {
    if (!name || !type) return null;

    const id = this._makeId(name, type);

    // Exact match: same name + same type → return existing
    if (this._entities.has(id)) return id;

    // Cross-type dedup: same name, different type → keep more specific
    const normalizedName = name.toLowerCase().trim();
    for (const [existingId, existing] of this._entities) {
      if (existing.name.toLowerCase().trim() === normalizedName) {
        const newPri = TYPE_PRIORITY[type] || 0;
        const existingPri = TYPE_PRIORITY[existing.type] || 0;

        if (newPri > existingPri) {
          // New type is more specific — re-type existing entity under new id
          this._entities.delete(existingId);
          const newId = this._makeId(name, type);
          const updated = { ...existing, id: newId, type };
          this._entities.set(newId, updated);
          // Update triples that referenced the old id
          this._rewriteTripleIds(existingId, newId);
          this._dirty = true;
          return newId;
        }
        // Existing type is equal or more specific — keep it
        return existingId;
      }
    }

    this._entities.set(id, {
      id,
      name,
      type,
      created: options.created || new Date().toISOString()
    });

    this._dirty = true;
    return id;
  }

  /**
   * Add a subject–predicate–object triple to the graph.
   * If an identical triple already exists, refreshes its verified timestamp.
   * Silently ignores invalid predicates or missing arguments.
   *
   * @param {string} subjectId - Entity id of the subject
   * @param {string} predicate - Relationship type (must be in VALID_PREDICATES)
   * @param {string} objectId - Entity id of the object
   * @returns {void}
   */
  addTriple(subjectId, predicate, objectId) {
    if (!subjectId || !predicate || !objectId) return;
    if (!VALID_PREDICATES.has(predicate)) return; // silently ignore invalid predicates

    const existing = this._triples.find(
      t => t.subject === subjectId && t.predicate === predicate && t.object === objectId
    );

    if (existing) {
      // Refresh verification timestamp on re-assertion
      existing.verified = new Date().toISOString();
    } else {
      this._triples.push({
        subject: subjectId,
        predicate,
        object: objectId,
        verified: new Date().toISOString()
      });
    }

    this._dirty = true;
  }

  // ===========================================================================
  // Query API
  // ===========================================================================

  /**
   * Look up an entity by its id or by name (case-insensitive).
   *
   * @param {string} idOrName - Entity id or display name
   * @returns {{ id: string, name: string, type: string, created: string }|null}
   */
  getEntity(idOrName) {
    if (!idOrName || typeof idOrName !== 'string') return null;

    // Fast path: direct id lookup
    if (this._entities.has(idOrName)) return this._entities.get(idOrName);

    // Fallback: case-insensitive name search
    const lower = idOrName.toLowerCase();
    for (const entity of this._entities.values()) {
      if (entity.name.toLowerCase() === lower) return entity;
    }

    return null;
  }

  /**
   * BFS neighbourhood traversal starting from entityId.
   * Returns all reachable entities within maxHops, sorted by distance ascending.
   *
   * @param {string} entityId - Starting entity id
   * @param {number} [maxHops=2] - Maximum edge distance to traverse
   * @param {Object} [options]
   * @param {string} [options.predicate] - If set, only follow edges with this predicate
   * @returns {Array<{ entity: Object, predicate: string, distance: number }>}
   */
  relatedTo(entityId, maxHops = 2, options = {}) {
    if (!entityId) return [];

    const predicateFilter = options.predicate || null;
    const visited = new Set([entityId]);
    const queue = [{ id: entityId, distance: 0 }];
    const results = [];

    while (queue.length > 0) {
      const current = queue.shift();

      // Do not process nodes that are already at or beyond maxHops
      if (current.distance > maxHops) continue;

      for (const triple of this._triples) {
        // Determine if current node appears as subject or object in this triple
        let neighbor = null;
        if (triple.subject === current.id) {
          neighbor = triple.object;
        } else if (triple.object === current.id) {
          neighbor = triple.subject;
        } else {
          continue;
        }

        // Apply optional predicate filter
        if (predicateFilter && triple.predicate !== predicateFilter) continue;

        // Skip already-visited nodes
        if (visited.has(neighbor)) continue;
        visited.add(neighbor);

        const entity = this._entities.get(neighbor);
        if (!entity) continue; // skip orphaned references

        const newDist = current.distance + 1;
        results.push({ entity, predicate: triple.predicate, distance: newDist });

        // Only enqueue for further traversal if we haven't reached maxHops yet
        if (newDist < maxHops) {
          queue.push({ id: neighbor, distance: newDist });
        }
      }
    }

    // Sort by distance ascending
    results.sort((a, b) => a.distance - b.distance);
    return results;
  }

  /**
   * BFS shortest-path search between two entity ids.
   * Returns an ordered array of { entity, predicate } steps from fromId to toId,
   * or null if no path exists within MAX_HOPS.
   *
   * @param {string} fromId - Starting entity id
   * @param {string} toId - Target entity id
   * @returns {Array<{ entity: Object, predicate: string }>|null}
   */
  findPath(fromId, toId) {
    if (!fromId || !toId) return null;
    if (fromId === toId) return [];

    const visited = new Set([fromId]);
    const queue = [fromId];
    // parent map: child id → { from: parentId, predicate }
    const parent = new Map();

    while (queue.length > 0) {
      const current = queue.shift();

      for (const triple of this._triples) {
        let neighbor = null;
        if (triple.subject === current) {
          neighbor = triple.object;
        } else if (triple.object === current) {
          neighbor = triple.subject;
        } else {
          continue;
        }

        if (visited.has(neighbor)) continue;
        visited.add(neighbor);
        parent.set(neighbor, { from: current, predicate: triple.predicate });

        if (neighbor === toId) {
          // Reconstruct path by walking parent map backwards from toId to fromId
          const path = [];
          let step = toId;

          while (step !== fromId) {
            const info = parent.get(step);
            const entity = this._entities.get(step);
            path.push({ entity, predicate: info.predicate });
            step = info.from;
          }

          // Reverse so the path runs fromId → toId
          path.reverse();
          return path;
        }

        // Safety valve: stop if the visited set grows too large
        if (visited.size > MAX_HOPS * 10) return null;

        queue.push(neighbor);
      }
    }

    return null; // no path found
  }

  // ===========================================================================
  // Helpers
  // ===========================================================================

  /**
   * Build a stable, URL-safe id string from a name and type.
   * e.g. ("Alice Smith", "person") → "person_alice_smith"
   *
   * @param {string} name
   * @param {string} type
   * @returns {string}
   * @private
   */
  _makeId(name, type) {
    return `${type}_${name.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '')}`;
  }

  /**
   * Rewrite all triples that reference oldId to use newId.
   * Called when an entity is re-typed and its id changes.
   * @param {string} oldId
   * @param {string} newId
   * @private
   */
  _rewriteTripleIds(oldId, newId) {
    for (const triple of this._triples) {
      if (triple.subject === oldId) triple.subject = newId;
      if (triple.object === oldId) triple.object = newId;
    }
  }
}

module.exports = KnowledgeGraph;
