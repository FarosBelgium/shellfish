'use strict';
/* global Terminal, FitAddon, api */


// ===========================================================================
// Small helpers
// ===========================================================================

const $ = (sel, root = document) => root.querySelector(sel);

// Builds DOM nodes. Text is always set via textContent, never parsed as HTML,
// so file names and host names cannot inject markup.
function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k === 'class') node.className = v;
    else if (k === 'text') node.textContent = v;
    else if (k.startsWith('on')) node.addEventListener(k.slice(2), v);
    else if (k === 'dataset') Object.assign(node.dataset, v);
    else node.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat()) if (c != null) node.append(c);
  return node;
}

function fmtSize(n) {
  if (n == null) return '';
  const u = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
  return `${i ? n.toFixed(n < 10 ? 1 : 0) : n} ${u[i]}`;
}

function fmtDate(ms) {
  if (!ms) return '';
  const d = new Date(ms);
  const pad = (x) => String(x).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function fmtMode(mode, isDir) {
  const r = (b, c) => (mode & b ? c : '-');
  return (isDir ? 'd' : '-')
    + r(0o400, 'r') + r(0o200, 'w') + r(0o100, 'x')
    + r(0o040, 'r') + r(0o020, 'w') + r(0o010, 'x')
    + r(0o004, 'r') + r(0o002, 'w') + r(0o001, 'x');
}

const remotePath = {
  sep: '/',
  join: (dir, name) => (dir.endsWith('/') ? dir + name : `${dir}/${name}`),
  parent: (p) => {
    const s = p.replace(/\/+$/, '');
    const i = s.lastIndexOf('/');
    return i <= 0 ? '/' : s.slice(0, i);
  },
};

const localSep = api.platform === 'win32' ? '\\' : '/';
const localPath = {
  sep: localSep,
  join: (dir, name) => (dir.endsWith(localSep) ? dir + name : dir + localSep + name),
  parent: (p) => {
    if (localSep === '/') return remotePath.parent(p);
    const s = p.replace(/\\+$/, '');
    const i = s.lastIndexOf('\\');
    if (i < 0) return p;
    const up = s.slice(0, i);
    return /^[A-Za-z]:$/.test(up) ? `${up}\\` : up;
  },
};

// Unwraps {ok,data} from the main process or throws.
async function call(promise) {
  const r = await promise;
  if (!r.ok) {
    const e = new Error(r.message);
    e.code = r.code;
    throw e;
  }
  return r.data;
}

// ===========================================================================
// Prompt / confirm dialogs
// ===========================================================================

let dialogResolve = null;

function openDialog({ title, message = '', input = false, type = 'text', value = '', okText = 'OK', danger = false }) {
  if (dialogResolve) dialogResolve(null);
  const modal = $('#dialog-modal');
  const inp = $('#dialog-input');
  $('#dialog-title').textContent = title;
  $('#dialog-message').textContent = message;
  $('#dialog-message').hidden = !message;
  inp.hidden = !input;
  inp.type = type;
  inp.value = value;
  const ok = $('#dialog-ok');
  ok.textContent = okText;
  ok.className = `btn ${danger ? 'danger' : 'primary'}`;
  modal.classList.remove('hidden');
  setTimeout(() => {
    if (input) {
      inp.focus();
      // Select the name without extension, like a file manager does.
      const dot = value.lastIndexOf('.');
      inp.setSelectionRange(0, dot > 0 ? dot : value.length);
    } else ok.focus();
  }, 0);
  return new Promise((resolve) => {
    dialogResolve = (v) => {
      dialogResolve = null;
      modal.classList.add('hidden');
      resolve(v);
    };
  });
}

const promptDialog = (opts) => openDialog({ ...opts, input: true });
const confirmDialog = async (opts) => (await openDialog(opts)) !== null;

$('#dialog-form').addEventListener('submit', (e) => {
  e.preventDefault();
  if (dialogResolve) dialogResolve($('#dialog-input').hidden ? true : $('#dialog-input').value);
});
$('#dialog-cancel').addEventListener('click', () => dialogResolve && dialogResolve(null));

function alertError(title, err) {
  return openDialog({ title, message: String(err && err.message || err), okText: 'Close' });
}

document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  if (!$('#dialog-modal').classList.contains('hidden')) dialogResolve && dialogResolve(null);
  else if (!$('#host-modal').classList.contains('hidden')) closeHostEditor();
});

// ===========================================================================
// Hosts sidebar + editor
// ===========================================================================

let hosts = [];

async function loadHosts() {
  try {
    hosts = await call(api.hosts.list());
  } catch (e) {
    hosts = [];
    alertError('Could not read hosts.json', e);
  }
  renderHostList();
}

// Sets --env (and a background tint for terminals) on an element for a host's environment colour.
function applyEnvColor(node, h) {
  if (!h.color) return;
  node.style.setProperty('--env', h.color);
}

// Mixes an environment colour into the terminal background so it is noticeable but stays readable.
function tint(base, color, amount) {
  const rgb = (hex) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
  const [a, b] = [rgb(base), rgb(color)];
  return '#' + a.map((v, i) => Math.round(v + (b[i] - v) * amount).toString(16).padStart(2, '0')).join('');
}

// Pseudo-host for terminals on this computer.
const LOCAL_HOST = { id: '__local__', name: 'Local', local: true };

