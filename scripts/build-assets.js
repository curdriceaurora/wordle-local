const fs = require("fs");
const path = require("path");
const esbuild = require("esbuild");

const root = path.join(__dirname, "..");
const publicDir = path.join(root, "public");
const distDir = path.join(publicDir, "dist");
const adminDir = path.join(publicDir, "admin");
const distAdminDir = path.join(distDir, "admin");

// Wipe dist/ but PRESERVE vendor/ — it's the one subdir of public/dist
// that's committed to git (chart.umd.min.js et al, see .gitignore's
// `!public/dist/vendor/`). A blanket rmSync would delete those tracked
// files and dirty the working tree on every build, which previously
// happened. The /dist/vendor express mount in server.js reads from
// PUBLIC_ROOT/dist/vendor regardless of dist mode, so the directory
// must continue to exist.
if (fs.existsSync(distDir)) {
  for (const entry of fs.readdirSync(distDir)) {
    if (entry === "vendor") continue;
    fs.rmSync(path.join(distDir, entry), { recursive: true, force: true });
  }
} else {
  fs.mkdirSync(distDir, { recursive: true });
}
fs.mkdirSync(distAdminDir, { recursive: true });

async function build() {
  await esbuild.build({
    entryPoints: [path.join(publicDir, "app.js")],
    outfile: path.join(distDir, "app.js"),
    minify: true,
    bundle: false,
    target: "es2017"
  });

  await esbuild.build({
    entryPoints: [path.join(publicDir, "styles.css")],
    outfile: path.join(distDir, "styles.css"),
    minify: true,
    loader: { ".css": "css" }
  });

  await esbuild.build({
    entryPoints: [path.join(adminDir, "app.js")],
    outfile: path.join(distAdminDir, "app.js"),
    minify: true,
    bundle: false,
    target: "es2017"
  });

  await esbuild.build({
    entryPoints: [path.join(adminDir, "admin.css")],
    outfile: path.join(distAdminDir, "admin.css"),
    minify: true,
    loader: { ".css": "css" }
  });

  fs.copyFileSync(path.join(publicDir, "index.html"), path.join(distDir, "index.html"));
  fs.copyFileSync(path.join(adminDir, "index.html"), path.join(distAdminDir, "index.html"));

  // Copy public/js/ verbatim — these are UMD-style helper scripts
  // (escape-html.js, i18n.js, random-name.js) loaded by `<script>`
  // tags in index.html. They're not bundled into app.js because each
  // is independently re-usable; the build pipeline therefore needs
  // to ship them alongside the minified app.js. Without this, any
  // /js/*.js URL 404s in dist mode. Codex P1 on PR #180 (#174).
  fs.cpSync(path.join(publicDir, "js"), path.join(distDir, "js"), { recursive: true });

  // Copy PWA assets: the service worker, web app manifest, and icon
  // set. PUBLIC_PATH flips to public/dist when dist/index.html exists,
  // so the express.static mount at server.js:3562 will 404 any of
  // these if they aren't present in dist — breaking PWA install on
  // production (Vercel) and the pwa.test.js suite locally. Codex P2
  // on PR #180 about the new pickRandomName precache only matters
  // if sw.js itself reaches dist, so this copy was always required.
  fs.copyFileSync(path.join(publicDir, "sw.js"), path.join(distDir, "sw.js"));
  fs.copyFileSync(path.join(publicDir, "manifest.json"), path.join(distDir, "manifest.json"));
  fs.cpSync(path.join(publicDir, "icons"), path.join(distDir, "icons"), { recursive: true });
  // Self-hosted fonts (issue #187). Without this copy, dist-mode
  // (Vercel, Docker) silently 404s on `/fonts/*` and the typography
  // falls back to the system stack. Codex P2 on PR #195.
  fs.cpSync(path.join(publicDir, "fonts"), path.join(distDir, "fonts"), { recursive: true });
  // i18n locale JSON. The user-locale switcher fetches /locales/es.json
  // when the user opts in; without this copy, dist-mode 404s and the
  // switch silently no-ops to English. (The default-locale `en.json`
  // is also served pre-bundled via the /js/i18n-en.js server route,
  // which reads from PUBLIC_ROOT regardless of dist mode and is
  // unaffected.)
  fs.cpSync(path.join(publicDir, "locales"), path.join(distDir, "locales"), { recursive: true });

  // Warn if dist/vendor is missing — those are tracked runtime assets
  // (chart.umd.min.js et al, see .gitignore's `!public/dist/vendor/`)
  // served via the `/dist/vendor` express mount in server.js. If a
  // user wipes public/dist before building (e.g. `rm -rf public/dist
  // && npm run build`), vendor won't be re-created and the admin
  // shell's chart will 404. Caught by Copilot on PR #180.
  if (!fs.existsSync(path.join(distDir, "vendor"))) {
    console.warn(
      "WARN: public/dist/vendor/ is missing. Run `git checkout -- public/dist/vendor/` to restore the tracked vendor bundles before serving."
    );
  }
}

build().catch((err) => {
  console.error(err);
  process.exit(1);
});
