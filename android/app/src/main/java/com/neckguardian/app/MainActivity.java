package com.neckguardian.app;

import android.Manifest;
import android.content.pm.PackageManager;
import android.os.Bundle;
import android.webkit.PermissionRequest;
import android.webkit.WebChromeClient;

import androidx.core.app.ActivityCompat;
import androidx.core.content.ContextCompat;

import com.getcapacitor.BridgeActivity;

/**
 * NeckGuardian 安卓入口。
 *
 * ⚠️ 关键：Capacitor 默认的 WebView 会**拒绝**网页的 getUserMedia（摄像头）请求，
 * 表现为前端 `getUserMedia` 直接失败、无法启动姿态检测。
 * 这里覆写 WebChromeClient.onPermissionRequest，把 WebView 的媒体权限请求
 * 映射到系统运行时权限（CAMERA），用户授权后即可正常打开摄像头。
 */
public class MainActivity extends BridgeActivity {

    private static final int CAMERA_PERMISSION_CODE = 1001;
    private PermissionRequest pendingRequest;

    @Override
    public void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);

        getBridge().getWebView().setWebChromeClient(new WebChromeClient() {
            @Override
            public void onPermissionRequest(final PermissionRequest request) {
                runOnUiThread(() -> {
                    boolean hasCamera = ContextCompat.checkSelfPermission(
                            MainActivity.this, Manifest.permission.CAMERA)
                            == PackageManager.PERMISSION_GRANTED;

                    if (hasCamera) {
                        request.grant(request.getResources());
                    } else {
                        pendingRequest = request;
                        ActivityCompat.requestPermissions(
                                MainActivity.this,
                                new String[]{Manifest.permission.CAMERA},
                                CAMERA_PERMISSION_CODE);
                    }
                });
            }
        });
    }

    @Override
    public void onRequestPermissionsResult(int requestCode, String[] permissions, int[] grantResults) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults);
        if (requestCode == CAMERA_PERMISSION_CODE && pendingRequest != null) {
            if (grantResults.length > 0 && grantResults[0] == PackageManager.PERMISSION_GRANTED) {
                pendingRequest.grant(pendingRequest.getResources());
            } else {
                pendingRequest.deny();
            }
            pendingRequest = null;
        }
    }
}
