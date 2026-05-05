———

# 🎯 肩颈健康助手 - 完整 Vibe Code 提示词

---

# 角色

你是一个资深全栈架构师 + 桌面端工程师。

你将设计并实现一个完整可运行的桌面健康软件。

你必须输出：

* 完整项目目录结构
* 完整代码（不可省略核心代码）
* 技术设计文档
* 数据库结构
* API 设计
* 姿态识别流程
* 定时调度逻辑
* 错误兜底方案
* 日志规范
* Acceptance Criteria（AC）

---

# 项目名称

NeckGuardian - 肩颈健康助手

---

# 项目目标

开发一个无需联网运行的桌面软件，用于帮助用户健康使用电脑，自动提醒肩颈放松训练，并通过摄像头实时检测姿态质量。

核心目标：

* 启动后自动检测肩颈姿态
* 引导做 1 分钟标准肩颈活动（7 个动作，总计约 82 秒）
* 每 30 分钟提醒一次（可自定义 15/30/45/60 分钟）
* 记录电脑使用时长
* 记录姿态评分数据
* 生成周报统计
* 支持最小化到托盘
* 支持开机自启动

---

# 技术架构

前端：Electron + React + TypeScript + Vite
后端：Python (FastAPI + Uvicorn)
数据库：SQLite（aiosqlite 异步驱动）
姿态识别：MediaPipe Pose（本地运行）
AI 建议：DeepSeek API（可选联网增强模式，需配置 DEEPSEEK_API_KEY）
调度器：APScheduler（异步调度）
通信：WebSocket（摄像头帧传输）+ HTTP REST API

---

# 系统架构设计

```
Electron 主进程 (main.ts)
│
├── React 渲染进程 (Vite 构建)
│   ├── NeckActivity  (/)
│   ├── Dashboard     (/dashboard)
│   └── Settings      (/settings)
│
├── Python FastAPI 本地服务 (port 18920)
│   ├── 姿态评分计算    (scorer.py)
│   ├── MediaPipe 检测  (pose_detector.py)
│   ├── 健康数据统计    (stats.py)
│   ├── 定时调度        (scheduler.py)
│   ├── 数据持久化      (database.py)
│   ├── AI 建议代理     (ai_advisor.py)
│   └── WebSocket 帧处理 (camera_ws.py)
│
└── SQLite 本地数据库 (data/neckguardian.db)
```

---

# 核心功能设计

## 1️⃣ 启动流程

1. Electron 主进程启动
2. 自动启动本地 Python FastAPI 服务（spawn python backend/main.py）
3. 轮询 /api/health 等待后端就绪（最多 30 秒）
4. 后端 lifespan 初始化：创建 data 目录 → 初始化 SQLite 数据库 → 加载提醒间隔设置 → 启动 APScheduler
5. React 前端显示"正在启动服务..."加载动画
6. 后端就绪后，前端自动申请摄像头权限
7. 摄像头就绪后，建立 WebSocket 连接 (/ws/camera)
8. MediaPipe 初始化成功后开始实时姿态检测

---

## 2️⃣ 姿态检测逻辑

使用 MediaPipe Pose 检测关键点：

| 关键点 | 索引 | 用途 |
|--------|------|------|
| 鼻子 (NOSE) | 0 | 头部位置参考 |
| 左耳 (LEFT_EAR) | 7 | 头部倾斜计算 |
| 右耳 (RIGHT_EAR) | 8 | 头部倾斜计算 |
| 左肩 (LEFT_SHOULDER) | 11 | 肩部高度/脊柱计算 |
| 右肩 (RIGHT_SHOULDER) | 12 | 肩部高度/脊柱计算 |
| 左髋 (LEFT_HIP) | 23 | 脊柱倾斜计算 |
| 右髋 (RIGHT_HIP) | 24 | 脊柱倾斜计算 |

### 计算指标

