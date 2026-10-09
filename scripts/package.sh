#!/bin/bash
# Assemble the Volumio plugin zip: the payload directory, the listener from
# bin/<arch> for every architecture, and the node modules. Output:
# dist/unhappy_triggerhappy-<version>.zip, the file a player installs.
#
# The plugin's version follows the workspace version in Cargo.toml.
set -euo pipefail
ROOT=$(CDPATH='' cd -- "$(dirname "$0")/.." && pwd)
cd "$ROOT"
VERSION=$(sed -n 's/^version = "\(.*\)"/\1/p' Cargo.toml | head -n1)
NAME=unhappy_triggerhappy
STAGE=$ROOT/dist/stage/$NAME
rm -rf "$ROOT/dist/stage"
mkdir -p "$STAGE" "$ROOT/dist"
cp -r "$ROOT/$NAME/." "$STAGE/"

sed -i "s/\"version\": \"[^\"]*\"/\"version\": \"$VERSION\"/" "$STAGE/package.json"

# The build the zip carries: the commit and the time.
printf '{ "commit": "%s", "built": "%s" }\n' \
  "$(git -C "$ROOT" rev-parse --short HEAD 2>/dev/null || echo unknown)" \
  "$(date -u +%Y-%m-%dT%H:%M:%SZ)" > "$STAGE/build.json"

for arch in arm armv7 armv8 x64; do
  bin="$ROOT/bin/$arch/unhappy-listener"
  [ -x "$bin" ] || { echo "package: $bin is missing; run scripts/ship.sh first" >&2; exit 1; }
  install -D -m 755 "$bin" "$STAGE/bin/$arch/unhappy-listener"
done

# Node modules: with npm on this machine, directly; otherwise in a container
# with the Node major Volumio ships.
if command -v npm >/dev/null 2>&1; then
  ( cd "$STAGE" && npm install --omit=dev --no-audit --no-fund --loglevel=error >/dev/null )
else
  docker run --rm -v "$STAGE:/plugin" -w /plugin node:20-bookworm-slim sh -c \
    "npm install --omit=dev --no-audit --no-fund --loglevel=error >/dev/null && chown -R $(id -u):$(id -g) /plugin/node_modules /plugin/package-lock.json 2>/dev/null || true"
fi
rm -f "$STAGE/package-lock.json"

ZIP=$ROOT/dist/$NAME-$VERSION.zip
rm -f "$ZIP"
( cd "$STAGE" && zip -qr "$ZIP" . )
rm -rf "$ROOT/dist/stage"
echo "package: $ZIP: $(stat -c %s "$ZIP") bytes, sha256 $(sha256sum "$ZIP" | cut -d' ' -f1)"
