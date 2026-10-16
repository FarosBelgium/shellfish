// SSH terminal and SFTP sessions, driven from the renderer over IPC.

const fs = require('fs');
const fsp = require('fs/promises');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { Client } = require('ssh2');
const { dialog } = require('electron');

const sessions = new Map(); // id -> { type, conn, stream?, sftp?, sender }

function expandHome(p) {
  return p && p.startsWith('~') ? path.join(os.homedir(), p.slice(1)) : p;
}

// ---- host key verification (trust on first use) ---------------------------

function describeKey(keyBuf) {
  let type = 'unknown';
  try {
    const len = keyBuf.readUInt32BE(0);
    type = keyBuf.subarray(4, 4 + len).toString('ascii');
  } catch { /* leave as unknown */ }
  const fingerprint = 'SHA256:' + crypto.createHash('sha256').update(keyBuf).digest('base64').replace(/=+$/, '');
  return { type, fingerprint };
}

async function verifyHostKey(win, store, host, keyBuf) {
  const id = `[${host.host}]:${host.port || 22}`;
  const { type, fingerprint } = describeKey(keyBuf);
  const known = store.getKnownHost(id);
  if (known && known.fingerprint === fingerprint) return true;

  if (known) {
    const r = await dialog.showMessageBox(win, {
      type: 'warning',
      title: 'Host key changed',
      message: `WARNING: the host key for ${id} has CHANGED`,
      detail: `Someone could be intercepting this connection (man-in-the-middle), or the server was reinstalled.\n\n`
        + `Previously trusted: ${known.type} ${known.fingerprint}\n`
        + `Now offered:        ${type} ${fingerprint}\n\n`
        + `Only accept if you know why the key changed.`,
      buttons: ['Cancel connection', 'Accept new key'],
      defaultId: 0,
      cancelId: 0,
    });
    if (r.response !== 1) return false;
  } else {
    const r = await dialog.showMessageBox(win, {
      type: 'question',
      title: 'Unknown host',
      message: `First connection to ${id}`,
      detail: `The server presented this host key:\n\n${type}\n${fingerprint}\n\nVerify it with the server administrator before trusting it.`,
      buttons: ['Cancel', 'Trust and connect'],
      defaultId: 1,
      cancelId: 0,
    });
    if (r.response !== 1) return false;
  }
  store.setKnownHost(id, { type, fingerprint });
  return true;
}

// ---- connecting -------------------------------------------------------------

function classifyError(err) {
  const msg = String(err && err.message || err);
  if (/passphrase/i.test(msg) && /(no passphrase|bad passphrase|decrypt|encrypted)/i.test(msg)) return 'NEED_PASSPHRASE';
  if (/All configured authentication methods failed/i.test(msg)) return 'AUTH_FAILED';
  if (/host key|hostkey|verification failed/i.test(msg)) return 'HOSTKEY_REJECTED';
  return 'ERROR';
}

// opts.password / opts.passphrase override the saved secret for this attempt only.
function connectClient(win, store, hostId, opts = {}) {
  return new Promise((resolve, reject) => {
    let host;
    const cfg = {};
    try {
      host = store.getHost(hostId);
      Object.assign(cfg, {
        host: host.host,
        port: host.port || 22,
        username: host.username,
        readyTimeout: 60000, // includes time spent in the host key dialog
        keepaliveInterval: 15000,
        keepaliveCountMax: 4,
        hostVerifier: (key, verify) => {
          verifyHostKey(win, store, host, key).then(verify, () => verify(false));
        },
      });
      if (host.authType === 'key') {
        const keyPath = expandHome(host.privateKeyPath);
        try { cfg.privateKey = fs.readFileSync(keyPath); } catch (e) { throw new Error(`Cannot read private key ${keyPath}: ${e.message}`); }
        const pp = opts.passphrase ?? store.unseal(host.passphrase);
        if (pp) cfg.passphrase = pp;
      } else {
        const pw = opts.password ?? store.unseal(host.password);
        if (!pw) { const e = new Error('No password saved for this host'); e.code = 'AUTH_FAILED'; throw e; }
        cfg.password = pw;
        cfg.tryKeyboard = true; // many servers only offer keyboard-interactive for passwords
      }
    } catch (e) {
      e.code = e.code || classifyError(e);
      return reject(e);
    }

    const conn = new Client();
    let settled = false;
    if (cfg.tryKeyboard) {
      conn.on('keyboard-interactive', (_n, _i, _l, prompts, finish) => finish(prompts.map(() => cfg.password)));
    }
    conn.once('ready', () => {
      settled = true;
      resolve({ conn, host });
    });
    conn.on('error', (err) => {
      if (!settled) {
        settled = true;
        err.code = classifyError(err);
        reject(err);
      }
    });
    try {
      conn.connect(cfg);
    } catch (e) {
      settled = true;
      e.code = classifyError(e);
      reject(e);
    }
  });
}

