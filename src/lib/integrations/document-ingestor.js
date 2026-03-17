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
 * DocumentIngestor — Bridge file events to text extraction, entity extraction,
 * and wiki page creation.
 *
 * Architecture Brief:
 * -------------------
 * Problem: Files uploaded or changed in Nextcloud contain knowledge that should
 * flow into the agent's knowledge graph and wiki. Without automation the agent
 * is blind to content in the file system.
 *
 * Pattern: Event-driven ingestor. ActivityPoller 'file_created'/'file_changed'
 * events trigger processFile(); 'share_created' events trigger a recursive
 * directory scan of the shared path. TextExtractor converts binary/office/image
 * buffers to text; EntityExtractor populates the knowledge graph in-place;
 * ResilientWikiWriter persists a document summary page per file. A Set tracks
 * already-processed paths so repeat polls are cheap. ingestDirectory() provides
 * a batch bootstrap path for existing content.
 *
 * Key Dependencies:
 * - NCFilesClient   — readFileBuffer() for binary downloads
 * - TextExtractor   — extract(buffer, filePath), isSupported(filePath) (static)
 * - EntityExtractor — extractEntitiesFromDocument(title, content) → void (LLM-only, no regex)
 * - ResilientWikiWriter — createPage(sectionPath, pageName, content)
 *
 * Data Flow:
 * ActivityPoller.emit('event') → onFileEvent()
 *   → processFile(filePath)
 *     → ncFilesClient.readFileBuffer()
 *     → TextExtractor.extract()
 *     → entityExtractor.extractEntitiesFromDocument()
 *     → wikiWriter.createPage()
 *
 * Dependency Map:
 * document-ingestor.js
 *   ← webhook-server.js (wiring)
 *   → nc-files-client.js
 *   → text-extractor.js
 *   → entity-extractor.js
 *   → resilient-wiki-writer.js
 *   → activity-poller.js (event source, wired externally)
 *
 * @module integrations/document-ingestor
 * @version 1.0.0
 */

const path = require('path');
const { TextExtractor } = require('../extraction/text-extractor');
const { DocumentClassifier } = require('../extraction/document-classifier');

/** Maximum characters fed to entity extraction (first 10 KB + last 2 KB). */
const EXTRACT_HEAD = 10 * 1024;
const EXTRACT_TAIL = 2 * 1024;
const EXTRACT_THRESHOLD = EXTRACT_HEAD + EXTRACT_TAIL; // 12 KB

/** Minimum extracted text length before processing continues. */
const MIN_TEXT_LENGTH = 100;

/**
 * Map file extensions to wiki section names.
 * @type {Object<string, string>}
 */
const EXT_TO_SECTION = {
  pdf: 'Documents',
  docx: 'Documents',
  xlsx: 'Documents',
  xls: 'Documents',
  txt: 'Documents',
  md: 'Documents',
  csv: 'Documents',
  json: 'Documents',
  yaml: 'Documents',
  yml: 'Documents',
  html: 'Documents',
  htm: 'Documents',
  xml: 'Documents',
  log: 'Documents',
  jpg: 'Images',
  jpeg: 'Images',
  png: 'Images',
  tiff: 'Images',
  tif: 'Images',
  bmp: 'Images',
  webp: 'Images',
};

/**
 * Protected page names that must NEVER be targets for entity page creation.
 * These are system pages maintained by other modules.
 * @type {Set<string>}
 */
const PROTECTED_PAGES = new Set([
  'learning log', 'pending questions', 'memory manifesto',
  'knowledge stats', 'decisions index', 'sessions index',
  'welcome email template',
]);

/**
 * Normalize an entity name for dedup comparison.
 * Lowercases, collapses whitespace, and strips trailing "(N)" suffixes
 * that Nextcloud Collectives appends on title collision.
 *
 * @param {string} name
 * @returns {string}
 */
function normalizeEntityName(name) {
  if (!name) return '';
  return name.toLowerCase().trim()
    .replace(/\s+/g, ' ')
    .replace(/\s*\(\d+\)$/, '');
}

