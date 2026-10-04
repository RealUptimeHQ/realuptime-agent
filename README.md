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

**The `ghcr.io/realuptimehq/agent` package is not public yet** (REA-601).
Until RealUptime flips that in GitHub's package settings, an anonymous
`docker pull` or `docker run` against it fails with `unauthorized` -- which
includes the Docker half of the one-liner above, on any host where Docker is
already installed and usable, since that is the path it picks by default.
`install.sh` says exactly this (not a bare docker error) when a pull is
denied, and names the fix: force the systemd install instead, which needs
only Node.js 22+ and no Docker at all:

```
curl -fsSL https://realuptime.io/agent/install.sh | sh -s -- --token rua_your_token_here --method systemd
```

Once the package is public, both paths work with no flag needed, and this
note goes away.

Docker, one command (works once the package above is public):

```
docker run -d --name realuptime-agent --restart unless-stopped \
  --network host \
  -e REALUPTIME_TOKEN=rua_your_token_here \
  ghcr.io/realuptimehq/agent:latest
```

`--network host` is part of the command, not an option (REA-780). An agent
watching its own host has to share that host's network: without the flag the
container gets a network of its own, `127.0.0.1` inside it is the container,
and every check pointed at a host-local service is refused forever while the
service is healthy. Drop it only when the container itself is what you mean
to watch. The agent detects the isolated case from `/sys/class/net` and
`/proc/net/route` (`host-network.ts`), logs it at startup, and reports it
with its host identity so the dashboard can explain the refusal instead of
repeating it.

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