function hostLabel(h) {
  return `${h.username}@${h.host}${h.port && h.port !== 22 ? `:${h.port}` : ''}`;
}

function renderHostList() {
  const list = $('#host-list');
  const q = $('#host-search').value.trim().toLowerCase();
  list.replaceChildren(el('div', {
    class: 'host local-host',
    title: 'Open a terminal on this computer (Ctrl+Shift+T)',
    onclick: () => openTerminal(LOCAL_HOST),
  },
  el('span', { class: 'local-icon', text: '>_' }),
  el('div', { class: 'host-main' },
    el('div', { class: 'host-name', text: 'Local terminal' }),
    el('div', { class: 'host-sub', text: 'this computer' }))));

  const matches = hosts
    .filter((h) => !q || [h.name, h.host, h.username, h.group, h.label, h.notes].some((v) => v && v.toLowerCase().includes(q)))
    .sort((a, b) => (a.group || '').localeCompare(b.group || '') || a.name.localeCompare(b.name));

  if (!hosts.length) {
    list.append(el('div', { class: 'empty', text: 'No saved hosts yet.' }));
    return;
  }
  if (!matches.length) {
    list.append(el('div', { class: 'empty', text: 'No matches.' }));
    return;
  }

  let currentGroup;
  for (const h of matches) {
    const g = h.group || '';
    if (g !== currentGroup) {
      currentGroup = g;
      if (g) list.append(el('div', { class: 'group-title', text: g }));
    }
    const item = el('div', {
      class: `host${h.color ? ' has-env' : ''}`,
      title: `${hostLabel(h)}\nClick to open a terminal${h.notes ? `\n\n${h.notes}` : ''}`,
      onclick: () => openTerminal(h),
    },
    el('div', { class: 'host-main' },
      el('div', { class: 'host-name', text: h.name }),
      el('div', { class: 'host-sub', text: hostLabel(h) })),
    h.label ? el('span', { class: 'env-badge', text: h.label }) : null,
    el('span', { class: 'auth-badge', title: h.authType === 'key' ? 'Private key' : 'Password', text: h.authType === 'key' ? 'key' : 'pw' }),
    el('div', { class: 'host-actions' },
      el('button', { class: 'btn small', title: 'Open SSH terminal', text: 'SSH', onclick: (e) => { e.stopPropagation(); openTerminal(h); } }),
      el('button', { class: 'btn small', title: 'Open SFTP file browser', text: 'SFTP', onclick: (e) => { e.stopPropagation(); openSftp(h); } }),
      el('button', { class: 'btn small icon', title: 'Duplicate host', text: '⧉', onclick: (e) => { e.stopPropagation(); openHostEditor(h, { duplicate: true }); } }),
      el('button', { class: 'btn small icon', title: 'Edit host', text: '✎', onclick: (e) => { e.stopPropagation(); openHostEditor(h); } })));
    applyEnvColor(item, h);
    list.append(item);
  }
}

async function renderStoreInfo() {
  try {
    const info = await call(api.store.info());
    const box = $('#store-info');
    box.replaceChildren(
      el('div', { class: info.encrypted ? 'ok' : 'warn', text: info.encrypted ? '🔒 Secrets encrypted with OS keychain' : '⚠ No OS keychain: secrets saved in plain text' }),
      el('a', { href: '#', title: info.file, text: 'Show hosts.json', onclick: (e) => { e.preventDefault(); api.store.reveal(); } }),
    );
  } catch { /* non-fatal */ }
}

$('#host-search').addEventListener('input', renderHostList);
$('#btn-new-host').addEventListener('click', () => openHostEditor(null));

// ---- editor ----

const form = $('#host-form');
let clearFlags = {};
let duplicateFrom = null; // host id whose saved secrets a duplicate inherits

function setEnv(label, color) {
  form.elements.label.value = label;
  form.elements.color.value = color;
  $('#color-swatch').style.background = color || 'transparent';
  $('#color-swatch').classList.toggle('none', !color);
  if (color) $('#color-picker').value = color;
  for (const chip of form.querySelectorAll('.env-chip')) chip.classList.toggle('active', chip.dataset.color === color);
}

for (const chip of form.querySelectorAll('.env-chip')) {
  chip.style.setProperty('--env', chip.dataset.color || 'var(--muted)');
  chip.addEventListener('click', () => setEnv(chip.dataset.label, chip.dataset.color));
}
$('#color-picker').addEventListener('input', (e) => setEnv(form.elements.label.value, e.target.value));

function setAuthPane(type) {
  for (const pane of form.querySelectorAll('.auth-pane')) pane.classList.toggle('hidden', pane.dataset.auth !== type);
}

