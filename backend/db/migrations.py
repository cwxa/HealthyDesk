"""数据库 schema 版本与迁移（桌面端 SQLite）。

## 为什么需要它

在此之前 `init_db()` 只有一串 `CREATE TABLE IF NOT EXISTS`，这带来两个后果：

1. **加字段会静默失败**：`IF NOT EXISTS` 看到表已存在就整条跳过，新列永远不会出现。
   建表语句"执行成功"、日志无异常，读那列的代码却拿到 `None` —— 这是最难查的一类
   bug（本项目已经踩过多次"结论下早了"的坑）。
2. **没有版本可判断**：无从知道用户库里现在是哪一版，也就没法写"v1 升 v2"的逻辑。

本模块引入 `schema_version` 表 + 有序迁移列表解决这两点。

## 约定（改这里之前先读）

- 🔴 **迁移只增不改。** 已发布的迁移编号与内容**不得修改** —— 用户的库里已经跑过了，
  改它对老库无效、对新库生效，两端结构会分叉。新增改动一律**追加新编号**。
- 🔴 **每个迁移必须是幂等的 SQL**（`IF NOT EXISTS` / `INSERT OR IGNORE`）。
  原因：`executescript` 会先隐式 COMMIT，无法把整个迁移包进一个事务；若中途崩溃，
  会留下"半升级"状态。此时**重跑必须安全**，所以幂等是硬要求。版本号在脚本
  全部执行成功后才记录，因此重跑会重新执行同一编号的迁移。
- **迁移只在桌面端。** 移动端的等价物是 `src/platform/localDb.ts` 的
  `DB_VERSION` + `onupgradeneeded` 分支，两端要保持结构同构（字段名一致），
  否则导出的数据互相导入不了（见 ROADMAP 需求 4）。
"""

import logging

import aiosqlite
# 时间戳格式单点定义（见 services/timefmt.py）。本文件此前也自己拼了一遍。
from services.timefmt import now_iso_ms

logger = logging.getLogger("neckguardian.db.migrations")


# ---------------------------------------------------------------------------
# 迁移 1：基线 —— v1.3.x 起就有的四张表与默认设置。
#
# 内容与历史 `init_db()` **一字不差**：对全新库它就是建库脚本；对已有库
# （四表已在、但还没有 schema_version）它是一串幂等空操作，只负责把版本补记为 1。
# ---------------------------------------------------------------------------
BASELINE_SQL = """
    CREATE TABLE IF NOT EXISTS usage_record (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        date TEXT NOT NULL UNIQUE,
        usage_minutes INTEGER NOT NULL DEFAULT 0,
        break_count INTEGER NOT NULL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS posture_score (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        timestamp TEXT NOT NULL,
        head_angle REAL NOT NULL,
        shoulder_diff REAL NOT NULL,
        spine_angle REAL NOT NULL,
        score INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS activity_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        timestamp TEXT NOT NULL,
        activity_type TEXT NOT NULL DEFAULT 'exercise',
        exercise_count INTEGER NOT NULL DEFAULT 0,
        duration_sec INTEGER NOT NULL DEFAULT 0,
        avg_score INTEGER NOT NULL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
    );

    INSERT OR IGNORE INTO settings (key, value) VALUES ('reminder_interval', '30');
    INSERT OR IGNORE INTO settings (key, value) VALUES ('ai_enabled', 'false');
    INSERT OR IGNORE INTO settings (key, value) VALUES ('auto_start', 'false');
    INSERT OR IGNORE INTO settings (key, value) VALUES ('voice_enabled', 'true');
    INSERT OR IGNORE INTO settings (key, value) VALUES ('deepseek_api_key', '');
    INSERT OR IGNORE INTO settings (key, value) VALUES ('deepseek_base_url', '');
    INSERT OR IGNORE INTO settings (key, value) VALUES ('deepseek_model', 'deepseek-chat');
"""

# ---------------------------------------------------------------------------
# 迁移 2：数据保留与日粒度聚合所需的结构。
#
# - `posture_daily`：每天的**精确**聚合（存原始和，不存已取整的派生量，
#   否则跨天合并时误差会累积）。字段与移动端 IndexedDB 的 `posture_daily`
#   object store 严格同构。
# - `idx_posture_score_ts`：原始表此前**没有任何索引**，而按时间窗口查询
#   （今日均分 / 近 7 天趋势）与保留期清理都要扫时间列。原始表约 1.9 万行/天，
#   没有索引时每次查询都是全表扫描。
# ---------------------------------------------------------------------------
DAILY_AGG_SQL = """
    CREATE TABLE IF NOT EXISTS posture_daily (
        date TEXT PRIMARY KEY,
        sample_count INTEGER NOT NULL,
        score_sum REAL NOT NULL,
        min_score INTEGER NOT NULL,
        head_bad_count INTEGER NOT NULL DEFAULT 0,
        shoulder_bad_count INTEGER NOT NULL DEFAULT 0,
        spine_bad_count INTEGER NOT NULL DEFAULT 0,
        updated_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_posture_score_ts ON posture_score(timestamp);
"""


# ---------------------------------------------------------------------------
# 迁移 3：保留天数的设置项。
#
# 为什么单独一条迁移、而不是往迁移 1 里补一行 INSERT：迁移 1 早已在用户的库里跑过，
# 改它对老库无效、对新库生效，两端结构就会分叉（见模块顶部的"迁移只增不改"）。
# 这一条同时是迁移机制的第二次实战 —— 它证明"加一个设置项"确实能推到老库上。
# 读不到的兜底在 `services/retention.retention_days()`（回落默认 30），
# 所以这条迁移失败也不会让功能不可用。
# ---------------------------------------------------------------------------
RETENTION_SETTING_SQL = """
    INSERT OR IGNORE INTO settings (key, value) VALUES ('retention_days', '30');
"""


