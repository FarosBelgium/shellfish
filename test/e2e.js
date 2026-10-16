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
// File dialogs: return whatever the test sets here.
let nextOpenFile = null;
dialog.showOpenDialog = async () => (nextOpenFile ? { canceled: false, filePaths: [nextOpenFile] } : { canceled: true, filePaths: [] });
dialog.showMessageBox = async (_win, opts) => {
  hostKeyPrompts.push(opts.message);
  return { response: 1 };
};

require('../src/main/main.js'); // the real app: window, IPC, store
const { Store } = require('../src/main/store');
const ssh = require('../src/main/ssh');
const importer = require('../src/main/importer');

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

  // 'importer' is the user of the hosts the import tests create (so they are not duplicates).
  const jump1 = await startServer({ name: 'jump1', username: ['tester', 'importer'], password: 'jump1-pass' });
  const jump2 = await startServer({ name: 'jump2', publicKey: keyPair.public });
  const target = await startServer({ name: 'target', username: ['tester', 'importer', 'importer2'], password: 'target-pass', root: remoteRoot });
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
    assert(!text.includes('null'), `update box shows "null": "${text}"`);
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

  console.log('\nSaved commands');
  await test('commands are stored cleanly in hosts.json', async () => {
    const h = store.saveHost({ ...store.getHost(hDirect.id), password: null, commands: [
      { name: '  Disk ', command: 'df -h\r\n', run: false },
      { name: '', command: 'uptime', run: 1 },
      { name: 'empty', command: '   ' },
    ] });
    assert(JSON.stringify(h.commands) === JSON.stringify([
      { name: 'Disk', command: 'df -h', run: false },
      { name: 'uptime', command: 'uptime', run: true },
    ]), `got ${JSON.stringify(h.commands)}`);
    assert(store.getHost(hDirect.id).password, 'saving commands must keep the saved password');
    store.saveHost({ ...store.getHost(hDirect.id), password: null, commands: [] });
    await js('loadHosts()');
  });

  await test('commands can be added in the host editor', async () => {
    await js(`(async () => {
      openHostEditor(hosts.find(x => x.name === 'target-direct'));
      const add = (name, cmd, run) => {
        document.querySelector('#btn-add-cmd').click();
        const row = [...document.querySelectorAll('#cmd-list .cmd-row')].pop();
        row.querySelector('.cmd-name').value = name;
        row.querySelector('.cmd-text').value = cmd;
        row.querySelector('.cmd-run-box').checked = run;
      };
      add('Paste only', 'ls -la /tmp', false);
      add('Echo hi', 'echo hi', true);
      document.querySelector('#host-form [type=submit]').click();
    })()`);
    await until(() => js(`(hosts.find(x => x.name === 'target-direct').commands || []).length === 2`), 5000, 'commands saved');
    const saved = store.getHost(hDirect.id).commands;
    assert(saved[0].name === 'Paste only' && saved[1].run === true, JSON.stringify(saved));
  });

  await test('clicking a command pastes it; "Run" commands also press Enter', async () => {
    await js(`openTerminal(hosts.find(x => x.name === 'target-direct'))`);
    await until(() => termText().then((t) => t.includes('Welcome to target')), 10000, 'banner');
    const chips = await js(`[...document.querySelectorAll('.tabview.active .cmd-chip')].map(c => c.textContent)`);
    assert(chips.join('|') === 'Paste only|▶Echo hi|+', `chips: ${chips.join('|')}`);
    await js(`[...document.querySelectorAll('.tabview.active .cmd-chip')].find(c => c.textContent === 'Paste only').click()`);
    await until(() => termText().then((t) => t.includes('ls -la /tmp')), 5000, 'pasted text');
    await wait(500);
    assert(!(await termText()).includes('target says: ls -la /tmp'), 'paste-only command was executed');
    await js(`[...document.querySelectorAll('.tabview.active .cmd-chip')].find(c => c.textContent.endsWith('Echo hi')).click()`);
    // The server sees one line: the pasted text followed by the run command.
    await until(() => termText().then((t) => t.includes('target says: ls -la /tmpecho hi')), 5000, 'run command executed');
  });

  await test('"+" in the terminal saves a command for the host', async () => {
    await js(`(() => {
      const answers = ['whoami', 'Who am I'];
      const obs = new MutationObserver(() => {
        const m = document.querySelector('#dialog-modal');
        if (!m.classList.contains('hidden') && answers.length) {
          document.querySelector('#dialog-input').value = answers.shift();
          document.querySelector('#dialog-ok').click();
        }
      });
      obs.observe(document.querySelector('#dialog-modal'), { attributes: true });
      window.__obs2 = obs;
      [...document.querySelectorAll('.tabview.active .cmd-chip')].find(c => c.classList.contains('add')).click();
    })()`);
    await until(() => js(`[...document.querySelectorAll('.tabview.active .cmd-chip')].some(c => c.textContent === 'Who am I')`), 5000, 'new chip');
    assert(store.getHost(hDirect.id).commands.some((c) => c.command === 'whoami' && c.name === 'Who am I'), 'not saved to hosts.json');
    await js('window.__obs2.disconnect(); closeTab(activeTab)');
  });

  await test('local terminal has no command bar', async () => {
    await js('openTerminal(LOCAL_HOST)');
    await wait(300);
    assert(!(await js(`!!document.querySelector('.tabview.active .cmd-bar')`)), 'local terminal shows a command bar');
    await js('closeTab(activeTab)');
  });

  console.log('\nImport (Termius CSV / SSH config)');
  const impDir = path.join(tmp, 'import');
  fs.mkdirSync(path.join(impDir, 'config.d'), { recursive: true });
  fs.mkdirSync(path.join(impDir, 'keys'));
  fs.writeFileSync(path.join(impDir, 'keys', 'id_extra'), 'x');
  fs.writeFileSync(path.join(impDir, 'config'), [
    '# comment',
    'Include config.d/*',
    'Host bastion',
    '    HostName 127.0.0.1',
    `    Port ${jump1.port}`,
    '    User importer',
    'Host inner',
    '    HostName 127.0.0.1',
    `    Port ${target.port}`,
    '    User importer2',
    '    ProxyJump bastion',
    'Host legacy',
    '    HostName 10.0.0.5',
    '    ProxyCommand ssh -W %h:%p bastion',
    'Host web-*',
    '    User www',
    'Match host foo',
    '    User nope',
    'Host *',
    '    User defaultuser',
    '    ServerAliveInterval 30',
  ].join('\n'));
  fs.writeFileSync(path.join(impDir, 'config.d', 'extra'), [
    'Host extra',
    '  HostName=extra.example.com',
    '  IdentityFile keys/id_extra',
    '  ProxyJump admin@gateway.example.com:2222,jumpbox.example.com',
  ].join('\n'));
  // Exactly the columns termius-export writes (Termius' import template plus key/proxy columns).
  const csvFile = path.join(impDir, 'hosts.csv');
  fs.writeFileSync(csvFile, [
    'Groups,Label,Tags,Hostname,Protocol,Port,Username,Password,IdentityFile,KeyLabel,KeyPassphrase,ProxyType,ProxyHost,ProxyPort',
    `Klant B/Prod,csv-target,"web,prod",127.0.0.1,ssh,${target.port},importer,target-pass,,,,,,`,
    ',old switch,,10.0.0.9,telnet,23,admin,,,,,,,',
    ',"Web, ""main""",,web1.example.com,ssh,2200,deploy,,keys/id_extra,deploy-key,secret-pp,,,',
  ].join('\r\n') + '\r\n');

  await test('SSH config: hosts, Host * defaults, Include, ProxyJump and ProxyCommand -W', async () => {
    const r = importer.analyze(path.join(impDir, 'config'), store.listHosts());
    const by = (n) => r.candidates.find((c) => c.name === n);
    assert(!by('web-*') && !r.candidates.some((c) => c.username === 'nope'), 'wildcard/Match blocks must be skipped');
    assert(by('bastion').port === jump1.port && by('bastion').username === 'importer', 'bastion');
    assert(by('inner').jump && by('inner').jump.candidate === by('bastion').key, 'inner should go via bastion');
    assert(by('legacy').jump && by('legacy').jump.candidate === by('bastion').key, 'ProxyCommand ssh -W should become a jump host');
    assert(by('legacy').username === 'defaultuser', 'Host * default user not applied');
    const extra = by('extra');
    assert(extra && extra.host === 'extra.example.com', 'Include not followed');
    assert(extra.authType === 'key' && extra.privateKeyPath === path.join(impDir, 'keys', 'id_extra'), `key path ${extra.privateKeyPath}`);
    const jb = r.candidates.find((c) => c.key === extra.jump.candidate);
    const gw = r.candidates.find((c) => c.key === jb.jump.candidate);
    assert(jb.host === 'jumpbox.example.com' && gw.host === 'gateway.example.com' && gw.port === 2222 && gw.username === 'admin', 'ProxyJump chain');
    const pv = importer.preview(extra, r.candidates, store.listHosts());
    assert(pv.via.join(' → ') === 'gateway.example.com → jumpbox.example.com', `preview route: ${pv.via.join(' → ')}`);
  });

  await test('CSV (Termius / termius-export): columns, quotes, skipped protocols, keys', async () => {
    const r = importer.analyze(csvFile, store.listHosts());
    assert(r.format === 'CSV' && r.candidates.length === 2, `got ${r.candidates.length} hosts`);
    assert(r.warnings.some((w) => /telnet is not supported/.test(w)), 'telnet row should be reported');
    const [a, b] = r.candidates;
    assert(a.name === 'csv-target' && a.group === 'Klant B / Prod' && a.password === 'target-pass' && a.notes === 'Tags: web,prod', JSON.stringify({ ...a, password: !!a.password }));
    assert(b.name === 'Web, "main"' && b.port === 2200 && b.authType === 'key' && b.passphrase === 'secret-pp' && b.privateKeyPath === path.join(impDir, 'keys', 'id_extra'), JSON.stringify({ ...b, passphrase: !!b.passphrase }));
    assert(!JSON.stringify(importer.preview(a, r.candidates, [])).includes('target-pass'), 'the preview must not contain passwords');
    assert(!b.warnings.some((w) => /key file not found/.test(w)), 'existing key reported as missing');
    fs.writeFileSync(path.join(impDir, 'missing-key.csv'), 'Label,Hostname,Username,IdentityFile\nx,h.example.com,u,keys/nope\n');
    const m = importer.analyze(path.join(impDir, 'missing-key.csv'), []);
    assert(m.candidates[0].warnings.some((w) => /key file not found/.test(w)), 'missing key should be reported');
  });

  await test('imported CSV host connects with its imported (encrypted) password', async () => {
    const r = importer.analyze(csvFile, store.listHosts());
    const res = importer.apply(store, r, [r.candidates[0].key], '');
    assert(res.added.length === 1, JSON.stringify(res));
    const saved = store.listHosts().find((h) => h.name === 'csv-target');
    const raw = fs.readFileSync(path.join(process.env.SHELLFISH_DATA_DIR, 'hosts.json'), 'utf8');
    assert(!raw.includes('target-pass') || !store.canEncrypt(), 'password stored in plain text although encryption is available');
    const { r: sh } = await shellRoundTrip(saved.id);
    ssh.closeSession(sh.id);
    const again = importer.analyze(csvFile, store.listHosts());
    assert(again.candidates[0].existingId === saved.id, 'second import should recognise the saved host');
  });

  await test('importing a host also adds the jump hosts it needs, and connects through them', async () => {
    const r = importer.analyze(path.join(impDir, 'config'), store.listHosts());
    const inner = r.candidates.find((c) => c.name === 'inner');
    const res = importer.apply(store, r, [inner.key], 'Imported');
    assert(res.added.join(',') === 'bastion,inner' && res.pulledIn.join(',') === 'bastion', JSON.stringify(res));
    const hs = store.listHosts();
    const hInner = hs.find((h) => h.name === 'inner');
    const bastionId = hs.find((h) => h.name === 'bastion').id;
    assert(hInner.jumpHostId === bastionId && hInner.group === 'Imported', 'jump link / group');
    // The config has no passwords: supply them like the password prompts would.
    const { r: sh } = await shellRoundTrip(hInner.id, { secrets: { [bastionId]: { password: 'jump1-pass' }, [hInner.id]: { password: 'target-pass' } } });
    ssh.closeSession(sh.id);
  });

  await test('import through the UI: choose file, preview, import', async () => {
    nextOpenFile = csvFile;
    await js(`document.querySelector('#btn-import').click()`);
    await until(() => js(`!document.querySelector('#import-modal').classList.contains('hidden')`), 3000, 'import window');
    await js(`[...document.querySelectorAll('#import-card button')].find(b => b.textContent.startsWith('Choose a file')).click()`);
    await until(() => js(`document.querySelectorAll('.import-table tbody tr').length === 2`), 5000, 'preview rows');
    const rows = await js(`[...document.querySelectorAll('.import-table tbody tr')].map(r => ({ text: r.textContent, checked: r.querySelector('input').checked, disabled: r.querySelector('input').disabled }))`);
    assert(rows[0].disabled && /already saved/.test(rows[0].text), 'existing host should be shown as already saved');
    assert(rows[1].checked && !rows[1].disabled && /Web, "main"/.test(rows[1].text), JSON.stringify(rows));
    assert(!(await js(`document.querySelector('#import-card').textContent`)).includes('secret-pp'), 'passphrase leaked into the UI');
    await js(`[...document.querySelectorAll('#import-card button')].find(b => b.textContent.startsWith('Import 1')).click()`);
    await until(() => js(`hosts.some(h => h.name === 'Web, "main"')`), 5000, 'imported host in the sidebar');
    await until(() => js(`/Added 1 host/.test(document.querySelector('#dialog-message').textContent)`), 3000, 'done message');
    await js(`document.querySelector('#dialog-ok').click()`);
    assert(store.getHost(store.listHosts().find((h) => h.name === 'Web, "main"').id).passphrase, 'passphrase not saved');
    nextOpenFile = null;
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
