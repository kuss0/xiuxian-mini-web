"""资源统计 parser:入箱时提取执行事件和收益流水,不改变展示/发送行为。"""

from __future__ import annotations

import re

from backend.domain.models import RawMessageEvent, ResourceDelta, ResourceEvent
from backend.domain.registry import ParserOutput


WILD_TITLE_RE = re.compile(r"【野外历练(?:\s*[·・]\s*(?P<name>[^】]+))?】")
DUNGEON_LOOT_TITLE_RE = re.compile(r"【战利品结算(?:[·・]\s*(?P<name>[^】]+))?】")
PLAYER_RE = re.compile(r"@(?P<user>[A-Za-z0-9_]+)")
RESOURCE_PLUS_RE = re.compile(r"(?P<name>修为|贡献|灵石)\s*[+＋]\s*(?P<amount>\d+)")
RESOURCE_LOSS_RE = re.compile(r"(?P<name>修为)\s*折损\s*[-－]\s*(?P<amount>\d+)")
AMOUNT_BEFORE_RESOURCE_RE = re.compile(r"(?P<amount>\d+)\s*(?P<name>修为|贡献|灵石)")
RESOURCE_X_RE = re.compile(
    r"(?:【(?P<bracket>[^】]+)】|(?P<name>[\u4e00-\u9fff][\u4e00-\u9fff0-9]*))\s*[xX×*]\s*(?P<amount>\d+)"
)
ITEM_WITHOUT_AMOUNT_RE = re.compile(r"(?:^|[\s，。！])(?:@(?P<user>[A-Za-z0-9_]+)\s*)?额?外?获得了\s*【(?P<name>[^】]+)】(?=$|[\s，。！])")

NON_BLOOD_DUNGEONS = ("虚天殿", "黄龙山", "昆吾山", "坠魔谷")
BLOOD_MARKERS = ("血色试炼", "血色副本")
WILD_COOLDOWN_MARKERS = ("山中灵机未复", "后再来")
WILD_FAILED_MARKERS = ("NPC 历练失败", "修为折损")
DUNGEON_BASIC_ONLY_MARKERS = ("额外宝藏尽毁", "只保住了基础收获", "引发了反噬")
DUNGEON_EXTRA_MARKERS = ("全队额外获得", "额外获得了")


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
        player = _first_player(text)
        title_detail = (title.group("name") if title else "") or ""
        meta = {"title": "野外历练"}
        if title_detail:
            meta["title_detail"] = title_detail.strip()

        deltas = _extract_reward_deltas(
            event,
            text,
            source_type="wild_training",
            source_name="野外历练",
            player=player,
            basis="player",
            meta=meta,
        )
        deltas.extend(
            _extract_loss_deltas(
                event,
                text,
                source_type="wild_training",
                source_name="野外历练",
                player=player,
                basis="player",
                meta=meta,
            )
        )

        if _contains_any(text, WILD_COOLDOWN_MARKERS):
            result = "cooldown"
        elif title_detail.strip() == "负伤而归" or _contains_any(text, WILD_FAILED_MARKERS):
            result = "failed"
        elif deltas:
            result = "success"
        else:
            return None

        event_row = _resource_event(
            event,
            source_type="wild_training",
            source_name="野外历练",
            player=player,
            result=result,
            outcome=title_detail.strip(),
            meta=meta,
        )
        return ParserOutput(resource_deltas=tuple(deltas), resource_events=(event_row,))

    def _parse_dungeon_loot(self, event: RawMessageEvent) -> ParserOutput | None:
        text = event.text or ""
        title = DUNGEON_LOOT_TITLE_RE.search(text)
        title_detail = ((title.group("name") if title else "") or "").strip()
        if any(marker in text for marker in BLOOD_MARKERS) or "血色" in title_detail:
            return None
        reward_lines = "\n".join(
            line for line in text.splitlines() if "获得" in line or "均获得" in line
        )
        if not reward_lines:
            return None
        meta = {"title": "战利品结算"}
        if title_detail:
            meta["settlement"] = title_detail
        if "天命所归" in text or re.search(r"@[A-Za-z0-9_]+\s*额外获得了", text):
            meta["lucky_drop"] = True

        result = "settled"
        if _contains_any(text, DUNGEON_BASIC_ONLY_MARKERS):
            result = "basic_only"
        elif _contains_any(text, DUNGEON_EXTRA_MARKERS):
            result = "extra_success"

        deltas = _extract_reward_deltas(
            event,
            reward_lines,
            source_type="dungeon",
            source_name=_infer_dungeon_name(text),
            player="",
            basis="run",
            meta=meta,
        )
        deltas.extend(
            _extract_explicit_item_deltas(
                event,
                reward_lines,
                source_type="dungeon",
                source_name=_infer_dungeon_name(text),
                basis="run",
                meta=meta,
            )
        )
        if not deltas:
            return None
        event_row = _resource_event(
            event,
            source_type="dungeon",
            source_name=_infer_dungeon_name(text),
            player="",
            result=result,
            outcome=title_detail,
            meta=meta,
        )
        return ParserOutput(resource_deltas=tuple(deltas), resource_events=(event_row,))


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

    def add(name: str, amount: str, *, owner: str = "") -> None:
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
            _resource_delta(
                event,
                source_type=source_type,
                source_name=source_name,
                player=owner or player,
                resource_name=resource_name,
                amount=value,
                basis=basis,
                meta=meta,
            )
        )

    for match in RESOURCE_PLUS_RE.finditer(text):
        add(match.group("name"), match.group("amount"), owner=_line_owner_for_match(text, match.start()))
    for match in AMOUNT_BEFORE_RESOURCE_RE.finditer(text):
        add(match.group("name"), match.group("amount"), owner=_line_owner_for_match(text, match.start()))
    for match in RESOURCE_X_RE.finditer(text):
        add(
            match.group("bracket") or match.group("name"),
            match.group("amount"),
            owner=_line_owner_for_match(text, match.start()),
        )
    return found