// opts.duplicate: open a new, unsaved copy of h (including its saved secrets).
function openHostEditor(h, { duplicate = false } = {}) {
  form.reset();
  clearFlags = {};
  duplicateFrom = duplicate ? h.id : null;
  const editing = h && !duplicate;
  $('#host-form-error').textContent = '';
  $('#host-form-title').textContent = duplicate ? `Copy of ${h.name}` : editing ? `Edit ${h.name}` : 'New host';
  $('#btn-delete-host').hidden = !editing;
  $('#btn-duplicate-host').hidden = !editing;
  const f = form.elements;
  f.id.value = editing ? h.id : '';
  f.name.value = duplicate ? `${h.name} (copy)` : h?.name || '';
  f.group.value = h?.group || '';
  f.host.value = h?.host || '';
  f.port.value = h?.port || 22;
  f.username.value = h?.username || '';
  f.privateKeyPath.value = h?.privateKeyPath || '';
  f.notes.value = h?.notes || '';
  const auth = h?.authType || 'password';
  form.querySelector(`input[name=authType][value=${auth}]`).checked = true;
  setAuthPane(auth);
  setEnv(h?.label || '', h?.color || '');
  const saved = duplicate ? '•••••• copied from original (type to replace)' : '•••••• saved (type to replace)';
  f.password.placeholder = h?.hasPassword ? saved : 'leave empty to be asked on connect';
  f.passphrase.placeholder = h?.hasPassphrase ? saved : 'only if the key is encrypted';
  form.querySelector('[data-clear=password]').hidden = !h?.hasPassword;
  form.querySelector('[data-clear=passphrase]').hidden = !h?.hasPassphrase;

  $('#group-options').replaceChildren(...[...new Set(hosts.map((x) => x.group).filter(Boolean))].map((g) => el('option', { value: g })));
  $('#host-modal').classList.remove('hidden');
  if (duplicate) { f.host.focus(); f.host.select(); } else (h ? f.name : f.host).focus();
}

function closeHostEditor() {
  $('#host-modal').classList.add('hidden');
  form.reset(); // drop any typed secret from the DOM
}

form.addEventListener('change', (e) => {
  if (e.target.name === 'authType') setAuthPane(e.target.value);
});

for (const btn of form.querySelectorAll('[data-clear]')) {
  btn.addEventListener('click', () => {
    const field = btn.dataset.clear;
    clearFlags[field] = true;
    form.elements[field].value = '';
    form.elements[field].placeholder = 'will be forgotten on save';
    btn.hidden = true;
  });
}

form.querySelector('[data-close]').addEventListener('click', closeHostEditor);

$('#btn-pick-key').addEventListener('click', async () => {
  const p = await call(api.pickKey());
  if (p) form.elements.privateKeyPath.value = p;
});

form.addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = form.elements;
  const input = {
    id: f.id.value || undefined,
    name: f.name.value,
    group: f.group.value,
    host: f.host.value,
    port: Number(f.port.value),
    username: f.username.value,
    authType: form.querySelector('input[name=authType]:checked').value,
    privateKeyPath: f.privateKeyPath.value,
    notes: f.notes.value,
    label: f.label.value,
    color: f.color.value,
    copySecretsFrom: duplicateFrom || undefined,
    password: f.password.value || null,
    passphrase: f.passphrase.value || null,
    clearPassword: !!clearFlags.password,
    clearPassphrase: !!clearFlags.passphrase,
  };
  try {
    await call(api.hosts.save(input));
    closeHostEditor();
    await loadHosts();
  } catch (err) {
    $('#host-form-error').textContent = err.message;
  }
});

$('#btn-duplicate-host').addEventListener('click', () => {
  const h = hosts.find((x) => x.id === form.elements.id.value);
  if (h) openHostEditor(h, { duplicate: true });
});

$('#btn-delete-host').addEventListener('click', async () => {
  const id = form.elements.id.value;
  const h = hosts.find((x) => x.id === id);
  if (!h) return;
  if (!(await confirmDialog({ title: 'Delete host', message: `Remove "${h.name}" (${hostLabel(h)}) from saved hosts?`, okText: 'Delete', danger: true }))) return;
  try {
    await call(api.hosts.remove(id));
    closeHostEditor();
    await loadHosts();
  } catch (err) {
    $('#host-form-error').textContent = err.message;
  }
});

// ===========================================================================
// Connecting (with password / passphrase prompts)
// ===========================================================================

async function connectWithPrompts(kind, host, extra = {}) {
  const opts = { hostId: host.id, ...extra };
  const open = kind === 'ssh' ? api.ssh.open : api.sftp.open;
  for (let attempt = 0; attempt < 4; attempt++) {
    const res = await open(opts);
    if (res.ok) return res;

    if (res.code === 'AUTH_FAILED' && host.authType === 'password') {
      const tried = attempt > 0 || host.hasPassword;
      const pw = await promptDialog({
        title: `Password for ${hostLabel(host)}`,
        message: tried ? 'Authentication failed. Try again:' : 'Enter password (not saved):',
        type: 'password',
        okText: 'Connect',
      });
      if (pw == null) return { ok: false, cancelled: true };
      opts.password = pw;
      continue;
    }
    if (res.code === 'NEED_PASSPHRASE') {
      const pp = await promptDialog({
        title: 'Key passphrase',
        message: `${opts.passphrase ? 'Wrong passphrase. ' : ''}The key ${host.privateKeyPath} is encrypted. Enter its passphrase (not saved):`,
        type: 'password',
        okText: 'Unlock',
      });
      if (pp == null) return { ok: false, cancelled: true };
      opts.passphrase = pp;
      continue;
    }
    return res;
  }
  return { ok: false, message: 'Too many failed attempts' };
}

// ===========================================================================
// Tabs
// ===========================================================================

const tabs = [];
let activeTab = null;

