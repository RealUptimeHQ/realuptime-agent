import type { GpuVendor } from "./config.ts";
import { DarwinCollector } from "./collect-darwin.ts";
import { NvidiaSmiCollector } from "./collect-gpu.ts";
import { LinuxCollector } from "./collect-linux.ts";
import {
  LOG_SNAPSHOT_DEFAULT_LINES,
  LogSnapshotCollector,
  type LogSnapshotSource,
} from "./collect-logs.ts";
import { MysqlCollector } from "./collect-mysql.ts";
import { PostgresCollector } from "./collect-postgres.ts";
import { RedisCollector } from "./collect-redis.ts";
import { normalizeWatchList } from "./collect-services.ts";
import { WindowsCollector } from "./collect-windows.ts";
import { log } from "./log.ts";
import {
  detectHostNetwork,
  isolatedNetworkHint,
  readHostNetworkEvidence,
  type HostNetworkResult,
} from "./host-network.ts";
import { RealHostPlatform, type HostPlatform } from "./platform.ts";
import type { VantageResult } from "./vantage.ts";
import type {
  GpuSample,
  HostInfo,
  MetricSample,
  MetricsVantage,
  MysqlSample,
  PostgresSample,
  RedisSample,
} from "./types.ts";

/**
 * Orchestrates one server-health sample through the per-OS collector seam
 * (REA-181), and owns the two facts the runtime asks for alongside a
 * sample: this machine's vantage and its host identity.
 *
 * ## One collector per operating system, chosen once
 *
 *   linux    collect-linux.ts     files under /proc, /sys, /run; no commands
 *   darwin   collect-darwin.ts    os module + a fixed list of read-only commands
 *   windows  collect-windows.ts   os module + one PowerShell script, wmic fallback
 *   other    nothing: metrics are skipped with one log line, checks run
 *
 * The choice is made from `process.platform` at construction (or injected
 * by a test) and never revisited. Every collector is written against the
 * same `HostPlatform` interface (platform.ts), so every one of them is
 * tested against fixture text rather than a real machine, and so the
 * complete list of what this program can touch on a host is that one file.
 *
 * ## The warm-up sample
 *
 * Every collector's first `collect()` records baselines for its delta
 * families (CPU, network rates, per-process and per-container CPU) and
 * returns null. The first real sample lands on the SECOND call, one poll
 * interval later. Unchanged from the phase 2 collector; documented there
 * and in the README as expected, not a bug.
 *
 * ## The service watch list
 *
 * `setServiceWatch` receives whatever the last successful poll carried. It
 * is normalised here (collect-services.ts) so a malformed entry from the
 * server is dropped before any collector sees it.
 */

export interface PlatformCollector {
  readonly os: HostInfo["os"];
  available(): boolean;
  collect(serviceWatch: readonly string[]): Promise<MetricSample | null>;
  vantage(): VantageResult;
  hostInfo():
    | Promise<Pick<HostInfo, "os" | "osVersion" | "arch" | "hostname">>
    | Pick<HostInfo, "os" | "osVersion" | "arch" | "hostname">;
}

/** The subset of `PostgresCollector` the metrics collector needs, injectable
 * for tests exactly like `collector` above. */
export interface PostgresSource {
  collect(): Promise<PostgresSample | null>;
}

/** The subset of `RedisCollector` the metrics collector needs. */
export interface RedisSource {
  collect(): Promise<RedisSample | null>;
}

/** The subset of `MysqlCollector` the metrics collector needs. */
export interface MysqlSource {
  collect(): Promise<MysqlSample | null>;
}

/** The subset of `NvidiaSmiCollector` the metrics collector needs. */
export interface GpuSource {
  collect(): Promise<GpuSample | null>;
}

