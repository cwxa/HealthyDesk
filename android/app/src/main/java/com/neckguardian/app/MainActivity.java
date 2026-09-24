package com.neckguardian.app;

import android.Manifest;
import android.content.pm.PackageManager;
import android.os.Build;
import android.os.Bundle;
import android.util.Log;
import android.webkit.JavascriptInterface;
import android.webkit.PermissionRequest;
import android.webkit.WebView;

import androidx.core.app.ActivityCompat;
import androidx.core.content.ContextCompat;

import com.getcapacitor.Bridge;
import com.getcapacitor.BridgeActivity;
import com.getcapacitor.BridgeWebChromeClient;

import java.util.ArrayList;
import java.util.Arrays;
import java.util.List;

/**
 * NeckGuardian 安卓入口。
 *
 * 原生部分**只做三件事**：摄像头权限桥、只读的诊断通道、以及把 Capacitor 的
 * WebChromeClient 换成一个「只覆写摄像头授权」的子类。**取帧没有任何原生代码**——
 * `getUserMedia` 由 WebView 内置的 Chromium 自己去调 Camera2，MediaPipe 推理全在 JS 层。
 *
 * <h3>为什么必须自己接管 onPermissionRequest</h3>
 *
 * 先纠正一个曾经写错的归因：**Capacitor 的 BridgeWebChromeClient 是会处理摄像头请求的**
 * （把 `android.webkit.resource.VIDEO_CAPTURE` 映射成 CAMERA 权限并放行，见
 * `BridgeWebChromeClient.java:106-131`）。会拒绝 `getUserMedia` 的是**没设
 * WebChromeClient 的裸 WebView**，不是 Capacitor。
 *
 * 真正的问题是它**怎么**处理，有两点：
 *
 * <ol>
 *   <li>`permissionListener` 是**单个可变字段**，被 `onPermissionRequest` /
 *       `onGeolocationPermissionsShowPrompt` / `onShowFileChooser` 共用。并发请求会
 *       互相覆盖回调，**第一个 PermissionRequest 既没 grant 也没 deny**，前端的
 *       `getUserMedia` 就永久挂起。dev 模式 React StrictMode 双挂载、或用户连点「重试」
 *       都会触发并发——这正是 v1.3.2「允许了权限却打不开」的机制。</li>
 *   <li>授权发生在**等系统对话框的异步回调**里，对话框夹在 `getUserMedia` 中间；
 *       WebView 不会超时，用户不点就一直转圈。</li>
 * </ol>
 *
 * 所以本类的做法是：**启动即预申请、持有权限就同步 grant、系统对话框等待期挂看门狗**
 * （对应下面 1/2/3 三点）。
 *
 * <h3>只覆写、不替换</h3>
 *
 * 本类**继承** {@link BridgeWebChromeClient}，而不是早期那样 new 一个裸
 * `WebChromeClient` 把 Capacitor 的整个换掉。换掉会连带丢掉：
 *
 * <table>
 *   <tr><td>{@code onShowFileChooser}</td><td>`&lt;input type="file"&gt;` 静默失灵
 *       （将来做「导入数据」必踩）</td></tr>
 *   <tr><td>{@code onConsoleMessage}</td><td>JS 的 `console.*` 不再进 logcat——
 *       安卓端**唯一**的排查手段</td></tr>
 *   <tr><td>{@code onGeolocationPermissionsShowPrompt}</td><td>定位请求被直接拒绝</td></tr>
 *   <tr><td>{@code onJsAlert/onJsConfirm/onJsPrompt}</td><td>alert/confirm 退回基础实现</td></tr>
 *   <tr><td>{@code onShowCustomView/onHideCustomView}</td><td>视频全屏</td></tr>
 * </table>
 *
 * 前三项当前确未被前端使用（已 grep `type="file"` / `geolocation` / `alert(` 全空），
 * 但它们是**能力**而非当前需求：保留成本为零，丢失成本是将来某个功能在安卓上静默失灵
 * 且极难归因。继承之后，这些职责全部回到 Capacitor，我们也随 Capacitor 升级自动受益。
 *
 * ⚠️ 换 WebChromeClient 必须发生在 `super.onCreate()` **之后**（那时 `getBridge()` 才可用），
 * 且 `BridgeWebChromeClient` 的构造会调 `Bridge.registerForActivityResult`——必须赶在
 * Activity 进入 STARTED 之前，`onCreate` 内满足。
 */
