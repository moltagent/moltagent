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
 * Problem: Wiki pages go stale over time. Without periodic review,
 * knowledge drifts from reality silently.
 *
 * Pattern: Scan wiki pages for staleness by comparing last_verified +
 * decay_days against today. Creates cards in the KnowledgeBoard 'stale'
 * stack for expired pages. Rate-limited via maxPagesPerScan cap.
 *
 * Key Dependencies:
 *   - CollectivesClient: listPages(), readPageWithFrontmatter()
 *   - KnowledgeBoard: createVerificationCard(), getCardsInStack()
 *
 * Data Flow:
 *   checkAll() -> listPages() -> filter candidates -> readPageWithFrontmatter()
 *              -> _isStale() -> createVerificationCard() for stale pages
 *
 * Dependency Map:
 *   freshness-checker.js depends on: CollectivesClient, KnowledgeBoard (injected)
 *   Used by: heartbeat-manager.js
 */

class FreshnessChecker {
  /**
   * @param {Object} options
   * @param {Object} options.collectivesClient - CollectivesClient instance
   * @param {Object} options.knowledgeBoard - KnowledgeBoard instance
   * @param {Object} [options.config={}]
   * @param {number} [options.config.maxPagesPerScan=20] - Cap on pages to read per scan
   * @param {number} [options.config.defaultDecayDays=90] - Fallback decay_days when frontmatter omits it
   */
  constructor({ collectivesClient, knowledgeBoard, config = {} }) {
    this.collectivesClient = collectivesClient;
    this.knowledgeBoard = knowledgeBoard;
    this.config = {
      maxPagesPerScan: config.maxPagesPerScan || 20,
      defaultDecayDays: config.defaultDecayDays || 90
    };
  }

  /**
   * Full scan: list all pages, check each for staleness, create cards for stale ones.
   * @returns {Promise<{scanned: number, stale: number, cards: Array}>}
   */
  async checkAll() {
    if (!this.collectivesClient) {
      return { scanned: 0, stale: 0, cards: [] };
    }

    const collectiveId = await this.collectivesClient.resolveCollective();
    const pages = await this.collectivesClient.listPages(collectiveId);

    if (!Array.isArray(pages) || pages.length === 0) {
      return { scanned: 0, stale: 0, cards: [] };
    }

    // Filter to non-root pages (skip section headers like "People", "Projects")
    const candidates = pages.filter(p => p.parentId && p.parentId > 0);

    // Cap to maxPagesPerScan
    const toScan = candidates.slice(0, this.config.maxPagesPerScan);

    let staleCount = 0;
    const cards = [];

    for (const page of toScan) {
      try {
        const result = await this.collectivesClient.readPageWithFrontmatter(page.title);
        if (!result) continue;

        const frontmatter = result.frontmatter || {};
        const staleInfo = this._isStale(frontmatter);

        if (staleInfo.stale) {
          const card = await this._createStaleCard(page.title, frontmatter, staleInfo);
          if (card) {
            cards.push(card);
          }
          staleCount++;
        }
      } catch (err) {
        console.error(`[FreshnessChecker] Error checking "${page.title}":`, err.message);
      }
    }

    return { scanned: toScan.length, stale: staleCount, cards };
  }

  /**
   * Check whether a page's frontmatter indicates staleness.
   * @param {Object} frontmatter
   * @returns {{stale: boolean, daysSinceVerified: number, decayDays: number}}
   */
  _isStale(frontmatter) {
    const decayDays = frontmatter.decay_days || this.config.defaultDecayDays;

    if (!frontmatter.last_verified) {
      return { stale: true, daysSinceVerified: Infinity, decayDays };
    }

    const lastVerified = new Date(frontmatter.last_verified);
    if (isNaN(lastVerified.getTime())) {
      return { stale: true, daysSinceVerified: Infinity, decayDays };
    }

    const now = new Date();
    const diffMs = now.getTime() - lastVerified.getTime();
    const daysSinceVerified = Math.floor(diffMs / (1000 * 60 * 60 * 24));

    return {
      stale: daysSinceVerified >= decayDays,
      daysSinceVerified,
      decayDays
    };
  }

  /**
   * Build a description for a stale KnowledgeBoard card.
   * @param {string} title
   * @param {Object} frontmatter
   * @param {Object} staleInfo
   * @returns {string}
   */
  _buildStaleDescription(title, frontmatter, staleInfo) {
    const lines = [`## Stale Page: ${title}\n`];

    if (staleInfo.daysSinceVerified === Infinity) {
      lines.push('**Last verified:** Never (no last_verified in frontmatter)');
    } else {
      lines.push(`**Last verified:** ${frontmatter.last_verified}`);
      lines.push(`**Days since verification:** ${staleInfo.daysSinceVerified}`);
      lines.push(`**Decay threshold:** ${staleInfo.decayDays} days`);
      lines.push(`**Overdue by:** ${staleInfo.daysSinceVerified - staleInfo.decayDays} days`);
    }

    if (frontmatter.type) {
      lines.push(`**Page type:** ${frontmatter.type}`);
    }

    lines.push('');
    lines.push('**Suggested action:** Read and re-verify this page, then update `last_verified` in frontmatter.');

    return lines.join('\n');
  }

  /**
   * Create a stale card in the KnowledgeBoard, avoiding duplicates.
   * @param {string} title
   * @param {Object} frontmatter
   * @param {Object} staleInfo
   * @returns {Promise<Object|null>}
   */
  async _createStaleCard(title, frontmatter, staleInfo) {
    if (!this.knowledgeBoard) return null;

    // Check for existing stale card with same title prefix
    try {
      const existingCards = await this.knowledgeBoard.deck.getCardsInStack('stale');
      const cardTitle = `Stale: ${title}`;
      const duplicate = (existingCards || []).find(c => c.title === cardTitle);
      if (duplicate) {
        return null; // Skip duplicate
      }
    } catch {
      // If we cannot check, proceed with creation
    }

    const description = this._buildStaleDescription(title, frontmatter, staleInfo);

    try {
      const card = await this.knowledgeBoard.deck.createCard('stale', {
        title: `Stale: ${title}`,
        description
      });
      return card;
    } catch (err) {
      console.error(`[FreshnessChecker] Failed to create stale card for "${title}":`, err.message);
      return null;
    }
  }
}

module.exports = { FreshnessChecker };
