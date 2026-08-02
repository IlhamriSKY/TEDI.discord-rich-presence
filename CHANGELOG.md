# Changelog

All notable changes to **TEDI Discord Rich Presence**. Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions follow [SemVer](https://semver.org/).

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
