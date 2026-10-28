const API = `http://127.0.0.1:${window.tkswarmBrowser?.apiPort || 54345}`;

/** @type {Array<Record<string, unknown>>} */
let cachedProfiles = [];

async function json(method, path, body) {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  return res.json();
}

async function bitListProfiles() {
  const res = await fetch(`${API}/browser/list`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ page: 0, pageSize: 200 }),
  });
  const j = await res.json();
  return j.data?.list || [];
}

function show(el, on) {
  document.querySelector(el)?.classList.toggle('hidden', !on);
}

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

/* —— Toast —— */
function toast(message, type = 'info') {
  const host = document.getElementById('toast-host');
  if (!host) {
    // fallback
    // eslint-disable-next-line no-alert
    alert(message);
    return;
  }
  const el = document.createElement('div');
  el.className = `toast ${type}`;
  el.innerHTML = `<span class="toast-ico" aria-hidden="true"></span><span class="toast-msg">${esc(message)}</span>`;
  host.appendChild(el);
  setTimeout(() => {
    el.style.opacity = '0';
    el.style.transform = 'translateY(-6px)';
    el.style.transition = 'opacity .2s ease, transform .2s ease';
    setTimeout(() => el.remove(), 220);
  }, 2800);
}

/* —— Confirm modal —— */
function confirmDialog({ title = '确认操作', message = '', confirmText = '确定', danger = false } = {}) {
  return new Promise((resolve) => {
    const mask = document.createElement('div');
    mask.className = 'modal-mask';
    mask.innerHTML = `
      <div class="modal" role="dialog" aria-modal="true">
        <div class="modal-head"><h3>${esc(title)}</h3></div>
        <div class="modal-body">${esc(message)}</div>
        <div class="modal-foot">
          <button type="button" class="btn ghost" data-act="cancel">取消</button>
          <button type="button" class="btn ${danger ? 'danger' : 'primary'}" data-act="ok">${esc(confirmText)}</button>
        </div>
      </div>`;
    const close = (v) => {
      mask.remove();
      resolve(v);
    };
    mask.addEventListener('click', (e) => {
      if (e.target === mask) close(false);
    });
    mask.querySelector('[data-act="cancel"]').onclick = () => close(false);
    mask.querySelector('[data-act="ok"]').onclick = () => close(true);
    document.body.appendChild(mask);
    mask.querySelector('[data-act="ok"]').focus();
  });
}

function emptyRow(colspan, title, detail) {
  return `<tr><td colspan="${colspan}" class="empty">
    <div class="empty-block">
      <strong>${esc(title)}</strong>
      ${detail ? `<span class="muted">${esc(detail)}</span>` : ''}
    </div>
  </td></tr>`;
}

function renderSystemPills(sys) {
  if (!sys?.ok) return '加载失败';
  const renderOn = sys.softwareRenderActive
    ? `已开启${sys.softwareRenderReason ? `（${sys.softwareRenderReason}）` : ''}`
    : '未开启';
  const pills = [
    ['数据目录', `<code>${esc(sys.dataRoot)}</code>`],
    ['配置文件', `<code>${esc(sys.settingsPath)}</code>`],
    ['软件渲染', esc(renderOn)],
    ['内核', esc(sys.engine || '—')],
    ['环境窗', esc(sys.envWindowMode || '—')],
    ['版本', `v${esc(sys.version || '—')}`],
  ];
  if (sys.packagedPortable) {
    pills.push(['便携版', '<span class="muted">经 portable.exe 子进程拉起</span>']);
  }
  return pills.map(([label, value]) =>
    `<div class="system-pill"><b>${label}</b><span>${value}</span></div>`
  ).join('');
}

function proxyTag(p) {
  const type = String(p.proxyType || 'noproxy').toLowerCase();
  if (type === 'noproxy' || !type) {
    return '<span class="tag noproxy">直连</span>';
  }
  const host = [p.host, p.port].filter(Boolean).join(':');
  return `<span class="tag proxy">${esc(type)}</span>${host ? ` <span class="muted">${esc(host)}</span>` : ''}${
    p.lastIp ? `<div class="cell-sub">IP ${esc(p.lastIp)}</div>` : ''
  }`;
}

function renderProfileRows(list) {
  const body = document.getElementById('profile-body');
  const countEl = document.getElementById('profile-count');
  if (countEl) countEl.textContent = `${list.length} 条`;
  if (!body) return;
  if (!list.length) {
    const q = document.getElementById('profile-search')?.value?.trim();
    body.innerHTML = emptyRow(
      6,
      q ? '无匹配结果' : '暂无环境',
      q ? '尝试其他关键词' : '请在 Node 账号页创建并绑定'
    );
    return;
  }
  body.innerHTML = list.map((p) => {
    const running = p.status === 1 || p.status === 2;
    const group = p.groupId || 'default';
    return `
      <tr>
        <td><code>${esc(String(p.id).slice(0, 12))}…</code></td>
        <td>${esc(p.name)}${p.remark ? `<div class="cell-sub">${esc(p.remark)}</div>` : ''}</td>
        <td><span class="tag group">${esc(group)}</span></td>
        <td>${proxyTag(p)}</td>
        <td>${esc(p.timezone || '—')}</td>
        <td><span class="status-dot ${running ? 'running' : 'idle'}">${running ? '运行中' : '空闲'}</span></td>
      </tr>`;
  }).join('');
}

