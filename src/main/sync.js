'use strict';
const C = require('./crypto');
const { VAULT, IMG_NAME_RE } = require('./vault');

class WrongNotebookError extends Error {}

// Three-way compare per file using the checksum from the last successful sync:
// only-local-changed uploads, only-remote-changed downloads, both-changed merges.
async function syncOnce(vault, remote) {
  const files = new Map((await remote.list()).map((f) => [f.name, f]));
  const changedDates = [];
  let failed = 0;
  let vaultChanged = false;

  const rv = files.get(VAULT);
  const localVault = vault.readVaultRaw();
  if (rv) {
    const buf = await remote.download(rv.id);
    if (!vault.verifyVault(buf)) {
      throw new WrongNotebookError('This Google Drive holds a different RabbitNote notebook. Nothing was synced.');
    }
    const r = JSON.parse(buf.toString()).updatedAt;
    const l = JSON.parse(localVault.toString()).updatedAt;
    if (r > l) { vault.writeVaultRaw(buf); vaultChanged = true; }
    else if (l > r) await remote.upload(VAULT, localVault, rv.id);
  } else {
    await remote.upload(VAULT, localVault);
  }

  // Images come first so that a note arriving next can already show its pictures.
  let imagesArrived = false;
  const localImages = new Set(vault.localImageNames());
  const remoteImages = [...files.keys()].filter((n) => IMG_NAME_RE.test(n));
  for (const name of [...new Set([...localImages, ...remoteImages])]) {
    try {
      if (!files.has(name)) await remote.upload(name, vault.readImageRaw(name));
      else if (!localImages.has(name)) { vault.applyRemoteImage(name, await remote.download(files.get(name).id)); imagesArrived = true; }
    } catch (e) {
      if (e.name === 'TypeError' || e.offline || e.auth) throw e;
      failed++;
    }
  }

  const state = vault.loadSyncState();
  const names = new Set([...vault.localNames(), ...[...files.keys()].filter((n) => /^[a-f0-9]{40}\.rn$/.test(n))]);

  for (const name of names) {
    const rf = files.get(name);
    const L = vault.localMd5(name);
    const R = rf ? rf.md5 : null;
    const B = state[name] || null;
    try {
      if (L === R) { state[name] = L; continue; }
      if (L && (!R || R === B)) {
        const bytes = vault.readRaw(name);
        const up = await remote.upload(name, bytes, rf && rf.id);
        state[name] = up.md5 || C.md5(bytes);
      } else if (R && (!L || L === B)) {
        const bytes = await remote.download(rf.id);
        if (vault.localMd5(name) !== L) continue; // edited while downloading; next round merges it
        const entry = vault.applyRemote(name, bytes);
        state[name] = R;
        changedDates.push(entry.date);
      } else {
        const bytes = await remote.download(rf.id);
        if (vault.localMd5(name) !== L) continue;
        const { entry, merged } = vault.mergeRemote(name, bytes);
        if (merged) {
          const out = vault.readRaw(name);
          const up = await remote.upload(name, out, rf.id);
          state[name] = up.md5 || C.md5(out);
        } else state[name] = R;
        changedDates.push(entry.date);
      }
    } catch (e) {
      if (e.name === 'TypeError' || e.offline || e.auth) { vault.saveSyncState(state); throw e; }
      failed++;
    }
    vault.saveSyncState(state);
  }
  vault.saveSyncState(state);
  return { changedDates, failed, vaultChanged, imagesArrived };
}

module.exports = { syncOnce, WrongNotebookError };
