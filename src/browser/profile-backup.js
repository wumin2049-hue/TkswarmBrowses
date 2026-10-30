/**
 * Profile 打包导出 / 导入：meta.json + userdata（Cookie 等）。
 * 统一 format：tkswarm-browser-profile（兼容旧 tkswarm-linuxbrowse-profile）。
 * 排除 Cache 等体积大目录，保留 Cookies / Local Storage 以跨机保持登录态。
 */
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const zlib = require('node:zlib');
const { spawnSync } = require('node:child_process');
const { PROFILES_DIR, DATA_ROOT } = require('../config');
const { profileRoot } = require('./profile-cleanup');
const db = require('../db');

const PROVIDER_ID = 'tkswarm-browses';
const FORMAT = 'tkswarm-browser-profile';
const LEGACY_FORMATS = new Set(['tkswarm-browser-profile', 'tkswarm-linuxbrowse-profile']);

const EXPORTS_DIR = path.join(DATA_ROOT, 'exports');

/** 顶层或任意层级跳过的目录/文件名（控体积；登录态目录不在此列） */
const SKIP_NAMES = new Set([
  '.tkswarm-chrome.pid',
  'SingletonLock',
  'SingletonCookie',
  'SingletonSocket',
  'lockfile',
  'Cache',
  'Code Cache',
  'GPUCache',
  'ShaderCache',
  'GrShaderCache',
  'GraphiteDawnCache',
  'DawnGraphiteCache',
  'DawnWebGPUCache',
  'Crashpad',
  'BrowserMetrics',
  'component_crx_cache',
  'optimization_guide_model_store',
]);

function clientVersion() {
  try {
    return String(require('../../package.json').version || '0');
  } catch {
    return '0';
  }
}

function ensureExportsDir() {
  fs.mkdirSync(EXPORTS_DIR, { recursive: true });
  return EXPORTS_DIR;
}

function tarBin() {
  return process.platform === 'win32' ? 'tar.exe' : 'tar';
}

/**
 * Windows 自带 bsdtar 会把参数里的 `\` 当转义（C:\data\exports → C:datalexports），
 * 传给 tar 的路径一律改成正斜杠；优先用相对路径 + cwd 更稳。
 */
function toTarArg(p) {
  const abs = path.resolve(String(p || ''));
  return process.platform === 'win32' ? abs.replace(/\\/g, '/') : abs;
}

function hasTar() {
  try {
    const r = spawnSync(tarBin(), ['--version'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      windowsHide: true,
    });
    return r.status === 0;
  } catch {
    return false;
  }
}

/** ustar 头（支持 prefix，路径可用到约 255 字节） */
function ustarHeader(namePosix, size, typeFlag = '0', mtimeSec = Math.floor(Date.now() / 1000)) {
  const buf = Buffer.alloc(512, 0);
  let name = String(namePosix || '').replace(/\\/g, '/');
  let prefix = '';
  if (Buffer.byteLength(name, 'utf8') > 100) {
    const parts = name.split('/');
    while (parts.length > 1) {
      const nextPrefix = prefix ? `${prefix}/${parts[0]}` : parts[0];
      if (Buffer.byteLength(nextPrefix, 'utf8') > 155) break;
      prefix = nextPrefix;
      parts.shift();
      name = parts.join('/');
      if (Buffer.byteLength(name, 'utf8') <= 100) break;
    }
  }
  if (Buffer.byteLength(name, 'utf8') > 100) {
    name = Buffer.from(name, 'utf8').subarray(0, 100).toString('utf8');
  }
  buf.write(name, 0, 100, 'utf8');
  buf.write('0000644\0', 100, 8, 'utf8');
  buf.write('0000000\0', 108, 8, 'utf8');
  buf.write('0000000\0', 116, 8, 'utf8');
  buf.write(`${(size >>> 0).toString(8).padStart(11, '0')}\0`, 124, 12, 'utf8');
  buf.write(`${(mtimeSec >>> 0).toString(8).padStart(11, '0')}\0`, 136, 12, 'utf8');
  buf.write('        ', 148, 8, 'utf8'); // checksum placeholder
  buf.write(typeFlag, 156, 1, 'utf8');
  buf.write('ustar\0', 257, 6, 'utf8');
  buf.write('00', 263, 2, 'utf8');
  if (prefix) buf.write(prefix, 345, 155, 'utf8');
  let sum = 0;
  for (let i = 0; i < 512; i += 1) sum += buf[i];
  buf.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148, 8, 'utf8');
  return buf;
}

