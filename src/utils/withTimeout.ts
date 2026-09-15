/**
 * 给 Promise 加超时。
 *
 * 摄像头链路最怕的就是"永久 pending"：WebView 的 `onPermissionRequest` 既没 grant 也没 deny、
 * 或 `video.play()` 一直不 resolve，界面就会无限停在「正在启动摄像头...」。
 * 加上超时后退化成一条可展示的错误，至少知道断在哪。
 *
 * 超时抛出的错误 `name` 固定为 `'TimeoutError'`，便于上层区分处理。
 */
export function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      const err = new Error(`${label}超时（${Math.round(ms / 1000)} 秒未响应）`)
      err.name = 'TimeoutError'
      reject(err)
    }, ms)
    promise.then(
      (value) => {
        clearTimeout(timer)
        resolve(value)
      },
      (err) => {
        clearTimeout(timer)
        reject(err)
      }
    )
  })
}
