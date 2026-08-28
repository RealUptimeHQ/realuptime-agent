import { describe, expect, it } from "vitest";
import { ApiClient, AuthError, TransientError, VantageConflictError, parseChecks, parseServiceWatch } from "./api.ts";
import { FLUSH_BATCH_SIZE } from "./buffer.ts";
import { METRICS_FLUSH_BATCH_SIZE } from "./metrics-buffer.ts";
import type { CheckResult, MetricSample, MetricsRequest } from "./types.ts";

const config = { token: "rua_test_token", baseUrl: "https://realuptime.io", cluster: null, node: null };

function stub(status: number, body: unknown = {}): typeof fetch {
  return (async () =>
    new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    })) as unknown as typeof fetch;
}

function result(n: number): CheckResult {
  return { checkId: `c${n}`, ok: true, checkedAt: new Date(n).toISOString() };
}

describe("ApiClient", () => {
  it("posts to the contract's paths with a bearer token and an empty poll body", async () => {
    const calls: Array<[string, RequestInit]> = [];
    const fetchImpl = (async (url: string, init: RequestInit) => {
      calls.push([url, init]);
      return new Response(JSON.stringify({ checks: [] }), { status: 200 });
    }) as unknown as typeof fetch;

    const client = new ApiClient(config, fetchImpl);
    await client.poll();
    await client.sendResults([result(1)]);

    const [pollUrl, pollInit] = calls[0]!;
    expect(pollUrl).toBe("https://realuptime.io/api/agent/v1/poll");
    expect(pollInit.method).toBe("POST");
    expect(pollInit.body).toBe("{}");
    expect((pollInit.headers as Record<string, string>).authorization).toBe(
      "Bearer rua_test_token",
    );
    expect(calls[1]?.[0]).toBe("https://realuptime.io/api/agent/v1/results");
    expect(JSON.parse(String(calls[1]?.[1].body))).toEqual({ results: [result(1)] });
  });

  it("turns 401 into AuthError, and everything else retryable into TransientError", async () => {
    await expect(new ApiClient(config, stub(401)).poll()).rejects.toBeInstanceOf(AuthError);
    for (const status of [404, 429, 500, 502, 503]) {
      const err = await new ApiClient(config, stub(status)).poll().catch((e) => e);
      expect(err, `status ${status}`).toBeInstanceOf(TransientError);
      expect((err as TransientError).status).toBe(status);
    }
  });

  it("turns a network failure into a TransientError rather than crashing", async () => {
    const fetchImpl = (async () => {
      throw new TypeError("fetch failed");
    }) as unknown as typeof fetch;
    await expect(new ApiClient(config, fetchImpl).poll()).rejects.toBeInstanceOf(TransientError);
  });

  it("treats a 200 with an unreadable body as transient", async () => {
    const fetchImpl = (async () => new Response("not json", { status: 200 })) as unknown as typeof fetch;
    await expect(new ApiClient(config, fetchImpl).poll()).rejects.toBeInstanceOf(TransientError);
  });

  it("refuses to send more than the contract's 100 results", async () => {
    const client = new ApiClient(config, stub(200));
    const tooMany = Array.from({ length: FLUSH_BATCH_SIZE + 1 }, (_, i) => result(i));
    await expect(client.sendResults(tooMany)).rejects.toBeInstanceOf(TransientError);
    await expect(
      client.sendResults(tooMany.slice(0, FLUSH_BATCH_SIZE)),
    ).resolves.toBeUndefined();
  });
});

function metricSample(n: number): MetricSample {
  return {
    sampledAt: new Date(n).toISOString(),
    cpuUsedRatio: 0.5,
    cpuCores: 4,
    memoryTotalBytes: 1000,
    memoryUsedBytes: 500,
    filesystems: [],
  };
}

function metricsRequest(samples: MetricSample[]): MetricsRequest {
  return { vantage: "host", vantageDetail: null, collectorVersion: "0.1.0", samples };
}

