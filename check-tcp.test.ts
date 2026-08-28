import net, { type AddressInfo } from "node:net";
import tls from "node:tls";
import { afterAll, describe, expect, it } from "vitest";
import { runTcpCheck } from "./check-tcp.ts";
import { TEST_CERT_PEM, TEST_KEY_PEM } from "./testdata/self-signed.ts";

const closers: Array<() => void> = [];

async function listenTcp(): Promise<number> {
  const server = net.createServer();
  closers.push(() => server.close());
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return (server.address() as AddressInfo).port;
}

async function listenTls(): Promise<number> {
  const server = tls.createServer({ key: TEST_KEY_PEM, cert: TEST_CERT_PEM });
  closers.push(() => server.close());
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return (server.address() as AddressInfo).port;
}

/** A port nothing is listening on, obtained by binding one and letting it go. */
async function deadPort(): Promise<number> {
  const server = net.createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

afterAll(() => {
  for (const close of closers) close();
});

describe("runTcpCheck", () => {
  it("counts a completed connection as up", async () => {
    const port = await listenTcp();
    const out = await runTcpCheck("127.0.0.1", port, false);
    expect(out.ok).toBe(true);
    expect(out.error).toBeUndefined();
    expect(out.latencyMs).toBeGreaterThanOrEqual(0);
  });

  it("counts a completed TLS handshake as up, against a self-signed certificate", async () => {
    // The normal case on a private network, and the case certificate
    // validation would report as a false outage.
    const port = await listenTls();
    const out = await runTcpCheck("127.0.0.1", port, true);
    expect(out.ok).toBe(true);
    expect(out.error).toBeUndefined();
  });

  it("counts a refused connection as down, with the errno named", async () => {
    const port = await deadPort();
    const out = await runTcpCheck("127.0.0.1", port, false);
    expect(out.ok).toBe(false);
    expect(out.error).toMatch(/ECONNREFUSED|closed before it completed/);
  });

  it("fails the TLS handshake against a plain TCP listener", async () => {
    // A plain socket accepts the connection and then never speaks TLS. The
    // handshake is the success condition, so this must NOT report up.
    const port = await listenTcp();
    const out = await runTcpCheck("127.0.0.1", port, true, 500);
    expect(out.ok).toBe(false);
  });

  it("times out rather than hanging on an unroutable address", async () => {
    // 192.0.2.0/24 is TEST-NET-1: reserved, and routed nowhere.
    const started = Date.now();
    const out = await runTcpCheck("192.0.2.1", 9, false, 300);
    expect(out.ok).toBe(false);
    expect(Date.now() - started).toBeLessThan(5_000);
  });

  it("reports an unresolvable hostname in plain language", async () => {
    const out = await runTcpCheck("no-such-host.invalid", 443, false, 5_000);
    expect(out.ok).toBe(false);
    expect(out.error).toBeDefined();
  });
});