class DocumentIngestor {
  /**
   * @param {Object} deps
   * @param {Object} deps.ncFilesClient      - NCFilesClient instance
   * @param {Object} deps.textExtractor      - TextExtractor instance
   * @param {Object} deps.entityExtractor    - EntityExtractor instance
   * @param {Object} deps.knowledgeGraph     - KnowledgeGraph instance (used indirectly via entityExtractor)
   * @param {Object} deps.wikiWriter         - ResilientWikiWriter instance
   * @param {Object} [deps.llmRouter]        - LLM router (used to auto-create DocumentClassifier)
   * @param {Object} [deps.classifier]       - DocumentClassifier instance (optional; auto-created if llmRouter given)
   * @param {Object} [deps.logger]           - Logger (defaults to console)
   */
  constructor({ ncFilesClient, textExtractor, entityExtractor, knowledgeGraph, wikiWriter, learningLog, llmRouter, classifier, logger } = {}) {
    if (!ncFilesClient)   throw new Error('DocumentIngestor requires ncFilesClient');
    if (!textExtractor)   throw new Error('DocumentIngestor requires textExtractor');
    if (!entityExtractor) throw new Error('DocumentIngestor requires entityExtractor');
    if (!wikiWriter)      throw new Error('DocumentIngestor requires wikiWriter');

    this.ncFilesClient  = ncFilesClient;
    this.textExtractor  = textExtractor;
    this.entityExtractor = entityExtractor;
    // knowledgeGraph stored for consumers who need direct graph access; not used
    // internally because EntityExtractor.extractFromPage() writes directly to the graph.
    this.knowledgeGraph = knowledgeGraph || null;
    this.wikiWriter     = wikiWriter;
    this.learningLog    = learningLog || null;
    this.logger         = logger || console;

    this.classifier = classifier || null;
    // Auto-create classifier if router available
    if (!this.classifier && llmRouter) {
      this.classifier = new DocumentClassifier({ llmRouter, logger: this.logger });
    }

    /** @type {Set<string>} Tracks successfully processed file paths. */
    this._processed = new Set();

    /** @type {Set<string>} Tracks entity pages already created (section/name lowercase). */
    this._createdEntityPages = new Set();

    /** @type {Promise} Serial queue — prevents concurrent wiki section creation races. */
    this._queue = Promise.resolve();
  }

  // ===========================================================================
  // Public API
  // ===========================================================================

