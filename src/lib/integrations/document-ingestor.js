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
 * events trigger processFile(). TextExtractor converts binary/office/image
 * buffers to text; EntityExtractor populates the knowledge graph in-place;
 * ResilientWikiWriter persists a document summary page per file. A Set tracks
 * already-processed paths so repeat polls are cheap. ingestDirectory() provides
 * a batch bootstrap path for existing content.
 *
 * Key Dependencies:
 * - NCFilesClient   — readFileBuffer() for binary downloads
 * - TextExtractor   — extract(buffer, filePath), isSupported(filePath) (static)
 * - EntityExtractor — extractFromPage(title, content) → void (loads graph directly)
 * - ResilientWikiWriter — createPage(sectionPath, pageName, content)
 *
 * Data Flow:
 * ActivityPoller.emit('event') → onFileEvent()
 *   → processFile(filePath)
 *     → ncFilesClient.readFileBuffer()
 *     → TextExtractor.extract()
 *     → entityExtractor.extractFromPage()
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

class DocumentIngestor {
  /**
   * @param {Object} deps
   * @param {Object} deps.ncFilesClient      - NCFilesClient instance
   * @param {Object} deps.textExtractor      - TextExtractor instance
   * @param {Object} deps.entityExtractor    - EntityExtractor instance
   * @param {Object} deps.knowledgeGraph     - KnowledgeGraph instance (used indirectly via entityExtractor)
   * @param {Object} deps.wikiWriter         - ResilientWikiWriter instance
   * @param {Object} [deps.logger]           - Logger (defaults to console)
   */
  constructor({ ncFilesClient, textExtractor, entityExtractor, knowledgeGraph, wikiWriter, logger } = {}) {
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
    this.logger         = logger || console;

    /** @type {Set<string>} Tracks successfully processed file paths. */
    this._processed = new Set();
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

    // Run entity extraction — directly populates the knowledge graph
    try {
      await this.entityExtractor.extractFromPage(filenameNoExt, truncatedText);
    } catch (err) {
      // Entity extraction is best-effort; do not abort wiki page creation
      this.logger.warn(`[DocumentIngestor] Entity extraction error for ${filePath}: ${err.message}`);
    }

    // Build wiki page content
    const sectionPath = this._sectionForFile(filePath);
    const pageName    = filenameNoExt;
    const pageContent = this._buildDocumentPage(filePath, extraction);

    // Create wiki summary page
    let wikiResult;
    try {
      wikiResult = await this.wikiWriter.createPage(sectionPath, pageName, pageContent);
    } catch (err) {
      this.logger.warn(`[DocumentIngestor] Wiki page creation failed for ${filePath}: ${err.message}`);
      wikiResult = { success: false, error: err.message };
    }

    // Mark as processed only after successful pipeline run
    this._processed.add(filePath);

    this.logger.info(`[DocumentIngestor] Processed ${filePath} → ${sectionPath}/${pageName} (${rawText.length} chars)`);

    return {
      filePath,
      skipped: false,
      textLength: rawText.length,
      wikiResult,
    };
  }

