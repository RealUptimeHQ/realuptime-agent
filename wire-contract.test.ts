import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { REQUEST_TIMEOUT_MS } from "./api.ts";
import { FLUSH_BATCH_SIZE, bufferPolicy } from "./buffer.ts";
import { MAX_FILESYSTEMS_PER_SAMPLE } from "./collect-disk.ts";
import { executeCheck } from "./execute.ts";
import { MAX_ASSERTION_BODY_BYTES } from "./http-assertions.ts";
import { METRICS_FLUSH_BATCH_SIZE, metricsBufferPolicy } from "./metrics-buffer.ts";
import { TICK_MS } from "./scheduler.ts";
import { MAX_CONTAINERS_PER_SAMPLE } from "./collect-containers.ts";
import { MAX_NETWORK_INTERFACES_PER_SAMPLE } from "./collect-network.ts";
import { MAX_PROCESSES_PER_SAMPLE } from "./collect-processes.ts";
import { MAX_WATCHED_SERVICES } from "./collect-services.ts";
import {
  WIRE_PROTOCOL_VERSION,
  type AgentCheck,
  type CheckResult,
  type ContainerSample,
  type DiskSample,
  type HostInfo,
  type MetricSample,
  type MetricsRequest,
  type MetricsResponse,
  type MetricsVantage,
  type NetworkInterfaceSample,
  type PollResponse,
  type ProcessSample,
  type ServiceSample,
} from "./types.ts";

/**
 * The contract this agent was built against, written down as assertions.
 *
 * The server half is built in a different session against the same document.
 * Nothing in a monorepo type system connects the two, so the only thing that
 * can catch a rename is a test that names every field out loud. When one of
 * these fails, the question is not "which side is wrong" but "which side
 * changed the contract without saying so".
 */

const HERE = dirname(fileURLToPath(import.meta.url));

