"""官方定时(Telegram scheduled message)骨架。

preset + plan + batch 三层:
- preset:几个预设玩法(深度闭关 / 抚摸法宝 / 温养器灵 / 器灵试炼) + 自定义
- plan:把 preset 展开成多条带时间戳的命令(plan items)
- batch:一次「准备」记一条批次,带 N 条 scheduled_messages 子记录

骨架只做:
1. preset 注册表 + plan builder(纯计算,无 IO)
2. 优先复用 listener 的已登录 client,也允许 server 层用已登录账号开短生命周期 client,
   调 channels SendMessage(schedule_date=...) / GetScheduledHistory / DeleteScheduledMessages
3. 提供 dry_run 模式 — 只算 plan,不真发到 TG,方便 UI 开发和试错
"""

from __future__ import annotations

import time
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from typing import Any, Callable

# 默认锚点:现在
# 默认 horizon:3 天
DEFAULT_HORIZON_DAYS = 3
MAX_HORIZON_DAYS = 7
MAX_SCHEDULED_MESSAGES_PER_IDENTITY = 100
SOURCE_TAG = "official_schedule"
DISPLAY_TZ = timezone(timedelta(hours=8), "Asia/Shanghai")

CMD_DEEP_RETREAT = ".深度闭关"
CMD_VIEW_RETREAT = "查看闭关"
CMD_PET_TOUCH = ".抚摸法宝"
CMD_PET_WARM = ".温养器灵"
CMD_PET_TRIAL = ".器灵试炼"
CMD_WENDAO = ".问道"
CMD_YINDAO = ".引道"
CMD_SEARCH_NODE = ".搜寻节点"
CMD_RETREAT_SHALLOW = ".闭关修炼"
CMD_STARGAZER_GUIDE = ".牵引星辰"
CMD_STARGAZER_GUIDE_THUNDER = ".牵引星辰 天雷星"
CMD_STARGAZER_SOOTHE = ".安抚星辰"
CMD_STARGAZER_COLLECT = ".收集精华"
DEEP_RETREAT_CD = 8 * 3600  # 默认 8h
RETREAT_SHALLOW_CD = 10 * 60
RETREAT_SHALLOW_MAX_COUNT = 24
STARGAZER_THUNDER_CD = 36 * 3600

PRESET_DEEP_RETREAT = "deep_retreat"
PRESET_PET_TOUCH = "pet_touch"
PRESET_PET_WARM = "pet_warm"
PRESET_PET_TRIAL = "pet_trial"
PRESET_YUANYING = "yuanying"
PRESET_WENDAO = "wendao"
PRESET_YINDAO = "yindao"
PRESET_SEARCH_NODE = "search_node"
PRESET_CUSTOM = "custom"

PRESET_LABELS = {
    PRESET_DEEP_RETREAT: "深度闭关",
    PRESET_PET_TOUCH: "抚摸法宝",
    PRESET_PET_WARM: "温养器灵",
    PRESET_PET_TRIAL: "器灵试炼",
    PRESET_YUANYING: "元婴出窍",
    PRESET_WENDAO: "问道",
    PRESET_YINDAO: "引道",
    PRESET_SEARCH_NODE: "搜寻节点",
    PRESET_CUSTOM: "自定义",
}


# ---------- 工具 ----------

def _now() -> float:
    return time.time()


def _norm(value: object) -> str:
    return str(value or "").strip()


def _positive_int(value, default: int) -> int:
    try:
        parsed = int(value)
    except (TypeError, ValueError):
        return default
    return parsed if parsed > 0 else default


def _clamp_horizon_days(value) -> int:
    n = _positive_int(value, DEFAULT_HORIZON_DAYS)
    if n < 1:
        return 1
    if n > MAX_HORIZON_DAYS:
        return MAX_HORIZON_DAYS
    return n


# 排定时给 TG 时,每条 SendMessageRequest 之间留一个短暂停顿。
# 这里是在创建 Telegram scheduled message,不是往群里即时刷屏;
# 需要避免 API 侧连续请求过密,但不应该按真人手动排每条的分钟级节奏。
#
# 参数:
# - 短停顿 gauss(SHORT_PAUSE_MEAN, SHORT_PAUSE_STDEV) clamp [SHORT_MIN, SHORT_MAX]
#   多数条之间 1-4s
# - 每 18-28 条插一次长停顿 uniform(LONG_PAUSE_MIN, LONG_PAUSE_MAX) 6-15s
#   给 TG 端一点缓冲,同时让大批量仍在几分钟内完成
#
# 估算耗时:
# - 3 天 deep_retreat ~6 条 → ~20 秒
# - 7 天 ~14 条 → ~1 分钟
# - 上限 100 条 → ~7 分钟
# 因为时间长,server 把这个跑成后台任务,前端轮询批次进度,而不是阻塞 HTTP 响应。
SHORT_PAUSE_MEAN_SEC = 2.5
SHORT_PAUSE_STDEV_SEC = 0.8
SHORT_PAUSE_MIN_SEC = 1.0
SHORT_PAUSE_MAX_SEC = 5.0
LONG_PAUSE_MIN_SEC = 6.0
LONG_PAUSE_MAX_SEC = 15.0
LONG_PAUSE_EVERY_MIN = 18
LONG_PAUSE_EVERY_MAX = 28


def humanized_send_pause(*, rng=None) -> float:
    """单条排定时后的短暂停顿(秒)。给 server 端发 TG 时调用。"""
    import random as _random
    r = rng or _random
    val = r.gauss(SHORT_PAUSE_MEAN_SEC, SHORT_PAUSE_STDEV_SEC)
    if val < SHORT_PAUSE_MIN_SEC:
        return SHORT_PAUSE_MIN_SEC
    if val > SHORT_PAUSE_MAX_SEC:
        return SHORT_PAUSE_MAX_SEC
    return val


