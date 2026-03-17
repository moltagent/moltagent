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
 * DocumentClassifier -- Classify documents into one of 14 types before entity
 * extraction, then provide type-specific extraction prompts.
 *
 * Architecture Brief:
 * -------------------
 * Problem: A single generic extraction prompt performs poorly across wildly
 * different document types (invoices vs. meeting notes vs. source code).
 * Knowing the document type lets us ask the LLM sharper, narrower questions
 * and skip extraction entirely for types that yield no useful entities.
 *
 * Pattern: Two-tier classification. A fast extension-based pre-filter catches
 * obvious media/system/data files without an LLM call. Everything else gets
 * the first 2 000 chars sent to the LLM router for classification into one
 * of 14 canonical types. A companion method returns a type-specific extraction
 * prompt (or null for types that need no extraction).
 *
 * Key Dependencies:
 * - LLMRouter  -- route({ job, task, content, requirements }) for classification
 * - Logger     -- structured logging (defaults to console)
 *
 * Data Flow:
 * filename + text
 *   -> _preFilterByExtension(filename) -> type | null
 *   -> if null: LLM classification (first 2000 chars)
 *   -> { type, confidence }
 *   -> getExtractionPrompt(type, text, filename) -> prompt | null
 *
 * Dependency Map:
 * document-classifier.js
 *   <- document-ingestor.js (caller)
 *   -> llm-router.js (classification calls)
 *   -> entity-extractor.js (consumer of extraction prompts)
 *
 * @module extraction/document-classifier
 * @version 1.0.0
 */

const path = require('path');

// ============================================================================
// Constants
// ============================================================================

/** Maximum characters sent to the LLM for classification. */
const CLASSIFY_HEAD = 2000;

/** Canonical document types. */
const TYPES = {
  TRANSACTIONAL:  'TRANSACTIONAL',
  AGREEMENT:      'AGREEMENT',
  CORRESPONDENCE: 'CORRESPONDENCE',
  MEETING_RECORD: 'MEETING_RECORD',
  PLANNING:       'PLANNING',
  REFERENCE:      'REFERENCE',
  CREATIVE:       'CREATIVE',
  PEOPLE_HR:      'PEOPLE_HR',
  TECHNICAL:      'TECHNICAL',
  VISUAL:         'VISUAL',
  DATA:           'DATA',
  MEDIA:          'MEDIA',
  TEMPLATE:       'TEMPLATE',
  SYSTEM:         'SYSTEM',
};

/** Set of all valid type strings for quick membership checks. */
const VALID_TYPES = new Set(Object.values(TYPES));

/** Extension sets for the pre-filter. Lowercase, with leading dot. */
const MEDIA_EXTS = new Set([
  '.mp4', '.mov', '.avi', '.webm', '.mkv',
  '.mp3', '.wav', '.m4a', '.ogg', '.flac', '.aac', '.wma',
]);

const SYSTEM_EXTS = new Set([
  '.env', '.pem', '.key', '.crt', '.lock',
  '.gitignore', '.dockerignore', '.eslintrc',
]);

const DATA_EXTS = new Set([
  '.csv', '.tsv', '.json', '.jsonl', '.xml', '.sql',
]);

// ============================================================================
// Class
// ============================================================================

class DocumentClassifier {
  /**
   * @param {Object} deps
   * @param {Object} deps.llmRouter - LLMRouter instance with route()
   * @param {Object} [deps.logger]  - Logger (defaults to console)
   */
  constructor({ llmRouter, logger } = {}) {
    if (!llmRouter) throw new Error('DocumentClassifier requires llmRouter');
    this.router = llmRouter;
    this.logger = logger || console;
    this._stats = { preFiltered: 0, llmClassified: 0, fallbacks: 0 };
  }

  // ==========================================================================
  // Public API
  // ==========================================================================

