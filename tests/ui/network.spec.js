const { test, expect } = require("./fixtures");

test("index response is not cached", async ({ page }) => {
  const response = await page.goto("/", { waitUntil: "domcontentloaded" });
  expect(response).not.toBeNull();
  const headers = response.headers();
  expect(headers["cache-control"]).toContain("no-store");
});
