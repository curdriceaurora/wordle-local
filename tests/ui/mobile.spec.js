const { test, expect } = require("@playwright/test");

const viewports = [
  { name: "iphone-13", width: 390, height: 844 },
  { name: "pixel-7", width: 412, height: 915 }
];

for (const viewport of viewports) {
  test(`mobile layout stays within viewport (${viewport.name})`, async ({ page }) => {
    await page.setViewportSize({ width: viewport.width, height: viewport.height });
    await page.goto("/");
    await page.selectOption("#langSelect", "none");
    await page.fill("#wordInput", "JACKS");
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
