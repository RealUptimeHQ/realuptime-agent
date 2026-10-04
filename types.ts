/**
 * The agent wire contract, in one file.
 *
 * These types are the ONLY thing this package shares with the server, and they
 * are duplicated here on purpose rather than imported from `@realuptime/db`:
 * this program runs on a customer's machine, so its dependency graph has to
 * stay auditable by someone who does not trust us. Importing the database
 * package to reuse a row type would drag postgres.js, the migration runner and
 * every schema type into a binary a security reviewer is reading line by line.
 *
 * The cost of that duplication is that a server-side rename does not break the
 * build here. That is what `wire-contract.test.ts` guards: it pins the exact
 * field names, so a drift shows up as a failing assertion with the contract
 * written next to it rather than as a silent no-op in production.
 */

export type CheckType = "http" | "tcp" | "dns" | "ping";

/** One check the server has assigned to this agent, as returned by /poll. */
export interface AgentCheck {
  id: string;
  type: CheckType;
  /** http only. */
  url?: string | null;
  /** tcp only. */
  tcpHost?: string | null;
  tcpPort?: number | null;
  tcpTls?: boolean | null;
  /** dns only. */
  dnsHostname?: string | null;
  dnsRecordType?: string | null;
  dnsExpectedValue?: string | null;
  /** ping only. */
  pingHost?: string | null;
  intervalSeconds: number;
  /** http only (Monitor Phase 4). Response assertions -- see
   * `./http-assertions.ts`, this program's own copy of the evaluation rule
   * `packages/checker/http-assertions.ts` implements for the fleet. Absent,
   * or every field null, means "no assertions", exact prior behavior. */
  assertionBodyOp?: "contains" | "not_contains" | null;
  assertionBodyValue?: string | null;
  assertionBodyCaseSensitive?: boolean | null;
  assertionHeaderName?: string | null;
  assertionHeaderOp?: "equals" | "contains" | null;
  assertionHeaderValue?: string | null;
  assertionStatusMin?: number | null;
  assertionStatusMax?: number | null;
  /** JSON-path assertion (REA-176, migrations/096). Same four-group shape the
   * fleet evaluates; see `./json-path.ts`. */
  assertionJsonPath?: string | null;
  assertionJsonOp?: "equals" | "contains" | "exists" | null;
  assertionJsonValue?: string | null;
  /**
   * http only (private locations phase 3, `docs/private-probe-locations.md`
   * section 3.6). Request headers and URL credentials that carry
   * `${SECRET:NAME}` REFERENCES, never values: the server stores and sends
   * the literal reference text, and this agent resolves each name from its
   * own environment or secrets file at dial time (`secrets.ts`). Absent or
   * null means an unauthenticated check, exact prior behaviour.
   *
   * Only ever sent to an agent whose poll declared the `secret_refs`
   * capability. An agent built before this field existed gets the check with
   * no url instead, so it fails loudly rather than probing without the
   * credential it was configured with.
   */
  auth?: AgentCheckAuth | null;
}

/** The auth block of one http check. Every string is a template: literal
 * text plus `${SECRET:NAME}` references, validated by `parseChecks` for
 * shape and by `secrets.ts` for the positions and names it may use. */
export interface AgentCheckAuth {
  headers: AgentAuthHeader[];
  /** `user:${SECRET:PASSWORD}`, sent as HTTP Basic credentials. Null when
   * the check carries none. */
  userinfo: string | null;
}

export interface AgentAuthHeader {
  name: string;
  value: string;
}

/**
 * What this agent says about itself on every poll (private locations phase
 * 3). The server uses it for two things only: whether an authenticated check
 * may be served to this location in its authenticated form, and which extra
 * header names the dashboard may offer for it. Names only: never a secret
 * name, never a value, never a path.
 */
export interface AgentSelfReport {
  version: string;
  capabilities: string[];
  /** The customer-declared header names from `REALUPTIME_SECRET_HEADERS`,
   * beyond the four every agent allows. */
  secretHeaderNames: string[];
}

