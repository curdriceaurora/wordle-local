const { test, expect } = require("./fixtures");

test("ignores non-letter keyboard input", async ({ page }) => {
  await page.goto("/?word=fotnd&lang=none", { waitUntil: "commit" });
  await page.waitForSelector("#board");
  await page.waitForSelector("#keyboard .key");
  await page.keyboard.type("A1!");
  await expect(page.locator("#board .row:nth-child(1) .tile.filled")).toHaveCount(1);
  await expect(page.locator('#board .row:nth-child(1) .tile[data-col="0"]')).toContainText("A");
});

test("backspace removes the last letter", async ({ page }) => {
  await page.goto("/?word=fotnd&lang=none", { waitUntil: "commit" });
  await page.waitForSelector("#board");
  await page.waitForSelector("#keyboard .key");
  await page.keyboard.type("ABC");
  await page.click('button[data-key="BACK"]');
  await expect(page.locator("#board .row:nth-child(1) .tile.filled")).toHaveCount(2);
  await expect(page.locator('#board .row:nth-child(1) .tile[data-col="2"]')).toHaveText("");
});