  /**
   * Process a single file: download, extract text, run entity extraction,
   * and create a wiki summary page.
   *
   * @param {string} filePath - Nextcloud-relative file path
   * @returns {Promise<{filePath: string, skipped: boolean, reason?: string, textLength?: number, wikiResult?: Object}>}
   */
  async processFile(filePath) {
    if (!filePath) {
      return { filePath, skipped: true, reason: 'empty path' };
    }

    // Skip already-processed files (re-processing is triggered by clearing the set)
    if (this._processed.has(filePath)) {
      return { filePath, skipped: true, reason: 'already processed' };
    }

    // Unsupported file type check (fast path before download)
    if (!TextExtractor.isSupported(filePath)) {
      return { filePath, skipped: true, reason: 'unsupported file type' };
    }

    // Download file as buffer
    let buffer;
    try {
      buffer = await this.ncFilesClient.readFileBuffer(filePath);
    } catch (err) {
      this.logger.warn(`[DocumentIngestor] Download failed for ${filePath}: ${err.message}`);
      return { filePath, skipped: true, reason: `download failed: ${err.message}` };
    }

    // Extract text from buffer
    let extraction;
    try {
      extraction = await this.textExtractor.extract(buffer, filePath);
    } catch (err) {
      this.logger.warn(`[DocumentIngestor] Text extraction failed for ${filePath}: ${err.message}`);
      return { filePath, skipped: true, reason: `extraction failed: ${err.message}` };
    }

    const rawText = extraction.text || '';

    // Skip near-empty files
    if (rawText.length < MIN_TEXT_LENGTH) {
      return { filePath, skipped: true, reason: `text too short (${rawText.length} chars)` };
    }

    // Truncate for entity extraction
    const truncatedText = this._truncateForExtraction(rawText);

    // Derive a title from the filename (strip extension)
    const filename = path.basename(filePath);
    const filenameNoExt = filename.replace(/\.[^.]+$/, '');

    // 6b. CLASSIFY: Determine document type before extraction
    let classification = { type: 'REFERENCE', confidence: 0.5 };
    if (this.classifier) {
      try {
        classification = await this.classifier.classify(rawText, filename, path.extname(filePath));
        this.logger.info(`[DocumentIngestor] ${filename} → ${classification.type} (${classification.confidence})`);
      } catch (err) {
        this.logger.warn(`[DocumentIngestor] Classification failed for ${filename}: ${err.message}`);
      }
    }

    // 6c. SKIP non-content types
    if (classification.type === 'TEMPLATE' || classification.type === 'SYSTEM') {
      this.logger.info(`[DocumentIngestor] Skipped ${classification.type}: ${filename}`);
      this._processed.add(filePath);
      return { filePath, skipped: true, reason: classification.type.toLowerCase() };
    }

    // 6d. VISUAL reclassification — if OCR produced usable text, reclassify
    if (classification.type === 'VISUAL' && rawText.length > 100 && this.classifier) {
      try {
        const reclass = await this.classifier.classify(rawText, filename, 'ocr-text');
        if (reclass.type !== 'VISUAL') {
          this.logger.info(`[DocumentIngestor] VISUAL reclassified → ${reclass.type}`);
          classification = { ...reclass, originalType: 'VISUAL' };
        }
      } catch { /* keep original VISUAL classification */ }
      // Skip if reclassified to non-content type
      if (classification.type === 'TEMPLATE' || classification.type === 'SYSTEM') {
        this.logger.info(`[DocumentIngestor] Skipped ${classification.type} (reclassified from VISUAL): ${filename}`);
        this._processed.add(filePath);
        return { filePath, skipped: true, reason: classification.type.toLowerCase() };
      }
    }

    // Override fidelity if we know the text came from OCR
    if (extraction.ocr === true && classification.fidelity !== 'ocr') {
      classification.fidelity = 'ocr';
    }

    // Run LLM extraction — returns summary + typed entities, populates graph
    let extractionResult = { summary: '', entities: [] };
    try {
      // Use type-specific prompt if classifier provides one, passing fidelity
      // so the LLM can apply appropriate tolerance for OCR/transcribed sources.
      const typePrompt = this.classifier?.getExtractionPrompt(classification.type, truncatedText, filename, classification.fidelity || 'authored');
      if (typePrompt) {
        extractionResult = await this.entityExtractor.extractWithPrompt(typePrompt) || { summary: '', entities: [] };
      } else {
        extractionResult = await this.entityExtractor.extractEntitiesFromDocument(filenameNoExt, truncatedText) || { summary: '', entities: [] };
      }
    } catch (err) {
      this.logger.warn(`[DocumentIngestor] Entity extraction error for ${filePath}: ${err.message}`);
    }

    const { summary, entities } = extractionResult;

    // 1. ALL entities are already in the knowledge graph (done by extractEntitiesFromDocument)

    // 2. Create reference stub with summary (always)
    const sectionPath = this._sectionForFile(filePath);
    const pageName    = filenameNoExt;
    const stubContent = this._buildReferenceStub(filePath, extraction, summary, entities);

    let wikiResult;
    try {
      wikiResult = await this.wikiWriter.createPage(sectionPath, pageName, stubContent);
    } catch (err) {
      this.logger.warn(`[DocumentIngestor] Reference stub failed for ${filePath}: ${err.message}`);
      wikiResult = { success: false, error: err.message };
    }

    // 3. Create wiki pages for high-significance entities only

    // Pre-load section page titles for fuzzy dedup — one listPages call per
    // section rather than one per entity. Only load sections we will actually
    // need for this document's entities.
    const sectionTitlesCache = new Map(); // section -> string[]
    const _getSectionTitles = async (section) => {
      if (sectionTitlesCache.has(section)) return sectionTitlesCache.get(section);
      try {
        const result = await this.wikiWriter.listPages(section);
        const titles = (result?.pages || []).map(p => p.title).filter(Boolean);
        sectionTitlesCache.set(section, titles);
        return titles;
      } catch {
        sectionTitlesCache.set(section, []);
        return [];
      }
    };

    let entityPagesCreated = 0;
    for (const entity of entities) {
      if (!this._shouldCreateWikiPage(entity)) continue;

      try {
        const section = this._sectionForEntityType(entity.type);
        const dedupKey = `${section}/${normalizeEntityName(entity.name)}`;

        // Fast in-memory dedup (survives batch parallelism)
        if (this._createdEntityPages.has(dedupKey)) continue;

        // Remote dedup: check if page already exists on wiki (exact-match)
        const exists = await this._pageExists(section, entity.name);
        if (exists) {
          this._createdEntityPages.add(dedupKey);
          continue;
        }

        // Fuzzy dedup: ask the LLM whether this entity matches an existing page
        // by a different name (handles OCR errors, phonetic variants, abbreviations).
        // Only runs when a classifier with a router is available.
        const sectionTitles = await _getSectionTitles(section);
        const match = await this._findMatchingEntity(entity, sectionTitles, classification?.fidelity);
        if (match) {
          this.logger.info(`[DocumentIngestor] Entity dedup: "${entity.name}" matches existing "${match.title}" (${match.reason})`);
          this._createdEntityPages.add(dedupKey);
          continue; // Don't create duplicate page
        }

        const pageContent = this._buildEntityPage(entity, filePath);
        await this.wikiWriter.createPage(section, entity.name, pageContent);
        this._createdEntityPages.add(dedupKey);
        // Update local section cache so subsequent entities in this file can
        // match against the page we just created without another listPages call.
        sectionTitlesCache.set(section, [...(sectionTitlesCache.get(section) || []), entity.name]);
        entityPagesCreated++;
        this.logger.info(`[DocumentIngestor] Entity page: ${section}/${entity.name}`);
      } catch (err) {
        this.logger.warn(`[DocumentIngestor] Entity page failed for ${entity.name}: ${err.message}`);
      }
    }

    // Record ingestion in Learning Log
    if (this.learningLog && typeof this.learningLog.learned === 'function') {
      try {
        await this.learningLog.learned(
          `Ingested document "${path.basename(filePath)}": ${summary || 'no summary'} (${entities.length} entities, ${entityPagesCreated} pages created)`,
          `document-ingestor:${filePath}`
        );
      } catch (err) {
        this.logger.warn(`[DocumentIngestor] Learning log write failed: ${err.message}`);
      }
    }

    // Mark as processed only after successful pipeline run
    this._processed.add(filePath);

    this.logger.info(
      `[DocumentIngestor] Processed ${filePath} → ${classification.type} (${classification.confidence}), ${entities.length} entities, ` +
      `${entityPagesCreated} pages, reference stub in ${sectionPath}/${pageName}`
    );

    return {
      filePath,
      skipped: false,
      textLength: rawText.length,
      summary: summary || '',
      entitiesFound: entities.length,
      entityPagesCreated,
      wikiResult,
      classification: classification.type,
    };
  }

