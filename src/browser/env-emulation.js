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
/**
 * 页面内时区兜底（纯 JS，不依赖 debugger）。
 * CDP Emulation.setTimezoneOverride 会在 debugger 脱离（如打开 DevTools）、换渲染进程时整体清空，
 * 这里在 JS 层再保一道：Intl 默认时区、getTimezoneOffset、toString 系列、toLocale* 系列。
 * 该函数会被 toString() 序列化注入页面，因此必须自包含，不能引用外部变量。
 */
function tzPatch(TZ) {
  if (window.__TKSWARM_TZ__ === TZ) return;
  try { Object.defineProperty(window, '__TKSWARM_TZ__', { value: TZ }); } catch (e) { return; }
  try {
    const OrigDTF = Intl.DateTimeFormat;
    const withTz = (o) => {
      if (o == null) return { timeZone: TZ };
      if (typeof o === 'object' && !o.timeZone) return { ...o, timeZone: TZ };
      return o;
    };
    const Patched = function DateTimeFormat(locales, options) {
      return Reflect.construct(OrigDTF, [locales, withTz(options)], new.target || Patched);
    };
    Patched.prototype = OrigDTF.prototype;
    // 原生 supportedLocalesOf 不依赖 this，直接复用，避免出现 "bound ..." 名称
    Object.defineProperty(Patched, 'supportedLocalesOf', { value: OrigDTF.supportedLocalesOf, writable: true, configurable: true });
    Object.defineProperty(Patched, 'length', { value: OrigDTF.length, configurable: true });
    // prototype.constructor 必须指回对外可见的构造器，否则 new Intl.DateTimeFormat().constructor !== Intl.DateTimeFormat
    Object.defineProperty(OrigDTF.prototype, 'constructor', { value: Patched, writable: true, configurable: true });
    Intl.DateTimeFormat = Patched;

    // 伪装：在已有（可能已被 fp-inject 伪装过的）Function.prototype.toString 之上再叠一层，
    // 让本脚本覆盖的函数对外表现为原生（toString / name / length）。
    const prevToString = Function.prototype.toString;
    const masked = new WeakMap();
    const mask = (fn, orig) => {
      try {
        masked.set(fn, prevToString.call(orig));
        Object.defineProperty(fn, 'name', { value: orig.name, configurable: true });
        Object.defineProperty(fn, 'length', { value: orig.length, configurable: true });
      } catch (e) { /* */ }
    };
    const toStr = function toString() {
      const m = masked.get(this);
      return m !== undefined ? m : prevToString.call(this);
    };
    mask(toStr, prevToString);
    Object.defineProperty(Function.prototype, 'toString', { value: toStr, writable: true, configurable: true });
    mask(Patched, OrigDTF);

    const partsFmt = new OrigDTF('en-US', {
      timeZone: TZ, hourCycle: 'h23', weekday: 'short', year: 'numeric', month: 'short',
      day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
    });
    const parts = (t) => {
      const p = {};
      partsFmt.formatToParts(new Date(t)).forEach((x) => { p[x.type] = x.value; });
      return p;
    };
    const MONTHS = { Jan: 0, Feb: 1, Mar: 2, Apr: 3, May: 4, Jun: 5, Jul: 6, Aug: 7, Sep: 8, Oct: 9, Nov: 10, Dec: 11 };
    const offsetMin = (t) => {
      const p = parts(t);
      const asUtc = Date.UTC(+p.year, MONTHS[p.month], +p.day, (+p.hour) % 24, +p.minute, +p.second);
      return Math.round((asUtc - Math.floor(t / 1000) * 1000) / 60000);
    };
    let tzName = TZ;
    try {
      const n = new OrigDTF(navigator.language || 'en-US', { timeZone: TZ, timeZoneName: 'long' })
        .formatToParts(new Date()).find((x) => x.type === 'timeZoneName');
      if (n) tzName = n.value;
    } catch (e) { /* */ }
    const pad = (n) => String(n).padStart(2, '0');
    const gmt = (t) => {
      const m = offsetMin(t);
      const a = Math.abs(m);
      return `GMT${m < 0 ? '-' : '+'}${pad(Math.floor(a / 60))}${pad(a % 60)} (${tzName})`;
    };
    const DP = Date.prototype;
    const def = (name, fn) => {
      try {
        const orig = DP[name];
        Object.defineProperty(DP, name, { value: fn, writable: true, configurable: true });
        if (typeof orig === 'function') mask(fn, orig);
      } catch (e) { /* */ }
    };
    def('getTimezoneOffset', function getTimezoneOffset() {
      const t = this.getTime();
      return Number.isNaN(t) ? NaN : -offsetMin(t);
    });
    def('toString', function toString() {
      const t = this.getTime();
      if (Number.isNaN(t)) return 'Invalid Date';
      const p = parts(t);
      return `${p.weekday} ${p.month} ${p.day} ${p.year} ${p.hour}:${p.minute}:${p.second} ${gmt(t)}`;
    });
    def('toTimeString', function toTimeString() {
      const t = this.getTime();
      if (Number.isNaN(t)) return 'Invalid Date';
      const p = parts(t);
      return `${p.hour}:${p.minute}:${p.second} ${gmt(t)}`;
    });
    def('toDateString', function toDateString() {
      const t = this.getTime();
      if (Number.isNaN(t)) return 'Invalid Date';
      const p = parts(t);
      return `${p.weekday} ${p.month} ${p.day} ${p.year}`;
    });
    ['toLocaleString', 'toLocaleDateString', 'toLocaleTimeString'].forEach((name) => {
      const orig = DP[name];
      def(name, function (locales, options) { return orig.call(this, locales, withTz(options)); });
    });
  } catch (e) { /* 兜底失败不影响其它覆盖 */ }
}

