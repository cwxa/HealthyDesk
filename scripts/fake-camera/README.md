# 假摄像头案例（fake camera）

一套**可复现的摄像头输入** + **由真实现跑出来的期望判定**，用来测「有帧」那条链路。

## 为什么需要

`verify:ui`（无头 Chrome 冒烟）的「不覆盖」清单里有一条最贵：

> **有真实帧时的实时徽章 / `localQuality`** —— 无头环境没有摄像头，`liveQuality` 恒为 `null`。

也就是：**「界面渲染得出来」验过了，「拿到帧之后判得对不对」从来没在自动化里验过**，
只在真机上人工看过。本目录就是为了堵这个口子 —— 它给出可控的「摄像头内容」。

## 目录与职责

| 路径 | 职责 | 入库 |
| --- | --- | --- |
| `build-frames.py` | **素材流水线 + 准入校验**。从 ImageGen 原图重建 `frames/` 与 `scenarios.json`；无参运行时**重测重放并与登记值逐项比对** | ✅ |
| `replay.mjs` | **消费端**：把登记序列喂给**移动端** TS 实现，与桌面端 Python 登记值做双端对拍（`npm run verify:fake-camera`，**已进 CI**） | ✅ |
| `make-y4m.py` | 把案例序列写成 **Y4M** 供无头 Chrome 的假摄像头使用（见「注入浏览器」） | ✅ |
| `frames/*.jpg` | 6 帧 640×480 画面素材（共 456 KB） | ✅ |
| `scenarios.json` | fixture：素材准入读数、逐帧序列、期望判定、阈值、实测结论（64 KB） | ✅ |
| 原图（ImageGen 出品，3 张 PNG 共 2.8 MB） | 只做再生成用；**不入库**（花 credits、体积大、可复现性靠 prompt 记录） | ❌ |

原图与 ImageGen prompt 记录在 `.buildenv/fake-camera-src/`；重建命令：

```bash
.buildenv/Scripts/python.exe scripts/fake-camera/build-frames.py --from-src=.buildenv/fake-camera-src
```

## 命令

```bash
# 1) 校验模式：重测素材 + 重放 7 个案例，与 scenarios.json 逐项比对（需要 mediapipe）
.buildenv/Scripts/python.exe scripts/fake-camera/build-frames.py

# 2) 双端对拍：同一个 fixture 喂给 TS 实现，六字段逐项比（纯 node + esbuild，**不需要 mediapipe**）
npm run verify:fake-camera

# 3) 生成假摄像头供片盘（可选，注入浏览器时才用）
.buildenv/Scripts/python.exe scripts/fake-camera/make-y4m.py --list
.buildenv/Scripts/python.exe scripts/fake-camera/make-y4m.py --case=completed --out=.buildenv/fake-cam/completed.y4m
```

> 分工：**重新生成案例需要 mediapipe**（要真跑推理）；**断言案例不需要** ——
> 逐帧序列已落盘在 `scenarios.json`，所以第 2 条能进 CI。

## 素材准入（每帧**单独**喂 5 次；过一遍 app 的 q70 编码）

| 文件 | 字节 | head_angle | shoulder_diff | spine | visibility | 兜底？ |
| --- | ---: | ---: | ---: | ---: | ---: | --- |
| `00-no-person.jpg` | 24 905 | — **检不到** | — | — | — | 负样本（期望行为） |
| `01-upright.jpg` | 90 268 | 0.97° | 3.48% | 0.35° | 0.996 | 否 |
| `02-head-tilt-mild.jpg` | 78 827 | 9.69° | 6.62% | 1.52° | 0.966 | 否 |
| `03-head-tilt-strong.jpg` | 80 649 | 8.51° | 6.56% | 0.85° | 0.991 | 否 |
| `04-near-upright-3deg.jpg` | 86 253 | 5.32° | 1.80% | 0.25° | 0.991 | 否 |
| `05-near-upright-5deg.jpg` | 84 162 | 8.31° | 0.97% | 0.06° | 0.972 | 否 |