  /**
   * Batch-process all supported files in a directory (recursive).
   *
   * @param {string} directoryPath - Nextcloud-relative directory path
   * @param {Object} [options]
   * @param {number} [options.batchSize=10] - Files processed in parallel per batch
   * @param {Function} [options.onProgress] - Called after each batch: (processed, total) => void
   * @returns {Promise<{total: number, processed: number, errors: number, details: Array}>}
   */
  async ingestDirectory(directoryPath, options = {}) {
    const onProgress = typeof options.onProgress === 'function' ? options.onProgress : null;

    // Recursively discover all supported files
    const allFiles = await this._listFilesRecursive(directoryPath);

    if (allFiles.length === 0) {
      this.logger.info(`[DocumentIngestor] No supported files in ${directoryPath}`);
      return { total: 0, processed: 0, errors: 0, details: [] };
    }

    this.logger.info(`[DocumentIngestor] Found ${allFiles.length} supported files in ${directoryPath}`);

    const total   = allFiles.length;
    let processed = 0;
    let errors    = 0;
    const details = [];

    // Process files sequentially to prevent entity page creation races
    // (parallel batches cause duplicate wiki pages when multiple files
    // reference the same entity — all check _pageExists simultaneously,
    // all get false, all create → Nextcloud appends (2), (3), etc.)
    for (const file of allFiles) {
      try {
        const result = await this.processFile(file);
        details.push(result);
        if (result.error) {
          errors++;
        } else if (!result.skipped) {
          processed++;
        }
      } catch (err) {
        this.logger.warn(`[DocumentIngestor] Unexpected error for ${file}: ${err.message}`);
        details.push({ filePath: file, skipped: true, reason: err.message, error: true });
        errors++;
      }

      if (onProgress) {
        onProgress(processed, total);
      }
    }

    // Flush Learning Log entries that accumulated during the batch
    if (this.learningLog && typeof this.learningLog.flushWrites === 'function') {
      try {
        await this.learningLog.flushWrites();
      } catch (err) {
        this.logger.warn(`[DocumentIngestor] Learning log flush failed: ${err.message}`);
      }
    }

    this.logger.info(`[DocumentIngestor] Directory scan complete: ${processed}/${total} files processed, ${errors} errors`);
    return { total, processed, errors, details };
  }

