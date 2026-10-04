import { hostname } from "node:os";

/**
 * REA-575: reports this agent's own unhandled exceptions and rejections to
 * errors-internal, the same way every other RealUptime service does --
 * gated OFF by default behind the same two env vars
 * (`REALUPTIME_ERRORS_INTERNAL`, `REALUPTIME_ERRORS_DSN`) and the same
 * environment label rule (`FLY_APP_NAME`, falling back to the hostname).
 *
 * ## Why this hand-rolls a client instead of importing `@realuptime/errors`
 *
 * Every other file this program cannot avoid duplicating instead of
 * importing (types.ts, log.ts, config.ts) says the same thing: this binary
 * runs inside a customer's network, and its dependency list is a security
 * artifact a reviewer reads line by line. `@realuptime/errors` has zero
 * runtime dependencies of its own, but it would still be a new workspace
 * edge in the one program whose selling point is that it has nothing in
 * it -- and the shipped image (see Dockerfile) deliberately contains no
 * `node_modules` at all, so an actual package import has nowhere to
 * resolve from at runtime without changing that.
 *
 * So this talks to the SAME wire contract
 * (packages/errors-js/types.ts's `WireEvent`/`WireBatch`, pinned by
 * wire-contract.test.ts on every other SDK) using nothing but the
 * platform's built-in `fetch`. It captures far less than the real SDK
 * (no breadcrumbs, no stack-frame parsing, and a small strict redaction
 * below in place of the SDK's scrub and the shared outbound filter) because
 * covering less surface with zero new dependencies is the right trade for
 * this one program; the four Fly-hosted services get the full SDK.
 *
 * Reporting is fire-and-forget and swallows every failure: a broken error
 * reporter must never become a second thing to monitor, and must never be
 * the reason this agent -- whose entire selling point is that a bad config
 * is the ONLY thing that exits it -- stops running.
 */

const SDK_LABEL = "realuptime-agent-native/1";
const MAX_MESSAGE_LENGTH = 500;
const SEND_TIMEOUT_MS = 10_000;

/**
 * What leaves for the internal Errors host, which receives no customer
 * personal data (packages/db/internal-telemetry.ts, the filter every other
 * internal reporter installs). This program cannot import that module (see
 * above), so it carries a smaller, STRICTER copy: the message's first line
 * only; every single-quoted literal replaced; everything from the first
 * double quote, backtick or `{` to the end dropped (quoted input and JSON
 * echoes have quotes of their own, so no pairing is trusted); and every URL,
 * email, IP address, UUID, phone number, long number and dotted hostname
 * replaced, ours included. It keeps less than the shared filter, never
 * more; errors-report.test.ts runs the shared filter's personal-data
 * vectors against it.
 */
