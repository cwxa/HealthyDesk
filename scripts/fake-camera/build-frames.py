#!/usr/bin/env python
"""模拟摄像头案例 · 素材流水线 + 准入校验。

## 这个脚本解决什么

项目要在**没有真摄像头**的环境里测实时链路（首当其冲是「有帧时的实时徽章/提示」，
它至今只在真机验过 —— 无头环境没帧，`liveQuality` 恒为 `null`）。
本脚本产出那套「假摄像头」用的**画面素材**与**期望判定**。

## 三种模式

    python scripts/fake-camera/build-frames.py --from-src=<原图目录>
        # 从 ImageGen 原图重建 frames/ 与 scenarios.json（需要 PIL + mediapipe）

    python scripts/fake-camera/build-frames.py
        # 校验模式（默认）：**重测/重放**已入库素材，与 scenarios.json 登记值逐项比对

    python scripts/fake-camera/build-frames.py --rewrite
        # 从**入库素材**刷新登记表（原图不入库，所以改了喂帧表就只能走这条路）。
        # 🔴 有闸门：只在「除 ui_smoke 之外的一切都与登记值一致」时才写文件 ——
        #    它刷新不了任何判定结论，因此不可能被用来把评分回归洗成新的登记值。

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


# ---------------------------------------------------------------- UI 冒烟轮
#
# `npm run verify:ui`（`scripts/verify-ui-smoke.mjs`）会把下面这份帧表**真的逐帧喂进
# 浏览器里的 app**（CDP 注入一条 `canvas.captureStream()` 假摄像头），于是
# 「`getUserMedia` → 本地引擎（MediaPipe wasm）→ 帧序列 → `judgeExercise` →
# 实时引导浮层 + 实时徽章」这条链第一次有了自动化证据。
# 在此之前无头环境**没有帧** ⇒ `liveQuality` 恒为 `null` ⇒ 只验过它的**回落分支**。
#
# 登记**展开后的文件名列表**，而不是把 `sequence` 串交给 JS 再解析一遍：
# 序列解析器只该有一份实现（`parse_sequence`），而它已经坏过两次（见其 docstring）——
# 多写一份 JS 复刻，就是多一处"两份解析器悄悄分叉"的地方。
UI_SMOKE_LEAD_IN = 1
UI_SMOKE_ACTIVE = "02-head-tilt-mild"
UI_SMOKE_FRAMES = 60
# 🔴 浏览器那次喂帧是**按墙上时间定长**的（`feed_ms`），不是「把帧表喂完为止」。
#
# 为什么不能靠"帧数 × 间隔"来定长（**实测，返工过一次**）：
# 无头页里每帧推理 ~0.4–0.5 秒且**同步**占用主线程 ⇒ 推帧的 `setInterval` 被拖到
# **2.0–5.0 帧/秒**（`.buildenv/probe-live-frames.mjs` 与冒烟实跑都测到过 2.0）。
# 于是「53 帧 × 200ms = 10.6s」这条算术在浏览器里根本不成立：
#   ① 帧率 2.0 时它变成 **22.5 秒**，越过动作计时器的 **12 秒** ⇒ 后半段帧被记到
#      下一个动作上 ⇒ 收尾屏多出一个"判过的动作"（「未判定」6 → 5）、落库明细 1 项 → 2 项；
#   ② 帧率 5.0 时它只有 10.6 秒 —— 于是"多久"取决于机器当前有多忙，断言跟着飘。
# 改成"在 `feed_ms` 墙上时间里一直喂"，帧率变成**只影响帧数、不影响时长**的量，
# 而"保持比例"这个被验的量恰好只依赖**时长**。
#
# 为什么是 10 秒：整段判定的分母是动作的**标称时长**（`neck-flex-left` = 12 秒），
# 达标线 0.6 ⇒ 需要 held ≥ 7.2 秒。喂帧能贡献的 held ≈ `feed_ms − (起势 + 跟踪器收敛) × 帧间隔`，
# 而收敛段在**帧数**上是固定的（实测见下），换算成时间就是 `4 × 1000/帧率` ⇒ 帧率越低亏得越多。
# 10 秒 + 起势压到 1 帧之后，最慢的扫描点（1.5 帧/秒）也还剩 0.7 的占比（余量 +0.1），
# 同时离 12 秒的动作切换线留了 2 秒 —— `feed_ms` 一到就点「结束活动」，绝不可能溢出。
UI_SMOKE_FEED_MS = 10000
# 🔴 帧率扫描：把同一份帧表按这几个帧率**重打时间戳**再判一次，要求**全部**判成 completed。
#
# 这几个值不是随手取的：
#   · 1.5 = 这条断言允许的最慢节奏。它同时是"帧间隔还没被当成掉帧"的下界
#     （1000/1.5 = 667ms < MAX_FRAME_GAP_MS = 1500，再慢下去 held_ms 会整段塌成 0）
#     与"保持比例还够得着"的下界（实测：再慢一档就要压线）。
#   · 2.0 = 实跑里真出现过的最低帧率（`.buildenv/probe-live-frames.mjs`）。
#   · 5.0 = 实跑里的正常值。
# 扫描把"帧率波动会不会翻结论"变成一条**离线可复算**的断言，而不是等 CI 里偶发一次红。
# ⚠️ **下界必须与 `verify-ui-smoke.mjs` 允许的最低帧率一致** —— 消费端直接读
#    `rate_floor`（= 这里的最小值）来断言，不自己另写一个数（下面有自检钉住）。
UI_SMOKE_RATES = (1.5, 2.0, 5.0)
# 从 `feed_ms` 一到就开始点「结束活动」：点击会立刻停止记录帧，而 CDP 往返
# （`Runtime.evaluate` + React 调度）在忙页上最多几百毫秒 —— 这段余量必须预先算出来，
# 否则"帧越过了 12 秒边界"会以"收尾屏多了一个判过的动作"的形状出现（很难归因）。
UI_SMOKE_CLICK_SLACK_MS = 600
UI_SMOKE_SEQUENCE = (f"01-upright x{UI_SMOKE_LEAD_IN} "
                     f"{UI_SMOKE_ACTIVE} x{UI_SMOKE_FRAMES - UI_SMOKE_LEAD_IN}")
UI_SMOKE_WHY = (
    f"起势 {UI_SMOKE_LEAD_IN} 帧（`01-upright`，只用来当活动范围的基线）→ 之后一直是 "
    f"`{UI_SMOKE_ACTIVE}`（拉伸位，实测 head_angle 最大的一张）。"
    f"整个冒烟就是「把这一段按**墙上时间**喂 {UI_SMOKE_FEED_MS} 毫秒」。"
    "\n"
    "\n"
    "## 为什么不是「取 completed 案例的连续切片」\n"
    "\n"
    "v1 取的是 `completed` 的前 53 帧（起势 3 + 轻微 5 + 大幅 45），按「喂完即止」跑。"
    "实跑暴露两个问题：① 帧率被拖到 2.0 帧/秒时推帧跨过了 12 秒的动作边界，"
    "后半段帧被记到下一个动作上（收尾屏会多出一个「判过的动作」）；"
    "② `hold_ratio` 的分母是**标称 12 秒**，而「被记下的第一帧」来得晚"
    "（首次推理要建图 + 预热，起势帧在墙上时间里被拉长）⇒ ratio 正好在 0.6 上摇摆。"
    "现在改成「定长喂帧 + 起势压到 1 帧」，两条同时解决。"
    "\n"
    "\n"
    "## 起势为什么只能是 1 帧\n"
    "\n"
    "跟踪器（`static_image_mode=False`）换图之后要几帧才收敛：实测喂 "
    "`01-upright → 02-mild` 时 head_angle 走 1.31° → 3.63° → 6.06° → 7.71°，"
    "第 4 帧才越过 `ACTIVITY_ONSET`。这几帧在**帧数**上是固定的，换算成占时就等于 "
    "`4 × 帧间隔` —— 帧率越低，喂帧时长里能被算成「保持住」的部分越少。"
    "起势 1 帧把这段开销压到最小，于是最慢的扫描点也还有 0.1 的余量。"
    "\n"
    "\n"
    "## 不钉时间轴，只钉不变量\n"
    "\n"
    "实时引导看的是**最近 5 秒**的滚动窗口、帧的时间戳是 `Date.now()`，所以"
    "「第几秒该出现哪句文案」依赖真实帧率，钉了必然假红。冒烟只断言：读数真的来自"
    "注入的帧、浮层整个喂帧期间都在、出现过非 idle 的提示、徽章与提示不矛盾。"
    "⚠️ 另有一个**已知现象**（不是缺陷、也未被断死）：起势帧滚出 5 秒窗口后，"
    "窗口内的最低位变成拉伸位本身 ⇒「活动范围」归零 ⇒ 静止保持被实时提示成"
    "「没检测到动作」。整段判定不受影响（它看的是整段帧），见 README。"
)


# UI 冒烟那份帧表的**重放载体**。它不是第 8 个案例：案例表要"覆盖 grade/hint 的组合"，
# 而这份表只服务一件事 —— 给浏览器喂帧。所以它不进 `CASES`，也不进登记表的 `cases`。
# 但它的读数**必须由同一条重放路径产生**（`simulate()`，一把检测器、按顺序喂），
# 否则"离线扫描说 completed、浏览器里 insufficient"就无从对账。
UI_SMOKE_CASE = {
    "id": "__ui-smoke__",
    "title": "UI 冒烟喂帧表（不进案例登记）",
    "spec": dict(HOLD_HEAD),
    "sequence": UI_SMOKE_SEQUENCE,
    "frames": UI_SMOKE_FRAMES,
    "expect_grade": "completed",
    "expect_hint": "很好，保持住",
    "semantics": "as-designed",
    "why": UI_SMOKE_WHY,
}


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


def first_action_duration_ms() -> int:
    """从 `src/data/exercises.ts` 读**第一个动作**的标称时长（毫秒）。

    🔴 为什么要跨语言读，而不是在这里写 `12000`：动作计时器走到这个时长会**自动切到
    下一个动作**，而切过去之后推进去的帧会被记到新动作上 —— 这正是 v1 那个
    「收尾屏多出一个判过的动作」的原因。喂帧窗口必须短于它，这条不等式只有在
    时长**单点取值**时才成立；在 Python 里复刻一个 12000，改动作库时就会悄悄分叉
    （症状是浏览器里偶发多一个动作，而归因看起来完全不像"时长改了"）。
    """
    src = (ROOT / "src" / "data" / "exercises.ts").read_text(encoding="utf-8")
    body = src.split("export const EXERCISES", 1)
    if len(body) != 2:
        raise RuntimeError("src/data/exercises.ts 里找不到 `export const EXERCISES`")
    m = re.search(r"\bduration:\s*(\d+)", body[1])
    if not m:
        raise RuntimeError("src/data/exercises.ts 的动作里找不到 `duration: <秒>`")
    return int(m.group(1)) * 1000


def smoke_series(blobs: dict[str, bytes]) -> list[dict]:
    """按 UI 冒烟的帧表重放一遍，拿到**顺序相关**的读数。

    复用 `simulate()` 而不是另写一遍循环：读数与喂帧顺序有关（跟踪模式有跨帧状态），
    而"浏览器里那 10 秒"喂的就是这个顺序 —— 两条路各写一份重放，迟早有一天分叉。
    """
    return simulate(UI_SMOKE_CASE, blobs)["series"]


def rate_sweep(series: list[dict], spec: dict) -> dict:
    """把同一串读数按几个帧率**重打时间戳**再判一次 —— 见 `UI_SMOKE_RATES`。

    建模方式：帧率 r ⇒ 每帧间隔 1000/r 毫秒；在 `feed_ms` 的墙上时间里只来得及喂
    `r × feed_ms / 1000` 帧。**读数不重测**（它们只取决于喂帧顺序，与时间戳无关），
    只换时间戳 —— 而"保持比例"恰恰只由时间戳决定。
    """
    out: dict[str, dict] = {}
    for r in UI_SMOKE_RATES:
        n = int(r * UI_SMOKE_FEED_MS / 1000)
        gap = round(1000.0 / r)
        sub = [dict(f, t=i * gap) for i, f in enumerate(series[:n])]
        v = judge_exercise(sub, spec)
        out[str(r)] = {
            "frames": len(sub), "frame_gap_ms": gap,
            "peak_activity": v["peak_activity"], "held_ms": v["held_ms"],
            "hold_ratio": v["hold_ratio"], "grade": v["grade"], "hint": v["hint"],
        }
    return out


def ui_smoke_block(blobs: dict[str, bytes]) -> dict:
    """UI 冒烟那段要喂的帧表 + 「帧率波动会不会翻结论」的离线扫描。

    消费端（`scripts/verify-ui-smoke.mjs`）拿到的是**展开后的文件名列表**，
    它不必再解析一遍 `sequence` —— 序列解析器只该有一份实现（`parse_sequence`），
    而且它已经坏过两次（见 docstring）。

    ### 四条自检，每一条都"自己先坏掉才可能放过"

    1. 帧数与声明一致 —— 解析器坏了要报成解析器的缺陷（同样的教训见 `simulate()`）。
    2. 起势帧必须恰好是最前面那几帧、且**只有**它们是非拉伸帧。基线帧一旦跑到中间
       （或消失），`amplitudesOf` 取到的"最低位"就不再是静息位，活动范围会被凭空改小 ——
       症状是浏览器里偶发 `insufficient`，而离线扫描照样绿。
    3. 帧率扫描必须**全部** `completed` —— 这是把"帧率波动"从"CI 里偶发一次红"
       变成"改完当场可复算"。
    4. 两个余量（幅度、保持）都要留够，不能"刚好过线" —— 浏览器路径的读数与这里
       差零点几度是常态（见文件头第 3 条），压线的表必然间歇性翻车。
    """
    files = [f"{n}.jpg" for n in parse_sequence(UI_SMOKE_SEQUENCE)]
    lead = [f"{UI_SMOKE_ACTIVE}.jpg"] * (UI_SMOKE_FRAMES - UI_SMOKE_LEAD_IN)
    if len(files) != UI_SMOKE_FRAMES:
        raise AssertionError(
            f"UI 冒烟序列解析出 {len(files)} 帧，声明 {UI_SMOKE_FRAMES} 帧 —— "
            f"**解析器坏了**（sequence={UI_SMOKE_SEQUENCE!r}）")
    want = ["01-upright.jpg"] * UI_SMOKE_LEAD_IN + lead
    if files != want:
        raise AssertionError(
            f"UI 冒烟帧表必须恰好是「起势 {UI_SMOKE_LEAD_IN} 帧 01-upright → 其余全部 "
            f"{UI_SMOKE_ACTIVE}」—— 实际 {sorted(set(files))}，"
            f"`01-upright` 出现 {files.count('01-upright.jpg')} 次。"
            f"（基线帧跑到中间会让活动范围凭空改小，而且离线扫描看不出来）")

    series = smoke_series(blobs)
    sweep = rate_sweep(series, UI_SMOKE_CASE["spec"])

    # ── 喂帧窗口 vs 动作时长：这条不等式不成立，"多出一个判过的动作"必然复发 ──
    action_ms = first_action_duration_ms()
    budget = UI_SMOKE_FEED_MS + UI_SMOKE_CLICK_SLACK_MS
    if budget > action_ms - 500:
        raise AssertionError(
            f"喂帧窗口 {UI_SMOKE_FEED_MS}ms + 点击余量 {UI_SMOKE_CLICK_SLACK_MS}ms "
            f"= {budget}ms，已经贴到第一个动作的标称时长 {action_ms}ms —— "
            f"动作计时器会在喂帧还没结束时切到下一个动作，后半段帧被记到新动作上。"
            f"（第一个动作的时长来自 src/data/exercises.ts，不是本文件的常量）")

    bad = [f"{r} 帧/秒 → {v['grade']}/{v['hint']}"
           for r, v in sweep.items() if v["grade"] != "completed"]
    if bad:
        raise AssertionError(
            "UI 冒烟帧表在扫描的帧率下有判不成 completed 的：\n"
            + "\n".join(f"  · {b}" for b in bad)
            + "\n  ⇒ 要么加长 feed_ms / 缩短起势，要么换一张 tilt 更大的拉伸帧。"
              "**不要**改成只扫一个帧率或放宽这句 —— 那等于把已知的间歇性失败藏起来。"
              "（实测：起势压到 1 帧 + feed 10 秒，最慢的 1.5 帧/秒才刚好留出 0.1 的余量）")

    amp_margin = min(v["peak_activity"] for v in sweep.values()) - ACTIVITY_ONSET
    hold_margin = min(v["hold_ratio"] for v in sweep.values()) - HOLD_TARGET_RATIO
    if amp_margin < 0.3 or hold_margin < 0.09:
        raise AssertionError(
            f"UI 冒烟帧表余量不够：幅度余量 {amp_margin:+.2f}（要求 ≥ +0.30）、"
            f"保持余量 {hold_margin:+.2f}（要求 ≥ +0.09）。扫描明细："
            + json.dumps(sweep, ensure_ascii=False)
            + "。浏览器路径的读数与离线重放差零点几度是常态，压线的表会间歇性翻车"
              "（v1 就是栽在这上面）。")

    floor = min(UI_SMOKE_RATES)
    return {
        "why": UI_SMOKE_WHY,
        "sequence": UI_SMOKE_SEQUENCE,
        "frame_interval_ms": FPS_MS,
        "frame_count": len(files),
        "lead_in_frames": UI_SMOKE_LEAD_IN,
        "feed_ms": UI_SMOKE_FEED_MS,
        "click_slack_ms": UI_SMOKE_CLICK_SLACK_MS,
        "action_duration_ms": action_ms,
        # 🔴 消费端（`verify-ui-smoke.mjs`）直接用这个当下界去断言"帧率没被节流"，
        # 不自己另写一个数 —— 否则"断言允许的帧率"与"扫描证明过的帧率"会分叉，
        # 而那种分叉的表现是"守卫绿着但浏览器里已经判不出来了"。
        "rate_floor": floor,
        "rate_sweep": sweep,
        "margins": {"amplitude": round(amp_margin, 3), "hold": round(hold_margin, 3)},
        "frames": files,
    }


def make_doc(solo: dict, cases: list[dict], ui: dict) -> dict:
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
        "ui_smoke": ui,
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

    # UI 冒烟那份帧表：它是 `verify:ui` 的输入。帧率扫描要**每次**都打出来 ——
    # 只在失败时才显示的话，"它今天扫的是 1.5 还是 5.0"就没人知道，
    # 而"扫描绿"正是"浏览器里那 10 秒不会间歇性翻结论"的唯一依据。
    ui = doc["ui_smoke"]
    print(f"\nUI 冒烟帧表（喂给浏览器的那一份；定长 {ui['feed_ms']}ms，"
          f"{ui['frame_count']} 帧表 / 起势 {ui['lead_in_frames']} 帧）")
    print(f"  {ui['sequence']}")
    print(f"{'帧率':>6}{'帧数':>7}{'间隔(ms)':>10}{'峰值活动':>10}{'保持(ms)':>10}{'占比':>8}"
          f"{'判定':>14}")
    for r, v in ui["rate_sweep"].items():
        mark = "✅" if v["grade"] == "completed" else "❌"
        print(f"{r:>6}{v['frames']:>7}{v['frame_gap_ms']:>10}{v['peak_activity']:>10.3f}"
              f"{v['held_ms']:>10}{v['hold_ratio']:>8.3f}{v['grade']:>14}  {mark}")
    mg = ui["margins"]
    if any(v["grade"] != "completed" for v in ui["rate_sweep"].values()):
        problems.append("UI 冒烟帧表在扫描的帧率下有判不成 completed 的（余量不足）")
    print(f"  余量：幅度 {mg['amplitude']:+.3f}（vs ACTIVITY_ONSET）"
          f" / 保持 {mg['hold']:+.3f}（vs HOLD_TARGET_RATIO）")

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


# ---------------------------------------------------------------- 三种模式

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
    doc = make_doc(solo, cases, ui_smoke_block(blobs))
    SCENARIOS.write_text(json.dumps(doc, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    rc, _ = report(doc, "重建完成（已写入 frames/ 与 scenarios.json）")
    return rc


def load_frames() -> dict[str, bytes]:
    return {p.stem: p.read_bytes() for p in sorted(FRAMES.glob("*.jpg"))}


def load_doc() -> dict | None:
    if not SCENARIOS.exists():
        print(f"!! 缺 {SCENARIOS}；先跑 --from-src=<原图目录>")
        return None
    return json.loads(SCENARIOS.read_text(encoding="utf-8"))


def recompute(doc: dict) -> tuple[dict, list[dict], dict, list[str]]:
    """把登记表里**除 `ui_smoke` 之外**的一切重算一遍并逐项比对。

    返回 `(solo, cases, ui, problems)`。`ui_smoke` 单独由调用方比对 ——
    它与其他段不同源（见 `ui_smoke_block()`）。
    """
    frames = load_frames()
    recorded_frames = {f["file"]: f for f in doc["frames"]}
    recorded_cases = {c["id"]: c for c in doc["cases"]}
    problems: list[str] = []

    on_disk = {f"{n}.jpg" for n in frames}
    if on_disk != set(recorded_frames):
        problems.append(f"frames/ 与登记表不一致：{sorted(on_disk)} vs {sorted(recorded_frames)}")

    # 素材说明与「期望检出」是**代码里的常量**生成的。比对它们，是因为导出/重写登记表时
    # 这两栏最容易变成"只在 JSON 里改过、代码里没改"的孤儿值（人眼不会去核对注释）。
    for spec in FRAME_SPECS:
        old = recorded_frames.get(f"{spec['name']}.jpg")
        if old is None:
            continue
        if old.get("desc") != spec["desc"]:
            problems.append(f"{spec['name']}.jpg：desc 与 FRAME_SPECS 不一致")
        if old.get("expect_detected", True) != spec.get("expect_detected", True):
            problems.append(f"{spec['name']}.jpg：expect_detected 与 FRAME_SPECS 不一致")

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

    return solo, cases, ui_smoke_block(frames), problems


def verify() -> int:
    """重测 + 重放，与 scenarios.json 逐项比对 —— 这才是「校验」。"""
    doc = load_doc()
    if doc is None:
        return 2
    solo, cases, ui, problems = recompute(doc)

    # UI 冒烟那一段的帧表：它是 `verify:ui` 的输入，被谁单方面改掉都会让那条守卫
    # 验的东西悄悄变样（少喂几帧、喂错素材、断言照样可能绿）。
    if doc.get("ui_smoke") != ui:
        problems.append(
            "ui_smoke 段与重建结果不一致 —— 帧表 / 序列 / 喂帧时长 / 帧率扫描任一改动都要重跑 "
            "--from-src=<原图目录>（没有原图时用 --rewrite，它有闸门）再提交"
            "（它是 verify:ui 的输入，不是注释）")

    rc, _ = report(make_doc(solo, cases, ui), "校验（重测素材 + 重放案例）")
    if problems:
        print("\n❌ 与 scenarios.json 登记值不符：")
        for p in problems:
            print(f"   · {p}")
        return 1
    print("\n✅ 与 scenarios.json 登记值逐项一致")
    return rc


def rewrite() -> int:
    """从**入库素材**刷新登记表（不需要 ImageGen 原图）。

    🔴 这个模式存在的唯一理由是：`scenarios.json` 里有些段是**从素材重算出来的**
    （`frames` 的单测读数、`ui_smoke` 的帧率扫描），而原图（花钱的那三张）**不入库** ——
    没有原图就没法走 `--from-src`，于是一次纯粹的"喂帧表改动"会被迫连累整份素材。

    🔴 **闸门**：只在「除 `ui_smoke` 之外的一切都与登记值一致」时才写文件。
    也就是说它**刷新不了任何判定结论** —— 案例的 grade/hint/读数只要变了，
    `recompute()` 就会把问题列出来，这里直接拒绝。这样它就不可能被用来
    "把一次评分回归洗成新的登记值"（那正是本项目铁律里最贵的一种自欺）。
    """
    doc = load_doc()
    if doc is None:
        return 2
    solo, cases, ui, problems = recompute(doc)
    if problems:
        print("\n❌ 拒绝刷新登记表：重算结果与登记值**不符**（--rewrite 不是用来洗结论的）")
        for p in problems:
            print(f"   · {p}")
        print("\n  先跑不带参数的模式查原因；真要改判定，那是评分域变更，"
              "要同时升 ACTION_SCORES_VERSION 并重跑 verify:parity。")
        return 1

    new = make_doc(solo, cases, ui)
    SCENARIOS.write_text(json.dumps(new, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    if doc.get("ui_smoke") != ui:
        print("\n（ui_smoke 段已刷新）")
    report(new, "刷新完成（已写入 scenarios.json；判定结论一个字都没动）")
    return 0


def main() -> int:
    check_parser()          # 先体检解析器：它坏过两次，且症状都不指向自己
    src_arg = next((a for a in sys.argv[1:] if a.startswith("--from-src=")), None)
    if src_arg:
        src_dir = Path(src_arg.split("=", 1)[1])
        print(f"从 {src_dir} 重建素材……")
        return build_from_src(src_dir)
    if "--rewrite" in sys.argv[1:]:
        return rewrite()
    return verify()


if __name__ == "__main__":
    raise SystemExit(main())
