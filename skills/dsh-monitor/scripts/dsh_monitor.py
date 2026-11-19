#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""DeepSeek Harness monitor CLI backed by official dsh-baton host bridge."""

import argparse
import json
import os
import shutil
import subprocess
import sys


DEFAULT_BATON_CLI = os.path.join(os.path.expanduser("~"), ".dsh-baton", "app", "src", "cli.mjs")


def _find_node():
    node_env = os.environ.get("DSH_BATON_NODE")
    if node_env and os.path.exists(node_env):
        return node_env
    win_node = r"C:\Program Files\nodejs\node.exe"
    if os.path.exists(win_node):
        return win_node
    found = shutil.which("node")
    if found:
        return found
    raise RuntimeError("未找到 node 可执行文件，请安装 Node.js 或设置 DSH_BATON_NODE。")


def _find_cli():
    cli_env = os.environ.get("DSH_BATON_CLI")
    if cli_env and os.path.exists(cli_env):
        return cli_env
    if os.path.exists(DEFAULT_BATON_CLI):
        return DEFAULT_BATON_CLI
    raise RuntimeError(f"未找到 dsh-baton CLI: {DEFAULT_BATON_CLI}，请确认已安装 dsh-baton。")


def _run_baton(args, timeout=30, stdin_text=None):
    node = _find_node()
    cli = _find_cli()
    env = os.environ.copy()
    env["ELECTRON_RUN_AS_NODE"] = "1"
    proc = subprocess.run(
        [node, cli, *args],
        input=stdin_text,
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
        timeout=timeout,
        env=env,
    )
    if proc.returncode != 0:
        err = (proc.stderr or proc.stdout or "").strip()
        raise RuntimeError(err or f"dsh-baton exited with code {proc.returncode}")
    out = (proc.stdout or "").strip()
    if not out:
        return None
    try:
        return json.loads(out)
    except ValueError:
        return out


def _resolve_session(session_arg):
    sessions = _run_baton(["sessions", "--limit", "200"]) or []
    sessions = [s for s in sessions if not s.get("blank")]
    if not sessions:
        print("未找到任何 DeepSeek Harness 会话。", file=sys.stderr)
        sys.exit(1)
    if not session_arg:
        return sessions[0]
    for s in sessions:
        sid = s.get("session_id", "")
        if sid == session_arg or session_arg in sid:
            return s
    print(f"未找到匹配的会话: {session_arg}", file=sys.stderr)
    sys.exit(1)


def cmd_workspaces(args):
    workspaces = _run_baton(["workspaces"]) or []
    if args.json:
        print(json.dumps({"workspaces": workspaces}, ensure_ascii=False))
        return
    for idx, w in enumerate(workspaces, 1):
        print(f"{idx}. {w.get('title') or w.get('path')} | sessions={w.get('session_count', 0)} | id={w.get('id')}")
        print(f"   path={w.get('path')}")


def cmd_list(args):
    sessions = _run_baton(["sessions", "--limit", str(max(args.limit, 200))]) or []
    if not args.include_blank:
        sessions = [s for s in sessions if not s.get("blank")]
    if args.active_only:
        sessions = [s for s in sessions if s.get("running")]
    if args.query:
        q = args.query.lower()
        sessions = [
            s for s in sessions
            if q in (s.get("title") or "").lower()
            or q in (s.get("session_id") or "").lower()
            or q in (s.get("cwd") or "").lower()
        ]
    sessions = sessions[: args.limit]
    if args.json:
        print(json.dumps({"sessions": sessions}, ensure_ascii=False))
        return
    if not sessions:
        print("没有符合条件的 DeepSeek Harness 会话。")
        return
    for idx, s in enumerate(sessions, 1):
        status = "RUNNING" if s.get("running") else "IDLE"
        model_info = s.get("model") or {}
        model_name = model_info.get("model") or "-"
        print(f"{idx}. [{status}] {s.get('session_id')} | {s.get('title') or '(无标题)'}")
        print(f"   model={model_name} | updated={s.get('updated_at')} | cwd={s.get('cwd')}")


def cmd_read(args):
    sess = _resolve_session(args.session)
    sid = sess["session_id"]
    data = _run_baton(["read", sid, "--last", str(args.last)])
    if args.json:
        print(json.dumps({"session": sess, "messages": data}, ensure_ascii=False))
        return
    print(f"=== Session: {sid} | {sess.get('title') or '(无标题)'} ===")
    print(json.dumps(data, ensure_ascii=False, indent=2))


