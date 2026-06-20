from __future__ import annotations

import re
from datetime import datetime, timedelta, timezone

from backend.domain.models import RawMessageEvent
from backend.identity_state.duration import parse_chinese_duration

CMD_SECT_TEACH = ".宗门传功"
SECT_TEACH_SHORT_CD_SEC = 90
SECT_TEACH_DAILY_LIMIT = 3
TZ_LOCAL = timezone(timedelta(hours=8))

RE_TEACH_COUNT = re.compile(r"今日已传功\s*(\d+)\s*/\s*(\d+)\s*次")


def _parent_command(ctx) -> str:
    if ctx.parent and ctx.parent.text:
        return str(ctx.parent.text or "").strip()
    return ""


def _is_sect_teach_command(command: str) -> bool:
    raw = str(command or "").strip()
    return raw == CMD_SECT_TEACH or raw.startswith(f"{CMD_SECT_TEACH} ")


def _day_key(now: float) -> str:
    return datetime.fromtimestamp(float(now or 0), TZ_LOCAL).strftime("%Y-%m-%d")


def _next_local_midnight(now: float) -> float:
    local_now = datetime.fromtimestamp(float(now or 0), TZ_LOCAL)
    next_day = (local_now + timedelta(days=1)).replace(hour=0, minute=0, second=0, microsecond=0)
    return next_day.timestamp()


class SectTeachModule:
    key = "sect_teach"
    label = "宗门传功"
    default_state: dict = {
        "cooldown_until": 0.0,
        "day_key": "",
        "teach_count": 0,
        "daily_limit": SECT_TEACH_DAILY_LIMIT,
        "last_observed_at": 0.0,
        "last_success_at": 0.0,
        "last_status": "unknown",
        "last_result": "",
        "last_error": "",
        "last_text_excerpt": "",
    }

    def resolve_target(self, event: RawMessageEvent, ctx) -> int | None:
        if ctx.sender_kind != "bot" or not ctx.parent_is_my_identity():
            return None
        if not _is_sect_teach_command(_parent_command(ctx)):
            return None
        return ctx.parent_sender()

    def observe(self, event: RawMessageEvent, ctx, state: dict) -> dict | None:
        text = str(event.text or "").strip()
        if not text:
            return None
        now = float(ctx.now or 0)
        today = _day_key(now)
        new = dict(state)
        if str(new.get("day_key") or "") != today:
            new["day_key"] = today
            new["teach_count"] = 0
            new["cooldown_until"] = 0.0

        def finish(status: str, *, cooldown_until: float | None = None, result: str = "", error: str = "") -> dict:
            new["last_observed_at"] = now
            new["last_status"] = status
            new["last_text_excerpt"] = text[:160]
            if cooldown_until is not None:
                new["cooldown_until"] = float(cooldown_until or 0)
            if result:
                new["last_result"] = result
            new["last_error"] = error
            return new

        if "传功玉简已记录" in text:
            match = RE_TEACH_COUNT.search(text)
            if match:
                count = max(0, int(match.group(1) or 0))
                limit = max(1, int(match.group(2) or SECT_TEACH_DAILY_LIMIT))
                new["teach_count"] = min(limit, count)
                new["daily_limit"] = limit
            else:
                limit = int(new.get("daily_limit") or SECT_TEACH_DAILY_LIMIT)
                new["teach_count"] = min(limit, int(new.get("teach_count") or 0) + 1)
            new["last_success_at"] = now
            limit = int(new.get("daily_limit") or SECT_TEACH_DAILY_LIMIT)
            count = int(new.get("teach_count") or 0)
            if count >= limit:
                return finish("done_today", cooldown_until=_next_local_midnight(now), result=f"今日完成 {count}/{limit}")
            return finish("success", cooldown_until=now + SECT_TEACH_SHORT_CD_SEC, result=f"今日 {count}/{limit}")

        if any(marker in text for marker in ("今日传功次数已满", "今日已传功", "今日已完成传功")):
            match = RE_TEACH_COUNT.search(text)
            limit = int(match.group(2)) if match else int(new.get("daily_limit") or SECT_TEACH_DAILY_LIMIT)
            count = int(match.group(1)) if match else limit
            new["teach_count"] = min(limit, count)
            new["daily_limit"] = limit
            return finish("done_today", cooldown_until=_next_local_midnight(now), result=f"今日完成 {new['teach_count']}/{limit}")

        if any(marker in text for marker in ("稍后再试", "请在", "冷却", "间隔")):
            wait_sec = parse_chinese_duration(text)
            until = now + wait_sec if wait_sec > 0 else now + SECT_TEACH_SHORT_CD_SEC
            return finish("cooldown", cooldown_until=until, result="短冷却")

        if any(marker in text for marker in ("未加入宗门", "散修", "没有宗门")):
            reason = text.splitlines()[0].strip() if text.splitlines() else text[:120]
            return finish("blocked", cooldown_until=0, result="不可用", error=reason)

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
        count = int(state.get("teach_count") or 0)
        limit = int(state.get("daily_limit") or SECT_TEACH_DAILY_LIMIT)
        cd_until = float(state.get("cooldown_until") or 0)
        if status == "unknown":
            return {"text": "未观测", "ready": False, "next_at": None, "status": status}
        if status == "blocked":
            return {"text": str(state.get("last_error") or "不可用"), "ready": False, "next_at": None, "status": status}
        if count >= limit and cd_until > now:
            return {"text": f"今日完成 {count}/{limit}", "ready": False, "next_at": cd_until, "status": status}
        if cd_until > now:
            return {"text": f"今日 {count}/{limit}｜剩 {fmt_remain(cd_until - now)}", "ready": False, "next_at": cd_until, "status": status}
        return {"text": f"今日 {count}/{limit}｜可继续", "ready": True, "next_at": cd_until or None, "status": status}


__all__ = ["CMD_SECT_TEACH", "SectTeachModule"]
