#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
创建项目所需的所有空文件与目录。

用法：
    python scripts/scaffold.py                    # 干跑（只打印）
    python scripts/scaffold.py --apply            # 实际创建
    python scripts/scaffold.py --apply --force    # 已存在的也清空重建（危险）
    python scripts/scaffold.py --apply --no-config # 不写 config.yaml 默认内容

默认工作目录：脚本所在目录的上一级（即 server/）。
"""

import argparse
import sys
from pathlib import Path

# [FIX] Windows/GBK 控制台下 stdout 被重定向时，打印 ⚠ / ✓ 会抛
#       UnicodeEncodeError 并以 exit 1 中断脚本。切到 UTF-8 并降级替换。
try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")
except Exception:
    pass

# 脚本在 scripts/ 下，ROOT = server/
ROOT = Path(__file__).resolve().parent.parent

# ============================================================
# 目录列表（相对 ROOT）
# ============================================================
DIRS = [
    "src",
    "src/db",
    "src/auth",
    "src/middleware",
    "src/utils",
    "src/services",
    "src/routes",
    "src/socket",
    "src/socket/handlers",
    "scripts",
    "uploads",
    "uploads/avatars",
    "uploads/files",
    "uploads/shop",
    "uploads/covers",
]

# ============================================================
# 文件列表（相对 ROOT）
# ============================================================
FILES = [
    # ---- 入口 & 配置 ----
    "index.js",
    "config.yaml",
    "config.local.yaml.example",
    "package.json",
    ".gitignore",

    # ---- src 根 ----
    "src/config.js",
    "src/app.js",

    # ---- db ----
    "src/db/index.js",
    "src/db/schema.js",
    "src/db/seed.js",
    "src/db/tx.js",

    # ---- auth ----
    "src/auth/index.js",

    # ---- middleware ----
    "src/middleware/upload.js",

    # ---- utils ----
    "src/utils/avatar.js",
    "src/utils/filename.js",

    # ---- services ----
    "src/services/permissions.js",
    "src/services/points.js",
    "src/services/plagiarism.js",
    "src/services/products.js",

    # ---- routes ----
    "src/routes/index.js",
    "src/routes/auth.js",
    "src/routes/user.js",
    "src/routes/shop.js",
    "src/routes/shop_admin.js",
    "src/routes/download.js",
    "src/routes/roles.js",

    # ---- socket ----
    "src/socket/index.js",
    "src/socket/helpers.js",
    "src/socket/handlers/message.js",
    "src/socket/handlers/friend.js",
    "src/socket/handlers/group.js",
    "src/socket/handlers/presence.js",

    # ---- scripts ----
    "scripts/scaffold.py",
    "scripts/scaffold.ps1",
    "scripts/init_accounts.py",
    "scripts/clean_history.py",

    # ---- uploads 占位 ----
    "uploads/.gitkeep",
    "uploads/avatars/.gitkeep",
    "uploads/files/.gitkeep",
    "uploads/shop/.gitkeep",
    "uploads/covers/.gitkeep",
]

# ============================================================
# config.yaml 最小默认内容（仅当文件是空的时才写入）
# ============================================================
MINIMAL_CONFIG_YAML = """\
# 最小可用配置。完整版请参考项目文档。
# 加载顺序：config.yaml → config.local.yaml → 环境变量
server:
  port: 3001
  env: development

security:
  jwt:
    secret: change-me-in-production
    expiresIn: 7d

database:
  path: chat.db
  journal_mode: WAL
  foreign_keys: true
"""

CONFIG_LOCAL_EXAMPLE = """\
# 本地私有覆盖示例。复制为 config.local.yaml 后修改。
server:
  port: 3001

security:
  jwt:
    secret: dev-only-change-me
"""


def log(msg, level="info"):
    prefix = {"info": "  ", "ok": "  ✓", "warn": "  ⚠", "err": "  ✗"}.get(level, "  ")
    print(f"{prefix} {msg}")


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--apply", action="store_true", help="实际创建")
    parser.add_argument("--force", action="store_true",
                        help="已存在的文件也清空（默认跳过）")
    parser.add_argument("--no-config", action="store_true",
                        help="不写 config.yaml 最小默认内容")
    args = parser.parse_args()

    dry = not args.apply

    print()
    log(f"根目录: {ROOT}")
    log(f"模式: {'干跑' if dry else '执行'}" + (" + 强制清空" if args.force else ""))
    print()

    if not ROOT.exists():
        log(f"根目录不存在: {ROOT}", "err")
        sys.exit(1)

    if dry:
        log("干跑：不会创建任何文件。加 --apply 执行。", "warn")
        print()

    # ---------- 目录 ----------
    log("目录：", "info")
    for d in DIRS:
        p = ROOT / d
        if p.exists():
            log(f"[skip]  {d}", "info")
        else:
            log(f"[mkdir] {d}", "ok")
            if not dry:
                p.mkdir(parents=True, exist_ok=True)

    print()

    # ---------- 文件 ----------
    log("文件：", "info")
    n_created = 0
    n_skipped = 0
    n_forced = 0

    for f in FILES:
        p = ROOT / f
        if not dry:
            p.parent.mkdir(parents=True, exist_ok=True)

        if p.exists():
            if args.force and not dry:
                p.write_text("", encoding="utf-8")
                log(f"[force] {f}", "warn")
                n_forced += 1
            else:
                log(f"[skip]  {f}", "info")
                n_skipped += 1
        else:
            log(f"[new]   {f}", "ok")
            if not dry:
                p.write_text("", encoding="utf-8")
            n_created += 1

    print()

    # ---------- config.yaml 兜底 ----------
    if not args.no_config and not dry:
        cfg = ROOT / "config.yaml"
        if cfg.exists() and cfg.stat().st_size == 0:
            cfg.write_text(MINIMAL_CONFIG_YAML, encoding="utf-8")
            log("已写入 config.yaml 最小默认内容", "ok")

        local_ex = ROOT / "config.local.yaml.example"
        if local_ex.exists() and local_ex.stat().st_size == 0:
            local_ex.write_text(CONFIG_LOCAL_EXAMPLE, encoding="utf-8")
            log("已写入 config.local.yaml.example", "ok")

    # ---------- 汇总 ----------
    if dry:
        log(f"干跑结束。将创建 {n_created} 个文件，跳过 {n_skipped} 个。", "warn")
        log("确认后加 --apply 执行。", "info")
    else:
        log(f"完成。新建 {n_created}，跳过 {n_skipped}，清空 {n_forced}。", "ok")
        print()
        log("下一步：", "info")
        log("  1) 填好每个空文件的内容", "info")
        log("  2) npm install", "info")
        log("  3) python scripts/init_accounts.py --apply", "info")
        log("  4) npm start", "info")


if __name__ == "__main__":
    main()