from __future__ import annotations

import re
from datetime import datetime, timedelta, timezone

from backend.domain.models import RawMessageEvent

CMD_DIVINATION = ".卜筮问天"
CMD_DIVINATION_EXCHANGE = ".换取"
DIVINATION_DEFAULT_DAILY_LIMIT = 6
TZ_LOCAL = timezone(timedelta(hours=8))

RE_DAILY_COUNT = re.compile(r"今日第\s*(\d+)\s*次")
RE_DAILY_LIMIT = re.compile(r"今日.*?(?:次数|问天|窥探).*?(?:已满|已达|达到|上限|用尽)|(?:已满|已达|达到).*?今日.*?(?:次数|上限)")
RE_HEXAGRAM = re.compile(r"【卦象[：:]\s*([^】]+)】|得卦【([^】]+)】")
RE_TREASURE = re.compile(r"卦象显示[，,、\s]*【([^】]+)】")
RE_COST = re.compile(r"【?([^【】\sx×*＊,，、]+)】?\s*[x×*＊]\s*([\d,]+)")


def _parent_command(ctx) -> str:
    if ctx.parent and ctx.parent.text:
        return str(ctx.parent.text or "").strip()
    return ""


def _is_divination_command(command: str) -> bool:
    raw = str(command or "").strip()
    return raw == CMD_DIVINATION or raw.startswith(f"{CMD_DIVINATION} ")


def _is_exchange_command(command: str) -> bool:
    raw = str(command or "").strip()
    return raw == CMD_DIVINATION_EXCHANGE or raw.startswith(f"{CMD_DIVINATION_EXCHANGE} ")


def _day_key(now: float) -> str:
    return datetime.fromtimestamp(float(now or 0), TZ_LOCAL).strftime("%Y-%m-%d")


def _next_local_midnight(now: float) -> float:
    local_now = datetime.fromtimestamp(float(now or 0), TZ_LOCAL)
    next_day = (local_now + timedelta(days=1)).replace(hour=0, minute=0, second=0, microsecond=0)
    return next_day.timestamp()


def _compact(text: str, limit: int = 90) -> str:
    compacted = " ".join(str(text or "").split())
    return compacted[:limit]


def _cost_summary(text: str) -> str:
    costs: list[str] = []
    for item, count in RE_COST.findall(str(text or "")):
        name = str(item or "").strip()
        if not name or name in {"今日第"}:
            continue
        costs.append(f"{name}x{str(count).replace(',', '')}")
    return "、".join(costs[:4])


def parse_divination_summary(text: str) -> str:
    raw = str(text or "").strip()
    if "【神物现世】" in raw:
        target = ""
        if match := RE_TREASURE.search(raw):
            target = str(match.group(1) or "").strip()
        summary = f"神物现世：{target or '神物'}"
        costs = _cost_summary(raw)
        if costs:
            summary += f"｜需 {costs}"
        return summary
    if match := RE_HEXAGRAM.search(raw):
        name = str(match.group(1) or match.group(2) or "").strip()
        return f"卦象：{name}" if name else "卦象结果"
    if match := RE_DAILY_COUNT.search(raw):
        return f"今日第 {int(match.group(1))} 次"
    return _compact(raw, limit=120) or "卜筮问天"


