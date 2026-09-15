"""姿态评分：Python 后端 vs 前端 TS 的数值等价性验证。

思路：构造一组覆盖典型场景的 (head_angle, shoulder_diff, spine_angle) 输入，
分别用 Python 的 scorer.compute_score 与前端 TS 的 computeScore 计算，
逐条比对 score 与 issues 是否完全一致。

前端实现通过 tsx/esbuild 转译后由 node 执行（见 scripts/verify-scoring.mjs）。
本脚本只负责「Python 侧」的期望值，输出 JSON 供 node 侧对比。
"""

import json
import sys
import os

# 后端模块用的是裸导入（from config import ...），因此要把 backend/ 本身加入 sys.path
BACKEND = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "backend")
sys.path.insert(0, BACKEND)

import services.scorer as _scorer  # noqa: E402

compute_score = _scorer.compute_score

CASES = [
    # (head_angle, shoulder_diff, spine_angle) —— 覆盖各档位边界
    (0.0, 0.0, 0.0),        # 完美姿势
    (3.0, 2.0, 5.0),        # 阈值内
    (5.0, 4.0, 10.0),       # 恰好等于阈值，不应扣分
    (5.01, 4.01, 10.01),    # 刚过阈值
    (8.0, 6.0, 12.0),       # 轻微
    (12.0, 8.0, 15.0),      # 中等
    (18.0, 14.0, 20.0),     # 明显
    (30.0, 50.0, 60.0),     # 极端，触发各项上限
    (100.0, 100.0, 100.0),  # 更极端，分数应被 min 到 20
    (5.5, 4.5, 10.5),       # 微小超出，验证小数舍入
    (11.0, 3.0, 9.0),       # 只有头部有问题
    (2.0, 12.0, 4.0),       # 只有肩部有问题
    (1.0, 1.0, 18.0),       # 只有脊柱有问题
]


def main():
    out = []
    for head, sh, spine in CASES:
        r = compute_score(head, sh, spine)
        out.append({
            "input": {"head": head, "shoulder": sh, "spine": spine},
            "score": r["score"],
            "issues": r["issues"],
        })
    # 输出到 stdout，供 node 侧读取比对
    print(json.dumps(out, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
