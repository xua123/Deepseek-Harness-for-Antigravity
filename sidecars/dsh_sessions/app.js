(() => {
  const POLL_MS = 4000;
  const PIN_STORAGE_KEY = 'dsh_monitor_pinned_sessions_v1';

  function loadPinned() {
    try {
      const arr = JSON.parse(localStorage.getItem(PIN_STORAGE_KEY) || '[]');
      return new Set(Array.isArray(arr) ? arr : []);
    } catch {
      return new Set();
    }
  }

  function savePinned(set) {
    try {
      localStorage.setItem(PIN_STORAGE_KEY, JSON.stringify([...set]));
    } catch {
      // Ignore storage errors in sandboxed iframes.
    }
  }

  const state = {
    activeOnly: false,
    searchOpen: false,
    query: '',
    data: null,
    selectedId: null,
    steps: 6,
    collapsedCategories: new Set(),
    collapsedWorkspaces: new Set(),
    pinned: loadPinned(),
    details: new Map(),
  };

  const els = {
    liveDot: document.getElementById('live-dot'),
    btnSearch: document.getElementById('btn-search'),
    btnFilter: document.getElementById('btn-filter'),
    btnRefresh: document.getElementById('btn-refresh'),
    searchWrap: document.getElementById('search-wrap'),
    searchInput: document.getElementById('search-input'),
    tree: document.getElementById('tree'),
    toast: document.getElementById('toast'),
  };

  function syncThemeFromHost() {
    const bg = getComputedStyle(document.documentElement).getPropertyValue('--background').trim();
    if (!bg) return;
    let r = 24, g = 24, b = 24;
    const m = bg.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/i);
    if (m) {
      r = +m[1]; g = +m[2]; b = +m[3];
    } else if (bg.startsWith('#') && bg.length >= 7) {
      r = parseInt(bg.slice(1, 3), 16);
      g = parseInt(bg.slice(3, 5), 16);
      b = parseInt(bg.slice(5, 7), 16);
    } else {
      return;
    }
    const lum = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
    document.documentElement.setAttribute('data-theme', lum < 0.5 ? 'dark' : 'light');
  }

  let toastTimer = null;
  function showToast(msg) {
    els.toast.textContent = msg;
    els.toast.classList.remove('hidden');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => els.toast.classList.add('hidden'), 1600);
  }

  function esc(str) {
    return String(str ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function fmtRel(ms) {
    if (!ms) return '';
    const diff = Math.max(0, Math.floor((Date.now() - ms) / 1000));
    if (diff < 60) return '刚刚';
    if (diff < 3600) return `${Math.floor(diff / 60)}分钟`;
    if (diff < 86400) return `${Math.floor(diff / 3600)}小时`;
    return `${Math.floor(diff / 86400)}天`;
  }

  function fmtDuration(sec) {
    if (sec < 60) return `${sec}s`;
    const m = Math.floor(sec / 60);
    const s = sec % 60;
    return s ? `${m}m${s}s` : `${m}m`;
  }

  /**
   * Convert a raw cwd path into a clean workspace label matching DSH sidebar style.
   * Examples:
   *   .../remote-workspaces/172.18.21.163-junhong.pan-22/junhong.pan -> 172.18.21.163-junhong.pan
   *   C:\Users\...\Desktop\临商银行项目 -> 临商银行项目
   */
  function workspaceLabel(cwd) {
    if (!cwd) return '临时';
    const norm = cwd.replace(/\\/g, '/').replace(/\/+$/, '');
    if (/\/default-workspace$/i.test(norm)) return '临时';
    const remoteMatch = norm.match(/remote-workspaces\/([^/]+)(?:\/(.+))?$/i);
    if (remoteMatch) {
      const hostSlug = remoteMatch[1].replace(/-\d+$/, '');
      const sub = remoteMatch[2];
      if (!sub || hostSlug.endsWith(sub)) return hostSlug;
      return `${hostSlug}-/${sub}`;
    }
    const parts = norm.split('/').filter(Boolean);
    return parts[parts.length - 1] || cwd;
  }

  function folderSvg() {
    return `<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.35" stroke-linejoin="round">
      <path d="M2 4.2A1.2 1.2 0 0 1 3.2 3h3l1.3 1.4h5.3A1.2 1.2 0 0 1 14 5.6v6.2a1.2 1.2 0 0 1-1.2 1.2H3.2A1.2 1.2 0 0 1 2 11.8V4.2z"></path>
    </svg>`;
  }

  function copySvg() {
    return `<svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round">
      <rect x="5.5" y="5.5" width="7.5" height="7.5" rx="1.2"></rect>
      <path d="M10.5 5.5V3.8A1.3 1.3 0 0 0 9.2 2.5H3.8A1.3 1.3 0 0 0 2.5 3.8v5.4a1.3 1.3 0 0 0 1.3 1.3h1.7"></path>
    </svg>`;
  }

  function pinSvg() {
    return `<svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round">
      <path d="M5.5 3h5l-.8 4 2 2H4.3l2-2-.8-4z"></path>
      <path d="M8 9v4.5"></path>
    </svg>`;
  }

  function moreSvg() {
    return `<svg viewBox="0 0 16 16" width="13" height="13" fill="currentColor">
      <circle cx="3.5" cy="8" r="1.1"></circle>
      <circle cx="8" cy="8" r="1.1"></circle>
      <circle cx="12.5" cy="8" r="1.1"></circle>
    </svg>`;
  }

  async function fetchSessions() {
    try {
      const res = await fetch('/api/sessions?limit=150&staleSec=300', { cache: 'no-store' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      state.data = await res.json();
      els.liveDot.classList.remove('offline');
      els.liveDot.title = `每 4 秒自动刷新 · 运行中 ${state.data.runningCount} / 共 ${state.data.totalCount}`;
      render();
    } catch (err) {
      els.liveDot.classList.add('offline');
      els.liveDot.title = `连接失败：${err.message}`;
    }
  }

  async function fetchDetail(sessionId) {
    state.details.set(sessionId, { loading: true, data: null, error: null });
    render();
    try {
      const url = `/api/session/detail?session=${encodeURIComponent(sessionId)}&steps=${state.steps}&staleSec=300`;
      const res = await fetch(url, { cache: 'no-store' });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || `HTTP ${res.status}`);
      state.details.set(sessionId, { loading: false, data: json, error: null });
    } catch (err) {
      state.details.set(sessionId, { loading: false, data: null, error: err.message });
    }
    render();
  }

  function buildGroups() {
    if (!state.data || !Array.isArray(state.data.sessions)) return [];
    const q = state.query.trim().toLowerCase();
    const groupsMap = new Map();

    for (const s of state.data.sessions) {
      const isRunning = s.status === 'RUNNING' || s.status === 'STALLED';
      if (state.activeOnly && !isRunning) continue;

      const wsName = workspaceLabel(s.cwd);
      if (q) {
        const hit =
          wsName.toLowerCase().includes(q) ||
          (s.title || '').toLowerCase().includes(q) ||
          (s.session_id || '').toLowerCase().includes(q) ||
          (s.cwd || '').toLowerCase().includes(q) ||
          (s.model || '').toLowerCase().includes(q);
        if (!hit) continue;
      }

      const key = s.cwd || '__temp__';
      if (!groupsMap.has(key)) {
        groupsMap.set(key, {
          key,
          label: wsName,
          cwd: s.cwd || '',
          sessions: [],
          hasActive: false,
          latestMtime: 0,
        });
      }
      const g = groupsMap.get(key);
      g.sessions.push(s);
      if (isRunning) g.hasActive = true;
      if (s.mtime_ms > g.latestMtime) g.latestMtime = s.mtime_ms;
    }

    const groups = [...groupsMap.values()];
    for (const g of groups) {
      g.sessions.sort((a, b) => {
        const pa = state.pinned.has(a.session_id) ? 1 : 0;
        const pb = state.pinned.has(b.session_id) ? 1 : 0;
        if (pa !== pb) return pb - pa;
        return b.mtime_ms - a.mtime_ms;
      });
    }
    groups.sort((a, b) => {
      if (a.hasActive !== b.hasActive) return a.hasActive ? -1 : 1;
      return b.latestMtime - a.latestMtime;
    });
    return groups;
  }

  function renderDetail(s) {
    const entry = state.details.get(s.session_id);
    const pendingTag = s.pending_count > 0
      ? `<span class="tag ${s.status === 'STALLED' ? 'warn' : ''}">pending ${s.pending_count} (${fmtDuration(s.max_pending_sec)})</span>`
      : '';

    let bodyHtml = '';
    if (!entry || entry.loading) {
      bodyHtml = `<div style="color:var(--fg-muted);font-size:11.5px;">正在加载轨迹与巡检…</div>`;
    } else if (entry.error) {
      bodyHtml = `<div class="error-msg">${esc(entry.error)}</div>`;
    } else {
      const d = entry.data || {};
      let inspectHtml = '';
      if (d.inspectError) {
        inspectHtml = `<div class="error-msg">${esc(d.inspectError)}</div>`;
      } else if (d.inspect) {
        const findings = d.inspect.findings || [];
        inspectHtml = findings.length === 0
          ? `<div class="inspect-ok">巡检正常 · 无卡死或报错</div>`
          : findings.map((f) => `<div class="finding ${esc(f.level)}"><b>[${esc(f.level)}]</b> ${esc(f.message)}</div>`).join('');
      }

      let tailHtml = '';
      if (d.tailError) {
        tailHtml = `<div class="error-msg">${esc(d.tailError)}</div>`;
      } else if (d.tail) {
        const items = d.tail.items || [];
        tailHtml = items.length === 0
          ? `<div style="color:var(--fg-muted);font-size:11.5px;">暂无轨迹事件</div>`
          : `<div class="timeline">${items.slice().reverse().map((it) => {
              const tag = String(it.tag || '');
              const cls = tag.includes('reasoning') ? 'reasoning' : tag.includes('result') ? 'result' : '';
              return `
                <div class="step-row">
                  <div class="step-head">
                    <span class="step-tag ${cls} mono">${esc(tag)}</span>
                    <span class="mono">#${esc(it.seq ?? '-')}</span>
                  </div>
                  <pre class="step-text">${esc(it.text || '')}</pre>
                </div>`;
            }).join('')}</div>`;
      }
      bodyHtml = `${inspectHtml}${tailHtml}`;
    }

    return `
      <div class="detail-box">
        <div class="detail-meta">
          <div class="detail-meta-left">
            ${s.model ? `<span class="tag mono">${esc(s.model)}</span>` : ''}
            <span>turn ${s.turns} · steps ${s.steps}</span>
            ${pendingTag}
          </div>
          <div class="detail-controls">
            <select class="steps-select" data-action="steps" data-sid="${esc(s.session_id)}">
              <option value="5" ${state.steps === 5 ? 'selected' : ''}>5步</option>
              <option value="6" ${state.steps === 6 ? 'selected' : ''}>6步</option>
              <option value="10" ${state.steps === 10 ? 'selected' : ''}>10步</option>
              <option value="20" ${state.steps === 20 ? 'selected' : ''}>20步</option>
            </select>
            <button type="button" class="mini-link" data-action="reload-detail" data-sid="${esc(s.session_id)}">刷新</button>
          </div>
        </div>
        ${bodyHtml}
      </div>`;
  }

  function renderIndicator(s) {
    if (s.status === 'STALLED') {
      return `<span class="dot stalled" title="挂起已超过 ${fmtDuration(s.max_pending_sec)}"></span>`;
    }
    if (s.status === 'RUNNING') {
      return `<span class="spinner" title="运行中"></span>`;
    }
    if (state.pinned.has(s.session_id)) {
      return `<span class="dot pinned" title="已置顶"></span>`;
    }
    return '';
  }

  function chevronSvg() {
    return `<svg viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">
      <path d="M4.5 6.2L8 9.8l3.5-3.6"></path>
    </svg>`;
  }

  function renderWorkspaceGroup(g) {
    const collapsed = state.collapsedWorkspaces.has(g.key);
    const rowsHtml = collapsed ? '' : g.sessions.map((s) => {
      const selected = state.selectedId === s.session_id;
      const isPinned = state.pinned.has(s.session_id);
      const cls = [
        'sess-row',
        selected ? 'selected' : '',
        s.status === 'RUNNING' ? 'is-running' : '',
        s.status === 'STALLED' ? 'is-stalled' : '',
      ].filter(Boolean).join(' ');

      return `
        <div class="${cls}" data-action="toggle-session" data-sid="${esc(s.session_id)}" title="${esc(s.title || s.session_id)}">
          <span class="sess-indicator">${renderIndicator(s)}</span>
          <span class="sess-title">${esc(s.title || '(无标题)')}</span>
          <span class="sess-time">${fmtRel(s.mtime_ms)}</span>
          <span class="sess-hover-actions">
            <button type="button" class="row-btn" data-action="toggle-session" data-sid="${esc(s.session_id)}" title="查看轨迹与巡检">${moreSvg()}</button>
            <button type="button" class="row-btn" data-action="copy-id" data-sid="${esc(s.session_id)}" title="复制会话 ID">${copySvg()}</button>
            <button type="button" class="row-btn ${isPinned ? 'pinned' : ''}" data-action="pin" data-sid="${esc(s.session_id)}" title="${isPinned ? '取消置顶' : '置顶'}">${pinSvg()}</button>
          </span>
        </div>
        ${selected ? renderDetail(s) : ''}`;
    }).join('');

    return `
      <section class="ws-group ${g.hasActive ? 'has-active' : ''}">
        <div class="ws-row" data-action="toggle-ws" data-ws="${esc(g.key)}" title="${esc(g.cwd || g.label)}">
          <span class="ws-icon">${folderSvg()}</span>
          <span class="ws-name">${esc(g.label)}</span>
          <span class="ws-count">${g.sessions.length}</span>
        </div>
        <div class="ws-children">${rowsHtml}</div>
      </section>`;
  }

  function renderCategory(id, title, dotClass, groups, emptyText) {
    const collapsed = state.collapsedCategories.has(id);
    const bodyHtml = collapsed
      ? ''
      : groups.length === 0
        ? `<div class="cat-empty">${emptyText}</div>`
        : groups.map(renderWorkspaceGroup).join('');

    return `
      <div class="cat-section ${collapsed ? 'collapsed' : ''}">
        <div class="cat-header" data-action="toggle-cat" data-cat="${id}">
          <span class="cat-chevron">${chevronSvg()}</span>
          <span class="cat-dot ${dotClass}"></span>
          <span class="cat-title">${title}</span>
          <span class="cat-count">${groups.length}</span>
        </div>
        ${bodyHtml}
      </div>`;
  }

  function render() {
    syncThemeFromHost();
    if (!state.data) return;

    if (!state.data.exists) {
      els.tree.innerHTML = `<div class="empty-state">未找到 DeepSeek Harness 数据目录<br><span class="mono" style="font-size:11px;">${esc(state.data.dshDir)}</span></div>`;
      return;
    }

    const groups = buildGroups();
    if (groups.length === 0) {
      els.tree.innerHTML = `<div class="empty-state">${state.activeOnly ? '当前没有运行中的会话' : '没有匹配的会话'}</div>`;
      return;
    }

    const workingGroups = groups.filter((g) => g.hasActive);
    const stoppedGroups = groups.filter((g) => !g.hasActive);

    const sections = [
      renderCategory('working', '工作目录', 'active', workingGroups, '暂无运行中的目录'),
    ];
    if (!state.activeOnly) {
      sections.push(renderCategory('stopped', '停止目录', 'stopped', stoppedGroups, '暂无已停止的目录'));
    }
    els.tree.innerHTML = sections.join('');
  }

  els.btnSearch.addEventListener('click', () => {
    state.searchOpen = !state.searchOpen;
    els.btnSearch.classList.toggle('active', state.searchOpen);
    els.searchWrap.classList.toggle('hidden', !state.searchOpen);
    if (state.searchOpen) {
      els.searchInput.focus();
    } else if (state.query) {
      state.query = '';
      els.searchInput.value = '';
      render();
    }
  });

  els.btnFilter.addEventListener('click', () => {
    state.activeOnly = !state.activeOnly;
    els.btnFilter.classList.toggle('active', state.activeOnly);
    els.btnFilter.setAttribute('aria-pressed', String(state.activeOnly));
    els.btnFilter.title = state.activeOnly ? '当前：仅看运行中（点击查看全部）' : '仅看运行中';
    render();
  });

  els.btnRefresh.addEventListener('click', () => {
    fetchSessions();
    if (state.selectedId) fetchDetail(state.selectedId);
    showToast('已刷新');
  });

  els.searchInput.addEventListener('input', (e) => {
    state.query = e.target.value || '';
    render();
  });

  els.tree.addEventListener('click', (e) => {
    const el = e.target.closest('[data-action]');
    if (!el) return;
    const action = el.dataset.action;

    if (action === 'toggle-cat') {
      const cat = el.dataset.cat;
      if (state.collapsedCategories.has(cat)) state.collapsedCategories.delete(cat);
      else state.collapsedCategories.add(cat);
      render();
      return;
    }

    if (action === 'toggle-ws') {
      const key = el.dataset.ws;
      if (state.collapsedWorkspaces.has(key)) state.collapsedWorkspaces.delete(key);
      else state.collapsedWorkspaces.add(key);
      render();
      return;
    }

    const sid = el.dataset.sid;
    if (action === 'copy-id') {
      e.stopPropagation();
      navigator.clipboard?.writeText(sid).then(
        () => showToast('已复制会话 ID'),
        () => showToast(sid),
      );
      return;
    }

    if (action === 'pin') {
      e.stopPropagation();
      if (state.pinned.has(sid)) state.pinned.delete(sid);
      else state.pinned.add(sid);
      savePinned(state.pinned);
      render();
      return;
    }

    if (action === 'reload-detail') {
      e.stopPropagation();
      fetchDetail(sid);
      return;
    }

    if (action === 'toggle-session') {
      e.stopPropagation();
      if (state.selectedId === sid) {
        state.selectedId = null;
        render();
      } else {
        state.selectedId = sid;
        fetchDetail(sid);
      }
    }
  });

  els.tree.addEventListener('change', (e) => {
    const sel = e.target.closest('select[data-action="steps"]');
    if (!sel) return;
    state.steps = Number(sel.value) || 6;
    fetchDetail(sel.dataset.sid);
  });

  new MutationObserver(syncThemeFromHost).observe(document.documentElement, {
    attributes: true,
    attributeFilter: ['style', 'class', 'data-theme'],
  });

  syncThemeFromHost();
  fetchSessions();
  setInterval(fetchSessions, POLL_MS);
})();
