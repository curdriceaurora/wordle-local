# local-hosted-wordle — Launch Checklist

## Product
- [ ] Create flow starts puzzle directly.
- [ ] Share link visible and copyable below keyboard.
- [ ] Strict mode and high‑contrast toggles persist.
- [ ] Daily word admin endpoints verified.
- [ ] Random word disabled when no dictionary is selected.
- [ ] Invalid share link shows an interstitial error and 10-second countdown, then redirects.
- [ ] `/daily` returns a friendly error when no word is configured.
- [ ] `ADMIN_KEY` enforcement verified (401/403 on missing or bad key).
- [ ] Dictionary validation error shown for invalid guesses.
- [ ] Languages with missing dictionary files do not appear as options.

## Accessibility
- [ ] Keyboard‑only flow verified (tab + enter).
- [ ] Screen reader: status messages read after each guess.
- [ ] Color‑blind mode visual cues verified (A/P/C).
- [ ] Focus rings visible on all controls.
- [ ] Skip link works and is visible on focus.
- [ ] ARIA roles/labels present for board and tiles.
- [ ] Reduced motion honored when prefers-reduced-motion is set.
- [ ] Touch targets meet 24px minimum.

## QA
- [ ] Unit tests pass (`npm test`).
- [ ] UI tests pass (`npm run test:ui`).
- [ ] Axe a11y checks pass (`npm run test:ui`).
- [ ] Manual mobile checks on iOS/Android.
- [ ] Playwright mobile viewport checks pass.
- [ ] Daily word date boundary tested (local midnight).

## Deployment
- [ ] Docker build succeeds.
- [ ] Compose stack starts without errors.
- [ ] Volume mounted for `/app/data`.

## Documentation
- [ ] Admin key set in `.env`.
- [ ] Usage instructions provided (create, share, daily).
- [ ] Error states documented (invalid link, missing daily, dictionary missing).
