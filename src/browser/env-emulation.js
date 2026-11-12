/**
 * Electron 环境窗口：把「代理所在地区 + 指纹」真正应用到每个标签页。
 *
 * 背景：时区 / 语言 / 经纬度 / 指纹注入过去只在 Chrome 路径（launcher.js）里通过 CDP 应用，
 * Electron 路径（env-window.js 子进程、env-session-host.js 同进程）只设置了代理和 UA，
 * 结果是 profile 里存了正确的地区，打开的窗口却仍是本机时区 / 语言。
 *
 * 做法：对每个内容标签页的 webContents 挂 debugger，在首次导航之前下发
 *   - Emulation.setTimezoneOverride / setLocaleOverride / setGeolocationOverride
 *   - Emulation.setUserAgentOverride（含 acceptLanguage 与 userAgentMetadata，对齐 Client Hints）
 *   - Page.addScriptToEvaluateOnNewDocument（Canvas / WebGL / Audio / WebRTC 指纹脚本）
 * 并把 WebRTC IP 处理策略设为只走代理，防止真实 IP 经 STUN 泄露。
 */
const { buildInjectScript } = require('./fp-inject');
const { buildUserAgentMetadata } = require('./fingerprint');

/**
 * @param {{ profileId: string, fp?: object, userAgent?: string, locale?: string,
 *           timezone?: string, latitude?: number, longitude?: number }} src
 */
function buildEmulationOpts(src = {}) {
  const fp = src.fp || {};
  const locale = String(src.locale || fp.languages || 'en-US');
  let injectScript = '';
  try {
    injectScript = buildInjectScript(String(src.profileId || ''), {
      ...fp,
      userAgent: src.userAgent,
      languages: locale,
      os: fp.os,
    });
  } catch { /* 注入脚本生成失败不阻断打开 */ }
  let userAgentMetadata = null;
  try { userAgentMetadata = buildUserAgentMetadata(fp); } catch { /* */ }
  return {
    timezone: String(src.timezone || ''),
    locale,
    latitude: Number(src.latitude || 0),
    longitude: Number(src.longitude || 0),
    userAgent: String(src.userAgent || ''),
    platform: String(fp.os || 'Win32'),
    userAgentMetadata,
    injectScript,
    // 这两个属性在页面里是 non-configurable，JS 层 defineProperty 必然失败，
    // 只能走 CDP Emulation 覆盖（见 applyEmulationToWc）。
    hardwareConcurrency: Number(fp.hardwareConcurrency || 0),
    deviceMemory: Number(fp.deviceMemory || 0),
  };
}

