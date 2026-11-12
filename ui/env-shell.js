const api = window.envChrome;

function $(id) { return document.getElementById(id); }

function renderTabs(tabs) {
  const strip = $('tab-strip');
  strip.innerHTML = tabs.map((t) => `
    <div class="tab-item${t.active ? ' active' : ''}" data-id="${t.id}">
      <span class="tab-title">${esc(t.title || '新标签页')}</span>
      <button type="button" class="tab-close" data-close="${t.id}" title="关闭">×</button>
    </div>
  `).join('');
  strip.querySelectorAll('.tab-item').forEach((el) => {
    el.addEventListener('click', (e) => {
      if (e.target.closest('.tab-close')) return;
      api.switchTab(Number(el.dataset.id));
    });
  });
  strip.querySelectorAll('.tab-close').forEach((btn) => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      api.closeTab(Number(btn.dataset.close));
    });
  });
}

function renderHistory(items) {
  const list = $('history-list');
  if (!items?.length) {
    list.innerHTML = '<li class="muted" style="padding:12px;color:#888;font-size:12px">暂无历史记录</li>';
    return;
  }
  list.innerHTML = items.map((h) => `
    <li><button type="button" data-url="${escAttr(h.url)}">
      <span class="h-title">${esc(h.title || h.url)}</span>
      <span class="h-url">${esc(h.url)}</span>
    </button></li>
  `).join('');
  list.querySelectorAll('button[data-url]').forEach((btn) => {
    btn.addEventListener('click', () => {
      api.openHistory(btn.dataset.url);
      $('history-panel').classList.add('hidden');
    });
  });
}

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

