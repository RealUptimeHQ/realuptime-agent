import { readFileSync } from "node:fs";

/**
 * Configuration: a handful of environment variables, and nothing else.
 *
 * There is no config file, no config directory, no `--flag`, and no
 * server-pushed setting that changes how this process behaves locally (the
 * one exception, the service watch list, can only name units and is
 * documented in collect-services.ts). That is a security property, not
 * minimalism for its own sake. A customer's security reviewer can read this
 * one file and know the complete set of inputs the program accepts, and an
 * attacker who reaches the machine cannot repoint the agent by dropping a
 * file next to it.
 *
 * It also means the install instruction stays one line, which is the thing
 * every competitor's onboarding gets wrong.
 *
 * ## The variables
 *
 *   REALUPTIME_TOKEN        the `rua_...` token (required unless TOKEN_FILE)
 *   REALUPTIME_TOKEN_FILE   a path to read the token from, once, at start.
 *                           For Kubernetes, where a DaemonSet mounts one
 *                           Secret with one key per node and names the key
 *                           with the node name; and for Docker/Podman
 *                           secrets. The file is read exactly once and its
 *                           path is never derived from anything the server
 *                           sends. This is the ONLY file path this program
 *                           accepts from its environment.
 *   REALUPTIME_URL          origin override for self-hosted / staging
 *   REALUPTIME_CLUSTER      optional label: which cluster this host is in
 *   REALUPTIME_NODE         optional label: this host's node name (defaults
 *                           to the hostname). Both labels are purely for
 *                           grouping in the dashboard.
 *   REALUPTIME_POSTGRES_DSN optional (REA-440): a `postgresql://` connection
 *                           string this agent should read read-only health
 *                           metrics from (see collect-postgres.ts). Absent
 *                           means no Postgres traffic at all, ever -- this
 *                           is the one variable in this file that makes the
 *                           process talk to something other than the
 *                           RealUptime API, so it is off by default and its
 *                           value is never logged, not even truncated.
 *   REALUPTIME_REDIS_DSN    optional (REA-440): a `redis://` connection
 *                           string for read-only health metrics from a
 *                           Redis/Valkey instance (see collect-redis.ts).
 *                           Same off-by-default, never-logged treatment as
 *                           REALUPTIME_POSTGRES_DSN.
 *   REALUPTIME_MYSQL_DSN    optional (REA-440 phase 4): a `mysql://`
 *                           connection string for read-only health metrics
 *                           from a MySQL/MariaDB instance (see
 *                           collect-mysql.ts). Same off-by-default,
 *                           never-logged treatment as the other two.
 *   REALUPTIME_GPU_VENDOR   optional (REA-440 phase 5): "nvidia" (the
 *                           default when unset), "amd", or "intel". Unlike
 *                           the three DSN variables above, this is not a
 *                           credential and collection needs no opt-in: on
 *                           the default "nvidia" the agent simply looks for
 *                           `nvidia-smi` on PATH every tick and reports
 *                           nothing when it is not there (see
 *                           collect-gpu.ts). Set this to "amd" or "intel"
 *                           only to make an unsupported host say so plainly
 *                           in its sample instead of silently reporting no
 *                           GPU: this agent version implements NVIDIA via
 *                           nvidia-smi only.
 *   REALUPTIME_LOG_UNITS    optional (REA-440, log snapshots phase 1):
 *                           comma-separated systemd unit names this agent
 *                           may capture a short journald tail from, WHEN
 *                           the server asks for one (see collect-logs.ts
 *                           and PollResponse.requestLogSnapshot). Absent
 *                           means no journald source at all, ever. Each
 *                           name is validated again by collect-logs.ts, the
 *                           same "server-pushed values are re-checked
 *                           locally" rule the service watch list follows,
 *                           except this list is never server-pushed at
 *                           all: it is set once, on this machine, by
 *                           whoever runs the agent.
 *   REALUPTIME_LOG_DOCKER_ENABLED
 *                           optional (REA-440, log snapshots phase 1):
 *                           "true" opts this host into capturing a short
 *                           `docker logs` tail from containers this agent
 *                           already monitors (collect-containers.ts), when
 *                           the server asks for a snapshot. No separate
 *                           container list: the set eligible is exactly
 *                           the set already being read for cgroup metrics.
 *                           Absent or anything else means off.
 *   REALUPTIME_LOG_LINES    optional (REA-440, log snapshots phase 1): how
 *                           many lines to request per source, default 50,
 *                           clamped to `LOG_SNAPSHOT_MAX_LINES` (200,
 *                           collect-logs.ts) either direction.
 *   REALUPTIME_ERRORS_INTERNAL / REALUPTIME_ERRORS_DSN
 *                           optional (REA-575): reports THIS agent's own
 *                           unhandled exceptions and rejections to
 *                           errors-internal, off unless both are set --
 *                           see errors-report.ts, read by that file
 *                           directly rather than through `AgentConfig`
 *                           below, since it never touches a check or a
 *                           poll. `REALUPTIME_ERRORS_DSN` is never a
 *                           credential worth alarm here: it is only ever
 *                           set on a RealUptime-owned host running this
 *                           same binary for our own monitoring, never on a
 *                           customer's.
 */

