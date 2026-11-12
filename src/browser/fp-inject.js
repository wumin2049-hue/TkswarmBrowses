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
  // 标记必须不可枚举，否则 Object.keys(window) 一眼就能看到
  try { Object.defineProperty(window, '__TKSWARM_FP__', { value: true }); } catch (e) { window.__TKSWARM_FP__ = true; }

  // —— 伪装基础设施：让被覆盖的函数在 toString / name / length 上与原生一致 ——
  const __nativeToString = Function.prototype.toString;
  const __masked = new WeakMap();
  const __seenGP = new WeakSet();
  const __seenRP = new WeakSet();
  const __seenRtc = new WeakSet();
  const __seenFn = new WeakSet();
  const __findDesc = (o, k) => {
    for (let p = o; p; p = Object.getPrototypeOf(p)) {
      const d = Object.getOwnPropertyDescriptor(p, k);
      if (d) return d;
    }
    return null;
  };
  const __maskFn = (fn, orig) => {
    try {
      __masked.set(fn, __nativeToString.call(orig));
      Object.defineProperty(fn, 'name', { value: orig.name, configurable: true });
      Object.defineProperty(fn, 'length', { value: orig.length, configurable: true });
    } catch (e) {}
  };
  // 在任何覆盖发生之前，先记下原始描述符；脚本末尾统一对照伪装
  const __snap = [];
  [
    ['HTMLCanvasElement', 'toDataURL'], ['HTMLCanvasElement', 'toBlob'],
    ['CanvasRenderingContext2D', 'getImageData'],
    ['WebGLRenderingContext', 'getParameter'], ['WebGLRenderingContext', 'readPixels'],
    ['WebGL2RenderingContext', 'getParameter'], ['WebGL2RenderingContext', 'readPixels'],
    ['AudioBuffer', 'getChannelData'], ['AudioBuffer', 'copyFromChannel'],
    ['Navigator', 'platform'], ['Navigator', 'languages'], ['Navigator', 'language'],
    ['Navigator', 'webdriver'], ['Navigator', 'plugins'],
    ['RTCPeerConnection', 'addEventListener'], ['RTCPeerConnection', 'setLocalDescription'],
    ['RTCPeerConnection', 'createOffer'], ['RTCPeerConnection', 'onicecandidate'],
  ].forEach(([cls, key]) => {
    try {
      const C = window[cls];
      if (typeof C !== 'function' || !C.prototype) return;
      const d = __findDesc(C.prototype, key);
      if (d) __snap.push({ o: C.prototype, k: key, d: d });
    } catch (e) {}
  });
  const __toStr = function toString() {
    const m = __masked.get(this);
    return m !== undefined ? m : __nativeToString.call(this);
  };
  __maskFn(__toStr, __nativeToString);
  try {
    Object.defineProperty(Function.prototype, 'toString', { value: __toStr, writable: true, configurable: true });
  } catch (e) {}
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
  //
  // 旧实现有致命缺陷：先 getImageData → 加噪声 → putImageData **写回原画布**。
  // 后果是画布内容被永久且**累积**地修改：第二次调用是在第一次已改的像素上再加一次，
  // 于是同一个 canvas 连续读出两个不同值。
  // 真实设备的 canvas 指纹是**完全稳定**的，因此「同一画布读出不同结果」比不伪造更显眼，
  // 检测脚本只要连读两次就能确定这里被动过手脚。
  //
  // 正确做法：绝不写回原画布。在**离屏副本**上做变换，再从副本导出。
  // 这样稳定性由 (SEED, 像素位置) 决定 —— 同一环境永远一致，不同环境各自不同。
  const cloneWithNoise = (srcCanvas, width, height, salt) => {
    const off = document.createElement('canvas');
    off.width = srcCanvas.width || width;
    off.height = srcCanvas.height || height;
    const offCtx = off.getContext('2d');
    if (!offCtx) return null;
    offCtx.drawImage(srcCanvas, 0, 0);
    const w = Math.min(off.width, width);
    const h = Math.min(off.height, height);
    if (w > 0 && h > 0) {
      const img = offCtx.getImageData(0, 0, w, h);
      for (let i = 0; i < img.data.length; i += 4) {
        // 只动 R 通道且幅度极小：跨浏览器/跨设备本来就有的正常差异量级
        img.data[i] = (img.data[i] + noiseByte(i + salt)) & 255;
      }
      offCtx.putImageData(img, 0, 0);
    }
    return off;
  };

  try {
    const toDataURL = HTMLCanvasElement.prototype.toDataURL;
    HTMLCanvasElement.prototype.toDataURL = function(...args) {
      try {
        if (this.width && this.height) {
          const off = cloneWithNoise(this, 16, 16, 17);
          if (off) return toDataURL.apply(off, args);
        }
      } catch (e) {}
      return toDataURL.apply(this, args);
    };
    const toBlob = HTMLCanvasElement.prototype.toBlob;
    if (toBlob) {
      HTMLCanvasElement.prototype.toBlob = function(cb, ...rest) {
        try {
          if (this.width && this.height) {
            const off = cloneWithNoise(this, 16, 16, 99);
            if (off) return toBlob.call(off, cb, ...rest);
          }
        } catch (e) {}
        return toBlob.call(this, cb, ...rest);
      };
    }
    // getImageData 返回的是副本，直接改副本不会污染画布；这里保持稳定
    const getImageData = CanvasRenderingContext2D.prototype.getImageData;
    CanvasRenderingContext2D.prototype.getImageData = function(...args) {
      const img = getImageData.apply(this, args);
      try {
        if (img && img.data && img.data.length >= 4) {
          const n = Math.min(img.data.length, 256 * 4);
          for (let i = 0; i < n; i += 4) {
            img.data[i] = (img.data[i] + noiseByte(i + 511)) & 255;
          }
        }
      } catch (e) {}
      return img;
    };
  } catch (e) {}

  // —— WebGL ——
  try {
    const patchGetParameter = (proto) => {
      if (!proto || __seenGP.has(proto)) return;
      const getParameter = proto.getParameter;
      proto.getParameter = function(param) {
        const UNMASKED_VENDOR = 0x9245;
        const UNMASKED_RENDERER = 0x9246;
        if (param === UNMASKED_VENDOR) return ${JSON.stringify(vendor)};
        if (param === UNMASKED_RENDERER) return ${JSON.stringify(renderer)};
        return getParameter.call(this, param);
      };
      __seenGP.add(proto);
    };
    if (typeof WebGLRenderingContext !== 'undefined') patchGetParameter(WebGLRenderingContext.prototype);
    if (typeof WebGL2RenderingContext !== 'undefined') patchGetParameter(WebGL2RenderingContext.prototype);

    const patchReadPixels = (proto) => {
      if (!proto || __seenRP.has(proto)) return;
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
      __seenRP.add(proto);
    };
    if (typeof WebGLRenderingContext !== 'undefined') patchReadPixels(WebGLRenderingContext.prototype);
    if (typeof WebGL2RenderingContext !== 'undefined') patchReadPixels(WebGL2RenderingContext.prototype);
  } catch (e) {}

  // —— AudioContext 指纹 ——
  //
  // 真实检测做法：OfflineAudioContext 渲染一段振荡器 → 读 outputBuffer 的浮点样本 →
  // 做加权累加得到一个小数（AudioContext fingerprint）。
  // 旧实现只改 getChannelData 返回数组的前 32 个样本，且 length>100 才动手，
  // 而指纹算法通常看的是**整个** buffer 的累积和，改 32 个样本几乎不影响结果；
  // 同时每次 getChannelData 都在**同一份底层数据**上重复叠加，属于累积污染。
  //
  // 做法：处理一次就标记（WeakSet），保证同一 buffer 恒等；噪声幅度按样本索引确定性生成，
  // 分布在整段 buffer 上，足以让累加值产生稳定但极小的偏移。
  try {
    const processed = new WeakSet();
    const getChannelData = AudioBuffer.prototype.getChannelData;
    AudioBuffer.prototype.getChannelData = function(channel) {
      const data = getChannelData.call(this, channel);
      try {
        if (data && data.length && !processed.has(data)) {
          processed.add(data);
          const n = data.length;
          // 均匀撒在整段 buffer 上，步长随长度自适应，避免大 buffer 卡顿
          const step = n > 200000 ? Math.floor(n / 200000) * 997 + 1 : 997;
          for (let i = 0; i < n; i += step) {
            // ±1e-7 量级：远小于可听阈值，但足以改变累加结果
            data[i] = data[i] + (rnd(i + 300) - 0.5) * 2e-7;
          }
          const last = n - 1;
          if (last > 0) data[last] = data[last] + (rnd(last + 301) - 0.5) * 2e-7;
        }
      } catch (e) {}
      return data;
    };
    // copyFromChannel 是另一条常见读取路径，同样不能漏
    const copyFromChannel = AudioBuffer.prototype.copyFromChannel;
    if (copyFromChannel) {
      AudioBuffer.prototype.copyFromChannel = function(dest, channel, startInChannel) {
        const r = copyFromChannel.call(this, dest, channel, startInChannel);
        try {
          if (dest && dest.length) {
            const step = dest.length > 2000 ? Math.floor(dest.length / 2000) + 1 : 1;
            for (let i = 0; i < dest.length; i += step) {
              dest[i] = dest[i] + (rnd(i + 302) - 0.5) * 2e-7;
            }
          }
        } catch (e) {}
        return r;
      };
    }
  } catch (e) {}

  // —— Navigator ——
  try {
    const def = (obj, key, value) => {
      try {
        Object.defineProperty(obj, key, { get: () => value, configurable: true });
      } catch (e) {}
    };
    // 注意：hardwareConcurrency / deviceMemory 在真实 Chrome 里是 non-configurable，
    // 这里 Object.defineProperty 必然抛 TypeError（被上面 def 静默吞掉），覆盖无效。
    // 这两个值改由主进程 CDP 的 Emulation.setHardwareConcurrencyOverride 处理，
    // 不要在这里再尝试，否则会给人「已覆盖」的假象、实际泄露本机值。
    // 浏览器标识类属性（platform/languages/language 是 configurable 的，可在此覆盖）
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
      if (!orig || __seenFn.has(orig)) return;
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
      __seenFn.add(proto[method]);
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
  //
  // 目标：既要**不泄露**真实内网/公网 IP，又要**不暴露**「这里被禁用过」。
  //
  // 旧实现直接把 RTCPeerConnection 换成抛异常的构造函数，问题很大：
  //   1. 真实 Chrome 一定存在 RTCPeerConnection，构造即抛 NotAllowedError 是极强的特征；
  //   2. 部分站点的音视频/直播功能会直接崩，反而不自然；
  //   3. 检测脚本 new RTCPeerConnection() 一 try 就能判定环境被改造。
  //
  // 现在保留原生构造器，只在**两个出口**上做净化：
  //   - onicecandidate / addEventListener('icecandidate')：丢弃暴露真实 IP 的候选
  //   - SDP 文本：删除 a=candidate 行中的 IP 字段，并对 host / srflx 候选降级
  // 这样 API 语义正常（对象能建、能 offer/answer），但拿不到任何本地地址。
  // 配合启动参数 --force-webrtc-ip-handling-policy=disable_non_proxied_udp
  // （禁止非代理 UDP，从网络层阻断），形成双重保险。
  try {
    const RTC = window.RTCPeerConnection;
    if (typeof RTC === 'function') {
      // 内网地址段 + mDNS .local，命中即视为泄露候选
      const isLeakyCandidate = (candStr) => {
        const s = String(candStr || '');
        if (!s) return true;
        // candidate:... typ host / srflx 且带 IP
        if (/\\btyp\\s+host\\b/.test(s) || /\\btyp\\s+srflx\\b/.test(s)) return true;
        if (/\\b(10|127)\\.\\d{1,3}\\.\\d{1,3}\\.\\d{1,3}\\b/.test(s)) return true;
        if (/\\b192\\.168\\.\\d{1,3}\\.\\d{1,3}\\b/.test(s)) return true;
        if (/\\b172\\.(1[6-9]|2\\d|3[01])\\.\\d{1,3}\\.\\d{1,3}\\b/.test(s)) return true;
        if (/\\.local\\b/.test(s)) return true;
        if (/\\b[0-9a-f]{1,4}(:[0-9a-f]{1,4}){2,7}\\b/i.test(s) && /candidate/i.test(s)) return true; // IPv6
        return false;
      };
      const scrubSdp = (sdp) => String(sdp || '')
        .split('\\r\\n')
        .filter((line) => !(line.indexOf('a=candidate:') === 0 && isLeakyCandidate(line)))
        .join('\\r\\n');

      const scrubCandidateEvent = (ev) => {
        try {
          if (!ev) return ev;
          const c = ev.candidate;
          if (!c) return ev; // null candidate 表示收集结束，必须放行
          if (isLeakyCandidate(c.candidate)) {
            // 用空对象屏蔽细节，但不能返回 null（会被当成收集结束）
            return Object.defineProperty(
              Object.create(Object.getPrototypeOf(ev) || Object.prototype),
              'candidate',
              { value: null, configurable: true },
            );
          }
        } catch (e) {}
        return ev;
      };

      const patchEvents = (proto) => {
        if (!proto || __seenRtc.has(proto)) return;
        const addEventListener = proto.addEventListener;
        if (typeof addEventListener === 'function') {
          proto.addEventListener = function(type, listener, ...rest) {
            if (type === 'icecandidate' && typeof listener === 'function') {
              const wrapped = function(ev) {
                const clean = scrubCandidateEvent(ev);
                if (clean && clean.candidate === null && ev && ev.candidate) return undefined;
                return listener.call(this, clean);
              };
              return addEventListener.call(this, type, wrapped, ...rest);
            }
            return addEventListener.call(this, type, listener, ...rest);
          };
        }
        const setLocalDescription = proto.setLocalDescription;
        if (typeof setLocalDescription === 'function') {
          proto.setLocalDescription = function(desc) {
            try {
              if (desc && typeof desc === 'object' && typeof desc.sdp === 'string') {
                desc = { type: desc.type, sdp: scrubSdp(desc.sdp) };
              }
            } catch (e) {}
            return setLocalDescription.call(this, desc);
          };
        }
        const createOffer = proto.createOffer;
        if (typeof createOffer === 'function') {
          proto.createOffer = function(...args) {
            return createOffer.apply(this, args).then((desc) => {
              try {
                if (desc && typeof desc.sdp === 'string') {
                  return { type: desc.type, sdp: scrubSdp(desc.sdp) };
                }
              } catch (e) {}
              return desc;
            });
          };
        }
        __seenRtc.add(proto);
      };
      patchEvents(RTC.prototype);

      // onicecandidate 赋值路径（比 addEventListener 更常用）
      try {
        const desc = Object.getOwnPropertyDescriptor(RTC.prototype, 'onicecandidate');
        if (desc && desc.set) {
          Object.defineProperty(RTC.prototype, 'onicecandidate', {
            configurable: true,
            get: desc.get,
            set(fn) {
              if (typeof fn !== 'function') return desc.set.call(this, fn);
              const self = this;
              return desc.set.call(this, function(ev) {
                const clean = scrubCandidateEvent(ev);
                if (clean && clean.candidate === null && ev && ev.candidate) return undefined;
                return fn.call(self, clean);
              });
            },
          });
        }
      } catch (e) {}

    }
  } catch (e) {}
  // —— 统一伪装：被覆盖的函数 / getter 对外表现为原生 ——
  try {
    __snap.forEach(({ o, k, d }) => {
      try {
        const cur = Object.getOwnPropertyDescriptor(o, k);
        if (!cur) return;
        if (typeof cur.value === 'function' && typeof d.value === 'function' && cur.value !== d.value) __maskFn(cur.value, d.value);
        if (typeof cur.get === 'function' && typeof d.get === 'function' && cur.get !== d.get) __maskFn(cur.get, d.get);
      } catch (e) {}
    });
  } catch (e) {}
})();`;
}

module.exports = { buildInjectScript, hashSeed };