「兜底？」= 角度是不是走了兜底分支（`dx < 0.03` 时直接 `return 0.0`）。**兜底值的素材一律不合格** ——
它和「真的竖直」同值，光看角度分不出来（见下面「三条规矩」第 2 条）。

## 七个案例（判定均由 `judge_exercise` / `judgeExercise` 实测，不是手推）

| 案例 | 序列 | 峰值活动 | 保持(ms) | 占比 | 次数 | 判定 | hint |
| --- | --- | ---: | ---: | ---: | ---: | --- | --- |
| `completed` | `01 x10 02 x5 03 x45` | 1.9 | 9600 | 0.80 | 0 | `completed` | 很好，保持住 |
| `insufficient-amplitude` | `(04 x5 05 x5) x6` | 0.7 | 0 | 0.00 | 0 | `insufficient` | 幅度还不够，再大一点 |
| `insufficient-hold` | `(01 04 02 02) x15` | 1.2 | 2200 | 0.20 | 11 | `insufficient` | 保持住，别急着放下 |
| `cyclic-completed` | `01 x8 02 x6 (01 x4 02 x4) x5 01 x6` | 1.7 | 4200 | 0.40 | 4 | `completed` | 很好，保持住 |
| `cyclic-too-few` | `01 x10 03 x20 01 x10 03 x20` | 2.1 | 7200 | 0.60 | 1 | `insufficient` | 再多做几次 |
| `still-person-12s` | `01 x60` | 0.3 | 0 | 0.00 | 0 | `insufficient` | 幅度还不够（**已登记的语义偏差**） |
| `no-pose` | `00 x60` | 0.0 | 0 | 0.00 | 0 | `idle` | 没检测到动作，跟着引导慢慢做 |

帧名缩写：`01`=`01-upright`、`02`=`02-head-tilt-mild`、`03`=`03-head-tilt-strong`、
`04`=`04-near-upright-3deg`、`05`=`05-near-upright-5deg`、`00`=`00-no-person`。

### 覆盖矩阵（这是这套案例的主要价值）

- **三分类全中**：`idle` / `insufficient` / `completed` 各有案例。
- **五条 hint 全中**：`很好，保持住` / `幅度还不够，再大一点` / `保持住，别急着放下` /
  `再多做几次` / `没检测到动作，跟着引导慢慢做`。**hint 与 grade 是一对多**，
  后三条是最容易混的（三个不同的缺口，同两个 grade）—— 案例就是为拆开它们而设计的：
  - `insufficient-amplitude`（幅度不够）vs `insufficient-hold`（保持不够）：**同 grade、不同 hint**；
  - `cyclic-too-few` 是**第三条缺口**：它 `hold_ratio = 0.6`（在保持门槛上）却仍判不足，
    因为往复类只看 `cycles`；反过来 `insufficient-hold` 的 `cycles = 11` 却不判完成，
    因为保持类不看次数 —— 两条合起来钉住「**尺度用错就会误判**」。
- **两条缺口之外的第三个方向**：`completed` 是正样本，`no-pose` 是**真负样本**。

## 实测结论：跟踪器在「完全静止」的人身上会漂（F1）

`.buildenv/probe-idle-drift*.py` 用同一张 `01-upright.jpg` 连喂 300 帧（60 秒）：

```
帧  0: 1.31°  →  帧 25: 0.84°（最低）  →  帧 59: 2.45°  →  帧 299: 4.91°（仍在上升、不收敛）
≈ 0.07°/s；300 帧上的全部 241 个 12 秒滑动窗口里，最坏 peak_activity = 0.400
```

三条推论（已写进 `scenarios.json` 的 `findings`）：

1. 🔴 **`ACTIVITY_IDLE_MAX = 0.25` 在「检到人的静止画面」上不可达** ⇒ 真人一动不动会被判
   `insufficient` /「幅度还不够，再大一点」，**不是** `idle`。`idle` 实际只在
   「一帧都没有 / 少于两帧」时出现（因此 `no-pose` 才是唯一的真负样本）。
   **这是已登记的语义偏差**（`still-person-12s` 的 `semantics: "known-deviation"`），不是案例写错了。
