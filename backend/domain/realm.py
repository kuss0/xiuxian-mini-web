"""境界推断 + 排序辅助 — 跟老脚本 model/state.py:103-163 对齐。

应用场景:
- profile parser 拿到 修为: X/Y 但没境界文本 → 用 xiuwei_max 反推
- skill bar 比较「当前境界 >= skill.realm_min」时,统一从 REALM_SORT_ORDER 拿 index
- 突破 broadcast 拿到 realm 后,可用 realm_min_xiuwei_max 反查兜底
"""

from __future__ import annotations


REALM_SORT_ORDER: tuple[str, ...] = (
    "炼气一层", "炼气二层", "炼气三层", "炼气四层", "炼气五层",
    "炼气六层", "炼气七层", "炼气八层", "炼气九层", "炼气十层",
    "炼气十一层", "炼气十二层", "炼气十三层",
    "筑基初期", "筑基中期", "筑基后期",
    "结丹初期", "结丹中期", "结丹后期",
    "元婴初期", "元婴中期", "元婴后期",
    "化神初期", "化神中期", "化神后期", "化神后期大圆满",
)

# 老脚本 model/state.py:132-159 — 严格相等才匹配(老脚本判等不是「>=」)
REALM_XIUWEI_MAX_MAP: dict[int, str] = {
    100: "炼气一层",
    150: "炼气二层",
    220: "炼气三层",
    300: "炼气四层",
    400: "炼气五层",
    520: "炼气六层",
    650: "炼气七层",
    800: "炼气八层",
    1000: "炼气九层",
    1250: "炼气十层",
    1500: "炼气十一层",
    1800: "炼气十二层",
    2200: "炼气十三层",
    5000: "筑基初期",
    10000: "筑基中期",
    30000: "筑基后期",
    50000: "结丹初期",
    100000: "结丹中期",
    200000: "结丹后期",
    500000: "元婴初期",
    1000000: "元婴中期",
    2000000: "元婴后期",
    4000000: "化神初期",
    8000000: "化神中期",
    16000000: "化神后期",
    32000000: "化神后期大圆满",
}


def realm_index(realm: str) -> int:
    """返回境界在 REALM_SORT_ORDER 里的 index;不在表里返 -1。"""
    try:
        return REALM_SORT_ORDER.index((realm or "").strip())
    except ValueError:
        return -1


def realm_at_least(current: str, minimum: str) -> bool:
    """当前境界是否 >= minimum;两边都得在表里才能比,任一缺失返 True(放行)。"""
    cur = realm_index(current)
    need = realm_index(minimum)
    if cur < 0 or need < 0:
        return True
    return cur >= need


def infer_realm_from_xiuwei_max(xiuwei_max: int | None) -> str:
    """通过 xiuwei_max 反查境界。没匹配上返空字符串(不强行猜)。"""
    try:
        mx = int(xiuwei_max or 0)
    except (TypeError, ValueError):
        return ""
    return REALM_XIUWEI_MAX_MAP.get(mx, "")


__all__ = [
    "REALM_SORT_ORDER",
    "REALM_XIUWEI_MAX_MAP",
    "realm_index",
    "realm_at_least",
    "infer_realm_from_xiuwei_max",
]
