// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Deployment-Config Bootstrap
 *
 * ARCHITECTURE BRIEF
 * Problem: Three deployment config files were git-tracked and mutable; a pull
 *   that clobbers a deployer's edited file (or leaves conflict markers) breaks
 *   startup. We untrack the real files and ship `.example` templates; on a fresh
 *   or post-untrack checkout the real files may be absent and must be seeded.
 * Pattern: Single copy-on-missing chokepoint (CLAUDE.md Rule 5). Runs ONCE at
 *   the top of initialize(), before any config reader. True-absence only:
 *   existsSync(real) === false → copy from `<real>.example`. Never overwrites an
 *   existing file (a corrupt-but-present file is the human's to repair, untouched).
 * Key deps: fs, path. No NC, no LLM, no network. Pure local FS.
 * Data flow: initialize() → ensureDeploymentConfig() → for each node-read pair,
 *   copy `.example`→real iff real missing → log [INIT] notice → return summary.
 * Dependency map: depended on by webhook-server.js initialize(). Depends on nothing
 *   in src/. Implement before the webhook-server edits that call it.
 */

'use strict';

const fs = require('fs');
const path = require('path');

/**
 * The node-read config files that must exist at startup, paired with their
 * shipped template. The `.service` file is intentionally absent: node never
 * reads it, so it gets no runtime copy.
 * Paths are repo-root-relative; resolved against `rootDir`.
 * @type {ReadonlyArray<{ real: string, example: string }>}
 */
const MANAGED_FILES = Object.freeze([
  Object.freeze({ real: 'config/providers.json', example: 'config/providers.json.example' }),
  Object.freeze({ real: 'config/moltagent-providers.yaml', example: 'config/moltagent-providers.yaml.example' })
]);

/**
 * @typedef {Object} EnsureResult
 * @property {string[]} copied   - real paths that were seeded from their example this run
 * @property {string[]} present  - real paths that already existed (untouched)
 * @property {Array<{ file: string, error: string }>} errors - copy failures (non-fatal)
 */

/**
 * Ensure each managed deployment-config file is present, seeding from its
 * `.example` template on TRUE ABSENCE ONLY. Never overwrites an existing file.
 * Idempotent: a second call is a pure no-op once files exist.
 *
 * @param {Object} [options]
 * @param {string} [options.rootDir] - repo root for resolving paths (default: process.cwd())
 * @param {(msg: string) => void} [options.log] - notice sink (default: console.log)
 * @param {(msg: string) => void} [options.errorLog] - error sink (default: console.error)
 * @returns {EnsureResult}
 */
function ensureDeploymentConfig(options = {}) {
  const rootDir = options.rootDir || process.cwd();
  const log = options.log || console.log;
  const errorLog = options.errorLog || console.error;

  /** @type {EnsureResult} */
  const result = { copied: [], present: [], errors: [] };

  for (const { real, example } of MANAGED_FILES) {
    const realPath = path.join(rootDir, real);
    const examplePath = path.join(rootDir, example);
    try {
      if (fs.existsSync(realPath)) {
        // File already present — never overwrite. A corrupt-but-present file is
        // left for the human to repair; the in-memory parse guard handles it.
        result.present.push(real);
        continue;
      }

      if (!fs.existsSync(examplePath)) {
        // Template missing — record the error and move on. Non-fatal: startup
        // proceeds, but the missing config may cause failures downstream.
        result.errors.push({ file: real, error: 'template missing: ' + example });
        errorLog(`[INIT] Could not seed ${real}: template ${example} not found`);
        continue;
      }

      fs.copyFileSync(examplePath, realPath);
      result.copied.push(real);
      log(`[INIT] Copied ${real} from ${example} — edit for your deployment`);
    } catch (err) {
      result.errors.push({ file: real, error: err.message });
      errorLog(`[INIT] Could not seed ${real} from ${example}: ${err.message}`);
    }
  }

  return result;
}

module.exports = { ensureDeploymentConfig, MANAGED_FILES };
