import { describe, expect, it } from "vitest";
import { DockerEngineClient, enrichDockerContainers, parseDockerInspection } from "./collect-docker.ts";

describe("parseDockerInspection", () => {
  it("reads name, image, state, restart count and health from an inspect response", () => {
    const info = parseDockerInspection(
      JSON.stringify({
        Name: "/web-1",
        Config: { Image: "nginx:1.27" },
        State: { Status: "running", Health: { Status: "healthy" } },
        RestartCount: 2,
      }),
    );
    expect(info).toEqual({ name: "web-1", image: "nginx:1.27", state: "running", restartCount: 2, health: "healthy" });
  });

  it("reports health as 'none' rather than absent when the image defines no healthcheck", () => {
    const info = parseDockerInspection(
      JSON.stringify({ Name: "/db-1", Config: { Image: "postgres:16" }, State: { Status: "running" }, RestartCount: 0 }),
    );
    expect(info?.health).toBe("none");
  });

  it("strips only the single leading slash Docker always puts on a container name", () => {
    const info = parseDockerInspection(JSON.stringify({ Name: "/api-1", State: {}, RestartCount: 0 }));
    expect(info?.name).toBe("api-1");
  });

  it("degrades field-by-field rather than failing whole on an unexpected shape", () => {
    const info = parseDockerInspection(JSON.stringify({ State: { Status: "bogus-future-state" } }));
    expect(info).toEqual({ name: null, image: null, state: null, restartCount: null, health: "none" });
  });

  it("returns null on unparseable JSON rather than throwing", () => {
    expect(parseDockerInspection("not json")).toBeNull();
    expect(parseDockerInspection("null")).toBeNull();
  });
});

describe("DockerEngineClient", () => {
  it("is unavailable when the socket does not exist, and never issues a request", async () => {
    let called = false;
    const client = new DockerEngineClient({
      existsSync: () => false,
      request: async () => {
        called = true;
        return "{}";
      },
    });
    expect(client.available()).toBe(false);
    expect(await client.inspect("abc")).toBeNull();
    expect(called).toBe(false);
  });

  it("inspects a container over the injected request function", async () => {
    const client = new DockerEngineClient({
      existsSync: () => true,
      request: async (path) => {
        expect(path).toContain("/containers/abc/json");
        return JSON.stringify({ Name: "/x", Config: { Image: "redis:7" }, State: { Status: "running" }, RestartCount: 1 });
      },
    });
    const info = await client.inspect("abc");
    expect(info?.image).toBe("redis:7");
  });

  it("marks itself unavailable after a connection-level failure, not after a single 404", async () => {
    const refused = new DockerEngineClient({
      existsSync: () => true,
      request: async () => {
        const err: NodeJS.ErrnoException = new Error("refused");
        err.code = "ECONNREFUSED";
        throw err;
      },
    });
    expect(await refused.inspect("abc")).toBeNull();
    expect(refused.available()).toBe(false);

    const notFound = new DockerEngineClient({
      existsSync: () => true,
      request: async () => {
        throw new Error("docker socket returned 404");
      },
    });
    expect(await notFound.inspect("missing")).toBeNull();
    expect(notFound.available()).toBe(true);
  });
});

describe("enrichDockerContainers", () => {
  it("looks up only docker-runtime containers", async () => {
    const seen: string[] = [];
    const client = new DockerEngineClient({
      existsSync: () => true,
      request: async (path) => {
        seen.push(path);
        return JSON.stringify({ Name: "/c", Config: { Image: "img" }, State: { Status: "running" }, RestartCount: 0 });
      },
    });
    const containers = [
      { id: "a", runtime: "docker" },
      { id: "b", runtime: "kubernetes" },
      { id: "c", runtime: "docker" },
    ];
    const result = await enrichDockerContainers(containers, client, 64);
    expect(result.size).toBe(2);
    expect(seen).toEqual([expect.stringContaining("/a/"), expect.stringContaining("/c/")]);
  });

  it("stops once the socket goes away mid-batch, keeping what was already found", async () => {
    let calls = 0;
    const client = new DockerEngineClient({
      existsSync: () => true,
      request: async () => {
        calls += 1;
        if (calls === 1) return JSON.stringify({ Name: "/a", State: { Status: "running" }, RestartCount: 0 });
        const err: NodeJS.ErrnoException = new Error("gone");
        err.code = "ENOENT";
        throw err;
      },
    });
    const containers = [
      { id: "a", runtime: "docker" },
      { id: "b", runtime: "docker" },
      { id: "c", runtime: "docker" },
    ];
    const result = await enrichDockerContainers(containers, client, 64);
    expect(result.size).toBe(1);
    expect(calls).toBe(2); // third lookup skipped once availability flipped
  });

  it("caps lookups per tick", async () => {
    let calls = 0;
    const client = new DockerEngineClient({
      existsSync: () => true,
      request: async () => {
        calls += 1;
        return JSON.stringify({ Name: "/x", State: { Status: "running" }, RestartCount: 0 });
      },
    });
    const containers = Array.from({ length: 10 }, (_, i) => ({ id: `id${i}`, runtime: "docker" }));
    await enrichDockerContainers(containers, client, 3);
    expect(calls).toBe(3);
  });

  it("returns empty when the client is unavailable, without calling request", async () => {
    const client = new DockerEngineClient({ existsSync: () => false, request: async () => "{}" });
    const result = await enrichDockerContainers([{ id: "a", runtime: "docker" }], client, 64);
    expect(result.size).toBe(0);
  });
});