export interface MetricsCollectorOptions {
  platform?: HostPlatform;
  collector?: PlatformCollector;
  /** The two labels the dashboard's cluster view groups by; from
   *  REALUPTIME_CLUSTER / REALUPTIME_NODE. */
  cluster?: string | null;
  node?: string | null;
  /** REA-440 phase 3: `REALUPTIME_POSTGRES_DSN`, off by default. Absent or
   *  empty means no Postgres traffic at all, ever. */
  postgresDsn?: string | null;
  /** Test injection point, bypassing `postgresDsn` entirely. */
  postgres?: PostgresSource;
  /** REA-440 phase 3: `REALUPTIME_REDIS_DSN`, off by default. */
  redisDsn?: string | null;
  /** Test injection point, bypassing `redisDsn` entirely. */
  redis?: RedisSource;
  /** REA-440 phase 4: `REALUPTIME_MYSQL_DSN`, off by default. */
  mysqlDsn?: string | null;
  /** Test injection point, bypassing `mysqlDsn` entirely. */
  mysql?: MysqlSource;
  /** REA-440 phase 5: `REALUPTIME_GPU_VENDOR`, "nvidia" unless overridden.
   *  Unlike the three DSN options above, GPU collection is always
   *  attempted -- there is no credential to gate it on. See
   *  collect-gpu.ts. */
  gpuVendor?: GpuVendor;
  /** Test injection point, bypassing `gpuVendor` entirely. */
  gpu?: GpuSource;
  /** REA-440, log snapshots phase 1: `REALUPTIME_LOG_UNITS`, off by
   *  default. */
  logUnits?: readonly string[];
  /** REA-440, log snapshots phase 1: `REALUPTIME_LOG_DOCKER_ENABLED`, off
   *  by default. */
  logDockerEnabled?: boolean;
  /** REA-440, log snapshots phase 1: `REALUPTIME_LOG_LINES`. */
  logLines?: number;
  /** Test injection point, bypassing the three log options entirely. */
  logs?: LogSnapshotSource;
}

export class MetricsCollector {
  private readonly platform: HostPlatform;
  private readonly collector: PlatformCollector | null;
  private readonly cluster: string | null;
  private readonly node: string | null;
  private readonly postgres: PostgresSource | null;
  private readonly redis: RedisSource | null;
  private readonly mysql: MysqlSource | null;
  private readonly gpu: GpuSource;
  private readonly logs: LogSnapshotSource | null;
  private availableCache: boolean | null = null;
  private serviceWatch: string[] = [];
  private hostInfoCache: HostInfo | null = null;
  private hostNetworkCache: HostNetworkResult | null = null;
  private readonly warned = new Set<string>();

  constructor(options: MetricsCollectorOptions = {}) {
    this.platform = options.platform ?? new RealHostPlatform();
    this.cluster = options.cluster ?? null;
    this.node = options.node ?? null;
    const warn = (key: string, message: string) => this.warnOnce(key, message);
    this.collector =
      options.collector ??
      (this.platform.os === "linux"
        ? new LinuxCollector(this.platform, warn)
        : this.platform.os === "darwin"
          ? new DarwinCollector(this.platform, warn)
          : this.platform.os === "windows"
            ? new WindowsCollector(this.platform, warn)
            : null);
    this.postgres =
      options.postgres ?? (options.postgresDsn ? new PostgresCollector(options.postgresDsn) : null);
    this.redis = options.redis ?? (options.redisDsn ? new RedisCollector(options.redisDsn) : null);
    this.mysql = options.mysql ?? (options.mysqlDsn ? new MysqlCollector(options.mysqlDsn) : null);
    this.gpu = options.gpu ?? new NvidiaSmiCollector({ vendor: options.gpuVendor ?? "nvidia" });
    // Constructed unconditionally (unlike the three DSN collectors, which
    // are null when unconfigured): a LogSnapshotCollector with no units and
    // docker disabled is cheap to hold and `collect()` already returns null
    // in that case, and this way `requestLogSnapshot()` always has
    // something to call rather than needing its own null check at every
    // call site.
    this.logs =
      options.logs ??
      new LogSnapshotCollector(
        this.platform,
        options.logUnits ?? [],
        options.logDockerEnabled ?? false,
        options.logLines ?? LOG_SNAPSHOT_DEFAULT_LINES,
        warn,
      );
  }

