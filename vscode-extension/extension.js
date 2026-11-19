'use strict';

const vscode = require('vscode');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');

const execFileAsync = promisify(execFile);
const SESSION_ID_RE = /^[a-zA-Z0-9_-]{4,128}$/;
const PIN_KEY = 'dshSessions.pinnedIds';
const MONITOR_KEY = 'dshSessions.monitoringEnabled';
const POLL_MS = 4000;

function findNodeBin() {
  const winNode = 'C:\\Program Files\\nodejs\\node.exe';
  if (process.platform === 'win32' && fs.existsSync(winNode)) return winNode;
  return 'node';
}

function findBatonCli() {
  const fromEnv = (process.env.DSH_BATON_CLI || '').trim();
  if (fromEnv && fs.existsSync(fromEnv)) return fromEnv;
  const def = path.join(os.homedir(), '.dsh-baton', 'app', 'src', 'cli.mjs');
  return fs.existsSync(def) ? def : null;
}

async function runBaton(args, { timeout = 15000, stdinText = null } = {}) {
  const cli = findBatonCli();
  if (!cli) {
    throw new Error('未找到 dsh-baton CLI (~/.dsh-baton/app/src/cli.mjs)');
  }
  const nodeBin = findNodeBin();
  const env = { ...process.env, ELECTRON_RUN_AS_NODE: '1' };

  if (stdinText !== null) {
    return new Promise((resolve, reject) => {
      const child = execFile(
        nodeBin,
        [cli, ...args],
        { timeout, maxBuffer: 4 * 1024 * 1024, windowsHide: true, env },
        (err, stdout, stderr) => {
          if (err) {
            reject(new Error((stderr || err.message || String(err)).trim().slice(0, 400)));
            return;
          }
          try {
            const out = String(stdout || '').trim();
            resolve(out ? JSON.parse(out) : null);
          } catch (e) {
            reject(new Error(`解析 dsh-baton 输出失败: ${e.message}`));
          }
        },
      );
      if (child.stdin) {
        child.stdin.write(stdinText);
        child.stdin.end();
      }
    });
  }

  const { stdout } = await execFileAsync(nodeBin, [cli, ...args], {
    timeout,
    maxBuffer: 4 * 1024 * 1024,
    windowsHide: true,
    env,
  });
  const out = String(stdout || '').trim();
  return out ? JSON.parse(out) : null;
}

async function fetchBatonOverview() {
  const cli = findBatonCli();
  if (!cli) {
    return {
      exists: false,
      error: '未检测到 dsh-baton (~/.dsh-baton/app/src/cli.mjs)，请先在 DeepSeek Harness 中启用 dsh-baton-host 插件。',
      updatedAt: Date.now(),
      totalCount: 0,
      runningCount: 0,
      workspaces: [],
      sessions: [],
    };
  }

  const [workspacesRaw, sessionsRaw] = await Promise.all([
    runBaton(['workspaces']).catch(() => []),
    runBaton(['sessions', '--limit', '200']),
  ]);

  const workspaces = Array.isArray(workspacesRaw) ? workspacesRaw : [];
  const wsTitleByPath = new Map();
  for (const w of workspaces) {
    if (w && w.path) {
      wsTitleByPath.set(String(w.path).toLowerCase(), w.title || '');
    }
  }

  const rawList = Array.isArray(sessionsRaw) ? sessionsRaw : [];
  const sessions = [];
  for (const s of rawList) {
    if (!s || s.blank) continue;
    const cwd = s.cwd || '';
    const isRunning = Boolean(s.running);
    const updatedMs = s.updated_at ? Date.parse(s.updated_at) || 0 : 0;
    const modelObj = s.model && typeof s.model === 'object' ? s.model : {};
    sessions.push({
      session_id: s.session_id,
      title: s.title || '新会话',
      cwd,
      workspace_title: wsTitleByPath.get(cwd.toLowerCase()) || '',
      model: modelObj.model || '',
      status: isRunning ? 'RUNNING' : 'IDLE',
      running: isRunning,
      bridge_runs: Array.isArray(s.bridge_runs) ? s.bridge_runs : [],
      mtime_ms: updatedMs,
      updated_at: s.updated_at || '',
    });
  }

  sessions.sort((a, b) => b.mtime_ms - a.mtime_ms);
  const runningCount = sessions.filter((s) => s.running).length;

  return {
    exists: true,
    error: null,
    updatedAt: Date.now(),
    totalCount: sessions.length,
    runningCount,
    workspaces,
    sessions,
  };
}

class DshSidebarProvider {
  constructor(context) {
    this._context = context;
    this._view = null;
    this._timer = null;
  }

  isMonitoringEnabled() {
    return this._context.globalState.get(MONITOR_KEY, true) !== false;
  }

