#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
初始化脚本：删库重建 + 预置两个账号（admin / developer）。

[SEC] 密码不再写死在仓库里：
      · 优先读环境变量 INIT_ADMIN_PASSWORD / INIT_DEV_PASSWORD
      · 没给就随机生成一个强密码，并在**本次运行结束时打印一次**（只打印一次，
        因为它不进版本库；请自行保存）。
      注意：重复运行不会自动改已有账号的密码，除非加 --reset-passwords。

账号 1：党的好干部 / <见上> / 角色=admin     / 积分=50
账号 2：狐本无忧   / <见上> / 角色=developer / 积分=50

用法：
    python scripts/init_accounts.py              # 干跑
    python scripts/init_accounts.py --apply      # 执行（重建库）
    python scripts/init_accounts.py --apply --keep   # 保留旧库，只加账号

依赖：Python 3.7+、Node.js（用于生成 bcrypt 哈希）
必须：先停掉后端，SQLite 有写锁
"""

import os
import secrets
import argparse
import sqlite3
import subprocess
import sys
import time
from pathlib import Path

# [FIX] Windows/GBK 控制台下 stdout 被重定向（CI、`| Tee-Object`、`> log.txt`）时，
#       打印 ⚠ / ✓ 之类的字符会抛 UnicodeEncodeError 并以 exit 1 中断整个脚本。
#       显式切到 UTF-8，无法编码的字符降级替换，保证脚本在管道里也能跑完。
try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")
except Exception:
    pass

SERVER_DIR = Path(__file__).resolve().parent.parent
DB_PATH = SERVER_DIR / "chat.db"

# ============================================================
# 要创建的账号
#
# [SEC] 不再把明文密码写进仓库：优先取环境变量，缺失则随机生成，
#       并在收尾时打印一次（生成值每次运行都不同，不要提交到任何地方）。
# ============================================================
import os
import secrets

_GENERATED_PASSWORDS = {}


def _password_for(env_key: str, label: str) -> str:
    """从环境变量取密码；没有就随机生成一个强密码（记录以便收尾时打印一次）。"""
    from_env = os.environ.get(env_key, "").strip()
    if from_env:
        return from_env
    # token_urlsafe(12) ≈ 16 字符、约 96 bit 熵
    pw = secrets.token_urlsafe(12)
    _GENERATED_PASSWORDS[label] = pw
    return pw


ACCOUNTS = [
    {
        "username": "党的好干部",
        "password": _password_for("INIT_ADMIN_PASSWORD", "党的好干部"),
        "nickname": "党的好干部",
        "role": "admin",
        "points": 50,
    },
    {
        "username": "狐本无忧",
        "password": _password_for("INIT_DEV_PASSWORD", "狐本无忧"),
        "nickname": "狐本无忧",
        "role": "developer",
        "points": 50,
    },
]


def log(msg, level="info"):
    prefix = {"info": "  ", "ok": "  ✓", "warn": "  ⚠", "err": "  ✗"}.get(level, "  ")
    print(f"{prefix} {msg}")


# ============================================================
# bcrypt 哈希（调 Node，保证和后端一致）
# ============================================================
def bcrypt_hash(password: str) -> str:
    node_script = (
        "const bcrypt=require('bcryptjs');"
        "const p=process.argv[1];"
        "bcrypt.hash(p,10).then(h=>process.stdout.write(h));"
    )
    try:
        result = subprocess.run(
            ["node", "-e", node_script, password],
            cwd=str(SERVER_DIR),
            capture_output=True,
            text=True,
            check=True,
            timeout=30,
        )
        h = result.stdout.strip()
        if not h.startswith("$2"):
            raise RuntimeError(f"bcrypt 输出异常: {h!r}")
        return h
    except FileNotFoundError:
        log("找不到 node，请确认已安装 Node.js 且在 PATH 中", "err")
        sys.exit(1)
    except subprocess.CalledProcessError as e:
        log(f"bcrypt 失败: {e.stderr}", "err")
        sys.exit(1)


# ============================================================
# 删库
# ============================================================
def drop_db():
    for suffix in ["", "-shm", "-wal"]:
        p = Path(str(DB_PATH) + suffix)
        if p.exists():
            p.unlink()
            log(f"已删除 {p.name}", "ok")


# ============================================================
# 建最小表结构（后端启动时再补全其余表）
# ============================================================
def ensure_min_schema():
    conn = sqlite3.connect(str(DB_PATH))
    conn.executescript(
        """
        CREATE TABLE IF NOT EXISTS users (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          username TEXT UNIQUE NOT NULL,
          password_hash TEXT NOT NULL,
          nickname TEXT NOT NULL,
          avatar TEXT NOT NULL DEFAULT '',
          created_at INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS user_points (
          user_id INTEGER PRIMARY KEY,
          balance INTEGER NOT NULL DEFAULT 50,
          frozen INTEGER NOT NULL DEFAULT 0,
          updated_at INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS points_transactions (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          user_id INTEGER NOT NULL,
          delta INTEGER NOT NULL,
          balance_after INTEGER NOT NULL,
          reason TEXT NOT NULL,
          ref_type TEXT,
          ref_id INTEGER,
          note TEXT,
          created_at INTEGER NOT NULL
        );
        """
    )
    conn.commit()
    conn.close()


def ensure_user_columns(conn):
    cols = {r[1] for r in conn.execute("PRAGMA table_info(users)").fetchall()}
    add = []
    if "role" not in cols:
        add.append("ALTER TABLE users ADD COLUMN role TEXT NOT NULL DEFAULT 'user'")
    if "status" not in cols:
        add.append("ALTER TABLE users ADD COLUMN status TEXT NOT NULL DEFAULT 'active'")
    if "banned_at" not in cols:
        add.append("ALTER TABLE users ADD COLUMN banned_at INTEGER")
    if "banned_by" not in cols:
        add.append("ALTER TABLE users ADD COLUMN banned_by INTEGER")
    if "ban_reason" not in cols:
        add.append("ALTER TABLE users ADD COLUMN ban_reason TEXT")
    if "last_promoted_at" not in cols:
        add.append("ALTER TABLE users ADD COLUMN last_promoted_at INTEGER")
    for sql in add:
        conn.execute(sql)
        log(f"补列: {sql.split('ADD COLUMN ')[1].split(' ')[0]}")


# ============================================================
# 创建 / 更新账号
# ============================================================
def upsert_account(conn, acc):
    pw_hash = bcrypt_hash(acc["password"])
    now = int(time.time() * 1000)

    row = conn.execute(
        "SELECT id FROM users WHERE username = ?", (acc["username"],)
    ).fetchone()

    if row:
        user_id = row[0]
        conn.execute(
            """UPDATE users
               SET password_hash = ?, nickname = ?, role = ?, status = 'active'
               WHERE id = ?""",
            (pw_hash, acc["nickname"], acc["role"], user_id),
        )
        log(f"已更新 {acc['username']} (id={user_id}, role={acc['role']})", "ok")
    else:
        cur = conn.execute(
            """INSERT INTO users
               (username, password_hash, nickname, avatar, role, status, created_at)
               VALUES (?, ?, ?, ?, ?, 'active', ?)""",
            (acc["username"], pw_hash, acc["nickname"], "", acc["role"], now),
        )
        user_id = cur.lastrowid
        log(f"已创建 {acc['username']} (id={user_id}, role={acc['role']})", "ok")

    # 积分
    p = conn.execute(
        "SELECT balance FROM user_points WHERE user_id = ?", (user_id,)
    ).fetchone()
    if not p:
        conn.execute(
            "INSERT INTO user_points (user_id, balance, frozen, updated_at) VALUES (?, ?, 0, ?)",
            (user_id, acc["points"], now),
        )
        conn.execute(
            """INSERT INTO points_transactions
               (user_id, delta, balance_after, reason, created_at)
               VALUES (?, ?, ?, 'signup', ?)""",
            (user_id, acc["points"], acc["points"], now),
        )
        log(f"  {acc['username']} 积分初始化 {acc['points']}", "ok")
    else:
        log(f"  {acc['username']} 积分已存在 ({p[0]})，跳过", "info")


# ============================================================
# 主流程
# ============================================================
def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--apply", action="store_true", help="实际执行")
    parser.add_argument("--keep", action="store_true", help="保留旧库，只加账号")
    args = parser.parse_args()

    dry = not args.apply

    print()
    log(f"数据库: {DB_PATH}")
    log(f"模式: {'干跑' if dry else '执行'}" + (" + 保留旧库" if args.keep else " + 重建"))
    print()

    if dry:
        log("干跑：不会修改任何文件。加 --apply 执行。", "warn")
        for acc in ACCOUNTS:
            log(f"将创建/更新: {acc['username']} / 角色={acc['role']} / 积分={acc['points']}")
        return

    if DB_PATH.exists() and not args.keep:
        log("删除旧数据库...", "info")
        drop_db()

    log("建最小表结构...", "info")
    ensure_min_schema()

    log("写入账号...", "info")
    conn = sqlite3.connect(str(DB_PATH))
    conn.execute("PRAGMA foreign_keys = ON")
    ensure_user_columns(conn)

    for acc in ACCOUNTS:
        upsert_account(conn, acc)

    conn.commit()
    conn.close()

    print()
    log("完成。启动后端后，server/src/db/schema.js 会自动补充其余表结构。", "ok")
    print()
    log("账号一览：", "info")
    for acc in ACCOUNTS:
        if acc["username"] in _GENERATED_PASSWORDS:
            log(f"  {acc['username']} / {acc['password']} / {acc['role']}  （随机生成，仅此一次显示，请立即保存）")
        else:
            log(f"  {acc['username']} / ******（取自环境变量）/ {acc['role']}")
    print()
    if _GENERATED_PASSWORDS:
        log("提示：想固定密码可改用环境变量 INIT_ADMIN_PASSWORD / INIT_DEV_PASSWORD。", "warn")
    log("启动命令示例：", "info")
    log("  npm start", "info")


if __name__ == "__main__":
    main()