const { test, expect } = require("./fixtures");

test("index response is not cached", async ({ page }) => {
  const response = await page.request.get("/");
  expect(response.ok()).toBe(true);
  const headers = response.headers();
  expect(headers["cache-control"]).toContain("no-store");
});
