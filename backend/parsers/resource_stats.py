"""资源统计 parser:只提取收益流水,不改变消息展示和发送行为。"""

from __future__ import annotations

import re

from backend.domain.models import RawMessageEvent, ResourceDelta
from backend.domain.registry import ParserOutput


WILD_TITLE_RE = re.compile(r"【野外历练(?:\s*[·・]\s*(?P<name>[^】]+))?】")
DUNGEON_LOOT_TITLE_RE = re.compile(r"【战利品结算(?:[·・]\s*(?P<name>[^】]+))?】")
PLAYER_RE = re.compile(r"@(?P<user>[A-Za-z0-9_]+)")
RESOURCE_PLUS_RE = re.compile(r"(?P<name>修为|贡献|灵石)\s*[+＋]\s*(?P<amount>\d+)")
AMOUNT_BEFORE_RESOURCE_RE = re.compile(r"(?P<amount>\d+)\s*(?P<name>修为|贡献|灵石)")
RESOURCE_X_RE = re.compile(
    r"(?:【(?P<bracket>[^】]+)】|(?P<name>[\u4e00-\u9fffA-Za-z0-9_]+))\s*[xX×*]\s*(?P<amount>\d+)"
)

NON_BLOOD_DUNGEONS = ("虚天殿", "黄龙山", "昆吾山", "坠魔谷")
BLOOD_MARKERS = ("血色试炼", "血色副本")


class ResourceStatsParser:
    name = "resource_stats"

    def parse(self, event: RawMessageEvent) -> ParserOutput | None:
        text = event.text or ""
        if not text:
            return None
        if WILD_TITLE_RE.search(text):
            return self._parse_wild_training(event)
        if DUNGEON_LOOT_TITLE_RE.search(text):
            return self._parse_dungeon_loot(event)
        return None

    def _parse_wild_training(self, event: RawMessageEvent) -> ParserOutput | None:
        text = event.text or ""
        title = WILD_TITLE_RE.search(text)
        player = ""
        if match := PLAYER_RE.search(text):
            player = match.group("user")
        meta = {"title": "野外历练"}
        if title and title.group("name"):
            meta["title_detail"] = title.group("name").strip()
        deltas = _extract_reward_deltas(
            event,
            text,
            source_type="wild_training",
            source_name="野外历练",
            player=player,
            basis="player",
            meta=meta,
        )
        if not deltas:
            return None
        return ParserOutput(resource_deltas=tuple(deltas))

    def _parse_dungeon_loot(self, event: RawMessageEvent) -> ParserOutput | None:
        text = event.text or ""
        title = DUNGEON_LOOT_TITLE_RE.search(text)
        title_detail = (title.group("name") if title else "") or ""
        if any(marker in text for marker in BLOOD_MARKERS) or "血色" in title_detail:
            return None
        reward_lines = "\n".join(
            line for line in text.splitlines() if "获得" in line or "均获得" in line
        )
        if not reward_lines:
            return None
        meta = {"title": "战利品结算"}
        if title_detail:
            meta["settlement"] = title_detail.strip()
        deltas = _extract_reward_deltas(
            event,
            reward_lines,
            source_type="dungeon",
            source_name=_infer_dungeon_name(text),
            player="",
            basis="per_member",
            meta=meta,
        )
        if not deltas:
            return None
        return ParserOutput(resource_deltas=tuple(deltas))


def _extract_reward_deltas(
    event: RawMessageEvent,
    text: str,
    *,
    source_type: str,
    source_name: str,
    player: str,
    basis: str,
    meta: dict,
) -> list[ResourceDelta]:
    found: list[ResourceDelta] = []

    def add(name: str, amount: str) -> None:
        resource_name = str(name or "").strip()
        if not resource_name:
            return
        try:
            value = int(str(amount or "0").strip())
        except ValueError:
            return
        if value <= 0:
            return
        found.append(
            ResourceDelta(
                raw_message_id=event.id,
                source_type=source_type,
                source_name=source_name,
                player=player,
                resource_name=resource_name,
                amount=value,
                unit="点" if resource_name == "修为" else "",
                basis=basis,
                event_time=event.date,
                chat_id=int(event.chat_id or 0),
                msg_id=int(event.msg_id or 0),
                meta=dict(meta),
            )
        )

    for match in RESOURCE_PLUS_RE.finditer(text):
        add(match.group("name"), match.group("amount"))
    for match in AMOUNT_BEFORE_RESOURCE_RE.finditer(text):
        add(match.group("name"), match.group("amount"))
    for match in RESOURCE_X_RE.finditer(text):
        add(match.group("bracket") or match.group("name"), match.group("amount"))
    return found


def _infer_dungeon_name(text: str) -> str:
    for name in NON_BLOOD_DUNGEONS:
        if name in text:
            return name
    if any(marker in text for marker in ("玄冰秘径", "极寒冰魄", "焚天烈焰", "夺鼎")):
        return "虚天殿"
    return "副本"