The systemd install pins to no version by default: `--version latest`
resolves the most recent `agent-*` release on this project's public mirror,
[github.com/RealUptimeHQ/realuptime-agent](https://github.com/RealUptimeHQ/realuptime-agent),
through the GitHub API (never the private monorepo, which an anonymous
request cannot reach at all -- REA-601). Pin a specific build with
`--version 0.3.1` (or `REALUPTIME_AGENT_VERSION=0.3.1`), and see what a run
would resolve without installing anything with `install.sh --print-version`
(no token needed).

## Configuration

Environment variables only. There are no flags and no config file. The one
file you may point it at besides the token file is the secrets file, which
holds values for authenticated checks and cannot change what the agent does.

| Variable | Required | Default | Purpose |
| --- | --- | --- | --- |
| `REALUPTIME_TOKEN` | Yes (or the file) | none | The `rua_...` agent token from the dashboard. |
| `REALUPTIME_TOKEN_FILE` | No | none | A path to read the token from once, at start. For Kubernetes (one Secret key per node) and Docker/Podman secrets. The only file path the agent accepts from its environment. |
| `REALUPTIME_URL` | No | `https://ingest.realuptime.io` | Override only for a self-hosted or staging deployment. `https://realuptime.io` serves the same agent routes. |
| `REALUPTIME_CLUSTER` | No | none | A label: which cluster this host belongs to. The dashboard groups hosts by it. |
| `REALUPTIME_NODE` | No | the hostname | A label: this host's node name. |
| `REALUPTIME_POSTGRES_DSN` | No | none | A `postgresql://user:password@host:port/db` connection string. Off by default: set it to have this agent also report PostgreSQL health (connections, database sizes, cache hit ratio, longest running query, replication lag). See [PostgreSQL metrics](#postgresql-metrics) below. |
| `REALUPTIME_REDIS_DSN` | No | none | A `redis://[:password@]host:port[/db]` connection string. Off by default: set it to have this agent also report Redis/Valkey health (memory used, connected clients, hit ratio, evicted keys). See [Redis metrics](#redis-metrics) below. |
| `REALUPTIME_MYSQL_DSN` | No | none | A `mysql://user:password@host:port/db` connection string. Off by default: set it to have this agent also report MySQL/MariaDB health (connections, threads running, slow queries, buffer pool hit ratio, uptime, replication lag). See [MySQL metrics](#mysql-metrics) below. |
| `REALUPTIME_GPU_VENDOR` | No | `nvidia` | `nvidia`, `amd`, or `intel`. Not a credential, and NVIDIA needs no opt-in: the agent simply looks for `nvidia-smi` on PATH every tick. Set this to `amd` or `intel` only to make an unsupported host say so plainly instead of silently reporting no GPU. See [GPU metrics](#gpu-metrics) below. |
| `REALUPTIME_LOG_UNITS` | No | none | Comma-separated systemd unit names (`nginx,postgresql@16`). Off by default: set it to let this agent capture a short journald tail from those units, but only when the server asks for one. See [Log snapshots](#log-snapshots) below. |
| `REALUPTIME_LOG_DOCKER_ENABLED` | No | `false` | `true` opts this host's already-monitored containers into a `docker logs` tail under the same conditions as `REALUPTIME_LOG_UNITS`. No separate container list. |
| `REALUPTIME_LOG_LINES` | No | `50` | Lines requested per source when a snapshot is captured, clamped to 1-200. |
| `REALUPTIME_EGRESS_POLICY` | No | `report` | `report` or `enforce`. See [Where this agent will dial](#where-this-agent-will-dial) below. Declaring an allowlist flips the default to `enforce`. |
| `REALUPTIME_ALLOW_TARGETS` | No | none | Comma-separated CIDRs, bare addresses, or hostname suffixes (`10.0.0.0/8, fd00::/8, .corp.example.com`). When set, a target outside it is refused before any packet leaves. |
| `REALUPTIME_ALLOW_PORTS` | No | none | Comma-separated ports or ranges (`5432, 8000-8999`). When set, a target on any other port is refused. |
| `REALUPTIME_ALLOW_LOOPBACK` | No | `false` | `true` lets this agent probe `127.0.0.1` and `::1`. Off by default so a container sharing a host network does not become a probe of that host by accident. |
| `REALUPTIME_MIN_INTERVAL_SECONDS` | No | `60` | No check runs faster than this, whatever interval the dashboard assigned. Set it to `30` if you pay for 30 second checks and want them. |
| `REALUPTIME_MAX_CONCURRENT_PROBES` | No | `8` | Probes in flight at once. |
| `REALUPTIME_MAX_PROBES_PER_MINUTE` | No | `600` | Probes started per rolling minute. Past it, the excess is skipped and each skipped check reports the reason rather than going quiet. |
| `REALUPTIME_MAX_ASSIGNED_CHECKS` | No | `250` | Checks this agent accepts from one check list. |
| `REALUPTIME_SECRET_<NAME>` | No | none | The value of a secret an authenticated check references as `${SECRET:<NAME>}`. `NAME` is capital letters, digits and underscores. Read when the check runs, never logged, never sent to RealUptime. See [Authenticated checks](#authenticated-checks) below. |
| `REALUPTIME_SECRETS_FILE` | No | none | A path to a `NAME=value` file, consulted for a name no `REALUPTIME_SECRET_<NAME>` variable sets. Re-read when it changes, so a rotated credential needs no restart. |
| `REALUPTIME_AUTH_HEADERS` | No | none | Comma-separated header names this agent may send a secret in, beyond `Authorization`, `Proxy-Authorization`, `Cookie` and `X-Api-Key` (`X-Internal-Auth, X-Tenant-Key`). Framing and identity headers (`Host`, `Content-Length`, `User-Agent` and the like) are never allowed. |

A missing token is the only condition that stops the agent. Everything else,
including a rejected token, is retried indefinitely. A typo in any of the
optional variables above is ignored and the default stands: a mistyped
hardening setting must not take your monitoring down, and it never widens
anything.

Two settings arrive from the server rather than the environment. The
**service watch list**: the names of services or units you asked the
dashboard to report status for. It can only name a unit (the agent validates
the shape again on receipt), and it is applied on every poll. The **log
snapshot request**: a one-shot "capture on your next check-in" flag, true
only right after a threshold alert fires or clears for this host, or when
you ask for one on demand from the dashboard. It never names a log source --
that stays entirely in the three variables above, which the server never
sees.

## Where this agent will dial

The agent takes its check list from RealUptime over the internet, which makes
that list an instruction channel. This section is the boundary around it, and
every rule in it is enforced on your machine by settings only you can change.

**Cloud metadata endpoints are refused, always.** `169.254.169.254` and every
other documented instance-metadata address, on every cloud, in both address
families. There is no setting that lifts this, because there is no legitimate
uptime check against an endpoint whose read is a credential. Link-local,
multicast, broadcast and reserved addresses are refused on the same terms.

**Public addresses are refused, and by default the refusal is only reported.**
Monitoring a public target is what RealUptime's own regional fleet is for, and
it does that from ten places instead of one, so an agent that cannot reach the
public internet loses you nothing and is worthless to anyone who compromises
RealUptime. This release ships the rule in `report` mode: the agent probes
exactly as it did before and writes one log line per target it would have
refused, so you can see what enforcement would cost before it costs you
anything. Set `REALUPTIME_EGRESS_POLICY=enforce` to turn it on now. A later
agent release makes `enforce` the default.

**You can narrow it further, and only you can widen it.**
`REALUPTIME_ALLOW_TARGETS` and `REALUPTIME_ALLOW_PORTS` are read from this
machine's own environment and never from the check list. That is the point: a
total compromise of RealUptime cannot widen them, because widening them means
editing a file on your server and restarting a process.

A refused target reports as a failed check reading `Blocked by this location's
local policy`, with the rule that refused it. It is never a silent drop, so a
target somebody added that this agent will not dial shows up on your dashboard
as a down monitor rather than as nothing at all. The resolved address stays in
your own logs and is not sent to RealUptime.

**Every address is judged at dial time, on what the name resolves to right
then**, and again on every redirect hop. For a tcp or ping check the approved
addresses are then pinned onto the socket, so the connection cannot follow a
name that moved between the check and the dial. An http check is re-checked per
hop but cannot be pinned the same way (Node's built-in `fetch` exposes no hook
for it without adding a dependency this program deliberately does not have), so
its window is the milliseconds between the agent's lookup and `fetch`'s own.

## Authenticated checks

An internal admin panel or a private API usually needs a credential. The
credential stays on this machine: the check RealUptime sends carries a NAME,
and this agent fills in the value when it runs the check.

In the dashboard, the monitor's Authentication section takes a header and a
value with a reference in it:

```
Authorization: Bearer ${SECRET:BILLING_API_TOKEN}
```

On this machine, set the value:

```
docker run ... -e REALUPTIME_SECRET_BILLING_API_TOKEN=<the token> ...
```

or put `BILLING_API_TOKEN=<the token>` in a file only this service can read and
point `REALUPTIME_SECRETS_FILE` at it. A variable wins over the file when both
set a name.

RealUptime stores and sends the text `Bearer ${SECRET:BILLING_API_TOKEN}` and
nothing else. A stolen check list, a leaked RealUptime database and a
compromised RealUptime server all reveal that a check sends a bearer token
named `BILLING_API_TOKEN`, never the token. The rules, all enforced here:

- **A reference is filled in only in a header value or in the check's user
  name and password** (sent as HTTP Basic), never in the host, path, port or
  query. A check whose address contains a reference is refused before any
  packet leaves, because a secret that can be written into a hostname can be
  sent anywhere.
- **Only header names this machine allows.** `Authorization`,
  `Proxy-Authorization`, `Cookie` and `X-Api-Key`, plus whatever you list in
  `REALUPTIME_AUTH_HEADERS`. RealUptime cannot add one.
- **A missing secret fails the check.** It reports `This location has no
  secret named BILLING_API_TOKEN`. The request is never sent with the
  placeholder text in it, and never sent without the header.
- **The value is sent only to the check's own address.** On a redirect to
  another origin, the credential is left behind.
- **The value never appears anywhere else.** Every resolved value is scrubbed
  from this agent's log lines and from every error it reports to RealUptime,
  including a truncated fragment of one.

Authenticated checks need agent 0.4.0 or later. An older agent is never handed
the reference: RealUptime sends it the check with no address, and it reports
`Check is missing configuration: no url` until it is updated.

## How much this agent will do

Four load bounds, all enforced here rather than on our side, because a check
list is a work order and an unbounded work order is a load generator pointed at
your own infrastructure:

- **No check runs faster than 60 seconds**, whatever the dashboard assigned. If
  your plan includes 30 second checks and you want them from this agent, set
  `REALUPTIME_MIN_INTERVAL_SECONDS=30`. Every clamped check is counted on the
  agent's own log line each minute, so this is visible rather than mysterious.
- **At most 8 probes in flight**, so a hundred checks coming due together is a
  queue and not a burst.
- **At most 600 probes a minute.** That is 100 checks at a 10 second cadence.
  Past it the excess is skipped, and each skipped check reports "This location
  reached its limit of 600 probes a minute and skipped this check" rather than
  going quiet.
- **At most 250 checks from one check list.** A longer list is truncated, in
  the order it arrived, with a log line saying so.

## What the agent can do

- Run http, tcp, dns and ping checks against any address reachable from the
  machine it runs on, including private ranges (`10.0.0.0/8`,
  `192.168.0.0/16`). Reaching private addresses is the entire point of the
  agent; RealUptime's cloud probes deliberately refuse them, and this agent
  refuses the reverse (see [Where this agent will
  dial](#where-this-agent-will-dial) above).
- Report its own server health once a minute (see
  [Server health metrics](#server-health-metrics) below).
- When asked to and only then, capture a small bounded log snapshot from a
  source you opted in locally, and attach it to its next metrics batch (see
  [Log snapshots](#log-snapshots) below).
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

### PostgreSQL metrics

Off by default. Set `REALUPTIME_POSTGRES_DSN` to a `postgresql://` connection
string and the agent reads a short, read-only batch of health metrics from
that instance every tick, alongside the OS-level sample:

- Connection count against the configured `max_connections`.
- Per-database on-disk size, largest first (bounded, so a cluster with an
  unusual number of databases costs a fixed amount of wire payload).
- Buffer cache hit ratio (blocks served from shared_buffers over total block
  reads, cluster-wide).
- The oldest still-running query's age.
- Replication lag, when this instance has replicas.

A role with `pg_monitor` (or superuser) can read every one of these; none of
them touches your table data. Authentication supports trust, cleartext
password, and MD5; SCRAM-SHA-256 (the Postgres 14+ default) is not yet
supported. There is no TLS support in this version: point the DSN at an
instance reachable without one, typically `localhost` or the same private
network the agent already runs on. A DSN that is present but unreachable
(wrong password, database down) costs that tick's PostgreSQL reading only:
the OS-level sample is unaffected, and the agent retries next tick.

### Redis metrics

Off by default. Set `REALUPTIME_REDIS_DSN` to a `redis://` connection string
and the agent reads one `INFO` reply from that instance every tick:

- Memory used, against the configured `maxmemory` when one is set.
- Connected clients.
- Keyspace hit ratio (`keyspace_hits` over hits plus misses).
- Evicted keys.

Every one of these is a plain counter `INFO` already reports; the agent never
issues a command that touches a key. Authentication supports a plain
password (`AUTH`); there is no TLS support in this version, same limitation
and same reasoning as PostgreSQL above. A DSN that is present but
unreachable costs that tick's Redis reading only.

### MySQL metrics

Off by default. Set `REALUPTIME_MYSQL_DSN` to a `mysql://` connection string
and the agent reads a small, read-only set of health metrics from that
instance every tick, alongside the OS-level sample:

- Connection count against the configured `max_connections`.
- Threads actively running a query right now, not merely connected.
- The cumulative slow-query counter.
- The InnoDB buffer pool hit ratio (reads served from memory over total
  logical reads).
- Server uptime.
- Replication lag, when this instance is a replica (`Seconds_Behind_Master`
  or, on MySQL 8.0.22+, `Seconds_Behind_Source`).

This is deliberately not a `SHOW GLOBAL STATUS` dump: that statement returns
several hundred counters, and only the handful above are read out of it. A
monitoring user needs no special grant for the status and variables
statements; the replication statement needs `REPLICATION CLIENT` (MariaDB:
`REPLICATION CLIENT` or `SLAVE MONITOR`) and, absent it, only replication
lag degrades to unavailable rather than losing the whole reading.

Authentication supports `mysql_native_password` only. This client always
offers it, so an account actually configured with
`mysql_native_password` works even against a MySQL 8+ server whose
*default* plugin is `caching_sha2_password` (the server corrects a
mismatched offer with its own `AuthSwitchRequest`, which this client
follows when it names `mysql_native_password`). An account that genuinely
requires `caching_sha2_password` is refused: its "full" authentication path
needs TLS or an RSA public-key exchange this agent does not implement.
Create the monitoring user with `IDENTIFIED WITH mysql_native_password` to
avoid this. There is no TLS support in this version, same limitation as the
other two integrations. A DSN that is present but unreachable costs that
tick's MySQL reading only.

### GPU metrics

Unlike the three integrations above, there is no DSN and no opt-in: on the
default `REALUPTIME_GPU_VENDOR=nvidia` the agent simply looks for
`nvidia-smi` on `PATH` every tick, since reading it needs no credential and
touches nothing but a local, read-only system tool. Per physical GPU:

- Index and name, so a host with more than one card can tell them apart.
- Compute utilization.
- Memory used and total.
- Temperature.
- Power draw against its configured limit (null when the card or its power
  mode does not expose one).

`nvidia-smi` ships with every NVIDIA driver install and is the only GPU
vendor tool broadly deployable across a fleet without a separate SDK: AMD's
`rocm-smi` needs the ROCm stack, and Intel's tooling is newer and less
universally installed. Both are out of scope for this agent version. A host
with no NVIDIA driver reports no GPU family at all, the same silent
treatment as "no Docker socket". Set `REALUPTIME_GPU_VENDOR=amd` or `=intel`
only to make an unsupported host say so plainly: every sample then carries
a GPU family shaped `{ error }` naming the gap, rather than either silently
reporting nothing or guessing at numbers this agent cannot produce.

A GPU is a physical fact about the host, unlike a database connection, so a
tick where `nvidia-smi` is present but errors (driver reinstall in
progress, a card fallen off the bus) is itself reported as `{ error }`
rather than silently omitted: an operator paging on GPU health should see
"nvidia-smi is failing", not nothing.

### Log snapshots

Off by default, and off in a second way even when configured: capturing a log
snapshot is a completely separate event from the once-a-minute metrics
sample above, and normally never happens at all. Set `REALUPTIME_LOG_UNITS`,
`REALUPTIME_LOG_DOCKER_ENABLED`, or both, and the agent becomes ELIGIBLE to
capture a short tail of recent log lines -- but it only actually captures one
when the server asks for it on a poll response, which happens for exactly
two reasons: a threshold alert just fired or cleared for this host, or you
clicked "request a log snapshot" on the agent's dashboard page. The tail is
held in memory and attached to the very next metrics batch; it is never
included on an ordinary tick, and there is no continuous log shipping or
aggregation here at all.

What gets captured, per opt-in source:

- **journald** (`REALUPTIME_LOG_UNITS`, Linux only): `journalctl -u <unit> -n
  <N> --no-pager --output=cat` for each named unit, run with a fixed argv --
  never a shell, never a path the server can influence. Unit names are
  validated the same way the service watch list's names are (a conservative
  character class, no path separators, `.service` appended if you left it
  off).
- **Docker** (`REALUPTIME_LOG_DOCKER_ENABLED=true`, Linux only): `docker logs
  --tail <N> <container-id>` for containers this agent is ALREADY reading
  cgroup metrics from (see [Containers](#server-health-metrics) above).
  There is no separate list of containers to watch for logs; the eligible
  set is exactly the set already being monitored.

Each source is capped at `LOG_SNAPSHOT_DEFAULT_LINES` (50) lines by default,
`LOG_SNAPSHOT_MAX_LINES` (200) at most, each line cut to
`LOG_SNAPSHOT_MAX_LINE_BYTES` (4096) bytes with a truncation marker appended
when it is, and at most `LOG_SNAPSHOT_MAX_SOURCES` (10) sources per snapshot.
The server (`packages/db/server-metrics.ts`) enforces every one of these
caps again on receipt regardless of what the agent sends.

**Privacy, stated plainly: a captured log line may contain a secret.** A
password logged by mistake, an API key in a stack trace, a customer's email
address in an access log -- if your application wrote it to the unit or
container this feature is pointed at, that line ships to RealUptime exactly
as captured. This is why the feature is opt-in **per source** and off by
default: nothing is ever read from journald or Docker unless you name the
unit or turn Docker capture on yourself. A snapshot is small (bounded by the
caps above) and short-lived (deleted with the rest of raw retention, 7 days
on every tier -- see `packages/db/migrations/185_log_snapshots.sql`), but it
is not scrubbed or redacted in this version. **A redaction pass -- stripping
patterns that look like secrets before a snapshot ever leaves this
process -- is explicitly out of scope for this phase and is the gate before
this feature is ever considered for on-by-default anywhere.** Until that
lands, only point `REALUPTIME_LOG_UNITS` or `REALUPTIME_LOG_DOCKER_ENABLED`
at a source whose log lines you are comfortable having RealUptime store
for a week.

## Alert thresholds

Every host has three rules, editable on its server health page in the
dashboard: CPU, memory and disk, each as "at or above N% for M minutes,
clears under N% for M minutes". Disk is judged per filesystem. The defaults
are disk 90% for 2 minutes (clears under 88% for 5), memory 90% used for 5
minutes (clears under 88% for 5), and CPU 90% for 5 minutes, off until you
turn it on. A rule fires only once the reading has held past its line for
the whole window, so a build or a backup does not page you.

## Planned maintenance

Before you restart, patch or reboot the machine, flag the downtime as
expected. The agent does it with its own token, so no account API key has
to live on the box:

```sh
# Docker
docker exec realuptime-agent node dist/agent.js maintenance --minutes 30 --reason "kernel update"
docker exec realuptime-agent node dist/agent.js maintenance --end
# systemd
sudo sh -c 'set -a; . /etc/realuptime-agent/env; exec node /opt/realuptime-agent/dist/agent.js maintenance --status'
```

While the window is active this server raises no offline or health alert,
and every check that runs from this agent, or targets this machine's host
name or a `--host NAME` you add, opens no incident, sends nothing and does
not count against uptime. When it ends (`--end`, or `--minutes` running
out; 15 by default, a day at most) anything still down is reported from
that moment, never backdated. The subcommand makes one call to
`/api/v1/agents/self/maintenance` and exits: 0 on success, 1 on a failed
call, 2 on a usage error. The same window can be opened from the server's
page in the dashboard or with `POST /api/v1/agents/{id}/maintenance`.

## What the agent cannot do

These are limits built into the program, not settings you can turn on:

- **It opens no inbound port.** Nothing can connect to it. It is a client
  only, and there is no listening socket to expose, scan, or firewall.
- **It never runs a shell, and never runs anything the server names.** There
  is no `exec` of a command line, no remote command channel, and nothing in
  the poll response can name a program or a path. The server can tell it
  which addresses to check, how often, which service NAMES to report the
  status of, and (since log snapshots) only WHEN to capture a log tail --
  never WHICH unit or container. For its core OS-level metrics, Linux runs
  no external program at all: every reading is a file under `/proc`, `/sys`
  or `/run`. On macOS and Windows, which expose no such files, it runs a
  short FIXED list of stock read-only OS programs with FIXED arguments:
  `vm_stat`, `df -Pk`, `netstat -ibn`, `ps -Aceo pid=,pcpu=,rss=,comm=`,
  `launchctl list`, `sw_vers -productVersion` on macOS; one constant
  `powershell.exe` script (`Get-CimInstance Win32_LogicalDisk`,
  `Get-NetAdapterStatistics`, `Get-Process`, `Get-Service`) with `wmic
  logicaldisk` as a fallback on Windows. The one exception to "no external
  program on Linux" is log snapshots (see [Log snapshots](#log-snapshots)
  above): `journalctl` and `docker`, and only when you have opted a source
  in locally AND the server has asked for a snapshot right now. The list is
  `ALLOWED_COMMANDS` in `platform.ts`; anything else is refused before it is
  looked up. A watched service name is applied to a full listing in this
  process, after a listing of ALL services returns, so no operator-typed
  name ever reaches a command line; a log snapshot's unit or container name
  is validated against a conservative character class before it becomes an
  argument, and neither one is ever a name the SERVER supplied -- both come
  from this machine's own local configuration or its own prior cgroup/Docker
  discovery.
- **It reads no configuration file and none of your data.**
  Its complete configuration input is the environment variables above (plus
  the token file and the secrets file, when you point it at them). The only
  credentials it reads are the secrets you give it for [authenticated
  checks](#authenticated-checks), and only the ones a check names. What it DOES read is a
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
- **It sends nothing but check results, server health, and -- rarely, and only
  when you have opted a source in -- a log snapshot.** Each check result is a
  check id, up or down, an http status code where there is one, a latency in
  milliseconds, an error string when the check failed, and the timestamp of
  the observation. Each metrics sample is the table above: numbers, interface
  names, executable names, container ids, and the status of services you
  asked about. Never a command line, a file listing, or file contents outside
  the one deliberate exception: a log snapshot, sent only when
  `REALUPTIME_LOG_UNITS` or `REALUPTIME_LOG_DOCKER_ENABLED` is set AND the
  server asked for one, bounded and unredacted -- see [Log
  snapshots](#log-snapshots) above for exactly what that means for privacy.
  No inventory, no environment dump.
- **It is not a remote access tool.** There is no mechanism in this program by
  which RealUptime, or anyone who compromised RealUptime, could run anything on
  your machine.
- **It speaks a closed, finite vocabulary and refuses everything outside it.**
  A check is one of four verbs (http, tcp, dns, ping) and nothing else. An http
  check is a GET with no request body and no server-chosen headers: the only
  headers it adds are the authentication headers this machine allows, filled
  from secrets held on this machine. A tcp check
  writes zero bytes and its port must be a real port and not one of the RFC
  862-865 amplification ports. A dns check may ask for one of six record types
  (A, AAAA, CNAME, MX, TXT, NS) and nothing else, which is why it can never be
  turned into a zone transfer or an `ANY` query. A verb, a record type or a
  port this version of the agent does not recognise is skipped with one log
  line rather than passed through. That is what makes an old agent safe against
  a newer server: a compromised server can reuse the capabilities this binary
  was compiled with, and cannot teach it new ones.

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
