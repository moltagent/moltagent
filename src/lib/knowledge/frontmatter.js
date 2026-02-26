'use strict';

/**
 * Minimal YAML Frontmatter Parser/Serializer
 *
 * Parses and serializes YAML frontmatter in markdown pages.
 * Supports the subset needed for knowledge wiki pages:
 * - Simple key-value pairs (strings, numbers, booleans, dates)
 * - Inline arrays: [a, b, c]
 * - List arrays: - item
 * - Nested objects via indented key-value under parent
 *
 * Not a full YAML parser — covers the frontmatter subset only.
 *
 * @module knowledge/frontmatter
 * @version 1.0.0
 */

/**
 * Parse frontmatter from a markdown string
 * @param {string} markdown - Full markdown content with optional --- delimited frontmatter
 * @returns {{ frontmatter: Object, body: string }}
 */
function parseFrontmatter(markdown) {
  if (!markdown || typeof markdown !== 'string') {
    return { frontmatter: {}, body: markdown || '' };
  }

  const trimmed = markdown.trimStart();

  // Must start with ---
  if (!trimmed.startsWith('---')) {
    return { frontmatter: {}, body: markdown };
  }

  // Find closing ---
  const endIndex = trimmed.indexOf('\n---', 3);
  if (endIndex === -1) {
    return { frontmatter: {}, body: markdown };
  }

  const fmBlock = trimmed.substring(3, endIndex).trim();
  const body = trimmed.substring(endIndex + 4).replace(/^\n/, '');

  const frontmatter = _parseYamlBlock(fmBlock);

  return { frontmatter, body };
}

/**
 * Serialize frontmatter and body into a full markdown string
 * @param {Object} frontmatter - Frontmatter key-value pairs
 * @param {string} body - Markdown body content
 * @returns {string} Full markdown with --- delimited frontmatter
 */
function serializeFrontmatter(frontmatter, body) {
  if (!frontmatter || Object.keys(frontmatter).length === 0) {
    return body || '';
  }

  const fmLines = _serializeYamlBlock(frontmatter);
  const bodyStr = body || '';

  return `---\n${fmLines}\n---\n${bodyStr}`;
}

/**
 * Parse a YAML block (content between --- delimiters)
 * @private
 * @param {string} block - YAML content
 * @returns {Object}
 */
function _parseYamlBlock(block) {
  const result = {};
  const lines = block.split('\n');
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    // Skip empty lines and comments
    if (!line.trim() || line.trim().startsWith('#')) {
      i++;
      continue;
    }

    // Top-level key: value
    const match = line.match(/^(\w[\w_-]*)\s*:\s*(.*)/);
    if (!match) {
      i++;
      continue;
    }

    const key = match[1];
    let value = match[2].trim();

    // Check if next lines are indented list items (array or nested object)
    if (value === '') {
      const items = [];
      i++;
      while (i < lines.length) {
        const nextLine = lines[i];
        const listMatch = nextLine.match(/^\s+-\s+(.*)/);
        if (!listMatch) break;

        const itemValue = listMatch[1].trim();
        // Check if it's a key: value pair (nested object in array)
        const kvMatch = itemValue.match(/^(\w[\w_-]*)\s*:\s*(.*)/);
        if (kvMatch) {
          const obj = {};
          obj[kvMatch[1]] = _parseValue(kvMatch[2].trim());
          items.push(obj);
        } else {
          items.push(_parseValue(itemValue));
        }
        i++;
      }
      result[key] = items;
      continue;
    }

    // Inline array: [a, b, c]
    if (value.startsWith('[') && value.endsWith(']')) {
      const inner = value.slice(1, -1);
      result[key] = inner.split(',').map(s => _parseValue(s.trim())).filter(v => v !== '');
      i++;
      continue;
    }

    // Simple value
    result[key] = _parseValue(value);
    i++;
  }

  return result;
}

/**
 * Parse a single YAML value
 * @private
 * @param {string} raw - Raw value string
 * @returns {*} Parsed value
 */
function _parseValue(raw) {
  if (raw === '' || raw === undefined) return '';

  // Remove surrounding quotes
  if ((raw.startsWith('"') && raw.endsWith('"')) ||
      (raw.startsWith("'") && raw.endsWith("'"))) {
    return raw.slice(1, -1);
  }

  // Booleans
  if (raw === 'true') return true;
  if (raw === 'false') return false;

  // Null
  if (raw === 'null' || raw === '~') return null;

  // Numbers (integers and floats)
  if (/^-?\d+$/.test(raw)) return parseInt(raw, 10);
  if (/^-?\d+\.\d+$/.test(raw)) return parseFloat(raw);

  // Everything else is a string (including dates like 2026-02-08)
  return raw;
}

/**
 * Serialize an object to YAML-like frontmatter lines
 * @private
 * @param {Object} obj - Object to serialize
 * @returns {string} YAML lines
 */
function _serializeYamlBlock(obj) {
  const lines = [];

  for (const [key, value] of Object.entries(obj)) {
    if (value === null || value === undefined) {
      lines.push(`${key}: null`);
    } else if (Array.isArray(value)) {
      // Decide: inline vs block array
      const allSimple = value.every(v => typeof v !== 'object' || v === null);
      if (allSimple && value.length <= 5) {
        // Inline array
        const items = value.map(v => _serializeValue(v));
        lines.push(`${key}: [${items.join(', ')}]`);
      } else {
        // Block array
        lines.push(`${key}:`);
        for (const item of value) {
          if (item && typeof item === 'object' && !Array.isArray(item)) {
            // Object item: - key: value
            for (const [k, v] of Object.entries(item)) {
              lines.push(`  - ${k}: ${_serializeValue(v)}`);
            }
          } else {
            lines.push(`  - ${_serializeValue(item)}`);
          }
        }
      }
    } else if (typeof value === 'object') {
      // Nested object (shouldn't typically occur in frontmatter, but handle it)
      lines.push(`${key}:`);
      for (const [k, v] of Object.entries(value)) {
        lines.push(`  ${k}: ${_serializeValue(v)}`);
      }
    } else {
      lines.push(`${key}: ${_serializeValue(value)}`);
    }
  }

  return lines.join('\n');
}

/**
 * Serialize a single value
 * @private
 * @param {*} value
 * @returns {string}
 */
function _serializeValue(value) {
  if (value === null || value === undefined) return 'null';
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'number') return String(value);

  const str = String(value);
  // Quote strings that contain special characters or look like wikilinks
  if (str.includes(':') || str.includes('#') || str.includes('[') ||
      str.includes(']') || str.includes('{') || str.includes('}') ||
      str.includes(',') || str.startsWith('- ')) {
    return `"${str.replace(/"/g, '\\"')}"`;
  }
  return str;
}

/**
 * Merge updates into existing frontmatter, preserving untouched fields.
 * Returns new object — does not mutate inputs.
 * @param {Object} existing - Current frontmatter key-value pairs
 * @param {Object} updates - Fields to add or overwrite
 * @returns {Object} Merged frontmatter
 */
function mergeFrontmatter(existing, updates) {
  return { ...(existing || {}), ...(updates || {}) };
}

module.exports = { parseFrontmatter, serializeFrontmatter, mergeFrontmatter };
