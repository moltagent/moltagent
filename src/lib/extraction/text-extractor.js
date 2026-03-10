/*
 * MoltAgent - Sovereign AI Security Layer
 * Copyright (C) 2026 MoltAgent Contributors
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU Affero General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the
 * GNU Affero General Public License for more details.
 */

'use strict';

/**
 * TextExtractor — Extract text from PDF, Word, Excel, text, and image files
 * with OCR fallback for scanned PDFs and direct image OCR via tesseract.
 *
 * Architecture Brief:
 * - Problem: Scanned PDFs (invoices, receipts) contain no extractable text;
 *   NC StorageShare has no OCR capability, so the Bot VM must handle it.
 *   Image files (jpg, png, tiff, etc.) also require OCR to yield text.
 * - Pattern: Normal text extraction first, heuristic scanned-PDF detection
 *   (< N chars/page), then ocrmypdf fallback via temp files. Image files
 *   are routed directly to tesseract via _extractImage().
 * - Key Dependencies: pdf-parse, mammoth, xlsx, ocrmypdf (system binary),
 *   tesseract (system binary)
 * - Data Flow: buffer → pdf-parse → scanned? → ocrmypdf → pdf-parse → text
 *              buffer → (image ext) → tesseract → text
 *
 * @module extraction/text-extractor
 * @version 2.1.0
 */

const { execFile } = require('child_process');
const { promisify } = require('util');
const execFileAsync = promisify(execFile);
const fs = require('fs').promises;
const os = require('os');
const path = require('path');

class TextExtractor {
  /**
   * @param {Object} [config={}]
   * @param {number} [config.maxOutputSize=51200] - Max output text size (bytes)
   * @param {boolean} [config.ocrEnabled=true] - Enable OCR fallback for scanned PDFs
   * @param {string} [config.ocrLanguages='eng+deu+por'] - Tesseract language string
   * @param {number} [config.ocrTimeoutMs=120000] - Max OCR processing time (ms)
   * @param {number} [config.ocrJobs=1] - CPU cores for ocrmypdf
   * @param {number} [config.charsPerPageThreshold=50] - Below this = scanned PDF
   * @param {Object} [config.logger] - Optional logger instance
   */
  constructor(config = {}) {
    this.maxOutputSize = config.maxOutputSize || 51200; // 50KB
    this.ocrEnabled = config.ocrEnabled !== false;
    this.ocrLanguages = config.ocrLanguages || 'eng+deu+por';
    this.ocrTimeoutMs = config.ocrTimeoutMs ?? 120000;
    this.ocrJobs = config.ocrJobs ?? 1;
    this.charsPerPageThreshold = config.charsPerPageThreshold ?? 50;
    this.logger = config.logger || null;

    // Lazy-checked on first scanned PDF
    this._ocrAvailable = null;

    // Lazy-checked on first image OCR request
    this._tesseractAvailable = null;
  }

  /** Supported file extensions */
  static SUPPORTED = new Set([
    'pdf', 'docx', 'xlsx', 'xls',
    'txt', 'md', 'csv', 'json', 'yaml', 'yml',
    'html', 'htm', 'xml', 'log',
    'jpg', 'jpeg', 'png', 'tiff', 'tif', 'bmp', 'webp'
  ]);

  /** Image extensions that route to _extractImage */
  static IMAGE_EXTENSIONS = new Set([
    'jpg', 'jpeg', 'png', 'tiff', 'tif', 'bmp', 'webp'
  ]);

  /**
   * Check if a file path has a supported extension.
   * @param {string} filePath
   * @returns {boolean}
   */
  static isSupported(filePath) {
    const ext = (filePath || '').split('.').pop().toLowerCase();
    return TextExtractor.SUPPORTED.has(ext);
  }

  /**
   * Lazy-check whether ocrmypdf is available on this system.
   * Caches the result after first invocation.
   * @returns {Promise<boolean>}
   */
  async _checkOcrAvailable() {
    if (this._ocrAvailable !== null) return this._ocrAvailable;
    try {
      await execFileAsync('ocrmypdf', ['--version']);
      this._ocrAvailable = true;
      this.logger?.info?.('[TextExtractor] ocrmypdf available — OCR fallback enabled');
    } catch {
      this._ocrAvailable = false;
      this.logger?.info?.('[TextExtractor] ocrmypdf not found — OCR fallback disabled');
    }
    return this._ocrAvailable;
  }