/** One executed check, as posted to /results. */
export interface CheckResult {
  checkId: string;
  ok: boolean;
  statusCode?: number;
  latencyMs?: number;
  error?: string;
  /**
   * ISO 8601, stamped when the check STARTED executing, never when the batch
   * was flushed. After an hours-long connectivity loss the agent delivers
   * results whose timestamps are hours old, and that is the point: the server
   * is reconstructing what happened while it could not hear us, not recording
   * when it finally did.
   */
  checkedAt: string;
}

/** The /poll response body. `services` arrived with protocol v2 (REA-181):
 * the opt-in list of service/unit names this host should report status
 * for, set per host in the dashboard. Absent or empty means "watch none",
 * which is exactly what a v1 server sends. `requestLogSnapshot` (REA-440,
 * log snapshots phase 1) is the second and only other server-pushed
 * setting: a one-shot "capture a log snapshot on your next tick" flag, true
 * when the server has a reason to want one right now (a threshold alert
 * just fired or cleared for this agent, or an operator asked for one
 * on-demand from the dashboard) and within the last few minutes. It names
 * no path and no unit; it only tells the agent WHEN, never WHAT -- the
 * WHAT is `REALUPTIME_LOG_UNITS`/`REALUPTIME_LOG_DOCKER_ENABLED`, set
 * locally on the machine and never visible to the server. See
 * `collect-logs.ts`. */
export interface PollResponse {
  checks: AgentCheck[];
  services?: string[];
  requestLogSnapshot?: boolean;
}

/**
 * ---------------------------------------------------------------------------
 * Server health metrics (the Monitor design notes)
 * ---------------------------------------------------------------------------
 *
 * The second thing this agent reports: not whether a target is up, but what
 * the machine it runs on is doing. Posted to `/metrics` in batches, on the
 * same outbound-only connection, under the same bearer token.
 *
 * Collection is NOT implemented in this program yet. These types are the
 * contract the server was built against, landed here first and on purpose, so
 * that the change which adds collection is measured against a contract that
 * already exists rather than inventing one and hoping the server agrees.
 *
 * ## Units, which are the whole contract
 *
 *   cpuUsedRatio       a fraction of TOTAL CPU capacity across all cores,
 *                      between 0 and 1. NOT a percentage (0.87, never 87) and
 *                      NOT per-core. The server refuses anything outside 0..1.
 *   cpuCores           how many cores that total is across.
 *   memory*Bytes       bytes. `used` is total minus AVAILABLE memory, not
 *                      total minus free: on Linux, cache and buffers are
 *                      reclaimable, so total-minus-free reports every healthy
 *                      machine as full.
 *   totalBytes/usedBytes (filesystems)
 *                      bytes. Percentages are derived by the server from the
 *                      totals, never reported.
 *   load1/5/15         the raw kernel load averages, unnormalised. All three
 *                      or all absent: a platform with no load average sends
 *                      none, and must never send zeroes, which would read as
 *                      an idle machine.
 *
 * ## Vantage is required, and it is pinned
 *
 * A collector inside a container reads the CONTAINER's cgroup limits and its
 * overlay filesystem. Those numbers are real and completely wrong as a
 * description of the host. The server pins whichever vantage this agent first
 * reports and refuses (409) any later batch that disagrees, so the mistake
 * surfaces as a loud error on the first batch instead of as a plausible chart
 * forever. Report what is true; do not guess "host" because it looks tidier.
 */

/** Where a sample was measured from. */
export type MetricsVantage = "host" | "container";

/** One mounted filesystem within a sample. */
export interface DiskSample {
  /** As the operating system reports it: "/", "/var", "C:\". */
  mountPoint: string;
  totalBytes: number;
  usedBytes: number;
}

