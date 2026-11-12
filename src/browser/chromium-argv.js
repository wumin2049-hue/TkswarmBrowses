/**
 * 子 Electron 进程的 Chromium 启动参数。
 * 双层 portable 架构下，父进程 app.commandLine 不会继承到子进程，必须经 spawn argv 传入。
 */
const WIN_FEATURES = ['RendererCodeIntegrity', 'CalculateNativeWinOcclusion', 'Vulkan'];

/**
 * 必须关闭的 blink 自动化特性。
 *
 * AutomationControlled 启用时 `navigator.webdriver === true`，
 * 这是风控最容易直接抓到的一条自动化特征：TikTok 注册页读一次就能拒绝，
 * 要求「Continue on the TikTok app」扫码验证。
 * 必须在 Chromium 启动前关掉，靠 JS 事后涂抹会被 getter 特征反查。
 */
const DISABLED_BLINK_FEATURES = ['AutomationControlled'];

/**
 * @param {{ softwareRender?: boolean, disableSandbox?: boolean, profileId?: string }} options
 * @returns {string[]}
 */
function buildChildChromiumArgv(options = {}) {
  const {
    softwareRender = false,
    disableSandbox = true,
    profileId = '',
  } = options;

  const args = [
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-background-networking',
    '--disable-sync',
    '--disable-background-timer-throttling',
    '--disable-renderer-backgrounding',
    '--disable-backgrounding-occluded-windows',
    '--remote-allow-origins=*',
    `--disable-features=${WIN_FEATURES.join(',')}`,
    // 去掉 navigator.webdriver=true 与「正受自动化软件控制」相关差异
    `--disable-blink-features=${DISABLED_BLINK_FEATURES.join(',')}`,
    '--excludeSwitches=enable-automation',
  ];

  if (disableSandbox) {
    args.push('--no-sandbox', '--disable-gpu-sandbox');
  }

  if (softwareRender) {
    args.push('--disable-gpu', '--disable-gpu-compositing', '--use-angle=swiftshader');
  } else {
    // 硬件加速：成熟指纹浏览器默认开 GPU，显著减轻页面卡顿
    args.push(
      '--ignore-gpu-blocklist',
      '--enable-gpu-rasterization',
      '--enable-zero-copy',
      '--enable-features=CanvasOopRasterization',
    );
  }

  if (profileId) {
    args.push(`--tkswarm-profile=${profileId}`);
  }

  return args;
}

/** 将 argv 开关同步到 app.commandLine（子进程 main.js 兜底，须在 app.ready 前） */
function applyChromiumArgvToApp(app, options = {}) {
  if (!app) return;
  if (options.softwareRender === true) {
    try { app.disableHardwareAcceleration(); } catch { /* */ }
  }
  for (const arg of buildChildChromiumArgv(options)) {
    if (!arg.startsWith('--')) continue;
    const body = arg.slice(2);
    const eq = body.indexOf('=');
    if (eq > 0) {
      app.commandLine.appendSwitch(body.slice(0, eq), body.slice(eq + 1));
    } else {
      app.commandLine.appendSwitch(body);
    }
  }
}

function bootFingerprint() {
  return {
    execPath: process.execPath,
    cwd: process.cwd(),
    resourcesPath: process.resourcesPath,
    portableFile: process.env.PORTABLE_EXECUTABLE_FILE || '',
    portableDir: process.env.PORTABLE_EXECUTABLE_DIR || '',
    argv: process.argv.slice(1),
    pid: process.pid,
  };
}

module.exports = {
  buildChildChromiumArgv,
  applyChromiumArgvToApp,
  bootFingerprint,
  WIN_FEATURES,
};
