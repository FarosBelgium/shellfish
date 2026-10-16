#!/usr/bin/env bash
# Runs a command on a virtual X display (Xvfb), so Electron windows never appear on
# your screen. Wayland variables are cleared, otherwise Electron would use the real
# Wayland session.   usage: scripts/headless.sh <command...>
exec env -u WAYLAND_DISPLAY -u XDG_SESSION_TYPE xvfb-run -a -s "-screen 0 1400x900x24" "$@"