  /**
   * Classify a document into one of 14 canonical types.
   *
   * Fast path: extension pre-filter catches MEDIA, SYSTEM, and DATA files
   * without touching the LLM. Everything else goes through a short LLM call.
   *
   * @param {string} text     - Extracted document text
   * @param {string} filename - Original filename (e.g. "invoice-2026.pdf")
   * @param {string} [fileType] - MIME type hint (currently unused, reserved)
   * @returns {Promise<{ type: string, confidence: number }>}
   */
  async classify(text, filename, fileType) {
    const safeName = filename || 'unknown';

    // --- Fast path: extension pre-filter ---
    const preType = this._preFilterByExtension(safeName);
    if (preType) {
      this._stats.preFiltered++;
      this.logger.info?.(`[DocumentClassifier] pre-filter: ${safeName} -> ${preType}`);
      return { type: preType, confidence: 1.0 };
    }

    // --- Slow path: LLM classification ---
    const safeText = (text || '').slice(0, CLASSIFY_HEAD);
    if (safeText.length < 20) {
      // Too little text to classify meaningfully
      this._stats.fallbacks++;
      return { type: TYPES.REFERENCE, confidence: 0.3 };
    }

    const prompt = `Classify this document into exactly ONE of these types:
TRANSACTIONAL, AGREEMENT, CORRESPONDENCE, MEETING_RECORD, PLANNING, REFERENCE, CREATIVE, PEOPLE_HR, TECHNICAL, VISUAL, DATA, MEDIA, TEMPLATE, SYSTEM

Filename: ${safeName}

Content (first ${safeText.length} chars):
${safeText}

Respond ONLY with JSON: {"type":"<TYPE>","confidence":<0.0-1.0>}`;

    try {
      const rawResponse = await this.router.route({
        job: 'classification',
        task: 'document_classification',
        content: prompt,
        requirements: { maxTokens: 50, temperature: 0.0 },
      });

      const raw = rawResponse?.result || rawResponse?.content || '';
      const parsed = this._parseClassification(raw);
      this._stats.llmClassified++;
      this.logger.info?.(`[DocumentClassifier] LLM: ${safeName} -> ${parsed.type} (${parsed.confidence})`);
      return parsed;
    } catch (err) {
      this.logger.warn?.(`[DocumentClassifier] LLM classification failed for ${safeName}: ${err.message}`);
      this._stats.fallbacks++;
      return { type: TYPES.REFERENCE, confidence: 0.5 };
    }
  }

  /**
   * Return a type-specific extraction prompt, or null if the type requires
   * no entity extraction (TEMPLATE, SYSTEM, MEDIA, VISUAL, REFERENCE).
   *
   * @param {string} type     - One of the 14 canonical types
   * @param {string} text     - Document text (caller should pre-truncate)
   * @param {string} filename - Original filename
   * @returns {string|null}
   */
  getExtractionPrompt(type, text, filename) {
    const safeName = filename || 'unknown';
    const safeText = text || '';

    switch (type) {
      case TYPES.TECHNICAL:
        return this._promptTechnical(safeText, safeName);
      case TYPES.MEETING_RECORD:
        return this._promptMeetingRecord(safeText, safeName);
      case TYPES.PEOPLE_HR:
        return this._promptPeopleHR(safeText, safeName);
      case TYPES.AGREEMENT:
        return this._promptAgreement(safeText, safeName);
      case TYPES.TRANSACTIONAL:
        return this._promptTransactional(safeText, safeName);
      case TYPES.CORRESPONDENCE:
        return this._promptCorrespondence(safeText, safeName);
      case TYPES.PLANNING:
        return this._promptPlanning(safeText, safeName);
      case TYPES.CREATIVE:
        return this._promptCreative(safeText, safeName);
      case TYPES.DATA:
        return this._promptData(safeText, safeName);

      // Types that need no entity extraction
      case TYPES.TEMPLATE:
      case TYPES.SYSTEM:
      case TYPES.MEDIA:
      case TYPES.VISUAL:
      case TYPES.REFERENCE:
        return null;

      default:
        return null;
    }
  }

