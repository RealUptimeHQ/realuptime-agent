# RealUptime Monitor agent

The RealUptime Monitor agent watches services that the public internet cannot
reach: internal APIs, databases, admin panels, anything behind your firewall or
inside your VPC. It runs on a server you own, pulls its list of checks from
RealUptime over outbound HTTPS, runs them from inside your network, and posts
the results back. It also reports the health of the machine it runs on: CPU,
memory, disk, load, network, top processes, containers, and the status of any
services you name, so a server has charts, history and alert thresholds
without a second agent to install.

It is deliberately small. No inbound ports, no configuration file, no agent
plugins, no log shipping, and no runtime dependencies. Linux, macOS and
Windows Server.

## Install

One line, Linux (Docker if present, otherwise a hardened systemd service under
your existing Node.js 22+):

```
curl -fsSL https://realuptime.io/agent/install.sh | sh -s -- --token rua_your_token_here
```

Docker, one command:

```
docker run -d --name realuptime-agent --restart unless-stopped \
  -e REALUPTIME_TOKEN=rua_your_token_here \
  ghcr.io/realuptimehq/agent:latest
```

The token is shown once, when you register the agent in the RealUptime
dashboard. If you lose it, issue a new one: tokens are stored hashed, so
nobody at RealUptime can read yours back to you.

Verify the image before running it (optional, but this is what
`install.sh` does automatically when `cosign` is on the machine):

```
cosign verify --key https://realuptime.io/.well-known/cosign.pub \
  ghcr.io/realuptimehq/agent:latest
```

**Trust chain.** Every published image is signed with cosign against a key
pair generated for this purpose, with an SPDX software bill of materials and
a provenance attestation (builder, git commit, build time) attached to the
same digest, so a verify confirms both who built it and what's in it, not
just that a signature exists. `install.sh` runs this same check itself on
the Docker path: when `cosign` is present it verifies before the container
starts and logs the result; when `cosign` is absent it says so plainly and
runs the image unverified rather than silently skipping the check. Either
way, verification never blocks the install: an unsigned or unverifiable
image still runs, exactly as it always has for anyone not running `cosign`
at all. Run the command above yourself first if you want that guarantee
before the agent ever starts.

Images are published as `latest` and as the exact git commit SHA that built
them (by the release pipeline), so pin the SHA tag instead of
`latest` if you want a specific build to stay fixed under you.

Docker Compose:

```yaml
services:
  realuptime-agent:
    image: ghcr.io/realuptimehq/agent:latest
    restart: unless-stopped
    environment:
      REALUPTIME_TOKEN: rua_your_token_here
```

### Windows Server

From an elevated PowerShell, with Node.js 22+ installed:

```
iwr -useb https://realuptime.io/agent/install.ps1 | iex; Install-RealUptimeAgent -Token rua_your_token_here
```

This registers a Scheduled Task that starts at boot as `LOCAL SERVICE` and
restarts on failure. It is a task rather than a Windows service on purpose:
`node.exe` is not a Service Control Manager binary, and the usual fix (a
third-party wrapper) would put someone else's code on your machine. If you
already run WinSW, pointing it at `node.exe dist\agent.js` works the same.

### macOS

Install Node.js 22+, download the release tarball, and run it under `launchd`
or the supervisor you already use:

```
REALUPTIME_TOKEN=rua_your_token_here node dist/agent.js
```

### Kubernetes

`deploy/kubernetes/daemonset.yaml` runs one agent per node, reporting the
NODE's health through a read-only mount of its root filesystem at `/host`,
with one token per node held in a Secret (see the comments in the manifest
for the exact `kubectl create secret` line). Set `REALUPTIME_CLUSTER` once
per cluster; the dashboard groups hosts by it.

### apt / yum

Package build scripts and the repository layout are in `packaging/`
(`build-deb.sh`, `build-rpm.sh`, `repo/README.md`). The repositories are not
published yet; the scripts exist so the layout is decided before the first
package, not improvised at publish time.

### From source

Node.js 22 or newer:

```
pnpm install
pnpm --filter @realuptime/agent build
REALUPTIME_TOKEN=rua_your_token_here node dist/agent.js
```

Run it under whatever supervisor you already use. The systemd unit the
installer writes is `packaging/realuptime-agent.service`; the hardening
directives in it are safe to keep. The agent writes nothing to disk.

## Verify the image and the releases

