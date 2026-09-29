#!/usr/bin/env python
"""模拟摄像头案例 · 素材流水线 + 准入校验。

## 这个脚本解决什么

项目要在**没有真摄像头**的环境里测实时链路（首当其冲是「有帧时的实时徽章/提示」，
它至今只在真机验过 —— 无头环境没帧，`liveQuality` 恒为 `null`）。
本脚本产出那套「假摄像头」用的**画面素材**与**期望判定**。

## 两种模式

    python scripts/fake-camera/build-frames.py --from-src=<原图目录>
        # 从 ImageGen 原图重建 frames/ 与 scenarios.json（需要 PIL + mediapipe）

    python scripts/fake-camera/build-frames.py
        # 校验模式：**重测/重放**已入库素材，与 scenarios.json 登记值逐项比对

## 四条「别把绿当能用」的规矩（全部踩过，逐条留证）

1. 🔴 **键名是 `head_angle` / `shoulder_diff`，不是 `head_tilt` / `shoulder_ratio`。**
   第一版探针读错键，`dict.get(k, 0)` **静默**返回 0 ⇒ 「什么都没测」被打印成
   「测到了，值是 0.00」。一个漂亮的假绿。
2. 🔴 **`head_angle == 0` 有两种来源**：真的竖直，或 `dx < 0.03`（双耳水平间距不足）
   的**兜底 return 0.0**，两者同值。所以额外检查归一化双耳间距，兜底一律不合格。
3. 🔴🔴 **读数与「喂帧顺序」有关**：`PoseDetector` 建的是 `static_image_mode=False`
   （**跟踪**模式），有跨帧状态。实测同一张 `03-head-tilt-strong.jpg`：
   单独喂 = **8.51°**，先喂过正坐帧再喂 = **5.70°**（差 2.81°）。
   ⇒ 本文件的判定一律来自**按案例序列重放**（复刻 app 的喂法），
   另存一组 `head_angle_solo`（每帧新建检测器单独喂，与顺序无关）只用于素材准入。
   **这两组数不可混用。**
4. 🔴 **期望判定必须由真实现跑出来**（`judge_exercise`），不能照着公式手推。

## 实测结论（比上面四条更值得先读）—— 跟踪器在**完全静止**的人身上会漂

`.buildenv/probe-idle-drift*.py` 实测（同一张 `01-upright.jpg` 连续喂）：

    帧  0: 1.31°   →  帧 25: 0.84°（最低）  →  帧 59: 2.45°  →  帧 299: 4.91°
    60 秒内 head_angle 从 0.84° 单调爬到 4.91°（≈0.07°/s），**到 300 帧仍在上升、没收敛**。

由此得到三条硬结论（都进了 `scenarios.json` 的 `findings`）：

- **`ACTIVITY_IDLE_MAX = 0.25` 在「检到人的静止画面」上不可达。** 单次活动窗口是
  10–12 秒（`src/data/exercises.ts`；82 秒是**整套**总长，不是单次），
  在 300 帧上滑遍全部 241 个 12 秒窗口，最坏 `peak_activity = 0.400`（> 0.25）
  ⇒ 真人一动不动会被判 `insufficient`/「幅度还不够，再大一点」，**不是** `idle`。
  `idle` 实际上只在「一帧都没有 / 少于两帧」时出现（如摄像头对着空房间）。
  ⚠️ 这是**已登记的语义偏差**，不是案例写错了（见 `still-person-12s` 的 `semantics`）。
- **但漂移伪造不出 `completed`**：0.400 只有 `ACTIVITY_ONSET = 1.0` 的 40%。
  这是好的一面，同样要写明 —— 否则「知道它漂」会变成「以为它随时会坏」。
- **风险（未修，留给评分域）**：漂移不收敛 ⇒ 活动时长若显著变长，窗口内范围会跟着涨。
  按 0.07°/s 推算约 70 秒才能摸到 5.0° 阈值；当前动作库最长 20 秒（S8 `durationRange`
  上限）→ 漂移约 1.4°、`peak ≈ 0.28`，**眼下安全**。真要动 `ACTIVITY_IDLE_MAX`
  或加漂移补偿，属于评分域变更，得单独升 `ACTION_SCORES_VERSION`，**不在本脚本范围**。

## 素材构成

- `01`–`03`：ImageGen 真人照（**花钱**，3 张约 15–30 credits，原图不入库）。
- `04` / `05`：由 `01` 确定性旋转派生（**不花钱**）。
- `00-no-person`：**程序生成**的空房间（**不花钱**）。它的职责恰恰是「画面里没有人」——
  BlazePose 对无人画面返回 `None`（实测：简笔骨架 / 纯色剪影 / 明暗拟真剪影 / 侧倾版
  **一律拒检**，见 `.buildenv/probe-fake-camera.py` 的 A–E 表），
  于是它成为**真负样本**：`judge_exercise([])` 必须回 `idle`。

## 局限（写在代码里，免得只在 README 里）

- 期望角度是**预测值**：本脚本用 PIL 的缩放与 JPEG 编码；浏览器 canvas 实现不同，
  app 实测可能差零点几度。所以每个案例都留了余量（见 README 的余量表）。
- **旋转 → head_angle 不是线性的，且与分辨率、旋转方向都有关**（实测两组）：
  · 入库这条路（640×480 + q70）：`01` 0.97° → 旋转 +3° 得 5.47° → +5° 得 7.90°；
  · 全分辨率（1024×768 直接送检）、方向相反时：2.27° → 0.90°（**下降**）。
  ⇒ 「转了多少度」**不能**当已知量，只能逐张实测 —— 04 / 05 的存在理由就是这个。
"""
from __future__ import annotations

