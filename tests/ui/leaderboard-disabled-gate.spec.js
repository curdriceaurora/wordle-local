// Regression guard for PR #160 Codex finding (P2): when /api/meta
// reports `leaderboardEnabled: false`, opening any gameplay path
// (including a daily share URL like /?word=...&daily=1) must NOT
// issue any /api/stats/* request. Without this gate, the daily-share
// init path was resetting `statsServiceUnavailable` to false and
// firing leaderboard/profile fetches that 404 on a deploy that
// doesn't ship the stats backend.
const { test, expect } = require("./fixtures");

test.describe("leaderboard disabled by /api/meta deploy cap", () => {
  for (const route of [
    { name: "create page", url: "/" },
    { name: "play (encoded share)", url: "/?word=yfrqp&lang=en" },
    { name: "daily share URL", url: "/?word=yfrqp&lang=en&daily=1" }
  ]) {
    test(`no /api/stats/* requests on ${route.name}`, async ({ page }) => {
      const statsRequests = [];
      page.on("request", (req) => {
        const url = req.url();
        if (url.includes("/api/stats/")) statsRequests.push(url);
      });

      // Stub /api/meta to return the Vercel deploy cap shape.
      await page.route("**/api/meta", (r) =>
        r.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({
            minLength: 3,
            maxLength: 12,
            minGuesses: 4,
            maxGuesses: 10,
            defaultGuesses: 6,
            languages: [{ id: "en", label: "English", minLength: 3 }],
            defaultLang: "en",
            perfLogging: false,
            definitionsMode: "off",
            dailyWordEnabled: false,
            leaderboardEnabled: false,
            challengesEnabled: false,
            notificationsEnabled: false
          })
        })
      );

      await page.goto(route.url);
      // Give init() + initChallengesUI() + initPlay() time to run their
      // bootstraps; if a stats fetch were going to fire it would be in
      // this window.
      await page.waitForTimeout(1000);

      expect(
        statsRequests,
        `expected zero /api/stats/* fetches but got: ${statsRequests.join(", ")}`
      ).toEqual([]);
    });
  }
});
