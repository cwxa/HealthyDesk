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
| `build-frames.py` | **素材流水线 + 准入校验**。从 ImageGen 原图重建 `frames/` 与 `scenarios.json`（`--from-src=`）；无参运行时**重测重放并与登记值逐项比对**；`--rewrite` 从入库素材刷新登记表（**有闸门**，刷新不了判定结论） | ✅ |
| `replay.mjs` | **消费端**：把登记序列喂给**移动端** TS 实现，与桌面端 Python 登记值做双端对拍（`npm run verify:fake-camera`，**已进 CI**） | ✅ |
| `make-y4m.py` | 把案例序列写成 **Y4M** 供无头 Chrome 的假摄像头使用（**备查路线**，最终走的是 CDP 注入，见「注入浏览器」） | ✅ |
| `frames/*.jpg` | 6 帧 640×480 画面素材（共 456 KB） | ✅ |
| `scenarios.json` | fixture：素材准入读数、逐帧序列、期望判定、阈值、实测结论、`ui_smoke`（喂给 `verify:ui` 的那份帧表 + 帧率扫描）（68 KB） | ✅ |
| 原图（ImageGen 出品，3 张 PNG 共 2.8 MB） | 只做再生成用；**不入库**（花 credits、体积大、可复现性靠 prompt 记录） | ❌ |

> ⚠️ 原图与 prompt 记录在 `.buildenv/fake-camera-src/` —— 那是**本机临时目录**，
> 不在版本控制里。所以**换机器之后 `--from-src` 就跑不了了**，改喂帧表只能走
> `--rewrite`（它对判定结论有闸门）。重建素材则需要重新用 ImageGen 出图（花钱）。

## 命令

```bash
# 1) 校验模式：重测素材 + 重放 7 个案例，与 scenarios.json 逐项比对（需要 mediapipe）
.buildenv/Scripts/python.exe scripts/fake-camera/build-frames.py

# 1b) 改了喂帧表 / 换了素材之后刷新登记表（原图不入库 ⇒ 这是唯一能改 ui_smoke 的路）
#     🔴 有闸门：只在「除 ui_smoke 之外的一切都与登记值一致」时才写文件
.buildenv/Scripts/python.exe scripts/fake-camera/build-frames.py --rewrite

# 1c) 有原图时从零重建素材（需要 ImageGen 出的那 3 张 PNG，本机在 .buildenv/fake-camera-src/）
.buildenv/Scripts/python.exe scripts/fake-camera/build-frames.py --from-src=.buildenv/fake-camera-src

# 2) 双端对拍：同一个 fixture 喂给 TS 实现，六字段逐项比（纯 node + esbuild，**不需要 mediapipe**）
npm run verify:fake-camera

# 3) 把这份帧表真的喂进浏览器（移动端用例；`ui_smoke` 是它的输入）
npm run verify:ui -- --case=android

# 4) 生成假摄像头供片盘（备查路线 A，现在走的是 CDP 注入）
.buildenv/Scripts/python.exe scripts/fake-camera/make-y4m.py --list
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

## 注入浏览器（✅ **已接线进 `npm run verify:ui`**，移动端用例）

### 两条路都用过，最终选第二条

| 路子 | 做法 | 结论 |
| --- | --- | --- |
| A. Chrome 官方开关 | `--use-file-for-fake-video-capture=<case>.y4m` | **实测可行**（`<video>` 640×480、≈5fps），但 ① 相位不可控（第几帧什么时候到不由我们定）② y4m **26MB** 不入库 ③ 每个 Chrome 实例只能喂一个文件 |
| B. **CDP 注入 `MediaStream`** | `canvas.captureStream(0)` + `track.requestFrame()`，覆写 `getUserMedia` | ✅ **最终采用**：纯 JS、几 KB 载荷、帧表与节奏完全可控、能与现有冒烟共用同一个 Chrome |

路 A 的命令留在这里备查：

```bash
.buildenv/Scripts/python.exe scripts/fake-camera/make-y4m.py --case=completed --out=/tmp/completed.y4m
chrome --headless=new --no-sandbox \
  --use-fake-ui-for-media-stream --use-fake-device-for-media-stream \
  --use-file-for-fake-video-capture=/tmp/completed.y4m <页面>