describe("ApiClient.sendMetrics", () => {
  it("posts to /api/agent/v1/metrics with the vantage and samples", async () => {
    const calls: Array<[string, RequestInit]> = [];
    const fetchImpl = (async (url: string, init: RequestInit) => {
      calls.push([url, init]);
      return new Response(
        JSON.stringify({ accepted: 1, rejectedStale: 0, rejectedFuture: 0, rejectedDuplicate: 0 }),
        { status: 200 },
      );
    }) as unknown as typeof fetch;

    const client = new ApiClient(config, fetchImpl);
    const response = await client.sendMetrics(metricsRequest([metricSample(1)]));

    expect(calls[0]?.[0]).toBe("https://realuptime.io/api/agent/v1/metrics");
    expect(JSON.parse(String(calls[0]?.[1].body))).toEqual(metricsRequest([metricSample(1)]));
    expect(response).toEqual({ accepted: 1, rejectedStale: 0, rejectedFuture: 0, rejectedDuplicate: 0 });
  });

  it("turns a 409 into VantageConflictError, carrying the server's message", async () => {
    const fetchImpl = (async () =>
      new Response(JSON.stringify({ error: "This agent already reports from a host vantage." }), {
        status: 409,
      })) as unknown as typeof fetch;
    const err = await new ApiClient(config, fetchImpl)
      .sendMetrics(metricsRequest([metricSample(1)]))
      .catch((e) => e);
    expect(err).toBeInstanceOf(VantageConflictError);
    expect((err as VantageConflictError).message).toContain("host vantage");
  });

  it("turns 401 into AuthError and 5xx into TransientError, like every other route", async () => {
    await expect(
      new ApiClient(config, stub(401)).sendMetrics(metricsRequest([metricSample(1)])),
    ).rejects.toBeInstanceOf(AuthError);
    await expect(
      new ApiClient(config, stub(500)).sendMetrics(metricsRequest([metricSample(1)])),
    ).rejects.toBeInstanceOf(TransientError);
  });

  it("refuses to send more than the contract's 100 samples", async () => {
    const client = new ApiClient(config, stub(200, { accepted: 0, rejectedStale: 0, rejectedFuture: 0, rejectedDuplicate: 0 }));
    const tooMany = metricsRequest(
      Array.from({ length: METRICS_FLUSH_BATCH_SIZE + 1 }, (_, i) => metricSample(i)),
    );
    await expect(client.sendMetrics(tooMany)).rejects.toBeInstanceOf(TransientError);
  });
});

describe("parseChecks", () => {
  it("reads the contract's field names off the wire", () => {
    const checks = parseChecks({
      checks: [
        {
          id: "1",
          type: "http",
          url: "http://10.0.0.1/health",
          tcpHost: null,
          tcpPort: null,
          tcpTls: null,
          dnsHostname: null,
          dnsRecordType: null,
          dnsExpectedValue: null,
          intervalSeconds: 60,
        },
        {
          id: "2",
          type: "tcp",
          tcpHost: "db.internal",
          tcpPort: 5432,
          tcpTls: true,
          intervalSeconds: 30,
        },
        {
          id: "3",
          type: "dns",
          dnsHostname: "api.internal",
          dnsRecordType: "A",
          dnsExpectedValue: "10.0.0.4",
          intervalSeconds: 300,
        },
      ],
    });

    expect(checks).toHaveLength(3);
    expect(checks[0]).toMatchObject({ type: "http", url: "http://10.0.0.1/health" });
    expect(checks[1]).toMatchObject({ tcpHost: "db.internal", tcpPort: 5432, tcpTls: true });
    expect(checks[2]).toMatchObject({
      dnsHostname: "api.internal",
      dnsRecordType: "A",
      dnsExpectedValue: "10.0.0.4",
      intervalSeconds: 300,
    });
  });

  it("skips a check type it has never heard of instead of crashing", () => {
    // A newer server, an older agent. The checks it DOES understand must keep
    // running.
    const checks = parseChecks({
      checks: [
        { id: "1", type: "http", url: "http://10.0.0.1/", intervalSeconds: 60 },
        { id: "2", type: "quantum", intervalSeconds: 60 },
        null,
        "nonsense",
      ],
    });
    expect(checks.map((c) => c.id)).toEqual(["1"]);
  });

  it("rejects a response with no checks array", () => {
    expect(() => parseChecks({})).toThrow(TransientError);
    expect(() => parseChecks(null)).toThrow(TransientError);
  });

  it("defaults a missing interval rather than scheduling NaN", () => {
    const [c] = parseChecks({ checks: [{ id: "1", type: "http", url: "http://x/" }] });
    expect(c?.intervalSeconds).toBe(60);
  });
});

describe("parseServiceWatch (protocol v2)", () => {
  it("reads the opt-in list, keeps only strings, and treats absence as nothing to watch", () => {
    expect(parseServiceWatch({ checks: [], services: ["nginx", 3, null, "sshd"] })).toEqual(["nginx", "sshd"]);
    expect(parseServiceWatch({ checks: [] })).toEqual([]);
    expect(parseServiceWatch({ checks: [], services: "nginx" })).toEqual([]);
    expect(parseServiceWatch(null)).toEqual([]);
  });
});
