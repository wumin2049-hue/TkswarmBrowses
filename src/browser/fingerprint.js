/** 支持的 Chrome 内核档位（UA / Client Hints；实际二进制仍用本机 Chrome） */
const CORE_VERSIONS = ['120', '124', '128', '131', '136', '140', '144', '148', '150', '152', '154', '156', '157', '158', '159', '160'];

/**
 * 打开环境时探测到的真实内核版本（如本机 Chrome 157.0.x）。
 * 见 syncRealCoreVersion()：UA 必须与内核真实版本一致，否则页面做特性探测
 * 就能发现「UA 说 131、身上有 157 的特性」，判定为伪造环境。
 */
let REAL_CORE_VERSION = '';
// 单独记「是否已尝试过」，否则探测失败返回 '' 时每次调用都会重新扫盘
let REAL_CORE_PROBED = false;
// 真实内核是否为 Electron 内嵌 Chromium，及其完整版本号
let REAL_CORE_IS_EMBEDDED = false;
let REAL_CORE_FULL_VERSION = '';

/**
 * 用本机 Chrome 的真实主版本同步指纹版本。
 * - 指纹里显式指定了 coreVersion 时：只有当它与真实版本相差 >= 5 个大版本才强制纠正
 *   （尊重用户刻意选择的档位，但避免 131 vs 157 这种离谱错配）
 * - 未指定时：直接采用真实版本
 * @returns {string} 真实主版本号，探测失败返回 ''
 */
function syncRealCoreVersion() {
  if (REAL_CORE_PROBED) return REAL_CORE_VERSION;
  REAL_CORE_PROBED = true;
  // Electron 会话：窗口真正运行的内核是 Electron 内嵌的 Chromium（如 Electron 33 = 130），
  // 与本机装的 Chrome 版本无关。UA 必须以它为准，否则就是「UA 说 157、内核是 130」。
  try {
    const full = String(process.versions?.electron ? (process.versions.chrome || '') : '').trim();
    const major = (full.match(/^(\d{2,3})\./) || [])[1];
    if (major) {
      REAL_CORE_VERSION = major;
      REAL_CORE_FULL_VERSION = full;
      REAL_CORE_IS_EMBEDDED = true;
      return REAL_CORE_VERSION;
    }
  } catch { /* 落到下面的本机 Chrome 探测 */ }
  try {
    const { detectChromeMajorVersion } = require('./chrome-path');
    REAL_CORE_VERSION = String(detectChromeMajorVersion() || '').trim();
  } catch {
    REAL_CORE_VERSION = '';
  }
  return REAL_CORE_VERSION;
}

/** 真实内核完整版本号（如 130.0.6723.191）；仅 Electron 内嵌内核可知，其余返回 '' */
function realCoreFullVersion(major) {
  syncRealCoreVersion();
  if (REAL_CORE_IS_EMBEDDED && REAL_CORE_FULL_VERSION && String(major) === REAL_CORE_VERSION) {
    return REAL_CORE_FULL_VERSION;
  }
  return `${major}.0.0.0`;
}

/** 与真实内核版本对齐后的 coreVersion */
function alignedCoreVersion(rawWanted) {
  const real = syncRealCoreVersion();
  const wanted = String(rawWanted || '').match(/^(\d{2,3})/)?.[1] || '';
  if (!real) return wanted || DEFAULT_FP.coreVersion;
  // Electron 内嵌内核是唯一真相：无论环境里存的是 148 / 157 / 131，一律以真实内核为准
  if (REAL_CORE_IS_EMBEDDED) return real;
  if (!wanted) return real;
  // 相差过大（>=5 个大版本）时以内核真实版本为准
  if (Math.abs(Number(real) - Number(wanted)) >= 5) return real;
  return wanted;
}

const DEFAULT_FP = {
  coreVersion: '131',
  coreProduct: 'chrome',
  ostype: 'PC',
  os: process.platform === 'darwin' ? 'MacIntel' : 'Win32',
  isIpCreateTimeZone: true,
  isIpCreatePosition: true,
  isIpCreateLanguage: true,
  languages: 'en-US',
  resolutionType: '0',
  resolution: '1920 x 1080',
  webRTC: '0',
  hardwareConcurrency: 8,
  deviceMemory: 8,
  devicePixelRatio: 1,
  webglVendor: 'Google Inc. (NVIDIA)',
  webglRenderer: 'ANGLE (NVIDIA, NVIDIA GeForce GTX 1660 Direct3D11 vs_5_0 ps_5_0)',
};