function toIpcError(e) {
  return { ok: false, code: e.code || 'ERROR', message: String(e.message || e) };
}

function newId() {
  return crypto.randomUUID();
}

function send(sender, channel, ...args) {
  if (!sender.isDestroyed()) sender.send(channel, ...args);
}

// ---- terminal ---------------------------------------------------------------

async function openShell(win, store, sender, { hostId, cols, rows, password, passphrase }) {
  let conn;
  try {
    ({ conn } = await connectClient(win, store, hostId, { password, passphrase }));
  } catch (e) {
    return toIpcError(e);
  }
  return new Promise((resolve) => {
    conn.shell({ term: 'xterm-256color', cols: cols || 80, rows: rows || 24 }, (err, stream) => {
      if (err) { conn.end(); return resolve(toIpcError(err)); }
      const id = newId();
      sessions.set(id, { type: 'shell', conn, stream, sender });
      stream.on('data', (d) => send(sender, 'ssh:data', id, d));
      stream.stderr.on('data', (d) => send(sender, 'ssh:data', id, d));
      const closed = (reason) => {
        if (!sessions.has(id)) return;
        sessions.delete(id);
        send(sender, 'ssh:closed', id, reason || null);
        conn.end();
      };
      stream.on('close', () => closed());
      conn.on('close', () => closed());
      conn.on('error', (e) => closed(e.message));
      resolve({ ok: true, id });
    });
  });
}

function shellWrite(id, data) {
  const s = sessions.get(id);
  if (s && s.stream) s.stream.write(data);
}

function shellResize(id, cols, rows) {
  const s = sessions.get(id);
  if (s && s.stream) s.stream.setWindow(rows, cols, 0, 0);
}

function closeSession(id) {
  const s = sessions.get(id);
  if (!s) return;
  sessions.delete(id);
  try { s.conn.end(); } catch { /* already gone */ }
}

function closeAllForSender(sender) {
  for (const [id, s] of sessions) if (s.sender === sender) closeSession(id);
}

// ---- SFTP -------------------------------------------------------------------

function p(fn) {
  return new Promise((resolve, reject) => fn((err, res) => (err ? reject(err) : resolve(res))));
}

async function openSftp(win, store, sender, { hostId, password, passphrase }) {
  let conn;
  try {
    ({ conn } = await connectClient(win, store, hostId, { password, passphrase }));
    const sftp = await p((cb) => conn.sftp(cb));
    const home = await p((cb) => sftp.realpath('.', cb)).catch(() => '/');
    const id = newId();
    sessions.set(id, { type: 'sftp', conn, sftp, sender });
    conn.on('close', () => {
      if (sessions.delete(id)) send(sender, 'sftp:closed', id);
    });
    conn.on('error', () => {});
    return { ok: true, id, home };
  } catch (e) {
    if (conn) conn.end();
    return toIpcError(e);
  }
}

function getSftp(id) {
  const s = sessions.get(id);
  if (!s || s.type !== 'sftp') throw new Error('SFTP session is closed');
  return s.sftp;
}

const S_IFMT = 0o170000, S_IFDIR = 0o040000, S_IFLNK = 0o120000;

async function remoteList(id, dir) {
  const sftp = getSftp(id);
  const real = await p((cb) => sftp.realpath(dir, cb));
  const list = await p((cb) => sftp.readdir(real, cb));
  const entries = await Promise.all(list.map(async (e) => {
    let mode = e.attrs.mode;
    let isLink = (mode & S_IFMT) === S_IFLNK;
    let isDir = (mode & S_IFMT) === S_IFDIR;
    let size = e.attrs.size;
    if (isLink) {
      // Follow symlinks so linked folders can be browsed.
      try {
        const st = await p((cb) => sftp.stat(path.posix.join(real, e.filename), cb));
        isDir = st.isDirectory();
        size = st.size;
      } catch { /* dangling link */ }
    }
    return { name: e.filename, isDir, isLink, size, mtime: e.attrs.mtime * 1000, mode: mode & 0o7777 };
  }));
  return { path: real, entries };
}

async function remoteMkdir(id, dir) {
  await p((cb) => getSftp(id).mkdir(dir, cb));
}

async function remoteRename(id, from, to) {
  await p((cb) => getSftp(id).rename(from, to, cb));
}

