from __future__ import annotations

import re

from backend.domain.models import RawMessageEvent
from backend.identity_state.duration import parse_chinese_duration

PANEL_RE = re.compile(r"【(?P<owner>[^】]+)的小世界】")
NUMBER_RE = re.compile(r"[\d,]+")
POPULATION_RE = re.compile(r"人口\s*[:：]\s*(?P<value>[\d,]+)\s*人")
POPULATION_LIMIT_RE = re.compile(r"承载上限\s*[:：]\s*(?P<value>[\d,]+)\s*人")
FAITH_RE = re.compile(r"信仰\s*[:：]\s*(?P<value>[\d,]+)\s*/\s*(?P<max>[\d,]+)")
STABILITY_RE = re.compile(r"稳定\s*[:：]\s*(?P<value>[\d,]+)\s*/\s*(?P<max>[\d,]+)")
PENDING_RE = re.compile(r"待收香火\s*[:：]\s*(?P<value>[\d,.]+)")
STOCK_RE = re.compile(r"香火库存\s*[:：]\s*(?P<value>[\d,]+)")
OUTPUT_RE = re.compile(r"预计产出\s*[:：]\s*(?P<value>[\d,.]+)\s*香火/小时")
SHIELD_RE = re.compile(r"护界禁制\s*[:：]\s*(?P<value>[^\n\r]+)")
SENSE_RE = re.compile(r"神识强度\s*[:：]\s*(?P<value>[\d,]+)")
PRAYER_RE = re.compile(r"凡人祈愿\s*[:：]\s*(?P<value>[^\n]+)")
PRAYER_COST_RE = re.compile(r"显灵消耗\s*[:：]\s*(?P<value>[^\n\r]+)")
PRAYER_WAIT_RE = re.compile(r"下一次祈愿感应需等待\s*[:：]\s*(?P<value>[^\n)）]+)")
PRAYER_RESULT_WAIT_RE = re.compile(r"下一次凡人祈愿感应需等待\s*(?P<value>[^。\n\r]+)")
MIRACLE_CD_RE = re.compile(r"凡间方才承受神谕，需再等待")
HARVEST_STOCK_RE = re.compile(r"当前香火库存\s*[:：]\s*(?P<value>\d+)")
REFINE_BURNED_RE = re.compile(r"燃烧了\s*(?P<value>\d+)\s*点香火")
PREACH_FAITH_RE = re.compile(r"信仰值大幅提升至\s*(?P<value>\d+)")
PREACH_STABILITY_RE = re.compile(r"稳定提升至\s*(?P<value>\d+)")
SHORTAGE_RE = re.compile(r"(香火库存不足|显灵所需.+不足|灵石不足|清灵丹.+不足|资源不足|材料不足)")


def _parse_int(value: object) -> int:
    match = NUMBER_RE.search(str(value or ""))
    if not match:
        return 0
    try:
        return int(match.group(0).replace(",", ""))
    except (TypeError, ValueError):
        return 0


def _parse_float(value: object) -> float:
    try:
        return float(str(value or "0").replace(",", ""))
    except (TypeError, ValueError):
        return 0.0