def humanized_long_pause(*, rng=None) -> float:
    """偶发缓冲停顿,大批量里插一次。"""
    import random as _random
    r = rng or _random
    return r.uniform(LONG_PAUSE_MIN_SEC, LONG_PAUSE_MAX_SEC)


def next_long_pause_gap(*, rng=None) -> int:
    """决定还差几条才插下一次长停顿。"""
    import random as _random
    r = rng or _random
    return r.randint(LONG_PAUSE_EVERY_MIN, LONG_PAUSE_EVERY_MAX)


def _to_float_ts(value, default: float | None = None) -> float | None:
    if value in {None, ""}:
        return default
    try:
        return float(value)
    except (TypeError, ValueError):
        return default


def _fmt_ts(ts: float) -> str:
    if not ts or ts <= 0:
        return ""
    return datetime.fromtimestamp(ts, timezone.utc).astimezone(DISPLAY_TZ).strftime("%m-%d %H:%M")


# ---------- plan builders ----------

# 配对节奏(trigger → command)的默认偏移,单位秒。
# - trigger 在 CD 走完后 +60s 才发(给系统点空隙)
# - command 在 trigger 之后再 +240s = 4min(让 bot 处理完触发返回 / 总结落地)
# - 每个偏移加 0~60s 抖动,避免节奏一眼能看出
# 用户可在 UI 覆盖(payload.trigger_delay_sec / payload.command_delay_sec)。
DEFAULT_TRIGGER_DELAY_SEC = 60
DEFAULT_COMMAND_DELAY_SEC = 240
JITTER_MAX_SEC = 60


def _jitter(seconds: float, *, rng=None) -> float:
    import random as _random
    r = rng or _random
    return seconds + r.uniform(0, JITTER_MAX_SEC)


def _build_deep_retreat(
    anchor: float,
    horizon_days: int,
    end_at: float = 0.0,
    trigger_command: str = "",
    trigger_delay_sec: float = 0,
    command_delay_sec: float = 0,
    **_kw,
) -> list[dict]:
    """深闭:trigger(触发总结/查询) → command(.深度闭关) 配对,
    下一对的 trigger 基于上一对 command 时间 + 8h + jitter,**不是**死按 anchor + N*8h 节拍点。

    用户可改 trigger_command(默认「查看闭关」)。
    """
    end = float(end_at) if end_at and end_at > 0 else (anchor + horizon_days * 86400)
    trigger_cmd = (trigger_command or CMD_VIEW_RETREAT).strip() or CMD_VIEW_RETREAT
    trigger_delay = float(trigger_delay_sec) if trigger_delay_sec and trigger_delay_sec > 0 else DEFAULT_TRIGGER_DELAY_SEC
    command_delay = float(command_delay_sec) if command_delay_sec and command_delay_sec > 0 else DEFAULT_COMMAND_DELAY_SEC
    items: list[dict] = []

    # 第一对从 anchor 起步(anchor 已经是「下次可发时间」,无需再 +CD)
    trigger_at = anchor + _jitter(trigger_delay)
    command_at = trigger_at + _jitter(command_delay)
    while command_at <= end:
        items.append({"command": trigger_cmd, "schedule_at": trigger_at})
        items.append({"command": CMD_DEEP_RETREAT, "schedule_at": command_at})
        # 下一对:基于刚才 command + 8h CD + jitter
        trigger_at = command_at + DEEP_RETREAT_CD + _jitter(trigger_delay)
        command_at = trigger_at + _jitter(command_delay)
    return items


def _build_pet_periodic(
    *, anchor: float, horizon_days: int, command_prefix: str, pet_name: str,
    interval_sec: int, end_at: float = 0.0,
    trigger_command: str = "", trigger_delay_sec: float = 0, command_delay_sec: float = 0,
    **_kw,
) -> list[dict]:
    """法宝类:同样支持 trigger 步(可选),触发词为空就直接发 command,
    递推 anchor:下次 command = 上次 command + interval + jitter。"""
    end = float(end_at) if end_at and end_at > 0 else (anchor + horizon_days * 86400)
    command = command_prefix
    pet = _norm(pet_name)
    if pet:
        command = f"{command_prefix} {pet}"
    trigger_cmd = (trigger_command or "").strip()
    trigger_delay = float(trigger_delay_sec) if trigger_delay_sec and trigger_delay_sec > 0 else DEFAULT_TRIGGER_DELAY_SEC
    command_delay = float(command_delay_sec) if command_delay_sec and command_delay_sec > 0 else DEFAULT_COMMAND_DELAY_SEC
    items: list[dict] = []
    last_command_at = anchor - interval_sec  # 让第一条 command 就落在 anchor 附近
    while True:
        # 下一个 command 基于上一次 command + interval + jitter
        if trigger_cmd:
            trigger_at = last_command_at + interval_sec + _jitter(trigger_delay)
            command_at = trigger_at + _jitter(command_delay)
            if command_at > end:
                break
            items.append({"command": trigger_cmd, "schedule_at": trigger_at})
            items.append({"command": command, "schedule_at": command_at})
        else:
            command_at = last_command_at + interval_sec + _jitter(trigger_delay + command_delay)
            if command_at > end:
                break
            items.append({"command": command, "schedule_at": command_at})
        last_command_at = command_at
    return items


