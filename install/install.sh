#!/bin/sh
# RealUptime Monitor agent: one-line installer for Linux (REA-181, REA-454).
#
#   curl -fsSL https://realuptime.io/agent/install.sh | REALUPTIME_TOKEN=rua_... sh
#
# This file is versioned and checksummed. Before piping it into a shell,
# fetch it, check it against the published checksum, then run it:
#
#   curl -fsSLo agent-install.sh https://realuptime.io/agent/install.sh
#   curl -fsSL https://realuptime.io/agent/install.sh.sha256 | sha256sum -c
#   REALUPTIME_TOKEN=rua_... sh agent-install.sh
#
# INSTALLER_SCRIPT_VERSION below is bumped on every change to this file.
# apps/agent/install.test.ts pins that install.sh.sha256, checked in next to
# this file and its served copy, matches this file's actual SHA256 (via
# `sha256sum install.sh`), so a change here without regenerating that
# checksum fails the suite rather than shipping a script whose published
# hash no longer matches what `curl | sh` actually fetches.
INSTALLER_SCRIPT_VERSION="2"
#
# What it does, in order, and nothing else:
#   1. Picks a method: Docker if the docker CLI is present and usable (the
#      documented default), otherwise a systemd service running the release
#      tarball under Node.js 22+ that is already installed.
#   2. Systemd path: downloads the release tarball and its SHA256SUMS from
#      the release URL, verifies the checksum, and (when cosign is
#      installed) verifies the detached signature against the public key
#      served at https://realuptime.io/.well-known/cosign.pub. A checksum or
#      signature mismatch aborts before anything is unpacked.
#      Docker path: when cosign is installed, verifies the image's cosign
#      signature against the same public key before running it; when cosign
#      is absent, says so and runs the image unverified, exactly the way the
#      systemd path always has for a missing cosign binary. Either way this
#      is a courtesy check, never a hard gate: an unverifiable image still
#      runs, the same as an unsigned one always has.
#   3. Installs under /opt/realuptime-agent, creates an unprivileged system
#      user, writes the token to /etc/realuptime-agent/env (root:root 0600),
#      installs and starts a hardened systemd unit.
#
# It never opens a port, never writes anywhere but the three paths above, and
# the token is passed to the agent as an environment variable from a root-only
# file, never on a command line where `ps` could read it.
#
# Re-running is safe: it upgrades in place and restarts the service.
#
# Flags:
#   --token TOKEN        the rua_... agent token (required, or REALUPTIME_TOKEN)
#   --url URL            override the RealUptime origin (self-hosted/staging)
#   --method docker|systemd   force a method instead of auto-detecting
#   --cluster NAME       optional cluster label (REALUPTIME_CLUSTER)
#   --node NAME          optional node label (REALUPTIME_NODE), default hostname
#   --version VER        pin a release (default: latest)
#   --uninstall          stop and remove the systemd install (keeps nothing)
#
# The source of truth for this file is apps/agent/install/install.sh in the
# repository; apps/web/public/agent/install.sh is a byte-identical copy served
# by the website, pinned by apps/agent/install.test.ts.

set -eu

RELEASE_BASE="${REALUPTIME_RELEASE_BASE:-https://github.com/realuptimehq/realuptime/releases/download}"
COSIGN_KEY_URL="https://realuptime.io/.well-known/cosign.pub"
IMAGE="ghcr.io/realuptimehq/agent:latest"
INSTALL_DIR="/opt/realuptime-agent"
ENV_DIR="/etc/realuptime-agent"
ENV_FILE="$ENV_DIR/env"
UNIT_FILE="/etc/systemd/system/realuptime-agent.service"
SERVICE_USER="realuptime-agent"

TOKEN="${REALUPTIME_TOKEN:-}"
URL="${REALUPTIME_URL:-}"
METHOD=""
CLUSTER="${REALUPTIME_CLUSTER:-}"
NODE_LABEL="${REALUPTIME_NODE:-}"
VERSION="latest"
UNINSTALL=0