2. ✅ **但漂移伪造不出 `completed`**：0.400 只有 `ACTIVITY_ONSET = 1.0` 的 40%。
   这一条同样要写 —— 否则「知道它漂」会变成「以为它随时会坏」。
3. ⚠️ **风险（未修，属评分域）**：漂移不收敛 ⇒ 活动时长若显著变长，窗口内范围会跟着涨
   （按 0.07°/s 推算约 70 秒才摸到 5.0° 阈值）。当前动作库最长 20 秒（S8 `durationRange` 上限）
   ⇒ 漂移约 1.4°、`peak ≈ 0.28`，**眼下安全**。真要改 `ACTIVITY_IDLE_MAX` 或加漂移补偿，
   属评分域变更，得单独升 `ACTION_SCORES_VERSION`。

## 余量表（判据离边界有多远）

活动量单位 = 该量静息阈值的倍数（1.0 = 5.0°，对 `head`）。

| 案例 | 关键判据 | 余量 | 折算角度 |
| --- | --- | --- | --- |
| `completed` | `peak ≥ 1.0` | **+0.9** | +4.5° |
| `cyclic-completed` | `cycles ≥ 3` | **+1**（4 vs 3） | — |
| `cyclic-too-few` | `cycles ≥ 3` | −2（1 vs 3） | — |
| `insufficient-hold` | `peak ≥ 1.0` / `ratio ≥ 0.6` | **+0.2** / −0.4 | +1.0° / — |
| `insufficient-amplitude` | `peak < 1.0` / `peak ≥ 0.25` | −0.3 / **+0.45** | −1.5° / +2.25° |
| `still-person-12s` | `peak < 0.25` | +0.05（登记偏差，非断言） | +0.25° |
| `no-pose` | `peak < 0.25` | −0.25（不可能漂：全帧检不到） | — |

### ⚠️ 已知测量路径差异（**这是本 fixture 最大的未验证项**）

期望角度是**预测值**，两条路径的重采样不同：

- 本 fixture 走 PIL + OpenCV 的 `resize`/`imencode`（LANCZOS / INTER_LANCZOS4）；
- app 走浏览器 `canvas.drawImage(video, 0, 0, 640, 480)` + `toDataURL('image/jpeg', 0.7)`。

**实测到的差异量级**：同一张 `01-upright.jpg` 在不同重采样路径下 `head_angle`
差 **1.3°**（全分辨率 1024×768 直送 = 2.27° vs 640×480 + LANCZOS + q70 = 0.97°），
折算 **0.26 活动量**。注意那组数据的差异里还含「换了分辨率」，浏览器路径只换滤波、不换分辨率，
所以真实差异**应当更小 —— 但未测**。

按最坏方向（1.3° 全算进范围）把 0.26 活动量扣到每条案例上：

- `completed`（余量 0.9）、`cyclic-*`（看次数，不吃这项）：**不受影响**；
- `insufficient-amplitude`（余量 −0.3 / +0.45）：仍在夹缝里，**不受影响但最紧**；
- `insufficient-hold`（余量 +0.2）：**可能翻成「幅度还不够」** —— 这条是唯一有实际翻转风险的；
  它的序列已经**按余量挑过**（原设计 `(01 04 05) x20` 的 peak 只有 1.1，余量 +0.1，比现在更危险）。

**结论怎么用**：把这份 fixture 注入浏览器（下一节）之后，**必须复核这几条余量**，
不能假定预测值等于实跑值。

## 素材准入的三条规矩（全部踩过，逐条留证）

1. 🔴 **键名是 `head_angle` / `shoulder_diff`，不是 `head_tilt` / `shoulder_ratio`。**
   第一版探针读错键，`dict.get(k, 0)` **静默**返回 0 ⇒ 「什么都没测」被打印成
   「测到了，值是 0.00」。一个漂亮的假绿。
