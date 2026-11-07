'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const readline = require('readline');
const C = require('./crypto');

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const VAULT = 'vault.json';
const BACKUP_MAGIC = 'RABBITNOTE-BACKUP-1';
const THEME_DATE = '0000-00-00'; // look and colours travel between devices as a hidden, encrypted entry
const IMG_RE = /\[\[img:([a-f0-9]{40})\]\]/g;
const IMG_NAME_RE = /^[a-f0-9]{40}\.rni$/;
const TAG_RE = /(^|[^\p{L}\p{N}_#&/])#([\p{L}\p{N}_-]{1,48})/gu;

function writeAtomic(file, data) {
  const tmp = `${file}.${crypto.randomBytes(4).toString('hex')}.tmp`;
  fs.writeFileSync(tmp, data, { mode: 0o600 });
  fs.renameSync(tmp, file);
}

// Notes are plain text with [[...]] markers for formatting. This returns just the words.
function plainText(text) {
  return text
    .replace(/\[\[draw:[A-Za-z0-9_-]*\]\]/g, '')
    .replace(/\[\[table:([A-Za-z0-9_-]*)\]\]/g, (_m, b) => {
      try { return `\n${JSON.parse(Buffer.from(b, 'base64url').toString()).map((r) => r.join('\t')).join('\n')}\n`; } catch { return ''; }
    })
    .replace(/\[\[\/?(?:b|i|u|hl|tape)(?::#[0-9a-fA-F]{6})?\]\]/g, '');
}

function tagsOf(raw) {
  const text = plainText(raw);
  const out = new Set();
  for (const m of text.matchAll(TAG_RE)) out.add(m[2].toLowerCase());
  return [...out];
}

function conflictText(keep, other, whenMs) {
  const when = new Date(whenMs).toLocaleString();
  return `${keep}\n\n--- Also written on another device (${when}) ---\n\n${other}`;
}

class Vault {
  constructor(dir, kdf) {
    this.dir = dir;
    this.kdf = kdf || C.KDF;
    this.entriesDir = path.join(dir, 'entries');
    this.imagesDir = path.join(dir, 'images');
    fs.mkdirSync(this.entriesDir, { recursive: true, mode: 0o700 });
    fs.mkdirSync(this.imagesDir, { recursive: true, mode: 0o700 });
    this.keys = null;
    this.index = new Map();
  }

  get unlocked() { return !!this.keys; }
  get vaultPath() { return path.join(this.dir, VAULT); }
  exists() { return fs.existsSync(this.vaultPath); }
  readVaultRaw() { return fs.readFileSync(this.vaultPath); }
  writeVaultRaw(buf) { JSON.parse(buf.toString()); writeAtomic(this.vaultPath, buf); }

  setMaster(master) {
    this.keys = { master, enc: C.subkey(master, 'enc'), id: C.subkey(master, 'id'), check: C.subkey(master, 'check') };
  }

  checkOf(v) {
    const { check, ...rest } = v;
    const canon = JSON.stringify([rest.v, rest.kdf, rest.salt, rest.wrapped, rest.updatedAt]);
    return C.hmac(this.keys.check, canon);
  }
  // True when a vault file belongs to the notebook that's currently open.
  verifyVault(buf) {
    try {
      const v = JSON.parse(buf.toString());
      const a = Buffer.from(this.checkOf(v));
      const b = Buffer.from(String(v.check));
      return a.length === b.length && crypto.timingSafeEqual(a, b);
    } catch { return false; }
  }

  async writeWrapped(passphrase) {
    const salt = crypto.randomBytes(16);
    const kek = await C.deriveFromPassphrase(passphrase, salt, this.kdf);
    const wrapped = C.seal(kek, this.keys.master, 'vault');
    kek.fill(0);
    const v = { v: 1, kdf: this.kdf, salt: salt.toString('base64'), wrapped: wrapped.toString('base64'), updatedAt: Date.now() };
    v.check = this.checkOf(v);
    writeAtomic(this.vaultPath, JSON.stringify(v));
  }

  async create(passphrase) {
    if (this.exists()) throw new Error('A notebook already exists here.');
    this.setMaster(crypto.randomBytes(32));
    await this.writeWrapped(passphrase);
    this.index = new Map();
  }

  async unlock(passphrase) {
    const v = JSON.parse(this.readVaultRaw().toString());
    const kek = await C.deriveFromPassphrase(passphrase, Buffer.from(v.salt, 'base64'), v.kdf);
    let master;
    try { master = C.open(kek, Buffer.from(v.wrapped, 'base64'), 'vault'); }
    catch { throw new Error('That passphrase is not correct.'); }
    finally { kek.fill(0); }
    this.setMaster(master);
    if (!this.verifyVault(Buffer.from(JSON.stringify(v)))) { this.lock(); throw new Error('The notebook file has been altered and cannot be trusted.'); }
    this.loadIndex();
  }

  async changePassphrase(current, next) {
    const v = JSON.parse(this.readVaultRaw().toString());
    const kek = await C.deriveFromPassphrase(current, Buffer.from(v.salt, 'base64'), v.kdf);
    try { C.open(kek, Buffer.from(v.wrapped, 'base64'), 'vault'); }
    catch { throw new Error('Your current passphrase is not correct.'); }
    finally { kek.fill(0); }
    await this.writeWrapped(next);
  }

  lock() {
    if (this.keys) Object.values(this.keys).forEach((k) => k.fill(0));
    this.keys = null;
    this.index = new Map();
  }

  // ---- entries ----
  nameOf(date) { return `${C.hmac(this.keys.id, date).slice(0, 40)}.rn`; }
  fileOf(name) {
    if (!/^[a-f0-9]{40}\.rn$/.test(name)) throw new Error('Bad file name.');
    return path.join(this.entriesDir, name);
  }

  decrypt(name, sealed) {
    const entry = JSON.parse(C.unpad(C.open(this.keys.enc, sealed, name)).toString());
    if (!DATE_RE.test(entry.date) || this.nameOf(entry.date) !== name) throw new Error('Entry does not match its file.');
    return entry;
  }
  encrypt(entry) {
    const name = this.nameOf(entry.date);
    return { name, sealed: C.seal(this.keys.enc, C.pad(Buffer.from(JSON.stringify(entry))), name) };
  }

  loadIndex() {
    this.index = new Map();
    this.unreadable = 0;
    for (const f of fs.readdirSync(this.entriesDir)) {
      if (!f.endsWith('.rn')) continue;
      try { const e = this.decrypt(f, fs.readFileSync(path.join(this.entriesDir, f))); this.index.set(e.date, e); }
      catch { this.unreadable++; }
    }
  }

  get(date) { return this.index.get(date) || { date, text: '', updatedAt: 0 }; }

  put(date, text, updatedAt = Date.now()) {
    const entry = { date, text, updatedAt };
    const { name, sealed } = this.encrypt(entry);
    writeAtomic(this.fileOf(name), sealed);
    this.index.set(date, entry);
    return entry;
  }

  // baseUpdatedAt is the version the editor loaded. If sync brought in something
  // newer while the person was typing, both versions are kept.
  save(date, text, baseUpdatedAt) {
    if (!DATE_RE.test(date)) throw new Error('Bad date.');
    const cur = this.index.get(date);
    if (!cur && !text) return this.get(date);
    if (cur && cur.text === text) return cur;
    if (cur && baseUpdatedAt !== undefined && cur.updatedAt !== baseUpdatedAt && cur.text.trim()) {
      text = conflictText(text, cur.text, cur.updatedAt);
    }
    return this.put(date, text);
  }

  visible() { return [...this.index.values()].filter((e) => e.date !== THEME_DATE); }

  overview() {
    const days = [];
    const tags = {};
    for (const e of this.visible()) {
      if (!e.text.trim()) continue;
      days.push(e.date);
      for (const t of tagsOf(e.text)) tags[t] = (tags[t] || 0) + 1;
    }
    return { days, tags };
  }

  search(query) {
    const q = query.trim().toLowerCase();
    if (!q) return [];
    const res = [];
    for (const e of this.visible()) {
      const text = plainText(e.text).replace(IMG_RE, ' ');
      const at = text.toLowerCase().indexOf(q);
      if (at < 0) continue;
      const start = Math.max(0, at - 40);
      res.push({ date: e.date, snippet: (start ? '…' : '') + text.slice(start, at + q.length + 70).replace(/\s+/g, ' ').trim() });
    }
    return res.sort((a, b) => b.date.localeCompare(a.date)).slice(0, 200);
  }

  exportText() {
    return this.visible().filter((e) => e.text.trim()).sort((a, b) => a.date.localeCompare(b.date))
      .map((e) => `=== ${e.date} ===\n${plainText(e.text).replace(IMG_RE, '[image: $1.webp]')}\n`).join('\n');
  }
  exportImages() {
    return [...new Set(this.visible().flatMap((e) => [...e.text.matchAll(IMG_RE)].map((m) => m[1])))];
  }

  // ---- images: encrypted one per file; named by content, so they never change ----
  imageFile(name) {
    if (!IMG_NAME_RE.test(name)) throw new Error('Bad file name.');
    return path.join(this.imagesDir, name);
  }
  addImage(bytes) {
    const id = C.hmac(this.keys.id, bytes).slice(0, 40);
    const name = `${id}.rni`;
    if (!fs.existsSync(this.imageFile(name))) writeAtomic(this.imageFile(name), C.seal(this.keys.enc, C.pad(Buffer.from(bytes)), name));
    return id;
  }
  getImage(id) {
    const name = `${id}.rni`;
    const f = this.imageFile(name);
    if (!fs.existsSync(f)) return null;
    return Buffer.from(C.unpad(C.open(this.keys.enc, fs.readFileSync(f), name)));
  }
  localImageNames() { return fs.readdirSync(this.imagesDir).filter((f) => IMG_NAME_RE.test(f)); }
  readImageRaw(name) { return fs.readFileSync(this.imageFile(name)); }
  applyRemoteImage(name, sealed) {
    C.unpad(C.open(this.keys.enc, sealed, name)); // throws if it fails authentication
    writeAtomic(this.imageFile(name), sealed);
  }

  // ---- backups: one file holding the already-encrypted notebook, opened with the passphrase ----
  writeBackup(file) {
    const fd = fs.openSync(`${file}.tmp`, 'w', 0o600);
    fs.writeSync(fd, `${BACKUP_MAGIC}\n${VAULT}\t${this.readVaultRaw().toString('base64')}\n`);
    for (const n of this.localNames()) fs.writeSync(fd, `${n}\t${this.readRaw(n).toString('base64')}\n`);
    for (const n of this.localImageNames()) fs.writeSync(fd, `${n}\t${this.readImageRaw(n).toString('base64')}\n`);
    fs.closeSync(fd);
    fs.renameSync(`${file}.tmp`, file);
  }
  async restoreBackup(file) {
    if (this.exists()) throw new Error('This computer already has a notebook.');
    const rl = readline.createInterface({ input: fs.createReadStream(file), crlfDelay: Infinity });
    let first = true; let vaultBuf = null; const writes = [];
    for await (const line of rl) {
      if (first) { if (line !== BACKUP_MAGIC) throw new Error('That is not a RabbitNote backup.'); first = false; continue; }
      const tab = line.indexOf('\t');
      const name = line.slice(0, tab);
      const buf = Buffer.from(line.slice(tab + 1), 'base64');
      if (name === VAULT) { JSON.parse(buf.toString()); vaultBuf = buf; }
      else if (/^[a-f0-9]{40}\.rn$/.test(name)) writes.push([this.fileOf(name), buf]);
      else if (IMG_NAME_RE.test(name)) writes.push([this.imageFile(name), buf]);
      else throw new Error('That backup file is damaged.');
    }
    if (first || !vaultBuf) throw new Error('That is not a RabbitNote backup.');
    for (const [p, b] of writes) writeAtomic(p, b);
    writeAtomic(this.vaultPath, vaultBuf); // last, so a failed restore never looks like a notebook
  }

  // ---- theme ----
  getTheme() {
    const e = this.index.get(THEME_DATE);
    if (!e) return null;
    try { return JSON.parse(e.text); } catch { return null; }
  }
  setTheme(theme) { this.put(THEME_DATE, JSON.stringify(theme)); }

  // ---- sync support ----
  localNames() { return fs.readdirSync(this.entriesDir).filter((f) => /^[a-f0-9]{40}\.rn$/.test(f)); }
  readRaw(name) { const p = this.fileOf(name); return fs.existsSync(p) ? fs.readFileSync(p) : null; }
  localMd5(name) { const b = this.readRaw(name); return b ? C.md5(b) : null; }
  applyRemote(name, sealed) {
    const entry = this.decrypt(name, sealed); // throws rather than storing anything that fails authentication
    writeAtomic(this.fileOf(name), sealed);
    this.index.set(entry.date, entry);
    return entry;
  }
  mergeRemote(name, sealed) {
    const remote = this.decrypt(name, sealed);
    const local = this.decrypt(name, this.readRaw(name));
    if (local.date === THEME_DATE) { // settings aren't merged: newest wins
      return remote.updatedAt >= local.updatedAt ? { entry: this.applyRemote(name, sealed), merged: false } : { entry: local, merged: true };
    }
    if (remote.text === local.text) return { entry: this.applyRemote(name, sealed), merged: false };
    const [keep, other] = remote.updatedAt >= local.updatedAt ? [remote, local] : [local, remote];
    let text;
    if (!other.text.trim()) text = keep.text;
    else if (!keep.text.trim()) text = other.text;
    else text = conflictText(keep.text, other.text, other.updatedAt);
    return { entry: this.put(local.date, text), merged: true };
  }

  get statePath() { return path.join(this.dir, 'sync-state.json'); }
  loadSyncState() { try { return JSON.parse(fs.readFileSync(this.statePath, 'utf8')); } catch { return {}; } }
  saveSyncState(s) { writeAtomic(this.statePath, JSON.stringify(s)); }
  clearSyncState() { fs.rmSync(this.statePath, { force: true }); }

  // ---- secrets stored under the notebook key ----
  get secretsPath() { return path.join(this.dir, 'secrets.rn'); }
  saveSecrets(obj) { writeAtomic(this.secretsPath, C.seal(this.keys.enc, Buffer.from(JSON.stringify(obj)), 'secrets')); }
  loadSecrets() {
    try { return JSON.parse(C.open(this.keys.enc, fs.readFileSync(this.secretsPath), 'secrets').toString()); } catch { return null; }
  }
  clearSecrets() { fs.rmSync(this.secretsPath, { force: true }); }
}

module.exports = { Vault, tagsOf, plainText, VAULT, THEME_DATE, IMG_NAME_RE };