const REDACTIONS: [RegExp, string][] = [
  [/'[^'\n]*'/g, "<redacted>"],
  [/["`{].*$/, "<redacted>"],
  [/\b[a-z][a-z0-9+.-]*:\/\/\S+/gi, "<url>"],
  [/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, "<email>"],
  [/(?<![\d.])(?:\d{1,3}\.){3}\d{1,3}(?![\d.])/g, "<ip>"],
  [/[0-9a-fA-F]{0,4}::[0-9a-fA-F]*[0-9][0-9a-fA-F:.]*|\b(?:[0-9a-fA-F]{1,4}:){4,7}[0-9a-fA-F]{1,4}\b/g, "<ip>"],
  [/\b[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}\b/g, "<id>"],
  [/\+\d[\d ().-]{6,18}\d/g, "<phone>"],
  [/(?<![\w.])\d{9,}(?![\w.])/g, "<n>"],
  [/(?<![\w/\\@<-])(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]{1,62}(?![\w-])/gi, "<host>"],
];

export function redactAgentMessage(message: string): string {
  const firstLine = String(message).split(/\r?\n/, 1)[0] ?? "";
  let out = firstLine.length > MAX_MESSAGE_LENGTH ? firstLine.slice(0, MAX_MESSAGE_LENGTH) : firstLine;
  for (const [pattern, replacement] of REDACTIONS) out = out.replace(pattern, replacement);
  return out;
}

const EXCEPTION_TYPE_RE = /^[A-Za-z_$][A-Za-z0-9_$]{0,99}$/;

export interface ErrorsReportConfig {
  dsn: string;
  environment: string;
  release?: string;
}

/** Reads the two gating env vars. Returns null (reporting off) unless BOTH
 * `REALUPTIME_ERRORS_INTERNAL=1` and a non-empty `REALUPTIME_ERRORS_DSN`
 * are set, same two-variable gate as apps/web/instrumentation.ts. */
export function loadErrorsReportConfig(env: NodeJS.ProcessEnv): ErrorsReportConfig | null {
  const enabled = env.REALUPTIME_ERRORS_INTERNAL?.trim() === "1";
  const dsn = env.REALUPTIME_ERRORS_DSN?.trim();
  if (!enabled || !dsn) return null;
  const release = env.GIT_SHA?.trim();
  return {
    dsn,
    environment: env.FLY_APP_NAME?.trim() || hostname(),
    release: release && release !== "unknown" ? release : undefined,
  };
}

/** One wire event, in the exact shape packages/errors-js/types.ts's
 * `WireEvent` requires for a v1 batch (this reporter never sends any v2
 * field, so a server that only understands v1 ingests it unchanged).
 * `frames` is always null: parsing a stack into wire frames is real
 * machinery (packages/errors-js/index.ts's `parseStack`), and duplicating
 * it here is not worth it for a reporter whose whole point is staying
 * small -- the message already names the error. */
function buildEvent(config: ErrorsReportConfig, message: string, exceptionType: string | null) {
  return {
    occurredAt: new Date().toISOString(),
    message: redactAgentMessage(message),
    exceptionType: exceptionType === null || EXCEPTION_TYPE_RE.test(exceptionType) ? exceptionType : "Error",
    release: config.release ?? null,
    environment: config.environment,
    frames: null,
    request: null,
    fingerprint: null,
  };
}

async function send(config: ErrorsReportConfig, event: ReturnType<typeof buildEvent>, fetchImpl: typeof fetch): Promise<void> {
  try {
    await fetchImpl(config.dsn, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sdk: SDK_LABEL, droppedClient: 0, events: [event] }),
      signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
    });
  } catch {
    // Never becomes a second thing to monitor. See the module doc.
  }
}

export type Logger = (level: "info", msg: string, fields?: Record<string, unknown>) => void;

/**
 * Installs `uncaughtException`/`unhandledRejection` handlers that report to
 * errors-internal and then let the process keep running -- the same
 * "nothing but a bad config ever exits" guarantee every check in
 * runtime.ts already gives individually, now covering the process as a
 * whole too. Logs exactly one line describing whether reporting is
 * actually on, mirroring every other RealUptime service's startup log.
 *
 * A no-op (logs why, installs nothing) when the two env vars are not both
 * set, which is the default and the only state ever true on a customer's
 * machine.
 */
export function installErrorsReporting(env: NodeJS.ProcessEnv, log: Logger, fetchImpl: typeof fetch = fetch): void {
  const config = loadErrorsReportConfig(env);
  if (!config) {
    log("info", "errors reporting disabled", {
      reason: env.REALUPTIME_ERRORS_INTERNAL?.trim() === "1" ? "REALUPTIME_ERRORS_DSN not set" : "REALUPTIME_ERRORS_INTERNAL not set",
    });
    return;
  }
  process.on("uncaughtException", (error) => {
    void send(config, buildEvent(config, error.message || error.name, error.name || "Error"), fetchImpl);
  });
  process.on("unhandledRejection", (reason) => {
    const error = reason instanceof Error ? reason : new Error(String(reason));
    void send(config, buildEvent(config, error.message, reason instanceof Error ? error.name : null), fetchImpl);
  });
  log("info", "errors reporting enabled", { environment: config.environment });
}