function createTab({ title, kind, view, host }) {
  const n = tabs.filter((t) => t.baseTitle === title && t.kind === kind).length;
  const tab = { id: crypto.randomUUID(), baseTitle: title, kind, view, onShow: null, onClose: null };
  tab.button = el('div', {
    class: `tab kind-${kind}`,
    title,
    onclick: () => activateTab(tab),
    onauxclick: (e) => { if (e.button === 1) closeTab(tab); },
  },
  el('span', { class: 'tab-kind', text: { ssh: 'SSH', sftp: 'SFTP', local: 'LOCAL' }[kind] }),
  host?.label ? el('span', { class: 'env-badge', text: host.label }) : null,
  el('span', { class: 'tab-title', text: n ? `${title} (${n + 1})` : title }),
  el('span', { class: 'tab-dot' }),
  el('button', { class: 'tab-close', title: 'Close', text: '×', onclick: (e) => { e.stopPropagation(); closeTab(tab); } }));
  tab.setState = (state) => { tab.button.dataset.state = state; };
  if (host?.color) { tab.button.classList.add('has-env'); applyEnvColor(tab.button, host); }
  $('#tabbar').append(tab.button);
  view.classList.add('tabview');
  $('#tabviews').append(view);
  tabs.push(tab);
  activateTab(tab);
  return tab;
}

function activateTab(tab) {
  activeTab = tab;
  for (const t of tabs) {
    t.button.classList.toggle('active', t === tab);
    t.view.classList.toggle('active', t === tab);
  }
  $('#welcome').hidden = tabs.length > 0;
  if (tab && tab.onShow) requestAnimationFrame(tab.onShow);
}

function closeTab(tab) {
  const i = tabs.indexOf(tab);
  if (i < 0) return;
  tabs.splice(i, 1);
  if (tab.onClose) tab.onClose();
  tab.button.remove();
  tab.view.remove();
  if (activeTab === tab) activateTab(tabs[Math.min(i, tabs.length - 1)] || null);
  $('#welcome').hidden = tabs.length > 0;
}

// Ctrl+Tab / Ctrl+Shift+Tab to cycle, Ctrl+Shift+W to close.
document.addEventListener('keydown', (e) => {
  if (e.ctrlKey && e.shiftKey && e.code === 'KeyT') {
    e.preventDefault();
    e.stopPropagation(); // keep the key from reaching a focused terminal
    openTerminal(LOCAL_HOST);
  } else if (e.ctrlKey && e.key === 'Tab' && tabs.length) {
    e.preventDefault();
    e.stopPropagation();
    const i = tabs.indexOf(activeTab);
    activateTab(tabs[(i + (e.shiftKey ? -1 : 1) + tabs.length) % tabs.length]);
  } else if (e.ctrlKey && e.shiftKey && (e.key === 'W' || e.key === 'w') && activeTab) {
    e.preventDefault();
    e.stopPropagation();
    closeTab(activeTab);
  }
}, true);

// ===========================================================================
// SSH terminal tab
// ===========================================================================

const shellHandlers = new Map(); // sessionId -> { data(d), closed(reason) }
api.ssh.onData((id, data) => shellHandlers.get(id)?.data(data));
api.ssh.onClosed((id, reason) => shellHandlers.get(id)?.closed(reason));

function openTerminal(host) {
  const overlay = el('div', { class: 'term-overlay hidden' });
  const termEl = el('div', { class: 'term' });
  const banner = host.color
    ? el('div', { class: 'env-banner' }, el('b', { text: host.label || 'Environment' }), el('span', { text: `${host.name} · ${hostLabel(host)}` }))
    : null;
  const view = el('div', { class: `term-wrap${host.color ? ' has-env' : ''}` }, banner, el('div', { class: 'term-area' }, termEl), overlay);
  const termBg = host.color ? tint('#0f1216', host.color, 0.07) : '#0f1216';
  if (host.color) { applyEnvColor(view, host); view.style.setProperty('--term-bg', termBg); }
  const tab = createTab({ title: host.name, kind: host.local ? 'local' : 'ssh', view, host });

  const term = new Terminal({
    cursorBlink: true,
    fontFamily: '"JetBrains Mono", "Fira Code", "Cascadia Mono", "DejaVu Sans Mono", Menlo, monospace',
    fontSize: 14,
    scrollback: 10000,
    allowProposedApi: false,
    theme: { background: termBg, foreground: '#d7dde5', cursor: '#7cc4ff', selectionBackground: '#2f4a66' },
  });
  const fit = new FitAddon.FitAddon();
  term.loadAddon(fit);
  term.open(termEl);

  let sessionId = null;
  let closedByUser = false;

  const doFit = () => {
    if (!view.classList.contains('active')) return;
    try { fit.fit(); } catch { /* not laid out yet */ }
  };
  tab.onShow = () => { doFit(); term.focus(); };
  new ResizeObserver(doFit).observe(termEl);

  term.onData((d) => { if (sessionId) api.ssh.write(sessionId, d); });
  term.onResize(({ cols, rows }) => { if (sessionId) api.ssh.resize(sessionId, cols, rows); });

  // Ctrl+Shift+C / Ctrl+Shift+V copy & paste; right-click copies a selection or pastes.
  term.attachCustomKeyEventHandler((e) => {
    if (e.type !== 'keydown' || !e.ctrlKey || !e.shiftKey) return true;
    if (e.code === 'KeyC') { if (term.hasSelection()) navigator.clipboard.writeText(term.getSelection()); return false; }
    if (e.code === 'KeyV') { navigator.clipboard.readText().then((t) => term.paste(t)); return false; }
    return true;
  });
  termEl.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    if (term.hasSelection()) { navigator.clipboard.writeText(term.getSelection()); term.clearSelection(); }
    else navigator.clipboard.readText().then((t) => term.paste(t));
  });

  function showOverlay(message) {
    overlay.replaceChildren(
      el('div', { class: 'overlay-card' },
        el('div', { text: message }),
        el('div', { class: 'row' },
          el('button', { class: 'btn primary', text: host.local ? 'Restart' : 'Reconnect', onclick: connect }),
          el('button', { class: 'btn', text: 'Close tab', onclick: () => closeTab(tab) }))));
    overlay.classList.remove('hidden');
  }

  async function connect() {
    overlay.classList.add('hidden');
    tab.setState('connecting');
    doFit();
    let res;
    if (host.local) {
      res = await api.ssh.openLocal({ cols: term.cols, rows: term.rows });
    } else {
      term.write(`\x1b[90mConnecting to ${hostLabel(host)}…\x1b[0m\r\n`);
      res = await connectWithPrompts('ssh', host, { cols: term.cols, rows: term.rows });
    }
    if (!tabs.includes(tab)) { if (res.ok) api.close(res.id); return; }
    if (!res.ok) {
      tab.setState('error');
      if (!res.cancelled) term.write(`\x1b[31m${res.message}\x1b[0m\r\n`);
      showOverlay(res.cancelled ? 'Connection cancelled.' : host.local ? res.message : `Connection failed: ${res.message}`);
      return;
    }
    sessionId = res.id;
    tab.setState('connected');
    shellHandlers.set(sessionId, {
      data: (d) => term.write(d),
      closed: (reason) => {
        shellHandlers.delete(sessionId);
        sessionId = null;
        if (closedByUser) return;
        tab.setState('error');
        if (host.local) { closeTab(tab); return; } // `exit` in a local shell closes its tab, like other terminals
        term.write(`\r\n\x1b[90m[Connection closed${reason ? `: ${reason}` : ''}]\x1b[0m\r\n`);
        showOverlay('Disconnected.');
      },
    });
    api.ssh.resize(sessionId, term.cols, term.rows);
    term.focus();
  }

  tab.onClose = () => {
    closedByUser = true;
    if (sessionId) { shellHandlers.delete(sessionId); api.close(sessionId); }
    term.dispose();
  };

  connect();
}