/** 任何 CDP 命令都不能无限挂起：超时即放弃该项，不阻塞页面加载 */
function withTimeout(promise, ms, label) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label || '操作'} 超时(${ms}ms)`)), ms);
  });
  return Promise.race([Promise.resolve(promise), timeout]).finally(() => clearTimeout(timer));
}

function acceptLanguageOf(locale) {
  const primary = String(locale || 'en-US').split(',')[0].trim() || 'en-US';
  const base = primary.split('-')[0] || 'en';
  // CDP 的 acceptLanguage 不带权重，Chromium 自行追加 ;q=0.9
  return primary.includes('-') && base.toLowerCase() !== primary.toLowerCase()
    ? `${primary},${base}`
    : primary;
}

/**
 * 在标签页「首次导航开始」时下发覆盖，不阻塞、不预加载、不竞态。
 *
 * 时序要点（这是踩过两次坑后定下来的）：
 *   1. 新建的 BrowserView 还没有渲染进程，任何 debugger 命令都会挂起（v1.0.58 卡 90 秒）。
 *   2. 预加载 about:blank 会与真正的 loadURL 抢导航，页面停在 about:blank 永不前进（v1.0.59）。
 *   3. 正确时机是 did-start-navigation：此刻渲染进程已建、导航刚发起、页面 JS 尚未执行。
 *      在这里下发 Emulation 覆盖既不会挂起，又能赶在首屏 JS 读取时区/语言之前生效。
 *
 * 因此本函数不再 await 任何导航，立刻返回；覆盖在首次 did-start-navigation 里异步完成。
 *
 * @param {Electron.WebContents} wc
 * @param {ReturnType<typeof buildEmulationOpts>} opts
 * @param {(msg: string) => void} [log]
 * @returns {void}
 */
function applyEmulationToWc(wc, opts = {}, log = () => {}) {
  if (!wc || wc.isDestroyed()) return;

  try { wc.setWebRTCIPHandlingPolicy('disable_non_proxied_udp'); } catch { /* 老版本无此 API */ }

  let done = false;
  const runOnce = async () => {
    if (done) return;
    done = true;

    const dbg = wc.debugger;
    try {
      if (!dbg.isAttached()) dbg.attach('1.3');
    } catch (error) {
      log(`标签页 debugger 附加失败，地区/指纹覆盖未应用: ${error?.message || error}`);
      return;
    }
    const send = (method, params = {}, ms = 2500) => withTimeout(
      dbg.sendCommand(method, params), ms, method,
    ).then(() => true, (error) => {
      log(`${method} 失败: ${error?.message || error}`);
      return false;
    });

    // 关键：5 条命令必须并发下发，不能串行 await。
    // 串行时 UA（带 userAgentMetadata 较慢）会拖到 ~2s 才轮到发时区，
    // 此刻页面已开始加载、渲染进程繁忙，时区命令排队超时被放弃，
    // 最终「时区」缺失 → TikTok 判定 IP 与浏览器时区不一致 → 弹 App 扫码验证。
    // 并发下发让时区与 UA 同时到达，赶在首屏 JS 读取时区之前生效。
    const tasks = [];
    if (opts.userAgent) {
      tasks.push(send('Emulation.setUserAgentOverride', {
        userAgent: opts.userAgent,
        acceptLanguage: acceptLanguageOf(opts.locale),
        platform: opts.platform || 'Win32',
        ...(opts.userAgentMetadata ? { userAgentMetadata: opts.userAgentMetadata } : {}),
      }).then((ok) => ok && 'UA/ClientHints'));
    }
    if (opts.timezone) {
      // 时区是对齐的命门，单独放宽超时，避免页面加载瞬间被误杀
      tasks.push(send('Emulation.setTimezoneOverride', { timezoneId: opts.timezone }, 4000)
        .then((ok) => ok && `时区=${opts.timezone}`));
    }
    if (opts.locale) {
      tasks.push(send('Emulation.setLocaleOverride', { locale: String(opts.locale).split(',')[0].trim() })
        .then((ok) => ok && `语言=${opts.locale}`));
    }
    const hasGeo = Number.isFinite(opts.latitude) && Number.isFinite(opts.longitude)
      && (opts.latitude !== 0 || opts.longitude !== 0);
    if (hasGeo) {
      tasks.push(send('Emulation.setGeolocationOverride', {
        latitude: opts.latitude, longitude: opts.longitude, accuracy: 100,
      }).then((ok) => ok && `定位=${opts.latitude.toFixed(2)},${opts.longitude.toFixed(2)}`));
    }
    if (opts.injectScript) {
      tasks.push(send('Page.addScriptToEvaluateOnNewDocument', { source: opts.injectScript })
        .then((ok) => ok && '指纹脚本'));
    }
    // navigator.hardwareConcurrency 在页面里 non-configurable，JS 层改不动，走 CDP 覆盖。
    // 该命令较新，旧内核可能不认识，失败只记日志、不影响其它项。
    if (opts.hardwareConcurrency > 0) {
      tasks.push(send('Emulation.setHardwareConcurrencyOverride', {
        hardwareConcurrency: opts.hardwareConcurrency,
      }).then((ok) => ok && `硬件并发=${opts.hardwareConcurrency}`));
    }

    const applied = (await Promise.all(tasks)).filter(Boolean);
    log(`标签页地区/指纹覆盖已应用: ${applied.join(' | ') || '无'}`
      + (opts.timezone ? '' : '（⚠ 未解析到代理时区，窗口将使用本机时区）'));
  };

  // 首次主 frame 导航开始即下发。若首次导航是 about:blank / 本地页，则等下一个真正的导航。
  wc.on('did-start-navigation', (event) => {
    if (done) return;
    if (!event.isMainFrame) return;
    const url = String(event.url || '');
    if (url === 'about:blank' || url === 'about:srcdoc' || url.startsWith('file:')) return;
    void runOnce();
  });

  // 兜底：addScriptToEvaluateOnNewDocument 在 did-start-navigation 才注册，可能赶不上首屏文档，
  // 因此 dom-ready 时再用 executeJavaScript 补注入一次（脚本开头有 __TKSWARM_FP__ 守卫，重复执行无副作用）。
  wc.once('dom-ready', () => {
    if (!opts.injectScript) return;
    try {
      wc.executeJavaScript(opts.injectScript, true).catch(() => {});
    } catch { /* */ }
  });
}

module.exports = { buildEmulationOpts, applyEmulationToWc, acceptLanguageOf };