  /** Return accumulated statistics. */
  getStats() {
    return { ...this._stats };
  }

  // ==========================================================================
  // Pre-filter
  // ==========================================================================

  /**
   * Catch obvious types by file extension without an LLM call.
   *
   * @param {string} filename
   * @returns {string|null} A TYPES constant, or null if LLM classification needed
   */
  _preFilterByExtension(filename) {
    if (!filename || typeof filename !== 'string') return null;

    const ext = path.extname(filename).toLowerCase();
    const base = path.basename(filename).toLowerCase();
    // Dotfiles like ".env" and ".gitignore" have empty extname;
    // use the full basename (already starts with a dot) as the effective ext
    const effectiveExt = ext || (base.startsWith('.') ? base : null);
    if (!effectiveExt) return null;

    if (MEDIA_EXTS.has(effectiveExt))  return TYPES.MEDIA;
    if (SYSTEM_EXTS.has(effectiveExt)) return TYPES.SYSTEM;
    if (DATA_EXTS.has(effectiveExt))   return TYPES.DATA;

    return null;
  }

  // ==========================================================================
  // Response parsing
  // ==========================================================================

  /**
   * Parse the LLM classification response into { type, confidence }.
   * Tolerates markdown fences and partial JSON. Falls back to REFERENCE / 0.5.
   *
   * @param {string} raw
   * @returns {{ type: string, confidence: number }}
   */
  _parseClassification(raw) {
    const fallback = { type: TYPES.REFERENCE, confidence: 0.5 };
    if (!raw || typeof raw !== 'string') return fallback;

    // Strip markdown fences if present
    const cleaned = raw.replace(/```json?\s*/gi, '').replace(/```/g, '').trim();

    try {
      const obj = JSON.parse(cleaned);
      const type = (obj.type || '').toUpperCase().trim();
      const confidence = Number.isFinite(obj.confidence) ? Math.max(0, Math.min(1, obj.confidence)) : 0.5;

      if (VALID_TYPES.has(type)) {
        return { type, confidence };
      }
      this.logger.warn?.(`[DocumentClassifier] unknown type from LLM: "${obj.type}"`);
      return fallback;
    } catch {
      // Try to extract a type keyword from the raw text
      const upper = cleaned.toUpperCase();
      for (const t of VALID_TYPES) {
        if (upper.includes(t)) {
          return { type: t, confidence: 0.4 };
        }
      }
      return fallback;
    }
  }

  // ==========================================================================
  // Type-specific extraction prompts
  // ==========================================================================

  _promptTechnical(text, filename) {
    return `Extract entities from this TECHNICAL document.
Document: ${filename}

Content:
${text}

Focus on:
- Software components, libraries, frameworks, tools mentioned by name
- APIs, protocols, data formats referenced
- System requirements, version numbers, platform constraints
- Architecture patterns and design decisions
- Known issues, limitations, deprecation notices
- People who authored or are responsible for the system

Respond ONLY with JSON:
{
  "summary": "2-3 sentence summary of what this technical document covers",
  "entities": [
    {"name": "exact name from text", "type": "tool|concept|person|project|organization", "significance": "high|medium|low", "description": "what the source says about it, or null"}
  ],
  "relationships": [{"from": "...", "predicate": "depends_on|uses|built_with|related_to", "to": "..."}]
}

RULES:
- Every entity name MUST appear verbatim in the source text
- Prefer tool type for named software; concept for patterns/methodologies
- Only extract relationships that are explicitly stated
- If nothing worth extracting: {"summary":"","entities":[],"relationships":[]}`;
  }

