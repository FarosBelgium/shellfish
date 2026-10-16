// Imports hosts from OpenSSH config files and CSV (the Termius import template, which is
// also what the open-source `termius-export` tool writes).
//
// Parsing produces "candidates"; the UI shows a preview (without any secrets) and the
// user picks which ones to save. Jump hosts (ProxyJump, `ProxyCommand ssh -W`) are kept
// as references between candidates and resolved to Shellfish host ids when saving.

const fs = require('fs');
const os = require('os');
const path = require('path');

const DEFAULT_KEYS = ['id_ed25519', 'id_ecdsa', 'id_rsa'];

// ---- helpers ---------------------------------------------------------------------

function expandPath(p, baseDir) {
  if (!p) return '';
  let out = p.replace(/^"(.*)"$/, '$1').replace(/%d/g, '~').replace(/%%/g, '%');
  if (out.startsWith('~')) return out; // kept with ~ so it stays valid if the home dir moves
  if (path.isAbsolute(out)) return out;
  // Relative paths: next to the imported file (termius-export writes keys/...), else ~/.ssh.
  const local = path.join(baseDir, out);
  if (fs.existsSync(local)) return local;
  return path.join('~', '.ssh', out);
}

// "user@host:port" -> parts (IPv6 in brackets supported)
function parseDestination(spec) {
  const m = /^(?:([^@]+)@)?(\[[^\]]+\]|[^:]+)(?::(\d+))?$/.exec(spec.trim());
  if (!m) return null;
  return { username: m[1] || '', host: m[2].replace(/^\[|\]$/g, ''), port: m[3] ? Number(m[3]) : 22 };
}

const isPattern = (s) => /[*?!]/.test(s);

// ---- OpenSSH config ----------------------------------------------------------------

function readConfigLines(file, depth = 0, seen = new Set()) {
  const real = path.resolve(file);
  if (depth > 5 || seen.has(real) || !fs.existsSync(real)) return [];
  seen.add(real);
  const out = [];
  for (const raw of fs.readFileSync(real, 'utf8').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const m = /^(\S+?)\s*(?:=\s*|\s+)(.*)$/.exec(line);
    if (!m) continue;
    const key = m[1].toLowerCase();
    const value = m[2].trim();
    if (key === 'include') {
      for (const pattern of value.split(/\s+/)) {
        // Relative to the including file's folder: for ~/.ssh/config that is ~/.ssh, as in ssh.
        const p = pattern.startsWith('~') ? path.join(os.homedir(), pattern.slice(1))
          : path.isAbsolute(pattern) ? pattern : path.join(path.dirname(real), pattern);
        for (const f of globSimple(p)) out.push(...readConfigLines(f, depth + 1, seen));
      }
      continue;
    }
    out.push({ key, value, file: real });
  }
  return out;
}

