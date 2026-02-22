const fs = require("fs");
const path = require("path");
const esbuild = require("esbuild");

const root = path.join(__dirname, "..");
const publicDir = path.join(root, "public");
const distDir = path.join(publicDir, "dist");
const adminDir = path.join(publicDir, "admin");
const distAdminDir = path.join(distDir, "admin");

fs.rmSync(distDir, { recursive: true, force: true });
fs.mkdirSync(distDir, { recursive: true });
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
}

build().catch((err) => {
  console.error(err);
  process.exit(1);
});