/**
 * Windows 11 的 sec-ch-ua-platform-version 是 "13.0.0"+（Win10 是 "10.0.0"，Win11 各版为 13/14/15/16）。
 * 报错会与 navigator.userAgentData 的实际值矛盾，这里按真实系统版本取。
 */
function detectPlatformVersion() {
  if (process.platform === 'darwin') return '14.5.0';
  if (process.platform !== 'win32') return '6.5.0';
  try {
    const os = require('node:os');
    const rel = String(os.release() || ''); // 如 "10.0.22631"
    const parts = rel.split('.').map(Number);
    const build = parts[2] || 0;
    if ((parts[0] || 0) === 10 && build >= 22000) {
      // Windows 11 映射：22000 → 13.0.0，22631/26100 → 15.0.0 左右
      if (build >= 26100) return '16.0.0';
      if (build >= 22631) return '15.0.0';
      if (build >= 22621) return '14.0.0';
      return '13.0.0';
    }
    return '10.0.0';
  } catch {
    return '10.0.0';
  }
}

function normalizeCoreVersion(raw) {
  const v = String(raw || '').trim();
  const major = (v.match(/^(\d{2,3})/) || [])[1];
  // 真实内核版本不在固定档位里（如 130）也必须原样保留，否则会被吸附成 131 而与内核不符
  if (major && major === syncRealCoreVersion()) return major;
  if (major && CORE_VERSIONS.includes(major)) return major;
  // 允许接近档位：取最近的受支持版本
  if (major) {
    const n = Number(major);
    let best = CORE_VERSIONS[0];
    let dist = Infinity;
    for (const c of CORE_VERSIONS) {
      const d = Math.abs(Number(c) - n);
      if (d < dist) { dist = d; best = c; }
    }
    return best;
  }
  const real = syncRealCoreVersion();
  return real || DEFAULT_FP.coreVersion;
}

function mergeFingerprint(input = {}) {
  const fp = { ...DEFAULT_FP, ...(input || {}) };
  if (input?.browserFingerPrint) {
    Object.assign(fp, input.browserFingerPrint);
  }
  // 关键：UA 声称的版本必须与内核真实版本一致，否则一眼假
  fp.coreVersion = alignedCoreVersion(normalizeCoreVersion(fp.coreVersion));
  return fp;
}

function parseResolution(res) {
  const m = String(res || '1920 x 1080').match(/(\d+)\s*[x×]\s*(\d+)/i);
  return { width: Number(m?.[1] || 1920), height: Number(m?.[2] || 1080) };
}

function buildUserAgent(fp) {
  const ver = normalizeCoreVersion(fp.coreVersion);
  if (fp.os === 'MacIntel') {
    return `Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${ver}.0.0.0 Safari/537.36`;
  }
  return `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${ver}.0.0.0 Safari/537.36`;
}

/** Sec-CH-UA 近似串（供后续 CDP Network 覆盖用） */
function buildSecChUa(fp = {}) {
  const ver = normalizeCoreVersion(fp.coreVersion);
  return `"Not-A.Brand";v="99", "Google Chrome";v="${ver}", "Chromium";v="${ver}"`;
}

/* ------------------------------------------------------------------ *
 * 硬件指纹池
 *
 * 问题：过去 DEFAULT_FP 里写死 vendor='Google Inc. (NVIDIA)' +
 * renderer='...GTX 1660...'，**所有环境拿到完全相同的 WebGL 指纹**。
 * 平台侧只要把 WebGL renderer 当设备 ID 用，一眼就能把这些"不同人"
 * 归并到同一台机器上，等于没做隔离。
 *
 * 做法：按环境 ID 哈希，从真实存在的 GPU 组合里确定性地选一个。
 * - 同一环境每次打开结果一致（不能每次刷新都变，那是另一种异常）
 * - 不同环境分布到不同组合（避免固定指纹）
 * - vendor / renderer / 核数 / 内存 必须彼此搭配合理，不能出现
 *   「Intel 核显配 32GB 显存」这种一眼假的组合
 * ------------------------------------------------------------------ */