def _split_commands(command: str) -> list[str]:
    raw = str(command or "").replace("；", "\n").replace(";", "\n")
    out: list[str] = []
    for line in raw.splitlines():
        item = _norm(line)
        if not item:
            continue
        out.append(item)
    return out


def _build_fixed_periodic(
    *, anchor: float, horizon_days: int, command_prefix: str, interval_sec: int,
    command: str = "", end_at: float = 0.0, trigger_command: str = "", default_trigger_command: str = "",
    trigger_delay_sec: float = 0, command_delay_sec: float = 0, **_kw,
) -> list[dict]:
    return _build_pet_periodic(
        anchor=anchor,
        horizon_days=horizon_days,
        command_prefix=_norm(command) or command_prefix,
        pet_name="",
        interval_sec=interval_sec,
        end_at=end_at,
        trigger_command=trigger_command or default_trigger_command,
        trigger_delay_sec=trigger_delay_sec,
        command_delay_sec=command_delay_sec,
    )


def _build_custom(
    *, anchor: float, command: str, interval_sec: int, count: int,
    command_gap_sec: int = 180, horizon_days: int = DEFAULT_HORIZON_DAYS,
    end_at: float = 0.0, **_kw,
) -> list[dict]:
    commands = _split_commands(command)
    if not commands:
        return []
    interval_sec = _positive_int(interval_sec, 3600)
    count = _positive_int(count, 1)
    command_gap_sec = max(30, min(3600, _positive_int(command_gap_sec, 180)))
    # 红线护栏: 自定义与其它 preset 一样, 不得超过 7 天窗口、单批不超过 100 条。
    # 否则 count×interval 能把官方定时排到任意远的未来, 绕过"一次最多 7 天"上限。
    count = min(count, MAX_SCHEDULED_MESSAGES_PER_IDENTITY)
    horizon_end = (
        float(end_at)
        if end_at and end_at > 0
        else (anchor + _clamp_horizon_days(horizon_days) * 86400)
    )
    items = []
    # 自定义支持多条命令:count 表示轮数;每轮内部按 command_gap_sec 错开。
    # 每条加少量 jitter,避免精确等距。
    for round_index in range(count):
        base_at = anchor + round_index * interval_sec
        for command_index, item_command in enumerate(commands):
            schedule_at = base_at + command_index * command_gap_sec + _jitter(0)
            if schedule_at > horizon_end:
                return items
            items.append({
                "command": item_command,
                "schedule_at": schedule_at,
            })
            if len(items) >= MAX_SCHEDULED_MESSAGES_PER_IDENTITY:
                return items
    return items


def _safe_command_gap(value, default: int = 180) -> int:
    return max(30, min(3600, _positive_int(value, default)))


def _safe_base_delay(trigger_delay_sec: float = 0, command_delay_sec: float = 0) -> float:
    trigger_delay = (
        float(trigger_delay_sec)
        if trigger_delay_sec and trigger_delay_sec > 0
        else DEFAULT_TRIGGER_DELAY_SEC
    )
    command_delay = (
        float(command_delay_sec)
        if command_delay_sec and command_delay_sec > 0
        else DEFAULT_COMMAND_DELAY_SEC
    )
    return trigger_delay + command_delay


def _build_counted_periodic(
    *, anchor: float, horizon_days: int, command_prefix: str, interval_sec: int,
    count: int = 1, max_count: int = MAX_SCHEDULED_MESSAGES_PER_IDENTITY,
    end_at: float = 0.0, trigger_delay_sec: float = 0, command_delay_sec: float = 0,
    **_kw,
) -> list[dict]:
    end = float(end_at) if end_at and end_at > 0 else (anchor + horizon_days * 86400)
    command = _norm(command_prefix)
    if not command:
        return []
    interval_sec = _positive_int(interval_sec, 3600)
    count = min(_positive_int(count, 1), max(1, int(max_count or 1)), MAX_SCHEDULED_MESSAGES_PER_IDENTITY)
    base_delay = _safe_base_delay(trigger_delay_sec, command_delay_sec)
    items: list[dict] = []
    last_command_at = anchor - interval_sec
    while len(items) < count:
        schedule_at = last_command_at + interval_sec + _jitter(base_delay)
        if schedule_at > end:
            break
        items.append({"command": command, "schedule_at": schedule_at})
        last_command_at = schedule_at
    return items


def _build_combo_rounds(
    *, anchor: float, horizon_days: int, commands: tuple[str, ...], interval_sec: int,
    command_gap_sec: int = 180, end_at: float = 0.0,
    trigger_delay_sec: float = 0, command_delay_sec: float = 0, **_kw,
) -> list[dict]:
    command_list = tuple(c for c in (_norm(c) for c in commands) if c)
    if not command_list:
        return []
    end = float(end_at) if end_at and end_at > 0 else (anchor + horizon_days * 86400)
    interval_sec = _positive_int(interval_sec, 24 * 3600)
    gap = _safe_command_gap(command_gap_sec)
    base_delay = _safe_base_delay(trigger_delay_sec, command_delay_sec)
    items: list[dict] = []
    last_round_at = anchor - interval_sec
    while True:
        round_at = last_round_at + interval_sec + _jitter(base_delay)
        if round_at > end:
            break
        for index, command in enumerate(command_list):
            schedule_at = round_at + index * gap + _jitter(0)
            if schedule_at > end:
                return items
            items.append({"command": command, "schedule_at": schedule_at})
            if len(items) >= MAX_SCHEDULED_MESSAGES_PER_IDENTITY:
                return items
        last_round_at = round_at
    return items


