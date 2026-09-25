#!/bin/sh
# Builds the agent's release artifacts from a clean checkout (REA-181).
# Packaging only: nothing here publishes. The lead attaches the output to a
# GitHub release tagged `agent-<version>` by hand, the same operational shape
# the official Docker image build documents.
#
#   apps/agent/packaging/build-release.sh [--sign]
#
# Output, in apps/agent/packaging/out/:
#   realuptime-agent-<ver>.tgz   dist/ + package.json, the thing install.sh
#                                unpacks under /opt/realuptime-agent
#   realuptime-agent-<ver>.zip   the same tree, for install-windows.ps1
#   SHA256SUMS                   over both archives
#   SHA256SUMS.sig               cosign signature over SHA256SUMS (--sign,
#                                needs COSIGN_KEY pointing at the private key
#                                whose public half is served at
#                                https://realuptime.io/.well-known/cosign.pub;
#                                the installers verify it when cosign is
#                                present on the target)
#
# Then, if dpkg-deb / rpmbuild are available, build-deb.sh and build-rpm.sh
# produce the packages from the same tree (see repo/README.md for the apt
# and yum repository layout).
set -eu

HERE="$(cd "$(dirname "$0")" && pwd)"
AGENT="$(cd "$HERE/.." && pwd)"
ROOT="$(cd "$AGENT/../.." && pwd)"
OUT="$HERE/out"
SIGN=0
[ "${1:-}" = "--sign" ] && SIGN=1

VERSION="$(node -p "require('$AGENT/package.json').version")"
STAGE="$(mktemp -d)/realuptime-agent-$VERSION"
mkdir -p "$STAGE" "$OUT"

echo "building @realuptime/agent $VERSION"
( cd "$ROOT" && pnpm --filter @realuptime/agent build >/dev/null )
cp -R "$AGENT/dist" "$STAGE/dist"
cp "$AGENT/package.json" "$AGENT/README.md" "$STAGE/"
cp "$HERE/realuptime-agent.service" "$STAGE/"

( cd "$(dirname "$STAGE")" && tar -czf "$OUT/realuptime-agent-$VERSION.tgz" "realuptime-agent-$VERSION" )
if command -v zip >/dev/null 2>&1; then
  ( cd "$STAGE" && zip -qr "$OUT/realuptime-agent-$VERSION.zip" . )
else
  echo "zip not installed; skipping the Windows archive"
fi

( cd "$OUT" && sha256sum realuptime-agent-"$VERSION".tgz realuptime-agent-"$VERSION".zip 2>/dev/null > SHA256SUMS || sha256sum realuptime-agent-"$VERSION".tgz > SHA256SUMS )

if [ "$SIGN" -eq 1 ]; then
  [ -n "${COSIGN_KEY:-}" ] || { echo "--sign needs COSIGN_KEY" >&2; exit 1; }
  ( cd "$OUT" && cosign sign-blob --yes --key "$COSIGN_KEY" --use-signing-config=false --new-bundle-format=false --output-signature SHA256SUMS.sig SHA256SUMS )
fi

echo "artifacts in $OUT:"
ls -1 "$OUT"
