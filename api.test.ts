import { describe, expect, it } from "vitest";
import {
  ApiClient,
  AuthError,
  TransientError,
  VantageConflictError,
  parseChecks,
  parseRequestLogSnapshot,
  parseRules,
  parseServiceWatch,
} from "./api.ts";
import { FLUSH_BATCH_SIZE } from "./buffer.ts";
import { METRICS_FLUSH_BATCH_SIZE } from "./metrics-buffer.ts";
import type { AgentConfig } from "./config.ts";
import type { CheckResult, MetricSample, MetricsRequest } from "./types.ts";

const config: AgentConfig = {
  token: "rua_test_token",
  baseUrl: "https://realuptime.io",
  cluster: null,
  node: null,
  postgresDsn: null,
  redisDsn: null,
  mysqlDsn: null,
  gpuVendor: "nvidia",
  logUnits: [],
  logDockerEnabled: false,
  logLines: 50,
};

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
    const fetchImpl = (async () =>
      new Response("not json", { status: 200 })) as unknown as typeof fetch;
    await expect(new ApiClient(config, fetchImpl).poll()).rejects.toBeInstanceOf(TransientError);
  });

  it("refuses to send more than the contract's 100 results", async () => {
    const client = new ApiClient(config, stub(200));
    const tooMany = Array.from({ length: FLUSH_BATCH_SIZE + 1 }, (_, i) => result(i));
    await expect(client.sendResults(tooMany)).rejects.toBeInstanceOf(TransientError);
    await expect(client.sendResults(tooMany.slice(0, FLUSH_BATCH_SIZE))).resolves.toBeUndefined();
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
    expect(response).toEqual({
      accepted: 1,
      rejectedStale: 0,
      rejectedFuture: 0,
      rejectedDuplicate: 0,
    });
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
    const client = new ApiClient(
      config,
      stub(200, { accepted: 0, rejectedStale: 0, rejectedFuture: 0, rejectedDuplicate: 0 }),
    );
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

/**
 * The closed operation vocabulary, section 3.2 of
 * `docs/private-probe-locations.md`.
 *
 * The point of these is not that a malformed value is rejected. It is that a
 * value the server INVENTED cannot reach a dialer. An old agent facing a
 * server that learned a new verb has to refuse the verb, because that property
 * is what stops a compromised server teaching a deployed agent a capability it
 * was never compiled with.
 */
describe("parseChecks: the closed vocabulary", () => {
  it("holds exactly the four probe verbs and the six dns record types", () => {
    expect([...parseRules.checkTypes]).toEqual(["http", "tcp", "dns", "ping"]);
    // Byte-identical to the server's own z.enum in packages/db/api-schemas.ts.
    expect([...parseRules.dnsRecordTypes]).toEqual(["A", "AAAA", "CNAME", "MX", "TXT", "NS"]);
  });

  it("refuses a dns record type that is not on the list", () => {
    // ANY is resolveAny, the one query check-dns.ts's header says is never
    // used. Without the allowlist the type arrives as an unconstrained string
    // and goes straight to the resolver.
    for (const recordType of ["ANY", "SOA", "PTR", "SRV", "CAA", "any", "a"]) {
      const [c] = parseChecks({
        checks: [
          { id: "1", type: "dns", dnsHostname: "api.internal", dnsRecordType: recordType, intervalSeconds: 60 },
        ],
      });
      expect(c?.dnsRecordType).toBeNull();
    }
  });

  it("keeps every record type that IS on the list", () => {
    for (const recordType of parseRules.dnsRecordTypes) {
      const [c] = parseChecks({
        checks: [
          { id: "1", type: "dns", dnsHostname: "api.internal", dnsRecordType: recordType, intervalSeconds: 60 },
        ],
      });
      expect(c?.dnsRecordType).toBe(recordType);
    }
  });

  it("refuses a tcp port outside the real range, or one of the amplification ports", () => {
    for (const port of [0, -1, 65_536, 1.5, 7, 9, 13, 17, 19]) {
      const [c] = parseChecks({
        checks: [{ id: "1", type: "tcp", tcpHost: "db.internal", tcpPort: port, intervalSeconds: 60 }],
      });
      expect(c?.tcpPort).toBeNull();
    }
  });

  it("keeps an ordinary tcp port", () => {
    for (const port of [1, 22, 5432, 65_535]) {
      const [c] = parseChecks({
        checks: [{ id: "1", type: "tcp", tcpHost: "db.internal", tcpPort: port, intervalSeconds: 60 }],
      });
      expect(c?.tcpPort).toBe(port);
    }
  });

  /**
   * MUTATION TEST. Widen the vocabulary and the refusals have to disappear.
   * Without this, every assertion above would still pass if the allowlist were
   * replaced by an unconditional `true`, because a made-up verb would simply
   * be absent from the fixture's expectations.
   */
  it("mutation: with the vocabulary widened, the unknown verb is accepted", () => {
    const originalTypes = parseRules.checkTypes;
    const originalRecords = parseRules.dnsRecordTypes;
    try {
      parseRules.checkTypes = [...originalTypes, "quantum"];
      const [invented] = parseChecks({ checks: [{ id: "1", type: "quantum", intervalSeconds: 60 }] });
      expect(invented).toBeDefined();
      expect(invented?.type).toBe("quantum");

      parseRules.dnsRecordTypes = [...originalRecords, "ANY"];
      const [any] = parseChecks({
        checks: [{ id: "2", type: "dns", dnsHostname: "h.internal", dnsRecordType: "ANY", intervalSeconds: 60 }],
      });
      expect(any?.dnsRecordType).toBe("ANY");
    } finally {
      parseRules.checkTypes = originalTypes;
      parseRules.dnsRecordTypes = originalRecords;
    }
  });

  it("the vocabulary is restored afterwards", () => {
    expect(parseChecks({ checks: [{ id: "1", type: "quantum", intervalSeconds: 60 }] })).toEqual([]);
    const [c] = parseChecks({
      checks: [{ id: "2", type: "dns", dnsHostname: "h.internal", dnsRecordType: "ANY", intervalSeconds: 60 }],
    });
    expect(c?.dnsRecordType).toBeNull();
  });
});

describe("parseServiceWatch (protocol v2)", () => {
  it("reads the opt-in list, keeps only strings, and treats absence as nothing to watch", () => {
    expect(parseServiceWatch({ checks: [], services: ["nginx", 3, null, "sshd"] })).toEqual([
      "nginx",
      "sshd",
    ]);
    expect(parseServiceWatch({ checks: [] })).toEqual([]);
    expect(parseServiceWatch({ checks: [], services: "nginx" })).toEqual([]);
    expect(parseServiceWatch(null)).toEqual([]);
  });
});

describe("parseRequestLogSnapshot (REA-440, log snapshots phase 1)", () => {
  it("is true only for the literal boolean true", () => {
    expect(parseRequestLogSnapshot({ checks: [], requestLogSnapshot: true })).toBe(true);
    expect(parseRequestLogSnapshot({ checks: [], requestLogSnapshot: false })).toBe(false);
    expect(parseRequestLogSnapshot({ checks: [], requestLogSnapshot: "true" })).toBe(false);
    expect(parseRequestLogSnapshot({ checks: [] })).toBe(false);
    expect(parseRequestLogSnapshot(null)).toBe(false);
  });
});