function filterProfiles() {
  const q = (document.getElementById('profile-search')?.value || '').trim().toLowerCase();
  if (!q) {
    renderProfileRows(cachedProfiles);
    return;
  }
  const filtered = cachedProfiles.filter((p) => {
    const blob = [
      p.id, p.name, p.remark, p.groupId, p.proxyType, p.host, p.port, p.timezone, p.lastIp,
    ].map((x) => String(x ?? '').toLowerCase()).join(' ');
    return blob.includes(q);
  });
  renderProfileRows(filtered);
}

async function openTestEnvWindow(triggerBtn) {
  const targets = [triggerBtn, document.getElementById('btn-test-env'), document.getElementById('btn-test-env-hero')]
    .filter(Boolean);
  targets.forEach((btn) => { btn.disabled = true; });
  try {
    const pack = await json('POST', '/api/test/open-env-window');
    if (!pack.ok) {
      toast(pack.message || '测试环境窗打开失败', 'err');
    } else {
      toast('测试环境窗已打开', 'ok');
      await refreshDashboard();
    }
  } catch (error) {
    toast(error?.message || '请求失败', 'err');
  } finally {
    targets.forEach((btn) => { btn.disabled = false; });
  }
}

async function refreshDashboard() {
  const [pack, sys] = await Promise.all([
    json('GET', '/api/dashboard/stats/async'),
    json('GET', '/api/system/info').catch(() => ({})),
  ]);
  if (!pack.ok) return;
  const pathBar = document.getElementById('path-bar');
  if (pathBar) pathBar.innerHTML = renderSystemPills(sys);
  const { user, self, children, windows } = pack;
  const displayName = user.nickname || user.username || '管理员';
  const chipText = document.getElementById('user-chip-text');
  if (chipText) chipText.textContent = `${displayName} · ${user.role || ''}`;
  const welcomeName = document.getElementById('welcome-name');
  if (welcomeName) welcomeName.textContent = displayName;
  show('#user-chip', true);
  show('#btn-logout', true);
  show('#btn-test-env', true);
  document.getElementById('stat-self').textContent = `${self.used} / ${self.limit}`;
  const tokenEl = document.getElementById('api-token');
  if (pack.token) tokenEl.textContent = pack.token;
  document.getElementById('stat-windows').textContent = String(windows.length);
  if (sys.ok) {
    const engineEl = document.getElementById('stat-engine');
    const versionEl = document.getElementById('stat-version');
    if (engineEl) engineEl.textContent = sys.engine || '—';
    if (versionEl) versionEl.textContent = `v${sys.version || '—'} · ${sys.envWindowMode || '—'}`;
  }
  const childEl = document.getElementById('stat-children');
  const childPanel = document.getElementById('children-panel');
  if (!children?.length) {
    if (childPanel) childPanel.classList.add('hidden');
    if (childEl) childEl.textContent = '';
  } else {
    if (childPanel) childPanel.classList.remove('hidden');
    childEl.classList.remove('muted');
    childEl.innerHTML = children.map((c) =>
      `<article class="child-card">
        <strong>${esc(c.nickname || c.username)}</strong>
        <span>${c.used} / ${c.limit} 环境</span>
      </article>`
    ).join('');
  }

  const winBody = document.getElementById('win-body');
  if (!windows.length) {
    winBody.innerHTML = emptyRow(5, '暂无运行中的窗口', '打开环境后会出现在这里');
  } else {
    winBody.innerHTML = windows.map((w) => `
      <tr>
        <td><code>${esc(w.profileId.slice(0, 10))}…</code></td>
        <td>${esc(w.name)}</td>
        <td><span class="tag ${w.headless ? 'headless' : 'visible'}">${w.headless ? '无头' : '有头'}</span></td>
        <td><code>${w.pid || '—'}</code></td>
        <td>
          <div class="row-actions">
            ${w.headless ? `<button class="btn small primary btn-show" type="button" data-id="${esc(w.profileId)}">显示</button>` : ''}
            <button class="btn small danger btn-close" type="button" data-id="${esc(w.profileId)}">关闭</button>
          </div>
        </td>
      </tr>
    `).join('');
    winBody.querySelectorAll('.btn-show').forEach((btn) => {
      btn.onclick = () => showWindow(btn.dataset.id);
    });
    winBody.querySelectorAll('.btn-close').forEach((btn) => {
      btn.onclick = () => closeWindow(btn.dataset.id);
    });
  }

  const profiles = await bitListProfiles();
  cachedProfiles = profiles;
  const statProfiles = document.getElementById('stat-profiles');
  if (statProfiles) statProfiles.textContent = String(profiles.length);
  filterProfiles();
}

