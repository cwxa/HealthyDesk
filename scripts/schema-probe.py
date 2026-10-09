"""表结构守卫的**证据收集**（判据在 scripts/verify-schema.mjs）。

跑法：
    python scripts/schema-probe.py > <某处>.json

与 `timefmt-probe.py` 同一套路：Python 只负责"把事实摆出来"，是绿是红由 node 断言。
分开的理由是 `verify-*.mjs` 是判据的主人，而且**判据要能同时看到两端**
（桌面 SQLite 的列、移动端 IndexedDB 的字段、导出规格的字段）—— 那三者在同一个
进程里才比得了。

本脚本做四件事：

1. 报出迁移清单（编号、是否连续、`LATEST_VERSION`）—— "编号必须连续递增"是
   `MIGRATIONS` 列表的硬要求，但此前**没有任何地方断言过它**。
2. 在一个**全新的空库**上跑真实的 `apply_migrations`，报出每张表的列。
3. 造一个 **v4 时代**的库（有 `activity_log` 表与数据、但**没有** `action_scores` 列），
   跑真实的 `apply_migrations`，报出：升到了几版、列集合变成什么、老行有没有丢、
   新列在旧行上是 NULL 还是别的值。
4. 在同一个库上**再跑** `apply_migrations`，并额外构造一次**真正的重放**：
   删掉最新的版本行（等价于"迁移成功了但版本号没记上"）再跑一遍。
   🔴 这才是幂等性真正要防的场景，也是本文件存在的首要理由：迁移 5 是
   `ALTER TABLE ... ADD COLUMN`，而 SQLite **没有** `ADD COLUMN IF NOT EXISTS`；
   若写成裸 SQL，重放会抛 "duplicate column name" —— 而"成功但版本号没记上"之后
   **一定会重放**（版本号是在脚本成功之后才写的，见 `db/migrations.py` 顶部）。
   线上表现是**应用再也起不来**。
   ⚠️ 只跑一次 `apply_migrations` 是**验不到**这条的：runner 会按版本号
   `if version <= start: continue` 直接跳过已应用的迁移。这个坑是被变异测试 S1
   逼出来的（S1 去掉了迁移里的存在性判断，守卫却依然全绿）。

🔴 全程只使用 `:memory:` 与临时文件，绝不打开用户的真实数据库。
"""

import asyncio
import json
import os
import sys
import tempfile

sys.path.insert(0, os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "backend"))

import aiosqlite  # noqa: E402

from db.migrations import (  # noqa: E402
    ACTION_SCORES_COLUMN,
    BASELINE_SQL,
    DAILY_AGG_SQL,
    LATEST_VERSION,
    MIGRATIONS,
    RETENTION_SETTING_SQL,
    TIMESTAMP_UTC_SQL,
    apply_migrations,
)

# v4 时代的迁移集合：用它造老库，确保"老库"的形态与真实历史一致，
# 而不是我凭记忆手写一份建表 SQL（手写那份一旦与历史不符，这个实验就什么都没验到）。
V4_SCRIPTS = [BASELINE_SQL, DAILY_AGG_SQL, RETENTION_SETTING_SQL, TIMESTAMP_UTC_SQL]

TABLES = ("usage_record", "posture_score", "activity_log", "settings", "posture_daily")


async def _columns(db, table: str) -> list:
    cur = await db.execute(f"PRAGMA table_info({table})")
    rows = await cur.fetchall()
    out = []
    for r in rows:
        out.append(r["name"] if hasattr(r, "keys") else r[1])
    return out