  /**
   * Scan a list of directories on startup, ingesting any files not yet processed.
   * Runs in the background — returns immediately after queueing work.
   *
   * @param {string[]} directories - Array of Nextcloud-relative directory paths
   * @returns {Promise<void>}
   */
  async scanOnStartup(directories) {
    if (!Array.isArray(directories) || directories.length === 0) return;

    // Pre-populate entity page cache from existing wiki sections
    // so we never re-create pages that already exist
    for (const section of ['People', 'Agents', 'Organizations', 'Projects', 'Procedures', 'Research']) {
      try {
        const result = await this.wikiWriter.listPages(section);
        for (const page of (result?.pages || [])) {
          const title = normalizeEntityName(page.title);
          if (title && title !== 'readme') {
            this._createdEntityPages.add(`${section}/${title}`);
          }
        }
      } catch { /* section may not exist yet */ }
    }
    this.logger.info(`[DocumentIngestor] Pre-cached ${this._createdEntityPages.size} existing entity pages`);

    for (const dir of directories) {
      this.logger.info(`[DocumentIngestor] Startup scan: ${dir}`);
      this._enqueue(async () => {
        try {
          await this.ingestDirectory(dir);
        } catch (err) {
          this.logger.warn(`[DocumentIngestor] Startup scan failed for ${dir}: ${err.message}`);
        }
      });
    }
  }

  /**
   * Handler for ActivityPoller 'event' emissions.
   *
   * Handles three event families:
   * - file_created / file_changed (objectType: file) → processFile()
   * - share_created (objectType: share) → determine if file or folder, ingest accordingly
   *
   * @param {Object} event - NCFlowEvent from ActivityPoller
   * @param {string} event.type - Normalized event type
   * @param {string} event.objectType - Normalized object type
   * @param {string} event.objectName - File/folder path
   * @returns {Promise<Object|undefined>}
   */
  async onFileEvent(event) {
    if (!event) return;

    // ── Share events: someone shared a file or folder with Moltagent ──
    if (event.type === 'share_created' || event.type === 'file_shared') {
      // Share scans are large — enqueue but don't block the caller
      this._enqueue(() => this._handleShareEvent(event));
      return;
    }

    // ── Direct file events: file created or changed ──
    if (event.objectType !== 'files' && event.objectType !== 'file') {
      this.logger.debug?.(`[DocumentIngestor] Skipped event: objectType=${event.objectType} (not file)`);
      return;
    }
    if (event.type !== 'file_created' && event.type !== 'file_changed') return;

    const filePath = event.objectName;
    if (!filePath) return;
    if (!TextExtractor.isSupported(filePath)) {
      this.logger.debug?.(`[DocumentIngestor] Skipped unsupported: ${filePath}`);
      return;
    }

    // Re-ingest on change by clearing the processed flag
    if (event.type === 'file_changed') {
      this._processed.delete(filePath);
    }

    // Serialize file processing to prevent wiki section creation races
    return this._enqueue(() => this.processFile(filePath));
  }

  /**
   * Enqueue an async operation onto the serial queue.
   * Prevents concurrent wiki section creation from producing duplicates.
   *
   * @param {Function} fn - Async function to run
   * @returns {Promise}
   * @private
   */
  _enqueue(fn) {
    this._queue = this._queue.then(fn, fn);
    return this._queue;
  }

