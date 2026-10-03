#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
清理聊天/商城数据。

默认行为（MODE = "history"）：
    保留「你爹」账号本身，删除它的历史消息、好友、群、商品、订单、积分流水等。
    其他所有账号：删账号 + 删一切关联数据。

用法：
    python scripts/clean_history.py                 # 干跑（只打印，不写库）
    python scripts/clean_history.py --apply         # 实际执行
    python scripts/clean_history.py --apply --mode=nuke   # 连上传文件也删
    python scripts/clean_history.py --keeper=你爹 --apply # 指定保留账号

重要：
    1) 执行前务必停掉后端服务（SQLite 有写锁）
    2) 脚本会自动备份 chat.db 到 chat.db.bak-<时间戳>
    3) 默认干跑，看清楚了再 --apply
"""

import argparse
import os
import shutil
import sqlite3
import sys
import time
from pathlib import Path

# [FIX] Windows/GBK 控制台下 stdout 被重定向时，打印 ⚠ / ✓ 会抛
#       UnicodeEncodeError 并以 exit 1 中断脚本（CI / 日志重定向全部不可用）。
try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")
except Exception:
    pass


# ============================================================
# 配置
# ============================================================
SERVER_DIR = Path(__file__).resolve().parent.parent
DEFAULT_DB = SERVER_DIR / "chat.db"
DEFAULT_KEEPER = "你爹"
DEFAULT_UPLOAD = SERVER_DIR / "uploads"


def log(msg, level="info"):
    prefix = {
        "info": "  ",
        "ok": "  ✓",
        "warn": "  ⚠",
        "err": "  ✗",
        "step": "\n===",
    }.get(level, "  ")
    if level == "step":
        print(f"\n\033[1m{msg}\033[0m")
    else:
        print(f"{prefix} {msg}")


# ============================================================
# 备份
# ============================================================
def backup_db(db_path: Path) -> Path:
    ts = time.strftime("%Y%m%d-%H%M%S")
    bak = db_path.with_suffix(db_path.suffix + f".bak-{ts}")
    shutil.copy2(db_path, bak)
    log(f"已备份: {bak.name}", "ok")
    return bak


# ============================================================
# 检查保留账号
# ============================================================
def find_keeper(conn: sqlite3.Connection, keeper_username: str):
    row = conn.execute(
        "SELECT id, username, nickname FROM users WHERE username = ?",
        (keeper_username,),
    ).fetchone()
    if not row:
        log(f"找不到用户名「{keeper_username}」，请检查拼写", "err")
        sys.exit(1)
    log(f"保留账号: id={row[0]} username={row[1]} nickname={row[2]}", "ok")
    return row[0]


# ============================================================
# 各表的清理
# ============================================================
def collect_target_ids(conn, keeper_id: int):
    """
    收集除保留账号外的所有 user_id。
    """
    rows = conn.execute(
        "SELECT id FROM users WHERE id != ?", (keeper_id,)
    ).fetchall()
    return [r[0] for r in rows]


def clean_messages(conn, keeper_id, targets, mode, dry):
    placeholders = ",".join("?" * len(targets)) if targets else "NULL"
    if targets:
        n1 = conn.execute(
            f"SELECT COUNT(*) FROM messages WHERE sender_id IN ({placeholders})",
            targets,
        ).fetchone()[0]
    else:
        n1 = 0

    rows = conn.execute(
        "SELECT id, room_type, room_id FROM messages WHERE room_type='private'"
    ).fetchall()
    target_set = set(targets)
    private_ids = []
    for mid, _rtype, rid in rows:
        try:
            parts = rid.replace("p_", "").split("_")
            a, b = int(parts[0]), int(parts[1])
        except Exception:
            continue
        if a in target_set or b in target_set:
            private_ids.append(mid)

    n2 = len(private_ids)
    log(f"将删除 messages: {n1} 条（target 发的） + {n2} 条（私聊房间）", "info")

    if dry:
        return

    if targets:
        conn.execute(
            f"DELETE FROM messages WHERE sender_id IN ({placeholders})",
            targets,
        )

    if private_ids:
        BATCH = 500
        for i in range(0, len(private_ids), BATCH):
            chunk = private_ids[i:i + BATCH]
            ph = ",".join("?" * len(chunk))
            conn.execute(f"DELETE FROM messages WHERE id IN ({ph})", chunk)


def clean_message_reads(conn, keeper_id, targets, dry):
    if not targets:
        return
    placeholders = ",".join("?" * len(targets))

    n1 = conn.execute(
        f"SELECT COUNT(*) FROM message_reads WHERE user_id IN ({placeholders})",
        targets,
    ).fetchone()[0]

    n2 = conn.execute(
        "SELECT COUNT(*) FROM message_reads WHERE message_id NOT IN (SELECT id FROM messages)"
    ).fetchone()[0]

    log(f"将删除 message_reads: {n1} 条（target 已读）+ {n2} 条（孤儿）", "info")
    if dry:
        return

    conn.execute(
        f"DELETE FROM message_reads WHERE user_id IN ({placeholders})",
        targets,
    )
    conn.execute(
        "DELETE FROM message_reads WHERE message_id NOT IN (SELECT id FROM messages)"
    )


def clean_friendships(conn, keeper_id, targets, dry):
    if not targets:
        return
    placeholders = ",".join("?" * len(targets))
    n = conn.execute(
        f"""SELECT COUNT(*) FROM friendships
            WHERE user_id IN ({placeholders}) OR friend_id IN ({placeholders})""",
        targets + targets,
    ).fetchone()[0]
    log(f"将删除 friendships: {n} 条", "info")
    if dry:
        return
    conn.execute(
        f"""DELETE FROM friendships
            WHERE user_id IN ({placeholders}) OR friend_id IN ({placeholders})""",
        targets + targets,
    )


def clean_friend_requests(conn, keeper_id, targets, dry):
    if not targets:
        return
    placeholders = ",".join("?" * len(targets))
    n = conn.execute(
        f"""SELECT COUNT(*) FROM friend_requests
            WHERE from_id IN ({placeholders}) OR to_id IN ({placeholders})""",
        targets + targets,
    ).fetchone()[0]
    log(f"将删除 friend_requests: {n} 条", "info")
    if dry:
        return
    conn.execute(
        f"""DELETE FROM friend_requests
            WHERE from_id IN ({placeholders}) OR to_id IN ({placeholders})""",
        targets + targets,
    )


def clean_groups_and_members(conn, keeper_id, targets, dry):
    if not targets:
        return
    placeholders = ",".join("?" * len(targets))

    owned = conn.execute(
        f"SELECT id FROM groups WHERE owner_id IN ({placeholders})",
        targets,
    ).fetchall()
    owned_ids = [r[0] for r in owned]

    member_rows = conn.execute(
        f"""SELECT group_id FROM group_members
            WHERE user_id IN ({placeholders})
              AND group_id NOT IN ({','.join('?' * len(owned_ids)) if owned_ids else 'NULL'})""",
        targets + owned_ids,
    ).fetchall()
    member_group_ids = list({r[0] for r in member_rows})

    log(f"将删除 groups: {len(owned_ids)} 个（target 是群主）", "info")
    log(f"将清理 group_members: target 在 {len(member_group_ids)} 个群里的成员记录", "info")

    if owned_ids:
        ph_owned = ",".join("?" * len(owned_ids))
        n_req_owned = conn.execute(
            f"SELECT COUNT(*) FROM group_requests WHERE group_id IN ({ph_owned})",
            owned_ids,
        ).fetchone()[0]
    else:
        n_req_owned = 0

    n_req_user = conn.execute(
        f"SELECT COUNT(*) FROM group_requests WHERE user_id IN ({placeholders})",
        targets,
    ).fetchone()[0]
    log(f"将删除 group_requests: {n_req_owned + n_req_user} 条", "info")

    if dry:
        return

    if owned_ids:
        BATCH = 500
        for i in range(0, len(owned_ids), BATCH):
            chunk = owned_ids[i:i + BATCH]
            ph = ",".join("?" * len(chunk))
            conn.execute(f"DELETE FROM group_members WHERE group_id IN ({ph})", chunk)
            conn.execute(f"DELETE FROM group_requests WHERE group_id IN ({ph})", chunk)
            conn.execute(f"DELETE FROM groups WHERE id IN ({ph})", chunk)

    conn.execute(
        f"""DELETE FROM group_members
            WHERE user_id IN ({placeholders})""",
        targets,
    )
    conn.execute(
        f"DELETE FROM group_requests WHERE user_id IN ({placeholders})",
        targets,
    )


def clean_shop(conn, keeper_id, targets, dry):
    if not targets:
        return
    placeholders = ",".join("?" * len(targets))

    seller_products = conn.execute(
        f"SELECT id FROM products WHERE seller_id IN ({placeholders})",
        targets,
    ).fetchall()
    seller_pids = [r[0] for r in seller_products]

    if seller_pids:
        ph = ",".join("?" * len(seller_pids))
        n_order_by_product = conn.execute(
            f"SELECT COUNT(*) FROM orders WHERE product_id IN ({ph})",
            seller_pids,
        ).fetchone()[0]
    else:
        n_order_by_product = 0

    n_order_by_buyer = conn.execute(
        f"SELECT COUNT(*) FROM orders WHERE buyer_id IN ({placeholders})",
        targets,
    ).fetchone()[0]

    log(f"将删除 products: {len(seller_pids)} 个（target 卖的）", "info")
    log(f"将删除 orders: {n_order_by_product}（商品被删） + {n_order_by_buyer}（target 买的）", "info")

    if dry:
        return

    if seller_pids:
        BATCH = 500
        for i in range(0, len(seller_pids), BATCH):
            chunk = seller_pids[i:i + BATCH]
            ph = ",".join("?" * len(chunk))
            conn.execute(f"DELETE FROM orders WHERE product_id IN ({ph})", chunk)
            conn.execute(f"DELETE FROM products WHERE id IN ({ph})", chunk)

    conn.execute(
        f"DELETE FROM orders WHERE buyer_id IN ({placeholders})",
        targets,
    )


def clean_points(conn, keeper_id, targets, dry):
    if not targets:
        return
    placeholders = ",".join("?" * len(targets))

    n_bal = conn.execute(
        f"SELECT COUNT(*) FROM user_points WHERE user_id IN ({placeholders})",
        targets,
    ).fetchone()[0]
    n_tx = conn.execute(
        f"SELECT COUNT(*) FROM points_transactions WHERE user_id IN ({placeholders})",
        targets,
    ).fetchone()[0]

    log(f"将删除 user_points: {n_bal} 行", "info")
    log(f"将删除 points_transactions: {n_tx} 条", "info")

    if dry:
        return
    conn.execute(
        f"DELETE FROM user_points WHERE user_id IN ({placeholders})",
        targets,
    )
    conn.execute(
        f"DELETE FROM points_transactions WHERE user_id IN ({placeholders})",
        targets,
    )


def clean_admin_audit(conn, keeper_id, targets, dry):
    if not targets:
        return
    placeholders = ",".join("?" * len(targets))

    n = conn.execute(
        f"""SELECT COUNT(*) FROM admin_audit
            WHERE actor_id IN ({placeholders})
               OR (target_type = 'user' AND target_id IN ({placeholders}))""",
        targets + targets,
    ).fetchone()[0]
    log(f"将删除 admin_audit: {n} 条", "info")
    if dry:
        return
    conn.execute(
        f"""DELETE FROM admin_audit
            WHERE actor_id IN ({placeholders})
               OR (target_type = 'user' AND target_id IN ({placeholders}))""",
        targets + targets,
    )


def clean_role_requests(conn, keeper_id, targets, dry):
    if not targets:
        return
    placeholders = ",".join("?" * len(targets))
    n = conn.execute(
        f"SELECT COUNT(*) FROM role_requests WHERE user_id IN ({placeholders})",
        targets,
    ).fetchone()[0]
    log(f"将删除 role_requests: {n} 条", "info")
    if dry:
        return
    conn.execute(
        f"DELETE FROM role_requests WHERE user_id IN ({placeholders})",
        targets,
    )


def clean_users(conn, keeper_id, targets, dry):
    if not targets:
        return
    log(f"将删除 users: {len(targets)} 个", "info")
    if dry:
        return
    placeholders = ",".join("?" * len(targets))
    conn.execute(f"DELETE FROM users WHERE id IN ({placeholders})", targets)


# ============================================================
# 清理上传文件（mode=nuke 时）
# ============================================================
def clean_upload_files(upload_root: Path, db_conn: sqlite3.Connection, keeper_id: int, dry: bool):
    if not upload_root.exists():
        log(f"上传目录不存在: {upload_root}", "warn")
        return

    keeper_avatar = db_conn.execute(
        "SELECT avatar FROM users WHERE id = ?", (keeper_id,)
    ).fetchone()
    keeper_avatar = keeper_avatar[0] if keeper_avatar else ""
    keeper_avatar_name = os.path.basename(keeper_avatar) if keeper_avatar else ""

    avatar_dir = upload_root / "avatars"
    file_dir = upload_root / "files"
    shop_dir = upload_root / "shop"

    n_avatar = 0
    if avatar_dir.exists():
        for p in avatar_dir.iterdir():
            if not p.is_file():
                continue
            if p.name == keeper_avatar_name:
                continue
            n_avatar += 1
            log(f"  [avatar] {p.name}", "info")
            if not dry:
                try:
                    p.unlink()
                except Exception as e:
                    log(f"删除失败: {p} ({e})", "warn")

    n_file = 0
    if file_dir.exists():
        for p in file_dir.iterdir():
            if p.is_file():
                n_file += 1
                if not dry:
                    try:
                        p.unlink()
                    except Exception as e:
                        log(f"删除失败: {p} ({e})", "warn")

    n_shop = 0
    if shop_dir.exists():
        for p in shop_dir.iterdir():
            if p.is_file():
                n_shop += 1
                if not dry:
                    try:
                        p.unlink()
                    except Exception as e:
                        log(f"删除失败: {p} ({e})", "warn")

    log(f"将删除上传文件: avatars={n_avatar}, files={n_file}, shop={n_shop}", "info")


# ============================================================
# 主流程
# ============================================================
def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--db", default=str(DEFAULT_DB), help="chat.db 路径")
    parser.add_argument("--keeper", default=DEFAULT_KEEPER, help="保留的用户名")
    parser.add_argument("--upload", default=str(DEFAULT_UPLOAD), help="uploads 目录")
    parser.add_argument("--apply", action="store_true", help="实际执行（默认干跑）")
    parser.add_argument(
        "--mode",
        choices=["history", "account", "nuke"],
        default="history",
        help="history=只删数据保留账号；account=删数据+删账号；nuke=连上传文件也删",
    )
    args = parser.parse_args()

    db_path = Path(args.db)
    if not db_path.exists():
        log(f"找不到数据库: {db_path}", "err")
        sys.exit(1)

    dry = not args.apply
    if dry:
        log("═══ 干跑模式 ═══ 不会修改数据库。加 --apply 实际执行。", "warn")
    else:
        log(f"═══ 实际执行 mode={args.mode} ═══", "warn")

    log(f"数据库: {db_path}")
    log(f"保留账号: {args.keeper}")
    log(f"模式: {args.mode}")

    if not dry:
        backup_db(db_path)

    conn = sqlite3.connect(str(db_path))
    conn.execute("PRAGMA foreign_keys = OFF")
    conn.isolation_level = None

    try:
        keeper_id = find_keeper(conn, args.keeper)
        targets = collect_target_ids(conn, keeper_id)

        if not targets:
            log("除了保留账号外没有其他用户，无需清理", "ok")
            return

        log(f"待处理账号数: {len(targets)}（除保留账号外全部）", "info")

        if not dry:
            conn.execute("BEGIN")

        log("清理消息", "step")
        clean_messages(conn, keeper_id, targets, args.mode, dry)
        clean_message_reads(conn, keeper_id, targets, dry)

        log("清理社交关系", "step")
        clean_friendships(conn, keeper_id, targets, dry)
        clean_friend_requests(conn, keeper_id, targets, dry)

        log("清理群", "step")
        clean_groups_and_members(conn, keeper_id, targets, dry)

        log("清理商城", "step")
        clean_shop(conn, keeper_id, targets, dry)

        log("清理积分", "step")
        clean_points(conn, keeper_id, targets, dry)

        log("清理管理记录", "step")
        clean_admin_audit(conn, keeper_id, targets, dry)
        clean_role_requests(conn, keeper_id, targets, dry)

        if args.mode in ("account", "nuke"):
            log("删除用户账号", "step")
            clean_users(conn, keeper_id, targets, dry)
        else:
            log("保留用户账号（mode=history）", "info")

        if args.mode == "nuke":
            log("清理上传文件", "step")
            clean_upload_files(Path(args.upload), conn, keeper_id, dry)

        if not dry:
            conn.execute("COMMIT")
            log("已提交事务", "ok")

        log("校验", "step")
        n_users = conn.execute("SELECT COUNT(*) FROM users").fetchone()[0]
        n_msgs = conn.execute("SELECT COUNT(*) FROM messages").fetchone()[0]
        log(f"剩余 users: {n_users}, messages: {n_msgs}", "info")

        if dry:
            log("干跑结束。没有修改任何数据。", "ok")
            log("确认无误后加 --apply 重新执行。", "info")
        else:
            log("清理完成。", "ok")

    except Exception as e:
        if not dry:
            try:
                conn.execute("ROLLBACK")
                log("事务已回滚", "warn")
            except Exception:
                pass
        log(f"失败: {e}", "err")
        import traceback
        traceback.print_exc()
        sys.exit(1)
    finally:
        conn.close()


if __name__ == "__main__":
    main()