def _build_mixed_periodic(
    *, anchor: float, horizon_days: int, streams: tuple[dict, ...],
    end_at: float = 0.0, trigger_delay_sec: float = 0, command_delay_sec: float = 0,
    **_kw,
) -> list[dict]:
    end = float(end_at) if end_at and end_at > 0 else (anchor + horizon_days * 86400)
    base_delay = _safe_base_delay(trigger_delay_sec, command_delay_sec)
    items: list[dict] = []
    for stream in streams:
        command = _norm(stream.get("command"))
        interval_sec = _positive_int(stream.get("interval_sec"), 0)
        if not command or interval_sec <= 0:
            continue
        try:
            offset_sec = float(stream.get("offset_sec") or 0)
        except (TypeError, ValueError):
            offset_sec = 0.0
        last_command_at = anchor + offset_sec - interval_sec
        while True:
            schedule_at = last_command_at + interval_sec + _jitter(base_delay)
            if schedule_at > end:
                break
            items.append({"command": command, "schedule_at": schedule_at})
            last_command_at = schedule_at
            if len(items) >= MAX_SCHEDULED_MESSAGES_PER_IDENTITY:
                break
        if len(items) >= MAX_SCHEDULED_MESSAGES_PER_IDENTITY:
            break
    items.sort(key=lambda item: float(item.get("schedule_at") or 0))
    return items[:MAX_SCHEDULED_MESSAGES_PER_IDENTITY]


# ---------- preset registry ----------

@dataclass(frozen=True)
class PresetSpec:
    key: str
    label: str
    description: str
    # 必填字段(前端 UI 表单要根据这个动态显示)
    fields: tuple[str, ...]
    builder: Callable[..., list[dict]]
    module_key: str = ""


SCHEDULE_PRESET_UI_META: dict[str, dict[str, Any]] = {
    PRESET_CUSTOM: {"category": "custom", "shape": "custom", "tags": ["联动", "多命令"], "automation": "manual"},
    PRESET_DEEP_RETREAT: {"category": "phase", "shape": "phase_pair", "tags": ["阶段型", "需确认"], "renewable": True, "automation": "renewable"},
    PRESET_YUANYING: {"category": "phase", "shape": "phase_pair", "tags": ["阶段型", "需确认"], "automation": "manual"},
    PRESET_PET_TOUCH: {"category": "fabao", "shape": "single", "tags": ["法宝"]},
    PRESET_PET_WARM: {"category": "fabao", "shape": "single", "tags": ["法宝"]},
    PRESET_PET_TRIAL: {"category": "fabao", "shape": "single", "tags": ["法宝"]},
    "retreat_shallow": {"category": "daily", "shape": "counted", "tags": ["小批量", "高频"]},
    "wild_training": {"category": "daily", "shape": "single", "tags": ["常用"], "renewable": True},
    "checkin": {"category": "daily", "shape": "daily", "tags": ["每日"], "renewable": True},
    "tower": {"category": "daily", "shape": "daily", "tags": ["每日"], "renewable": True},
    "daily_check_core": {"category": "package", "shape": "combo_rounds", "tags": ["联动包", "每日"], "renewable": True},
    "daily_essentials": {"category": "package", "shape": "combo_rounds", "tags": ["联动包", "每日"], "renewable": True},
    "ranch": {"category": "sect", "shape": "single", "tags": ["万灵宗"], "renewable": True},
    "concubine_dream": {"category": "concubine", "shape": "single", "tags": ["侍妾"], "renewable": True},
    "concubine_tianji": {"category": "concubine", "shape": "single", "tags": ["侍妾"], "renewable": True},
    "concubine_cycle": {"category": "package", "shape": "mixed_periodic", "tags": ["侍妾", "联动包"], "automation": "manual"},
    "stargazer_guide": {"category": "sect", "shape": "single", "tags": ["星宫", "需参数"], "automation": "manual"},
    "stargazer_soothe": {"category": "sect", "shape": "single", "tags": ["星宫", "需状态"], "automation": "manual"},
    "stargazer_collect": {"category": "sect", "shape": "single", "tags": ["星宫", "需状态"], "automation": "manual"},
    "stargazer_care": {"category": "package", "shape": "combo_rounds", "tags": ["星宫", "联动包"], "automation": "manual"},
    "stargazer_bamboo_thunder": {"category": "package", "shape": "mixed_periodic", "tags": ["星宫", "天雷星", "联动包"], "automation": "manual"},
    "tianti_climb": {"category": "sect", "shape": "single", "tags": ["凌霄宫"]},
    "tianti_climb_elder": {"category": "sect", "shape": "single", "tags": ["凌霄宫", "长老"]},
    "tianti_wenxin": {"category": "sect", "shape": "daily", "tags": ["凌霄宫", "每日"], "renewable": True},
    "tianti_gangfeng": {"category": "sect", "shape": "single", "tags": ["凌霄宫"], "renewable": True},
    "lingxiao_standard": {"category": "package", "shape": "mixed_periodic", "tags": ["凌霄宫", "联动包"], "renewable": True},
    "lingxiao_elder": {"category": "package", "shape": "mixed_periodic", "tags": ["凌霄宫", "长老", "联动包"], "renewable": True},
    "second_soul": {"category": "sect", "shape": "daily", "tags": ["元神"], "renewable": True},
    PRESET_WENDAO: {"category": "sect", "shape": "single", "tags": ["问道"], "renewable": True},
    PRESET_YINDAO: {"category": "sect", "shape": "single", "tags": ["引道"], "renewable": True},
    PRESET_SEARCH_NODE: {"category": "phase", "shape": "single", "tags": ["需接力"], "automation": "manual_followup"},
    "taiyi_cycle": {"category": "sect", "shape": "single", "tags": ["太一门"], "renewable": True},
    "taiyi_patrol": {"category": "package", "shape": "combo_rounds", "tags": ["太一门", "联动包", "需接力"], "automation": "manual_followup"},
}


