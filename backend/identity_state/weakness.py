from __future__ import annotations

from backend.domain.models import RawMessageEvent
from backend.identity_state.duration import parse_chinese_duration

WEAKNESS_DEFAULT_SEC = 30 * 60
WEAKNESS_BUFFER_SEC = 60


def _is_weakness_reply(text: str) -> bool:
    raw = str(text or "")
    if "虚弱状态" not in raw:
        return False
    if "暂时无法运转灵力" in raw and "静养" in raw:
        return True
    if "陷入了" in raw and "【虚弱状态】" in raw and ("元气大伤" in raw or "修为损失" in raw):
        return True
    return False


def _is_jingsi_busy_reply(text: str) -> bool:
    raw = str(text or "")
    return "静思崖面壁悟道" in raw and "无法进行大部分操作" in raw


def _is_jingsi_interrupt_reply(text: str) -> bool:
    raw = str(text or "")
    return "心乱如麻" in raw and "强行中断了感悟" in raw and "离开了静思崖" in raw


def _blocked_until(text: str, now: float) -> float:
    wait_sec = parse_chinese_duration(text)
    if wait_sec <= 0:
        wait_sec = WEAKNESS_DEFAULT_SEC
    return float(now + wait_sec + WEAKNESS_BUFFER_SEC)


class WeaknessModule:
    key = "weakness"
    label = "虚弱/静思"
    default_state: dict = {
        "blocked_until": 0.0,
        "source": "",
        "reason": "",
        "last_observed_at": 0.0,
    }

    def resolve_target(self, event: RawMessageEvent, ctx) -> int | None:
        if ctx.sender_kind != "bot":
            return None
        if not ctx.parent_is_my_identity():
            return None
        text = str(event.text or "")
        if _is_weakness_reply(text) or _is_jingsi_busy_reply(text) or _is_jingsi_interrupt_reply(text):
            return ctx.parent_sender()
        return None

    def observe(self, event: RawMessageEvent, ctx, state: dict) -> dict | None:
        text = str(event.text or "").strip()
        if not text:
            return None
        now = float(ctx.now or 0)
        new = dict(state)
        if _is_jingsi_interrupt_reply(text):
            new.update(
                {
                    "blocked_until": 0.0,
                    "source": "",
                    "reason": "",
                    "last_observed_at": now,
                }
            )
            return new
        if _is_jingsi_busy_reply(text):
            new.update(
                {
                    "blocked_until": _blocked_until(text, now),
                    "source": "jingsi",
                    "reason": text[:120],
                    "last_observed_at": now,
                }
            )
            return new
        if _is_weakness_reply(text):
            new.update(
                {
                    "blocked_until": _blocked_until(text, now),
                    "source": "weakness",
                    "reason": text[:120],
                    "last_observed_at": now,
                }
            )
            return new
        return None

    def compute_anchor(self, state: dict, *, now: float) -> float | None:
        until = float(state.get("blocked_until") or 0)
        if until <= 0:
            return None
        return now if until <= now else until

    def status_summary(self, state: dict, *, now: float) -> dict:
        from backend.identity_state import fmt_remain

        until = float(state.get("blocked_until") or 0)
        source = str(state.get("source") or "")
        label = "静思中" if source == "jingsi" else "虚弱中"
        if until <= 0:
            return {"text": "未受限", "ready": True, "next_at": None, "status": "ready", "source": source}
        if until <= now:
            return {"text": "已恢复", "ready": True, "next_at": until, "status": "ready", "source": source}
        return {
            "text": f"{label} 剩 {fmt_remain(until - now)}",
            "ready": False,
            "next_at": until,
            "status": source or "blocked",
            "source": source,
        }
