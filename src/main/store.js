// Local, file-based storage for saved hosts and trusted host keys.
//
// Everything lives in a single data directory (default: ./data next to the app):
//   hosts.json        saved connections (human-readable JSON)
//   known_hosts.json  host key fingerprints you have trusted (TOFU)
//
// Secrets (passwords and key passphrases) are encrypted with the operating
// system's keychain via Electron safeStorage when one is available, and are
// written as "enc:<base64>". You may type a plaintext secret into hosts.json by
// hand; it will be encrypted automatically the next time the app starts.
// Files are written atomically with 0600 permissions (directory 0700).

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { safeStorage } = require('electron');

const SECRET_FIELDS = ['password', 'passphrase'];
const ENC_PREFIX = 'enc:';

class Store {
  constructor(dir) {
    this.dir = dir;
    this.hostsFile = path.join(dir, 'hosts.json');
    this.knownHostsFile = path.join(dir, 'known_hosts.json');
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    try { fs.chmodSync(dir, 0o700); } catch { /* not supported on this FS */ }
    this._migratePlaintextSecrets();
  }

  // ---- encryption -------------------------------------------------------

  canEncrypt() {
    if (!safeStorage.isEncryptionAvailable()) return false;
    // On Linux without a keyring Electron falls back to a hard-coded key,
    // which is obfuscation rather than encryption. Treat it as unavailable.
    if (process.platform === 'linux' && typeof safeStorage.getSelectedStorageBackend === 'function'
        && safeStorage.getSelectedStorageBackend() === 'basic_text') return false;
    return true;
  }

  seal(value) {
    if (!value) return '';
    if (!this.canEncrypt()) return value;
    return ENC_PREFIX + safeStorage.encryptString(value).toString('base64');
  }

  // Returns '' when the value cannot be decrypted (e.g. hosts.json copied from
  // another machine or user account); the user is then asked for it on connect.
  unseal(value) {
    if (!value) return '';
    if (!value.startsWith(ENC_PREFIX)) return value;
    try {
      return safeStorage.decryptString(Buffer.from(value.slice(ENC_PREFIX.length), 'base64'));
    } catch {
      return '';
    }
  }

  // ---- file helpers -----------------------------------------------------

  _read(file, fallback) {
    if (!fs.existsSync(file)) return fallback;
    const text = fs.readFileSync(file, 'utf8');
    try {
      return JSON.parse(text);
    } catch (e) {
      throw new Error(`${path.basename(file)} is not valid JSON (${e.message}). Fix or remove it; it will not be overwritten.`);
    }
  }

  _write(file, data) {
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n', { mode: 0o600 });
    fs.renameSync(tmp, file);
    try { fs.chmodSync(file, 0o600); } catch { /* ignore */ }
  }

  _readHostsDoc() {
    const doc = this._read(this.hostsFile, { version: 1, hosts: [] });
    if (!Array.isArray(doc.hosts)) doc.hosts = [];
    return doc;
  }

  _migratePlaintextSecrets() {
    if (!fs.existsSync(this.hostsFile) || !this.canEncrypt()) return;
    let doc;
    try { doc = this._readHostsDoc(); } catch { return; } // surfaced later via listHosts()
    let changed = false;
    for (const h of doc.hosts) {
      if (!h.id) { h.id = crypto.randomUUID(); changed = true; }
      for (const f of SECRET_FIELDS) {
        if (h[f] && !h[f].startsWith(ENC_PREFIX)) { h[f] = this.seal(h[f]); changed = true; }
      }
    }
    if (changed) this._write(this.hostsFile, doc);
  }

  // ---- hosts ------------------------------------------------------------

  // Hosts as seen by the UI: secrets are never sent to the renderer.
  listHosts() {
    return this._readHostsDoc().hosts.map(publicHost);
  }

  // Full host record including decrypted secrets (main process only).
  getHost(id) {
    const h = this._readHostsDoc().hosts.find((x) => x.id === id);
    if (!h) throw new Error('Host not found');
    return h;
  }

  // The hops to connect through, outermost first, ending with the host itself.
  getChain(id) {
    const hosts = this._readHostsDoc().hosts;
    const chain = [];
    for (let cur = id; cur;) {
      const h = hosts.find((x) => x.id === cur);
      if (!h) throw new Error(chain.length ? `Jump host of "${chain[0].name}" no longer exists` : 'Host not found');
      if (chain.includes(h)) throw new Error('Jump hosts form a loop; check the "Connect via" settings');
      chain.unshift(h);
      cur = h.jumpHostId;
    }
    return chain;
  }

