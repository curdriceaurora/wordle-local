const { test, expect } = require("./fixtures");

/*
 * Visual-regression baseline for the play surface — captured against
 * the post-merge typography/motion/contrast state so the container-
 * query refactor (#189) can be reviewed against pixel-identical
 * baselines.
 *
 * Scoped to chromium only. webkit + firefox add baselines that need
 * per-browser tuning (font hinting, sub-pixel rendering) without
 * adding diagnostic value for THIS refactor — the question is whether
 * the container-query migration changed the rendered output on a
 * representative viewport matrix.
 *
 * **Opt-in via `VISUAL_REGRESSION=1`** (not run by default). Reason:
 * Playwright snapshots are platform-suffixed (`-darwin`, `-linux`),
 * font hinting + sub-pixel rendering differ between macOS and Linux,
 * and CI runs on Linux. Committing macOS baselines makes them useful
 * for local review but they'd fail on CI without per-platform
 * regeneration. Run locally with:
 *
 *   PLAYWRIGHT_BROWSERS=chromium VISUAL_REGRESSION=1 \
 *     npx playwright test tests/ui/play-surface-visual.spec.js
 *
 * To accept a visual change after a deliberate UI edit:
 *
 *   PLAYWRIGHT_BROWSERS=chromium VISUAL_REGRESSION=1 \
 *     npx playwright test tests/ui/play-surface-visual.spec.js \
 *     --update-snapshots
 *
 * Matrix covered:
 *   - Viewports: 320, 360, 375, 390, 414, 420, 720, 768, 1024, 1280
 *     (covers iPhone SE up through desktop) plus 800×375 landscape
 *   - Themes: dark (default), light, dark+HC, light+HC
 *
 * Browser zoom intentionally not exercised here — testing zoom
 * meaningfully requires CDP and a separate spec; this baseline is
 * about layout fidelity at native zoom.
 */

const gotoOptions = { waitUntil: "commit" };

const RUN_VISUAL = process.env.VISUAL_REGRESSION === "1";

const VIEWPORTS = [
  { name: "v320x640", width: 320, height: 640 },
  { name: "v360x640", width: 360, height: 640 },
  { name: "v375x667", width: 375, height: 667 },
  { name: "v390x844", width: 390, height: 844 },
  { name: "v414x896", width: 414, height: 896 },
  { name: "v420x844", width: 420, height: 844 },
  { name: "v720x1280", width: 720, height: 1280 },
  { name: "v768x1024", width: 768, height: 1024 },
  { name: "v1024x1366", width: 1024, height: 1366 },
  { name: "v1280x800", width: 1280, height: 800 },
  { name: "v800x375-landscape", width: 800, height: 375 }
];

const THEMES = [
  { name: "dark", theme: "dark", highContrast: false },
  { name: "light", theme: "light", highContrast: false },
  { name: "dark-hc", theme: "dark", highContrast: true },
  { name: "light-hc", theme: "light", highContrast: true }
];

async function preparePage(page, theme) {
  /* `highContrast` isn't applied here — the contrast toggle lives in
     the rendered UI and needs to be clicked after navigation, not
     pre-paint. The caller applies it after the play panel mounts. */
  /* Lock theme via localStorage BEFORE first paint. The shell's pre-
     paint script (public/index.html head) reads `themePreference` from
     localStorage to set `html.theme-{dark,light}`. addInitScript runs
     before any document script, so the theme is right on first paint
     and no flash bleeds into the screenshot. */
  await page.addInitScript((args) => {
    try { localStorage.setItem("themePreference", args.theme); } catch (_e) { /* fail open */ }
  }, { theme });

  /* Suppress motion for stable screenshots — without this, the
     skeleton pulse + any in-flight animation could change pixels
     between runs. */
  await page.emulateMedia({ reducedMotion: "reduce" });
}

for (const browser of ["chromium"]) {
  test.describe(`${browser}: play surface visual regression`, () => {
    test.skip(!RUN_VISUAL, "Opt-in via VISUAL_REGRESSION=1");
    test.skip(({ browserName }) => browserName !== browser, "Chromium-only");

    for (const viewport of VIEWPORTS) {
      for (const themeSpec of THEMES) {
        test(`${viewport.name} · ${themeSpec.name}`, async ({ page }) => {
          test.setTimeout(60000);
          await page.setViewportSize({ width: viewport.width, height: viewport.height });
          await preparePage(page, themeSpec.theme);
          await page.goto("/?word=yfrqp&lang=en", gotoOptions);
          await page.waitForSelector("#playPanel:not(.hidden)", { timeout: 10000 });
          /* Wait for the real board (not the skeleton) before
             screenshot. `#board[aria-busy]` is set during the
             /api/puzzle fetch and cleared once buildBoard runs. */
          await page.waitForFunction(
            () => {
              const b = document.getElementById("board");
              return b && !b.hasAttribute("aria-busy");
            },
            { timeout: 10000 }
          );

          if (themeSpec.highContrast) {
            await page.check("#contrastToggle");
          }

          /* Wait for both self-hosted fonts to be ready, so the
             screenshot is post-swap (no FOIT/FOUT artifacts). */
          await page.evaluate(async () => {
            if (document.fonts && document.fonts.ready) await document.fonts.ready;
          });

          /* Settle: one frame for any final layout pass. */
          await page.evaluate(
            () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))
          );

          await expect(page).toHaveScreenshot(`${viewport.name}-${themeSpec.name}.png`, {
            fullPage: false,
            /* `animations: "disabled"` is redundant after our
               `reducedMotion: "reduce"` emulation but cheap belt-and-
               suspenders for any inline animation that ignores the
               media query. */
            animations: "disabled",
            /* 0.2% pixel diff tolerance — absorbs font-rendering
               sub-pixel jitter without masking real layout shifts.
               If a real shift sneaks through, the diff jumps past
               this floor immediately. */
            maxDiffPixelRatio: 0.002
          });
        });
      }
    }
  });
}
