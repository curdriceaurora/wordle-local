#!/usr/bin/env node
"use strict";

// Mechanical verification of factual claims in README + docs/*.md
// against the actual codebase. Catches the kind of doc-vs-code drift
// that drove a lot of #106's review-round churn — "Node 18+" claims
// that should have been "Node 20+", broken `docs/X.md` links,
// references to npm scripts that don't exist, env vars not in
// `.env.example`, and so on.
//
// Failures here block `npm run check`. To opt out of a specific
// check on a single line, append the HTML comment `<!-- claim:skip -->`
// to that line — the line is then skipped for ALL checks. Use
// sparingly; most "skips" should instead become real claims.
//
// What this script DOES NOT do:
//
//   - Validate prose claims about behavior. "The gate covers /admin"
//     is structurally a claim, but mapping it to a verifiable code
//     reference requires NLP. Reviewers (and the
//     human review and source verification catch those.
//   - Parse markdown structure perfectly. Uses pragmatic regex on
//     code-fence contents and inline-code spans. False negatives
//     (claims we miss) are acceptable; false positives (claims we
//     flag wrongly) are not.

const fs = require("fs");
const path = require("path");

const projectRoot = path.resolve(__dirname, "..");

// ---------- Inputs from the codebase ----------

function readDockerfileNodeMajor() {
  const dockerfile = path.join(projectRoot, "Dockerfile");
  if (!fs.existsSync(dockerfile)) return null;
  const contents = fs.readFileSync(dockerfile, "utf8");
  const match = contents.match(/^FROM\s+node:(\d+)/m);
  return match ? parseInt(match[1], 10) : null;
}

