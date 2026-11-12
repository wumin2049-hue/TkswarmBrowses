/**
 * 子 Electron 进程的 Chromium 启动参数。
 * 双层 portable 架构下，父进程 app.commandLine 不会继承到子进程，必须经 spawn argv 传入。
 */
const WIN_FEATURES = ['RendererCodeIntegrity', 'CalculateNativeWinOcclusion', 'Vulkan'];

/**
 * 必须关闭的 Chromium 特性。
 *
 * AutomationControlled：开启时 navigator.webdriver === true，是最容易被抓的自动化特征。
 * AsyncDns：异步 DNS 会在**本地**发起解析请求。虽然走 SOCKS5 时 Chromium 会把域名交给
 *   代理解析（远程 DNS），但 AsyncDns 的本地探测仍可能把真实 ISP 的 DNS 暴露出去，
 *   让「声称在海外」的环境在 DNS 层面漏出本地归属。关掉后统一由代理侧解析。
 */
const DISABLED_FEATURES = ['AutomationControlled', 'AsyncDns'];

/**
 * DNS 防泄露启动参数。
 *
 * 为什么需要：SOCKS5 转发时 Chromium 用 ATYP=域名 交给上游解析（远程 DNS，正确），
 * 但 Chromium 自己还会做 DNS **预取**（预测用户可能要访问的域名并提前解析），
 * 这一步走的是本机系统 DNS。结果是：环境声称在洛杉矶，本地 DNS 却向中国 ISP 查询了 tiktok.com。
 * 关闭预取 + 关闭异步 DNS，让解析完全落到代理侧。
 */
const DNS_LEAK_GUARD_ARGS = [
  '--dns-prefetch-disable',
  '--disable-features=AsyncDns,PrefetchDNS',
];

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
    // 注意：Chromium 只认最后一个 --disable-features，这里合并成一条
    `--disable-features=${WIN_FEATURES.join(',')},${DISABLED_FEATURES.join(',')}`,
    // 去掉 navigator.webdriver=true 与「正受自动化软件控制」相关差异
    '--disable-blink-features=AutomationControlled',
    '--excludeSwitches=enable-automation',
    // DNS 防泄露：禁止预取与异步解析，把域名解析交给代理侧完成
    ...DNS_LEAK_GUARD_ARGS.filter((a) => !a.startsWith('--disable-features=')),
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
  DISABLED_FEATURES,
  DNS_LEAK_GUARD_ARGS,
  bootFingerprint,
  WIN_FEATURES,
};
