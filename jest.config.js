module.exports = {
  testEnvironment: "node",
  testMatch: ["**/tests/**/*.test.js"],
  testPathIgnorePatterns: ["/node_modules/", "/.auto-claude/"],
  testTimeout: 15000
};
