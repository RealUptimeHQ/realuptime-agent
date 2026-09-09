import { containerSamples, enrichContainerSamples, walkCgroupTree, type CgroupReading } from "./collect-containers.ts";
import { cpuUsedRatioFromDelta, readCpuTotals, type CpuTotals } from "./collect-cpu.ts";
import { DockerEngineClient, enrichDockerContainers, MAX_DOCKER_LOOKUPS_PER_TICK } from "./collect-docker.ts";
import { diskSamplesFromMounts } from "./collect-disk.ts";
import { parseLoadAvg } from "./collect-load.ts";
import { parseMemInfo } from "./collect-memory.ts";
import { parseProcNetDev, ratesFromCounters, type InterfaceCounters } from "./collect-network.ts";
import { parseProcPidStat, topProcesses, type ProcessReading } from "./collect-processes.ts";
import { linuxServiceStatus } from "./collect-services.ts";
import type { HostPlatform } from "./platform.ts";
import { safePathSegment } from "./platform.ts";
import { detectVantage, type VantageResult } from "./vantage.ts";
import type { HostInfo, MetricSample } from "./types.ts";

/**
 * The Linux collector: files only, no commands (REA-181 refactor of the
 * phase 2 `/proc` collector into the per-OS seam).
 *
 * ## Roots, and the DaemonSet host mount
 *
 * Every path is built from three roots. On an ordinary host they are
 * `/proc`, `/sys` and `/run` with filesystems statfs'd at their own mount
 * points. When the agent runs as a Kubernetes DaemonSet with the node's
 * root filesystem mounted read-only at `/host` (the manifest in
 * apps/agent/deploy/kubernetes), `/host/proc/stat` exists and every root
 * moves under `/host`: the readings are then the NODE's, and the vantage
 * is reported as `host` with detail `host-mount`, because that is what is
 * being measured. Nothing about this is configured; it is detected from
 * the presence of the mount, the same way vantage itself is.
 *
 * ## The warm-up sample
 *
 * CPU, network rates, per-process CPU and per-container CPU are all deltas
 * between two readings. The first `collect()` records baselines and returns
 * null; the first real sample lands one interval later. Same rule as the
 * phase 2 collector, now for four families instead of one.
 */

export const HOST_MOUNT_ROOT = "/host";
/** Linux reports rss in pages; 4 KiB everywhere this agent is supported
 * (x86_64, aarch64 default). A 16 KiB-page arm64 kernel would under-report
 * RSS by 4x, which is visible and wrong rather than silently right, and is
 * recorded here as a known approximation. */
const PAGE_SIZE_BYTES = 4096;

export class LinuxCollector {
  readonly os = "linux" as const;
  private readonly platform: HostPlatform;
  private cpuBaseline: CpuTotals | null = null;
  private netBaseline: { counters: InterfaceCounters[]; at: number } | null = null;
  private processCpuBaseline = new Map<number, number>();
  private containerUsageBaseline = new Map<string, number>();
  private lastSampleAt: number | null = null;
  private vantageCache: VantageResult | null = null;
  private rootsCache: { proc: string; sys: string; run: string; fs: string } | null = null;
  private readonly injectedDocker: DockerEngineClient | undefined;
  private dockerCache: DockerEngineClient | null = null;

  constructor(
    platform: HostPlatform,
    private readonly warn: (key: string, message: string) => void,
    docker?: DockerEngineClient,
  ) {
    this.platform = platform;
    this.injectedDocker = docker;
  }

  /** The socket the daemon listens on. Under the Kubernetes DaemonSet host
   * mount it lives under the same host-root prefix as every other path in
   * this collector; on an ordinary host it is the well-known path. */
  private docker(): DockerEngineClient {
    if (this.injectedDocker) return this.injectedDocker;
    if (this.dockerCache) return this.dockerCache;
    const socketPath = `${this.roots().fs}/var/run/docker.sock`;
    this.dockerCache = new DockerEngineClient({ socketPath, existsSync: (p) => this.platform.existsSync(p) });
    return this.dockerCache;
  }

