import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AuthError, TransientError, VantageConflictError } from "./api.ts";
import { FLUSH_BATCH_SIZE, ResultBuffer } from "./buffer.ts";
import { logSink } from "./log.ts";
import { METRICS_FLUSH_BATCH_SIZE, MetricsBuffer } from "./metrics-buffer.ts";
import {
  AUTH_RETRY_MS,
  AgentRuntime,
  BACKOFF_MAX_MS,
  BACKOFF_START_MS,
  FLUSH_INTERVAL_MS,
  METRICS_SAMPLE_INTERVAL_MS,
  POLL_INTERVAL_MS,
  nextBackoff,
  type MetricsSource,
} from "./runtime.ts";
import type { AgentCheck, CheckResult, MetricSample, MetricsRequest, MetricsResponse, MetricsVantage } from "./types.ts";

/**
 * The loop is driven by an injected clock, so an hours-long outage is a
 * for-loop rather than a wait. A backoff curve that can only be exercised by a
 * real network failure is a backoff curve nobody has watched work.
 */

function check(id: string, intervalSeconds = 60): AgentCheck {
  return { id, type: "http", url: `http://10.0.0.1/${id}`, intervalSeconds };
}

class FakeApi {
  checks: AgentCheck[] = [];
  sent: CheckResult[][] = [];
  pollError: Error | null = null;
  sendError: Error | null = null;
  pollCalls = 0;

  metricsSent: MetricsRequest[] = [];
  sendMetricsError: Error | null = null;
  metricsResponse: MetricsResponse = { accepted: 0, rejectedStale: 0, rejectedFuture: 0, rejectedDuplicate: 0 };

  services: string[] = [];

  async poll(): Promise<{ checks: AgentCheck[]; services: string[] }> {
    this.pollCalls++;
    if (this.pollError) throw this.pollError;
    return { checks: this.checks, services: this.services };
  }

  async sendResults(results: CheckResult[]): Promise<void> {
    if (this.sendError) throw this.sendError;
    this.sent.push(results);
  }

  async sendMetrics(request: MetricsRequest): Promise<MetricsResponse> {
    if (this.sendMetricsError) throw this.sendMetricsError;
    this.metricsSent.push(request);
    return { ...this.metricsResponse, accepted: request.samples.length };
  }
}

/** A metrics source that never actually reads a filesystem: `nextSample` is
 *  handed straight back (or null, the default, meaning "nothing to report
 *  this round" -- warm-up or `/proc` absent in the real collector). */
class FakeMetricsSource implements MetricsSource {
  calls = 0;
  nextSample: MetricSample | null = null;
  vantageValue: { vantage: MetricsVantage; detail: string | null } = { vantage: "host", detail: null };
  watchLists: (readonly unknown[])[] = [];
  throwOnCollect: Error | null = null;

  async collect(): Promise<MetricSample | null> {
    this.calls++;
    if (this.throwOnCollect) throw this.throwOnCollect;
    return this.nextSample;
  }

  vantage(): { vantage: MetricsVantage; detail: string | null } {
    return this.vantageValue;
  }

  hostInfo() {
    return { hostname: "vps-1", os: "linux" as const, osVersion: "Ubuntu 24.04", arch: "x64", cluster: "prod", node: "vps-1" };
  }

  setServiceWatch(names: readonly unknown[]): void {
    this.watchLists.push(names);
  }
}

function metricSample(n: number): MetricSample {
  return {
    sampledAt: new Date(n).toISOString(),
    cpuUsedRatio: 0.3,
    cpuCores: 2,
    memoryTotalBytes: 1000,
    memoryUsedBytes: 400,
    filesystems: [],
  };
}

function harness(
  api: FakeApi,
  buffer = new ResultBuffer(),
  metricsSource: MetricsSource = new FakeMetricsSource(),
  metricsBuffer = new MetricsBuffer(),
) {
  let now = 0;
  const runtime = new AgentRuntime({
    api,
    buffer,
    metricsSource,
    metricsBuffer,
    now: () => now,
    execute: async (c: AgentCheck) => ({
      checkId: c.id,
      ok: true,
      latencyMs: 1,
      checkedAt: new Date(now).toISOString(),
    }),
  });
  return {
    runtime,
    metricsSource,
    metricsBuffer,
    async tickAt(t: number) {
      now = t;
      await runtime.tick();
    },
    get now() {
      return now;
    },
  };
}