function buildTimezoneScript(timezone) {
  const tz = String(timezone || '').trim();
  if (!tz) return '';
  return `(${tzPatch.toString()})(${JSON.stringify(tz)});`;
}

/**
 * Worker 全局里的 navigator 补丁（toString 序列化后经 CDP Runtime.evaluate 注入）。
 * 页面主线程已被覆盖，但 Dedicated/Shared/Service Worker 是独立全局，
 * 风控脚本在 Worker 里再读一遍 UA / 语言 / 核数，若仍是本机值就会与页面对不上。
 */
function workerPatch(CFG) {
  try {
    const WN = self.WorkerNavigator && self.WorkerNavigator.prototype;
    if (!WN) return;
    const nativeToString = Function.prototype.toString;
    const masked = new WeakMap();
    const find = (o, k) => {
      for (let p = o; p; p = Object.getPrototypeOf(p)) {
        const d = Object.getOwnPropertyDescriptor(p, k);
        if (d) return d;
      }
      return null;
    };
    const mask = (fn, orig) => {
      try {
        masked.set(fn, nativeToString.call(orig));
        Object.defineProperty(fn, 'name', { value: orig.name, configurable: true });
        Object.defineProperty(fn, 'length', { value: orig.length, configurable: true });
      } catch (e) { /* */ }
    };
    const toStr = function toString() {
      const m = masked.get(this);
      return m !== undefined ? m : nativeToString.call(this);
    };
    mask(toStr, nativeToString);
    Object.defineProperty(Function.prototype, 'toString', { value: toStr, writable: true, configurable: true });
    const def = (k, v) => {
      try {
        const orig = find(WN, k);
        if (!orig || typeof orig.get !== 'function') return;
        const getter = function () { return v; };
        Object.defineProperty(WN, k, { get: getter, set: undefined, enumerable: orig.enumerable, configurable: true });
        mask(getter, orig.get);
      } catch (e) { /* non-configurable 时忽略，交给 CDP 覆盖 */ }
    };
    if (CFG.userAgent) {
      def('userAgent', CFG.userAgent);
      def('appVersion', CFG.userAgent.replace(/^Mozilla\//, ''));
    }
    if (CFG.platform) def('platform', CFG.platform);
    if (CFG.languages && CFG.languages.length) {
      def('language', CFG.languages[0]);
      def('languages', Object.freeze(CFG.languages.slice()));
    }
    if (CFG.hardwareConcurrency > 0) def('hardwareConcurrency', CFG.hardwareConcurrency);
    if (CFG.deviceMemory > 0) def('deviceMemory', CFG.deviceMemory);
  } catch (e) { /* */ }
}

function buildWorkerScript(cfg) {
  try {
    const parts = [`(${workerPatch.toString()})(${JSON.stringify(cfg)});`];
    if (cfg.timezone) {
      // tzPatch 里引用了 window，Worker 里没有：用局部变量别名，避免给 Worker 全局多出一个 window
      parts.push(`try{(function(){var window=self;(${tzPatch.toString()})(${JSON.stringify(cfg.timezone)});})();}catch(e){}`);
    }
    return parts.join('\n');
  } catch { return ''; }
}

function buildEmulationOpts(src = {}) {
  const fp = src.fp || {};
  const locale = String(src.locale || fp.languages || 'en-US');
  let injectScript = '';
  try {
    injectScript = buildInjectScript(String(src.profileId || ''), {
      ...fp,
      userAgent: src.userAgent,
      // navigator.languages 必须与 Accept-Language 一致（真实 Chrome 两者同源，如 id-ID,id）
      languages: acceptLanguageOf(locale),
      os: fp.os,
    });
  } catch { /* 注入脚本生成失败不阻断打开 */ }
  // 时区 JS 兜底与指纹脚本合并注入（同一个 addScript + 每次 dom-ready 补注入）。
  try {
    const tzScript = buildTimezoneScript(src.timezone);
    if (tzScript) injectScript = `${injectScript}\n;${tzScript}`;
  } catch { /* */ }
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
    // Worker / SharedWorker / ServiceWorker 里的 navigator 与时区也要与页面一致
    workerScript: buildWorkerScript({
      userAgent: String(src.userAgent || ''),
      platform: String(fp.os || 'Win32'),
      languages: acceptLanguageOf(locale).split(',').map((x) => x.trim()).filter(Boolean),
      hardwareConcurrency: Number(fp.hardwareConcurrency || 0),
      deviceMemory: Number(fp.deviceMemory || 0),
      timezone: String(src.timezone || ''),
    }),
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

  // 覆盖不能只下发一次：首次导航可能被打断（ERR_ABORTED）、重定向或换渲染进程，
  // 此后 Emulation 状态会丢失（页面退回本机时区）。因此每次主 frame 导航都重新下发，
  // 命令本身是幂等的；只有「指纹脚本」注册一次（debugger 脱离后才重新注册）。
  let scriptInstalled = false;
  let workersHooked = false;
  let workerLogCount = 0;
  let applying = false;
  let pendingReason = '';
  const runOnce = async (reason = '导航') => {
    if (applying) {
      pendingReason = reason;
      return;
    }
    applying = true;
    try {
      await applyAll(reason);
    } finally {
      applying = false;
      if (pendingReason) {
        const next = pendingReason;
        pendingReason = '';
        void runOnce(next);
      }
    }
  };
  // Worker 自动附加：Worker 一启动就暂停，先下发覆盖再放行（无论成败都必须 runIfWaitingForDebugger，否则 Worker 会卡死）。
  try {
    wc.debugger.on('message', (_e, method, params, sessionId) => {
      if (method !== 'Target.attachedToTarget') return;
      const sid = params && params.sessionId;
      if (!sid) return;
      const info = (params && params.targetInfo) || {};
      const dbg = wc.debugger;
      const call = (m, p, ms = 1500) => withTimeout(dbg.sendCommand(m, p, sid), ms, m).then(() => true, () => false);
      void (async () => {
        try {
          if (/worker/i.test(String(info.type || '')) && opts.workerScript) {
            const results = await Promise.all([
              opts.userAgent ? call('Emulation.setUserAgentOverride', {
                userAgent: opts.userAgent,
                acceptLanguage: acceptLanguageOf(opts.locale),
                platform: opts.platform || 'Win32',
                ...(opts.userAgentMetadata ? { userAgentMetadata: opts.userAgentMetadata } : {}),
              }) : false,
              opts.hardwareConcurrency > 0 ? call('Emulation.setHardwareConcurrencyOverride', { hardwareConcurrency: opts.hardwareConcurrency }) : false,
              opts.timezone ? call('Emulation.setTimezoneOverride', { timezoneId: opts.timezone }) : false,
              call('Runtime.evaluate', { expression: opts.workerScript, silent: true }),
            ]);
            if (workerLogCount < 6) {
              workerLogCount += 1;
              log(`Worker 覆盖(${info.type}) UA=${results[0] ? '√' : '×'} 并发=${results[1] ? '√' : '×'} 时区=${results[2] ? '√' : '×'} 脚本=${results[3] ? '√' : '×'} ${String(info.url || '').slice(0, 80)}`);
            }
          }
        } catch { /* */ } finally {
          if (params && params.waitingForDebugger) await call('Runtime.runIfWaitingForDebugger', {}, 3000);
        }
      })();
    });
  } catch { /* */ }
  try {
    wc.debugger.on('detach', (_e, why) => {
      scriptInstalled = false;
      workersHooked = false;
      log(`标签页 debugger 已脱离(${why})，Emulation 覆盖随之清空，稍后自动重新附加并下发`);
      // 脱离（如打开 DevTools 把 debugger 顶掉）会立刻清空时区等覆盖，页面退回本机时区；
      // 不等下一次导航，延迟片刻后直接重新附加下发。
      if (why === 'target closed' || wc.isDestroyed()) return;
      setTimeout(() => {
        if (!wc.isDestroyed()) void runOnce('debugger脱离后重连');
      }, 400);
    });
  } catch { /* */ }

  const applyAll = async (reason) => {
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
    // 指纹脚本只注册一次，否则每次导航都会叠加一份；debugger 脱离后 scriptInstalled 会被清零。
    if (opts.injectScript && !scriptInstalled) {
      tasks.push(send('Page.addScriptToEvaluateOnNewDocument', { source: opts.injectScript })
        .then((ok) => {
          if (ok) scriptInstalled = true;
          return ok && '指纹脚本';
        }));
    }
    // navigator.hardwareConcurrency 在页面里 non-configurable，JS 层改不动，走 CDP 覆盖。
    // 该命令较新，旧内核可能不认识，失败只记日志、不影响其它项。
    if (opts.hardwareConcurrency > 0) {
      tasks.push(send('Emulation.setHardwareConcurrencyOverride', {
        hardwareConcurrency: opts.hardwareConcurrency,
      }).then((ok) => ok && `硬件并发=${opts.hardwareConcurrency}`));
    }

    // 让 Worker / SharedWorker / ServiceWorker 也拿到同样的覆盖（每次 debugger 附加后只设一次）。
    // 设环境变量 TKSWARM_WORKER_EMU=0 可整体关闭，便于排查 Worker 相关问题。
    if (!workersHooked && opts.workerScript && String(process.env.TKSWARM_WORKER_EMU || '') !== '0') {
      workersHooked = true;
      tasks.push(send('Target.setAutoAttach', {
        autoAttach: true,
        waitForDebuggerOnStart: true,
        flatten: true,
        filter: [{ type: 'worker' }, { type: 'service_worker' }, { type: 'shared_worker' }, { exclude: true }],
      }).then((ok) => {
        if (!ok) workersHooked = false;
        return ok && 'Worker覆盖';
      }));
    }

    const applied = (await Promise.all(tasks)).filter(Boolean);
    log(`标签页地区/指纹覆盖已应用(${reason}): ${applied.join(' | ') || '无'}`
      + (opts.timezone ? '' : '（⚠ 未解析到代理时区，窗口将使用本机时区）'));
  };

  // 每次「主 frame、非页内跳转」的真实导航开始都重新下发（幂等）。
  // 跳过 about:blank / 本地页，避免对外壳页或空白页白白附加 debugger。
  wc.on('did-start-navigation', (event) => {
    if (!event.isMainFrame || event.isInPlace) return;
    const url = String(event.url || '');
    if (url === 'about:blank' || url === 'about:srcdoc' || url.startsWith('file:')) return;
    void runOnce('导航');
  });

  // 渲染进程被换掉或崩溃重建后，Emulation 状态同样会丢，下一次导航前先标记脚本需重装。
  wc.on('render-process-gone', () => { scriptInstalled = false; workersHooked = false; });

  // 兜底：addScriptToEvaluateOnNewDocument 可能赶不上首屏文档，每个新文档 dom-ready 时
  // 再用 executeJavaScript 补注入一次（脚本开头有 __TKSWARM_FP__ 守卫，重复执行无副作用）。
  wc.on('dom-ready', () => {
    if (opts.injectScript) {
      try {
        wc.executeJavaScript(opts.injectScript, true).catch(() => {});
      } catch { /* */ }
    }

    // 时区自检：读回页面真实看到的时区，不一致就记日志并立刻重新下发。
    // 既自愈，也能在日志里留下「覆盖是在哪一步丢的」的证据。
    if (!opts.timezone) return;
    try {
      wc.executeJavaScript('Intl.DateTimeFormat().resolvedOptions().timeZone', true)
        .then(async (tz) => {
          if (String(tz) === opts.timezone) return;
          log(`时区自检不一致：页面=${tz} 期望=${opts.timezone}，立即重新下发 (${String(wc.getURL()).slice(0, 80)})`);
          try {
            if (!wc.debugger.isAttached()) wc.debugger.attach('1.3');
            await withTimeout(
              wc.debugger.sendCommand('Emulation.setTimezoneOverride', { timezoneId: opts.timezone }),
              4000,
              'Emulation.setTimezoneOverride',
            );
            log('时区重新下发完成');
          } catch (error) {
            log(`时区重新下发失败: ${error?.message || error}`);
          }
        })
        .catch(() => {});
    } catch { /* */ }
  });
}

module.exports = { buildEmulationOpts, applyEmulationToWc, acceptLanguageOf };
