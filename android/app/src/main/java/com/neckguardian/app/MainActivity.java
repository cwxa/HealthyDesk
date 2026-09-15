package com.neckguardian.app;

import android.Manifest;
import android.content.pm.PackageManager;
import android.os.Build;
import android.os.Bundle;
import android.util.Log;
import android.webkit.JavascriptInterface;
import android.webkit.PermissionRequest;
import android.webkit.WebChromeClient;
import android.webkit.WebView;

import androidx.core.app.ActivityCompat;
import androidx.core.content.ContextCompat;

import com.getcapacitor.BridgeActivity;

import java.util.ArrayList;
import java.util.Arrays;
import java.util.List;

/**
 * NeckGuardian 安卓入口。
 *
 * ⚠️ Capacitor 默认的 WebView 会**拒绝**网页的 getUserMedia（摄像头）请求，
 * 因此必须覆写 WebChromeClient.onPermissionRequest。
 *
 * 这里有三个容易踩的坑，都会表现为「允许了权限但摄像头打不开」：
 *
 * 1. **授权必须同步**：如果先把 PermissionRequest 存起来、等用户点完系统权限对话框
 *    再 grant()，这个对象在等待期间可能已经被 WebView 释放，grant() 变成空操作，
 *    前端 getUserMedia 直接 reject 或永久挂起。所以只要已经持有系统权限，
 *    就**在回调内立即 grant()**；权限尚未持有的情况改为在 App 启动阶段预先申请。
 *
 * 2. **预申请权限**：启动时就把 CAMERA 权限要到手，用户打开「肩颈活动」时权限已就绪，
 *    取流一步到位，不再出现「对话框夹在 getUserMedia 中间」的竞态。
 *
 * 3. **并发请求**：dev 模式下 React StrictMode 会双挂载、用户点「重试」也会再次取流，
 *    WebView 可能同时抛出多个 PermissionRequest。用列表而非单个变量保存，避免漏掉。
 */
public class MainActivity extends BridgeActivity {

    private static final String TAG = "NeckGuardian";
    private static final int CAMERA_PERMISSION_CODE = 1001;

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

        webView.setWebChromeClient(new WebChromeClient() {
            @Override
            public void onPermissionRequest(final PermissionRequest request) {
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
        });

        // 启动即预申请，消除「对话框夹在 getUserMedia 中间」的竞态。
        requestCameraPermission();
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
