const fs = require('node:fs');
const path = require('node:path');
const { v4: uuidv4 } = require('uuid');
const { DB_PATH, PROFILES_DIR, MAX_ENVS_PER_USER } = require('../config');

const DEFAULT = { users: [], profiles: [], sessions: [], groups: [] };

function load() {
  try {
    if (fs.existsSync(DB_PATH)) {
      return { ...DEFAULT, ...JSON.parse(fs.readFileSync(DB_PATH, 'utf8')) };
    }
  } catch { /* reset */ }
  return { ...DEFAULT };
}

function save(data) {
  fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
  fs.writeFileSync(DB_PATH, JSON.stringify(data, null, 2));
}

function withStore(fn) {
  const data = load();
  const out = fn(data);
  save(data);
  return out;
}

function readOnly(fn) {
  return fn(load());
}

function countProfilesByOwner(ownerId) {
  return readOnly((d) => d.profiles.filter((p) => Number(p.owner_id) === Number(ownerId)).length);
}

function resolveEnvLimit(ownerId, overrideLimit) {
  if (overrideLimit !== undefined && overrideLimit !== null && overrideLimit !== '') {
    const o = Number(overrideLimit);
    if (Number.isFinite(o) && o >= 0) return Math.floor(o);
  }
  const oid = Number(ownerId || 0);
  if (oid > 0) {
    const user = readOnly((d) => (d.users || []).find((u) => Number(u.id) === oid));
    const uq = user?.browser_env_quota ?? user?.browserEnvQuota;
    if (uq !== undefined && uq !== null && uq !== '') {
      const n = Number(uq);
      if (Number.isFinite(n) && n >= 0) return Math.floor(n);
    }
  }
  return MAX_ENVS_PER_USER;
}

function assertCanCreateProfile(ownerId, overrideLimit) {
  const limit = resolveEnvLimit(ownerId, overrideLimit);
  const n = countProfilesByOwner(ownerId);
  if (n >= limit) {
    throw new Error(`每个账号最多 ${limit} 个浏览器环境，当前已用 ${n} 个`);
  }
}

function nextSeq(data) {
  const max = data.profiles.reduce((m, p) => Math.max(m, Number(p.seq || 0)), 0);
  return max + 1;
}

function ensureDefaultGroup(data, ownerId = 0) {
  if (!Array.isArray(data.groups)) data.groups = [];
  let g = data.groups.find((x) => x.id === 'default');
  if (!g) {
    g = {
      id: 'default',
      name: '默认分组',
      sort: 0,
      owner_id: Number(ownerId || 0),
      created_at: new Date().toISOString(),
    };
    data.groups.push(g);
  }
  return g;
}

function createProfile(row) {
  return withStore((data) => {
    assertCanCreateProfile(row.owner_id, row.max_envs ?? row.maxEnvs);
    ensureDefaultGroup(data, row.owner_id);
    const id = row.id || uuidv4().replace(/-/g, '').slice(0, 24);
    const profile = {
      id,
      seq: row.seq || nextSeq(data),
      owner_id: Number(row.owner_id || 0),
      group_id: String(row.group_id || row.groupId || 'default'),
      name: row.name,
      remark: row.remark || '',
      platform: row.platform || 'https://www.tiktok.com',
      proxy_type: row.proxy_type || 'noproxy',
      proxy_host: row.proxy_host || '',
      proxy_port: Number(row.proxy_port || 0),
      proxy_user: row.proxy_user || '',
      proxy_pass: row.proxy_pass || '',
      proxy_id: Number(row.proxy_id || 0) || 0,
      fingerprint_json: typeof row.fingerprint_json === 'string'
        ? row.fingerprint_json
        : JSON.stringify(row.fingerprint_json || {}),
      timezone: row.timezone || 'America/New_York',
      language: row.language || 'en-US',
      latitude: Number(row.latitude || 0),
      longitude: Number(row.longitude || 0),
      country: row.country || '',
      last_ip: row.last_ip || '',
      status: 'idle',
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };
    data.profiles.push(profile);
    return { ...profile };
  });
}

function getProfile(id) {
  return readOnly((d) => d.profiles.find((p) => p.id === String(id)) || null);
}

