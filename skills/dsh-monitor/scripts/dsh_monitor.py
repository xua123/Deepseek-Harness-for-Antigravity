#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""Read-only monitor for local DeepSeek Harness (.dsh) sessions."""

import argparse
import datetime
import glob
import json
import os
import re
import sys
import time


DEFAULT_DSH_DIR = os.path.join(os.path.expanduser("~"), ".dsh")


def _fmt_ts(ts_ms):
    if not ts_ms:
        return "-"
    ts = ts_ms / 1000.0 if ts_ms > 1e12 else float(ts_ms)
    return datetime.datetime.fromtimestamp(ts).strftime("%Y-%m-%d %H:%M:%S")


def _load_projcache_sessions(dsh_dir):
    pattern = os.path.join(dsh_dir, "storages", "session_projcache", "sessions", "session-*.json")
    sessions = []
    for path in glob.glob(pattern):
        try:
            with open(path, "r", encoding="utf-8") as f:
                data = json.load(f)
        except Exception:
            continue
        rec = data.get("record") or {}
        rows = rec.get("rows") or {}
        identity = rec.get("identity") or {}
        sid = os.path.splitext(os.path.basename(path))[0]
        stats = (rows.get("sessionStats") or {}).get("val") or {}
        approval = (rows.get("approvalState") or {}).get("val") or {}
        title = (rows.get("title") or {}).get("val") or ""
        cwd = (rows.get("workingDirectory") or {}).get("val") or identity.get("cwd") or ""
        model_sel = ((rows.get("modelSelection") or {}).get("val") or {}).get("lastUsed") or {}
        time_ctx = (rows.get("timeContext") or {}).get("val") or {}
        pending = stats.get("pendingCalls") or {}
        mtime = os.path.getmtime(path)
        sessions.append({
            "session_id": sid,
            "title": title,
            "cwd": cwd,
            "model": model_sel.get("model", ""),
            "turns": stats.get("turns", 0),
            "steps": stats.get("steps", 0),
            "turn_open": bool(approval.get("turnOpen", False)),
            "pending_calls": pending,
            "last_msg_ts": time_ctx.get("lastMessageTime", 0),
            "mtime": mtime,
            "projcache_path": path,
        })
    sessions.sort(key=lambda x: x["mtime"], reverse=True)
    return sessions


def _find_trajectory_file(dsh_dir, session_id):
    pattern = os.path.join(dsh_dir, "sessions", "*", session_id, "session.v4.jsonl.zstd")
    matches = glob.glob(pattern)
    if matches:
        matches.sort(key=os.path.getmtime, reverse=True)
        return matches[0]
    pattern2 = os.path.join(dsh_dir, "sessions", "*", session_id, "*.jsonl*")
    matches2 = glob.glob(pattern2)
    if matches2:
        matches2.sort(key=os.path.getmtime, reverse=True)
        return matches2[0]
    return None


def _read_events(traj_path):
    if traj_path.endswith(".zstd") or traj_path.endswith(".zst"):
        try:
            import zstandard as zstd
        except ImportError:
            print("ERROR: 缺少 zstandard 库，请使用已安装 zstandard 的 Python 运行（如 ppocrv5 环境）。", file=sys.stderr)
            sys.exit(2)
        dctx = zstd.ZstdDecompressor()
        with open(traj_path, "rb") as fh:
            with dctx.stream_reader(fh) as reader:
                raw = reader.read().decode("utf-8", errors="replace")
    else:
        with open(traj_path, "r", encoding="utf-8", errors="replace") as fh:
            raw = fh.read()
    events = []
    for line in raw.splitlines():
        line = line.strip()
        if not line:
            continue
        try:
            events.append(json.loads(line))
        except Exception:
            continue
    return events


def _extract_text_from_content(content):
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        parts = []
        for item in content:
            if isinstance(item, dict):
                t = item.get("text") or item.get("content") or ""
                if isinstance(t, str) and t:
                    parts.append(t)
            elif isinstance(item, str):
                parts.append(item)
        return "\n".join(parts)
    return str(content) if content is not None else ""


