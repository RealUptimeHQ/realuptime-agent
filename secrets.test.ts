// biome-ignore-all lint/suspicious/noTemplateCurlyInString: ${SECRET:NAME} is the literal wire format of a secret reference, never a template placeholder
import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { executeCheck, type CheckSecrets } from "./execute.ts";
import { __clearRegisteredSecrets, log, logSink, REDACTED, redactSecrets } from "./log.ts";
import {
  allowedAuthHeaderNames,
  BASE_AUTH_HEADER_NAMES,
  createSecretSource,
  declaredAuthHeaderNames,
  parseSecretsFile,
  parseTemplate,
  prepareCheckAuth,
  type SecretSource,
} from "./secrets.ts";
import type { AgentCheck } from "./types.ts";

/**
 * Secrets for authenticated internal checks (`docs/private-probe-locations.md`
 * section 3.6). The four rules, each proven against a real socket where the
 * rule is about what goes on the wire: closed positions, this machine's header
 * allowlist, an unresolvable name failing loudly, and values never leaving in
 * anything but the request.
 *
 * Every secret value in this file is an obviously fake fixture.
 */

const servers: http.Server[] = [];
type Seen = { url: string; headers: http.IncomingHttpHeaders };

async function serve(handler?: (req: http.IncomingMessage, res: http.ServerResponse) => void): Promise<{ url: string; seen: Seen[] }> {
  const seen: Seen[] = [];
  const server = http.createServer((req, res) => {
    seen.push({ url: req.url ?? "", headers: req.headers });
    if (handler) handler(req, res);
    else res.writeHead(200).end("ok");
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return { url: `http://127.0.0.1:${port}`, seen };
}

afterAll(async () => {
  await Promise.all(servers.map((s) => new Promise<void>((resolve) => s.close(() => resolve()))));
});

afterEach(() => {
  __clearRegisteredSecrets();
});

const FAKE_TOKEN = "fake-token-0123456789abcdef";

function source(values: Record<string, string>): SecretSource {
  return { lookup: (name) => values[name] };
}

function secrets(values: Record<string, string>, declared: string[] = []): CheckSecrets {
  return { source: source(values), allowedHeaderNames: allowedAuthHeaderNames(declared) };
}

function httpCheck(url: string, auth: AgentCheck["auth"]): AgentCheck {
  return { id: "chk_auth", type: "http", url, intervalSeconds: 60, auth };
}

describe("resolution", () => {
  it("reads REALUPTIME_SECRET_<NAME> from the environment", () => {
    const s = createSecretSource({ env: { REALUPTIME_SECRET_BILLING_API_TOKEN: FAKE_TOKEN } });
    expect(s.lookup("BILLING_API_TOKEN")).toBe(FAKE_TOKEN);
    expect(s.lookup("OTHER")).toBeUndefined();
  });

  it("falls back to the secrets file, and the environment wins when both set a name", () => {
    const s = createSecretSource({
      env: { REALUPTIME_SECRET_A: "from-env-value" },
      secretsFile: "/etc/realuptime/secrets",
      readFile: () => "A=from-file-value\nB=file-only-value\n",
      stamp: () => "1",
    });
    expect(s.lookup("A")).toBe("from-env-value");
    expect(s.lookup("B")).toBe("file-only-value");
  });

  it("re-reads the file when it changes, so a rotated value needs no restart", () => {
    let contents = "TOKEN=first-value-1234";
    let version = 1;
    const s = createSecretSource({
      env: {},
      secretsFile: "/secrets",
      readFile: () => contents,
      stamp: () => String(version),
    });
    expect(s.lookup("TOKEN")).toBe("first-value-1234");
    contents = "TOKEN=second-value-5678";
    expect(s.lookup("TOKEN"), "unchanged stamp, cached").toBe("first-value-1234");
    version = 2;
    expect(s.lookup("TOKEN")).toBe("second-value-5678");
  });

  it("treats an unreadable file as holding no secrets, logging once, never throwing", () => {
    const lines: string[] = [];
    const original = logSink.write;
    logSink.write = (line) => lines.push(line);
    try {
      const s = createSecretSource({
        env: {},
        secretsFile: "/missing",
        readFile: () => "",
        stamp: () => {
          throw new Error("ENOENT: no such file");
        },
      });
      expect(s.lookup("A")).toBeUndefined();
      expect(s.lookup("B")).toBeUndefined();
    } finally {
      logSink.write = original;
    }
    expect(lines.filter((line) => line.includes("REALUPTIME_SECRETS_FILE could not be read"))).toHaveLength(1);
  });

  it("never looks up a name outside the secret-name charset", () => {
    const s = createSecretSource({ env: { "REALUPTIME_SECRET_lower": "x", REALUPTIME_SECRET_: "y" } });
    expect(s.lookup("lower")).toBeUndefined();
    expect(s.lookup("")).toBeUndefined();
  });

  it("parses NAME=value lines, comments, export prefixes and one pair of quotes", () => {
    const parsed = parseSecretsFile(
      [
        "# comment",
        "",
        "PLAIN=abc=def",
        'QUOTED="with spaces"',
        "export EXPORTED='single'",
        "lower=ignored",
        "NOEQUALS",
        "WINDOWS=crlf\r",
      ].join("\n"),
    );
    expect(Object.fromEntries(parsed)).toEqual({
      PLAIN: "abc=def",
      QUOTED: "with spaces",
      EXPORTED: "single",
      WINDOWS: "crlf",
    });
  });
});

describe("templates", () => {
  it("splits literal text from references", () => {
    expect(parseTemplate("Bearer ${SECRET:TOKEN}")).toEqual([{ literal: "Bearer " }, { secret: "TOKEN" }]);
    expect(parseTemplate("a=${SECRET:A}; b=${SECRET:B}")).toEqual([
      { literal: "a=" },
      { secret: "A" },
      { literal: "; b=" },
      { secret: "B" },
    ]);
  });

  it("refuses anything reference-shaped that is not a well-formed reference", () => {
    for (const bad of ["${SECRET:lower}", "${OTHER:X}", "${SECRET:A", "Bearer ${TOKEN}", "${SECRET:}"]) {
      expect(parseTemplate(bad), bad).toBeNull();
    }
  });
});

describe("closed positions", () => {
  it("refuses a reference in the host, the path, the query or the port, before any request", async () => {
    const target = await serve();
    const s = secrets({ X: "fake-value-xyz" });
    const urls = [
      "http://${SECRET:X}.attacker.example/",
      `${target.url}/\${SECRET:X}`,
      `${target.url}/health?token=\${SECRET:X}`,
      `${target.url}/health?token=%24%7BSECRET%3AX%7D`,
      `${target.url}/health?token=$%7Bsecret:X%7D`,
    ];
    for (const url of urls) {
      const result = await executeCheck(httpCheck(url, null), undefined, s);
      expect(result.ok, url).toBe(false);
      expect(result.error).toBe(
        "Secret references are only allowed in request headers and URL credentials, never in the address itself",
      );
    }
    expect(target.seen).toHaveLength(0);
  });

  it("substitutes in a header value and sends exactly the resolved header", async () => {
    const target = await serve();
    const result = await executeCheck(
      httpCheck(`${target.url}/admin`, {
        headers: [{ name: "Authorization", value: "Bearer ${SECRET:BILLING_API_TOKEN}" }],
        userinfo: null,
      }),
      undefined,
      secrets({ BILLING_API_TOKEN: FAKE_TOKEN }),
    );
    expect(result.ok).toBe(true);
    expect(target.seen[0]?.headers.authorization).toBe(`Bearer ${FAKE_TOKEN}`);
    expect(target.seen[0]?.headers["user-agent"]).toBe("RealUptime-Monitor-Agent");
  });

  it("sends URL credentials as HTTP Basic, never in the URL", async () => {
    const target = await serve();
    const result = await executeCheck(
      httpCheck(`${target.url}/admin`, { headers: [], userinfo: "admin:${SECRET:ADMIN_PASSWORD}" }),
      undefined,
      secrets({ ADMIN_PASSWORD: "fake-pass-9876" }),
    );
    expect(result.ok).toBe(true);
    expect(target.seen[0]?.headers.authorization).toBe(
      `Basic ${Buffer.from("admin:fake-pass-9876").toString("base64")}`,
    );
    expect(target.seen[0]?.url).toBe("/admin");
  });

  it("refuses URL credentials and an Authorization header on the same check", () => {
    const prepared = prepareCheckAuth(
      "http://10.0.0.5/",
      { headers: [{ name: "Authorization", value: "Bearer ${SECRET:A}" }], userinfo: "u:${SECRET:B}" },
      source({ A: "fake-aaaa", B: "fake-bbbb" }),
    );
    expect(prepared).toEqual({ ok: false, error: "Set URL credentials or an Authorization header on this check, not both" });
  });

  it("sends the credential to the same origin on a redirect, and never to another origin", async () => {
    const elsewhere = await serve();
    const sameOriginHop = await serve((req, res) => {
      if (req.url === "/start") res.writeHead(302, { location: "/next" }).end();
      else if (req.url === "/next") res.writeHead(302, { location: `${elsewhere.url}/landing` }).end();
      else res.writeHead(404).end();
    });
    await executeCheck(
      httpCheck(`${sameOriginHop.url}/start`, {
        headers: [{ name: "X-Api-Key", value: "${SECRET:KEY}" }],
        userinfo: null,
      }),
      undefined,
      secrets({ KEY: FAKE_TOKEN }),
    );
    expect(sameOriginHop.seen.map((s) => s.headers["x-api-key"])).toEqual([FAKE_TOKEN, FAKE_TOKEN]);
    expect(elsewhere.seen).toHaveLength(1);
    expect(elsewhere.seen[0]?.headers["x-api-key"]).toBeUndefined();
  });
});

describe("the header-name allowlist lives on this machine", () => {
  it("allows the base four in any case, and nothing else by default", () => {
    expect(allowedAuthHeaderNames([]).sort()).toEqual(BASE_AUTH_HEADER_NAMES.map((n) => n.toLowerCase()).sort());
    const ok = prepareCheckAuth("http://10.0.0.5/", { headers: [{ name: "cookie", value: "s=${SECRET:S}" }], userinfo: null }, source({ S: "fake-cookie" }));
    expect(ok.ok).toBe(true);
    const refused = prepareCheckAuth(
      "http://10.0.0.5/",
      { headers: [{ name: "X-Internal-Auth", value: "${SECRET:S}" }], userinfo: null },
      source({ S: "fake-cookie" }),
    );
    expect(refused).toEqual({
      ok: false,
      error: "This location does not send the X-Internal-Auth header. Add it to REALUPTIME_AUTH_HEADERS on this machine to allow it",
    });
  });

  it("adds a customer-declared name, and never a forbidden or malformed one", () => {
    const allowed = allowedAuthHeaderNames(["X-Internal-Auth", "Host", "User-Agent", "Content-Length", "bad name", "Transfer-Encoding"]);
    expect(allowed).toContain("x-internal-auth");
    for (const forbidden of ["host", "user-agent", "content-length", "bad name", "transfer-encoding"]) {
      expect(allowed, forbidden).not.toContain(forbidden);
    }
    expect(declaredAuthHeaderNames(["X-Internal-Auth", "x-internal-auth", "Authorization", "Host"])).toEqual(["X-Internal-Auth"]);
  });

  it("refuses the same header twice", () => {
    const prepared = prepareCheckAuth(
      "http://10.0.0.5/",
      {
        headers: [
          { name: "Cookie", value: "a=${SECRET:A}" },
          { name: "cookie", value: "b=${SECRET:A}" },
        ],
        userinfo: null,
      },
      source({ A: "fake-aaaa" }),
    );
    expect(prepared.ok).toBe(false);
  });
});

describe("an unresolvable name fails the check loudly", () => {
  it("reads 'This location has no secret named NAME' and sends nothing", async () => {
    const target = await serve();
    const result = await executeCheck(
      httpCheck(`${target.url}/admin`, {
        headers: [{ name: "Authorization", value: "Bearer ${SECRET:BILLING_API_TOKEN}" }],
        userinfo: null,
      }),
      undefined,
      secrets({}),
    );
    expect(result).toMatchObject({ ok: false, error: "This location has no secret named BILLING_API_TOKEN" });
    expect(target.seen).toHaveLength(0);
  });

  it("fails the same way with no secret source configured at all", async () => {
    const target = await serve();
    const result = await executeCheck(
      httpCheck(`${target.url}/`, { headers: [], userinfo: "admin:${SECRET:PW}" }),
    );
    expect(result.error).toBe("This location has no secret named PW");
    expect(target.seen).toHaveLength(0);
  });

  it("refuses a value that would split the header, naming no value", async () => {
    const target = await serve();
    const result = await executeCheck(
      httpCheck(`${target.url}/`, { headers: [{ name: "X-Api-Key", value: "${SECRET:K}" }], userinfo: null }),
      undefined,
      secrets({ K: "fake-key\r\nX-Evil: 1" }),
    );
    expect(result.ok).toBe(false);
    expect(result.error).toContain("line break");
    expect(result.error).not.toContain("fake-key");
    expect(target.seen).toHaveLength(0);
  });

  it("refuses a malformed reference rather than sending it as text", async () => {
    const target = await serve();
    const result = await executeCheck(
      httpCheck(`${target.url}/`, { headers: [{ name: "X-Api-Key", value: "${SECRET:lower}" }], userinfo: null }),
      undefined,
      secrets({}),
    );
    expect(result.error).toBe("A secret reference on this check is malformed. Write it as ${SECRET:NAME}");
    expect(target.seen).toHaveLength(0);
  });
});

describe("redaction", () => {
  it("scrubs a resolved value from an error string before the result is queued", async () => {
    // The realistic leak: a service that echoes the credential back in a
    // response header, and a header assertion whose failure message quotes
    // what the header actually said.
    const target = await serve((req, res) =>
      res.writeHead(200, { "x-echo": String(req.headers["x-api-key"] ?? "") }).end(),
    );
    const result = await executeCheck(
      {
        ...httpCheck(`${target.url}/`, { headers: [{ name: "X-Api-Key", value: "${SECRET:K}" }], userinfo: null }),
        assertionHeaderName: "x-echo",
        assertionHeaderOp: "equals",
        assertionHeaderValue: "expected-value",
      },
      undefined,
      secrets({ K: FAKE_TOKEN }),
    );
    expect(result.ok).toBe(false);
    expect(result.error).toBe(`Assertion failed: header "x-echo" was "${REDACTED}", expected "expected-value"`);
  });

  it("scrubs every registered value from every log line, including nested fields", () => {
    prepareCheckAuth(
      "http://10.0.0.5/",
      { headers: [{ name: "X-Api-Key", value: "${SECRET:K}" }], userinfo: "svc:${SECRET:P}" },
      source({ K: FAKE_TOKEN, P: "fake-password-abc" }),
    );
    const lines: string[] = [];
    const original = logSink.write;
    logSink.write = (line) => lines.push(line);
    try {
      log("warn", `request failed with ${FAKE_TOKEN}`, {
        error: `upstream said fake-password-abc`,
        nested: { deep: [FAKE_TOKEN] },
        basic: Buffer.from("svc:fake-password-abc").toString("base64"),
      });
    } finally {
      logSink.write = original;
    }
    const line = lines.join("\n");
    expect(line).not.toContain(FAKE_TOKEN);
    expect(line).not.toContain("fake-password-abc");
    expect(line).not.toContain(Buffer.from("svc:fake-password-abc").toString("base64"));
    expect(line).toContain(REDACTED);
  });

  it("matches by prefix, so a truncated secret is scrubbed too", () => {
    const truncated = `error: ${FAKE_TOKEN.slice(0, 12)}`;
    expect(redactSecrets(truncated, [FAKE_TOKEN])).toBe(`error: ${REDACTED}`);
    expect(redactSecrets("nothing here", [FAKE_TOKEN])).toBe("nothing here");
  });

  it("leaves values too short to tell apart from words alone", () => {
    expect(redactSecrets("the cat sat", ["cat"])).toBe("the cat sat");
  });
});

describe("an older agent never sends the literal reference", () => {
  // The rollback rule of section 8, phase 3: the server serves an
  // authenticated check with no url to any agent whose poll did not declare
  // `secret_refs`. This is what every agent release before 0.4.0 does with
  // that shape, and what this one still does: a failed result naming the
  // missing configuration, and no request at all.
  it("reports a check served with no url as a failure without dialling", async () => {
    const result = await executeCheck({ id: "chk_old", type: "http", url: null, intervalSeconds: 60 });
    expect(result).toMatchObject({ ok: false, error: "Check is missing configuration: no url" });
  });
});
