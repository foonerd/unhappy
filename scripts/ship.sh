#!/bin/bash
# Build the listener for each Volumio architecture and put it in
# bin/<arch>/unhappy-listener. Players run those files; they do not run
# cargo.
#
# Every binary is linked statically against musl: the daemon needs nothing
# from a player's C library, and Ubuntu's cross glibc would otherwise bind
# the standard library's child spawning to a glibc newer than Volumio's 2.36.
# The arm binary is ARMv6 code: Volumio's universal Pi image labels itself
# arm and runs on every Pi from the Zero up.
set -euo pipefail
ROOT=$(CDPATH='' cd -- "$(dirname "$0")/.." && pwd)
cd "$ROOT"
unset CARGO_TARGET_DIR

# The cross compilers only drive the link; the C runtime and libc come with
# the Rust musl targets themselves.
export CARGO_TARGET_ARMV7_UNKNOWN_LINUX_MUSLEABIHF_LINKER=arm-linux-gnueabihf-gcc
export CARGO_TARGET_ARM_UNKNOWN_LINUX_MUSLEABIHF_LINKER=arm-linux-gnueabihf-gcc
export CARGO_TARGET_AARCH64_UNKNOWN_LINUX_MUSL_LINKER=aarch64-linux-gnu-gcc

ship() {
  local triple=$1 arch=$2
  echo "ship: $arch ($triple)"
  cargo build --release --locked --target "$triple" -p unhappy-listener
  install -D -m 755 "target/$triple/release/unhappy-listener" "bin/$arch/unhappy-listener"
}
ship x86_64-unknown-linux-musl x64
ship armv7-unknown-linux-musleabihf armv7
ship arm-unknown-linux-musleabihf arm
ship aarch64-unknown-linux-musl armv8

echo "ship: static"
for bin in bin/*/unhappy-listener; do
  # x86-64 musl links as a static PIE; file words that differently.
  file "$bin" | grep -qE 'statically linked|static-pie linked' || { echo "ship: $bin is not statically linked" >&2; exit 1; }
  if readelf -W --dyn-syms "$bin" 2>/dev/null | grep -q 'GLIBC_'; then
    echo "ship: $bin needs glibc" >&2; exit 1
  fi
done
echo "ship: arm is ARMv6"
readelf -A bin/arm/unhappy-listener | grep -q 'Tag_CPU_arch: v6' || { echo "ship: bin/arm/unhappy-listener is not ARMv6 code" >&2; exit 1; }
file bin/arm/unhappy-listener bin/armv7/unhappy-listener bin/armv8/unhappy-listener bin/x64/unhappy-listener
