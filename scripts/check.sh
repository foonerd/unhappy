#!/bin/bash
# The workshop pass CI runs: formatting, lints with warnings denied, tests,
# the documentation with warnings denied, the shell scripts parsed and
# linted, and the plugin's JavaScript checked and tested. Run it before a
# commit; nothing ships without it.
set -euo pipefail
ROOT=$(CDPATH='' cd -- "$(dirname "$0")/.." && pwd)
cd "$ROOT"

echo "check: format"
cargo fmt --all -- --check

echo "check: clippy"
cargo clippy --workspace --all-targets --locked -- -D warnings

echo "check: tests"
cargo test --workspace --locked

echo "check: documentation"
RUSTDOCFLAGS="-D warnings" cargo doc --workspace --no-deps --locked

echo "check: shell scripts"
for script in scripts/*.sh get-unhappy.sh unhappy_triggerhappy/*.sh; do
  [ -f "$script" ] || continue
  sh -n "$script" || { echo "check: $script does not parse" >&2; exit 1; }
done
# The scripts the player runs go through dash: POSIX sh, no bash.
if command -v shellcheck >/dev/null 2>&1; then
  shellcheck -S warning -s sh unhappy_triggerhappy/install.sh unhappy_triggerhappy/uninstall.sh get-unhappy.sh
  shellcheck -S warning scripts/*.sh
else
  echo "check: shellcheck is not installed; the shell lint is skipped"
fi

echo "check: plugin"
for f in unhappy_triggerhappy/*.js test/*.js; do node --check "$f"; done
for f in unhappy_triggerhappy/*.json unhappy_triggerhappy/i18n/*.json; do
  node -e 'JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"))' "$f"
done
node --test test/

echo "check: clean"
