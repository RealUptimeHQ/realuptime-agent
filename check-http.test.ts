import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, describe, expect, it } from "vitest";
import { MAX_REDIRECTS, httpRules, runHttpCheck } from "./check-http.ts";

/**
 * Real local http servers on ephemeral ports, not a mocked `fetch`. The whole
 * point of these checks is what happens on a socket: a redirect chain, a
 * server that sends headers and then stalls, a body that must never be read. A
 * fetch stub proves none of that.
 */

const servers: http.Server[] = [];

async function serve(handler: http.RequestListener): Promise<string> {
  const server = http.createServer(handler);
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return `http://127.0.0.1:${port}`;
}

afterAll(async () => {
  await Promise.all(
    servers.map((s) => new Promise<void>((resolve) => s.close(() => resolve()))),
  );
});

describe("runHttpCheck", () => {
  it("counts a 200 as up and records the status and a latency", async () => {
    const url = await serve((_req, res) => res.writeHead(200).end("ok"));
    const out = await runHttpCheck(url);
    expect(out.ok).toBe(true);
    expect(out.statusCode).toBe(200);
    expect(out.latencyMs).toBeGreaterThanOrEqual(0);
    expect(out.error).toBeUndefined();
  });

  it("counts 204 as up and 199 / 300-with-no-location / 404 / 500 as down", async () => {
    const cases: Array<[number, boolean]> = [
      [204, true],
      [299, true],
      [404, false],
      [500, false],
      [503, false],
    ];
    for (const [status, expected] of cases) {
      const url = await serve((_req, res) => res.writeHead(status).end());
      const out = await runHttpCheck(url);
      expect(out.ok, `status ${status}`).toBe(expected);
      expect(out.statusCode).toBe(status);
    }
  });

  it("treats a 3xx with no Location as down rather than as a redirect", async () => {
    const url = await serve((_req, res) => res.writeHead(302).end());
    const out = await runHttpCheck(url);
    expect(out.ok).toBe(false);
    expect(out.statusCode).toBe(302);
  });

  it("follows up to three redirects and reports the final status", async () => {
    let hops = 0;
    const url = await serve((req, res) => {
      hops++;
      const n = Number(new URL(req.url ?? "/", "http://x").pathname.slice(1)) || 0;
      if (n < MAX_REDIRECTS) return res.writeHead(302, { location: `/${n + 1}` }).end();
      res.writeHead(200).end();
    });
    const out = await runHttpCheck(`${url}/0`);
    expect(out.ok).toBe(true);
    expect(out.statusCode).toBe(200);
    expect(hops).toBe(MAX_REDIRECTS + 1);
  });

  it("gives up on a fourth redirect", async () => {
    const url = await serve((_req, res) => res.writeHead(302, { location: "/next" }).end());
    const out = await runHttpCheck(url);
    expect(out.ok).toBe(false);
    expect(out.error).toBe("Too many redirects");
  });

  it("refuses to follow a redirect off http/https", async () => {
    const url = await serve((_req, res) =>
      res.writeHead(302, { location: "file:///etc/passwd" }).end(),
    );
    const out = await runHttpCheck(url);
    expect(out.ok).toBe(false);
    expect(out.error).toContain("Unsupported redirect target");
    expect(out.error).toContain("file");
  });

  it("reaches a private address without complaint, because that is the product", async () => {
    // 127.0.0.1 is exactly what the cloud fleet's SSRF guard refuses. The agent
    // must not inherit that refusal.
    const url = await serve((_req, res) => res.writeHead(200).end());
    expect(url).toContain("127.0.0.1");
    expect((await runHttpCheck(url)).ok).toBe(true);
  });

  it("never reads the body: a server that stalls mid-body still reports up", async () => {
    const url = await serve((_req, res) => {
      res.writeHead(200, { "content-length": "1000000" });
      res.write("first chunk");
      // Deliberately never ends. A prober that buffered the body would hang
      // here until the timeout and report a false outage.
    });
    const started = Date.now();
    const out = await runHttpCheck(url, 10_000);
    expect(out.ok).toBe(true);
    expect(out.statusCode).toBe(200);
    expect(Date.now() - started).toBeLessThan(5_000);
  });

  it("times out on a server that never sends headers", async () => {
    const url = await serve(() => {
      /* never responds */
    });
    const out = await runHttpCheck(url, 300);
    expect(out.ok).toBe(false);
    expect(out.error).toBe("The request timed out");
  });

  it("reports a refused connection as down", async () => {
    // Port 1 on loopback: nothing listens there.
    const out = await runHttpCheck("http://127.0.0.1:1/", 2_000);
    expect(out.ok).toBe(false);
    expect(out.error).toBeDefined();
    expect(out.statusCode).toBeUndefined();
  });

  it("surfaces the errno instead of a bare 'fetch failed'", async () => {
    // Node's fetch collapses connection and TLS failures into
    // `TypeError: fetch failed` and hides the distinguishing code on
    // `err.cause`. Whether a given platform populates that cause is not ours
    // to control, so the unwrapping is pinned directly rather than through a
    // real socket.
    const fetchImpl = (async () => {
      const err = new TypeError("fetch failed");
      (err as { cause?: unknown }).cause = { code: "CERT_HAS_EXPIRED" };
      throw err;
    }) as unknown as typeof fetch;
    const out = await runHttpCheck("http://10.0.0.1/", 2_000, fetchImpl);
    expect(out.ok).toBe(false);
    expect(out.error).toBe("fetch failed (CERT_HAS_EXPIRED)");
  });

  it("rejects a non-http scheme on the monitor's own target", async () => {
    const out = await runHttpCheck("ftp://example.internal/");
    expect(out.ok).toBe(false);
    expect(out.error).toContain("Unsupported monitor target");
  });

  /**
   * MUTATION TEST. "2xx is up" is the single rule every http result depends
   * on, and a test suite that would still pass with it broken is a suite that
   * proves nothing. Break it, watch the down-detection assertions flip,
   * restore in `finally`.
   */
  it("mutation: with the 2xx rule broken, the down assertions no longer hold", async () => {
    const url500 = await serve((_req, res) => res.writeHead(500).end());
    const url200 = await serve((_req, res) => res.writeHead(200).end());
    const original = httpRules.isUp;
    try {
      httpRules.isUp = () => true;
      const down = await runHttpCheck(url500);
      expect(down.ok).not.toBe(false);
      expect(down.ok).toBe(true);

      httpRules.isUp = () => false;
      const up = await runHttpCheck(url200);
      expect(up.ok).not.toBe(true);
      expect(up.ok).toBe(false);
    } finally {
      httpRules.isUp = original;
    }
  });

  it("mutation: the 2xx rule is restored afterwards", async () => {
    const url = await serve((_req, res) => res.writeHead(500).end());
    expect((await runHttpCheck(url)).ok).toBe(false);
    expect(httpRules.isUp(200)).toBe(true);
    expect(httpRules.isUp(500)).toBe(false);
  });
});

