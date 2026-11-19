(() => {
  const POLL_MS = 4000;

  const state = {
    filter: 'active', // 'active' | 'all'
    query: '',
    data: null,
    expandedId: null,
    steps: 6,
    details: new Map(), // sessionId -> { loading, data, error }
    pollTimer: null,
  };

  const els = {
    livePill: document.getElementById('live-pill'),
    liveText: document.getElementById('live-text'),
    refreshBtn: document.getElementById('refresh-btn'),
    tabActive: document.getElementById('tab-active'),
    tabAll: document.getElementById('tab-all'),
    countActive: document.getElementById('count-active'),
    countAll: document.getElementById('count-all'),
    searchInput: document.getElementById('search-input'),
    summaryBar: document.getElementById('summary-bar'),
    list: document.getElementById('session-list'),
    toast: document.getElementById('toast'),
  };

  function syncThemeFromHost() {
    const bg = getComputedStyle(document.documentElement).getPropertyValue('--background').trim();
    if (!bg) return;
    const m = bg.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/i);
    if (m) {
      const lum = (0.299 * +m[1] + 0.587 * +m[2] + 0.114 * +m[3]) / 255;
      document.documentElement.setAttribute('data-theme', lum < 0.5 ? 'dark' : 'light');
    } else if (bg.startsWith('#') && bg.length >= 7) {
      const r = parseInt(bg.slice(1, 3), 16);
      const g = parseInt(bg.slice(3, 5), 16);
      const b = parseInt(bg.slice(5, 7), 16);
      const lum = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
      document.documentElement.setAttribute('data-theme', lum < 0.5 ? 'dark' : 'light');
    }
  }

  let toastTimer = null;
  function showToast(msg) {
    els.toast.textContent = msg;
    els.toast.classList.remove('hidden');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => els.toast.classList.add('hidden'), 1800);
  }

  function escapeHtml(str) {
    return String(str ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function fmtRelTime(ms) {
    if (!ms) return '-';
    const diff = Math.max(0, Math.floor((Date.now() - ms) / 1000));
    if (diff < 10) return '刚刚';
    if (diff < 60) return `${diff}s 前`;
    if (diff < 3600) return `${Math.floor(diff / 60)}m 前`;
    if (diff < 86400) return `${Math.floor(diff / 3600)}h 前`;
    return `${Math.floor(diff / 86400)}d 前`;
  }

  function fmtAbsTime(ms) {
    if (!ms) return '-';
    const d = new Date(ms);
    const pad = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
  }

  function fmtDuration(sec) {
    if (sec < 60) return `${sec}s`;
    const m = Math.floor(sec / 60);
    const s = sec % 60;
    return s ? `${m}m${s}s` : `${m}m`;
  }

  function shortPath(cwd) {
    if (!cwd) return '-';
    const parts = cwd.replace(/\\/g, '/').split('/').filter(Boolean);
    if (parts.length <= 2) return cwd;
    return `…/${parts.slice(-2).join('/')}`;
  }

  async function fetchSessions() {
    try {
      const res = await fetch('/api/sessions?limit=100&staleSec=300', { cache: 'no-store' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = await res.json();
      state.data = json;
      els.livePill.classList.remove('offline');
      els.liveText.textContent = 'Live';

      // Auto-fallback to "all" on initial load if no active sessions exist.
      if (state.filter === 'active' && json.runningCount === 0 && !state._userPickedFilter) {
        state.filter = 'all';
        updateFilterTabs();
      }
      render();
    } catch (err) {
      els.livePill.classList.add('offline');
      els.liveText.textContent = '离线';
      els.summaryBar.textContent = `获取会话失败：${err.message}`;
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

  function updateFilterTabs() {
    const isActive = state.filter === 'active';
    els.tabActive.classList.toggle('active', isActive);
    els.tabActive.setAttribute('aria-selected', String(isActive));
    els.tabAll.classList.toggle('active', !isActive);
    els.tabAll.setAttribute('aria-selected', String(!isActive));
  }

  function getVisibleSessions() {
    if (!state.data || !Array.isArray(state.data.sessions)) return [];
    let list = state.data.sessions;
    if (state.filter === 'active') {
      list = list.filter((s) => s.status === 'RUNNING' || s.status === 'STALLED');
    }
    const q = state.query.trim().toLowerCase();
    if (q) {
      list = list.filter((s) =>
        (s.title || '').toLowerCase().includes(q) ||
        (s.session_id || '').toLowerCase().includes(q) ||
        (s.cwd || '').toLowerCase().includes(q) ||
        (s.model || '').toLowerCase().includes(q),
      );
    }
    return list;
  }

  function renderDetail(sessionId) {
    const entry = state.details.get(sessionId);
    if (!entry || entry.loading) {
      return `
        <div class="detail-panel">
          <div class="detail-sid mono">${escapeHtml(sessionId)}</div>
          <div style="color: var(--dsh-fg-muted); font-size: 12px;">正在读取轨迹与巡检结果…</div>
        </div>`;
    }
    if (entry.error) {
      return `
        <div class="detail-panel">
          <div class="detail-sid mono">${escapeHtml(sessionId)}</div>
          <div class="error-banner">${escapeHtml(entry.error)}</div>
        </div>`;
    }

    const d = entry.data || {};
    let inspectHtml = '';
    if (d.inspectError) {
      inspectHtml = `<div class="error-banner">${escapeHtml(d.inspectError)}</div>`;
    } else if (d.inspect) {
      const findings = d.inspect.findings || [];
      if (findings.length === 0) {
        inspectHtml = `<div class="inspect-ok">OK：未发现卡死、报错或空结果假通过特征</div>`;
      } else {
        inspectHtml = findings.map((f) => `
          <div class="finding ${escapeHtml(f.level)}">
            <span class="finding-level">[${escapeHtml(f.level)}]</span>${escapeHtml(f.message)}
          </div>`).join('');
      }
    }

    let tailHtml = '';
    if (d.tailError) {
      tailHtml = `<div class="error-banner">${escapeHtml(d.tailError)}</div>`;
    } else if (d.tail) {
      const items = d.tail.items || [];
      if (items.length === 0) {
        tailHtml = `<div style="color: var(--dsh-fg-muted); font-size: 12px;">暂无可读轨迹事件</div>`;
      } else {
        tailHtml = `<div class="timeline">${items.slice().reverse().map((it) => {
          const tag = String(it.tag || '');
          const tagClass = tag.includes('reasoning') ? 'reasoning' : tag.includes('result') ? 'result' : '';
          return `
            <div class="step-item">
              <div class="step-head">
                <span class="step-tag ${tagClass} mono">${escapeHtml(tag)}</span>
                <span class="mono">#${escapeHtml(it.seq ?? '-')} · ${escapeHtml(it.ts || '')}</span>
              </div>
              <pre class="step-body">${escapeHtml(it.text || '')}</pre>
            </div>`;
        }).join('')}</div>`;
      }
    }

    return `
      <div class="detail-panel">
        <div class="detail-toolbar">
          <span class="detail-sid mono">${escapeHtml(sessionId)}</span>
          <div class="detail-controls">
            <select class="steps-select" data-action="steps" data-sid="${escapeHtml(sessionId)}" aria-label="显示步骤数">
              <option value="5" ${state.steps === 5 ? 'selected' : ''}>最近 5 步</option>
              <option value="6" ${state.steps === 6 ? 'selected' : ''}>最近 6 步</option>
              <option value="10" ${state.steps === 10 ? 'selected' : ''}>最近 10 步</option>
              <option value="20" ${state.steps === 20 ? 'selected' : ''}>最近 20 步</option>
            </select>
            <button type="button" class="mini-btn" data-action="reload-detail" data-sid="${escapeHtml(sessionId)}">刷新详情</button>
          </div>
        </div>
        <div class="inspect-box">
          <div class="section-label">异常巡检</div>
          ${inspectHtml}
        </div>
        <div>
          <div class="section-label">最近轨迹（最新在前）</div>
          ${tailHtml}
        </div>
      </div>`;
  }

  function render() {
    syncThemeFromHost();
    if (!state.data) return;

    els.countActive.textContent = String(state.data.runningCount ?? 0);
    els.countAll.textContent = String(state.data.totalCount ?? 0);

    const stalledNote = state.data.stalledCount > 0 ? ` · ${state.data.stalledCount} 个挂起预警` : '';
    els.summaryBar.innerHTML = `
      <span>运行中 ${state.data.runningCount} / 共 ${state.data.totalCount}${stalledNote}</span>
      <span>更新于 ${fmtAbsTime(state.data.updatedAt).slice(11)}</span>`;

    if (!state.data.exists) {
      els.list.innerHTML = `
        <div class="empty-state">
          <div class="empty-title">未找到 DeepSeek Harness 会话目录</div>
          <div class="mono" style="font-size:11px;">${escapeHtml(state.data.dshDir)}</div>
        </div>`;
      return;
    }

    const sessions = getVisibleSessions();
    if (sessions.length === 0) {
      const hint = state.filter === 'active'
        ? '当前没有运行中的 DeepSeek Harness 会话，可切换到「全部」查看历史会话。'
        : '没有匹配的会话。';
      els.list.innerHTML = `
        <div class="empty-state">
          <div class="empty-title">暂无会话</div>
          <div>${hint}</div>
        </div>`;
      return;
    }

    els.list.innerHTML = sessions.map((s) => {
      const expanded = state.expandedId === s.session_id;
      const statusLower = s.status.toLowerCase();
      const statusLabel = s.status === 'STALLED' ? '挂起预警' : s.status === 'RUNNING' ? 'RUNNING' : 'IDLE';
      const pendingBadge = s.pending_count > 0
        ? `<span class="pill ${s.status === 'STALLED' ? 'warn' : ''}">pending=${s.pending_count} (${fmtDuration(s.max_pending_sec)})</span>`
        : '';

      return `
        <article class="card ${expanded ? 'expanded' : ''}" data-sid="${escapeHtml(s.session_id)}">
          <div class="card-head" data-action="toggle" data-sid="${escapeHtml(s.session_id)}">
            <div class="card-row-top">
              <div class="card-title-wrap">
                <span class="status-dot ${statusLower}" aria-hidden="true"></span>
                <span class="card-title" title="${escapeHtml(s.title || s.session_id)}">${escapeHtml(s.title || '(无标题)')}</span>
              </div>
              <span class="status-tag ${statusLower}">${statusLabel}</span>
            </div>
            <div class="card-meta">
              ${s.model ? `<span class="pill mono">${escapeHtml(s.model)}</span>` : ''}
              <span>turn ${s.turns} · steps ${s.steps}</span>
              ${pendingBadge}
              <span title="${fmtAbsTime(s.mtime_ms)}">${fmtRelTime(s.mtime_ms)}</span>
            </div>
            <div class="card-footer">
              <span class="cwd-text mono" title="${escapeHtml(s.cwd)}">${escapeHtml(shortPath(s.cwd))}</span>
              <div class="card-actions">
                <button type="button" class="mini-btn" data-action="copy-id" data-sid="${escapeHtml(s.session_id)}" title="复制会话 ID">复制 ID</button>
              </div>
            </div>
          </div>
          ${expanded ? renderDetail(s.session_id) : ''}
        </article>`;
    }).join('');
  }

  // Event listeners
  els.tabActive.addEventListener('click', () => {
    state.filter = 'active';
    state._userPickedFilter = true;
    updateFilterTabs();
    render();
  });

  els.tabAll.addEventListener('click', () => {
    state.filter = 'all';
    state._userPickedFilter = true;
    updateFilterTabs();
    render();
  });

  els.searchInput.addEventListener('input', (e) => {
    state.query = e.target.value || '';
    render();
  });

  els.refreshBtn.addEventListener('click', () => {
    fetchSessions();
    if (state.expandedId) fetchDetail(state.expandedId);
  });

  els.list.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-action]');
    if (!btn) return;
    const action = btn.dataset.action;
    const sid = btn.dataset.sid;

    if (action === 'copy-id') {
      e.stopPropagation();
      navigator.clipboard?.writeText(sid).then(
        () => showToast('已复制会话 ID'),
        () => showToast(sid),
      );
      return;
    }

    if (action === 'reload-detail') {
      e.stopPropagation();
      fetchDetail(sid);
      return;
    }

    if (action === 'toggle') {
      if (state.expandedId === sid) {
        state.expandedId = null;
        render();
      } else {
        state.expandedId = sid;
        fetchDetail(sid);
      }
    }
  });

  els.list.addEventListener('change', (e) => {
    const sel = e.target.closest('select[data-action="steps"]');
    if (!sel) return;
    state.steps = Number(sel.value) || 6;
    fetchDetail(sel.dataset.sid);
  });

  // Watch theme mutations synced by preload.js
  new MutationObserver(syncThemeFromHost).observe(document.documentElement, {
    attributes: true,
    attributeFilter: ['style', 'class', 'data-theme'],
  });

  syncThemeFromHost();
  fetchSessions();
  state.pollTimer = setInterval(fetchSessions, POLL_MS);
})();