import json
import re
import sys
from pathlib import Path

import cv2
import numpy as np
from PIL import Image, ImageFilter

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent.parent
FRAMES = HERE / "frames"
SCENARIOS = HERE / "scenarios.json"

sys.path.insert(0, str(ROOT / "backend"))

from services.exercise_quality import (  # noqa: E402
    ACTIVITY_IDLE_MAX,
    ACTIVITY_ONSET,
    DEFAULT_MIN_CYCLES,
    HEAD_TILT_THRESHOLD,
    HOLD_TARGET_RATIO,
    judge_exercise,
)
from services.pose_detector import PoseDetector  # noqa: E402

W, H = 640, 480
JPEG_QUALITY = 95          # 入库素材质量
APP_JPEG_QUALITY = 70      # = `canvas.toDataURL('image/jpeg', 0.7)`，app 发帧用的
TOL = 0.05                 # 重测容差（度 / 百分点）
WARMUP = 5                 # solo 测量时连喂同一张的次数（跟踪模式需要暖机）

# 漂移实测（`.buildenv/probe-idle-drift-long.py` 跑 300 帧得到的全局漂移）。
# 只登记**结论数字**，不登记整条序列 —— 序列是取证中间产物，不是素材。
DRIFT_FINDING = {
    "what": "PoseDetector(static_image_mode=False) 在完全静止的人身上会缓慢漂移",
    "measured": {
        "frames": 300, "seconds": 60.0,
        "head_angle_at_frame_25": 0.84, "head_angle_last_frame": 4.91,
        "converged": False, "approx_deg_per_sec": 0.07,
        "worst_peak_activity_over_all_12s_windows": 0.400,
        "windows_scanned": 241,
    },
    "consequences": [
        "ACTIVITY_IDLE_MAX=0.25 在「检到人的静止画面」上不可达 ⇒ 真人一动不动判 "
        "insufficient/「幅度还不够，再大一点」，不是 idle。idle 实际只在"
        "「一帧都没有 / 少于两帧」时出现。",
        "但伪造不出 completed：0.400 只有 ACTIVITY_ONSET=1.0 的 40%。",
        "漂移不收敛：活动时长若显著变长，窗口内范围跟着涨（按 0.07°/s 推算约 70 秒"
        "摸到 5.0° 阈值）。当前动作库最长 20 秒（S8 durationRange 上限）⇒ 漂移约 "
        "1.4°、peak≈0.28，**眼下安全**。真要改 ACTIVITY_IDLE_MAX 或加漂移补偿，"
        "属评分域变更，要单独升 ACTION_SCORES_VERSION，不在本脚本范围。",
    ],
}

# 素材清单。`src` 指向 ImageGen 原图（不入库）；`rotate` 由另一帧确定性派生；
# `synth` 由本脚本程序生成（不花钱）。
# 说明里的引号一律用「」，免得与 Python 字符串的 ASCII 引号打架。
NO_PERSON = "00-no-person"

FRAME_SPECS = [
    {"name": NO_PERSON, "synth": "empty_room", "expect_detected": False,
     "desc": "程序生成的空房间（无自然人像）—— **负样本**：BlazePose 对无人画面返回 "
             "None ⇒ 帧不入序列 ⇒ 判定必须回 idle。它不花 credits。"},
    {"name": "01-upright", "src": "*webcam_snapshot*.png",
     "desc": "正坐面对摄像头、双肩水平（静息基线帧）"},
    {"name": "02-head-tilt-mild", "src": "*14-40-42.png",
     "desc": "头向左侧倾（图像模型收到 18° 指令，实际远不到）"},
    {"name": "03-head-tilt-strong", "src": "*14-40-43.png",
     "desc": "头向左侧倾（图像模型收到 5° 指令，实际反而更大 —— 模型不服从角度指令）"},
    {"name": "04-near-upright-3deg", "src": None, "rotate": ("01-upright", 3.0),
     "desc": "由 01 旋转 +3° 派生（solo 读数 0.97° → 5.47°）"},
    {"name": "05-near-upright-5deg", "src": None, "rotate": ("01-upright", 5.0),
     "desc": "由 01 旋转 +5° 派生（solo 读数 0.97° → 7.90°）"},
]

# t 按 200ms/帧 = 桌面端 `setInterval(captureAndSend, 200)`
FPS_MS = 200

# spec 一律照抄动作库里**真实动作**的判定元数据（`src/data/exercises.ts`），
# 不另立一套：`completed` 类看幅度+保持时长，`cyclic` 类看幅度+有效次数。
HOLD_HEAD = {"kind": "hold", "duration_ms": 12000, "metric": "head"}
CYCLIC_ANY = {"kind": "cyclic", "duration_ms": 12000, "metric": "any",
              "min_cycles": DEFAULT_MIN_CYCLES}   # = shoulder-circles 的 spec