**头部侧倾角 (head_angle)**：
- 双耳连线的水平夹角（2D 平面，不依赖深度）
- `atan2(dy, dx)` 计算，>30° 视为跟踪错误归零
- 阈值：`HEAD_TILT_THRESHOLD = 5.0°`

**肩部高度差 (shoulder_diff)**：
- 双肩垂直差占肩宽的百分比（距离无关的归一化指标）
- 阈值：`SHOULDER_DIFF_THRESHOLD = 4.0%`

**脊柱倾斜角 (spine_angle)**：
- 肩中点与髋中点连线相对于垂直线的夹角
- 阈值：`SPINE_ANGLE_THRESHOLD = 10.0°`

### 姿态评分算法 (scorer.py)

```python
head_excess   = max(0, head_angle   - 5.0)
shoulder_excess = max(0, shoulder_diff - 4.0)
spine_excess  = max(0, spine_angle  - 10.0)

head_deduction    = min(35, head_excess   * 0.7)
shoulder_deduction = min(25, shoulder_excess * 0.7)
spine_deduction   = min(25, spine_excess  * 0.7)

score = max(20, min(100, round(100 - total_deduction)))
```

评分等级：
- 80-100：姿态良好（绿色）
- 60-79：需要注意（橙色）
- 20-59：姿态异常（红色）

### WebSocket 帧处理流程

1. 前端以 200ms 间隔捕获视频帧 → base64 JPEG → WebSocket 发送
2. 后端解码帧 (OpenCV) → 缩放至 640x480 → RGB 转换
3. MediaPipe Pose 处理 → 提取关键点
4. 指数移动平均 (EMA, α=0.35) 平滑帧间抖动
5. 评分计算 → 返回 JSON 给前端
6. 前端渲染姿态骨架覆盖层 (PostureSkeleton SVG)

---

## 3️⃣ 定时提醒机制

后端调度器 (APScheduler AsyncIOScheduler)：

- 每分钟执行一次 `_minute_tick`
- 累计使用时长写入 `usage_record` 表
- 当累计时长达到 `reminder_interval`（默认 30 分钟）时触发提醒
- 通过 WebSocket 广播 `{"type": "reminder"}` 给所有连接客户端
- 同时 Electron 主进程轮询 `/api/reminder/status`（每 10 秒），检测到 pending 时弹出系统通知

提醒交互：
- **开始活动**：结束当前 break session，跳转到活动页面
- **稍后提醒**：snooze 5 分钟（可自定义 1-60 分钟），`_forced_reminder_at` 延迟触发

---

## 4️⃣ 数据库设计

### 表：usage_record

| 字段 | 类型 | 说明 |
|------|------|------|
| id | INTEGER PK AUTOINCREMENT | 主键 |
| date | TEXT NOT NULL UNIQUE | 日期 (YYYY-MM-DD) |
| usage_minutes | INTEGER DEFAULT 0 | 当日使用时长（分钟）|
| break_count | INTEGER DEFAULT 0 | 当日活动次数 |

### 表：posture_score

| 字段 | 类型 | 说明 |
|------|------|------|
| id | INTEGER PK AUTOINCREMENT | 主键 |
| timestamp | TEXT NOT NULL | ISO 8601 时间戳 |
| head_angle | REAL NOT NULL | 头部侧倾角 |
| shoulder_diff | REAL NOT NULL | 肩部高度差百分比 |
| spine_angle | REAL NOT NULL | 脊柱倾斜角 |
| score | INTEGER NOT NULL | 姿态评分 (20-100) |

### 表：activity_log

| 字段 | 类型 | 说明 |
|------|------|------|
| id | INTEGER PK AUTOINCREMENT | 主键 |
| timestamp | TEXT NOT NULL | 活动完成时间 |
| activity_type | TEXT DEFAULT 'exercise' | 活动类型 |
| exercise_count | INTEGER DEFAULT 0 | 动作数量 |
| duration_sec | INTEGER DEFAULT 0 | 活动时长（秒）|
| avg_score | INTEGER DEFAULT 0 | 活动期间平均姿态评分 |