// ===========================================================================
// SFTP tab: local pane (left) and remote pane (right)
// ===========================================================================

const DRAG_TYPE = 'application/x-shellfish-files';
let dragSource = null; // the FilePane a drag started from

class FilePane {
  constructor({ title, subtitle, backend, pathlib, onActivateFiles, onDropFiles, onDropOsFiles }) {
    Object.assign(this, { backend, pathlib, onActivateFiles, onDropFiles, onDropOsFiles });
    this.path = '';
    this.entries = [];
    this.selected = new Set();
    this.anchor = null;
    this.sort = { key: 'name', dir: 1 };
    this.history = [];

    this.pathInput = el('input', { class: 'path-input', spellcheck: 'false' });
    this.pathInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') this.navigate(this.pathInput.value.trim()); });
    this.tbody = el('tbody');
    this.status = el('div', { class: 'pane-status' });
    this.overlay = el('div', { class: 'pane-overlay hidden' });

    const th = (key, label, cls) => el('th', { class: cls, dataset: { key }, onclick: () => this.setSort(key) }, label);
    this.thead = el('thead', {}, el('tr', {}, th('name', 'Name', 'c-name'), th('size', 'Size', 'c-size'), th('mtime', 'Modified', 'c-date'), th('mode', 'Permissions', 'c-mode')));

    const tool = (text, titleText, fn) => el('button', { class: 'btn small icon', title: titleText, text, onclick: fn });
    this.tableWrap = el('div', { class: 'table-wrap', tabindex: '0' }, el('table', { class: 'files' }, this.thead, this.tbody));

    this.root = el('div', { class: 'pane' },
      el('div', { class: 'pane-head' },
        el('div', { class: 'pane-title' }, el('b', { text: title }), el('span', { class: 'muted', text: subtitle || '' })),
        el('div', { class: 'pane-tools' },
          tool('←', 'Back', () => this.back()),
          tool('↑', 'Parent folder (Backspace)', () => this.navigate(this.pathlib.parent(this.path))),
          tool('⌂', 'Home folder', () => this.navigate(this.backend.home)),
          tool('⟳', 'Refresh (F5)', () => this.refresh()),
          tool('+', 'New folder', () => this.mkdir()),
          tool('✎', 'Rename (F2)', () => this.rename()),
          tool('🗑', 'Delete (Del)', () => this.remove()))),
      this.pathInput,
      this.tableWrap,
      this.status,
      this.overlay);

    this.tableWrap.addEventListener('keydown', (e) => this.onKey(e));
    this.tableWrap.addEventListener('click', (e) => { if (e.target === this.tableWrap) this.select(new Set()); });
    this.setupDrop();
  }

  // ---- data ----

  async navigate(dir, { pushHistory = true } = {}) {
    if (!dir) return;
    try {
      const res = await call(this.backend.list(dir));
      if (pushHistory && this.path && this.path !== res.path) this.history.push(this.path);
      this.path = res.path;
      this.entries = res.entries;
      this.selected = new Set();
      this.anchor = null;
      this.render();
    } catch (e) {
      this.pathInput.value = this.path;
      alertError('Cannot open folder', e);
    }
  }