  /**
   * Extract text from a file buffer.
   * @param {Buffer} buffer - File contents
   * @param {string} filePath - Original file path (for extension detection)
   * @returns {Promise<{text: string, truncated: boolean, totalLength: number, pages?: number, ocr?: boolean, warning?: string}>}
   */
  async extract(buffer, filePath) {
    const ext = (filePath || '').split('.').pop().toLowerCase();

    if (!TextExtractor.SUPPORTED.has(ext)) {
      throw new Error(`Unsupported file type: .${ext}. Supported: ${Array.from(TextExtractor.SUPPORTED).join(', ')}`);
    }

    let text = '';
    let pages;
    let ocr;
    let warning;

    switch (ext) {
      case 'pdf': {
        const pdfResult = await this._extractPdf(buffer);
        text = pdfResult.text || '';
        pages = pdfResult.pageCount;
        ocr = pdfResult.ocr;
        if (pdfResult.warning) warning = pdfResult.warning;
        break;
      }

      case 'docx':
        text = await this._extractDocx(buffer);
        break;

      case 'xlsx':
      case 'xls':
        text = await this._extractXlsx(buffer);
        break;

      case 'jpg':
      case 'jpeg':
      case 'png':
      case 'tiff':
      case 'tif':
      case 'bmp':
      case 'webp': {
        const imgResult = await this._extractImage(buffer, filePath);
        text = imgResult.text || '';
        ocr = imgResult.ocr;
        if (imgResult.warning) warning = imgResult.warning;
        // Return early — _extractImage already produces the final shape,
        // but we still run through the shared truncation logic below.
        break;
      }

      default:
        // Text-based formats — direct conversion
        text = buffer.toString('utf-8');
        break;
    }

    const totalLength = text.length;
    const truncated = totalLength > this.maxOutputSize;

    if (truncated) {
      text = text.substring(0, this.maxOutputSize) +
        `\n\n[... truncated, showing first ${this.maxOutputSize} chars of ${totalLength}.]`;
    }

    const result = { text, truncated, totalLength };
    if (pages !== undefined) result.pages = pages;
    if (ocr !== undefined) result.ocr = ocr;
    if (warning) result.warning = warning;
    return result;
  }

  /**
   * Extract text from PDF buffer, with OCR fallback for scanned PDFs.
   * @param {Buffer} buffer
   * @returns {Promise<{text: string, pageCount: number, ocr: boolean, truncated?: boolean, warning?: string, error?: string}>}
   * @private
   */
  async _extractPdf(buffer) {
    const pdfParse = require('pdf-parse');

    // First pass: try normal text extraction
    const data = await pdfParse(buffer);
    const rawText = (data.text || '').trim();

    // Heuristic: is this a scanned PDF?
    const pageCount = Math.max(data.numpages, 1);
    const charsPerPage = rawText.length / pageCount;
    const isLikelyScanned = charsPerPage < this.charsPerPageThreshold;

    if (!isLikelyScanned || !this.ocrEnabled) {
      // Normal PDF with text — return directly
      return { text: rawText, pageCount: data.numpages, ocr: false };
    }

    // Scanned PDF detected — try OCR fallback
    this.logger?.info?.(
      `[TextExtractor] Scanned PDF detected (${charsPerPage.toFixed(0)} chars/page across ${data.numpages} pages) — attempting OCR`
    );

    const ocrAvailable = await this._checkOcrAvailable();
    if (!ocrAvailable) {
      return {
        text: rawText || '',
        pageCount: data.numpages,
        ocr: false,
        warning: 'This appears to be a scanned PDF but OCR is not available on this system. Text extraction may be incomplete.'
      };
    }

    // OCR the PDF — fall back to rawText if OCR fails
    const ocrResult = await this._ocrPdf(buffer, data.numpages);
    if (ocrResult.error) {
      return { text: rawText || '', pageCount: data.numpages, ocr: false, warning: ocrResult.error };
    }
    return ocrResult;
  }

