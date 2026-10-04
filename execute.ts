import { runDnsCheck } from "./check-dns.ts";
import { runHttpCheck } from "./check-http.ts";
import { runTcpCheck } from "./check-tcp.ts";
import { runPingCheck } from "./check-ping.ts";
import type { EgressGuard } from "./egress-guard.ts";
import { redactSecrets } from "./log.ts";
import { prepareCheckAuth, type SecretSource } from "./secrets.ts";
import type { AgentCheck, CheckResult } from "./types.ts";

const NO_SECRETS: SecretSource = { lookup: () => undefined };

/**
 * Turn one assigned check into one result.
 *
 * ## Which probers get the egress guard, and which does not
 *
 * `http`, `tcp` and `ping` all open a socket to the target, so all three take
 * the guard (`docs/private-probe-locations.md` section 3.3).
 *
 * `dns` deliberately does not, and the distinction is the definition of the
 * rule rather than an omission. A dns check never dials its target: it asks
 * the machine's own resolver about a NAME and compares the answer. The only
 * socket involved goes to the resolver this host is already configured to use,
 * which the agent does not choose (3.2: "no arbitrary resolver selection"),
 * and the answer is read, never connected to. Applying an address policy to a
 * value nothing dials would refuse the most ordinary private-location dns
 * check there is: confirming that split-horizon DNS still answers for a public
 * name from inside the network.
 *
 * What bounds a dns check instead is the closed record-type vocabulary in
 * `api.ts`'s `parseChecks`, which is where a server asking for a zone transfer
 * or `ANY` is refused.
 *
 * `checkedAt` is stamped HERE, at the top, before the probe runs. Not when the
 * result is queued, and emphatically not when the batch is flushed. The agent
 * is designed to survive an hours-long link failure and deliver what it held,
 * and a result stamped at delivery time would land in the history as though
 * the outage never happened. The timestamp is the observation, so it belongs
 * to the observation.
 *
 * A malformed check (one whose type-specific fields are missing) is reported
 * as a FAILED RESULT rather than thrown. Throwing would kill the tick and take
 * every other check on the machine down with it, over a server-side field the
 * agent cannot fix.
 */
export async function executeCheck(
  check: AgentCheck,
  egress?: EgressGuard,
  /** Where `${SECRET:NAME}` references resolve from, and which header names
   * this location sends them in (private locations phase 3). Omitted means no
   * secrets at all: an authenticated check then fails naming the secret it
   * could not find, which is the safe reading of "nothing configured". */
  secrets?: CheckSecrets,
): Promise<CheckResult> {
  const result = await runCheck(check, egress, secrets);
  // Every error string is scrubbed of every secret value this process has
  // resolved, on every check type, before it is queued for the server
  // (section 3.6). The http branch also scrubs its own values explicitly, so
  // a value is covered even in the instant before the shared registry sees it.
  return result.error === undefined ? result : { ...result, error: redactSecrets(result.error) };
}

/** What an http check needs to resolve its auth block. */
export interface CheckSecrets {
  source: SecretSource;
  allowedHeaderNames: readonly string[];
}

async function runCheck(check: AgentCheck, egress?: EgressGuard, secrets?: CheckSecrets): Promise<CheckResult> {
  const checkedAt = new Date().toISOString();

  try {
    switch (check.type) {
      case "http": {
        if (!check.url) return malformed(check.id, checkedAt, "no url");
        const prepared = prepareCheckAuth(
          check.url,
          check.auth,
          secrets?.source ?? NO_SECRETS,
          secrets?.allowedHeaderNames,
        );
        // Refused before any packet leaves: no request is ever sent with a
        // placeholder in it, and none is sent with the credential left off.
        if (!prepared.ok) return { checkId: check.id, ok: false, error: prepared.error, checkedAt };
        const out = await runHttpCheck(check.url, undefined, undefined, {
          assertionBodyOp: check.assertionBodyOp,
          assertionBodyValue: check.assertionBodyValue,
          assertionBodyCaseSensitive: check.assertionBodyCaseSensitive,
          assertionHeaderName: check.assertionHeaderName,
          assertionHeaderOp: check.assertionHeaderOp,
          assertionHeaderValue: check.assertionHeaderValue,
          assertionStatusMin: check.assertionStatusMin,
          assertionStatusMax: check.assertionStatusMax,
          assertionJsonPath: check.assertionJsonPath,
          assertionJsonOp: check.assertionJsonOp,
          assertionJsonValue: check.assertionJsonValue,
        }, egress, prepared.headers);
        return {
          checkId: check.id,
          ok: out.ok,
          statusCode: out.statusCode,
          latencyMs: out.latencyMs,
          error: out.error === undefined ? undefined : redactSecrets(out.error, prepared.secretValues),
          checkedAt,
        };
      }
      case "tcp": {
        if (!check.tcpHost || !check.tcpPort) return malformed(check.id, checkedAt, "no host or port");
        const out = await runTcpCheck(
          check.tcpHost,
          check.tcpPort,
          check.tcpTls === true,
          undefined,
          egress,
        );
        return {
          checkId: check.id,
          ok: out.ok,
          latencyMs: out.latencyMs,
          error: out.error,
          checkedAt,
        };
      }
      case "dns": {
        if (!check.dnsHostname || !check.dnsRecordType) {
          return malformed(check.id, checkedAt, "no hostname or record type");
        }
        const out = await runDnsCheck(
          check.dnsHostname,
          check.dnsRecordType,
          check.dnsExpectedValue ?? null,
        );
        return {
          checkId: check.id,
          ok: out.ok,
          latencyMs: out.latencyMs,
          error: out.error,
          checkedAt,
        };
      }
      case "ping": {
        if (!check.pingHost) return malformed(check.id, checkedAt, "no host");
        const out = await runPingCheck(check.pingHost, undefined, undefined, egress);
        return {
          checkId: check.id,
          ok: out.ok,
          latencyMs: out.latencyMs,
          error: out.error,
          checkedAt,
        };
      }
      default:
        return malformed(check.id, checkedAt, `unknown check type ${String(check.type)}`);
    }
  } catch (err) {
    // Nothing above is expected to throw: each prober catches its own. This is
    // the backstop that keeps one surprising error from ending the process.
    return {
      checkId: check.id,
      ok: false,
      error: err instanceof Error ? err.message : String(err),
      checkedAt,
    };
  }
}

function malformed(checkId: string, checkedAt: string, why: string): CheckResult {
  return { checkId, ok: false, error: `Check is missing configuration: ${why}`, checkedAt };
}
