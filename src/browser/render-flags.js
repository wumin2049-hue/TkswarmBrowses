/**
 * 环境窗软件渲染与便携版检测。
 */
const { readSettings } = require('../settings');
const { applyChromiumArgvToApp } = require('./chromium-argv');

function inElectron() {
  return Boolean(process.versions && process.versions.electron);
}

function isRemoteSession() {
  return /rdp|citrix|console-remote/i.test(String(process.env.SESSIONNAME || ''));
}

function isPackagedApp() {
  if (!inElectron()) return false;
  try {
    return Boolean(require('electron').app.isPackaged);
  } catch {
    return false;
  }
}

function isPackagedPortable() {
  if (String(process.env.PORTABLE_EXECUTABLE_DIR || '').trim()) return true;
  return isPackagedApp() && Boolean(process.env.PORTABLE_EXECUTABLE_DIR);
}

/**
 * 软件渲染（SwiftShader）极吃 CPU，默认关闭以免环境窗卡顿。
 * 仅在白屏 / 远程桌面等场景按需开启：settings / 环境变量 / RDP。
 */
function wantSoftwareRender() {
  const env = String(process.env.TKSWARM_ENV_SOFTWARE_RENDER || '').trim();
  if (env === '1') return 'env';
  if (env === '0') return '';
  try {
    const flag = readSettings().envSoftwareRender;
    if (flag === true || flag === 'true') return 'settings';
    if (flag === false || flag === 'false') return '';
  } catch { /* default below */ }
  // 打包版 / 便携版默认走 GPU 硬件加速（成熟指纹浏览器同策略）；白屏再手动开软件渲染
  if (isRemoteSession()) return 'remote';
  return '';
}

function applySoftwareRenderFlags(app, options = {}) {
  applyChromiumArgvToApp(app, {
    softwareRender: options.softwareRender === true,
    disableSandbox: options.disableSandbox !== false,
    profileId: options.profileId || '',
  });
}

function bootstrapRenderFlags() {
  if (!inElectron()) return '';
  let app;
  try { app = require('electron').app; } catch { return ''; }
  const reason = wantSoftwareRender();
  if (reason) {
    applySoftwareRenderFlags(app, {
      softwareRender: true,
      disableSandbox: isPackagedApp(),
    });
  }
  return reason;
}

module.exports = {
  wantSoftwareRender,
  applySoftwareRenderFlags,
  bootstrapRenderFlags,
  isPackagedPortable,
  isPackagedApp,
  isRemoteSession,
};