  _promptMeetingRecord(text, filename) {
    return `Extract entities from this MEETING RECORD / minutes document.
Document: ${filename}

Content:
${text}

Focus on:
- People who attended or are mentioned (with roles if stated)
- Decisions made and who made them
- Action items and who owns them
- Projects, products, or initiatives discussed
- Organizations or teams referenced
- Dates and deadlines mentioned in context

Respond ONLY with JSON:
{
  "summary": "2-3 sentence summary of what was discussed and decided",
  "entities": [
    {"name": "exact name from text", "type": "person|project|organization|tool|concept", "significance": "high|medium|low", "description": "their role or what was said about them, or null"}
  ],
  "relationships": [{"from": "...", "predicate": "leads|works_on|reports_to|belongs_to|has_goal|has_status", "to": "..."}]
}

RULES:
- Every entity name MUST appear verbatim in the source text
- People mentioned by name are at least medium significance
- Action item owners are high significance
- Only extract relationships that are explicitly stated
- If nothing worth extracting: {"summary":"","entities":[],"relationships":[]}`;
  }

  _promptPeopleHR(text, filename) {
    return `Extract entities from this PEOPLE / HR document (CV, org chart, personnel record, team roster).
Document: ${filename}

Content:
${text}

Focus on:
- People with their full names, titles, roles, departments
- Organizations they work for or have worked for
- Skills, certifications, qualifications mentioned
- Reporting relationships and team structures
- Contact information context (do NOT extract email/phone values)
- Employment dates and tenure information

Respond ONLY with JSON:
{
  "summary": "2-3 sentence summary of who this document is about and their role",
  "entities": [
    {"name": "exact name from text", "type": "person|organization|concept|tool", "significance": "high|medium|low", "description": "role, title, or qualification, or null"}
  ],
  "relationships": [{"from": "...", "predicate": "works_at|reports_to|managed_by|employed_by|affiliated_with|uses", "to": "..."}]
}

RULES:
- Every entity name MUST appear verbatim in the source text
- All named people are high significance
- Organizations where people work are high significance
- Skills and certifications are medium significance concepts
- Only extract relationships that are explicitly stated
- If nothing worth extracting: {"summary":"","entities":[],"relationships":[]}`;
  }

  _promptAgreement(text, filename) {
    return `Extract entities from this AGREEMENT / CONTRACT document.
Document: ${filename}

Content:
${text}

Focus on:
- Parties to the agreement (people, organizations)
- What is being agreed upon (subject matter, deliverables)
- Key terms: dates, durations, amounts, penalties
- Governing law or jurisdiction if mentioned
- Signatories and their roles/titles
- Referenced documents, standards, or regulations

Respond ONLY with JSON:
{
  "summary": "2-3 sentence summary of the agreement: who, what, and key terms",
  "entities": [
    {"name": "exact name from text", "type": "person|organization|project|concept", "significance": "high|medium|low", "description": "their role in the agreement, or null"}
  ],
  "relationships": [{"from": "...", "predicate": "client_of|affiliated_with|works_on|belongs_to|related_to", "to": "..."}]
}

RULES:
- Every entity name MUST appear verbatim in the source text
- All parties to the agreement are high significance
- Only extract relationships that are explicitly stated
- If nothing worth extracting: {"summary":"","entities":[],"relationships":[]}`;
  }

  _promptTransactional(text, filename) {
    return `Extract entities from this TRANSACTIONAL document (invoice, receipt, purchase order, bank statement).
Document: ${filename}

Content:
${text}

Focus on:
- Sender and recipient organizations or people
- Products or services described
- Referenced project or account names
- Payment terms, currency, tax identifiers mentioned as context

Respond ONLY with JSON:
{
  "summary": "2-3 sentence summary: who invoiced whom, for what",
  "entities": [
    {"name": "exact name from text", "type": "person|organization|project|tool", "significance": "high|medium|low", "description": "role in the transaction, or null"}
  ],
  "relationships": [{"from": "...", "predicate": "client_of|affiliated_with|works_on|related_to", "to": "..."}]
}

RULES:
- Every entity name MUST appear verbatim in the source text
- Sender and recipient organizations are high significance
- Only extract relationships explicitly stated
- If nothing worth extracting: {"summary":"","entities":[],"relationships":[]}`;
  }

