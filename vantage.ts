import type { MetricsVantage } from "./types.ts";

/**
 * Whether this process is measuring a host or a container (the wire
 * contract's required, server-pinned `vantage` field).
 *
 * ## Why this matters more than any other field
 *
 * A collector inside a container reads the CONTAINER's cgroup limits and
 * overlay filesystem, never the host's. Those numbers are real and
 * completely wrong as a description of the host machine. The server refuses
 * (409) a later batch that disagrees with the vantage this agent first
 * reported, so getting this WRONG on the first report is a mistake that
 * either gets caught immediately (if a genuine host later reports
 * "container") or silently mislabels every reading forever (if a
 * containerized collector guesses "host" because it looks tidier). This
 * module exists so nothing here is a guess: every branch below is evidence a
 * container runtime leaves behind, not an inference.
 *
 * A container CAN legitimately monitor itself and get a "container" vantage;
 * what it must never do is claim "host".
 *
 * ## The evidence, in the order it is checked
 *
 * 1. `/.dockerenv` -- a file Docker creates inside every container it
 *    starts, and the cheapest, most direct signal available.
 * 2. `/run/.containerenv` -- Podman's equivalent.
 * 3. `/proc/1/cgroup` -- the init process's own cgroup path. Docker,
 *    Kubernetes (kubepods), containerd, LXC, and ECS all write the container
 *    or pod ID into this path, so a substring match against a small set of
 *    known runtime names is reliable even without file 1 or 2 being present
 *    (a rootless or unusual container runtime, for instance).
 * 4. `/proc/1/environ` -- systemd-nspawn sets a `container=` environment
 *    variable on PID 1 rather than leaving cgroup or filesystem evidence,
 *    so this is the fallback for that one runtime.
 *
 * None present means host. No config override exists for this, on purpose:
 * see the Monitor design notes -- truthfulness is not configurable.
 */

export interface VantageEvidence {
  dockerenvExists: boolean;
  containerenvExists: boolean;
  /** Contents of `/proc/1/cgroup`, or null if it could not be read. */
  cgroupText: string | null;
  /** Contents of `/proc/1/environ`, or null if it could not be read. */
  environText: string | null;
}

export interface VantageResult {
  vantage: MetricsVantage;
  detail: string | null;
}

const CGROUP_RUNTIME_LABELS: Array<[RegExp, string]> = [
  [/docker/i, "docker"],
  [/kubepods/i, "kubernetes"],
  [/containerd/i, "containerd"],
  [/libpod/i, "podman"],
  [/\blxc\b/i, "lxc"],
  [/\becs\b/i, "ecs"],
];

export function detectVantage(evidence: VantageEvidence): VantageResult {
  if (evidence.dockerenvExists) return { vantage: "container", detail: "docker" };
  if (evidence.containerenvExists) return { vantage: "container", detail: "podman" };

  if (evidence.cgroupText) {
    for (const [pattern, label] of CGROUP_RUNTIME_LABELS) {
      if (pattern.test(evidence.cgroupText)) return { vantage: "container", detail: label };
    }
  }

  // systemd-nspawn writes NUL-separated `KEY=value` entries; `container=`
  // is the one it sets specifically to mark "I am not the real init".
  if (evidence.environText && /(?:^|\0)container=/i.test(evidence.environText)) {
    return { vantage: "container", detail: "systemd-nspawn" };
  }

  return { vantage: "host", detail: null };
}
