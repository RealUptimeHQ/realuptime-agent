#!/bin/sh
# Builds realuptime-agent_<ver>_all.deb from the release tree (REA-181).
# Needs dpkg-deb (Debian/Ubuntu, or `brew install dpkg`). Packaging only:
# the lead signs and publishes to the apt repository by hand (repo/README.md).
#
#   apps/agent/packaging/build-deb.sh
#
# The package depends on nodejs (>= 22), installs to /opt/realuptime-agent,
# ships the systemd unit, creates the realuptime-agent system user in postinst
# and leaves /etc/realuptime-agent/env for the operator to write:
#
#   sudo install -m 0600 /dev/stdin /etc/realuptime-agent/env <<< 'REALUPTIME_TOKEN=rua_...'
#   sudo systemctl enable --now realuptime-agent
set -eu

HERE="$(cd "$(dirname "$0")" && pwd)"
AGENT="$(cd "$HERE/.." && pwd)"
OUT="$HERE/out"
VERSION="$(node -p "require('$AGENT/package.json').version")"
command -v dpkg-deb >/dev/null 2>&1 || { echo "dpkg-deb not installed" >&2; exit 1; }
[ -d "$AGENT/dist" ] || { echo "run build-release.sh first (no dist/)" >&2; exit 1; }

PKG="$(mktemp -d)/realuptime-agent_${VERSION}_all"
mkdir -p "$PKG/DEBIAN" "$PKG/opt/realuptime-agent" "$PKG/lib/systemd/system" "$PKG/etc/realuptime-agent"
cp -R "$AGENT/dist" "$PKG/opt/realuptime-agent/dist"
cp "$AGENT/package.json" "$PKG/opt/realuptime-agent/"
cp "$HERE/realuptime-agent.service" "$PKG/lib/systemd/system/realuptime-agent.service"

cat > "$PKG/DEBIAN/control" <<CONTROL
Package: realuptime-agent
Version: $VERSION
Section: admin
Priority: optional
Architecture: all
Depends: nodejs (>= 22)
Maintainer: RealUptime <support@realuptime.io>
Homepage: https://docs.realuptime.io/monitor-agent
Description: RealUptime Monitor agent
 Outbound-only monitoring agent: runs checks against private targets from
 inside your network and reports server health (CPU, memory, disk, load,
 network, processes, containers, watched services). No inbound port, no
 config file beyond the token, zero runtime dependencies.
CONTROL

cat > "$PKG/DEBIAN/postinst" <<'POSTINST'
#!/bin/sh
set -e
if ! id realuptime-agent >/dev/null 2>&1; then
  adduser --system --group --no-create-home --shell /usr/sbin/nologin realuptime-agent
fi
chmod 0750 /etc/realuptime-agent
if [ ! -f /etc/realuptime-agent/env ]; then
  echo "realuptime-agent: write REALUPTIME_TOKEN=rua_... to /etc/realuptime-agent/env (mode 0600), then: systemctl enable --now realuptime-agent"
fi
systemctl daemon-reload >/dev/null 2>&1 || true
if systemctl is-enabled realuptime-agent >/dev/null 2>&1; then
  systemctl restart realuptime-agent >/dev/null 2>&1 || true
fi
POSTINST
chmod 0755 "$PKG/DEBIAN/postinst"

cat > "$PKG/DEBIAN/prerm" <<'PRERM'
#!/bin/sh
set -e
if [ "$1" = "remove" ]; then
  systemctl disable --now realuptime-agent >/dev/null 2>&1 || true
fi
PRERM
chmod 0755 "$PKG/DEBIAN/prerm"

echo "/etc/realuptime-agent/env" > "$PKG/DEBIAN/conffiles"
: > "$PKG/etc/realuptime-agent/env"
chmod 0600 "$PKG/etc/realuptime-agent/env"

mkdir -p "$OUT"
dpkg-deb --build --root-owner-group "$PKG" "$OUT/realuptime-agent_${VERSION}_all.deb"
echo "built $OUT/realuptime-agent_${VERSION}_all.deb"
