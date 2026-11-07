'use strict';
const { app, BrowserWindow, ipcMain, shell, dialog, powerMonitor, Menu, net } = require('electron');
const fs = require('fs');
const path = require('path');
const { Vault, VAULT, THEME_DATE } = require('./vault');
const { getFont } = require('./fonts');
const GOOGLE = require('./google-client');
const { Drive, signIn } = require('./drive');
const { syncOnce, WrongNotebookError } = require('./sync');

const AUTO_LOCK_SECONDS = 15 * 60;
const SYNC_EVERY_MS = 2 * 60 * 1000;
const SYNC_AFTER_SAVE_MS = 5000;
const ALLOWED_LINKS = [];

let win; let vault; let drive = null; let pendingToken = null;
let syncing = null; let syncTimer = null; let saveTimer = null; let closing = false;
let status = { state: 'off' };

const configPath = () => path.join(app.getPath('userData'), 'config.json');
const loadConfig = () => { try { return JSON.parse(fs.readFileSync(configPath(), 'utf8')); } catch { return {}; } };
const saveConfig = (patch) => fs.writeFileSync(configPath(), JSON.stringify({ ...loadConfig(), ...patch }), { mode: 0o600 });
const send = (ch, d) => { if (win && !win.isDestroyed()) win.webContents.send(ch, d); };
const setStatus = (s) => { status = s; send('sync-status', s); };

