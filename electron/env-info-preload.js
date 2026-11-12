const { contextBridge, ipcRenderer } = require('electron');

function chanFromArgv() {
  try {
    const hit = process.argv.find((a) => a.startsWith('--env-info-chan='));
    if (hit) return hit.split('=').slice(1).join('=');
  } catch { /* */ }
  return '';
}

const chan = chanFromArgv();

contextBridge.exposeInMainWorld('envInfo', {
  get: () => ipcRenderer.invoke(`${chan}:data`),
  refresh: () => ipcRenderer.invoke(`${chan}:refresh`),
  close: () => ipcRenderer.send(`${chan}:close`),
});
