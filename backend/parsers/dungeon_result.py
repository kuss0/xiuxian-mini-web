"""副本结果 parser:识别加入成功 / 加入失败 / 房间解散等副本相关事件。

老脚本对照:features/join_dungeon.py:34-38。
- `@user 已成功加入副本 N` / `已成功加入坠魔谷 N` / `已成功加入黄龙山队伍 N`
- `@user 已加入苍坤上人洞府队伍`
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
_CANGKUN_JOINED_RE = re.compile(r"@(?P<u>[A-Za-z0-9_]+)\s*已加入苍坤上人洞府队伍")
_JOIN_FAILED_RE = re.compile(
    r"找不到此副本房间[，,]?\s*可能已解散或ID错误"
    r"|找不到此苍坤上人洞府房间[，,]?\s*可能已出发或已解散"
    r"|苍坤上人洞府只对\s*(?P<realm>[^。\n]+)\s*及以上修士开放"
    r"|你已在一个苍坤上人洞府队伍中"
    r"|你并非队长，或你开启的苍坤上人洞府房间已解散"
    r"|苍坤洞府外层神禁极重，至少需要\s*(?P<need>\d+)\s*名修士合力破禁"
)
_DISSOLVED_RE = re.compile(
    r"(?:已将副本房间\s*[（(]\s*ID\s*[:：]\s*(?P<id>\d+)\s*[）)]\s*解散"
    r"|已解散苍坤上人洞府房间[（(]\s*ID\s*[:：]\s*(?P<cangkun_id>\d+)\s*[）)])"
)


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
        if joined := _CANGKUN_JOINED_RE.search(text):
            user = joined.group("u")
            return ParserOutput(
                cards=(
                    ParsedCard(
                        id=event.id,
                        channels=("system", "dungeon"),
                        title="加入副本成功",
                        summary=f"@{user} 已加入苍坤上人洞府",
                        source=event.source,
                        time=event.date,
                        tags=("副本", "加入", "苍坤上人洞府"),
                        raw=event.text,
                        fields={"username": user, "副本名": "苍坤上人洞府", "状态": "已加入"},
                    ),
                ),
            )
        if failed := _JOIN_FAILED_RE.search(text):
            reason = _join_failed_reason(failed)
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
                        fields={"状态": "加入失败", "失败原因": reason, **_failed_dungeon_name(text)},
                    ),
                ),
            )
        if dissolved := _DISSOLVED_RE.search(text):
            dungeon_id = dissolved.group("id") or dissolved.group("cangkun_id")
            dungeon_name = _dissolved_dungeon_name(text)
            fields = {"副本ID": dungeon_id}
            if dungeon_name:
                fields["副本名"] = dungeon_name
            return ParserOutput(
                cards=(
                    ParsedCard(
                        id=event.id,
                        channels=("system", "dungeon"),
                        title="副本房间解散",
                        summary=f"副本 {dungeon_id} 已解散",
                        source=event.source,
                        time=event.date,
                        tags=tuple(x for x in ("副本", dungeon_name, "解散") if x),
                        raw=event.text,
                        fields=fields,
                    ),
                ),
            )
        return None


def _join_failed_reason(match: re.Match) -> str:
    text = match.group(0).strip()
    if match.groupdict().get("realm"):
        return f"境界不足，需要 {match.group('realm').strip()} 及以上"
    if match.groupdict().get("need"):
        return f"人数不足，需要 {match.group('need')} 人"
    if "已在一个苍坤上人洞府队伍中" in text:
        return "已在苍坤上人洞府队伍中"
    if "你并非队长" in text:
        return "非队长或苍坤上人洞府房间已解散"
    if "苍坤上人洞府房间" in text:
        return "找不到苍坤上人洞府房间，可能已出发或已解散"
    return "找不到房间，可能已解散或ID错误"


def _failed_dungeon_name(text: str) -> dict:
    if "苍坤" in text:
        return {"副本名": "苍坤上人洞府"}
    return {}


def _dissolved_dungeon_name(text: str) -> str:
    if "苍坤" in text:
        return "苍坤上人洞府"
    return ""
