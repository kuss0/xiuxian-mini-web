"""轻量 CD 观察器。

这个模块只做一件事:从真实 bot 回复里观察某个手动技能的下一次可用时间。
它不负责自动发送,也不试图复刻老脚本的完整状态机;复杂玩法仍然应该独立写
module。这里覆盖的是"回复成功/冷却提示 -> 快捷指令灰掉"这类 UI 需求。
"""
from __future__ import annotations

import re
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from typing import Pattern

from backend.domain.models import RawMessageEvent
from backend.identity_state.duration import parse_chinese_duration

TZ_LOCAL = timezone(timedelta(hours=8))


def _matches_any(text: str, patterns: tuple[str | Pattern[str], ...]) -> bool:
    for pattern in patterns:
        if isinstance(pattern, str):
            if pattern and pattern in text:
                return True
        elif pattern.search(text):
            return True
    return False


def _parent_command(ctx) -> str:
    if ctx.parent and ctx.parent.text:
        return str(ctx.parent.text or "").strip()
    return ""


def _command_matches(raw_command: str, commands: tuple[str, ...]) -> bool:
    command = str(raw_command or "").strip()
    if not command:
        return False
    for prefix in commands:
        prefix = str(prefix or "").strip()
        if command == prefix or command.startswith(f"{prefix} "):
            return True
    return False


def _extract_arg(raw_command: str, commands: tuple[str, ...]) -> str:
    command = str(raw_command or "").strip()
    for prefix in commands:
        prefix = str(prefix or "").strip()
        if command == prefix:
            return ""
        if command.startswith(f"{prefix} "):
            return command[len(prefix):].strip()
    return ""


def _next_local_midnight(now: float) -> float:
    local_now = datetime.fromtimestamp(float(now or 0), TZ_LOCAL)
    next_day = (local_now + timedelta(days=1)).replace(hour=0, minute=0, second=0, microsecond=0)
    return next_day.timestamp()


def _next_daily_window(now: float, start_hour_utc: int) -> float:
    """粗略对齐老脚本的每日窗口:点卯 UTC 02,闯塔 UTC 01。"""
    utc_now = datetime.fromtimestamp(float(now or 0), timezone.utc)
    next_day = utc_now + timedelta(days=1)
    due = next_day.replace(hour=start_hour_utc, minute=0, second=0, microsecond=0)
    return due.timestamp()


def _star_duration_from_command(raw_command: str) -> int:
    durations = {
        "赤血星": 4 * 3600,
        "庚金星": 6 * 3600,
        "建木星": 8 * 3600,
        "天雷星": 36 * 3600,
        "帝魂星": 48 * 3600,
    }
    for name, seconds in durations.items():
        if name in raw_command:
            return seconds
    return 0


@dataclass(frozen=True)
class CooldownSpec:
    key: str
    label: str
    commands: tuple[str, ...]
    default_cd_sec: int = 0
    success_patterns: tuple[str | Pattern[str], ...] = ()
    cooldown_patterns: tuple[str | Pattern[str], ...] = ()
    ready_patterns: tuple[str | Pattern[str], ...] = ()
    daily_reset: bool = False
    daily_window_utc_hour: int | None = None
    arg_label: str = ""
    star_duration_from_parent: bool = False


