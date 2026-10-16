// Reads PuTTY private keys (.ppk, versions 2 and 3) and converts them, in memory, to the
// OpenSSH format that ssh2 understands. ssh2 itself only reads unencrypted-or-v2 RSA/DSA
// .ppk files, while PuTTY 0.75+ saves version 3 (Argon2) keys, often Ed25519/ECDSA.
//
// Format: https://the.earth.li/~sgtatham/putty/0.83/htmldoc/AppendixC.html
// The decrypted key is never written to disk.

const crypto = require('crypto');

function ppkError(message, code = 'ERROR') {
  const e = new Error(message);
  e.code = code;
  return e;
}

// ---- SSH wire format ---------------------------------------------------------------

class Reader {
  constructor(buf) { this.buf = buf; this.pos = 0; }
  string() {
    if (this.pos + 4 > this.buf.length) throw ppkError('Malformed PuTTY key');
    const len = this.buf.readUInt32BE(this.pos);
    const start = this.pos + 4;
    if (start + len > this.buf.length) throw ppkError('Malformed PuTTY key');
    this.pos = start + len;
    return this.buf.subarray(start, start + len);
  }
}

const u32 = (n) => { const b = Buffer.alloc(4); b.writeUInt32BE(n); return b; };
const str = (b) => { const buf = Buffer.isBuffer(b) ? b : Buffer.from(b); return Buffer.concat([u32(buf.length), buf]); };

// ---- parsing ------------------------------------------------------------------------

function parseFields(text) {
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  const fields = {};
  let i = 0;
  const takeBlock = (n) => { const b = lines.slice(i, i + n).join(''); i += n; return Buffer.from(b, 'base64'); };
  while (i < lines.length) {
    const m = /^([A-Za-z0-9-]+): ?(.*)$/.exec(lines[i]);
    i++;
    if (!m) continue;
    const [, key, value] = m;
    if (key === 'Public-Lines') fields.public = takeBlock(Number(value));
    else if (key === 'Private-Lines') fields.private = takeBlock(Number(value));
    else fields[key] = value;
  }
  return fields;
}

function isPpk(buf) {
  return /^PuTTY-User-Key-File-[23]:/.test(buf.toString('latin1', 0, 32));
}

// Argon2 for PPK v3: Node's built-in version needs OpenSSL 3.2+, but Electron uses
// BoringSSL, so fall back to @noble/hashes (pure JS, audited). Async keeps the UI responsive.
async function argon2(algo, { message, nonce, parallelism, tagLength, memory, passes }) {
  try {
    return await new Promise((resolve, reject) => crypto.argon2(algo, { message, nonce, parallelism, tagLength, memory, passes }, (e, out) => (e ? reject(e) : resolve(out))));
  } catch (e) {
    if (e.code !== 'ERR_CRYPTO_ARGON2_NOT_SUPPORTED') throw e;
  }
  const noble = require('@noble/hashes/argon2.js');
  const fn = { argon2id: noble.argon2idAsync, argon2i: noble.argon2iAsync, argon2d: noble.argon2dAsync }[algo];
  return Buffer.from(await fn(message, nonce, { t: passes, m: memory, p: parallelism, dkLen: tagLength }));
}