function collectTarEntries(rootDir) {
  const entries = [];
  const walk = (absDir, relPosix) => {
    let names = [];
    try { names = fs.readdirSync(absDir); } catch { return; }
    for (const name of names) {
      const abs = path.join(absDir, name);
      const rel = relPosix ? `${relPosix}/${name}` : name;
      let st;
      try { st = fs.lstatSync(abs); } catch { continue; }
      if (st.isSymbolicLink()) continue;
      if (st.isDirectory()) {
        entries.push({ type: '5', name: rel.endsWith('/') ? rel : `${rel}/`, size: 0, abs: null, mtime: st.mtimeMs });
        walk(abs, rel);
      } else if (st.isFile()) {
        entries.push({ type: '0', name: rel, size: st.size, abs, mtime: st.mtimeMs });
      }
    }
  };
  walk(rootDir, '');
  return entries;
}

/**
 * 纯 Node 打 .tgz，不依赖系统 tar（规避 Windows bsdtar 吃反斜杠/中文路径）
 * @param {string} srcDir 要打包的目录（内容作为归档根）
 * @param {string} destTgz 输出 .tgz 绝对路径（建议放在 ASCII 临时目录）
 */
function createTgzNode(srcDir, destTgz) {
  const entries = collectTarEntries(srcDir);
  const chunks = [];
  for (const ent of entries) {
    const name = String(ent.name || '').replace(/\\/g, '/').replace(/^\//, '');
    if (!name) continue;
    const mtime = Math.floor((ent.mtime || Date.now()) / 1000);
    if (ent.type === '5') {
      chunks.push(ustarHeader(name.replace(/\/?$/, '/'), 0, '5', mtime));
      continue;
    }
    const data = fs.readFileSync(ent.abs);
    chunks.push(ustarHeader(name, data.length, '0', mtime));
    chunks.push(data);
    const pad = (512 - (data.length % 512)) % 512;
    if (pad) chunks.push(Buffer.alloc(pad, 0));
  }
  chunks.push(Buffer.alloc(1024, 0));
  const raw = Buffer.concat(chunks);
  const gz = zlib.gzipSync(raw, { level: 6 });
  fs.mkdirSync(path.dirname(destTgz), { recursive: true });
  fs.writeFileSync(destTgz, gz);
  return destTgz;
}

/** 路径含非 ASCII / 空格时，Windows bsdtar 极易把 `\` 当转义并乱码（datalexports…） */
function pathUnsafeForWinTar(p) {
  const s = String(p || '');
  return /[^\x00-\x7F]/.test(s) || /\s/.test(s);
}

/**
 * 打 .tgz：Windows 一律走纯 Node（避开 bsdtar 中文/空格路径）；
 * 其它平台可试系统 tar（cwd + 相对名），失败再 Node。
 * destTgz 必须是调用方准备好的 ASCII 路径。
 */
function createTgzFromDir(srcDir, destTgz) {
  const outName = path.basename(destTgz) || 'pack.tgz';
  const preferNode = process.platform === 'win32'
    || pathUnsafeForWinTar(srcDir)
    || pathUnsafeForWinTar(destTgz);

  try {
    if (!preferNode && hasTar()) {
      const inSrc = path.join(srcDir, outName);
      const hasMeta = fs.existsSync(path.join(srcDir, 'meta.json'));
      const args = hasMeta
        ? ['-czf', outName, 'meta.json', 'userdata']
        : ['-czf', outName, '.'];
      const r = spawnSync(tarBin(), args, {
        encoding: 'utf8',
        cwd: srcDir,
        windowsHide: true,
      });
      if (r.status === 0 && fs.existsSync(inSrc) && fs.statSync(inSrc).size > 0) {
        fs.copyFileSync(inSrc, destTgz);
        try { fs.unlinkSync(inSrc); } catch { /* */ }
        return { filePath: destTgz, via: 'tar' };
      }
      console.warn('[profile-backup] system tar failed, fallback to node tgz:', r.stderr || r.stdout || r.status);
    }
    createTgzNode(srcDir, destTgz);
    return { filePath: destTgz, via: 'node' };
  } catch (e) {
    createTgzNode(srcDir, destTgz);
    return { filePath: destTgz, via: 'node-catch' };
  }
}

function copyDirFiltered(src, dest) {
  fs.mkdirSync(dest, { recursive: true });
  if (!fs.existsSync(src)) return;
  for (const name of fs.readdirSync(src)) {
    if (SKIP_NAMES.has(name)) continue;
    const from = path.join(src, name);
    const to = path.join(dest, name);
    let st;
    try {
      st = fs.lstatSync(from);
    } catch {
      continue;
    }
    if (st.isSymbolicLink()) continue;
    if (st.isDirectory()) copyDirFiltered(from, to);
    else fs.copyFileSync(from, to);
  }
}

function dirSize(dir) {
  let n = 0;
  const walk = (d) => {
    for (const name of fs.readdirSync(d)) {
      const p = path.join(d, name);
      const st = fs.statSync(p);
      if (st.isDirectory()) walk(p);
      else n += st.size;
    }
  };
  try { walk(dir); } catch { /* */ }
  return n;
}

/**
 * 导出环境为 .tgz（含 meta + userdata）
 * @returns {{ filePath: string, fileName: string, bytes: number, kind: string }}
 */
function exportProfilePack(profileId, { closeFirst } = {}) {
  const id = String(profileId);
  const row = db.getProfile(id);
  if (!row) throw new Error('环境不存在');

  ensureExportsDir();
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const fileName = `tkswarm-profile-${id.slice(0, 12)}-${stamp}.tgz`;
  const mirrorPath = path.join(EXPORTS_DIR, fileName);
  // 工作目录与成品一律放系统 Temp（纯 ASCII），避免安装目录含「Tik Tok / 中文」时 tar/上传踩坑
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'tk-br-export-'));
  const asciiTgz = path.join(work, fileName);

  try {
    const meta = {
      format: FORMAT,
      formatVersion: 1,
      provider: PROVIDER_ID,
      version: clientVersion(),
      exportedAt: new Date().toISOString(),
      profile: { ...row },
      note: closeFirst ? 'exported-after-close-hint' : 'export-live-ok-if-idle',
    };
    const stage = path.join(work, 'stage');
    fs.mkdirSync(stage, { recursive: true });
    fs.writeFileSync(path.join(stage, 'meta.json'), JSON.stringify(meta, null, 2), 'utf8');
    copyDirFiltered(profileRoot(id), path.join(stage, 'userdata'));

    const packed = createTgzFromDir(stage, asciiTgz);
    const st = fs.statSync(asciiTgz);
    // 可选镜像到 data/exports（UI 列表用）；失败不影响返回 ASCII 路径给 Node 上传
    try {
      fs.copyFileSync(asciiTgz, mirrorPath);
    } catch (e) {
      console.warn('[profile-backup] mirror to exports failed (ok if Chinese path):', e.message || e);
    }
    // 把成品移出即将删除的 work，放到独立 ASCII 临时文件，供 Node 读取上传
    const handoff = path.join(os.tmpdir(), `tk-pack-out-${id.slice(0, 12)}-${Date.now()}.tgz`);
    fs.copyFileSync(asciiTgz, handoff);
    return {
      filePath: handoff,
      fileName,
      bytes: st.size,
      kind: 'tgz',
      via: packed?.via || 'node',
      mirrorPath: fs.existsSync(mirrorPath) ? mirrorPath : '',
    };
  } finally {
    try { fs.rmSync(work, { recursive: true, force: true }); } catch { /* */ }
  }
}

