import type { AgentConfig } from "./config.ts";
import { FLUSH_BATCH_SIZE } from "./buffer.ts";
import { METRICS_FLUSH_BATCH_SIZE } from "./metrics-buffer.ts";
import { log } from "./log.ts";
import type {
  AgentAuthHeader,
  AgentCheck,
  AgentCheckAuth,
  AgentSelfReport,
  CheckResult,
  CheckType,
  MetricsRequest,
  MetricsResponse,
} from "./types.ts";

/**
 * The only network conversation this program has with anything other than the
 * customer's own targets: two POSTs, one hostname, one port.
 *
 * ## The two error classes, and why they are not the same
 *
 * `AuthError` (401) means the token is wrong or was revoked. Backing off
 * exponentially would be wrong in both directions: a revoked token will never
 * start working, so the backoff is wasted, and if the 401 came from a
 * momentary auth-infrastructure fault, an exponential curve leaves the agent
 * dark for hours after the fault clears. So auth failures retry at a SLOW
 * FIXED interval, forever. The process never exits on a 401. An agent that
 * exits is an agent that a container runtime restarts in a crash loop, or that
 * a bare-metal customer never notices died, and either way the monitoring is
 * gone at the moment somebody rotated a token by mistake.
 *
 * `TransientError` (404, 429, 5xx, DNS failure, connection refused) means try
 * again later. Those get the exponential backoff.
 */

export const REQUEST_TIMEOUT_MS = 20_000;

export class AuthError extends Error {
  constructor(message = "The agent token was rejected") {
    super(message);
    this.name = "AuthError";
  }
}

export class TransientError extends Error {
  readonly status?: number;
  constructor(message: string, status?: number) {
    super(message);
    this.name = "TransientError";
    this.status = status;
  }
}

/**
 * The server pinned this agent's metrics vantage on its first report and
 * this batch declared a different one (409). Unlike `TransientError`, this
 * is never worth retrying: the vantage a machine measures from does not
 * change while the process runs, so every future batch would be refused the
 * same way. `runtime.ts` treats it as permanent for the process lifetime.
 */
export class VantageConflictError extends Error {
  constructor(message = "This agent's metrics vantage was rejected by the server") {
    super(message);
    this.name = "VantageConflictError";
  }
}

/** What one poll hands back: the checks, plus the opt-in service watch list
 * (protocol v2, REA-181; empty from a v1 server) and the one-shot log
 * snapshot request (REA-440, log snapshots phase 1; false from a server
 * that predates it or has no reason to ask right now). */
export interface PollResult {
  checks: AgentCheck[];
  services: string[];
  requestLogSnapshot: boolean;
}

/** What a poll carries up (REA-1013): this location's egress mode and the
 * verdicts since the last poll, so the dashboard can show what enforcement
 * would cost before it becomes the default. Counts only, never a target. */
export interface EgressPollReport {
  mode: "report" | "enforce";
  refused: number;
  wouldRefuse: number;
  byRule: Record<string, number>;
}

export interface AgentApi {
  poll(egress?: EgressPollReport, self?: AgentSelfReport): Promise<PollResult>;
  sendResults(results: CheckResult[]): Promise<void>;
  sendMetrics(request: MetricsRequest): Promise<MetricsResponse>;
}

export class ApiClient implements AgentApi {
  private readonly config: AgentConfig;
  private readonly fetchImpl: typeof fetch;

  constructor(config: AgentConfig, fetchImpl: typeof fetch = fetch) {
    this.config = config;
    this.fetchImpl = fetchImpl;
  }

  async poll(egress?: EgressPollReport, self?: AgentSelfReport): Promise<PollResult> {
    // `agent` (phase 3): this build's version and capabilities, so the server
    // serves an authenticated check in its authenticated form only to an
    // agent that said it understands one.
    const body = await this.post("/api/agent/v1/poll", {
      ...(egress ? { egress } : {}),
      ...(self ? { agent: self } : {}),
    });
    return {
      checks: parseChecks(body),
      services: parseServiceWatch(body),
      requestLogSnapshot: parseRequestLogSnapshot(body),
    };
  }

  async sendResults(results: CheckResult[]): Promise<void> {
    if (results.length > FLUSH_BATCH_SIZE) {
      // A caller sending more than the server accepts would get a 4xx that
      // looks like a transport problem and would retry forever. Caught here,
      // where the contract is written down.
      throw new TransientError(`Refusing to send ${results.length} results (max ${FLUSH_BATCH_SIZE})`);
    }
    await this.post("/api/agent/v1/results", { results });
  }