function escAttr(s) { return esc(s).replace(/"/g, '&quot;'); }

function applyState(state) {
  if (!state) return;
  renderTabs(state.tabs || []);
  const input = $('addr-input');
  if (document.activeElement !== input) input.value = state.url || '';
  $('btn-back').disabled = !state.canGoBack;
  $('btn-forward').disabled = !state.canGoForward;
  renderHistory(state.history || []);
}

$('addr-form').addEventListener('submit', (e) => {
  e.preventDefault();
  api.navigate($('addr-input').value.trim());
});

$('btn-back').onclick = () => api.back();
$('btn-forward').onclick = () => api.forward();
$('btn-reload').onclick = () => api.reload();
$('btn-home').onclick = () => api.home();
$('btn-new-tab').onclick = () => api.newTab();
$('btn-close-win').onclick = () => api.closeWindow();
$('btn-history').onclick = () => $('history-panel').classList.toggle('hidden');
$('btn-devtools').onclick = () => api.toggleDevTools?.();
$('btn-close-history').onclick = () => $('history-panel').classList.add('hidden');
$('btn-clear-history').onclick = () => api.clearHistory();

/* —— 环境信息面板 —— */
function envInfoRow(k, v, cls) {
  return `<tr><td class="k">${esc(k)}</td><td class="v${cls ? ' ' + cls : ''}">${v}</td></tr>`;
}
function envInfoSection(title, rows) {
  return `<div class="env-info-section"><h4>${esc(title)}</h4><table>${rows}</table></div>`;
}

function buildEnvInfoHtml(data) {
  const cfg = data.config || {};
  const live = data.live || {};
  const cfgProxy = cfg.proxyHost ? `${cfg.proxyHost}:${cfg.proxyPort || ''}` : '（未绑定）';

  const sections = [];

  // 1. 出口 / 地区
  const proxyRows = [
    envInfoRow('代理地址', cfgProxy),
    envInfoRow('代理类型', esc(cfg.proxyType || '—')),
    envInfoRow('国家/地区', esc(cfg.country || '—')),
    envInfoRow('配置时区', esc(cfg.timezone || '—')),
    envInfoRow('配置语言', esc(cfg.locale || '—')),
    envInfoRow('经纬度', cfg.latitude != null && cfg.longitude != null ? `${cfg.latitude}, ${cfg.longitude}` : '—'),
  ];
  sections.push(envInfoSection('① 出口 / 地区（按代理）', proxyRows.join('')));

  // 2. 站点实际读到的参数（风控判定依据）
  if (live.ok) {
    const liveRows = [
      envInfoRow('页面 URL', esc(live.url || '—')),
      envInfoRow('navigator.language', esc(live.language || '—')),
      envInfoRow('navigator.languages', esc(live.languages || '—')),
      envInfoRow('Intl 时区', esc(live.timezone || '—')),
      envInfoRow('时区偏移', live.tzOffsetMin != null ? `UTC${live.tzOffsetMin >= 0 ? '+' : ''}${live.tzOffsetMin / 60}h` : '—'),
      envInfoRow('本地时间', esc(live.localTime || '—')),
      envInfoRow('IP / 出口', esc(cfg.lastIp || '（未探测）')),
    ];
    sections.push(envInfoSection('② 站点实际读到', liveRows.join('')));
  }

  // 3. 浏览器指纹
  const fp = cfg.fp || {};
  const fpRows = [
    envInfoRow('User-Agent', esc(cfg.userAgent || (live.ok ? live.userAgent : '—'))),
    envInfoRow('平台', esc(fp.os || (live.ok ? live.platform : '—'))),
    envInfoRow('内核版本', esc(fp.coreVersion || '—')),
    envInfoRow('navigator.webdriver', live.ok ? (live.webdriver ? '<span class="warn">true（易被识别）</span>' : '<span class="ok">false</span>') : '—'),
    envInfoRow('硬件并发', live.ok ? esc(String(live.hardwareConcurrency)) : esc(fp.hardwareConcurrency != null ? String(fp.hardwareConcurrency) : '—')),
    envInfoRow('设备内存', live.ok ? esc(String(live.deviceMemory)) : esc(fp.deviceMemory != null ? String(fp.deviceMemory) : '—')),
    envInfoRow('屏幕 / 分辨率', live.ok ? esc(live.screen + ' / dpr ' + live.devicePixelRatio) : esc(fp.resolution || '—')),
    envInfoRow('WebGL 厂商', live.ok && live.webgl ? esc(live.webgl.vendor) : esc(fp.webglVendor || '—')),
    envInfoRow('WebGL 渲染器', live.ok && live.webgl ? esc(live.webgl.renderer) : esc(fp.webglRenderer || '—')),
  ];
  if (live.ok && live.uaData) {
    fpRows.push(
      envInfoRow('CH brands', esc(live.uaData.brands || '—')),
      envInfoRow('CH platform', esc(`${live.uaData.platform || '—'} ${live.uaData.platformVersion || ''}`.trim())),
      envInfoRow('CH mobile', esc(String(live.uaData.mobile))),
    );
  }
  sections.push(envInfoSection('③ 浏览器指纹', fpRows.join('')));

  return sections.join('');
}

let lastEnvInfo = null;
async function refreshEnvInfo() {
  const body = $('env-info-body');
  body.innerHTML = '<div class="muted">采集中…</div>';
  try {
    lastEnvInfo = await api.getEnvInfo();
    const html = buildEnvInfoHtml(lastEnvInfo || {});
    body.innerHTML = html || '<div class="muted">暂无数据</div>';
  } catch (e) {
    body.innerHTML = `<div class="muted">采集失败：${esc(String(e && e.message || e))}</div>`;
  }
}

function copyEnvInfo() {
  if (!lastEnvInfo) return;
  const cfg = lastEnvInfo.config || {};
  const live = lastEnvInfo.live || {};
  const lines = [];
  const push = (k, v) => lines.push(`${k}: ${v}`);
  push('代理地址', `${cfg.proxyHost || ''}:${cfg.proxyPort || ''}`);
  push('代理类型', cfg.proxyType || '');
  push('国家/地区', cfg.country || '');
  push('配置时区', cfg.timezone || '');
  push('配置语言', cfg.locale || '');
  push('经纬度', cfg.latitude != null ? `${cfg.latitude}, ${cfg.longitude}` : '');
  push('出口IP', cfg.lastIp || '');
  if (live.ok) {
    push('navigator.language', live.language || '');
    push('navigator.languages', live.languages || '');
    push('Intl时区', live.timezone || '');
    push('时区偏移', live.tzOffsetMin != null ? `UTC${live.tzOffsetMin >= 0 ? '+' : ''}${live.tzOffsetMin / 60}h` : '');
    push('本地时间', live.localTime || '');
    push('User-Agent', live.userAgent || '');
    push('webdriver', String(live.webdriver));
    push('硬件并发', live.hardwareConcurrency);
    push('设备内存', live.deviceMemory);
    push('屏幕', live.screen);
    push('dpr', live.devicePixelRatio);
    if (live.webgl) {
      push('WebGL厂商', live.webgl.vendor);
      push('WebGL渲染器', live.webgl.renderer);
    }
  }
  const text = lines.join('\n');
  navigator.clipboard?.writeText(text).then(() => {
    const btn = $('btn-copy-env-info');
    btn.textContent = '已复制';
    setTimeout(() => { btn.textContent = '复制'; }, 1200);
  }).catch(() => {});
}

$('btn-env-info').onclick = () => {
  const panel = $('env-info-panel');
  const hidden = panel.classList.toggle('hidden');
  if (!hidden) refreshEnvInfo();
};
$('btn-close-env-info').onclick = () => $('env-info-panel').classList.add('hidden');
$('btn-refresh-env-info').onclick = refreshEnvInfo;
$('btn-copy-env-info').onclick = copyEnvInfo;
// 工具栏也响应 F12（焦点在地址栏时）
window.addEventListener('keydown', (e) => {
  const key = e.key;
  const ctrl = e.ctrlKey || e.metaKey;
  if (key === 'F12' || (ctrl && e.shiftKey && ['I', 'J', 'C', 'i', 'j', 'c'].includes(key))) {
    e.preventDefault();
    api.toggleDevTools?.();
  }
});

api.onState(applyState);
api.ready();
