// Simple test to verify server.js loads without syntax errors
try {
  require('./server.js');
  console.log('✓ Server module loads successfully');
  process.exit(0);
} catch(e) {
  console.error('✗ Error loading server:', e.message);
  process.exit(1);
}
