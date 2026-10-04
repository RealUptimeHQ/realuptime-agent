import { promises as dnsPromises } from "node:dns";
import { isIP } from "node:net";
import {
  EGRESS_BLOCKED_MESSAGE,
  evaluateEgress,
  type EgressPolicy,
  type EgressRule,
  type EgressVerdict,
} from "./egress-policy.ts";
import { log } from "./log.ts";

/**
 * The seam between the policy (`egress-policy.ts`, pure arithmetic) and the
 * probers (`check-http.ts`, `check-tcp.ts`, `check-ping.ts`, which open
 * sockets).
 *
 * Three jobs, and only three:
 *
 * 1. **Resolve at dial time.** The verdict is computed against the addresses a
 *    lookup returns in the moment, not against a hostname, and not against a
 *    verdict cached from an earlier poll. A name that resolved to `10.0.0.5`
 *    an hour ago and answers with a public address now has to be refused on
 *    THIS dial.
 * 2. **Hand back the pin.** The approved addresses go to `net`/`tls` through a
 *    `lookup` function that replays them and never consults DNS, so the socket
 *    physically cannot land somewhere the policy did not see. This is
 *    `packages/db/guarded-connect.ts`'s mechanism, re-implemented here for the
 *    same reason every other server module is (see `egress-policy.ts`'s
 *    header).
 * 3. **Count what it saw.** In report-only mode the probe still runs, so the
 *    only evidence enforcement would produce is what this counter holds. It is
 *    the number the decision to enforce gets made on.
 *
 * ## The one honest gap: http
 *
 * `node:net` and `node:tls` accept a `lookup` option, so a tcp or ping probe
 * is genuinely pinned. Node's global `fetch` does not expose one without
 * pulling undici in as a dependency, which this package deliberately does not
 * have. So an http probe is checked against a resolution taken immediately
 * before the request and re-checked on every redirect hop, and the residual
 * window is between our lookup and fetch's own, measured in milliseconds.
 * That is weaker than a pin and it is stated plainly rather than papered over:
 * closing it means either taking a dependency or dialling the IP directly and
 * losing SNI, and both are decisions for a later phase, not something to
 * decide inside a hardening change.
 */

/** A validated address, in the shape `node:net`'s `lookup` option wants. */
export interface PinnedAddress {
  address: string;
  family: number;
}

export interface EgressDecision {
  /** True when the probe may proceed. In report-only mode this is true even
   * for a refused verdict: the whole point is to measure the cost of
   * enforcement without paying it. */
  proceed: boolean;
  /** Present only when `proceed` is false. The customer-facing failure text. */
  error?: string;
  /** Every address the policy approved, or the ones it saw when it refused.
   * Empty when resolution failed. */
  addresses: PinnedAddress[];
}

/** What a prober calls before it dials. `port` is null for a target with no
 * port concept at this layer. */
export type EgressGuard = (host: string, port: number | null) => Promise<EgressDecision>;

export type LookupFn = (
  hostname: string,
  options: { all: true; verbatim?: boolean },
) => Promise<{ address: string; family: number }[]>;

const defaultLookup: LookupFn = (hostname, options) =>
  dnsPromises.lookup(hostname, options) as Promise<{ address: string; family: number }[]>;

/**
 * Running counts of what the policy decided, for the agent's own health line.
 *
 * There is no local API and no local database to put this in
 * (`docs/private-probe-locations.md` section 7 forbids both, and
 * `apps/agent/agent.ts` listening on no port is a load-bearing sentence), so
 * the agent's health surface is its log stream. `runtime.ts` drains this once
 * a minute onto the poll line.
 */
/** One poll's worth of egress verdicts: what `EgressReport.drain` returns and
 * what the poll carries to the server (REA-1013). */
export interface EgressCounts {
  refused: number;
  wouldRefuse: number;
  byRule: Record<string, number>;
}

export class EgressReport {
  private counts = new Map<EgressRule, number>();
  private wouldRefuse = 0;
  private refused = 0;

  /** `host` is not stored: the per-occurrence log line the guard already wrote
   * carries the target, and a second copy here would only be the last one. */
  record(verdict: Extract<EgressVerdict, { allow: false }>): void {
    this.counts.set(verdict.rule, (this.counts.get(verdict.rule) ?? 0) + 1);
    if (verdict.enforced) this.refused += 1;
    else this.wouldRefuse += 1;
  }

  /** Read and clear. Called once per poll so the numbers on a line describe
   * the minute that line covers, not the life of the process. */
  drain(): EgressCounts {
    const byRule: Record<string, number> = {};
    for (const [rule, count] of this.counts) byRule[rule] = count;
    const drained = { refused: this.refused, wouldRefuse: this.wouldRefuse, byRule };
    this.counts = new Map();
    this.refused = 0;
    this.wouldRefuse = 0;
    return drained;
  }

