"""温养器灵模块。

跟 [[pet_touch]] 是同一族(器灵相关),但 CD 长得多(默认 6h)、
回复格式不同。成功标志:「【温养器灵】」开头;CD 拒绝有
「器灵方才吞纳过灵机」/ 「请在 X 后再行温养」两种话术。
"""
from __future__ import annotations

import re

from backend.domain.models import RawMessageEvent
from backend.identity_state.duration import parse_chinese_duration

PET_WARM_DEFAULT_CD = 6 * 3600

RE_WARM_OK = re.compile(r"【温养器灵】")
RE_WARM_CMD = re.compile(r"\.温养器灵[\s ]+(\S+)")


def _extract_pet_name(event: RawMessageEvent, ctx) -> str:
    if ctx.parent and ctx.parent.text:
        m = RE_WARM_CMD.search(ctx.parent.text)
        if m:
            return m.group(1).strip()
    return ""


class PetWarmModule:
    key = "pet_warm"
    label = "温养器灵"
    default_state: dict = {
        "pet_name": "",
        "last_warmed_at": 0.0,
        "cooldown_until": 0.0,
        "last_text_excerpt": "",
    }

    def resolve_target(self, event: RawMessageEvent, ctx) -> int | None:
        if ctx.sender_kind != "bot":
            return None
        if not ctx.parent_is_my_identity():
            return None
        return ctx.parent_sender()

    def observe(self, event: RawMessageEvent, ctx, state: dict) -> dict | None:
        text = (event.text or "")
        if not text:
            return None
        now = ctx.now or 0.0
        new = dict(state)
        changed = False

        if RE_WARM_OK.search(text):
            new["last_warmed_at"] = now
            new["cooldown_until"] = now + PET_WARM_DEFAULT_CD
            pet = _extract_pet_name(event, ctx)
            if pet:
                new["pet_name"] = pet
            new["last_text_excerpt"] = text[:80]
            changed = True
        elif "器灵方才吞纳过灵机" in text or ("请在" in text and "后再行温养" in text):
            wait = parse_chinese_duration(text)
            if wait > 0:
                new["cooldown_until"] = now + wait
                pet = _extract_pet_name(event, ctx)
                if pet:
                    new["pet_name"] = pet
                new["last_text_excerpt"] = text[:80]
                changed = True

        return new if changed else None

    def compute_anchor(self, state: dict, *, now: float) -> float | None:
        cd_until = float(state.get("cooldown_until") or 0)
        if cd_until <= 0:
            return None
        return now if cd_until <= now else cd_until

    def status_summary(self, state: dict, *, now: float) -> dict:
        from backend.identity_state import fmt_remain
        cd_until = float(state.get("cooldown_until") or 0)
        pet = state.get("pet_name") or ""
        suffix = f" {pet}" if pet else ""
        if cd_until <= 0:
            return {
                "text": f"未观测{suffix}",
                "ready": False,
                "next_at": None,
                "pet_name": pet,
            }
        if cd_until <= now:
            return {
                "text": f"已就绪{suffix}",
                "ready": True,
                "next_at": cd_until,
                "pet_name": pet,
            }
        return {
            "text": f"剩 {fmt_remain(cd_until - now)}{suffix}",
            "ready": False,
            "next_at": cd_until,
            "pet_name": pet,
        }
