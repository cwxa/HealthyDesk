"""运行时回归：真实 OpenCV/MediaPipe 素材、有序后台推理与实际 aiosqlite。"""
import asyncio
import base64
import json
import logging
import sys
import time
from pathlib import Path

import cv2
import numpy as np
import aiosqlite
from fastapi import WebSocketDisconnect

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'backend'))
from services.pose_detector import PoseDetector
from services.pose_session import PoseSession
from db.migrations import apply_migrations, _add_metric_versions, MIGRATIONS
from services.retention import rollup_daily
from ws import camera_ws

logging.basicConfig(level=logging.ERROR)


async def database_test():
    async with aiosqlite.connect(':memory:') as db:
        db.row_factory = aiosqlite.Row
        assert await apply_migrations(db) == 6
        for version, score in ((1, 10), (2, 90)):
            await db.execute("INSERT INTO posture_score (timestamp, head_angle, shoulder_diff, spine_angle, score, metric_version) VALUES ('2026-10-08T03:00:00.000Z', 0, 0, 0, ?, ?)", (score, version))
        await db.commit()
        assert await rollup_daily(db) == 2
        rows = await (await db.execute('SELECT metric_version, score_sum FROM posture_daily ORDER BY metric_version')).fetchall()
        assert [tuple(r) for r in rows] == [(1, 10), (2, 90)]
    # 在重命名并建表后注入复制失败，验证旧表与旧值随 DDL 一并回滚。
    async with aiosqlite.connect(':memory:') as db:
        for _, migration in MIGRATIONS[:5]:
            if callable(migration): await migration(db)
            else: await db.executescript(migration)
        await db.execute("INSERT INTO posture_daily VALUES ('2020-01-01', 10, 900, 80, 0, 0, 0, '2020-01-01T00:00:00.000Z')")
        await db.commit()
        class FailingCopy:
            async def execute(self, sql):
                if 'SELECT date, 1' in sql: raise RuntimeError('Injected migration failure')
                return await db.execute(sql)
            async def commit(self): await db.commit()
        try:
            await _add_metric_versions(FailingCopy())
            raise AssertionError('Injected failure was not raised')
        except RuntimeError:
            pass
        row = await (await db.execute('SELECT score_sum FROM posture_daily')).fetchone()
        assert row[0] == 900
        names = [r[1] for r in await (await db.execute('PRAGMA table_info(posture_score)')).fetchall()]
        assert 'metric_version' not in names
        await _add_metric_versions(db)
        row = await (await db.execute('SELECT metric_version, score_sum FROM posture_daily')).fetchone()
        assert tuple(row) == (1, 900)


class Socket:
    def __init__(self, messages): self.messages = list(messages); self.responses = []; self.closed = False
    async def accept(self): pass
    async def receive_text(self):
        if not self.messages: raise WebSocketDisconnect()
        return json.dumps(self.messages.pop(0))
    async def send_json(self, value): self.responses.append(value)
    async def close(self): self.closed = True


async def worker_test():
    original = camera_ws.pose_detector
    ticks = 0
    concurrent_ticks = []
    class SlowDetector:
        initialized = False
        def initialize(self): self.initialized = True; return True
        def process_frame(self, frame):
            before = ticks
            time.sleep(.1)
            concurrent_ticks.append(ticks - before)
            return {'head_angle': 0, 'shoulder_diff': 0, 'spine_angle': 0}
        def release(self): self.initialized = False
    model = SlowDetector()
    camera_ws.pose_detector = model
    image = np.zeros((360, 640, 3), dtype=np.uint8)
    encoded = base64.b64encode(cv2.imencode('.jpg', image)[1]).decode()
    frame = {'type': 'frame', 'data': encoded, 'mode': 'monitor', 'frame_id': 1, 'session_id': 'test-session', 'captured_at': 1000}
    decoded = camera_ws._decode_frame(frame)
    assert decoded.shape[:2] == (360, 640), decoded.shape
    assert camera_ws._decode_frame({'data': 'invalid'}) is None
    ws = Socket([frame, {**frame, 'data': 'bad', 'frame_id': 2}])
    async def heartbeat():
        nonlocal ticks
        for _ in range(12): await asyncio.sleep(.01); ticks += 1
    try:
        await asyncio.gather(camera_ws.camera_websocket(ws), heartbeat())
        assert ticks == 12
        assert concurrent_ticks[0] >= 3, concurrent_ticks
        result = [r for r in ws.responses if r.get('frame_id') == 1][0]
        assert result['type'] == 'pose' and result['score'] == 100 and result['session_id'] == 'test-session'
        assert [r for r in ws.responses if r.get('frame_id') == 2][0]['type'] == 'no_pose'
        assert not camera_ws.active_connections and not model.initialized
        # 已有会话时新输入不能混入同一个视频跟踪器。
        camera_ws.active_connections.append(ws)
        other = Socket([])
        await camera_ws.camera_websocket(other)
        assert other.closed and other.responses[0]['type'] == 'error'
    finally:
        camera_ws.active_connections.clear()
        camera_ws.pose_detector = original


def mediapipe_test():
    detector = PoseDetector()
    assert detector.initialize(), 'MediaPipe model initialization failed'
    rows = []
    try:
        for path in sorted((ROOT / 'scripts/fake-camera/frames').glob('0[0-5]-*.jpg')):
            image = cv2.cvtColor(cv2.imread(str(path)), cv2.COLOR_BGR2RGB)
            result = None
            started = time.perf_counter()
            for _ in range(5): result = detector.process_frame(image)
            session = PoseSession()
            response = session.process(result, 'monitor', 0)
            assert response['metric_version'] == 2
            if response['type'] == 'pose':
                assert all(q['valid'] for q in response['quality'].values())
            else:
                assert 'score' not in response
            rows.append({'file': path.name, 'type': response['type'], 'metrics': {k: response[k] for k in ('head_angle', 'shoulder_diff', 'spine_angle') if k in response}, 'quality': response.get('quality'), 'infer_ms_mean': round((time.perf_counter() - started) * 1000 / 5, 2)})
        assert len(rows) == 6
        assert rows[0]['type'] == 'no_pose'
        assert any(r['type'] in ('pose', 'partial_pose') for r in rows[1:])
    finally:
        detector.release()
    target = ROOT / '.buildenv/pose-runtime-report.json'
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(json.dumps(rows, ensure_ascii=False, indent=2), encoding='utf-8')
    return rows


async def main():
    await database_test()
    await worker_test()
    rows = await asyncio.to_thread(mediapipe_test)
    print(json.dumps({'runtime_tests': 'passed', 'real_model_frames': len(rows), 'results': [{'file': r['file'], 'type': r['type'], 'infer_ms_mean': r['infer_ms_mean']} for r in rows]}, ensure_ascii=False))
    camera_ws.pose_worker.shutdown(wait=True)


if __name__ == '__main__': asyncio.run(main())
