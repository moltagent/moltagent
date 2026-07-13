# Dependency Security Posture

A fresh `npm install` surfaces an `npm audit` warning count that looks alarming
(currently **18 vulnerabilities**, most of them in dev-only or transitive
packages). This document is the project's documented stance: what each advisory
is, whether it is reachable at runtime, and why it is fixed, deferred, or
accepted. It exists so an installer seeing that number can find the reasoning
in-repo rather than guessing.

Re-generate the numbers below with:

```bash
npm audit                 # full tree (dev + runtime) — the headline count
npm audit --omit=dev      # runtime-only — what actually ships
```

## Snapshot

| Scope | Count | Notes |
| ----- | ----- | ----- |
| Full tree (`npm audit`) | 18 (5 moderate, 13 high) | Includes the dev toolchain (eslint/lint-staged and their transitive deps). Never shipped or executed in production. |
| Runtime (`npm audit --omit=dev`) | **11 (2 moderate, 9 high)** | After the `undici` override below (was 12 before). |

`--omit=dev` is the number that matters for a deployed instance: the reference
deployment installs with `npm ci --omit=dev`, so the dev-toolchain advisories
are not present on the running box.

## Fixed in this change

### undici — pinned via `overrides`

- Advisory cluster: request/response smuggling, unbounded-memory / DoS, CRLF and
  header-injection issues (GHSA-2mjp-6q6p-2qxm and others).
- Reached transitively as `cheerio@1.2.0 → undici`. `cheerio` accepts
  `undici@^7.19.0`; the patched line `7.28.0` is inside that range, so the fix is
  a clean, non-breaking pin — no direct dependency changes major version.

```jsonc
// package.json
"overrides": {
  "undici": "^7.28.0"
}
```

This clears the entire `undici` cluster from `npm audit --omit=dev` (12 → 11).

## Accepted — no patched version exists

### SheetJS / xlsx (high)

- **GHSA-4r6h-8v6p-xvw6** — Prototype Pollution
- **GHSA-5pgg-2g8v-p4x9** — ReDoS
- Direct dependency `xlsx@^0.18.5`. Upstream has published **no fixed version on
  the npm registry** (`npm audit` reports *No fix available*); an `overrides`
  pin has nothing patched to point at.
- **Exposure & mitigation:** `xlsx` parses spreadsheet files a user has
  deliberately handed to the agent. Treat spreadsheet input as untrusted at the
  parsing boundary; do not parse attachments from unauthenticated senders.
  Migrating off SheetJS (or to its non-npm CDN build, which carries the fixes)
  is the real remediation and is out of scope for a hygiene change.

## Deferred — fix requires a major-version change of a direct dependency

Project policy (see `CLAUDE.md`): no major-version bumps of direct dependencies
inside a hygiene change; each is its own change with its own testing.

- **nodemailer** (high, `<=9.0.0`) — direct `^8.0.0` (and transitively via
  `mailparser`). The fix lands only in `9.x`; adopting it is a direct-dependency
  major bump and a deliberate SMTP-path revalidation, tracked separately.
- **imap** (high, `>=0.8.18`) and its dependency chain **semver** (ReDoS) and
  **utf7** — direct `imap@^0.8.19`. `npm`'s only offered fix is `imap@0.8.17`, a
  **breaking downgrade** that would lose fixes and features. Replacing the `imap`
  client is the correct long-term move, tracked separately.

## Deferred — transitive fixes available (follow-up override/refresh pass)

These have patched versions reachable without a direct-dependency major bump.
They are **not** pinned in this change so it stays minimal and independently
testable; a dedicated pass can add the overrides and re-run the suite.

| Package | Sev | Reached via | Fix path |
| ------- | --- | ----------- | -------- |
| `@xmldom/xmldom` (`<=0.8.12`) | high | `mammoth` | override to `~0.8.13` |
| `linkify-it` (`<=5.0.0`) | high | `mailparser` | override to a patched release |
| `postcss` (`<8.5.10`) | moderate | `@extractus/article-extractor → sanitize-html` | override to `^8.5.10` |
| `underscore` (`<=1.13.7`) | high | `mammoth → lop → duck` | override to a patched release |
| `js-yaml` (`4.0.0 – 4.1.1`) | moderate | direct `^4.1.1` | in-range refresh (no major bump) |
| `mailparser` (`2.1.0 – 3.9.8`) | high | direct `^3.9.3` | in-range refresh (no major bump) |

## Verification

- `npm ci` → clean install from the committed lockfile (`undici@7.28.0` resolved).
- `npm test` → 246/246 test files pass with the override applied.
- `npm audit --omit=dev` → 11 (2 moderate, 9 high); the `undici` cluster is gone.
