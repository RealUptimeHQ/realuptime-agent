import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * REA-281: the agent-side ping check. `runTcpCheck` (this app's own tcp
 * prober, exercised directly by check-tcp.test.ts) is mocked here so this
 * file can assert the parts unique to ping -- candidate-port discovery,
 * pinning, and loss accounting -- without needing root to bind port 443/80/22
 * for a real "up" case.
 */

const runTcpCheck = vi.fn();

vi.mock("./check-tcp.ts", () => ({
  runTcpCheck: (...args: unknown[]) => runTcpCheck(...args),
}));

const { runPingCheck } = await import("./check-ping.ts");

describe("runPingCheck", () => {
  beforeEach(() => {
    runTcpCheck.mockReset();
  });

  it("reports up with zero loss when every probe on the first candidate port succeeds", async () => {
    runTcpCheck.mockResolvedValue({ ok: true, latencyMs: 5 });

    const out = await runPingCheck("router.internal", 3);

    expect(out.ok).toBe(true);
    expect(out.transport).toBe("tcp-connect");
    expect(out.port).toBe(443);
    expect(out.packetLossPercent).toBe(0);
    expect(out.error).toBeUndefined();
    expect(runTcpCheck).toHaveBeenCalledTimes(3);
    for (const call of runTcpCheck.mock.calls) {
      expect(call[1]).toBe(443);
    }
  });

  it("falls through the candidate ports in order and pins whichever answers", async () => {
    runTcpCheck.mockImplementation(async (_host: string, port: number) => {
      if (port === 443) return { ok: false, latencyMs: 1, error: "refused" };
      if (port === 80) return { ok: true, latencyMs: 8 };
      throw new Error("should not try a third port once one has answered");
    });

    const out = await runPingCheck("router.internal", 1);

    expect(out.ok).toBe(true);
    expect(out.port).toBe(80);
  });

  it("reports 100% loss and down when none of the candidate ports answer", async () => {
    runTcpCheck.mockResolvedValue({ ok: false, latencyMs: 1000, error: "timed out" });

    const out = await runPingCheck("router.internal", 2);

    expect(out.ok).toBe(false);
    expect(out.packetLossPercent).toBe(100);
    expect(out.port).toBeNull();
    expect(out.error).toMatch(/no response/i);
  });

  it("reports partial loss without marking the check down", async () => {
    let call = 0;
    runTcpCheck.mockImplementation(async () => {
      call += 1;
      if (call === 1) return { ok: true, latencyMs: 5 };
      return { ok: false, latencyMs: 1000, error: "timed out" };
    });

    const out = await runPingCheck("router.internal", 2);

    expect(out.ok).toBe(true);
    expect(out.packetLossPercent).toBe(50);
    expect(out.error).toMatch(/50% packet loss/);
  });
});
