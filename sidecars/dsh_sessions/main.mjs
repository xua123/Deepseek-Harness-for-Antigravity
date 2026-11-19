/**
 * DeepSeek Harness session monitor sidecar backend (powered by official dsh-baton bridge).
 */
import { execFile } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { SidecarApp, Response } from 'sidecar_sdk';

const execFileAsync = promisify(execFile);
const __dirname = dirname(fileURLToPath(import.meta.url));
const SESSION_ID_RE = /^[a-zA-Z0-9_-]{4,128}$/;

const STATIC = {
  '/styles.css': ['styles.css', 'text/css; charset=utf-8'],
  '/app.js': ['app.js', 'application/javascript; charset=utf-8'],
};

function findNodeBin() {
  const winNode = 'C:\\Program Files\\nodejs\\node.exe';
  if (process.platform === 'win32' && existsSync(winNode)) return winNode;
  return 'node';
}

function findBatonCli() {
  const fromEnv = (process.env.DSH_BATON_CLI || '').trim();
  if (fromEnv && existsSync(fromEnv)) return fromEnv;
  const def = join(homedir(), '.dsh-baton', 'app', 'src', 'cli.mjs');
  return existsSync(def) ? def : null;
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

const app = new SidecarApp();

app.page('/', () => readFileSync(join(__dirname, 'index.html'), 'utf-8'));

for (const [route, [file, type]] of Object.entries(STATIC)) {
  app.api(route, () => new Response(readFileSync(join(__dirname, file), 'utf-8'), { contentType: type }), 'GET');
}

app.api('/api/sessions', async (data) => {
  const activeOnly = data.activeOnly === '1' || data.activeOnly === 'true';
  const limit = Math.min(200, Math.max(1, Number(data.limit) || 200));

  if (!findBatonCli()) {
    return {
      exists: false,
      error: '未检测到 dsh-baton (~/.dsh-baton/app/src/cli.mjs)',
      updatedAt: Date.now(),
      totalCount: 0,
      runningCount: 0,
      workspaces: [],
      sessions: [],
    };
  }

  try {
    const [workspacesRaw, sessionsRaw] = await Promise.all([
      runBaton(['workspaces']).catch(() => []),
      runBaton(['sessions', '--limit', String(limit)]),
    ]);

    const workspaces = Array.isArray(workspacesRaw) ? workspacesRaw : [];
    const wsTitleByPath = new Map();
    for (const w of workspaces) {
      if (w && w.path) {
        wsTitleByPath.set(String(w.path).toLowerCase(), w.title || '');
      }
    }

    const sessions = [];
    for (const s of Array.isArray(sessionsRaw) ? sessionsRaw : []) {
      if (!s || s.blank) continue;
      const cwd = s.cwd || '';
      const isRunning = Boolean(s.running);
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
        mtime_ms: s.updated_at ? Date.parse(s.updated_at) || 0 : 0,
        updated_at: s.updated_at || '',
      });
    }

    sessions.sort((a, b) => b.mtime_ms - a.mtime_ms);
    const runningCount = sessions.filter((s) => s.running).length;
    const filtered = activeOnly ? sessions.filter((s) => s.running) : sessions;

    return {
      exists: true,
      error: null,
      updatedAt: Date.now(),
      totalCount: sessions.length,
      runningCount,
      workspaces,
      sessions: filtered.slice(0, limit),
    };
  } catch (err) {
    return {
      exists: false,
      error: err.message || String(err),
      updatedAt: Date.now(),
      totalCount: 0,
      runningCount: 0,
      workspaces: [],
      sessions: [],
    };
  }
}, 'GET');

app.api('/api/session/detail', async (data) => {
  const sessionId = String(data.session || '').trim();
  if (!SESSION_ID_RE.test(sessionId)) {
    return new Response(JSON.stringify({ error: '无效的会话 ID' }), {
      status: 400,
      contentType: 'application/json; charset=utf-8',
    });
  }
  const safeLast = Math.min(30, Math.max(2, Number(data.last || data.steps) || 6));
  try {
    const [status, messages] = await Promise.all([
      runBaton(['status', sessionId]),
      runBaton(['read', sessionId, '--last', String(safeLast)]),
    ]);
    return { sessionId, last: safeLast, status, messages };
  } catch (err) {
    return new Response(JSON.stringify({ error: err.message || String(err) }), {
      status: 500,
      contentType: 'application/json; charset=utf-8',
    });
  }
}, 'GET');

app.api('/api/session/send', async (data) => {
  const sessionId = String(data.session || '').trim();
  const message = String(data.message || '').trim();
  const mode = data.mode === 'steer' || data.mode === 'followup' ? data.mode : null;
  if (!SESSION_ID_RE.test(sessionId) || !message) {
    return new Response(JSON.stringify({ error: '会话 ID 或消息不能为空' }), {
      status: 400,
      contentType: 'application/json; charset=utf-8',
    });
  }
  try {
    const args = ['send', '--session', sessionId];
    if (mode) args.push('--mode', mode);
    args.push('-');
    const res = await runBaton(args, { timeout: 20000, stdinText: message });
    return { ok: true, result: res };
  } catch (err) {
    return new Response(JSON.stringify({ error: err.message || String(err) }), {
      status: 500,
      contentType: 'application/json; charset=utf-8',
    });
  }
}, 'POST');

app.api('/api/session/cancel', async (data) => {
  const sessionId = String(data.session || '').trim();
  if (!SESSION_ID_RE.test(sessionId)) {
    return new Response(JSON.stringify({ error: '无效的会话 ID' }), {
      status: 400,
      contentType: 'application/json; charset=utf-8',
    });
  }
  try {
    const res = await runBaton(['cancel', '--session', sessionId], { timeout: 15000 });
    return { ok: true, result: res };
  } catch (err) {
    return new Response(JSON.stringify({ error: err.message || String(err) }), {
      status: 500,
      contentType: 'application/json; charset=utf-8',
    });
  }
}, 'POST');

app.run();
