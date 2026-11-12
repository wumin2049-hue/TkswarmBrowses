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
  };
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
 * 在标签页首次导航前调用。返回的 Promise 在所有覆盖下发完成后 resolve（失败项只记日志）。
 * @param {Electron.WebContents} wc
 * @param {ReturnType<typeof buildEmulationOpts>} opts
 * @param {(msg: string) => void} [log]
 */
async function applyEmulationToWc(wc, opts = {}, log = () => {}) {
  if (!wc || wc.isDestroyed()) return false;

  try { wc.setWebRTCIPHandlingPolicy('disable_non_proxied_udp'); } catch { /* 老版本无此 API */ }

  const dbg = wc.debugger;
  try {
    if (!dbg.isAttached()) dbg.attach('1.3');
  } catch (error) {
    log(`标签页 debugger 附加失败，地区/指纹覆盖未应用: ${error?.message || error}`);
    return false;
  }
  const send = (method, params = {}) => dbg.sendCommand(method, params).then(
    () => true,
    (error) => { log(`${method} 失败: ${error?.message || error}`); return false; },
  );

  const applied = [];
  if (opts.userAgent) {
    const ok = await send('Emulation.setUserAgentOverride', {
      userAgent: opts.userAgent,
      acceptLanguage: acceptLanguageOf(opts.locale),
      platform: opts.platform || 'Win32',
      ...(opts.userAgentMetadata ? { userAgentMetadata: opts.userAgentMetadata } : {}),
    });
    if (ok) applied.push('UA/ClientHints');
  }
  if (opts.timezone && await send('Emulation.setTimezoneOverride', { timezoneId: opts.timezone })) {
    applied.push(`时区=${opts.timezone}`);
  }
  if (opts.locale && await send('Emulation.setLocaleOverride', { locale: String(opts.locale).split(',')[0].trim() })) {
    applied.push(`语言=${opts.locale}`);
  }
  const hasGeo = Number.isFinite(opts.latitude) && Number.isFinite(opts.longitude)
    && (opts.latitude !== 0 || opts.longitude !== 0);
  if (hasGeo && await send('Emulation.setGeolocationOverride', {
    latitude: opts.latitude,
    longitude: opts.longitude,
    accuracy: 100,
  })) {
    applied.push(`定位=${opts.latitude.toFixed(2)},${opts.longitude.toFixed(2)}`);
  }
  if (opts.injectScript && await send('Page.addScriptToEvaluateOnNewDocument', { source: opts.injectScript })) {
    applied.push('指纹脚本');
  }

  log(`标签页地区/指纹覆盖已应用: ${applied.join(' | ') || '无'}`
    + (opts.timezone ? '' : '（⚠ 未解析到代理时区，窗口将使用本机时区）'));
  return applied.length > 0;
}

module.exports = { buildEmulationOpts, applyEmulationToWc, acceptLanguageOf };