2. 🔴 **`head_angle == 0` 有两种来源**：真的竖直，或 `dx < 0.03`（双耳水平间距不足）的
   **兜底 `return 0.0`**，两者同值 ⇒ 必须额外查归一化间距（上表「兜底？」一列）。
3. 🔴🔴 **读数与「喂帧顺序」有关**：`PoseDetector` 建的是 `static_image_mode=False`（**跟踪**模式）。
   实测同一张 `03-head-tilt-strong.jpg`：单独喂 **8.51°**，先喂过正坐帧再喂 **5.70°**（差 2.81°）。
   ⇒ 判定一律来自**按案例序列重放**；`head_angle_solo` 只用于素材准入。**两组数不可混用。**

## 序列解析器：坏过两次，两次都不指向自己

`parse_sequence()` 支持 `a x10` / `ax10` / `(a b) x5` / `(a b) x5 c x2` / 嵌套括号。两次缺陷：

| 版本 | 症状 | 真因 |
| --- | --- | --- |
| v1 | `KeyError: ''` —— 看着像素材缺文件 | 把 `x10` 当成了帧名 |
| v2 | 60 帧的案例「采用帧」只有 8 ⇒ 报「案例与期望不符」 | 括号重复**后面还有尾巴**时把尾巴整段丢掉 |
| v3 | `ValueError: not enough values to unpack` | 嵌套括号按**第一个** `)` 切分（应深度匹配） |

⇒ 现在有两道**直指解析器**的防线：`PARSER_SELF_TEST`（6 条自测，
含案例序列**覆盖不到**的「以 `(` 开头且带尾巴」与嵌套括号形状）+ 案例自带的
`frames` 声明帧数（不符就报「**解析器坏了**」）。**案例判定红了先看「采用帧」这一列。**

## 变异自证（证明这些断言真的有效）

`.buildenv/mutate-fake-camera.py`（按项目惯例不入库）：临时改一处源码 → 跑守卫 → 要求它红 → 还原。

```
抓出 15/15 条正向变异；期望绿 3 条（X1, N1, N2）全绿 ✅；还原后基线 ✅ 绿
```

| 组 | 变异 | 抓它的断言 |
| --- | --- | --- |
| M1–M6 | TS 侧常量：`HOLD_TARGET_RATIO` / `HEAD_TILT_THRESHOLD` / `HINT_CYCLES` / `ACTIVITY_IDLE_MAX` / `DEFAULT_MIN_CYCLES` / `EXERCISE_ACTIVITY_START` | 阈值同源断言（改阈值必须重建案例）+ 六字段对拍 |
| M7–M10 | fixture 被改：伪造 `cycles`、清空 `series`、改阈值登记值、改某帧 `head_angle` | 六字段对拍 |
| K1–K2 | 负样本失效：`00-no-person` 被期望检出 / 换成真人帧 | 素材准入（期望检不到却检出）+ `no-pose` 的期望判定 |
| K3–K4 | 解析器退回 v2 / 按第一个 `)` 切分 | `PARSER_SELF_TEST` |
| K5 | 案例声明帧数被改 | 「采用帧」体检 |
| **X1** | TS：`MIN_POSE_MS` 200 → 0（**抓不到，且这是对的**） | 本层逐帧间隔 = 200ms = `MIN_POSE_MS` ⇒ 时间支撑过滤本就惰性；它由 `verify:exercise-quality` §l 的 50ms 密集帧用例覆盖 |
| N1–N2 | 负向对照：改注释 / 值等价改写（`0.25` → `2.5e-1`） | 证明守卫不是「见到 diff 就红」，比的是**语义**不是**文本** |

## 注入浏览器（**已实测可行**，接线尚未做）

Chromium 有官方假摄像头开关：

