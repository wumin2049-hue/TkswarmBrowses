/**
 * Chromium / Electron 命令行开关（父进程 app.commandLine + 子进程 spawn argv 必须一致）。
 * 便携双层嵌套：子进程只继承父进程环境变量不够，GPU/RCI/沙箱相关开关必须出现在子进程 argv 里。
 */
const { readSettings } = require('../settings');

function inElectron() {
  return Boolean(process.versions && process.versions.electron);
}

function isRemoteSession() {
  return /rdp|citrix|console-remote/i.test(String(process.env.SESSIONNAME || ''));
}

function isPackagedApp() {
  if (!inElectron()) return false;
  try { return Boolean(require('electron').app.isPackaged); } catch { return false; }
}

function isPackagedPortable() {
  if (String(process.env.PORTABLE_EXECUTABLE_FILE || '').trim()) return true;
  if (String(process.env.PORTABLE_EXECUTABLE_DIR || '').trim()) return true;
  return isPackagedApp() && Boolean(process.env.PORTABLE_EXECUTABLE_DIR);
}

/** @returns {''|'env'|'settings'|'remote'} */
function wantSoftwareRender() {
  const env = String(process.env.TKSWARM_ENV_SOFTWARE_RENDER || '').trim();
  if (env === '1') return 'env';
  if (env === '0') return '';
  try {
    const flag = readSettings().envSoftwareRender;
    if (flag === true || flag === 'true') return 'settings';
    if (flag === false || flag === 'false') return '';
  } catch { /* */ }
  // 打包/便携默认 GPU；SwiftShader 仅白屏或 RDP 时手动/自动开启
  if (isRemoteSession()) return 'remote';
  return '';
}

function winDisableFeatures() {
  const features = ['Vulkan', 'RendererCodeIntegrity', 'CalculateNativeWinOcclusion'];
  return features.join(',');
}

/**
 * 必须关闭的自动化 blink 特性。
 *
 * AutomationControlled 打开时，`navigator.webdriver === true`，
 * 这是最著名、最容易被风控直接抓到的一条自动化特征。
 * TikTok 注册页只要读一次 navigator.webdriver 就能拒绝要求 App 验证，
 * 所以这里必须在 Chromium 启动前就关掉，而不是靠 JS 事后涂抹。
 */
const DISABLED_BLINK_FEATURES = ['AutomationControlled'];

/**
 * 子进程 spawn 用：必须在 --tkswarm-env 之前传入，确保 Chromium 在 BrowserMain 前解析。
 * @param {{ softwareRender?: boolean }} opts
 * @returns {string[]}
 */
function buildChildChromiumArgv(opts = {}) {
  const softwareRender = opts.softwareRender !== false
    && (opts.softwareRender === true || Boolean(wantSoftwareRender()) || Boolean(opts.forceSoftwareRender));
  const argv = [
    '--no-sandbox',
    '--disable-dev-shm-usage',
    '--disable-background-timer-throttling',
    '--disable-renderer-backgrounding',
    '--disable-backgrounding-occluded-windows',
    `--disable-features=${winDisableFeatures()}`,
    // 去掉 navigator.webdriver=true 这类自动化标记
    `--disable-blink-features=${DISABLED_BLINK_FEATURES.join(',')}`,
    // 关闭「Chrome 正受自动化软件控制」提示条带来的附加差异
    '--excludeSwitches=enable-automation',
  ];
  if (process.platform === 'win32') {
    argv.push('--disable-gpu-sandbox');
  }
  if (softwareRender) {
    argv.push(
      '--disable-gpu',
      '--disable-gpu-compositing',
      '--use-angle=swiftshader',
      '--in-process-gpu',
    );
  } else {
    argv.push(
      '--ignore-gpu-blocklist',
      '--enable-gpu-rasterization',
      '--enable-zero-copy',
      '--enable-features=CanvasOopRasterization',
    );
  }
  return argv;
}

/** 子进程 / 同进程 env：app ready 前调用（配合 argv 双保险） */
function applyEnvProcessFlags(app, { softwareRender } = {}) {
  if (!app) return;
  const useSw = softwareRender !== false
    && (softwareRender === true || Boolean(wantSoftwareRender()));
  if (useSw) {
    try { app.disableHardwareAcceleration(); } catch { /* */ }
  }
  for (const arg of buildChildChromiumArgv({ softwareRender: useSw, forceSoftwareRender: useSw })) {
    if (arg.startsWith('--disable-features=')) {
      app.commandLine.appendSwitch('disable-features', arg.slice('--disable-features='.length));
    } else if (arg.startsWith('--use-angle=')) {
      app.commandLine.appendSwitch('use-angle', arg.slice('--use-angle='.length));
    } else if (arg.startsWith('--')) {
      const eq = arg.indexOf('=');
      if (eq > 0) {
        app.commandLine.appendSwitch(arg.slice(2, eq), arg.slice(eq + 1));
      } else {
        app.commandLine.appendSwitch(arg.slice(2));
      }
    }
  }
}

function bootstrapParentFlags(app) {
  if (!app) return '';
  try { app.allowRendererProcessReuse = false; } catch { /* */ }
  const reason = wantSoftwareRender();
  if (reason) applyEnvProcessFlags(app, { softwareRender: true });
  return reason;
}

module.exports = {
  wantSoftwareRender,
  isPackagedPortable,
  isPackagedApp,
  isRemoteSession,
  buildChildChromiumArgv,
  applyEnvProcessFlags,
  bootstrapParentFlags,
};