  refresh() {
    const keep = this.selected;
    return this.navigate(this.path, { pushHistory: false }).then(() => {
      this.select(new Set([...keep].filter((n) => this.entries.some((x) => x.name === n))));
    });
  }

  back() {
    const prev = this.history.pop();
    if (prev) this.navigate(prev, { pushHistory: false });
  }

  full(name) {
    return this.pathlib.join(this.path, name);
  }

  selectedEntries() {
    return this.entries.filter((x) => this.selected.has(x.name));
  }

  // ---- rendering ----

  sorted() {
    const { key, dir } = this.sort;
    return [...this.entries].sort((a, b) => {
      if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
      let r;
      if (key === 'name') r = a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' });
      else r = (a[key] || 0) - (b[key] || 0);
      return r * dir || a.name.localeCompare(b.name);
    });
  }

  setSort(key) {
    this.sort = { key, dir: this.sort.key === key ? -this.sort.dir : 1 };
    this.render();
  }

  render() {
    this.pathInput.value = this.path;
    for (const th of this.thead.querySelectorAll('th')) {
      th.dataset.sort = th.dataset.key === this.sort.key ? (this.sort.dir > 0 ? 'asc' : 'desc') : '';
    }
    this.view = this.sorted();
    const rows = [];
    if (this.pathlib.parent(this.path) !== this.path) {
      rows.push(el('tr', { class: 'dir up', ondblclick: () => this.navigate(this.pathlib.parent(this.path)) },
        el('td', { class: 'c-name' }, el('span', { class: 'ico', text: '↰' }), '..'), el('td'), el('td'), el('td')));
    }
    for (const entry of this.view) {
      const hidden = entry.name.startsWith('.');
      const tr = el('tr', {
        class: [entry.isDir ? 'dir' : 'file', hidden ? 'dotfile' : '', this.selected.has(entry.name) ? 'selected' : ''].join(' '),
        draggable: 'true',
        dataset: { name: entry.name },
        onclick: (e) => this.onRowClick(e, entry),
        ondblclick: () => this.activate(entry),
        ondragstart: (e) => this.onDragStart(e, entry),
        ondragend: () => { dragSource = null; },
        oncontextmenu: (e) => { if (!this.selected.has(entry.name)) this.select(new Set([entry.name])); e.preventDefault(); },
      },
      el('td', { class: 'c-name', title: entry.name },
        el('span', { class: 'ico', text: entry.isDir ? '📁' : '📄' }),
        entry.name,
        entry.isLink ? el('span', { class: 'muted', text: ' →' }) : null),
      el('td', { class: 'c-size', text: entry.isDir ? '' : fmtSize(entry.size) }),
      el('td', { class: 'c-date', text: fmtDate(entry.mtime) }),
      el('td', { class: 'c-mode', text: fmtMode(entry.mode, entry.isDir) }));
      rows.push(tr);
    }
    this.tbody.replaceChildren(...rows);
    this.updateStatus();
  }

  updateStatus() {
    const sel = this.selectedEntries();
    const files = this.entries.filter((x) => !x.isDir).length;
    const dirs = this.entries.length - files;
    let s = `${dirs} folder${dirs === 1 ? '' : 's'}, ${files} file${files === 1 ? '' : 's'}`;
    if (sel.length) s += `  ·  ${sel.length} selected (${fmtSize(sel.reduce((n, x) => n + (x.isDir ? 0 : x.size), 0))})`;
    this.status.textContent = s;
  }

  select(set) {
    this.selected = set;
    for (const tr of this.tbody.querySelectorAll('tr[data-name]')) tr.classList.toggle('selected', set.has(tr.dataset.name));
    this.updateStatus();
  }

  // ---- interaction ----

  onRowClick(e, entry) {
    this.tableWrap.focus();
    if (e.shiftKey && this.anchor) {
      const names = this.view.map((x) => x.name);
      const [a, b] = [names.indexOf(this.anchor), names.indexOf(entry.name)].sort((x, y) => x - y);
      this.select(new Set(names.slice(a, b + 1)));
      return;
    }
    if (e.ctrlKey || e.metaKey) {
      const s = new Set(this.selected);
      s.has(entry.name) ? s.delete(entry.name) : s.add(entry.name);
      this.anchor = entry.name;
      this.select(s);
      return;
    }
    this.anchor = entry.name;
    this.select(new Set([entry.name]));
  }

  activate(entry) {
    if (entry.isDir) this.navigate(this.full(entry.name));
    else this.onActivateFiles([entry]);
  }

