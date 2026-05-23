from __future__ import annotations

import re

from backend.domain.models import RawMessageEvent
from backend.identity_state.duration import parse_chinese_duration

PANEL_RE = re.compile(r"【(?P<owner>[^】]+)的小世界】")
FAITH_RE = re.compile(r"信仰\s*[:：]\s*(?P<value>\d+)\s*/\s*(?P<max>\d+)")
PENDING_RE = re.compile(r"待收香火\s*[:：]\s*(?P<value>[0-9]+(?:\.[0-9]+)?)")
STOCK_RE = re.compile(r"香火库存\s*[:：]\s*(?P<value>\d+)")
PRAYER_RE = re.compile(r"凡人祈愿\s*[:：]\s*(?P<value>[^\n]+)")
PRAYER_WAIT_RE = re.compile(r"下一次祈愿感应需等待\s*[:：]\s*(?P<value>[^\n)）]+)")
HARVEST_STOCK_RE = re.compile(r"当前香火库存\s*[:：]\s*(?P<value>\d+)")
REFINE_BURNED_RE = re.compile(r"燃烧了\s*(?P<value>\d+)\s*点香火")
PREACH_FAITH_RE = re.compile(r"信仰值大幅提升至\s*(?P<value>\d+)")
SHORTAGE_RE = re.compile(r"(香火库存不足|显灵所需.+不足|灵石不足|清灵丹.+不足|资源不足|材料不足)")


class SmallWorldModule:
    key = "small_world"
    label = "小世界"
    default_state: dict = {
        "owner": "",
        "faith": 0,
        "faith_max": 0,
        "pending_incense": 0.0,
        "incense_stock": 0,
        "prayer": "",
        "prayer_wait_until": 0.0,
        "last_observed_at": 0.0,
        "last_status": "unknown",
        "last_error": "",
    }

    def resolve_target(self, event: RawMessageEvent, ctx) -> int | None:
        if ctx.sender_kind != "bot":
            return None
        if not ctx.parent_is_my_identity():
            return None
        text = str(event.text or "")
        if not _is_small_world_signal(text):
            return None
        return ctx.parent_sender()

    def observe(self, event: RawMessageEvent, ctx, state: dict) -> dict | None:
        text = str(event.text or "").strip()
        if not text:
            return None
        now = float(ctx.now or 0)
        new = dict(state)
        changed = False

        if panel_match := PANEL_RE.search(text):
            new["owner"] = panel_match.group("owner").strip()
            new["last_status"] = "panel"
            new["last_error"] = ""
            changed = True
            if match := FAITH_RE.search(text):
                new["faith"] = int(match.group("value") or 0)
                new["faith_max"] = int(match.group("max") or 0)
            if match := PENDING_RE.search(text):
                new["pending_incense"] = float(match.group("value") or 0)
            if match := STOCK_RE.search(text):
                new["incense_stock"] = int(match.group("value") or 0)
            if match := PRAYER_RE.search(text):
                new["prayer"] = match.group("value").strip()
            elif "暂无祈愿" in text:
                new["prayer"] = ""
            if match := PRAYER_WAIT_RE.search(text):
                wait_sec = parse_chinese_duration(match.group("value"))
                new["prayer_wait_until"] = now + wait_sec if wait_sec > 0 else 0.0

        if match := HARVEST_STOCK_RE.search(text):
            new["incense_stock"] = int(match.group("value") or 0)
            new["pending_incense"] = 0.0
            new["last_status"] = "harvest"
            new["last_error"] = ""
            changed = True

        if match := REFINE_BURNED_RE.search(text):
            burned = int(match.group("value") or 0)
            new["incense_stock"] = max(0, int(new.get("incense_stock") or 0) - burned)
            new["last_status"] = "refine"
            new["last_error"] = ""
            changed = True

        if match := PREACH_FAITH_RE.search(text):
            new["faith"] = int(match.group("value") or 0)
            if int(new.get("faith_max") or 0) < int(new["faith"]):
                new["faith_max"] = int(new["faith"])
            new["last_status"] = "preach"
            new["last_error"] = ""
            changed = True

        if SHORTAGE_RE.search(text):
            new["last_status"] = "blocked"
            new["last_error"] = text[:120]
            changed = True

        if not changed:
            return None
        new["last_observed_at"] = now
        return new

    def compute_anchor(self, state: dict, *, now: float) -> float | None:
        wait_until = float(state.get("prayer_wait_until") or 0)
        if wait_until <= 0:
            return None
        return now if wait_until <= now else wait_until

    def status_summary(self, state: dict, *, now: float) -> dict:
        from backend.identity_state import fmt_remain

        status = str(state.get("last_status") or "unknown")
        wait_until = float(state.get("prayer_wait_until") or 0)
        stock = int(state.get("incense_stock") or 0)
        pending = float(state.get("pending_incense") or 0)
        faith = int(state.get("faith") or 0)
        faith_max = int(state.get("faith_max") or 0)
        if status == "unknown":
            return {"text": "未观测", "ready": False, "next_at": None, "status": status}
        faith_text = f"{faith}/{faith_max}" if faith_max else str(faith or "-")
        if wait_until > now:
            text = f"信仰 {faith_text} 香火 {stock}+{pending:g} 祈愿剩 {fmt_remain(wait_until - now)}"
            ready = False
        else:
            text = f"信仰 {faith_text} 香火 {stock}+{pending:g}"
            ready = True
        return {"text": text, "ready": ready, "next_at": wait_until or None, "status": status}


def _is_small_world_signal(text: str) -> bool:
    raw = str(text or "")
    return any(
        token in raw
        for token in (
            "小世界",
            "香火",
            "神音浩荡",
            "信仰值大幅提升",
            "显灵所需",
            "清灵丹",
        )
    )
