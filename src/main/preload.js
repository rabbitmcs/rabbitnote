'use strict';
const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('rn', {
  call: async (name, ...args) => {
    const r = await ipcRenderer.invoke('rn', name, args);
    if (!r.ok) throw new Error(r.error);
    return r.data;
  },
  on: (ch, fn) => {
    if (['sync-status', 'entries-changed', 'request-lock', 'request-close', 'theme-changed'].includes(ch)) ipcRenderer.on(ch, (_e, d) => fn(d));
  },
});