def _preset_ui_meta(preset: PresetSpec) -> dict:
    meta = dict(SCHEDULE_PRESET_UI_META.get(preset.key) or {})
    fields = set(preset.fields)
    if "category" not in meta:
        meta["category"] = "custom" if preset.key == PRESET_CUSTOM else "daily"
    if "shape" not in meta:
        if preset.key == PRESET_CUSTOM:
            meta["shape"] = "custom"
        elif "command_gap_sec" in fields:
            meta["shape"] = "combo_rounds"
        elif "trigger_command" in fields:
            meta["shape"] = "phase_pair"
        elif "count" in fields:
            meta["shape"] = "counted"
        else:
            meta["shape"] = "single"
    meta.setdefault("tags", [])
    meta["renewable"] = bool(meta.get("renewable", False))
    meta.setdefault("automation", "renewable" if meta["renewable"] else "manual")
    return meta


def _fixed_preset(
    *,
    key: str,
    label: str,
    command: str,
    interval_sec: int,
    description: str,
    module_key: str | None = None,
    fields: tuple[str, ...] = ("horizon_days",),
    default_trigger_command: str = "",
) -> PresetSpec:
    return PresetSpec(
        key=key,
        label=label,
        description=description,
        fields=fields,
        module_key=module_key or key,
        builder=lambda **kw: _build_fixed_periodic(
            command_prefix=command,
            interval_sec=interval_sec,
            default_trigger_command=default_trigger_command,
            **{k: v for k, v in kw.items() if k not in {"interval_sec", "command_prefix", "default_trigger_command"}},
        ),
    )


