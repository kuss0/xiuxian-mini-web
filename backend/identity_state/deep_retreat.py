"""深度闭关 observe-only 状态机。"""
from __future__ import annotations

from backend.domain.models import RawMessageEvent
from backend.identity_state.duration import parse_chinese_duration
from backend.identity_state.phaseful import PhasefulModule, PhasefulSpec

DEEP_RETREAT_DEFAULT_CD = 8 * 3600


class DeepRetreatModule(PhasefulModule):
    def __init__(self) -> None:
        super().__init__(
            PhasefulSpec(
                key="deep_retreat",
                label="深度闭关",
                commands=(".深度闭关", ".查看闭关", ".强行出关"),
                default_cd_sec=DEEP_RETREAT_DEFAULT_CD,
                entry_patterns=(("你已进入深度闭关状态", "神魂将自行吐纳"),),
                running_patterns=(
                    ("预计还需", "即可功成圆满"),
                    ("你正在深度闭关", "预计还需"),
                ),
                cooldown_patterns=("尚未恢复", "冷却", "等待", "不足", "休息"),
                already_running_patterns=("你已在深度闭关之中",),
                idle_patterns=("你并未处于深度闭关之中",),
                summary_patterns=("【深度闭关总结】", "深度闭关总结", "闭关结束"),
                failure_patterns=("【闭关失败】",),
                post_summary_wait_sec=30,
                unknown_running_probe_sec=30,
            )
        )

    def observe(self, event: RawMessageEvent, ctx, state: dict) -> dict | None:
        text = str(event.text or "").strip()
        if not text:
            return None

        # 浅闭关成功不是深闭启动；若它回复到深闭相关查询，只能证明当前不在深闭。
        if "【闭关成功】" in text:
            wait_sec = parse_chinese_duration(text)
            return self._idle_state(
                state,
                event,
                float(ctx.now or 0),
                text,
                status="ready" if wait_sec <= 0 else "cooldown",
                result="闭关已结算",
                next_at=float(ctx.now or 0) + wait_sec if wait_sec > 0 else float(ctx.now or 0),
            )

        new = super().observe(event, ctx, state)
        if not new:
            return None

        # 强行出关总结里如果出现惩罚 CD，以惩罚 CD 作为下一次可用时间。
        if "深度闭关总结" in text and "强行出关" in text:
            wait_sec = parse_chinese_duration(text)
            if wait_sec > 0:
                now = float(ctx.now or 0)
                new["post_summary_until"] = now + wait_sec
                new["cooldown_until"] = now + wait_sec
                new["last_status"] = "penalty"
                new["last_result"] = "强行出关惩罚"

        return new


__all__ = ["DEEP_RETREAT_DEFAULT_CD", "DeepRetreatModule"]
