import * as net from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { RedisCollector, dsnFingerprint, parseRedisDsn } from "./collect-redis.ts";

describe("parseRedisDsn", () => {
  it("parses a plain TCP DSN with defaults", () => {
    expect(parseRedisDsn("redis://:secret@cache.internal:6380/2")).toEqual({
      host: "cache.internal",
      port: 6380,
      password: "secret",
      db: 2,
    });
  });

  it("defaults the port and carries no password or db when absent", () => {
    expect(parseRedisDsn("redis://localhost")).toEqual({
      host: "localhost",
      port: 6379,
      password: null,
      db: null,
    });
  });

  it("accepts the rediss:// alias", () => {
    expect(parseRedisDsn("rediss://localhost")?.host).toBe("localhost");
  });

  it("reads a unix-socket DSN from the path query parameter", () => {
    expect(parseRedisDsn("redis://?path=/var/run/redis/redis.sock&password=x")).toEqual({
      host: "/var/run/redis/redis.sock",
      port: 6379,
      password: "x",
      db: null,
    });
  });

  it("returns null for an unparseable or wrong-scheme DSN", () => {
    expect(parseRedisDsn("not a url")).toBeNull();
    expect(parseRedisDsn("http://localhost")).toBeNull();
  });

  it("returns null for a bogus db index", () => {
    expect(parseRedisDsn("redis://localhost/not-a-number")).toBeNull();
    expect(parseRedisDsn("redis://localhost/-1")).toBeNull();
  });
});

describe("dsnFingerprint", () => {
  it("never includes the password", () => {
    const opts = parseRedisDsn("redis://:very-secret@cache.internal:6379/1")!;
    const fp = dsnFingerprint(opts);
    expect(fp).toBe("cache.internal:6379/1");
    expect(fp).not.toContain("very-secret");
  });
});

function simpleString(text: string): Buffer {
  return Buffer.from(`+${text}\r\n`, "utf8");
}

function bulkString(text: string): Buffer {
  return Buffer.from(`$${Buffer.byteLength(text, "utf8")}\r\n${text}\r\n`, "utf8");
}

function errorReply(text: string): Buffer {
  return Buffer.from(`-${text}\r\n`, "utf8");
}

let servers: net.Server[] = [];

afterEach(async () => {
  await Promise.all(
    servers.map(
      (s) =>
        new Promise<void>((resolve) => {
          s.close(() => resolve());
        }),
    ),
  );
  servers = [];
});

/** A fake Redis server that replies to each RESP command it receives, in
 * order, with the next buffer from `replies`. Good enough for the fixed
 * AUTH/SELECT/INFO sequence this module ever sends. */
function startFakeServer(replies: Buffer[]): Promise<number> {
  return new Promise((resolve) => {
    const server = net.createServer((socket) => {
      let index = 0;
      socket.on("data", () => {
        // One command in, one reply out; the fake server does not parse the
        // RESP command array since every test here fixes the exact
        // sequence of replies it expects to send regardless of the exact
        // bytes received.
        if (index < replies.length) socket.write(replies[index++]!);
      });
    });
    servers.push(server);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      resolve(typeof address === "object" && address ? address.port : 0);
    });
  });
}

const INFO_BODY = [
  "# Memory",
  "used_memory:1048576",
  "maxmemory:0",
  "# Clients",
  "connected_clients:7",
  "# Stats",
  "keyspace_hits:900",
  "keyspace_misses:100",
  "evicted_keys:3",
  "",
].join("\r\n");

describe("RedisCollector", () => {
  it("returns null when the DSN does not parse", async () => {
    const collector = new RedisCollector("not a url");
    expect(collector.configured()).toBe(false);
    expect(await collector.collect()).toBeNull();
  });

  it("runs INFO with no auth and parses memory, clients, hit ratio and evictions", async () => {
    const port = await startFakeServer([bulkString(INFO_BODY)]);
    const collector = new RedisCollector(`redis://127.0.0.1:${port}`);
    const sample = await collector.collect();
    expect(sample).toEqual({
      usedMemoryBytes: 1048576,
      maxMemoryBytes: null, // maxmemory:0 means unlimited, reported as null
      connectedClients: 7,
      hitRatio: 0.9,
      evictedKeys: 3,
    });
  });

  it("sends AUTH then INFO when a password is configured", async () => {
    const port = await startFakeServer([simpleString("OK"), bulkString(INFO_BODY)]);
    const collector = new RedisCollector(`redis://:secret@127.0.0.1:${port}`);
    const sample = await collector.collect();
    expect(sample?.connectedClients).toBe(7);
  });

  it("sends SELECT when a db index is configured", async () => {
    const port = await startFakeServer([simpleString("OK"), bulkString(INFO_BODY)]);
    const collector = new RedisCollector(`redis://127.0.0.1:${port}/3`);
    const sample = await collector.collect();
    expect(sample?.evictedKeys).toBe(3);
  });

  it("reports maxmemory as a real number when configured", async () => {
    const body = INFO_BODY.replace("maxmemory:0", "maxmemory:536870912");
    const port = await startFakeServer([bulkString(body)]);
    const collector = new RedisCollector(`redis://127.0.0.1:${port}`);
    const sample = await collector.collect();
    expect(sample?.maxMemoryBytes).toBe(536870912);
  });

  it("returns null (not a throw) on an AUTH error", async () => {
    const port = await startFakeServer([errorReply("WRONGPASS invalid password")]);
    const collector = new RedisCollector(`redis://:bad@127.0.0.1:${port}`);
    expect(await collector.collect()).toBeNull();
  });

  it("returns null when nothing is listening on the port", async () => {
    const collector = new RedisCollector("redis://127.0.0.1:1");
    expect(await collector.collect()).toBeNull();
  });

  it("reports a null hit ratio when neither a hit nor a miss has happened", async () => {
    const body = INFO_BODY.replace("keyspace_hits:900", "keyspace_hits:0").replace(
      "keyspace_misses:100",
      "keyspace_misses:0",
    );
    const port = await startFakeServer([bulkString(body)]);
    const collector = new RedisCollector(`redis://127.0.0.1:${port}`);
    const sample = await collector.collect();
    expect(sample?.hitRatio).toBeNull();
  });
});
