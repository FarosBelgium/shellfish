#!/usr/bin/env bash
# Lets Electron's Chromium sandbox run on Ubuntu 23.10+ / other distros that
# restrict unprivileged user namespaces via AppArmor
# (kernel.apparmor_restrict_unprivileged_userns=1).
# Installs an AppArmor profile that grants user namespaces to THIS project's
# Electron binary only. Needs sudo. Re-run if you move the project folder.
set -euo pipefail

ELECTRON="$(cd "$(dirname "$0")/.." && pwd)/node_modules/electron/dist/electron"
PROFILE=/etc/apparmor.d/shellfish-electron

if [[ ! -x "$ELECTRON" ]]; then
  echo "Electron not found at $ELECTRON - run 'npm install' first." >&2
  exit 1
fi

echo "Installing AppArmor profile for: $ELECTRON"
sudo tee "$PROFILE" >/dev/null <<PROFILE_EOF
abi <abi/4.0>,
include <tunables/global>

profile shellfish-electron "$ELECTRON" flags=(unconfined) {
  userns,
  include if exists <local/shellfish-electron>
}
PROFILE_EOF

sudo apparmor_parser -r "$PROFILE"
echo "Done. Start the app with: npm start"
