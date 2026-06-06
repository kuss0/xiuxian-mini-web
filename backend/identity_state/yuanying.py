"""元婴出窍 observe-only 状态机。"""
from __future__ import annotations

from backend.domain.models import RawMessageEvent
from backend.identity_state.duration import parse_chinese_duration
from backend.identity_state.phaseful import PhasefulModule, PhasefulSpec

YUANYING_DEFAULT_CD = 8 * 3600


class YuanyingModule(PhasefulModule):
    def __init__(self) -> None:
        super().__init__(
            PhasefulSpec(
                key="yuanying",
                label="元婴出窍",
                commands=(".元婴出窍", ".元婴状态"),
                default_cd_sec=YUANYING_DEFAULT_CD,
                entry_patterns=(("你心念一动", "元婴化作一道流光飞出"),),
                running_patterns=(
                    "归来倒计时",
                    ("状态: 元神出窍",),
                    ("状态：元神出窍",),
                    ("你的元婴正在执行", "元神出窍", "无法分身"),
                ),
                cooldown_patterns=("尚未恢复", "冷却", "等待", "不足", "休息"),
                ready_patterns=("状态: 窍中温养", "状态：窍中温养", "窍中温养"),
                summary_patterns=(
                    "元神归窍总结",
                    "元婴闭关结算",
                    ("元神回响", "神游归来", "清点收获"),
                ),
                post_summary_wait_sec=30,
                unknown_running_probe_sec=15,
            )
        )

    def observe(self, event: RawMessageEvent, ctx, state: dict) -> dict | None:
        new = super().observe(event, ctx, state)
        if not new:
            return None

        text = str(event.text or "")
        if "归来倒计时" in text or "状态: 元神出窍" in text or "状态：元神出窍" in text:
            new["probe_pending"] = False
        if "窍中温养" in text:
            new["idle_confirmed_at"] = float(ctx.now or 0)
        if "元神归窍总结" in text or "元婴闭关结算" in text or "神游归来" in text:
            new["idle_confirmed_at"] = float(ctx.now or 0)

        # Some status cards include no duration. Keep them as running/probe states
        # without inventing a full 8h cooldown.
        if (
            new.get("phase") == "running"
            and parse_chinese_duration(text) <= 0
            and "元婴化作一道流光飞出" not in text
        ):
            current_until = float(new.get("cooldown_until") or 0)
            now = float(ctx.now or 0)
            if current_until > now + self.spec.unknown_running_probe_sec:
                new["cooldown_until"] = current_until
            else:
                new["cooldown_until"] = now + self.spec.unknown_running_probe_sec
            new["probe_pending"] = True

        return new


__all__ = ["YUANYING_DEFAULT_CD", "YuanyingModule"]
