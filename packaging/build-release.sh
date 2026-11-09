#!/bin/sh
# Builds the agent's release artifacts from a clean checkout (REA-181).
# Packaging only: nothing here publishes. The lead attaches the output to a
# GitHub release tagged `agent-<version>` by hand, the same operational shape
# the official Docker image build documents.
#
#   agent/packaging/build-release.sh [--sign]
#
# Output, in agent/packaging/out/:
#   realuptime-agent-<ver>.tgz   dist/ + package.json, the thing install.sh
#                                unpacks under /opt/realuptime-agent
#   realuptime-agent-<ver>.zip   the same tree, for install-windows.ps1
#   realuptime-agent-<ver>-linux-x64, -linux-arm64
#                                standalone executables with Node.js built
#                                in (build-binary.sh), which install.sh uses
#                                on a host with neither Node.js nor Docker
#   realuptime-agent-go-<ver>-{linux-x64,linux-arm64,darwin-x64,darwin-arm64,
#                                windows-x64.exe}
#                                the Go build (agent-go), static, which
#                                install.sh --build go and install-windows.ps1
#                                -Build go install; built when Go is on PATH
#   SHA256SUMS                  over the archives and the executables
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

REALUPTIME_AGENT_BINARY_TARGETS="linux-x64 linux-arm64" sh "$HERE/build-binary.sh"

GO_BUILDS=""
if command -v go >/dev/null 2>&1; then
  GO_OUT="$(mktemp -d)"
  sh "$ROOT/agent-go/packaging/build-release.sh" "$VERSION" "$GO_OUT"
  mv "$GO_OUT"/realuptime-agent-go-"$VERSION"-* "$OUT/"
  rm -rf "$GO_OUT"
  GO_BUILDS="$(cd "$OUT" && ls realuptime-agent-go-"$VERSION"-*)"
else
  echo "go not installed; skipping the Go build"
fi

# shellcheck disable=SC2086 # GO_BUILDS is a list of file names
( cd "$OUT" && sha256sum realuptime-agent-"$VERSION".tgz realuptime-agent-"$VERSION".zip realuptime-agent-"$VERSION"-linux-x64 realuptime-agent-"$VERSION"-linux-arm64 $GO_BUILDS 2>/dev/null > SHA256SUMS \
    || sha256sum realuptime-agent-"$VERSION".tgz realuptime-agent-"$VERSION"-linux-x64 realuptime-agent-"$VERSION"-linux-arm64 $GO_BUILDS > SHA256SUMS )

if [ "$SIGN" -eq 1 ]; then
  [ -n "${COSIGN_KEY:-}" ] || { echo "--sign needs COSIGN_KEY" >&2; exit 1; }
  ( cd "$OUT" && cosign sign-blob --yes --key "$COSIGN_KEY" --use-signing-config=false --new-bundle-format=false --output-signature SHA256SUMS.sig SHA256SUMS )
fi

echo "artifacts in $OUT:"
ls -1 "$OUT"
