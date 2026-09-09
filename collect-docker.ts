import * as http from "node:http";
import type { ContainerHealth, ContainerState } from "./types.ts";

/**
 * Docker Engine API enrichment (REA-440 phase 1), over the local unix
 * socket only.
 *
 * `collect-containers.ts` already answers "what is running and how much
 * CPU/memory is it using" from cgroup v2 alone, with no daemon
 * conversation at all. That stays true for every runtime it recognizes.
 * This module adds the handful of facts cgroups do not carry for the
 * Docker runtime specifically: the container's name, its image, the
 * daemon's own state string, the restart count, and a healthcheck's
 * status when the image defines one. None of that lives in a cgroup file.
 *
 * The Docker Engine API is the right way to ask for it: it is a plain
 * HTTP/1.1 API served over `/var/run/docker.sock` on every Docker install,
 * reachable with nothing more than `node:http`'s `socketPath` option (a
 * core module already used throughout this program), so this stays true
 * to the zero-dependency rule. Shelling out to the `docker` CLI would add
 * a process spawn, a PATH dependency and a text format to parse for
 * exactly the same JSON the daemon already serves on the socket.
 *
 * Absence is silent, not a warning: a host with no Docker daemon, a
 * daemon that only listens on TCP, or a permission-denied socket all read
 * as "nothing to enrich" and the cgroup-only sample stands unchanged.
 * `available` is checked once and cached so a Docker-less host does not
 * retry the socket every 15 seconds.
 */

export const DEFAULT_DOCKER_SOCKET = "/var/run/docker.sock";
/** Caps inspect calls per collection tick, same reasoning as
 * `MAX_CONTAINERS_PER_SAMPLE`: a host with an unusually large number of
 * containers gets a bounded amount of extra daemon traffic per 15-second
 * tick rather than one inspect per container. */
export const MAX_DOCKER_LOOKUPS_PER_TICK = 64;
const REQUEST_TIMEOUT_MS = 2000;
/** Docker API version path. Pinned old on purpose: every field this module
 * reads (`RestartCount`, `State.Health.Status`, `Config.Image`) has been
 * stable since Docker 1.12 (API 1.24, 2016), so pinning old maximizes how
 * many customer daemons answer rather than 404 on a version mismatch. */
const API_VERSION = "v1.24";

export interface DockerInspection {
  name: string | null;
  image: string | null;
  state: ContainerState | null;
  restartCount: number | null;
  health: ContainerHealth | null;
}

const STATE_VALUES: ReadonlySet<string> = new Set([
  "created",
  "running",
  "paused",
  "restarting",
  "removing",
  "exited",
  "dead",
]);

const HEALTH_VALUES: ReadonlySet<string> = new Set(["starting", "healthy", "unhealthy"]);

/** Parses the body of `GET /containers/{id}/json` (the inspect endpoint).
 * Pure and total: any shape that is not what we expect yields nulls for
 * the fields that could not be read rather than throwing, since a daemon
 * upgrade changing an unrelated field must not take container enrichment
 * down with it. */
