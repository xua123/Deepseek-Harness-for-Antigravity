---
name: dsh-monitor
description: 监控本机 DeepSeek Harness (.dsh) 桌面端与 CLI 的 Agent 会话。用于列出活跃会话、实时读取最近 N 步的思考（reasoning）/命令（ops_bash）/结果（tool/result），以及巡检报错、长时间卡住或空结果“假通过”。当用户询问“DeepSeek Harness 在干什么”、“监控我的 Agent”、“查看 dsh 进度”或设置定时巡检时使用。
---

# DeepSeek Harness 会话监控技能

本技能通过只读方式解析本机 DeepSeek Harness 落盘的会话数据：
- 会话状态快照：`~/.dsh/storages/session_projcache/sessions/session-*.json`
- 完整步骤轨迹流：`~/.dsh/sessions/<workspace-slug>/session-<id>/session.v4.jsonl.zstd`

本插件同时内置了右侧辅助侧边栏 UI 面板 **`DSH Sessions`**（入口 `sidecar://dsh-monitor/dsh_sessions/`），可实时展示运行中与历史会话列表，并点击展开轨迹与异常巡检结果。

## 命令行使用方式

统一调用插件内置脚本 `scripts/dsh_monitor.py`（需要装有 `zstandard` 库的 Python 解释器；可设置环境变量 `DSH_MONITOR_PYTHON` 或使用已安装 `zstandard` 的环境）：

### 1. 列出活跃 / 最近会话
```bash
python ~/.gemini/config/plugins/dsh-monitor/skills/dsh-monitor/scripts/dsh_monitor.py list --limit 10
```
仅看正在执行中的会话可加 `--active-only`；需要结构化输出可加 `--json`。

### 2. 实时查看最近 N 步执行进度
```bash
python ~/.gemini/config/plugins/dsh-monitor/skills/dsh-monitor/scripts/dsh_monitor.py tail --steps 5
```
指定特定会话时追加 `--session <session-id>`；默认自动选取最近更新的会话。

### 3. 异常 / 假通过巡检
```bash
python ~/.gemini/config/plugins/dsh-monitor/skills/dsh-monitor/scripts/dsh_monitor.py inspect --stale-sec 300
```
输出会标出：
- **STALL**：`pendingCalls` 挂起时间超过阈值；
- **ERROR**：近期工具返回中出现非零退出码、`Traceback`、`ERROR`、`Exception`、`FAILED`；
- **FALSE_PASS**：接口返回 `200 / errorcode 0` 但出现 `items 0`、`items: 0`、`image_size []` 等空提取结果。

### 4. 配合定时任务持续监控
若用户要求自动定时盯盘，可调用 `schedule` 工具（例如 `CronExpression: "*/2 * * * *"`），在回调 Prompt 中要求执行 `inspect` 与 `tail --steps 3`，仅在进度推进到关键节点或发现异常/假通过时向用户汇报。