def _extract_explicit_item_deltas(
    event: RawMessageEvent,
    text: str,
    *,
    source_type: str,
    source_name: str,
    basis: str,
    meta: dict,
) -> list[ResourceDelta]:
    found: list[ResourceDelta] = []
    for match in ITEM_WITHOUT_AMOUNT_RE.finditer(text):
        item = str(match.group("name") or "").strip()
        if not item or item.startswith("大量"):
            continue
        found.append(
            _resource_delta(
                event,
                source_type=source_type,
                source_name=source_name,
                player=match.group("user") or "",
                resource_name=item,
                amount=1,
                basis=basis,
                meta=meta | {"implicit_amount": True},
            )
        )
    return found


def _extract_loss_deltas(
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
    for match in RESOURCE_LOSS_RE.finditer(text):
        try:
            amount = -int(match.group("amount") or "0")
        except ValueError:
            continue
        if amount >= 0:
            continue
        found.append(
            _resource_delta(
                event,
                source_type=source_type,
                source_name=source_name,
                player=player,
                resource_name=match.group("name"),
                amount=amount,
                basis=basis,
                meta=meta | {"loss": True},
            )
        )
    return found


def _resource_delta(
    event: RawMessageEvent,
    *,
    source_type: str,
    source_name: str,
    player: str,
    resource_name: str,
    amount: int,
    basis: str,
    meta: dict,
) -> ResourceDelta:
    return ResourceDelta(
        raw_message_id=event.id,
        source_type=source_type,
        source_name=source_name,
        player=player,
        resource_name=resource_name,
        amount=amount,
        unit="点" if resource_name == "修为" else "",
        basis=basis,
        event_time=event.date,
        chat_id=int(event.chat_id or 0),
        msg_id=int(event.msg_id or 0),
        meta=dict(meta),
    )


def _resource_event(
    event: RawMessageEvent,
    *,
    source_type: str,
    source_name: str,
    player: str,
    result: str,
    outcome: str,
    meta: dict,
) -> ResourceEvent:
    return ResourceEvent(
        raw_message_id=event.id,
        source_type=source_type,
        source_name=source_name,
        player=player,
        result=result,
        outcome=outcome,
        event_time=event.date,
        chat_id=int(event.chat_id or 0),
        msg_id=int(event.msg_id or 0),
        meta=dict(meta),
    )


def _first_player(text: str) -> str:
    if match := PLAYER_RE.search(text):
        return match.group("user")
    return ""


def _line_owner_for_match(text: str, pos: int) -> str:
    start = text.rfind("\n", 0, max(0, pos)) + 1
    end = text.find("\n", max(0, pos))
    if end < 0:
        end = len(text)
    return _first_player(text[start:end])


def _contains_any(text: str, markers: tuple[str, ...]) -> bool:
    return any(marker in text for marker in markers)


def _infer_dungeon_name(text: str) -> str:
    for name in NON_BLOOD_DUNGEONS:
        if name in text:
            return name
    if any(marker in text for marker in ("玄冰秘径", "极寒冰魄", "焚天烈焰", "夺鼎", "求稳")):
        return "虚天殿"
    return "副本"
