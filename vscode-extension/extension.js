'use strict';

const vscode = require('vscode');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFile, execFileSync } = require('node:child_process');
const { promisify } = require('node:util');

const execFileAsync = promisify(execFile);
const SESSION_ID_RE = /^[a-zA-Z0-9_-]{4,128}$/;
const PIN_KEY = 'dshSessions.pinnedIds';
const POLL_MS = 4000;

let cachedPython = null;
let pythonChecked = false;

function getConfig() {
  const cfg = vscode.workspace.getConfiguration('dshSessions');
  const dshDir = (cfg.get('dshDir') || process.env.DSH_DIR || path.join(os.homedir(), '.dsh')).trim();
  const pythonPath = (cfg.get('pythonPath') || process.env.DSH_MONITOR_PYTHON || '').trim();
  const staleSec = Math.max(30, Number(cfg.get('staleSec') || 300));
  return { dshDir, pythonPath, staleSec };
}

function findMonitorScript(extensionPath) {
  const candidates = [
    path.resolve(extensionPath, '..', 'skills', 'dsh-monitor', 'scripts', 'dsh_monitor.py'),
    path.join(os.homedir(), '.gemini', 'config', 'plugins', 'dsh-monitor', 'skills', 'dsh-monitor', 'scripts', 'dsh_monitor.py'),
  ];
  for (const p of candidates) {
    if (fs.existsSync(p)) return p;
  }
  return null;
}

function testPythonWithZstd(candidate) {
  try {
    execFileSync(candidate, ['-c', 'import zstandard'], {
      stdio: 'ignore',
      timeout: 3000,
      windowsHide: true,
    });
    return true;
  } catch {
    return false;
  }
}

