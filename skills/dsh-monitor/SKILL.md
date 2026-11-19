---
name: dsh-monitor
description: 监控并调度本机 DeepSeek Harness (.dsh) 桌面端会话。基于官方 dsh-baton 桥接列出全部工作区与会话、查看实时活动与最近消息、发送任务指令，以及零 Google token 后台等待完成。当用户询问“DeepSeek Harness 在干什么”、“监控我的 Agent”、“列出 dsh 会话”或需要向 DSH 派发/等待任务时使用。
---

# DeepSeek Harness 会话监控与调度技能

本技能完全通过官方 **`dsh-baton`** 桥接与运行中的 DeepSeek Harness 交互（不再扫描本地快照文件），可实时获取全部工作区和全部会话。

- 若环境中已挂载 `dsh-baton` MCP 工具，可直接调用 `dsh_list_workspaces` / `dsh_list_sessions` / `dsh_send` / `dsh_read_session` / `dsh_status` / `dsh_cancel`。
- **零 Google token 等待原则**：需要等待 DSH 长耗时任务完成时，**禁止在主对话循环调用 50 秒超时的 `dsh_wait`**；改用 `run_command` 在后台启动 `dsh_monitor.py wait`，等待期间不消耗任何 Google token，任务完成后脚本自动退出并由系统唤醒读取结果。

## 命令行使用方式

统一调用插件内置脚本 `scripts/dsh_monitor.py`（仅依赖 Python 标准库 + 本机 Node.js + `~/.dsh-baton/app/src/cli.mjs`）：

### 1. 列出所有工作区 / 会话
```bash
python ~/.gemini/config/plugins/dsh-monitor/skills/dsh-monitor/scripts/dsh_monitor.py workspaces --json
python ~/.gemini/config/plugins/dsh-monitor/skills/dsh-monitor/scripts/dsh_monitor.py list --limit 50
```
仅看运行中会话可加 `--active-only`，关键词筛选可加 `--query <关键词>`，结构化输出可加 `--json`。

### 2. 查看实时活动状态与最近消息
```bash
python ~/.gemini/config/plugins/dsh-monitor/skills/dsh-monitor/scripts/dsh_monitor.py activity --session <session-id>
python ~/.gemini/config/plugins/dsh-monitor/skills/dsh-monitor/scripts/dsh_monitor.py read --session <session-id> --last 10
```

### 3. 向指定会话发送指令 / 中断
```bash
python ~/.gemini/config/plugins/dsh-monitor/skills/dsh-monitor/scripts/dsh_monitor.py send --session <session-id> --message "你的指令"
python ~/.gemini/config/plugins/dsh-monitor/skills/dsh-monitor/scripts/dsh_monitor.py cancel --session <session-id>
```

### 4. 零 token 后台等待完成
```bash
python ~/.gemini/config/plugins/dsh-monitor/skills/dsh-monitor/scripts/dsh_monitor.py wait --session <session-id> --timeout 3600
```
也可传入 `send` 返回的 `--run-id hrun-...`；命令将在任务结束或需要人工确认时退出并打印最终结果。