describe("wire contract", () => {
  it("names every field of a poll check", () => {
    const check: Required<AgentCheck> = {
      id: "chk_1",
      type: "http",
      url: "http://10.0.0.1/health",
      tcpHost: "db.internal",
      tcpPort: 5432,
      tcpTls: true,
      dnsHostname: "api.internal",
      dnsRecordType: "A",
      dnsExpectedValue: "10.0.0.4",
      pingHost: "router.internal",
      intervalSeconds: 60,
      assertionBodyOp: "contains",
      assertionBodyValue: "Add to cart",
      assertionBodyCaseSensitive: true,
      assertionHeaderName: "content-type",
      assertionHeaderOp: "equals",
      assertionHeaderValue: "application/json",
      assertionStatusMin: 200,
      assertionStatusMax: 204,
      assertionJsonPath: "data.items[0].status",
      assertionJsonOp: "equals",
      assertionJsonValue: "ok",
    };
    expect(Object.keys(check).sort()).toEqual(
      [
        "assertionBodyCaseSensitive",
        "assertionBodyOp",
        "assertionBodyValue",
        "assertionHeaderName",
        "assertionHeaderOp",
        "assertionHeaderValue",
        "assertionJsonOp",
        "assertionJsonPath",
        "assertionJsonValue",
        "assertionStatusMax",
        "assertionStatusMin",
        "dnsExpectedValue",
        "dnsHostname",
        "dnsRecordType",
        "id",
        "intervalSeconds",
        "pingHost",
        "tcpHost",
        "tcpPort",
        "tcpTls",
        "type",
        "url",
      ].sort(),
    );
  });

  it("names every field of a posted result", () => {
    const result: Required<CheckResult> = {
      checkId: "chk_1",
      ok: true,
      statusCode: 200,
      latencyMs: 12,
      error: "",
      checkedAt: new Date(0).toISOString(),
    };
    expect(Object.keys(result).sort()).toEqual(
      ["checkId", "checkedAt", "error", "latencyMs", "ok", "statusCode"].sort(),
    );
  });

  // The metrics half of the contract (the Monitor design notes). This
  // agent does not collect these yet: the server route and the store landed
  // first, and these assertions are what makes the collection change land
  // against a contract instead of a guess. If one of them starts failing
  // before collection exists, the SERVER moved.
  it("names every field of a posted metric sample", () => {
    const sample: Required<MetricSample> = {
      sampledAt: new Date(0).toISOString(),
      cpuUsedRatio: 0.42,
      cpuCores: 8,
      memoryTotalBytes: 16 * 1024 * 1024 * 1024,
      memoryUsedBytes: 9 * 1024 * 1024 * 1024,
      load1: 1.2,
      load5: 0.9,
      load15: 0.7,
      filesystems: [],
      network: [],
      processes: [],
      containers: [],
      services: [],
    };
    expect(Object.keys(sample).sort()).toEqual(
      [
        "containers",
        "cpuCores",
        "cpuUsedRatio",
        "filesystems",
        "load1",
        "load15",
        "load5",
        "memoryTotalBytes",
        "memoryUsedBytes",
        "network",
        "processes",
        "sampledAt",
        "services",
      ].sort(),
    );
  });

  // Protocol v2 (REA-181). Every family is additive and optional: a v1
  // server ignores them, a v2 server stores them as a sidecar. The field
  // names are pinned here for the same reason the v1 ones are, and the
  // per-sample caps are pinned to the server's constants
  // (packages/db/server-metrics.ts) by literal, since nothing here imports
  // that package.
  it("names every field of the four v2 families and the host header", () => {
    const net: Required<NetworkInterfaceSample> = {
      name: "eth0",
      rxBytesPerSec: 1,
      txBytesPerSec: 2,
      rxErrors: 0,
      txErrors: 0,
      rxDropped: 0,
      txDropped: 0,
    };
    expect(Object.keys(net).sort()).toEqual(
      ["name", "rxBytesPerSec", "rxDropped", "rxErrors", "txBytesPerSec", "txDropped", "txErrors"].sort(),
    );
    const proc: Required<ProcessSample> = { pid: 1, name: "node", cpuRatio: 0.1, memoryBytes: 100 };
    expect(Object.keys(proc).sort()).toEqual(["cpuRatio", "memoryBytes", "name", "pid"].sort());
    const container: Required<ContainerSample> = {
      id: "abc",
      name: null,
      runtime: "docker",
      cpuRatio: null,
      memoryUsedBytes: 1,
      memoryLimitBytes: null,
    };
    expect(Object.keys(container).sort()).toEqual(
      ["cpuRatio", "id", "memoryLimitBytes", "memoryUsedBytes", "name", "runtime"].sort(),
    );
    const service: Required<ServiceSample> = { name: "nginx", status: "active" };
    expect(Object.keys(service).sort()).toEqual(["name", "status"].sort());
    const host: Required<HostInfo> = {
      hostname: "vps-1",
      os: "linux",
      osVersion: null,
      arch: "x64",
      cluster: null,
      node: null,
    };
    expect(Object.keys(host).sort()).toEqual(["arch", "cluster", "hostname", "node", "os", "osVersion"].sort());
    const poll: Required<PollResponse> = { checks: [], services: [] };
    expect(Object.keys(poll).sort()).toEqual(["checks", "services"]);
  });

  it("pins the protocol version and the v2 per-sample caps to the server's", () => {
    expect(WIRE_PROTOCOL_VERSION).toBe(2);
    expect(MAX_NETWORK_INTERFACES_PER_SAMPLE).toBe(32);
    expect(MAX_PROCESSES_PER_SAMPLE).toBe(20);
    expect(MAX_CONTAINERS_PER_SAMPLE).toBe(64);
    expect(MAX_WATCHED_SERVICES).toBe(64);
  });

  it("names every field of a filesystem reading", () => {
    const disk: Required<DiskSample> = {
      mountPoint: "/",
      totalBytes: 500 * 1024 * 1024 * 1024,
      usedBytes: 431 * 1024 * 1024 * 1024,
    };
    expect(Object.keys(disk).sort()).toEqual(["mountPoint", "totalBytes", "usedBytes"].sort());
  });

  it("names every field of a metrics request and response", () => {
    const request: Required<MetricsRequest> = {
      vantage: "host",
      vantageDetail: null,
      collectorVersion: "0.1.0",
      protocolVersion: 2,
      host: null,
      samples: [],
    };
    expect(Object.keys(request).sort()).toEqual(
      ["collectorVersion", "host", "protocolVersion", "samples", "vantage", "vantageDetail"].sort(),
    );

    const response: Required<MetricsResponse> = {
      accepted: 1,
      rejectedStale: 0,
      rejectedFuture: 0,
      rejectedDuplicate: 0,
    };
    expect(Object.keys(response).sort()).toEqual(
      ["accepted", "rejectedDuplicate", "rejectedFuture", "rejectedStale"].sort(),
    );
  });

  it("pins the two legal vantages", () => {
    // Every value here is a promise the server enforces with a CHECK
    // constraint (migration 068). Adding a third is a schema decision, not a
    // string literal: a collector that reports one the server does not know is
    // refused, which is the intended failure and the reason this is pinned.
    const vantages: MetricsVantage[] = ["host", "container"];
    expect(vantages).toEqual(["host", "container"]);
  });

  it("pins the units a metric sample is expressed in", () => {
    // The one contract detail no field name can carry. CPU is a fraction of
    // TOTAL capacity, so a fully-loaded machine is 1 and not 100, and the
    // server refuses anything above 1: a collector sending percent fails on
    // its first batch instead of drawing a chart wrong by 100x forever.
    const fullyLoaded: MetricSample = {
      sampledAt: new Date(0).toISOString(),
      cpuUsedRatio: 1,
      cpuCores: 4,
      // Bytes, never megabytes and never a percentage: the server derives
      // every percentage from these totals so a chart and an alert threshold
      // cannot disagree about what "90% full" meant.
      memoryTotalBytes: 8_589_934_592,
      memoryUsedBytes: 8_589_934_592,
      filesystems: [{ mountPoint: "/", totalBytes: 1_000_000_000, usedBytes: 900_000_000 }],
    };
    expect(fullyLoaded.cpuUsedRatio).toBeLessThanOrEqual(1);
    expect(fullyLoaded.memoryUsedBytes).toBeLessThanOrEqual(fullyLoaded.memoryTotalBytes);
    // Load is optional as a GROUP. A platform without load averages omits all
    // three; it must never send zeroes, which read as an idle machine.
    expect(fullyLoaded.load1).toBeUndefined();
    expect(fullyLoaded.load5).toBeUndefined();
    expect(fullyLoaded.load15).toBeUndefined();
  });

  it("stamps checkedAt as an ISO 8601 instant", async () => {
    const result = await executeCheck({
      id: "chk_1",
      type: "http",
      url: "not a url",
      intervalSeconds: 60,
    });
    expect(result.checkedAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    expect(result.ok).toBe(false);
  });

  it("reports a malformed check as a failed result rather than throwing", async () => {
    // Throwing would kill the tick and take every other check on the machine
    // down with it, over a server-side field the agent cannot fix.
    for (const check of [
      { id: "a", type: "http", intervalSeconds: 60 },
      { id: "b", type: "tcp", tcpHost: "x", intervalSeconds: 60 },
      { id: "c", type: "dns", intervalSeconds: 60 },
    ] as AgentCheck[]) {
      const out = await executeCheck(check);
      expect(out.ok).toBe(false);
      expect(out.error).toContain("missing configuration");
      expect(out.checkId).toBe(check.id);
    }
  });

  it("pins the operating numbers the contract fixes", () => {
    expect(FLUSH_BATCH_SIZE).toBe(100);
    expect(bufferPolicy.max).toBe(1000);
    expect(TICK_MS).toBe(15_000);
    expect(REQUEST_TIMEOUT_MS).toBeLessThanOrEqual(30_000);
  });

  // The metrics collection half (the Monitor design notes). These pin
  // the agent's own batch/mount caps against the server's, which is the same
  // "written down as assertions" reasoning the rest of this file follows:
  // packages/db/server-metrics.ts's MAX_SAMPLES_PER_CALL and
  // MAX_FILESYSTEMS_PER_SAMPLE are not imported (this package imports
  // nothing outside itself), so a server-side change to either number would
  // otherwise show up as silent over-sending instead of a failing test here.
  it("pins the agent's metrics batch and mount caps to the server's", () => {
    expect(METRICS_FLUSH_BATCH_SIZE).toBe(100);
    expect(metricsBufferPolicy.max).toBe(1000);
    expect(MAX_FILESYSTEMS_PER_SAMPLE).toBe(32);
  });

  // Response assertions (Monitor Phase 4): this program's body-read cap
  // mirrors packages/checker/http-assertions.ts's MAX_ASSERTION_BODY_BYTES,
  // which is itself packages/db/outage-feed.ts's existing
  // MAX_FEED_BODY_BYTES reused rather than grown. Neither is importable here
  // (zero workspace imports), so the number is pinned as a literal.
  it("pins the agent's assertion body cap to the checker's", () => {
    expect(MAX_ASSERTION_BODY_BYTES).toBe(262_144);
  });
});

describe("dependency hygiene", () => {
  it("has no runtime dependencies at all", () => {
    // This program runs on customer hardware. Every dependency is something a
    // security reviewer has to read and something a supply-chain attack can
    // arrive through, so the honest number is zero and this test keeps it
    // there. Adding one is a decision, not an npm install.
    const pkg = JSON.parse(readFileSync(join(HERE, "package.json"), "utf8"));
    expect(pkg.dependencies ?? {}).toEqual({});
    expect(Object.keys(pkg.devDependencies).sort()).toEqual([
      "@types/node",
      "typescript",
      "vitest",
    ]);
  });

  it("never imports another workspace package", () => {
    // Especially not @realuptime/db: dragging the schema, the migration runner
    // and postgres.js into the customer's binary would undo the whole point.
    const sources = readFileSync(join(HERE, "README.md"), "utf8");
    expect(sources).toBeTruthy();
    for (const file of [
      "agent.ts",
      "api.ts",
      "buffer.ts",
      "check-dns.ts",
      "check-http.ts",
      "check-tcp.ts",
      "collect-containers.ts",
      "collect-cpu.ts",
      "collect-darwin.ts",
      "collect-disk.ts",
      "collect-linux.ts",
      "collect-load.ts",
      "collect-memory.ts",
      "collect-metrics.ts",
      "collect-network.ts",
      "collect-processes.ts",
      "collect-services.ts",
      "collect-windows.ts",
      "config.ts",
      "execute.ts",
      "http-assertions.ts",
      "log.ts",
      "metrics-buffer.ts",
      "json-path.ts",
      "platform.ts",
      "runtime.ts",
      "scheduler.ts",
      "types.ts",
      "vantage.ts",
      "version.ts",
    ]) {
      // Comments are stripped first: this file's own prose quotes strings, and
      // a naive `from "..."` scan happily matches an English sentence.
      const source = readFileSync(join(HERE, file), "utf8")
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/^\s*\/\/.*$/gm, "");
      const imports = [...source.matchAll(/from\s+"([^"]+)"/g)].map((m) => m[1]!);
      for (const specifier of imports) {
        const ok = specifier.startsWith("./") || specifier.startsWith("node:");
        expect(ok, `${file} imports ${specifier}`).toBe(true);
      }
    }
  });
});

