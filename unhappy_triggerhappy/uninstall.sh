#!/bin/bash

echo "Uninstalling Unhappy TriggerHappy"

# Only the triggers file this plugin writes. Not audio.conf.
# Not 99-restart-thd-on-hid.rules. triggerhappy.service is left enabled.
rm -f /etc/triggerhappy/triggers.d/unhappy_triggerhappy.conf

echo "Done"
echo "pluginuninstallend"
