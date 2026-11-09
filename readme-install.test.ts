import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * The README's install commands are the ones the website publishes, from the
 * server's own builder of them (apps/web/lib/agent-install.ts), read from
 * REALUPTIME_SERVER_SRC. Unset, as in the public mirror or a bare local run,
 * the test skips; ci/gate.sh sets it.
 */
const HERE = dirname(fileURLToPath(import.meta.url));
const README = readFileSync(join(HERE, "README.md"), "utf8");

type InstallModule = {
  AGENT_PLATFORMS: readonly string[];
  agentInstallCommand: (platform: string) => string;
  agentDockerCommand: () => string;
};

async function serverInstall(ctx: { skip: () => void }): Promise<InstallModule> {
  const root = process.env.REALUPTIME_SERVER_SRC;
  if (!root) {
    ctx.skip();
    return undefined as never;
  }
  const path = join(root, "apps/web/lib/agent-install.ts");
  if (!existsSync(path)) throw new Error("REALUPTIME_SERVER_SRC has no apps/web/lib/agent-install.ts");
  return (await import(pathToFileURL(path).href)) as InstallModule;
}

describe("the README's install commands", () => {
  it("are the website's, for every platform and Docker", async (ctx) => {
    const install = await serverInstall(ctx);
    for (const platform of install.AGENT_PLATFORMS) expect(README).toContain(install.agentInstallCommand(platform));
    expect(README).toContain(install.agentDockerCommand());
  });

  it("carry no hand-typed token-flag variant", () => {
    expect(README).not.toContain("sh -s -- --token");
  });
});
