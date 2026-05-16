"""官方定时(Telegram scheduled message)骨架。

参考 /opt/xiuxian-main/model/official_schedule.py 的 preset + plan + batch 三层:
- preset:几个预设玩法(深度闭关 / 抚摸法宝 / 温养器灵 / 器灵试炼) + 自定义
- plan:把 preset 展开成多条带时间戳的命令(plan items)
- batch:一次「准备」记一条批次,带 N 条 scheduled_messages 子记录

mini-web 当前骨架只做:
1. preset 注册表 + plan builder(纯计算,无 IO)
2. 通过 listener 复用已登录 client,调 channels SendMessage(schedule_date=...) / GetScheduledHistory / DeleteScheduledMessages
3. 提供 dry_run 模式 — 只算 plan,不真发到 TG,方便 UI 开发和试错
"""

from __future__ import annotations

import time
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Any, Callable

# 默认锚点:现在
# 默认 horizon:3 天(对照 xiuxian-main DEFAULT_HORIZON_DAYS=3)
DEFAULT_HORIZON_DAYS = 3
SOURCE_TAG = "official_schedule"

# 命令对照 xiuxian-main config:
CMD_DEEP_RETREAT = ".深度闭关"
CMD_VIEW_RETREAT = "查看闭关"
CMD_PET_TOUCH = ".抚摸法宝"
CMD_PET_WARM = ".温养器灵"
CMD_PET_TRIAL = ".器灵试炼"
DEEP_RETREAT_CD = 8 * 3600  # 默认 8h,对应老脚本

PRESET_DEEP_RETREAT = "deep_retreat"
PRESET_PET_TOUCH = "pet_touch"
PRESET_PET_WARM = "pet_warm"
PRESET_PET_TRIAL = "pet_trial"
PRESET_CUSTOM = "custom"