export function parseDockerInspection(text: string): DockerInspection | null {
  let doc: unknown;
  try {
    doc = JSON.parse(text);
  } catch {
    return null;
  }
  if (!doc || typeof doc !== "object") return null;
  const d = doc as Record<string, unknown>;
  const rawName = typeof d.Name === "string" ? d.Name : null;
  const name = rawName ? rawName.replace(/^\//, "") || null : null;
  const config = d.Config && typeof d.Config === "object" ? (d.Config as Record<string, unknown>) : null;
  const image = config && typeof config.Image === "string" ? config.Image : null;
  const state = d.State && typeof d.State === "object" ? (d.State as Record<string, unknown>) : null;
  const rawStatus = state && typeof state.Status === "string" ? state.Status : null;
  const status = rawStatus && STATE_VALUES.has(rawStatus) ? (rawStatus as ContainerState) : null;
  const restartCountRaw = typeof d.RestartCount === "number" ? d.RestartCount : null;
  const restartCount = restartCountRaw !== null && Number.isFinite(restartCountRaw) && restartCountRaw >= 0 ? restartCountRaw : null;
  const healthObj = state?.Health && typeof state.Health === "object" ? (state.Health as Record<string, unknown>) : null;
  // No Config.Healthcheck / no State.Health block means the image defines
  // no healthcheck at all, reported as "none" rather than left absent: a
  // dashboard needs to tell "healthy" apart from "this container cannot
  // even report health", and null would collapse both into "no data".
  const rawHealth = healthObj && typeof healthObj.Status === "string" ? healthObj.Status : null;
  const health: ContainerHealth | null = rawHealth
    ? HEALTH_VALUES.has(rawHealth)
      ? (rawHealth as ContainerHealth)
      : "none"
    : "none";
  return { name, image, state: status, restartCount, health };
}

/**
 * One GET request to the daemon's unix socket, with a short timeout so a
 * hung daemon cannot stall the metrics tick. Injectable for tests via
 * `request`; the default performs the real HTTP call.
 */
export class DockerEngineClient {
  private readonly socketPath: string;
  private readonly request: (path: string) => Promise<string>;
  private availableCache: boolean | null = null;

  constructor(options: { socketPath?: string; existsSync?: (path: string) => boolean; request?: (path: string) => Promise<string> } = {}) {
    this.socketPath = options.socketPath ?? DEFAULT_DOCKER_SOCKET;
    const existsSync = options.existsSync;
    this.request = options.request ?? ((path) => realDockerRequest(this.socketPath, path));
    if (existsSync) {
      this.availableCache = existsSync(this.socketPath);
    }
  }

  /** Whether the socket looks reachable. Cached after the first check
   * (either the injected `existsSync` at construction, or the first real
   * request's outcome) so a Docker-less host pays the cost once. */
  available(): boolean {
    return this.availableCache !== false;
  }

  /** Inspect one container by id. Returns null on any failure (not
   * found, permission denied, timeout, malformed body) and marks the
   * client unavailable only on a connection-level failure (ECONNREFUSED /
   * ENOENT), never on a single container's 404. */
  async inspect(id: string): Promise<DockerInspection | null> {
    if (this.availableCache === false) return null;
    try {
      const body = await this.request(`/${API_VERSION}/containers/${encodeURIComponent(id)}/json`);
      this.availableCache = true;
      return parseDockerInspection(body);
    } catch (err) {
      if (isConnectionError(err)) this.availableCache = false;
      return null;
    }
  }
}

function isConnectionError(err: unknown): boolean {
  const code = (err as { code?: string } | null)?.code;
  return code === "ENOENT" || code === "ECONNREFUSED" || code === "EACCES";
}

function realDockerRequest(socketPath: string, path: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { socketPath, path, method: "GET", timeout: REQUEST_TIMEOUT_MS, headers: { Accept: "application/json" } },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => {
          if (res.statusCode !== 200) {
            reject(new Error(`docker socket returned ${res.statusCode}`));
            return;
          }
          resolve(Buffer.concat(chunks).toString("utf8"));
        });
      },
    );
    req.on("timeout", () => req.destroy(new Error("docker socket request timed out")));
    req.on("error", reject);
    req.end();
  });
}

/**
 * Enriches cgroup-derived containers with a Docker inspection, id-keyed
 * and additive only: a sample with no matching inspection (enrichment
 * skipped, id unknown to the daemon, non-docker runtime) is returned
 * unchanged, never stripped of the cgroup-measured fields.
 */
export async function enrichDockerContainers<T extends { id: string; runtime: string }>(
  containers: readonly T[],
  client: DockerEngineClient,
  maxLookups: number,
): Promise<Map<string, DockerInspection>> {
  const out = new Map<string, DockerInspection>();
  if (!client.available()) return out;
  let lookups = 0;
  for (const c of containers) {
    if (c.runtime !== "docker") continue;
    if (lookups >= maxLookups) break;
    lookups += 1;
    const inspection = await client.inspect(c.id);
    if (inspection) out.set(c.id, inspection);
    if (!client.available()) break; // socket went away mid-batch
  }
  return out;
}
