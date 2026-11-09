const db = require('../db');
const { TKSWARM_API_BASE } = require('../config');
const { readSettings, writeSettings } = require('../settings');

function normalizeApiBase(raw) {
  const fallback = String(TKSWARM_API_BASE).replace(/\/+$/, '');
  const saved = String(readSettings().apiBase || '').trim().replace(/\/+$/, '');
  const candidate = String(raw || saved || fallback).trim().replace(/\/+$/, '');
  if (/127\.0\.0\.1|localhost/i.test(candidate)) return fallback;
  return candidate || fallback;
}

async function login({ apiBase, username, password, captcha, captchaKey }) {
  const base = normalizeApiBase(apiBase);
  const res = await fetch(`${base}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ username, password, captcha, captchaKey }),
  });
  const json = await res.json().catch(() => ({}));
  const ok = json.success === true || json.code === 0 || json.code === 200;
  if (!res.ok || !ok) {
    throw new Error(json.message || json.msg || '登录失败');
  }
  const data = json.data || json;
  const token = data.token || data.accessToken || '';
  const user = data.user || {};
  const role = user.role || user.roleName || (Number(user.role_id) === 1 ? '超级管理员' : 'user');
  db.saveUser({
    id: Number(user.id || 0),
    username: user.username || username,
    nickname: user.nickname || '',
    token,
    role_name: role,
    is_super: user.isSuper || user.roleId === 1 ? 1 : 0,
    parent_id: 0,
    browser_env_quota: user.browserEnvQuota ?? user.browser_env_quota,
    browser_env_used: user.browserEnvUsed ?? user.browser_env_used,
  });
  if (token) {
    db.setApiToken(token);
    writeSettings({ apiToken: token, apiBase: base });
    // 不再把登录 Token 写入 PHP 的 tkswarmBrowserApiToken：
    // A/B 交替登录会互相覆盖，Node 带着「错的 Bearer」打本机 API，环境共用失败。
    // Node 调自研浏览器时留空 Token 即可（本机有人登录即放行）。
  }
  return { token, user: db.getCurrentUser() };
}

function logout() {
  const fs = require('node:fs');
  const { DB_PATH } = require('../config');
  try {
    if (fs.existsSync(DB_PATH)) {
      const data = JSON.parse(fs.readFileSync(DB_PATH, 'utf8'));
      data.users = [];
      data.sessions = [];
      fs.writeFileSync(DB_PATH, JSON.stringify(data, null, 2));
    }
  } catch { /* ignore */ }
}

async function fetchChildrenStats(user) {
  if (!user?.token) return [];
  const base = normalizeApiBase(process.env.TKSWARM_API_BASE);
  try {
    const res = await fetch(`${base}/auth/status`, {
      headers: { Authorization: `Bearer ${user.token}`, Accept: 'application/json' },
    });
    const json = await res.json().catch(() => ({}));
    const body = json.data || json;
    const remoteUser = body.user || body.loginUser || null;
    if (remoteUser && Number(remoteUser.id) === Number(user.id)) {
      db.saveUser({
        id: Number(user.id),
        username: remoteUser.username || user.username,
        nickname: remoteUser.nickname ?? user.nickname,
        token: user.token,
        role_name: remoteUser.role || user.role_name,
        is_super: remoteUser.isSuper || Number(remoteUser.roleId) === 1 ? 1 : user.is_super,
        browser_env_quota: remoteUser.browserEnvQuota ?? remoteUser.browser_env_quota,
        browser_env_used: remoteUser.browserEnvUsed ?? remoteUser.browser_env_used,
        preserveLoginTime: true,
      });
    }
    const children = body.children || [];
    return children.map((c) => {
      const localStat = db.statsForOwner(c.id, c.browserEnvQuota ?? c.browser_env_quota);
      const remoteUsed = Number(c.browserEnvUsed ?? c.browser_env_used);
      // 已创建数以中心库统计为准（与 Node 管理用户列表一致），拿不到才回退本机统计
      const used = Number.isFinite(remoteUsed) && remoteUsed >= 0 ? remoteUsed : localStat.localUsed;
      return {
        id: c.id,
        username: c.username,
        nickname: c.nickname || c.username,
        ...localStat,
        used,
        remaining: Math.max(0, localStat.limit - used),
      };
    });
  } catch {
    return [];
  }
}

module.exports = { login, logout, fetchChildrenStats };
