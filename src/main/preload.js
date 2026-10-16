// Narrow, explicit bridge between the UI and the main process.
const { contextBridge, ipcRenderer, webUtils } = require('electron');

const invoke = (ch, ...a) => ipcRenderer.invoke(ch, ...a);
const on = (ch, fn) => {
  const listener = (_e, ...a) => fn(...a);
  ipcRenderer.on(ch, listener);
  return () => ipcRenderer.removeListener(ch, listener);
};

contextBridge.exposeInMainWorld('api', {
  hosts: {
    list: () => invoke('hosts:list'),
    save: (h) => invoke('hosts:save', h),
    remove: (id) => invoke('hosts:delete', id),
  },
  store: {
    info: () => invoke('store:info'),
    reveal: () => invoke('store:reveal'),
  },
  pickKey: () => invoke('dialog:pickKey'),
  ssh: {
    open: (opts) => invoke('ssh:open', opts),
    write: (id, data) => ipcRenderer.send('ssh:write', id, data),
    resize: (id, cols, rows) => ipcRenderer.send('ssh:resize', id, cols, rows),
    onData: (fn) => on('ssh:data', fn),
    onClosed: (fn) => on('ssh:closed', fn),
  },
  close: (id) => ipcRenderer.send('session:close', id),
  sftp: {
    open: (opts) => invoke('sftp:open', opts),
    list: (id, dir) => invoke('sftp:list', id, dir),
    mkdir: (id, dir) => invoke('sftp:mkdir', id, dir),
    rename: (id, a, b) => invoke('sftp:rename', id, a, b),
    remove: (id, t) => invoke('sftp:delete', id, t),
    upload: (id, local, remoteDir) => invoke('sftp:upload', id, local, remoteDir),
    download: (id, remote, localDir) => invoke('sftp:download', id, remote, localDir),
    onProgress: (fn) => on('sftp:progress', fn),
    onClosed: (fn) => on('sftp:closed', fn),
  },
  local: {
    home: () => invoke('local:home'),
    list: (dir) => invoke('local:list', dir),
    mkdir: (dir) => invoke('local:mkdir', dir),
    rename: (a, b) => invoke('local:rename', a, b),
    remove: (t) => invoke('local:delete', t),
    open: (t) => invoke('local:open', t),
    // Absolute path of a file dropped from the OS file manager.
    pathForFile: (file) => webUtils.getPathForFile(file),
  },
  platform: process.platform,
});