CASES = [
    {
        "id": "completed",
        "title": "颈部左侧屈 · 做足并保持",
        "spec": dict(HOLD_HEAD),
        "sequence": "01-upright x10 02-head-tilt-mild x5 03-head-tilt-strong x45",
        "frames": 60,
        "expect_grade": "completed",
        "expect_hint": "很好，保持住",
        "semantics": "as-designed",
        "why": "起势 2s 后在拉伸位保持到结束（占比 ≥ 0.6），活动范围远超静息阈值 5.0°",
    },
    {
        "id": "insufficient-amplitude",
        "title": "颈部左侧屈 · 只轻轻歪了一下（幅度不够）",
        "spec": dict(HOLD_HEAD),
        "sequence": "(04-near-upright-3deg x5 05-near-upright-5deg x5) x6",
        "frames": 60,
        "expect_grade": "insufficient",
        "expect_hint": "幅度还不够，再大一点",
        "semantics": "as-designed",
        "why": "在两张「轻微倾斜」帧之间来回，活动范围只有阈值的约一半 —— 落在"
               "「不是没动（>0.25）」与「还不够到位（<1.0）」之间的夹缝里",
    },
    {
        "id": "insufficient-hold",
        "title": "颈部左侧屈 · 幅度够但没保持（另一条缺口）",
        "spec": dict(HOLD_HEAD),
        "sequence": "(01-upright 04-near-upright-3deg 02-head-tilt-mild 02-head-tilt-mild) x15",
        "frames": 60,
        "expect_grade": "insufficient",
        "expect_hint": "保持住，别急着放下",
        "semantics": "as-designed",
        "why": "峰值活动量 1.2 ≥ 1（幅度过关，余量 +0.2），但每轮只在拉伸位停 400ms ⇒ 达标时长"
               "占比只有 0.2 < 0.6（余量 −0.4）。**与上一条同 grade 但 hint 不同**，专门盯"
               "「两条缺口别混」。⚠️ 这版序列是**按余量挑的**：原来的 `(01 04 05) x20` "
               "peak 只有 1.1（只比 onset 高 0.5°），而同一张图在不同重采样路径下能差 1.3° "
               "⇒ 在浏览器路径下有翻成「幅度还不够」的风险。见 README 的余量表",
    },
    {
        "id": "cyclic-completed",
        "title": "肩部环绕 · 往复次数够（往复类分支）",
        "spec": dict(CYCLIC_ANY),
        "sequence": "01-upright x8 02-head-tilt-mild x6 (01-upright x4 02-head-tilt-mild x4) x5 01-upright x6",
        "frames": 60,
        "expect_grade": "completed",
        "expect_hint": "很好，保持住",
        "semantics": "as-designed",
        "why": "前 14 帧是**暖机段**（跟踪模式要喂几帧才给出真实角度，见文件头第 3 条），"
               "之后在静息位与拉伸位之间来回 5 轮 —— 合计 6 次 ≥ min_cycles=3。"
               "**往复类走的是另一条分支**（只看 cycles，不看 hold_ratio），"
               "本 fixture 此前完全没有覆盖它 —— 补上",
    },
    {
        "id": "cyclic-too-few",
        "title": "肩部环绕 · 幅度够但只做了 2 次（第三条缺口）",
        "spec": dict(CYCLIC_ANY),
        "sequence": "01-upright x10 03-head-tilt-strong x20 01-upright x10 03-head-tilt-strong x20",
        "frames": 60,
        "expect_grade": "insufficient",
        "expect_hint": "再多做几次",
        "semantics": "as-designed",
        "why": "幅度足够（peak ≥ 1）且**保持时长也够**，唯一不合格的是次数 2 < 3 —— "
               "这条是「hold_ratio 这个尺度在往复类上不生效」的唯一证据",
    },
    {
        "id": "still-person-12s",
        "title": "真人坐在镜头前·一动不动 12 秒（已知语义偏差）",
        "spec": dict(HOLD_HEAD),
        "sequence": "01-upright x60",
        "frames": 60,
        "expect_grade": "insufficient",
        "expect_hint": "幅度还不够，再大一点",
        "semantics": "known-deviation",
        "finding": "按设计意图这里**应当**是 idle（人没动），实测是 insufficient。原因不是"
                   "判定逻辑写错，而是上游：PoseDetector 的跟踪模式在完全静止的人身上"
                   "0.07°/s 地漂（60s 内 0.84°→4.91° 且不收敛），12 秒窗口内伪造出 "
                   "≈0.4 的「活动范围」，越过了 ACTIVITY_IDLE_MAX=0.25 却够不到 "
                   "ACTIVITY_ONSET=1.0。**危害有限**：它只能把「没动」说成「幅度还不够」，"
                   "（两者都是「你需要多动一点」），伪造不出 completed —— 0.400 只有 onset 的 40%。"
                   "登记这个案例是为了：① 钉住「漂移今长什么样」，它一变守卫就红；"
                   "② 把「idle 对真人不可达」写成可查的账，而不是留成谜。",
        "why": "60 帧同一张正坐帧 ⇒ 真值「没动」，但读数被跟踪器漂移推到 peak≈0.3–0.4",
    },
    {
        "id": "no-pose",
        "title": "摄像头对着空房间（真负样本）",
        "spec": dict(HOLD_HEAD),
        "sequence": f"{NO_PERSON} x60",
        "frames": 60,
        "expect_grade": "idle",
        "expect_hint": "没检测到动作，跟着引导慢慢做",
        "semantics": "as-designed",
        "why": "画面里没有人 ⇒ 60 帧全被检出为 None ⇒ 序列为空 ⇒ `judge_exercise([])` "
               "必须回 idle。**这是本 fixture 里唯一的真负样本**：前一条（still-person）"
               "因为漂移拿不到 idle，真正的「整条链路坏了」信号只能靠这一条 —— "
               "它若被判 completed，说明判定链在「没有数据」时捏造了结论",
    },
]