// Supports `*` in the file name part only (e.g. ~/.ssh/config.d/*), like most configs use.
function globSimple(p) {
  if (!p.includes('*')) return [p];
  const dir = path.dirname(p);
  const re = new RegExp('^' + path.basename(p).replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.') + '$');
  try {
    return fs.readdirSync(dir).filter((f) => re.test(f)).sort().map((f) => path.join(dir, f));
  } catch {
    return [];
  }
}

function parseSshConfig(file) {
  const baseDir = path.dirname(file);
  const blocks = [];
  let cur = null;
  for (const { key, value } of readConfigLines(file)) {
    if (key === 'host') {
      cur = { patterns: value.split(/\s+/).filter(Boolean), opts: {} };
      blocks.push(cur);
    } else if (key === 'match') {
      cur = null; // conditional blocks are not supported; skip their options
    } else if (cur && !(key in cur.opts)) {
      cur.opts[key] = value; // like ssh: the first value wins
    }
  }

  // `Host *` style blocks provide defaults for the concrete hosts.
  const defaults = {};
  for (const b of blocks) {
    if (b.patterns.every(isPattern) && b.patterns.includes('*')) {
      for (const [k, v] of Object.entries(b.opts)) if (!(k in defaults)) defaults[k] = v;
    }
  }

  const candidates = [];
  const warnings = [];
  for (const b of blocks) {
    const alias = b.patterns.find((p) => !isPattern(p));
    if (!alias) continue;
    const o = { ...defaults, ...b.opts };
    const host = (o.hostname || alias).replace(/%h/g, alias);
    const c = {
      key: `ssh:${alias}`,
      alias,
      name: alias,
      host,
      port: Number(o.port) || 22,
      username: o.user || '',
      group: '',
      notes: '',
      warnings: [],
    };
    if (o.identityfile) {
      c.authType = 'key';
      c.privateKeyPath = expandPath(o.identityfile, baseDir);
    } else {
      // ssh would try your default keys; use the first one that exists.
      const def = DEFAULT_KEYS.find((k) => fs.existsSync(path.join(os.homedir(), '.ssh', k)));
      if (def) {
        c.authType = 'key';
        c.privateKeyPath = `~/.ssh/${def}`;
        c.warnings.push(`no IdentityFile; using your default key ~/.ssh/${def}`);
      } else {
        c.authType = 'password';
      }
    }

    let jump = o.proxyjump && o.proxyjump.toLowerCase() !== 'none' ? o.proxyjump : '';
    if (!jump && o.proxycommand && o.proxycommand.toLowerCase() !== 'none') {
      // The classic bastion form: ProxyCommand ssh -W %h:%p bastion (or ssh bastion -W %h:%p)
      const m = /^ssh\s+(.*)$/.exec(o.proxycommand.trim());
      if (m && /-W\s*%h:%p/.test(m[1])) {
        const rest = m[1].replace(/-W\s*%h:%p/, ' ').split(/\s+/).filter(Boolean);
        const dest = rest.filter((t, i) => !t.startsWith('-') && !(i > 0 && /^-[bcDEeFIiJLlmOopQRSWw]$/.test(rest[i - 1]))).pop();
        if (dest) jump = dest;
      }
      if (!jump) c.warnings.push('ProxyCommand is not supported; imported as a direct connection');
    }
    c.jumpChain = jump ? jump.split(',').map((s) => s.trim()).filter(Boolean) : [];
    if (o.localforward || o.remoteforward || o.dynamicforward) c.warnings.push('port forwards are not imported');
    candidates.push(c);
  }
  if (!candidates.length) warnings.push('No hosts found (only wildcard or Match blocks?)');
  return { format: 'OpenSSH config', candidates, warnings };
}

// ---- CSV (Termius template / termius-export) ----------------------------------------

function parseCsvText(text) {
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;
  text = text.replace(/^﻿/, '');
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') { field += '"'; i++; }
      else if (ch === '"') quoted = false;
      else field += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ',') { row.push(field); field = ''; }
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      row.push(field); field = '';
      if (row.some((f) => f !== '')) rows.push(row);
      row = [];
    } else field += ch;
  }
  row.push(field);
  if (row.some((f) => f !== '')) rows.push(row);
  return rows;
}

const CSV_COLUMNS = {
  group: ['groups', 'group', 'folder'],
  name: ['label', 'name', 'alias', 'title'],
  tags: ['tags'],
  host: ['hostname', 'hostname/ip', 'host', 'address', 'ip', 'ip address'],
  protocol: ['protocol'],
  port: ['port', 'ssh port'],
  username: ['username', 'user', 'login'],
  password: ['password'],
  identityFile: ['identityfile', 'identity file', 'key', 'private key', 'keyfile'],
  passphrase: ['keypassphrase', 'key passphrase', 'passphrase'],
  proxyHost: ['proxyhost'],
};