def _resolve_session(dsh_dir, session_arg):
    sessions = _load_projcache_sessions(dsh_dir)
    if not sessions:
        print("未在 " + dsh_dir + " 下找到任何 DeepSeek Harness 会话。")
        sys.exit(1)
    if not session_arg:
        return sessions[0]
    for s in sessions:
        if s["session_id"] == session_arg or session_arg in s["session_id"]:
            return s
    print(f"未找到匹配的会话: {session_arg}")
    sys.exit(1)


def cmd_list(args):
    sessions = _load_projcache_sessions(args.dsh_dir)
    if args.active_only:
        sessions = [s for s in sessions if s["turn_open"] or s["pending_calls"]]
    sessions = sessions[: args.limit]
    if getattr(args, "json", False):
        print(json.dumps({"sessions": sessions}, ensure_ascii=False))
        return
    if not sessions:
        print("没有符合条件的 DeepSeek Harness 会话。")
        return
    for idx, s in enumerate(sessions, 1):
        status = "RUNNING" if (s["turn_open"] or s["pending_calls"]) else "IDLE"
        pending_str = f" pending={len(s['pending_calls'])}" if s["pending_calls"] else ""
        print(f"{idx}. [{status}] {s['session_id']} | {s['title'] or '(无标题)'}")
        print(f"   model={s['model'] or '-'} | turn={s['turns']} steps={s['steps']}{pending_str} | updated={_fmt_ts(s['mtime'])}")
        print(f"   cwd={s['cwd']}")


def _collect_tail_items(traj_path, steps):
    events = _read_events(traj_path)
    interesting = []
    for ev in events:
        etype = ev.get("type", "")
        data = ev.get("data") or {}
        seq = ev.get("seq")
        raw_ts = ev.get("time")
        ts = _fmt_ts(raw_ts)
        if etype == "assistant/message":
            msg = data.get("message") or {}
            content = msg.get("content") or []
            for block in (content if isinstance(content, list) else []):
                if isinstance(block, dict) and block.get("type") in ("reasoning", "text"):
                    txt = (block.get("text") or "").strip()
                    if txt:
                        interesting.append({
                            "seq": seq,
                            "time": raw_ts,
                            "ts": ts,
                            "tag": f"assistant/{block['type']}",
                            "text": txt[:400],
                        })
        elif etype == "tool/call":
            name = data.get("name", "")
            raw_args = data.get("arguments", "")
            summary = raw_args
            try:
                parsed = json.loads(raw_args) if isinstance(raw_args, str) else raw_args
                if isinstance(parsed, dict):
                    summary = parsed.get("description") or parsed.get("command") or json.dumps(parsed, ensure_ascii=False)
            except Exception:
                pass
            interesting.append({
                "seq": seq,
                "time": raw_ts,
                "ts": ts,
                "tag": f"tool/call:{name}",
                "text": str(summary).strip()[:400],
            })
        elif etype == "job/registered":
            label = data.get("label") or data.get("jobId") or ""
            interesting.append({
                "seq": seq,
                "time": raw_ts,
                "ts": ts,
                "tag": "job/registered",
                "text": label[:200],
            })
        elif etype == "tool/result":
            msg = data.get("message") or {}
            txt = _extract_text_from_content(msg.get("content")).strip()
            interesting.append({
                "seq": seq,
                "time": raw_ts,
                "ts": ts,
                "tag": "tool/result",
                "text": txt[:400],
            })
    count = max(1, steps * 3)
    return interesting[-count:]


def cmd_tail(args):
    sess = _resolve_session(args.dsh_dir, args.session)
    traj = _find_trajectory_file(args.dsh_dir, sess["session_id"])
    items = _collect_tail_items(traj, args.steps) if traj else []
    if getattr(args, "json", False):
        print(json.dumps({
            "session": sess,
            "trajectory": traj,
            "items": items,
        }, ensure_ascii=False))
        return
    print(f"=== Session: {sess['session_id']} | {sess['title']} ===")
    print(f"cwd={sess['cwd']} | turn={sess['turns']} steps={sess['steps']} | turnOpen={sess['turn_open']}")
    if not traj:
        print("未找到对应的 session.v4.jsonl.zstd 轨迹文件。")
        return
    for item in items:
        one_line = re.sub(r"\s+", " ", item["text"])
        print(f"[{item['seq']}] {item['ts']} | {item['tag']}: {one_line}")


