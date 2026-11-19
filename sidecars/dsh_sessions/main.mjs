/**
 * DeepSeek Harness (.dsh) session monitor sidecar backend.
 *
 * Read-only:
 *   - Scans ~/.dsh/storages/session_projcache/sessions/session-*.json
 *   - Delegates trajectory tail & anomaly inspection to ../../skills/dsh-monitor/scripts/dsh_monitor.py
 */
import { execFile, execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { SidecarApp, Response } from 'sidecar_sdk';

const execFileAsync = promisify(execFile);
const __dirname = dirname(fileURLToPath(import.meta.url));
const DSH_DIR = process.env.DSH_DIR || join(homedir(), '.dsh');
const MONITOR_SCRIPT = resolve(__dirname, '..', '..', 'skills', 'dsh-monitor', 'scripts', 'dsh_monitor.py');
const SESSION_ID_RE = /^[a-zA-Z0-9_-]{4,128}$/;

const STATIC = {
  '/styles.css': ['styles.css', 'text/css; charset=utf-8'],
  '/app.js': ['app.js', 'application/javascript; charset=utf-8'],
};

let cachedPython = null;
let pythonChecked = false;

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

function findPythonWithZstd() {
  if (pythonChecked) return cachedPython;
  pythonChecked = true;

  const candidates = [];
  if (process.env.DSH_MONITOR_PYTHON) {
    candidates.push(process.env.DSH_MONITOR_PYTHON);
  }
  candidates.push('python', 'python3');

  // Probe common conda / miniconda environments without hardcoding user-specific env names.
  const home = homedir();
  const isWin = process.platform === 'win32';
  for (const base of ['anaconda3', 'miniconda3', 'mambaforge', 'miniforge3']) {
    const envsDir = join(home, base, 'envs');
    if (!existsSync(envsDir)) continue;
    try {
      for (const entry of readdirSync(envsDir, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        const py = isWin
          ? join(envsDir, entry.name, 'python.exe')
          : join(envsDir, entry.name, 'bin', 'python');
        if (existsSync(py)) candidates.push(py);
      }
    } catch {
      // Ignore unreadable directories.
    }
  }

  const seen = new Set();
  for (const candidate of candidates) {
    if (!candidate || seen.has(candidate)) continue;
    seen.add(candidate);
    if (testPythonWithZstd(candidate)) {
      cachedPython = candidate;
      return cachedPython;
    }
  }
  return null;
}

function loadSessions(staleSec = 300) {
  const dir = join(DSH_DIR, 'storages', 'session_projcache', 'sessions');
  if (!existsSync(dir)) {
    return { dshDir: DSH_DIR, exists: false, sessions: [] };
  }

  let files;
  try {
    files = readdirSync(dir).filter((f) => f.startsWith('session-') && f.endsWith('.json'));
  } catch {
    return { dshDir: DSH_DIR, exists: false, sessions: [] };
  }

  const nowMs = Date.now();
  const sessions = [];

  for (const file of files) {
    const fullPath = join(dir, file);
    try {
      const stat = statSync(fullPath);
      const data = JSON.parse(readFileSync(fullPath, 'utf-8'));
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
      const turns = Number(stats.turns || 0);
      const steps = Number(stats.steps || 0);

      // Skip empty draft sessions (never sent a message, no title, not running).
      if (!title && turns === 0 && steps === 0 && !isRunning) {
        continue;
      }

      const fallbackTitle =
        title ||
        (typeof (rows.goal || {}).val === 'string' ? rows.goal.val.trim() : '') ||
        (typeof (rows.titleInput || {}).val === 'string' ? rows.titleInput.val.trim() : '') ||
        '新会话';

      const isStalled = pendingCount > 0 && maxPendingSec >= staleSec;
      const status = isStalled ? 'STALLED' : isRunning ? 'RUNNING' : 'IDLE';

      sessions.push({
        session_id: file.slice(0, -'.json'.length),
        title: fallbackTitle,
        cwd,
        model: modelSel.model || '',
        turns,
        steps,
        turn_open: turnOpen,
        pending_count: pendingCount,
        max_pending_sec: maxPendingSec,
        status,
        last_msg_ts: Number(timeCtx.lastMessageTime || 0),
        mtime_ms: Math.floor(stat.mtimeMs),
      });
    } catch {
      // Skip partially written or unreadable session snapshots.
    }
  }

  sessions.sort((a, b) => b.mtime_ms - a.mtime_ms);
  return { dshDir: DSH_DIR, exists: true, sessions };
}

async function runMonitorJson(subcmd, extraArgs) {
  const pythonBin = findPythonWithZstd();
  if (!pythonBin) {
    return {
      ok: false,
      error: '未找到已安装 zstandard 库的 Python 环境。可通过环境变量 DSH_MONITOR_PYTHON 指定 Python 路径，或执行 pip install zstandard。',
    };
  }
  if (!existsSync(MONITOR_SCRIPT)) {
    return { ok: false, error: `监控脚本不存在: ${MONITOR_SCRIPT}` };
  }

  try {
    const { stdout } = await execFileAsync(
      pythonBin,
      [MONITOR_SCRIPT, '--dsh-dir', DSH_DIR, subcmd, ...extraArgs, '--json'],
      { timeout: 15000, maxBuffer: 4 * 1024 * 1024, windowsHide: true },
    );
    return { ok: true, data: JSON.parse(stdout) };
  } catch (err) {
    const msg = (err?.stderr || err?.message || String(err)).trim();
    return { ok: false, error: msg.slice(0, 400) };
  }
}

const app = new SidecarApp();

app.page('/', () => readFileSync(join(__dirname, 'index.html'), 'utf-8'));

for (const [route, [file, type]] of Object.entries(STATIC)) {
  app.api(route, () => new Response(readFileSync(join(__dirname, file), 'utf-8'), { contentType: type }), 'GET');
}

app.api('/api/sessions', (data) => {
  const activeOnly = data.activeOnly === '1' || data.activeOnly === 'true';
  const limit = Math.min(200, Math.max(1, Number(data.limit) || 50));
  const staleSec = Math.max(30, Number(data.staleSec) || 300);

  const { dshDir, exists, sessions } = loadSessions(staleSec);
  const runningCount = sessions.filter((s) => s.status === 'RUNNING' || s.status === 'STALLED').length;
  const stalledCount = sessions.filter((s) => s.status === 'STALLED').length;
  const filtered = activeOnly
    ? sessions.filter((s) => s.status === 'RUNNING' || s.status === 'STALLED')
    : sessions;

  return {
    dshDir,
    exists,
    updatedAt: Date.now(),
    totalCount: sessions.length,
    runningCount,
    stalledCount,
    sessions: filtered.slice(0, limit),
  };
}, 'GET');

app.api('/api/session/detail', async (data) => {
  const sessionId = String(data.session || '').trim();
  if (!SESSION_ID_RE.test(sessionId)) {
    return new Response(JSON.stringify({ error: '无效的会话 ID' }), {
      status: 400,
      contentType: 'application/json; charset=utf-8',
    });
  }
  const steps = Math.min(30, Math.max(1, Number(data.steps) || 6));
  const staleSec = Math.max(30, Number(data.staleSec) || 300);

  const [tailRes, inspectRes] = await Promise.all([
    runMonitorJson('tail', ['--session', sessionId, '--steps', String(steps)]),
    runMonitorJson('inspect', ['--session', sessionId, '--stale-sec', String(staleSec)]),
  ]);

  return {
    sessionId,
    steps,
    tail: tailRes.ok ? tailRes.data : null,
    tailError: tailRes.ok ? null : tailRes.error,
    inspect: inspectRes.ok ? inspectRes.data : null,
    inspectError: inspectRes.ok ? null : inspectRes.error,
  };
}, 'GET');

app.run();
