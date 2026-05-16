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
        }


# 默认布局 — 参照老脚本 model/web/static/js/app.js 的分组(日常/法宝/侍妾/奇遇 + 独立)
DEFAULT_SKILLS: tuple[Skill, ...] = (
    # ---------- 日常 ----------
    Skill("wild_training", "日常", "野外历练", ".野外历练", icon="⚔️"),
    Skill("checkin", "日常", "宗门点卯", ".宗门点卯", icon="📋"),
    Skill("tower", "日常", "闯塔", ".闯塔", icon="🗼"),
    Skill("deep_retreat", "日常", "深度闭关", ".深度闭关", cd_module="deep_retreat", icon="📿"),
    Skill("deep_retreat_query", "日常", "查看闭关", ".查看闭关", icon="🔍",
          note="查询当前闭关状态,不消耗"),
    Skill("yuanying", "日常", "元婴出窍", ".元婴出窍", icon="👻"),

    # ---------- 法宝 ----------
    Skill("pet_touch", "法宝", "抚摸法宝", ".抚摸法宝", cd_module="pet_touch", icon="🖐️"),
    Skill("pet_warm", "法宝", "温养器灵", ".温养器灵", cd_module="pet_warm", icon="♨️"),
    Skill("pet_trial", "法宝", "器灵试炼", ".器灵试炼", icon="🥊"),

    # ---------- 侍妾 ----------
    Skill("concubine_status", "侍妾", "我的侍妾", ".我的侍妾", icon="👩",
          note="查询侍妾面板,不消耗"),
    Skill("concubine_tianji", "侍妾", "天机代卜", ".天机代卜", icon="🔮"),
    Skill("concubine_heart", "侍妾", "共历心劫", ".共历心劫", icon="💔"),
    Skill("concubine_heart_steady", "侍妾", "稳", ".稳",
          reply_mode="required",
          note="心劫提示出现后,回复 bot 的提示消息发出"),

    # ---------- 奇遇 ----------
    Skill("quiz_answer", "奇遇", "作答", ".作答",
          reply_mode="required",
          note="玄骨考校题目出现时,回复题目消息"),
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

    # ---------- 独立(暂收最常用 4 个 - 灵树/小世界/第二元神/查询)----------
    Skill("tree_water", "独立", "灵树灌溉", ".灵树灌溉", icon="🌱"),
    Skill("tree_status", "独立", "灵树状态", ".灵树状态", icon="🌳",
          note="查询不消耗"),
    Skill("small_world", "独立", "小世界", ".小世界", icon="🌐",
          note="查询不消耗"),
    Skill("second_soul_train", "独立", "元神修炼", ".元神修炼", icon="🔮"),
    Skill("second_soul_choice_break", "独立", "抉择 强行突破", ".抉择 强行突破",
          reply_mode="required",
          note="第二元神 prompt 出现时,回复 bot 提示"),
    Skill("second_soul_choice_stable", "独立", "抉择 稳固道心", ".抉择 稳固道心",
          reply_mode="required",
          note="第二元神 prompt 出现时,回复 bot 提示"),
    Skill("battle_power", "独立", "战力", ".战力", icon="💪",
          note="查询当前综合战力"),
    Skill("identity_info", "独立", "我的灵根", ".我的灵根", icon="📜",
          note="查询面板信息"),
    Skill("dungeon_join", "独立", "加入副本", ".加入副本",
          reply_mode="required",
          note="副本公告出现时,回复并附副本ID;或在动作按钮里用预填命令"),
)


class SkillRegistry:
    def __init__(self, skills: tuple[Skill, ...] = DEFAULT_SKILLS):
        self._skills_by_key: dict[str, Skill] = {skill.key: skill for skill in skills}

    def list(self) -> tuple[Skill, ...]:
        return tuple(self._skills_by_key.values())

    def get(self, key: str) -> Skill | None:
        return self._skills_by_key.get(str(key or "").strip())

    def list_groups(self) -> list[str]:
        seen: list[str] = []
        for skill in self._skills_by_key.values():
            if skill.group not in seen:
                seen.append(skill.group)
        return seen

    def to_api(self) -> dict:
        return {
            "ok": True,
            "groups": self.list_groups(),
            "skills": [skill.to_api() for skill in self.list()],
        }


__all__ = ["Skill", "SkillRegistry", "DEFAULT_SKILLS"]
