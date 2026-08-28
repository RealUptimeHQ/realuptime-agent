import type { AgentConfig } from "./config.ts";
import { FLUSH_BATCH_SIZE } from "./buffer.ts";
import { METRICS_FLUSH_BATCH_SIZE } from "./metrics-buffer.ts";
import { log } from "./log.ts";
import type { AgentCheck, CheckResult, CheckType, MetricsRequest, MetricsResponse } from "./types.ts";

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
 * (protocol v2, REA-181; empty from a v1 server). */
export interface PollResult {
  checks: AgentCheck[];
  services: string[];
}

export interface AgentApi {
  poll(): Promise<PollResult>;
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

  async poll(): Promise<PollResult> {
    const body = await this.post("/api/agent/v1/poll", {});
    return { checks: parseChecks(body), services: parseServiceWatch(body) };
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

const CHECK_TYPES: readonly string[] = ["http", "tcp", "dns", "ping"];

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
  for (const item of raw) {
    if (!item || typeof item !== "object") {
      skipped++;
      continue;
    }
    const c = item as Record<string, unknown>;
    if (typeof c.id !== "string" || !CHECK_TYPES.includes(String(c.type))) {
      skipped++;
      continue;
    }
    checks.push({
      id: c.id,
      type: c.type as CheckType,
      url: typeof c.url === "string" ? c.url : null,
      tcpHost: typeof c.tcpHost === "string" ? c.tcpHost : null,
      tcpPort: typeof c.tcpPort === "number" ? c.tcpPort : null,
      tcpTls: typeof c.tcpTls === "boolean" ? c.tcpTls : null,
      dnsHostname: typeof c.dnsHostname === "string" ? c.dnsHostname : null,
      dnsRecordType: typeof c.dnsRecordType === "string" ? c.dnsRecordType : null,
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
    });
  }

  if (skipped > 0) {
    log("warn", "skipped checks this agent does not understand", {
      skipped,
      hint: "upgrade the agent image",
    });
  }
  return checks;
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
