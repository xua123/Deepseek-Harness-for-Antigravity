# DeepSeek Harness for Antigravity (`dsh-monitor`)

An Antigravity plugin (Skill + Auxiliary Pane UI Sidecar) for monitoring local **DeepSeek Harness (`.dsh`)** desktop and CLI agent sessions in real time — completely read-only.

## Features

- **Sidecar UI Panel (`DSH Sessions`)**
  - Renders natively in Antigravity's **Auxiliary Side Pane** (`SIDECAR_UI_ENTRYPOINT_AUX_PANE`) with automatic light/dark theme sync.
  - Auto-refreshes every 4 seconds to list running, stalled, and recent `.dsh` sessions from `~/.dsh/storages/session_projcache/sessions/session-*.json`.
  - Supports **Active / All** filtering, keyword search (title, session ID, working directory, model), and one-click session ID copy.
  - Click any session card to expand **Anomaly Inspection** (`STALL` / `ERROR` / `FALSE_PASS`) and **Recent Trajectory** (reasoning, tool calls, tool results) decoded from `session.v4.jsonl.zstd`.
- **Agent Skill (`/dsh-monitor`) & CLI Script**
  - `list [--active-only] [--limit N] [--json]` — list active or recent sessions.
  - `tail [--session ID] [--steps N] [--json]` — inspect recent reasoning, tool calls, and results.
  - `inspect [--session ID] [--stale-sec 300] [--json]` — detect hung pending tool calls, errors/tracebacks, and empty-result false passes.
  - Works seamlessly with Antigravity `/schedule` for automated background watchdogs.

## Directory Structure

```text
dsh-monitor/
├── plugin.json
├── README.md
├── sidecars/
│   └── dsh_sessions/
│       ├── sidecar.json
│       ├── package.json
│       ├── main.mjs
│       ├── index.html
│       ├── styles.css
│       └── app.js
└── skills/
    └── dsh-monitor/
        ├── SKILL.md
        └── scripts/
            └── dsh_monitor.py
```

## Installation

1. Clone or copy this repository into your Antigravity global plugins directory:
   ```bash
   git clone https://github.com/xua123/Deepseek-Harness-for-Antigravity.git ~/.gemini/config/plugins/dsh-monitor
   ```
   On Windows (PowerShell):
   ```powershell
   git clone https://github.com/xua123/Deepseek-Harness-for-Antigravity.git "$env:USERPROFILE\.gemini\config\plugins\dsh-monitor"
   ```
2. Install the optional Python dependency `zstandard` (required for reading compressed `session.v4.jsonl.zstd` trajectories; session list works with Node.js alone):
   ```bash
   pip install zstandard
   ```
   If `zstandard` is installed in a specific virtual/conda environment, either let the sidecar auto-detect it or set `DSH_MONITOR_PYTHON` to that Python executable path.
3. Open **DSH Sessions** from Antigravity's conversation `+` menu (Auxiliary Pane) or invoke `/dsh-monitor` in chat.

## Environment Variables (Optional)

| Variable | Description | Default |
| :--- | :--- | :--- |
| `DSH_DIR` | Path to DeepSeek Harness data directory | `~/.dsh` |
| `DSH_MONITOR_PYTHON` | Python executable with `zstandard` installed | Auto-detected (`python` / `python3` / conda envs) |

## Security & Read-Only Guarantee

This plugin only performs read-only filesystem reads under `~/.dsh` and never modifies session state, sends agent messages, or executes arbitrary commands.
