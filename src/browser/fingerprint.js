/** 支持的 Chrome 内核档位（UA / Client Hints；实际二进制仍用本机 Chrome） */
const CORE_VERSIONS = ['120', '124', '128', '131', '136', '140', '144', '148', '150', '152', '154', '156', '157', '158', '159', '160'];

/**
 * 打开环境时探测到的真实内核版本（如本机 Chrome 157.0.x）。
 * 见 syncRealCoreVersion()：UA 必须与内核真实版本一致，否则页面做特性探测
 * 就能发现「UA 说 131、身上有 157 的特性」，判定为伪造环境。
 */
let REAL_CORE_VERSION = '';

/**
 * 用本机 Chrome 的真实主版本同步指纹版本。
 * - 指纹里显式指定了 coreVersion 时：只有当它与真实版本相差 >= 5 个大版本才强制纠正
 *   （尊重用户刻意选择的档位，但避免 131 vs 157 这种离谱错配）
 * - 未指定时：直接采用真实版本
 * @returns {string} 真实主版本号，探测失败返回 ''
 */
function syncRealCoreVersion() {
  if (REAL_CORE_VERSION !== '') return REAL_CORE_VERSION;
  try {
    const { detectChromeMajorVersion } = require('./chrome-path');
    REAL_CORE_VERSION = String(detectChromeMajorVersion() || '').trim();
  } catch {
    REAL_CORE_VERSION = '';
  }
  return REAL_CORE_VERSION;
}

/** 与真实内核版本对齐后的 coreVersion */
function alignedCoreVersion(rawWanted) {
  const real = syncRealCoreVersion();
  const wanted = String(rawWanted || '').match(/^(\d{2,3})/)?.[1] || '';
  if (!real) return wanted || DEFAULT_FP.coreVersion;
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

/**
 * 构造与 User-Agent 严格一致的 CDP userAgentMetadata
 */
function buildUserAgentMetadata(fp = {}) {
  const ver = normalizeCoreVersion(fp.coreVersion);
  const fullVer = `${ver}.0.0.0`;
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
  const fullVer = `${ver}.0.0.0`;
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
  CORE_VERSIONS,
  DEFAULT_FP,
};