  /**
   * Run ocrmypdf on a PDF buffer and extract text from the result.
   * @param {Buffer} buffer - Input PDF buffer
   * @param {number} pageCount - Number of pages
   * @returns {Promise<{text: string, pageCount: number, ocr: boolean, error?: string}>}
   * @private
   */
  async _ocrPdf(buffer, pageCount) {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'moltagent-ocr-'));
    const inputPath = path.join(tmpDir, 'input.pdf');
    const outputPath = path.join(tmpDir, 'output.pdf');

    try {
      // Write input buffer to temp file
      await fs.writeFile(inputPath, buffer);

      // Run ocrmypdf
      // --skip-text: don't re-OCR pages that already have text
      // --jobs N: limit CPU usage
      // -l: languages
      await execFileAsync('ocrmypdf', [
        '--skip-text',
        '--jobs', String(this.ocrJobs),
        '-l', this.ocrLanguages,
        '--output-type', 'pdf',
        inputPath,
        outputPath
      ], {
        timeout: this.ocrTimeoutMs
      });

      // Read OCR'd PDF and extract text
      const ocrBuffer = await fs.readFile(outputPath);
      const pdfParse = require('pdf-parse');
      const ocrData = await pdfParse(ocrBuffer);
      const text = (ocrData.text || '').trim();

      this.logger?.info?.(
        `[TextExtractor] OCR complete: ${text.length} chars extracted from ${pageCount} pages`
      );

      return { text, pageCount, ocr: true };
    } catch (err) {
      this.logger?.warn?.(`[TextExtractor] OCR failed: ${err.message}`);
      return {
        text: '',
        pageCount,
        ocr: false,
        error: `OCR processing failed: ${err.message}`
      };
    } finally {
      // Clean up temp files
      try {
        await fs.rm(tmpDir, { recursive: true, force: true });
      } catch { /* ignore cleanup errors */ }
    }
  }

  /**
   * Lazy-check whether tesseract is available on this system.
   * Caches the result after first invocation.
   * @returns {Promise<boolean>}
   */
  async _checkTesseractAvailable() {
    if (this._tesseractAvailable !== null) return this._tesseractAvailable;
    try {
      await execFileAsync('tesseract', ['--version']);
      this._tesseractAvailable = true;
      this.logger?.info?.('[TextExtractor] tesseract available — image OCR enabled');
    } catch {
      this._tesseractAvailable = false;
      this.logger?.info?.('[TextExtractor] tesseract not found — image OCR disabled');
    }
    return this._tesseractAvailable;
  }

  /**
   * Extract text from an image buffer using tesseract.
   * @param {Buffer} buffer - Image file contents
   * @param {string} filePath - Original file path (used for extension / logging)
   * @returns {Promise<{text: string, truncated: boolean, totalLength: number, ocr: boolean, warning?: string}>}
   * @private
   */
  async _extractImage(buffer, filePath) {
    const tesseractAvailable = await this._checkTesseractAvailable();
    if (!tesseractAvailable) {
      this.logger?.warn?.('[TextExtractor] tesseract not available — cannot OCR image');
      return {
        text: '',
        truncated: false,
        totalLength: 0,
        ocr: true,
        warning: 'Image OCR failed: tesseract is not available on this system'
      };
    }

    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'moltagent-imgocr-'));
    // Preserve extension so tesseract can detect image format
    const ext = (filePath || 'image.png').split('.').pop().toLowerCase();
    const inputPath = path.join(tmpDir, `input.${ext}`);
    // tesseract appends .txt to the output base name automatically
    const outputBase = path.join(tmpDir, 'output');
    const outputTxt = `${outputBase}.txt`;

    try {
      await fs.writeFile(inputPath, buffer);

      await execFileAsync('tesseract', [
        inputPath,
        outputBase,
        '-l', this.ocrLanguages,
        '--psm', '1'
      ], {
        timeout: this.ocrTimeoutMs
      });

      const rawText = await fs.readFile(outputTxt, 'utf-8');
      const text = rawText.trim();

      this.logger?.info?.(
        `[TextExtractor] Image OCR complete: ${text.length} chars extracted from ${filePath || 'image'}`
      );

      // Note: truncation is handled by the shared logic in extract(), so we
      // return the full text here. totalLength/truncated are filled in there.
      return { text, truncated: false, totalLength: text.length, ocr: true };
    } catch (err) {
      this.logger?.warn?.(`[TextExtractor] Image OCR failed: ${err.message}`);
      return {
        text: '',
        truncated: false,
        totalLength: 0,
        ocr: true,
        warning: `Image OCR failed: ${err.message}`
      };
    } finally {
      try {
        await fs.rm(tmpDir, { recursive: true, force: true });
      } catch { /* ignore cleanup errors */ }
    }
  }

  /**
   * Extract text from .docx buffer.
   * @private
   */
  async _extractDocx(buffer) {
    const mammoth = require('mammoth');
    const result = await mammoth.extractRawText({ buffer });
    return result.value;
  }

  /**
   * Extract text from .xlsx/.xls buffer.
   * @private
   */
  async _extractXlsx(buffer) {
    const XLSX = require('xlsx');
    const workbook = XLSX.read(buffer);
    const lines = [];

    for (const sheetName of workbook.SheetNames) {
      lines.push(`--- Sheet: ${sheetName} ---`);
      const sheet = workbook.Sheets[sheetName];
      const csv = XLSX.utils.sheet_to_csv(sheet);
      lines.push(csv);
    }

    return lines.join('\n');
  }
}

module.exports = { TextExtractor };