  async sendMetrics(request: MetricsRequest): Promise<MetricsResponse> {
    if (request.samples.length > METRICS_FLUSH_BATCH_SIZE) {
      throw new TransientError(
        `Refusing to send ${request.samples.length} metric samples (max ${METRICS_FLUSH_BATCH_SIZE})`,
      );
    }
    const body = await this.post("/api/agent/v1/metrics", request, {
      // 409 means the vantage this batch declared disagrees with the one
      // pinned on this agent's first metrics report. The body is well-formed
      // and the credential is valid, so this is not a TransientError: it is
      // permanent until an operator registers a new agent for the new
      // vantage, which is `runtime.ts`'s job to act on.
      on409: (raw) => {
        const message =
          raw && typeof raw === "object" && typeof (raw as { error?: unknown }).error === "string"
            ? (raw as { error: string }).error
            : undefined;
        throw new VantageConflictError(message);
      },
    });
    return body as MetricsResponse;
  }

  private async post(
    path: string,
    payload: unknown,
    opts: { on409?: (body: unknown) => never } = {},
  ): Promise<unknown> {
    const url = `${this.config.baseUrl}${path}`;
    let res: Response;
    try {
      res = await this.fetchImpl(url, {
        method: "POST",
        headers: {
          authorization: `Bearer ${this.config.token}`,
          "content-type": "application/json",
          "user-agent": "RealUptime-Monitor-Agent",
        },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch (err) {
      // Offline, DNS down, proxy refusing: all the same instruction, which is
      // keep the buffer and try again.
      throw new TransientError(err instanceof Error ? err.message : String(err));
    }

    if (res.status === 401) {
      void res.body?.cancel().catch(() => {});
      throw new AuthError();
    }
    if (res.status === 409 && opts.on409) {
      const body = await res.json().catch(() => undefined);
      opts.on409(body);
    }
    if (!res.ok) {
      void res.body?.cancel().catch(() => {});
      throw new TransientError(`${path} returned ${res.status}`, res.status);
    }

    try {
      return await res.json();
    } catch (err) {
      // A 200 with an unparseable body is a broken deployment on our side, not
      // on the customer's. Transient, so the agent keeps its data and waits.
      throw new TransientError(`${path} returned an unreadable body: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}

/**
 * The closed operation vocabulary, agent side
 * (`docs/private-probe-locations.md` section 3.2).
 *
 * The poll response is a DATA CONTRACT with a finite vocabulary, never a
 * command channel, and this object is the third of the three places that
 * vocabulary is enforced (the other two are the
 * `checks_agent_id_probed_types` database constraint and the poll route's
 * serializer, which builds its response from typed columns and cannot emit a
 * field that has no column). Three enforcement points for one rule is
 * deliberate: this is the property that makes an agent inside a customer's
 * network defensible, and a property with a single enforcement point is one
 * refactor from gone.
 *
 * The rule for the future, stated so it cannot be lost: **this parser is an
 * allowlist and stays an allowlist.** No `switch` default that attempts a
 * generic action, no pass-through of an unknown field into any dialer. An old
 * agent facing a server that learned a new verb refuses the verb, which means
 * a compromised server cannot teach a deployed agent a new capability, only
 * reuse the ones it was compiled with.
 *
 * Behind a mutable holder so `api.test.ts` can widen it and watch the refusal
 * assertions flip, the same shape `check-http.ts`'s `httpRules` uses. A guard
 * no test has ever seen fail is decoration.
 */
export const parseRules = {
  /** The four probe verbs. `multistep`, `smtp`, `browser` and `heartbeat` are
   * fleet-only and are refused at the database as well as here. */
  checkTypes: ["http", "tcp", "dns", "ping"] as readonly string[],
  /**
   * The six record types a dns check may ask for, byte-identical to the
   * server's own `z.enum` in `packages/db/api-schemas.ts`.
   *
   * This list is a security control, not a convenience. `node:dns`'s
   * `resolver.resolve(name, type)` accepts `"ANY"`, which is `resolveAny`, the
   * one query `check-dns.ts`'s header says is never used because RFC 8482 lets
   * resolvers refuse it. Without this allowlist a server could put `"ANY"`, or
   * any other type node happens to accept, straight through to the resolver:
   * the type arrived as an unconstrained string and was passed to the dialer
   * verbatim, which is precisely the pass-through this vocabulary forbids.
   */
  dnsRecordTypes: ["A", "AAAA", "CNAME", "MX", "TXT", "NS"] as readonly string[],
  /**
   * The auth block of an http check (private locations phase 3, section 3.6):
   * exactly these two keys, and each header exactly `name` and `value`. An
   * unknown key anywhere inside it refuses the whole check, because a field
   * this agent does not understand is precisely a field whose meaning it
   * cannot promise to honour; a future auth form rides a new capability
   * rather than a new key an old parser might half-read.
   */
  authKeys: ["headers", "userinfo"] as readonly string[],
  authHeaderKeys: ["name", "value"] as readonly string[],
  /** Header names are HTTP tokens (RFC 9110 section 5.6.2), bounded. Which
   * names this location will actually send is decided at dial time, against
   * this machine's own allowlist (`secrets.ts`), not here. */
  authHeaderName: /^[A-Za-z0-9!#$%&'*+.^_`|~-]{1,64}$/ as RegExp,
  maxAuthHeaders: 8,
  maxAuthTemplateChars: 1024,
};

/**
 * Ports a probe will never legitimately target, mirroring the fleet's
 * `DENIED_TCP_PORTS` (`packages/db/target-guard.ts`): the RFC 862-865 "simple
 * TCP services", which exist mainly as amplification and connection-loop
 * vectors. This prober writes zero application bytes, so smuggling is not the
 * concern; pointing a customer's own machine at its own chargen is.
 */
const DENIED_TCP_PORTS: ReadonlySet<number> = new Set([7, 9, 13, 17, 19]);

/** A tcp port the agent will dial: an integer inside the real port range and
 * not one of the denied ones. Anything else becomes null, which surfaces to
 * the customer as a failed result naming the missing configuration rather
 * than as a silent skip. */
function tcpPort(raw: unknown): number | null {
  if (typeof raw !== "number" || !Number.isInteger(raw)) return null;
  if (raw < 1 || raw > 65_535) return null;
  if (DENIED_TCP_PORTS.has(raw)) return null;
  return raw;
}

/**
 * Validate the poll response instead of casting it.
 *
 * A future server version will add a check type this agent has never heard of,
 * and the customer will not have upgraded. The correct behaviour then is to
 * run the checks it understands and skip the rest with one log line, not to
 * crash and take the checks it DOES understand down with it.
 */
export function parseChecks(body: unknown): AgentCheck[] {
  const raw = (body as { checks?: unknown })?.checks;
  if (!Array.isArray(raw)) {
    throw new TransientError("Poll response had no checks array");
  }

  const checks: AgentCheck[] = [];
  let skipped = 0;
  let skippedAuth = 0;
  for (const item of raw) {
    if (!item || typeof item !== "object") {
      skipped++;
      continue;
    }
    const c = item as Record<string, unknown>;
    if (typeof c.id !== "string" || !parseRules.checkTypes.includes(String(c.type))) {
      skipped++;
      continue;
    }
    const auth = parseCheckAuth(c.type, c.auth);
    if (auth === REFUSED_AUTH) {
      // Refused whole, like an unknown verb: dialling this check without the
      // block would send a request the customer configured to carry a
      // credential with no credential at all, and dialling it with a
      // half-understood block is the pass-through section 3.2 forbids.
      skippedAuth++;
      continue;
    }
    checks.push({
      id: c.id,
      type: c.type as CheckType,
      url: typeof c.url === "string" ? c.url : null,
      tcpHost: typeof c.tcpHost === "string" ? c.tcpHost : null,
      tcpPort: tcpPort(c.tcpPort),
      tcpTls: typeof c.tcpTls === "boolean" ? c.tcpTls : null,
      dnsHostname: typeof c.dnsHostname === "string" ? c.dnsHostname : null,
      dnsRecordType:
        typeof c.dnsRecordType === "string" && parseRules.dnsRecordTypes.includes(c.dnsRecordType)
          ? c.dnsRecordType
          : null,
      dnsExpectedValue: typeof c.dnsExpectedValue === "string" ? c.dnsExpectedValue : null,
      pingHost: typeof c.pingHost === "string" ? c.pingHost : null,
      intervalSeconds: typeof c.intervalSeconds === "number" ? c.intervalSeconds : 60,
      assertionBodyOp: c.assertionBodyOp === "contains" || c.assertionBodyOp === "not_contains" ? c.assertionBodyOp : null,
      assertionBodyValue: typeof c.assertionBodyValue === "string" ? c.assertionBodyValue : null,
      assertionBodyCaseSensitive: typeof c.assertionBodyCaseSensitive === "boolean" ? c.assertionBodyCaseSensitive : null,
      assertionHeaderName: typeof c.assertionHeaderName === "string" ? c.assertionHeaderName : null,
      assertionHeaderOp: c.assertionHeaderOp === "equals" || c.assertionHeaderOp === "contains" ? c.assertionHeaderOp : null,
      assertionHeaderValue: typeof c.assertionHeaderValue === "string" ? c.assertionHeaderValue : null,
      assertionStatusMin: typeof c.assertionStatusMin === "number" ? c.assertionStatusMin : null,
      assertionStatusMax: typeof c.assertionStatusMax === "number" ? c.assertionStatusMax : null,
      assertionJsonPath: typeof c.assertionJsonPath === "string" ? c.assertionJsonPath : null,
      assertionJsonOp:
        c.assertionJsonOp === "equals" || c.assertionJsonOp === "contains" || c.assertionJsonOp === "exists"
          ? c.assertionJsonOp
          : null,
      assertionJsonValue: typeof c.assertionJsonValue === "string" ? c.assertionJsonValue : null,
      auth,
    });
  }

  if (skipped > 0) {
    log("warn", "skipped checks this agent does not understand", {
      skipped,
      hint: "upgrade the agent image",
    });
  }
  if (skippedAuth > 0) {
    log("warn", "skipped checks whose authentication this agent does not understand", {
      skipped: skippedAuth,
      hint: "upgrade the agent image",
    });
  }
  return checks;
}

/** The parser's verdict on an auth block it will not run. A sentinel rather
 * than null, because null is the ordinary "this check has no auth". */
const REFUSED_AUTH = Symbol("refused auth");

/** A template string the dialer may see: bounded, and free of every control
 * character, so no value can smuggle a second header line in through a
 * newline before the secret resolver ever looks at it. */
function authTemplate(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  if (raw.length === 0 || raw.length > parseRules.maxAuthTemplateChars) return null;
  // biome-ignore lint/suspicious/noControlCharactersInRegex: refusing control characters is the point
  if (/[\x00-\x1f\x7f]/.test(raw)) return null;
  return raw;
}

function exactKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  return Object.keys(value).every((key) => allowed.includes(key));
}

/**
 * The `auth` block, strictly (section 3.2's allowlist rule applied to 3.6).
 * Absent or null is an unauthenticated check. Anything else must be exactly
 * the documented shape, on an http check, or the whole check is refused.
 * Shape only: which header names this location sends, and whether each
 * `${SECRET:NAME}` resolves, is decided at dial time by `secrets.ts`, where a
 * refusal can become a failed result naming the reason.
 */
function parseCheckAuth(type: unknown, raw: unknown): AgentCheckAuth | null | typeof REFUSED_AUTH {
  if (raw === undefined || raw === null) return null;
  if (type !== "http" || typeof raw !== "object" || Array.isArray(raw)) return REFUSED_AUTH;
  const block = raw as Record<string, unknown>;
  if (!exactKeys(block, parseRules.authKeys)) return REFUSED_AUTH;

  const rawHeaders = block.headers ?? [];
  if (!Array.isArray(rawHeaders) || rawHeaders.length > parseRules.maxAuthHeaders) return REFUSED_AUTH;
  const headers: AgentAuthHeader[] = [];
  for (const entry of rawHeaders) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) return REFUSED_AUTH;
    const header = entry as Record<string, unknown>;
    if (!exactKeys(header, parseRules.authHeaderKeys)) return REFUSED_AUTH;
    if (typeof header.name !== "string" || !parseRules.authHeaderName.test(header.name)) return REFUSED_AUTH;
    const value = authTemplate(header.value);
    if (value === null) return REFUSED_AUTH;
    headers.push({ name: header.name, value });
  }

  let userinfo: string | null = null;
  if (block.userinfo !== undefined && block.userinfo !== null) {
    userinfo = authTemplate(block.userinfo);
    if (userinfo === null) return REFUSED_AUTH;
  }
  if (headers.length === 0 && userinfo === null) return null;
  return { headers, userinfo };
}

/**
 * The service watch list from a poll response (protocol v2). Absent, null,
 * or not an array all mean "watch nothing", which is what a v1 server says
 * by saying nothing. Only strings survive here; the collector applies the
 * name rule (collect-services.ts) on top, so a malformed entry can never
 * reach a filesystem path or a command line.
 */
export function parseServiceWatch(body: unknown): string[] {
  const raw = (body as { services?: unknown })?.services;
  if (!Array.isArray(raw)) return [];
  return raw.filter((entry): entry is string => typeof entry === "string");
}

/** The log snapshot request flag (REA-440, log snapshots phase 1). Anything
 * other than the literal boolean `true` means "no request", including a v1
 * server's response, which carries no such field at all. */
export function parseRequestLogSnapshot(body: unknown): boolean {
  return (body as { requestLogSnapshot?: unknown })?.requestLogSnapshot === true;
}