function readKnownEnvVars() {
  const envExample = path.join(projectRoot, ".env.example");
  if (!fs.existsSync(envExample)) return new Set();
  const contents = fs.readFileSync(envExample, "utf8");
  const out = new Set();
  for (const line of contents.split(/\r?\n/)) {
    // Match both active assignments (`FOO=value`) and the commented-
    // out form (`# FOO=value` / `#FOO=value`) used in `.env.example`
    // to document optional vars. A future doc
    // example like `WEBHOOKS_ENABLED=true npm start` would have
    // failed claims:check even though `.env.example` documents it
    // as a commented optional.
    const m = line.match(/^[ \t]*#?[ \t]*([A-Z][A-Z0-9_]+)=/);
    if (m) out.add(m[1]);
  }
  return out;
}

function readKnownNpmScripts() {
  const pkg = JSON.parse(
    fs.readFileSync(path.join(projectRoot, "package.json"), "utf8")
  );
  return new Set(Object.keys(pkg.scripts || {}));
}

// Discover all markdown files in scope: README.md + every .md under
// docs/ (recursively). Excludes node_modules, .auto-claude, and .git.
function findMarkdownFiles() {
  const out = [];
  const top = path.join(projectRoot, "README.md");
  if (fs.existsSync(top)) out.push(top);
  const docsRoot = path.join(projectRoot, "docs");
  if (fs.existsSync(docsRoot)) {
    walk(docsRoot, out);
  }
  return out;
}

function walk(dir, out) {
  for (const name of fs.readdirSync(dir)) {
    const abs = path.join(dir, name);
    const stat = fs.statSync(abs);
    if (stat.isDirectory()) walk(abs, out);
    else if (stat.isFile() && name.endsWith(".md")) out.push(abs);
  }
}

// ---------- Checks ----------

const SKIP_TAG = "<!-- claim:skip -->";

// Pre-process file contents into (lineNumber, line) pairs, then drop
// lines tagged for skip. All checks operate on this filtered view so
// the escape hatch works uniformly.
function readLines(file) {
  const raw = fs.readFileSync(file, "utf8");
  return raw.split(/\r?\n/).map((line, idx) => ({ no: idx + 1, line }));
}

// Whitelist for env-var-like ALL_CAPS_NAMES that aren't actually env
// vars: shell builtins, CI variables, generic placeholders. Adding to
// this list is fine when a check would over-flag.
const ENV_VAR_NOISE = new Set([
  "PATH", "HOME", "USER", "PWD", "TMPDIR", "SHELL", "LANG", "LC_ALL",
  "EDITOR", "PAGER", "TERM",
  // GitHub Actions / CI placeholders
  "GITHUB_TOKEN", "CI", "RUNNER_OS",
  // Per-language NODE_OPTIONS / similar
  "NODE_OPTIONS",
  // Shell pseudo-vars
  "IFS", "PS1", "PS2",
  // Common in code examples that aren't real env
  "YOUR_ADMIN_KEY", "REPLACE_ME", "SECRET",
]);

function check(file, allEnvVars, allScripts, dockerfileNodeMajor) {
  const errors = [];
  const lines = readLines(file);
  const rel = path.relative(projectRoot, file);

  // Tracker: are we inside a fenced code block right now?
  let inFence = false;
  let fenceLang = "";

  for (const { no, line } of lines) {
    // Fence tracking ALWAYS runs first, before the skip-tag check.
    // If a `<!-- claim:skip -->` is added to a fence open/close
    // line, we still need to toggle `inFence` so subsequent lines
    // know whether they're inside a code block — otherwise a
    // skipped fence-line would desync state for the rest of the
    // file. After
    // toggling, we honor the skip tag to avoid running other
    // checks against the fence-marker line itself.
    const fenceMatch = line.match(/^[ \t]*```([a-zA-Z0-9_.-]*)/);
    if (fenceMatch) {
      if (!inFence) {
        inFence = true;
        fenceLang = fenceMatch[1] || "";
      } else {
        inFence = false;
        fenceLang = "";
      }
      continue;
    }

    if (line.includes(SKIP_TAG)) continue;

    // ---- Markdown link target check (prose only, not code fences) ----
    if (!inFence) {
      const linkPattern = /\[[^\]]*\]\(([^)\s]+)\)/g;
      let lm;
      while ((lm = linkPattern.exec(line)) !== null) {
        const target = lm[1];
        if (!target) continue;
        if (target.startsWith("http://") || target.startsWith("https://") || target.startsWith("mailto:")) continue;
        if (target.startsWith("#")) continue; // intra-document anchor
        const cleaned = target.split("#")[0];
        if (!cleaned) continue;
        if (cleaned.startsWith("/")) continue; // root-absolute paths used for HTTP routes (e.g. /admin)
        const abs = path.resolve(path.dirname(file), cleaned);
        if (!fs.existsSync(abs)) {
          errors.push(`${rel}:${no}: broken doc link → "${target}"`);
        }
      }
    }

    // ---- Node version claim check (prose only) ----
    //
    // "Node N+" means "Node N or newer is required." We only flag
    // when `claimed > dockerfile`, i.e. the doc is asking the user
    // for a higher version than the runtime actually pins. The
    // reverse direction (claim < dockerfile) is stale-but-still-
    // accurate — saying "Node 20+" when the Dockerfile is `node:22`
    // doesn't mislead anyone, since Node 22 IS "20 or newer."
    if (!inFence && dockerfileNodeMajor !== null) {
      const nodeMatch = line.match(/\bNode\s+(\d+)\+/);
      if (nodeMatch) {
        const claimed = parseInt(nodeMatch[1], 10);
        if (claimed > dockerfileNodeMajor) {
          errors.push(
            `${rel}:${no}: doc says "Node ${claimed}+" but Dockerfile uses node:${dockerfileNodeMajor}-... ` +
              `(claim asserts a higher floor than the actual runtime).`
          );
        }
      }
    }

    // ---- npm script reference check (prose AND code fences) ----
    const npmPattern = /(?:^|\s|`)npm\s+run\s+([a-zA-Z][a-zA-Z0-9:_-]*)/g;
    let nm;
    while ((nm = npmPattern.exec(line)) !== null) {
      const script = nm[1];
      if (!allScripts.has(script)) {
        errors.push(
          `${rel}:${no}: references "npm run ${script}" but not in package.json`
        );
      }
    }

    // ---- Env var assignments inside code fences ----
    if (inFence && (fenceLang === "bash" || fenceLang === "sh" || fenceLang === "" || fenceLang === "shell")) {
      // Skip lines that are entirely comments (start with `#` after
      // any leading whitespace). The earlier draft naively stripped
      // a leading `#` and then matched, which would treat a comment
      // like `# FOO=bar` as a real assignment and (incorrectly) flag
      // FOO if it weren't in .env.example.
      const isCommentLine = /^\s*#/.test(line);
      if (!isCommentLine) {
        // Allow a leading `$ ` shell prompt (e.g. `$ FOO=bar npm run x`).
        const trimmed = line.replace(/^\s*\$?\s*/, "");
        const envMatch = trimmed.match(/^([A-Z][A-Z0-9_]{2,})=/);
        if (envMatch) {
          const name = envMatch[1];
          if (!allEnvVars.has(name) && !ENV_VAR_NOISE.has(name)) {
            errors.push(
              `${rel}:${no}: code block references "${name}=" but not in .env.example`
            );
          }
        }
      }
    }
  }

  return errors;
}

// ---------- Driver ----------

function main() {
  const dockerfileNodeMajor = readDockerfileNodeMajor();
  const allEnvVars = readKnownEnvVars();
  const allScripts = readKnownNpmScripts();
  const files = findMarkdownFiles();

  if (files.length === 0) {
    console.error("[claims:check] no markdown files found — that's surprising. Aborting.");
    process.exit(1);
  }

  let allErrors = [];
  for (const f of files) {
    allErrors = allErrors.concat(check(f, allEnvVars, allScripts, dockerfileNodeMajor));
  }

  if (allErrors.length > 0) {
    console.error("[claims:check] FAIL — doc claims don't match codebase:\n");
    for (const e of allErrors) console.error(`  ${e}`);
    console.error(`\n[claims:check] ${allErrors.length} error(s) across ${files.length} file(s).`);
    console.error(
      "[claims:check] To skip a specific line: append " + SKIP_TAG + " to that line."
    );
    process.exit(1);
  }

  console.log(
    `[claims:check] OK — ${files.length} file(s), node@${dockerfileNodeMajor || "?"}, ` +
      `${allEnvVars.size} env var(s), ${allScripts.size} npm script(s) cross-checked.`
  );
}

main();
