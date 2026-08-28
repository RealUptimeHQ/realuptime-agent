import net, { isIP } from "node:net";
import tls from "node:tls";

/**
 * The tcp check: did the connection complete, and (when tls is on) did the
 * handshake complete, inside the timeout.
 *
 * Nothing is written to the socket and nothing is read off it. That is what
 * makes watching an arbitrary customer-chosen port defensible even inside
 * their own network: there are no bytes in either direction to smuggle into a
 * text protocol, and no response data to accidentally log.
 *
 * ## `rejectUnauthorized: false`, deliberately
 *
 * Same call the cloud fleet makes (`packages/db/guarded-connect.ts`), and the
 * case is stronger here. The targets are internal: private CAs, self-signed
 * certificates and IP-addressed services are the norm on a private network,
 * not a red flag. If certificate validation were on, every one of those would
 * report as down while the service was perfectly healthy, and the customer
 * would learn to ignore the agent. Certificate EXPIRY is a separate product
 * surface with its own alerting; conflating it with reachability makes the
 * reachability signal useless.
 */

export const DEFAULT_TIMEOUT_MS = 10_000;

export interface TcpOutcome {
  ok: boolean;
  latencyMs: number;
  error?: string;
}

export async function runTcpCheck(
  host: string,
  port: number,
  useTls: boolean,
  timeoutMs: number = DEFAULT_TIMEOUT_MS,
): Promise<TcpOutcome> {
  const started = Date.now();

  return new Promise<TcpOutcome>((resolve) => {
    let settled = false;
    let socket: net.Socket | tls.TLSSocket | undefined;

    const finish = (outcome: TcpOutcome) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      // destroy(), not end(): end() sends FIN and waits for the peer, which a
      // hung target will never send, and the process would then hold the
      // socket open for the rest of its life.
      socket?.destroy();
      resolve(outcome);
    };

    const timer = setTimeout(() => {
      finish({
        ok: false,
        latencyMs: Date.now() - started,
        error: useTls ? "The TLS handshake timed out" : "The connection timed out",
      });
    }, timeoutMs);

    try {
      if (useTls) {
        socket = tls.connect({
          host,
          port,
          // An IP literal is not a legal SNI value, and sending one makes some
          // servers abort the handshake outright.
          servername: isIP(host) ? undefined : host,
          rejectUnauthorized: false,
        });
        socket.once("secureConnect", () => finish({ ok: true, latencyMs: Date.now() - started }));
      } else {
        socket = net.connect({ host, port });
        socket.once("connect", () => finish({ ok: true, latencyMs: Date.now() - started }));
      }
      socket.once("error", (err: Error) => {
        finish({ ok: false, latencyMs: Date.now() - started, error: describeSocketError(err) });
      });
      // A peer that closes without ever completing the connection would
      // otherwise leave this promise pending until the timeout, reporting a
      // timeout for what was actually a refusal.
      socket.once("close", () => {
        finish({
          ok: false,
          latencyMs: Date.now() - started,
          error: "The connection closed before it completed",
        });
      });
    } catch (err) {
      finish({
        ok: false,
        latencyMs: Date.now() - started,
        error: describeSocketError(err),
      });
    }
  });
}

/** Plain language, because the raw errno is not something an operator should
 *  have to look up at 3am. The code is kept in parentheses for the ones who
 *  do want it. */
function describeSocketError(err: unknown): string {
  const code = (err as { code?: string })?.code;
  switch (code) {
    case "ECONNREFUSED":
      return "The connection was refused (ECONNREFUSED)";
    case "ETIMEDOUT":
      return "The connection timed out (ETIMEDOUT)";
    case "EHOSTUNREACH":
      return "The host is unreachable (EHOSTUNREACH)";
    case "ENETUNREACH":
      return "The network is unreachable (ENETUNREACH)";
    case "ENOTFOUND":
    case "EAI_AGAIN":
      return `That hostname could not be resolved (${code})`;
    case "ECONNRESET":
      return "The connection was reset (ECONNRESET)";
    default:
      return err instanceof Error ? err.message : String(err);
  }
}
