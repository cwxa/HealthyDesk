package com.neckguardian.app;

import java.util.ArrayList;
import java.util.List;

/**
 * 挂着「等系统权限对话框结果」的 WebView 权限请求队列。
 *
 * <h3>为什么要有这个类</h3>
 *
 * Capacitor 的 {@code BridgeWebChromeClient} 用**单个可变字段** {@code permissionListener}
 * 承接系统权限结果，而它被 {@code onPermissionRequest} / {@code onGeolocationPermissionsShowPrompt}
 * / {@code onShowFileChooser} 三处共用。于是并发请求会互相覆盖回调：
 * **先到的 {@code PermissionRequest} 既没 grant 也没 deny**，前端 {@code getUserMedia}
 * 就永久挂起 —— 这正是 v1.3.2「允许了权限却打不开」的机制。
 * dev 模式 React StrictMode 双挂载、或用户连点「重试」都会触发并发。
 *
 * <h3>这个类怎么解决</h3>
 *
 * 把「挂起中的请求」从**单个字段**换成**集合**，并且每个请求**恰好被应答一次**
 * （grant / deny / cancel 三者互斥）。这样并发多少个请求都不会互相顶掉。
 *
 * <h3>为什么单独成文件（而不是写在 MainActivity 里）</h3>
 *
 * 本类**不 import 任何 {@code android.*}**，是纯 JVM 逻辑，因此可以用
 * {@code ./gradlew :app:testDebugUnitTest} 直接跑单元测试覆盖 ——
 * 「并发下会不会漏应答」这件事过去**只能真机复现**（浏览器的 dialog 行为不同、
 * 模拟器也没有 ROM 的权限交互），现在由 {@code CameraPermissionQueueTest} 兜住。
 *
 * <h3>key 的语义</h3>
 *
 * {@link #cancel(Object)} 与 {@link #denyIfPending(Object)} 按 **{@code equals}** 定位。
 * 生产环境传入的是 {@code android.webkit.PermissionRequest}，它没有覆写 {@code equals}
 * ⇒ 是 identity 语义，正是我们要的「同一个请求对象」。测试里可用任意类型作 key。
 *
 * @param <K> 请求的同一性标识（生产环境为 {@code PermissionRequest}）
 */
public final class CameraPermissionQueue<K> {

    /** 一个等待系统权限结果的挂起请求。 */
    public interface Pending<K> {
        /** 系统授予权限。 */
        void grant();

        /** 系统拒绝权限（或看门狗判定超时）。 */
        void deny();

        /** 同一性标识，供 {@link #cancel(Object)} / {@link #denyIfPending(Object)} 定位。 */
        K key();
    }

    private final List<Pending<K>> pending = new ArrayList<>();

    /** 加入一个等待系统对话框结果的请求。 */
    public void add(Pending<K> request) {
        pending.add(request);
    }

    /**
     * WebView 主动取消（页面导航、重新取流等）—— 移除且**不应答**。
     *
     * @return true 表示它确实还在挂起、已被移除；false 表示它已被应答过（幂等）
     */
    public boolean cancel(K key) {
        return removeByKey(key) != null;
    }

    /**
     * 系统权限对话框返回：{@code granted} 为真放行全部挂起请求，否则全部拒绝。
     *
     * <p>先取快照、再清空、最后逐个应答 —— 这样即便某个应答回调**重入**本队列
     * （例如 grant 之后前端立刻重新发起取流），新加入的请求也不会被这次应答带出去，
     * 更不会抛 {@code ConcurrentModificationException}。
     *
     * @return 本次被应答的请求数
     */
    public int resolveAll(boolean granted) {
        if (pending.isEmpty()) return 0;
        final List<Pending<K>> answered = new ArrayList<>(pending);
        pending.clear();
        for (Pending<K> request : answered) {
            if (granted) {
                request.grant();
            } else {
                request.deny();
            }
        }
        return answered.size();
    }

    /**
     * 看门狗：若该请求仍在挂起，移除并拒绝它。
     *
     * <p>用户把系统对话框挂着不点、或被 ROM 拦掉时，这是避免前端永久转圈的最后一道兜底。
     *
     * @return true 表示确实拒绝了（它仍在挂起）；false 表示它已被应答过（幂等，不会重复 deny）
     */
    public boolean denyIfPending(K key) {
        final Pending<K> request = removeByKey(key);
        if (request == null) return false;
        request.deny();
        return true;
    }

    /** 仍在挂起的请求数（供日志）。 */
    public int size() {
        return pending.size();
    }

    /** 是否没有挂起请求。 */
    public boolean isEmpty() {
        return pending.isEmpty();
    }

    private Pending<K> removeByKey(K key) {
        final int n = pending.size();
        for (int i = 0; i < n; i++) {
            final Pending<K> request = pending.get(i);
            if (request.key() == key || (key != null && key.equals(request.key()))) {
                return pending.remove(i);
            }
        }
        return null;
    }
}