function listProfiles({ page = 0, pageSize = 100, name = '', ownerId = null, groupId = null } = {}) {
  return readOnly((d) => {
    let list = [...d.profiles];
    if (name) {
      const q = name.toLowerCase();
      list = list.filter((p) =>
        p.name.toLowerCase().includes(q)
        || String(p.remark || '').toLowerCase().includes(q)
        || p.id.includes(q)
      );
    }
    if (ownerId != null && ownerId > 0) {
      list = list.filter((p) => Number(p.owner_id) === Number(ownerId));
    }
    if (groupId != null && String(groupId)) {
      list = list.filter((p) => String(p.group_id || 'default') === String(groupId));
    }
    list.sort((a, b) => (a.seq - b.seq) || String(b.created_at).localeCompare(String(a.created_at)));
    const totalNum = list.length;
    const limit = Math.min(500, Math.max(1, pageSize));
    const offset = Math.max(0, page) * limit;
    return { list: list.slice(offset, offset + limit), page, pageSize: limit, totalNum };
  });
}

function updateProfileProxy(id, proxy) {
  return withStore((data) => {
    const p = data.profiles.find((x) => x.id === String(id));
    if (!p) return null;
    p.proxy_type = proxy.proxyType || 'noproxy';
    const nextHost = proxy.host || '';
    const nextPort = Number(proxy.port || 0);
    const sameEndpoint = nextHost === (p.proxy_host || '') && nextPort === Number(p.proxy_port || 0);
    const nextUser = String(proxy.proxyUserName || '').trim();
    const nextPass = String(proxy.proxyPassword || '');
    p.proxy_host = nextHost;
    p.proxy_port = nextPort;
    // Node 偶发只同步 host/port、不带账密时，勿把库里已有密码清空（否则桥接变直连 → ERR_SOCKS）
    p.proxy_user = nextUser || (sameEndpoint ? (p.proxy_user || '') : '');
    p.proxy_pass = nextPass || (sameEndpoint ? (p.proxy_pass || '') : '');
    if (proxy.proxyId != null) p.proxy_id = Number(proxy.proxyId) || 0;
    if (proxy.lastIp != null) p.last_ip = String(proxy.lastIp || '');
    if (proxy.timezone) p.timezone = String(proxy.timezone);
    if (proxy.language) p.language = String(proxy.language);
    if (proxy.latitude != null) p.latitude = Number(proxy.latitude) || 0;
    if (proxy.longitude != null) p.longitude = Number(proxy.longitude) || 0;
    if (proxy.country != null) p.country = String(proxy.country || '');
    p.updated_at = new Date().toISOString();
    return { ...p };
  });
}

function setProfileLastIp(id, lastIp) {
  return withStore((data) => {
    const p = data.profiles.find((x) => x.id === String(id));
    if (!p) return null;
    p.last_ip = String(lastIp || '');
    p.updated_at = new Date().toISOString();
    return { ...p };
  });
}

function updateProfileMeta(id, meta = {}) {
  return withStore((data) => {
    const p = data.profiles.find((x) => x.id === String(id));
    if (!p) return null;
    if (meta.name != null) p.name = String(meta.name || p.name);
    if (meta.remark != null) p.remark = String(meta.remark || '');
    if (meta.group_id != null || meta.groupId != null) {
      p.group_id = String(meta.group_id || meta.groupId || 'default');
    }
    if (meta.timezone != null) p.timezone = String(meta.timezone || '');
    if (meta.language != null) p.language = String(meta.language || '');
    if (meta.latitude != null) p.latitude = Number(meta.latitude) || 0;
    if (meta.longitude != null) p.longitude = Number(meta.longitude) || 0;
    if (meta.country != null) p.country = String(meta.country || '');
    if (meta.last_ip != null) p.last_ip = String(meta.last_ip || '');
    if (meta.fingerprint_json != null) {
      p.fingerprint_json = typeof meta.fingerprint_json === 'string'
        ? meta.fingerprint_json
        : JSON.stringify(meta.fingerprint_json || {});
    }
    if (meta.platform != null) p.platform = String(meta.platform || p.platform);
    if (meta.proxy_type != null) p.proxy_type = String(meta.proxy_type);
    const nextHost = meta.proxy_host != null ? String(meta.proxy_host || '') : (p.proxy_host || '');
    const nextPort = meta.proxy_port != null ? Number(meta.proxy_port) || 0 : Number(p.proxy_port || 0);
    const sameEndpoint = nextHost === (p.proxy_host || '') && nextPort === Number(p.proxy_port || 0);
    if (meta.proxy_host != null) p.proxy_host = nextHost;
    if (meta.proxy_port != null) p.proxy_port = nextPort;
    if (meta.proxy_user != null) {
      const nextUser = String(meta.proxy_user || '').trim();
      p.proxy_user = nextUser || (sameEndpoint ? (p.proxy_user || '') : '');
    }
    if (meta.proxy_pass != null) {
      const nextPass = String(meta.proxy_pass || '');
      p.proxy_pass = nextPass || (sameEndpoint ? (p.proxy_pass || '') : '');
    }
    p.updated_at = new Date().toISOString();
    return { ...p };
  });
}

