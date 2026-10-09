#!/bin/sh
# Install Unhappy TriggerHappy on a Volumio player from its latest release,
# or from a release named on the command line:
#
#   curl -fsSL https://raw.githubusercontent.com/foonerd/unhappy/main/get-unhappy.sh | sh
#   curl -fsSL https://raw.githubusercontent.com/foonerd/unhappy/main/get-unhappy.sh | sh -s -- 1.1.0
#
# Run as the volumio user on the player. The plugin zip is downloaded from
# GitHub into the place the player's plugin manager takes dropped files and
# handed to that manager over the player's own socket. A fresh install is
# enabled; an installed plugin is updated and the backend restarted, since
# the backend keeps a plugin's old code loaded until it restarts.
set -eu

REPO=foonerd/unhappy
NAME=unhappy_triggerhappy
CATEGORY=system_controller
PLUGIN=/data/plugins/$CATEGORY/$NAME
DROP=/tmp/plugins
NODE=/usr/bin/node
SOCKET_CLIENT=/volumio/node_modules/socket.io-client
WANTED=${1:-}

say() { printf '%s\n' "$*"; }
fail() { printf 'get-unhappy: %s\n' "$*" >&2; exit 1; }

[ "$(id -un)" = volumio ] || fail "run this as the volumio user on the player"
[ -d /volumio ] && [ -x "$NODE" ] && [ -d "$SOCKET_CLIENT" ] || fail "this is not a Volumio player"
command -v curl >/dev/null 2>&1 || fail "curl is needed"

# The release: the latest, or the one asked for.
if [ -z "$WANTED" ]; then
  say "Looking up the latest release of Unhappy TriggerHappy"
  WANTED=$(curl -fsSL "https://api.github.com/repos/$REPO/releases/latest" | "$NODE" -e '
    let s = ""; process.stdin.on("data", d => s += d).on("end", () => {
      const r = JSON.parse(s); process.stdout.write(String(r.tag_name || "").replace(/^v/, ""));
    });')
  [ -n "$WANTED" ] || fail "the latest release could not be read from GitHub"
fi
WANTED=${WANTED#v}
ZIP="$NAME-$WANTED.zip"
URL="https://github.com/$REPO/releases/download/v$WANTED/$ZIP"
SUMS="https://github.com/$REPO/releases/download/v$WANTED/SHA256SUMS"

mkdir -p "$DROP"
say "Downloading $ZIP"
curl -fL --progress-bar -o "$DROP/$ZIP" "$URL" || fail "$URL could not be downloaded"
if curl -fsSL -o "$DROP/SHA256SUMS" "$SUMS" 2>/dev/null; then
  (cd "$DROP" && grep " $ZIP\$" SHA256SUMS | sha256sum -c - >/dev/null) || fail "$ZIP does not match the release's SHA256SUMS"
  rm -f "$DROP/SHA256SUMS"
  say "Digest checked"
fi

# The plugin manager's own install path, over the socket, as the dropped
# file; the zip's name must match what the manager serves.
mv -f "$DROP/$ZIP" "$DROP/$NAME.zip"
if [ -d "$PLUGIN" ]; then
  ACTION=update
else
  ACTION=install
fi
say "Asking the plugin manager to $ACTION"
"$NODE" - "$ACTION" "$NAME" "$CATEGORY" "$SOCKET_CLIENT" <<'JS'
const [action, name, category, client] = process.argv.slice(2);
const io = require(client);
const socket = io.connect('http://127.0.0.1:3000', { reconnection: false });
const url = 'http://127.0.0.1:3000/plugin-serve/' + name + '.zip';
const timer = setTimeout(() => { console.error('the plugin manager did not finish within 5 minutes'); process.exit(1); }, 300000);
socket.on('connect', () => {
  if (action === 'update') socket.emit('updatePlugin', { url, category, name });
  else socket.emit('installPlugin', { url, confirm: true });
});
socket.on('installPluginStatus', (d) => {
  const last = d.advancedLog ? d.advancedLog.substring(d.advancedLog.lastIndexOf('<br>') + 4) : '';
  console.log('[' + d.progress + '] ' + d.message + (last && last !== d.message ? ' | ' + last : ''));
  if (d.progress === 100) {
    if (action === 'install') {
      socket.emit('pluginManager', { category, name, action: 'enable' });
      setTimeout(() => { clearTimeout(timer); socket.close(); process.exit(0); }, 3000);
    } else {
      clearTimeout(timer); socket.close(); process.exit(0);
    }
  } else if (d.progress === 0) {
    clearTimeout(timer); socket.close(); process.exit(1);
  }
});
socket.on('connect_error', (e) => { console.error('cannot reach the player\'s backend: ' + e); process.exit(1); });
JS

if [ "$ACTION" = update ]; then
  say "Restarting the backend so the new code is loaded"
  volumio vrestart >/dev/null 2>&1 || fail "volumio vrestart failed; restart the player"
fi
say "Unhappy TriggerHappy $WANTED is in place"
