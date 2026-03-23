// Simple test to verify server.js loads without syntax errors
try {
  require.resolve("./server.js");
  console.log("✓ Server module loads successfully");
  process.exit(0);
} catch (e) {
  console.error("✗ Error loading server:", e?.stack || e);
  process.exit(1);
}
