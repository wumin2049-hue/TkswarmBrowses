/**
 * TikTok 注册环境自检
 * ---------------------------------------------------------------------------
 * 用法：在环境窗口里打开 tiktok.com，按 F12 打开 Console，粘贴本文件全部内容。
 *
 * 目的：回答一个必须先确认的问题 —— 「我们改的指纹到底生效了没有」。
 * 如果输出显示 UA 还是 131、webdriver 还是 true，说明用的是旧 exe，
 * 需要重新打包安装，后面的排查都没意义。
 */
(() => {
  const rows = [];
  const add = (item, value, verdict) => rows.push({ item, value: String(value), verdict });

  // ---- 1. UA 版本是否已跟随真实内核 ----
  const ua = navigator.userAgent;
  const uaVer = (ua.match(/Chrome\/(\d+)/) || [])[1] || '';
  const realVer = (navigator.userAgentData?.getHighEntropyValues
    ? null
    : null);
  add('navigator.userAgent', ua,
    /Electron|Headless/.test(ua) ? '❌ 含 Electron/Headless 字样' : '');
  add('UA Chrome 主版本', uaVer || '(无)',
    uaVer === '131' ? '❌ 还是写死的 131，改动未生效' : (uaVer ? '✓' : '❌ 解析失败'));

  // ---- 2. 自动化痕迹 ----
  add('navigator.webdriver', navigator.webdriver,
    navigator.webdriver === true ? '❌ 自动化特征，必须为 false' : '✓');

  // Playwright 注入痕迹：如果这个环境被 tkswarm-node 通过 CDP 连过，会残留这些
  const pwKeys = Object.keys(window).filter((k) => /playwright|__pw|cdc_|\$cdc|_selenium|__nightmare|__driver/i.test(k));
  add('自动化全局变量', pwKeys.length ? pwKeys.join(',') : '(无)',
    pwKeys.length ? '❌ 存在自动化注入痕迹' : '✓');

  // CDP 检测：Chromium 开了 DevTools 协议后，console.debug 会绑定特殊 getter
  const cdpTrap = (() => {
    try {
      let hit = false;
      const el = document.createElement('div');
      const desc = Object.getOwnPropertyDescriptor(el, 'onclick');
      void desc;
      // Runtime.enable 后 console 对象会有异常序列化行为
      const t0 = performance.now();
      // eslint-disable-next-line no-console
      console.debug(el);
      hit = performance.now() - t0 > 50;
      return hit;
    } catch { return false; }
  })();
  add('CDP console 探针', cdpTrap ? '疑似被调试' : '正常', '');

  // ---- 3. Client Hints 一致性 ----
  const uad = navigator.userAgentData;
  if (!uad) {
    add('navigator.userAgentData', '缺失', '❌ 真实 Chrome 一定有');
  } else {
    const brands = (uad.brands || []).map((b) => `${b.brand}=${b.version}`).join(', ');
    add('userAgentData.brands', brands,
      /Chromium/.test(brands) && /Google Chrome/.test(brands) ? '✓' : '❌ 品牌列表异常');
    add('userAgentData.platform', uad.platform, '');
    if (uad.getHighEntropyValues) {
      uad.getHighEntropyValues(['fullVersionList', 'platformVersion', 'architecture', 'bitness'])
        .then((h) => {
          const full = (h.fullVersionList || []).map((b) => `${b.brand}=${b.version}`).join(', ');
          const chromeVer = ((h.fullVersionList || []).find((b) => b.brand === 'Google Chrome') || {}).version || '';
          const major = chromeVer.split('.')[0];
          add('Client Hints 完整版本', full, '');
          add('Client Hints 主版本', major,
            major && uaVer && major !== uaVer ? `❌ 与 UA 不一致（UA=${uaVer}）` : '✓');
          add('platformVersion', h.platformVersion,
            /^10\.0\.0$/.test(h.platformVersion) && /Windows NT 1[01]/.test(ua) ? '需与真实系统比对' : '');
          add('architecture / bitness', `${h.architecture || '?'} / ${h.bitness || '?'}`, '');
          print();
        })
        .catch(() => print());
    }
  }

  // ---- 4. 时区 / 语言 / 地理 ----
  add('Intl 时区', Intl.DateTimeFormat().resolvedOptions().timeZone, '');
  add('getTimezoneOffset', new Date().getTimezoneOffset(), '');
  add('navigator.language', navigator.language, '');
  add('navigator.languages', JSON.stringify(navigator.languages), '');

  // ---- 5. plugins / chrome 对象 ----
  add('navigator.plugins.length', navigator.plugins.length,
    navigator.plugins.length === 0 ? '❌ 空数组是典型自动化特征' : '✓');
  add('window.chrome', typeof window.chrome, typeof window.chrome !== 'object' ? '❌ 缺失' : '✓');
  add('chrome.runtime', typeof window.chrome?.runtime, typeof window.chrome?.runtime !== 'object' ? '❌ 缺失' : '✓');

  // ---- 6. WebGL ----
  try {
    const gl = document.createElement('canvas').getContext('webgl');
    if (!gl) {
      add('WebGL', '不可用', '❌');
    } else {
      const dbg = gl.getExtension('WEBGL_debug_renderer_info');
      const r = dbg ? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER);
      add('WebGL renderer', r,
        /SwiftShader|llvmpipe|Software/i.test(String(r)) ? '❌ 软件渲染，强信号' : '✓');
    }
  } catch (e) {
    add('WebGL', 'ERROR ' + e.message, '❌');
  }

  // ---- 7. 出口 IP（关键：确认走的是哪个代理） ----
  fetch('https://api.ipify.org?format=json')
    .then((r) => r.json())
    .then((d) => add('出口 IP', d.ip, '← 与代理绑定记录比对'))
    .catch(() => add('出口 IP', '查询失败（可能被代理拦截）', '⚠'))
    .finally(() => print());

  function print() {
    // eslint-disable-next-line no-console
    console.log('%c=== TikTok 注册环境自检 ===', 'color:#0a0;font-weight:bold;font-size:14px');
    // eslint-disable-next-line no-console
    console.table(rows);
    const bad = rows.filter((r) => /❌/.test(r.verdict));
    if (bad.length) {
      // eslint-disable-next-line no-console
      console.warn(`%c⚠ ${bad.length} 项异常：`, 'color:#d00;font-weight:bold');
      bad.forEach((r) => console.warn(`  ${r.item} = ${r.value}  → ${r.verdict}`));
    } else {
      // eslint-disable-next-line no-console
      console.log('%c✓ 未发现明显自动化特征', 'color:#0a0');
    }
    // eslint-disable-next-line no-console
    console.log('把上表的「出口 IP」和你在代理后台看到的 IP 对一下：不一致就是串线了。');
    return rows;
  }
})();
