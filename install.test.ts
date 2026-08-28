import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * The installers (REA-181) are served by the website from apps/web/public as
 * byte-identical copies of the files in apps/agent/install, the same
 * hand-kept-duplicate arrangement wire-contract.test.ts pins for json-path.ts.
 * Pinned here so an edit to one copy without the other fails before it
 * ships a different installer to `curl | sh` than the one reviewed in the
 * agent tree. A few structural properties of the scripts are pinned too:
 * the ones a customer's security reviewer would check first.
 */
const HERE = dirname(fileURLToPath(import.meta.url));
const WEB_PUBLIC = join(HERE, "..", "web", "public", "agent");

// In the public mirror (scripts/publish-agent-mirror.mjs) the website tree
// does not exist, so the byte-identity cross-checks against the served
// copies have nothing to compare and skip; the structural pins below still
// run everywhere.
const IN_MONOREPO = existsSync(WEB_PUBLIC);

describe("installers", () => {
  it.skipIf(!IN_MONOREPO)("the served Linux installer is byte-identical to the reviewed one", () => {
    expect(readFileSync(join(WEB_PUBLIC, "install.sh"), "utf8")).toBe(
      readFileSync(join(HERE, "install", "install.sh"), "utf8"),
    );
  });

  it.skipIf(!IN_MONOREPO)("the served Windows installer is byte-identical to the reviewed one", () => {
    expect(readFileSync(join(WEB_PUBLIC, "install.ps1"), "utf8")).toBe(
      readFileSync(join(HERE, "install", "install-windows.ps1"), "utf8"),
    );
  });

  // REA-454: `curl -fsSL .../install.sh | REALUPTIME_TOKEN=... sh` is only as
  // trustworthy as the checksum a customer can check before piping it into a
  // shell. install.sh.sha256 is checked in next to both copies of the
  // script, so an edit to install.sh without regenerating the checksum (run
  // `sha256sum install.sh > install.sh.sha256` in apps/agent/install, then
  // copy it to apps/web/public/agent) fails here instead of shipping a
  // published hash that no longer matches what curl actually fetches.
  it.skipIf(!IN_MONOREPO)("the published SHA256 for the Linux installer matches its actual contents, in both copies", () => {
    const script = readFileSync(join(HERE, "install", "install.sh"));
    const expected = createHash("sha256").update(script).digest("hex");

    const agentSum = readFileSync(join(HERE, "install", "install.sh.sha256"), "utf8").trim();
    const webSum = readFileSync(join(WEB_PUBLIC, "install.sh.sha256"), "utf8").trim();

    expect(agentSum).toBe(`${expected}  install.sh`);
    expect(webSum).toBe(agentSum);
  });

  it("the Linux installer documents how to verify the checksum before piping it into a shell, and carries a version", () => {
    const sh = readFileSync(join(HERE, "install", "install.sh"), "utf8");
    expect(sh).toContain("install.sh.sha256");
    expect(sh).toContain("sha256sum -c");
    expect(sh).toMatch(/INSTALLER_SCRIPT_VERSION="\d+"/);
  });

  it("the Linux installer fails closed, verifies the checksum, and never puts the token on a command line", () => {
    const sh = readFileSync(join(HERE, "install", "install.sh"), "utf8");
    expect(sh).toMatch(/^set -eu$/m);
    expect(sh).toContain("checksum mismatch");
    expect(sh).toContain("cosign verify-blob");
    expect(sh).toContain("--env-file");
    expect(sh).toContain("EnvironmentFile=");
    // The token only ever lands in a 0600 root-owned file or an env file
    // handed to docker; it is never interpolated into a `docker run -e` or
    // an ExecStart line.
    expect(sh).not.toMatch(/-e REALUPTIME_TOKEN=\$TOKEN/);
    expect(sh).not.toMatch(/ExecStart=.*\$TOKEN/);
  });

  // REA-475: the Docker install path gained the same courtesy signature
  // check the tarball path already had -- verify when cosign is present,
  // log honestly and run unverified when it isn't. Never a hard gate.
  it("the Docker install path verifies the image signature with cosign when it is present, and logs honestly when it is not", () => {
    const sh = readFileSync(join(HERE, "install", "install.sh"), "utf8");
    expect(sh).toContain("cosign verify --key");
    expect(sh).toContain("$COSIGN_KEY_URL");
    expect(sh).toMatch(/cosign not found: skipping image signature verification/);
    // The verify call happens before the image is ever run, and the
    // function that does it is called from install_docker.
    const verifyIdx = sh.indexOf("verify_image() {");
    const dockerRunIdx = sh.indexOf("docker run -d --name realuptime-agent");
    expect(verifyIdx).toBeGreaterThan(-1);
    expect(verifyIdx).toBeLessThan(dockerRunIdx);
    expect(sh).toMatch(/verify_image "\$IMAGE"/);
  });

  it("the Windows installer verifies the checksum and runs the agent as LOCAL SERVICE under Task Scheduler", () => {
    const ps = readFileSync(join(HERE, "install", "install-windows.ps1"), "utf8");
    expect(ps).toContain("checksum mismatch");
    expect(ps).toContain("NT AUTHORITY\\LOCAL SERVICE");
    expect(ps).toContain("Register-ScheduledTask");
    expect(ps).toContain("-AtStartup");
  });

  it("the DaemonSet reads the node through /host, one token file per node, as a non-root read-only container", () => {
    const yaml = readFileSync(join(HERE, "deploy", "kubernetes", "daemonset.yaml"), "utf8");
    expect(yaml).toContain("kind: DaemonSet");
    expect(yaml).toContain("mountPath: /host");
    expect(yaml).toContain("readOnly: true");
    expect(yaml).toContain("REALUPTIME_TOKEN_FILE");
    expect(yaml).toContain("/etc/realuptime/tokens/$(NODE_NAME)");
    expect(yaml).toContain("REALUPTIME_CLUSTER");
    expect(yaml).toContain("runAsNonRoot: true");
    expect(yaml).toContain("readOnlyRootFilesystem: true");
    expect(yaml).not.toContain("privileged: true");
  });
});