const GPU_POOL = [
  { vendor: 'Google Inc. (Intel)', renderer: 'ANGLE (Intel, Intel(R) UHD Graphics 630 Direct3D11 vs_5_0 ps_5_0, D3D11)', cores: 8, mem: 8, dpr: 1 },
  { vendor: 'Google Inc. (Intel)', renderer: 'ANGLE (Intel, Intel(R) UHD Graphics 620 Direct3D11 vs_5_0 ps_5_0, D3D11)', cores: 4, mem: 8, dpr: 1 },
  { vendor: 'Google Inc. (Intel)', renderer: 'ANGLE (Intel, Intel(R) Iris(R) Xe Graphics Direct3D11 vs_5_0 ps_5_0, D3D11)', cores: 8, mem: 16, dpr: 1.25 },
  { vendor: 'Google Inc. (NVIDIA)', renderer: 'ANGLE (NVIDIA, NVIDIA GeForce GTX 1660 Direct3D11 vs_5_0 ps_5_0, D3D11)', cores: 8, mem: 8, dpr: 1 },
  { vendor: 'Google Inc. (NVIDIA)', renderer: 'ANGLE (NVIDIA, NVIDIA GeForce GTX 1650 Direct3D11 vs_5_0 ps_5_0, D3D11)', cores: 6, mem: 8, dpr: 1 },
  { vendor: 'Google Inc. (NVIDIA)', renderer: 'ANGLE (NVIDIA, NVIDIA GeForce RTX 2060 Direct3D11 vs_5_0 ps_5_0, D3D11)', cores: 12, mem: 16, dpr: 1 },
  { vendor: 'Google Inc. (NVIDIA)', renderer: 'ANGLE (NVIDIA, NVIDIA GeForce RTX 3060 Direct3D11 vs_5_0 ps_5_0, D3D11)', cores: 12, mem: 16, dpr: 1 },
  { vendor: 'Google Inc. (NVIDIA)', renderer: 'ANGLE (NVIDIA, NVIDIA GeForce RTX 4060 Direct3D11 vs_5_0 ps_5_0, D3D11)', cores: 16, mem: 16, dpr: 1 },
  { vendor: 'Google Inc. (AMD)', renderer: 'ANGLE (AMD, AMD Radeon RX 580 Direct3D11 vs_5_0 ps_5_0, D3D11)', cores: 8, mem: 8, dpr: 1 },
  { vendor: 'Google Inc. (AMD)', renderer: 'ANGLE (AMD, AMD Radeon RX 6600 Direct3D11 vs_5_0 ps_5_0, D3D11)', cores: 12, mem: 16, dpr: 1 },
  { vendor: 'Google Inc. (AMD)', renderer: 'ANGLE (AMD, AMD Radeon(TM) Graphics Direct3D11 vs_5_0 ps_5_0, D3D11)', cores: 8, mem: 8, dpr: 1.25 },
  { vendor: 'Google Inc. (Intel)', renderer: 'ANGLE (Intel, Intel(R) HD Graphics 520 Direct3D11 vs_5_0 ps_5_0, D3D11)', cores: 4, mem: 4, dpr: 1 },
];

/** 与 GPU 池解耦的分辨率候选（避免所有人都是 1920x1080） */
const RESOLUTION_POOL = ['1920 x 1080', '1920 x 1080', '1920 x 1080', '2560 x 1440', '1600 x 900', '1536 x 864', '1366 x 768'];

