import { execFile } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statfsSync } from "node:fs";
import { arch, cpus, freemem, hostname, loadavg, platform, release, totalmem } from "node:os";
import type { HostOs } from "./types.ts";

/**
 * Everything the collectors are allowed to touch on the machine, behind one
 * interface, so every collector is testable against fixtures and so a
 * security reviewer has exactly one file to read to know what this program
 * can observe (REA-181).
 *
 * ## The two kinds of access, and the rule for each
 *
 * 1. **Files.** Read-only. On Linux every reading comes from `/proc`, `/sys`
 *    and a `statfs` per mount point (plus `/etc/os-release` for the OS name).
 *    No directory traversal: each path is assembled from a fixed prefix and
 *    either a fixed name or a value that has passed `safePathSegment`
 *    (a pid, a cgroup directory name, a service unit name).
 *
 * 2. **Commands.** macOS and Windows expose no `/proc`, so on those two
 *    platforms a FIXED, short list of OS-provided, read-only programs is run
 *    with FIXED arguments (`vm_stat`, `df -Pk`, `netstat -ibn`, `ps`,
 *    `launchctl list`, `sw_vers`; `powershell.exe` with one constant script,
 *    `wmic` as a fallback). `exec` below runs a binary directly with an argv
 *    array: there is never a shell, never string interpolation into a
 *    command, and nothing the server sends is ever passed as an argument.
 *    The service watch list is filtered in this process AFTER a command
 *    listing ALL services returns, precisely so no operator-typed name ever
 *    reaches a command line. On Linux no command is run at all.
 *
 * `ALLOWED_COMMANDS` is the closed set; `exec` refuses anything else. A new
 * entry is a design decision made in this file, not an npm install.
 */

export interface CpuTimes {
  user: number;
  nice: number;
  sys: number;
  idle: number;
  irq: number;
}

export interface StatfsResult {
  bsize: number;
  blocks: number;
  bfree: number;
}

export interface HostPlatform {
  os: HostOs;
  existsSync(path: string): boolean;
  readFileSync(path: string): string;
  readdirSync(path: string): string[];
  statfsSync(path: string): StatfsResult;
  /** Runs one allow-listed program with a fixed argv. Resolves to stdout;
   *  rejects on non-zero exit, timeout, or a program not on the list. */
  exec(file: string, args: readonly string[]): Promise<string>;
  /** `os.cpus()` times, for platforms whose CPU accounting is not a file. */
  cpuTimes(): CpuTimes[];
  totalmem(): number;
  freemem(): number;
  loadavg(): number[];
  hostname(): string;
  release(): string;
  arch(): string;
  now(): Date;
}

/** The closed set of programs `exec` will run, by platform. Everything is a
 * stock OS binary; nothing is downloaded or installed by the agent. */
export const ALLOWED_COMMANDS: Readonly<Record<string, readonly string[]>> = {
  darwin: ["vm_stat", "df", "netstat", "ps", "launchctl", "sw_vers"],
  windows: ["powershell.exe", "wmic"],
  linux: [],
  other: [],
};

export const EXEC_TIMEOUT_MS = 10_000;
/** Output larger than this is a program misbehaving, not a reading. */
export const EXEC_MAX_OUTPUT_BYTES = 4 * 1024 * 1024;

/** Accepts the only shapes a per-entity path segment can take here: a pid,
 * a cgroup directory name, a systemd unit name. Refuses separators, dot-dot
 * and anything outside a conservative character class, so a value that
 * arrived from the server (a service name) can never become a traversal. */
export function safePathSegment(segment: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9_.@:\\-]{0,127}$/.test(segment) && !segment.includes("..");
}

export function detectHostOs(nodePlatform: string = platform()): HostOs {
  if (nodePlatform === "linux") return "linux";
  if (nodePlatform === "darwin") return "darwin";
  if (nodePlatform === "win32") return "windows";
  return "other";
}

export class RealHostPlatform implements HostPlatform {
  readonly os: HostOs;

  constructor(os: HostOs = detectHostOs()) {
    this.os = os;
  }

  existsSync(path: string): boolean {
    return existsSync(path);
  }
  readFileSync(path: string): string {
    return readFileSync(path, "utf8");
  }
  readdirSync(path: string): string[] {
    return readdirSync(path);
  }
  statfsSync(path: string): StatfsResult {
    const s = statfsSync(path);
    return { bsize: s.bsize, blocks: s.blocks, bfree: s.bfree };
  }
  exec(file: string, args: readonly string[]): Promise<string> {
    if (!(ALLOWED_COMMANDS[this.os] ?? []).includes(file)) {
      return Promise.reject(new Error(`refusing to run ${file}: not an allow-listed command on ${this.os}`));
    }
    return new Promise((resolve, reject) => {
      execFile(
        file,
        [...args],
        {
          // Never a shell: the argv goes to the program as-is.
          shell: false,
          windowsHide: true,
          timeout: EXEC_TIMEOUT_MS,
          maxBuffer: EXEC_MAX_OUTPUT_BYTES,
          encoding: "utf8",
          // The program sees none of this process's environment except what
          // it needs to find itself and its locale; in particular not the
          // agent token.
          env: minimalEnv(),
        },
        (err, stdout) => {
          if (err) reject(err);
          else resolve(String(stdout));
        },
      );
    });
  }
  cpuTimes(): CpuTimes[] {
    return cpus().map((c) => ({ ...c.times }));
  }
  totalmem(): number {
    return totalmem();
  }
  freemem(): number {
    return freemem();
  }
  loadavg(): number[] {
    return loadavg();
  }
  hostname(): string {
    return hostname();
  }
  release(): string {
    return release();
  }
  arch(): string {
    return arch();
  }
  now(): Date {
    return new Date();
  }
}

function minimalEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const key of ["PATH", "SYSTEMROOT", "SystemRoot", "TEMP", "TMP", "LANG", "LC_ALL"]) {
    if (process.env[key] !== undefined) env[key] = process.env[key];
  }
  // A fixed locale so every parser below sees the formats it was written for.
  env.LC_ALL = "C";
  env.LANG = "C";
  return env;
}
