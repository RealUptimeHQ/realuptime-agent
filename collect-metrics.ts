import { DarwinCollector } from "./collect-darwin.ts";
import { LinuxCollector } from "./collect-linux.ts";
import { normalizeWatchList } from "./collect-services.ts";
import { WindowsCollector } from "./collect-windows.ts";
import { log } from "./log.ts";
import { RealHostPlatform, type HostPlatform } from "./platform.ts";
import type { VantageResult } from "./vantage.ts";
import type { HostInfo, MetricSample, MetricsVantage } from "./types.ts";

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
  hostInfo(): Promise<Pick<HostInfo, "os" | "osVersion" | "arch" | "hostname">> | Pick<HostInfo, "os" | "osVersion" | "arch" | "hostname">;
}

export interface MetricsCollectorOptions {
  platform?: HostPlatform;
  collector?: PlatformCollector;
  /** The two labels the dashboard's cluster view groups by; from
   *  REALUPTIME_CLUSTER / REALUPTIME_NODE. */
  cluster?: string | null;
  node?: string | null;
}

export class MetricsCollector {
  private readonly platform: HostPlatform;
  private readonly collector: PlatformCollector | null;
  private readonly cluster: string | null;
  private readonly node: string | null;
  private availableCache: boolean | null = null;
  private serviceWatch: string[] = [];
  private hostInfoCache: HostInfo | null = null;
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
  }

  /** One sample, or null if nothing truthful could be measured this round
   *  (warm-up, no collector for this OS, an unreadable or unparseable core
   *  reading). Never throws: a collector failure is a log line, not a dead
   *  tick. */
  async collect(): Promise<MetricSample | null> {
    if (!this.available()) return null;
    try {
      return await this.collector!.collect(this.serviceWatch);
    } catch (err) {
      this.warnOnce("collect-failed", `server-health collection failed: ${err instanceof Error ? err.message : String(err)}`);
      return null;
    }
  }

  setServiceWatch(names: readonly unknown[]): void {
    this.serviceWatch = normalizeWatchList(names);
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
      this.hostInfoCache = {
        hostname: base.hostname,
        os: base.os,
        osVersion: base.osVersion,
        arch: base.arch,
        cluster: this.cluster,
        node: this.node ?? base.hostname,
      };
      return this.hostInfoCache;
    } catch {
      return null;
    }
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