// Returns { type, comment, publicBlob, privateBlob } after verifying the MAC.
async function decrypt(text, passphrase) {
  const f = parseFields(text);
  const version = f['PuTTY-User-Key-File-3'] !== undefined ? 3 : f['PuTTY-User-Key-File-2'] !== undefined ? 2 : 0;
  if (!version) throw ppkError('Not a PuTTY key (version 2 or 3)');
  const type = f[`PuTTY-User-Key-File-${version}`];
  const encryption = f.Encryption;
  const comment = f.Comment || '';
  if (!f.public || !f.private || !f['Private-MAC']) throw ppkError('Malformed PuTTY key');
  if (encryption !== 'none' && encryption !== 'aes256-cbc') throw ppkError(`Unsupported PuTTY key encryption: ${encryption}`);

  const encrypted = encryption === 'aes256-cbc';
  if (encrypted && !passphrase) throw ppkError('Encrypted PuTTY key: no passphrase given', 'NEED_PASSPHRASE');
  const pass = encrypted ? Buffer.from(passphrase, 'utf8') : Buffer.alloc(0);

  let cipherKey, iv, macKey, macAlgo;
  if (version === 3) {
    macAlgo = 'sha256';
    if (encrypted) {
      const algo = { Argon2id: 'argon2id', Argon2i: 'argon2i', Argon2d: 'argon2d' }[f['Key-Derivation']];
      if (!algo) throw ppkError(`Unsupported PuTTY key derivation: ${f['Key-Derivation']}`);
      const out = await argon2(algo, {
        message: pass,
        nonce: Buffer.from(f['Argon2-Salt'], 'hex'),
        parallelism: Number(f['Argon2-Parallelism']),
        tagLength: 80,
        memory: Number(f['Argon2-Memory']),
        passes: Number(f['Argon2-Passes']),
      });
      cipherKey = out.subarray(0, 32);
      iv = out.subarray(32, 48);
      macKey = out.subarray(48, 80);
    } else {
      macKey = Buffer.alloc(0);
    }
  } else {
    macAlgo = 'sha1';
    if (encrypted) {
      const h = (n) => crypto.createHash('sha1').update(Buffer.concat([u32(n), pass])).digest();
      cipherKey = Buffer.concat([h(0), h(1)]).subarray(0, 32);
      iv = Buffer.alloc(16);
    }
    macKey = crypto.createHash('sha1').update(Buffer.concat([Buffer.from('putty-private-key-file-mac-key'), pass])).digest();
  }

  let privateBlob = f.private;
  if (encrypted) {
    const d = crypto.createDecipheriv('aes-256-cbc', cipherKey, iv);
    d.setAutoPadding(false);
    privateBlob = Buffer.concat([d.update(privateBlob), d.final()]);
  }

  const macData = Buffer.concat([str(type), str(encryption), str(comment), str(f.public), str(privateBlob)]);
  const mac = crypto.createHmac(macAlgo, macKey).update(macData).digest('hex');
  if (mac !== f['Private-MAC'].toLowerCase()) {
    throw encrypted ? ppkError('Wrong passphrase for the PuTTY key', 'NEED_PASSPHRASE') : ppkError('PuTTY key is corrupt (MAC mismatch)');
  }
  return { type, comment, publicBlob: f.public, privateBlob };
}

// ---- conversion to OpenSSH ------------------------------------------------------------

// Builds the type-specific part of an "openssh-key-v1" private key.
function opensshPrivate(type, pub, priv) {
  if (type === 'ssh-ed25519') {
    pub.string(); // type
    const pk = pub.string();
    const seed = priv.string();
    return [str(type), str(pk), str(Buffer.concat([seed, pk]))];
  }
  if (type === 'ssh-rsa') {
    pub.string();
    const e = pub.string();
    const n = pub.string();
    const d = priv.string();
    const p = priv.string();
    const q = priv.string();
    const iqmp = priv.string();
    return [str(type), str(n), str(e), str(d), str(iqmp), str(p), str(q)];
  }
  if (type.startsWith('ecdsa-sha2-')) {
    pub.string();
    const curve = pub.string();
    const q = pub.string();
    const d = priv.string();
    return [str(type), str(curve), str(q), str(d)];
  }
  if (type === 'ssh-dss') {
    pub.string();
    const [p, q, g, y] = [pub.string(), pub.string(), pub.string(), pub.string()];
    const x = priv.string();
    return [str(type), str(p), str(q), str(g), str(y), str(x)];
  }
  throw ppkError(`Unsupported PuTTY key type: ${type}`);
}

// Converts .ppk text to an unencrypted OpenSSH private key (PEM string).
async function ppkToOpenSsh(text, passphrase) {
  const { type, comment, publicBlob, privateBlob } = await decrypt(text, passphrase);
  const parts = opensshPrivate(type, new Reader(publicBlob), new Reader(privateBlob));
  const check = crypto.randomBytes(4);
  let section = Buffer.concat([check, check, ...parts, str(comment)]);
  const pad = (8 - (section.length % 8)) % 8;
  section = Buffer.concat([section, Buffer.from(Array.from({ length: pad }, (_, i) => i + 1))]);
  const body = Buffer.concat([
    Buffer.from('openssh-key-v1\0'),
    str('none'), str('none'), str(''), u32(1),
    str(publicBlob), str(section),
  ]);
  const b64 = body.toString('base64').replace(/.{70}/g, '$&\n');
  return `-----BEGIN OPENSSH PRIVATE KEY-----\n${b64.replace(/\n$/, '')}\n-----END OPENSSH PRIVATE KEY-----\n`;
}

module.exports = { isPpk, ppkToOpenSsh };
