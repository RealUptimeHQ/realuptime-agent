import { runTcpCheck } from "./check-tcp.ts";

/**
 * The ping check, agent side (REA-281).
 *
 * Same transport decision as the cloud fleet's prober
 * (`packages/checker/ping-probe.ts` -- read that file's header for the full
 * "why not real ICMP" reasoning, which applies here too: the agent is a
 * plain Node process the customer runs with no assumed privilege, on
 * whichever of Linux/macOS/Windows they installed it, and Node has no
 * built-in ICMP socket on any of them). TCP-connect-time against a small set
 * of commonly-open ports, honestly labeled, not asserted as ICMP anywhere.
 *
 * Reuses `runTcpCheck` (this app's own tcp prober) rather than duplicating
 * socket handling -- an agent-side ping probe against an internal host has
 * exactly the same "connect, time it, tear it down, write nothing" shape a
 * tcp probe already has, with no port supplied by the customer to reuse, so
 * this supplies the candidate ports instead.
 */
export const PING_TRANSPORT = "tcp-connect" as const;

const CANDIDATE_PORTS = [443, 80, 22] as const;

export const DEFAULT_PING_COUNT = 4;

export interface PingOutcome {
  ok: boolean;
  latencyMs: number;
  error?: string;
  transport: typeof PING_TRANSPORT;
  port: number | null;
  packetLossPercent: number;
}

export async function runPingCheck(
  host: string,
  count: number = DEFAULT_PING_COUNT,
  timeoutMs?: number,
): Promise<PingOutcome> {
  let port: number | null = null;
  let received = 0;
  let sent = 0;
  const latencies: number[] = [];

  for (let i = 0; i < count; i++) {
    const portsToTry: readonly number[] = port !== null ? [port] : CANDIDATE_PORTS;
    for (const candidate of portsToTry) {
      sent += 1;
      const out = await runTcpCheck(host, candidate, false, timeoutMs);
      if (out.ok) {
        port = candidate;
        latencies.push(out.latencyMs);
        received += 1;
        break;
      }
    }
  }

  const packetLossPercent = sent === 0 ? 100 : Math.round(((sent - received) / sent) * 100);
  const avgLatencyMs =
    latencies.length > 0 ? Math.round(latencies.reduce((a, b) => a + b, 0) / latencies.length) : 0;

  if (received === 0) {
    return {
      ok: false,
      latencyMs: avgLatencyMs,
      error: `No response on any of the usual ports (${CANDIDATE_PORTS.join(", ")}) over ${count} attempts (${packetLossPercent}% loss).`,
      transport: PING_TRANSPORT,
      port: null,
      packetLossPercent,
    };
  }

  return {
    ok: true,
    latencyMs: avgLatencyMs,
    transport: PING_TRANSPORT,
    port,
    packetLossPercent,
    ...(packetLossPercent > 0
      ? { error: `${packetLossPercent}% packet loss over ${sent} probes (port ${port}).` }
      : {}),
  };
}