async function remoteDelete(id, target) {
  const sftp = getSftp(id);
  const st = await p((cb) => sftp.lstat(target, cb));
  if (st.isDirectory()) {
    const list = await p((cb) => sftp.readdir(target, cb));
    for (const e of list) await remoteDelete(id, path.posix.join(target, e.filename));
    await p((cb) => sftp.rmdir(target, cb));
  } else {
    await p((cb) => sftp.unlink(target, cb));
  }
}

// ---- transfers --------------------------------------------------------------

// Builds a flat plan of {kind:'dir'|'file', src, dst, size} for recursive copies.
async function planUpload(localPaths, remoteDir) {
  const plan = [];
  async function walk(src, dst) {
    const st = await fsp.stat(src);
    if (st.isDirectory()) {
      plan.push({ kind: 'dir', dst });
      for (const name of await fsp.readdir(src)) await walk(path.join(src, name), path.posix.join(dst, name));
    } else if (st.isFile()) {
      plan.push({ kind: 'file', src, dst, size: st.size });
    }
  }
  for (const lp of localPaths) await walk(lp, path.posix.join(remoteDir, path.basename(lp)));
  return plan;
}

async function planDownload(sftp, remotePaths, localDir) {
  const plan = [];
  async function walk(src, dst) {
    const st = await p((cb) => sftp.stat(src, cb));
    if (st.isDirectory()) {
      plan.push({ kind: 'dir', dst });
      const list = await p((cb) => sftp.readdir(src, cb));
      for (const e of list) await walk(path.posix.join(src, e.filename), path.join(dst, e.filename));
    } else {
      plan.push({ kind: 'file', src, dst, size: st.size });
    }
  }
  for (const rp of remotePaths) await walk(rp, path.join(localDir, path.posix.basename(rp)));
  return plan;
}

async function runTransfer(sender, id, direction, sources, targetDir) {
  const sftp = getSftp(id);
  const transferId = newId();
  const label = sources.length === 1 ? path.basename(sources[0]) : `${sources.length} items`;
  const progress = (extra) => send(sender, 'sftp:progress', { transferId, sessionId: id, direction, label, ...extra });

  (async () => {
    try {
      progress({ state: 'preparing' });
      const plan = direction === 'upload'
        ? await planUpload(sources, targetDir)
        : await planDownload(sftp, sources, targetDir);
      const total = plan.reduce((n, x) => n + (x.size || 0), 0);
      const files = plan.filter((x) => x.kind === 'file').length;
      let done = 0, filesDone = 0, lastEmit = 0;
      progress({ state: 'running', total, done, files, filesDone });

      for (const item of plan) {
        if (item.kind === 'dir') {
          if (direction === 'upload') await p((cb) => sftp.mkdir(item.dst, cb)).catch(() => {});
          else await fsp.mkdir(item.dst, { recursive: true });
          continue;
        }
        let fileDone = 0;
        const step = (transferred) => {
          done += transferred - fileDone;
          fileDone = transferred;
          const now = Date.now();
          if (now - lastEmit > 150) { lastEmit = now; progress({ state: 'running', total, done, files, filesDone, current: path.basename(item.src) }); }
        };
        if (direction === 'upload') await p((cb) => sftp.fastPut(item.src, item.dst, { step }, cb));
        else await p((cb) => sftp.fastGet(item.src, item.dst, { step }, cb));
        done += item.size - fileDone;
        filesDone++;
      }
      progress({ state: 'done', total, done: total, files, filesDone });
    } catch (e) {
      progress({ state: 'error', message: e.message });
    }
  })();

  return { ok: true, transferId };
}

// ---- local filesystem (left pane) --------------------------------------------

async function localList(dir) {
  const real = await fsp.realpath(expandHome(dir || os.homedir()));
  const names = await fsp.readdir(real);
  const entries = await Promise.all(names.map(async (name) => {
    const full = path.join(real, name);
    try {
      const lst = await fsp.lstat(full);
      let st = lst;
      if (lst.isSymbolicLink()) st = await fsp.stat(full).catch(() => lst);
      return { name, isDir: st.isDirectory(), isLink: lst.isSymbolicLink(), size: st.size, mtime: st.mtimeMs, mode: st.mode & 0o7777 };
    } catch {
      return null; // permission denied etc.
    }
  }));
  return { path: real, entries: entries.filter(Boolean) };
}

module.exports = {
  openShell, shellWrite, shellResize, closeSession, closeAllForSender,
  openSftp, remoteList, remoteMkdir, remoteRename, remoteDelete, runTransfer,
  localList, toIpcError,
};
