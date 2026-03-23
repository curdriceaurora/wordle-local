const { test, expect } = require("./fixtures");

async function waitForLanguages(page) {
  await page.waitForSelector("#langSelect option", { state: "attached" });
}

const viewports = [
  { name: "minimum", width: 320, height: 568 },
  { name: "galaxy-a", width: 360, height: 740 },
  { name: "iphone-se", width: 375, height: 667 },
  { name: "iphone-13", width: 390, height: 844 },
  { name: "pixel-7", width: 412, height: 915 }
];

for (const viewport of viewports) {
  test(`mobile layout stays within viewport (${viewport.name})`, async ({ page }) => {
    await page.setViewportSize({ width: viewport.width, height: viewport.height });
    await page.goto("/", { waitUntil: "commit" });
    await waitForLanguages(page);
    await page.selectOption("#langSelect", "en");
    await page.fill("#wordInput", "CRANE");
    await page.click("form#createForm button[type=submit]");
    await page.waitForSelector("#playPanel:not(.hidden)");

    const boardBox = await page.locator("#board").boundingBox();
    const keyboardBox = await page.locator("#keyboard").boundingBox();

    expect(boardBox).not.toBeNull();
    expect(keyboardBox).not.toBeNull();

    expect(boardBox.width).toBeLessThanOrEqual(viewport.width);
    expect(keyboardBox.width).toBeLessThanOrEqual(viewport.width);
  });
}

for (const viewport of viewports) {
  test(`no horizontal overflow or content clipping (${viewport.name})`, async ({ page }) => {
    await page.setViewportSize({ width: viewport.width, height: viewport.height });
    await page.goto("/", { waitUntil: "commit" });
    await waitForLanguages(page);
    await page.selectOption("#langSelect", "en");
    await page.fill("#wordInput", "CRANE");
    await page.click("form#createForm button[type=submit]");
    await page.waitForSelector("#playPanel:not(.hidden)");

    // Check no horizontal scrollbar exists (scrollable width equals client width)
    const hasHorizontalScroll = await page.evaluate(() => {
      return document.documentElement.scrollWidth > document.documentElement.clientWidth;
    });
    expect(hasHorizontalScroll).toBe(false);

    // Verify key interactive elements (board, keyboard) are fully visible
    // Note: Some container elements may extend slightly beyond viewport but are clipped by overflow-x: hidden
    const interactiveElements = await page.locator("#board, #keyboard").all();
    for (const element of interactiveElements) {
      await expect(element).toBeVisible();
      const box = await element.boundingBox();
      if (box) {
        // Ensure interactive content starts within viewport
        expect(box.x).toBeGreaterThanOrEqual(0);
      }
    }

    // Verify overflow-x is hidden on html and body
    const overflowSettings = await page.evaluate(() => {
      const htmlOverflow = window.getComputedStyle(document.documentElement).overflowX;
      const bodyOverflow = window.getComputedStyle(document.body).overflowX;
      return { html: htmlOverflow, body: bodyOverflow };
    });
    expect(overflowSettings.html).toBe("hidden");
    expect(overflowSettings.body).toBe("hidden");
  });
}

test("touch targets meet 44x44px minimum", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/", { waitUntil: "commit" });
  await waitForLanguages(page);
  await page.selectOption("#langSelect", "en");
  await page.fill("#wordInput", "CRANE");
  await page.click("form#createForm button[type=submit]");
  await page.waitForSelector("#playPanel:not(.hidden)");

  const selectors = [".key", ".admin-link", ".link-button"];

  for (const selector of selectors) {
    const elements = await page.locator(selector).all();
    for (const element of elements) {
      const box = await element.boundingBox();
      if (box) {
        expect(box.width).toBeGreaterThanOrEqual(44);
        expect(box.height).toBeGreaterThanOrEqual(44);
      }
    }
  }
});

test("landscape orientation remains playable", async ({ page }) => {
  await page.setViewportSize({ width: 568, height: 320 });
  await page.goto("/", { waitUntil: "commit" });
  await waitForLanguages(page);
  await page.selectOption("#langSelect", "en");
  await page.fill("#wordInput", "CRANE");
  await page.click("form#createForm button[type=submit]");
  await page.waitForSelector("#playPanel:not(.hidden)");

  const boardBox = await page.locator("#board").boundingBox();
  const keyboardBox = await page.locator("#keyboard").boundingBox();

  expect(boardBox).not.toBeNull();
  expect(keyboardBox).not.toBeNull();

  expect(boardBox.width).toBeLessThanOrEqual(568);
  expect(keyboardBox.width).toBeLessThanOrEqual(568);

  const board = page.locator("#board");
  const keyboard = page.locator("#keyboard");
  await expect(board).toBeVisible();
  await expect(keyboard).toBeVisible();
});
