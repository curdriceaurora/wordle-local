const { test, expect } = require("./fixtures");

// Pins the on-screen keyboard's wide-key sizing.
//
// User-reported regression on the Vercel preview: the "ENTER" label
// overflowed its button. Earlier .key.wide tweaks (flex 1.6 → 2,
// font-size 0.9rem → 0.75rem) helped on the default viewport but the
// label still didn't always fit, especially on narrower layouts where
// flex space is tighter.
//
// Each test loads a play screen so the keyboard renders, then asserts
// that the wide key's content (scrollWidth) fits inside its visible
// box (clientWidth) — i.e. the browser is not silently clipping or
// overflowing the label. The check runs at three representative
// viewports so we catch overflow at any layout breakpoint.

const PLAY_URL = "/?word=yfrqp&lang=en";

const VIEWPORTS = [
  { name: "desktop", width: 1280, height: 800 },
  { name: "tablet", width: 768, height: 1024 },
  { name: "mobile", width: 360, height: 640 }
];

for (const viewport of VIEWPORTS) {
  test(`ENTER on-screen key label fits within its button at ${viewport.name}`, async ({ page }) => {
    await page.setViewportSize({ width: viewport.width, height: viewport.height });
    await page.goto(PLAY_URL, { waitUntil: "commit" });
    await page.waitForSelector('#keyboard button[data-key="ENTER"]');

    const dims = await page.evaluate(() => {
      const btn = document.querySelector('#keyboard button[data-key="ENTER"]');
      const cs = window.getComputedStyle(btn);
      return {
        scrollWidth: btn.scrollWidth,
        clientWidth: btn.clientWidth,
        offsetWidth: btn.offsetWidth,
        text: btn.textContent,
        fontSize: cs.fontSize,
        fontWeight: cs.fontWeight,
        paddingLeft: cs.paddingLeft,
        paddingRight: cs.paddingRight
      };
    });

    expect(
      dims.scrollWidth,
      `ENTER button content overflows its visible width at ${viewport.name} ` +
        `(${viewport.width}×${viewport.height}): scrollWidth=${dims.scrollWidth} ` +
        `clientWidth=${dims.clientWidth} text="${dims.text}" font=${dims.fontSize}/${dims.fontWeight} ` +
        `padding=${dims.paddingLeft}/${dims.paddingRight}`
    ).toBeLessThanOrEqual(dims.clientWidth + 1);
  });
}

test("ENTER and BACK wide keys are visibly wider than letter keys", async ({ page }) => {
  // Sanity check: the .key.wide selector should still apply some extra
  // width versus a regular letter key. If a future CSS change drops the
  // wide modifier we want this test to flag it before it ships.
  await page.goto(PLAY_URL, { waitUntil: "commit" });
  await page.waitForSelector('#keyboard button[data-key="ENTER"]');

  const widths = await page.evaluate(() => {
    const enter = document.querySelector('#keyboard button[data-key="ENTER"]');
    const back = document.querySelector('#keyboard button[data-key="BACK"]');
    const letter = document.querySelector('#keyboard button[data-key="Z"]');
    return {
      enter: enter?.offsetWidth ?? 0,
      back: back?.offsetWidth ?? 0,
      letter: letter?.offsetWidth ?? 0
    };
  });

  expect(widths.enter).toBeGreaterThan(widths.letter);
  expect(widths.back).toBeGreaterThan(widths.letter);
});