  onKey(e) {
    if (e.target !== this.tableWrap) return;
    const names = this.view.map((x) => x.name);
    if (e.key === 'Enter') {
      const sel = this.selectedEntries();
      if (sel.length === 1 && sel[0].isDir) this.navigate(this.full(sel[0].name));
      else if (sel.length) this.onActivateFiles(sel.filter((x) => !x.isDir));
    } else if (e.key === 'Backspace') this.navigate(this.pathlib.parent(this.path));
    else if (e.key === 'Delete') this.remove();
    else if (e.key === 'F2') this.rename();
    else if (e.key === 'F5') this.refresh();
    else if (e.key === 'a' && (e.ctrlKey || e.metaKey)) this.select(new Set(names));
    else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      const cur = names.indexOf(this.anchor);
      const next = Math.max(0, Math.min(names.length - 1, cur + (e.key === 'ArrowDown' ? 1 : -1)));
      if (names[next] === undefined) return;
      this.anchor = names[next];
      this.select(new Set([names[next]]));
      this.tbody.querySelector(`tr[data-name="${CSS.escape(names[next])}"]`)?.scrollIntoView({ block: 'nearest' });
    } else return;
    e.preventDefault();
  }

  async mkdir() {
    const name = await promptDialog({ title: 'New folder', message: `Create in ${this.path}`, okText: 'Create' });
    if (!name) return;
    try {
      await call(this.backend.mkdir(this.full(name)));
      await this.refresh();
      this.select(new Set([name]));
    } catch (e) { alertError('Could not create folder', e); }
  }

  async rename() {
    const [entry] = this.selectedEntries();
    if (!entry) return;
    const name = await promptDialog({ title: 'Rename', value: entry.name, okText: 'Rename' });
    if (!name || name === entry.name) return;
    try {
      await call(this.backend.rename(this.full(entry.name), this.full(name)));
      await this.refresh();
      this.select(new Set([name]));
    } catch (e) { alertError('Could not rename', e); }
  }

  async remove() {
    const sel = this.selectedEntries();
    if (!sel.length) return;
    const what = sel.length === 1 ? `"${sel[0].name}"${sel[0].isDir ? ' and everything inside it' : ''}` : `${sel.length} items`;
    const ok = await confirmDialog({
      title: 'Delete',
      message: this.backend.deleteIsPermanent ? `Permanently delete ${what} on the server? This cannot be undone.` : `Move ${what} to the trash?`,
      okText: 'Delete',
      danger: true,
    });
    if (!ok) return;
    try {
      for (const entry of sel) await call(this.backend.remove(this.full(entry.name)));
    } catch (e) { alertError('Could not delete', e); }
    this.refresh();
  }

  // ---- drag & drop ----

  onDragStart(e, entry) {
    if (!this.selected.has(entry.name)) this.select(new Set([entry.name]));
    dragSource = this;
    e.dataTransfer.effectAllowed = 'copy';
    e.dataTransfer.setData(DRAG_TYPE, JSON.stringify(this.selectedEntries().map((x) => x.name)));
  }

  setupDrop() {
    const accepts = (e) => (dragSource && dragSource !== this) || (this.onDropOsFiles && e.dataTransfer.types.includes('Files') && !dragSource);
    this.root.addEventListener('dragover', (e) => {
      if (!accepts(e)) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'copy';
      this.root.classList.add('drop-target');
    });
    this.root.addEventListener('dragleave', (e) => { if (!this.root.contains(e.relatedTarget)) this.root.classList.remove('drop-target'); });
    this.root.addEventListener('drop', (e) => {
      this.root.classList.remove('drop-target');
      if (!accepts(e)) return;
      e.preventDefault();
      if (dragSource) {
        const src = dragSource;
        dragSource = null;
        this.onDropFiles(src);
      } else {
        const paths = [...e.dataTransfer.files].map((f) => api.local.pathForFile(f)).filter(Boolean);
        if (paths.length) this.onDropOsFiles(paths);
      }
    });
  }

  setDisconnected(message, onReconnect) {
    if (!message) { this.overlay.classList.add('hidden'); return; }
    this.overlay.replaceChildren(el('div', { class: 'overlay-card' },
      el('div', { text: message }),
      onReconnect ? el('button', { class: 'btn primary', text: 'Reconnect', onclick: onReconnect }) : null));
    this.overlay.classList.remove('hidden');
  }
}

// ---- transfers list ----

const transferHandlers = new Map(); // sftp sessionId -> fn(progress)
api.sftp.onProgress((p) => transferHandlers.get(p.sessionId)?.(p));
const sftpClosedHandlers = new Map();
api.sftp.onClosed((id) => sftpClosedHandlers.get(id)?.());