async function showWindow(id) {
  await json('POST', `/api/windows/${encodeURIComponent(id)}/show`);
  toast('已切换为可见窗口', 'ok');
  await refreshDashboard();
}

async function closeWindow(id) {
  const ok = await confirmDialog({
    title: '关闭环境窗口',
    message: '确认关闭该运行中的环境窗口？未保存的页面状态可能丢失。',
    confirmText: '关闭窗口',
    danger: true,
  });
  if (!ok) return;
  await json('POST', `/api/windows/${encodeURIComponent(id)}/close`);
  toast('窗口已关闭', 'ok');
  await refreshDashboard();
}

async function doLogin(e) {
  e?.preventDefault?.();
  const errEl = document.getElementById('login-error');
  errEl.classList.add('hidden');
  const pack = await json('POST', '/api/auth/login', {
    apiBase: document.getElementById('api-base').value.trim(),
    username: document.getElementById('username').value.trim(),
    password: document.getElementById('password').value,
  });
  if (!pack.ok) {
    errEl.textContent = pack.message || '登录失败';
    errEl.classList.remove('hidden');
    return;
  }
  show('#login-panel', false);
  show('#dashboard', true);
  toast('登录成功', 'ok');
  await refreshDashboard();
}

const DEFAULT_API_BASE = 'http://tkswarm-api.dyyweb.com/api';

function normalizeLoginApiBase(raw) {
  const v = String(raw || '').trim().replace(/\/+$/, '');
  if (!v || /127\.0\.0\.1|localhost/i.test(v)) return DEFAULT_API_BASE;
  return v;
}

async function init() {
  document.getElementById('api-url').textContent = API;
  const apiBaseEl = document.getElementById('api-base');
  const settings = await json('GET', '/api/settings').catch(() => ({}));
  if (apiBaseEl) {
    apiBaseEl.value = normalizeLoginApiBase(settings.apiBase || settings.defaultApiBase || DEFAULT_API_BASE);
  }
  const st = await json('GET', '/api/auth/status');
  if (st.loggedIn) {
    show('#login-panel', false);
    show('#dashboard', true);
    await refreshDashboard();
  }

  document.getElementById('login-form').addEventListener('submit', doLogin);
  document.getElementById('btn-login').onclick = doLogin;

  document.getElementById('profile-search')?.addEventListener('input', filterProfiles);

  document.getElementById('btn-logout').onclick = async () => {
    await json('POST', '/api/auth/logout');
    show('#dashboard', false);
    show('#login-panel', true);
    show('#user-chip', false);
    show('#btn-logout', false);
    show('#btn-test-env', false);
    toast('已退出登录', 'info');
  };
  document.getElementById('btn-test-env').onclick = () => openTestEnvWindow(document.getElementById('btn-test-env'));
  document.getElementById('btn-test-env-hero')?.addEventListener('click', () =>
    openTestEnvWindow(document.getElementById('btn-test-env-hero'))
  );
  document.getElementById('btn-refresh').onclick = async () => {
    await refreshDashboard();
    toast('数据已刷新', 'ok');
  };
  document.getElementById('btn-refresh-hero')?.addEventListener('click', async () => {
    await refreshDashboard();
    toast('数据已刷新', 'ok');
  });
  document.getElementById('quick-refresh')?.addEventListener('click', async (e) => {
    e.preventDefault();
    await refreshDashboard();
    toast('状态已同步', 'ok');
  });
  document.getElementById('quick-test')?.addEventListener('click', (e) => {
    e.preventDefault();
    openTestEnvWindow(document.getElementById('btn-test-env'));
  });
  document.getElementById('quick-node')?.addEventListener('click', (e) => {
    e.preventDefault();
    navigator.clipboard.writeText(API).then(() => toast('已复制本地 API 地址', 'ok'));
  });
  document.getElementById('quick-docs')?.addEventListener('click', (e) => {
    e.preventDefault();
    window.open('http://tkswarm-api.dyyweb.com/', '_blank');
  });
  document.getElementById('btn-copy-token').onclick = async () => {
    const t = document.getElementById('api-token').textContent.trim();
    if (!t || t === '—') {
      toast('暂无 Token 可复制', 'err');
      return;
    }
    await navigator.clipboard.writeText(t);
    const btn = document.getElementById('btn-copy-token');
    const prev = btn.textContent;
    btn.textContent = '已复制';
    toast('Token 已复制', 'ok');
    setTimeout(() => { btn.textContent = prev; }, 1500);
  };
  window.tkswarmBrowser?.onWindowsUpdated?.(() => refreshDashboard());
  window.tkswarmBrowser?.onTestEnvError?.((msg) => {
    toast(`测试环境窗打开失败：${msg}`, 'err');
  });
  setInterval(() => refreshDashboard(), 8000);
}

init().catch(console.error);
