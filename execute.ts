import { runDnsCheck } from "./check-dns.ts";
import { runHttpCheck } from "./check-http.ts";
import { runTcpCheck } from "./check-tcp.ts";
import { runPingCheck } from "./check-ping.ts";
import type { AgentCheck, CheckResult } from "./types.ts";

/**
 * Turn one assigned check into one result.
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
export async function executeCheck(check: AgentCheck): Promise<CheckResult> {
  const checkedAt = new Date().toISOString();

  try {
    switch (check.type) {
      case "http": {
        if (!check.url) return malformed(check.id, checkedAt, "no url");
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
        });
        return {
          checkId: check.id,
          ok: out.ok,
          statusCode: out.statusCode,
          latencyMs: out.latencyMs,
          error: out.error,
          checkedAt,
        };
      }
      case "tcp": {
        if (!check.tcpHost || !check.tcpPort) return malformed(check.id, checkedAt, "no host or port");
        const out = await runTcpCheck(check.tcpHost, check.tcpPort, check.tcpTls === true);
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
        const out = await runPingCheck(check.pingHost);
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