  /**
   * Batch-process all supported files in a directory.
   *
   * @param {string} directoryPath - Nextcloud-relative directory path
   * @param {Object} [options]
   * @param {number} [options.batchSize=10] - Files processed in parallel per batch
   * @param {Function} [options.onProgress] - Called after each batch: (processed, total) => void
   * @returns {Promise<{total: number, processed: number, errors: number, details: Array}>}
   */
  async ingestDirectory(directoryPath, options = {}) {
    const batchSize = options.batchSize || 10;
    const onProgress = typeof options.onProgress === 'function' ? options.onProgress : null;

    let entries;
    try {
      entries = await this.ncFilesClient.getDirectoryContents(directoryPath);
    } catch (err) {
      this.logger.warn(`[DocumentIngestor] Cannot list directory ${directoryPath}: ${err.message}`);
      return { total: 0, processed: 0, errors: 1, details: [{ error: err.message }] };
    }

    // Filter to supported files only
    const files = (entries || []).filter(
      entry => entry.type !== 'directory' && TextExtractor.isSupported(entry.name || '')
    );

    const total   = files.length;
    let processed = 0;
    let errors    = 0;
    const details = [];

    // Process in batches
    for (let i = 0; i < total; i += batchSize) {
      const batch = files.slice(i, i + batchSize);

      const batchResults = await Promise.all(
        batch.map(async entry => {
          const filePath = directoryPath
            ? `${directoryPath.replace(/\/+$/, '')}/${entry.name}`
            : entry.name;
          try {
            return await this.processFile(filePath);
          } catch (err) {
            this.logger.warn(`[DocumentIngestor] Unexpected error for ${filePath}: ${err.message}`);
            return { filePath, skipped: true, reason: err.message, error: true };
          }
        })
      );

      for (const result of batchResults) {
        details.push(result);
        if (result.error) {
          errors++;
        } else if (!result.skipped) {
          processed++;
        }
      }

      if (onProgress) {
        onProgress(processed, total);
      }
    }

    return { total, processed, errors, details };
  }

  /**
   * Handler for ActivityPoller 'event' emissions.
   * Filters to file create/change events and delegates to processFile().
   *
   * @param {Object} event - NCFlowEvent from ActivityPoller
   * @param {string} event.type - Event type string
   * @param {string} event.objectType - Normalized object type ('file' or original)
   * @param {string} event.objectName - File path
   * @returns {Promise<Object|undefined>}
   */
  async onFileEvent(event) {
    if (!event) return;

    // ActivityPoller normalizes 'files' object_type to 'file' via OBJECT_TYPE_MAP
    // but the spec says objectType will be 'files' — handle both to be safe
    if (event.objectType !== 'files' && event.objectType !== 'file') return;

    if (event.type !== 'file_created' && event.type !== 'file_changed') return;

    const filePath = event.objectName;
    if (!filePath || !TextExtractor.isSupported(filePath)) return;

    // Re-ingest on change by clearing the processed flag
    if (event.type === 'file_changed') {
      this._processed.delete(filePath);
    }

    return this.processFile(filePath);
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
   * Build wiki page content for a document summary.
   * Includes YAML frontmatter and extracted text.
   *
   * @param {string} filePath - Original file path
   * @param {Object} extraction - Result from TextExtractor.extract()
   * @param {string} extraction.text - Extracted text
   * @param {boolean} [extraction.truncated] - Whether text was truncated
   * @param {number} [extraction.totalLength] - Total character count before truncation
   * @param {number} [extraction.pages] - Page count (PDFs)
   * @param {boolean} [extraction.ocr] - Whether OCR was used
   * @param {string} [extraction.warning] - Any extraction warning
   * @returns {string} Markdown page content
   */
  _buildDocumentPage(filePath, extraction) {
    const filename = path.basename(filePath);
    const ext      = filename.split('.').pop().toLowerCase();
    const now      = new Date().toISOString();

    const safeFilename = filename.replace(/"/g, '\\"');
    const safeFilePath = filePath.replace(/"/g, '\\"');

    const lines = [
      '---',
      `title: "${safeFilename}"`,
      `source: "${safeFilePath}"`,
      `type: document`,
      `fileType: "${ext}"`,
      `ingestedAt: "${now}"`,
    ];

    if (extraction.pages !== undefined) {
      lines.push(`pages: ${extraction.pages}`);
    }
    if (extraction.ocr) {
      lines.push(`ocr: true`);
    }
    if (extraction.totalLength !== undefined) {
      lines.push(`totalChars: ${extraction.totalLength}`);
    }
    if (extraction.truncated) {
      lines.push(`truncated: true`);
    }

    lines.push('---', '');
    lines.push(`# ${filename}`, '');

    if (extraction.warning) {
      lines.push(`> **Warning:** ${extraction.warning}`, '');
    }

    lines.push('## Extracted Content', '');
    lines.push(extraction.text || '');

    return lines.join('\n');
  }
}

module.exports = DocumentIngestor;
