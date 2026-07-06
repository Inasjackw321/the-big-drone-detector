'use strict';

const { contextBridge, ipcRenderer } = require('electron');

/**
 * Safe, explicit bridge between the renderer and the main process.
 * No Node APIs are exposed to the page — only these named channels.
 */
contextBridge.exposeInMainWorld('ddx', {
  bootstrap: () => ipcRenderer.invoke('app:bootstrap'),
  startMonitor: () => ipcRenderer.invoke('monitor:start'),
  stopMonitor: () => ipcRenderer.invoke('monitor:stop'),
  pollOnce: () => ipcRenderer.invoke('monitor:pollOnce'),
  getSettings: () => ipcRenderer.invoke('settings:get'),
  updateSettings: (patch) => ipcRenderer.invoke('settings:update', patch),
  getSightings: () => ipcRenderer.invoke('sightings:all'),
  getTracks: () => ipcRenderer.invoke('tracks:all'),
  checkBackend: () => ipcRenderer.invoke('backend:check'),
  clearSightings: () => ipcRenderer.invoke('sightings:clear'),
  openExternal: (url) => ipcRenderer.invoke('app:openExternal', url),

  // Event subscriptions (return an unsubscribe fn).
  on: (channel, handler) => {
    const allowed = [
      'pipeline:status',
      'pipeline:sighting',
      'pipeline:post',
      'pipeline:backfill',
      'pipeline:tracks',
      'pipeline:error',
      'pipeline:tick',
    ];
    if (!allowed.includes(channel)) return () => {};
    const listener = (_e, payload) => handler(payload);
    ipcRenderer.on(channel, listener);
    return () => ipcRenderer.removeListener(channel, listener);
  },
});
