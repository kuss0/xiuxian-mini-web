"""储物袋 parser:识别「储物袋」类消息,目前只生成卡片,后续可投影库存。"""

from __future__ import annotations

from backend.domain.models import ParsedCard, RawMessageEvent
from backend.domain.registry import ParserOutput


class InventoryParser:
    name = "inventory"

    def parse(self, event: RawMessageEvent) -> ParserOutput | None:
        text = event.text
        if "储物袋" not in text:
            return None
        return ParserOutput(
            cards=(
                ParsedCard(
                    id=event.id,
                    channels=("system", "resource", "console"),
                    title="储物袋快照",
                    summary="已识别背包/资源类消息,后续可投影库存。",
                    source=event.source,
                    time=event.date,
                    tags=("资源", "储物袋"),
                    raw=event.text,
                ),
            )
        )
