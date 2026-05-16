"""第二元神归位 parser:识别「【第二元神归位】回归窍中温养」类消息。"""

from __future__ import annotations

from backend.domain.models import ActionSuggestion, ParsedCard, RawMessageEvent
from backend.domain.registry import ParserOutput


class SecondSoulParser:
    name = "second_soul"

    def parse(self, event: RawMessageEvent) -> ParserOutput | None:
        text = event.text
        if "【第二元神归位】" not in text or "回归窍中温养" not in text:
            return None
        return ParserOutput(
            cards=(
                ParsedCard(
                    id=event.id,
                    channels=("mine", "training", "system"),
                    title="第二元神归位",
                    summary="第二元神已结束修炼,可以考虑抉择后继续修炼。",
                    source=event.source,
                    time=event.date,
                    tags=("修炼", "第二元神"),
                    raw=event.text,
                    actions=(
                        ActionSuggestion(
                            "copy",
                            "复制抉择",
                            ".抉择 稳固道心",
                            chat_id=event.chat_id,
                            reply_to_msg_id=event.msg_id,
                        ),
                        ActionSuggestion(
                            "copy",
                            "复制修炼",
                            ".元神修炼",
                            chat_id=event.chat_id,
                        ),
                    ),
                ),
            )
        )