describe("runHttpCheck: the egress guard", () => {
  it("never sends the request when the guard refuses", async () => {
    let requests = 0;
    const url = await serve((_req, res) => {
      requests++;
      res.writeHead(200).end();
    });
    const out = await runHttpCheck(url, undefined, undefined, undefined, async () => ({
      proceed: false,
      error: "Blocked by this location's local policy (public address)",
      addresses: [],
    }));
    expect(requests).toBe(0);
    expect(out.ok).toBe(false);
    expect(out.error).toBe("Blocked by this location's local policy (public address)");
  });

  it("is asked again on every redirect hop", async () => {
    // A redirect is a dial at a host the first verdict never saw. Checking
    // once at the top of the chain is the classic hole in this shape.
    const final = await serve((_req, res) => res.writeHead(200).end());
    const start = await serve((_req, res) => res.writeHead(302, { location: final }).end());
    const asked: string[] = [];
    const out = await runHttpCheck(start, undefined, undefined, undefined, async (host, port) => {
      asked.push(`${host}:${port}`);
      return { proceed: true, addresses: [] };
    });
    expect(out.ok).toBe(true);
    expect(asked).toHaveLength(2);
  });

  it("refuses a redirect the first hop was allowed to make", async () => {
    const final = await serve((_req, res) => res.writeHead(200).end());
    const start = await serve((_req, res) => res.writeHead(302, { location: final }).end());
    let hop = 0;
    const out = await runHttpCheck(start, undefined, undefined, undefined, async () => {
      hop++;
      return hop === 1
        ? { proceed: true, addresses: [] }
        : { proceed: false, error: "Blocked by this location's local policy (public address)", addresses: [] };
    });
    expect(out.ok).toBe(false);
    expect(out.error).toContain("Blocked by this location's local policy");
  });

  it("resolves the default port, so a rule naming 443 sees an https target", async () => {
    const asked: (number | null)[] = [];
    await runHttpCheck("https://host.invalid/health", 500, undefined, undefined, async (_host, port) => {
      asked.push(port);
      return { proceed: false, error: "no", addresses: [] };
    });
    await runHttpCheck("http://host.invalid/health", 500, undefined, undefined, async (_host, port) => {
      asked.push(port);
      return { proceed: false, error: "no", addresses: [] };
    });
    await runHttpCheck("http://host.invalid:8080/health", 500, undefined, undefined, async (_host, port) => {
      asked.push(port);
      return { proceed: false, error: "no", addresses: [] };
    });
    expect(asked).toEqual([443, 80, 8080]);
  });

  it("without a guard, behaves exactly as it did before one existed", async () => {
    const url = await serve((_req, res) => res.writeHead(200).end());
    expect((await runHttpCheck(url)).ok).toBe(true);
  });
});