  /** Put drained counts back, for a poll that failed to carry them: the next
   * poll reports them instead of the numbers quietly going missing. */
  restore(counts: EgressCounts): void {
    for (const [rule, count] of Object.entries(counts.byRule)) {
      const key = rule as EgressRule;
      this.counts.set(key, (this.counts.get(key) ?? 0) + count);
    }
    this.refused += counts.refused;
    this.wouldRefuse += counts.wouldRefuse;
  }
}

/**
 * Build the guard a prober calls.
 *
 * `lookup` is injectable so the tests never touch a real resolver; production
 * omits it and gets `node:dns/promises`.
 */
export function createEgressGuard(
  policy: EgressPolicy,
  report: EgressReport,
  lookup: LookupFn = defaultLookup,
): EgressGuard {
  return async (rawHost: string, port: number | null): Promise<EgressDecision> => {
    const host = normalizeHost(rawHost);
    if (!host) {
      return { proceed: false, error: `${EGRESS_BLOCKED_MESSAGE} (no host)`, addresses: [] };
    }

    let resolved: { address: string; family: number }[];
    if (isIP(host)) {
      // No name to re-resolve, so the literal IS the pin.
      resolved = [{ address: host, family: isIP(host) }];
    } else {
      try {
        resolved = await lookup(host, { all: true, verbatim: true });
      } catch {
        resolved = [];
      }
    }

    const verdict = evaluateEgress(
      { host, port, addresses: resolved.map(({ address }) => address) },
      policy,
    );

    if (verdict.allow) {
      return { proceed: true, addresses: resolved };
    }

    report.record(verdict);
    if (!verdict.enforced) {
      // Report-only: probe as normal, but say what enforcement would have
      // cost. One line per occurrence rather than a summary only, because the
      // operator needs the target, and a summary cannot carry every target.
      log("warn", "target would be refused by this location's egress policy", {
        host,
        port: port ?? undefined,
        rule: verdict.rule,
        detail: verdict.detail,
        hint: "set REALUPTIME_EGRESS_POLICY=enforce to make this a refusal, or allow the target with REALUPTIME_ALLOW_TARGETS",
      });
      return { proceed: true, addresses: resolved };
    }

    log("warn", "refused a target by this location's egress policy", {
      host,
      port: port ?? undefined,
      rule: verdict.rule,
      detail: verdict.detail,
    });
    return {
      proceed: false,
      // The rule is named in the customer-facing text on purpose. "Blocked by
      // policy" with no reason sends an operator to a support ticket; "blocked
      // by policy (public address)" sends them to their own config.
      error: `${EGRESS_BLOCKED_MESSAGE} (${describe(verdict.rule)})`,
      addresses: resolved,
    };
  };
}

/** Short, plain descriptions. Deliberately does not echo the resolved address:
 * the error string is written into `check_results` and shipped to us, and a
 * customer's internal addressing is theirs. The full detail is in the local
 * log line above, which never leaves the machine. */
function describe(rule: EgressRule): string {
  switch (rule) {
    case "metadata":
      return "cloud metadata endpoint";
    case "link_local":
      return "link-local address";
    case "multicast":
      return "multicast or broadcast address";
    case "unspecified":
      return "reserved address";
    case "unknown_address":
      return "the target did not resolve to a usable address";
    case "loopback":
      return "loopback is not enabled on this location";
    case "public":
      return "public address";
    case "allowlist_host":
      return "host is not on this location's allowlist";
    case "allowlist_port":
      return "port is not on this location's allowlist";
  }
}

function normalizeHost(raw: string): string {
  let host = (raw ?? "").trim().toLowerCase();
  if (host.startsWith("[") && host.endsWith("]")) host = host.slice(1, -1);
  return host;
}

/**
 * Turn approved addresses into the `lookup` `node:net` and `node:tls` accept,
 * so the socket replays exactly those and never resolves the name a second
 * time.
 *
 * Fails CLOSED on an empty pin. An empty pin degrading into "resolve it
 * normally" is precisely the hole this exists to close, and it is the one
 * mistake in this shape that looks like it works.
 */
export function createPinnedLookup(pinned: readonly PinnedAddress[]) {
  const approved = Array.isArray(pinned) ? pinned.map(({ address, family }) => ({ address, family })) : [];
  return (
    _hostname: string,
    options: { all?: boolean } | undefined,
    callback: (
      err: NodeJS.ErrnoException | null,
      address: string | { address: string; family: number }[],
      family?: number,
    ) => void,
  ): void => {
    if (approved.length === 0) {
      callback(Object.assign(new Error("No validated address to connect to."), { code: "ENOTFOUND" }), "");
      return;
    }
    if (options?.all) {
      callback(null, approved);
      return;
    }
    callback(null, approved[0].address, approved[0].family);
  };
}