```

两个坑（都踩过）：

1. **Y4M 头必须是 `C420mpeg2`**，帧率写 `F5:1`；分辨率/帧率要和 `scenarios.json` 的
   `capture` 一致，否则 `<video>` 尺寸与喂帧节奏都对不上。
2. 🔴 **别用 `--dump-dom --virtual-time-budget` 读结果**：`--virtual-time-budget` 会被
   **未决的媒体请求**挂住 —— `getUserMedia()` 的 Promise 既不 resolve 也不 reject，
   虚拟时间就不再推进，dump 出来永远是初始状态。实测第一版打印 `0:start`，
   **看上去像「y4m 不行」，其实探针根本没跑**。必须连 CDP、用**真实**等待。

### 路 B 的三个关键点（少一个就静默失效）

1. 🔴 必须在 **document-start** 注入（`Page.addScriptToEvaluateOnNewDocument`），
   而且那时 `document.documentElement` **还是 `null`** —— 直接 `appendChild` 会抛，
   整段注入**静默失效**（症状是 `window.__ngFakeCam === undefined`，而界面照常渲染，
   看着像"注入没执行"）。整段包 `try/catch`，错误留在 `window.__ngFakeCamErr` 供断言读。
   ⚠️ 这个 API 只对**后续文档**生效 ⇒ 必须在 `Page.navigate` **之前**注册。
2. 🔴 `captureStream(0)` **不主动 `requestFrame()` 就不出新帧** ⇒ `<video>` 只有画布初始
   那一帧、`currentTime` 不动、引擎按它去重 ⇒ 一条帧都进不了判定链。这被当成**特性**用：
   未 `start()` 时一条帧都不推，于是整个用例前半段（路由 / 新手引导 / 零采样收尾屏）
   保持"没有摄像头"时的语义 —— 有一条断言专门钉这件事。
3. 🔴 **喂帧按墙上时间定长**（`start(ms)`），不是"把帧表喂完为止"。见下一节。

### 为什么"喂帧时长"必须自己定，而不能由帧数算

无头页里每帧推理是**同步**的、占主线程 ~0.45 秒 ⇒ 推帧的 `setInterval` 被拖到
**2.0–5.0 帧/秒**（实测：同一次冒烟里既出现过 3.2/s 也出现过 2.0/s）。
于是「53 帧 × 200ms = 10.6 秒」在浏览器里根本不成立：

- 帧率 2.0 时它变成 **22.5 秒** ⇒ 越过动作计时器的 **12 秒**边界 ⇒ 后半段帧被记到
  `action=1` 上 ⇒ 收尾屏多出一个"判过的动作"（「未判定」6 → 5）、落库明细 1 项 → 2 项；
- 帧率 5.0 时它只有 10.6 秒 ⇒ "喂多久"取决于机器当前有多忙，断言跟着飘。

改成"在 `feed_ms` 里一直喂"之后，帧率**只影响帧数、不影响时长**，
而"保持比例"这个被验的量恰好**只依赖时长**（`judgeSession` 的 `held_ms` 是相邻帧时间差之和）。

### UI 冒烟帧表（`scenarios.json:ui_smoke`）

`01-upright x1 02-head-tilt-mild x59`，表长 60 帧（供循环），但**实际喂 10 秒**：

- 起势只放 **1 帧** `01-upright`：它只用来当活动范围的基线（`amplitudesOf` 取段内最低位）。
- 之后**一直**是 `02-head-tilt-mild`（solo 读数 9.69° = 6 张里最大的一张；
  `03-head-tilt-strong` 在跟踪上下文里只收敛到 5.70°，**判不到 onset**，所以不能用它）。
- ⚠️ **起势为什么只能 1 帧**：跟踪器换图之后要几帧才收敛 —— 实测喂
  `01-upright → 02-mild` 时 `head_angle` 走 **1.31° → 3.63° → 6.06° → 7.71°**，
  第 4 帧才越过 `ACTIVITY_ONSET`。这几帧在**帧数**上是固定的，换算成占时就等于
  `4 × 帧间隔` —— **帧率越低，能被算成"保持住"的时间越少**。起势 1 帧把这段开销压到最小。

#### 帧率扫描（`ui_smoke.rate_sweep`）—— 把"帧率波动会不会翻结论"变成离线可复算

| 帧率 | 帧数 | 帧间隔 | 峰值活动 | 保持(ms) | 占比 | 判定 |
| --- | --- | --- | --- | --- | --- | --- |
| 1.5 | 15 | 667ms | 1.6 | 8004 | **0.7** | completed ✅ |
| 2.0 | 20 | 500ms | 1.6 | 8500 | **0.7** | completed ✅ |
| 5.0 | 50 | 200ms | 1.6 | 9400 | **0.8** | completed ✅ |

幅度余量 **+0.6**（vs `ACTIVITY_ONSET`）/ 保持余量 **+0.1**（vs `HOLD_TARGET_RATIO`）。

🔴 **这张表只说明"离线模型在哪个帧率下还站得住" —— 它不是"浏览器里那个帧率一定判得出来"。**
扫描的建模方式是"同一串读数**重打时间戳**再判一次"（`rate_sweep()` 自己的 docstring 写着
"读数只取决于喂帧顺序，与时间戳无关"），而**这句话在浏览器里是假的**：真环境读数来自 MediaPipe 的
**逐帧跟踪**（`static_image_mode=false`），帧隔得越久越要重新收敛 ⇒ 实测
**2.7–4.5 帧/秒稳定判成 `completed`**，而 **1.5–1.6 帧/秒那一档结论不可信**：
CI `36676223799` **同一次 run 里两个平台都跑 1.5 帧/秒**，android 判 `completed score=84`、
ios 判 `insufficient score=76` —— **跨在 80 分达标线上摇摆**（`36660895335` 的 1.5/1.6 也判 76）。
而本表说 1.5 那一档是 `completed`。⇒ 现在 fixture 里**两个下界并存、各答一问**：

| 字段 | 答的是 | 值 |
| --- | --- | --- |
| `rate_floor` | 离线重放里算法还判得出的最低档（**模型**问题） | 1.5 |
| `rate_floor_browser` | 浏览器里这一次的读数还可信吗（**环境**问题） | 2.0（实测落在 1.6–2.7 之间） |

消费端（`verify-ui-smoke.mjs`）读这两个数，**不自己另写**；两轴交叉判"这一轮该不该采信"
（帧率 × 结论对不对得上），**低帧率本身不判红** —— 判据、取舍与实跑证据见
`docs/MULTIPLATFORM.md §9.9` 的决策表。
再往下会先坏在两处：① 帧间隔超过 `MAX_FRAME_GAP_MS=1500` ⇒ `held_ms` 整段不计；
② 收敛帧占掉更长的墙上时间 ⇒ 保持比例掉到达标线以下。

### 实跑记录（`npm run verify:ui -- --case=android`）

```
· 采样 16 次 / 喂帧 10000 ms，推送 32 帧（3.2/s）；点结束活动 t+10110ms（往返 110ms）
· 时间轴 0.1s:-- 1.2s:-- 1.7s:-- 2.4s:幅度 3.0s:幅度 3.6s:保持 4.2s:保持 4.8s:保持
        5.6s:保持 6.1s:很好 6.7s:很好 7.3s:保持 7.9s:幅度 8.5s:幅度 9.0s:没检 9.6s:没检
