"""抚摸法宝模块。

Why
---
抚摸 CD ~2h,bot 回复里成功标志是末尾的 "(默契+N, 经验+M)" 标签;
另一类 CD 提示是「请在 X 后再行抚摸」之类的拒绝回复。

跟温养 / 试炼一样,需要带 pet_name(法宝名);自定义官方定时也按 pet_name
拆 plan。state 里把 pet_name 同步存,UI 显示 「📿 抚摸 玄天斩灵剑 剩 0:42」。
"""
from __future__ import annotations

import re

from backend.domain.models import RawMessageEvent
from backend.identity_state.duration import parse_chinese_duration

PET_TOUCH_DEFAULT_CD = 2 * 3600

# (默契+1, 经验+5) 这类成功尾巴,中英括号 + 全半角逗号都兼容
RE_PET_TOUCH_OK = re.compile(r"[(（]\s*默契\s*\+\s*\d+\s*[,，]\s*经验\s*\+\s*\d+\s*[)）]")
# 「.抚摸法宝 玄天斩灵剑」这类原指令里抓 pet_name
RE_TOUCH_CMD = re.compile(r"\.抚摸法宝[\s ]+(\S+)")


def _extract_pet_name(event: RawMessageEvent, ctx) -> str:
    """优先从 reply 的父消息(玩家发的指令)里抓 pet 名。"""
    if ctx.parent and ctx.parent.text:
        m = RE_TOUCH_CMD.search(ctx.parent.text)
        if m:
            return m.group(1).strip()
    return ""


class PetTouchModule:
    key = "pet_touch"
    label = "抚摸法宝"
    default_state: dict = {
        "pet_name": "",
        "last_touched_at": 0.0,
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

        if RE_PET_TOUCH_OK.search(text):
            new["last_touched_at"] = now
            new["cooldown_until"] = now + PET_TOUCH_DEFAULT_CD
            pet = _extract_pet_name(event, ctx)
            if pet:
                new["pet_name"] = pet
            new["last_text_excerpt"] = text[:80]
            changed = True
        elif "请在" in text and "后再行抚摸" in text:
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