/**
 * ---------------------------------------------------------------------------
 * Protocol v2 families (REA-181): network, processes, containers, services
 * ---------------------------------------------------------------------------
 *
 * Every field below is OPTIONAL on the wire and absent means "this collector
 * does not measure it here", never zero. A v1 server ignores unknown fields;
 * a v2 server stores them as a sidecar to the core sample. The core sample
 * (cpu/memory/load/disk) is unchanged and remains the only required part, so
 * a v2 agent against a v1 server and a v1 agent against a v2 server both
 * keep working. `protocolVersion` on the request names which shape the
 * collector speaks so a reader of stored data can tell the two apart.
 *
 * Privacy line, stated once: a process is reported by pid and EXECUTABLE
 * NAME only, never its command line, environment, or owner; a container by
 * its runtime id (and name when the runtime exposes one in the cgroup
 * path); a service by the name the operator typed into the watch list.
 * Nothing here carries a path the operator did not choose.
 */

/** One network interface within a sample. Bytes per second are computed by
 * the collector from two consecutive counter readings, the same delta
 * discipline `cpuUsedRatio` uses; errors/dropped are the DELTAS over that
 * same interval, not lifetime counters. */
export interface NetworkInterfaceSample {
  name: string;
  rxBytesPerSec: number;
  txBytesPerSec: number;
  rxErrors: number;
  txErrors: number;
  rxDropped: number;
  txDropped: number;
}

/** One process within a sample: the top N by CPU and by memory, merged.
 * `cpuRatio` is a fraction of TOTAL machine capacity (0..1), the same unit
 * as `cpuUsedRatio`, so the two can be compared directly. */
export interface ProcessSample {
  pid: number;
  /** Executable name only, as the OS reports it, never the command line. */
  name: string;
  cpuRatio: number;
  /** Resident set / working set, bytes. */
  memoryBytes: number;
}

/** The daemon's own lifecycle state for a container (REA-440), as reported
 * by `docker inspect`'s `State.Status`. Not derivable from a cgroup: a
 * `restarting` or `created` container may have no cgroup reading yet, and
 * an `exited` one's cgroup is often already gone. */
export type ContainerState =
  | "created"
  | "running"
  | "paused"
  | "restarting"
  | "removing"
  | "exited"
  | "dead";

/** A healthcheck's status (REA-440). `"none"` means the image defines no
 * healthcheck at all, distinct from simply not having asked: a dashboard
 * needs to tell "healthy" apart from "this container cannot report
 * health" rather than collapsing both into an absent field. */
export type ContainerHealth = "none" | "starting" | "healthy" | "unhealthy";

/** One container within a sample, read from cgroup v2 on a Linux host.
 * Absent (not empty) on macOS and Windows, whose Docker runs in a VM the
 * host cannot see into.
 *
 * `image`, `state`, `restartCount` and `health` (REA-440) are Docker Engine
 * API enrichment layered onto the cgroup reading (see `collect-docker.ts`)
 * and are OPTIONAL, exactly like every protocol v2 family field: a
 * cgroup-only reading (no Docker socket reachable, a non-docker runtime,
 * an older agent build) omits them rather than sending nulls, and a server
 * or dashboard built before REA-440 ignores them entirely. */
export interface ContainerSample {
  /** The runtime's container id, full length as found in the cgroup path. */
  id: string;
  /** A human name when the cgroup path carries one; otherwise null. */
  name: string | null;
  runtime: "docker" | "containerd" | "cri-o" | "podman" | "kubernetes" | "lxc";
  /** Fraction of total machine capacity, null on the warm-up sample. */
  cpuRatio: number | null;
  memoryUsedBytes: number;
  /** The cgroup's memory.max, null when unlimited ("max"). */
  memoryLimitBytes: number | null;
  /** The image reference the container was created from, e.g. "nginx:1.27". */
  image?: string | null;
  state?: ContainerState | null;
  /** Cumulative restarts since the container was created, as the daemon
   * counts them. An increase between two samples is a signal worth
   * alerting on even when the container is currently running. */
  restartCount?: number | null;
  health?: ContainerHealth | null;
}

export type ServiceStatus = "active" | "inactive" | "failed" | "unknown";