  roots(): { proc: string; sys: string; run: string; fs: string } {
    if (this.rootsCache) return this.rootsCache;
    const hostMounted = this.platform.existsSync(`${HOST_MOUNT_ROOT}/proc/stat`);
    this.rootsCache = hostMounted
      ? { proc: `${HOST_MOUNT_ROOT}/proc`, sys: `${HOST_MOUNT_ROOT}/sys`, run: `${HOST_MOUNT_ROOT}/run`, fs: HOST_MOUNT_ROOT }
      : { proc: "/proc", sys: "/sys", run: "/run", fs: "" };
    return this.rootsCache;
  }

  available(): boolean {
    return this.platform.existsSync(`${this.roots().proc}/stat`);
  }

  async collect(serviceWatch: readonly string[]): Promise<MetricSample | null> {
    const roots = this.roots();
    const now = this.platform.now();
    const sampledAt = now.toISOString();
    const statText = this.tryRead(`${roots.proc}/stat`);
    const memText = this.tryRead(`${roots.proc}/meminfo`);
    if (statText === null || memText === null) {
      this.warn("proc-unreadable", "could not read /proc/stat or /proc/meminfo; skipping this sample");
      return null;
    }
    const cpuReading = readCpuTotals(statText);
    if (!cpuReading) {
      this.warn("stat-unparseable", "could not parse /proc/stat; skipping this sample");
      return null;
    }

    // Baselines for every delta family are (re)recorded on every call, so a
    // skipped sample never leaves a stale baseline behind.
    const previousCpu = this.cpuBaseline;
    this.cpuBaseline = cpuReading.totals;
    const netNow = this.readNetCounters(roots.proc);
    const previousNet = this.netBaseline;
    this.netBaseline = netNow ? { counters: netNow, at: now.getTime() } : null;
    const processReadings = this.readProcesses(roots.proc);
    const previousProcessCpu = this.processCpuBaseline;
    this.processCpuBaseline = new Map(
      processReadings.filter((p) => p.cpuTime !== null).map((p) => [p.pid, p.cpuTime as number]),
    );
    const cgroupReadings = this.readContainers(roots.sys);
    const previousContainerUsage = this.containerUsageBaseline;
    this.containerUsageBaseline = new Map(
      cgroupReadings.filter((r) => r.usageUsec !== null).map((r) => [r.container.path, r.usageUsec as number]),
    );
    const previousSampleAt = this.lastSampleAt;
    this.lastSampleAt = now.getTime();

    if (!previousCpu) return null; // warm-up
    const cpuUsedRatio = cpuUsedRatioFromDelta(previousCpu, cpuReading.totals);
    if (cpuUsedRatio === null) return null; // wrapped or glitched counters

    const mem = parseMemInfo(memText);
    if (!mem) {
      this.warn("meminfo-unparseable", "could not parse /proc/meminfo; skipping this sample");
      return null;
    }

    const loadText = this.tryRead(`${roots.proc}/loadavg`);
    const load = loadText ? parseLoadAvg(loadText) : null;

    const mountsText = this.tryRead(`${roots.proc}/mounts`);
    const filesystems = mountsText
      ? diskSamplesFromMounts(
          mountsText,
          (mountPoint) => this.platform.statfsSync(roots.fs ? `${roots.fs}${mountPoint}` : mountPoint),
          (message) => this.warn(`disk:${message}`, message),
        )
      : [];

    const elapsedMs = previousSampleAt === null ? 0 : now.getTime() - previousSampleAt;
    const totalCpuDelta = cpuReading.totals.total - previousCpu.total;

    const sample: MetricSample = {
      sampledAt,
      cpuUsedRatio,
      cpuCores: cpuReading.cores,
      memoryTotalBytes: mem.totalBytes,
      memoryUsedBytes: mem.usedBytes,
      load1: load?.load1 ?? null,
      load5: load?.load5 ?? null,
      load15: load?.load15 ?? null,
      filesystems,
    };
    if (netNow && previousNet) sample.network = ratesFromCounters(previousNet.counters, netNow, now.getTime() - previousNet.at);
    if (processReadings.length) sample.processes = topProcesses(processReadings, previousProcessCpu, totalCpuDelta);
    if (cgroupReadings.length) {
      const containers = containerSamples(cgroupReadings, previousContainerUsage, elapsedMs, cpuReading.cores);
      sample.containers = await this.enrichWithDocker(containers);
    }
    if (serviceWatch.length) {
      sample.services = linuxServiceStatus(serviceWatch, roots.run, (p) => this.platform.existsSync(p));
    }
    return sample;
  }