# ---------------------------------------------------------------------------
# 迁移 4：把历史时间戳统一到 UTC 契约格式，并让归档按新口径重算。
#
# 根因见 `services/timefmt.py`：桌面端此前用 `datetime.now().isoformat()`（**本地
# 时间、无时区标记**）写 `posture_score`，而所有按天判定都走
# `date(timestamp,'localtime')` —— SQLite 的 `localtime` 修饰符**假定输入是 UTC**。
# 在 UTC+8，本地 16:00 之后的采样会被算到次日，于是「今日均分」下午起就不再增长、
# 趋势图日期整体错位、保留期边界跟着偏、而错位的归档行一写进去就长期保留。
# 🔴 该缺陷在 CI runner（TZ=UTC、偏移为 0）上**完全不可见**，所以它需要构造
# 跨日界时刻的显式用例，不能指望换个环境自己暴露。
#
# 两步：
#
# 1. **统一格式**：把没有时区标记的串按「它是本地时间」换算成 UTC。
#    `'utc'` 修饰符正是这个语义（假定输入为本地时间、输出 UTC），因此转换前后
#    **本地日不变** —— 这是守卫断言的核心不变式：
#        date(转换后, 'localtime') == substr(原串, 1, 10)
#    已经带 `Z` / `+HH:MM` 的一律跳过：移动端导入的数据本来就是 UTC，再转一次
#    会把它算错。判断用 `NOT LIKE '%Z'` + `NOT LIKE '%+%'` —— 宁可漏、不可错。
#
# 2. **让归档重算**：`posture_daily` 的日期键是按旧口径（错位）算出来的，必须
#    整体重来。做法是删掉**原始表仍能覆盖的日期范围**内的归档行，交给紧随其后的
#    `rollup_daily` 重建 —— 启动流程是 `lifespan: init_db() → _run_maintenance()`，
#    两者之间没有请求窗口，所以不存在"界面看到空归档"的空档。
#    ⚠️ 范围**之外**的归档必须保留：那些天的原始采样已被保留策略清理，删掉就永久
#    消失 —— 保留它们正是 `posture_daily` 存在的意义。
#
# 幂等：第 1、2 条第二次执行时所有串都已带时区标记 → 0 行受影响；第 3 条在重跑时
# 会删掉上一次 `rollup_daily` 重建出来的行，但紧随其后的 `rollup_daily` 用同样的
# 输入重建出同样的结果 —— 守卫里有专门的幂等性用例。
# ---------------------------------------------------------------------------
TIMESTAMP_UTC_SQL = """
    UPDATE posture_score
    SET timestamp = strftime('%Y-%m-%dT%H:%M:%fZ', timestamp, 'utc')
    WHERE timestamp NOT LIKE '%Z' AND timestamp NOT LIKE '%+%';

    UPDATE activity_log
    SET timestamp = strftime('%Y-%m-%dT%H:%M:%fZ', timestamp, 'utc')
    WHERE timestamp NOT LIKE '%Z' AND timestamp NOT LIKE '%+%';

    DELETE FROM posture_daily
    WHERE date >= (SELECT date(MIN(timestamp), 'localtime') FROM posture_score);
"""


# (版本号, SQL)。顺序即执行顺序；编号必须连续递增。
MIGRATIONS: list[tuple[int, str]] = [
    (1, BASELINE_SQL),
    (2, DAILY_AGG_SQL),
    (3, RETENTION_SETTING_SQL),
    (4, TIMESTAMP_UTC_SQL),
]

LATEST_VERSION = MIGRATIONS[-1][0]


async def current_version(db: aiosqlite.Connection) -> int:
    """读取当前 schema 版本；库还没有版本表时返回 0。"""
    await db.execute(
        "CREATE TABLE IF NOT EXISTS schema_version ("
        " version INTEGER PRIMARY KEY,"
        " applied_at TEXT NOT NULL)"
    )
    cursor = await db.execute("SELECT COALESCE(MAX(version), 0) AS v FROM schema_version")
    row = await cursor.fetchone()
    if row is None:
        return 0
    # row_factory 可能没设成 Row（调用方各不相同），两种形态都兼容
    return int(row["v"] if hasattr(row, "keys") else row[0])


async def apply_migrations(db: aiosqlite.Connection) -> int:
    """把库升到最新版本，返回升级后的版本号。

    已经是目标版本的库不会执行任何 SQL（除了读版本），因此每次启动都可以无脑调用。
    """
    if not hasattr(db, "row_factory") or db.row_factory is None:
        db.row_factory = aiosqlite.Row

    start = await current_version(db)
    applied = []
    for version, script in MIGRATIONS:
        if version <= start:
            continue
        await db.executescript(script)
        # 版本号在脚本**成功执行之后**才记录：中途崩溃 → 下次重跑（幂等，安全）
        await db.execute(
            "INSERT OR IGNORE INTO schema_version (version, applied_at) VALUES (?, ?)",
            (version, now_iso_ms()),
        )
        await db.commit()
        applied.append(version)

    if applied:
        logger.info("schema 迁移已应用：%s（%d → %d）", applied, start, applied[-1])
    else:
        logger.info("schema 已是最新：v%d", start)
    return applied[-1] if applied else start
