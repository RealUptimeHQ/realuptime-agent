import { ApiClient } from "./api.ts";
import { loadBounds } from "./bounds.ts";
import { ConfigError, loadConfig, tokenFingerprint } from "./config.ts";
import { createEgressGuard, EgressReport } from "./egress-guard.ts";
import { loadEgressPolicy } from "./egress-policy.ts";
import { installErrorsReporting } from "./errors-report.ts";
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
  // REA-575: wired before config even loads, so a crash during startup is
  // covered too. A no-op on every customer machine (see errors-report.ts);
  // only ever live on a RealUptime-owned host running this same binary
  // against itself.
  installErrorsReporting(process.env, log);

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

  // Both read from THIS machine's environment and from nothing else. A total
  // compromise of RealUptime cannot move either of them, because moving them
  // means editing a file on this server and restarting this process. That is
  // the whole argument in `docs/private-probe-locations.md` section 3.3, and
  // it only holds because these two lines are the only place the values come
  // from.
  const bounds = loadBounds();
  const egressPolicy = loadEgressPolicy();
  const egressReport = new EgressReport();

  log("info", "RealUptime Monitor agent", {
    baseUrl: config.baseUrl,
    token: tokenFingerprint(config.token),
  });
  // Stated at startup, in full, so an operator can read what this location
  // will and will not do without reading the source. A security boundary
  // nobody can see the current setting of is a security boundary nobody
  // trusts.
  log("info", "this location's limits", {
    egressPolicy: egressPolicy.mode,
    allowLoopback: egressPolicy.allowLoopback,
    allowTargets: egressPolicy.allowTargets.length || undefined,
    allowPorts: egressPolicy.allowPorts.length || undefined,
    minIntervalSeconds: bounds.minIntervalSeconds,
    maxConcurrentProbes: bounds.maxConcurrentProbes,
    maxProbesPerMinute: bounds.maxProbesPerMinute,
    maxAssignedChecks: bounds.maxAssignedChecks,
  });

  const runtime = new AgentRuntime({
    api: new ApiClient(config),
    bounds,
    egress: createEgressGuard(egressPolicy, egressReport),
    egressReport,
    metricsOptions: {
      cluster: config.cluster,
      node: config.node,
      postgresDsn: config.postgresDsn,
      redisDsn: config.redisDsn,
      mysqlDsn: config.mysqlDsn,
      gpuVendor: config.gpuVendor,
      logUnits: config.logUnits,
      logDockerEnabled: config.logDockerEnabled,
      logLines: config.logLines,
    },
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