async def _table_names(db) -> list:
    cur = await db.execute("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
    return [r["name"] if hasattr(r, "keys") else r[0] for r in await cur.fetchall()]


async def fresh_schema() -> dict:
    """空库 → 跑完所有迁移：每张表的列。"""
    async with aiosqlite.connect(":memory:") as db:
        db.row_factory = aiosqlite.Row
        version = await apply_migrations(db)
        cols = {t: await _columns(db, t) for t in TABLES}
        return {"version": version, "columns": cols, "tables": sorted(await _table_names(db))}


async def upgrade_from_v4() -> dict:
    """v4 老库（有数据、无 `action_scores` 列）→ 升到最新，再跑一遍验幂等。"""
    fd, path = tempfile.mkstemp(prefix="neckguardian-schema-", suffix=".db")
    os.close(fd)
    try:
        async with aiosqlite.connect(path) as db:
            db.row_factory = aiosqlite.Row

            # ---- 造老库：只跑 v1–v4，并塞进 3 条活动记录 ----
            for script in V4_SCRIPTS:
                await db.executescript(script)
            await db.executemany(
                "INSERT INTO activity_log (timestamp, activity_type, exercise_count, duration_sec, avg_score)"
                " VALUES (?, ?, ?, ?, ?)",
                [
                    ("2026-09-24T02:00:00.000Z", "exercise", 7, 82, 71),
                    ("2026-09-24T06:00:00.000Z", "exercise", 7, 82, 64),
                    ("2026-09-25T01:00:00.000Z", "exercise", 7, 82, 88),
                ],
            )
            await db.commit()
            before_cols = await _columns(db, "activity_log")
            before_rows = (await (await db.execute("SELECT COUNT(*) AS n FROM activity_log")).fetchone())["n"]
            before_sums = [
                r["avg_score"]
                for r in await (await db.execute("SELECT avg_score FROM activity_log ORDER BY timestamp")).fetchall()
            ]

            # ---- 升级 ----
            version_after = await apply_migrations(db)
            after_cols = await _columns(db, "activity_log")
            rows = await (
                await db.execute("SELECT timestamp, avg_score, action_scores FROM activity_log ORDER BY timestamp")
            ).fetchall()
            after_rows = len(rows)

            # ---- 再跑一遍（幂等）----
            second_error = None
            second_version = None
            try:
                second_version = await apply_migrations(db)
            except Exception as exc:  # noqa: BLE001
                second_error = f"{type(exc).__name__}: {exc}"
            second_cols = await _columns(db, "activity_log")
            second_rows = (await (await db.execute("SELECT COUNT(*) AS n FROM activity_log")).fetchone())["n"]

            # ---- 🔴 真正危险的那一遍：模拟「迁移成功，但版本号没记上」----
            #
            # 上面那次"再跑一遍"其实**什么都没验到**：`apply_migrations` 会按版本号
            # `if version <= start: continue` 直接跳过已应用的迁移。也就是说，
            # 一个**不幂等**的迁移在正常路径上永远不会被执行第二次 —— 除非出现
            # "脚本成功了、版本号没写进去"的状态，而那正是版本号"在成功之后才记"的设计
            # 所允许的窗口（进程在这两步之间被杀掉）。
            #
            # 所以这里**显式构造**那个状态：删掉 v5 的版本行（等价于"没记上"），
            # 再跑一次 `apply_migrations`。此时迁移 5 会在"列已经存在"的库上重新执行 ——
            # 只有真正幂等的实现才能过。裸 `ALTER TABLE ... ADD COLUMN` 会在这里抛
            # "duplicate column name"，而线上的表现就是**应用再也起不来**。
            #
            # 这条实验是被变异测试 S1 逼出来的：S1 把"列已存在就跳过"的判断去掉，
            # 守卫却依然全绿 —— 因为当时只跑了上面那次会被跳过的"第二遍"。
            # v6 加入后仍重放 v5，保留原有可空动作列幂等覆盖。
            await db.execute("DELETE FROM schema_version WHERE version >= 5")
            await db.commit()
            replay_error = None
            replay_version = None
            try:
                replay_version = await apply_migrations(db)
            except Exception as exc:  # noqa: BLE001
                replay_error = f"{type(exc).__name__}: {exc}"
            replay_cols = await _columns(db, "activity_log")
            replay_rows = (await (await db.execute("SELECT COUNT(*) AS n FROM activity_log")).fetchone())["n"]

            # 版本表里不该出现重复编号
            version_rows = [
                r["version"] if hasattr(r, "keys") else r[0]
                for r in await (await db.execute("SELECT version FROM schema_version ORDER BY version")).fetchall()
            ]

            return {
                "before_columns": before_cols,
                "before_rows": before_rows,
                "before_avg_scores": before_sums,
                "version_after": version_after,
                "after_columns": after_cols,
                "after_rows": after_rows,
                "after_avg_scores": [r["avg_score"] for r in rows],
                "after_action_scores": [r["action_scores"] for r in rows],
                "second_error": second_error,
                "second_version": second_version,
                "second_columns": second_cols,
                "second_rows": second_rows,
                "replay_error": replay_error,
                "replay_version": replay_version,
                "replay_columns": replay_cols,
                "replay_rows": replay_rows,
                "version_rows": version_rows,
                "has_column_before": ACTION_SCORES_COLUMN in before_cols,
            }
    finally:
        try:
            os.unlink(path)
        except OSError:
            pass


def main():
    payload = {
        "migration_numbers": [v for v, _ in MIGRATIONS],
        "latest_version": LATEST_VERSION,
        "action_scores_column": ACTION_SCORES_COLUMN,
        "callable_migrations": [v for v, s in MIGRATIONS if callable(s)],
        "fresh": asyncio.run(fresh_schema()),
        "upgrade": asyncio.run(upgrade_from_v4()),
    }
    json.dump(payload, sys.stdout, ensure_ascii=False, separators=(",", ":"), sort_keys=True)
    sys.stdout.write("\n")


if __name__ == "__main__":
    main()
