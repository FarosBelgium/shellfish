// Tests the auto-updater of a *packaged* build against a local update feed.
//   node test/update-test.js <path to the installed/unpacked app executable> [dist dir] [--tamper]
//
// --tamper flips one byte of the served installer: the app must then reject the
// download because its SHA-512 no longer matches.
//
// The feed announces version 99.0.0 using the installer that was just built, so the
// app must find the update, download it and verify its SHA-512 (Windows/Linux), or
// report it as a manual download (macOS, which cannot self-update unsigned apps).

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');

const args = process.argv.slice(2);
const tamper = args.includes('--tamper');
const [exe, distDir = 'dist'] = args.filter((a) => a !== '--tamper');
if (!exe || !fs.existsSync(exe)) { console.error(`usage: node test/update-test.js <app executable> [dist]  (not found: ${exe})`); process.exit(2); }

const ymlName = { win32: 'latest.yml', darwin: 'latest-mac.yml', linux: 'latest-linux.yml' }[process.platform];
const ymlPath = path.join(distDir, ymlName);
const yml = fs.readFileSync(ymlPath, 'utf8');
const files = [...new Set([...yml.matchAll(/^\s*(?:- url|path): (.+)$/gm)].map((m) => m[1].trim()))];

// Feed folder: the same installer files, announced as 99.0.0.
const feedDir = fs.mkdtempSync(path.join(os.tmpdir(), 'shellfish-feed-'));
fs.writeFileSync(path.join(feedDir, ymlName), yml.replace(/^version: .+$/m, 'version: 99.0.0'));
for (const f of files) {
  fs.copyFileSync(path.join(distDir, f), path.join(feedDir, f));
  // Windows tries a differential download first, using the blockmap next to the installer.
  if (fs.existsSync(path.join(distDir, `${f}.blockmap`))) fs.copyFileSync(path.join(distDir, `${f}.blockmap`), path.join(feedDir, `${f}.blockmap`));
}
if (tamper) {
  const f = path.join(feedDir, files[0]);
  const fd = fs.openSync(f, 'r+');
  const b = Buffer.alloc(1);
  const at = Math.floor(fs.statSync(f).size / 2);
  fs.readSync(fd, b, 0, 1, at);
  b[0] ^= 0xff;
  fs.writeSync(fd, b, 0, 1, at);
  fs.closeSync(fd);
}

const served = [];
const server = http.createServer((req, res) => {
  const file = path.join(feedDir, decodeURIComponent(new URL(req.url, 'http://x').pathname).replace(/^\/+/, ''));
  served.push(req.url);
  if (!file.startsWith(feedDir) || !fs.existsSync(file)) { res.writeHead(404); return res.end(); }
  res.writeHead(200, { 'Content-Length': fs.statSync(file).size });
  fs.createReadStream(file).pipe(res);
});

// Where the app writes its update log (userData/logs/updates.log).
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'shellfish-home-'));
const env = { ...process.env, SHELLFISH_DATA_DIR: path.join(home, 'data') };
let logFile;
if (process.platform === 'linux') {
  env.XDG_CONFIG_HOME = home; // Chromium honours this for userData
  logFile = path.join(home, 'shellfish', 'logs', 'updates.log');
} else if (process.platform === 'win32') {
  logFile = path.join(process.env.APPDATA, 'shellfish', 'logs', 'updates.log');
} else {
  logFile = path.join(os.homedir(), 'Library', 'Application Support', 'shellfish', 'logs', 'updates.log');
}
try { fs.rmSync(logFile); } catch { /* no previous log */ }
// Start without a previously downloaded update: the updater reuses a cached download
// whose checksum still matches, which would hide what this run serves.
const cacheBase = { linux: process.env.XDG_CACHE_HOME || path.join(os.homedir(), '.cache'), win32: process.env.LOCALAPPDATA, darwin: path.join(os.homedir(), 'Library', 'Caches') }[process.platform];
fs.rmSync(path.join(cacheBase, 'shellfish-updater'), { recursive: true, force: true });

server.listen(0, '127.0.0.1', () => {
  env.SHELLFISH_UPDATE_FEED = `http://127.0.0.1:${server.address().port}/`;
  console.log(`feed ${env.SHELLFISH_UPDATE_FEED} serving ${ymlName} + ${files.join(', ')}`);
  const child = spawn(exe, [], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  let exited = null;
  child.on('exit', (code, sig) => { exited = `${code ?? sig}`; });
  child.stdout.on('data', () => {});
  child.stderr.on('data', () => {});

  // macOS never downloads (manual updates), so tampering cannot be observed there.
  const want = tamper
    ? /sha512 checksum mismatch/i
    : process.platform === 'darwin' ? /Found version 99\.0\.0/ : /update downloaded: 99\.0\.0/;
  const t0 = Date.now();
  const timer = setInterval(() => {
    const log = fs.existsSync(logFile) ? fs.readFileSync(logFile, 'utf8') : '';
    const done = want.test(log);
    // "Cannot download differentially, fallback to full download" is logged as ERROR but is not one.
    const errors = log.split('\n').filter((l) => / ERROR /.test(l) && !/fallback to full download/.test(l));
    const failed = (!tamper && errors.length > 0) || /update downloaded/.test(tamper ? log : '') || exited !== null;
    if (!done && !failed && Date.now() - t0 < 150000) return;
    clearInterval(timer);
    child.kill();
    server.close();
    console.log(`--- ${logFile}\n${log || '(no log)'}---`);
    console.log(`requests: ${served.join(' ')}`);
    if (exited !== null) console.log(`app exited early with ${exited}`);
    console.log(done
      ? (tamper ? `PASS: packaged ${process.platform} app rejected the tampered update` : `PASS: packaged ${process.platform} app found, downloaded and verified the update`)
      : 'FAIL');
    process.exit(done ? 0 : 1);
  }, 500);
});
