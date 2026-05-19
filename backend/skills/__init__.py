"""技能注册表 — 把游戏里的常用命令按 5 组(日常/法宝/侍妾/奇遇/独立)整理出来。

每条 Skill 是「一个能在 UI 一键发出去的命令」。spec 层声明:
- group:UI 底栏分组
- command:实际发到 game bot 的文本
- reply_mode:
    - "none"     标准发送(不带 reply_to)
    - "required" 必须带 reply_to_msg_id 才发,否则报错(如 .加入副本 N、.抉择 ...)
    - "optional" 带 reply_to 就回复发,不带就直接发(用于通用查询)
- cd_module:对应 identity_module_state 里哪个 module key(为空表示无 CD)
"""

from __future__ import annotations

from dataclasses import dataclass

from backend.domain.realm import REALM_SORT_ORDER


@dataclass(frozen=True)
class Skill:
    key: str
    group: str
    label: str
    command: str
    reply_mode: str = "none"  # none | required | optional
    cd_module: str = ""
    icon: str = ""
    note: str = ""
    sect: str = ""        # 限定宗门(空=所有宗门可用),对应老脚本 get_available_module_names
    realm_min: str = ""   # 最低境界(空=无要求),命名对齐老脚本 REALM_SORT_ORDER

    def to_api(self) -> dict:
        return {
            "key": self.key,
            "group": self.group,
            "label": self.label,
            "command": self.command,
            "reply_mode": self.reply_mode,
            "cd_module": self.cd_module,
            "icon": self.icon,
            "note": self.note,
            "sect": self.sect,
            "realm_min": self.realm_min,
        }


# 老脚本 model/state.py:124-163 的 REALM_SORT_ORDER + sect/realm 闸:
# - 灵树   → 落云宗 only
# - 观星台/观星 → 星宫 only
# - 登天阶 → 凌霄宫 only
# - 太一   → 太一门 only
# - 放养   → 万灵宗 only
# - 元婴   → 境界 ≥ 元婴初期
# - 小世界 → 境界 ≥ 化神初期
# REALM_SORT_ORDER 现在统一从 backend.domain.realm 导入,跟 parser 用同一份。