# ---------------------------------------------------------------- 编解码

def to_jpeg(image: Image.Image, quality: int = JPEG_QUALITY) -> bytes:
    ok, buf = cv2.imencode(".jpg", np.array(image.convert("RGB"))[:, :, ::-1],
                           [int(cv2.IMWRITE_JPEG_QUALITY), quality])
    assert ok, "JPEG 编码失败"
    return buf.tobytes()


def decode_jpeg(data: bytes) -> np.ndarray:
    return cv2.imdecode(np.frombuffer(data, np.uint8), cv2.IMREAD_COLOR)


def app_style(decoded_bgr: np.ndarray) -> np.ndarray:
    """再走一遍 app 的编码（JPEG q0.7）—— MediaPipe 在生产里看到的就是这个。"""
    ok, buf = cv2.imencode(".jpg", decoded_bgr, [int(cv2.IMWRITE_JPEG_QUALITY), APP_JPEG_QUALITY])
    assert ok
    return cv2.imdecode(buf, cv2.IMREAD_COLOR)


def fit(image: Image.Image) -> Image.Image:
    return image.convert("RGB").resize((W, H), Image.LANCZOS)


def rotate_frame(image: Image.Image, deg: float) -> Image.Image:
    """绕画面中心旋转 + 轻微放大裁切（抹掉黑角）。见文件头「旋转不是线性的」。"""
    rot = image.rotate(deg, resample=Image.BICUBIC, expand=False, fillcolor=None)
    w, h = rot.size
    k = 1 + abs(deg) / 29.0
    bw, bh = int(w / k), int(h / k)
    return rot.crop(((w - bw) // 2, (h - bh) // 2,
                     (w + bw) // 2, (h + bh) // 2)).resize((w, h), Image.LANCZOS)


def empty_room(seed: int = 20260929) -> Image.Image:
    """程序生成的「空房间」——**确定性**（固定种子），不花 credits。

    职责单一：画面里**没有人**。不追求好看，只求「BlazePose 不会在里面看出人」。
    实测依据：合成画面一律被拒检（简笔骨架 / 纯色剪影 / 拟真剪影，见
    `.buildenv/probe-fake-camera.py`）——这里就是把「检不到」当成**期望行为**用：
    它是负样本，检到了反而说明模型在编。
    """
    rng = np.random.default_rng(seed)
    yy, xx = np.mgrid[0:H, 0:W].astype(np.float32)
    yn, xn = yy / H, xx / W

    # 墙面：上亮下暗的冷灰渐变 + 左侧更暗（模拟侧光）
    wall = 176.0 - 46.0 * yn - 26.0 * xn
    wall += 10.0 * np.sin(xn * 22.0) * 0.3                       # 极轻的墙面不匀
    base = np.dstack([wall * 0.96, wall * 0.98, wall * 1.00])     # 偏冷
    img = (base + rng.normal(0.0, 2.2, size=(H, W, 3))).clip(0, 255).astype(np.uint8)

    # 画在 PIL 上：地板、踢脚线、桌子、显示器、椅背
    im = Image.fromarray(img)
    from PIL import ImageDraw
    d = ImageDraw.Draw(im)
    fh = 150                                                      # 地板线
    d.rectangle([0, H - fh, W, H], fill=(122, 110, 96))
    d.line([0, H - fh, W, H - fh], fill=(88, 80, 70), width=3)    # 踢脚线
    # 桌面（画面下方 1/3）
    d.rectangle([40, H - 118, W - 40, H - 62], fill=(150, 138, 122))
    d.rectangle([40, H - 62, W - 40, H - 52], fill=(120, 110, 98))
    # 显示器（空屏幕，无内容）
    d.rectangle([200, 196, 452, 344], fill=(46, 50, 58))
    d.rectangle([208, 204, 444, 336], fill=(30, 33, 39))
    d.rectangle([316, 344, 336, H - 118], fill=(60, 64, 72))
    d.rectangle([276, H - 124, 376, H - 116], fill=(70, 74, 82))
    # 椅背（右侧）——**只是个靠背**，别画成有人坐在上面
    d.rounded_rectangle([482, 262, 596, H - 96], radius=18, fill=(58, 62, 70))
    # 门框（左侧，暗示是室内）
    d.rectangle([0, 30, 74, H - fh], fill=(146, 138, 126))
    d.rectangle([8, 44, 62, H - fh], fill=(128, 121, 110))
    im = im.filter(ImageFilter.GaussianBlur(1.2))
    return fit(im)


# ---------------------------------------------------------------- 检测

def read_metrics(out: dict) -> dict:
    """从 `process_frame` 的输出抽读数，并标出角度是不是**兜底值**（见文件头第 2 条）。"""
    lm = out["landmarks"]
    dx_ear = abs(lm["left_ear"]["x"] - lm["right_ear"]["x"]) / W
    dx_sh = abs(lm["left_shoulder"]["x"] - lm["right_shoulder"]["x"]) / W
    return {
        "head_angle": out["head_angle"],
        "shoulder_diff": out["shoulder_diff"],
        "spine_angle": out["spine_angle"],
        "visibility": out["visibility"],
        "head_is_real": dx_ear >= 0.03,
        "shoulder_is_real": dx_sh >= 0.01,
        "dx_ear": round(dx_ear, 4),
        "dx_shoulder": round(dx_sh, 4),
    }


def new_detector() -> PoseDetector:
    det = PoseDetector()
    if not det.initialize():
        raise RuntimeError("MediaPipe 初始化失败（本脚本需要 mediapipe，用本机 venv 跑）")
    return det


EMPTY = {"detected": False, "head_angle": None, "head_is_real": False,
         "shoulder_is_real": False, "shoulder_diff": None, "spine_angle": None,
         "visibility": None, "dx_ear": None, "dx_shoulder": None}


def measure_solo(jpg_bytes: bytes) -> dict:
    """**单独**测一帧（新检测器只喂这一张，与顺序无关）—— 只用于素材准入。"""
    det = new_detector()
    out = None
    for _ in range(WARMUP):
        out = det.process_frame(app_style(decode_jpeg(jpg_bytes)))
    det.release()
    return EMPTY if out is None else {"detected": True, **read_metrics(out)}


def parse_sequence(text: str) -> list[str]:
    """把序列串展开成帧名列表。四种写法都要吃：

        01-upright x10              帧名与次数**分开**写（两个 token）
        01-uprightx10               次数**贴着**帧名写（一个 token）
        (a b) x20                   括号内整段重复
        (a b) x5 01-upright x4      **括号重复之后还有尾巴**

    ⚠️ 这个解析器坏过**两次，都在同一个地方**——「看着像素材缺文件，其实是解析器坏了」：

    - v1：只认后两种写法，遇到 ``01-upright x10`` 会把 ``x10`` 当帧名
      （`rsplit("x",1)` 得到 `name=''`）→ `KeyError: ''`。修法：对「次数 token」单独判定。
    - v2：遇到 ``(a b) x5 <尾巴>`` 时，读走 ``x5`` 就把**尾巴整段丢掉** ——
      于是 60 帧的序列被采成 8 帧，判定自然错（而报错形状是"案例与期望不符"，
      **根本不提解析器**）。修法：拆成递归的 `_expand()`，括号段与尾巴各自展开。

    ⇒ 教训进 README：**案例判定红了先看「采用帧」对不对**，那是解析器健康度的体检项。
    """
    return _expand(text.strip())


# 解析器自测（**守卫的守卫**）：`parse_sequence` 坏过两次，两次的症状都不是"解析器坏了"。
# 案例序列本身**覆盖不到**那个已知坏形状（"以 `(` 开头且后面还有尾巴"）——
# 现有 7 个案例没有一个是这个形状，所以「退回 v2 的变异」不会被案例抓住。
# ⇒ 直接拿字符串钉住它，别指望案例顺带覆盖。
# 值一栏是**期望展开出的帧数**。
PARSER_SELF_TEST = [
    ("01-upright x10", 10, "帧名与次数分开写（两个 token）"),
    ("01-uprightx10", 10, "次数贴着帧名写（一个 token）"),
    ("(01 x2 02 x3) x4", 20, "括号整段重复"),
    ("(01 x2 02 x3) x4 03 x2", 22, "🔴 括号重复**之后还有尾巴** —— v2 在这里把尾巴整段丢掉"),
    ("((01 x2) x3) x2", 12, "嵌套括号"),
    ("(01 02) x3 03 04", 8, "括号 + 尾巴里有多个单帧"),
]


def check_parser() -> None:
    """跑解析器自测。任何一条不符就抛 —— 这是**解析器缺陷**，不是素材问题。"""
    bad = []
    for text, want, why in PARSER_SELF_TEST:
        got = len(parse_sequence(text))
        if got != want:
            bad.append(f"{text!r}：展开 {got} 帧，应 {want} 帧（{why}）")
    if bad:
        raise AssertionError(
            "序列解析器自测失败 —— **解析器坏了**（症状常伪装成「案例与期望不符」或 KeyError）：\n"
            + "\n".join(f"  · {b}" for b in bad))


def _take_group(text: str) -> tuple[str, str]:
    """从 ``text``（必须以 ``(`` 开头）取出一整个括号组，返回 (组内内容, 组后残余)。

    🔴 **必须用深度匹配，不能 `split(")", 1)`**：后者在嵌套括号上会切在**内层**的 `)` 上，
    把 ``((a x2) x3) x2`` 切成 ``(a x2`` —— 症状是 `ValueError: not enough values to unpack`。
    这个缺陷是上面那张 `PARSER_SELF_TEST` 抓出来的（写成自测的当场就抓到了，
    案例序列一条都碰不到它 —— 因为现有 7 个案例里没有一个用嵌套括号）。
    """
    depth = 0
    for i, ch in enumerate(text):
        if ch == "(":
            depth += 1
        elif ch == ")":
            depth -= 1
            if depth == 0:
                return text[1:i], text[i + 1:]
    raise ValueError(f"括号不配对：{text!r}")


def _expand(text: str) -> list[str]:
    """递归展开一段序列串（可含括号重复、重复后的尾巴、以及嵌套括号）。"""
    out: list[str] = []
    while text:
        if text.startswith("("):
            inner, rest = _take_group(text)
            rest = rest.strip()
            m = re.match(r"^x(\d+)\s*", rest)
            n = int(m.group(1)) if m else 1
            rest = rest[m.end():] if m else rest
            out.extend(_expand(inner) * n)
            text = rest
            continue
        parts = text.split(None, 1)
        tok = parts[0]
        text = parts[1].strip() if len(parts) > 1 else ""
        if tok.startswith("x") and tok[1:].isdigit():        # 单独的 x10 → 重复上一个
            if not out:
                raise ValueError(f"序列开头就是次数：{text!r}")
            out.extend([out[-1]] * (int(tok[1:]) - 1))
            continue
        m = re.fullmatch(r"(.+?)x(\d+)", tok)                # 01-uprightx10
        if m:
            out.extend([m.group(1)] * int(m.group(2)))
            continue
        out.append(tok)
    return out


def simulate(case: dict, blobs: dict[str, bytes]) -> dict:
    """按案例序列**重放**：新检测器，每帧只喂一次（= app 每 200ms 一张的喂法）。

    检不到的帧按 app 的规则**跳过**（`onPoseResult` 只推 pose 帧），
    但时间戳照旧前进 —— 所以缺口会体现在 `held_ms` 的区间划分上。
    """
    det = new_detector()
    planned = parse_sequence(case["sequence"])
    # 🔴 解析器体检：`parse_sequence` 坏过**两次**（见它的 docstring），两次的症状都不是
    # "解析器坏了"，而是"案例与期望不符"或 `KeyError`。所以这里拿**案例自己声明的帧数**
    # 直接核对 —— 让解析器的缺陷报成解析器的缺陷。
    if "frames" in case and len(planned) != case["frames"]:
        raise AssertionError(
            f"案例 {case['id']}：声明 {case['frames']} 帧，解析出 {len(planned)} 帧 —— "
            f"**解析器坏了**，不是素材或期望的问题（sequence={case['sequence']!r}）")
    series: list[dict] = []
    skipped = 0
    for i, name in enumerate(planned):
        out = det.process_frame(app_style(decode_jpeg(blobs[name])))
        if out is None:
            skipped += 1
            continue
        series.append({"t": i * FPS_MS, "head_angle": out["head_angle"],
                       "shoulder_diff": out["shoulder_diff"], "spine_angle": out["spine_angle"]})
    det.release()

    verdict = judge_exercise(series, case["spec"])
    vals = [f["head_angle"] for f in series]
    # 逐帧序列也登记进 fixture：这样**任何**消费者（node/TS 复用同一份判定、
    # 或将来在浏览器里注入）都能离线复放，不必在本机装 mediapipe。
    # 只留 3 位小数 —— 判定里唯一的取整点是 `round_1((v - base) / thr)`，
    # 3 位小数远细于它，不会改变结论；`verify()` 有一条断言专门盯这件事。
    stored = [{"t": f["t"], "head_angle": round(f["head_angle"], 3),
               "shoulder_diff": round(f["shoulder_diff"], 3),
               "spine_angle": round(f["spine_angle"], 3)} for f in series]
    return {
        "id": case["id"], "title": case["title"], "spec": case["spec"],
        "sequence": case["sequence"], "frames": case.get("frames"), "why": case["why"],
        "semantics": case["semantics"], **({"finding": case["finding"]} if case.get("finding") else {}),
        "expect_grade": case["expect_grade"], "expect_hint": case["expect_hint"],
        "planned_frames": len(planned), "accepted_frames": len(series),
        "skipped_frames": skipped, "duration_ms": len(planned) * FPS_MS,
        "head_angle_range": [round(min(vals), 2), round(max(vals), 2)] if vals else [None, None],
        "series": stored,
        "verdict": verdict,
        "match": verdict["grade"] == case["expect_grade"] and verdict["hint"] == case["expect_hint"],
    }


# ---------------------------------------------------------------- 组装 / 报告

def thresholds() -> dict:
    return {
        "HEAD_TILT_THRESHOLD": HEAD_TILT_THRESHOLD,
        "ACTIVITY_ONSET": ACTIVITY_ONSET,
        "ACTIVITY_IDLE_MAX": ACTIVITY_IDLE_MAX,
        "HOLD_TARGET_RATIO": HOLD_TARGET_RATIO,
        "DEFAULT_MIN_CYCLES": DEFAULT_MIN_CYCLES,
    }


def make_doc(solo: dict, cases: list[dict]) -> dict:
    return {
        "_comment": "由 scripts/fake-camera/build-frames.py 生成；校验模式会重测/重放并逐项比对。",
        "capture": {
            "width": W, "height": H, "frame_interval_ms": FPS_MS,
            "note": "200ms = 桌面端 setInterval(captureAndSend, 200)，恰好等于 MIN_POSE_MS "
                    "⇒ 桌面路径下时间支撑过滤是惰性的（真正的短命段只出现在移动端 rAF 高帧率）",
        },
        "thresholds": thresholds(),
        "reading_semantics": {
            "head_angle_solo": "每帧新建检测器单独喂 5 次的读数，与喂帧顺序无关 —— 只用于素材准入",
            "head_angle_range": "在该案例的序列上下文里实测的读数区间，**随喂帧顺序变**",
            "warning": "两组数不可混用。实测同一张 03-head-tilt-strong.jpg：单独喂 8.51°，"
                       "先喂过正坐帧再喂 5.70°（差 2.81°）—— static_image_mode=False 是跟踪模式，有跨帧状态。",
        },
        "findings": DRIFT_FINDING,
        "frames": [
            {"file": f"{name}.jpg", **solo[name],
             "expect_detected": next(s.get("expect_detected", True)
                                     for s in FRAME_SPECS if s["name"] == name),
             "desc": next(s["desc"] for s in FRAME_SPECS if s["name"] == name)}
            for name in solo
        ],
        "cases": cases,
    }


def report(doc: dict, title: str) -> tuple[int, list[str]]:
    print(f"\n{title}")
    print(f"素材（{len(doc['frames'])} 帧 {doc['capture']['width']}x{doc['capture']['height']}，"
          f"过一遍 app 编码 q{APP_JPEG_QUALITY} 后**单独**实测）")
    print(f"{'文件':<26}{'head_angle':>11}{'shoulder%':>10}{'spine':>8}{'vis':>7}  兜底?")
    print("-" * 80)
    problems: list[str] = []
    for f in doc["frames"]:
        want = f.get("expect_detected", True)
        if not f["detected"]:
            if want:
                print(f"{f['file']:<26}{'检不到':>11}   ❌ 期望检出却没有")
                problems.append(f"{f['file']}：期望检出，实际检不到")
            else:
                print(f"{f['file']:<26}{'检不到':>11}   ✅ 就该检不到（负样本）")
            continue
        if not want:
            print(f"{f['file']:<26}{f['head_angle']:>11.2f}   ❌ 期望检不到却检出了")
            problems.append(f"{f['file']}：本应无人却被检出 —— 负样本失效")
            continue
        ok = f["head_is_real"] and f["shoulder_is_real"]
        if not ok:
            problems.append(f"{f['file']}：角度是兜底值，素材不合格")
        print(f"{f['file']:<26}{f['head_angle']:>11.2f}{f['shoulder_diff']:>9.2f}%"
              f"{f['spine_angle']:>8.2f}{f['visibility']:>7.3f}  {'✅ 否' if ok else '❌ 是'}")

    print(f"\n案例（每帧 {doc['capture']['frame_interval_ms']}ms，按序列重放）")
    print(f"{'案例':<24}{'采用帧':>7}{'峰值活动':>10}{'保持(ms)':>10}{'占比':>8}{'次数':>6}"
          f"{'实际':>14}{'期望':>14}  判定")
    print("-" * 120)
    deviated = 0
    for c in doc["cases"]:
        v = c["verdict"]
        if not c["match"]:
            problems.append(f"案例 {c['id']}：实际 {v['grade']}/{v['hint']} "
                            f"≠ 期望 {c['expect_grade']}/{c['expect_hint']}")
        mark = "✅ 与登记一致"
        if c["match"] and c["semantics"] == "known-deviation":
            mark = "⚠️ 已知语义偏差（见 finding）"
            deviated += 1
        elif not c["match"]:
            mark = "❌ 与期望不符"
        print(f"{c['id']:<24}{c['accepted_frames']:>7}{v['peak_activity']:>10.3f}{v['held_ms']:>10}"
              f"{v['hold_ratio']:>8.3f}{v['cycles']:>6}{v['grade']:>14}{c['expect_grade']:>14}"
              f"  {mark}")
    print("-" * 120)
    t = doc["thresholds"]
    print(f"阈值：HEAD_TILT_THRESHOLD={t['HEAD_TILT_THRESHOLD']}°  "
          f"ACTIVITY_ONSET={t['ACTIVITY_ONSET']}  ACTIVITY_IDLE_MAX={t['ACTIVITY_IDLE_MAX']}  "
          f"HOLD_TARGET_RATIO={t['HOLD_TARGET_RATIO']}  DEFAULT_MIN_CYCLES={t['DEFAULT_MIN_CYCLES']}")

    grades = {c["verdict"]["grade"] for c in doc["cases"]}
    hints = {c["verdict"]["hint"] for c in doc["cases"]}
    print(f"覆盖：{len(doc['cases'])} 个案例 / grade {sorted(grades)}（三分类全中 "
          f"{'✅' if len(grades) == 3 else '❌'}）/ hint {len(hints)} 条"
          f"（共 5 条 {'✅' if len(hints) == 5 else '❌'}）")
    if problems:
        print("\n问题：")
        for p in problems:
            print(f"   · {p}")
    else:
        note = f"，其中 {deviated} 个为已登记的语义偏差" if deviated else ""
        print(f"总判定：✅ 素材准入合格、{len(doc['cases'])} 个案例全部与登记值一致{note}")
    return (0 if not problems else 1), problems


# ---------------------------------------------------------------- 两种模式

def build_from_src(src_dir: Path) -> int:
    FRAMES.mkdir(parents=True, exist_ok=True)
    blobs: dict[str, bytes] = {}
    for spec in FRAME_SPECS:
        if spec.get("synth") == "empty_room":
            img = empty_room()
        elif spec.get("rotate"):
            base_name, deg = spec["rotate"]
            img = rotate_frame(Image.fromarray(decode_jpeg(blobs[base_name])[:, :, ::-1]), deg)
        else:
            matches = sorted(src_dir.glob(spec["src"]))
            if not matches:
                print(f"!! 找不到原图：{src_dir}/{spec['src']}")
                return 2
            img = fit(Image.open(matches[0]))
        blobs[spec["name"]] = to_jpeg(img)
        (FRAMES / f"{spec['name']}.jpg").write_bytes(blobs[spec["name"]])
        print(f"  写出 frames/{spec['name']}.jpg（{len(blobs[spec['name']])} B）")

    solo = {n: measure_solo(b) for n, b in blobs.items()}
    cases = [simulate(c, blobs) for c in CASES]
    doc = make_doc(solo, cases)
    SCENARIOS.write_text(json.dumps(doc, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    rc, _ = report(doc, "重建完成（已写入 frames/ 与 scenarios.json）")
    return rc


def load_frames() -> dict[str, bytes]:
    return {p.stem: p.read_bytes() for p in sorted(FRAMES.glob("*.jpg"))}


def verify() -> int:
    """重测 + 重放，与 scenarios.json 逐项比对 —— 这才是「校验」。"""
    if not SCENARIOS.exists():
        print(f"!! 缺 {SCENARIOS}；先跑 --from-src=<原图目录>")
        return 2
    doc = json.loads(SCENARIOS.read_text(encoding="utf-8"))
    frames = load_frames()
    recorded_frames = {f["file"]: f for f in doc["frames"]}
    recorded_cases = {c["id"]: c for c in doc["cases"]}

    problems: list[str] = []
    on_disk = {f"{n}.jpg" for n in frames}
    if on_disk != set(recorded_frames):
        problems.append(f"frames/ 与登记表不一致：{sorted(on_disk)} vs {sorted(recorded_frames)}")

    solo = {n: measure_solo(b) for n, b in frames.items()}
    for name, m in solo.items():
        old = recorded_frames.get(f"{name}.jpg")
        if old is None:
            continue
        want = old.get("expect_detected", True)
        if not want:
            if m["detected"]:
                problems.append(f"{name}.jpg：负样本失效 —— 本应无人却被检出")
            continue
        if not m["detected"]:
            problems.append(f"{name}.jpg：重测检不到（原登记为检出）")
            continue
        if abs(m["head_angle"] - old["head_angle"]) > TOL:
            problems.append(f"{name}.jpg：head_angle {old['head_angle']} → {m['head_angle']}"
                            f"（超容差 {TOL}）")
        if m["head_is_real"] != old["head_is_real"]:
            problems.append(f"{name}.jpg：head_is_real {old['head_is_real']} → {m['head_is_real']}")
        if not m["head_is_real"] or not m["shoulder_is_real"]:
            problems.append(f"{name}.jpg：角度是兜底值，素材不合格")

    if thresholds() != doc["thresholds"]:
        problems.append(f"阈值常量变了：登记 {doc['thresholds']} → 现在 {thresholds()}")

    cases = [simulate(c, frames) for c in CASES]
    for c in cases:
        old = recorded_cases.get(c["id"])
        if old is None:
            problems.append(f"案例 {c['id']} 不在登记表里")
            continue
        ov = old["verdict"]
        nv = c["verdict"]
        for k in ("grade", "hint", "cycles"):
            if nv[k] != ov[k]:
                problems.append(f"案例 {c['id']}：{k} {ov[k]} → {nv[k]}")
        for k in ("peak_activity", "held_ms", "hold_ratio"):
            if abs(nv[k] - ov[k]) > TOL:
                problems.append(f"案例 {c['id']}：{k} {ov[k]} → {nv[k]}（超容差 {TOL}）")
        if c["head_angle_range"] != old["head_angle_range"]:
            problems.append(f"案例 {c['id']}：读数区间 {old['head_angle_range']} → {c['head_angle_range']}")
        # 登记序列自洽：**拿登记下来的序列重判一次**，必须得到登记下来的结论。
        # 这条盯的是「series 与 verdict 不同源」—— 例如序列被四舍五入到改变了结论，
        # 或某次改动只重算了 verdict 没重存 series。任何外端消费者都信不过不自洽的 fixture。
        redo = judge_exercise(old.get("series") or [], c["spec"])
        for k in ("grade", "hint", "cycles", "peak_activity", "held_ms", "hold_ratio"):
            if redo[k] != ov[k]:
                problems.append(f"案例 {c['id']}：登记序列不自洽 —— 重判 {k}={redo[k]} ≠ 登记 {ov[k]}")

    rc, _ = report(make_doc(solo, cases), "校验（重测素材 + 重放案例）")
    if problems:
        print("\n❌ 与 scenarios.json 登记值不符：")
        for p in problems:
            print(f"   · {p}")
        return 1
    print("\n✅ 与 scenarios.json 登记值逐项一致")
    return rc


def main() -> int:
    check_parser()          # 先体检解析器：它坏过两次，且症状都不指向自己
    src_arg = next((a for a in sys.argv[1:] if a.startswith("--from-src=")), None)
    if src_arg:
        src_dir = Path(src_arg.split("=", 1)[1])
        print(f"从 {src_dir} 重建素材……")
        return build_from_src(src_dir)
    return verify()


if __name__ == "__main__":
    raise SystemExit(main())
