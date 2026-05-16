"""游戏 bot 「发言指纹」识别。

抄 xiuxian-main `/opt/xiuxian-main/model/app.py:164-209` 的 `BOT_REPLY_FAMILY_HINTS`:
每个 family(玩法分支)对应几个关键词 tuple,bot 回复某条命令时通常包含这些词。
mini-web 用它过滤「discovered_bots」候选 —— 只把真在群里发过游戏 bot 风格消息的
sender 列给用户勾选,不把闲聊玩家的频道号也扔上去。

不做「自动加进 game_bot_ids」这一步(老脚本满 3 次自动加),mini-web 让用户手动确认。
"""

from __future__ import annotations

# 直接照搬,顺序不重要,值是 OR 关系
BOT_REPLY_FAMILY_HINTS: dict[str, tuple[str, ...]] = {
    "checkin": ("点卯", "已点卯", "已经点过", "宗门"),
    "sect_teach": ("传功", "宗门", "贡献"),
    "tower": ("闯塔", "古塔", "塔灵", "挑战", "道心受挫"),
    "pet": ("器灵", "法宝", "默契", "经验", "休息"),
    "pet_warm": ("温养器灵", "温养", "灵光大振", "吞纳过灵机"),
    "pet_trial": ("器灵试炼", "试炼", "共鸣", "灵潮", "反噬"),
    "tree_panel": ("灵眼之树", "灵树", "果实", "采摘", "成熟"),
    "tree_guard": ("守山", "护山", "攻山", "灵树"),
    "tree_harvest": ("采摘", "灵果", "木髓", "灵树"),
    "stargazer_panel": ("观星台", "引星盘", "星辰"),
    "stargazer_guide": ("牵引", "星辰", "引星盘", "星力"),
    "stargazer_soothe": ("安抚", "狂暴星力", "引星盘"),
    "stargazer_collect": ("收集", "精华", "星辰", "引星盘"),
    "stargazer_sync": ("观星台", "引星盘", "星辰"),
    "guanxing_query": ("观星台", "引星盘", "空闲", "精华"),
    "guanxing_shift": ("牵引", "星辰", "引星盘", "星力"),
    "tianti_status": ("天梯", "问心", "罡风", "登天"),
    "tianti_wenxin": ("问心", "天梯", "道心"),
    "tianti_climb": ("天梯", "登天", "层", "修为"),
    "tianti_gangfeng": ("九天罡风", "罡风", "再聚"),
    "yuanying": ("元婴", "出窍", "归窍", "法则碎片", "探寻"),
    "deep_retreat": ("深度闭关", "闭关", "神魂", "功成圆满", "总结"),
    "small_world_preach": ("小世界", "香火", "信仰", "神识", "神迹"),
    "small_world_query": ("小世界", "香火", "祈愿", "显灵", "紫府"),
    "small_world_manifest": ("显灵", "祈愿", "清灵丹", "灵石", "小世界"),
    "small_world_harvest": ("收割香火", "香火", "库存", "小世界"),
    "small_world_refine": ("神识淬炼", "香火", "神识", "小世界"),
    "concubine_status": ("侍妾", "道侣", "红尘", "情缘", "残图"),
    "concubine_dream": ("入梦寻图", "侍妾", "残图", "梦图感应"),
    "concubine_fragment": ("虚天残图", "残图", "残纹", "拼片"),
    "concubine_puzzle": ("拼图", "虚天残图", "拼合", "残纹"),
    "concubine_reacquire": ("侍妾", "道侣", "红尘寻缘", "宗门赐婚", "红颜"),
    "concubine_tianji": ("天机代卜", "天机链路", "卜算天机", "代卜"),
    "concubine_heart": ("共历心劫", "坠魔心劫", "心劫余波", "心劫抉择"),
    "nanlong": ("南陇侯", "交易", "侍妾", "法宝", "功法"),
    "second_soul_status": ("第二元神", "元神", "心魔", "修炼"),
    "second_soul_train": ("第二元神", "元神", "修炼", "闭关"),
    "second_soul_choice": ("心魔", "抉择", "第二元神"),
    "taiyi_yindao": ("引道", "太一", "五行", "神识"),
    "taiyi_node_search": ("搜寻节点", "空间节点", "虚空", "神识"),
    "taiyi_node_define": ("定星", "空间节点", "稳固", "材料"),
    # mini-web 额外:几个高频系统/角色面板
    "profile_card": ("天命玉牒", "灵根", "宗门", "修为"),
    "battle_power": ("战力评估", "综合战力", "天机阁"),
    "risk": ("天道审判", "挂机嫌疑", "永久打入死牢"),
    "dungeon_open": ("虚天殿", "副本ID", "加入队伍"),
    "second_soul_return": ("第二元神归位", "回归窍中温养"),
    "inventory": ("储物袋",),
}


def matched_families(text: str) -> list[str]:
    """对照老脚本 `_looks_like_game_bot_reply`:
    - 文本以 `.` 开头 → 玩家指令,不算
    - 命中任一 family 的任一关键词 → 收进结果
    返回命中的 family 列表(可能多个 family 同时命中)。
    """
    raw = str(text or "").strip()
    if not raw or raw.startswith("."):
        return []
    hits: list[str] = []
    for family, keywords in BOT_REPLY_FAMILY_HINTS.items():
        if any(keyword in raw for keyword in keywords):
            hits.append(family)
    return hits


def looks_like_game_bot_message(text: str) -> bool:
    return bool(matched_families(text))
