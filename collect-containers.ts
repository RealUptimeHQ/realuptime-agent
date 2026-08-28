import type { ContainerSample } from "./types.ts";

/**
 * Container metrics from cgroup v2 (REA-181), on a Linux host only.
 *
 * No Docker socket, no containerd API, no daemon conversation: every
 * runtime that matters places each container in its own cgroup under
 * `/sys/fs/cgroup`, and the cgroup itself carries `cpu.stat`
 * (`usage_usec`), `memory.current` and `memory.max`. Reading those files is
 * both the cheapest and the least privileged way to answer "what are the
 * containers on this machine doing", and it needs nothing the kernel does
 * not already expose to any process that can see the cgroup tree.
 *
 * The walk is bounded: at most `MAX_CGROUP_DIRS_VISITED` directories and
 * `MAX_CGROUP_DEPTH` levels, and only directories whose NAME matches a
 * known runtime scope pattern are read as containers. The id is the
 * runtime's own; a Docker name is not available from the cgroup path
 * (`docker-<id>.scope`) and is reported null rather than invented. A
 * Kubernetes pod's containers are reported individually under
 * `runtime: "kubernetes"` with the container id; the pod uid stays out of
 * the sample (it is not a name and carries no operator meaning).
 *
 * Absent entirely on cgroup v1 hosts (different layout, declining share,
 * not worth a second parser), on macOS and on Windows.
 */

export const MAX_CONTAINERS_PER_SAMPLE = 64;
export const MAX_CGROUP_DIRS_VISITED = 2000;
export const MAX_CGROUP_DEPTH = 6;

export interface CgroupContainer {
  /** Path relative to the cgroup root, e.g. "system.slice/docker-abc.scope". */
  path: string;
  id: string;
  name: string | null;
  runtime: ContainerSample["runtime"];
}

const SCOPE_PATTERNS: Array<[RegExp, ContainerSample["runtime"]]> = [
  [/^docker-([0-9a-f]{12,64})\.scope$/, "docker"],
  [/^cri-containerd-([0-9a-f]{12,64})\.scope$/, "containerd"],
  [/^crio-([0-9a-f]{12,64})\.scope$/, "cri-o"],
  [/^libpod-([0-9a-f]{12,64})\.scope$/, "podman"],
  [/^lxc\.payload\.(.+)$/, "lxc"],
];

/** Classifies one cgroup directory name. `inKubepods` promotes a containerd
 * / cri-o scope under the kubepods tree to `runtime: "kubernetes"`. Plain
 * `docker/<id>` (the cgroupfs driver) is recognised by parent name. */
export function classifyCgroupDir(parent: string, dirName: string): CgroupContainer | null {
  const inKubepods = /(^|\/)kubepods/.test(parent);
  for (const [pattern, runtime] of SCOPE_PATTERNS) {
    const m = dirName.match(pattern);
    if (m) {
      const id = m[1]!;
      const path = parent ? `${parent}/${dirName}` : dirName;
      if (runtime === "lxc") return { path, id, name: id, runtime };
      return { path, id, name: null, runtime: inKubepods ? "kubernetes" : runtime };
    }
  }
  if (/(^|\/)docker$/.test(parent) && /^[0-9a-f]{12,64}$/.test(dirName)) {
    return { path: `${parent}/${dirName}`, id: dirName, name: null, runtime: "docker" };
  }
  return null;
}

/** `cpu.stat`'s `usage_usec` line. */
export function parseCpuStatUsageUsec(text: string): number | null {
  const m = text.match(/^usage_usec\s+(\d+)/m);
  if (!m) return null;
  const n = Number(m[1]);
  return Number.isFinite(n) ? n : null;
}

