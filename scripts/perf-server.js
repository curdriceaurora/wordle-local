#!/usr/bin/env node

const http = require("http");
const path = require("path");
const { spawnSync } = require("child_process");

const SERVER_MODULE_PATH = path.join(__dirname, "..", "server.js");
const DEFAULT_MODES = Object.freeze(["memory", "lazy", "indexed"]);

function parseArgs(argv) {
  const parsed = {
    mode: "memory",
    modes: false,
    jsonOnly: false,
    iterations: 500,
    warmup: 80,
    concurrency: 12,
    timeoutMs: 15000
  };

  argv.forEach((arg) => {
    if (arg === "--modes") {
      parsed.modes = true;
      return;
    }
    if (arg === "--json-only") {
      parsed.jsonOnly = true;
      return;
    }
    if (arg.startsWith("--mode=")) {
      parsed.mode = arg.slice("--mode=".length).trim();
      return;
    }
    if (arg.startsWith("--iterations=")) {
      parsed.iterations = Number(arg.slice("--iterations=".length));
      return;
    }
    if (arg.startsWith("--warmup=")) {
      parsed.warmup = Number(arg.slice("--warmup=".length));
      return;
    }
    if (arg.startsWith("--concurrency=")) {
      parsed.concurrency = Number(arg.slice("--concurrency=".length));
      return;
    }
    if (arg.startsWith("--timeout-ms=")) {
      parsed.timeoutMs = Number(arg.slice("--timeout-ms=".length));
    }
  });

  if (!Number.isInteger(parsed.iterations) || parsed.iterations <= 0) {
    throw new Error("--iterations must be a positive integer.");
  }
  if (!Number.isInteger(parsed.warmup) || parsed.warmup < 0) {
    throw new Error("--warmup must be a non-negative integer.");
  }
  if (!Number.isInteger(parsed.concurrency) || parsed.concurrency <= 0) {
    throw new Error("--concurrency must be a positive integer.");
  }
  if (!Number.isInteger(parsed.timeoutMs) || parsed.timeoutMs <= 0) {
    throw new Error("--timeout-ms must be a positive integer.");
  }
  if (!DEFAULT_MODES.includes(parsed.mode) && !parsed.modes) {
    throw new Error(`--mode must be one of: ${DEFAULT_MODES.join(", ")}`);
  }

  return parsed;
}

function percentile(values, p) {
  if (!values.length) return 0;
  const index = Math.ceil((p / 100) * values.length) - 1;
  const safeIndex = Math.max(0, Math.min(values.length - 1, index));
  return values[safeIndex];
}

function formatBytes(bytes) {
  const units = ["B", "KB", "MB", "GB"];
  let value = bytes;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }
  return `${value.toFixed(2)} ${units[unitIndex]}`;
}

function snapshotMemory() {
  const mem = process.memoryUsage();
  return {
    rss: mem.rss,
    heapUsed: mem.heapUsed,
    heapTotal: mem.heapTotal
  };
}

function memoryDelta(after, before) {
  return {
    rss: after.rss - before.rss,
    heapUsed: after.heapUsed - before.heapUsed,
    heapTotal: after.heapTotal - before.heapTotal
  };
}

async function requestJson(port, requestPath, payload, timeoutMs) {
  const body = JSON.stringify(payload);
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        hostname: "127.0.0.1",
        port,
        path: requestPath,
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(body)
        }
      },
      (res) => {
        let data = "";
        res.setEncoding("utf8");
        res.on("data", (chunk) => {
          data += chunk;
        });
        res.on("end", () => {
          let parsed = {};
          if (data) {
            try {
              parsed = JSON.parse(data);
            } catch (err) {
              reject(new Error(`Invalid JSON response from ${requestPath}: ${err.message}`));
              return;
            }
          }
          if (res.statusCode < 200 || res.statusCode >= 300) {
            reject(
              new Error(
                `Request ${requestPath} failed (${res.statusCode}): ${JSON.stringify(parsed)}`
              )
            );
            return;
          }
          resolve(parsed);
        });
      }
    );

    req.setTimeout(timeoutMs, () => {
      req.destroy(new Error(`Request ${requestPath} timed out after ${timeoutMs}ms.`));
    });
    req.on("error", reject);
    req.write(body);
    req.end();
  });
}

