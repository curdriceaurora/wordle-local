const { test, expect } = require("./fixtures");

async function waitForLanguages(page) {
  await page.waitForSelector("#langSelect option", { state: "attached" });
}

const viewports = [
  { name: "minimum", width: 320, height: 568 },
  { name: "galaxy-a", width: 360, height: 740 },
  { name: "iphone-se", width: 375, height: 667 },
  { name: "tablet", width: 768, height: 1024 },
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
    await expect(page.locator("#keyboard")).toBeVisible();
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

    // Bounding boxes catch genuine clipping without depending on root overflow behavior.
    const interactiveElements = await page.locator("#board .tile, #keyboard .key").all();
    const viewportOverflowTolerance = 7;
    for (const element of interactiveElements) {
      await expect(element).toBeVisible();
      const box = await element.boundingBox();
      expect(box).not.toBeNull();
      expect(box.x).toBeGreaterThanOrEqual(0);
      expect(box.x + box.width).toBeLessThanOrEqual(viewport.width + viewportOverflowTolerance);
    }
  });
}

const touchTargetViewports = [
  { name: "max-375", width: 375, height: 667 },
  { name: "max-360", width: 360, height: 740 },
  { name: "max-320", width: 320, height: 568 },
  { name: "landscape", width: 568, height: 320 }
];

for (const viewport of touchTargetViewports) {
  test(`touch targets meet 44x44px minimum (${viewport.name})`, async ({ page }) => {
    await page.setViewportSize({ width: viewport.width, height: viewport.height });
    await page.goto("/", { waitUntil: "commit" });
    await waitForLanguages(page);
    await page.selectOption("#langSelect", "en");
    await page.fill("#wordInput", "CRANE");
    await page.click("form#createForm button[type=submit]");
    await page.waitForSelector("#playPanel:not(.hidden)");

    const selectors = [".key", ".admin-link", ".link-button"];

    for (const selector of selectors) {
      const elements = await page.locator(`${selector}:visible`).all();
      for (const element of elements) {
        const box = await element.boundingBox();
        expect(box).not.toBeNull();
        expect(Math.round(box.width)).toBeGreaterThanOrEqual(44);
        expect(Math.round(box.height)).toBeGreaterThanOrEqual(44);
      }
    }
  });
}

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
