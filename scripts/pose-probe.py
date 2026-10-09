"""核心姿态回归：直接执行生产几何、会话状态、迁移与归档。"""
import json
import math
import sys
import sqlite3
import asyncio
import logging
import faulthandler
from pathlib import Path
from types import SimpleNamespace

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'backend'))
from services.pose_geometry import measure_pose
from services.pose_session import PoseSession
from services.smoother import PoseSmoother
from services.exercise_quality import judge_exercise
from db.migrations import apply_migrations, BASELINE_SQL, DAILY_AGG_SQL
from services.retention import rollup_daily

logging.basicConfig(level=logging.ERROR)
faulthandler.dump_traceback_later(10)


# 同步 SQLite 适配为迁移/归档所需异步接口，使用真实 SQL 与真实事务。
class Cursor:
    def __init__(self, cursor): self.cursor = cursor
    async def fetchall(self): return self.cursor.fetchall()
    async def fetchone(self): return self.cursor.fetchone()


class Database:
    def __init__(self):
        self.db = sqlite3.connect(':memory:')
        self.db.row_factory = sqlite3.Row
        self.row_factory = sqlite3.Row
    async def execute(self, sql, parameters=()): return Cursor(self.db.execute(sql, parameters))
    async def executescript(self, sql): self.db.executescript(sql)
    async def commit(self): self.db.commit()


async def test_versions():
    db = Database()
    # 模拟已发布旧库，先放入仅归档保留的数据，再运行新迁移。
    db.db.executescript(BASELINE_SQL + DAILY_AGG_SQL)
    db.db.execute("INSERT INTO posture_daily VALUES ('2020-01-01', 10, 900, 80, 0, 0, 0, '2020-01-01T00:00:00.000Z')")
    assert await apply_migrations(db) == 6
    assert await apply_migrations(db) == 6
    assert db.db.execute("SELECT metric_version, sample_count FROM posture_daily WHERE date='2020-01-01'").fetchone()[:] == (1, 10)
    # 删除版本标记模拟迁移已提交而记录版本前被终止，重放仍安全。
    db.db.execute('DELETE FROM schema_version WHERE version=6')
    assert await apply_migrations(db) == 6
    for version, score in [(1, 10), (2, 90)]:
        db.db.execute("INSERT INTO posture_score (timestamp, head_angle, shoulder_diff, spine_angle, score, metric_version) VALUES ('2026-10-08T03:00:00.000Z', 0, 0, 0, ?, ?)", (score, version))
    assert await rollup_daily(db) == 2
    rows = db.db.execute("SELECT metric_version, sample_count, score_sum FROM posture_daily WHERE date != '2020-01-01' ORDER BY metric_version").fetchall()
    assert [tuple(r) for r in rows] == [(1, 1, 10), (2, 1, 90)], rows
    assert await rollup_daily(db) == 0
    assert db.db.execute("SELECT COUNT(*) FROM posture_daily").fetchone()[0] == 3
    db.db.close()


def test_session():
    session = PoseSession()
    full = {'head_angle': 24, 'shoulder_diff': 12, 'spine_angle': 30}
    session.process(full, 'exercise', 0)
    neutral = {'head_angle': 0, 'shoulder_diff': 0, 'spine_angle': 0}
    result = session.process(neutral, 'monitor', 200)
    assert result['head_angle'] == 0 and result['score'] == 100
    result = session.process(full, 'exercise', 400)
    assert result['head_angle'] == 24
    partial = session.process({'head_angle': 0, 'shoulder_diff': 0}, 'monitor', 600)
    assert partial['type'] == 'partial_pose' and 'score' not in partial and 'spine_angle' not in partial
    recovered = session.process(neutral, 'monitor', 800)
    assert recovered['spine_angle'] == 0
    session.process(full, 'monitor', 1000)
    assert session.process(neutral, 'monitor', 4000)['head_angle'] == 0
    assert session.process(None)['type'] == 'no_pose'
    assert judge_exercise([{'t': 0, 'head_angle': float('nan')}, {'t': 200, 'head_angle': 12}], {'metric': 'head'})['grade'] == 'idle'
    partial_frames = [{'t': i * 200, 'head_angle': 0 if i < 3 else 12} for i in range(20)]
    assert judge_exercise(partial_frames, {'metric': 'head', 'duration_ms': 4000})['grade'] == 'completed'
    assert judge_exercise(partial_frames, {'metric': 'spine', 'duration_ms': 4000})['grade'] == 'idle'


def main():
    data = json.load(sys.stdin)
    geometry = [measure_pose([SimpleNamespace(**p) for p in c['points']], c['width'], c['height']) for c in data['geometry']]
    temporal = []
    for sequence in data['temporal']:
        smoother = PoseSmoother()
        temporal.append([smoother.update(f['metrics'], f['t']) for f in sequence])
    test_session()
    asyncio.run(test_versions())
    json.dump({'geometry': geometry, 'temporal': temporal, 'session_tests': True, 'version_tests': True}, sys.stdout, allow_nan=False)


if __name__ == '__main__': main()
