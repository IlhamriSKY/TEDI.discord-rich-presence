# Changelog

All notable changes to **TEDI Discord Rich Presence**. Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions follow [SemVer](https://semver.org/).

## [1.5.14] - 2026-08-24

### Changed

- **Built against TEDI's published extension types.** TEDI 0.4.26 ships `tedi.d.ts`, a standalone typed contract for `ctx`, and a JSON Schema for `manifest.json`. Both now live in this repo, written by `tedi ext types`, alongside a `jsconfig.json` that turns type checking on for plain JavaScript. A misspelled `ctx.*` call is an editor error now rather than a `TypeError` raised inside an async handler, where it surfaces as an unhandled rejection nobody sees. `build.mjs` is the canonical copy shared across the TEDI extensions: it reads its entry point, output path and banner from `manifest.json`, so it holds nothing specific to this extension. The manifest gains a `$schema` line, which every parser ignores and which gives the file completion while it is edited. No behaviour changes; the bundle esbuild produces is byte-identical apart from its banner comment.

## [1.5.13] - 2026-08-02

### Fixed

- **The presence card still called TEDI by its old name.** Hovering the large icon in Discord read "Terminal Environment & Development Infrastructure"; the app was renamed to Terminal Director in TEDI v0.3.95 and the sidecar was the last place carrying the old expansion. The tooltip is the only thing that changes, so an already-running presence picks it up on the next sidecar start.

## [1.5.12] - 2026-07-18

### Changed

- **Documentation.** Project links point at the TEDI website (https://tedi.ilhamriski.com/) in both `manifest.json` and the README, the README follows the structure shared across the TEDI extensions, and "How it works" is rendered as a Mermaid diagram. No behaviour change.

## [1.5.11] - 2026-06-16

### Changed

- **Internal refactor.** The single `src/index.js` is split into small, cohesive modules (each ≤ 300 lines), matching the project's module convention. No behaviour change — the built `extension.js` is functionally identical (verified: same string-literal set, same exports).

## [1.5.10] - 2026-06-16

### Changed

- **Build pipeline.** The extension is now authored as `src/index.js` and bundled into `extension.js` with esbuild (`npm run build`); the built bundle is **no longer committed** — CI (`release.yml`) builds it into the release `.zip` that users install. No behaviour change. CI actions bumped to `@v5` (Node 24).

## [1.5.9] - 2026-05-28

### Changed

- **`engines.tedi` raised to `>=0.3.9`.** The host now enforces this constraint at install time, so older TEDI builds refuse to install the extension and surface a "needs TEDI X.Y.Z" message rather than letting it run against a host that predates the current API surface.
