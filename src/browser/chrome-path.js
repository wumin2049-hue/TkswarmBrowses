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
 * 过去这里写死 coreVersion='131'，而本机 Chrome 早已是 157，
 * 这正是 TikTok 注册被判高风险、强制要求 App 扫码的直接原因。
 *
 * @param {string} [exePath] 不传则内部解析
 * @returns {string} 主版本号，如 '157'；失败返回 ''
 */
function detectChromeMajorVersion(exePath) {
  try {
    const exe = exePath || resolveChromeExecutable();
    if (!exe || !fs.existsSync(exe)) return '';
    // Windows / macOS：可执行文件本身带版本资源
    if (process.platform === 'win32' || process.platform === 'darwin') {
      try {
        const { execFileSync } = require('node:child_process');
        const out = execFileSync(exe, ['--version'], {
          timeout: 8000,
          encoding: 'utf8',
          windowsHide: true,
          stdio: ['ignore', 'pipe', 'ignore'],
        });
        const m = String(out || '').match(/(\d{2,3})\.\d+\.\d+/);
        if (m) return m[1];
      } catch { /* 有些版本 --version 不输出，继续兜底 */ }
    }
    // 兜底：读 Application 目录下的版本号子目录（Windows 惯例）
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
    } catch { /* ignore */ }
  } catch { /* ignore */ }
  return '';
}

module.exports = { resolveChromeExecutable, detectChromeMajorVersion };
