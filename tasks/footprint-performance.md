# Task: Minimize Footprint and Improve Performance

## Goal
Reduce client/server footprint and improve runtime performance without changing functionality.

## Scope
- Remove external font dependencies to eliminate third-party fetches.
- Minify client assets and serve built artifacts in production.
- Enable compression and caching for static assets.
- Use multi-stage Docker build to avoid dev dependencies in the final image.

## Acceptance Criteria
- App functions identically in create/play/daily flows.
- Client assets are minified and served from `public/dist` when present.
- Static assets are compressed in transit and have cache headers.
- Docker image contains only production dependencies and built assets.

## Implementation Notes
- Build script: `scripts/build-assets.js` uses esbuild to minify JS/CSS and copy `index.html`.
- Server prefers `public/dist` when available; falls back to `public`.
- Compression enabled via `compression` middleware.
- Dockerfile uses multi-stage build and ships only `public/dist`.
- Google Fonts removed; system font stack used instead.
- Built asset size: ~36 KB total (`app.js` ~16 KB, `styles.css` ~12 KB).

## Status
- Done (2026-02-08)