def cmd_activity(args):
    sess = _resolve_session(args.session)
    sid = sess["session_id"]
    act = _run_baton(["activity", sid])
    status = _run_baton(["status", sid])
    if args.json:
        print(json.dumps({"session": sess, "activity": act, "status": status}, ensure_ascii=False))
        return
    print(f"=== Activity: {sid} | {sess.get('title') or '(无标题)'} ===")
    print(json.dumps({"status": status, "activity": act}, ensure_ascii=False, indent=2))


def cmd_send(args):
    sess = _resolve_session(args.session)
    sid = sess["session_id"]
    cmd = ["send", "--session", sid]
    if args.mode:
        cmd.extend(["--mode", args.mode])
    cmd.append("-")
    res = _run_baton(cmd, timeout=30, stdin_text=args.message)
    if args.json:
        print(json.dumps(res, ensure_ascii=False))
        return
    print(json.dumps(res, ensure_ascii=False, indent=2))


def cmd_wait(args):
    target = args.run_id
    if target and target.startswith("hrun-"):
        res = _run_baton(["wait", target, "--timeout", str(args.timeout)], timeout=args.timeout + 30)
    else:
        sess = _resolve_session(args.session or target)
        res = _run_baton(["follow", sess["session_id"], "--timeout", str(args.timeout)], timeout=args.timeout + 30)
    if args.json:
        print(json.dumps(res, ensure_ascii=False))
        return
    print(json.dumps(res, ensure_ascii=False, indent=2))


def cmd_cancel(args):
    sess = _resolve_session(args.session)
    res = _run_baton(["cancel", "--session", sess["session_id"]])
    if args.json:
        print(json.dumps(res, ensure_ascii=False))
        return
    print(json.dumps(res, ensure_ascii=False, indent=2))


def main():
    parser = argparse.ArgumentParser(description="Monitor DeepSeek Harness sessions via dsh-baton")
    sub = parser.add_subparsers(dest="cmd", required=True)

    p_ws = sub.add_parser("workspaces", help="List all DSH workspaces")
    p_ws.add_argument("--json", action="store_true", help="Output JSON")
    p_ws.set_defaults(func=cmd_workspaces)

    p_list = sub.add_parser("list", help="List DSH sessions")
    p_list.add_argument("--active-only", action="store_true", help="Show only running sessions")
    p_list.add_argument("--include-blank", action="store_true", help="Include blank draft sessions")
    p_list.add_argument("--query", default="", help="Filter by title, cwd or id")
    p_list.add_argument("--limit", type=int, default=50, help="Max sessions to display")
    p_list.add_argument("--json", action="store_true", help="Output JSON")
    p_list.set_defaults(func=cmd_list)

    p_read = sub.add_parser("read", help="Read recent messages of a session")
    p_read.add_argument("--session", default=None, help="Session ID or substring")
    p_read.add_argument("--last", type=int, default=10, help="Number of recent messages")
    p_read.add_argument("--json", action="store_true", help="Output JSON")
    p_read.set_defaults(func=cmd_read)

    p_act = sub.add_parser("activity", help="Show live activity and status of a session")
    p_act.add_argument("--session", default=None, help="Session ID or substring")
    p_act.add_argument("--json", action="store_true", help="Output JSON")
    p_act.set_defaults(func=cmd_activity)

    p_send = sub.add_parser("send", help="Send message to a session")
    p_send.add_argument("--session", required=True, help="Session ID or substring")
    p_send.add_argument("--mode", choices=["followup", "steer"], default=None, help="Send mode")
    p_send.add_argument("--message", required=True, help="Message text")
    p_send.add_argument("--json", action="store_true", help="Output JSON")
    p_send.set_defaults(func=cmd_send)

    p_wait = sub.add_parser("wait", help="Block until a run or session finishes")
    p_wait.add_argument("--run-id", default=None, help="Run ID from send")
    p_wait.add_argument("--session", default=None, help="Session ID or substring")
    p_wait.add_argument("--timeout", type=int, default=3600, help="Max seconds to wait")
    p_wait.add_argument("--json", action="store_true", help="Output JSON")
    p_wait.set_defaults(func=cmd_wait)

    p_cancel = sub.add_parser("cancel", help="Cancel a running session")
    p_cancel.add_argument("--session", required=True, help="Session ID or substring")
    p_cancel.add_argument("--json", action="store_true", help="Output JSON")
    p_cancel.set_defaults(func=cmd_cancel)

    args = parser.parse_args()
    args.func(args)


if __name__ == "__main__":
    main()
