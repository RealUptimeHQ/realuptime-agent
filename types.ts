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
 * which is exactly what a v1 server sends. It is the ONLY server-pushed
 * setting that changes what the agent reads locally, and it can only name
 * service units, never a path: see `collect-services.ts`. */
export interface PollResponse {
  checks: AgentCheck[];
  services?: string[];
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

/** One container within a sample, read from cgroup v2 on a Linux host.
 * Absent (not empty) on macOS and Windows, whose Docker runs in a VM the
 * host cannot see into. */
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
}

export type ServiceStatus = "active" | "inactive" | "failed" | "unknown";

/** One watched service/unit within a sample. */
export interface ServiceSample {
  name: string;
  status: ServiceStatus;
}

export type HostOs = "linux" | "darwin" | "windows" | "other";

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
