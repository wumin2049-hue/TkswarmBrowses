/**
 * 生成注入到每个新文档的 Canvas / WebGL / Audio / 硬件指纹脚本。
 * seed 来自环境 id，保证同一环境稳定、不同环境不同。
 */
function hashSeed(str) {
  let h = 2166136261;
  const s = String(str || 'tkswarm');
  for (let i = 0; i < s.length; i += 1) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function buildInjectScript(seedKey, fp = {}) {
  const seed = hashSeed(seedKey);
  const vendor = String(fp.webglVendor || 'Google Inc. (NVIDIA)');
  const renderer = String(fp.webglRenderer || 'ANGLE (NVIDIA, NVIDIA GeForce GTX 1660 Direct3D11 vs_5_0 ps_5_0)');
  const hardwareConcurrency = Number(fp.hardwareConcurrency || 8);
  const deviceMemory = Number(fp.deviceMemory || 8);
  const isMac = String(fp.os || '') === 'MacIntel';
  const platform = isMac ? 'MacIntel' : String(fp.os || 'Win32');
  const languages = String(fp.languages || 'en-US').split(',').map((x) => x.trim()).filter(Boolean);
  const devicePixelRatio = Number(fp.devicePixelRatio || fp.dpr || 1) || 1;
  const clientRectNoise = (seed % 7) - 3; // -3..3 px 级稳定偏移
  // SPA 每帧狂调 getBoundingClientRect，默认关闭以免卡顿；TKSWARM_FP_CLIENT_RECTS=1 可开
  const enableClientRects = fp.clientRects === true
    || String(process.env.TKSWARM_FP_CLIENT_RECTS || '').trim() === '1';
  const fontList = Array.isArray(fp.fonts) && fp.fonts.length
    ? fp.fonts
    : ['Arial', 'Arial Black', 'Calibri', 'Cambria', 'Comic Sans MS', 'Courier New',
      'Georgia', 'Impact', 'Segoe UI', 'Tahoma', 'Times New Roman', 'Trebuchet MS', 'Verdana'];

  return `(() => {
  if (window.__TKSWARM_FP__) return;
  window.__TKSWARM_FP__ = true;
  const SEED = ${seed};
  function rnd(n) {
    let x = (SEED ^ (n * 2654435761)) >>> 0;
    x ^= x << 13; x ^= x >>> 17; x ^= x << 5;
    return (x >>> 0) / 4294967296;
  }
  function noiseByte(i) {
    return Math.floor(rnd(i + 17) * 4) - 1; // -1..2
  }

  // —— Canvas 2D ——
  try {
    const toDataURL = HTMLCanvasElement.prototype.toDataURL;
    HTMLCanvasElement.prototype.toDataURL = function(...args) {
      try {
        const ctx = this.getContext('2d');
        if (ctx && this.width && this.height) {
          const w = Math.min(this.width, 16);
          const h = Math.min(this.height, 16);
          const img = ctx.getImageData(0, 0, w, h);
          for (let i = 0; i < img.data.length; i += 4) {
            img.data[i] = (img.data[i] + noiseByte(i)) & 255;
          }
          ctx.putImageData(img, 0, 0);
        }
      } catch (e) {}
      return toDataURL.apply(this, args);
    };
    const toBlob = HTMLCanvasElement.prototype.toBlob;
    if (toBlob) {
      HTMLCanvasElement.prototype.toBlob = function(cb, ...rest) {
        try {
          const ctx = this.getContext('2d');
          if (ctx && this.width && this.height) {
            const img = ctx.getImageData(0, 0, Math.min(this.width, 8), Math.min(this.height, 8));
            for (let i = 0; i < img.data.length; i += 4) {
              img.data[i] = (img.data[i] + noiseByte(i + 99)) & 255;
            }
            ctx.putImageData(img, 0, 0);
          }
        } catch (e) {}
        return toBlob.call(this, cb, ...rest);
      };
    }
  } catch (e) {}

  // —— WebGL ——
  try {
    const patchGetParameter = (proto) => {
      if (!proto || proto.__tkPatched) return;
      const getParameter = proto.getParameter;
      proto.getParameter = function(param) {
        const UNMASKED_VENDOR = 0x9245;
        const UNMASKED_RENDERER = 0x9246;
        if (param === UNMASKED_VENDOR) return ${JSON.stringify(vendor)};
        if (param === UNMASKED_RENDERER) return ${JSON.stringify(renderer)};
        return getParameter.call(this, param);
      };
      proto.__tkPatched = true;
    };
    if (typeof WebGLRenderingContext !== 'undefined') patchGetParameter(WebGLRenderingContext.prototype);
    if (typeof WebGL2RenderingContext !== 'undefined') patchGetParameter(WebGL2RenderingContext.prototype);

    const patchReadPixels = (proto) => {
      if (!proto || proto.__tkReadPatched) return;
      const readPixels = proto.readPixels;
      proto.readPixels = function(...args) {
        readPixels.apply(this, args);
        try {
          const buf = args[6];
          if (buf && buf.length) {
            for (let i = 0; i < Math.min(buf.length, 64); i += 4) {
              buf[i] = (buf[i] + noiseByte(i + 200)) & 255;
            }
          }
        } catch (e) {}
      };
      proto.__tkReadPatched = true;
    };
    if (typeof WebGLRenderingContext !== 'undefined') patchReadPixels(WebGLRenderingContext.prototype);
    if (typeof WebGL2RenderingContext !== 'undefined') patchReadPixels(WebGL2RenderingContext.prototype);
  } catch (e) {}

  // —— AudioContext ——
  try {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (AC) {
      const origCreate = AC.prototype.createAnalyser || AC.prototype.createOscillator;
      const getChannelData = AudioBuffer.prototype.getChannelData;
      AudioBuffer.prototype.getChannelData = function(channel) {
        const data = getChannelData.call(this, channel);
        try {
          if (data && data.length > 100) {
            for (let i = 0; i < 32; i += 1) {
              data[i] = data[i] + (rnd(i + 300) - 0.5) * 1e-7;
            }
          }
        } catch (e) {}
        return data;
      };
      void origCreate;
    }
  } catch (e) {}

  // —— Navigator ——
  try {
    const def = (obj, key, value) => {
      try {
        Object.defineProperty(obj, key, { get: () => value, configurable: true });
      } catch (e) {}
    };
    // 浏览器标识类属性一律交给 CDP 的 UA 覆盖（含 Client Hints 元数据）处理，页面内不再重写，
    // 避免与 HTTP 请求头不一致导致 TikTok 验证码 SDK 加载失败（弹框空白）。
    def(Navigator.prototype, 'hardwareConcurrency', ${hardwareConcurrency});
    def(Navigator.prototype, 'deviceMemory', ${deviceMemory});
    def(Navigator.prototype, 'platform', ${JSON.stringify(platform)});
    def(Navigator.prototype, 'languages', Object.freeze(${JSON.stringify(languages)}));
    def(Navigator.prototype, 'language', ${JSON.stringify(languages[0] || 'en-US')});
  } catch (e) {}

  // —— webdriver 兜底 ——
  // 正常情况已由启动参数 --disable-blink-features=AutomationControlled 从根上关掉；
  // 这里再兜一层，防止某些内核/参数组合漏网。
  try {
    if (navigator.webdriver !== false) {
      Object.defineProperty(Navigator.prototype, 'webdriver', {
        get: () => false,
        configurable: true,
      });
    }
  } catch (e) {}

  // —— window.chrome 完整性 ——
  // Electron 内核下 window.chrome 常是空对象或缺失子项，真实 Chrome 一定有这几个成员。
  // 只补缺失项，不动已有实现，避免破坏正常功能。
  try {
    if (!window.chrome || typeof window.chrome !== 'object') window.chrome = {};
    const c = window.chrome;
    if (!c.runtime) {
      c.runtime = {
        connect: function () {
          throw new Error('Could not establish connection. Receiving end does not exist.');
        },
        sendMessage: function () {
          throw new Error('Could not establish connection. Receiving end does not exist.');
        },
        onMessage: {
          addListener: function () {},
          removeListener: function () {},
          hasListener: function () { return false; },
        },
      };
    }
    if (!c.loadTimes) {
      c.loadTimes = function () {
        const t = performance.timing || {};
        const s = (t.navigationStart || Date.now()) / 1000;
        return {
          requestTime: s, startLoadTime: s, commitLoadTime: s + 0.05,
          finishDocumentLoadTime: s + 0.2, finishLoadTime: s + 0.3,
          firstPaintTime: s + 0.15, firstPaintAfterLoadTime: 0,
          navigationType: 'Other', wasFetchedViaSpdy: true, wasNpnNegotiated: true,
          npnNegotiatedProtocol: 'h2', wasAlternateProtocolAvailable: false,
          connectionInfo: 'h2',
        };
      };
    }
    if (!c.csi) {
      c.csi = function () {
        return { onloadT: Date.now(), pageT: 1000, startE: 1, tran: 15 };
      };
    }
    if (!c.app) {
      c.app = {
        isInstalled: false,
        InstallState: { DISABLED: 'disabled', INSTALLED: 'installed', NOT_INSTALLED: 'not_installed' },
        RunningState: { CANNOT_RUN: 'cannot_run', READY_TO_RUN: 'ready_to_run', RUNNING: 'running' },
        getDetails: function () { return null; },
        getIsInstalled: function () { return false; },
        installState: function () { return 'not_installed'; },
        runningState: function () { return 'cannot_run'; },
      };
    }
  } catch (e) {}

  // —— plugins / mimeTypes ——
  // 空数组是自动化环境最典型的特征之一，真实 Chrome 至少有 PDF 相关项。
  try {
    if (!navigator.plugins || navigator.plugins.length === 0) {
      const names = [
        { name: 'PDF Viewer', filename: 'internal-pdf-viewer', description: 'Portable Document Format' },
        { name: 'Chrome PDF Viewer', filename: 'internal-pdf-viewer', description: 'Portable Document Format' },
        { name: 'Chromium PDF Viewer', filename: 'internal-pdf-viewer', description: 'Portable Document Format' },
        { name: 'Microsoft Edge PDF Viewer', filename: 'internal-pdf-viewer', description: 'Portable Document Format' },
        { name: 'WebKit built-in PDF', filename: 'internal-pdf-viewer', description: 'Portable Document Format' },
      ];
      const arr = Object.create(PluginArray.prototype);
      names.forEach((meta, i) => {
        const plugin = Object.create(Plugin.prototype);
        const pdfMime = {
          type: 'application/pdf',
          suffixes: 'pdf',
          description: meta.description,
          enabledPlugin: plugin,
        };
        Object.defineProperty(plugin, 'name', { get: () => meta.name, configurable: true });
        Object.defineProperty(plugin, 'filename', { get: () => meta.filename, configurable: true });
        Object.defineProperty(plugin, 'description', { get: () => meta.description, configurable: true });
        Object.defineProperty(plugin, 'length', { get: () => 1, configurable: true });
        Object.defineProperty(plugin, 0, { get: () => pdfMime, configurable: true });
        Object.defineProperty(arr, i, { get: () => plugin, configurable: true });
        Object.defineProperty(arr, meta.name, { get: () => plugin, configurable: true });
      });
      Object.defineProperty(arr, 'length', { get: () => names.length, configurable: true });
      Object.defineProperty(arr, 'item', {
        value: function (i) { return this[i] || null; }, configurable: true,
      });
      Object.defineProperty(arr, 'namedItem', {
        value: function (n) { return this[n] || null; }, configurable: true,
      });
      arr[Symbol.iterator] = function* () {
        for (let i = 0; i < names.length; i += 1) yield arr[i];
      };
      Object.defineProperty(Navigator.prototype, 'plugins', { get: () => arr, configurable: true });
    }
  } catch (e) {}

  // —— DPI ——
  try {
    Object.defineProperty(window, 'devicePixelRatio', {
      get: () => ${devicePixelRatio},
      configurable: true,
    });
  } catch (e) {}

  // —— ClientRects（可选；默认关闭，避免 SPA 布局卡顿） ——
  ${enableClientRects ? `try {
    const noise = ${clientRectNoise};
    const patchRect = (proto, method) => {
      const orig = proto[method];
      if (!orig || orig.__tkPatched) return;
      proto[method] = function(...args) {
        const r = orig.apply(this, args);
        if (!r) return r;
        try {
          const shift = noise * 0.001;
          if (typeof DOMRect === 'function' && r instanceof DOMRect) {
            return new DOMRect(r.x + shift, r.y + shift, r.width, r.height);
          }
          return r;
        } catch (e) { return r; }
      };
      proto[method].__tkPatched = true;
    };
    patchRect(Element.prototype, 'getBoundingClientRect');
    if (typeof Range !== 'undefined') patchRect(Range.prototype, 'getBoundingClientRect');
  } catch (e) {}` : ''}

  // —— Fonts 探测干扰（document.fonts.check） ——
  try {
    const allow = new Set(${JSON.stringify(fontList)}.map((f) => String(f).toLowerCase()));
    if (document.fonts && document.fonts.check) {
      const origCheck = document.fonts.check.bind(document.fonts);
      document.fonts.check = function(font, text) {
        try {
          const m = String(font || '').match(/([A-Za-z][A-Za-z0-9 ]{0,40})/);
          const name = (m && m[1] ? m[1] : '').trim().toLowerCase();
          if (name && allow.size && !allow.has(name)) return false;
        } catch (e) {}
        return origCheck(font, text);
      };
    }
  } catch (e) {}

  // —— WebRTC 防泄露 ——
  try {
    const Blocked = function() {
      throw new DOMException('WebRTC disabled by 第一页自研浏览器', 'NotAllowedError');
    };
    Blocked.prototype = {};
    if (typeof window.RTCPeerConnection !== 'undefined') {
      window.RTCPeerConnection = Blocked;
    }
    if (typeof window.webkitRTCPeerConnection !== 'undefined') {
      window.webkitRTCPeerConnection = Blocked;
    }
    if (typeof navigator.mediaDevices !== 'undefined') {
      try {
        navigator.mediaDevices.getUserMedia = function() {
          return Promise.reject(new DOMException('Permission denied', 'NotAllowedError'));
        };
      } catch (e) {}
    }
  } catch (e) {}
})();`;
}

module.exports = { buildInjectScript, hashSeed };
