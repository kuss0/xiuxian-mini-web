"""副本 parser:识别「【虚天殿已开启】副本ID: N」类消息,提取副本 ID 和加入命令。"""

from __future__ import annotations

import re

from backend.domain.models import ActionSuggestion, ParsedCard, RawMessageEvent
from backend.domain.registry import ParserOutput

DUNGEON_ID_RE = re.compile(r"副本ID[:：]\s*(?P<id>\d+)")


class DungeonParser:
    name = "dungeon"

    def parse(self, event: RawMessageEvent) -> ParserOutput | None:
        text = event.text
        if "加入队伍" not in text:
            return None
        match = DUNGEON_ID_RE.search(text)
        if not match:
            return None
        dungeon_id = match.group("id")
        return ParserOutput(
            cards=(
                ParsedCard(
                    id=event.id,
                    channels=("system", "dungeon", "console"),
                    title="虚天殿开启",
                    summary="发现副本公告,可人工确认加入。",
                    source=event.source,
                    time=event.date,
                    tags=("副本", "可加入"),
                    raw=event.text,
                    fields={"副本ID": dungeon_id},
                    actions=(
                        ActionSuggestion(
                            "copy",
                            "复制加入副本",
                            f".加入副本 {dungeon_id}",
                            chat_id=event.chat_id,
                            reply_to_msg_id=event.msg_id,
                        ),
                    ),
                ),
            )
        )