const lines: string[] = [];
const originalWrite = logSink.write;
beforeEach(() => {
  lines.length = 0;
  logSink.write = (line: string) => {
    lines.push(line);
  };
});
afterEach(() => {
  logSink.write = originalWrite;
});

describe("AgentRuntime", () => {
  it("polls on start and then only once a minute", async () => {
    const api = new FakeApi();
    api.checks = [check("a")];
    const h = harness(api);

    await h.tickAt(0);
    expect(api.pollCalls).toBe(1);
    await h.tickAt(15_000);
    await h.tickAt(30_000);
    await h.tickAt(45_000);
    expect(api.pollCalls).toBe(1);
    await h.tickAt(POLL_INTERVAL_MS);
    expect(api.pollCalls).toBe(2);
  });

  it("executes due checks and flushes them", async () => {
    const api = new FakeApi();
    api.checks = [check("a", 15)];
    const h = harness(api);

    await h.tickAt(0);
    expect(api.sent).toHaveLength(1);
    expect(api.sent[0]?.map((r) => r.checkId)).toEqual(["a"]);
  });

  it("stamps checkedAt at EXECUTION time, not at flush time", async () => {
    const api = new FakeApi();
    api.checks = [check("a", 15)];
    api.sendError = new TransientError("offline");
    const h = harness(api);

    await h.tickAt(1_000_000); // the check runs here
    const executedAt = new Date(1_000_000).toISOString();

    // ...and does not reach the server for another hour.
    api.sendError = null;
    for (let t = 1_015_000; t <= 1_000_000 + 3_600_000; t += 15_000) await h.tickAt(t);

    const first = api.sent[0]?.[0];
    expect(first?.checkId).toBe("a");
    expect(first?.checkedAt).toBe(executedAt);
  });

  it("flushes early once 100 results are held", async () => {
    const api = new FakeApi();
    // 100 checks, all due on the first tick.
    api.checks = Array.from({ length: FLUSH_BATCH_SIZE }, (_, i) => check(`c${i}`, 15));
    const h = harness(api);

    await h.tickAt(0);
    expect(api.sent[0]).toHaveLength(FLUSH_BATCH_SIZE);
  });

  it("never sends more than 100 in one call, and drains the rest on later ticks", async () => {
    const api = new FakeApi();
    api.checks = Array.from({ length: 250 }, (_, i) => check(`c${i}`, 15));
    const h = harness(api);

    await h.tickAt(0);
    expect(api.sent.every((batch) => batch.length <= FLUSH_BATCH_SIZE)).toBe(true);
    await h.tickAt(FLUSH_INTERVAL_MS);
    await h.tickAt(FLUSH_INTERVAL_MS * 2);
    const total = api.sent.reduce((n, batch) => n + batch.length, 0);
    expect(total).toBeGreaterThanOrEqual(250);
  });

  it("backs off exponentially on flush failure, capped at five minutes", async () => {
    const api = new FakeApi();
    api.checks = [check("a", 15)];
    api.sendError = new TransientError("ECONNREFUSED");
    const h = harness(api);

    await h.tickAt(0);
    const retries = lines
      .map((l) => JSON.parse(l) as { msg: string; retryInMs?: number })
      .filter((r) => r.msg === "flush failed, holding results");
    expect(retries[0]?.retryInMs).toBe(BACKOFF_START_MS);

    // Walk the curve: each failed attempt doubles until the cap.
    const observed: number[] = [BACKOFF_START_MS];
    let t = 0;
    for (let i = 0; i < 8; i++) {
      t += observed[observed.length - 1]!;
      lines.length = 0;
      await h.tickAt(t);
      const line = lines
        .map((l) => JSON.parse(l) as { msg: string; retryInMs?: number })
        .find((r) => r.msg === "flush failed, holding results");
      expect(line, `attempt ${i}`).toBeDefined();
      observed.push(line!.retryInMs!);
    }
    expect(observed.slice(0, 5)).toEqual([15_000, 30_000, 60_000, 120_000, 240_000]);
    expect(observed[observed.length - 1]).toBe(BACKOFF_MAX_MS);
    expect(Math.max(...observed)).toBe(BACKOFF_MAX_MS);
  });

  it("a full buffer does NOT punch through an active backoff", async () => {
    const api = new FakeApi();
    api.checks = Array.from({ length: FLUSH_BATCH_SIZE }, (_, i) => check(`c${i}`, 15));
    api.sendError = new TransientError("offline");
    const h = harness(api);

    await h.tickAt(0);
    const attemptsAfterFirst = lines.filter((l) => l.includes("flush failed")).length;
    expect(attemptsAfterFirst).toBe(1);

    // Buffer is way over 100 now, but the backoff has not expired.
    lines.length = 0;
    await h.tickAt(1_000);
    await h.tickAt(2_000);
    expect(lines.filter((l) => l.includes("flush failed"))).toHaveLength(0);
  });

  it("rides out an hours-long outage and delivers what it held when the link returns", async () => {
    const api = new FakeApi();
    api.checks = [check("a", 15)];
    api.pollError = new TransientError("offline");
    api.sendError = new TransientError("offline");
    const h = harness(api);

    // The check list was already known before the link went down.
    api.pollError = null;
    await h.tickAt(0);
    api.pollError = new TransientError("offline");
    api.sendError = new TransientError("offline");

    const buffer = h.runtime.buffer;
    // Six hours at one result every fifteen seconds is 1440 results, which
    // overflows the 1000-entry bound: the outage is long enough to exercise
    // both the holding AND the dropping.
    const OUTAGE_MS = 6 * 3_600_000;
    for (let t = 15_000; t <= OUTAGE_MS; t += 15_000) await h.tickAt(t);

    expect(api.sent).toHaveLength(0);
    expect(buffer.size).toBe(1000);
    expect(buffer.dropped).toBeGreaterThan(0);

    // Link returns.
    api.pollError = null;
    api.sendError = null;
    // The first attempt after recovery still waits out the 5 minute backoff
    // the outage ended on: the agent has no way to know the link is back
    // except by trying. After that one success the cadence returns to 15
    // seconds and the queue drains 100 per tick.
    let t = OUTAGE_MS;
    for (let i = 0; i < 60; i++) {
      t += FLUSH_INTERVAL_MS;
      await h.tickAt(t);
    }
    const delivered = api.sent.reduce((n, b) => n + b.length, 0);
    expect(delivered).toBeGreaterThanOrEqual(1000);
    expect(buffer.size).toBeLessThan(FLUSH_BATCH_SIZE);
  });

  it("logs the dropped count once the link recovers", async () => {
    const api = new FakeApi();
    const buffer = new ResultBuffer(5);
    api.checks = [check("a", 15)];
    api.sendError = new TransientError("offline");
    const h = harness(api, buffer);

    await h.tickAt(0);
    for (let t = 15_000; t <= 3_600_000; t += 15_000) await h.tickAt(t);
    expect(buffer.dropped).toBeGreaterThan(0);

    api.sendError = null;
    lines.length = 0;
    await h.tickAt(3_600_000 + BACKOFF_MAX_MS);
    const dropLine = lines
      .map((l) => JSON.parse(l) as { msg: string; dropped?: number })
      .find((r) => r.msg === "dropped oldest results: buffer was full");
    expect(dropLine?.dropped).toBeGreaterThan(0);
  });

  it("resets the backoff after a successful flush", async () => {
    const api = new FakeApi();
    api.checks = [check("a", 15)];
    api.sendError = new TransientError("offline");
    const h = harness(api);

    await h.tickAt(0);
    await h.tickAt(BACKOFF_START_MS);
    await h.tickAt(BACKOFF_START_MS * 3);
    api.sendError = null;
    await h.tickAt(BACKOFF_START_MS * 10);
    expect(api.sent.length).toBeGreaterThan(0);

    // Back on the normal 15 second cadence, not still on a 60 second backoff.
    api.sendError = new TransientError("offline again");
    lines.length = 0;
    await h.tickAt(BACKOFF_START_MS * 10 + FLUSH_INTERVAL_MS);
    const line = lines
      .map((l) => JSON.parse(l) as { msg: string; retryInMs?: number })
      .find((r) => r.msg === "flush failed, holding results");
    expect(line?.retryInMs).toBe(BACKOFF_START_MS);
  });

  it("on 401 keeps retrying at a slow FIXED interval and never exits", async () => {
    const exit = vi.spyOn(process, "exit").mockImplementation(((() => {}) as never));
    try {
      const api = new FakeApi();
      api.checks = [check("a", 15)];
      const h = harness(api);
      await h.tickAt(0);

      api.pollError = new AuthError();
      api.sendError = new AuthError();

      const pollAttemptTimes: number[] = [];
      let lastPollCalls = api.pollCalls;
      for (let t = 15_000; t <= 60 * 60_000; t += 15_000) {
        await h.tickAt(t);
        if (api.pollCalls > lastPollCalls) {
          pollAttemptTimes.push(t);
          lastPollCalls = api.pollCalls;
        }
      }

      // Fixed 5 minute spacing, not a doubling curve: a revoked token that is
      // reissued must be picked up promptly, and an exponential curve would
      // leave the agent dark for hours.
      const gaps = pollAttemptTimes.slice(1).map((t, i) => t - pollAttemptTimes[i]!);
      expect(gaps.length).toBeGreaterThan(5);
      expect(new Set(gaps)).toEqual(new Set([AUTH_RETRY_MS]));

      expect(exit).not.toHaveBeenCalled();
      const authLines = lines.filter((l) => l.includes("agent token rejected"));
      expect(authLines.length).toBeGreaterThan(0);
      expect(authLines[0]).toContain("revoked");
      expect(authLines[0]).toContain('"level":"error"');
    } finally {
      exit.mockRestore();
    }
  });

  it("recovers immediately once a reissued token is accepted", async () => {
    const api = new FakeApi();
    api.checks = [check("a", 15)];
    const h = harness(api);
    await h.tickAt(0);

    const sentBeforeRevocation = api.sent.length;
    api.pollError = new AuthError();
    api.sendError = new AuthError();
    for (let t = 15_000; t <= 20 * 60_000; t += 15_000) await h.tickAt(t);
    const heldBefore = h.runtime.buffer.size;
    expect(heldBefore).toBeGreaterThan(0);
    // Nothing got through while the token was rejected.
    expect(api.sent).toHaveLength(sentBeforeRevocation);

    api.pollError = null;
    api.sendError = null;
    let t = 20 * 60_000;
    for (let i = 0; i < 20; i++) {
      t += AUTH_RETRY_MS;
      await h.tickAt(t);
    }
    expect(api.sent.reduce((n, b) => n + b.length, 0)).toBeGreaterThanOrEqual(heldBefore);
  });

  it("keeps running the checks it already knows while polling is failing", async () => {
    const api = new FakeApi();
    api.checks = [check("a", 15)];
    const h = harness(api);
    await h.tickAt(0);
    api.pollError = new TransientError("offline");

    const before = api.sent.reduce((n, b) => n + b.length, 0);
    for (let t = 15_000; t <= 300_000; t += 15_000) await h.tickAt(t);
    expect(api.sent.reduce((n, b) => n + b.length, 0)).toBeGreaterThan(before);
  });

  it("does not POST an empty batch", async () => {
    const api = new FakeApi();
    api.checks = [];
    const h = harness(api);
    for (let t = 0; t <= 120_000; t += 15_000) await h.tickAt(t);
    expect(api.sent).toHaveLength(0);
  });

  it("survives a tick that throws, rather than ending the process", async () => {
    const api = new FakeApi();
    const runtime = new AgentRuntime({
      api,
      now: () => 0,
      metricsSource: new FakeMetricsSource(),
      execute: async () => {
        throw new Error("boom");
      },
    });
    api.checks = [check("a", 15)];
    let ticks = 0;
    await runtime.run(async () => {
      ticks++;
      if (ticks >= 2) runtime.stop();
    });
    expect(ticks).toBeGreaterThanOrEqual(2);
    expect(lines.some((l) => l.includes("unexpected tick failure"))).toBe(true);
  });
});

