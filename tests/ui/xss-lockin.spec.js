const { test, expect } = require("./fixtures");

// A1 / #114: defensive XSS lock-in. The admin and player shells
// already render dynamic content via `textContent =` + DOM-construction
// APIs, so the live XSS surface is small. These tests verify (a) the
// `window.escapeHtml` helper is loaded everywhere and behaves
// correctly, and (b) representative XSS payloads land as inert text
// in the DOM when injected via supported entry points.

test.describe("XSS lock-in: escapeHtml helper availability", () => {
  test("loaded on player shell", async ({ page }) => {
    await page.goto("/", { waitUntil: "domcontentloaded" });
    const out = await page.evaluate(() => {
      return typeof window.escapeHtml === "function"
        ? window.escapeHtml('<img src=x onerror="alert(1)">')
        : null;
    });
    expect(out).toBe("&lt;img src=x onerror=&quot;alert(1)&quot;&gt;");
  });

  test("loaded on admin shell (locked state)", async ({ page }) => {
    await page.goto("/admin", { waitUntil: "domcontentloaded" });
    const out = await page.evaluate(() => {
      return typeof window.escapeHtml === "function"
        ? window.escapeHtml("'><script>alert(1)</script>")
        : null;
    });
    expect(out).toBe("&#39;&gt;&lt;script&gt;alert(1)&lt;/script&gt;");
  });
});

test.describe("XSS lock-in: ?word= URL param", () => {
  // `?word=<payload>` is the most reachable user-controlled surface
  // on the player shell. The app validates against `/^[a-zA-Z]+$/`
  // and falls back to `showErrorPanel()` for anything else — payloads
  // never reach a render path. Lock that behavior in.
  const PAYLOADS = [
    "<script>window.__pwned=true</script>",
    '<img src=x onerror="window.__pwned=true">',
    "<svg/onload=window.__pwned=true>"
  ];
  for (const payload of PAYLOADS) {
    test(`payload "${payload.slice(0, 20)}..." routes to error panel without executing`, async ({ page }) => {
      const url = `/?word=${encodeURIComponent(payload)}`;
      await page.goto(url, { waitUntil: "domcontentloaded" });
      await expect(page.locator("#errorPanel")).toBeVisible();
      // The canary stays unset — no <script> executed, no img/svg
      // event handler fired.
      const pwned = await page.evaluate(() => Boolean(window.__pwned));
      expect(pwned).toBe(false);
      // No live <script>/<svg> node from the payload was injected into
      // the document body (inputs/textareas store their value as a
      // string attribute, which is not a render-path).
      const liveScripts = await page
        .locator("body :not(input):not(textarea):not(template) script:not([src])")
        .count();
      expect(liveScripts).toBe(0);
    });
  }
});