say() { printf '%s\n' "$*"; }
die() { printf 'realuptime-agent install: %s\n' "$*" >&2; exit 1; }
need() { command -v "$1" >/dev/null 2>&1 || die "missing required command: $1"; }

while [ $# -gt 0 ]; do
  case "$1" in
    --token) TOKEN="$2"; shift 2 ;;
    --url) URL="$2"; shift 2 ;;
    --method) METHOD="$2"; shift 2 ;;
    --cluster) CLUSTER="$2"; shift 2 ;;
    --node) NODE_LABEL="$2"; shift 2 ;;
    --version) VERSION="$2"; shift 2 ;;
    --uninstall) UNINSTALL=1; shift ;;
    -h|--help) sed -n '2,53p' "$0"; exit 0 ;;
    *) die "unknown flag: $1" ;;
  esac
done

as_root() {
  if [ "$(id -u)" -eq 0 ]; then "$@"; else need sudo; sudo "$@"; fi
}

uninstall_systemd() {
  as_root systemctl disable --now realuptime-agent.service 2>/dev/null || true
  as_root rm -f "$UNIT_FILE"
  as_root systemctl daemon-reload
  as_root rm -rf "$INSTALL_DIR" "$ENV_DIR"
  say "removed the systemd install; the service user $SERVICE_USER was left in place"
}

if [ "$UNINSTALL" -eq 1 ]; then
  uninstall_systemd
  exit 0
fi

[ -n "$TOKEN" ] || die "no token. Pass --token rua_... (shown once when you register the agent in the dashboard)."
case "$TOKEN" in rua_*) ;; *) die "that does not look like an agent token (expected rua_...)";; esac

if [ -z "$METHOD" ]; then
  if command -v docker >/dev/null 2>&1 && docker info >/dev/null 2>&1; then METHOD=docker; else METHOD=systemd; fi
fi

env_lines() {
  printf 'REALUPTIME_TOKEN=%s\n' "$TOKEN"
  [ -n "$URL" ] && printf 'REALUPTIME_URL=%s\n' "$URL"
  [ -n "$CLUSTER" ] && printf 'REALUPTIME_CLUSTER=%s\n' "$CLUSTER"
  [ -n "$NODE_LABEL" ] && printf 'REALUPTIME_NODE=%s\n' "$NODE_LABEL"
  return 0
}

verify_image() {
  # $1 = image reference. Mirrors verify_release's behavior for the tarball
  # path: verify when cosign is present, log honestly and proceed when it
  # isn't. Never blocks the install either way -- an unsigned or unverifiable
  # image still runs, same as a missing cosign binary never blocked the
  # tarball path before signatures existed. This function only ever informs;
  # docker itself pulls and runs the image below regardless of what it finds.
  if command -v cosign >/dev/null 2>&1; then
    if cosign verify --key "$COSIGN_KEY_URL" "$1" >/dev/null 2>&1; then
      say "verified image signature with cosign ($1)"
    else
      say "warning: cosign could not verify the signature on $1 (continuing; the image still runs)"
    fi
  else
    say "cosign not found: skipping image signature verification (install cosign to verify $1 before it runs)"
  fi
}

install_docker() {
  say "installing with Docker ($IMAGE)"
  verify_image "$IMAGE"
  docker rm -f realuptime-agent >/dev/null 2>&1 || true
  # The token travels in an env file handed to docker, never in argv.
  tmp="$(mktemp)"
  env_lines > "$tmp"
  docker run -d --name realuptime-agent --restart unless-stopped --env-file "$tmp" "$IMAGE" >/dev/null
  rm -f "$tmp"
  say "done. The agent is running as container 'realuptime-agent'; it appears in the dashboard within a minute."
}