async function runLimitedConcurrency(count, concurrency, task) {
  const latencies = [];
  let next = 0;

  async function worker() {
    while (true) {
      const index = next;
      next += 1;
      if (index >= count) return;
      const start = process.hrtime.bigint();
      await task();
      const elapsedMs = Number(process.hrtime.bigint() - start) / 1e6;
      latencies.push(elapsedMs);
    }
  }

  const workers = Array.from({ length: Math.min(concurrency, count) }, () => worker());
  await Promise.all(workers);
  return latencies;
}

function clearServerModuleCache() {
  delete require.cache[require.resolve(SERVER_MODULE_PATH)];
}

async function startServerForMode(mode) {
  process.env.DEFINITIONS_MODE = mode;
  process.env.PERF_LOGGING = "false";
  process.env.NODE_ENV = "development";
  process.env.RATE_LIMIT_MAX = "1000000";
  process.env.RATE_LIMIT_WINDOW_MS = "900000";
  process.env.REQUIRE_ADMIN_KEY = "false";
  process.env.ADMIN_KEY = "";
  process.env.TRUST_PROXY = "false";
  clearServerModuleCache();

  const app = require(SERVER_MODULE_PATH);
  return new Promise((resolve, reject) => {
    const server = app.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address !== "object") {
        reject(new Error("Could not resolve benchmark server address."));
        return;
      }
      resolve({ app, server, port: address.port });
    });
    server.on("error", reject);
  });
}

async function closeServer(server) {
  return new Promise((resolve, reject) => {
    server.close((err) => {
      if (err) {
        reject(err);
        return;
      }
      resolve();
    });
  });
}

async function runModeBenchmark(mode, options) {
  const originalEnv = { ...process.env };
  let started = null;
  try {
    started = await startServerForMode(mode);
    const { server, port } = started;
    const memoryBeforeWarmup = snapshotMemory();

    const encode = await requestJson(
      port,
      "/api/encode",
      { word: "CRANE", lang: "en" },
      options.timeoutMs
    );
    const code = encode.code;
    if (!code) {
      throw new Error(`Could not encode benchmark word in mode ${mode}.`);
    }

    for (let i = 0; i < options.warmup; i += 1) {
      await requestJson(
        port,
        "/api/guess",
        { code, guess: "CRANE", lang: "en", reveal: false },
        options.timeoutMs
      );
    }

    const memoryAfterWarmup = snapshotMemory();
    const startedAt = process.hrtime.bigint();
    const latencies = await runLimitedConcurrency(options.iterations, options.concurrency, () =>
      requestJson(
        port,
        "/api/guess",
        { code, guess: "CRANE", lang: "en", reveal: false },
        options.timeoutMs
      )
    );
    const totalMs = Number(process.hrtime.bigint() - startedAt) / 1e6;
    const memoryAfterRun = snapshotMemory();

    latencies.sort((a, b) => a - b);
    const throughput = options.iterations / (totalMs / 1000);
    const result = {
      mode,
      iterations: options.iterations,
      warmup: options.warmup,
      concurrency: options.concurrency,
      totalMs,
      throughputRps: throughput,
      latencyMs: {
        min: latencies[0] || 0,
        p50: percentile(latencies, 50),
        p95: percentile(latencies, 95),
        p99: percentile(latencies, 99),
        max: latencies[latencies.length - 1] || 0
      },
      memory: {
        beforeWarmup: memoryBeforeWarmup,
        afterWarmup: memoryAfterWarmup,
        afterRun: memoryAfterRun,
        warmupDelta: memoryDelta(memoryAfterWarmup, memoryBeforeWarmup),
        runDelta: memoryDelta(memoryAfterRun, memoryAfterWarmup)
      }
    };

    await closeServer(server);
    return result;
  } finally {
    if (started && started.server && started.server.listening) {
      await closeServer(started.server).catch(() => {});
    }
    clearServerModuleCache();
    Object.keys(process.env).forEach((key) => {
      if (!(key in originalEnv)) {
        delete process.env[key];
      }
    });
    Object.entries(originalEnv).forEach(([key, value]) => {
      process.env[key] = value;
    });
  }
}

