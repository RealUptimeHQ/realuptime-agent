import { safePathSegment } from "./platform.ts";
import type { ServiceSample, ServiceStatus } from "./types.ts";

/**
 * Service / unit status for an opt-in watch list (REA-181).
 *
 * The list comes from the server (`PollResponse.services`), set per host in
 * the dashboard. It is the one server-pushed value that changes what this
 * program looks at locally, and it is constrained so that it can only ever
 * name a unit:
 *
 *   - Names are validated by `normalizeServiceName` (a conservative
 *     character class, no path separators, bounded length). An invalid name
 *     is dropped, never "fixed".
 *   - On Linux nothing is executed. systemd marks an ACTIVE unit with a
 *     symlink `/run/systemd/units/invocation:<unit>` (systemd >= 232), and
 *     a FAILED one by `/sys/fs/cgroup/.../<unit>` absence plus the
 *     invocation link absence; this reads those two facts. A unit systemd
 *     does not know about and one that is stopped both read as inactive,
 *     which is what an operator means by "is nginx running".
 *   - On macOS and Windows the listing command is run with NO arguments
 *     derived from the list (`launchctl list`, `Get-Service` for ALL
 *     services) and the watch list is applied in this process afterwards,
 *     so an operator-typed name never reaches a command line.
 *
 * A name with no reading on this platform reports `unknown` rather than
 * being omitted: the operator asked, and silence would read as "fine".
 */

export const MAX_WATCHED_SERVICES = 64;
export const MAX_SERVICE_NAME_LENGTH = 128;

/** Accepts `nginx`, `nginx.service`, `postgresql@14.service`,
 * `com.apple.sshd`, `W32Time`, `Spooler`; refuses anything with a slash,
 * a space-run, or a dot-dot. */
export function normalizeServiceName(raw: string): string | null {
  const name = raw.trim();
  if (!name || name.length > MAX_SERVICE_NAME_LENGTH) return null;
  if (!/^[A-Za-z0-9][A-Za-z0-9_.@:\- ]*$/.test(name)) return null;
  if (name.includes("..") || name.includes("/") || name.includes("\\")) return null;
  return name;
}

export function normalizeWatchList(raw: readonly unknown[]): string[] {
  const seen = new Set<string>();
  for (const entry of raw) {
    if (typeof entry !== "string") continue;
    const name = normalizeServiceName(entry);
    if (name && !seen.has(name)) seen.add(name);
    if (seen.size >= MAX_WATCHED_SERVICES) break;
  }
  return [...seen];
}

/** A systemd unit name as the operator wrote it, with `.service` appended
 * when no unit type suffix is present, so `nginx` and `nginx.service` are
 * the same unit. */
export function systemdUnitName(name: string): string {
  return /\.(service|socket|timer|mount|target|path|slice|scope)$/.test(name) ? name : `${name}.service`;
}

/**
 * Linux, files only. `runRoot` is `/run` (or `/host/run` on a DaemonSet
 * mount); `exists` is the injected existence check.
 */
export function linuxServiceStatus(
  names: readonly string[],
  runRoot: string,
  exists: (path: string) => boolean,
): ServiceSample[] {
  const out: ServiceSample[] = [];
  const unitsDir = `${runRoot}/systemd/units`;
  const systemdPresent = exists(unitsDir);
  for (const name of names) {
    const unit = systemdUnitName(name);
    if (!systemdPresent || !safePathSegment(unit)) {
      out.push({ name, status: "unknown" });
      continue;
    }
    const active = exists(`${unitsDir}/invocation:${unit}`);
    out.push({ name, status: active ? "active" : "inactive" });
  }
  return out;
}

/**
 * `launchctl list` on macOS: `PID\tStatus\tLabel`. A numeric PID means the
 * job is running; `-` means loaded but not running; a non-zero Status with
 * no PID is the last exit status, i.e. it failed. Labels not in the table
 * are not loaded at all: inactive.
 */
export function parseLaunchctlList(text: string): Map<string, ServiceStatus> {
  const out = new Map<string, ServiceStatus>();
  for (const line of text.split("\n")) {
    const fields = line.trim().split(/\s+/);
    if (fields.length < 3 || fields[0] === "PID") continue;
    const [pid, status, label] = fields as [string, string, string];
    if (/^\d+$/.test(pid)) out.set(label, "active");
    else if (status !== "0" && status !== "-") out.set(label, "failed");
    else out.set(label, "inactive");
  }
  return out;
}

/** The `services` array of the Windows PowerShell document: Name, Status
 * (`Running`, `Stopped`, `StartPending`, `StopPending`, `Paused`, ...). */
export function parseWindowsServices(rows: unknown): Map<string, ServiceStatus> {
  const out = new Map<string, ServiceStatus>();
  if (!Array.isArray(rows)) return out;
  for (const row of rows) {
    if (!row || typeof row !== "object") continue;
    const r = row as Record<string, unknown>;
    if (typeof r.Name !== "string") continue;
    const status = String(r.Status ?? "").toLowerCase();
    out.set(
      r.Name,
      status === "running" || status === "4" ? "active" : status === "stopped" || status === "1" ? "inactive" : "unknown",
    );
  }
  return out;
}

/** Applies the watch list to a platform's full listing. Case-insensitive on
 * Windows (service names are), exact elsewhere. */
export function statusesFor(
  names: readonly string[],
  listing: ReadonlyMap<string, ServiceStatus>,
  caseInsensitive = false,
): ServiceSample[] {
  const lookup = caseInsensitive ? new Map([...listing].map(([k, v]) => [k.toLowerCase(), v])) : listing;
  return names.map((name) => ({
    name,
    status: lookup.get(caseInsensitive ? name.toLowerCase() : name) ?? "inactive",
  }));
}
