import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
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

  // REA-780. The installer's Docker path is the one most customers get, and
  // without host networking 127.0.0.1 inside the container is the container:
  // every check pointed at a host-local service is refused forever while the
  // service is healthy (2,819 false failures against 22 successes in a day on
  // our own account). Pinned on the same `docker run` line the signature test
  // above already locates, so the flag cannot be dropped silently.
  it("the Docker install path gives the agent the host's network", () => {
    const sh = readFileSync(join(HERE, "install", "install.sh"), "utf8");
    const runLine = sh
      .split("\n")
      .find((line) => line.includes("docker run -d --name realuptime-agent"));
    expect(runLine).toBeDefined();
    expect(runLine).toContain("--network host");
    expect(sh).toContain("REA-780");
  });

  it("the Windows installer verifies the checksum and runs the agent as LOCAL SERVICE under Task Scheduler", () => {
    const ps = readFileSync(join(HERE, "install", "install-windows.ps1"), "utf8");
    expect(ps).toContain("checksum mismatch");
    expect(ps).toContain("NT AUTHORITY\\LOCAL SERVICE");
    expect(ps).toContain("Register-ScheduledTask");
    expect(ps).toContain("-AtStartup");
  });

  // REA-601: the Linux installer used to resolve "latest" by hitting the
  // PRIVATE monorepo's /releases/latest and reading the tag off the
  // redirect. That repository answers an anonymous request with a bare 404
  // (never a redirect), so every default install died with "could not
  // resolve the latest agent release tag". These pin the fix: resolution
  // comes from the PUBLIC mirror's own release list via the GitHub API,
  // filtered to agent-* tags, with an explicit override, and the old broken
  // pattern is gone for good.
  it("the Linux installer resolves the latest release from the public mirror's API, never the private monorepo's redirect", () => {
    const sh = readFileSync(join(HERE, "install", "install.sh"), "utf8");
    expect(sh).toContain("resolve_agent_tag");
    expect(sh).toContain('MIRROR_REPO="realuptimehq/realuptime-agent"');
    // Pinning the shell variable reference literally, not a JS template.
    // biome-ignore lint/suspicious/noTemplateCurlyInString: this is shell source, not a JS template string
    expect(sh).toContain("api.github.com/repos/${MIRROR_REPO}");
    expect(sh).toContain("REALUPTIME_AGENT_VERSION");
    expect(sh).toContain("--print-version");
    // The old, broken redirect-based resolution must not come back.
    expect(sh).not.toContain("github.com/realuptimehq/realuptime/releases/latest");
  });

  it("the Linux installer's tag resolver only ever accepts an agent-* tag (mutation guard)", () => {
    const sh = readFileSync(join(HERE, "install", "install.sh"), "utf8");
    // The filter that would catch a mirror answering with the wrong
    // product's release, or a misconfigured REALUPTIME_AGENT_API_BASE
    // pointed at the wrong repository: a matched tag must start with
    // "agent-", and anything else is a hard failure, never a silent accept.
    expect(sh).toMatch(/agent-\[\^"\]\*"/);
    expect(sh).toMatch(/case "\$tag" in\s*\n\s*agent-\*\) printf/);
    expect(sh).toContain("no agent-* release found there");
  });

  it("the Linux installer checks Node.js 22+ before any network call on the systemd path", () => {
    const sh = readFileSync(join(HERE, "install", "install.sh"), "utf8");
    // Anchored to install_systemd()'s own body: resolve_agent_tag's usage
    // pattern is also quoted verbatim in that function's doc comment further
    // up the file, so a plain indexOf from the top would find the docstring
    // rather than the real call site.
    // Anchored with a leading newline: a plain indexOf("install_systemd() {")
    // finds it as a SUBSTRING of "uninstall_systemd() {" (which is defined
    // earlier), since "un" + "install_systemd..." contains the same text.
    const fnIdx = sh.indexOf("\ninstall_systemd() {");
    expect(fnIdx).toBeGreaterThan(-1);
    const nodeCheckIdx = sh.indexOf("Node.js 22 or newer is required for the systemd install", fnIdx);
    const resolveIdx = sh.indexOf('tag="$(resolve_agent_tag)"', fnIdx);
    expect(nodeCheckIdx).toBeGreaterThan(fnIdx);
    expect(resolveIdx).toBeGreaterThan(fnIdx);
    expect(nodeCheckIdx).toBeLessThan(resolveIdx);
  });

  it("the Linux installer's Docker path names a denied pull plainly, with the systemd fallback, not a bare docker error", () => {
    const sh = readFileSync(join(HERE, "install", "install.sh"), "utf8");
    expect(sh).toContain("the registry denied the request");
    expect(sh).toContain("install with --method systemd instead");
    expect(sh).toMatch(/\*unauthorized\*/);
  });

  it("the Windows installer resolves the latest release from the same public mirror's API, never the private monorepo's redirect", () => {
    const ps = readFileSync(join(HERE, "install", "install-windows.ps1"), "utf8");
    expect(ps).toContain('$MirrorRepo = "realuptimehq/realuptime-agent"');
    expect(ps).toContain("api.github.com/repos/$MirrorRepo");
    expect(ps).toContain("REALUPTIME_AGENT_VERSION");
    expect(ps).toContain("agent-*");
    expect(ps).not.toContain("github.com/realuptimehq/realuptime/releases/latest");
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

/**
 * REA-841: the Docker path is the default whenever Docker is present, and a
 * registry that denies the image pull used to end the install. When Docker
 * was the installer's own pick and Node.js 22 is on the host, it now falls
 * back to the systemd path; an explicit `--method docker` still stops with
 * the explanation. Fake `docker` and `node` on PATH; the systemd path is only
 * followed as far as its first download, which the fake `curl` fails.
 */
describe("install.sh when the agent image cannot be pulled (REA-841)", () => {
  function fakeBin(): string {
    const dir = mkdtempSync(join(tmpdir(), "agent-install-"));
    const bin = join(dir, "bin");
    mkdirSync(bin);
    const write = (name: string, body: string) => {
      writeFileSync(join(bin, name), `#!/bin/sh\n${body}\n`);
      chmodSync(join(bin, name), 0o755);
    };
    write("docker", 'case "$1" in info) exit 0;; rm) exit 0;; run) echo "Error response from daemon: denied: requested access to the resource is denied" >&2; exit 1;; esac; exit 0');
    write("node", 'echo 22');
    write("curl", "exit 22");
    write("cosign", "exit 1");
    write("uname", "echo Linux");
    return bin;
  }
  function run(args: string[]) {
    return spawnSync("sh", [join(HERE, "install", "install.sh"), "--token", "rua_test", ...args], {
      encoding: "utf8",
      env: { PATH: `${fakeBin()}:/usr/bin:/bin`, HOME: tmpdir() },
    });
  }

  it("falls back to the systemd install when Docker was its own pick", () => {
    const result = run([]);
    expect(result.stdout + result.stderr).toContain("installing as a systemd service instead");
  });

  it("stops with the explanation when the customer asked for Docker", () => {
    const result = run(["--method", "docker"]);
    const out = result.stdout + result.stderr;
    expect(result.status).not.toBe(0);
    expect(out).toContain("could not pull");
    expect(out).not.toContain("installing as a systemd service instead");
  });
});

/**
 * The installer must not choose Docker when the image cannot be pulled. The
 * auto-pick used to look only at whether the docker CLI answered, so a host
 * whose pull would fail (a registry that denies it, an architecture the image
 * does not carry, no route to ghcr.io) was sent down the Docker path and
 * recovered only after `docker run` had failed. Now the pick itself pulls
 * first, and falls back to the release binary with a message that names why.
 * Fake `docker`, `node`, `curl` and `uname` on PATH; the binary path is only
 * followed as far as its first download, which the fake `curl` fails.
 */
describe("install.sh picks a method by what can actually be done", () => {
  function fakeEnv(opts: { pull: "ok" | "denied" | "arch" | "offline"; node?: boolean; os?: string }) {
    const dir = mkdtempSync(join(tmpdir(), "agent-install-pick-"));
    const bin = join(dir, "bin");
    mkdirSync(bin);
    const ran = join(dir, "docker-run-called");
    const write = (name: string, body: string) => {
      writeFileSync(join(bin, name), `#!/bin/sh\n${body}\n`);
      chmodSync(join(bin, name), 0o755);
    };
    const pullBody = {
      ok: "exit 0",
      denied: 'echo "Error response from daemon: denied: requested access to the resource is denied" >&2; exit 1',
      arch: 'echo "no matching manifest for linux/arm64/v8 in the manifest list entries" >&2; exit 1',
      offline: 'echo "dial tcp: lookup ghcr.io: no such host" >&2; exit 1',
    }[opts.pull];
    // `docker run` pulls a missing image itself, so it fails exactly when a pull would.
    const runBody =
      opts.pull === "ok"
        ? `: > "${ran}"; echo cid; exit 0`
        : 'echo "Error response from daemon: denied: requested access to the resource is denied" >&2; exit 1';
    write(
      "docker",
      `case "$1" in info) exit 0;; pull) ${pullBody};; rm) exit 0;; run) ${runBody};; esac; exit 0`,
    );
    if (opts.node !== false) write("node", "echo 22");
    write("curl", "exit 22");
    write("cosign", "exit 1");
    write("uname", `echo ${opts.os ?? "Linux"}`);
    write("launchctl", "exit 0");
    write("sudo", 'exec "$@"');
    return { bin, ran };
  }
  function run(env: ReturnType<typeof fakeEnv>, args: string[] = []) {
    const result = spawnSync("sh", [join(HERE, "install", "install.sh"), "--token", "rua_test", ...args], {
      encoding: "utf8",
      env: { PATH: `${env.bin}:/usr/bin:/bin`, HOME: tmpdir() },
    });
    return { out: result.stdout + result.stderr, status: result.status, dockerRan: existsSync(env.ran) };
  }

  it("uses Docker when the image pulls", () => {
    const result = run(fakeEnv({ pull: "ok" }));
    expect(result.dockerRan).toBe(true);
    expect(result.out).toContain("installing with Docker");
    expect(result.status).toBe(0);
  });

  it.each([
    ["a registry that denies the pull", "denied"],
    ["an architecture the image does not carry", "arch"],
    ["no route to the registry", "offline"],
  ] as const)("does not choose Docker for %s, and installs the binary instead", (_label, pull) => {
    const result = run(fakeEnv({ pull }));
    expect(result.dockerRan).toBe(false);
    expect(result.out).not.toContain("installing with Docker");
    expect(result.out).toContain("could not pull ghcr.io/realuptimehq/agent:latest");
    expect(result.out).toContain("installing the release binary instead");
  });

  it("names both problems when the image cannot be pulled and Node.js 22+ is missing", () => {
    const result = run(fakeEnv({ pull: "denied", node: false }));
    expect(result.dockerRan).toBe(false);
    expect(result.status).not.toBe(0);
    expect(result.out).toContain("could not pull ghcr.io/realuptimehq/agent:latest");
    expect(result.out).toContain("Node.js 22");
  });

  it("an explicit --method docker still tries Docker and stops with the explanation", () => {
    const result = run(fakeEnv({ pull: "denied" }), ["--method", "docker"]);
    expect(result.status).not.toBe(0);
    expect(result.out).toContain("could not pull");
  });

  it("on macOS it installs the release binary as a launchd daemon, never Docker", () => {
    const result = run(fakeEnv({ pull: "ok", os: "Darwin" }));
    expect(result.dockerRan).toBe(false);
    expect(result.out).toContain("installing the release binary as a launchd daemon");
  });
});

describe("install.sh on macOS", () => {
  const sh = readFileSync(join(HERE, "install", "install.sh"), "utf8");

  it("runs the daemon as an unprivileged user, with the token in a file only that user can read", () => {
    expect(sh).toContain("io.realuptime.agent");
    expect(sh).toContain("<key>UserName</key>");
    expect(sh).toMatch(/chown nobody/);
    expect(sh).not.toMatch(/<key>REALUPTIME_TOKEN<\/key>/);
  });

  it("checks the release checksum with shasum when sha256sum is absent", () => {
    expect(sh).toContain("shasum -a 256");
  });
});