class CooldownModule:
    """通用"回复 -> cooldown_until"模块。"""

    def __init__(self, spec: CooldownSpec) -> None:
        self.spec = spec
        self.key = spec.key
        self.label = spec.label
        self.default_state: dict = {
            "cooldown_until": 0.0,
            "last_observed_at": 0.0,
            "last_success_at": 0.0,
            "last_status": "unknown",
            "last_text_excerpt": "",
        }
        if spec.arg_label:
            self.default_state[spec.arg_label] = ""

    def resolve_target(self, event: RawMessageEvent, ctx) -> int | None:
        if ctx.sender_kind != "bot":
            return None
        if not ctx.parent_is_my_identity():
            return None
        if not _command_matches(_parent_command(ctx), self.spec.commands):
            return None
        return ctx.parent_sender()

    def observe(self, event: RawMessageEvent, ctx, state: dict) -> dict | None:
        text = str(event.text or "").strip()
        if not text:
            return None
        now = float(ctx.now or 0)
        parent_cmd = _parent_command(ctx)
        arg_value = _extract_arg(parent_cmd, self.spec.commands)
        wait_sec = parse_chinese_duration(text)
        new = dict(state)

        def _finish(*, until: float, status: str, success: bool = False) -> dict:
            new["cooldown_until"] = float(until or 0)
            new["last_observed_at"] = now
            new["last_status"] = status
            new["last_text_excerpt"] = text[:120]
            if success:
                new["last_success_at"] = now
            if self.spec.arg_label and arg_value:
                new[self.spec.arg_label] = arg_value
            return new

        if self.spec.ready_patterns and _matches_any(text, self.spec.ready_patterns):
            return _finish(until=now, status="ready", success=False)

        if self.spec.cooldown_patterns and _matches_any(text, self.spec.cooldown_patterns):
            if wait_sec > 0:
                return _finish(until=now + wait_sec, status="cooldown", success=False)
            if self.spec.daily_reset:
                return _finish(until=_next_local_midnight(now), status="done_today", success=False)
            fallback_cd = self._fallback_cd_sec(text)
            if fallback_cd > 0:
                return _finish(until=now + fallback_cd, status="cooldown", success=False)

        if self.spec.success_patterns and _matches_any(text, self.spec.success_patterns):
            if self.spec.daily_window_utc_hour is not None:
                until = _next_daily_window(now, self.spec.daily_window_utc_hour)
            elif self.spec.daily_reset:
                until = _next_local_midnight(now)
            elif self.spec.star_duration_from_parent:
                star_cd = _star_duration_from_command(parent_cmd)
                until = now + (star_cd or self.spec.default_cd_sec)
            else:
                until = now + self.spec.default_cd_sec if self.spec.default_cd_sec > 0 else now
            return _finish(until=until, status="success", success=True)

        return None

    def _fallback_cd_sec(self, text: str) -> int:
        """解析不到具体时长时的保守兜底。"""
        if self.spec.key == "second_soul":
            if "受伤" in text:
                return 6 * 3600
            if "修炼中" in text:
                return 60 * 60
        return int(self.spec.default_cd_sec or 0)

    def compute_anchor(self, state: dict, *, now: float) -> float | None:
        cd_until = float(state.get("cooldown_until") or 0)
        if cd_until <= 0:
            return None
        return now if cd_until <= now else cd_until

    def status_summary(self, state: dict, *, now: float) -> dict:
        from backend.identity_state import fmt_remain

        cd_until = float(state.get("cooldown_until") or 0)
        status = str(state.get("last_status") or "unknown")
        detail = ""
        if self.spec.arg_label:
            detail = str(state.get(self.spec.arg_label) or "").strip()
        suffix = f" {detail}" if detail else ""
        if cd_until <= 0 and status == "unknown":
            return {"text": f"未观测{suffix}", "ready": False, "next_at": None, "status": status}
        if cd_until <= now:
            return {"text": f"已就绪{suffix}", "ready": True, "next_at": cd_until, "status": status}
        return {
            "text": f"剩 {fmt_remain(cd_until - now)}{suffix}",
            "ready": False,
            "next_at": cd_until,
            "status": status,
        }


RE_PET_TRIAL_OK = re.compile(r"【器灵试炼[·・][^】]+】")
RE_TIANTI_CLIMB_OK = re.compile(r"你消耗了\s*\d+\s*点修为[\s\S]*本次获得\s*\d+\s*点修为[、,，]\s*\d+\s*点宗门贡献")
RE_TIANTI_GANGFENG_OK = re.compile(r"【九天罡风】[\s\S]*【罡风淬体】提升至\s*\d+\s*/\s*\d+\s*层")
RE_TAIYI_NODE_OK = re.compile(r"获得[：:]\s*【空间节点[·・][^】]+】")


