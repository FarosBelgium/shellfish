// A small, self-contained SSH server for the test suite (pure JS, runs on every OS).
// Supports password + public key auth, a fake shell, SFTP backed by a local folder,
// and TCP forwarding (so it can act as a jump host).

const fs = require('fs');
const net = require('net');
const path = require('path');
const { Server, utils } = require('ssh2');

const { OPEN_MODE, STATUS_CODE } = utils.sftp;

// ssh2's key generator occasionally (~1 in 128) emits an Ed25519 key with a 31-byte
// public part that it cannot parse itself; regenerate until the key is valid.
function generateKey(type = 'ed25519', opts = {}) {
  for (;;) {
    const pair = utils.generateKeyPairSync(type, opts);
    if (!(utils.parseKey(pair.private, opts.passphrase) instanceof Error)) return pair;
  }
}

// `username` may be a list of accepted user names.
function startServer({ name, username = 'tester', password, publicKey, allowForwarding = true, root }) {
  const hostKey = generateKey().private;
  const allowedKeys = [].concat(publicKey || []).map((k) => utils.parseKey(k)); // one key or a list
  const stats = { connections: 0, open: 0, forwards: [], authFailures: 0 };

  const server = new Server({ hostKeys: [hostKey] }, (client) => {
    stats.connections++;
    stats.open++;
    client.on('close', () => { stats.open--; });
    client.on('error', () => {});

    client.on('authentication', (ctx) => {
      if (![].concat(username).includes(ctx.username)) { stats.authFailures++; return ctx.reject(); }
      if (ctx.method === 'password' && password) {
        if (ctx.password === password) return ctx.accept();
        stats.authFailures++;
        return ctx.reject();
      }
      if (ctx.method === 'publickey' && allowedKeys.length) {
        const key = allowedKeys.find((k) => ctx.key.data.equals(k.getPublicSSH()));
        if (!key) { stats.authFailures++; return ctx.reject(); }
        if (!ctx.signature) return ctx.accept(); // key is acceptable; client will sign
        return key.verify(ctx.blob, ctx.signature, ctx.hashAlgo) ? ctx.accept() : ctx.reject();
      }
      ctx.reject([password && 'password', allowedKeys.length && 'publickey'].filter(Boolean));
    });

    client.on('ready', () => {
      // TCP forwarding: this is what makes the server usable as a jump host.
      client.on('tcpip', (accept, reject, info) => {
        if (!allowForwarding) return reject();
        stats.forwards.push(`${info.destIP}:${info.destPort}`);
        const sock = net.connect(info.destPort, info.destIP);
        sock.once('error', () => reject());
        sock.once('connect', () => {
          const ch = accept();
          sock.pipe(ch).pipe(sock);
          ch.on('error', () => sock.destroy());
        });
      });

      client.on('session', (acceptSession) => {
        const session = acceptSession();
        session.on('pty', (accept) => accept && accept());
        session.on('window-change', (accept) => accept && accept());
        session.on('shell', (accept) => {
          // A fake shell: greets with the server name and echoes each line back.
          const stream = accept();
          stream.write(`Welcome to ${name}\r\n$ `);
          let line = '';
          stream.on('data', (d) => {
            for (const ch of d.toString()) {
              if (ch === '\r' || ch === '\n') {
                if (line === 'exit') { stream.exit(0); stream.end(); return; }
                stream.write(`\r\n${name} says: ${line}\r\n$ `);
                line = '';
              } else {
                line += ch;
                stream.write(ch);
              }
            }
          });
        });
        session.on('sftp', (accept) => serveSftp(accept(), root));
      });
    });
  });

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve({ name, port: server.address().port, stats, close: () => server.close() });
    });
  });
}

// Minimal SFTP server mapping "/" to `root` on disk.
function serveSftp(sftp, root) {
  const handles = new Map();
  let nextHandle = 0;
  const local = (p) => path.join(root, path.posix.normalize('/' + p));
  const newHandle = (value) => {
    const h = Buffer.alloc(4);
    h.writeUInt32BE(nextHandle++);
    handles.set(h.toString('hex'), value);
    return h;
  };
  const get = (h) => handles.get(h.toString('hex'));
  const attrs = (st) => ({ mode: st.mode, uid: 0, gid: 0, size: st.size, atime: Math.floor(st.atimeMs / 1000), mtime: Math.floor(st.mtimeMs / 1000) });
  const status = (id, err) => sftp.status(id, err ? (err.code === 'ENOENT' ? STATUS_CODE.NO_SUCH_FILE : STATUS_CODE.FAILURE) : STATUS_CODE.OK, err && err.message);

  sftp.on('REALPATH', (id, p) => {
    const norm = path.posix.normalize('/' + (p === '.' ? '' : p));
    sftp.name(id, [{ filename: norm, longname: norm, attrs: {} }]);
  });
  const statHandler = (fn) => (id, p) => {
    try { sftp.attrs(id, attrs(fn(local(p)))); } catch (e) { status(id, e); }
  };
  sftp.on('STAT', statHandler(fs.statSync));
  sftp.on('LSTAT', statHandler(fs.lstatSync));
  sftp.on('FSTAT', (id, h) => {
    try { sftp.attrs(id, attrs(fs.fstatSync(get(h).fd))); } catch (e) { status(id, e); }
  });
  sftp.on('OPENDIR', (id, p) => {
    try {
      const dir = local(p);
      const names = fs.readdirSync(dir).map((n) => ({ filename: n, longname: n, attrs: attrs(fs.lstatSync(path.join(dir, n))) }));
      sftp.handle(id, newHandle({ names, sent: false }));
    } catch (e) { status(id, e); }
  });
  sftp.on('READDIR', (id, h) => {
    const d = get(h);
    if (!d || d.sent) return sftp.status(id, STATUS_CODE.EOF);
    d.sent = true;
    d.names.length ? sftp.name(id, d.names) : sftp.status(id, STATUS_CODE.EOF);
  });
  sftp.on('OPEN', (id, p, flags) => {
    try {
      let mode = 'r';
      if (flags & OPEN_MODE.WRITE) mode = (flags & OPEN_MODE.APPEND) ? 'a' : 'w';
      sftp.handle(id, newHandle({ fd: fs.openSync(local(p), mode) }));
    } catch (e) { status(id, e); }
  });
  sftp.on('READ', (id, h, offset, length) => {
    const buf = Buffer.alloc(length);
    const n = fs.readSync(get(h).fd, buf, 0, length, offset);
    n ? sftp.data(id, buf.subarray(0, n)) : sftp.status(id, STATUS_CODE.EOF);
  });
  sftp.on('WRITE', (id, h, offset, data) => {
    try { fs.writeSync(get(h).fd, data, 0, data.length, offset); status(id); } catch (e) { status(id, e); }
  });
  sftp.on('CLOSE', (id, h) => {
    const v = get(h);
    if (v && v.fd != null) fs.closeSync(v.fd);
    handles.delete(h.toString('hex'));
    status(id);
  });
  const op = (fn) => (id, ...args) => { try { fn(...args); status(id); } catch (e) { status(id, e); } };
  sftp.on('MKDIR', op((p) => fs.mkdirSync(local(p))));
  sftp.on('RMDIR', op((p) => fs.rmdirSync(local(p))));
  sftp.on('REMOVE', op((p) => fs.unlinkSync(local(p))));
  sftp.on('RENAME', op((a, b) => fs.renameSync(local(a), local(b))));
  sftp.on('SETSTAT', op(() => {}));
  sftp.on('FSETSTAT', op(() => {}));
}

module.exports = { startServer, generateKey };