```bash
.buildenv/Scripts/python.exe scripts/fake-camera/make-y4m.py --case=completed --out=/tmp/completed.y4m
chrome --headless=new --no-sandbox \
  --use-fake-ui-for-media-stream \
  --use-fake-device-for-media-stream \
  --use-file-for-fake-video-capture=/tmp/completed.y4m \
  <页面>
```

**实测结果**（本机 Chrome / 无头 / 走 CDP + 真实时间）：`<video>` 拿到 **640×480**、
8 秒推进 **39 帧 ≈ 5fps** —— 正好等于桌面端的 `setInterval(captureAndSend, 200)` 与
fixture 的 `frame_interval_ms`。

两个坑（都踩过）：

1. **Y4M 头必须是 `C420mpeg2`**，帧率写 `F5:1`；分辨率/帧率要和 `scenarios.json` 的
   `capture` 一致，否则 `<video>` 尺寸与喂帧节奏都对不上。
2. 🔴 **别用 `--dump-dom --virtual-time-budget` 读结果**：`--virtual-time-budget` 会被
   **未决的媒体请求**挂住 —— `getUserMedia()` 的 Promise 既不 resolve 也不 reject，
   虚拟时间就不再推进，dump 出来永远是初始状态。实测第一版打印 `0:start`，
   **看上去像「y4m 不行」，其实探针根本没跑**。必须连 CDP、用**真实**等待。

### 接线还差什么（如实列出）

- `verify-ui-smoke.mjs` 里加一轮「假摄像头」：临时把 `dist/mediapipe/wasm/*` 与
  `dist/mediapipe/models/pose_landmarker_full.task` 补进 dist 的**临时副本**
  （`cap-build` 才补它们，plain `vite build` 没有，所以现在 `?platform=android` 走本地引擎会 404），
  用 `?platform=android` 打开、跑完 12 秒活动、断言实时徽章与收尾分数。
- 每案例 **12 秒真实时间**，7 个案例 ≈ 90 秒 —— 要决定是进 CI（变慢）还是本地/发布前跑。
- 上面「已知测量路径差异」那几条余量要在**实跑后复核**。

## 水印与成本

- ImageGen 出的 3 张原图右下角带**烘进像素**的「AI生成 WORKBUDDY」水印
  （实测该区域均值 44/41/38、max 173、std 32）。它离 5 个角度校验点很远，**不影响判定**；
  但素材**只应本地测试用**，不要对外发布或当宣传图。
- 成本：ImageGen **按张计费，约 5–10 credits/张** ⇒ 3 张原图约 **15–30 credits**。
  `04` / `05`（旋转派生）与 `00`（程序生成空房间）**不花钱**。
- 原图不入库、也不再随 `frames/` 一起分发；重建靠 `.buildenv/fake-camera-src/`。

## 局限与**不覆盖**（别把"没验"读成"验过了"）

- **不是真人**：ImageGen 的合成人脸与真实人体几何有差异，`head_angle` 的**绝对量级**
  只能保证「在这份素材上自洽」，不能推出「真机上同一个动作会给同样的读数」。
- **只有头部侧屈与一个空房间**：肩部环绕是**复用同一套帧**凑出的往复序列，
  它的 `metric` 是 `any`，**不代表真做环绕动作时肩部量的行为**。
- **只有 5fps 一条采样率**：桌面路径就是 200ms/帧，所以这没问题；但**移动端 rAF 高帧率**
  （真正的短命段只可能出现在那里）**没有被这套案例覆盖** —— 那一层由
  `verify:exercise-quality` §l 的 50ms 密集帧合成用例负责。
- **不含时间戳异常**：掉帧缺口、乱序时间戳不在素材里（数值层有用例）。
- **不含权限与设备行为**：不覆盖「用户拒绝授权」「切后台」「设备被占用」。
- **不含真机 WebView**：这是桌面 Chrome，与安卓/iOS 的 WebView 不是同一个内核版本。
- **`still-person-12s` 是已登记的偏差，不是通过**：see F1。
- **浏览器实跑（app 侧读数）尚未做过** —— 上面「余量表」里的期望角度全部是**预测值**。
