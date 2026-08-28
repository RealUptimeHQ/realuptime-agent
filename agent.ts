import { ApiClient } from "./api.ts";
import { ConfigError, loadConfig, tokenFingerprint } from "./config.ts";
import { log } from "./log.ts";
import { AgentRuntime } from "./runtime.ts";

/**
 * RealUptime Monitor agent, entrypoint.
 *
 * Reads two environment variables, opens outbound HTTPS to one hostname, and
 * loops. It listens on no port, executes no shell, reads no file, and accepts
 * no instruction from the server other than the list of checks to run.
 *
 * A bad configuration is the ONLY thing that exits nonzero, and only because a
 * missing token can never become a working one without a human. Everything
 * else, including a rejected token, is retried forever: a monitoring agent
 * that exits is monitoring that silently stopped.
 */

async function main(): Promise<void> {
  let config: ReturnType<typeof loadConfig>;
  try {
    config = loadConfig();
  } catch (err) {
    if (err instanceof ConfigError) {
      log("error", "configuration error", { error: err.message });
      process.exit(1);
    }
    throw err;
  }

  log("info", "RealUptime Monitor agent", {
    baseUrl: config.baseUrl,
    token: tokenFingerprint(config.token),
  });

  const runtime = new AgentRuntime({
    api: new ApiClient(config),
    metricsOptions: { cluster: config.cluster, node: config.node },
  });

  let shuttingDown = false;
  const shutdown = (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    log("info", "shutdown requested", { signal });
    runtime.stop();
    // One best-effort flush so a planned restart does not lose the last
    // fifteen seconds of results.
    void runtime.drain().finally(() => process.exit(0));
  };
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));

  await runtime.run();
}

main().catch((err) => {
  log("error", "fatal", { error: err instanceof Error ? err.message : String(err) });
  process.exit(1);
});