function openSftp(host) {
  let sessionId = null;

  const localBackend = {
    home: '',
    deleteIsPermanent: false,
    list: (d) => api.local.list(d),
    mkdir: (d) => api.local.mkdir(d),
    rename: (a, b) => api.local.rename(a, b),
    remove: (t) => api.local.remove(t),
  };
  const remoteBackend = {
    home: '/',
    deleteIsPermanent: true,
    list: (d) => api.sftp.list(sessionId, d),
    mkdir: (d) => api.sftp.mkdir(sessionId, d),
    rename: (a, b) => api.sftp.rename(sessionId, a, b),
    remove: (t) => api.sftp.remove(sessionId, t),
  };

  const transfersList = el('div', { class: 'transfers-list' });
  const transfersBox = el('div', { class: 'transfers' },
    el('div', { class: 'transfers-head' },
      el('b', { text: 'Transfers' }),
      el('button', { class: 'btn small', text: 'Clear finished', onclick: () => transfersList.querySelectorAll('.transfer.done, .transfer.error').forEach((n) => n.remove()) })),
    transfersList);

  // Upload = local (left) -> remote (right); Download = remote -> local.
  async function transfer(direction, names, fromPane) {
    if (!sessionId) return;
    const source = fromPane || (direction === 'upload' ? local : remote);
    const target = direction === 'upload' ? remote : local;
    if (!names.length) return;
    const conflicts = names.filter((n) => target.entries.some((x) => x.name === n));
    if (conflicts.length) {
      const ok = await confirmDialog({
        title: 'Overwrite?',
        message: `${conflicts.length === 1 ? `"${conflicts[0]}" already exists` : `${conflicts.length} items already exist`} in ${target.path}. Overwrite?`,
        okText: 'Overwrite',
        danger: true,
      });
      if (!ok) return;
    }
    const sources = names.map((n) => source.full(n));
    const res = direction === 'upload'
      ? await api.sftp.upload(sessionId, sources, target.path)
      : await api.sftp.download(sessionId, sources, target.path);
    if (!res.ok) alertError('Transfer failed', res);
  }

  const transferRows = new Map();
  function onProgress(p) {
    let row = transferRows.get(p.transferId);
    if (!row) {
      row = {
        bar: el('div', { class: 'bar-fill' }),
        text: el('span', { class: 'transfer-text' }),
      };
      row.node = el('div', { class: 'transfer' },
        el('span', { class: 'transfer-dir', text: p.direction === 'upload' ? '↑' : '↓', title: p.direction }),
        el('span', { class: 'transfer-label', text: p.label, title: p.label }),
        el('div', { class: 'bar' }, row.bar),
        row.text);
      transferRows.set(p.transferId, row);
      transfersList.prepend(row.node);
    }
    const pct = p.total ? Math.floor((p.done / p.total) * 100) : (p.state === 'done' ? 100 : 0);
    row.bar.style.width = `${pct}%`;
    row.node.className = `transfer ${p.state}`;
    if (p.state === 'preparing') row.text.textContent = 'Preparing…';
    else if (p.state === 'running') row.text.textContent = `${pct}% · ${fmtSize(p.done)} / ${fmtSize(p.total)} · ${p.filesDone}/${p.files} files`;
    else if (p.state === 'done') {
      row.text.textContent = `Done · ${fmtSize(p.total)} · ${p.files} file${p.files === 1 ? '' : 's'}`;
      (p.direction === 'upload' ? remote : local).refresh();
    } else if (p.state === 'error') {
      row.text.textContent = `Failed: ${p.message}`;
      row.text.title = p.message;
      (p.direction === 'upload' ? remote : local).refresh();
    }
  }

  const local = new FilePane({
    title: 'Local',
    subtitle: 'this computer',
    backend: localBackend,
    pathlib: localPath,
    onActivateFiles: (entries) => transfer('upload', entries.map((x) => x.name)),
    onDropFiles: (src) => src !== local && transfer('download', [...src.selected], src),
  });
  const remote = new FilePane({
    title: host.name,
    subtitle: hostLabel(host),
    backend: remoteBackend,
    pathlib: remotePath,
    onActivateFiles: (entries) => transfer('download', entries.map((x) => x.name)),
    onDropFiles: (src) => src !== remote && transfer('upload', [...src.selected], src),
    // Files dragged in from the OS file manager.
    onDropOsFiles: async (paths) => {
      if (!sessionId) return;
      const res = await api.sftp.upload(sessionId, paths, remote.path);
      if (!res.ok) alertError('Transfer failed', res);
    },
  });

  const middle = el('div', { class: 'sftp-middle' },
    el('button', { class: 'btn primary', title: 'Upload selected local items to the remote folder', text: 'Upload →', onclick: () => transfer('upload', [...local.selected]) }),
    el('button', { class: 'btn primary', title: 'Download selected remote items to the local folder', text: '← Download', onclick: () => transfer('download', [...remote.selected]) }),
    el('button', { class: 'btn small', title: 'Open a terminal on this host', text: 'Terminal', onclick: () => openTerminal(host) }));

  const view = el('div', { class: 'sftp' }, el('div', { class: 'sftp-panes' }, local.root, middle, remote.root), transfersBox);
  if (host.color) { remote.root.classList.add('has-env'); applyEnvColor(remote.root, host); }
  if (host.label) remote.root.querySelector('.pane-title').prepend(el('span', { class: 'env-badge', text: host.label }));
  const tab = createTab({ title: host.name, kind: 'sftp', view, host });

  async function connect() {
    remote.setDisconnected('Connecting…');
    tab.setState('connecting');
    const res = await connectWithPrompts('sftp', host);
    if (!tabs.includes(tab)) { if (res.ok) api.close(res.id); return; }
    if (!res.ok) {
      tab.setState('error');
      remote.setDisconnected(res.cancelled ? 'Connection cancelled.' : `Connection failed: ${res.message}`, connect);
      return;
    }
    sessionId = res.id;
    tab.setState('connected');
    remoteBackend.home = res.home;
    transferHandlers.set(sessionId, onProgress);
    sftpClosedHandlers.set(sessionId, () => {
      transferHandlers.delete(sessionId);
      sftpClosedHandlers.delete(sessionId);
      sessionId = null;
      tab.setState('error');
      remote.setDisconnected('Disconnected.', connect);
    });
    remote.setDisconnected(null);
    await remote.navigate(remote.path || res.home, { pushHistory: false });
  }

  tab.onClose = () => {
    if (sessionId) {
      transferHandlers.delete(sessionId);
      sftpClosedHandlers.delete(sessionId);
      api.close(sessionId);
    }
  };

  (async () => {
    localBackend.home = await call(api.local.home());
    await local.navigate(localBackend.home);
    await connect();
  })();
}

// ===========================================================================
// Boot
// ===========================================================================

$('#host-modal').addEventListener('mousedown', (e) => { if (e.target.id === 'host-modal') closeHostEditor(); });
loadHosts();
renderStoreInfo();
