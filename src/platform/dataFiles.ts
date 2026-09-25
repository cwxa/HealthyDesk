/**
 * 数据文件的**存取通道**（导出 / 导入用）。
 *
 * 为什么单独一层：三端把文件交到用户手里的路径完全不同 ——
 * 桌面（Electron）走 `<a download>`，Chromium 会弹系统"另存为"对话框；
 * 移动端（Capacitor WebView）**没有下载能力**（宿主没设 DownloadListener，
 * `<a download>` 会被静默忽略，用户点了像没反应），必须走系统分享面板。
 * 业务侧只该关心"存成文件"与"读一个文件"，不该关心这些差异。
 *
 * ⚠️ 移动端的分享通道**未经真机验证**（本轮只验证了桌面端与逻辑层）。
 * 分享不可用时会自动退回落盘 —— 退路是有的，但安卓上要回归一遍。
 */

import { isMobile } from './runtime'

export interface SaveOutcome {
  /** 是否已把文件交到用户手里（用户在分享面板/保存对话框里取消时为 false）。 */
  saved: boolean
  /** 实际走通的通道，用于界面提示与排错。 */
  via: 'share' | 'download'
  /** 用户主动取消 —— 这不是错误，不该弹红色提示。 */
  cancelled: boolean
}

function isCancelled(e: unknown): boolean {
  return e instanceof Error && (e.name === 'AbortError' || e.name === 'NotAllowedError')
}

/** 把文本存成文件，优先走系统级通道。 */
export async function saveTextFile(
  filename: string,
  text: string,
  mime = 'application/json',
): Promise<SaveOutcome> {
  if (isMobile() && typeof navigator.share === 'function') {
    try {
      const file = new File([text], filename, { type: mime })
      if (navigator.canShare?.({ files: [file] })) {
        await navigator.share({ files: [file], title: filename })
        return { saved: true, via: 'share', cancelled: false }
      }
    } catch (e) {
      if (isCancelled(e)) return { saved: false, via: 'share', cancelled: true }
      // 部分 WebView 未实现 Web Share（或 canShare 对 files 总返回 false）：
      // 退回落盘，别让用户拿不到文件。
      console.warn('系统分享不可用，回退到下载：', e)
    }
  }

  const blob = new Blob([text], { type: mime })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  a.style.display = 'none'
  document.body.appendChild(a)
  a.click()
  a.remove()
  // 立刻 revoke 会让部分浏览器来不及读取数据；延后释放即可。
  setTimeout(() => URL.revokeObjectURL(url), 10_000)
  return { saved: true, via: 'download', cancelled: false }
}

/**
 * 让用户挑一个文件读成文本。用户取消返回 `null`。
 *
 * 走原生 `<input type="file">`：这是三端都支持的唯一入口
 * （安卓侧由 `MainActivity.CameraChromeClient` 继承的 `onShowFileChooser` 承接）。
 */
export function pickTextFile(
  accept = 'application/json,.json',
): Promise<{ name: string; text: string } | null> {
  return new Promise((resolve, reject) => {
    const input = document.createElement('input')
    input.type = 'file'
    input.accept = accept
    input.style.display = 'none'
    document.body.appendChild(input)

    let settled = false
    const finish = (fn: () => void) => {
      if (settled) return
      settled = true
      input.remove()
      fn()
    }

    input.addEventListener('change', () => {
      const file = input.files?.[0]
      if (!file) return finish(() => resolve(null))
      const reader = new FileReader()
      reader.onload = () =>
        finish(() => resolve({ name: file.name, text: String(reader.result ?? '') }))
      reader.onerror = () => finish(() => reject(reader.error ?? new Error('读取文件失败')))
      reader.readAsText(file)
    })
    // 现代浏览器在对话框取消时会派发 cancel；老 WebView 不发，change 分支也会兜底。
    input.addEventListener('cancel', () => finish(() => resolve(null)))
    input.click()
  })
}
