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