/**
 * The other half of the duplicate-module arrangement.
 *
 * `json-path.ts` is a hand-kept copy of `packages/db/json-path.ts`, and
 * `json-path.test.ts` runs a hand-kept copy of that module's vector table
 * against it. The vectors pin BEHAVIOUR, which is the thing that matters, but
 * they can only catch a divergence somebody thought to write a vector for.
 * This pins the TEXT: everything below the header comment must be identical,
 * so a change to one copy that is not mirrored fails here even if no existing
 * vector happens to exercise it.
 *
 * Reading a sibling package's file from a test is not an import and does not
 * violate the dependency-hygiene rule above -- nothing ships from this read,
 * and the agent binary never touches it. `http-assertions.ts` predates this
 * and is deliberately NOT covered: the two copies of that module genuinely
 * differ (the agent's uses camelCase wire names), which is exactly why its
 * shared vectors carry the whole burden there and why this newer module was
 * kept textually identical instead.
 */
describe("json-path duplicate", () => {
  it("is byte-identical to packages/db/json-path.ts below the header", (ctx) => {
    // Skips in the public mirror, where packages/db does not exist.
    const fleetPath = join(HERE, "..", "..", "packages", "db", "json-path.ts");
    if (!existsSync(fleetPath)) return ctx.skip();
    const bodyOf = (source: string) => {
      const end = source.indexOf("*/");
      expect(end, "expected a leading block comment").toBeGreaterThan(-1);
      return source.slice(end + 2).trim();
    };

    const agent = readFileSync(join(HERE, "json-path.ts"), "utf8");
    const fleet = readFileSync(fleetPath, "utf8");

    expect(bodyOf(agent)).toBe(bodyOf(fleet));
  });
});
