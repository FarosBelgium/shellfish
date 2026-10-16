const path = require('path');
const fsp = require('fs/promises');
const os = require('os');
const { app, BrowserWindow, ipcMain, dialog, shell, Menu } = require('electron');
const { Store } = require('./store');
const ssh = require('./ssh');

// The OS keyring key used to encrypt saved secrets is tied to the app name, so keep it
// fixed: renaming the app would make every saved password undecryptable.
app.setName('shellfish');

// Data lives inside the tool's own folder (./data) unless overridden.
// A packaged build cannot write into its own bundle, so it uses the per-user app data dir.
function dataDir() {
  if (process.env.SHELLFISH_DATA_DIR) return path.resolve(process.env.SHELLFISH_DATA_DIR);
  if (app.isPackaged) return path.join(app.getPath('userData'), 'data');
  return path.join(__dirname, '..', '..', 'data');
}

let store;
let win;

function createWindow() {
  win = new BrowserWindow({
    width: 1400,
    height: 860,
    minWidth: 900,
    minHeight: 560,
    backgroundColor: '#14171c',
    title: 'Shellfish',
    icon: path.join(__dirname, '..', 'renderer', 'assets', 'icon.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));

  // Never navigate away from the app or open new windows.
  win.webContents.on('will-navigate', (e) => e.preventDefault());
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('destroyed', () => ssh.closeAllForSender(win.webContents));
}

// Wraps an IPC handler so errors reach the renderer as {ok:false,...} instead of throwing.
function handle(channel, fn) {
  ipcMain.handle(channel, async (event, ...args) => {
    try {
      const res = await fn(event, ...args);
      return res && typeof res === 'object' && 'ok' in res ? res : { ok: true, data: res };
    } catch (e) {
      return ssh.toIpcError(e);
    }
  });
}

function registerIpc() {
  // hosts
  handle('hosts:list', () => store.listHosts());
  handle('hosts:save', (_e, host) => store.saveHost(host));
  handle('hosts:delete', (_e, id) => store.deleteHost(id));
  handle('store:info', () => ({ dir: store.dir, file: store.hostsFile, encrypted: store.canEncrypt() }));
  handle('store:reveal', () => shell.showItemInFolder(store.hostsFile));
  handle('dialog:pickKey', async () => {
    const r = await dialog.showOpenDialog(win, {
      title: 'Choose private key',
      defaultPath: path.join(os.homedir(), '.ssh'),
      properties: ['openFile', 'showHiddenFiles'],
    });
    return r.canceled ? null : r.filePaths[0];
  });

  // terminal
  handle('ssh:open', (e, opts) => ssh.openShell(win, store, e.sender, opts));
  ipcMain.on('ssh:write', (_e, id, data) => ssh.shellWrite(id, data));
  ipcMain.on('ssh:resize', (_e, id, cols, rows) => ssh.shellResize(id, cols, rows));
  ipcMain.on('session:close', (_e, id) => ssh.closeSession(id));

  // sftp
  handle('sftp:open', (e, opts) => ssh.openSftp(win, store, e.sender, opts));
  handle('sftp:list', (_e, id, dir) => ssh.remoteList(id, dir));
  handle('sftp:mkdir', (_e, id, dir) => ssh.remoteMkdir(id, dir));
  handle('sftp:rename', (_e, id, from, to) => ssh.remoteRename(id, from, to));
  handle('sftp:delete', (_e, id, target) => ssh.remoteDelete(id, target));
  handle('sftp:upload', (e, id, localPaths, remoteDir) => ssh.runTransfer(e.sender, id, 'upload', localPaths, remoteDir));
  handle('sftp:download', (e, id, remotePaths, localDir) => ssh.runTransfer(e.sender, id, 'download', remotePaths, localDir));

  // local filesystem
  handle('local:home', () => os.homedir());
  handle('local:list', (_e, dir) => ssh.localList(dir));
  handle('local:mkdir', (_e, dir) => fsp.mkdir(dir));
  handle('local:rename', (_e, from, to) => fsp.rename(from, to));
  handle('local:delete', (_e, target) => shell.trashItem(target)); // recoverable
  handle('local:open', (_e, target) => shell.openPath(target));
}

app.whenReady().then(() => {
  const isMac = process.platform === 'darwin';
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    ...(isMac ? [{ role: 'appMenu' }] : [{ label: 'File', submenu: [{ role: 'quit' }] }]),
    { label: 'Edit', submenu: [{ role: 'undo' }, { role: 'redo' }, { type: 'separator' }, { role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { role: 'selectAll' }] },
    { label: 'View', submenu: [{ role: 'reload' }, { role: 'toggleDevTools' }, { type: 'separator' }, { role: 'resetZoom' }, { role: 'zoomIn' }, { role: 'zoomOut' }] },
  ]));
  try {
    store = new Store(dataDir());
  } catch (e) {
    dialog.showErrorBox('Shellfish', `Cannot open data directory: ${e.message}`);
    app.quit();
    return;
  }
  registerIpc();
  createWindow();
});

app.on('window-all-closed', () => app.quit());
