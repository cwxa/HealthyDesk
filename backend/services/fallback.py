SUGGESTIONS = [
    "请调整座椅高度，使双脚平放地面，大腿与地面平行。",
    "显示器顶部应与眼睛齐平，距离约一臂之长。",
    "双肩放松下沉，不要耸肩，保持脊柱自然直立。",
    "下巴微收，头部向后靠，避免头部前伸。",
    "建议做颈部侧屈拉伸：缓慢将头向左肩倾斜，保持15秒，换边。",
    "做肩部环绕：双肩向前缓慢画圈10次，再向后10次。",
    "起身站立，双手叉腰，轻轻向后仰身，伸展胸椎。",
    "每工作30分钟，起身活动2-3分钟，眺望远处放松眼部。",
    "使用弹力带做扩胸运动，增强上背部力量。",
    "调整椅子扶手高度，使手臂自然下垂时肘部得到支撑。",
]


def get_fallback_suggestions(issues: list[str]) -> list[str]:
    if not issues:
        return ["姿态良好，继续保持！"]

    result = []
    if "头部侧倾" in issues:
        result.append("检测到头部侧倾：调整坐姿，保持头部居中，双耳水平。")
    if "肩部不平衡" in issues:
        result.append("检测到肩部不平：放松双肩，保持左右肩等高。")
    if "脊柱倾斜" in issues:
        result.append("检测到脊柱倾斜：调整坐姿，保持身体居中。")

    result.append(SUGGESTIONS[hash(tuple(issues)) % len(SUGGESTIONS)])
    return result
