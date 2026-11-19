(() => {
  const vscode = acquireVsCodeApi();

  const state = {
    monitoring: true,
    activeOnly: false,
    searchOpen: false,
    query: '',
    data: null,
    selectedId: null,
    lastCount: 8,
    collapsedCategories: new Set(),
    collapsedWorkspaces: new Set(),
    pinned: new Set(),
    details: new Map(),
    drafts: new Map(), // sessionId -> draft message
  };

  const els = {
    liveDot: document.getElementById('live-dot'),
    pausedLabel: document.getElementById('paused-label'),
    btnSearch: document.getElementById('btn-search'),
    btnFilter: document.getElementById('btn-filter'),
    btnRefresh: document.getElementById('btn-refresh'),
    btnMonitor: document.getElementById('btn-monitor'),
    searchWrap: document.getElementById('search-wrap'),
    searchInput: document.getElementById('search-input'),
    tree: document.getElementById('tree'),
    toast: document.getElementById('toast'),
  };

  function updateMonitorUi() {
    const on = state.monitoring;
    els.liveDot.classList.toggle('paused', !on);
    els.pausedLabel.classList.toggle('hidden', on);
    els.btnMonitor.classList.toggle('paused', !on);
    els.btnMonitor.setAttribute('aria-pressed', String(on));
    els.btnMonitor.title = on ? '关闭监控' : '开启监控';
    els.btnMonitor.setAttribute('aria-label', on ? '关闭监控' : '开启监控');
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

  function workspaceLabel(s) {
    if (s.workspace_title) return s.workspace_title;
    const cwd = s.cwd || '';
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

  function chevronSvg() {
    return `<svg viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">
      <path d="M4.5 6.2L8 9.8l3.5-3.6"></path>
    </svg>`;
  }

  function requestDetail(sessionId) {
    state.details.set(sessionId, { loading: true, data: null, error: null });
    render();
    vscode.postMessage({ type: 'detail', sessionId, last: state.lastCount });
  }

  function buildCategorizedGroups() {
    if (!state.data || !Array.isArray(state.data.sessions)) {
      return { workingGroups: [], stoppedGroups: [] };
    }
    const q = state.query.trim().toLowerCase();
    const workingMap = new Map();
    const stoppedMap = new Map();

    const addToMap = (map, s, wsName, isRunning) => {
      const key = `${isRunning ? 'w:' : 's:'}${s.cwd || '__temp__'}`;
      if (!map.has(key)) {
        map.set(key, {
          key,
          label: wsName,
          cwd: s.cwd || '',
          sessions: [],
          hasActive: isRunning,
          latestMtime: 0,
        });
      }
      const g = map.get(key);
      g.sessions.push(s);
      if (s.mtime_ms > g.latestMtime) g.latestMtime = s.mtime_ms;
    };

    for (const s of state.data.sessions) {
      const isRunning = Boolean(s.running);
      if (state.activeOnly && !isRunning) continue;

      const wsName = workspaceLabel(s);
      if (q) {
        const hit =
          wsName.toLowerCase().includes(q) ||
          (s.title || '').toLowerCase().includes(q) ||
          (s.session_id || '').toLowerCase().includes(q) ||
          (s.cwd || '').toLowerCase().includes(q) ||
          (s.model || '').toLowerCase().includes(q);
        if (!hit) continue;
      }

      if (isRunning) addToMap(workingMap, s, wsName, true);
      else addToMap(stoppedMap, s, wsName, false);
    }

    const finalize = (map) => {
      const list = [...map.values()];
      for (const g of list) {
        g.sessions.sort((a, b) => {
          const pa = state.pinned.has(a.session_id) ? 1 : 0;
          const pb = state.pinned.has(b.session_id) ? 1 : 0;
          if (pa !== pb) return pb - pa;
          return b.mtime_ms - a.mtime_ms;
        });
      }
      list.sort((a, b) => b.latestMtime - a.latestMtime);
      return list;
    };

    return {
      workingGroups: finalize(workingMap),
      stoppedGroups: finalize(stoppedMap),
    };
  }

  function renderIndicator(s) {
    if (s.running) {
      return `<span class="spinner" title="运行中"></span>`;
    }
    if (state.pinned.has(s.session_id)) {
      return `<span class="dot pinned" title="已置顶"></span>`;
    }
    return '';
  }

  function summarizeMessage(m) {
    const text = (m.text || '').trim();
    if (text) return text.length > 360 ? `${text.slice(0, 360)}…` : text;
    if (Array.isArray(m.tools) && m.tools.length > 0) {
      return `调用工具: ${m.tools.join(', ')}`;
    }
    return '(空)';
  }

  function renderDetail(s) {
    const entry = state.details.get(s.session_id);
    const draft = state.drafts.get(s.session_id) || '';

    let bodyHtml = '';
    if (!entry || entry.loading) {
      bodyHtml = `<div style="color:var(--fg-muted);font-size:11.5px;">正在通过 dsh-baton 获取状态…</div>`;
    } else if (entry.error) {
      bodyHtml = `<div class="error-msg">${esc(entry.error)}</div>`;
    } else {
      const d = entry.data || {};
      const status = d.status || {};
      const actList = Array.isArray(status.activity) ? status.activity : [];
      const jobLabels = [];
      for (const act of actList) {
        if (act && Array.isArray(act.items)) {
          for (const it of act.items) {
            if (it && it.label) jobLabels.push(it.label);
          }
        }
      }

      const actHtml = jobLabels.length > 0
        ? `<div class="baton-act"><span class="eng-icon running">⟳</span><span class="baton-act-text">${esc(jobLabels[0].slice(0, 140))}</span></div>`
        : status.turn_running
          ? `<div class="baton-act"><span class="eng-icon running">⟳</span><span class="baton-act-text">正在执行当前轮次…</span></div>`
          : '';

      const msgs = ((d.messages && Array.isArray(d.messages.messages)) ? d.messages.messages : []).filter(
        (m) => (m.text && m.text.trim()) || (Array.isArray(m.tools) && m.tools.length > 0),
      );
      const msgsHtml = msgs.length === 0
        ? `<div style="color:var(--fg-muted);font-size:11.5px;">暂无会话消息</div>`
        : `<ol class="eng-list">${msgs.slice().reverse().map((m) => `
            <li class="eng-step">
              <div class="eng-row">
                <span class="eng-phase">${m.role === 'user' ? '指令' : 'DSH'}</span>
                <span class="eng-title">${esc(summarizeMessage(m))}</span>
              </div>
            </li>`).join('')}</ol>`;

      bodyHtml = `${actHtml}${msgsHtml}`;
    }

    return `
      <div class="detail-box">
        <div class="detail-meta">
          <div class="detail-meta-left">
            ${s.model ? `<span class="tag mono">${esc(s.model)}</span>` : ''}
            <span>${s.running ? '运行中' : '空闲'}</span>
          </div>
          <div class="detail-controls">
            <select class="steps-select" data-action="last" data-sid="${esc(s.session_id)}">
              <option value="4" ${state.lastCount === 4 ? 'selected' : ''}>4条</option>
              <option value="8" ${state.lastCount === 8 ? 'selected' : ''}>8条</option>
              <option value="15" ${state.lastCount === 15 ? 'selected' : ''}>15条</option>
            </select>
            ${s.running ? `<button type="button" class="mini-link danger" data-action="cancel-session" data-sid="${esc(s.session_id)}">中断</button>` : ''}
            <button type="button" class="mini-link" data-action="reload-detail" data-sid="${esc(s.session_id)}">刷新</button>
          </div>
        </div>
        ${bodyHtml}
        <div class="send-box">
          <input type="text" class="send-input" data-action="draft-input" data-sid="${esc(s.session_id)}" value="${esc(draft)}" placeholder="${s.running ? '运行中可发送纠偏/排队指令…' : '向该会话发送新指令…'}">
          <button type="button" class="send-btn" data-action="send-msg" data-sid="${esc(s.session_id)}">发送</button>
        </div>
      </div>`;
  }

  function renderWorkspaceGroup(g) {
    const collapsed = state.collapsedWorkspaces.has(g.key);
    const rowsHtml = collapsed ? '' : g.sessions.map((s) => {
      const selected = state.selectedId === s.session_id;
      const isPinned = state.pinned.has(s.session_id);
      const cls = [
        'sess-row',
        selected ? 'selected' : '',
        s.running ? 'is-running' : '',
      ].filter(Boolean).join(' ');

      return `
        <div class="${cls}" data-action="toggle-session" data-sid="${esc(s.session_id)}" title="${esc(s.title || s.session_id)}">
          <span class="sess-indicator">${renderIndicator(s)}</span>
          <span class="sess-title">${esc(s.title || '新会话')}</span>
          <span class="sess-time">${fmtRel(s.mtime_ms)}</span>
          <span class="sess-hover-actions">
            <button type="button" class="row-btn" data-action="toggle-session" data-sid="${esc(s.session_id)}" title="查看与发送指令">${moreSvg()}</button>
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
    updateMonitorUi();
    if (!state.monitoring) {
      els.liveDot.title = '监控已关闭';
      els.tree.innerHTML = `
        <div class="empty-state">
          <div>监控已关闭，已停止后台轮询</div>
          <button type="button" class="resume-btn" data-action="resume-monitor">开启监控</button>
        </div>`;
      return;
    }
    if (!state.data) {
      els.tree.innerHTML = `<div class="empty-state">正在连接 dsh-baton…</div>`;
      return;
    }

    els.liveDot.title = `每 4 秒通过 dsh-baton 刷新 · 运行中 ${state.data.runningCount} / 共 ${state.data.totalCount}`;

    if (!state.data.exists) {
      els.tree.innerHTML = `<div class="empty-state">${esc(state.data.error || 'dsh-baton 不可用')}</div>`;
      return;
    }

    const { workingGroups, stoppedGroups } = buildCategorizedGroups();
    if (workingGroups.length === 0 && stoppedGroups.length === 0) {
      els.tree.innerHTML = `<div class="empty-state">${state.activeOnly ? '当前没有运行中的会话' : '没有匹配的会话'}</div>`;
      return;
    }

    const sections = [
      renderCategory('working', '工作目录', 'active', workingGroups, '暂无正在工作的会话'),
    ];
    if (!state.activeOnly) {
      sections.push(renderCategory('stopped', '停止目录', 'stopped', stoppedGroups, '暂无已停止的目录'));
    }
    els.tree.innerHTML = sections.join('');
  }

  window.addEventListener('message', (event) => {
    const msg = event.data;
    if (!msg || typeof msg !== 'object') return;
    if (msg.type === 'sessions') {
      state.data = msg.data;
      if (typeof msg.monitoring === 'boolean') state.monitoring = msg.monitoring;
      if (Array.isArray(msg.pinned)) state.pinned = new Set(msg.pinned);
      render();
    } else if (msg.type === 'monitoring') {
      state.monitoring = Boolean(msg.enabled);
      render();
    } else if (msg.type === 'pinned') {
      state.pinned = new Set(Array.isArray(msg.pinned) ? msg.pinned : []);
      render();
    } else if (msg.type === 'detail') {
      state.details.set(msg.sessionId, {
        loading: false,
        data: msg.data || null,
        error: msg.error || null,
      });
      render();
    } else if (msg.type === 'toast') {
      showToast(msg.message);
    }
  });

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
    vscode.postMessage({ type: 'refresh' });
    if (state.selectedId) requestDetail(state.selectedId);
    showToast('已刷新');
  });

  els.btnMonitor.addEventListener('click', () => {
    vscode.postMessage({ type: 'toggleMonitoring' });
  });

  els.searchInput.addEventListener('input', (e) => {
    state.query = e.target.value || '';
    render();
  });

  els.tree.addEventListener('input', (e) => {
    const inp = e.target.closest('input[data-action="draft-input"]');
    if (inp) {
      state.drafts.set(inp.dataset.sid, inp.value);
    }
  });

  els.tree.addEventListener('keydown', (e) => {
    const inp = e.target.closest('input[data-action="draft-input"]');
    if (inp && e.key === 'Enter' && !e.isComposing) {
      e.preventDefault();
      const sid = inp.dataset.sid;
      const text = (inp.value || '').trim();
      if (!text) return;
      state.drafts.set(sid, '');
      vscode.postMessage({ type: 'sendMessage', sessionId: sid, message: text });
    }
  });

  els.tree.addEventListener('click', (e) => {
    const el = e.target.closest('[data-action]');
    if (!el) return;
    const action = el.dataset.action;

    if (action === 'draft-input') {
      e.stopPropagation();
      return;
    }

    if (action === 'resume-monitor') {
      vscode.postMessage({ type: 'toggleMonitoring' });
      return;
    }

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
      vscode.postMessage({ type: 'copyId', sessionId: sid });
      return;
    }

    if (action === 'pin') {
      e.stopPropagation();
      vscode.postMessage({ type: 'togglePin', sessionId: sid });
      return;
    }

    if (action === 'reload-detail') {
      e.stopPropagation();
      requestDetail(sid);
      return;
    }

    if (action === 'cancel-session') {
      e.stopPropagation();
      vscode.postMessage({ type: 'cancelSession', sessionId: sid });
      return;
    }

    if (action === 'send-msg') {
      e.stopPropagation();
      const text = (state.drafts.get(sid) || '').trim();
      if (!text) return;
      state.drafts.set(sid, '');
      vscode.postMessage({ type: 'sendMessage', sessionId: sid, message: text });
      return;
    }

    if (action === 'toggle-session') {
      e.stopPropagation();
      if (state.selectedId === sid) {
        state.selectedId = null;
        render();
      } else {
        state.selectedId = sid;
        requestDetail(sid);
      }
    }
  });

  els.tree.addEventListener('change', (e) => {
    const sel = e.target.closest('select[data-action="last"]');
    if (!sel) return;
    state.lastCount = Number(sel.value) || 8;
    requestDetail(sel.dataset.sid);
  });

  vscode.postMessage({ type: 'ready' });
})();
