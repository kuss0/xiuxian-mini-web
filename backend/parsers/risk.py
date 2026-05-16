"""风险 parser:识别天道审判 / 挂机嫌疑 / 永久打入死牢 类高危消息,
标 severity=risk,只提示,不出动作建议(用户必须人工查看原文决定)。"""

from __future__ import annotations

from backend.domain.models import ParsedCard, RawMessageEvent
from backend.domain.registry import ParserOutput

RISK_KEYWORDS = ("天道审判", "挂机嫌疑", "永久打入死牢")


class RiskParser:
    name = "risk"

    def parse(self, event: RawMessageEvent) -> ParserOutput | None:
        text = event.text
        if not any(keyword in text for keyword in RISK_KEYWORDS):
            return None
        return ParserOutput(
            cards=(
                ParsedCard(
                    id=event.id,
                    channels=("system", "risk", "mine"),
                    title="风险提醒",
                    summary="检测到举报/自证类消息,需要玩家手动处理。",
                    source=event.source,
                    time=event.date,
                    tags=("风险", "自证"),
                    raw=event.text,
                    fields={"处理方式": "人工查看原文"},
                    severity="risk",
                ),
            )
        )