  async toggleMonitoring() {
    const next = !this.isMonitoringEnabled();
    await this._context.globalState.update(MONITOR_KEY, next);
    if (next) {
      this._startPolling();
      await this.pushSessions();
      this._post({ type: 'toast', message: '已开启自动监控' });
    } else {
      this._stopPolling();
      this._post({ type: 'monitoring', enabled: false });
      this._post({ type: 'toast', message: '已关闭自动监控' });
    }
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
      if (msg.type === 'ready') {
        const enabled = this.isMonitoringEnabled();
        this._post({ type: 'monitoring', enabled });
        if (enabled) {
          await this.pushSessions();
          this._startPolling();
        }
      } else if (msg.type === 'refresh') {
        await this.pushSessions();
      } else if (msg.type === 'toggleMonitoring') {
        await this.toggleMonitoring();
      } else if (msg.type === 'detail') {
        await this._handleDetail(msg.sessionId, msg.last);
      } else if (msg.type === 'sendMessage') {
        await this._handleSend(msg.sessionId, msg.message, msg.mode);
      } else if (msg.type === 'cancelSession') {
        await this._handleCancel(msg.sessionId);
      } else if (msg.type === 'controlWithGemini' && msg.session) {
        await this._handleControlWithGemini(msg.session);
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
      if (webviewView.visible && this.isMonitoringEnabled()) {
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

    if (this.isMonitoringEnabled()) {
      this._startPolling();
    }
  }

  _startPolling() {
    if (this._timer || !this.isMonitoringEnabled()) return;
    this._timer = setInterval(() => {
      if (this._view && this._view.visible && this.isMonitoringEnabled()) {
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

  async pushSessions() {
    try {
      const data = await fetchBatonOverview();
      const pinned = this._context.globalState.get(PIN_KEY, []);
      this._post({
        type: 'sessions',
        data,
        pinned: Array.isArray(pinned) ? pinned : [],
        monitoring: this.isMonitoringEnabled(),
      });
    } catch (err) {
      this._post({
        type: 'sessions',
        data: {
          exists: false,
          error: err.message || String(err),
          updatedAt: Date.now(),
          totalCount: 0,
          runningCount: 0,
          workspaces: [],
          sessions: [],
        },
        monitoring: this.isMonitoringEnabled(),
      });
    }
  }

  async _handleDetail(sessionId, last) {
    const sid = String(sessionId || '').trim();
    if (!SESSION_ID_RE.test(sid)) {
      this._post({ type: 'detail', sessionId: sid, error: '无效的会话 ID' });
      return;
    }
    const safeLast = Math.min(30, Math.max(2, Number(last) || 6));
    try {
      const [status, messages] = await Promise.all([
        runBaton(['status', sid]),
        runBaton(['read', sid, '--last', String(safeLast)]),
      ]);
      this._post({
        type: 'detail',
        sessionId: sid,
        data: { sessionId: sid, last: safeLast, status, messages },
      });
    } catch (err) {
      this._post({
        type: 'detail',
        sessionId: sid,
        error: err.message || String(err),
      });
    }
  }

  async _handleSend(sessionId, message, mode) {
    const sid = String(sessionId || '').trim();
    const text = String(message || '').trim();
    if (!SESSION_ID_RE.test(sid) || !text) {
      this._post({ type: 'toast', message: '会话 ID 或消息不能为空' });
      return;
    }
    try {
      const args = ['send', '--session', sid];
      if (mode === 'steer' || mode === 'followup') {
        args.push('--mode', mode);
      }
      args.push('-');
      await runBaton(args, { timeout: 20000, stdinText: text });
      this._post({ type: 'toast', message: '已发送给 DeepSeek Harness' });
      await this.pushSessions();
      await this._handleDetail(sid, 6);
    } catch (err) {
      this._post({ type: 'toast', message: `发送失败: ${err.message}` });
    }
  }

  async _handleCancel(sessionId) {
    const sid = String(sessionId || '').trim();
    if (!SESSION_ID_RE.test(sid)) return;
    try {
      await runBaton(['cancel', '--session', sid], { timeout: 15000 });
      this._post({ type: 'toast', message: '已发送停止指令' });
      await this.pushSessions();
      await this._handleDetail(sid, 6);
    } catch (err) {
      this._post({ type: 'toast', message: `停止失败: ${err.message}` });
    }
  }

  async _handleControlWithGemini(session) {
    const sid = String(session.session_id || '').trim();
    if (!sid) return;
    const title = session.title || '新会话';
    const cwd = session.cwd || '-';
    const status = session.running ? 'RUNNING' : 'IDLE';
    const model = session.model || '-';

    const promptText = [
      '请接管并控制以下 DeepSeek Harness 会话：',
      `- 会话ID: ${sid}`,
      `- 标题: ${title}`,
      `- 工作目录: ${cwd}`,
      `- 状态: ${status} | 模型: ${model}`,
      '',
      '补充说明：',
    ].join('\n');

    await vscode.env.clipboard.writeText(promptText);

    // 尝试聚焦 Antigravity / IDE 聊天输入框并自动粘贴
    let pasted = false;
    try {
      const cmds = await vscode.commands.getCommands(true);
      const focusCandidates = [
        'antigravity.agentView.focus',
        'antigravity.chat.focus',
        'workbench.panel.chat.view.copilot.focus',
        'workbench.action.chat.open',
      ];
      const focusCmd = focusCandidates.find((c) => cmds.includes(c))
        || cmds.find((c) => /(?:antigravity|cascade|chat).*(?:focus|open)/i.test(c));
      if (focusCmd) {
        await vscode.commands.executeCommand(focusCmd);
        await new Promise((r) => setTimeout(r, 120));
        await vscode.commands.executeCommand('editor.action.clipboardPasteAction');
        pasted = true;
      }
    } catch {
      // Fallback to clipboard-only notification below.
    }

    this._post({
      type: 'toast',
      message: pasted ? '已填入聊天框，请补充说明' : '已复制会话信息，Ctrl+V 粘贴到聊天框补充说明',
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
        <span id="live-dot" class="live-indicator" title="每 4 秒通过 dsh-baton 自动刷新"></span>
        <span id="paused-label" class="paused-label hidden">已关闭</span>
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
        <button id="btn-monitor" type="button" class="icon-btn" title="关闭监控" aria-label="关闭监控" aria-pressed="true">
          <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round">
            <path d="M8 2.3v4.7"></path>
            <path d="M4.6 4.4a5.2 5.2 0 1 0 6.8 0"></path>
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
    vscode.commands.registerCommand('dshSessions.toggleMonitoring', () => provider.toggleMonitoring()),
  );
}

function deactivate() {}

module.exports = { activate, deactivate };
