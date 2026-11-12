const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { DATA_ROOT } = require('../config');

function chromiumFromPlaywright() {
  try {
    const { chromium } = require('playwright-core');
    return chromium.executablePath();
  } catch {
    return null;
  }
}

function systemChromePaths() {
  if (process.platform === 'darwin') {
    return [
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      '/Applications/Chromium.app/Contents/MacOS/Chromium',
    ];
  }
  if (process.platform === 'win32') {
    const local = process.env.LOCALAPPDATA || '';
    return [
      path.join(local, 'Google', 'Chrome', 'Application', 'chrome.exe'),
      'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
      'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    ];
  }
  return ['/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser'];
}

function resolveChromeExecutable() {
  const cached = path.join(DATA_ROOT, 'chrome-path.txt');
  if (fs.existsSync(cached)) {
    const p = fs.readFileSync(cached, 'utf8').trim();
    if (p && fs.existsSync(p)) return p;
  }
  const candidates = [process.env.TKSWARM_CHROME_PATH, chromiumFromPlaywright(), ...systemChromePaths()].filter(Boolean);
  for (const p of candidates) {
    if (fs.existsSync(p)) {
      fs.mkdirSync(DATA_ROOT, { recursive: true });
      fs.writeFileSync(cached, p);
      return p;
    }
  }
  throw new Error(
    '未找到 Chrome/Chromium。Windows 打包版环境窗需要本机已安装 Google Chrome，'
    + '或设置环境变量 TKSWARM_CHROME_PATH 指向 chrome.exe'
  );
}

/**
 * 读取 Chrome 二进制的真实主版本号。
 *
 * 为什么必须读真实版本：UA 里声称的版本如果和内核真实版本不一致，
 * 就是最硬的一条伪装证据。Chrome 131 和 157 之间新增了大量 API，
 * 页面只要做一次特性探测（检测某个新版本才有的接口是否存在），
 * 就能发现「UA 说 131，但身上有 157 的特性」→ 立刻判定为伪造环境。
 *
 * ⚠ 绝对不要用 execFileSync(exe, ['--version']) 来取版本：
 * Windows 上 chrome.exe --version 不会输出到 stdout，而是直接拉起浏览器窗口
 * 并常驻不退出，同步调用会把主进程线程彻底卡死 —— 表现就是「点打开环境没反应」。
 * 这里只读文件系统：Chrome 的 Application 目录下有一个以完整版本号命名的子目录。
 *
 * @param {string} [exePath] 不传则内部解析
 * @returns {string} 主版本号，如 '157'；失败返回 ''
 */
function detectChromeMajorVersion(exePath) {
  try {
    const exe = exePath || resolveChromeExecutable();
    if (!exe || !fs.existsSync(exe)) return '';

    // 1) Chrome / Chromium 惯例：同目录下存在 "157.0.8103.39" 这样的版本目录
    try {
      const appDir = path.dirname(exe);
      const dirs = fs.readdirSync(appDir).filter((n) => /^\d{2,3}\.\d+\.\d+\.\d+$/.test(n));
      if (dirs.length) {
        const latest = dirs
          .map((n) => ({ n, v: n.split('.').map(Number) }))
          .sort((a, b) => {
            for (let i = 0; i < 4; i += 1) {
              const d = (b.v[i] || 0) - (a.v[i] || 0);
              if (d) return d;
            }
            return 0;
          })[0];
        if (latest) return String(latest.v[0]);
      }
    } catch { /* 下一级兜底 */ }

    // 2) Playwright 下载的 chromium：路径里通常带 chromium-XXXX / chrome-XXXX 标记，
    //    真实版本记在相邻的 .links 或 INSTALLATION_COMPLETE 旁，读不到就算了
    try {
      const pwDir = path.resolve(path.dirname(exe), '..');
      const marker = path.join(pwDir, 'DEPENDENCIES_VALIDATED');
      if (fs.existsSync(marker)) return '';
    } catch { /* ignore */ }

    // 3) macOS：Contents/MacOS/Google Chrome → 读同 bundle 的 Info.plist 里的版本
    if (process.platform === 'darwin') {
      try {
        const plist = path.resolve(path.dirname(exe), '..', 'Info.plist');
        if (fs.existsSync(plist)) {
          // 这是一个 XML 文本，取 CFBundleShortVersionString 后的第一段
          const text = fs.readFileSync(plist, 'utf8');
          const m = text.match(/CFBundleShortVersionString[\s\S]{0,200}?<string>(\d{2,3})\./);
          if (m) return m[1];
        }
      } catch { /* ignore */ }
    }
  } catch { /* ignore */ }
  return '';
}

module.exports = { resolveChromeExecutable, detectChromeMajorVersion };
