/**
 * Kernel load averages from `/proc/loadavg`.
 *
 * Reported raw and unnormalised, exactly as the kernel computes them: the
 * wire contract is explicit that `load1/5/15` are not divided by core count,
 * because "load 4.0 on 2 cores" is a judgement the server or a dashboard
 * makes with `cpuCores` alongside it, not one this collector should make for
 * them.
 *
 * All three or none. A platform with no load average (this file missing or
 * unparseable) must never be reported as zeroes, which reads as an idle
 * machine; the caller sends the whole group as absent instead.
 */

export interface LoadReading {
  load1: number;
  load5: number;
  load15: number;
}

export function parseLoadAvg(text: string): LoadReading | null {
  const fields = text.trim().split(/\s+/).slice(0, 3).map(Number);
  if (fields.length < 3 || fields.some((f) => !Number.isFinite(f) || f < 0)) return null;
  const [load1, load5, load15] = fields as [number, number, number];
  return { load1, load5, load15 };
}