/** One watched service/unit within a sample. */
export interface ServiceSample {
  name: string;
  status: ServiceStatus;
}

/** One named database's on-disk size within a `PostgresSample`, largest
 * first, bounded at `MAX_POSTGRES_DATABASES_PER_SAMPLE`
 * (collect-postgres.ts). */
export interface PostgresDatabaseSample {
  name: string;
  sizeBytes: number;
}

/** A PostgreSQL instance's own health (REA-440 phase 3), read from
 * `pg_stat_activity` / `pg_settings` / `pg_stat_database` / `pg_database` /
 * `pg_stat_replication` -- see collect-postgres.ts. Config-gated: present
 * only when `REALUPTIME_POSTGRES_DSN` is set and the connection attempt for
 * this tick succeeded. */
export interface PostgresSample {
  connections: number;
  /** Null when `pg_settings` could not be read (should not happen for a
   * role with monitoring privileges, but nothing here assumes it). */
  maxConnections: number | null;
  /** Largest first, at most `MAX_POSTGRES_DATABASES_PER_SAMPLE`. */
  databases: PostgresDatabaseSample[];
  /** 0..1 fraction, blocks served from shared_buffers over total block
   * reads. Null on a cluster with no reads of either kind yet. */
  cacheHitRatio: number | null;
  /** Age in seconds of the oldest still-active query, 0 when none is
   * running. */
  longestQuerySeconds: number;
  /** Seconds, the furthest-behind replica as seen from a primary. Null on
   * an instance with no replicas visible (standalone, or this is itself a
   * standby, whose own lag is not exposed by this view). */
  replicationLagSeconds: number | null;
}

/** A Redis/Valkey instance's own health (REA-440 phase 3), read from one
 * `INFO` reply -- see collect-redis.ts. Config-gated: present only when
 * `REALUPTIME_REDIS_DSN` is set and the connection attempt for this tick
 * succeeded. */
export interface RedisSample {
  usedMemoryBytes: number;
  /** Null when `maxmemory` is unset (Redis's own 0 = unlimited). */
  maxMemoryBytes: number | null;
  connectedClients: number;
  /** 0..1 fraction, keyspace_hits over hits+misses. Null when neither has
   * happened yet. */
  hitRatio: number | null;
  evictedKeys: number;
}

/** A MySQL/MariaDB instance's own health (REA-440 phase 4), read from
 * `SHOW GLOBAL STATUS` / `SHOW GLOBAL VARIABLES` / `SHOW SLAVE STATUS` --
 * see collect-mysql.ts. Config-gated: present only when
 * `REALUPTIME_MYSQL_DSN` is set and the connection attempt for this tick
 * succeeded. Same single-object shape as `PostgresSample`/`RedisSample`:
 * one instance has one reading per instant, not a list of them. */
export interface MysqlSample {
  connections: number;
  /** Null when `max_connections` could not be read. */
  maxConnections: number | null;
  /** Threads actively executing a query right now, not merely connected. */
  threadsRunning: number;
  /** Cumulative counter since server start, same treatment as Redis's
   *  `evictedKeys`. */
  slowQueries: number;
  /** 0..1 fraction, InnoDB buffer pool reads served from memory over total
   * logical reads. Null on a server with no reads of either kind yet. */
  bufferPoolHitRatio: number | null;
  uptimeSeconds: number;
  /** Seconds, this instance's own lag as a replica. Null on a standalone
   * instance or a primary (an empty `SHOW SLAVE STATUS`), and also null
   * when the column itself is NULL (a replica whose IO thread is not
   * currently connected, whose lag is genuinely unknown, not zero). */
  replicationLagSeconds: number | null;
}

/** One physical GPU's health at this instant (REA-440 phase 5), read from
 * one `nvidia-smi --query-gpu=... --format=csv,noheader,nounits` row -- see
 * collect-gpu.ts. Unlike Postgres/Redis/MySQL, a host can have more than
 * one GPU, so the family is an array of these, not a single object. */