  // input.password / input.passphrase: string = set, null/undefined = keep.
  // input.clearPassword / input.clearPassphrase: true = remove saved value.
  // input.copySecretsFrom: id of a host whose saved secrets a new (duplicated) host inherits.
  saveHost(input) {
    const doc = this._readHostsDoc();
    const existing = input.id ? doc.hosts.find((x) => x.id === input.id) : null;
    const source = !existing && input.copySecretsFrom ? doc.hosts.find((x) => x.id === input.copySecretsFrom) : null;

    const host = {
      id: existing ? existing.id : crypto.randomUUID(),
      name: str(input.name) || str(input.host),
      group: str(input.group),
      label: str(input.label).slice(0, 24),
      color: /^#[0-9a-f]{6}$/i.test(str(input.color)) ? str(input.color).toLowerCase() : '',
      host: str(input.host),
      port: Number(input.port) || 22,
      username: str(input.username),
      jumpHostId: str(input.jumpHostId),
      authType: input.authType === 'key' ? 'key' : 'password',
      password: existing?.password || source?.password || '',
      privateKeyPath: str(input.privateKeyPath),
      passphrase: existing?.passphrase || source?.passphrase || '',
      notes: str(input.notes),
      commands: cleanCommands(input.commands),
    };

    if (!host.host) throw new Error('Host / IP address is required');
    if (!host.username) throw new Error('Username is required');
    if (!Number.isInteger(host.port) || host.port < 1 || host.port > 65535) throw new Error('Port must be 1-65535');
    if (host.authType === 'key' && !host.privateKeyPath) throw new Error('Private key file is required for key authentication');
    if (host.jumpHostId) {
      // Walk the jump chain to reject missing hosts and loops (A via B via A).
      const seen = new Set([host.id]);
      for (let id = host.jumpHostId; id;) {
        if (seen.has(id)) throw new Error('This jump host would create a loop (a host cannot connect via itself)');
        seen.add(id);
        const jump = doc.hosts.find((x) => x.id === id);
        if (!jump) throw new Error('The selected jump host no longer exists');
        id = jump.jumpHostId;
      }
    }

    if (input.clearPassword) host.password = '';
    else if (typeof input.password === 'string' && input.password) host.password = this.seal(input.password);
    if (input.clearPassphrase) host.passphrase = '';
    else if (typeof input.passphrase === 'string' && input.passphrase) host.passphrase = this.seal(input.passphrase);

    if (host.authType === 'key') host.password = '';
    else { host.privateKeyPath = ''; host.passphrase = ''; }

    if (existing) doc.hosts[doc.hosts.indexOf(existing)] = host;
    else doc.hosts.push(host);
    this._write(this.hostsFile, doc);
    return publicHost(host);
  }

  deleteHost(id) {
    const doc = this._readHostsDoc();
    doc.hosts = doc.hosts.filter((x) => x.id !== id);
    this._write(this.hostsFile, doc);
  }

  // ---- known hosts ------------------------------------------------------

  getKnownHost(key) {
    return this._read(this.knownHostsFile, {})[key] || null;
  }

  setKnownHost(key, entry) {
    const all = this._read(this.knownHostsFile, {});
    all[key] = { ...entry, trustedAt: new Date().toISOString() };
    this._write(this.knownHostsFile, all);
  }
}

// Saved commands: [{ name, command, run }]. `run` = press Enter after pasting.
function cleanCommands(list) {
  if (!Array.isArray(list)) return [];
  return list
    .map((c) => ({
      name: str(c && c.name).slice(0, 60),
      command: typeof (c && c.command) === 'string' ? c.command.replace(/\r\n?/g, '\n').replace(/\n+$/, '').slice(0, 10000) : '',
      run: !!(c && c.run),
    }))
    .filter((c) => c.command.trim())
    .map((c) => ({ ...c, name: c.name || c.command.split('\n')[0].slice(0, 40) }))
    .slice(0, 100);
}

function str(v) {
  return typeof v === 'string' ? v.trim() : '';
}

function publicHost(h) {
  const { password, passphrase, ...rest } = h;
  return { ...rest, hasPassword: !!password, hasPassphrase: !!passphrase };
}

module.exports = { Store };