  /**
   * Handle a share event: probe whether the objectName is a file or directory,
   * then ingest accordingly. Shared folders get a recursive scan.
   *
   * Strategy: Try listDirectory() first. If it returns entries, it's a folder
   * and we scan it. If it throws (404 or non-directory), treat it as a file.
   *
   * @param {Object} event - NCFlowEvent with type share_created
   * @returns {Promise<Object|undefined>}
   * @private
   */
  async _handleShareEvent(event) {
    const sharePath = event.objectName;
    if (!sharePath) return;

    this.logger.info(`[DocumentIngestor] Share event: ${event.type} → ${sharePath}`);

    // Try as directory first (shared folders are the common case)
    try {
      const entries = await this.ncFilesClient.listDirectory(sharePath);
      if (entries && entries.length >= 0) {
        // It's a directory — scan recursively
        this.logger.info(`[DocumentIngestor] Shared folder detected: ${sharePath} — scanning`);
        return this.ingestDirectory(sharePath);
      }
    } catch {
      // Not a directory (or not accessible). Try as single file.
    }

    // Try as single file
    if (TextExtractor.isSupported(sharePath)) {
      this.logger.info(`[DocumentIngestor] Shared file detected: ${sharePath}`);
      return this.processFile(sharePath);
    }

    this.logger.info(`[DocumentIngestor] Share path not actionable: ${sharePath}`);
  }

  // ===========================================================================
  // Helper methods
  // ===========================================================================

  /**
   * Truncate text to first 10 KB + last 2 KB for entity extraction.
   * Returns full text if it fits within 12 KB.
   *
   * @param {string} text
   * @returns {string}
   */
  _truncateForExtraction(text) {
    if (!text || text.length <= EXTRACT_THRESHOLD) return text;
    const head = text.slice(0, EXTRACT_HEAD);
    const tail = text.slice(-EXTRACT_TAIL);
    return `${head}\n\n[... middle truncated ...]\n\n${tail}`;
  }

  /**
   * Recursively list all supported files under a directory.
   * Uses NCFilesClient.listDirectory() (PROPFIND Depth:1) and recurses
   * into subdirectories. Returns an array of full file paths.
   *
   * @param {string} dirPath - Nextcloud-relative directory path
   * @param {number} [depth=0] - Current recursion depth (max 10)
   * @returns {Promise<string[]>} Array of file paths
   * @private
   */
  async _listFilesRecursive(dirPath, depth = 0) {
    if (depth > 10) return []; // Safety: prevent infinite recursion

    let entries;
    try {
      entries = await this.ncFilesClient.listDirectory(dirPath);
    } catch (err) {
      this.logger.warn(`[DocumentIngestor] Cannot list ${dirPath}: ${err.message}`);
      return [];
    }

    const normalizedDir = dirPath.replace(/\/+$/, '');
    const files = [];

    for (const entry of (entries || [])) {
      const entryPath = normalizedDir ? `${normalizedDir}/${entry.name}` : entry.name;

      if (entry.type === 'directory') {
        // Recurse into subdirectory
        const subFiles = await this._listFilesRecursive(entryPath, depth + 1);
        files.push(...subFiles);
      } else if (TextExtractor.isSupported(entry.name)) {
        files.push(entryPath);
      }
    }

    return files;
  }

  /**
   * Return true if the file has a supported extension.
   * Delegates to TextExtractor.isSupported().
   *
   * @param {string} filename
   * @returns {boolean}
   */
  _isSupportedFile(filename) {
    return TextExtractor.isSupported(filename);
  }

  /**
   * Determine the wiki section path based on file extension.
   *
   * @param {string} filePath
   * @returns {string} Section name, e.g. 'Documents' or 'Images'
   */
  _sectionForFile(filePath) {
    const ext = (filePath || '').split('.').pop().toLowerCase();
    return EXT_TO_SECTION[ext] || 'Documents';
  }