  _promptCorrespondence(text, filename) {
    return `Extract entities from this CORRESPONDENCE (email, letter, memo, chat log).
Document: ${filename}

Content:
${text}

Focus on:
- Sender and recipients (people, organizations)
- Topics or projects discussed
- Requests, commitments, or decisions made
- Third parties mentioned

Respond ONLY with JSON:
{
  "summary": "2-3 sentence summary: who wrote to whom about what",
  "entities": [
    {"name": "exact name from text", "type": "person|organization|project|concept", "significance": "high|medium|low", "description": "their role or what was said about them, or null"}
  ],
  "relationships": [{"from": "...", "predicate": "works_on|works_at|affiliated_with|related_to|client_of", "to": "..."}]
}

RULES:
- Every entity name MUST appear verbatim in the source text
- Sender and named recipients are high significance
- Only extract relationships explicitly stated
- If nothing worth extracting: {"summary":"","entities":[],"relationships":[]}`;
  }

  _promptPlanning(text, filename) {
    return `Extract entities from this PLANNING document (roadmap, strategy, project plan, sprint plan).
Document: ${filename}

Content:
${text}

Focus on:
- Projects, initiatives, or workstreams named
- People assigned to tasks or owning deliverables
- Teams and organizations involved
- Milestones, deadlines, and dependencies
- Tools or platforms to be used

Respond ONLY with JSON:
{
  "summary": "2-3 sentence summary of what is being planned and key milestones",
  "entities": [
    {"name": "exact name from text", "type": "project|person|organization|tool|concept", "significance": "high|medium|low", "description": "role in the plan, or null"}
  ],
  "relationships": [{"from": "...", "predicate": "works_on|leads|depends_on|has_goal|has_status|uses", "to": "..."}]
}

RULES:
- Every entity name MUST appear verbatim in the source text
- Named projects and their owners are high significance
- Only extract relationships explicitly stated
- If nothing worth extracting: {"summary":"","entities":[],"relationships":[]}`;
  }

  _promptCreative(text, filename) {
    return `Extract entities from this CREATIVE document (blog post, article, marketing copy, presentation script).
Document: ${filename}

Content:
${text}

Focus on:
- People, brands, or organizations mentioned
- Products or services featured
- Topics and themes covered
- Sources or references cited

Respond ONLY with JSON:
{
  "summary": "2-3 sentence summary of the creative content and its purpose",
  "entities": [
    {"name": "exact name from text", "type": "person|organization|project|tool|concept", "significance": "high|medium|low", "description": "how they appear in the content, or null"}
  ],
  "relationships": [{"from": "...", "predicate": "related_to|affiliated_with|uses|mentioned_in", "to": "..."}]
}

RULES:
- Every entity name MUST appear verbatim in the source text
- Only extract relationships explicitly stated
- If nothing worth extracting: {"summary":"","entities":[],"relationships":[]}`;
  }

  _promptData(text, filename) {
    return `Extract entities from this DATA file (CSV, JSON, XML, SQL, or tabular data).
Document: ${filename}

Content:
${text}

Focus on:
- Column headers or field names that reveal the data domain
- Named entities appearing in the data (organizations, people, products)
- The overall dataset purpose (what is this data about?)

Respond ONLY with JSON:
{
  "summary": "2-3 sentence summary of what data this file contains",
  "entities": [
    {"name": "exact name from text", "type": "person|organization|project|tool|concept", "significance": "high|medium|low", "description": "role in the dataset, or null"}
  ],
  "relationships": [{"from": "...", "predicate": "related_to|belongs_to", "to": "..."}]
}

RULES:
- Every entity name MUST appear verbatim in the source text
- Only extract entities that are proper nouns, not generic column headers
- Only extract relationships explicitly stated
- If nothing worth extracting: {"summary":"","entities":[],"relationships":[]}`;
  }
}

// ============================================================================
// Exports
// ============================================================================

module.exports = { DocumentClassifier, TYPES };