Published images are signed with cosign against a generated key pair, with an
SPDX software bill of materials and a provenance record (builder, git commit,
build time) attached as attestations on the same digest. Release tarballs
ship with a `SHA256SUMS` file signed by the same key; `install.sh` verifies
the checksum always and the signature whenever `cosign` is installed on the
target. See
[docs.realuptime.io/monitor-agent](https://docs.realuptime.io/monitor-agent#verify-the-image)
for the verify command and the public key's stable URL.

## Configuration

Environment variables only. There are no flags and no config file.

| Variable | Required | Default | Purpose |
| --- | --- | --- | --- |
| `REALUPTIME_TOKEN` | Yes (or the file) | none | The `rua_...` agent token from the dashboard. |
| `REALUPTIME_TOKEN_FILE` | No | none | A path to read the token from once, at start. For Kubernetes (one Secret key per node) and Docker/Podman secrets. The only file path the agent accepts from its environment. |
| `REALUPTIME_URL` | No | `https://realuptime.io` | Override only for a self-hosted or staging deployment. |
| `REALUPTIME_CLUSTER` | No | none | A label: which cluster this host belongs to. The dashboard groups hosts by it. |
| `REALUPTIME_NODE` | No | the hostname | A label: this host's node name. |

A missing token is the only condition that stops the agent. Everything else,
including a rejected token, is retried indefinitely.

The one setting that arrives from the server rather than the environment is
the **service watch list**: the names of services or units you asked the
dashboard to report status for. It can only name a unit (the agent validates
the shape again on receipt), and it is applied on every poll.

## What the agent can do

- Run http, tcp, and dns checks against any address reachable from the machine
  it runs on, including private ranges (`10.0.0.0/8`, `192.168.0.0/16`,
  `127.0.0.1`). Reaching private addresses is the entire point of the agent;
  RealUptime's cloud probes deliberately refuse them.
- Report its own server health once a minute (see
  [Server health metrics](#server-health-metrics) below).
- Open outbound HTTPS on port 443 to one hostname (`realuptime.io` by default)
  to fetch its check list and post results and metrics.
- Hold results and metrics in memory through a connectivity loss and deliver
  them when the link returns.

## Server health metrics

Once a minute the agent takes one sample of the MACHINE it runs on and posts
it, batched through the same buffering and backoff as check results (see
[How it behaves](#how-it-behaves)) but on its own queue, so a problem
delivering metrics can never delay or drop a check result.

| Field | Unit | Linux source | macOS source | Windows source |
| --- | --- | --- | --- | --- |
| CPU used | fraction of TOTAL capacity across all cores, 0 to 1 | `/proc/stat`, delta between two readings | `os.cpus()` delta | `os.cpus()` delta |
| Memory used | bytes, total minus AVAILABLE (not minus free) | `/proc/meminfo` | `vm_stat` (free + inactive + speculative + purgeable pages) | `GlobalMemoryStatusEx` available |
| Disk used | bytes, per mounted filesystem, up to 32 | `/proc/mounts` plus a `statvfs` reading | `df -Pk` | `Win32_LogicalDisk` |
| Load average | raw 1/5/15 minute kernel averages, not normalised by core count | `/proc/loadavg` | `os.loadavg()` | absent (Windows has none) |
| Network | bytes per second in/out per interface, error and drop deltas, up to 32 interfaces | `/proc/net/dev` | `netstat -ibn` | `Get-NetAdapterStatistics` |
| Top processes | pid, executable NAME, CPU fraction of capacity, resident bytes; top 10 by CPU + top 10 by memory | `/proc/[pid]/stat` | `ps -Aceo pid=,pcpu=,rss=,comm=` | `Get-Process` |
| Containers | id, runtime, CPU fraction, memory used and limit, up to 64 | cgroup v2 under `/sys/fs/cgroup` | absent (Docker Desktop runs a VM) | absent |
| Watched services | name and active/inactive/failed/unknown, for the names you listed | `/run/systemd/units/invocation:<unit>` | `launchctl list` | `Get-Service` |

CPU is a fraction of capacity, never a percentage: fully loaded is `1`, not
`100`. Load averages are reported as all three or none; a platform with no
load average never reports a fabricated `0`, which would read as an idle
machine. A family the platform cannot measure is ABSENT from the sample, not
an empty list.

The very first sample after the agent starts establishes a baseline for every
delta (CPU, network rates, per-process and per-container CPU) and is not sent;
the first real data point lands about a minute later. This is expected, not a
bug.

### What a process entry is, and is not

A process is reported by pid and EXECUTABLE NAME only (`comm` on Linux, `ps
-c` on macOS, `ProcessName` on Windows), with its CPU share and resident
memory. The command line, arguments, environment, owner and working directory
are never read and never sent. A process list is the most revealing thing a
server-health collector could send; this is the least revealing shape of it
that still answers "what is eating the box".

### Vantage: host or container

Every metrics batch carries a `vantage`: `host` or `container`. The agent
detects this itself, from evidence the container runtime leaves behind
(`/.dockerenv`, `/run/.containerenv`, the init process's cgroup membership),
and it cannot be configured or overridden: truthfulness about what a reading
describes is not a setting.

**If you run the agent inside a container, its server-health metrics describe
the container, not the underlying host**, and RealUptime records them that
way. The one exception is the Kubernetes DaemonSet arrangement, where the
node's root filesystem is mounted read-only at `/host`: when the agent finds
`/host/proc/stat` it reads the node's `/proc`, `/sys` and `/run` and reports
vantage `host` with detail `host-mount`, because that is what it is measuring.
Practically:

- CPU, memory, and disk figures reflect the container's own cgroup limits and
  writable layer, which can be very different from the host machine's.
- The vantage a token first reports under is pinned. If the agent later
  reports a different vantage on the same token (moved from a container to
  the host, or vice versa), the server refuses the batch (`409`) rather than
  silently appending a different kind of reading to the same history.
  Register a new agent token for the new vantage instead.
- **If your goal is host-local targets** (services bound to `localhost` or a
  host-only interface, or you want the machine's own CPU/memory/disk rather
  than the container's), run the agent with host networking, or directly on
  the host, not inside an isolated container.

## Alert thresholds

Every host has three rules, editable on its server health page in the
dashboard: CPU, memory and disk, each as "at or above N% for M minutes,
clears under N% for M minutes". Disk is judged per filesystem. The defaults
are disk 90% for 2 minutes (clears under 88% for 5), memory 90% used for 5
minutes (clears under 88% for 5), and CPU 90% for 5 minutes, off until you
turn it on. A rule fires only once the reading has held past its line for
the whole window, so a build or a backup does not page you.

## What the agent cannot do

These are limits built into the program, not settings you can turn on:

- **It opens no inbound port.** Nothing can connect to it. It is a client
  only, and there is no listening socket to expose, scan, or firewall.
- **It never runs a shell, and never runs anything the server names.** There
  is no `exec` of a command line, no remote command channel, and nothing in
  the poll response can name a program or a path. The server can tell it
  which addresses to check, how often, and which service NAMES to report the
  status of, and nothing else. On Linux it runs no external program at all:
  every reading is a file under `/proc`, `/sys` or `/run`. On macOS and
  Windows, which expose no such files, it runs a short FIXED list of stock
  read-only OS programs with FIXED arguments: `vm_stat`, `df -Pk`,
  `netstat -ibn`, `ps -Aceo pid=,pcpu=,rss=,comm=`, `launchctl list`,
  `sw_vers -productVersion` on macOS; one constant `powershell.exe` script
  (`Get-CimInstance Win32_LogicalDisk`, `Get-NetAdapterStatistics`,
  `Get-Process`, `Get-Service`) with `wmic logicaldisk` as a fallback on
  Windows. The list is `ALLOWED_COMMANDS` in `platform.ts`; anything else is
  refused before it is looked up. A watched service name is applied to the
  output in this process, after a listing of ALL services returns, so no
  operator-typed name ever reaches a command line.
- **It reads no configuration file, no credentials, and none of your data.**
  Its complete configuration input is the environment variables above (plus
  the one token file, when you point it at one). What it DOES read is a
  small, fixed set of read-only files the Linux kernel exposes about the
  machine itself: `/proc/stat`, `/proc/meminfo`, `/proc/loadavg`,
  `/proc/mounts`, `/proc/net/dev`, `/proc/[pid]/stat`, `/etc/os-release`,
  cgroup v2 control files under `/sys/fs/cgroup`, and the existence of
  `/run/systemd/units/invocation:<unit>` for a unit you named, plus a
  `statvfs` call per mounted filesystem. There is no directory traversal
  and no path from the server can tell it to read anything else: every
  per-entity path segment (a pid, a cgroup directory, a unit name) passes a
  conservative character-class check first.
- **It writes no files.** The result and metrics queues are in memory.
  Nothing is spooled to disk.
- **It does not read your data.** For an http check it reads the status line
  and immediately aborts the response body; the body is never buffered, never
  inspected, and never logged. A tcp check writes nothing to the socket and
  reads nothing from it. A dns check reads only the records it queried for.
- **It sends nothing but check results and server health.** Each check result
  is a check id, up or down, an http status code where there is one, a
  latency in milliseconds, an error string when the check failed, and the
  timestamp of the observation. Each metrics sample is the table above:
  numbers, interface names, executable names, container ids, and the
  status of services you asked about. Never a command line, a file listing,
  or file contents. No inventory, no environment dump.
- **It is not a remote access tool.** There is no mechanism in this program by
  which RealUptime, or anyone who compromised RealUptime, could run anything on
  your machine.

Log lines are single-line JSON, deliberately small, and every string field is
truncated at 200 characters so that no future diagnostic field can turn your
logs into a data leak.

The whole program is a few thousand lines of TypeScript with **zero runtime
dependencies**, and it is in this repository. A security review is a short
afternoon, which is how it was designed.

## Sizing and network

- Outbound only, TCP 443, one hostname.
- The agent polls for its check list every 60 seconds and flushes results every
  15 seconds, so traffic to RealUptime is a handful of small requests per
  minute regardless of how many checks it runs.
- Memory use is bounded: at most 1000 buffered results plus 1000 buffered
  metrics samples plus the process itself, which in practice is a container
  using tens of megabytes.
- Run more than one agent when you want redundancy or coverage of several
  networks. Each gets its own token and its own check assignments. Do not
  reuse one token for two agents: check results from both interleave in one
  history, and if the two run from different vantages (one on the host, one
  in a container) the second's metrics are refused outright rather than
  silently mixed into the first's.

## How it behaves

**Check scheduling.** The agent runs on a 15 second tick. Each check fires on
its own interval, rounded up to the next tick. A newly assigned check runs
immediately rather than waiting out its first interval, and a deleted one stops
at the next poll.

**Connectivity loss.** Results queue in memory, up to 1000 of them. Delivery
retries with exponential backoff starting at 15 seconds and capping at 5
minutes, so an outage does not turn into a request flood. When the link
returns, everything held is delivered in batches of 100, with each result
carrying the timestamp of when the check actually ran. Your history shows what
happened during the outage, at the times it happened.

If the queue fills before the link returns, the oldest results are dropped to
make room for the newest, and the number dropped is logged as a warning. A gap
in your data is always a gap you were told about.

**Timestamps.** `checkedAt` is stamped when the check runs, never when it is
delivered.

**Server health.** One sample is collected every 60 seconds, on its own
buffer and backoff, separate from check results (see
[Server health metrics](#server-health-metrics)). Results are always flushed
before metrics on any given tick, so nothing about the metrics endpoint can
delay or displace a check result. On an operating system with no collector,
or a Linux sandbox with no `/proc`, the agent logs one warning line and skips
metrics collection entirely; checks are unaffected.

**Protocol.** Metrics are posted as protocol version 2. A v1 server ignores
the new families and keeps the core sample; a v2 server stores them. Either
direction of version skew keeps working.

## Troubleshooting

**`configuration error` and the container exits immediately.**
`REALUPTIME_TOKEN` is unset or empty (and no readable `REALUPTIME_TOKEN_FILE`
was given). This is the only condition that stops the agent.

**`agent token rejected` repeating every 5 minutes.**
The token is wrong or was revoked. Issue a new agent token in the dashboard and
restart the agent with it. The agent deliberately does not exit: it keeps
retrying at a slow fixed interval, so a token revoked by mistake and reissued
is picked up within five minutes without anyone touching the server. Buffered
results are held meanwhile.

**`poll failed` or `flush failed, holding results`.**
The agent cannot reach RealUptime. Check outbound HTTPS on port 443 from the
machine. Results are being held and will be delivered when the link returns.

**`agent metrics vantage rejected by server`.**
This token has already reported server health from a different vantage (host
versus container). Register a new agent token for where the agent now runs.
Checks are unaffected.

**`vm_stat unavailable` / `PowerShell collection unavailable` (once).**
The macOS or Windows collector could not run one of its fixed commands; it
falls back to the best reading it has and says so once. The rest of the
sample is unaffected.