function extractTgz(tgzPath, destDir) {
  fs.mkdirSync(destDir, { recursive: true });
  // 先拷到 ASCII 临时目录再解压，避免 Windows tar 吃中文路径
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'tk-tgz-x-'));
  const tmpTgz = path.join(tmpRoot, 'pack.tgz');
  const tmpOut = path.join(tmpRoot, 'out');
  fs.mkdirSync(tmpOut, { recursive: true });
  try {
    fs.copyFileSync(tgzPath, tmpTgz);
    if (hasTar()) {
      const r = spawnSync(
        tarBin(),
        ['-xzf', 'pack.tgz', '-C', 'out'],
        { encoding: 'utf8', cwd: tmpRoot, windowsHide: true },
      );
      if (r.status === 0) {
        fs.cpSync(tmpOut, destDir, { recursive: true });
        return;
      }
    }
    // Node 回退：gunzip + 简易 ustar 解压（仅本格式）
    const raw = zlib.gunzipSync(fs.readFileSync(tmpTgz));
    extractUstarBuffer(raw, destDir);
  } finally {
    try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch { /* */ }
  }
}

function extractUstarBuffer(buf, destDir) {
  let offset = 0;
  while (offset + 512 <= buf.length) {
    const header = buf.subarray(offset, offset + 512);
    offset += 512;
    if (header.every((b) => b === 0)) break;
    const name = header.toString('utf8', 0, 100).replace(/\0.*$/, '');
    const prefix = header.toString('utf8', 345, 500).replace(/\0.*$/, '');
    const sizeOct = header.toString('utf8', 124, 135).replace(/\0.*$/, '').trim();
    const typeFlag = String.fromCharCode(header[156] || 48);
    const size = parseInt(sizeOct || '0', 8) || 0;
    const full = (prefix ? `${prefix}/` : '') + name;
    const rel = full.replace(/\\/g, '/').replace(/^\//, '');
    if (!rel || rel.includes('..')) {
      offset += Math.ceil(size / 512) * 512;
      continue;
    }
    const abs = path.join(destDir, ...rel.split('/').filter(Boolean));
    if (typeFlag === '5' || rel.endsWith('/')) {
      fs.mkdirSync(abs, { recursive: true });
    } else {
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.writeFileSync(abs, buf.subarray(offset, offset + size));
    }
    offset += Math.ceil(size / 512) * 512;
  }
}

/**
 * @param {string} packPath .tgz 或 .tkpack 目录
 * @param {{ ownerId: number, keepId?: boolean, forceOverwrite?: boolean, newName?: string }} opts
 */
function importProfilePack(packPath, opts = {}) {
  const ownerId = Number(opts.ownerId || 0);
  if (!ownerId) throw new Error('缺少 ownerId');

  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'tk-br-import-'));
  try {
    const st = fs.statSync(packPath);
    if (st.isDirectory()) {
      fs.cpSync(packPath, work, { recursive: true });
    } else {
      if (!hasTar()) throw new Error('系统无 tar，无法解压 .tgz');
      extractTgz(packPath, work);
    }

    const metaPath = path.join(work, 'meta.json');
    if (!fs.existsSync(metaPath)) throw new Error('包内缺少 meta.json');
    const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
    if (!LEGACY_FORMATS.has(String(meta.format || ''))) {
      throw new Error('不是受支持的 Profile 包');
    }
    const src = meta.profile || {};
    const forceOverwrite = opts.forceOverwrite === true;
    const wantKeepId = opts.keepId !== false && src.id;
    const existing = wantKeepId ? db.getProfile(String(src.id)) : null;

    let row;
    if (existing && (wantKeepId || forceOverwrite)) {
      const id = String(src.id);
      row = db.updateProfileMeta(id, {
        name: opts.newName || src.name || existing.name,
        remark: src.remark != null ? src.remark : existing.remark,
        groupId: src.group_id || existing.group_id,
        platform: src.platform || existing.platform,
        fingerprint_json: src.fingerprint_json || existing.fingerprint_json,
        timezone: src.timezone,
        language: src.language,
        latitude: src.latitude,
        longitude: src.longitude,
        country: src.country,
        last_ip: src.last_ip,
        proxy_type: src.proxy_type,
        proxy_host: src.proxy_host,
        proxy_port: src.proxy_port,
        proxy_user: src.proxy_user,
        proxy_pass: src.proxy_pass,
      }) || existing;
    } else {
      const keepId = wantKeepId && !existing;
      const id = keepId ? String(src.id) : undefined;
      row = db.createProfile({
        id,
        owner_id: ownerId,
        group_id: src.group_id || 'default',
        name: opts.newName || (keepId ? (src.name || 'imported') : `${src.name || 'imported'} (导入)`),
        remark: src.remark || '',
        platform: src.platform,
        proxy_type: src.proxy_type,
        proxy_host: src.proxy_host,
        proxy_port: src.proxy_port,
        proxy_user: src.proxy_user,
        proxy_pass: src.proxy_pass,
        fingerprint_json: src.fingerprint_json,
        timezone: src.timezone,
        language: src.language,
        latitude: src.latitude,
        longitude: src.longitude,
        country: src.country,
        last_ip: src.last_ip,
      });
    }

    const udSrc = path.join(work, 'userdata');
    const udDest = profileRoot(row.id);
    if (fs.existsSync(udSrc)) {
      if (fs.existsSync(udDest)) fs.rmSync(udDest, { recursive: true, force: true });
      fs.cpSync(udSrc, udDest, { recursive: true });
    }
    return { profile: row, sourceId: src.id || null, overwritten: Boolean(existing) };
  } finally {
    try { fs.rmSync(work, { recursive: true, force: true }); } catch { /* */ }
  }
}

function listExportFiles() {
  ensureExportsDir();
  return fs.readdirSync(EXPORTS_DIR)
    .filter((n) => /\.(tgz|tkpack)$/i.test(n) || fs.statSync(path.join(EXPORTS_DIR, n)).isDirectory())
    .map((name) => {
      const p = path.join(EXPORTS_DIR, name);
      const st = fs.statSync(p);
      return {
        name,
        path: p,
        bytes: st.isDirectory() ? dirSize(p) : st.size,
        mtime: st.mtime.toISOString(),
        kind: st.isDirectory() || /\.tkpack$/i.test(name) ? 'tkpack' : 'tgz',
      };
    })
    .sort((a, b) => String(b.mtime).localeCompare(String(a.mtime)));
}

function resolveExportFile(name) {
  const base = path.basename(String(name || ''));
  if (!base || base.includes('..')) return null;
  const p = path.join(EXPORTS_DIR, base);
  if (!fs.existsSync(p)) return null;
  return p;
}

module.exports = {
  FORMAT,
  exportProfilePack,
  importProfilePack,
  listExportFiles,
  resolveExportFile,
  EXPORTS_DIR,
  ensureExportsDir,
  PROFILES_DIR,
  createTgzFromDir,
  createTgzNode,
};