  /**
   * Build a thin reference stub for the document — NOT a content dump.
   * The full content lives in Nextcloud Files. The wiki holds extracted knowledge.
   *
   * @param {string} filePath  - Original file path
   * @param {Object} extraction - Result from TextExtractor.extract()
   * @param {string} summary   - LLM-generated summary (2-3 sentences), may be empty
   * @param {Array}  entities  - Entity objects [{name, type, significance, description}]
   * @returns {string} Markdown page content
   */
  _buildReferenceStub(filePath, extraction, summary = '', entities = []) {
    const filename = path.basename(filePath);
    const ext      = filename.split('.').pop().toLowerCase();
    const now      = new Date().toISOString().split('T')[0];

    const safeFilename = filename.replace(/[\n\r"]/g, ' ').trim();
    const safeFilePath = filePath.replace(/[\n\r"]/g, ' ').trim();

    const lines = [
      '---',
      `title: "${safeFilename}"`,
      `source: "${safeFilePath}"`,
      `type: document-ref`,
      `fileType: "${ext}"`,
      `ingestedAt: "${now}"`,
      `totalChars: ${extraction.totalLength || (extraction.text || '').length}`,
    ];

    if (extraction.pages !== undefined) lines.push(`pages: ${extraction.pages}`);
    if (extraction.ocr) lines.push(`ocr: true`);

    lines.push('---', '');
    lines.push(`# ${filename}`, '');

    if (extraction.warning) {
      lines.push(`> **Warning:** ${extraction.warning}`, '');
    }

    // Metadata
    lines.push(`**Source:** \`${filePath}\``);
    lines.push(`**Size:** ${extraction.totalLength || (extraction.text || '').length} chars`);
    if (extraction.pages) lines.push(`**Pages:** ${extraction.pages}`);
    if (extraction.ocr) lines.push(`**Method:** OCR`);
    lines.push(`**Ingested:** ${now}`, '');

    // LLM summary
    if (summary) {
      lines.push('## Summary', '', summary, '');
    }

    // Entity references using rich entity objects
    if (entities.length > 0) {
      lines.push('## Entities Mentioned', '');
      for (const entity of entities) {
        const desc = entity.description ? ` — ${entity.description}` : '';
        lines.push(`- **${entity.name}** (${entity.type})${desc}`);
      }
      lines.push('');
    }

    return lines.join('\n');
  }

  /**
   * Build a structured entity wiki page with typed frontmatter and description.
   *
   * @param {Object} entity     - Entity object { name, type, description }
   * @param {string} sourcePath - File path this entity was extracted from
   * @returns {string} Markdown page content
   */
  _buildEntityPage(entity, sourcePath) {
    const now = new Date().toISOString().split('T')[0];
    const lines = [
      '---',
      `title: "${entity.name.replace(/[\n\r"]/g, ' ').trim()}"`,
      `type: ${entity.type}`,
      `source: "${sourcePath.replace(/[\n\r"]/g, ' ').trim()}"`,
      `created: ${now}`,
      `decay_days: 180`,
      '---',
      '',
      `# ${entity.name}`,
      '',
    ];

    if (entity.description) {
      lines.push(entity.description, '');
    }

    lines.push(`*Extracted from: ${sourcePath}*`);
    return lines.join('\n');
  }

  /**
   * Determine if an entity should get its own wiki page.
   * Organizations always qualify (partner companies, vendors, clients).
   * Person and project require high significance.
   *
   * @param {Object} entity - { name, type, significance }
   * @returns {boolean}
   */
  _shouldCreateWikiPage(entity) {
    if (!entity || !entity.name || entity.name.length <= 2) return false;

    // Block protected system pages
    if (PROTECTED_PAGES.has(normalizeEntityName(entity.name))) return false;

    // Block null/empty descriptions — graph-only entities
    if (!entity.description || entity.description === 'null') return false;

    // Block thin descriptions that carry no real knowledge (< 20 chars)
    if (entity.description.length < 20) return false;

    // Academic citations are not people (e.g. "Zhang et al")
    if (/\bet\s+al\.?\b/i.test(entity.name)) return false;

    const type = entity.type;
    // Organizations and agents always get wiki pages — workspace knowledge
    if (type === 'organization' || type === 'company' || type === 'agent') return true;
    // Person and project require high significance
    if (entity.significance !== 'high') return false;
    return type === 'person' || type === 'project';
  }

  /**
   * Check whether a wiki page already exists in a section (for dedup).
   * Returns false on listing errors so creation proceeds and lets the
   * wiki writer handle any actual conflict.
   *
   * @param {string} section - Wiki section path (e.g. "People")
   * @param {string} name    - Page title to check
   * @returns {Promise<boolean>}
   */
  async _pageExists(section, name) {
    const normalized = normalizeEntityName(name);
    if (!normalized) return true; // Block empty names

    // Check protected pages
    if (PROTECTED_PAGES.has(normalized)) return true;

    // Check ALL entity sections, not just the target section
    const allSections = ['People', 'Agents', 'Organizations', 'Projects', 'Procedures', 'Research', 'Documents', 'Images'];
    for (const s of allSections) {
      try {
        const result = await this.wikiWriter.listPages(s);
        const pages = result?.pages || [];
        for (const p of pages) {
          const pageNorm = normalizeEntityName(p.title);
          if (pageNorm === normalized) {
            // Log Collectives "(N)" collision duplicates (not mere case differences)
            if (p.title !== name && /\(\d+\)$/.test(p.title)) {
              this.logger.warn(`[DocumentIngestor] Collision detected: "${p.title}" in ${s} matches "${name}"`);
            }
            return true;
          }
        }
      } catch { /* section may not exist yet */ }
    }
    return false;
  }

  /**
   * Map entity type to wiki section name.
   *
   * @param {string} type - Entity type (person, project, organization, etc.)
   * @returns {string}
   */
  _sectionForEntityType(type) {
    const map = {
      person: 'People',
      agent: 'Agents',
      organization: 'Organizations',
      company: 'Organizations',
      project: 'Projects',
      decision: 'Projects',
      procedure: 'Procedures',
      component: 'Components',
      module: 'Components',
      subsystem: 'Components',
      vm: 'Infrastructure',
      server: 'Infrastructure',
      service: 'Infrastructure',
      deployment: 'Infrastructure',
    };
    return map[type] || 'Research';
  }

  /**
   * Ask the LLM whether a new entity matches any existing page title.
   * Handles name variations, OCR errors, phonetic errors, and abbreviations.
   * Returns the matching title and a reason, or null if no match found.
   *
   * Only invoked when the classifier's router is available (graceful degradation:
   * if no router, skip fuzzy dedup and let the exact-match guard handle it).
   *
   * @param {Object} entity               - New entity { name, type, description }
   * @param {string[]} existingPageTitles - Current titles in the target section
   * @param {string} [fidelity]           - Source fidelity of the document
   * @returns {Promise<{title: string, reason: string}|null>}
   */
  async _findMatchingEntity(entity, existingPageTitles, fidelity) {
    if (!existingPageTitles || existingPageTitles.length === 0) return null;
    if (!this.classifier?.router) return null; // no LLM available

    const prompt = `Determine if this new entity matches any existing entity in the list.

New entity:
- Name: "${entity.name}"
- Type: ${entity.type}
- Description: "${(entity.description || '').substring(0, 200)}"
- Source fidelity: ${fidelity || 'authored'}${fidelity === 'ocr' ? ' (character-level errors likely)' : fidelity === 'transcribed' ? ' (phonetic errors likely)' : ''}

Existing entities:
${existingPageTitles.map((n, i) => `${i + 1}. "${n}"`).join('\n')}

Rules:
- Match if names clearly refer to the same real-world entity
- Account for: name variations, middle initials, OCR errors, phonetic errors, abbreviations
- Do NOT match if names could plausibly be different entities
- Names with (ocr-uncertain) or (transcription-uncertain) flags should be matched more generously

Respond ONLY with JSON:
{"match": true, "index": 1, "reason": "same person, middle initial variation"}
or
{"match": false}`;

    try {
      const result = await this.classifier.router.route({
        job: 'classification',
        task: 'entity_dedup',
        content: prompt,
        requirements: { maxTokens: 100, temperature: 0.0 },
      });

      const raw = result?.result || result?.content || '';
      const cleaned = raw.replace(/```json?\s*/gi, '').replace(/```/g, '').trim();
      const parsed = JSON.parse(cleaned.match(/\{[^}]+\}/)?.[0] || '{}');

      if (parsed.match && typeof parsed.index === 'number' &&
          parsed.index >= 1 && parsed.index <= existingPageTitles.length) {
        return { title: existingPageTitles[parsed.index - 1], reason: parsed.reason || 'matched' };
      }
    } catch (err) {
      this.logger.warn(`[DocumentIngestor] Entity dedup check failed: ${err.message}`);
    }
    return null;
  }
}

module.exports = DocumentIngestor;