class SmallWorldModule:
    key = "small_world"
    label = "小世界"
    default_state: dict = {
        "owner": "",
        "population": 0,
        "population_limit": 0,
        "faith": 0,
        "faith_max": 0,
        "stability": 0,
        "stability_max": 0,
        "pending_incense": 0.0,
        "incense_stock": 0,
        "output_per_hour": 0.0,
        "shield": "",
        "spiritual_sense": 0,
        "prayer": "",
        "prayer_cost": "",
        "prayer_wait_until": 0.0,
        "manifest_wait_until": 0.0,
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
            if match := POPULATION_RE.search(text):
                new["population"] = _parse_int(match.group("value"))
            if match := POPULATION_LIMIT_RE.search(text):
                new["population_limit"] = _parse_int(match.group("value"))
            if match := FAITH_RE.search(text):
                new["faith"] = _parse_int(match.group("value"))
                new["faith_max"] = _parse_int(match.group("max"))
            if match := STABILITY_RE.search(text):
                new["stability"] = _parse_int(match.group("value"))
                new["stability_max"] = _parse_int(match.group("max"))
            if match := PENDING_RE.search(text):
                new["pending_incense"] = _parse_float(match.group("value"))
            if match := STOCK_RE.search(text):
                new["incense_stock"] = _parse_int(match.group("value"))
            if match := OUTPUT_RE.search(text):
                new["output_per_hour"] = _parse_float(match.group("value"))
            if match := SHIELD_RE.search(text):
                new["shield"] = match.group("value").strip()
            if match := SENSE_RE.search(text):
                new["spiritual_sense"] = _parse_int(match.group("value"))
            if match := PRAYER_RE.search(text):
                new["prayer"] = match.group("value").strip()
            elif "暂无祈愿" in text:
                new["prayer"] = ""
            if match := PRAYER_COST_RE.search(text):
                new["prayer_cost"] = match.group("value").strip()
            if match := PRAYER_WAIT_RE.search(text):
                wait_sec = parse_chinese_duration(match.group("value"))
                new["prayer_wait_until"] = now + wait_sec if wait_sec > 0 else 0.0

        if match := HARVEST_STOCK_RE.search(text):
            new["incense_stock"] = _parse_int(match.group("value"))
            new["pending_incense"] = 0.0
            new["last_status"] = "harvest"
            new["last_error"] = ""
            changed = True

        if match := REFINE_BURNED_RE.search(text):
            burned = _parse_int(match.group("value"))
            new["incense_stock"] = max(0, int(new.get("incense_stock") or 0) - burned)
            new["last_status"] = "refine"
            new["last_error"] = ""
            changed = True

        if match := PREACH_FAITH_RE.search(text):
            new["faith"] = _parse_int(match.group("value"))
            if int(new.get("faith_max") or 0) < int(new["faith"]):
                new["faith_max"] = int(new["faith"])
            new["last_status"] = "preach"
            new["last_error"] = ""
            changed = True

        if match := PREACH_STABILITY_RE.search(text):
            new["stability"] = _parse_int(match.group("value"))
            if int(new.get("stability_max") or 0) < int(new["stability"]):
                new["stability_max"] = int(new["stability"])
            new["last_status"] = "preach"
            new["last_error"] = ""
            changed = True

        if match := PRAYER_RESULT_WAIT_RE.search(text):
            wait_sec = parse_chinese_duration(match.group("value"))
            if wait_sec > 0:
                new["prayer_wait_until"] = now + wait_sec
                new["last_status"] = "manifest"
                new["last_error"] = ""
                changed = True

        if MIRACLE_CD_RE.search(text):
            wait_sec = parse_chinese_duration(text)
            if wait_sec > 0:
                new["manifest_wait_until"] = now + wait_sec
                new["last_status"] = "manifest_cooldown"
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
        manifest_until = float(state.get("manifest_wait_until") or 0)
        next_at = max(wait_until, manifest_until)
        if next_at <= 0:
            return None
        return now if next_at <= now else next_at

    def status_summary(self, state: dict, *, now: float) -> dict:
        from backend.identity_state import fmt_remain

        status = str(state.get("last_status") or "unknown")
        wait_until = float(state.get("prayer_wait_until") or 0)
        manifest_until = float(state.get("manifest_wait_until") or 0)
        stock = int(state.get("incense_stock") or 0)
        pending = float(state.get("pending_incense") or 0)
        faith = int(state.get("faith") or 0)
        faith_max = int(state.get("faith_max") or 0)
        stability = int(state.get("stability") or 0)
        stability_max = int(state.get("stability_max") or 0)
        population = int(state.get("population") or 0)
        population_limit = int(state.get("population_limit") or 0)
        if status == "unknown":
            return {"text": "未观测", "ready": False, "next_at": None, "status": status}
        faith_text = f"{faith}/{faith_max}" if faith_max else str(faith or "-")
        stability_text = f" 稳定 {stability}/{stability_max}" if stability_max else ""
        population_text = f" 人口 {population}/{population_limit}" if population_limit else ""
        if wait_until > now:
            text = f"信仰 {faith_text}{stability_text}{population_text} 香火 {stock}+{pending:g} 祈愿剩 {fmt_remain(wait_until - now)}"
            ready = False
        elif manifest_until > now:
            text = f"信仰 {faith_text}{stability_text}{population_text} 香火 {stock}+{pending:g} 显灵剩 {fmt_remain(manifest_until - now)}"
            ready = False
        else:
            text = f"信仰 {faith_text}{stability_text}{population_text} 香火 {stock}+{pending:g}"
            ready = True
        next_at = max(wait_until, manifest_until)
        return {"text": text, "ready": ready, "next_at": next_at or None, "status": status}


def _is_small_world_signal(text: str) -> bool:
    raw = str(text or "")
    return any(
        token in raw
        for token in (
            "小世界",
            "香火",
            "神音浩荡",
            "信仰值大幅提升",
            "稳定提升至",
            "凡人祈愿",
            "凡间方才承受神谕",
            "下一次凡人祈愿感应",
            "护界禁制",
            "显灵所需",
            "清灵丹",
        )
    )
