// biome-ignore-all lint/suspicious/noTemplateCurlyInString: ${SECRET:NAME} is the literal wire format of a secret reference, never a template placeholder
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
  authHeaderNames: [],
  secretsFile: null,
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
  it("carries the location's egress mode and counts on the poll when given them (REA-1013)", async () => {
    const calls: [string, RequestInit][] = [];
    const client = new ApiClient(config, async (url, init) => {
      calls.push([String(url), init ?? {}]);
      return new Response(JSON.stringify({ checks: [], services: [], requestLogSnapshot: false }), { status: 200 });
    });
    await client.poll({ mode: "report", refused: 0, wouldRefuse: 3, byRule: { public: 3 } });
    expect(JSON.parse(String(calls[0]![1].body))).toEqual({
      egress: { mode: "report", refused: 0, wouldRefuse: 3, byRule: { public: 3 } },
    });
  });

  it("carries this build's version and capabilities on the poll when given them (phase 3)", async () => {
    const calls: [string, RequestInit][] = [];
    const client = new ApiClient(config, async (url, init) => {
      calls.push([String(url), init ?? {}]);
      return new Response(JSON.stringify({ checks: [] }), { status: 200 });
    });
    await client.poll(undefined, { version: "0.4.0", capabilities: ["secret_refs"], secretHeaderNames: ["X-Internal-Auth"] });
    expect(JSON.parse(String(calls[0]![1].body))).toEqual({
      agent: { version: "0.4.0", capabilities: ["secret_refs"], secretHeaderNames: ["X-Internal-Auth"] },
    });
  });

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

describe("parseChecks: the auth block (private locations phase 3)", () => {
  const http = (auth: unknown) => ({ id: "a1", type: "http", url: "http://10.0.0.5/admin", intervalSeconds: 60, auth });

  it("reads a well-formed block verbatim, references and all", () => {
    const [check] = parseChecks({
      checks: [
        http({
          headers: [{ name: "Authorization", value: "Bearer ${SECRET:BILLING_API_TOKEN}" }],
          userinfo: null,
        }),
      ],
    });
    expect(check?.auth).toEqual({
      headers: [{ name: "Authorization", value: "Bearer ${SECRET:BILLING_API_TOKEN}" }],
      userinfo: null,
    });
  });

  it("treats absent, null and empty blocks as an unauthenticated check", () => {
    for (const auth of [undefined, null, { headers: [], userinfo: null }, { headers: [] }]) {
      const [check] = parseChecks({ checks: [http(auth)] });
      expect(check?.auth, JSON.stringify(auth)).toBeNull();
    }
  });

  it("refuses the whole check for any shape it does not understand, and keeps the others", () => {
    const refused = [
      "Bearer x",
      [],
      { headers: "Authorization: x" },
      { headers: [{ name: "Authorization", value: "a", extra: 1 }] },
      { headers: [{ name: "Authorization" }] },
      { headers: [{ name: "Bad Name", value: "${SECRET:A}" }] },
      { headers: [{ name: "Authorization", value: "Bearer ${SECRET:A}\r\nX-Evil: 1" }] },
      { headers: [{ name: "Authorization", value: "" }] },
      { headers: [{ name: "Authorization", value: "x".repeat(parseRules.maxAuthTemplateChars + 1) }] },
      { headers: Array.from({ length: parseRules.maxAuthHeaders + 1 }, () => ({ name: "Cookie", value: "a=${SECRET:A}" })) },
      { headers: [], userinfo: 42 },
      { headers: [], userinfo: "admin:${SECRET:PW}\n" },
      // A key a future server might add. Half-reading a block is the
      // pass-through the closed vocabulary forbids.
      { headers: [], userinfo: null, query: "token=${SECRET:A}" },
    ];
    for (const auth of refused) {
      const checks = parseChecks({ checks: [http(auth), { id: "ok", type: "tcp", tcpHost: "db", tcpPort: 5432, intervalSeconds: 60 }] });
      expect(checks.map((c) => c.id), JSON.stringify(auth)).toEqual(["ok"]);
    }
  });

  it("refuses an auth block on a check type that has no request to put it in", () => {
    const checks = parseChecks({
      checks: [{ id: "t", type: "tcp", tcpHost: "db", tcpPort: 5432, intervalSeconds: 60, auth: { headers: [], userinfo: "a:${SECRET:B}" } }],
    });
    expect(checks).toEqual([]);
  });

  it("mutation: with the auth keys widened, the unknown key is accepted", () => {
    const original = parseRules.authKeys;
    try {
      parseRules.authKeys = [...original, "query"];
      const [check] = parseChecks({ checks: [http({ headers: [], userinfo: "a:${SECRET:B}", query: "x" })] });
      expect(check?.auth?.userinfo).toBe("a:${SECRET:B}");
    } finally {
      parseRules.authKeys = original;
    }
    expect(parseChecks({ checks: [http({ headers: [], userinfo: "a:${SECRET:B}", query: "x" })] })).toEqual([]);
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
