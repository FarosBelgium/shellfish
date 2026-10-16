// Checks that node-pty loads and runs a shell from inside a packaged build.
//   ELECTRON_RUN_AS_NODE=1 <app executable> test/packaged-pty-test.js <resources dir>
const path = require('path');

const pty = require(path.resolve(process.argv[2], 'app.asar', 'node_modules', 'node-pty'));
const win = process.platform === 'win32';
// The marker only appears when the command runs (the quotes split it in the source).
const p = win
  ? pty.spawn('powershell.exe', ['-NoLogo', '-NoProfile', '-Command', "Write-Output ('PTY' + '_OK')"], { cols: 80, rows: 24 })
  : pty.spawn('/bin/sh', ['-c', "echo PTY''_OK"], { cols: 80, rows: 24 });
let out = '';
p.onData((d) => { out += d; });
p.onExit(() => {
  const ok = out.includes('PTY_OK');
  console.log(ok ? `PASS: node-pty works in the packaged ${process.platform} app` : `FAIL: output was ${JSON.stringify(out)}`);
  process.exit(ok ? 0 : 1);
});
setTimeout(() => { console.log(`FAIL: timeout, output ${JSON.stringify(out)}`); process.exit(1); }, 30000);
