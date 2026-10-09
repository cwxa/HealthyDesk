"""构造新版浏览器链路测试素材与登记值，保留旧版 fixture 作为历史回归。"""
import json
import sys
import cv2
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / 'backend'))
from services.pose_detector import PoseDetector
from services.pose_session import PoseSession
from services.exercise_quality import judge_exercise

folder = ROOT / 'scripts/fake-camera'
source = cv2.imread(str(folder / 'frames/02-head-tilt-mild.jpg'))
target = folder / 'frames/06-head-tilt-v2.jpg'
# 此图仅是链路测试的合成强信号，整张画面旋转，不作为人体准确率数据。
transform = cv2.getRotationMatrix2D((source.shape[1] / 2, source.shape[0] / 2), -18, 1)
rotated = cv2.warpAffine(source, transform, (source.shape[1], source.shape[0]), borderMode=cv2.BORDER_REFLECT)
cv2.imwrite(str(target), rotated, [cv2.IMWRITE_JPEG_QUALITY, 90])
ui = json.loads((folder / 'scenarios.json').read_text(encoding='utf-8'))['ui_smoke']
ui.update({
    'metric_version': 2,
    'why': 'v2 修正像素比例并按时间平滑。起势保留 3 帧，使真实浏览器有机会采到中立位；随后使用合成旋转强信号。此案例验证链路与评分一致性，不代表真人姿势准确率。',
    'sequence': '01-upright x3 06-head-tilt-v2 x57',
    'frames': ['01-upright.jpg'] * 3 + ['06-head-tilt-v2.jpg'] * 57,
    'lead_in_frames': 3,
})
readings = []
detector = PoseDetector()
assert detector.initialize()
session = PoseSession()
try:
    for i, filename in enumerate(ui['frames']):
        image = cv2.cvtColor(cv2.imread(str(folder / 'frames' / filename)), cv2.COLOR_BGR2RGB)
        response = session.process(detector.process_frame(image), 'exercise', i * 200)
        assert 'head_angle' in response, response
        readings.append({'t': i * 200, 'head_angle': response['head_angle']})
finally:
    detector.release()
ui['readings'] = readings
ui['rate_sweep'] = {}
ui['rate_readings'] = {}
for fps in [1.5, 2.0, 3.0, 5.0]:
    # 真跑每一档模型跟踪与时间 EMA，而非重打已有帧的时间戳。
    detector = PoseDetector()
    assert detector.initialize()
    session = PoseSession()
    frames = []
    try:
        for i in range(round(ui['feed_ms'] / 1000 * fps)):
            t = i * 1000 / fps
            filename = ui['frames'][min(int(t / 200), len(ui['frames']) - 1)]
            image = cv2.cvtColor(cv2.imread(str(folder / 'frames' / filename)), cv2.COLOR_BGR2RGB)
            response = session.process(detector.process_frame(image), 'exercise', t)
            if 'head_angle' in response: frames.append({'t': t, 'head_angle': response['head_angle']})
    finally:
        detector.release()
    verdict = judge_exercise(frames, {'kind': 'hold', 'metric': 'head', 'duration_ms': ui['action_duration_ms']})
    assert verdict['grade'] == 'completed', (fps, verdict)
    ui['rate_sweep'][str(fps)] = verdict
    ui['rate_readings'][str(fps)] = frames
ui['margins'] = {'amplitude': min(v['peak_activity'] - 1 for v in ui['rate_sweep'].values()), 'hold': min(v['hold_ratio'] - .6 for v in ui['rate_sweep'].values())}
(folder / 'ui-smoke-v2.json').write_text(json.dumps({'ui_smoke': ui}, ensure_ascii=False, indent=2), encoding='utf-8')
print(json.dumps({'generated': target.name, 'rate_sweep': ui['rate_sweep']}, ensure_ascii=False))
