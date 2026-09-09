import { execFile } from "node:child_process";
import type { GpuVendor } from "./config.ts";
import type { GpuReading, GpuSample } from "./types.ts";

/**
 * GPU enrichment (REA-440 phase 5), following the shape phase 3/4
 * established for Postgres/Redis/MySQL -- a small, honest set of health
 * numbers, config-gated where it needs to be, off/absent where it cannot
 * truthfully say anything.
 *
 * ## Why nvidia-smi, and only nvidia-smi
 *
 * `nvidia-smi` ships with every NVIDIA driver install (Linux and Windows)
 * and is the only GPU vendor tool broadly deployable across a customer
 * fleet without a separate SDK install: AMD's `rocm-smi` requires the ROCm
 * stack to be present (most customers running an AMD card for anything
 * other than compute do not have it), and Intel's tooling (`intel_gpu_top`,
 * `xpu-smi`) is newer, less universally installed, and split across two
 * incompatible programs depending on card generation. Both are explicitly
 * out of scope for this rung: `REALUPTIME_GPU_VENDOR=amd` or `=intel` gets
 * a plain "not supported" reading every tick (see `NvidiaSmiCollector`
 * below) rather than either silently reporting nothing or guessing at a
 * shape this agent cannot fill in.
 *
 * Shelling out to the CLI, not a driver library binding, keeps this inside
 * the same zero-runtime-dependency rule collect-docker.ts and the DSN-based
 * collectors established: no `node-nvidia-smi`, no native addon, nothing
 * to compile against a driver ABI that varies by host. `nvidia-smi` speaks
 * a stable CSV output format built for exactly this kind of scripting.
 *
 * ## No opt-in required for the NVIDIA path
 *
 * Unlike the three DSN collectors, reading `nvidia-smi` needs no
 * credential and touches nothing but a local, read-only system tool, so
 * there is nothing to gate behind an environment variable the way a
 * database connection string is gated. The agent simply tries the binary
 * every tick; a host with no NVIDIA driver installed gets ENOENT, which is
 * treated exactly like "Docker socket not present" in collect-docker.ts:
 * silent, cached, and the GPU family is left off the sample entirely --
 * never a zeroed-out reading standing in for "no GPU here".
 *
 * ## What is collected, and why these fields
 *
 * `nvidia-smi --query-gpu=... --format=csv,noheader,nounits`, one row per
 * physical GPU: its index and name (so an operator with more than one card
 * per host can tell them apart), compute utilization, memory used/total,
 * temperature, and power draw against its configured limit -- the numbers
 * an operator actually pages on, not the dozens of counters `nvidia-smi -q`
 * would dump. Power fields are nullable: some cards and some power modes
 * report `[N/A]` for draw or limit, and that is reported as null rather
 * than a fabricated zero.
 *
 * ## Failure is its own state, not silence
 *
 * This is the one difference from the three DSN collectors, and it is
 * deliberate: a database is either configured or it is not, so a
 * connection failure on a configured DSN is indistinguishable in practice
 * from "try again next tick" and phase 3/4 treat it that way (log once,
 * omit the family, retry). A GPU is a physical fact about the host: once
 * `nvidia-smi` has been seen to exist, a tick where it errors (driver
 * reinstall in progress, a card fallen off the bus, a permissions
 * regression) is itself an operationally meaningful reading, and hiding it
 * behind "family absent" would look identical to "this host never had a
 * GPU". So a present-but-erroring nvidia-smi, and an explicitly configured
 * unsupported vendor, both report `{ error }` rather than nothing.
 */

export const NVIDIA_SMI_BINARY = "nvidia-smi";
/** A host with more GPUs than this is not a case this rung was sized for;
 * the same defensive-cap reasoning as `MAX_CONTAINERS_PER_SAMPLE`. */
export const MAX_GPUS_PER_SAMPLE = 16;
const EXEC_TIMEOUT_MS = 5000;
const EXEC_MAX_OUTPUT_BYTES = 1 * 1024 * 1024;
const MIB_TO_BYTES = 1024 * 1024;

const QUERY_FIELDS = [
  "index",
  "name",
  "utilization.gpu",
  "memory.used",
  "memory.total",
  "temperature.gpu",
  "power.draw",
  "power.limit",
] as const;

const VENDOR_LABEL: Record<Exclude<GpuVendor, "nvidia">, string> = {
  amd: "AMD",
  intel: "Intel",
};

export type ExecFn = (file: string, args: readonly string[]) => Promise<string>;

/** Parses one `[N/A]`-or-numeric CSV cell. `nvidia-smi` renders an
 * unreadable field (a card that does not expose power telemetry, a power
 * mode that reports no limit) as the literal string `[N/A]` even with
 * `nounits`. */
