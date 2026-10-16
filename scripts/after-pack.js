// electron-builder afterPack hook: node-pty's macOS `spawn-helper` ships without
// the executable bit in the npm package; without it local terminals fail to start.
const fs = require('fs');
const path = require('path');

function walk(dir, found = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, found);
    else if (entry.name === 'spawn-helper') found.push(full);
  }
  return found;
}

exports.default = async function afterPack({ appOutDir }) {
  for (const file of walk(appOutDir)) {
    fs.chmodSync(file, 0o755);
    console.log(`  • made executable  ${path.relative(appOutDir, file)}`);
  }
};
