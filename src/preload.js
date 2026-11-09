'use strict';

const { contextBridge, ipcRenderer, webUtils } = require('electron');

const listen = (channel) => (callback) => {
  const handler = (_e, data) => callback(data);
  ipcRenderer.on(channel, handler);
  return () => ipcRenderer.removeListener(channel, handler);
};

contextBridge.exposeInMainWorld('seabathy', {
  loadStore: (name) => ipcRenderer.invoke('store:load', name),
  saveStore: (name, data) => ipcRenderer.invoke('store:save', name, data),
  openDataFolder: () => ipcRenderer.invoke('store:folder'),

  saveFile: (dir, name, text) => ipcRenderer.invoke('files:save', dir, name, text),
  loadFile: (dir, name) => ipcRenderer.invoke('files:load', dir, name),
  listFiles: (dir) => ipcRenderer.invoke('files:list', dir),
  deleteFile: (dir, name) => ipcRenderer.invoke('files:delete', dir, name),

  httpGet: (url, options) => ipcRenderer.invoke('net:get', url, options),
  isOnline: () => ipcRenderer.invoke('net:online'),
  countryCode: () => ipcRenderer.invoke('app:country'),

  log: (tag, message) => ipcRenderer.invoke('log:write', tag, message),
  exportLog: () => ipcRenderer.invoke('log:export'),

  openTif: () => ipcRenderer.invoke('file:openTif'),
  tifFromPath: (path) => ipcRenderer.invoke('file:fromPath', path),
  downloadSeabed: (url, name) => ipcRenderer.invoke('seabed:download', url, name),
  openMbtilesFile: () => ipcRenderer.invoke('file:openMbtiles'),
  fileExists: (path) => ipcRenderer.invoke('file:exists', path),
  pathForFile: (file) => webUtils.getPathForFile(file),
  openText: (extensions) => ipcRenderer.invoke('file:openText', extensions),
  saveText: (name, text, extensions) => ipcRenderer.invoke('file:saveText', name, text, extensions),
  savePng: (name, dataUrl) => ipcRenderer.invoke('file:savePng', name, dataUrl),
  showInFolder: (path) => ipcRenderer.invoke('file:show', path),

  openMbtiles: (path) => ipcRenderer.invoke('mbtiles:open', path),
  closeMbtiles: (id) => ipcRenderer.invoke('mbtiles:close', id),

  tileCount: (bounds, minZoom, maxZoom) => ipcRenderer.invoke('download:count', bounds, minZoom, maxZoom),
  sampleTiles: (template, bounds, minZoom, maxZoom) => ipcRenderer.invoke('download:sample', template, bounds, minZoom, maxZoom),
  startDownload: (job) => ipcRenderer.invoke('download:start', job),
  cancelDownload: () => ipcRenderer.invoke('download:cancel'),
  downloadRunning: () => ipcRenderer.invoke('download:running'),
  downloadsFolder: () => ipcRenderer.invoke('download:folder'),
  onDownloadProgress: listen('download:progress'),
  onDownloadDone: listen('download:done'),
  onDownloadFailed: listen('download:failed')
});