function findPythonWithZstd(configuredPath) {
  if (configuredPath) {
    if (testPythonWithZstd(configuredPath)) return configuredPath;
  }
  if (pythonChecked) return cachedPython;
  pythonChecked = true;

  const candidates = ['python', 'python3'];
  const home = os.homedir();
  const isWin = process.platform === 'win32';

  for (const base of ['anaconda3', 'miniconda3', 'mambaforge', 'miniforge3']) {
    const envsDir = path.join(home, base, 'envs');
    if (!fs.existsSync(envsDir)) continue;
    try {
      for (const entry of fs.readdirSync(envsDir, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        const py = isWin
          ? path.join(envsDir, entry.name, 'python.exe')
          : path.join(envsDir, entry.name, 'bin', 'python');
        if (fs.existsSync(py)) candidates.push(py);
      }
    } catch {
      // Ignore unreadable directories.
    }
  }

  const seen = new Set();
  for (const c of candidates) {
    if (!c || seen.has(c)) continue;
    seen.add(c);
    if (testPythonWithZstd(c)) {
      cachedPython = c;
      return cachedPython;
    }
  }
  return null;
}

function loadSessions(dshDir, staleSec) {
  const dir = path.join(dshDir, 'storages', 'session_projcache', 'sessions');
  if (!fs.existsSync(dir)) {
    return { dshDir, exists: false, updatedAt: Date.now(), totalCount: 0, runningCount: 0, stalledCount: 0, sessions: [] };
  }

  let files = [];
  try {
    files = fs.readdirSync(dir).filter((f) => f.startsWith('session-') && f.endsWith('.json'));
  } catch {
    return { dshDir, exists: false, updatedAt: Date.now(), totalCount: 0, runningCount: 0, stalledCount: 0, sessions: [] };
  }

  const nowMs = Date.now();
  const sessions = [];

  for (const file of files) {
    const fullPath = path.join(dir, file);
    try {
      const stat = fs.statSync(fullPath);
      const data = JSON.parse(fs.readFileSync(fullPath, 'utf-8'));
      const rec = data.record || {};
      const rows = rec.rows || {};
      const identity = rec.identity || {};
      const stats = (rows.sessionStats || {}).val || {};
      const approval = (rows.approvalState || {}).val || {};
      const title = (rows.title || {}).val || '';
      const cwd = (rows.workingDirectory || {}).val || identity.cwd || '';
      const modelSel = ((rows.modelSelection || {}).val || {}).lastUsed || {};
      const timeCtx = (rows.timeContext || {}).val || {};
      const pendingCalls = stats.pendingCalls || {};
      const pendingEntries = Object.entries(pendingCalls);

      let maxPendingSec = 0;
      for (const [, startedMs] of pendingEntries) {
        const elapsed = Math.max(0, Math.floor((nowMs - Number(startedMs || 0)) / 1000));
        if (elapsed > maxPendingSec) maxPendingSec = elapsed;
      }

      const turnOpen = Boolean(approval.turnOpen);
      const pendingCount = pendingEntries.length;
      const isRunning = turnOpen || pendingCount > 0;
      const isStalled = pendingCount > 0 && maxPendingSec >= staleSec;
      const status = isStalled ? 'STALLED' : isRunning ? 'RUNNING' : 'IDLE';

      sessions.push({
        session_id: file.slice(0, -'.json'.length),
        title,
        cwd,
        model: modelSel.model || '',
        turns: Number(stats.turns || 0),
        steps: Number(stats.steps || 0),
        turn_open: turnOpen,
        pending_count: pendingCount,
        max_pending_sec: maxPendingSec,
        status,
        last_msg_ts: Number(timeCtx.lastMessageTime || 0),
        mtime_ms: Math.floor(stat.mtimeMs),
      });
    } catch {
      // Skip unreadable snapshot files.
    }
  }

  sessions.sort((a, b) => b.mtime_ms - a.mtime_ms);
  const runningCount = sessions.filter((s) => s.status === 'RUNNING' || s.status === 'STALLED').length;
  const stalledCount = sessions.filter((s) => s.status === 'STALLED').length;

  return {
    dshDir,
    exists: true,
    updatedAt: nowMs,
    totalCount: sessions.length,
    runningCount,
    stalledCount,
    sessions: sessions.slice(0, 150),
  };
}

async function runMonitorJson(extensionPath, dshDir, configuredPython, subcmd, extraArgs) {
  const script = findMonitorScript(extensionPath);
  if (!script) {
    return { ok: false, error: '未找到 dsh_monitor.py 脚本。请确认 dsh-monitor 插件已安装。' };
  }
  const py = findPythonWithZstd(configuredPython);
  if (!py) {
    return { ok: false, error: '未找到已安装 zstandard 的 Python 环境，可在设置 dshSessions.pythonPath 中指定。' };
  }
  try {
    const { stdout } = await execFileAsync(
      py,
      [script, '--dsh-dir', dshDir, subcmd, ...extraArgs, '--json'],
      { timeout: 15000, maxBuffer: 4 * 1024 * 1024, windowsHide: true },
    );
    return { ok: true, data: JSON.parse(stdout) };
  } catch (err) {
    const msg = (err && (err.stderr || err.message)) ? String(err.stderr || err.message).trim() : String(err);
    return { ok: false, error: msg.slice(0, 400) };
  }
}

class DshSidebarProvider {
  constructor(context) {
    this._context = context;
    this._view = null;
    this._timer = null;
  }

  resolveWebviewView(webviewView) {
    this._view = webviewView;
    const webview = webviewView.webview;

    webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(this._context.extensionUri, 'media')],
    };

    webview.html = this._getHtml(webview);

    webview.onDidReceiveMessage(async (msg) => {
      if (!msg || typeof msg !== 'object') return;
      if (msg.type === 'ready' || msg.type === 'refresh') {
        this.pushSessions();
      } else if (msg.type === 'detail') {
        await this._handleDetail(msg.sessionId, msg.steps);
      } else if (msg.type === 'copyId' && typeof msg.sessionId === 'string') {
        await vscode.env.clipboard.writeText(msg.sessionId);
        this._post({ type: 'toast', message: '已复制会话 ID' });
      } else if (msg.type === 'togglePin' && typeof msg.sessionId === 'string') {
        const list = this._context.globalState.get(PIN_KEY, []);
        const set = new Set(Array.isArray(list) ? list : []);
        if (set.has(msg.sessionId)) set.delete(msg.sessionId);
        else set.add(msg.sessionId);
        const next = [...set];
        await this._context.globalState.update(PIN_KEY, next);
        this._post({ type: 'pinned', pinned: next });
      }
    });

    webviewView.onDidChangeVisibility(() => {
      if (webviewView.visible) {
        this.pushSessions();
        this._startPolling();
      } else {
        this._stopPolling();
      }
    });

    webviewView.onDidDispose(() => {
      this._stopPolling();
      this._view = null;
    });

    this._startPolling();
  }

  _startPolling() {
    if (this._timer) return;
    this._timer = setInterval(() => {
      if (this._view && this._view.visible) {
        this.pushSessions();
      }
    }, POLL_MS);
  }

  _stopPolling() {
    if (this._timer) {
      clearInterval(this._timer);
      this._timer = null;
    }
  }

  _post(payload) {
    if (this._view) {
      this._view.webview.postMessage(payload);
    }
  }

  pushSessions() {
    const { dshDir, staleSec } = getConfig();
    const data = loadSessions(dshDir, staleSec);
    const pinned = this._context.globalState.get(PIN_KEY, []);
    this._post({ type: 'sessions', data, pinned: Array.isArray(pinned) ? pinned : [] });
  }

  async _handleDetail(sessionId, steps) {
    const sid = String(sessionId || '').trim();
    if (!SESSION_ID_RE.test(sid)) {
      this._post({ type: 'detail', sessionId: sid, error: '无效的会话 ID' });
      return;
    }
    const safeSteps = Math.min(30, Math.max(1, Number(steps) || 6));
    const { dshDir, pythonPath, staleSec } = getConfig();

    const [tailRes, inspectRes] = await Promise.all([
      runMonitorJson(this._context.extensionPath, dshDir, pythonPath, 'tail', ['--session', sid, '--steps', String(safeSteps)]),
      runMonitorJson(this._context.extensionPath, dshDir, pythonPath, 'inspect', ['--session', sid, '--stale-sec', String(staleSec)]),
    ]);

    this._post({
      type: 'detail',
      sessionId: sid,
      data: {
        sessionId: sid,
        steps: safeSteps,
        tail: tailRes.ok ? tailRes.data : null,
        tailError: tailRes.ok ? null : tailRes.error,
        inspect: inspectRes.ok ? inspectRes.data : null,
        inspectError: inspectRes.ok ? null : inspectRes.error,
      },
    });
  }

  _getHtml(webview) {
    const cssUri = webview.asWebviewUri(vscode.Uri.joinPath(this._context.extensionUri, 'media', 'styles.css'));
    const jsUri = webview.asWebviewUri(vscode.Uri.joinPath(this._context.extensionUri, 'media', 'webview.js'));
    const nonce = String(Date.now()) + Math.random().toString(36).slice(2);

    return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';">
  <title>DSH Sessions</title>
  <link rel="stylesheet" href="${cssUri}">
</head>
<body>
  <div class="sidebar">
    <header class="topbar">
      <div class="topbar-left">
        <span class="section-title">工作区</span>
        <span id="live-dot" class="live-indicator" title="每 4 秒自动刷新"></span>
      </div>
      <div class="topbar-actions">
        <button id="btn-search" type="button" class="icon-btn" title="搜索会话" aria-label="搜索会话">
          <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
            <circle cx="7" cy="7" r="4.8"></circle>
            <path d="M10.7 10.7L14 14"></path>
          </svg>
        </button>
        <button id="btn-filter" type="button" class="icon-btn" title="仅看运行中" aria-label="仅看运行中" aria-pressed="false">
          <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round">
            <path d="M2.5 4.5h11M2.5 8h11M2.5 11.5h11"></path>
            <circle cx="5.5" cy="4.5" r="1.4" fill="var(--bg)"></circle>
            <circle cx="10.5" cy="8" r="1.4" fill="var(--bg)"></circle>
            <circle cx="6.5" cy="11.5" r="1.4" fill="var(--bg)"></circle>
          </svg>
        </button>
        <button id="btn-refresh" type="button" class="icon-btn" title="立即刷新" aria-label="立即刷新">
          <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
            <path d="M13.5 8a5.5 5.5 0 1 1-1.4-3.7"></path>
            <path d="M13.5 2.5v2.8h-2.8"></path>
          </svg>
        </button>
      </div>
    </header>

    <div id="search-wrap" class="search-wrap hidden">
      <input id="search-input" type="search" class="search-input" placeholder="筛选工作区、标题、模型或 ID…" aria-label="搜索会话">
    </div>

    <main id="tree" class="tree" aria-live="polite"></main>
  </div>

  <div id="toast" class="toast hidden" role="status" aria-live="polite"></div>
  <script nonce="${nonce}" src="${jsUri}"></script>
</body>
</html>`;
  }
}

function activate(context) {
  const provider = new DshSidebarProvider(context);
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider('dshSessions.sidebarView', provider, {
      webviewOptions: { retainContextWhenHidden: true },
    }),
    vscode.commands.registerCommand('dshSessions.refresh', () => provider.pushSessions()),
  );
}

function deactivate() {}

module.exports = { activate, deactivate };
