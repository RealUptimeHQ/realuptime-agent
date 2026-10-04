import { afterEach, describe, expect, it, vi } from "vitest";
import { installErrorsReporting, loadErrorsReportConfig, redactAgentMessage } from "./errors-report.ts";

/**
 * REA-575: this agent's own unhandled exceptions/rejections report to
 * errors-internal using a hand-rolled client against the SDK's wire
 * contract (see errors-report.ts's module doc for why it does not import
 * @realuptime/errors). Off unless BOTH env vars are set, same gate as
 * every other RealUptime service.
 */

function fetchStub(): { fetchImpl: typeof fetch; calls: Array<[string, RequestInit]> } {
  const calls: Array<[string, RequestInit]> = [];
  const fetchImpl = (async (url: string, init: RequestInit) => {
    calls.push([url, init]);
    return new Response("{}", { status: 200 });
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

describe("loadErrorsReportConfig", () => {
  it("is null when REALUPTIME_ERRORS_INTERNAL is unset", () => {
    expect(loadErrorsReportConfig({ REALUPTIME_ERRORS_DSN: "https://x/api/errors/v1/ingest/rue_a" })).toBeNull();
  });

  it("is null when REALUPTIME_ERRORS_DSN is unset", () => {
    expect(loadErrorsReportConfig({ REALUPTIME_ERRORS_INTERNAL: "1" })).toBeNull();
  });

  it("is null when REALUPTIME_ERRORS_INTERNAL is not exactly \"1\"", () => {
    expect(
      loadErrorsReportConfig({ REALUPTIME_ERRORS_INTERNAL: "true", REALUPTIME_ERRORS_DSN: "https://x/api/errors/v1/ingest/rue_a" }),
    ).toBeNull();
  });

  it("uses FLY_APP_NAME as the environment label when set", () => {
    const config = loadErrorsReportConfig({
      REALUPTIME_ERRORS_INTERNAL: "1",
      REALUPTIME_ERRORS_DSN: "https://x/api/errors/v1/ingest/rue_a",
      FLY_APP_NAME: "realuptime-agent-host",
    });
    expect(config?.environment).toBe("realuptime-agent-host");
  });

  it("falls back to the hostname when FLY_APP_NAME is unset", () => {
    const config = loadErrorsReportConfig({
      REALUPTIME_ERRORS_INTERNAL: "1",
      REALUPTIME_ERRORS_DSN: "https://x/api/errors/v1/ingest/rue_a",
    });
    expect(config?.environment).toBeTruthy();
    expect(config?.environment).not.toBe("");
  });

  it("carries GIT_SHA as release, but never the literal \"unknown\"", () => {
    expect(
      loadErrorsReportConfig({
        REALUPTIME_ERRORS_INTERNAL: "1",
        REALUPTIME_ERRORS_DSN: "https://x/api/errors/v1/ingest/rue_a",
        GIT_SHA: "abc123",
      })?.release,
    ).toBe("abc123");
    expect(
      loadErrorsReportConfig({
        REALUPTIME_ERRORS_INTERNAL: "1",
        REALUPTIME_ERRORS_DSN: "https://x/api/errors/v1/ingest/rue_a",
        GIT_SHA: "unknown",
      })?.release,
    ).toBeUndefined();
  });
});

describe("installErrorsReporting", () => {
  const installed: Array<{ event: string; handler: (...args: unknown[]) => void }> = [];

  afterEach(() => {
    for (const { event, handler } of installed) process.removeListener(event, handler as never);
    installed.length = 0;
    vi.restoreAllMocks();
  });

  function trackListeners() {
    const on = process.on.bind(process);
    vi.spyOn(process, "on").mockImplementation((event: string | symbol, handler: (...args: unknown[]) => void) => {
      installed.push({ event: String(event), handler });
      return on(event, handler);
    });
  }

  it("logs disabled and installs nothing when the env vars are absent", () => {
    trackListeners();
    const logged: unknown[] = [];
    installErrorsReporting({}, (level, msg, fields) => logged.push({ level, msg, fields }));

    expect(logged).toEqual([{ level: "info", msg: "errors reporting disabled", fields: { reason: "REALUPTIME_ERRORS_INTERNAL not set" } }]);
    expect(installed).toHaveLength(0);
  });

  it("names the missing DSN specifically when only the flag is set", () => {
    trackListeners();
    const logged: unknown[] = [];
    installErrorsReporting({ REALUPTIME_ERRORS_INTERNAL: "1" }, (level, msg, fields) => logged.push({ level, msg, fields }));
    expect(logged).toEqual([{ level: "info", msg: "errors reporting disabled", fields: { reason: "REALUPTIME_ERRORS_DSN not set" } }]);
  });

  it("logs enabled and installs both handlers when both env vars are set", () => {
    trackListeners();
    const logged: unknown[] = [];
    installErrorsReporting(
      { REALUPTIME_ERRORS_INTERNAL: "1", REALUPTIME_ERRORS_DSN: "https://x/api/errors/v1/ingest/rue_a", FLY_APP_NAME: "test-host" },
      (level, msg, fields) => logged.push({ level, msg, fields }),
      fetchStub().fetchImpl,
    );

    expect(logged).toEqual([{ level: "info", msg: "errors reporting enabled", fields: { environment: "test-host" } }]);
    expect(installed.map((i) => i.event).sort()).toEqual(["uncaughtException", "unhandledRejection"]);
  });

  it("posts a wire-shaped batch of one event to the dsn on an uncaught exception, and never throws", async () => {
    trackListeners();
    const { fetchImpl, calls } = fetchStub();
    installErrorsReporting(
      { REALUPTIME_ERRORS_INTERNAL: "1", REALUPTIME_ERRORS_DSN: "https://x/api/errors/v1/ingest/rue_a", FLY_APP_NAME: "test-host" },
      () => {},
      fetchImpl,
    );

    const handler = installed.find((i) => i.event === "uncaughtException")?.handler;
    expect(handler).toBeDefined();
    handler?.(new Error("boom"));
    // send() is fire-and-forget; give its microtask a turn.
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(calls).toHaveLength(1);
    const [url, init] = calls[0];
    expect(url).toBe("https://x/api/errors/v1/ingest/rue_a");
    const body = JSON.parse(init.body as string);
    expect(body).toEqual({
      sdk: "realuptime-agent-native/1",
      droppedClient: 0,
      events: [
        {
          occurredAt: expect.any(String),
          message: "boom",
          exceptionType: "Error",
          release: null,
          environment: "test-host",
          frames: null,
          request: null,
          fingerprint: null,
        },
      ],
    });
  });

  it("a broken fetch never escapes the unhandledRejection handler", async () => {
    trackListeners();
    const throwingFetch = (async () => {
      throw new Error("network exploded");
    }) as unknown as typeof fetch;
    installErrorsReporting(
      { REALUPTIME_ERRORS_INTERNAL: "1", REALUPTIME_ERRORS_DSN: "https://x/api/errors/v1/ingest/rue_a" },
      () => {},
      throwingFetch,
    );

    const handler = installed.find((i) => i.event === "unhandledRejection")?.handler;
    expect(() => handler?.("a rejected string, not an Error")).not.toThrow();
    await new Promise((resolve) => setTimeout(resolve, 0));
  });

  it("sends the redacted message, never the raw one", async () => {
    trackListeners();
    const { fetchImpl, calls } = fetchStub();
    installErrorsReporting(
      { REALUPTIME_ERRORS_INTERNAL: "1", REALUPTIME_ERRORS_DSN: "https://x/api/errors/v1/ingest/rue_a", FLY_APP_NAME: "test-host" },
      () => {},
      fetchImpl,
    );
    installed.find((i) => i.event === "uncaughtException")?.handler(new Error("POST https://shop.acme-widgets.com/?x=1 by jane.doe@example.com"));
    await new Promise((resolve) => setTimeout(resolve, 0));
    const body = JSON.parse(String(calls[0][1].body));
    expect(body.events[0].message).toBe("POST <url> by <email>");
  });
});

describe("redactAgentMessage", () => {
  // The personal-data shapes packages/db/internal-telemetry.test.ts proves
  // the shared filter removes; this stricter copy must remove them too.
  const PERSONAL = [
    "jane.doe@example.com",
    "Jane Doe",
    "shop.acme-widgets.com",
    "tok_9f8e7d6c",
    "203.0.113.42",
    "2001:db8:85a3::8a2e:370:7334",
    "4f9c2b1e-8d7a-4c3b-9e2f-1a2b3c4d5e6f",
    "+14155550123",
    "Chocolate cake order",
  ];
  const messages = [
    "request to https://shop.acme-widgets.com/health?token=tok_9f8e7d6c failed, reason: getaddrinfo ENOTFOUND shop.acme-widgets.com",
    `Unexpected token 'u', "{"user":{"email":"jane.doe@example.com","name":"Jane Doe"}}" is not valid JSON`,
    'signup failed for "Jane Doe" <jane.doe@example.com> (+14155550123) on 4f9c2b1e-8d7a-4c3b-9e2f-1a2b3c4d5e6f from 203.0.113.42 / 2001:db8:85a3::8a2e:370:7334',
    'truncated echo "Chocolate cake order',
    "first line\nJane Doe on the second line",
  ];

  it("leaves nothing personal in any representative message", () => {
    for (const message of messages) {
      const out = redactAgentMessage(message);
      for (const value of PERSONAL) expect(out, message).not.toContain(value);
    }
  });

  it("keeps a plain docker socket error readable", () => {
    expect(redactAgentMessage("connect ENOENT /var/run/docker.sock")).toBe("connect ENOENT /var/run/docker.sock");
  });
});