PRESET_LABELS = {
    PRESET_DEEP_RETREAT: "深度闭关",
    PRESET_PET_TOUCH: "抚摸法宝",
    PRESET_PET_WARM: "温养器灵",
    PRESET_PET_TRIAL: "器灵试炼",
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
    if n > 21:
        return 21
    return n


# 排定时给 TG 时,每条 SendMessageRequest 之间睡一下。
# 用真实人类操作节奏:点输入框 → 打字 → 长按发送 → 选时间 → 确认,
# 一个熟练用户 20-40s 一条,偶尔卡顿 / 想一下要更久。
#
# 参数:
# - 短停顿 gauss(SHORT_PAUSE_MEAN, SHORT_PAUSE_STDEV) clamp [SHORT_MIN, SHORT_MAX]
#   多数条之间 20-35s
# - 每 5-10 条插一次长停顿 uniform(LONG_PAUSE_MIN, LONG_PAUSE_MAX) 60-180s
#   模拟人「停下来想想 / 看一眼别的」
#
# 估算耗时:
# - 3 天 deep_retreat ~6 条 → ~3 分钟
# - 7 天 ~14 条 → ~7-9 分钟
# - 21 天 ~60 条 → ~30-40 分钟
# 因为时间长,server 把这个跑成后台任务,前端轮询批次进度,而不是阻塞 HTTP 响应。
SHORT_PAUSE_MEAN_SEC = 28.0
SHORT_PAUSE_STDEV_SEC = 8.0
SHORT_PAUSE_MIN_SEC = 15.0
SHORT_PAUSE_MAX_SEC = 50.0
LONG_PAUSE_MIN_SEC = 60.0
LONG_PAUSE_MAX_SEC = 180.0
LONG_PAUSE_EVERY_MIN = 5
LONG_PAUSE_EVERY_MAX = 10


def humanized_send_pause(*, rng=None) -> float:
    """单条发送后的"拟人"停顿(秒)。给 server 端发 TG 时调用。"""
    import random as _random
    r = rng or _random
    val = r.gauss(SHORT_PAUSE_MEAN_SEC, SHORT_PAUSE_STDEV_SEC)
    if val < SHORT_PAUSE_MIN_SEC:
        return SHORT_PAUSE_MIN_SEC
    if val > SHORT_PAUSE_MAX_SEC:
        return SHORT_PAUSE_MAX_SEC
    return val


def humanized_long_pause(*, rng=None) -> float:
    """偶发的"长停顿",一组里几条插一次。"""
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
    return datetime.fromtimestamp(ts, timezone.utc).astimezone().strftime("%m-%d %H:%M")


# ---------- plan builders ----------

# 各 preset 的"两次发送之间"间隔 — auto_anchor 时要把 builder 看到的 anchor
# 往前推这么多,这样第一条落在「状态机算出的下次可用时间」上。
PRESET_INTERVAL_SECONDS: dict[str, int] = {
    PRESET_DEEP_RETREAT: DEEP_RETREAT_CD,
    PRESET_PET_TOUCH: 2 * 3600,
    PRESET_PET_WARM: 6 * 3600,
    PRESET_PET_TRIAL: 8 * 3600,
}


def _interval_for(preset_key: str, builder_kwargs: dict) -> int:
    if preset_key == PRESET_CUSTOM:
        return _positive_int(builder_kwargs.get("interval_sec"), 3600)
    return PRESET_INTERVAL_SECONDS.get(preset_key, 0)


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


def _build_custom(*, anchor: float, command: str, interval_sec: int, count: int, **_kw) -> list[dict]:
    command = _norm(command)
    if not command:
        return []
    interval_sec = _positive_int(interval_sec, 3600)
    count = _positive_int(count, 1)
    items = []
    # 自定义也加 jitter,避免精确等距
    for i in range(count):
        items.append({
            "command": command,
            "schedule_at": anchor + (i + 1) * interval_sec + _jitter(0),
        })
    return items


# ---------- preset registry ----------

@dataclass(frozen=True)
class PresetSpec:
    key: str
    label: str
    description: str
    # 必填字段(前端 UI 表单要根据这个动态显示)
    fields: tuple[str, ...]
    builder: Callable[..., list[dict]]


PRESETS: dict[str, PresetSpec] = {
    PRESET_DEEP_RETREAT: PresetSpec(
        key=PRESET_DEEP_RETREAT,
        label="深度闭关",
        description="trigger 触发总结/查询 → .深度闭关 配对,8h CD 后递推下一对",
        fields=("trigger_command", "horizon_days"),
        builder=_build_deep_retreat,
    ),
    PRESET_PET_TOUCH: PresetSpec(
        key=PRESET_PET_TOUCH,
        label="抚摸法宝",
        description="每 2h .抚摸法宝 <pet_name>;可选 trigger 先查 CD",
        fields=("pet_name", "trigger_command", "horizon_days"),
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
        builder=lambda **kw: _build_pet_periodic(
            command_prefix=CMD_PET_TRIAL,
            interval_sec=8 * 3600,
            **{k: v for k, v in kw.items() if k not in {"interval_sec", "command_prefix"}},
        ),
    ),
    PRESET_CUSTOM: PresetSpec(
        key=PRESET_CUSTOM,
        label="自定义",
        description="任意命令 + 间隔 + 次数,加 jitter 避免精确等距",
        fields=("command", "interval_sec", "count"),
        builder=_build_custom,
    ),
}


def list_presets() -> list[dict]:
    return [
        {
            "key": p.key,
            "label": p.label,
            "description": p.description,
            "fields": list(p.fields),
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


# ---------- Telethon-side service(对照 xiuxian-main create/list/delete_official_*) ----------

class OfficialScheduleService:
    """实际跟 Telegram 交互的部分。需要 listener manager 注入,这样能复用已登录 client。
    没 listener 的情况下,所有 Telethon 调用都失败 — 这是预期的(未登录就不能排定时)。
    """

    def __init__(self, listener_lookup: Callable[[str], object | None] | None = None):
        # listener_lookup(local_id) → TelegramReadOnlyListener or None
        # 用 callback 解耦,避免 outbox 直接 import tg.listener_manager 造成循环依赖。
        self._listener_lookup = listener_lookup or (lambda _id: None)

    def _client_for(self, account_local_id: str):
        listener = self._listener_lookup(account_local_id)
        if listener is None:
            raise RuntimeError("account 没在采集运行中,无法用其 client 排定时(需先登录并启动 listener)")
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