PRESETS: dict[str, PresetSpec] = {
    PRESET_CUSTOM: PresetSpec(
        key=PRESET_CUSTOM,
        label="自定义",
        description="一条或多条命令 + 间隔 + 轮数,批量排进官方定时",
        fields=("command", "interval_sec", "count", "command_gap_sec", "horizon_days"),
        builder=_build_custom,
    ),
    PRESET_DEEP_RETREAT: PresetSpec(
        key=PRESET_DEEP_RETREAT,
        label="深度闭关",
        description="trigger 触发总结/查询 → .深度闭关 配对,8h CD 后递推下一对",
        fields=("trigger_command", "horizon_days"),
        module_key="deep_retreat",
        builder=_build_deep_retreat,
    ),
    PRESET_YUANYING: _fixed_preset(
        key=PRESET_YUANYING,
        label="元婴出窍",
        command=".元婴出窍",
        interval_sec=8 * 3600,
        description=".元婴状态 → .元婴出窍 配对,8h 后递推下一轮",
        fields=("trigger_command", "horizon_days"),
        default_trigger_command=".元婴状态",
    ),
    PRESET_PET_TOUCH: PresetSpec(
        key=PRESET_PET_TOUCH,
        label="抚摸法宝",
        description="每 2h .抚摸法宝 <pet_name>;可选 trigger 先查 CD",
        fields=("pet_name", "trigger_command", "horizon_days"),
        module_key="pet_touch",
        builder=lambda **kw: _build_pet_periodic(
            command_prefix=CMD_PET_TOUCH,
            interval_sec=2 * 3600,
            **{k: v for k, v in kw.items() if k not in {"interval_sec", "command_prefix"}},
        ),
    ),
    PRESET_PET_WARM: PresetSpec(
        key=PRESET_PET_WARM,
        label="温养器灵",
        description="每 6h .温养器灵 <pet_name>;可选 trigger 先查 CD",
        fields=("pet_name", "trigger_command", "horizon_days"),
        module_key="pet_warm",
        builder=lambda **kw: _build_pet_periodic(
            command_prefix=CMD_PET_WARM,
            interval_sec=6 * 3600,
            **{k: v for k, v in kw.items() if k not in {"interval_sec", "command_prefix"}},
        ),
    ),
    PRESET_PET_TRIAL: PresetSpec(
        key=PRESET_PET_TRIAL,
        label="器灵试炼",
        description="每 8h .器灵试炼 <pet_name>;可选 trigger 先查 CD",
        fields=("pet_name", "trigger_command", "horizon_days"),
        module_key="pet_trial",
        builder=lambda **kw: _build_pet_periodic(
            command_prefix=CMD_PET_TRIAL,
            interval_sec=8 * 3600,
            **{k: v for k, v in kw.items() if k not in {"interval_sec", "command_prefix"}},
        ),
    ),
    "retreat_shallow": PresetSpec(
        key="retreat_shallow",
        label="闭关修炼·小批量",
        description="10min CD 小批量闭关;次数可填,单批最多 24 次",
        fields=("count",),
        module_key="retreat_shallow",
        builder=lambda **kw: _build_counted_periodic(
            command_prefix=CMD_RETREAT_SHALLOW,
            interval_sec=RETREAT_SHALLOW_CD,
            max_count=RETREAT_SHALLOW_MAX_COUNT,
            **{k: v for k, v in kw.items() if k not in {"command_prefix", "interval_sec", "max_count"}},
        ),
    ),
    "wild_training": _fixed_preset(
        key="wild_training",
        label="野外历练",
        command=".野外历练",
        interval_sec=150 * 60,
        description="按野外历练状态机起点,约 150 分钟一轮",
    ),
    "checkin": _fixed_preset(
        key="checkin",
        label="宗门点卯",
        command=".宗门点卯",
        interval_sec=24 * 3600,
        description="按点卯状态机/每日窗口,一天一轮",
    ),
    "tower": _fixed_preset(
        key="tower",
        label="闯塔",
        command=".闯塔",
        interval_sec=24 * 3600,
        description="按闯塔状态机/每日窗口,一天一轮",
    ),
    "daily_check_core": PresetSpec(
        key="daily_check_core",
        label="点卯闯塔",
        description="宗门点卯/闯塔,每天错峰一轮",
        fields=("horizon_days", "command_gap_sec"),
        module_key="checkin",
        builder=lambda **kw: _build_combo_rounds(
            commands=(".宗门点卯", ".闯塔"),
            interval_sec=24 * 3600,
            **{k: v for k, v in kw.items() if k not in {"commands", "interval_sec"}},
        ),
    ),
    "daily_essentials": PresetSpec(
        key="daily_essentials",
        label="每日包",
        description="点卯/闯塔/问心台/第二元神,每天错峰一轮",
        fields=("horizon_days", "command_gap_sec"),
        builder=lambda **kw: _build_combo_rounds(
            commands=(".宗门点卯", ".闯塔", ".问心台", ".元神修炼"),
            interval_sec=24 * 3600,
            **{k: v for k, v in kw.items() if k not in {"commands", "interval_sec"}},
        ),
    ),
    "ranch": _fixed_preset(
        key="ranch",
        label="一键放养",
        command=".一键放养",
        interval_sec=4 * 3600 + 20 * 60,
        description="按一键放养状态机起点,约 4h20m 一轮",
    ),
    "concubine_dream": _fixed_preset(
        key="concubine_dream",
        label="入梦寻图",
        command=".入梦寻图",
        interval_sec=8 * 3600,
        description="按入梦寻图状态机起点,8h 一轮",
    ),
    "concubine_tianji": _fixed_preset(
        key="concubine_tianji",
        label="天机代卜",
        command=".天机代卜",
        interval_sec=12 * 3600,
        description="按天机代卜状态机起点,12h 一轮",
    ),
    "concubine_cycle": PresetSpec(
        key="concubine_cycle",
        label="侍妾图卜",
        description="入梦寻图 8h / 天机代卜 12h,错峰排",
        fields=("horizon_days",),
        module_key="concubine_tianji",
        builder=lambda **kw: _build_mixed_periodic(
            streams=(
                {"command": ".入梦寻图", "interval_sec": 8 * 3600, "offset_sec": 0},
                {"command": ".天机代卜", "interval_sec": 12 * 3600, "offset_sec": 240},
            ),
            **{k: v for k, v in kw.items() if k != "streams"},
        ),
    ),
    "stargazer_guide": _fixed_preset(
        key="stargazer_guide",
        label="牵引星辰",
        command=CMD_STARGAZER_GUIDE,
        interval_sec=6 * 3600,
        description="裸牵引入口;需要星名时请用自定义或天雷星种竹",
    ),
    "stargazer_soothe": _fixed_preset(
        key="stargazer_soothe",
        label="安抚星辰",
        command=CMD_STARGAZER_SOOTHE,
        interval_sec=6 * 3600,
        description="按安抚星辰状态机起点,6h 巡查一轮",
    ),
    "stargazer_collect": _fixed_preset(
        key="stargazer_collect",
        label="收集精华",
        command=CMD_STARGAZER_COLLECT,
        interval_sec=6 * 3600,
        description="按收集精华状态机起点,6h 巡查一轮",
    ),
    "stargazer_care": PresetSpec(
        key="stargazer_care",
        label="星宫维护",
        description="牵引/安抚/收集三件套,每 6h 错峰一轮",
        fields=("horizon_days", "command_gap_sec"),
        builder=lambda **kw: _build_combo_rounds(
            commands=(CMD_STARGAZER_GUIDE, CMD_STARGAZER_SOOTHE, CMD_STARGAZER_COLLECT),
            interval_sec=6 * 3600,
            **{k: v for k, v in kw.items() if k not in {"commands", "interval_sec"}},
        ),
    ),
    "stargazer_bamboo_thunder": PresetSpec(
        key="stargazer_bamboo_thunder",
        label="金雷竹·天雷星",
        description="牵引天雷星/安抚/收集,按天雷星长周期错峰排",
        fields=("horizon_days",),
        module_key="stargazer_guide",
        builder=lambda **kw: _build_mixed_periodic(
            streams=(
                {"command": CMD_STARGAZER_GUIDE_THUNDER, "interval_sec": STARGAZER_THUNDER_CD, "offset_sec": 0},
                {"command": CMD_STARGAZER_SOOTHE, "interval_sec": STARGAZER_THUNDER_CD, "offset_sec": 180},
                {"command": CMD_STARGAZER_COLLECT, "interval_sec": STARGAZER_THUNDER_CD, "offset_sec": 360},
            ),
            **{k: v for k, v in kw.items() if k != "streams"},
        ),
    ),
    "tianti_climb": _fixed_preset(
        key="tianti_climb",
        label="登天阶",
        command=".登天阶",
        interval_sec=4 * 3600,
        description="按登天阶状态机起点,4h 一轮",
    ),
    "tianti_climb_elder": _fixed_preset(
        key="tianti_climb_elder",
        label="登天阶·长老",
        command=".登天阶",
        interval_sec=3 * 3600,
        description="按登天阶状态机起点,长老 3h 一轮",
        module_key="tianti_climb",
    ),
    "tianti_wenxin": _fixed_preset(
        key="tianti_wenxin",
        label="问心台",
        command=".问心台",
        interval_sec=24 * 3600,
        description="按问心台状态机/每日重置,一天一轮",
    ),
    "tianti_gangfeng": _fixed_preset(
        key="tianti_gangfeng",
        label="九天罡风",
        command=".引九天罡风",
        interval_sec=12 * 3600,
        description="按九天罡风状态机起点,12h 一轮",
    ),
    "lingxiao_standard": PresetSpec(
        key="lingxiao_standard",
        label="凌霄宫·标准",
        description="登天阶 4h / 九天罡风 12h / 问心台每日,错峰排",
        fields=("horizon_days",),
        module_key="tianti_climb",
        builder=lambda **kw: _build_mixed_periodic(
            streams=(
                {"command": ".登天阶", "interval_sec": 4 * 3600, "offset_sec": 0},
                {"command": ".引九天罡风", "interval_sec": 12 * 3600, "offset_sec": 180},
                {"command": ".问心台", "interval_sec": 24 * 3600, "offset_sec": 360},
            ),
            **{k: v for k, v in kw.items() if k != "streams"},
        ),
    ),
    "lingxiao_elder": PresetSpec(
        key="lingxiao_elder",
        label="凌霄宫·长老",
        description="登天阶 3h / 九天罡风 12h / 问心台每日,错峰排",
        fields=("horizon_days",),
        module_key="tianti_climb",
        builder=lambda **kw: _build_mixed_periodic(
            streams=(
                {"command": ".登天阶", "interval_sec": 3 * 3600, "offset_sec": 0},
                {"command": ".引九天罡风", "interval_sec": 12 * 3600, "offset_sec": 180},
                {"command": ".问心台", "interval_sec": 24 * 3600, "offset_sec": 360},
            ),
            **{k: v for k, v in kw.items() if k != "streams"},
        ),
    ),
    "second_soul": _fixed_preset(
        key="second_soul",
        label="第二元神",
        command=".元神修炼",
        interval_sec=24 * 3600,
        description="按第二元神状态机起点,一天一轮",
    ),
    PRESET_WENDAO: _fixed_preset(
        key=PRESET_WENDAO,
        label="问道",
        command=CMD_WENDAO,
        interval_sec=12 * 3600,
        description="按问道状态机起点,12h 一轮",
    ),
    PRESET_YINDAO: _fixed_preset(
        key=PRESET_YINDAO,
        label="引道",
        command=CMD_YINDAO,
        interval_sec=12 * 3600,
        description="按引道状态机起点,12h 一轮;如状态记录了属性则自动带上属性",
    ),
    PRESET_SEARCH_NODE: _fixed_preset(
        key=PRESET_SEARCH_NODE,
        label="搜寻节点",
        command=CMD_SEARCH_NODE,
        interval_sec=12 * 3600,
        description="按搜寻节点状态机起点,12h 一轮;定星后续仍需人工确认",
    ),
    "taiyi_cycle": _fixed_preset(
        key="taiyi_cycle",
        label="太一周期",
        command=".引道",
        interval_sec=12 * 3600,
        description="按太一周期状态机起点,12h 一轮",
    ),
    "taiyi_patrol": PresetSpec(
        key="taiyi_patrol",
        label="太一巡检",
        description="引道/搜寻节点,每 12h 错峰一轮;定星后续仍需人工确认",
        fields=("horizon_days", "command_gap_sec"),
        module_key="taiyi_cycle",
        builder=lambda **kw: _build_combo_rounds(
            commands=(CMD_YINDAO, CMD_SEARCH_NODE),
            interval_sec=12 * 3600,
            **{k: v for k, v in kw.items() if k not in {"commands", "interval_sec"}},
        ),
    ),
}


