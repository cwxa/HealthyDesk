package com.neckguardian.app;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import org.junit.Test;

import java.util.ArrayList;
import java.util.List;

/**
 * {@link CameraPermissionQueue} 的单元测试。
 *
 * <h3>这个测试在替代什么</h3>
 *
 * 「拒绝权限 → 关掉应用 → 重新打开 → 允许」这条路径过去被列为**必须真机走**的
 * 验证项，理由是：Capacitor 的 {@code permissionListener} 是单个共享字段，
 * 并发请求会互相覆盖，导致先到的请求既没 grant 也没 deny、前端永久挂起
 * （v1.3.2「允许了权限却打不开」）。浏览器的权限对话框行为与 ROM 不同、模拟器
 * 也复现不了这套交互，所以当时只能靠真机。
 *
 * 把「挂起请求的收纳」抽成不依赖 Android 框架的纯逻辑之后，这个缺陷**可以被
 * 单元测试直接压住** —— 见 {@link #concurrentRequestsAllGetAnswered()}。
 *
 * <h3>断言口径</h3>
 *
 * 每个用例断言**具体的应答次数**，而不是「没抛异常」。否则「用集合」这个关键
 * 设计一旦被改回「用单个字段」，测试仍会因为「至少有一个被应答了」而变绿。
 */
public class CameraPermissionQueueTest {

    /** 记录自己被 grant / deny 了几次的假请求。 */
    private static final class FakeRequest implements CameraPermissionQueue.Pending<String> {
        private final String key;
        int grants;
        int denies;

        FakeRequest(String key) {
            this.key = key;
        }

        @Override
        public void grant() {
            grants++;
        }

        @Override
        public void deny() {
            denies++;
        }

        @Override
        public String key() {
            return key;
        }

        /** 「被应答且仅被应答一次」——本测试的核心不变式。 */
        void assertAnsweredExactlyOnce() {
            assertEquals("应答总次数必须恰好为 1（grant " + grants + " + deny " + denies + "）",
                    1, grants + denies);
        }

        void assertNeverAnswered() {
            assertEquals("不应被 grant", 0, grants);
            assertEquals("不应被 deny", 0, denies);
        }
    }

    // ── resolveAll ───────────────────────────────────────────────────────────

    @Test
    public void resolveAllGrantAnswersEveryPendingExactlyOnce() {
        CameraPermissionQueue<String> queue = new CameraPermissionQueue<>();
        FakeRequest a = new FakeRequest("a");
        FakeRequest b = new FakeRequest("b");
        queue.add(a);
        queue.add(b);

        int answered = queue.resolveAll(true);

        assertEquals("两个挂起请求都应被应答", 2, answered);
        assertEquals("a 被放行一次", 1, a.grants);
        assertEquals("b 被放行一次", 1, b.grants);
        assertTrue("应答后队列必须清空", queue.isEmpty());
    }

    @Test
    public void resolveAllDenyRejectsEveryPendingExactlyOnce() {
        CameraPermissionQueue<String> queue = new CameraPermissionQueue<>();
        FakeRequest a = new FakeRequest("a");
        FakeRequest b = new FakeRequest("b");
        queue.add(a);
        queue.add(b);

        int answered = queue.resolveAll(false);

        assertEquals(2, answered);
        assertEquals("a 被拒绝一次", 1, a.denies);
        assertEquals("b 被拒绝一次", 1, b.denies);
        assertEquals("拒绝路径不应产出 grant", 0, a.grants);
        assertTrue(queue.isEmpty());
    }

    /**
     * 🔴 本测试最重要的一条：**并发请求必须全部被应答**。
     *
     * <p>这正是 v1.3.2「允许了权限却打不开」的机制 —— 单个共享字段被后来的请求
     * 覆盖后，先到的那个既没 grant 也没 deny，前端 {@code getUserMedia} 永久挂起。
     * 若把实现改回「单个字段」，本用例必须变红。
     */
    @Test
    public void concurrentRequestsAllGetAnswered() {
        CameraPermissionQueue<String> queue = new CameraPermissionQueue<>();
        // 模拟 StrictMode 双挂载 / 用户连点「重试」造成的并发请求
        List<FakeRequest> concurrent = new ArrayList<>();
        for (int i = 0; i < 5; i++) {
            FakeRequest r = new FakeRequest("concurrent-" + i);
            concurrent.add(r);
            queue.add(r);
        }
        assertEquals("5 个请求都应处于挂起状态", 5, queue.size());

        int answered = queue.resolveAll(true);

        assertEquals("一个都不能漏", 5, answered);
        for (FakeRequest r : concurrent) {
            r.assertAnsweredExactlyOnce();
        }
        assertTrue(queue.isEmpty());
    }

