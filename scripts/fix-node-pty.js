// postinstall: node-pty's npm package ships its macOS `spawn-helper` without the
// executable bit, so local terminals fail with "posix_spawnp failed" when running
// from source. (Packaged builds are fixed by scripts/after-pack.js.)
const fs = require('fs');
const path = require('path');

const prebuilds = path.join(__dirname, '..', 'node_modules', 'node-pty', 'prebuilds');
if (fs.existsSync(prebuilds)) {
  for (const dir of fs.readdirSync(prebuilds)) {
    const helper = path.join(prebuilds, dir, 'spawn-helper');
    if (fs.existsSync(helper)) fs.chmodSync(helper, 0o755);
  }
}
