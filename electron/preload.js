const { contextBridge, ipcRenderer } = require('electron');

// 端口由主进程经 additionalArguments 传入，避免与其他实例（如打包版）占用 54345 时界面请求错实例
const portArg = (process.argv || []).find((a) => String(a).startsWith('--tkswarm-api-port='));
const apiPort = Number(portArg ? String(portArg).split('=')[1] : 0) || 54345;

contextBridge.exposeInMainWorld('tkswarmBrowser', {
  onWindowsUpdated: (fn) => {
    ipcRenderer.on('windows-updated', () => fn());
  },
  onTestEnvError: (fn) => {
    ipcRenderer.on('test-env-error', (_event, message) => fn(message));
  },
  apiPort,
});
