/**
 * 指纹浏览器三项硬指标验收
 * ---------------------------------------------------------------------------
 * 在环境窗口里打开 tiktok.com（或任意 https 页面）→ F12 → Console → 粘贴本文件。
 *
 * 逐项核对：
 *   ① 环境参数对齐：代理 IP 归属 vs 时区 / 语言 / 经纬度
 *   ② WebRTC 不泄露：内网 IP、公网 IP 是否能被绕出来
 *   ③ 指纹灵活且稳定：Canvas / WebGL / Audio 每个环境不同，但同一环境内恒定
 *
 * 输出末尾会给出 PASS / FAIL 汇总。
 */
(async () => {
  const rows = [];
  const add = (group, item, value, ok) => rows.push({ group, item, value: String(value), ok });
  const OK = true; const BAD = false; const INFO = null;

  /* ---------------- ① 地区对齐 ---------------- */
  let ipInfo = null;
  try {
    const r = await fetch('http://ip-api.com/json/?fields=status,country,countryCode,regionName,city,timezone,lat,lon,isp,org,as,hosting,proxy,query');
    ipInfo = await r.json();
  } catch { /* 国内网络可能拿不到 */ }
  if (!ipInfo) {
    try {
      const r = await fetch('https://ipapi.co/json/');
      const d = await r.json();
      ipInfo = {
        countryCode: d.country_code, regionName: d.region, city: d.city,
        timezone: d.timezone, lat: d.latitude, lon: d.longitude,
        isp: d.org, as: d.asn, hosting: null, proxy: null, query: d.ip,
      };
    } catch { /* ignore */ }
  }

  const browserTz = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const browserLang = navigator.language;
  const browserLangs = navigator.languages;

  if (ipInfo) {
    add('①地区', '出口 IP', `${ipInfo.query} (${ipInfo.countryCode} ${ipInfo.regionName || ''} ${ipInfo.city || ''})`, INFO);
    add('①地区', 'IP 时区', ipInfo.timezone, INFO);
    add('①地区', '浏览器时区', browserTz, ipInfo.timezone ? (browserTz === ipInfo.timezone ? OK : BAD) : INFO);
    add('①地区', '浏览器语言', `${browserLang} [${(browserLangs || []).join(',')}]`, INFO);
    add('①地区', 'ISP / AS', `${ipInfo.isp || ''} / ${ipInfo.as || ''}`, INFO);
    add('①地区', 'hosting 标记', ipInfo.hosting === null ? '(该数据源无此字段)' : ipInfo.hosting,
      ipInfo.hosting === true ? BAD : (ipInfo.hosting === false ? OK : INFO));
    add('①地区', 'proxy 标记', ipInfo.proxy === null ? '(该数据源无此字段)' : ipInfo.proxy,
      ipInfo.proxy === true ? BAD : (ipInfo.proxy === false ? OK : INFO));

    // 经纬度偏差（时区对了但位置差半个地球同样可疑）
    if (ipInfo.lat != null && navigator.geolocation) {
      const pos = await new Promise((res) => {
        try {
          navigator.geolocation.getCurrentPosition(
            (p) => res({ lat: p.coords.latitude, lon: p.coords.longitude }),
            () => res(null), { timeout: 4000, maximumAge: 0 },
          );
        } catch { res(null); }
      });
      if (pos) {
        const d = haversine(pos.lat, pos.lon, ipInfo.lat, ipInfo.lon);
        add('①地区', '经纬度偏差', `${d.toFixed(0)} km（浏览器 ${pos.lat.toFixed(2)},${pos.lon.toFixed(2)}）`,
          d > 500 ? BAD : OK);
      } else {
        add('①地区', '经纬度', '浏览器拒绝提供（正常，未授予权限）', INFO);
      }
    }
  } else {
    add('①地区', '出口 IP', '所有查询源均失败', INFO);
  }
  add('①地区', 'Accept-Language 一致性', navigator.language,
    browserLang && ipInfo?.countryCode ? '见上「浏览器语言」' : INFO);

  /* ---------------- ② WebRTC 泄露 ---------------- */
  const rtcLeak = await new Promise((resolve) => {
    const found = new Set();
    let done = false;
    const finish = () => { if (!done) { done = true; resolve([...found]); } };
    try {
      const pc = new RTCPeerConnection({
        iceServers: [{ urls: 'stun:stun.l.google.com:19302' }],
      });
      pc.createDataChannel('probe');
      const timer = setTimeout(() => { try { pc.close(); } catch {} finish(); }, 6000);
      pc.onicecandidate = (e) => {
        if (!e || !e.candidate) { clearTimeout(timer); try { pc.close(); } catch {} finish(); return; }
        const c = String(e.candidate.candidate || '');
        const m = c.match(/(\d{1,3}(?:\.\d{1,3}){3}|[0-9a-f]{1,4}(?::[0-9a-f]{1,4}){2,7})/i);
        if (m) found.add(m[1]);
      };
      pc.createOffer().then((o) => pc.setLocalDescription(o)).catch(() => { clearTimeout(timer); finish(); });
    } catch (e) {
      finish();
    }
  });
  add('②WebRTC', '可见候选 IP', rtcLeak.length ? rtcLeak.join(', ') : '(无)', rtcLeak.length ? BAD : OK);
  add('②WebRTC', 'RTCPeerConnection 可构造', typeof RTCPeerConnection === 'function',
    typeof RTCPeerConnection === 'function' ? OK : BAD);

  /* ---------------- ③ 指纹灵活且稳定 ---------------- */
  // Canvas：连续三次必须完全一致（不一致 = 被污染，比不伪造更糟）
  const canvasOnce = () => {
    const c = document.createElement('canvas');
    c.width = 240; c.height = 60;
    const ctx = c.getContext('2d');
    ctx.textBaseline = 'top';
    ctx.font = '14px Arial';
    ctx.fillStyle = '#f60';
    ctx.fillRect(100, 1, 62, 20);
    ctx.fillStyle = '#069';
    ctx.fillText('TkSwarm-fp-测试 🎨', 2, 15);
    ctx.fillStyle = 'rgba(102,204,0,0.7)';
    ctx.fillText('TkSwarm-fp-测试 🎨', 4, 17);
    return c.toDataURL();
  };
  const c1 = canvasOnce(); const c2 = canvasOnce(); const c3 = canvasOnce();
  add('③指纹', 'Canvas 三次一致', c1 === c2 && c2 === c3,
    (c1 === c2 && c2 === c3) ? OK : BAD);
  add('③指纹', 'Canvas 哈希', hashStr(c1), INFO);

  // WebGL
  try {
    const gl = document.createElement('canvas').getContext('webgl');
    const dbg = gl && gl.getExtension('WEBGL_debug_renderer_info');
    const vendor = dbg ? gl.getParameter(dbg.UNMASKED_VENDOR_WEBGL) : (gl ? gl.getParameter(gl.VENDOR) : '');
    const renderer = dbg ? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : (gl ? gl.getParameter(gl.RENDERER) : '');
    add('③指纹', 'WebGL vendor', vendor, INFO);
    add('③指纹', 'WebGL renderer', renderer,
      /SwiftShader|llvmpipe|Software/i.test(String(renderer)) ? BAD : OK);
  } catch { add('③指纹', 'WebGL', '不可用', BAD); }

  // Audio：渲染两次必须一致
  const audioOnce = async () => {
    const OAC = window.OfflineAudioContext || window.webkitOfflineAudioContext;
    if (!OAC) return null;
    const ctx = new OAC(1, 44100, 44100);
    const osc = ctx.createOscillator();
    osc.type = 'triangle';
    osc.frequency.value = 10000;
    const comp = ctx.createDynamicsCompressor();
    osc.connect(comp); comp.connect(ctx.destination);
    osc.start(0);
    const buf = await ctx.startRendering();
    const data = buf.getChannelData(0);
    let sum = 0;
    for (let i = 0; i < data.length; i += 1) sum += Math.abs(data[i]);
    return sum;
  };
  try {
    const a1 = await audioOnce(); const a2 = await audioOnce();
    if (a1 == null) add('③指纹', 'Audio', 'OfflineAudioContext 不可用', INFO);
    else {
      add('③指纹', 'Audio 两次一致', a1 === a2, a1 === a2 ? OK : BAD);
      add('③指纹', 'Audio 指纹值', a1.toFixed(6), INFO);
    }
  } catch { add('③指纹', 'Audio', '渲染失败', INFO); }

  // 基础硬件
  add('③指纹', 'hardwareConcurrency', navigator.hardwareConcurrency,
    navigator.hardwareConcurrency >= 2 ? OK : BAD);
  add('③指纹', 'deviceMemory', navigator.deviceMemory ?? '(未提供)', INFO);
  add('③指纹', 'devicePixelRatio', devicePixelRatio, INFO);
  add('③指纹', '屏幕分辨率', `${screen.width}x${screen.height}`, INFO);
  add('③指纹', 'webdriver', navigator.webdriver, navigator.webdriver ? BAD : OK);
  add('③指纹', 'plugins.length', navigator.plugins.length, navigator.plugins.length > 0 ? OK : BAD);
  add('③指纹', 'window.chrome', typeof window.chrome,
    typeof window.chrome === 'object' ? OK : BAD);

  /* ---------------- 输出 ---------------- */
  console.log('%c=== 指纹浏览器验收 ===', 'color:#0a0;font-weight:bold;font-size:15px');
  console.table(rows);
  const fail = rows.filter((r) => r.ok === false);
  if (fail.length) {
    console.warn(`%c✗ ${fail.length} 项未通过`, 'color:#d00;font-weight:bold;font-size:13px');
    fail.forEach((r) => console.warn(`   ${r.group} / ${r.item} = ${r.value}`));
  } else {
    console.log('%c✓ 全部通过', 'color:#0a0;font-weight:bold');
  }
  console.log('%c DNS 泄露请另开 https://browserleaks.com/dns 或 https://ipleak.net 查看：DNS 服务器归属地应与代理一致，不该出现本地 ISP。',
    'color:#a60');

  function hashStr(s) {
    let h = 2166136261;
    for (let i = 0; i < s.length; i += 1) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
    return (h >>> 0).toString(16);
  }
  function haversine(lat1, lon1, lat2, lon2) {
    const R = 6371; const rad = (d) => (d * Math.PI) / 180;
    const dLat = rad(lat2 - lat1); const dLon = rad(lon2 - lon1);
    const a = Math.sin(dLat / 2) ** 2 + Math.cos(rad(lat1)) * Math.cos(rad(lat2)) * Math.sin(dLon / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(a));
  }
})();