export interface GpuReading {
  /** `nvidia-smi`'s own device index, stable across ticks on one host. */
  index: number;
  name: string;
  /** 0..1 fraction, same unit as `cpuUsedRatio`, from nvidia-smi's
   * `utilization.gpu` (a 0..100 percent) divided by 100. */
  utilizationRatio: number;
  memoryUsedBytes: number;
  memoryTotalBytes: number;
  temperatureCelsius: number;
  /** Null when nvidia-smi reports `[N/A]` for this field: some cards and
   * some power modes do not expose power telemetry at all. */
  powerDrawWatts: number | null;
  powerLimitWatts: number | null;
}

/** GPU collection was attempted this tick but could not produce a
 * truthful reading: `nvidia-smi` is present but errored (driver issue,
 * card fallen off the bus, permissions), its output did not parse, or
 * `REALUPTIME_GPU_VENDOR` names a vendor this agent version does not
 * implement (amd, intel). Distinct from the family being entirely absent
 * (no `nvidia-smi` binary found at all -- see collect-gpu.ts's module
 * comment for why the two are not collapsed into one "no GPU" state). */
export interface GpuUnavailable {
  error: string;
}

/** Present only when GPU collection was attempted this tick: absent
 * entirely means no NVIDIA driver was found on this host (the common,
 * silent case, same treatment as "no Docker socket"). An array (possibly
 * multi-GPU) on success, `GpuUnavailable` when nvidia-smi exists but this
 * tick's reading failed, or the vendor is explicitly unsupported. */
export type GpuSample = GpuReading[] | GpuUnavailable;

/** Where a captured log tail came from (REA-440, log snapshots phase 1). */
export type LogSnapshotSourceType = "journald" | "docker";

/** A small, bounded tail of recent log lines from one opt-in source,
 * captured only when the server asked for one (see `PollResponse.
 * requestLogSnapshot` above) and held in agent memory until the next
 * metrics flush -- never collected on every tick, never shipped with every
 * sample. See collect-logs.ts for the caps and the capture rule.
 *
 * Redaction is explicitly OUT of scope for phase 1 (see apps/agent/
 * README.md): a log line the operator's own application wrote may contain
 * a secret, and this snapshot ships it verbatim. The feature is opt-in per
 * source for exactly that reason. */
export interface LogSnapshot {
  /** The unit name or container id/name this tail came from, as configured
   * locally -- never a path. */
  source: string;
  sourceType: LogSnapshotSourceType;
  /** ISO 8601, when the capture ran (not when the batch was flushed). */
  capturedAt: string;
  /** Oldest first, at most `LOG_SNAPSHOT_MAX_LINES` (collect-logs.ts). */
  lines: string[];
  /** True when more lines existed than were captured (best-effort: exactly
   * `lines.length` came back from the capture command, which is itself
   * capped, so this is "the source may have had more", not a precise
   * count). */
  truncatedLines: boolean;
  /** True when one or more lines were cut to `LOG_SNAPSHOT_MAX_LINE_BYTES`
   * and had a truncation marker appended. */
  truncatedBytes: boolean;
}

export type HostOs = "linux" | "darwin" | "windows" | "other";

/** REA-780. Defined here rather than imported from `host-network.ts` for the
 * same reason every other type in this file is duplicated: this is the wire
 * contract, and it must be readable without following an import into the
 * collector. `host-network.ts` re-states it and `wire-contract.test.ts` pins
 * both. */
export type HostNetworkMode = "host" | "isolated";

/** Identity of the reporting host, sent on every v2 batch (it is cheap and
 * makes the batch self-describing when read months later). `cluster` and
 * `node` are the two optional labels the dashboard's cluster view groups
 * by; they come from `REALUPTIME_CLUSTER` / `REALUPTIME_NODE` and default
 * to null / the hostname. */