class DivinationModule:
    key = "divination"
    label = "卜筮问天"
    default_state: dict = {
        "day_key": "",
        "daily_count": 0,
        "daily_limit": DIVINATION_DEFAULT_DAILY_LIMIT,
        "cooldown_until": 0.0,
        "last_observed_at": 0.0,
        "last_success_at": 0.0,
        "last_status": "unknown",
        "last_result": "",
        "last_error": "",
        "last_text_excerpt": "",
        "pending_msg_id": 0,
        "exchange_target": "",
        "exchange_command": "",
    }

    def resolve_target(self, event: RawMessageEvent, ctx) -> int | None:
        if ctx.sender_kind != "bot" or not ctx.parent_is_my_identity():
            return None
        parent_cmd = _parent_command(ctx)
        if not (_is_divination_command(parent_cmd) or _is_exchange_command(parent_cmd)):
            return None
        return ctx.parent_sender()

    def observe(self, event: RawMessageEvent, ctx, state: dict) -> dict | None:
        text = str(event.text or "").strip()
        if not text:
            return None
        now = float(ctx.now or 0)
        today = _day_key(now)
        parent_cmd = _parent_command(ctx)
        new = dict(state)
        if str(new.get("day_key") or "") != today:
            new["day_key"] = today
            new["daily_count"] = 0
            new["cooldown_until"] = 0.0
            new["exchange_target"] = ""
            new["exchange_command"] = ""

        def finish(status: str, *, cooldown_until: float | None = None, result: str = "", error: str = "") -> dict:
            new["last_observed_at"] = now
            new["last_status"] = status
            new["last_text_excerpt"] = text[:180]
            if cooldown_until is not None:
                new["cooldown_until"] = float(cooldown_until or 0)
            if result:
                new["last_result"] = result
            new["last_error"] = error
            return new

        if _is_exchange_command(parent_cmd):
            if "换取成功" in text:
                new["exchange_command"] = CMD_DIVINATION_EXCHANGE
                new["last_success_at"] = now
                return finish("exchange_success", result=_compact(text, limit=90))
            if any(marker in text for marker in ("机缘消散", "超时", "已过期", "祭品不足", "资源不足", "材料不足")):
                return finish("exchange_failed", result="神物换取失败", error=_compact(text, limit=120))
            return None

        if RE_DAILY_LIMIT.search(text):
            limit = int(new.get("daily_limit") or DIVINATION_DEFAULT_DAILY_LIMIT)
            new["daily_count"] = max(int(new.get("daily_count") or 0), limit)
            return finish("done_today", cooldown_until=_next_local_midnight(now), result=f"今日完成 {new['daily_count']}/{limit}")

        if "修为不足" in text:
            return finish("blocked", cooldown_until=0, result="不可用", error=_compact(text, limit=120))

        if "开始转动天机罗盘" in text or "请稍候" in text:
            new["pending_msg_id"] = int(event.msg_id or 0)
            if match := RE_DAILY_COUNT.search(text):
                new["daily_count"] = int(match.group(1))
            return finish("pending", result=parse_divination_summary(text))

        if "【神物现世】" in text or RE_HEXAGRAM.search(text):
            new["pending_msg_id"] = 0
            if match := RE_DAILY_COUNT.search(text):
                new["daily_count"] = int(match.group(1))
            elif int(new.get("daily_count") or 0) <= 0:
                new["daily_count"] = 1
            if "【神物现世】" in text:
                treasure = RE_TREASURE.search(text)
                target = str(treasure.group(1) or "").strip() if treasure else ""
                new["exchange_target"] = target
                new["exchange_command"] = CMD_DIVINATION_EXCHANGE
            new["last_success_at"] = now
            limit = int(new.get("daily_limit") or DIVINATION_DEFAULT_DAILY_LIMIT)
            status = "done_today" if int(new.get("daily_count") or 0) >= limit else "success"
            cooldown = _next_local_midnight(now) if status == "done_today" else None
            return finish(status, cooldown_until=cooldown, result=parse_divination_summary(text))

        if match := RE_DAILY_COUNT.search(text):
            count = int(match.group(1))
            new["pending_msg_id"] = 0
            new["daily_count"] = count
            new["last_success_at"] = now
            limit = int(new.get("daily_limit") or DIVINATION_DEFAULT_DAILY_LIMIT)
            status = "done_today" if count >= limit else "success"
            cooldown = _next_local_midnight(now) if status == "done_today" else None
            return finish(status, cooldown_until=cooldown, result=parse_divination_summary(text))

        return None

    def compute_anchor(self, state: dict, *, now: float) -> float | None:
        status = str(state.get("last_status") or "")
        if status == "blocked":
            return None
        cd_until = float(state.get("cooldown_until") or 0)
        if cd_until <= 0:
            return None
        return now if cd_until <= now else cd_until

    def status_summary(self, state: dict, *, now: float) -> dict:
        from backend.identity_state import fmt_remain

        status = str(state.get("last_status") or "unknown")
        count = int(state.get("daily_count") or 0)
        limit = int(state.get("daily_limit") or DIVINATION_DEFAULT_DAILY_LIMIT)
        cd_until = float(state.get("cooldown_until") or 0)
        result = str(state.get("last_result") or "").strip()
        if status == "unknown":
            return {"text": "未观测", "ready": False, "next_at": None, "status": status}
        if status == "pending":
            return {"text": result or "问天中", "ready": False, "next_at": None, "status": status}
        if status == "blocked":
            return {"text": str(state.get("last_error") or "不可用"), "ready": False, "next_at": None, "status": status}
        if count >= limit and cd_until > now:
            return {"text": f"今日完成 {count}/{limit}", "ready": False, "next_at": cd_until, "status": status}
        if cd_until > now:
            return {"text": f"剩 {fmt_remain(cd_until - now)}｜今日 {count}/{limit}", "ready": False, "next_at": cd_until, "status": status}
        detail = f"｜{result}" if result and status != "success" else ""
        return {"text": f"今日 {count}/{limit}{detail}", "ready": True, "next_at": cd_until or None, "status": status}


__all__ = [
    "CMD_DIVINATION",
    "CMD_DIVINATION_EXCHANGE",
    "DIVINATION_DEFAULT_DAILY_LIMIT",
    "DivinationModule",
    "parse_divination_summary",
]