  /** One sample, or null if nothing truthful could be measured this round
   *  (warm-up, no collector for this OS, an unreadable or unparseable core
   *  reading). Never throws: a collector failure is a log line, not a dead
   *  tick. */
  async collect(): Promise<MetricSample | null> {
    if (!this.available()) return null;
    let sample: MetricSample | null;
    try {
      sample = await this.collector!.collect(this.serviceWatch);
    } catch (err) {
      this.warnOnce(
        "collect-failed",
        `server-health collection failed: ${err instanceof Error ? err.message : String(err)}`,
      );
      return null;
    }
    if (sample && this.postgres) {
      try {
        const pg = await this.postgres.collect();
        if (pg) sample.postgres = pg;
      } catch (err) {
        // A DSN that is configured but unreachable this tick (wrong
        // password, database restarting, network blip) costs this tick's
        // Postgres reading only -- the core OS sample above is unaffected
        // and already returned/attached. Retried next tick, same as the
        // Docker socket enrichment.
        this.warnOnce(
          "postgres-collect-failed",
          `PostgreSQL metrics collection failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
    if (sample && this.redis) {
      try {
        const redis = await this.redis.collect();
        if (redis) sample.redis = redis;
      } catch (err) {
        this.warnOnce(
          "redis-collect-failed",
          `Redis metrics collection failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
    if (sample && this.mysql) {
      try {
        const mysql = await this.mysql.collect();
        if (mysql) sample.mysql = mysql;
      } catch (err) {
        this.warnOnce(
          "mysql-collect-failed",
          `MySQL metrics collection failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
    if (sample) {
      try {
        const gpu = await this.gpu.collect();
        if (gpu) sample.gpu = gpu;
      } catch (err) {
        // NvidiaSmiCollector.collect() does not itself throw (a failed
        // nvidia-smi run or unsupported vendor is its own `{ error }`
        // reading, not an exception); this is only the backstop for a
        // surprising failure in an injected test double.
        this.warnOnce(
          "gpu-collect-failed",
          `GPU metrics collection failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
    // Log snapshots (REA-440, log snapshots phase 1): a no-op on every
    // ordinary tick (`this.logs.collect()` returns null immediately unless
    // `requestLogSnapshot()` was called since the last collection), so this
    // costs nothing on the common path. Never lets a capture failure drop
    // the core sample: same try/catch shape as postgres/redis/mysql above.
    if (sample && this.logs) {
      try {
        const logs = await this.logs.collect(sample.containers);
        if (logs) sample.logs = logs;
      } catch (err) {
        this.warnOnce(
          "log-snapshot-collect-failed",
          `log snapshot collection failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
    return sample;
  }

  setServiceWatch(names: readonly unknown[]): void {
    this.serviceWatch = normalizeWatchList(names);
  }

  /** The one-shot flag from the last successful poll
   *  (`PollResponse.requestLogSnapshot`): capture a log snapshot on the
   *  NEXT `collect()` call. See collect-logs.ts. */
  requestLogSnapshot(): void {
    this.logs?.requestSnapshot();
  }

  /** This machine's vantage, detected once by the collector and cached: the
   *  evidence does not change while the process is running. */
  vantage(): { vantage: MetricsVantage; detail: string | null } {
    if (!this.collector) return { vantage: "host", detail: null };
    return this.collector.vantage();
  }

  /** Host identity for the batch header, resolved once. */
  async hostInfo(): Promise<HostInfo | null> {
    if (this.hostInfoCache) return this.hostInfoCache;
    if (!this.collector) return null;
    try {
      const base = await this.collector.hostInfo();
      const network = this.hostNetwork();
      this.hostInfoCache = {
        hostname: base.hostname,
        os: base.os,
        osVersion: base.osVersion,
        arch: base.arch,
        cluster: this.cluster,
        node: this.node ?? base.hostname,
        networkMode: network.mode,
        networkGateway: network.gateway,
      };
      return this.hostInfoCache;
    } catch {
      return null;
    }
  }

  /**
   * REA-780: whether this process shares the machine's network. Detected once
   * (the evidence cannot change while the process runs) and logged once, at
   * warn, when it is the trap: an operator reading `docker logs
   * realuptime-agent` gets the answer without opening the dashboard, and the
   * dashboard gets it on the next metrics batch. Never fatal and never a
   * guess; see host-network.ts.
   */
  private hostNetwork(): HostNetworkResult {
    if (this.hostNetworkCache) return this.hostNetworkCache;
    let result: HostNetworkResult;
    try {
      result = detectHostNetwork(readHostNetworkEvidence(this.platform));
    } catch {
      result = { mode: null, evidence: "unknown", gateway: null };
    }
    this.hostNetworkCache = result;
    if (result.mode === "isolated") {
      log("warn", "this agent's container has its own network, so localhost is the container", {
        evidence: result.evidence,
        gateway: result.gateway ?? undefined,
        hint: isolatedNetworkHint(result.gateway),
      });
    }
    return result;
  }

  private available(): boolean {
    if (this.availableCache !== null) return this.availableCache;
    let available = false;
    if (!this.collector) {
      log("warn", "server-health metrics unavailable: no collector for this operating system", {
        platform: this.platform.os,
        hint: "checks run normally; metrics are collected on Linux, macOS and Windows",
      });
    } else {
      available = this.collector.available();
      if (!available) {
        log("warn", "server-health metrics unavailable: /proc not found", {
          hint: "expected inside a minimal sandbox; check results are unaffected",
        });
      }
    }
    this.availableCache = available;
    return available;
  }

  private warnOnce(key: string, message: string): void {
    if (this.warned.has(key)) return;
    this.warned.add(key);
    log("warn", message, {});
  }
}
