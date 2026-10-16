// Automatic updates from this project's GitHub Releases (FarosBelgium/shellfish).
//
// - Windows: downloads in the background, installs on "Restart" or when the app quits.
// - Linux (.deb): downloads in the background; installing asks for your password
//   (pkexec), because a .deb installs system-wide.
// - macOS: the app is not signed with an Apple Developer certificate, and macOS only
//   allows signed apps to replace themselves, so it reports the new version and the
//   button opens the release page to download it.
//
// Every download is checked against the SHA-512 in the release's latest*.yml.

const fs = require('fs');
const path = require('path');
const { app, shell } = require('electron');

const RELEASES_PAGE = 'https://github.com/FarosBelgium/shellfish/releases/latest';
const CHECK_EVERY_MS = 6 * 60 * 60 * 1000;

let updater = null;
let status = { state: 'idle' };
let notify = () => {};

function setStatus(next) {
  status = { ...next, version: app.getVersion(), platform: process.platform };
  notify(status);
}

function getStatus() {
  if (!app.isPackaged) return { state: 'dev', version: app.getVersion(), platform: process.platform };
  return { ...status, version: app.getVersion(), platform: process.platform };
}

// A small rotating log next to the data folder, so update problems can be diagnosed.
function makeLogger() {
  const file = path.join(app.getPath('userData'), 'logs', 'updates.log');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  try { if (fs.statSync(file).size > 512 * 1024) fs.renameSync(file, `${file}.old`); } catch { /* no log yet */ }
  const write = (level) => (...args) => {
    try { fs.appendFileSync(file, `${new Date().toISOString()} ${level} ${args.map(String).join(' ')}\n`); } catch { /* ignore */ }
  };
  return { info: write('INFO'), warn: write('WARN'), error: write('ERROR'), debug: () => {} };
}

function init(onStatus) {
  notify = onStatus;
  if (!app.isPackaged) return; // running from source: nothing to update

  ({ autoUpdater: updater } = require('electron-updater'));
  updater.logger = makeLogger();
  const isMac = process.platform === 'darwin';
  updater.autoDownload = !isMac;
  // Installing a .deb needs a password prompt, so only do that when the user clicks.
  updater.autoInstallOnAppQuit = process.platform === 'win32';

  // Test hook: point the updater at a local feed. Only loopback URLs are accepted, so
  // this cannot be used to redirect updates to another machine.
  const feed = process.env.SHELLFISH_UPDATE_FEED;
  if (feed && /^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?\//.test(feed)) {
    updater.setFeedURL({ provider: 'generic', url: feed });
    updater.logger.info(`using test feed ${feed}`);
  }

  updater.on('checking-for-update', () => setStatus({ state: 'checking' }));
  updater.on('update-not-available', () => setStatus({ state: 'up-to-date', checkedAt: Date.now() }));
  updater.on('update-available', (info) => setStatus({ state: isMac ? 'available-manual' : 'downloading', newVersion: info.version, percent: 0 }));
  updater.on('download-progress', (p) => setStatus({ ...status, state: 'downloading', percent: Math.round(p.percent) }));
  updater.on('update-downloaded', (info) => {
    updater.logger.info(`update downloaded: ${info.version}`);
    setStatus({ state: 'ready', newVersion: info.version });
  });
  updater.on('error', (e) => setStatus({ state: 'error', message: friendlyError(e) }));

  setTimeout(check, 10 * 1000); // don't slow down startup
  setInterval(check, CHECK_EVERY_MS).unref();
}

function friendlyError(e) {
  const msg = String(e && e.message || e);
  if (/ENOTFOUND|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN|net::ERR_/i.test(msg)) return 'Could not reach the update server (offline?)';
  if (/404/.test(msg)) return 'No releases published yet';
  if (/sha512 checksum mismatch/i.test(msg)) return 'Downloaded update was corrupt and has been discarded';
  return msg.split('\n')[0].slice(0, 200);
}

function check() {
  if (!updater) return getStatus();
  if (['checking', 'downloading', 'ready'].includes(status.state)) return getStatus();
  updater.checkForUpdates().catch((e) => setStatus({ state: 'error', message: friendlyError(e) }));
  return getStatus();
}

function install() {
  if (!updater) return;
  if (status.state === 'available-manual') {
    shell.openExternal(RELEASES_PAGE);
    return;
  }
  if (status.state === 'ready') {
    // isSilent: no installer wizard on Windows; isForceRunAfter: reopen when done.
    setImmediate(() => updater.quitAndInstall(true, true));
  }
}

module.exports = { init, check, install, getStatus };
