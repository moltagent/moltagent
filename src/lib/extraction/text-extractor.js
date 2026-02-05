'use strict';

/**
 * TextExtractor - Extract text from PDF, Word, Excel, and text files
 *
 * Lazy-loads npm dependencies (pdf-parse, mammoth, xlsx) so the module
 * won't crash if they aren't installed.
 *
 * @module extraction/text-extractor
 * @version 1.0.0
 */

class TextExtractor {
  /**
   * @param {Object} [config={}]
   * @param {number} [config.maxOutputSize=51200] - Max output text size (bytes)
   */
  constructor(config = {}) {
    this.maxOutputSize = config.maxOutputSize || 51200; // 50KB
  }

  /** Supported file extensions */
  static SUPPORTED = new Set([
    'pdf', 'docx', 'xlsx', 'xls',
    'txt', 'md', 'csv', 'json', 'yaml', 'yml',
    'html', 'htm', 'xml', 'log'
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
   * Extract text from a file buffer.
   * @param {Buffer} buffer - File contents
   * @param {string} filePath - Original file path (for extension detection)
   * @returns {Promise<{text: string, truncated: boolean, totalLength: number, pages?: number}>}
   */
  async extract(buffer, filePath) {
    const ext = (filePath || '').split('.').pop().toLowerCase();

    if (!TextExtractor.SUPPORTED.has(ext)) {
      throw new Error(`Unsupported file type: .${ext}. Supported: ${Array.from(TextExtractor.SUPPORTED).join(', ')}`);
    }

    let text = '';
    let pages;

    switch (ext) {
      case 'pdf':
        text = await this._extractPdf(buffer);
        // pdf-parse returns { text, numpages }
        if (typeof text === 'object') {
          pages = text.numpages;
          text = text.text;
        }
        break;

      case 'docx':
        text = await this._extractDocx(buffer);
        break;

      case 'xlsx':
      case 'xls':
        text = await this._extractXlsx(buffer);
        break;

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
    return result;
  }

  /**
   * Extract text from PDF buffer.
   * @private
   */
  async _extractPdf(buffer) {
    const pdfParse = require('pdf-parse');
    const result = await pdfParse(buffer);
    return { text: result.text, numpages: result.numpages };
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