export interface AgentConfig {
  /** The `rua_...` token the dashboard shows once, at agent registration. */
  token: string;
  /** Origin only, no trailing slash. */
  baseUrl: string;
  cluster: string | null;
  node: string | null;
  /** REA-440: raw connection string, or null when not configured. Never
   *  logged; collect-postgres.ts is the only reader. */
  postgresDsn: string | null;
  /** REA-440: raw connection string, or null when not configured. Never
   *  logged; collect-redis.ts is the only reader. */
  redisDsn: string | null;
  /** REA-440 phase 4: raw connection string, or null when not configured.
   *  Never logged; collect-mysql.ts is the only reader. */
  mysqlDsn: string | null;
  /** REA-440 phase 5: "nvidia" unless REALUPTIME_GPU_VENDOR names another
   *  supported vendor. Not a secret, safe to log. collect-gpu.ts is the
   *  only reader. */
  gpuVendor: GpuVendor;
  /** REA-440, log snapshots phase 1: raw comma-separated unit names, split
   *  and trimmed but NOT shape-validated here -- collect-logs.ts's
   *  `normalizeServiceName` does that, same split of responsibility as the
   *  three DSNs above. Empty means no journald source configured. */
  logUnits: string[];
  /** REA-440, log snapshots phase 1: opts this host's already-monitored
   *  containers into a `docker logs` tail. Off unless exactly "true"
   *  (case-insensitive). */
  logDockerEnabled: boolean;
  /** REA-440, log snapshots phase 1: lines requested per source, already
   *  clamped to `LOG_SNAPSHOT_DEFAULT_LINES`/`LOG_SNAPSHOT_MAX_LINES`
   *  (collect-logs.ts, pinned again in wire-contract.test.ts since this
   *  file imports nothing from that one). */
  logLines: number;
}

export const GPU_VENDORS = ["nvidia", "amd", "intel"] as const;
export type GpuVendor = (typeof GPU_VENDORS)[number];

export const DEFAULT_BASE_URL = "https://realuptime.io";
export const MAX_LABEL_LENGTH = 128;
/** Mirrors collect-logs.ts's LOG_SNAPSHOT_DEFAULT_LINES/MAX_LINES exactly
 *  (pinned together in wire-contract.test.ts); duplicated as literals here
 *  rather than imported so this file keeps its zero-internal-imports
 *  property. */
const LOG_LINES_DEFAULT = 50;
const LOG_LINES_MAX = 200;

export class ConfigError extends Error {}

