import { Resolver } from "node:dns/promises";

/**
 * The dns check. Semantics are a deliberate mirror of
 * `packages/checker/probe-dns.ts`, re-implemented rather than imported so this
 * package keeps its empty dependency graph (see types.ts for the reasoning).
 * `wire-contract.test.ts` pins the behaviours that must not drift apart.
 *
 * The three rules worth restating, because each one is a false-green if it is
 * dropped:
 *
 * - A FRESH `Resolver` per probe. Node's default resolver caches, and a
 *   monitor reading its own cache reports the state of its memory rather than
 *   the state of DNS: it keeps saying "up" for the whole TTL after a record is
 *   deleted, which is exactly the window the customer is paying us to catch.
 * - AN EMPTY ANSWER SET IS DOWN. `resolve()` can return zero records without
 *   throwing. Treating that as up is the classic false green: the query
 *   succeeded, so the code is happy, while the name resolves to nothing.
 * - `resolveAny` is never used. RFC 8482 lets resolvers refuse it, which would
 *   read as a customer outage rather than as our choice of query.
 */

export const DEFAULT_TIMEOUT_MS = 10_000;

/**
 * `Resolver({ timeout })` is a PER-NAMESERVER timeout, not a per-call one: a
 * host whose resolv.conf lists several nameservers can legitimately spend that
 * budget on each in turn. This multiplier is the total wall-clock ceiling the
 * whole probe gets, so no dns check can hang a tick.
 */
export const DNS_TOTAL_BUDGET_PHASES = 2;

export interface DnsOutcome {
  ok: boolean;
  latencyMs: number;
  error?: string;
}

export async function runDnsCheck(
  hostname: string,
  recordType: string,
  expectedValue: string | null,
  timeoutMs: number = DEFAULT_TIMEOUT_MS,
  /** Test seam. Production omits it and gets a real resolver. */
  resolveFn?: (hostname: string, recordType: string) => Promise<unknown[]>,
): Promise<DnsOutcome> {
  const started = Date.now();

  const resolve =
    resolveFn ??
    (async (name: string, type: string) => {
      const resolver = new Resolver({ timeout: timeoutMs, tries: 1 });
      return (await resolver.resolve(name, type)) as unknown[];
    });

  try {
    const answers = await withDeadline(
      resolve(hostname, recordType),
      timeoutMs * DNS_TOTAL_BUDGET_PHASES,
    );
    const latencyMs = Date.now() - started;

    if (!Array.isArray(answers) || answers.length === 0) {
      return { ok: false, latencyMs, error: "No records returned" };
    }

    if (expectedValue) {
      const needle = expectedValue.trim().toLowerCase();
      // Flattened to strings because each record type answers in its own
      // shape: A/AAAA/NS/CNAME give strings, MX gives {priority, exchange},
      // TXT gives arrays of chunks that must be rejoined before matching. A
      // long TXT record is split at 255 bytes on the wire, so matching a chunk
      // instead of the whole value would miss a DKIM key it contains.
      const flattened = answers.map((a) => flattenAnswer(a).toLowerCase());
      if (!flattened.some((value) => value.includes(needle))) {
        return {
          ok: false,
          latencyMs,
          // "expected X, got Y" is the whole diagnosis for a repointed record.
          // Without the actual answers the operator has to go resolve it by
          // hand before they have learned anything.
          error: `Expected "${expectedValue}", got: ${flattened.join(", ").slice(0, 200)}`,
        };
      }
    }

    return { ok: true, latencyMs };
  } catch (err) {
    const latencyMs = Date.now() - started;
    if (err instanceof DnsDeadlineError) {
      // Folded into the resolver's own timeout vocabulary rather than given a
      // new one: from the operator's side "never answered" and "answered too
      // late to matter" are the same fact.
      return { ok: false, latencyMs, error: "The DNS query timed out" };
    }
    return { ok: false, latencyMs, error: dnsErrorMessage((err as { code?: string })?.code, err) };
  }
}

class DnsDeadlineError extends Error {}

function withDeadline<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new DnsDeadlineError("dns probe deadline")), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}

/** One record, as a single comparable string. */
export function flattenAnswer(answer: unknown): string {
  if (typeof answer === "string") return answer;
  if (Array.isArray(answer)) return answer.join("");
  if (answer && typeof answer === "object") {
    const mx = answer as { exchange?: string; priority?: number };
    if (typeof mx.exchange === "string") {
      return mx.priority === undefined ? mx.exchange : `${mx.priority} ${mx.exchange}`;
    }
    return JSON.stringify(answer);
  }
  return String(answer);
}

/** Distinct messages per code on purpose: "the name does not exist" and "the
 *  resolver failed" send an operator to completely different places. */
function dnsErrorMessage(code: string | undefined, err: unknown): string {
  switch (code) {
    case "ENOTFOUND":
    case "ENODATA":
      return "No records found for that name and type";
    case "NXDOMAIN":
      return "That name does not exist (NXDOMAIN)";
    case "SERVFAIL":
      return "The DNS server failed to answer (SERVFAIL)";
    case "ETIMEOUT":
    case "ETIMEDOUT":
      return "The DNS query timed out";
    case "ECONNREFUSED":
      return "The DNS server refused the connection";
    default:
      return err instanceof Error ? err.message : String(err);
  }
}
