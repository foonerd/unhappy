# Changelog

All notable changes to Unhappy TriggerHappy are recorded here. The format follows Keep a Changelog; versions follow Semantic Versioning.

## [1.2.0] - 2026-10-09

- **Bindings of your own for a remote taken over.** A bindings section lists every binding as a row of key, press, and command with a remove switch, and a new-binding row at the end. Each key may carry a short, a long, and a double binding. A remote with no list of its own keeps running the editor's eight commands as short presses.
- **Capture a key.** A button asks the listener for the next key pressed on any remote and puts its name into the new binding's key field; the page refreshes itself. While the listener waits, presses run no commands.
- A binding the listener cannot run (a key name the kernel does not know) is left out with a warning shown on save and in the status line; the rest of the list runs, so one typo never leaves a remote dead after a reboot.

## [1.1.0] - 2026-10-09

- **A listener of the plugin's own for the remotes you take over.** `unhappy-listener`, a small daemon in the plugin's zip for every Volumio architecture, grabs the input devices named in its configuration and runs a command on a short, long, or double press of a key, with the kernel's timestamps and a debounce window. Triggerhappy keeps every device that is not taken over.
- The listener is installed as `unhappy-listener.service`, run as the volumio user with the input group, and controlled through a socket the plugin asks for status, the devices present, a reload, and the next key pressed.
- The plugin's own sudoers file, `volumio-user-unhappy_triggerhappy`, names the exact commands it runs: the triggerhappy restart, the listener unit's control, and `tee` and `rm` on its own conf.
- Release train: cross builds in CI, the plugin zip with its digest published on a tag.

## [1.0.1] - 2026-10-09

- Save writes only the bindings that differ from the other confs in triggers.d, so the same line can no longer sit in audio.conf and the plugin's file and fire twice.
- Turning the binding editor off removes the plugin's conf and restarts triggerhappy.
- install.sh checks for triggerhappy, its unit, its triggers directory, and the volumio CLI before installing, and warns when a sudo rule is missing.

## [1.0.0] - 2026-09-21

- Ready poll, immediate restart, and a stock binding editor.
