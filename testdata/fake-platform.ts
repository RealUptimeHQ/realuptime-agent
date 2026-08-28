import type { CpuTimes, HostPlatform, StatfsResult } from "../platform.ts";
import type { HostOs } from "../types.ts";

/**
 * An in-memory `HostPlatform` for the collector tests: files, directories,
 * statfs answers and command outputs are all fixtures, and every call is
 * recorded so a test can assert what was (and was not) touched. Nothing
 * here reaches a real filesystem or runs anything.
 */
export class FakeHostPlatform implements HostPlatform {
  os: HostOs;
  files = new Map<string, string>();
  dirs = new Map<string, string[]>();
  exists = new Set<string>();
  statfsResults = new Map<string, StatfsResult>();
  /** Keyed by `${file} ${args.join(" ")}`. A missing key rejects. */
  commands = new Map<string, string | Error>();
  cpu: CpuTimes[] = [];
  memTotal = 16 * 1024 ** 3;
  memFree = 4 * 1024 ** 3;
  load: number[] = [0.5, 0.4, 0.3];
  host = "fixture-host";
  kernel = "6.8.0";
  cpuArch = "x64";
  clock = 0;

  existsCalls: string[] = [];
  execCalls: string[] = [];
  readCalls: string[] = [];

  constructor(os: HostOs = "linux") {
    this.os = os;
  }

  existsSync(path: string): boolean {
    this.existsCalls.push(path);
    return this.exists.has(path) || this.files.has(path) || this.dirs.has(path);
  }
  readFileSync(path: string): string {
    this.readCalls.push(path);
    const content = this.files.get(path);
    if (content === undefined) throw new Error(`ENOENT: ${path}`);
    return content;
  }
  readdirSync(path: string): string[] {
    const entries = this.dirs.get(path);
    if (entries === undefined) throw new Error(`ENOTDIR: ${path}`);
    return entries;
  }
  statfsSync(path: string): StatfsResult {
    const result = this.statfsResults.get(path);
    if (!result) throw new Error(`no statfs fixture for ${path}`);
    return result;
  }
  async exec(file: string, args: readonly string[]): Promise<string> {
    const key = `${file} ${args.join(" ")}`.trim();
    this.execCalls.push(key);
    const out = this.commands.get(key) ?? this.commands.get(file);
    if (out === undefined) throw new Error(`no command fixture for ${key}`);
    if (out instanceof Error) throw out;
    return out;
  }
  cpuTimes(): CpuTimes[] {
    return this.cpu.map((c) => ({ ...c }));
  }
  totalmem(): number {
    return this.memTotal;
  }
  freemem(): number {
    return this.memFree;
  }
  loadavg(): number[] {
    return this.load;
  }
  hostname(): string {
    return this.host;
  }
  release(): string {
    return this.kernel;
  }
  arch(): string {
    return this.cpuArch;
  }
  now(): Date {
    return new Date(this.clock);
  }

  /** Adds a directory tree from a flat map of `relative/path -> content`;
   *  directories are inferred. */
  addTree(root: string, entries: Record<string, string>): void {
    const dirSet = new Map<string, Set<string>>();
    const ensureDir = (dir: string) => {
      if (!dirSet.has(dir)) dirSet.set(dir, new Set());
    };
    ensureDir(root);
    for (const [rel, content] of Object.entries(entries)) {
      const parts = rel.split("/");
      let current = root;
      for (let i = 0; i < parts.length; i++) {
        const part = parts[i]!;
        ensureDir(current);
        dirSet.get(current)!.add(part);
        current = `${current}/${part}`;
        if (i === parts.length - 1) this.files.set(current, content);
        else ensureDir(current);
      }
    }
    for (const [dir, names] of dirSet) this.dirs.set(dir, [...names].sort());
  }
}

export function statLine(user: number, idle: number, cores = 2): string {
  const lines = [`cpu  ${user} 0 0 ${idle} 0 0 0 0`];
  for (let i = 0; i < cores; i++) {
    lines.push(`cpu${i} ${Math.round(user / cores)} 0 0 ${Math.round(idle / cores)} 0 0 0 0`);
  }
  return lines.join("\n");
}

export const MEMINFO = `MemTotal:       16384000 kB
MemFree:          512000 kB
MemAvailable:    9000000 kB
Buffers:          200000 kB
Cached:          6000000 kB
`;

/** A Linux platform with the four core /proc files and one disk. */
export function linuxBaseline(): FakeHostPlatform {
  const p = new FakeHostPlatform("linux");
  p.exists.add("/proc/stat");
  p.files.set("/proc/stat", statLine(1000, 8000));
  p.files.set("/proc/meminfo", MEMINFO);
  p.files.set("/proc/loadavg", "1.0 0.5 0.25 1/10 100\n");
  p.files.set("/proc/mounts", "/dev/sda1 / ext4 rw 0 0\n");
  p.statfsResults.set("/", { bsize: 4096, blocks: 1000, bfree: 500 });
  return p;
}
