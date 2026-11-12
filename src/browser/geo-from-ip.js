/**
 * 根据出口 IP 推断时区 / 语言 / 经纬度（对齐比特 isIpCreate* 行为）。
 */
const http = require('node:http');
const https = require('node:https');

const COUNTRY_LOCALE = {
  US: 'en-US', GB: 'en-GB', AU: 'en-AU', CA: 'en-CA',
  CN: 'zh-CN', TW: 'zh-TW', HK: 'zh-HK',
  JP: 'ja-JP', KR: 'ko-KR',
  DE: 'de-DE', FR: 'fr-FR', ES: 'es-ES', IT: 'it-IT', PT: 'pt-PT', BR: 'pt-BR',
  RU: 'ru-RU', TR: 'tr-TR', TH: 'th-TH', VN: 'vi-VN', ID: 'id-ID',
  IN: 'en-IN', MX: 'es-MX', PH: 'en-PH', SG: 'en-SG', MY: 'en-MY',
};

/** 国家码 → 代表时区（地理查询全部失败时的兜底，避免写死成美国东部） */
const COUNTRY_TIMEZONE = {
  US: 'America/New_York', CA: 'America/Toronto', MX: 'America/Mexico_City', BR: 'America/Sao_Paulo',
  GB: 'Europe/London', IE: 'Europe/Dublin', DE: 'Europe/Berlin', FR: 'Europe/Paris',
  ES: 'Europe/Madrid', IT: 'Europe/Rome', NL: 'Europe/Amsterdam', BE: 'Europe/Brussels',
  CH: 'Europe/Zurich', AT: 'Europe/Vienna', SE: 'Europe/Stockholm', NO: 'Europe/Oslo',
  DK: 'Europe/Copenhagen', FI: 'Europe/Helsinki', PL: 'Europe/Warsaw', PT: 'Europe/Lisbon',
  RU: 'Europe/Moscow', UA: 'Europe/Kiev', TR: 'Europe/Istanbul', CZ: 'Europe/Prague',
  GR: 'Europe/Athens', RO: 'Europe/Bucharest', HU: 'Europe/Budapest',
  CN: 'Asia/Shanghai', TW: 'Asia/Taipei', HK: 'Asia/Hong_Kong', MO: 'Asia/Macau',
  JP: 'Asia/Tokyo', KR: 'Asia/Seoul', SG: 'Asia/Singapore', MY: 'Asia/Kuala_Lumpur',
  TH: 'Asia/Bangkok', VN: 'Asia/Ho_Chi_Minh', ID: 'Asia/Jakarta', PH: 'Asia/Manila',
  IN: 'Asia/Kolkata', PK: 'Asia/Karachi', BD: 'Asia/Dhaka', AE: 'Asia/Dubai',
  SA: 'Asia/Riyadh', IL: 'Asia/Jerusalem', KZ: 'Asia/Almaty',
  AU: 'Australia/Sydney', NZ: 'Pacific/Auckland',
  ZA: 'Africa/Johannesburg', EG: 'Africa/Cairo', NG: 'Africa/Lagos', KE: 'Africa/Nairobi',
};

