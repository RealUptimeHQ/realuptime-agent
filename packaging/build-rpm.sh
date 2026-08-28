#!/bin/sh
# Builds realuptime-agent-<ver>-1.noarch.rpm from the release tree (REA-181).
# Needs rpmbuild (Fedora/RHEL/Rocky, or `brew install rpm`). Packaging only:
# the lead signs (rpm --addsign) and publishes to the yum repository by hand
# (repo/README.md).
#
#   apps/agent/packaging/build-rpm.sh
set -eu

HERE="$(cd "$(dirname "$0")" && pwd)"
AGENT="$(cd "$HERE/.." && pwd)"
OUT="$HERE/out"
VERSION="$(node -p "require('$AGENT/package.json').version")"
command -v rpmbuild >/dev/null 2>&1 || { echo "rpmbuild not installed" >&2; exit 1; }
[ -d "$AGENT/dist" ] || { echo "run build-release.sh first (no dist/)" >&2; exit 1; }

TOP="$(mktemp -d)"
mkdir -p "$TOP/BUILD" "$TOP/RPMS" "$TOP/SOURCES" "$TOP/SPECS" "$TOP/SRPMS" "$OUT"
SRC="$TOP/SOURCES/realuptime-agent-$VERSION"
mkdir -p "$SRC"
cp -R "$AGENT/dist" "$SRC/dist"
cp "$AGENT/package.json" "$SRC/"
cp "$HERE/realuptime-agent.service" "$SRC/"
( cd "$TOP/SOURCES" && tar -czf "realuptime-agent-$VERSION.tar.gz" "realuptime-agent-$VERSION" )

sed "s/@VERSION@/$VERSION/g" "$HERE/realuptime-agent.spec" > "$TOP/SPECS/realuptime-agent.spec"
rpmbuild --define "_topdir $TOP" -bb "$TOP/SPECS/realuptime-agent.spec"
cp "$TOP"/RPMS/noarch/realuptime-agent-*.rpm "$OUT/"
echo "built:"; ls -1 "$OUT"/realuptime-agent-*.rpm
