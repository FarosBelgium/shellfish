// End-to-end tests. Runs inside Electron on Linux, Windows and macOS:
//   npm test            (on Linux CI: xvfb-run npm test)
// Starts its own SSH servers (test/ssh-test-server.js): two jump hosts and a target.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { app, dialog } = require('electron');
const { startServer, generateKey } = require('./ssh-test-server');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'shellfish-test-'));
process.env.SHELLFISH_DATA_DIR = path.join(tmp, 'data');

// Host key dialogs: always "trust", but record which hosts asked.
const hostKeyPrompts = [];
dialog.showMessageBox = async (_win, opts) => {
  hostKeyPrompts.push(opts.message);
  return { response: 1 };
};

require('../src/main/main.js'); // the real app: window, IPC, store
const { Store } = require('../src/main/store');
const ssh = require('../src/main/ssh');

const results = [];
async function test(name, fn) {
  const t0 = Date.now();
  try {
    await fn();
    results.push({ name, ok: true });
    console.log(`  ✓ ${name} (${Date.now() - t0} ms)`);
  } catch (e) {
    results.push({ name, ok: false });
    console.log(`  ✗ ${name}\n      ${String(e && e.stack || e).split('\n').slice(0, 4).join('\n      ')}`);
  }
}
function assert(cond, msg) { if (!cond) throw new Error(msg); }
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 8000, what = 'condition') {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await wait(50);
  }
}

// Collects terminal output per session id, like the renderer does.
function makeSender() {
  const out = {};
  const closed = new Set();
  const progress = [];
  return {
    out, closed, progress,
    isDestroyed: () => false,
    send(ch, a, b) {
      if (ch === 'ssh:data') out[a] = (out[a] || '') + Buffer.from(b).toString();
      else if (ch === 'ssh:closed' || ch === 'sftp:closed') closed.add(a);
      else if (ch === 'sftp:progress') progress.push(a);
    },
  };
}

process.on('unhandledRejection', (e) => { console.log('\nUNHANDLED:', e && e.stack || e); app.exit(3); });