public class MainActivity extends BridgeActivity {

    private static final String TAG = "NeckGuardian";
    private static final int CAMERA_PERMISSION_CODE = 1001;

    /** WebView 权限请求的资源名（摄像头）。 */
    private static final String RESOURCE_VIDEO_CAPTURE = "android.webkit.resource.VIDEO_CAPTURE";

    /** 等待系统权限结果的 WebView 权限请求（可能并发，必须用集合）。 */
    private final List<PermissionRequest> pendingRequests = new ArrayList<>();

    /** 是否已经向系统请求过相机权限（用于区分「还没问过」和「用户选了不再询问」）。 */
    private boolean cameraPermissionAsked = false;

    /** 兜底：WebView 权限请求若长时间无人应答，主动 deny，避免前端 getUserMedia 永久挂起。 */
    private static final long PERMISSION_WATCHDOG_MS = 60000L;
    private final android.os.Handler mainHandler = new android.os.Handler(android.os.Looper.getMainLooper());

    @Override
    public void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);

        WebView webView = getBridge().getWebView();

        // 一个只读的诊断通道，让前端能拿到安卓侧真实的权限状态并展示给用户。
        webView.addJavascriptInterface(new NativeBridge(this), "NeckGuardianNative");

        webView.setWebChromeClient(new CameraChromeClient(getBridge()));

        // 启动即预申请，消除「对话框夹在 getUserMedia 中间」的竞态。
        requestCameraPermission();
    }

    /**
     * 只覆写摄像头授权，其余（文件选择 / JS 对话框 / 定位 / 全屏 / logcat 转发）
     * 全部继承 Capacitor 的实现。
     */
    private class CameraChromeClient extends BridgeWebChromeClient {

        CameraChromeClient(Bridge bridge) {
            super(bridge);
        }

        @Override
        public void onPermissionRequest(final PermissionRequest request) {
            // 只接管「纯摄像头」请求。含音频等其它资源时交回 Capacitor——
            // 它知道该去申请 RECORD_AUDIO / MODIFY_AUDIO_SETTINGS，而我们绝不替用户
            // 放行自己没持有的资源。
            if (!isCameraOnlyRequest(request)) {
                Log.i(TAG, "onPermissionRequest -> delegate to Capacitor: "
                        + Arrays.toString(request.getResources()));
                super.onPermissionRequest(request);
                return;
            }

            Log.i(TAG, "onPermissionRequest origin=" + request.getOrigin()
                    + " resources=" + Arrays.toString(request.getResources()));

            runOnUiThread(() -> {
                if (hasCameraPermission()) {
                    // 关键：持有权限时立即放行，绝不能等到用户点完对话框。
                    Log.i(TAG, "camera permission held -> grant immediately");
                    request.grant(request.getResources());
                } else {
                    Log.i(TAG, "camera permission missing -> ask system, keep request pending");
                    pendingRequests.add(request);
                    armPermissionWatchdog(request);
                    requestCameraPermission();
                }
            });
        }

        @Override
        public void onPermissionRequestCanceled(PermissionRequest request) {
            Log.w(TAG, "onPermissionRequestCanceled");
            pendingRequests.remove(request);
        }
    }

    /** 请求资源是否「全是摄像头」——只有这种才敢自己同步放行。 */
    private static boolean isCameraOnlyRequest(PermissionRequest request) {
        String[] resources = request.getResources();
        if (resources == null || resources.length == 0) return false;
        for (String resource : resources) {
            if (!RESOURCE_VIDEO_CAPTURE.equals(resource)) return false;
        }
        return true;
    }

    private boolean hasCameraPermission() {
        return ContextCompat.checkSelfPermission(this, Manifest.permission.CAMERA)
                == PackageManager.PERMISSION_GRANTED;
    }

    private void requestCameraPermission() {
        if (hasCameraPermission()) {
            Log.i(TAG, "requestCameraPermission: already granted");
            return;
        }
        cameraPermissionAsked = true;
        Log.i(TAG, "requestCameraPermission: requesting CAMERA");
        ActivityCompat.requestPermissions(
                this, new String[]{Manifest.permission.CAMERA}, CAMERA_PERMISSION_CODE);
    }

    /**
     * 相机权限状态（供前端展示准确提示）：
     * granted 已授权 / denied 被拒但可再问 / blocked 不再询问需去系统设置 / unknown 尚未申请。
     */
    private String cameraPermissionState() {
        if (hasCameraPermission()) return "granted";
        if (!cameraPermissionAsked) return "unknown";
        // shouldShowRequestPermissionRationale 为 false 且未授权 => 用户勾了「不再询问」或系统直接拒绝
        return ActivityCompat.shouldShowRequestPermissionRationale(this, Manifest.permission.CAMERA)
                ? "denied"
                : "blocked";
    }

    @Override
    public void onRequestPermissionsResult(int requestCode, String[] permissions, int[] grantResults) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults);
        if (requestCode != CAMERA_PERMISSION_CODE) return;

        boolean granted = grantResults.length > 0
                && grantResults[0] == PackageManager.PERMISSION_GRANTED;
        Log.i(TAG, "onRequestPermissionsResult granted=" + granted
                + " pending=" + pendingRequests.size());

        for (PermissionRequest request : pendingRequests) {
            if (granted) {
                request.grant(request.getResources());
            } else {
                request.deny();
            }
        }
        pendingRequests.clear();

        notifyWebPermissionChanged();
    }

    /**
     * 看门狗：如果系统权限对话框一直没有结果（用户挂着不点、或被 ROM 拦掉），
     * 主动 deny 掉挂起的请求，让前端拿到明确的错误而不是无限转圈。
     */
    private void armPermissionWatchdog(final PermissionRequest request) {
        mainHandler.postDelayed(() -> {
            if (pendingRequests.remove(request)) {
                Log.w(TAG, "watchdog: deny stale PermissionRequest after "
                        + (PERMISSION_WATCHDOG_MS / 1000) + "s");
                request.deny();
            }
        }, PERMISSION_WATCHDOG_MS);
    }

    /** 权限结果回传前端：用户刚授权的瞬间可以自动重新取流，不必手动点「重试」。 */
    private void notifyWebPermissionChanged() {
        final String state = cameraPermissionState();
        runOnUiThread(() -> {
            try {
                WebView webView = getBridge().getWebView();
                if (webView == null) return;
                webView.evaluateJavascript(
                        "window.__ngCameraPermissionChanged &&"
                                + " window.__ngCameraPermissionChanged('" + state + "')",
                        null);
            } catch (Exception e) {
                Log.w(TAG, "notifyWebPermissionChanged failed: " + e.getMessage());
            }
        });
    }

    /**
     * 暴露给前端的只读诊断接口（无任何写操作）。
     * 必须是 public static 类，否则 WebView 的反射拿不到 @JavascriptInterface 方法。
     */
    public static class NativeBridge {
        private final MainActivity activity;

        NativeBridge(MainActivity activity) {
            this.activity = activity;
        }

        @JavascriptInterface
        public String diagnostics() {
            return "{"
                    + "\"cameraPermission\":\"" + activity.cameraPermissionState() + "\","
                    + "\"granted\":" + activity.hasCameraPermission() + ","
                    + "\"version\":\"" + activity.appVersionName() + "\","
                    + "\"versionCode\":" + activity.appVersionCode() + ","
                    + "\"sdk\":" + Build.VERSION.SDK_INT + ","
                    + "\"manufacturer\":\"" + Build.MANUFACTURER + "\","
                    + "\"model\":\"" + Build.MODEL + "\""
                    + "}";
        }
    }

    /** 当前安装包的 versionName（把构建号带到前端，便于确认用户装的是哪一版）。 */
    private String appVersionName() {
        try {
            return getPackageManager().getPackageInfo(getPackageName(), 0).versionName;
        } catch (Exception e) {
            return "unknown";
        }
    }

    private int appVersionCode() {
        try {
            return getPackageManager().getPackageInfo(getPackageName(), 0).versionCode;
        } catch (Exception e) {
            return -1;
        }
    }
}
