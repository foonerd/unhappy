#!/bin/bash

echo "Installing Unhappy TriggerHappy"

# Architecture check copied from audio_keepalive/install.sh.
# VOLUMIO_ARCH is the os-release value, not the dpkg architecture listed in package.json.
ARCH=$(cat /etc/os-release | grep ^VOLUMIO_ARCH | tr -d 'VOLUMIO_ARCH="')

if [ -z "$ARCH" ]; then
    echo "ERROR: Could not detect Volumio architecture"
    echo "plugininstallend"
    exit 1
fi

echo "Detected architecture: $ARCH"

case "$ARCH" in
    arm|armv7)
        ;;
    armv8|aarch64)
        ;;
    x64|amd64)
        ;;
    *)
        echo "ERROR: Architecture $ARCH not supported"
        echo "plugininstallend"
        exit 1
        ;;
esac

# Nothing is copied into /etc. The stock audio.conf is not replaced.
# The triggers file is written later, by Save in the binding editor.
# triggerhappy.service is not enabled or disabled here.
# 99-restart-thd-on-hid.rules is not installed or changed.

echo "plugininstallend"