### 表：settings

| 字段 | 类型 | 说明 |
|------|------|------|
| key | TEXT PK | 设置键名 |
| value | TEXT NOT NULL | 设置值 |

默认设置：
- `reminder_interval` = '30'
- `ai_enabled` = 'false'
- `auto_start` = 'false'
- `voice_enabled` = 'true'

---

## 5️⃣ 周报统计

`/api/stats/weekly` 返回：

| 字段 | 说明 |
|------|------|
| posture_avg | 近 7 天平均姿态评分 |
| weekly_activities | 近 7 天活动次数 |
| total_exercise_sec | 近 7 天运动总时长（秒）|
| total_minutes | 近 7 天使用总时长（分钟）|
| total_breaks | 近 7 天 break 次数 |
| completion_rate | 活动完成率（实际活动 / 期望活动 × 100%）|
| trend | 每日平均评分趋势数组 |

---

## 6️⃣ UI 设计规范

风格：
- 健康绿色 (#4CAF50) + 柔和蓝色 (#2196F3)
- 动态呼吸圈动画（ExercisePanel 倒计时 SVG 圆环）
- 实时姿态骨骼线覆盖（PostureSkeleton SVG）
- 评分实时仪表盘（ScoreGauge SVG 圆环）
- 毛玻璃效果指标浮层（MetricBadge backdrop-filter）

动画：
- Framer Motion（页面过渡、弹窗动画、开关滑动）
- CSS 旋转加载动画
- SVG stroke-dashoffset 倒计时动画

页面路由（HashRouter）：
- `/` → NeckActivity（肩颈活动主页面）
- `/dashboard` → Dashboard（仪表盘统计）
- `/settings` → Settings（系统设置）

---

## 7️⃣ AI 个性化建议

当连续 3 次姿态低于 60 分时触发（实际实现为前端按需调用）：

请求 `/api/ai/suggestion`：
```json
{
  "head_angle": 28,
  "shoulder_diff": 12,
  "spine_angle": 15,
  "history_avg": 55,
  "issues": ["头部明显侧倾", "肩部明显不平衡"]
}
```

逻辑：
1. 若 `AI_ENABLED`（存在 `DEEPSEEK_API_KEY` 环境变量），调用 DeepSeek API
2. DeepSeek 返回个性化建议（100 字以内中文）
3. 若 AI 调用失败或禁用，降级到本地规则建议 (fallback.py)

本地建议库 (fallback.py)：
- 根据检测到的具体问题（头部侧倾/肩部不平衡/脊柱倾斜）返回针对性建议
- 配合通用建议池（10 条，涵盖桌椅调整、显示器位置、拉伸动作等）

语音播报：
- Web Speech API（前端 `speech.ts`）
- 严重姿态问题实时语音提醒
- 活动开始/完成语音引导

---

## 8️⃣ 安全与隐私

- 摄像头画面绝不上传（仅通过本地 WebSocket 传输至本地 Python 服务）
- 仅姿态数值可发送 AI（不包含任何图像数据）
- 所有数据本地 SQLite（`data/neckguardian.db`）
- 可关闭联网增强模式（设置中切换 `ai_enabled`）

---

# API 设计

## REST API 列表

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | /api/health | 健康检查 |
| POST | /api/posture/record | 记录姿态评分 |
| GET | /api/posture/history | 获取姿态历史 |
| GET | /api/posture/average | 获取平均评分 |
| GET | /api/posture/trend | 获取评分趋势 |
| GET | /api/stats/weekly | 周报统计 |
| GET | /api/stats/summary | 今日摘要 |
| GET | /api/settings | 获取所有设置 |
| GET | /api/settings/{key} | 获取单个设置 |
| PUT | /api/settings | 更新设置 |
| POST | /api/ai/suggestion | 获取 AI 建议 |
| POST | /api/activity/record | 记录活动 |
| GET | /api/activity/recent | 最近活动 |
| GET | /api/activity/today-count | 今日活动数 |
| POST | /api/reminder/end | 结束 break session |
| POST | /api/reminder/snooze | 延迟提醒 |
| GET | /api/reminder/status | 获取提醒状态 |

## WebSocket API

| 消息类型 | 方向 | 说明 |
|----------|------|------|
| `{"type": "frame", "data": "base64..."}` | Client → Server | 发送摄像头帧 |
| `{"type": "pose", ...}` | Server → Client | 姿态检测结果 |
| `{"type": "no_pose"}` | Server → Client | 未检测到人体 |
| `{"type": "reminder"}` | Server → Client | 提醒触发 |
| `{"type": "ping"}` | Client → Server | 心跳 |
| `{"type": "pong"}` | Server → Client | 心跳响应 |

---

# Electron 主进程设计

### 职责

1. **Python 后端管理**：`startPythonBackend()` spawn Python 进程，异常退出后 3 秒自动重启
2. **后端就绪检测**：`waitForBackend()` 轮询 `/api/health`，就绪后通知渲染进程
3. **系统托盘**：最小化到托盘，双击/右键菜单恢复窗口
4. **提醒轮询**：每 10 秒轮询提醒状态，触发系统通知 (Notification)
5. **IPC 通道**：
   - `get-backend-url` → 返回后端地址
   - `minimize-to-tray` → 隐藏窗口
   - `get-app-version` → 返回应用版本
   - `setAutoStart` → 设置开机自启动（需实现）
   - `backend-ready` → 后端就绪事件
   - `start-exercise` → 托盘菜单触发活动
   - `reminder-trigger` → 提醒触发事件

### 窗口行为

- 关闭按钮 → 最小化到托盘（不退出）
- 托盘右键 → 显示主窗口 / 开始活动 / 退出
- 最小尺寸：900×600

---

# 错误兜底逻辑

1. **摄像头不可用** → 显示手动重试按钮 + 错误提示
2. **MediaPipe 加载失败** → WebSocket 返回 `{"type": "error"}`，前端显示错误状态
3. **AI 调用失败** → 自动降级到 `fallback.py` 本地规则建议
4. **Python 服务异常退出** → Electron 主进程 3 秒后自动重启
5. **后端未就绪** → 前端 5 秒超时后强制继续（降级模式）

---

# 日志规范

日志配置 (`main.py`)：
```python
logging.basicConfig(
    level=logging.DEBUG,
    format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
    handlers=[logging.StreamHandler()],
)
```

| 级别 | 使用场景 | 示例 |
|------|----------|------|
| INFO | 启动流程、状态变更 | "NeckGuardian backend starting..." |
| WARN | 姿态轻微异常、配置加载失败 | "Failed to load reminder_interval" |
| ERROR | 摄像头失败、服务异常 | "Pose processing error" |
| DEBUG | 姿态原始角度数据 | "Pose score=85 head=3.2°..." |

---

# Acceptance Criteria (AC)

### AC-1 启动检测

- 应用启动 5 秒内完成初始化
- 摄像头成功打开
- 显示姿态骨架

### AC-2 姿态识别准确

- 驼背识别准确率 > 85%
- 肩部倾斜识别准确

### AC-3 定时提醒

- 每 30 分钟 ± 1 分钟误差提醒
- 支持用户自定义时间（15/30/45/60 分钟）

### AC-4 数据持久化

- 重启后数据完整
- 周报正确生成

### AC-5 离线运行

- 无网络可完整使用
- AI 功能自动降级

### AC-6 性能

- CPU 占用 < 20%
- 内存 < 300MB

---

# 项目目录结构

```
HealthyDesk/
├── backend/                    # Python FastAPI 后端
│   ├── api/                    # REST API 路由
│   │   ├── __init__.py
│   │   ├── activity.py         # 活动记录 API
│   │   ├── ai.py              # AI 建议 API
│   │   ├── posture.py         # 姿态数据 API
│   │   ├── reminder.py        # 提醒控制 API
│   │   ├── settings.py        # 设置管理 API
│   │   └── stats.py           # 统计报表 API
│   ├── db/
│   │   ├── __init__.py
│   │   └── database.py        # SQLite 异步数据库
│   ├── services/              # 核心业务逻辑
│   │   ├── __init__.py
│   │   ├── ai_advisor.py      # DeepSeek AI 调用
│   │   ├── fallback.py        # 本地建议降级
│   │   ├── pose_detector.py   # MediaPipe 姿态检测
│   │   ├── scheduler.py       # APScheduler 定时调度
│   │   └── scorer.py          # 姿态评分算法
│   ├── ws/
│   │   ├── __init__.py
│   │   └── camera_ws.py       # WebSocket 摄像头处理
│   ├── config.py              # 全局配置常量
│   ├── main.py                # FastAPI 入口
│   └── requirements.txt       # Python 依赖
├── electron/                  # Electron 主进程
│   ├── main.ts                # 主进程入口
│   ├── main.js                # 编译后 JS
│   ├── preload.ts             # 预加载脚本
│   └── preload.js             # 编译后 JS
├── src/                       # React 前端源码
│   ├── components/            # 可复用组件
│   │   ├── BreathingCircle.tsx
│   │   ├── ExercisePanel.tsx  # 活动引导面板
│   │   ├── PostureSkeleton.tsx # 姿态骨架 SVG
│   │   ├── ScoreGauge.tsx     # 评分仪表盘
│   │   ├── Sidebar.tsx        # 侧边导航
│   │   └── TrendChart.tsx     # 趋势图表
│   ├── hooks/                 # 自定义 Hooks
│   │   ├── useApi.ts          # HTTP API 封装
│   │   └── useWebSocket.ts    # WebSocket 封装
│   ├── pages/                 # 页面组件
│   │   ├── Dashboard.tsx      # 仪表盘
│   │   ├── NeckActivity.tsx   # 肩颈活动主页面
│   │   └── Settings.tsx       # 系统设置
│   ├── utils/
│   │   └── speech.ts          # 语音播报
│   ├── App.tsx                # 根组件 + 路由
│   ├── index.css              # 全局样式
│   ├── main.tsx               # 前端入口
│   └── types.ts               # TypeScript 类型定义
├── public/                    # 静态资源
│   ├── icon.png
│   └── tray-icon.png
├── scripts/                   # 辅助脚本
│   ├── install.bat
│   └── start.bat
├── data/                      # 运行时数据目录（自动创建）
│   └── neckguardian.db        # SQLite 数据库
├── doc.md                     # 本文档
├── package.json               # Node.js 依赖与脚本
├── tsconfig.json              # TypeScript 配置
├── vite.config.ts             # Vite 配置
├── electron-builder.yml       # 打包配置
└── index.html                 # HTML 模板
```

---

# 代码输出要求

必须输出：

* Electron 主进程代码 (electron/main.ts)
* React 页面代码 (src/pages/*.tsx)
* MediaPipe 集成代码 (backend/services/pose_detector.py)
* Python FastAPI 代码 (backend/main.py, backend/api/*.py)
* SQLite 初始化脚本 (backend/db/database.py)
* 定时任务实现 (backend/services/scheduler.py)
* AI 调用封装 (backend/services/ai_advisor.py)
* 语音播报实现 (src/utils/speech.ts)
* 完整 package.json
* 完整 requirements.txt

---

# 输出格式要求

1. 先输出完整项目目录
2. 开发中可 Firecrawl、Context7 联网搜索技术用法，再逐文件输出完整代码
3. 不允许省略核心逻辑
4. 不允许使用伪代码
5. 必须可运行，必须生成完整可运行的代码，每步完成后必须自主测试验证

---

# 目标

1. 自主完成环境配置安装，生成一个可以 `npm run dev` `npm run python:start` `scripts\start.bat`测试项目的完整工程。
2. 能打包生成可执行软件

---
