"""深度闭关模块。

Why
---
深度闭关 CD 固定 ~8h,但有几种奇怪的反例:
- 「强行出关」会留下 40 分钟惩罚 CD
- 调息恢复期 9~13 分钟(刚出关又想再深一次的轻量 CD)
- 「闭关结束」是一种系统级通告

我们不替用户做决策,只观察:
- 看到「你已进入深度闭关状态」→ phase=running, 记 entered_at + cooldown_until
- 看到「【深度闭关总结】」 → phase=finished, 记 finished_at
- 看到「闭关结束」(系统通告) → phase=finished
- 看到「预计还需 X 即可功成圆满」 → 重写 cooldown_until = now + X

state 只存当前快照,UI 拿来显示「剩 02:34 / 已就绪」。
"""
from __future__ import annotations

import re
from typing import Any

from backend.domain.models import RawMessageEvent
from backend.identity_state.duration import parse_chinese_duration

DEEP_RETREAT_DEFAULT_CD = 8 * 3600  # 8 小时,跟官方定时 PRESET_DEEP_RETREAT 对齐


def _has_kw(text: str, *kws: str) -> bool:
    return all(k in text for k in kws)


class DeepRetreatModule:
    key = "deep_retreat"
    label = "深度闭关"
    default_state: dict = {
        "phase": "idle",            # idle / running / finished
        "entered_at": 0.0,
        "finished_at": 0.0,
        "cooldown_until": 0.0,      # 下一次允许深闭的绝对时间
        "last_text_excerpt": "",
    }

    def resolve_target(self, event: RawMessageEvent, ctx) -> int | None:
        # 只关心 game bot 的回复(包括系统通告型 sender);
        # 把 state 写到「这条 bot 回复指向哪个身份」上 — 即 ctx.parent.sender_id。
        if ctx.sender_kind != "bot":
            return None
        # 先看 reply 的父消息归属;父消息不在我的身份范围就跳过。
        if ctx.parent_is_my_identity():
            return ctx.parent_sender()
        # 系统通告类(没有 reply,或 reply 指向 topic)无法归属到具体身份,跳过。
        return None

    def observe(
        self, event: RawMessageEvent, ctx, state: dict
    ) -> dict | None:
        text = (event.text or "").strip()
        if not text:
            return None
        now = ctx.now or 0.0
        new = dict(state)
        changed = False

        # 1) 进入深闭
        if _has_kw(text, "你已进入深度闭关状态", "神魂将自行吐纳"):
            wait = parse_chinese_duration(text)
            cd = wait if wait > 0 else DEEP_RETREAT_DEFAULT_CD
            new["phase"] = "running"
            new["entered_at"] = now
            new["cooldown_until"] = now + cd
            new["last_text_excerpt"] = text[:80]
            changed = True

        # 2) CD 还在:「预计还需 X 即可功成圆满」
        elif "预计还需" in text and "即可功成圆满" in text:
            wait = parse_chinese_duration(text)
            if wait > 0:
                new["phase"] = "running"
                new["cooldown_until"] = now + wait
                new["last_text_excerpt"] = text[:80]
                changed = True

        # 3) 总结落地 → finished
        elif "【深度闭关总结】" in text:
            new["phase"] = "finished"
            new["finished_at"] = now
            # 强行出关惩罚 40 分钟 / 一般出关后短调息
            penalty = parse_chinese_duration(text)
            if "强行出关" in text and penalty > 0:
                new["cooldown_until"] = now + penalty
            else:
                new["cooldown_until"] = now
            new["last_text_excerpt"] = text[:80]
            changed = True

        # 4) 闭关成功(短闭关,不是深度) — 留个调息时间
        elif "【闭关成功】" in text and "再次闭关" in text:
            wait = parse_chinese_duration(text)
            if wait > 0:
                # 浅闭关 CD 不覆盖深闭 cooldown,但记一下 last_excerpt 给排查用
                new["last_text_excerpt"] = text[:80]
                changed = True

        # 5) 系统通告「闭关结束」
        elif text == "闭关结束" or text.startswith("闭关结束"):
            new["phase"] = "finished"
            new["finished_at"] = now
            new["cooldown_until"] = now
            new["last_text_excerpt"] = text[:80]
            changed = True

        return new if changed else None

    def compute_anchor(self, state: dict, *, now: float) -> float | None:
        cd_until = float(state.get("cooldown_until") or 0)
        if cd_until <= 0:
            return None
        # 已到点 → 现在可用,scheduler 直接用 now 作 anchor
        if cd_until <= now:
            return now
        return cd_until

    def status_summary(self, state: dict, *, now: float) -> dict:
        from backend.identity_state import fmt_remain
        phase = state.get("phase") or "idle"
        cd_until = float(state.get("cooldown_until") or 0)
        ready = cd_until <= now
        if phase == "idle" and cd_until <= 0:
            return {"text": "未观测", "ready": False, "next_at": None, "phase": phase}
        remain = max(0.0, cd_until - now)
        if ready:
            return {"text": "已就绪", "ready": True, "next_at": cd_until, "phase": phase}
        return {"text": f"剩 {fmt_remain(remain)}", "ready": False, "next_at": cd_until, "phase": phase}
