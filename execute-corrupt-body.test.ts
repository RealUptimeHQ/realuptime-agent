import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, describe, expect, it } from "vitest";
import { executeCheck } from "./execute.ts";
import type { AgentCheck } from "./types.ts";

/**
 * REA-1155: one target that serves a corrupt gzip body fails that one check
 * with a reason, and the agent's other checks keep running. Driven through
 * executeCheck, the function the runtime calls for every assigned check.
 */

const servers: http.Server[] = [];
async function serve(handler: http.RequestListener): Promise<string> {
  const server = http.createServer(handler);
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}
afterAll(async () => {
  await Promise.all(servers.map((s) => new Promise<void>((resolve) => s.close(() => resolve()))));
});

describe("executeCheck: a corrupt gzip body", () => {
  it("fails only that check, with the reason, and the next check still runs", async () => {
    const escaped: unknown[] = [];
    const onEscape = (err: unknown) => escaped.push(err);
    process.on("uncaughtException", onEscape);
    process.on("unhandledRejection", onEscape);
    try {
      const bad = await serve((_req, res) => {
        res.writeHead(200, { "content-encoding": "gzip" }).end("this is not gzip at all");
      });
      const good = await serve((_req, res) => res.writeHead(200).end("status: healthy"));
      const check = (id: string, url: string) =>
        ({ id, type: "http", url, assertionBodyOp: "contains", assertionBodyValue: "healthy" }) as unknown as AgentCheck;

      const first = await executeCheck(check("bad", bad));
      expect(first).toMatchObject({
        checkId: "bad",
        ok: false,
        statusCode: 200,
        error: "Response body could not be decoded: corrupt gzip",
      });
      const second = await executeCheck(check("good", good));
      expect(second).toMatchObject({ checkId: "good", ok: true, statusCode: 200 });

      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(escaped).toEqual([]);
    } finally {
      process.off("uncaughtException", onEscape);
      process.off("unhandledRejection", onEscape);
    }
  });
});