describe("AgentRuntime metrics", () => {
  it("collects one sample immediately, then only once a minute, same cadence as the poll", async () => {
    const api = new FakeApi();
    const metricsSource = new FakeMetricsSource();
    metricsSource.nextSample = metricSample(0);
    const h = harness(api, new ResultBuffer(), metricsSource);

    await h.tickAt(0);
    expect(metricsSource.calls).toBe(1);
    // Flushed within the same tick (nothing else is buffered or backing
    // off), same as a check result would be.
    expect(api.metricsSent[0]?.samples).toHaveLength(1);
    await h.tickAt(15_000);
    await h.tickAt(30_000);
    await h.tickAt(45_000);
    expect(metricsSource.calls).toBe(1);
    await h.tickAt(METRICS_SAMPLE_INTERVAL_MS);
    expect(metricsSource.calls).toBe(2);
  });

  it("does not buffer anything on a warm-up/proc-absent tick (collect() returns null)", async () => {
    const api = new FakeApi();
    const metricsSource = new FakeMetricsSource(); // nextSample stays null
    const h = harness(api, new ResultBuffer(), metricsSource);
    await h.tickAt(0);
    expect(metricsSource.calls).toBe(1);
    expect(h.metricsBuffer.size).toBe(0);
    expect(api.metricsSent).toHaveLength(0);
  });

  it("flushes a buffered sample with this machine's vantage", async () => {
    const api = new FakeApi();
    const metricsSource = new FakeMetricsSource();
    metricsSource.nextSample = metricSample(0);
    metricsSource.vantageValue = { vantage: "container", detail: "docker" };
    const h = harness(api, new ResultBuffer(), metricsSource);

    await h.tickAt(0);
    expect(api.metricsSent).toHaveLength(1);
    expect(api.metricsSent[0]?.vantage).toBe("container");
    expect(api.metricsSent[0]?.vantageDetail).toBe("docker");
    expect(api.metricsSent[0]?.samples).toHaveLength(1);
  });

  it("speaks protocol v2: every batch names its version and the host it describes", async () => {
    const api = new FakeApi();
    const metricsSource = new FakeMetricsSource();
    metricsSource.nextSample = metricSample(0);
    const h = harness(api, new ResultBuffer(), metricsSource);
    await h.tickAt(0);
    expect(api.metricsSent[0]?.protocolVersion).toBe(2);
    expect(api.metricsSent[0]?.host).toMatchObject({ hostname: "vps-1", os: "linux", cluster: "prod" });
  });

  it("hands the poll's service watch list to the collector on every successful poll, and nothing on a failed one", async () => {
    const api = new FakeApi();
    api.services = ["nginx", "postgresql"];
    const metricsSource = new FakeMetricsSource();
    const h = harness(api, new ResultBuffer(), metricsSource);
    await h.tickAt(0);
    expect(metricsSource.watchLists).toEqual([["nginx", "postgresql"]]);

    api.pollError = new TransientError("offline");
    await h.tickAt(POLL_INTERVAL_MS);
    expect(metricsSource.watchLists).toHaveLength(1);

    api.pollError = null;
    api.services = [];
    await h.tickAt(POLL_INTERVAL_MS + BACKOFF_START_MS);
    expect(metricsSource.watchLists).toEqual([["nginx", "postgresql"], []]);
  });

  it("a collector that throws costs one log line, never the tick", async () => {
    const api = new FakeApi();
    api.checks = [check("a", 15)];
    const metricsSource = new FakeMetricsSource();
    metricsSource.throwOnCollect = new Error("vm_stat exploded");
    const h = harness(api, new ResultBuffer(), metricsSource);
    await h.tickAt(0);
    expect(api.sent).toHaveLength(1);
    expect(lines.some((l) => l.includes("server-health collection failed"))).toBe(true);
  });

  it("flushes results BEFORE metrics on the same tick", async () => {
    const order: string[] = [];
    const api = new FakeApi();
    const originalSendResults = api.sendResults.bind(api);
    const originalSendMetrics = api.sendMetrics.bind(api);
    api.sendResults = async (results) => {
      order.push("results");
      return originalSendResults(results);
    };
    api.sendMetrics = async (request) => {
      order.push("metrics");
      return originalSendMetrics(request);
    };
    api.checks = [check("a", 15)];
    const metricsSource = new FakeMetricsSource();
    metricsSource.nextSample = metricSample(0);
    const h = harness(api, new ResultBuffer(), metricsSource);

    await h.tickAt(0);
    expect(order).toEqual(["results", "metrics"]);
  });

  it("a metrics send failure backs off independently and never delays or blocks results", async () => {
    const api = new FakeApi();
    api.checks = [check("a", 15)];
    api.sendMetricsError = new TransientError("metrics endpoint offline");
    const metricsSource = new FakeMetricsSource();
    metricsSource.nextSample = metricSample(0);
    const h = harness(api, new ResultBuffer(), metricsSource);

    await h.tickAt(0);
    // Results got through even though metrics is failing in the same tick.
    expect(api.sent).toHaveLength(1);
    expect(api.metricsSent).toHaveLength(0);
    expect(h.metricsBuffer.size).toBe(1);

    const metricsWarnings = lines.filter((l) => l.includes("metrics flush failed"));
    expect(metricsWarnings).toHaveLength(1);
  });

  it("a full results-flush backoff never blocks a metrics flush from succeeding", async () => {
    const api = new FakeApi();
    api.checks = [check("a", 15)];
    api.sendError = new TransientError("results endpoint offline"); // results only
    const metricsSource = new FakeMetricsSource();
    metricsSource.nextSample = metricSample(0);
    const h = harness(api, new ResultBuffer(), metricsSource);

    await h.tickAt(0);
    expect(api.sent).toHaveLength(0); // results backing off
    expect(api.metricsSent).toHaveLength(1); // metrics unaffected
  });

  it("never sends more than 100 metric samples in one call", async () => {
    const api = new FakeApi();
    const metricsSource = new FakeMetricsSource();
    const metricsBuffer = new MetricsBuffer();
    for (let i = 0; i < 250; i++) metricsBuffer.push(metricSample(i));
    const h = harness(api, new ResultBuffer(), metricsSource, metricsBuffer);

    await h.tickAt(0);
    expect(api.metricsSent[0]?.samples.length).toBeLessThanOrEqual(METRICS_FLUSH_BATCH_SIZE);
    await h.tickAt(FLUSH_INTERVAL_MS);
    await h.tickAt(FLUSH_INTERVAL_MS * 2);
    const total = api.metricsSent.reduce((n, r) => n + r.samples.length, 0);
    expect(total).toBeGreaterThanOrEqual(250);
  });

  it("on a vantage conflict (409), stops sending metrics for good, drops what is held, and leaves results alone", async () => {
    const api = new FakeApi();
    api.checks = [check("a", 15)];
    api.sendMetricsError = new VantageConflictError("This agent already reports from a host vantage.");
    const metricsSource = new FakeMetricsSource();
    metricsSource.nextSample = metricSample(0);
    const h = harness(api, new ResultBuffer(), metricsSource);

    await h.tickAt(0);
    expect(h.metricsBuffer.size).toBe(0); // dropped, not held for a retry that can never succeed
    const errorLine = lines.find((l) => l.includes("vantage rejected"));
    expect(errorLine).toBeDefined();
    expect(errorLine).toContain('"level":"error"');

    // Collection stops entirely: no more calls into the collector.
    const callsAfterRejection = metricsSource.calls;
    for (let t = 60_000; t <= 600_000; t += 15_000) await h.tickAt(t);
    expect(metricsSource.calls).toBe(callsAfterRejection);
    expect(api.metricsSent).toHaveLength(0);

    // Results keep flowing the whole time, unaffected.
    expect(api.sent.length).toBeGreaterThan(0);
  });

  it("drops the oldest samples once the metrics buffer overflows, and counts them", async () => {
    const api = new FakeApi();
    api.sendMetricsError = new TransientError("offline");
    const metricsBuffer = new MetricsBuffer(5);
    const metricsSource = new FakeMetricsSource();
    const h = harness(api, new ResultBuffer(), metricsSource, metricsBuffer);

    for (let t = 0; t <= 6 * METRICS_SAMPLE_INTERVAL_MS; t += METRICS_SAMPLE_INTERVAL_MS) {
      metricsSource.nextSample = metricSample(t);
      await h.tickAt(t);
    }
    expect(metricsBuffer.size).toBe(5);
    expect(metricsBuffer.dropped).toBeGreaterThan(0);
  });
});

describe("nextBackoff", () => {
  it("starts at 15s, doubles, and caps at 5 minutes", () => {
    expect(nextBackoff(0)).toBe(BACKOFF_START_MS);
    expect(nextBackoff(BACKOFF_START_MS)).toBe(30_000);
    expect(nextBackoff(240_000)).toBe(BACKOFF_MAX_MS);
    expect(nextBackoff(BACKOFF_MAX_MS)).toBe(BACKOFF_MAX_MS);
    expect(nextBackoff(10_000_000)).toBe(BACKOFF_MAX_MS);
  });
});