function printSummary(results) {
  console.log("");
  console.log("Mode       p95(ms)   p99(ms)   Throughput(req/s)   RSS Δ warmup   RSS Δ run");
  console.log("---------  --------  --------  -------------------  -------------  ---------");
  results.forEach((result) => {
    const mode = result.mode.padEnd(9, " ");
    const p95 = result.latencyMs.p95.toFixed(2).padStart(8, " ");
    const p99 = result.latencyMs.p99.toFixed(2).padStart(8, " ");
    const rps = result.throughputRps.toFixed(2).padStart(19, " ");
    const rssWarmup = formatBytes(result.memory.warmupDelta.rss).padStart(13, " ");
    const rssRun = formatBytes(result.memory.runDelta.rss).padStart(9, " ");
    console.log(`${mode}  ${p95}  ${p99}  ${rps}  ${rssWarmup}  ${rssRun}`);
  });
  console.log("");
}

function buildArgListForChild(args, mode) {
  return [
    __filename,
    `--mode=${mode}`,
    `--iterations=${args.iterations}`,
    `--warmup=${args.warmup}`,
    `--concurrency=${args.concurrency}`,
    `--timeout-ms=${args.timeoutMs}`,
    "--json-only"
  ];
}

function runModeInChildProcess(args, mode) {
  const child = spawnSync(process.execPath, buildArgListForChild(args, mode), {
    cwd: path.join(__dirname, ".."),
    encoding: "utf8",
    env: process.env,
    maxBuffer: 10 * 1024 * 1024
  });
  if (child.status !== 0) {
    const stderr = child.stderr || child.stdout || "";
    throw new Error(
      `Benchmark child process failed for mode "${mode}" (exit ${child.status}). ${stderr.trim()}`
    );
  }
  let parsed;
  try {
    parsed = JSON.parse(child.stdout);
  } catch (err) {
    throw new Error(
      `Could not parse benchmark JSON output for mode "${mode}": ${err.message}`
    );
  }
  return parsed;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const options = {
    iterations: args.iterations,
    warmup: args.warmup,
    concurrency: args.concurrency,
    timeoutMs: args.timeoutMs
  };

  if (args.modes) {
    console.log(
      `Running benchmark for mode(s): ${DEFAULT_MODES.join(", ")} | iterations=${options.iterations} warmup=${options.warmup} concurrency=${options.concurrency}`
    );
    const results = [];
    DEFAULT_MODES.forEach((mode) => {
      console.log(`\n[mode=${mode}] starting...`);
      const result = runModeInChildProcess(args, mode);
      results.push(result);
      console.log(
        `[mode=${mode}] p95=${result.latencyMs.p95.toFixed(
          2
        )}ms throughput=${result.throughputRps.toFixed(2)} req/s`
      );
    });
    printSummary(results);
    console.log(
      JSON.stringify({ generatedAt: new Date().toISOString(), options, results }, null, 2)
    );
    return;
  }

  const mode = args.mode;
  const result = await runModeBenchmark(mode, options);
  if (args.jsonOnly) {
    process.stdout.write(JSON.stringify(result));
    return;
  }

  console.log(
    `Running benchmark for mode: ${mode} | iterations=${options.iterations} warmup=${options.warmup} concurrency=${options.concurrency}`
  );
  console.log(`\n[mode=${mode}] starting...`);
  console.log(
    `[mode=${mode}] p95=${result.latencyMs.p95.toFixed(2)}ms throughput=${result.throughputRps.toFixed(
      2
    )} req/s`
  );
  const results = [result];
  printSummary(results);
  console.log(JSON.stringify({ generatedAt: new Date().toISOString(), options, results }, null, 2));
}

main().catch((err) => {
  console.error(`Benchmark failed: ${err.message}`);
  process.exit(1);
});