# 默认布局 — 6 个分组,参照老脚本 model/web/static/js/app.js 的「日常/法宝/侍妾/奇遇」
# 4 大组 + 把那一堆「独立卡片」收成「玩法」(灵树/观星/天阶/小世界/元神 等宗门玩法),
# 再加一个新「查询」组放纯只读不消耗的命令。
DEFAULT_SKILLS: tuple[Skill, ...] = (
    # ---------- 日常 ----------
    Skill("wild_training", "日常", "野外历练", ".野外历练", cd_module="wild_training", icon="⚔️"),
    Skill("checkin", "日常", "宗门点卯", ".宗门点卯", cd_module="checkin", icon="📋"),
    Skill("sect_teach", "日常", "宗门传功", ".宗门传功", icon="📖"),
    Skill("tower", "日常", "闯塔", ".闯塔", cd_module="tower", icon="🗼"),
    Skill("deep_retreat", "日常", "深度闭关", ".深度闭关", cd_module="deep_retreat", icon="📿"),
    Skill("retreat_shallow", "日常", "闭关修炼", ".闭关修炼", cd_module="retreat_shallow", icon="🧘"),
    Skill("yuanying", "日常", "元婴出窍", ".元婴出窍", cd_module="yuanying", icon="👻", realm_min="元婴初期"),

    # ---------- 法宝 ----------
    Skill("pet_touch", "法宝", "抚摸法宝", ".抚摸法宝", cd_module="pet_touch", icon="🖐️"),
    Skill("pet_warm", "法宝", "温养器灵", ".温养器灵", cd_module="pet_warm", icon="♨️"),
    Skill("pet_trial", "法宝", "器灵试炼", ".器灵试炼", cd_module="pet_trial", icon="🥊"),

    # ---------- 侍妾 ----------
    Skill("concubine_dream", "侍妾", "入梦寻图", ".入梦寻图", cd_module="concubine_dream", icon="💭"),
    Skill("concubine_fragment", "侍妾", "残图", ".残图", icon="🧩",
          note="拼图前先看残图"),
    Skill("concubine_puzzle", "侍妾", "拼图", ".拼图", icon="🖼️"),
    Skill("concubine_sect_marry", "侍妾", "宗门赐婚", ".宗门赐婚", icon="💍"),
    Skill("concubine_romance", "侍妾", "红尘寻缘", ".红尘寻缘", icon="🌹"),
    Skill("concubine_tianji", "侍妾", "天机代卜", ".天机代卜", cd_module="concubine_tianji", icon="🔮"),
    Skill("concubine_heart", "侍妾", "共历心劫", ".共历心劫", cd_module="concubine_heart", icon="💔"),
    Skill("concubine_heart_steady", "侍妾", "稳", ".稳",
          reply_mode="required",
          note="心劫提示出现后,回复 bot 的提示消息发出"),

    # ---------- 奇遇 ----------
    Skill("quiz_answer", "奇遇", "作答", ".作答",
          reply_mode="required",
          note="玄骨考校题目出现时,回复题目消息"),
    Skill("tiandao_prove", "奇遇", "自证", ".自证",
          reply_mode="required",
          note="天道审判出现时,回复 bot 的提示"),
    Skill("jiyin_offer_soul", "奇遇", "献上魂魄", ".献上魂魄",
          reply_mode="required",
          note="极阴祖师提示出现时,回复 bot 提示"),
    Skill("jiyin_hide_aura", "奇遇", "收敛气息", ".收敛气息",
          reply_mode="required",
          note="极阴祖师提示出现时,回复 bot 提示"),
    Skill("nanlong_exchange_fabao", "奇遇", "交换 法宝", ".交换 法宝",
          reply_mode="required",
          note="南陇侯出现时,回复 bot 提示"),
    Skill("nanlong_exchange_gongfa", "奇遇", "交换 功法", ".交换 功法",
          reply_mode="required",
          note="南陇侯出现时,回复 bot 提示"),
    Skill("nanlong_reject", "奇遇", "拒绝交易", ".拒绝交易",
          reply_mode="required",
          note="南陇侯出现时,回复 bot 提示"),

    # ---------- 玩法 — 宗门 / 境界限定(参考老脚本 state.py:1200 get_available_module_names)----------
    # 灵树 = 落云宗
    Skill("tree_water", "玩法", "灵树灌溉", ".灵树灌溉", icon="💧", sect="落云宗"),
    Skill("tree_guard", "玩法", "协同守山", ".协同守山", icon="⛰️", sect="落云宗"),
    Skill("tree_harvest", "玩法", "采摘灵果", ".采摘灵果", icon="🍎", sect="落云宗"),
    # 观星台 / 观星 = 星宫
    Skill("stargazer_panel", "玩法", "观星台", ".观星台", icon="🔭", sect="星宫"),
    Skill("stargazer_guide", "玩法", "牵引星辰", ".牵引星辰", cd_module="stargazer_guide", icon="🌟", sect="星宫"),
    Skill("stargazer_soothe", "玩法", "安抚星辰", ".安抚星辰", cd_module="stargazer_soothe", icon="✨", sect="星宫"),
    Skill("stargazer_collect", "玩法", "收集精华", ".收集精华", cd_module="stargazer_collect", icon="💎", sect="星宫"),
    Skill("guanxing", "玩法", "观星", ".观星", icon="🔮", sect="星宫"),
    Skill("guanxing_shift", "玩法", "改换星移", ".改换星移", icon="🌌", sect="星宫"),
    # 登天阶 = 凌霄宫
    Skill("tianti_climb", "玩法", "登天阶", ".登天阶", cd_module="tianti_climb", icon="🪜", sect="凌霄宫"),
    Skill("tianti_wenxin", "玩法", "问心台", ".问心台", cd_module="tianti_wenxin", icon="🧠", sect="凌霄宫"),
    Skill("tianti_gangfeng", "玩法", "引九天罡风", ".引九天罡风", cd_module="tianti_gangfeng", icon="🌬️", sect="凌霄宫"),
    # 太一 = 太一门
    Skill("taiyi", "玩法", "太一", ".太一", icon="☯️", sect="太一门"),
    # 放养 = 万灵宗
    Skill("ranch", "玩法", "一键放养", ".一键放养", cd_module="ranch", icon="🌾", sect="万灵宗"),
    # 小世界 = realm ≥ 化神初期
    Skill("small_world", "玩法", "小世界", ".小世界", icon="🌐", realm_min="化神初期",
          note="进入小世界面板,查询不消耗"),
    Skill("sw_manifest", "玩法", "显灵", ".显灵", icon="✨", realm_min="化神初期"),
    Skill("sw_harvest", "玩法", "收割香火", ".收割香火", icon="🔥", realm_min="化神初期"),
    Skill("sw_refine", "玩法", "神识淬炼", ".神识淬炼", icon="🧠", realm_min="化神初期"),
    Skill("sw_preach", "玩法", "神迹 布道", ".神迹 布道", icon="📜", realm_min="化神初期"),
    # 第二元神 / 元神修炼 — 无 sect 限制,通用
    Skill("second_soul_train", "玩法", "元神修炼", ".元神修炼", cd_module="second_soul", icon="🪞"),
    Skill("second_soul_choice_break", "玩法", "抉择 强行突破", ".抉择 强行突破",
          reply_mode="required",
          note="第二元神 prompt 出现时,回复 bot 提示"),
    Skill("second_soul_choice_stable", "玩法", "抉择 稳固道心", ".抉择 稳固道心",
          reply_mode="required",
          note="第二元神 prompt 出现时,回复 bot 提示"),
    # 引道 — 全角色都能用(节点/星移辅助)
    Skill("yindao", "玩法", "引道", ".引道", cd_module="taiyi_cycle", icon="🌠"),
    Skill("node_search", "玩法", "搜寻节点", ".搜寻节点", icon="🔎",
          cd_module="taiyi_cycle", note="搜寻可定星节点(老脚本 CMD_NODE_SEARCH)"),
    Skill("node_define", "玩法", "定星", ".定星", icon="⭐",
          note="把节点钉成星(老脚本 CMD_NODE_DEFINE)"),

    # ---------- 查询(只读,不消耗,不触发冷却)----------
    Skill("storage_bag", "查询", "储物袋", ".储物袋", icon="📦",
          note="查询当前储物袋"),
    Skill("battle_power", "查询", "战力", ".战力", icon="💪",
          note="查询当前综合战力"),
    Skill("identity_info", "查询", "我的灵根", ".我的灵根", icon="📜",
          note="查询天命玉牒(称号/灵根/宗门/修为)"),
    Skill("deep_retreat_query", "查询", "查看闭关", ".查看闭关", icon="🔍",
          note="查询当前闭关状态"),
    Skill("yuanying_status", "查询", "元婴状态", ".元婴状态", icon="👻", realm_min="元婴初期"),
    Skill("tianti_status", "查询", "天阶状态", ".天阶状态", icon="🪜", sect="凌霄宫"),
    Skill("tree_status", "查询", "灵树状态", ".灵树状态", icon="🌳", sect="落云宗"),
    Skill("concubine_status", "查询", "我的侍妾", ".我的侍妾", icon="👩"),
    Skill("second_soul_status", "查询", "第二元神", ".第二元神", icon="🔮"),
    Skill("sect_list", "查询", "宗门列表", ".宗门列表", icon="🏔️"),
    Skill("check_root", "查询", "检测灵根", ".检测灵根", icon="🪬",
          note="新角色用,会赐道号 + 灵根"),
    Skill("dungeon_join", "查询", "加入副本", ".加入副本",
          reply_mode="required",
          note="副本公告出现时,回复并附副本ID;或在卡片 actions 区点预填命令"),
    Skill("dungeon_zhuimo_choice", "查询", "坠魔抉择", ".坠魔抉择",
          reply_mode="required",
          note="坠魔谷推进提示出现时,回复路径1/路径2/路径3"),
)