/** `memory.max`: a byte count or the literal `max`. */
export function parseMemoryMax(text: string): number | null {
  const t = text.trim();
  if (t === "max" || t === "") return null;
  const n = Number(t);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

export function parseMemoryCurrent(text: string): number | null {
  const n = Number(text.trim());
  return Number.isFinite(n) && n >= 0 ? n : null;
}

export interface CgroupReading {
  container: CgroupContainer;
  usageUsec: number | null;
  memoryCurrent: number;
  memoryMax: number | null;
}

/**
 * Readings to samples. CPU is the delta of `usage_usec` over `elapsedMs`
 * divided by the machine's capacity over the same wall time (`cpuCores` x
 * elapsed), i.e. the same "fraction of total capacity" unit as
 * `cpuUsedRatio`; the warm-up sample (no previous reading for that id) and
 * a counter that went backwards (container restarted under the same id)
 * report null. Sorted by memory descending so a full cap keeps the
 * heaviest containers and the order is stable.
 */
export function containerSamples(
  readings: readonly CgroupReading[],
  previousUsage: ReadonlyMap<string, number>,
  elapsedMs: number,
  cpuCores: number,
): ContainerSample[] {
  const capacityUsec = Math.max(1, cpuCores) * elapsedMs * 1000;
  const out: ContainerSample[] = [];
  for (const r of readings) {
    let cpuRatio: number | null = null;
    const prev = previousUsage.get(r.container.path);
    if (r.usageUsec !== null && prev !== undefined && elapsedMs > 0) {
      const delta = r.usageUsec - prev;
      if (delta >= 0) cpuRatio = Math.min(1, delta / capacityUsec);
    }
    out.push({
      id: r.container.id,
      name: r.container.name,
      runtime: r.container.runtime,
      cpuRatio,
      memoryUsedBytes: r.memoryCurrent,
      memoryLimitBytes: r.memoryMax,
    });
  }
  out.sort((a, b) => b.memoryUsedBytes - a.memoryUsedBytes || a.id.localeCompare(b.id));
  return out.slice(0, MAX_CONTAINERS_PER_SAMPLE);
}

/**
 * Walks the cgroup tree through injected `readdir`/`readFile`, bounded by
 * depth and visit count. Pure given its two callbacks, so the fixture test
 * drives it with an in-memory tree.
 */
export function walkCgroupTree(
  root: string,
  readdir: (path: string) => string[],
  readFile: (path: string) => string,
): CgroupReading[] {
  const readings: CgroupReading[] = [];
  const queue: Array<{ rel: string; depth: number }> = [{ rel: "", depth: 0 }];
  let visited = 0;
  while (queue.length && visited < MAX_CGROUP_DIRS_VISITED && readings.length < MAX_CONTAINERS_PER_SAMPLE * 2) {
    const { rel, depth } = queue.shift()!;
    visited += 1;
    const abs = rel ? `${root}/${rel}` : root;
    let entries: string[];
    try {
      entries = readdir(abs);
    } catch {
      continue;
    }
    for (const entry of entries) {
      // cgroup v2 control files contain a dot but so do scope dirs; only
      // directories are walked, and a directory is anything readdir on it
      // succeeds for. Cheap filter first: control files never match a scope
      // pattern and are skipped before any I/O.
      if (/^(cgroup\.|cpu\.|memory\.|io\.|pids\.|hugetlb\.|misc\.|rdma\.|cpuset\.|dmem\.)/.test(entry)) continue;
      const container = classifyCgroupDir(rel, entry);
      if (container) {
        const dir = `${root}/${container.path}`;
        const memoryCurrent = tryRead(readFile, `${dir}/memory.current`, parseMemoryCurrent);
        if (memoryCurrent === null) continue;
        readings.push({
          container,
          usageUsec: tryRead(readFile, `${dir}/cpu.stat`, parseCpuStatUsageUsec),
          memoryCurrent,
          memoryMax: tryRead(readFile, `${dir}/memory.max`, parseMemoryMax),
        });
        continue;
      }
      if (depth + 1 <= MAX_CGROUP_DEPTH) queue.push({ rel: rel ? `${rel}/${entry}` : entry, depth: depth + 1 });
    }
  }
  return readings;
}

function tryRead<T>(readFile: (p: string) => string, path: string, parse: (t: string) => T | null): T | null {
  try {
    return parse(readFile(path));
  } catch {
    return null;
  }
}