export function loadConfig(
  env: NodeJS.ProcessEnv = process.env,
  readFile: (path: string) => string = (path) => readFileSync(path, "utf8"),
): AgentConfig {
  let token = (env.REALUPTIME_TOKEN ?? "").trim();
  const tokenFile = (env.REALUPTIME_TOKEN_FILE ?? "").trim();
  if (!token && tokenFile) {
    try {
      token = readFile(tokenFile).trim();
    } catch (err) {
      throw new ConfigError(
        `REALUPTIME_TOKEN_FILE could not be read (${tokenFile}): ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
  if (!token) {
    throw new ConfigError(
      "REALUPTIME_TOKEN is not set. Copy the agent token from the RealUptime dashboard and pass it as REALUPTIME_TOKEN (or a file path as REALUPTIME_TOKEN_FILE).",
    );
  }

  const raw = (env.REALUPTIME_URL ?? "").trim() || DEFAULT_BASE_URL;
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new ConfigError(`REALUPTIME_URL is not a valid URL: ${raw}`);
  }
  // http is accepted so a self-hosted or staging deployment can be pointed at
  // without a certificate, but the default and every documented install use
  // https. Anything else (file:, ftp:) is a misconfiguration that would
  // otherwise fail later, deep inside fetch, with a worse message.
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw new ConfigError(`REALUPTIME_URL must be http or https, got ${parsed.protocol}`);
  }

  // Not shape-checked here (a malformed DSN is collect-postgres.ts's / or
  // collect-redis.ts's own "not configured" path, logged once from there
  // rather than twice): this file's job is only to say whether the
  // variable was set at all.
  const postgresDsn = (env.REALUPTIME_POSTGRES_DSN ?? "").trim() || null;
  const redisDsn = (env.REALUPTIME_REDIS_DSN ?? "").trim() || null;
  const mysqlDsn = (env.REALUPTIME_MYSQL_DSN ?? "").trim() || null;

  const gpuVendorRaw = (env.REALUPTIME_GPU_VENDOR ?? "").trim().toLowerCase();
  const gpuVendor: GpuVendor = gpuVendorRaw ? (gpuVendorRaw as GpuVendor) : "nvidia";
  if (!GPU_VENDORS.includes(gpuVendor)) {
    throw new ConfigError(
      `REALUPTIME_GPU_VENDOR must be one of ${GPU_VENDORS.join(", ")}, got "${gpuVendorRaw}"`,
    );
  }

  // Split and trimmed only. Name validation (character class, length,
  // dot-dot/slash refusal) lives in collect-logs.ts, same as every other
  // "the operator typed this" value in this program.
  const logUnits = (env.REALUPTIME_LOG_UNITS ?? "")
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
  const logDockerEnabled =
    (env.REALUPTIME_LOG_DOCKER_ENABLED ?? "").trim().toLowerCase() === "true";
  const requestedLogLines = Number.parseInt((env.REALUPTIME_LOG_LINES ?? "").trim(), 10);
  const logLines = Number.isFinite(requestedLogLines)
    ? Math.min(Math.max(requestedLogLines, 1), LOG_LINES_MAX)
    : LOG_LINES_DEFAULT;

  return {
    token,
    baseUrl: parsed.origin,
    cluster: label(env.REALUPTIME_CLUSTER),
    node: label(env.REALUPTIME_NODE),
    postgresDsn,
    redisDsn,
    mysqlDsn,
    gpuVendor,
    logUnits,
    logDockerEnabled,
    logLines,
  };
}

/** A label is free text the customer typed; bounded and stripped of
 * control characters, otherwise as given. Empty is null. */
function label(raw: string | undefined): string | null {
  const value = (raw ?? "")
    // biome-ignore lint/suspicious/noControlCharactersInRegex: stripping control characters is the point
    .replace(/[\x00-\x1f\x7f]/g, "")
    .trim()
    .slice(0, MAX_LABEL_LENGTH);
  return value || null;
}

/** For log lines and error messages: proves the right token was loaded without
 *  putting a working credential in a log file the customer may ship offsite. */
export function tokenFingerprint(token: string): string {
  return token.length <= 10 ? "rua_..." : `${token.slice(0, 8)}...${token.slice(-4)}`;
}