    @Test
    public void resolveAllOnEmptyQueueAnswersNothing() {
        CameraPermissionQueue<String> queue = new CameraPermissionQueue<>();

        assertEquals("空队列不产生应答", 0, queue.resolveAll(true));
        assertEquals(0, queue.resolveAll(false));
    }

    /**
     * 应答回调里**重入**（grant 之后前端立刻重新发起取流）时，新加入的请求
     * 不能被这一轮应答带出去 —— 否则它同样会永久挂起。
     */
    @Test
    public void resolveAllDoesNotAnswerRequestsAddedDuringAnswering() {
        final CameraPermissionQueue<String> queue = new CameraPermissionQueue<>();
        final FakeRequest latecomer = new FakeRequest("latecomer");
        CameraPermissionQueue.Pending<String> reentrant =
                new CameraPermissionQueue.Pending<String>() {
                    @Override
                    public void grant() {
                        // 前端在授权回调里立即重新取流 ⇒ 队列里多出一个新请求
                        queue.add(latecomer);
                    }

                    @Override
                    public void deny() {
                    }

                    @Override
                    public String key() {
                        return "first";
                    }
                };
        queue.add(reentrant);

        int answered = queue.resolveAll(true);

        assertEquals("本轮只应答原本挂着的那个", 1, answered);
        latecomer.assertNeverAnswered();
        assertEquals("重入加入的请求必须仍留在队列里等下一轮", 1, queue.size());
    }

    // ── cancel ───────────────────────────────────────────────────────────────

    @Test
    public void cancelRemovesWithoutAnswering() {
        CameraPermissionQueue<String> queue = new CameraPermissionQueue<>();
        FakeRequest a = new FakeRequest("a");
        FakeRequest b = new FakeRequest("b");
        queue.add(a);
        queue.add(b);

        assertTrue("取消一个仍挂起的请求应返回 true", queue.cancel("a"));
        assertEquals(1, queue.size());

        int answered = queue.resolveAll(true);

        assertEquals("被取消的请求不再参与应答", 1, answered);
        a.assertNeverAnswered();
        assertEquals("剩下的那个照常被应答", 1, b.grants);
    }

    @Test
    public void cancelIsIdempotent() {
        CameraPermissionQueue<String> queue = new CameraPermissionQueue<>();
        FakeRequest a = new FakeRequest("a");
        queue.add(a);
        queue.resolveAll(true);

        assertFalse("已应答过的请求再取消应返回 false", queue.cancel("a"));
        assertEquals("不应被重复应答", 1, a.grants);
    }

    // ── denyIfPending（看门狗） ───────────────────────────────────────────────

    @Test
    public void denyIfPendingDeniesHangingRequest() {
        CameraPermissionQueue<String> queue = new CameraPermissionQueue<>();
        FakeRequest a = new FakeRequest("a");
        queue.add(a);

        assertTrue("仍在挂起 ⇒ 看门狗应拒绝它", queue.denyIfPending("a"));
        assertEquals("恰好被拒绝一次", 1, a.denies);
        assertEquals("拒绝后不应再有 grant", 0, a.grants);
        assertTrue(queue.isEmpty());
    }

    /** 看门狗与「系统回调」谁先到都得幂等 —— 否则会 double-deny 或 double-grant。 */
    @Test
    public void denyIfPendingDoesNotDoubleAnswerAfterResolve() {
        CameraPermissionQueue<String> queue = new CameraPermissionQueue<>();
        FakeRequest a = new FakeRequest("a");
        queue.add(a);
        queue.resolveAll(true);

        assertFalse("已被系统回调应答过 ⇒ 看门狗不应再动它", queue.denyIfPending("a"));
        assertEquals("不得重复 grant", 1, a.grants);
        assertEquals("更不得事后 deny", 0, a.denies);
    }

    @Test
    public void denyIfPendingOnUnknownKeyDoesNothing() {
        CameraPermissionQueue<String> queue = new CameraPermissionQueue<>();

        assertFalse(queue.denyIfPending("never-added"));
        assertTrue(queue.isEmpty());
    }
}
