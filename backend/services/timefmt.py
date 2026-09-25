"""本项目的时间戳契约 —— 单点定义。

## 契约

    时间戳串 ≡ ``YYYY-MM-DDTHH:MM:SS.sssZ``（UTC，毫秒 3 位，``Z`` 后缀）
             ≡ JavaScript ``Date.prototype.toISOString()``

前端由 ``toISOString()`` 天然产出这个格式；后端**只能**经由本模块产出。
``ws/camera_ws.py`` / ``services/retention.py`` / ``api/data.py`` /
``db/migrations.py`` 此前各自拼了一遍（四份实现），其中相机链路那份是**错的**。

## 为什么必须是 UTC，而不是 ``datetime.now()`` 的本地时间

数据库里所有「按天」的判定都写成 ``date(timestamp, 'localtime')`` —— SQLite 的
``localtime`` 修饰符**假定输入是 UTC**，据此换算成本地。而 SQLite 对**没有时区
标记**的字符串同样按 UTC 解释。于是：

    写入本地时间串 → SQLite 再减一次本地偏移 → 本地 16:00 之后的采样落到次日

实测（UTC+8）：``2026-09-25T16:30:00`` 经 ``date(..., 'localtime')`` 得到
``2026-09-26``。``camera_ws.py`` 此前用 ``datetime.now().isoformat()`` 写库，
正是这个形态，后果是：

- 仪表盘「今日均分」在下午 16 点后不再增长（新采样全被算到「明天」）
- 趋势图的日期整体错位（当天 16:00–24:00 的数据挂在次日）
- 保留期清理的边界跟着偏
- 归档（``posture_daily``）一旦写进去就长期保留 → **错误被固化**

🔴 这个缺陷在 CI runner 上**完全看不出来**：runner 的时区是 UTC、偏移为 0，
本地串与 UTC 串恰好相同。所以它必须由守卫用「构造跨日界时刻」的方式显式检验，
不能指望换个环境自己暴露。

## 毫秒必须是 3 位

``toISOString()`` 给 3 位毫秒；Python 的 ``isoformat()`` 给 6 位微秒、带时区时
还会多出 ``+00:00`` 后缀 —— 两者都不是同一个格式。格式不统一会破坏本项目的两个
前提：

1. **字符串比较 ≡ 时间比较**：``WHERE timestamp >= ? AND timestamp < ?`` 这类
   区间查询（``services/retention.py`` 的按天窗口）全靠它。混格式会让比较结果
   既不是时间序也不是稳定的字典序。
2. **两端取值一致**：移动端的 ``IDBKeyRange`` 范围查询同样按字符串比较。

## 与 ``is_iso_ms`` 的关系

``is_iso_ms()`` 是「要不要转换」这一判断的单点定义（迁移用）。判断必须
**宁可漏、不可错**：把已经是 UTC 的串再转一次会把它算错本地日。实测 SQLite 对
带 ``Z`` 的输入执行 ``'utc'`` 修饰符恰好是恒等变换，但不能依赖这个未文档化的
行为 —— 所以迁移显式排除掉带时区标记的串。
"""

import re
from datetime import datetime, timezone

# 契约格式的正则。`\d{3}` 是**要求**而不是宽容：见上面「毫秒必须是 3 位」。
ISO_MS_RE = re.compile(r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$")


def to_iso_ms(dt: datetime) -> str:
    """任意 ``datetime`` → 契约格式。

    naive 的 ``datetime`` 按**本地**时间解释（与 SQLite 的 ``'localtime'`` 以及
    ``datetime.astimezone()`` 的既定语义一致）—— ``services/retention.py`` 的
    ``local_day_bounds_utc`` 依赖这一点把「本地零点」换算成 UTC 瞬时。
    """
    if dt.tzinfo is None:
        dt = dt.astimezone()
    # `%f` 是 6 位微秒（零填充），截到 3 位即毫秒 —— 与 toISOString() 对齐。
    return dt.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.%f")[:-3] + "Z"


def now_iso_ms() -> str:
    """当前时刻的契约格式。**后端写时间戳一律用这个**。"""
    return to_iso_ms(datetime.now(timezone.utc))


def is_iso_ms(value) -> bool:
    """是否已经是契约格式（含时区标记，无需转换）。"""
    return isinstance(value, str) and ISO_MS_RE.match(value) is not None