function parseCsv(file) {
  const baseDir = path.dirname(file);
  const rows = parseCsvText(fs.readFileSync(file, 'utf8'));
  const warnings = [];
  if (rows.length < 2) return { format: 'CSV', candidates: [], warnings: ['The file has no host rows'] };
  const header = rows[0].map((h) => h.trim().toLowerCase());
  const col = {};
  for (const [k, names] of Object.entries(CSV_COLUMNS)) col[k] = header.findIndex((h) => names.includes(h));
  if (col.host < 0) return { format: 'CSV', candidates: [], warnings: [`No "Hostname" column found (columns: ${rows[0].join(', ')})`] };

  const get = (r, k) => (col[k] >= 0 ? (r[col[k]] || '').trim() : '');
  const candidates = [];
  rows.slice(1).forEach((r, i) => {
    const protocol = get(r, 'protocol').toLowerCase();
    const host = get(r, 'host');
    if (!host) return;
    if (protocol && protocol !== 'ssh') { warnings.push(`Row ${i + 2} (${get(r, 'name') || host}): ${protocol} is not supported, skipped`); return; }
    const c = {
      key: `csv:${i}`,
      name: get(r, 'name') || host,
      host,
      port: Number(get(r, 'port')) || 22,
      username: get(r, 'username'),
      group: get(r, 'group').replace(/\s*\/\s*/g, ' / '),
      notes: get(r, 'tags') ? `Tags: ${get(r, 'tags')}` : '',
      jumpChain: [],
      warnings: [],
    };
    const keyFile = get(r, 'identityFile');
    if (keyFile) {
      c.authType = 'key';
      c.privateKeyPath = expandPath(keyFile, baseDir);
      c.passphrase = get(r, 'passphrase');
    } else {
      c.authType = 'password';
      c.password = get(r, 'password');
    }
    if (get(r, 'proxyHost')) c.warnings.push('SOCKS/HTTP proxy is not supported; imported as a direct connection');
    candidates.push(c);
  });
  return { format: 'CSV', candidates, warnings };
}

// ---- shared ---------------------------------------------------------------------------

function parseFile(file) {
  const text = fs.readFileSync(file, 'utf8').slice(0, 4096);
  const firstLine = text.split(/\r?\n/).find((l) => l.trim()) || '';
  const looksCsv = /\.csv$/i.test(file) || (/,/.test(firstLine) && /host/i.test(firstLine) && !/^\s*host\s/i.test(firstLine));
  return looksCsv ? parseCsv(file) : parseSshConfig(file);
}

// Resolves jump references to other candidates (by alias), to existing Shellfish hosts
// (by name or address), or to new candidates created from a user@host:port spec.
function resolveJumps(result, existingHosts) {
  const byAlias = new Map();
  for (const c of result.candidates) byAlias.set((c.alias || c.name).toLowerCase(), c);
  const existingFor = (spec) => {
    const s = spec.toLowerCase();
    return existingHosts.find((h) => h.name.toLowerCase() === s || h.host.toLowerCase() === s);
  };
  const refFor = (spec) => {
    const c = byAlias.get(spec.toLowerCase());
    if (c) return { candidate: c.key };
    const ex = existingFor(spec);
    if (ex) return { existing: ex.id };
    const d = parseDestination(spec);
    if (!d) return null;
    const ex2 = existingHosts.find((h) => h.host.toLowerCase() === d.host.toLowerCase() && h.port === d.port && (!d.username || h.username === d.username));
    if (ex2) return { existing: ex2.id };
    const created = { key: `jump:${spec}`, alias: spec, name: d.host, host: d.host, port: d.port, username: d.username, authType: 'password', group: '', notes: 'Created as jump host during import', jumpChain: [], warnings: [] };
    result.candidates.push(created);
    byAlias.set(spec.toLowerCase(), created);
    return { candidate: created.key };
  };

  for (const c of [...result.candidates]) {
    // ProxyJump a,b: connect to a, then b, then the host. So the host goes via b, b via a.
    const refs = c.jumpChain.map(refFor);
    if (refs.some((r) => !r)) { c.warnings.push(`could not understand jump host "${c.jumpChain.join(',')}"`); continue; }
    if (refs.length) c.jump = refs[refs.length - 1];
    // In Shellfish "via" belongs to a host, so earlier hops can only be filled in on jump
    // hosts this import creates; changing a real host would reroute all its connections.
    for (let i = refs.length - 1; i > 0; i--) {
      const hop = refs[i].candidate && result.candidates.find((x) => x.key === refs[i].candidate);
      if (hop && hop.key.startsWith('jump:') && !hop.jump) hop.jump = refs[i - 1];
      else if (!(hop && hop.jump)) { c.warnings.push(`ProxyJump ${c.jumpChain.join(',')}: only the last hop is kept; set "Connect via" on ${c.jumpChain[i]} if needed`); break; }
    }
  }
}

