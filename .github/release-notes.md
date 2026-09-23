## 下载

| 平台 | 文件 | 说明 |
|---|---|---|
| Windows 10/11 | `NeckGuardian Setup <版本>.exe` | 双击安装，无需预装 Python |
| macOS（Apple Silicon / M 系列） | `NeckGuardian-<版本>-mac-arm64.dmg` | 拖入「应用程序」 |
| macOS（Intel） | `NeckGuardian-<版本>-mac-x64.dmg` | 拖入「应用程序」 |
| Android | `NeckGuardian-<版本>-android-release.apk` | 需允许「安装未知来源应用」 |
| iOS | `NeckGuardian-<版本>-ios-unsigned.xcarchive.tgz` | **未签名归档，不能直接安装**，仅供开发者 |

下载后用 `SHA256SUMS.txt` 校验完整性：

```bash
sha256sum -c SHA256SUMS.txt
```

> 📌 文件名里带空格的（只有 Windows 那个），GitHub 会把**连续空格压成一个点**，
> 所以实际下载到的是 `NeckGuardian.Setup.<版本>.exe`。
> `SHA256SUMS.txt` 里写的已经是这个改名后的名字，直接校验即可。

## ⚠️ 未签名产物怎么打开

**macOS**：包未签名、未公证，首次打开会被 Gatekeeper 拦下（提示「无法验证开发者」）。
在「应用程序」里 **右键 → 打开**，或执行：

```bash
xattr -dr com.apple.quarantine /Applications/NeckGuardian.app
```

**iOS**：产物是未签名归档，**不能装到设备上**。要出可安装的 IPA 需要 Apple 开发者账号与签名证书。

## 系统要求

- Windows 10 1809+ / macOS 10.15+ / Android 8.0+（API 26）
- 需要摄像头权限。画面**只在本机处理**，不会上传。

## 说明

- 桌面端内置本地推理后端；Android / iOS 端推理完全在设备本地完成。
- Android 的「后台常驻」尚未实现（系统会冻结后台 WebView）。
