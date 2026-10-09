#!/bin/sh
# Volumio runs this as root through "sudo sh install.sh". POSIX sh only.

echo "Installing Unhappy TriggerHappy"

fail() {
    echo "ERROR: $1"
    echo "plugininstallend"
    exit 1
}

# Architecture check copied from audio_keepalive/install.sh.
# VOLUMIO_ARCH is the os-release value, not the dpkg architecture listed in package.json.
ARCH=$(cat /etc/os-release | grep ^VOLUMIO_ARCH | tr -d 'VOLUMIO_ARCH="')

if [ -z "$ARCH" ]; then
    fail "Could not detect Volumio architecture"
fi

echo "Detected architecture: $ARCH"

case "$ARCH" in
    arm|armv7|armv8|aarch64|x64|amd64)
        ;;
    *)
        fail "Architecture $ARCH not supported"
        ;;
esac

# Hard dependencies. All are part of the Volumio 4 image; nothing is installed here.
if ! dpkg-query -W -f='${Status}' triggerhappy 2>/dev/null | grep -q 'install ok installed'; then
    fail "triggerhappy package is not installed"
fi
[ -x /usr/sbin/thd ] || fail "/usr/sbin/thd not found"
systemctl cat triggerhappy.service >/dev/null 2>&1 || fail "triggerhappy.service unit not found"
[ -d /etc/triggerhappy/triggers.d ] || fail "/etc/triggerhappy/triggers.d not found"
[ -x /usr/local/bin/volumio ] || fail "/usr/local/bin/volumio not found"

# Runtime sudo rules for the volumio user: restart, write, and remove the plugin conf.
# The image grants these. Report a missing one without failing the install.
SUDO_LIST=$(sudo -l -U volumio 2>/dev/null)
for cmd in /bin/systemctl /usr/bin/tee /bin/rm; do
    case "$SUDO_LIST" in
        *"$cmd"*)
            ;;
        *)
            echo "WARNING: $cmd is not NOPASSWD for volumio; the plugin cannot run it"
            ;;
    esac
done

# Nothing is copied into /etc. The stock audio.conf is not replaced.
# The triggers file is written later, by Save in the binding editor.
# triggerhappy.service is not enabled or disabled here.
# 99-restart-thd-on-hid.rules is not installed or changed.

echo "plugininstallend"
