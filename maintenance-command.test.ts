import { describe, expect, it, vi } from "vitest";
import {
  DEFAULT_MINUTES,
  describeWindow,
  parseMaintenanceArgs,
  runMaintenanceCommand,
  UsageError,
} from "./maintenance-command.ts";

const config = { baseUrl: "https://telemetry.example.com", token: "rua_secret_token_value" };

function recorder() {
  const logs: string[] = [];
  const errors: string[] = [];
  return { out: { log: (l: string) => logs.push(l), error: (l: string) => errors.push(l) }, logs, errors };
}

function json(status: number, body: unknown) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

describe("parseMaintenanceArgs", () => {
  it("defaults to opening a window of the default length", () => {
    expect(parseMaintenanceArgs([])).toEqual({ action: "open", minutes: DEFAULT_MINUTES, reason: "", hosts: [] });
  });

  it("reads minutes, reason and repeated hosts", () => {
    expect(
      parseMaintenanceArgs(["--minutes", "45", "--reason", "kernel update", "--host", "a.example.com", "--host", "b.example.com"]),
    ).toEqual({ action: "open", minutes: 45, reason: "kernel update", hosts: ["a.example.com", "b.example.com"] });
  });

  it("reads --end (and --off) and --status", () => {
    expect(parseMaintenanceArgs(["--end"])).toEqual({ action: "end" });
    expect(parseMaintenanceArgs(["--off"])).toEqual({ action: "end" });
    expect(parseMaintenanceArgs(["--status"])).toEqual({ action: "status" });
  });

  it("refuses minutes outside 1..1440, a non-number, a missing value and unknown flags", () => {
    expect(() => parseMaintenanceArgs(["--minutes", "0"])).toThrow(UsageError);
    expect(() => parseMaintenanceArgs(["--minutes", "1441"])).toThrow(UsageError);
    expect(() => parseMaintenanceArgs(["--minutes", "ten"])).toThrow(UsageError);
    expect(() => parseMaintenanceArgs(["--reason"])).toThrow(UsageError);
    expect(() => parseMaintenanceArgs(["--reason", "--end"])).toThrow(UsageError);
    expect(() => parseMaintenanceArgs(["--forever"])).toThrow(UsageError);
  });
});

describe("runMaintenanceCommand", () => {
  it("opens with the agent's own token against /agents/self/maintenance", async () => {
    const fetchImpl = vi.fn(async () =>
      json(201, { window: { ends_at: "2026-09-26T12:30:00.000Z", reason: "reboot", hosts: [] } }),
    );
    const r = recorder();

    const code = await runMaintenanceCommand(["--minutes", "30", "--reason", "reboot"], config, r.out, fetchImpl as unknown as typeof fetch);

    expect(code).toBe(0);
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://telemetry.example.com/api/v1/agents/self/maintenance");
    expect(init.method).toBe("POST");
    expect((init.headers as Record<string, string>).authorization).toBe("Bearer rua_secret_token_value");
    expect(JSON.parse(init.body as string)).toEqual({ minutes: 30, reason: "reboot", hosts: [] });
    expect(r.logs).toEqual(["planned maintenance until 2026-09-26T12:30:00.000Z (reboot)"]);
    // The token never reaches the output.
    expect([...r.logs, ...r.errors].join("\n")).not.toContain("rua_secret_token_value");
  });

  it("ends with DELETE and says so, including when nothing was active", async () => {
    const fetchImpl = vi.fn(async () => json(200, { window: null }));
    const r = recorder();

    expect(await runMaintenanceCommand(["--end"], config, r.out, fetchImpl as unknown as typeof fetch)).toBe(0);

    expect((fetchImpl.mock.calls[0] as unknown as [string, RequestInit])[1].method).toBe("DELETE");
    expect(r.logs).toEqual(["no planned maintenance was active"]);
  });

  it("reads status with GET", async () => {
    const fetchImpl = vi.fn(async () => json(200, { window: null }));
    const r = recorder();

    expect(await runMaintenanceCommand(["--status"], config, r.out, fetchImpl as unknown as typeof fetch)).toBe(0);

    expect((fetchImpl.mock.calls[0] as unknown as [string, RequestInit])[1].method).toBe("GET");
    expect(r.logs).toEqual(["no planned maintenance active"]);
  });

  it("exits 1 with the server's reason on a refusal, and on a network failure", async () => {
    const refused = recorder();
    const code = await runMaintenanceCommand(
      [],
      config,
      refused.out,
      (async () => json(404, { error: "Not found" })) as unknown as typeof fetch,
    );
    expect(code).toBe(1);
    expect(refused.errors.join("\n")).toContain("404: Not found");

    const unreachable = recorder();
    const code2 = await runMaintenanceCommand(
      [],
      config,
      unreachable.out,
      (async () => {
        throw new Error("ECONNREFUSED");
      }) as unknown as typeof fetch,
    );
    expect(code2).toBe(1);
    expect(unreachable.errors.join("\n")).toContain("ECONNREFUSED");
  });

  it("exits 2 on a usage error without calling the API", async () => {
    const fetchImpl = vi.fn();
    const r = recorder();
    expect(await runMaintenanceCommand(["--minutes", "0"], config, r.out, fetchImpl as unknown as typeof fetch)).toBe(2);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe("describeWindow", () => {
  it("names the extra hosts a window covers", () => {
    expect(
      describeWindow("open", { window: { ends_at: "2026-09-26T12:30:00.000Z", reason: "", hosts: ["a.example.com"] } }),
    ).toBe("planned maintenance until 2026-09-26T12:30:00.000Z, also covering a.example.com");
  });
});