function listGroups({ ownerId = null } = {}) {
  return withStore((data) => {
    ensureDefaultGroup(data, ownerId || 0);
    let list = [...data.groups];
    if (ownerId != null && ownerId > 0) {
      list = list.filter((g) => !g.owner_id || Number(g.owner_id) === Number(ownerId) || g.id === 'default');
    }
    list.sort((a, b) => (Number(a.sort || 0) - Number(b.sort || 0)) || String(a.name).localeCompare(String(b.name)));
    return list.map((g) => ({ ...g }));
  });
}

function createGroup({ name, ownerId = 0, sort = 0 } = {}) {
  return withStore((data) => {
    ensureDefaultGroup(data, ownerId);
    const id = uuidv4().replace(/-/g, '').slice(0, 16);
    const row = {
      id,
      name: String(name || '未命名分组'),
      sort: Number(sort || 0),
      owner_id: Number(ownerId || 0),
      created_at: new Date().toISOString(),
    };
    data.groups.push(row);
    return { ...row };
  });
}

function updateGroup(id, patch = {}) {
  return withStore((data) => {
    const g = data.groups.find((x) => x.id === String(id));
    if (!g) return null;
    if (patch.name != null) g.name = String(patch.name);
    if (patch.sort != null) g.sort = Number(patch.sort) || 0;
    return { ...g };
  });
}

function deleteGroup(id) {
  return withStore((data) => {
    const gid = String(id);
    if (gid === 'default') throw new Error('默认分组不可删除');
    data.groups = (data.groups || []).filter((g) => g.id !== gid);
    for (const p of data.profiles) {
      if (String(p.group_id || '') === gid) p.group_id = 'default';
    }
    return { ok: true };
  });
}

function deleteProfile(id) {
  withStore((data) => {
    data.profiles = data.profiles.filter((p) => p.id !== String(id));
  });
}

function setProfileStatus(id, status) {
  withStore((data) => {
    const p = data.profiles.find((x) => x.id === String(id));
    if (p) {
      // 仅状态变化，不刷新 updated_at：否则 openProfile 会把它当成「元数据更新」而关窗重开
      p.status = status;
    }
  });
}

function saveUser(user) {
  withStore((data) => {
    const idx = data.users.findIndex((u) => Number(u.id) === Number(user.id));
    const prev = idx >= 0 ? data.users[idx] : {};
    const rawQuota = user.browser_env_quota ?? user.browserEnvQuota ?? prev.browser_env_quota;
    const rawUsed = user.browser_env_used ?? user.browserEnvUsed ?? prev.browser_env_used;
    const row = {
      id: Number(user.id),
      username: user.username ?? prev.username ?? '',
      nickname: user.nickname ?? prev.nickname ?? '',
      token: user.token ?? prev.token ?? '',
      role_name: user.role_name ?? prev.role_name ?? '',
      is_super: (user.is_super !== undefined ? user.is_super : prev.is_super) ? 1 : 0,
      parent_id: Number(user.parent_id ?? prev.parent_id ?? 0),
      browser_env_quota: rawQuota !== undefined && rawQuota !== null && Number.isFinite(Number(rawQuota))
        ? Math.max(0, Math.floor(Number(rawQuota)))
        : undefined,
      browser_env_used: rawUsed !== undefined && rawUsed !== null && Number.isFinite(Number(rawUsed))
        ? Math.max(0, Math.floor(Number(rawUsed)))
        : undefined,
      logged_in_at: user.preserveLoginTime && prev.logged_in_at ? prev.logged_in_at : new Date().toISOString(),
    };
    if (idx >= 0) data.users[idx] = row;
    else data.users.push(row);
  });
}