def list_presets() -> list[dict]:
    return [
        {
            "key": p.key,
            "label": p.label,
            "description": p.description,
            "fields": list(p.fields),
            "module_key": p.module_key,
            "ui": _preset_ui_meta(p),
        }
        for p in PRESETS.values()
    ]


def build_plan(payload: dict, *, anchor_resolver: Callable[[int, str], float | None] | None = None) -> dict:
    """payload: {preset_key, anchor_at?, horizon_days?, pet_name?, command?, interval_sec?, count?,
                 auto_anchor?, auto_anchor_module?, auto_anchor_send_as_id?,
                 trigger_command?, trigger_delay_sec?, command_delay_sec?, offset_minutes?}

    auto_anchor 流程
    ----------------
    如果 payload.auto_anchor=True 且传了 anchor_resolver(send_as_id, module_key) -> ts | None,
    会拿对应 module 的 compute_anchor 当 anchor 起点。模块没观测过(返 None)就回退到
    payload.anchor_at,再回退到 now。这样深闭/抚摸/温养可以「跟着实际 CD 排」,
    而不是死按用户填的时间。

    offset_minutes
    --------------
    多账号错峰用。整批 plan 在 anchor 之上额外往后推 N 分钟,推荐每个账号差几分钟,
    避免同一时刻多个身份对天尊同时发指令(他处理不过来)。
    """
    key = _norm(payload.get("preset_key") or payload.get("template_key"))
    if key not in PRESETS:
        raise ValueError(f"未知的 preset:{key}")
    spec = PRESETS[key]
    user_anchor = _to_float_ts(payload.get("anchor_at"), default=_now()) or _now()
    anchor = user_anchor
    auto_anchor_used = False
    auto_anchor_source: dict | None = None

    if payload.get("auto_anchor") and anchor_resolver:
        module_key = _norm(payload.get("auto_anchor_module") or key)
        try:
            send_as_id = int(payload.get("auto_anchor_send_as_id") or payload.get("send_as_id") or 0)
        except (TypeError, ValueError):
            send_as_id = 0
        if send_as_id:
            try:
                resolved = anchor_resolver(send_as_id, module_key)
            except Exception:
                resolved = None
            if resolved and resolved > 0:
                # 取「用户锚点 / module 算出的下一次可用」中较晚那个,避免排到过去。
                anchor = max(anchor, float(resolved))
                auto_anchor_used = True
                auto_anchor_source = {
                    "module_key": module_key,
                    "send_as_id": send_as_id,
                    "resolved_at": float(resolved),
                }

    # 多账号错峰:整批整体推后 offset_minutes 分钟,1-720 范围(0-12h)。
    offset_minutes = max(0, min(720, _positive_int(payload.get("offset_minutes"), 0)))
    if offset_minutes > 0:
        anchor = anchor + offset_minutes * 60

    horizon_days = _clamp_horizon_days(payload.get("horizon_days") or DEFAULT_HORIZON_DAYS)
    builder_kwargs = {
        "anchor": anchor,
        "horizon_days": horizon_days,
        "pet_name": payload.get("pet_name") or "",
        "command": payload.get("command") or "",
        "interval_sec": _positive_int(payload.get("interval_sec"), 3600),
        "count": _positive_int(payload.get("count"), 1),
        "command_gap_sec": _positive_int(payload.get("command_gap_sec"), 180),
        "trigger_command": _norm(payload.get("trigger_command")),
        "trigger_delay_sec": _positive_int(payload.get("trigger_delay_sec"), 0),
        "command_delay_sec": _positive_int(payload.get("command_delay_sec"), 0),
    }
    # auto_anchor:新的 _build_deep_retreat / _build_pet_periodic 都把 anchor
    # 当作「下次可发时间」(first_command = anchor + jitter),不再需要往前推 interval。
    # 只钉 end_at 防 horizon 缩水。
    if auto_anchor_used:
        builder_kwargs["end_at"] = anchor + horizon_days * 86400
    items = spec.builder(**builder_kwargs)
    # 统一红线兜底: 任何 preset 产出都不超过单身份 100 条上限。
    items = items[:MAX_SCHEDULED_MESSAGES_PER_IDENTITY]
    first_due_at = float(items[0]["schedule_at"]) if items else 0.0
    return {
        "preset_key": spec.key,
        "preset_label": spec.label,
        "anchor_at": anchor,
        "anchor_text": _fmt_ts(anchor),
        "first_due_at": first_due_at,
        "first_due_text": _fmt_ts(first_due_at),
        "user_anchor_at": user_anchor,
        "auto_anchor_used": auto_anchor_used,
        "auto_anchor_source": auto_anchor_source,
        "horizon_days": horizon_days,
        "items": [
            {
                **item,
                "schedule_text": _fmt_ts(item.get("schedule_at") or 0),
            }
            for item in items
        ],
    }