export interface HostInfo {
  hostname: string;
  os: HostOs;
  osVersion: string | null;
  arch: string;
  cluster: string | null;
  node: string | null;
  /** REA-780: whether this process shares the machine's network ("host") or
   * has one of its own ("isolated"), from `host-network.ts`. Null means the
   * agent could not tell, and the server and dashboard then say nothing at
   * all: this field exists to explain a specific failure, and a wrong
   * explanation is worse than none. An agent older than REA-780 omits it,
   * which reads the same as null. */
  networkMode?: HostNetworkMode | null;
  /** REA-780: the default gateway of an ISOLATED namespace, which is the
   * address the host answers on from inside the container (172.17.0.1 for
   * Docker's default bridge). Null on a host-networked agent, where it is
   * merely the machine's own router and means nothing. */
  networkGateway?: string | null;
}

/** One instant's server health. */
export interface MetricSample {
  /**
   * ISO 8601, stamped when the sample was MEASURED, never when the batch was
   * flushed, exactly like `CheckResult.checkedAt`.
   *
   * Unlike a check result, an out-of-window timestamp here is DROPPED rather
   * than rewritten to server time: a chart must not have points invented at
   * instants nothing was measured. The server accepts up to 24 hours old and
   * up to a minute into the future, and returns the count it dropped.
   */
  sampledAt: string;
  /** 0..1 fraction of total capacity. See the units note above. */
  cpuUsedRatio: number;
  cpuCores: number;
  memoryTotalBytes: number;
  /** Total minus available, not total minus free. */
  memoryUsedBytes: number;
  /** All three or all omitted. */
  load1?: number | null;
  load5?: number | null;
  load15?: number | null;
  filesystems: DiskSample[];
  /** Protocol v2 families; each absent when this host's collector has no
   * truthful reading for it. See the section comment above. */
  network?: NetworkInterfaceSample[];
  processes?: ProcessSample[];
  containers?: ContainerSample[];
  services?: ServiceSample[];
  /** REA-440 phase 3: present only when `REALUPTIME_POSTGRES_DSN` is
   * configured and this tick's connection succeeded. */
  postgres?: PostgresSample;
  /** REA-440 phase 3: present only when `REALUPTIME_REDIS_DSN` is
   * configured and this tick's connection succeeded. */
  redis?: RedisSample;
  /** REA-440 phase 4: present only when `REALUPTIME_MYSQL_DSN` is
   * configured and this tick's connection succeeded. */
  mysql?: MysqlSample;
  /** REA-440 phase 5: present only when GPU collection was attempted this
   * tick (an NVIDIA driver was found, or `REALUPTIME_GPU_VENDOR` names an
   * unsupported vendor). Absent means no GPU collection to report at all,
   * not "zero GPUs". See `GpuSample`. */
  gpu?: GpuSample;
  /** REA-440, log snapshots phase 1: present only when the server asked for
   * one on the last poll (`PollResponse.requestLogSnapshot`) AND at least
   * one opt-in source is configured. Absent on every ordinary sample --
   * this is the field the whole feature exists to keep off the wire except
   * at an alert or an on-demand pull. */
  logs?: LogSnapshot[];
}

/** The `/metrics` request body. At most 100 samples, each with at most 32
 * filesystems; a batch that breaks either bound is refused whole. */
export interface MetricsRequest {
  vantage: MetricsVantage;
  /** Free-text detail behind the vantage: "docker", "lxc", "kubernetes". */
  vantageDetail?: string | null;
  collectorVersion?: string | null;
  /** 2 since REA-181. Omitted (v1) means "core sample only". */
  protocolVersion?: number;
  host?: HostInfo | null;
  samples: MetricSample[];
}

/** The protocol version this program speaks. */
export const WIRE_PROTOCOL_VERSION = 2;

/** The `/metrics` response body: counts, for the agent's own logs.
 *
 * `rejectedDuplicate` staying non-zero across FRESH batches (not redeliveries)
 * means another collector is posting on this same token; first write wins, so
 * neither can overwrite the other, but the series will be interleaved. */
export interface MetricsResponse {
  accepted: number;
  rejectedStale: number;
  rejectedFuture: number;
  rejectedDuplicate: number;
}
