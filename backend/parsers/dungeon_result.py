"""副本结果 parser:识别加入成功 / 加入失败 / 房间解散等副本相关事件。

老脚本对照:features/join_dungeon.py:34-38。
- `@user 已成功加入副本 N` / `已成功加入坠魔谷 N` / `已成功加入黄龙山队伍 N`
- `找不到此副本房间，可能已解散或ID错误`
- `已将副本房间 (ID: N) 解散`
"""

from __future__ import annotations

import re

from backend.domain.models import ParsedCard, RawMessageEvent
from backend.domain.registry import ParserOutput


_JOINED_RE = re.compile(
    r"@(?P<u>[A-Za-z0-9_]+)\s*已成功加入(?:副本\s*(?P<id1>\d+)|坠魔谷(?:\s*(?P<id2>\d+))?|黄龙山(?:队伍)?(?:\s*(?P<id3>\d+))?)"
)
_JOIN_FAILED_RE = re.compile(r"找不到此副本房间[，,]?\s*可能已解散或ID错误")
_DISSOLVED_RE = re.compile(r"已将副本房间\s*[（(]\s*ID\s*[:：]\s*(?P<id>\d+)\s*[）)]\s*解散")


class DungeonResultParser:
    name = "dungeon_result"

    def parse(self, event: RawMessageEvent) -> ParserOutput | None:
        text = event.text or ""
        if joined := _JOINED_RE.search(text):
            dungeon_id = joined.group("id1") or joined.group("id2") or joined.group("id3") or ""
            user = joined.group("u")
            fields = {"username": user}
            if dungeon_id:
                fields["副本ID"] = dungeon_id
            return ParserOutput(
                cards=(
                    ParsedCard(
                        id=event.id,
                        channels=("system", "dungeon"),
                        title="加入副本成功",
                        summary=f"@{user} 已加入副本 {dungeon_id or ''}".strip(),
                        source=event.source,
                        time=event.date,
                        tags=("副本", "加入"),
                        raw=event.text,
                        fields=fields,
                    ),
                ),
            )
        if _JOIN_FAILED_RE.search(text):
            reason = "找不到房间，可能已解散或ID错误"
            return ParserOutput(
                cards=(
                    ParsedCard(
                        id=event.id,
                        channels=("system", "dungeon"),
                        title="加入副本失败",
                        summary=f"加入副本失败：{reason}",
                        source=event.source,
                        time=event.date,
                        tags=("副本", "加入", "失败"),
                        raw=event.text,
                        fields={"状态": "加入失败", "失败原因": reason},
                    ),
                ),
            )
        if dissolved := _DISSOLVED_RE.search(text):
            dungeon_id = dissolved.group("id")
            return ParserOutput(
                cards=(
                    ParsedCard(
                        id=event.id,
                        channels=("system", "dungeon"),
                        title="副本房间解散",
                        summary=f"副本 {dungeon_id} 已解散",
                        source=event.source,
                        time=event.date,
                        tags=("副本", "解散"),
                        raw=event.text,
                        fields={"副本ID": dungeon_id},
                    ),
                ),
            )
        return None
