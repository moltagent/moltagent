/**
 * Moltagent - Commitment Detector
 *
 * Copyright (C) 2026 Moltagent Contributors
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU Affero General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU Affero General Public License for more details.
 *
 * You should have received a copy of the GNU Affero General Public License
 * along with this program.  If not, see <https://www.gnu.org/licenses/>.
 *
 * Architecture Brief:
 * -------------------
 * Problem: During a conversation the agent makes verbal commitments (promises,
 * research pledges, follow-up offers) that need to be surfaced so the user or
 * the agent itself can track and honour them. Regex-based detection is
 * English-only, brittle against paraphrase, and requires constant maintenance
 * as new commitment phrasings emerge.
 *
 * Pattern: Single LLM call over the condensed conversation tail. The LLM
 * already understands intent, language, and nuance — so it is the right tool
 * for classifying commitments. The detector condenses the last 20 messages
 * (each capped at 300 chars), sends one synthesis-job prompt, and parses the
 * JSON response. No language-specific rules. Works in German, Portuguese, or
 * any other language the LLM understands.
 *
 * Key Dependencies:
 *   - llmRouter  (route({ content, job, responseFormat }))
 *   - logger     (warn)
 *
 * Data Flow:
 *   messages ([{role, content}])
 *     → guard (null / empty / < 2 messages → [])
 *     → condense last 20 messages, each truncated to 300 chars
 *     → single LLM call (job: SYNTHESIS)
 *     → parse JSON array from response
 *     → validate + cap at MAX_COMMITMENTS
 *     → return [{title, type, context}]
 *
 * Dependency Map:
 *   commitment-detector.js depends on: llm/router (JOBS constant)
 *   Used by: session-persister
 *
 * @module integrations/commitment-detector
 * @version 2.0.0
 */

'use strict';

const { JOBS } = require('../llm/router');

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MAX_MESSAGES = 20;      // Tail of conversation fed to the LLM
const MAX_MSG_CHARS = 300;    // Per-message character cap for condensation
const MAX_COMMITMENTS = 5;    // Hard cap on returned commitments

// Valid commitment types the LLM is allowed to return
const VALID_TYPES = new Set(['follow-up', 'research', 'action']);

// ---------------------------------------------------------------------------
// Class
// ---------------------------------------------------------------------------

/**
 * LLM-based commitment detector.
 *
 * Replaces the regex-based detectCommitments() function with a single
 * LLM call that understands intent across all languages and phrasings.
 */
class CommitmentDetector {
  /**
   * @param {Object} options
   * @param {Object} options.llmRouter - LLM router with a route() method
   * @param {Object} [options.logger]  - Logger with a warn() method (defaults to console)
   */
  constructor({ llmRouter, logger }) {
    if (!llmRouter) {
      throw new Error('CommitmentDetector requires llmRouter');
    }
    this.llm = llmRouter;
    this.logger = logger || console;
  }

  /**
   * Detect unfulfilled commitments the agent made to the user.
   *
   * @param {Array<{role: string, content: string}>} messages - Conversation messages
   * @returns {Promise<Array<{title: string, type: string, context: string}>>}
   */
  async detect(messages) {
    // Guard: null / empty / too-short input
    if (!Array.isArray(messages) || messages.length < 2) {
      return [];
    }

    // Condense: take last MAX_MESSAGES messages, truncate each to MAX_MSG_CHARS
    const tail = messages.slice(-MAX_MESSAGES);
    const condensed = tail
      .map(m => {
        const role = m.role === 'assistant' ? 'Agent' : 'User';
        const content = (typeof m.content === 'string' ? m.content : String(m.content || ''))
          .replace(/\r?\n/g, ' ')
          .trim()
          .substring(0, MAX_MSG_CHARS);
        return `${role}: ${content}`;
      })
      .join('\n');

    const prompt = [
      'You are analyzing a conversation between a user and an AI agent.',
      'Identify commitments the AGENT made TO THE USER that were not completed within this conversation.',
      '',
      'A commitment is a specific promise or obligation the agent took on, such as:',
      '- Agreeing to follow up on something later',
      '- Promising to research or look into a topic',
      '- Offering to create, send, draft, or schedule something',
      '',
      'Do NOT include:',
      '- Narration of current actions ("let me check", "I am searching")',
      '- Explanations of agent capabilities',
      '- Actions that were completed within this conversation',
      '- Hypothetical statements ("if you want, I could...")',
      '- Conditional offers that the user did not accept',
      '',
      'For each unfulfilled commitment, return a JSON object with:',
      '  "title": a short action phrase (5-8 words) describing the commitment',
      '  "type": one of "follow-up", "research", or "action"',
      '  "context": a brief phrase (max 100 chars) summarising what triggered the commitment',
      '',
      `Return a JSON array. Return at most ${MAX_COMMITMENTS} items. If there are no commitments, return [].`,
      'Return ONLY the JSON array — no explanation, no markdown fences.',
      '',
      'Conversation:',
      condensed,
    ].join('\n');

    let result;
    try {
      result = await this.llm.route({
        content: prompt,
        job: JOBS.SYNTHESIS,
        responseFormat: 'json',
      });
    } catch (err) {
      this.logger.warn('[CommitmentDetector] LLM call failed:', err.message);
      return [];
    }

    // Extract text from router response — router returns { result: '...' }
    const text = (result?.result || result?.content || '').trim();

    if (!text) {
      this.logger.warn('[CommitmentDetector] LLM returned empty response');
      return [];
    }

    // Parse JSON — strip markdown fences if the model included them
    let parsed;
    try {
      const jsonText = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();
      parsed = JSON.parse(jsonText);
    } catch (err) {
      this.logger.warn('[CommitmentDetector] Failed to parse LLM JSON:', err.message, '| raw:', text.substring(0, 200));
      return [];
    }

    if (!Array.isArray(parsed)) {
      this.logger.warn('[CommitmentDetector] LLM response was not a JSON array');
      return [];
    }

    // Validate each entry and cap at MAX_COMMITMENTS
    const commitments = [];
    for (const item of parsed) {
      if (commitments.length >= MAX_COMMITMENTS) break;

      if (!item || typeof item !== 'object') continue;

      const title = typeof item.title === 'string' ? item.title.trim() : '';
      if (!title) continue;

      // Normalise type: default to 'action' if the LLM returned something unexpected
      const type = VALID_TYPES.has(item.type) ? item.type : 'action';

      const context = typeof item.context === 'string'
        ? item.context.trim().substring(0, 100)
        : '';

      commitments.push({ title, type, context });
    }

    return commitments;
  }
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

module.exports = { CommitmentDetector };