INTERNAL_SKILLS: tuple[Skill, ...] = (
    Skill(
        "manual_send",
        "内部",
        "手动发送",
        "",
        reply_mode="optional",
        note="UI 主动发送/回复入口专用;不暴露到底部技能盘",
    ),
)


class SkillRegistry:
    def __init__(self, skills: tuple[Skill, ...] = DEFAULT_SKILLS):
        self._public_skills = tuple(skills)
        internal = tuple(
            skill for skill in INTERNAL_SKILLS
            if all(skill.key != public.key for public in self._public_skills)
        )
        self._skills_by_key: dict[str, Skill] = {
            skill.key: skill for skill in (*self._public_skills, *internal)
        }

    def list(self) -> tuple[Skill, ...]:
        return self._public_skills

    def get(self, key: str) -> Skill | None:
        return self._skills_by_key.get(str(key or "").strip())

    def list_groups(self) -> list[str]:
        seen: list[str] = []
        for skill in self._public_skills:
            if skill.group not in seen:
                seen.append(skill.group)
        return seen

    def to_api(self) -> dict:
        return {
            "ok": True,
            "groups": self.list_groups(),
            "skills": [skill.to_api() for skill in self.list()],
            "realm_order": list(REALM_SORT_ORDER),
        }


__all__ = ["Skill", "SkillRegistry", "DEFAULT_SKILLS", "INTERNAL_SKILLS"]
