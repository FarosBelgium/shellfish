// Linux CI only: installs an update in the *installed* app the way a user does, and checks
// that the restarted app can still escalate privileges (no "no new privileges" flag), so
// the next update and `sudo` in local terminals keep working.
//   node test/update-install-test.js /opt/Shellfish/shellfish dist
// Needs pkexec to be allowed without a password (the CI workflow adds a polkit rule).

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');

const [exe, distDir = 'dist'] = process.argv.slice(2);
const PORT = 9333;
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms, what) {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await wait(250);
  }
}
// Main processes of the app: the command starts with the executable and it is not a Chromium
// helper (--type=...). Chromium rewrites its command line into one space-separated string.
const pidsOf = () => fs.readdirSync('/proc').filter((d) => /^\d+$/.test(d)).map(Number).filter((pid) => {
  try {
    const cmd = fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8').replace(/\0/g, ' ').trim();
    return (cmd === exe || cmd.startsWith(`${exe} `)) && !/\s--type=/.test(cmd);
  } catch { return false; }
});
const nnp = (pid) => (/^NoNewPrivs:\s*1$/m.test(fs.readFileSync(`/proc/${pid}/status`, 'utf8')) ? 1 : 0);

// Feed announcing 99.0.0 with the .deb that was just built.
const yml = fs.readFileSync(path.join(distDir, 'latest-linux.yml'), 'utf8');
const deb = /^path: (.+)$/m.exec(yml)[1].trim();
const feedDir = fs.mkdtempSync(path.join(os.tmpdir(), 'shellfish-feed-'));
fs.writeFileSync(path.join(feedDir, 'latest-linux.yml'), yml.replace(/^version: .+$/m, 'version: 99.0.0'));
fs.copyFileSync(path.join(distDir, deb), path.join(feedDir, deb));
const server = http.createServer((req, res) => {
  const file = path.join(feedDir, decodeURIComponent(new URL(req.url, 'http://x').pathname).slice(1));
  if (!file.startsWith(feedDir) || !fs.existsSync(file)) { res.writeHead(404); return res.end(); }
  res.writeHead(200, { 'Content-Length': fs.statSync(file).size });
  fs.createReadStream(file).pipe(res);
});

async function cdpEvaluate(expression) {
  const targets = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
  const page = targets.find((t) => t.type === 'page');
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
  ws.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: { expression } }));
  await wait(500);
  ws.close();
}

server.listen(0, '127.0.0.1', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'shellfish-home-'));
  const env = {
    ...process.env,
    XDG_CONFIG_HOME: home,
    XDG_CACHE_HOME: path.join(home, 'cache'),
    SHELLFISH_DATA_DIR: path.join(home, 'data'),
    SHELLFISH_UPDATE_FEED: `http://127.0.0.1:${server.address().port}/`,
  };
  const log = path.join(home, 'shellfish', 'logs', 'updates.log');
  const dpkgBefore = fs.readFileSync('/var/log/dpkg.log', 'utf8').length;
  let ok = false;
  try {
    const first = spawn(exe, [`--remote-debugging-port=${PORT}`], { env, stdio: 'ignore', detached: true });
    console.log(`started ${exe} (pid ${first.pid}), NoNewPrivs=${nnp(first.pid)}`);
    await until(() => fs.existsSync(log) && /update downloaded: 99\.0\.0/.test(fs.readFileSync(log, 'utf8')), 90000, 'update download');
    console.log('update downloaded; clicking Install');
    await until(() => fetch(`http://127.0.0.1:${PORT}/json/list`).then(() => true, () => false), 10000, 'remote debugging');
    await cdpEvaluate('api.updates.install()');

    await until(() => fs.readFileSync('/var/log/dpkg.log', 'utf8').slice(dpkgBefore).includes('status installed shellfish'), 60000, 'dpkg to install the update');
    console.log('dpkg installed the package via pkexec');
    await until(() => { try { process.kill(first.pid, 0); return false; } catch { return true; } }, 20000, 'the old app to quit');
    const restarted = await until(() => pidsOf().find((p) => p !== first.pid), 20000, 'the app to restart');
    console.log(`restarted as pid ${restarted}, NoNewPrivs=${nnp(restarted)}`);
    ok = nnp(restarted) === 0;
    for (const p of pidsOf()) { try { process.kill(p); } catch { /* gone */ } }
  } catch (e) {
    console.log(`error: ${e.message}`);
    if (fs.existsSync(log)) console.log(`--- ${log}\n${fs.readFileSync(log, 'utf8')}---`);
    for (const p of pidsOf()) { try { process.kill(p); } catch { /* gone */ } }
  }
  server.close();
  console.log(ok ? 'PASS: the update was installed and the restarted app can still use pkexec/sudo' : 'FAIL');
  process.exit(ok ? 0 : 1);
});