function validPassphrase(p) {
  if (typeof p !== 'string' || [...p].length < 12) throw new Error('Use at least 12 characters. A few random words works well.');
}
const COLOR_KEYS = ['kraft', 'kraft-deep', 'kraft-ink', 'stitch', 'paper', 'paper-edge', 'rule', 'margin', 'ink', 'caret', 'tape', 'tape-ink', 'err'];
function sanitizeTheme(t) {
  const colors = {};
  for (const k of COLOR_KEYS) if (/^#[0-9a-f]{6}$/i.test(t?.colors?.[k] || '')) colors[k] = t.colors[k];
  const font = t?.font?.google ? { google: String(t.font.google).slice(0, 80) }
    : { builtin: ['typewriter', 'book', 'hand'].includes(t?.font?.builtin) ? t.font.builtin : 'typewriter' };
  return { colors, font, imageTape: t?.imageTape !== false };
}
async function runSync() {
  if (!drive || !vault.unlocked) return;
  if (syncing) return syncing;
  setStatus({ ...status, state: 'syncing' });
  syncing = (async () => {
    try {
      const r = await syncOnce(vault, drive);
      if (r.changedDates.includes(THEME_DATE)) {
        const t = vault.getTheme();
        if (t) { saveConfig({ theme: t }); send('theme-changed', t); }
      }
      const dates = r.changedDates.filter((d) => d !== THEME_DATE);
      if (dates.length || r.imagesArrived) send('entries-changed', dates);
      setStatus(r.failed
        ? { state: 'error', message: `${r.failed} ${r.failed === 1 ? 'file' : 'files'} on Google Drive could not be read and were skipped.` }
        : { state: 'ok', at: Date.now() });
    } catch (e) {
      if (e instanceof WrongNotebookError || e.auth) setStatus({ state: 'error', message: e.message });
      else setStatus({ state: 'offline', at: status.at });
    } finally { syncing = null; }
  })();
  return syncing;
}

function startSyncLoop() {
  clearInterval(syncTimer);
  const secrets = vault.loadSecrets();
  if (secrets?.refreshToken) drive = new Drive(GOOGLE, secrets.refreshToken);
  if (!drive) return setStatus({ state: 'off' });
  runSync();
  syncTimer = setInterval(runSync, SYNC_EVERY_MS);
}

function stopSync() {
  clearInterval(syncTimer); clearTimeout(saveTimer);
  drive = null;
  setStatus({ state: 'off' });
}

function afterOpen() {
  if (pendingToken) { vault.saveSecrets({ refreshToken: pendingToken }); pendingToken = null; }
  startSyncLoop();
}

const handlers = {
  state: () => {
    const c = loadConfig();
    return { hasVault: vault.exists(), unlocked: vault.unlocked, theme: c.theme || (c.font ? { font: { builtin: c.font } } : null), driveConnected: !!drive, status, unreadable: vault.unreadable || 0, autoLockMinutes: AUTO_LOCK_SECONDS / 60 };
  },
  create: async (pass) => { validPassphrase(pass); await vault.create(pass); afterOpen(); },
  unlock: async (pass) => { await vault.unlock(String(pass)); afterOpen(); },
  lock: async () => { if (syncing) await syncing; stopSync(); vault.lock(); },
  overview: () => vault.overview(),
  get: (date) => vault.get(String(date)),
  save: (date, text, base) => {
    const e = vault.save(String(date), String(text), base);
    clearTimeout(saveTimer);
    saveTimer = setTimeout(runSync, SYNC_AFTER_SAVE_MS);
    return e;
  },
  search: (q) => vault.search(String(q)),
  getTheme: () => vault.getTheme() || loadConfig().theme || (loadConfig().font ? { font: { builtin: loadConfig().font } } : null),
  setTheme: (theme) => {
    const clean = sanitizeTheme(theme);
    vault.setTheme(clean);
    saveConfig({ theme: clean });
    clearTimeout(saveTimer);
    saveTimer = setTimeout(runSync, SYNC_AFTER_SAVE_MS);
  },
  loadFont: (name) => getFont(String(name), path.join(app.getPath('userData'), 'fonts'), (u, o) => net.fetch(u, o)),
  addImage: (bytes) => {
    const b = Buffer.from(bytes);
    if (b.length > 25 * 1024 * 1024 || b.subarray(0, 4).toString('latin1') !== 'RIFF' || b.subarray(8, 12).toString('latin1') !== 'WEBP') throw new Error('That image could not be added.');
    const id = vault.addImage(b);
    clearTimeout(saveTimer);
    saveTimer = setTimeout(runSync, SYNC_AFTER_SAVE_MS);
    return id;
  },
  getImage: (id) => {
    if (!/^[a-f0-9]{40}$/.test(String(id))) return null;
    const b = vault.getImage(String(id));
    return b ? `data:image/webp;base64,${b.toString('base64')}` : null;
  },
  syncNow: () => runSync(),
  driveConnect: async () => {
    const token = await signIn(GOOGLE, (u) => shell.openExternal(u));
    vault.clearSyncState();
    vault.saveSecrets({ refreshToken: token });
    startSyncLoop();
  },
  driveDisconnect: async () => {
    if (syncing) await syncing;
    clearInterval(syncTimer); drive = null;
    vault.clearSecrets(); vault.clearSyncState();
    setStatus({ state: 'off' });
  },
  // New install on a second machine: fetch the encrypted notebook file, then ask for the passphrase.
  driveOpenExisting: async () => {
    const token = await signIn(GOOGLE, (u) => shell.openExternal(u));
    const d = new Drive(GOOGLE, token);
    const parent = await d.folder({ create: false });
    const file = parent ? (await d.list()).find((f) => f.name === VAULT) : null;
    if (!file) throw new Error('No RabbitNote notebook on this Google Drive yet. Check that you chose the same Google account as your other computer.');
    vault.writeVaultRaw(await d.download(file.id));
    pendingToken = token;
  },
  backupCreate: async () => {
    const day = new Date().toISOString().slice(0, 10);
    const { canceled, filePath } = await dialog.showSaveDialog(win, { title: 'Back up notebook', defaultPath: `rabbitnote-backup-${day}.rnbackup`, filters: [{ name: 'RabbitNote backup', extensions: ['rnbackup'] }] });
    if (canceled) return false;
    vault.writeBackup(filePath);
    return true;
  },
  backupRestore: async () => {
    const { canceled, filePaths } = await dialog.showOpenDialog(win, { title: 'Restore from backup', properties: ['openFile'], filters: [{ name: 'RabbitNote backup', extensions: ['rnbackup'] }] });
    if (canceled) return false;
    await vault.restoreBackup(filePaths[0]);
    return true;
  },
  changePassphrase: async (cur, next) => { validPassphrase(next); await vault.changePassphrase(String(cur), next); runSync(); },
  exportText: async () => {
    const { canceled, filePath } = await dialog.showSaveDialog(win, { title: 'Export as plain text', defaultPath: 'rabbitnote-export.txt' });
    if (canceled) return false;
    fs.writeFileSync(filePath, vault.exportText(), { mode: 0o600 });
    const ids = vault.exportImages();
    if (ids.length) {
      const dir = `${filePath.replace(/\.txt$/i, '')}-images`;
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
      for (const id of ids) { const b = vault.getImage(id); if (b) fs.writeFileSync(path.join(dir, `${id}.webp`), b, { mode: 0o600 }); }
    }
    return true;
  },
  openLink: (url) => { if (ALLOWED_LINKS.some((p) => String(url).startsWith(p))) shell.openExternal(String(url)); },
  closeReady: async () => {
    closing = true;
    if (win) win.hide();
    await Promise.race([runSync(), new Promise((r) => setTimeout(r, 8000))]);
    vault.lock();
    app.quit();
  },
};

ipcMain.handle('rn', async (event, name, args) => {
  if (!event.senderFrame?.url.startsWith('file://') || !Object.hasOwn(handlers, name)) return { ok: false, error: 'Not allowed.' };
  try { return { ok: true, data: await handlers[name](...args) }; }
  catch (e) { return { ok: false, error: e.message || 'Something went wrong.' }; }
});

function createWindow() {
  win = new BrowserWindow({
    width: 1120, height: 760, minWidth: 720, minHeight: 520,
    title: 'RabbitNote', backgroundColor: '#b39467', autoHideMenuBar: true,
    icon: path.join(__dirname, '../renderer/icon.png'),
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, sandbox: true, nodeIntegration: false, spellcheck: true },
  });
  Menu.setApplicationMenu(null);
  win.loadFile(path.join(__dirname, '../renderer/index.html'));
  win.webContents.on('will-navigate', (e) => e.preventDefault());
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.on('close', (e) => {
    if (closing || !vault.unlocked) return;
    e.preventDefault();
    send('request-close');
  });
}

if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on('second-instance', () => { if (win) { win.show(); win.focus(); } });
  app.whenReady().then(() => {
    vault = new Vault(path.join(app.getPath('userData'), 'notebook'));
    createWindow();
    const requestLock = () => { if (vault.unlocked) send('request-lock'); };
    powerMonitor.on('lock-screen', requestLock);
    powerMonitor.on('suspend', requestLock);
    setInterval(() => { if (powerMonitor.getSystemIdleTime() >= AUTO_LOCK_SECONDS) requestLock(); }, 30000);
  });
  app.on('window-all-closed', () => app.quit());
}