DEFAULT_COOLDOWN_SPECS: tuple[CooldownSpec, ...] = (
    CooldownSpec(
        key="wild_training",
        label="野外历练",
        commands=(".野外历练",),
        default_cd_sec=150 * 60,
        success_patterns=("【野外历练", "修为", "获得", "负伤", "妖兽", "灵机"),
        cooldown_patterns=("山中灵机未复", "冷却", "请在", "等待"),
    ),
    CooldownSpec(
        key="checkin",
        label="宗门点卯",
        commands=(".宗门点卯",),
        success_patterns=("点卯成功", "已点卯", "已经点过"),
        daily_window_utc_hour=2,
    ),
    CooldownSpec(
        key="tower",
        label="闯塔",
        commands=(".闯塔",),
        success_patterns=("【琉璃问心塔】", "已经闯过", "已闯塔", "已在塔中", "你今日已挑战失败，道心受挫。"),
        daily_window_utc_hour=1,
    ),
    CooldownSpec(
        key="retreat_shallow",
        label="闭关修炼",
        commands=(".闭关修炼",),
        default_cd_sec=10 * 60,
        success_patterns=("【闭关成功】",),
        cooldown_patterns=("打坐调息", "再次闭关"),
    ),
    CooldownSpec(
        key="pet_trial",
        label="器灵试炼",
        commands=(".器灵试炼",),
        default_cd_sec=8 * 3600,
        success_patterns=(RE_PET_TRIAL_OK,),
        cooldown_patterns=("器灵试炼刚结束不久", "后再启程"),
        arg_label="pet_name",
    ),
    CooldownSpec(
        key="ranch",
        label="一键放养",
        commands=(".一键放养",),
        default_cd_sec=4 * 3600 + 20 * 60,
        success_patterns=("【万兽奔腾】", "你当前没有处于【休息中】的灵兽可供放养。"),
    ),
    CooldownSpec(
        key="concubine_dream",
        label="入梦寻图",
        commands=(".入梦寻图",),
        default_cd_sec=8 * 3600,
        success_patterns=("【入梦寻图】", "【全群异闻·虚天残图】"),
        cooldown_patterns=("入梦寻图冷却",),
    ),
    CooldownSpec(
        key="concubine_tianji",
        label="天机代卜",
        commands=(".天机代卜",),
        default_cd_sec=12 * 3600,
        success_patterns=("【天机代卜链】", "情缘未至", "情缘未深", "无法为你卜算天机"),
        cooldown_patterns=("天机代卜冷却", "天机链路尚未重铸"),
    ),
    CooldownSpec(
        key="concubine_heart",
        label="共历心劫",
        commands=(".共历心劫", ".稳", ".恨", ".骗"),
        default_cd_sec=12 * 3600,
        success_patterns=("【坠魔心劫·结算】",),
        cooldown_patterns=("心劫余波未散", "共历心劫冷却"),
    ),
    CooldownSpec(
        key="stargazer_guide",
        label="牵引星辰",
        commands=(".牵引星辰",),
        default_cd_sec=6 * 3600,
        success_patterns=("牵引成功",),
        cooldown_patterns=("尚未恢复", "冷却", "等待", "不足", "休息"),
        star_duration_from_parent=True,
    ),
    CooldownSpec(
        key="stargazer_soothe",
        label="安抚星辰",
        commands=(".安抚星辰",),
        success_patterns=("安抚完成", "没有需要安抚"),
        cooldown_patterns=("尚未恢复", "冷却", "等待", "不足", "休息"),
    ),
    CooldownSpec(
        key="stargazer_collect",
        label="收集精华",
        commands=(".收集精华",),
        success_patterns=("收集完成",),
        cooldown_patterns=("尚未恢复", "冷却", "等待", "不足", "休息"),
    ),
    CooldownSpec(
        key="tianti_climb",
        label="登天阶",
        commands=(".登天阶",),
        default_cd_sec=4 * 3600,
        success_patterns=(RE_TIANTI_CLIMB_OK,),
        cooldown_patterns=("登阶冷却", "请在", "后再"),
    ),
    CooldownSpec(
        key="tianti_wenxin",
        label="问心台",
        commands=(".问心台",),
        success_patterns=("【问心台回响】", "你今日已在问心台前静坐过一次，道台不会再回应你。"),
        daily_reset=True,
    ),
    CooldownSpec(
        key="tianti_gangfeng",
        label="九天罡风",
        commands=(".引九天罡风",),
        default_cd_sec=12 * 3600,
        success_patterns=(RE_TIANTI_GANGFENG_OK,),
        cooldown_patterns=("九天罡风尚未再聚",),
    ),
    CooldownSpec(
        key="second_soul",
        label="第二元神",
        commands=(".元神修炼", ".第二元神"),
        default_cd_sec=24 * 3600,
        success_patterns=("你的第二元神已开始闭关修炼",),
        cooldown_patterns=("状态：修炼中", "状态: 修炼中", "状态：受伤", "状态: 受伤", "无法分心修炼"),
        ready_patterns=("状态：窍中温养", "状态: 窍中温养"),
    ),
    CooldownSpec(
        key="taiyi_cycle",
        label="太一周期",
        commands=(".引道", ".搜寻节点"),
        default_cd_sec=12 * 3600,
        success_patterns=("参悟大道成功", "100点神识", "【虚空漫游】", "【斩妖除魔】", "【大凶之兆】", RE_TAIYI_NODE_OK),
        cooldown_patterns=("大道感悟需循序渐进", "搜寻节点", "神游太虚", "虚空", "空间节点", "神识尚在恢复", "再行搜寻"),
    ),
)


def build_cooldown_modules() -> list[CooldownModule]:
    return [CooldownModule(spec) for spec in DEFAULT_COOLDOWN_SPECS]


__all__ = [
    "CooldownModule",
    "CooldownSpec",
    "DEFAULT_COOLDOWN_SPECS",
    "build_cooldown_modules",
]
