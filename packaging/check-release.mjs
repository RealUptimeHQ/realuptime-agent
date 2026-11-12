#!/usr/bin/env node
/**
 * Starts each agent executable build-release.sh produced for THIS machine's
 * OS and CPU and proves it runs and reports the release version, the way a
 * customer's server would run it, without a VM.
 *
 * For each binary: a local HTTP server stands in for the RealUptime API, the
 * binary is started with REALUPTIME_URL pointing at it and a placeholder
 * token, and the check waits for its first `POST /api/agent/v1/poll`. That
 * poll carries the build's self-report (`agent.version`): the release version
 * for the Node.js build, `<version>-go` for the Go build. The binary is then
 * stopped. It fails when a binary exits before polling, does not poll within
 * the timeout, or reports another version.
 *
 *   node agent/packaging/check-release.mjs            # out dir and version from the repository
 *   node agent/packaging/check-release.mjs <out-dir> <version>
 *
 * ci/gate.sh runs it after build-release.sh on the gate's Linux container, so
 * every merge proves the release build starts.
 */
import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { createServer } from "node:http";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const TIMEOUT_MS = 30_000;

/** The executables in `out` built for `platform`/`arch`, with the version each must report. */
export function hostBinaries(out, version, platform = process.platform, arch = process.arch) {
  const os = platform === "win32" ? "windows" : platform;
  const cpu = arch === "x64" ? "x64" : arch === "arm64" ? "arm64" : arch;
  const exe = os === "windows" ? ".exe" : "";
  return [
    { name: `realuptime-agent-${version}-${os}-${cpu}${exe}`, reports: version },
    { name: `realuptime-agent-go-${version}-${os}-${cpu}${exe}`, reports: `${version}-go` },
  ]
    .map((b) => ({ ...b, path: join(out, b.name) }))
    .filter((b) => existsSync(b.path));
}

/** Runs one binary against a fake API until its first poll; resolves with the reported version. */
export function firstPollVersion(path, timeoutMs = TIMEOUT_MS) {
  return new Promise((resolve, reject) => {
    let child;
    let settled = false;
    const finish = (err, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (child && child.exitCode === null) child.kill("SIGTERM");
      server.close();
      if (err) reject(err);
      else resolve(value);
    };
    const server = createServer((req, res) => {
      let body = "";
      req.on("data", (c) => {
        body += c;
      });
      req.on("end", () => {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ checks: [] }));
        if (req.method === "POST" && req.url === "/api/agent/v1/poll") {
          try {
            finish(null, JSON.parse(body)?.agent?.version ?? null);
          } catch (err) {
            finish(new Error(`${path}: unreadable poll body: ${err.message}`));
          }
        }
      });
    });
    const timer = setTimeout(() => finish(new Error(`${path}: no poll within ${timeoutMs} ms`)), timeoutMs);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      let output = "";
      child = spawn(path, [], {
        env: {
          PATH: process.env.PATH,
          HOME: process.env.HOME,
          REALUPTIME_URL: `http://127.0.0.1:${port}`,
          REALUPTIME_TOKEN: "rua_releasecheck_placeholder_token",
        },
        stdio: ["ignore", "pipe", "pipe"],
      });
      child.stdout.on("data", (c) => {
        output += c;
      });
      child.stderr.on("data", (c) => {
        output += c;
      });
      child.on("error", (err) => finish(new Error(`${path}: did not start: ${err.message}`)));
      child.on("exit", (code, signal) =>
        finish(new Error(`${path}: exited (${signal ?? code}) before its first poll:\n${output.slice(-2000)}`)),
      );
    });
  });
}

async function main() {
  const out = process.argv[2] ?? join(HERE, "out");
  const version =
    process.argv[3] ?? JSON.parse(readFileSync(join(HERE, "..", "package.json"), "utf8")).version;
  const binaries = hostBinaries(out, version);
  if (binaries.length === 0) {
    throw new Error(`no agent executable for ${process.platform}-${process.arch} in ${out}: run build-release.sh first`);
  }
  let failed = false;
  for (const b of binaries) {
    try {
      const reported = await firstPollVersion(b.path);
      if (reported === b.reports) {
        console.log(`ok  ${b.name}: started and reported ${reported}`);
      } else {
        failed = true;
        console.error(`FAIL ${b.name}: reported ${JSON.stringify(reported)}, expected ${b.reports}`);
      }
    } catch (err) {
      failed = true;
      console.error(`FAIL ${err.message}`);
    }
  }
  if (failed) process.exit(1);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((err) => {
    console.error(err.message);
    process.exit(1);
  });
}