function parseOptionalNumber(raw: string | undefined): number | null {
  const value = (raw ?? "").trim();
  if (!value || /^\[?n\/a\]?$/i.test(value)) return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

/**
 * Parses `nvidia-smi --query-gpu=<QUERY_FIELDS> --format=csv,noheader,nounits`
 * output into one reading per row (one row per physical GPU). Returns null
 * for anything that does not parse as a well-formed instance of this exact
 * query -- a driver upgrade changing the CSV shape must surface as "could
 * not read GPU metrics", not as a half-filled or fabricated reading.
 */
export function parseNvidiaSmiCsv(text: string): GpuReading[] | null {
  const lines = text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  if (lines.length === 0) return null;
  if (lines.length > MAX_GPUS_PER_SAMPLE) return null;

  const readings: GpuReading[] = [];
  for (const line of lines) {
    const cols = line.split(",").map((c) => c.trim());
    if (cols.length !== QUERY_FIELDS.length) return null;
    const [indexRaw, name, utilRaw, memUsedRaw, memTotalRaw, tempRaw, powerDrawRaw, powerLimitRaw] =
      cols;

    const index = Number(indexRaw);
    const utilizationPercent = Number(utilRaw);
    const memoryUsedMib = Number(memUsedRaw);
    const memoryTotalMib = Number(memTotalRaw);
    const temperatureCelsius = Number(tempRaw);

    if (!Number.isInteger(index) || index < 0) return null;
    if (!name) return null;
    if (
      !Number.isFinite(utilizationPercent) ||
      utilizationPercent < 0 ||
      utilizationPercent > 100
    ) {
      return null;
    }
    if (!Number.isFinite(memoryUsedMib) || memoryUsedMib < 0) return null;
    if (!Number.isFinite(memoryTotalMib) || memoryTotalMib < 0) return null;
    if (memoryUsedMib > memoryTotalMib) return null;
    if (!Number.isFinite(temperatureCelsius)) return null;

    readings.push({
      index,
      name,
      utilizationRatio: utilizationPercent / 100,
      memoryUsedBytes: Math.round(memoryUsedMib * MIB_TO_BYTES),
      memoryTotalBytes: Math.round(memoryTotalMib * MIB_TO_BYTES),
      temperatureCelsius,
      powerDrawWatts: parseOptionalNumber(powerDrawRaw),
      powerLimitWatts: parseOptionalNumber(powerLimitRaw),
    });
  }
  return readings;
}

function isBinaryMissing(err: unknown): boolean {
  const code = (err as { code?: string } | null)?.code;
  return code === "ENOENT";
}

function realExec(file: string, args: readonly string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      file,
      [...args],
      {
        shell: false,
        windowsHide: true,
        timeout: EXEC_TIMEOUT_MS,
        maxBuffer: EXEC_MAX_OUTPUT_BYTES,
        encoding: "utf8",
        env: minimalEnv(),
      },
      (err, stdout) => {
        if (err) reject(err);
        else resolve(String(stdout));
      },
    );
  });
}

function minimalEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const key of ["PATH", "SYSTEMROOT", "SystemRoot", "TEMP", "TMP", "LANG", "LC_ALL"]) {
    if (process.env[key] !== undefined) env[key] = process.env[key];
  }
  env.LC_ALL = "C";
  env.LANG = "C";
  return env;
}

export class NvidiaSmiCollector {
  private readonly vendor: GpuVendor;
  private readonly exec: ExecFn;
  private availableCache: boolean | null = null;

  constructor(options: { vendor?: GpuVendor; exec?: ExecFn } = {}) {
    this.vendor = options.vendor ?? "nvidia";
    this.exec = options.exec ?? realExec;
  }

  /** One tick's GPU reading. `null` means "genuinely nothing to report"
   * (the vendor is nvidia and the binary is not on this host); anything
   * else -- readings or an error -- is a fact worth attaching to the
   * sample. See the module comment for why those two are not the same. */
  async collect(): Promise<GpuSample | null> {
    if (this.vendor !== "nvidia") {
      return {
        error: `${VENDOR_LABEL[this.vendor]} GPUs are configured (REALUPTIME_GPU_VENDOR=${this.vendor}) but this agent version only reads GPU metrics from NVIDIA via nvidia-smi. ${VENDOR_LABEL[this.vendor]} support is out of scope for this rung.`,
      };
    }
    if (this.availableCache === false) return null;

    let stdout: string;
    try {
      stdout = await this.exec(NVIDIA_SMI_BINARY, [
        `--query-gpu=${QUERY_FIELDS.join(",")}`,
        "--format=csv,noheader,nounits",
      ]);
      this.availableCache = true;
    } catch (err) {
      if (isBinaryMissing(err)) {
        this.availableCache = false;
        return null;
      }
      return {
        error: `nvidia-smi failed: ${err instanceof Error ? err.message : String(err)}`,
      };
    }

    const readings = parseNvidiaSmiCsv(stdout);
    if (readings === null) {
      return { error: "nvidia-smi returned output this agent could not parse." };
    }
    return readings;
  }
}
