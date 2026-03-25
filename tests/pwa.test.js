const fs = require("fs");
const path = require("path");
const request = require("supertest");

function loadApp() {
  jest.resetModules();
  return require("../server");
}

let app;

describe("Progressive Web App (PWA)", () => {
  beforeAll(() => {
    app = loadApp();
  });

  describe("Web App Manifest", () => {
    test("manifest.json exists in public directory", () => {
      const manifestPath = path.join(__dirname, "..", "public", "manifest.json");
      expect(fs.existsSync(manifestPath)).toBe(true);
    });

    test("manifest.json is valid JSON", () => {
      const manifestPath = path.join(__dirname, "..", "public", "manifest.json");
      const manifestContent = fs.readFileSync(manifestPath, "utf8");
      expect(() => JSON.parse(manifestContent)).not.toThrow();
    });

    test("manifest.json contains required PWA fields", () => {
      const manifestPath = path.join(__dirname, "..", "public", "manifest.json");
      const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));

      expect(manifest).toHaveProperty("name");
      expect(manifest).toHaveProperty("short_name");
      expect(manifest).toHaveProperty("start_url");
      expect(manifest).toHaveProperty("display");
      expect(manifest).toHaveProperty("icons");
      expect(manifest).toHaveProperty("theme_color");
      expect(manifest).toHaveProperty("background_color");
    });

    test("manifest.json icons array has required sizes (192px and 512px)", () => {
      const manifestPath = path.join(__dirname, "..", "public", "manifest.json");
      const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));

      expect(Array.isArray(manifest.icons)).toBe(true);
      expect(manifest.icons.length).toBeGreaterThanOrEqual(2);

      const iconSizes = manifest.icons.map(icon => icon.sizes);
      expect(iconSizes).toContain("192x192");
      expect(iconSizes).toContain("512x512");
    });

    test("manifest.json display mode is set to standalone", () => {
      const manifestPath = path.join(__dirname, "..", "public", "manifest.json");
      const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));

      expect(manifest.display).toBe("standalone");
    });

    test("GET /manifest.json returns 200 status", async () => {
      const response = await request(app).get("/manifest.json");
      expect(response.status).toBe(200);
    });

    test("GET /manifest.json returns correct MIME type", async () => {
      const response = await request(app).get("/manifest.json");
      expect(response.headers["content-type"]).toMatch(/application\/manifest\+json/);
    });

    test("GET /manifest.json returns valid JSON", async () => {
      const response = await request(app).get("/manifest.json");
      expect(() => JSON.parse(response.text)).not.toThrow();
    });
  });

  describe("App Icons", () => {
    test("192px icon exists in public/icons directory", () => {
      const iconPath = path.join(__dirname, "..", "public", "icons", "icon-192.png");
      expect(fs.existsSync(iconPath)).toBe(true);
    });

    test("512px icon exists in public/icons directory", () => {
      const iconPath = path.join(__dirname, "..", "public", "icons", "icon-512.png");
      expect(fs.existsSync(iconPath)).toBe(true);
    });

    test("192px icon is a valid PNG file (has PNG signature)", () => {
      const iconPath = path.join(__dirname, "..", "public", "icons", "icon-192.png");
      const buffer = fs.readFileSync(iconPath);
      const pngSignature = Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]);
      expect(buffer.slice(0, 8).equals(pngSignature)).toBe(true);
    });

    test("512px icon is a valid PNG file (has PNG signature)", () => {
      const iconPath = path.join(__dirname, "..", "public", "icons", "icon-512.png");
      const buffer = fs.readFileSync(iconPath);
      const pngSignature = Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]);
      expect(buffer.slice(0, 8).equals(pngSignature)).toBe(true);
    });

    test("GET /icons/icon-192.png returns 200 status", async () => {
      const response = await request(app).get("/icons/icon-192.png");
      expect(response.status).toBe(200);
    });

    test("GET /icons/icon-512.png returns 200 status", async () => {
      const response = await request(app).get("/icons/icon-512.png");
      expect(response.status).toBe(200);
    });

    test("GET /icons/icon-192.png returns correct MIME type", async () => {
      const response = await request(app).get("/icons/icon-192.png");
      expect(response.headers["content-type"]).toMatch(/image\/png/);
    });

    test("GET /icons/icon-512.png returns correct MIME type", async () => {
      const response = await request(app).get("/icons/icon-512.png");
      expect(response.headers["content-type"]).toMatch(/image\/png/);
    });
  });

  describe("Service Worker", () => {
    test("sw.js exists in public directory", () => {
      const swPath = path.join(__dirname, "..", "public", "sw.js");
      expect(fs.existsSync(swPath)).toBe(true);
    });

    test("sw.js contains install event listener", () => {
      const swPath = path.join(__dirname, "..", "public", "sw.js");
      const swContent = fs.readFileSync(swPath, "utf8");
      expect(swContent).toMatch(/self\.addEventListener\s*\(\s*['"]install['"]/);
    });

    test("sw.js contains fetch event listener", () => {
      const swPath = path.join(__dirname, "..", "public", "sw.js");
      const swContent = fs.readFileSync(swPath, "utf8");
      expect(swContent).toMatch(/self\.addEventListener\s*\(\s*['"]fetch['"]/);
    });

    test("sw.js contains activate event listener", () => {
      const swPath = path.join(__dirname, "..", "public", "sw.js");
      const swContent = fs.readFileSync(swPath, "utf8");
      expect(swContent).toMatch(/self\.addEventListener\s*\(\s*['"]activate['"]/);
    });

    test("sw.js defines cache name", () => {
      const swPath = path.join(__dirname, "..", "public", "sw.js");
      const swContent = fs.readFileSync(swPath, "utf8");
      expect(swContent).toMatch(/CACHE_NAME|cacheName|cacheVersion/i);
    });

    test("GET /sw.js returns 200 status", async () => {
      const response = await request(app).get("/sw.js");
      expect(response.status).toBe(200);
    });

    test("GET /sw.js returns correct MIME type", async () => {
      const response = await request(app).get("/sw.js");
      expect(response.headers["content-type"]).toMatch(/application\/javascript|text\/javascript/);
    });
  });

  describe("HTML Integration", () => {
    test("index.html contains manifest link", () => {
      const indexPath = path.join(__dirname, "..", "public", "index.html");
      const indexContent = fs.readFileSync(indexPath, "utf8");
      expect(indexContent).toMatch(/<link[^>]*rel=["']manifest["'][^>]*>/);
      expect(indexContent).toMatch(/manifest\.json/);
    });

    test("index.html contains theme-color meta tag", () => {
      const indexPath = path.join(__dirname, "..", "public", "index.html");
      const indexContent = fs.readFileSync(indexPath, "utf8");
      expect(indexContent).toMatch(/<meta[^>]*name=["']theme-color["'][^>]*>/);
    });

    test("admin/index.html contains manifest link", () => {
      const adminIndexPath = path.join(__dirname, "..", "public", "admin", "index.html");
      const adminIndexContent = fs.readFileSync(adminIndexPath, "utf8");
      expect(adminIndexContent).toMatch(/<link[^>]*rel=["']manifest["'][^>]*>/);
      expect(adminIndexContent).toMatch(/manifest\.json/);
    });

    test("admin/index.html contains theme-color meta tag", () => {
      const adminIndexPath = path.join(__dirname, "..", "public", "admin", "index.html");
      const adminIndexContent = fs.readFileSync(adminIndexPath, "utf8");
      expect(adminIndexContent).toMatch(/<meta[^>]*name=["']theme-color["'][^>]*>/);
    });
  });

  describe("Service Worker Registration", () => {
    test("app.js contains service worker registration code", () => {
      const appJsPath = path.join(__dirname, "..", "public", "app.js");
      const appJsContent = fs.readFileSync(appJsPath, "utf8");
      expect(appJsContent).toMatch(/navigator\.serviceWorker/);
      expect(appJsContent).toMatch(/\.register\s*\(/);
    });

    test("app.js registers service worker at /sw.js", () => {
      const appJsPath = path.join(__dirname, "..", "public", "app.js");
      const appJsContent = fs.readFileSync(appJsPath, "utf8");
      expect(appJsContent).toMatch(/register\s*\(\s*['"]\/sw\.js['"]/);
    });

    test("admin/app.js contains service worker registration code", () => {
      const adminAppJsPath = path.join(__dirname, "..", "public", "admin", "app.js");
      const adminAppJsContent = fs.readFileSync(adminAppJsPath, "utf8");
      expect(adminAppJsContent).toMatch(/navigator\.serviceWorker/);
      expect(adminAppJsContent).toMatch(/\.register\s*\(/);
    });

    test("admin/app.js registers service worker at /sw.js (not /admin-sw.js)", () => {
      const adminAppJsPath = path.join(__dirname, "..", "public", "admin", "app.js");
      const adminAppJsContent = fs.readFileSync(adminAppJsPath, "utf8");
      expect(adminAppJsContent).toMatch(/register\s*\(\s*['"]\/sw\.js['"]/);
      expect(adminAppJsContent).not.toMatch(/register\s*\(\s*['"]\/admin-sw\.js['"]/);
    });
  });

  describe("Service Worker Offline Fallback", () => {
    test("sw.js handles offline navigation with appropriate fallback", () => {
      const swPath = path.join(__dirname, "..", "public", "sw.js");
      const swContent = fs.readFileSync(swPath, "utf8");

      // Service worker should handle offline navigation requests
      expect(swContent).toMatch(/navigate|navigation/i);

      // Should have logic to determine which index.html to serve based on URL
      const hasAdminLogic = swContent.includes("/admin") && swContent.includes("/admin/index.html");
      const hasMainLogic = swContent.includes("/index.html");

      expect(hasAdminLogic || hasMainLogic).toBe(true);
    });

    test("sw.js routes admin URLs to /admin/index.html fallback", () => {
      const swPath = path.join(__dirname, "..", "public", "sw.js");
      const swContent = fs.readFileSync(swPath, "utf8");

      // Should detect admin URLs
      expect(swContent).toMatch(/\/admin/);

      // Should serve admin/index.html for admin routes
      expect(swContent).toMatch(/\/admin\/index\.html/);
    });
  });

  describe("PWA Cache Strategy", () => {
    test("sw.js defines assets to cache on install", () => {
      const swPath = path.join(__dirname, "..", "public", "sw.js");
      const swContent = fs.readFileSync(swPath, "utf8");

      // Should cache assets during install
      expect(swContent).toMatch(/self\.addEventListener\s*\(\s*['"]install['"]/);
      expect(swContent).toMatch(/cache\.addAll\s*\(/);
    });

    test("sw.js caches core HTML files", () => {
      const swPath = path.join(__dirname, "..", "public", "sw.js");
      const swContent = fs.readFileSync(swPath, "utf8");

      // Should cache at least one HTML file
      expect(swContent).toMatch(/['"]\/(index\.html|admin\/index\.html)['"]/);
    });

    test("sw.js caches manifest.json", () => {
      const swPath = path.join(__dirname, "..", "public", "sw.js");
      const swContent = fs.readFileSync(swPath, "utf8");

      expect(swContent).toMatch(/['"]\/manifest\.json['"]/);
    });

    test("sw.js caches app icons", () => {
      const swPath = path.join(__dirname, "..", "public", "sw.js");
      const swContent = fs.readFileSync(swPath, "utf8");

      expect(swContent).toMatch(/['"]\/icons\/icon-192\.png['"]/);
      expect(swContent).toMatch(/['"]\/icons\/icon-512\.png['"]/);
    });
  });
});
