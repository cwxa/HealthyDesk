import { isMobile, supports } from './runtime'
import { EXERCISE_COUNT, TOTAL_DURATION_SEC } from '../data/exercises'

/**
 * 新手引导：**「这台设备上看过没有」的标志 + 四步内容**。
 *
 * 组件在 `components/Onboarding.tsx`，触发与协调在 `App.tsx`。
 * 这里只放"唯一真相来源"：判定逻辑与文案数据，方便被守卫直接引用对拍。
 *
 * ## 标志为什么存 localStorage，而不是走 `dataLayer` 的设置表
 *
 * 项目里"用户的设置"统一走设置表（桌面 SQLite / 移动 IndexedDB），但这一条**不是设置**：
 *
 * 1. 它描述的是「**这台设备**上这份界面有没有被讲解过」，不是用户偏好。
 *    放进设置表会带来两个非预期行为：
 *    - 导出备份 → 导入到新设备，会把"已看过"一起带过去，**新设备上第一次打开反而没有引导**；
 *    - 「清除健康数据」只清数据表、设置保留 —— 语义上说得通，但客户支持时很难解释
 *      "为什么清了数据引导也不回来"。
 * 2. 读设置表是**异步且依赖后端 / IndexedDB 就绪**的；而引导判定必须发生在
 *    **启动闸门放行的同一帧**，否则会先闪一下主界面再盖上来。`localStorage` 同步可读。
 *
 * 代价（如实记下）：`localStorage` 按**浏览器 profile** 隔离，于是
 * 「重装应用 / 换设备 / 清空站点数据 / 换用另一个系统账户」之后会**再看一次**引导。
 * 对新手引导而言这是可接受、甚至更正确的行为（新设备确实需要重新讲一遍），
 * 但它**不是**"每个用户只看到一次"，别把这句话写进对外文档。
 */

/**
 * 引导内容的版本号。
 *
 * 增删步骤、改动文案后 **+1** —— 老用户会再看一次新版引导（这正是 `>=` 比较的用途）。
 * ⚠️ 不要为了"提醒用户升级了"而随手 bump：本引导的定位是**上手说明**，不是更新公告。
 */
export const ONBOARDING_VERSION = 1

/** localStorage 键。与 `App.tsx` 里 `neckguardian:start-exercise` 同一命名空间。 */
export const ONBOARDING_KEY = 'neckguardian:onboarding'

/**
 * 是否已看过**当前版本**的引导。
 *
 * 🔴 读失败（隐私模式、存储被禁、值不是数字）一律当「没看过」——
 * 理由是两种误判的代价不对称：多讲一遍只是多一次点击，而
 * 「本该看到却看不到」会让第一次打开的人不知道该怎么用，且**无从反馈**。
 */
export function isOnboardingDone(): boolean {
  try {
    const seen = Number(localStorage.getItem(ONBOARDING_KEY))
    return Number.isFinite(seen) && seen >= ONBOARDING_VERSION
  } catch {
    return false
  }
}

/**
 * 记下「已看过」。
 *
 * 写入失败**只能吞掉**（隐私模式 / 配额满）：最坏结果是下次启动再讲一遍，
 * 不影响可用性 —— 所以这里不弹错误、不阻塞流程。别改成抛异常。
 */
export function markOnboardingDone(): void {
  try {
    localStorage.setItem(ONBOARDING_KEY, String(ONBOARDING_VERSION))
  } catch {
    /* 见上：静默 */
  }
}

/** 仅测试用：清掉标志，让下次判定回到「没看过」（UI 冒烟与新用户路径都靠它）。 */
export function resetOnboarding(): void {
  try {
    localStorage.removeItem(ONBOARDING_KEY)
  } catch {
    /* 忽略 */
  }
}

/** 引导的一步。 */
export interface OnboardingStep {
  /** 大图标（emoji —— 与项目其余部分一致，不引入图片资源）。 */
  icon: string
  title: string
  /** 正文段落，逐段渲染。 */
  lines: string[]
  /** 该步强调色（用于图标底、进度点、主按钮）。 */
  accent: string
}

/** 整场活动的近似分钟数（由数据派生，别在文案里硬编码）。 */
function approxMinutes(): number {
  return Math.max(1, Math.round(TOTAL_DURATION_SEC / 60))
}

/**
 * 四步引导内容。
 *
 * 🔴 **平台差异只能来自能力矩阵**（`supports(...)`），不许写 `platform === 'android'`
 * 这类判断 —— 与其余业务代码同一条铁律（见 `runtime.ts` 顶部注释）。
 * 🔴 **不写动作名**：那是 `src/data/exercises.ts` 的专属权利，`verify:exercises`
 * 会递归扫 `src/**` 找违规。动作数量与时长一律从数据模块取，以后扩库时引导自动跟上。
 */
export function onboardingSteps(): OnboardingStep[] {
  const minutes = approxMinutes()

  // 第 4 步的平台差异：桌面端有托盘与自启，手机端都没有。
  // 手机上如实说明"不常驻后台"——安卓 WebView 被系统冻结时提醒不会响，
  // 这是已知取舍（见 ROADMAP 未实现项），引导里不许把它说成"随时都能提醒你"。
  const reminderLines = [
    '按你设置的间隔，它会提醒你起来活动一下；间隔和开关都在「系统设置」里。',
  ]
  if (supports('systemTray')) {
    reminderLines.push('关掉窗口不会退出 —— 它会缩到系统托盘继续计时。')
  } else {
    reminderLines.push('应用不在前台时它不会常驻后台，所以提醒要等你回到应用里才看得到。')
  }
  if (supports('autoStart')) {
    reminderLines.push('也可以在设置里打开开机自启，从此不用手动启动。')
  }

  return [
    {
      icon: '👋',
      title: '欢迎使用 NeckGuardian',
      lines: [
        '它会通过摄像头看着你的坐姿：颈肩一歪，分数就会往下掉，并提醒你起来活动一下。',
        '所有数据都只存在这台设备上。',
      ],
      accent: '#4CAF50',
    },
    {
      icon: '📷',
      title: '先让摄像头看见你',
      lines: [
        // 形态差异（手机架在面前 / 摄像头对准自己）走 `isMobile()` ——
        // ⚠️ 别拿 `supports('localInference')` 顶替：它在 `web`（桌面浏览器调试）也是 true，
        //    于是桌面浏览器里会显示"把手机架在面前"。
        isMobile()
          ? '把手机架在面前，让头和两侧肩膀都落在画面里。'
          : '把摄像头对准自己，让头和两侧肩膀都落在画面里。',
        '画面里出现绿色骨骼之后，姿势评分就开始实时更新了。',
        '第一次会弹系统的摄像头权限请求，允许即可 —— 画面只在本地处理，不会上传。',
      ],
      accent: '#2196F3',
    },
    {
      icon: '🧘',
      title: '跟着做，然后看记录',
      lines: [
        `点「开始活动」，跟着画面做 ${EXERCISE_COUNT} 个颈肩动作，大约 ${minutes} 分钟。`,
        '做完在「仪表盘」里能看到这次每个动作各自的得分，以及肩颈健康的长期趋势。',
      ],
      accent: '#FF9800',
    },
    {
      icon: '🔔',
      title: '别一直不动',
      lines: reminderLines,
      accent: '#9C27B0',
    },
  ]
}