def _collect_inspect_findings(sess, traj, stale_sec):
    findings = []
    now_ms = int(time.time() * 1000)
    for call_id, started_ms in (sess["pending_calls"] or {}).items():
        elapsed = (now_ms - int(started_ms)) / 1000.0
        if elapsed >= stale_sec:
            findings.append({
                "level": "STALL",
                "message": f"工具调用 {call_id} 已挂起 {elapsed:.0f}s (阈值 {stale_sec}s)",
            })

    if traj:
        events = _read_events(traj)
        recent = events[-80:]
        err_pat = re.compile(r"(Traceback \(most recent call last\)|exit code[:= ]+[1-9]|ModuleNotFoundError|FileNotFoundError|OSError:|ERROR[:\] ])", re.I)
        false_pass_pat = re.compile(r"(items\s*[:= ]\s*0\b|image_size\s*[:= ]\s*\[\]|errorcode\s*[:= ]\s*-[0-9]+)", re.I)
        for ev in recent:
            etype = ev.get("type", "")
            seq = ev.get("seq")
            data = ev.get("data") or {}
            if etype == "tool/result":
                txt = _extract_text_from_content((data.get("message") or {}).get("content"))
                if err_pat.search(txt):
                    snippet = re.sub(r"\s+", " ", txt)[:260]
                    findings.append({"level": "ERROR", "message": f"seq={seq} tool/result 命中错误特征: {snippet}"})
                if false_pass_pat.search(txt):
                    snippet = re.sub(r"\s+", " ", txt)[:260]
                    findings.append({"level": "FALSE_PASS", "message": f"seq={seq} tool/result 命中空结果/假通过特征: {snippet}"})
            elif etype == "assistant/message":
                content = (data.get("message") or {}).get("content") or []
                txt = _extract_text_from_content(content)
                if false_pass_pat.search(txt):
                    snippet = re.sub(r"\s+", " ", txt)[:260]
                    findings.append({"level": "FALSE_PASS", "message": f"seq={seq} assistant 提及空结果: {snippet}"})
    return findings[-15:]


def cmd_inspect(args):
    sess = _resolve_session(args.dsh_dir, args.session)
    traj = _find_trajectory_file(args.dsh_dir, sess["session_id"])
    findings = _collect_inspect_findings(sess, traj, args.stale_sec)
    if getattr(args, "json", False):
        print(json.dumps({
            "session": sess,
            "trajectory": traj,
            "findings": findings,
        }, ensure_ascii=False))
        return
    print(f"=== Inspect: {sess['session_id']} | {sess['title']} ===")
    if not findings:
        print("OK: 未发现明显卡死、报错或空结果假通过特征。")
    else:
        print(f"发现 {len(findings)} 条告警：")
        for item in findings:
            print(f"  [{item['level']}] {item['message']}")


def main():
    parser = argparse.ArgumentParser(description="Monitor local DeepSeek Harness (.dsh) sessions")
    parser.add_argument("--dsh-dir", default=DEFAULT_DSH_DIR, help="Path to .dsh directory")
    sub = parser.add_subparsers(dest="cmd", required=True)

    p_list = sub.add_parser("list", help="List DeepSeek Harness sessions")
    p_list.add_argument("--active-only", action="store_true", help="Show only active sessions")
    p_list.add_argument("--limit", type=int, default=10, help="Max sessions to display")
    p_list.add_argument("--json", action="store_true", help="Output JSON")
    p_list.set_defaults(func=cmd_list)

    p_tail = sub.add_parser("tail", help="Show recent steps of a session")
    p_tail.add_argument("--session", default=None, help="Session ID or substring")
    p_tail.add_argument("--steps", type=int, default=5, help="Number of recent steps")
    p_tail.add_argument("--json", action="store_true", help="Output JSON")
    p_tail.set_defaults(func=cmd_tail)

    p_ins = sub.add_parser("inspect", help="Inspect session for stalls, errors, or false passes")
    p_ins.add_argument("--session", default=None, help="Session ID or substring")
    p_ins.add_argument("--stale-sec", type=int, default=300, help="Seconds before a pending call is considered stalled")
    p_ins.add_argument("--json", action="store_true", help="Output JSON")
    p_ins.set_defaults(func=cmd_inspect)

    args = parser.parse_args()
    args.func(args)


if __name__ == "__main__":
    main()