# ---------- Telethon-side service ----------

class OfficialScheduleService:
    """实际跟 Telegram 交互的低层方法。

    这里只提供 listener client 复用和已连接 client 上的 Telegram 调用。
    没有 listener 时,server 层可以用已登录账号打开短生命周期 client。
    """

    def __init__(self, listener_lookup: Callable[[str], object | None] | None = None):
        # listener_lookup(local_id) → TelegramReadOnlyListener or None
        # 用 callback 解耦,避免 outbox 直接 import tg.listener_manager 造成循环依赖。
        self._listener_lookup = listener_lookup or (lambda _id: None)

    def _client_for(self, account_local_id: str):
        listener = self._listener_lookup(account_local_id)
        if listener is None:
            raise RuntimeError("该账号当前没有可复用 listener client")
        return listener

    async def create_one_on_client(
        self, client, *, peer, send_as_peer, reply_to, command: str, schedule_at: float
    ) -> int:
        """在已连接的 client 上排一条。返回 Telegram 给的 scheduled_msg_id(>0 表示成功)。"""
        from telethon import functions
        from datetime import datetime as _dt, timezone as _tz

        schedule_dt = _dt.fromtimestamp(float(schedule_at), tz=_tz.utc)
        result = await client(
            functions.messages.SendMessageRequest(
                peer=peer,
                message=command,
                reply_to=reply_to,
                send_as=send_as_peer,
                schedule_date=schedule_dt,
            )
        )
        updates = getattr(result, "updates", []) or []
        for update in updates:
            mid = getattr(update, "id", 0)
            if mid:
                return int(mid)
        return 0

    async def list_on_client(self, client, *, peer) -> list[dict]:
        from telethon import functions

        result = await client(functions.messages.GetScheduledHistoryRequest(peer=peer, hash=0))
        out = []
        for message in (getattr(result, "messages", None) or []):
            date = getattr(message, "date", None)
            ts = date.timestamp() if hasattr(date, "timestamp") else 0
            out.append(
                {
                    "scheduled_msg_id": int(getattr(message, "id", 0) or 0),
                    "message": str(getattr(message, "message", "") or ""),
                    "schedule_at": ts,
                    "schedule_text": _fmt_ts(ts),
                }
            )
        return out

    async def delete_on_client(self, client, *, peer, scheduled_msg_ids: list[int]) -> int:
        from telethon import functions

        ids = [int(x) for x in (scheduled_msg_ids or []) if int(x or 0) > 0]
        if not ids:
            return 0
        await client(functions.messages.DeleteScheduledMessagesRequest(peer=peer, id=ids))
        return len(ids)


def fmt_ts(ts: float) -> str:
    """对外暴露的格式化函数(server.py 在 list_local payload 用)。"""
    return _fmt_ts(ts)
