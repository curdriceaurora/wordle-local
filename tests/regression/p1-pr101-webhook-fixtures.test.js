"use strict";

// Historical P1 regression fixture from PR #101 (C4 / #130).
//
// PR #101 introduced webhook-service. A review round caught an SSRF
// gap in the private-network guard.
//
// Reproduction protocol — the test is designed to fail when run
// against the PR-internal pre-fix commit:
//   git worktree add /tmp/wt-pre101 06e7c55
//   cp tests/regression/p1-pr101-webhook-fixtures.test.js \
//     /tmp/wt-pre101/tests/regression/
//   cd /tmp/wt-pre101 && node node_modules/.bin/jest \
//     tests/regression/p1-pr101-webhook-fixtures.test.js
//   # Expect: both tests fail.

const { isPrivateIPv6, assertOutboundUrlAllowed } = require("../../lib/webhook-service.js");

// Pins P1 from #101 (pre-fix commit 06e7c55): "Block the IPv6
// unspecified address".
//
// Pre-fix symptom: isPrivateIPv6 only checked ::1, link-local
// (fe80::/10), and ULA (fc00::/7). The unspecified literal `::`
// passed through. A subscription URL like `http://[::]:<port>/`
// would let the webhook dispatcher SSRF into the host's loopback
// stack (Linux/macOS bind-all servers accept connections on `::`
// equivalent to 0.0.0.0). Post-fix `::` (and "::ffff:0.0.0.0" etc.)
// are rejected.
describe("P1 fixture: PR #101 — IPv6 unspecified address blocked by SSRF guard", () => {
  test("isPrivateIPv6('::') returns true (was false pre-fix)", () => {
    expect(isPrivateIPv6("::")).toBe(true);
  });

  test("assertOutboundUrlAllowed rejects http://[::]:port/ with PRIVATE_ADDRESS_BLOCKED", async () => {
    await expect(
      assertOutboundUrlAllowed("http://[::]:3000/webhook")
    ).rejects.toMatchObject({ code: "PRIVATE_ADDRESS_BLOCKED" });
  });
});