  vantage(): VantageResult {
    if (this.vantageCache) return this.vantageCache;
    const roots = this.roots();
    if (roots.fs === HOST_MOUNT_ROOT) {
      // The readings come from the node's own /proc and /sys, so they
      // describe the host even though this process sits in a pod.
      this.vantageCache = { vantage: "host", detail: "host-mount" };
      return this.vantageCache;
    }
    this.vantageCache = detectVantage({
      dockerenvExists: this.platform.existsSync("/.dockerenv"),
      containerenvExists: this.platform.existsSync("/run/.containerenv"),
      cgroupText: this.tryRead("/proc/1/cgroup"),
      environText: this.tryRead("/proc/1/environ"),
    });
    return this.vantageCache;
  }

  hostInfo(): Pick<HostInfo, "os" | "osVersion" | "arch" | "hostname"> {
    const roots = this.roots();
    const osRelease = this.tryRead(`${roots.fs}/etc/os-release`) ?? this.tryRead("/etc/os-release");
    const pretty = osRelease?.match(/^PRETTY_NAME="?([^"\n]*)"?/m)?.[1] ?? null;
    return {
      os: "linux",
      osVersion: pretty ? `${pretty} (${this.platform.release()})` : this.platform.release(),
      arch: this.platform.arch(),
      hostname: this.platform.hostname(),
    };
  }

  private readNetCounters(procRoot: string): InterfaceCounters[] | null {
    const text = this.tryRead(`${procRoot}/net/dev`);
    return text === null ? null : parseProcNetDev(text);
  }

  private readProcesses(procRoot: string): ProcessReading[] {
    let entries: string[];
    try {
      entries = this.platform.readdirSync(procRoot);
    } catch {
      return [];
    }
    const out: ProcessReading[] = [];
    for (const entry of entries) {
      if (!/^\d+$/.test(entry) || !safePathSegment(entry)) continue;
      const stat = this.tryRead(`${procRoot}/${entry}/stat`);
      if (stat === null) continue; // exited between readdir and read
      const reading = parseProcPidStat(stat, PAGE_SIZE_BYTES);
      if (reading) out.push(reading);
    }
    return out;
  }

  private readContainers(sysRoot: string): CgroupReading[] {
    const root = `${sysRoot}/fs/cgroup`;
    // cgroup v2 only: the unified hierarchy has `cgroup.controllers` at its
    // root; v1 has per-controller mount points and no such file.
    if (!this.platform.existsSync(`${root}/cgroup.controllers`)) return [];
    return walkCgroupTree(
      root,
      (p) => this.platform.readdirSync(p),
      (p) => this.platform.readFileSync(p),
    );
  }

  /** Docker Engine API enrichment (REA-440), best-effort: a socket that
   * is not there, not answering, or answers something unparseable simply
   * leaves the cgroup-only reading in place. Never thrown from here. */
  private async enrichWithDocker(containers: ReturnType<typeof containerSamples>): Promise<ReturnType<typeof containerSamples>> {
    const client = this.docker();
    if (!client.available()) return containers;
    try {
      const inspections = await enrichDockerContainers(containers, client, MAX_DOCKER_LOOKUPS_PER_TICK);
      return enrichContainerSamples(containers, inspections);
    } catch (err) {
      this.warn("docker-enrich-failed", `container enrichment via the Docker socket failed: ${err instanceof Error ? err.message : String(err)}`);
      return containers;
    }
  }

  private tryRead(path: string): string | null {
    try {
      return this.platform.readFileSync(path);
    } catch {
      return null;
    }
  }
}
