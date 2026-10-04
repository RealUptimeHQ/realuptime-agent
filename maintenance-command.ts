import type { AgentConfig } from "./config.ts";

/**
 * `realuptime-agent maintenance`: flag planned work on THIS server
 * (REA-968), using the agent's own token, so a restart script on the host can
 * say "the next few minutes of downtime are expected" without an account API
 * key on the box.
 *
 *   realuptime-agent maintenance --minutes 15 --reason "restart" [--host example.com ...]
 *   realuptime-agent maintenance --end
 *   realuptime-agent maintenance --status
 *
 * While the window is active the server's offline and health alerts are
 * withheld, and every check that runs from this agent, or targets one of the
 * hosts named here (or this machine's own host name), opens no incident and
 * does not count against uptime. When it ends, anything still down is
 * reported from that moment.
 *
 * It calls `/api/v1/agents/self/maintenance` once and exits: 0 on success, 1
 * on any failure, 2 on a usage error. It never starts the monitoring loop.
 */

export const DEFAULT_MINUTES = 15;
export const MAX_MINUTES = 1440;
const REQUEST_TIMEOUT_MS = 15_000;

export type MaintenanceArgs =
  | { action: "open"; minutes: number; reason: string; hosts: string[] }
  | { action: "end" }
  | { action: "status" }
  | { action: "help" };

export class UsageError extends Error {}

export const USAGE = `Usage:
  realuptime-agent maintenance [--minutes N] [--reason TEXT] [--host NAME ...]
  realuptime-agent maintenance --end
  realuptime-agent maintenance --status

Flags planned work on this server: no incident, no alert and no downtime for
its checks until the window ends. --minutes defaults to ${DEFAULT_MINUTES}, at most ${MAX_MINUTES}.`;

export function parseMaintenanceArgs(argv: readonly string[]): MaintenanceArgs {
  let minutes = DEFAULT_MINUTES;
  let reason = "";
  const hosts: string[] = [];
  let action: "open" | "end" | "status" = "open";
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!;
    const value = () => {
      const next = argv[i + 1];
      if (next === undefined || next.startsWith("--")) throw new UsageError(`${arg} needs a value`);
      i += 1;
      return next;
    };
    switch (arg) {
      case "--minutes": {
        const raw = value();
        if (!/^\d+$/.test(raw)) throw new UsageError("--minutes must be a whole number");
        minutes = Number(raw);
        if (minutes < 1 || minutes > MAX_MINUTES) {
          throw new UsageError(`--minutes must be between 1 and ${MAX_MINUTES}`);
        }
        break;
      }
      case "--reason":
        reason = value();
        break;
      case "--host":
        hosts.push(value());
        break;
      case "--end":
      case "--off":
        action = "end";
        break;
      case "--status":
        action = "status";
        break;
      case "-h":
      case "--help":
        return { action: "help" };
      default:
        throw new UsageError(`unknown argument: ${arg}`);
    }
  }
  if (action === "open") return { action, minutes, reason, hosts };
  return { action };
}

interface WindowBody {
  window: { ends_at: string; reason: string; hosts: string[] } | null;
  error?: string;
}

/** One line a restart script can log as-is. */
export function describeWindow(action: MaintenanceArgs["action"], body: WindowBody): string {
  const w = body.window;
  if (action === "end") return w ? "planned maintenance ended" : "no planned maintenance was active";
  if (!w) return "no planned maintenance active";
  const hosts = w.hosts.length ? `, also covering ${w.hosts.join(", ")}` : "";
  const reason = w.reason ? ` (${w.reason})` : "";
  return `planned maintenance until ${w.ends_at}${reason}${hosts}`;
}

export async function runMaintenanceCommand(
  argv: readonly string[],
  config: Pick<AgentConfig, "baseUrl" | "token">,
  out: { log: (line: string) => void; error: (line: string) => void } = console,
  fetchImpl: typeof fetch = fetch,
): Promise<number> {
  let args: MaintenanceArgs;
  try {
    args = parseMaintenanceArgs(argv);
  } catch (err) {
    out.error(`realuptime-agent maintenance: ${err instanceof Error ? err.message : String(err)}`);
    out.error(USAGE);
    return 2;
  }
  if (args.action === "help") {
    out.log(USAGE);
    return 0;
  }

  const url = `${config.baseUrl}/api/v1/agents/self/maintenance`;
  const init: RequestInit = {
    method: args.action === "open" ? "POST" : args.action === "end" ? "DELETE" : "GET",
    headers: {
      authorization: `Bearer ${config.token}`,
      ...(args.action === "open" ? { "content-type": "application/json" } : {}),
    },
    ...(args.action === "open"
      ? { body: JSON.stringify({ minutes: args.minutes, reason: args.reason, hosts: args.hosts }) }
      : {}),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  };

  let response: Response;
  try {
    response = await fetchImpl(url, init);
  } catch (err) {
    out.error(`realuptime-agent maintenance: request failed: ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  }
  let body: WindowBody | null = null;
  try {
    body = (await response.json()) as WindowBody;
  } catch {
    body = null;
  }
  if (!response.ok || !body) {
    const detail = body?.error ? `: ${body.error}` : "";
    out.error(`realuptime-agent maintenance: the server answered ${response.status}${detail}`);
    return 1;
  }
  out.log(describeWindow(args.action, body));
  return 0;
}