function httpJson(url, timeoutMs = 6000) {
  return new Promise((resolve, reject) => {
    const lib = String(url).startsWith('https') ? https : http;
    const req = lib.get(url, { timeout: timeoutMs }, (res) => {
      let body = '';
      res.on('data', (c) => { body += c; });
      res.on('end', () => {
        try { resolve(JSON.parse(body || '{}')); } catch (e) { reject(e); }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => {
      req.destroy();
      reject(new Error('geo lookup timeout'));
    });
  });
}

/**
 * 多源地理查询：ip-api 免费版容错差（限速 45 次/分、只支持 http），
 * 单一来源失败会让时区回退到错误默认值，所以按顺序尝试多个服务。
 */
async function lookupGeoMultiSource(ip) {
  // 1) ip-api.com（含时区，字段全，最优先）
  try {
    const d = await httpJson(`http://ip-api.com/json/${ip}?fields=status,message,country,countryCode,city,lat,lon,timezone,query`);
    if (d?.status === 'success' && d.timezone) {
      const cc = String(d.countryCode || '').toUpperCase();
      return {
        ip: d.query || ip,
        country: d.country || '',
        countryCode: cc,
        city: d.city || '',
        timezone: d.timezone,
        language: COUNTRY_LOCALE[cc] || 'en-US',
        latitude: Number(d.lat) || 0,
        longitude: Number(d.lon) || 0,
      };
    }
  } catch { /* 换下一个源 */ }

  // 2) ipapi.co（https，字段含 timezone）
  try {
    const d = await httpJson(`https://ipapi.co/${ip}/json/`, 7000);
    if (d && !d.error && d.timezone) {
      const cc = String(d.country_code || d.country || '').toUpperCase();
      return {
        ip: d.ip || ip,
        country: d.country_name || '',
        countryCode: cc,
        city: d.city || '',
        timezone: d.timezone,
        language: COUNTRY_LOCALE[cc] || 'en-US',
        latitude: Number(d.latitude) || 0,
        longitude: Number(d.longitude) || 0,
      };
    }
  } catch { /* 换下一个源 */ }

  // 3) ipwho.is（https，免费无 key）
  try {
    const d = await httpJson(`https://ipwho.is/${ip}`, 7000);
    if (d && d.success !== false && d.timezone?.id) {
      const cc = String(d.country_code || '').toUpperCase();
      return {
        ip: d.ip || ip,
        country: d.country || '',
        countryCode: cc,
        city: d.city || '',
        timezone: d.timezone.id,
        language: COUNTRY_LOCALE[cc] || 'en-US',
        latitude: Number(d.latitude) || 0,
        longitude: Number(d.longitude) || 0,
      };
    }
  } catch { /* ignore */ }

  return null;
}

/**
 * @param {string} ip
 * @returns {Promise<{ ip, country, countryCode, timezone, language, latitude, longitude, city }>}
 */
async function lookupGeoByIp(ip) {
  const clean = String(ip || '').trim();
  if (!clean || !/^\d+\.\d+\.\d+\.\d+$/.test(clean)) {
    return emptyGeo(clean);
  }
  const hit = await lookupGeoMultiSource(clean).catch(() => null);
  if (hit) return hit;
  return emptyGeo(clean, 'all geo sources failed');
}

function emptyGeo(ip = '', error = '') {
  return {
    ip: ip || '',
    country: '',
    countryCode: '',
    city: '',
    timezone: '',
    language: '',
    latitude: 0,
    longitude: 0,
    error: error || '',
  };
}

/**
 * 按指纹开关，把出口 IP 地理信息合并进 profile 创建/更新字段。
 */
/**
 * 按指纹开关，把出口 IP 地理信息合并进 profile 创建/更新字段。
 *
 * 时区兜底策略（重要）：
 * 过去凡是探测不到就写死 America/New_York。这会造成「代理 IP 在亚洲/欧洲、
 * 时区却报纽约」的硬矛盾——比没有时区更危险。现在改为：
 *   1. 优先用探测到的真实时区
 *   2. 探测不到时，按国家码推断
 *   3. 连国家都拿不到，就留空（由系统本地时区决定，而不是伪造一个错误的）
 */
function applyIpCreateFields(fp = {}, geo = {}, body = {}) {
  const out = {
    timezone: body.timezone || '',
    language: body.language || '',
    latitude: body.latitude != null ? Number(body.latitude) : null,
    longitude: body.longitude != null ? Number(body.longitude) : null,
    country: body.country || geo.country || '',
  };
  if (!out.timezone) {
    if (fp.isIpCreateTimeZone !== false && geo.timezone) {
      out.timezone = geo.timezone;
    } else {
      // 按国家码推断，而不是无脑美国东部
      const cc = String(geo.countryCode || '').toUpperCase();
      out.timezone = COUNTRY_TIMEZONE[cc] || '';
    }
  }
  if (!out.language) {
    if (fp.isIpCreateLanguage !== false && geo.language) out.language = geo.language;
    else out.language = fp.languages || 'en-US';
  }
  if (out.latitude == null || out.longitude == null) {
    if (fp.isIpCreatePosition !== false && geo.latitude && geo.longitude) {
      out.latitude = geo.latitude;
      out.longitude = geo.longitude;
    } else {
      out.latitude = out.latitude ?? 0;
      out.longitude = out.longitude ?? 0;
    }
  }
  return out;
}

module.exports = { lookupGeoByIp, applyIpCreateFields, COUNTRY_LOCALE, COUNTRY_TIMEZONE };

/* ------------------------------------------------------------------ *
 * 地区一致性强制对齐
 *
 * 指纹浏览器最基本的一条：代理 IP 的国家、浏览器时区、语言必须自洽。
 * 三者只要有一项对不上（典型：美国 IP + Asia/Shanghai + zh-CN），
 * 风控立刻能推断「这个"美国用户"其实在别处」，前面所有伪装都白做。
 *
 * 这里不做「探测」只做「收口」：给定 IP 国家码，把时区/语言强制写成该国的值，
 * 并返回冲突说明，供创建环境时提示用户。
 * ------------------------------------------------------------------ */

/** 一个国家可能有多个时区（美/加/澳/俄/巴西），按经度挑最接近的 */
const COUNTRY_MULTI_TIMEZONE = {
  US: [
    { tz: 'America/New_York', lon: -74 }, { tz: 'America/Chicago', lon: -87.6 },
    { tz: 'America/Denver', lon: -105 }, { tz: 'America/Los_Angeles', lon: -118.2 },
    { tz: 'America/Phoenix', lon: -112 },
  ],
  CA: [
    { tz: 'America/Toronto', lon: -79.4 }, { tz: 'America/Vancouver', lon: -123.1 },
    { tz: 'America/Edmonton', lon: -113.5 },
  ],
  AU: [
    { tz: 'Australia/Sydney', lon: 151.2 }, { tz: 'Australia/Perth', lon: 115.9 },
    { tz: 'Australia/Adelaide', lon: 138.6 }, { tz: 'Australia/Brisbane', lon: 153 },
  ],
  RU: [
    { tz: 'Europe/Moscow', lon: 37.6 }, { tz: 'Asia/Novosibirsk', lon: 82.9 },
    { tz: 'Asia/Vladivostok', lon: 131.9 },
  ],
  BR: [
    { tz: 'America/Sao_Paulo', lon: -46.6 }, { tz: 'America/Manaus', lon: -60 },
  ],
};

/**
 * 按国家 + 经度给出最合理的时区。
 * @param {string} countryCode 两位国家码
 * @param {number|null} longitude 出口 IP 经度（可为空）
 */
function timezoneForCountry(countryCode, longitude) {
  const cc = String(countryCode || '').toUpperCase();
  if (!cc) return '';
  const multi = COUNTRY_MULTI_TIMEZONE[cc];
  if (multi && multi.length) {
    const lon = Number(longitude);
    if (Number.isFinite(lon)) {
      let best = multi[0];
      let dist = Infinity;
      for (const item of multi) {
        const d = Math.abs(item.lon - lon);
        if (d < dist) { dist = d; best = item; }
      }
      return best.tz;
    }
    return multi[0].tz;
  }
  return COUNTRY_TIMEZONE[cc] || '';
}

/** 按国家给语言；未收录的国家回退到该国主要语言，再不行 en-US */
function languageForCountry(countryCode) {
  const cc = String(countryCode || '').toUpperCase();
  if (!cc) return '';
  if (COUNTRY_LOCALE[cc]) return COUNTRY_LOCALE[cc];
  return '';
}

/**
 * 把 fp 的时区/语言强制对齐到 IP 所在国家。
 *
 * @param {object} fp 环境指纹对象（会被就地修改）
 * @param {{ countryCode?: string, timezone?: string, longitude?: number, latitude?: number }} geo
 * @param {{ force?: boolean }} [opts] force=true 时即使已有值也覆盖
 * @returns {{ changed: string[], conflicts: string[], timezone: string, language: string }}
 */
function alignRegionToProxy(fp = {}, geo = {}, opts = {}) {
  const cc = String(geo.countryCode || '').toUpperCase();
  const force = opts.force === true;
  const changed = [];
  const conflicts = [];
  if (!cc) {
    return { changed, conflicts: ['未能识别代理 IP 的国家，时区/语言未对齐'], timezone: fp.timezone || '', language: fp.language || '' };
  }

  const wantTz = timezoneForCountry(cc, geo.longitude);
  const wantLang = languageForCountry(cc);

  // ---- 时区 ----
  if (wantTz) {
    const cur = String(fp.timezone || '').trim();
    if (!cur || force) {
      if (cur !== wantTz) { fp.timezone = wantTz; changed.push(`时区 ${cur || '(空)'} → ${wantTz}`); }
    } else if (cur !== wantTz) {
      conflicts.push(`时区与代理地区不符：${cur}，代理国家 ${cc} 应为 ${wantTz}`);
      if (force) fp.timezone = wantTz;
    }
  }

  // ---- 语言 ----
  if (wantLang) {
    const cur = String(fp.language || fp.languages || '').trim();
    if (!cur || force) {
      if (cur !== wantLang) {
        fp.language = wantLang;
        fp.languages = wantLang;
        changed.push(`语言 ${cur || '(空)'} → ${wantLang}`);
      }
    } else if (cur.toLowerCase() !== wantLang.toLowerCase()) {
      conflicts.push(`语言与代理地区不符：${cur}，代理国家 ${cc} 应为 ${wantLang}`);
      if (force) { fp.language = wantLang; fp.languages = wantLang; }
    }
  }

  // ---- 经纬度 ----
  if (geo.latitude != null && geo.longitude != null) {
    if (fp.latitude == null || force) fp.latitude = Number(geo.latitude);
    if (fp.longitude == null || force) fp.longitude = Number(geo.longitude);
  }

  return {
    changed,
    conflicts,
    timezone: fp.timezone || '',
    language: fp.language || fp.languages || '',
  };
}

module.exports.alignRegionToProxy = alignRegionToProxy;
module.exports.timezoneForCountry = timezoneForCountry;
module.exports.languageForCountry = languageForCountry;
module.exports.COUNTRY_MULTI_TIMEZONE = COUNTRY_MULTI_TIMEZONE;