function hashSeedKey(key) {
  let h = 2166136261;
  const s = String(key || 'tkswarm');
  for (let i = 0; i < s.length; i += 1) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/**
 * 按环境 ID 确定性地分配硬件指纹。
 * 只填「用户没有显式配置」的项，显式配置优先。
 *
 * @param {object} fp mergeFingerprint 的结果（会被就地修改）
 * @param {string} seedKey 环境 ID
 * @param {Set<string>} explicitKeys 用户显式配置过的字段名
 * @returns {object} fp
 */
function assignHardwareFingerprint(fp, seedKey, explicitKeys = new Set()) {
  const seed = hashSeedKey(seedKey);
  const gpu = GPU_POOL[seed % GPU_POOL.length];
  const want = (k) => !explicitKeys.has(k);

  if (want('webglVendor') || !fp.webglVendor) fp.webglVendor = gpu.vendor;
  if (want('webglRenderer') || !fp.webglRenderer) fp.webglRenderer = gpu.renderer;
  // 核数/内存与选中的 GPU 档次配套，避免「2 核配 RTX 4060」这类矛盾
  if (want('hardwareConcurrency') || !fp.hardwareConcurrency) fp.hardwareConcurrency = gpu.cores;
  if (want('deviceMemory') || !fp.deviceMemory) fp.deviceMemory = gpu.mem;
  if (want('devicePixelRatio') || !fp.devicePixelRatio) fp.devicePixelRatio = gpu.dpr;
  if (want('resolution') || !fp.resolution) {
    fp.resolution = RESOLUTION_POOL[(seed >>> 8) % RESOLUTION_POOL.length];
  }
  // 供 fp-inject 生成 Audio/Canvas 噪声：每环境一个稳定种子
  fp.fpSeed = seed;
  return fp;
}

/** 判断哪些指纹字段是调用方显式指定的（用于尊重用户配置） */
function explicitFingerprintKeys(input = {}) {
  const src = (input && input.browserFingerPrint) || input || {};
  const keys = new Set();
  for (const k of ['webglVendor', 'webglRenderer', 'hardwareConcurrency', 'deviceMemory', 'devicePixelRatio', 'resolution']) {
    if (src[k] !== undefined && src[k] !== null && src[k] !== '') keys.add(k);
  }
  return keys;
}

/**
 * 构造与 User-Agent 严格一致的 CDP userAgentMetadata
 */
function buildUserAgentMetadata(fp = {}) {
  const ver = normalizeCoreVersion(fp.coreVersion);
  const fullVer = realCoreFullVersion(ver);
  const isMac = fp.os === 'MacIntel';
  return {
    brands: [
      { brand: 'Not-A.Brand', version: '99' },
      { brand: 'Google Chrome', version: String(ver) },
      { brand: 'Chromium', version: String(ver) },
    ],
    fullVersionList: [
      { brand: 'Not-A.Brand', version: '99.0.0.0' },
      { brand: 'Google Chrome', version: fullVer },
      { brand: 'Chromium', version: fullVer },
    ],
    fullVersion: fullVer,
    platform: isMac ? 'macOS' : 'Windows',
    // 必须与真实系统一致：Win10 是 10.0.0，Win11 是 13~16.x
    platformVersion: isMac ? '14.5.0' : detectPlatformVersion(),
    architecture: 'x86',
    model: '',
    mobile: false,
    bitness: '64',
    wow64: false,
  };
}

/**
 * 构造与 User-Agent 一致的 HTTP Client Hints 请求头
 */
function buildClientHintHeaders(fp = {}, locale = 'en-US') {
  const ver = normalizeCoreVersion(fp.coreVersion);
  const fullVer = realCoreFullVersion(ver);
  const isMac = fp.os === 'MacIntel';
  const primaryLang = String(locale || fp.languages || 'en-US').split(',')[0].trim() || 'en-US';
  const baseLang = primaryLang.split('-')[0] || 'en';
  const acceptLang = primaryLang.includes('-') && baseLang.toLowerCase() !== primaryLang.toLowerCase()
    ? `${primaryLang},${baseLang};q=0.9`
    : `${primaryLang};q=0.9`;
  return {
    'sec-ch-ua': `"Not-A.Brand";v="99", "Google Chrome";v="${ver}", "Chromium";v="${ver}"`,
    'sec-ch-ua-mobile': '?0',
    'sec-ch-ua-platform': isMac ? '"macOS"' : '"Windows"',
    'sec-ch-ua-platform-version': isMac ? '"14.5.0"' : `"${detectPlatformVersion()}"`,
    'sec-ch-ua-arch': '"x86"',
    'sec-ch-ua-bitness': '"64"',
    'sec-ch-ua-model': '""',
    'sec-ch-ua-full-version': `"${fullVer}"`,
    'sec-ch-ua-full-version-list': `"Not-A.Brand";v="99.0.0.0", "Google Chrome";v="${fullVer}", "Chromium";v="${fullVer}"`,
    'accept-language': acceptLang,
  };
}

module.exports = {
  mergeFingerprint,
  parseResolution,
  buildUserAgent,
  buildSecChUa,
  buildUserAgentMetadata,
  buildClientHintHeaders,
  normalizeCoreVersion,
  syncRealCoreVersion,
  alignedCoreVersion,
  detectPlatformVersion,
  assignHardwareFingerprint,
  explicitFingerprintKeys,
  hashSeedKey,
  GPU_POOL,
  RESOLUTION_POOL,
  CORE_VERSIONS,
  DEFAULT_FP,
};