app.whenReady().then(async () => {
  console.log(`Shellfish e2e on ${process.platform}-${process.arch}, Electron ${process.versions.electron}`);
  const win = await until(() => require('electron').BrowserWindow.getAllWindows()[0], 10000, 'main window');
  await until(() => !win.webContents.isLoading(), 10000, 'window load');

  // ---- servers ----
  const keyPair = generateKey('ed25519', { passphrase: 'key-pass', cipher: 'aes256-ctr' });
  const keyFile = path.join(tmp, 'id_test');
  fs.writeFileSync(keyFile, keyPair.private, { mode: 0o600 });
  const remoteRoot = path.join(tmp, 'remote');
  fs.mkdirSync(remoteRoot);

  const jump1 = await startServer({ name: 'jump1', password: 'jump1-pass' });
  const jump2 = await startServer({ name: 'jump2', publicKey: keyPair.public });
  const target = await startServer({ name: 'target', password: 'target-pass', root: remoteRoot });
  const noFwd = await startServer({ name: 'nofwd', password: 'nofwd-pass', allowForwarding: false });

  const store = new Store(process.env.SHELLFISH_DATA_DIR);
  const add = (h) => store.saveHost({ host: '127.0.0.1', username: 'tester', authType: 'password', ...h });
  const hJump1 = add({ name: 'jump1', port: jump1.port, password: 'jump1-pass' });
  const hJump2 = add({ name: 'jump2', port: jump2.port, authType: 'key', privateKeyPath: keyFile, passphrase: 'key-pass', jumpHostId: hJump1.id });
  const hDirect = add({ name: 'target-direct', port: target.port, password: 'target-pass' });
  const hVia1 = add({ name: 'target-via-jump1', port: target.port, password: 'target-pass', jumpHostId: hJump1.id });
  const hVia2 = add({ name: 'target-via-chain', port: target.port, password: 'target-pass', jumpHostId: hJump2.id });
  const hNoFwd = add({ name: 'nofwd', port: noFwd.port, password: 'nofwd-pass' });
  const hBehindNoFwd = add({ name: 'behind-nofwd', port: target.port, password: 'target-pass', jumpHostId: hNoFwd.id });
  const hNoPwJump = add({ name: 'jump1-nopw', port: jump1.port });
  const hBehindNoPw = add({ name: 'behind-nopw-jump', port: target.port, password: 'target-pass', jumpHostId: hNoPwJump.id });

  async function shellRoundTrip(hostId, opts = {}) {
    const sender = makeSender();
    const r = await ssh.openShell(win, store, sender, { hostId, cols: 80, rows: 24, ...opts });
    assert(r.ok, `openShell failed: ${r.message}`);
    await until(() => (sender.out[r.id] || '').includes('Welcome to target'), 8000, 'target banner');
    ssh.shellWrite(r.id, 'hello\r');
    await until(() => (sender.out[r.id] || '').includes('target says: hello'), 8000, 'echo');
    return { r, sender };
  }

  console.log('\nJump hosts');
  await test('direct connection still works', async () => {
    const { r } = await shellRoundTrip(hDirect.id);
    ssh.closeSession(r.id);
  });

  await test('shell via one jump host goes through the tunnel', async () => {
    const before = jump1.stats.forwards.length;
    const { r } = await shellRoundTrip(hVia1.id);
    assert(jump1.stats.forwards.slice(before).includes(`127.0.0.1:${target.port}`), 'jump1 did not forward to the target');
    ssh.closeSession(r.id);
  });

  await test('shell via a chain (jump1 → jump2 with encrypted key → target)', async () => {
    const f1 = jump1.stats.forwards.length;
    const f2 = jump2.stats.forwards.length;
    const { r } = await shellRoundTrip(hVia2.id);
    assert(jump1.stats.forwards.slice(f1).includes(`127.0.0.1:${jump2.port}`), 'jump1 did not forward to jump2');
    assert(jump2.stats.forwards.slice(f2).includes(`127.0.0.1:${target.port}`), 'jump2 did not forward to the target');
    ssh.closeSession(r.id);
  });

  await test('closing the session closes every jump connection', async () => {
    const { r } = await shellRoundTrip(hVia2.id);
    assert(jump1.stats.open >= 1 && jump2.stats.open >= 1, 'jump connections not open');
    ssh.closeSession(r.id);
    await until(() => jump1.stats.open === 0 && jump2.stats.open === 0 && target.stats.open === 0, 5000, 'all connections closed');
  });

  await test('each hop gets its own host key check, once', async () => {
    const hosts = hostKeyPrompts.join('\n');
    for (const port of [jump1.port, jump2.port, target.port]) assert(hosts.includes(`[127.0.0.1]:${port}`), `no host key prompt for port ${port}`);
    const known = JSON.parse(fs.readFileSync(path.join(process.env.SHELLFISH_DATA_DIR, 'known_hosts.json'), 'utf8'));
    for (const port of [jump1.port, jump2.port, target.port]) assert(known[`[127.0.0.1]:${port}`], `port ${port} not in known_hosts.json`);
    const n = hostKeyPrompts.length;
    const { r } = await shellRoundTrip(hVia2.id);
    ssh.closeSession(r.id);
    assert(hostKeyPrompts.length === n, 'trusted hosts were prompted again');
  });

  await test('missing jump password reports the jump host, then succeeds with it', async () => {
    const sender = makeSender();
    const r1 = await ssh.openShell(win, store, sender, { hostId: hBehindNoPw.id });
    assert(!r1.ok && r1.code === 'AUTH_FAILED', `expected AUTH_FAILED, got ${r1.code}: ${r1.message}`);
    assert(r1.hostId === hNoPwJump.id, 'error should point at the jump host');
    const wrong = await ssh.openShell(win, store, sender, { hostId: hBehindNoPw.id, secrets: { [hNoPwJump.id]: { password: 'nope' } } });
    assert(!wrong.ok && wrong.hostId === hNoPwJump.id && wrong.code === 'AUTH_FAILED', 'wrong jump password should fail on the jump host');
    const { r } = await shellRoundTrip(hBehindNoPw.id, { secrets: { [hNoPwJump.id]: { password: 'jump1-pass' } } });
    ssh.closeSession(r.id);
  });

  await test('wrong target password behind a jump reports the target', async () => {
    const res = await ssh.openShell(win, store, makeSender(), { hostId: hVia1.id, secrets: { [hVia1.id]: { password: 'wrong' } } });
    assert(!res.ok && res.code === 'AUTH_FAILED' && res.hostId === hVia1.id, `got ${res.code} for ${res.hostName}`);
    await until(() => jump1.stats.open === 0, 5000, 'jump connection closed after failure');
  });

  await test('jump host that refuses forwarding gives a clear error', async () => {
    const res = await ssh.openShell(win, store, makeSender(), { hostId: hBehindNoFwd.id });
    assert(!res.ok && /could not reach/.test(res.message) && /nofwd/.test(res.message), res.message);
  });

  await test('loops and missing jump hosts are rejected', async () => {
    let err;
    try { store.saveHost({ ...store.getHost(hJump1.id), jumpHostId: hVia2.id }); } catch (e) { err = e; }
    assert(err && /loop/.test(err.message), 'loop was not rejected');
    err = null;
    try { add({ name: 'x', port: 22, password: 'x', jumpHostId: 'does-not-exist' }); } catch (e) { err = e; }
    assert(err && /no longer exists/.test(err.message), 'missing jump host was not rejected');
  });

  console.log('\nSFTP through a jump chain');
  const localDir = path.join(tmp, 'local');
  fs.mkdirSync(path.join(localDir, 'folder', 'sub'), { recursive: true });
  fs.writeFileSync(path.join(localDir, 'folder', 'sub', 'a.txt'), 'hello from shellfish');
  fs.writeFileSync(path.join(localDir, 'big.bin'), Buffer.alloc(3 * 1024 * 1024, 7));
  let sftpId;
  const sftpSender = makeSender();
  const transfer = async (dir, sources, targetDir) => {
    const n = sftpSender.progress.length;
    await ssh.runTransfer(sftpSender, sftpId, dir, sources, targetDir);
    const done = await until(() => sftpSender.progress.slice(n).find((p) => p.state === 'done' || p.state === 'error'), 20000, `${dir} to finish`);
    assert(done.state === 'done', `${dir} failed: ${done.message}`);
  };

  await test('open SFTP via jump1 → jump2', async () => {
    const r = await ssh.openSftp(win, store, sftpSender, { hostId: hVia2.id });
    assert(r.ok, r.message);
    sftpId = r.id;
  });
  await test('upload a folder recursively and a 3 MB file', async () => {
    await transfer('upload', [path.join(localDir, 'folder'), path.join(localDir, 'big.bin')], '/');
    assert(fs.readFileSync(path.join(remoteRoot, 'folder', 'sub', 'a.txt'), 'utf8') === 'hello from shellfish', 'a.txt content');
    assert(fs.statSync(path.join(remoteRoot, 'big.bin')).size === 3 * 1024 * 1024, 'big.bin size');
  });
  await test('list, mkdir, rename, delete remotely', async () => {
    const list = await ssh.remoteList(sftpId, '/');
    assert(list.entries.some((e) => e.name === 'folder' && e.isDir), 'folder not listed as dir');
    await ssh.remoteMkdir(sftpId, '/newdir');
    await ssh.remoteRename(sftpId, '/newdir', '/renamed');
    assert(fs.existsSync(path.join(remoteRoot, 'renamed')), 'rename failed');
    await ssh.remoteDelete(sftpId, '/renamed');
    assert(!fs.existsSync(path.join(remoteRoot, 'renamed')), 'delete failed');
  });
  await test('download a folder recursively', async () => {
    const back = path.join(tmp, 'back');
    fs.mkdirSync(back);
    await transfer('download', ['/folder', '/big.bin'], back);
    assert(fs.readFileSync(path.join(back, 'folder', 'sub', 'a.txt'), 'utf8') === 'hello from shellfish', 'downloaded a.txt');
    assert(fs.statSync(path.join(back, 'big.bin')).size === 3 * 1024 * 1024, 'downloaded big.bin');
    await ssh.remoteDelete(sftpId, '/folder');
    assert(!fs.existsSync(path.join(remoteRoot, 'folder')), 'recursive delete failed');
    ssh.closeSession(sftpId);
  });

  console.log('\nLocal terminal');
  await test('local shell runs a command', async () => {
    const sender = makeSender();
    const r = ssh.openLocalShell(sender, { cols: 100, rows: 30 });
    assert(r.ok, r.message);
    await wait(process.platform === 'win32' ? 3000 : 800);
    // The marker is only printed by running the command, not by echoing what was typed.
    ssh.shellWrite(r.id, process.platform === 'win32' ? "Write-Output ('SHELL' + 'FISH_OK')\r" : "echo SHELL''FISH_OK\r");
    await until(() => (sender.out[r.id] || '').includes('SHELLFISH_OK'), 15000, `shell output (got: ${JSON.stringify((sender.out[r.id] || '').slice(-300))})`);
    ssh.shellResize(r.id, 120, 40);
    ssh.closeSession(r.id);
  });

  console.log('\nUser interface');
  const js = (code) => win.webContents.executeJavaScript(code);
  // Text in the active terminal, read from xterm's buffer: the DOM rows are only
  // repainted when the window is actually on screen, which is not the case on CI.
  const termText = () => js(`(() => { const b = activeTab?.term?.buffer.active; if (!b) return ''; let t = ''; for (let i = 0; i < b.length; i++) t += b.getLine(i).translateToString(true) + '\\n'; return t; })()`);
  win.show();
  win.focus();
  await js('loadHosts()');
  await test('sidebar shows the jump path', async () => {
    const via = await until(() => js(`[...document.querySelectorAll('.host')].find(h => h.querySelector('.host-name')?.textContent === 'target-via-chain')?.querySelector('.host-via')?.textContent`), 5000, 'via label');
    assert(via === 'via jump1 → jump2', `label was "${via}"`);
  });
  await test('host editor offers jump hosts, not the host itself', async () => {
    const opts = await js(`(() => {
      const h = hosts.find(x => x.name === 'target-via-chain');
      openHostEditor(h);
      const r = { options: [...document.querySelectorAll('#jump-select option')].map(o => o.textContent), value: document.querySelector('#jump-select').value };
      closeHostEditor();
      return r;
    })()`);
    assert(opts.options[0] === 'Direct connection', 'first option should be Direct connection');
    assert(!opts.options.some((o) => o.startsWith('target-via-chain ')), 'host is offered as its own jump host');
    assert(opts.value === hJump2.id, 'saved jump host not selected');
  });
  await test('terminal tab connects via the chain', async () => {
    await js(`openTerminal(hosts.find(x => x.name === 'target-via-chain'))`);
    const text = await until(() => termText().then((t) => t.includes('Welcome to target') && t), 10000, 'banner in terminal');
    assert(text.includes('via jump1 → jump2'), 'connecting message should show the route');
    await js('closeTab(activeTab)');
  });
  await test('SFTP tab connects via the chain and lists files', async () => {
    fs.writeFileSync(path.join(remoteRoot, 'visible.txt'), 'x');
    await js(`openSftp(hosts.find(x => x.name === 'target-via-chain'))`);
    await until(() => js(`[...document.querySelectorAll('.tabview.active .pane')[1].querySelectorAll('tr[data-name]')].some(r => r.dataset.name === 'visible.txt')`), 10000, 'remote listing');
    await js('closeTab(activeTab)');
  });
  await test('update box shows the version (and that updates need the installed app)', async () => {
    const text = await until(() => js(`document.querySelector('#update-box')?.textContent || ''`), 5000, 'update box');
    assert(text.includes(`Shellfish ${app.getVersion()}`), `update box: "${text}"`);
    assert(/only in the installed app/.test(text), `expected the from-source note, got "${text}"`);
  });
  await test('UI asks for a missing jump host password and connects', async () => {
    // Answer the prompt from inside the page, as a user would.
    await js(`(() => {
      const obs = new MutationObserver(() => {
        const m = document.querySelector('#dialog-modal');
        if (!m.classList.contains('hidden') && /jump1-nopw/.test(document.querySelector('#dialog-title').textContent)) {
          document.querySelector('#dialog-input').value = 'jump1-pass';
          document.querySelector('#dialog-ok').click();
        }
      });
      obs.observe(document.querySelector('#dialog-modal'), { attributes: true });
      window.__obs = obs;
      openTerminal(hosts.find(x => x.name === 'behind-nopw-jump'));
    })()`);
    await until(() => termText().then((t) => t.includes('Welcome to target')), 10000, 'banner after prompt');
    await js('window.__obs.disconnect(); closeTab(activeTab)');
  });

  // ---- summary ----
  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} passed${failed.length ? `, FAILED: ${failed.map((f) => f.name).join('; ')}` : ''}`);
  for (const s of [jump1, jump2, target, noFwd]) s.close();
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* Windows may hold files briefly */ }
  // Quit the way a user does (close the window → app.quit()); app.exit() with the
  // window still open can stall. Electron ignores process.exitCode, so set it here.
  const code = failed.length ? 1 : 0;
  app.once('will-quit', (e) => { e.preventDefault(); app.exit(code); });
  win.close();
});

setTimeout(() => { console.log('\nTIMEOUT: test run took longer than 3 minutes'); process.exit(2); }, 180000);
