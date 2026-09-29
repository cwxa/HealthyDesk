#!/usr/bin/env python
"""把 `scenarios.json` 里的案例序列写成 **Y4M 视频文件** —— 假摄像头的「供片盘」。

## 为什么需要它

`scripts/verify-ui-smoke.mjs` 的「不覆盖」清单里有一条最贵的：
**「有真实帧时的实时徽章 / `localQuality`」** —— 无头环境没有摄像头，
`liveQuality` 恒为 `null`，这条链路一直只在真机上验过。

Chromium 有官方开关可以让**假摄像头**顶替真设备：

    --use-fake-ui-for-media-stream            自动同意权限（不用点弹窗）
    --use-fake-device-for-media-stream        用假设备替代真摄像头
    --use-file-for-fake-video-capture=a.y4m   画面循环来自这个 Y4M 文件

本脚本产出的就是那个 `.y4m`。**已实测可注入**（本机 Chrome / 无头 / 640×480）：
`<video>` 拿到 640×480、8 秒推进 39 帧 ≈ 5fps，正好等于桌面端 `setInterval(…, 200)`
与 fixture 的 `frame_interval_ms`。

## 两个必须记住的坑

1. 🔴 **Y4M 头里的色度标记必须是 `C420mpeg2`**，帧率写 `F<fps>:1`。分辨率/帧率与
   `scenarios.json` 的 `capture` 必须一致，否则 `<video>` 的尺寸与喂帧节奏都对不上。
2. 🔴 **别用 `--dump-dom --virtual-time-budget` 去读结果**：`--virtual-time-budget`
   会被**未决的媒体请求**挂住 —— `getUserMedia()` 的 Promise 既不 resolve 也不 reject，
   虚拟时间就不再推进，dump 出来永远是初始状态（实测打印 `0:start`，
   看上去像"y4m 不行"，其实探针根本没跑）。**必须连 CDP 用真实时间等**。

用法：

    python scripts/fake-camera/make-y4m.py --case=completed --out=.buildenv/fake-cam/completed.y4m
    python scripts/fake-camera/make-y4m.py --list

体积：640×480 的 I420 每帧 460,800 B ⇒ `completed`（60 帧）约 27 MB。
**别入库**（`.buildenv/` 或临时目录），用时现生成。
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

import cv2
import numpy as np

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent.parent
SCENARIOS = HERE / "scenarios.json"
FRAMES = HERE / "frames"

sys.path.insert(0, str(HERE))


def load_scenarios() -> dict:
    if not SCENARIOS.exists():
        sys.exit(f"!! 缺 {SCENARIOS}；先跑 scripts/fake-camera/build-frames.py --from-src=<原图目录>")
    return json.loads(SCENARIOS.read_text(encoding="utf-8"))


def case_frames(doc: dict, case_id: str) -> list[str]:
    """从案例的 `sequence` 展开出帧名（复用 fixture 的解析器，**不另写一份**）。

    另写一份 = 两个解析器会分叉，而解析器在这个项目里已经坏过两次（见 build-frames.py）。
    """
    case = next((c for c in doc["cases"] if c["id"] == case_id), None)
    if case is None:
        ids = [c["id"] for c in doc["cases"]]
        sys.exit(f"!! 没有案例 {case_id!r}；可选：{', '.join(ids)}")
    # 只借解析器：`frames` 是声明帧数，展开结果必须与它一致（build-frames.py 已断言过）
    return _parse(case["sequence"]), case


def _parse(text: str) -> list[str]:
    import importlib.util
    spec = importlib.util.spec_from_file_location("bf", HERE / "build-frames.py")
    bf = importlib.util.module_from_spec(spec)
    # 只借 `parse_sequence`；它不依赖 mediapipe（`PoseDetector` 是延迟导入到函数内的）
    spec.loader.exec_module(bf)
    return bf.parse_sequence(text)


def write_y4m(path: Path, names: list[str], w: int, h: int, fps: int, blobs: dict) -> int:
    """I420 平面 Y4M。返回帧数。"""
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("wb") as f:
        f.write(f"YUV4MPEG2 W{w} H{h} F{fps}:1 Ip A1:1 C420mpeg2\n".encode())
        for name in names:
            bgr = cv2.imdecode(np.frombuffer(blobs[name], np.uint8), cv2.IMREAD_COLOR)
            ok, buf = cv2.imencode(".jpg", bgr, [int(cv2.IMWRITE_JPEG_QUALITY), 70])
            assert ok
            bgr = cv2.imdecode(buf, cv2.IMREAD_COLOR)
            if (bgr.shape[1], bgr.shape[0]) != (w, h):
                bgr = cv2.resize(bgr, (w, h), interpolation=cv2.INTER_LANCZOS4)
            f.write(b"FRAME\n")
            f.write(np.ascontiguousarray(cv2.cvtColor(bgr, cv2.COLOR_BGR2YUV_I420)).tobytes())
    return len(names)


def main() -> int:
    ap = argparse.ArgumentParser(description="把案例序列写成 Y4M 假摄像头供片盘")
    ap.add_argument("--case", help="案例 id（见 --list）")
    ap.add_argument("--out", help="输出的 .y4m 路径")
    ap.add_argument("--list", action="store_true", help="列出所有案例")
    a = ap.parse_args()

    doc = load_scenarios()
    if a.list or not a.case:
        print("可用案例（视频帧数 = 序列长度；采纳帧数 = 其中真的检到人的）：")
        for c in doc["cases"]:
            vsz = len(_parse(c["sequence"]))
            secs = vsz / (1000 / doc["capture"]["frame_interval_ms"])
            print(f"  {c['id']:<24}视频 {vsz:>3} 帧 / 采纳 {c['accepted_frames']:>3} 帧  "
                  f"{secs:>5.1f}s  {c['verdict']['grade']}/{c['verdict']['hint']}")
        print("\n（`no-pose` 的采纳帧数是 0：整段都检不到人 —— 但**视频本身仍有 60 帧空房间画面**，"
              "正好用来注入「摄像头对着空房间」这一路）")
        return 0 if a.list else 2

    if not a.out:
        sys.exit("!! 需要 --out=<路径.y4m>")

    names, case = case_frames(doc, a.case)
    blobs = {n: (FRAMES / f"{n}.jpg").read_bytes() for n in set(names)}
    cap = doc["capture"]
    n = write_y4m(Path(a.out), names, cap["width"], cap["height"],
                  round(1000 / cap["frame_interval_ms"]), blobs)
    size = Path(a.out).stat().st_size
    print(f"写出 {a.out}：{n} 帧 @ {round(1000 / cap['frame_interval_ms'])}fps  "
          f"（{n * cap['frame_interval_ms'] / 1000:.1f}s，{size / 1048576:.1f} MB）")
    print(f"案例期望：{case['expect_grade']}/{case['expect_hint']}")
    print("注入无头 Chrome：见本文件头部的三条开关；**读结果必须走 CDP + 真实时间**。")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