```

时间轴与机制推演**完全吻合**（`没检 → 幅度 → 保持 → 很好 → 幅度 → 没检`）：开头两帧
窗口里不足两帧 ⇒ 无判定；随后跟踪器收敛 ⇒ 幅度不够 → 保持 → 很好；
**6.1–6.7 秒出现过「很好，保持住」**，即浏览器路径真的判出了 `completed`；
最后那两句「没检测到动作」是**已知现象**（起势帧滚出 5 秒窗口后活动范围归零），
不是缺陷，也没被断死（见下）。

### 复核「已知测量路径差异」（本文档此前的最大未验证项）

上一节列过：期望角度是**预测值**，浏览器路径只换滤波不换分辨率，差异**应当更小但未测**。
现在有了实跑证据：**浏览器判出来的结论与离线扫描的每一条都一致** ——

- 帧表在浏览器里判成 `completed`、成绩 ≥ 80（与扫描的 3 档全部一致）；
- 同一屏上的**实时徽章与实时提示不矛盾**（`idle ⟺ 0 分`、否则 `≥80 ⟺ completed`）。

🔴 **最后这一条自带一段教训（v1.7.1）**：它**第一轮是空转的** —— 锚点写成
`p「实时动作达成度」`，而移动端练习条上的徽章压根没有那个 `<p>` ⇒ 读数恒 `null`、
循环整段 `continue` ⇒ 断言一路"✓"却什么都没查（变异 M5 漏网才暴露）。
同轮修法：锚点改成 `ScoreGauge` 上的 `data-ng`，并把"锚点读得到"写进断言；
顺带发现移动端练习条徽章读的是运动态 `score`（不是 `liveQuality.score`）——
**v1.7.0 的「徽章与提示同源」当时只覆盖了桌面面板**，已一并统一。
修完实测：锚点每次跑读到 **19 次读数**，M5 当场被抓住（11 处矛盾）。

⇒ 余量按最坏方向扣 0.26 之后仍然成立（UI 冒烟这份表余量 +0.6/+0.1）。
⚠️ 但**七个登记案例的余量表没有重测** —— 浏览器里只喂了 UI 冒烟那一份表，
下面「已知测量路径差异」里 `insufficient-hold`（余量 +0.2）那条**仍然只是预测**。

### 收尾：契约变更（改了喂帧表就要走这条）

`ui_smoke` 段是 `verify:ui` 的**输入**，被谁单方面改掉都会让那条守卫验的东西悄悄变样。
所以：改了序列/时长/帧率档 ⇒ 跑 `build-frames.py --rewrite` 刷新登记值
（原图**不入库**，没有原图就跑不了 `--from-src`）。
🔴 `--rewrite` **有闸门**：只在「除 `ui_smoke` 之外的一切都与登记值一致」时才写文件 ——
它**刷新不了任何判定结论**，所以不可能被用来把一次评分回归洗成新的登记值。

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
- **案例只覆盖 5fps 一条采样率**：桌面路径就是 200ms/帧，所以离线案例这没问题；
  **移动端 rAF 高帧率**（真正的短命段只可能出现在那里）**没有被这 7 个案例覆盖** ——
  那一层由 `verify:exercise-quality` §l 的 50ms 密集帧合成用例负责。
  ⚠️ 而 `verify:ui` 那个浏览器用例里的实际帧率是**机器决定的 0.3–4.8 帧/秒**，
  它在 fixture 里由 `ui_smoke.rate_sweep`（1.5 / 2.0 / 5.0）离线建模（**只有时间戳被重打**），
  再加一个**浏览器实测**的环境门 `rate_floor_browser`（2.0）——
  "这一次的读数还可不可信"由 `trustCameraRound()` 两轴交叉判（见上）；
  "第几帧在什么时候"仍然不在射程内。
  ⚠️ 由此**放弃**的一层保护：帧率落在 `rate_floor`(1.5) ~ `rate_floor_browser`(2.0) 之间、
  且结论与 fixture 一致的那些轮**会通过**（只打 ⚠）—— 那几轮里的浮层/徽章类不变量
  是在偏挤的环境下验的。要不要收紧，见 `docs/MULTIPLATFORM.md §9.9` 的取舍说明。
- **不含时间戳异常**：掉帧缺口、乱序时间戳不在素材里（数值层有用例）。
- **不含权限与设备行为**：不覆盖「用户拒绝授权」「切后台」「设备被占用」。
- **不含真机 WebView**：这是桌面 Chrome，与安卓/iOS 的 WebView 不是同一个内核版本。
- **`still-person-12s` 是已登记的偏差，不是通过**：see F1。
- **浏览器实跑只覆盖了 UI 冒烟那一份帧表**（`01-upright x1 02-mild x59`）。
  上面「素材准入」表里的读数、以及七个案例的判定，**仍然全部是离线预测值** ——
  浏览器路径只被证明"对这份表给出了与离线一致的三分类结论与同源分数"，
  **不能**推出"这 6 张图在浏览器里读数与离线相同"。要核对的话得逐案例在浏览器里跑
  （每案例 10 秒，7 个 ≈ 70 秒），眼下没做 —— 因为 `verify:ui` 已经很长了。
