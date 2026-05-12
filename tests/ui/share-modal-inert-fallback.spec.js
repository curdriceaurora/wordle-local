// Verifies the share modal's inert fallback. On the real browser
// (inert-supporting) both paths behave correctly; we also forcibly
// disable inert support to drive the tabindex fallback and confirm
// the Close button is not Tab-reachable when the modal is closed,
// AND that the round-trip open → close restores cleanly.
const { test, expect } = require("./fixtures");

test("share modal hides Close from Tab when closed (inert path)", async ({ page }) => {
  await page.goto("/");
  await page.waitForSelector("#shareModal", { state: "attached" });

  // Initial state: modal closed, has `inert` attribute.
  const hasInert = await page.evaluate(() =>
    document.getElementById("shareModal").hasAttribute("inert")
  );
  expect(hasInert).toBe(true);

  // Sanity: focus walk doesn't reach #shareModalClose while closed.
  // "Reachable" = the button is focusable AND the modal isn't inert.
  // Either disqualifier (already focused/tabbable while inert, or not
  // focusable in the first place) means it's safely out of the tab
  // sequence.
  const reachableClosed = await page.evaluate(() => {
    const close = document.getElementById("shareModalClose");
    const modal = document.getElementById("shareModal");
    const focusable = close.matches(":focus") || close.tabIndex >= 0;
    return focusable && !modal.hasAttribute("inert");
  });
  expect(reachableClosed).toBe(false);
});

test("share modal inert fallback: full open/close round-trip on a browser without `inert`", async ({ page }) => {
  // Strip inert support BEFORE page scripts run so SUPPORTS_INERT
  // evaluates to false on bootstrap and the fallback path takes over.
  await page.addInitScript(() => {
    try {
      Object.defineProperty(HTMLElement.prototype, "inert", { configurable: true });
      delete HTMLElement.prototype.inert;
    } catch (_e) {
      /* feature-removal best effort */
    }
  });

  // Navigate via an encoded share link so #playPanel becomes visible
  // (the create-page DOM has #shareInfoBtn under .hidden, so a real
  // click can't open the modal from /). Driving to play state means
  // we exercise the full open/close round-trip through the same
  // listeners a user would.
  await page.goto("/?word=yfrqp&lang=en");
  await page.waitForSelector("#shareInfoBtn", { state: "visible" });

  // --- 1. INACTIVE (closed) ---
  // Save side: tabindex stashed, data-inert-tabindex remembers prior
  // absence, AND inert is still toggled (the function always sets it
  // regardless of browser support so the DOM is internally consistent).
  await page.waitForFunction(() =>
    document.getElementById("shareModalClose").getAttribute("data-inert-tabindex") !== null
  );
  const closedSave = await page.evaluate(() => {
    const close = document.getElementById("shareModalClose");
    const modal = document.getElementById("shareModal");
    return {
      tabindex: close.getAttribute("tabindex"),
      remembered: close.getAttribute("data-inert-tabindex"),
      modalHasInert: modal.hasAttribute("inert"),
      remainingStashedNodes: modal.querySelectorAll("[data-inert-tabindex]").length
    };
  });
  expect(closedSave.tabindex).toBe("-1");
  expect(closedSave.remembered).toBe("__none__");
  expect(closedSave.modalHasInert).toBe(true);
  expect(closedSave.remainingStashedNodes).toBeGreaterThan(0);

  // --- 2. OPEN ---
  // Real click on the same trigger a keyboard/AT user would use.
  await page.click("#shareInfoBtn");
  await page.waitForFunction(() =>
    document.getElementById("shareModal").classList.contains("is-open")
  );

  // Restore side: inert removed, tabindex cleared, data-inert-tabindex
  // wiped from every focusable in the modal (no stashed nodes remain).
  const openedRestore = await page.evaluate(() => {
    const close = document.getElementById("shareModalClose");
    const modal = document.getElementById("shareModal");
    return {
      tabindex: close.getAttribute("tabindex"),
      remembered: close.getAttribute("data-inert-tabindex"),
      modalHasInert: modal.hasAttribute("inert"),
      remainingStashedNodes: modal.querySelectorAll("[data-inert-tabindex]").length
    };
  });
  expect(openedRestore.tabindex).toBeNull();
  expect(openedRestore.remembered).toBeNull();
  expect(openedRestore.modalHasInert).toBe(false);
  expect(openedRestore.remainingStashedNodes).toBe(0);

  // --- 3. CLOSE again ---
  // Escape is the documented close path; verify the save side comes
  // back identically after a real round-trip (regression guard against
  // the function leaking state across cycles).
  await page.keyboard.press("Escape");
  await page.waitForFunction(() =>
    !document.getElementById("shareModal").classList.contains("is-open")
  );

  const closedSaveAgain = await page.evaluate(() => {
    const close = document.getElementById("shareModalClose");
    const modal = document.getElementById("shareModal");
    return {
      tabindex: close.getAttribute("tabindex"),
      remembered: close.getAttribute("data-inert-tabindex"),
      modalHasInert: modal.hasAttribute("inert")
    };
  });
  expect(closedSaveAgain.tabindex).toBe("-1");
  expect(closedSaveAgain.remembered).toBe("__none__");
  expect(closedSaveAgain.modalHasInert).toBe(true);
});