// Marks candidates that match a saved host (same address, port and user).
function markExisting(result, existingHosts) {
  for (const c of result.candidates) {
    const ex = existingHosts.find((h) => h.host.toLowerCase() === c.host.toLowerCase() && h.port === c.port && h.username === c.username);
    if (ex) c.existingId = ex.id;
  }
}

// What the UI may see: no passwords or passphrases.
function preview(c, all, existingHosts) {
  const nameOf = (ref) => {
    if (!ref) return '';
    if (ref.existing) return existingHosts.find((h) => h.id === ref.existing)?.name || '?';
    return all.find((x) => x.key === ref.candidate)?.name || '?';
  };
  const via = [];
  for (let ref = c.jump, n = 0; ref && n < 10; n++) {
    via.unshift(nameOf(ref));
    ref = ref.candidate ? all.find((x) => x.key === ref.candidate)?.jump : null;
  }
  return {
    key: c.key, name: c.name, host: c.host, port: c.port, username: c.username, group: c.group,
    authType: c.authType, privateKeyPath: c.privateKeyPath || '', hasPassword: !!c.password,
    via, exists: !!c.existingId, warnings: c.warnings,
  };
}

function keyExists(p) {
  return fs.existsSync(p.startsWith('~') ? path.join(os.homedir(), p.slice(1)) : p);
}

function analyze(file, existingHosts) {
  const result = parseFile(file);
  for (const c of result.candidates) {
    if (c.authType === 'key' && !keyExists(c.privateKeyPath)) c.warnings.push(`key file not found: ${c.privateKeyPath} (fix it in the host editor after importing)`);
  }
  resolveJumps(result, existingHosts);
  markExisting(result, existingHosts);
  return result;
}

// Saves the selected candidates (plus any jump hosts they need), jump hosts first.
// Returns { added: [names], linkedExisting: n }.
function apply(store, result, selectedKeys, groupOverride) {
  const byKey = new Map(result.candidates.map((c) => [c.key, c]));
  const ids = new Map(); // candidate key -> saved host id
  const added = [];
  const pulledIn = [];
  const selected = new Set(selectedKeys);

  const save = (c, stack = []) => {
    if (ids.has(c.key)) return ids.get(c.key);
    if (c.existingId) { ids.set(c.key, c.existingId); return c.existingId; }
    if (stack.includes(c.key)) throw new Error(`Jump hosts form a loop around "${c.name}"`);
    let jumpHostId = '';
    if (c.jump) {
      if (c.jump.existing) jumpHostId = c.jump.existing;
      else {
        const jc = byKey.get(c.jump.candidate);
        if (!selected.has(jc.key) && !jc.existingId) pulledIn.push(jc.name);
        jumpHostId = save(jc, [...stack, c.key]);
      }
    }
    const saved = store.saveHost({
      name: c.name,
      group: groupOverride || c.group,
      host: c.host,
      port: c.port,
      username: c.username || 'root',
      authType: c.authType,
      privateKeyPath: c.privateKeyPath,
      password: c.password || null,
      passphrase: c.passphrase || null,
      jumpHostId,
      notes: [c.notes, c.username ? '' : 'No user in the import; set to "root", please check.'].filter(Boolean).join('\n'),
    });
    ids.set(c.key, saved.id);
    added.push(saved.name);
    return saved.id;
  };

  for (const key of selectedKeys) {
    const c = byKey.get(key);
    if (c) save(c);
  }
  return { added, pulledIn };
}

module.exports = { analyze, apply, preview, parseCsvText, parseDestination };