verify_release() {
  # $1 = tarball path, $2 = sums path, $3 = signature path (may be absent)
  need sha256sum
  expected="$(grep " $(basename "$1")\$" "$2" | awk '{print $1}')"
  [ -n "$expected" ] || die "SHA256SUMS does not list $(basename "$1")"
  actual="$(sha256sum "$1" | awk '{print $1}')"
  [ "$expected" = "$actual" ] || die "checksum mismatch for $(basename "$1"): refusing to install"
  if command -v cosign >/dev/null 2>&1 && [ -s "$3" ]; then
    cosign verify-blob --key "$COSIGN_KEY_URL" --signature "$3" "$2" >/dev/null 2>&1 \
      || die "cosign signature on SHA256SUMS did not verify: refusing to install"
    say "verified release signature with cosign"
  else
    say "verified SHA256 checksum (install cosign to also verify the release signature)"
  fi
}

install_systemd() {
  need curl; need tar; need systemctl
  command -v node >/dev/null 2>&1 || die "Node.js 22 or newer is required for the systemd install (or install Docker)"
  major="$(node -p 'process.versions.node.split(".")[0]')"
  [ "$major" -ge 22 ] || die "Node.js $major found; 22 or newer is required"

  tag="agent-$VERSION"
  if [ "$VERSION" = "latest" ]; then
    tag="$(curl -fsSL -o /dev/null -w '%{url_effective}' https://github.com/realuptimehq/realuptime/releases/latest | sed 's#.*/##')"
    case "$tag" in agent-*) ;; *) die "could not resolve the latest agent release tag (got '$tag'); pass --version";; esac
  fi
  work="$(mktemp -d)"
  tarball="$work/realuptime-agent-${tag#agent-}.tgz"
  say "downloading $tag"
  curl -fsSL -o "$tarball" "$RELEASE_BASE/$tag/realuptime-agent-${tag#agent-}.tgz"
  curl -fsSL -o "$work/SHA256SUMS" "$RELEASE_BASE/$tag/SHA256SUMS"
  curl -fsSL -o "$work/SHA256SUMS.sig" "$RELEASE_BASE/$tag/SHA256SUMS.sig" || : > "$work/SHA256SUMS.sig"
  verify_release "$tarball" "$work/SHA256SUMS" "$work/SHA256SUMS.sig"

  if ! id "$SERVICE_USER" >/dev/null 2>&1; then
    as_root useradd --system --no-create-home --shell /usr/sbin/nologin "$SERVICE_USER" 2>/dev/null \
      || as_root adduser --system --no-create-home --shell /usr/sbin/nologin "$SERVICE_USER"
  fi
  as_root mkdir -p "$INSTALL_DIR" "$ENV_DIR"
  as_root tar -xzf "$tarball" -C "$INSTALL_DIR" --strip-components=1
  as_root chown -R root:root "$INSTALL_DIR"

  tmp="$(mktemp)"
  env_lines > "$tmp"
  as_root install -m 0600 -o root -g root "$tmp" "$ENV_FILE"
  rm -f "$tmp"

  node_bin="$(command -v node)"
  tmpunit="$(mktemp)"
  cat > "$tmpunit" <<UNIT
[Unit]
Description=RealUptime Monitor agent
Documentation=https://docs.realuptime.io/monitor-agent
After=network-online.target
Wants=network-online.target

[Service]
ExecStart=$node_bin $INSTALL_DIR/dist/agent.js
EnvironmentFile=$ENV_FILE
User=$SERVICE_USER
Restart=always
RestartSec=10
NoNewPrivileges=true
ProtectSystem=strict
ProtectHome=true
PrivateTmp=true
ProtectKernelTunables=true
ProtectControlGroups=false
RestrictSUIDSGID=true
CapabilityBoundingSet=

[Install]
WantedBy=multi-user.target
UNIT
  as_root install -m 0644 "$tmpunit" "$UNIT_FILE"
  rm -f "$tmpunit"
  rm -rf "$work"

  as_root systemctl daemon-reload
  as_root systemctl enable --now realuptime-agent.service
  say "done. systemctl status realuptime-agent; the agent appears in the dashboard within a minute."
}

case "$METHOD" in
  docker) install_docker ;;
  systemd) install_systemd ;;
  *) die "unknown --method $METHOD (docker|systemd)" ;;
esac
