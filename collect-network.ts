import type { NetworkInterfaceSample } from "./types.ts";

/**
 * Network I/O per interface (REA-181), from three sources:
 *
 *   Linux    /proc/net/dev (a file; cumulative counters since boot)
 *   macOS    `netstat -ibn` (the `<Link#N>` rows carry per-interface totals)
 *   Windows  `Get-NetAdapterStatistics` inside the one PowerShell script
 *
 * All three yield the same `InterfaceCounters`, and `ratesFromCounters`
 * turns two consecutive readings into the wire shape: bytes per second for
 * traffic and plain deltas for errors/dropped. Counters are cumulative and
 * unsigned, so a counter that went DOWN (interface reset, counter wrap, a
 * new interface with the same name) yields no reading for that interface
 * that round rather than a negative rate. Loopback is excluded: it is
 * traffic the machine sends itself, and it drowns a real NIC on a chart.
 */

export interface InterfaceCounters {
  name: string;
  rxBytes: number;
  txBytes: number;
  rxErrors: number;
  txErrors: number;
  rxDropped: number;
  txDropped: number;
}

/** Mirrors the server's cap (packages/db/server-metrics.ts). */
export const MAX_NETWORK_INTERFACES_PER_SAMPLE = 32;

const LOOPBACK = /^lo\d*$/;

export function parseProcNetDev(text: string): InterfaceCounters[] {
  const out: InterfaceCounters[] = [];
  for (const rawLine of text.split("\n")) {
    const colon = rawLine.indexOf(":");
    if (colon === -1) continue;
    const name = rawLine.slice(0, colon).trim();
    if (!name || LOOPBACK.test(name)) continue;
    const fields = rawLine
      .slice(colon + 1)
      .trim()
      .split(/\s+/)
      .map(Number);
    // rx: bytes packets errs drop fifo frame compressed multicast (8)
    // tx: bytes packets errs drop fifo colls carrier compressed (8)
    if (fields.length < 16 || fields.some((f) => !Number.isFinite(f))) continue;
    out.push({
      name,
      rxBytes: fields[0]!,
      rxErrors: fields[2]!,
      rxDropped: fields[3]!,
      txBytes: fields[8]!,
      txErrors: fields[10]!,
      txDropped: fields[11]!,
    });
  }
  return out;
}

/**
 * `netstat -ibn` on macOS. Header:
 *   Name Mtu Network Address Ipkts Ierrs Ibytes Opkts Oerrs Obytes Coll
 * Only the `<Link#N>` row of each interface carries the interface totals;
 * the per-address rows that follow repeat the same counters and are
 * skipped so an interface with three addresses is not tripled. macOS
 * exposes no dropped-packet counter here, so those are reported as 0
 * deltas rather than omitted, because the wire shape is per-interface and
 * a reader can tell "macOS" from the host info.
 */
export function parseNetstatIbn(text: string): InterfaceCounters[] {
  const out: InterfaceCounters[] = [];
  const lines = text.split("\n");
  const header = lines[0]?.trim().split(/\s+/) ?? [];
  // The seven counters are the LAST seven columns (Ipkts Ierrs Ibytes Opkts
  // Oerrs Obytes Coll). Counting from the end is what makes the row with a
  // blank Address column (lo0's `<Link#1>` row) and the row with a MAC in it
  // (en0's) parse identically.
  if (header.slice(-7).join(" ") !== "Ipkts Ierrs Ibytes Opkts Oerrs Obytes Coll") return out;

  for (const line of lines.slice(1)) {
    const fields = line.trim().split(/\s+/);
    if (fields.length < 9) continue;
    if (!fields.some((f, i) => i > 0 && i < fields.length - 7 && f.startsWith("<Link#"))) continue;
    const name = fields[0]!;
    if (LOOPBACK.test(name)) continue;
    const n = fields.length;
    const rxErrors = Number(fields[n - 6]);
    const rxBytes = Number(fields[n - 5]);
    const txErrors = Number(fields[n - 3]);
    const txBytes = Number(fields[n - 2]);
    if (![rxErrors, rxBytes, txErrors, txBytes].every(Number.isFinite)) continue;
    out.push({ name, rxBytes, txBytes, rxErrors, txErrors, rxDropped: 0, txDropped: 0 });
  }
  return out;
}

/** The `net` array of the Windows PowerShell document (see
 * collect-windows.ts): Get-NetAdapterStatistics rows. */
export function parseWindowsNetAdapters(rows: unknown): InterfaceCounters[] {
  if (!Array.isArray(rows)) return [];
  const out: InterfaceCounters[] = [];
  for (const row of rows) {
    if (!row || typeof row !== "object") continue;
    const r = row as Record<string, unknown>;
    const name = typeof r.Name === "string" ? r.Name.trim() : "";
    if (!name) continue;
    const n = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : 0);
    out.push({
      name,
      rxBytes: n(r.ReceivedBytes),
      txBytes: n(r.SentBytes),
      rxErrors: n(r.ReceivedPacketErrors),
      txErrors: n(r.OutboundPacketErrors),
      rxDropped: n(r.ReceivedDiscardedPackets),
      txDropped: n(r.OutboundDiscardedPackets),
    });
  }
  return out;
}

/**
 * Two readings to one sample. `elapsedMs` is the wall time between them.
 * Interfaces present in only one reading, or whose counters went backwards,
 * produce nothing this round. Capped, largest traffic first, ties by name,
 * so the same machine produces the same list in the same order.
 */
export function ratesFromCounters(
  previous: readonly InterfaceCounters[],
  current: readonly InterfaceCounters[],
  elapsedMs: number,
): NetworkInterfaceSample[] {
  if (!(elapsedMs > 0)) return [];
  const seconds = elapsedMs / 1000;
  const prevByName = new Map(previous.map((c) => [c.name, c]));
  const samples: NetworkInterfaceSample[] = [];
  for (const curr of current) {
    const prev = prevByName.get(curr.name);
    if (!prev) continue;
    const dRx = curr.rxBytes - prev.rxBytes;
    const dTx = curr.txBytes - prev.txBytes;
    const dRxE = curr.rxErrors - prev.rxErrors;
    const dTxE = curr.txErrors - prev.txErrors;
    const dRxD = curr.rxDropped - prev.rxDropped;
    const dTxD = curr.txDropped - prev.txDropped;
    if ([dRx, dTx, dRxE, dTxE, dRxD, dTxD].some((d) => d < 0)) continue;
    samples.push({
      name: curr.name,
      rxBytesPerSec: Math.round(dRx / seconds),
      txBytesPerSec: Math.round(dTx / seconds),
      rxErrors: dRxE,
      txErrors: dTxE,
      rxDropped: dRxD,
      txDropped: dTxD,
    });
  }
  samples.sort(
    (a, b) =>
      b.rxBytesPerSec + b.txBytesPerSec - (a.rxBytesPerSec + a.txBytesPerSec) || a.name.localeCompare(b.name),
  );
  return samples.slice(0, MAX_NETWORK_INTERFACES_PER_SAMPLE);
}