function getCurrentUser() {
  return readOnly((d) => {
    if (!d.users.length) return null;
    return [...d.users].sort((a, b) => String(b.logged_in_at).localeCompare(String(a.logged_in_at)))[0];
  });
}

/** 全部已知登录用户（A/B 交替登录时都在数组里，按最近登录排序） */
function listUsers() {
  return readOnly((d) => [...(d.users || [])].sort(
    (a, b) => String(b.logged_in_at).localeCompare(String(a.logged_in_at))
  ));
}

/** 本机仍保留的全部会话 Token（最近 8 个），中心 API 鉴权兜底用 */
function listSessionTokens() {
  return readOnly((d) => (Array.isArray(d.sessions) ? d.sessions : [])
    .map((s) => String(s && s.token ? s.token : '').trim())
    .filter(Boolean));
}

function statsForOwner(ownerId, overrideLimit) {
  const localUsed = countProfilesByOwner(ownerId);
  const oid = Number(ownerId || 0);
  const user = oid > 0 ? readOnly((d) => (d.users || []).find((u) => Number(u.id) === oid)) : null;
  const remoteUsed = Number(user?.browser_env_used);
  // 已创建数以中心库（account_browser_envs / register_envs 去重统计）为准，与 Node 管理用户列表一致；
  // 仅在尚未从中心库拿到数据（离线/未登录）时才回退到本机统计。
  const hasRemote = Number.isFinite(remoteUsed) && remoteUsed >= 0;
  const used = hasRemote ? remoteUsed : localUsed;
  const limit = resolveEnvLimit(ownerId, overrideLimit);
  return {
    ownerId,
    used,
    localUsed,
    remoteUsed: Number.isFinite(remoteUsed) && remoteUsed >= 0 ? remoteUsed : undefined,
    limit,
    remaining: Math.max(0, limit - used),
  };
}

function statsAllOwners() {
  return readOnly((d) => {
    const map = {};
    for (const p of d.profiles) {
      const oid = Number(p.owner_id);
      if (!map[oid]) {
        const u = (d.users || []).find((x) => Number(x.id) === oid);
        const uq = Number(u?.browser_env_quota);
        const lim = Number.isFinite(uq) && uq >= 0 ? Math.floor(uq) : MAX_ENVS_PER_USER;
        map[oid] = { ownerId: oid, used: 0, limit: lim };
      }
      map[oid].used += 1;
    }
    return map;
  });
}

function setApiToken(token) {
  withStore((data) => {
    const user = data.users.length
      ? [...data.users].sort((a, b) => String(b.logged_in_at).localeCompare(String(a.logged_in_at)))[0]
      : null;
    const row = {
      token: String(token),
      user_id: user?.id || 0,
      created_at: new Date().toISOString(),
    };
    // 同一台机器上 A/B 交替登录时，不能把对方的 token 顶掉，
    // 否则服务端无法判断「这次请求到底是谁」，环境共用必然出问题。保留最近 8 个。
    const list = (Array.isArray(data.sessions) ? data.sessions : [])
      .filter((s) => s && String(s.token) !== row.token);
    list.unshift(row);
    data.sessions = list.slice(0, 8);
  });
}

/** 按 Bearer token 反查用户，用于把请求归到真正的操作者 */
function getUserByToken(token) {
  const key = String(token || '').trim();
  if (!key) return null;
  return readOnly((d) => {
    const session = (d.sessions || []).find((s) => String(s.token) === key);
    if (!session) return null;
    if (!session.user_id) return null;
    return d.users.find((u) => Number(u.id) === Number(session.user_id)) || null;
  });
}

function validateApiToken(token) {
  return readOnly((d) => d.sessions.some((s) => s.token === String(token)));
}

function getDb() {
  fs.mkdirSync(PROFILES_DIR, { recursive: true });
  return { path: DB_PATH };
}

module.exports = {
  getDb,
  createProfile,
  getProfile,
  listProfiles,
  updateProfileProxy,
  setProfileLastIp,
  updateProfileMeta,
  listGroups,
  createGroup,
  updateGroup,
  deleteGroup,
  deleteProfile,
  setProfileStatus,
  saveUser,
  getCurrentUser,
  listUsers,
  listSessionTokens,
  statsForOwner,
  statsAllOwners,
  countProfilesByOwner,
  setApiToken,
  getUserByToken,
  validateApiToken,
  MAX_ENVS_PER_USER,
};
