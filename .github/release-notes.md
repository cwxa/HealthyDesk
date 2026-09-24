摄像头看着你的坐姿，实时打分，到点提醒你起来活动。**画面只在本机处理，不上传。**

## ⬇️ 下载

| 系统 | 文件 | 说明 |
|---|---|---|
| 🖥️ Windows 10/11 | `NeckGuardian.Setup.<版本>.exe` | 双击安装，**无需预装 Python** |
| 🍎 macOS（Apple 芯片 M1~M4） | `NeckGuardian-<版本>-mac-arm64.dmg` | 拖进「应用程序」。**未签名**，首次要右键 →「打开」（见下） |
| 🍎 macOS（Intel 芯片） | `NeckGuardian-<版本>-mac-x64.dmg` | 同上 |
| 📱 Android 8.0+ | `NeckGuardian-Android-<版本>.apk` | 需允许「安装未知来源应用」 |
| 📱 iPhone / iPad | `NeckGuardian.xcarchive.tgz` | **不是安装包**，普通用户装不上（见下） |

- 安装包已内置推理后端，**不需要另外装 Python、也不需要联网**
- 手机端推理完全在设备本地完成，**摄像头画面不出设备**

## 🔐 校验下载完整性（可选）

```bash
sha256sum -c SHA256SUMS.txt                                       # macOS / Linux
Get-FileHash .\NeckGuardian.Setup.<版本>.exe -Algorithm SHA256    # Windows PowerShell
```

## 🍎 macOS 首次打开（包未签名）

本包没有做 Apple 签名与公证，直接双击会提示「无法验证开发者」或「已损坏」。两种解法，**只需做一次**：

- 在「应用程序」里 **右键 →「打开」**，弹窗里再点一次「打开」；或
- 终端执行：`xattr -dr com.apple.quarantine /Applications/NeckGuardian.app`

## 📱 为什么 iPhone 装不了

iOS 应用必须由 Apple 开发者证书签名才能装到设备上，本项目没有配。
这个 `.xcarchive` 是**开发者归档** —— 需要自备 Mac + Xcode + Apple 开发者账号重签名后才能安装，
普通用户直接装不了。Android 不受影响。

## 💻 系统要求

- Windows 10 1809+ ／ macOS 10.15+ ／ Android 8.0+（API 26）
- 需要摄像头权限。**画面只在本机处理，不会上传**

## ⚠️ 已知限制

- **手机端切后台或锁屏后，检测与提醒会暂停**（系统会冻结后台页面），保持 App 在前台即可
- **macOS 与 iOS 产物尚未做真机验证**：CI 已自动验过"能构建 + 包内容完整 + 内置后端能在 Mac 上跑起来"，
  但**窗口界面与摄像头效果还没有人在真机上实际跑过**。遇到问题欢迎提 Issue
- 中低端手机推理帧率较低（GPU 不可用时自动回退 CPU）

<!--
============================================================
以下为发布者自查项。GitHub 会隐藏 HTML 注释，不会出现在 Release 正文里。
（写作时请保持本注释以下的正文是"给下载者看的"）
============================================================

🔴 发布前必查：
1. 本 Release 各端产物**是否都做过真机验证**？CI 只证明"可编译、可打包"，不等于"真机跑通"。
   没验过的端，要么别发，要么在正文"已知限制"里如实标注。
2. Android 正式包是否由 CI 签名产出（`ANDROID_*` secrets，2026-09-23 起已配置）？
   缺 secrets 时 CI 只出 debug 包，CD 会自动剔除（不可分发），需本机
   `npm run cap:build:release` 出包后 `gh release upload <tag> <apk> --clobber` 补传。
3. 完整清单见 docs/MULTIPLATFORM.md §9（发布前验证清单）。
-->
