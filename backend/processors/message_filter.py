from __future__ import annotations

from dataclasses import dataclass
from typing import Callable

from backend.domain.models import ParsedCard, RawMessageEvent


DEFAULT_FOCUS_KEYWORDS = (
    "猴子",
    "玄骨",
    "极阴",
    "风希",
    "洞府",
    "虚天殿",
    "黄龙山",
    "昆吾山",
    "坠魔谷",
    "血色试炼",
    "副本ID",
    "稳控全场",
    "天道审判",
    "挂机嫌疑",
    "自证",
    "举报",
    "封禁",
    "虚弱",
    "静思崖",
    "共历心劫",
    "心魔",
    "显灵",
)


@dataclass(frozen=True)
class FilterResult:
    channels: tuple[str, ...]
    tags: tuple[str, ...]


def enrich_filter_channels(
    card: ParsedCard,
    event: RawMessageEvent,
    settings: dict,
    *,
    is_game_bot_sender: Callable[[int | None], bool],
) -> FilterResult:
    """Add product-level message filtering channels.

    This layer is deliberately presentation-oriented: it does not infer game
    state or trigger sends. It only decides whether a card belongs in the
    realtime focus stream, leader stream, or archive.
    """
    channels = list(card.channels or ())
    tags = list(card.tags or ())
    text = event.text or card.raw or ""
    sender_id = event.sender_id
    bot_like = bool(event.sender_is_bot) or bool(is_game_bot_sender(sender_id))
    dot_command = is_dot_command(text)

    own_mention = has_own_mention(
        text,
        mentions=event.mentions,
        aliases=_list_setting(settings, "own_aliases"),
    )
    leader = is_leader_message(
        event,
        leader_sender_ids=_int_list_setting(settings, "leader_sender_ids"),
        leader_source_names=_list_setting(settings, "leader_source_names"),
    )
    keyword_hits = focus_keyword_hits(
        text,
        _list_setting(settings, "focus_keywords") or list(DEFAULT_FOCUS_KEYWORDS),
    )

    card_important = (
        card.severity == "risk"
        or "risk" in channels
        or bool(card.actions)
        or "dungeon" in channels
        or own_mention
        or leader
        or bool(keyword_hits)
    )
    plain_player = (
        bool(settings.get("focus_include_player_plain", True))
        and not bot_like
        and not dot_command
    )

    if leader:
        _append_unique(channels, "leader")
        _append_unique(tags, "会长")
    if own_mention:
        _append_unique(tags, "被@")
    for hit in keyword_hits[:3]:
        _append_unique(tags, f"关键词:{hit}")

    if card_important or plain_player:
        _append_unique(channels, "focus")

    archive_dot = bool(settings.get("archive_dot_commands", True))
    archive_bot = bool(settings.get("archive_bot_replies", True))
    if (archive_dot and dot_command) or (archive_bot and bot_like and not card_important):
        _append_unique(channels, "archive")
        _append_unique(tags, "归档")

    if not channels:
        channels.append("world")
    return FilterResult(channels=tuple(channels), tags=tuple(tags))


def is_dot_command(text: str) -> bool:
    stripped = str(text or "").lstrip()
    return stripped.startswith(".") or stripped.startswith("。")


def has_own_mention(text: str, *, mentions: tuple[str, ...], aliases: list[str]) -> bool:
    raw_text = str(text or "")
    normalized_aliases = [_normalize_alias(alias) for alias in aliases if _normalize_alias(alias)]
    normalized_mentions = {_normalize_alias(item) for item in (mentions or ()) if _normalize_alias(item)}
    if normalized_aliases:
        if normalized_mentions.intersection(normalized_aliases):
            return True
        lowered = raw_text.lower()
        return any(f"@{alias.lower()}" in lowered for alias in normalized_aliases)
    return False


def is_leader_message(
    event: RawMessageEvent,
    *,
    leader_sender_ids: list[int],
    leader_source_names: list[str],
) -> bool:
    sender_id = int(event.sender_id or 0)
    if sender_id and sender_id in set(leader_sender_ids):
        return True
    source = str(event.source or "").strip().lower()
    if not source:
        return False
    return any(name.lower() in source for name in leader_source_names if name)


def focus_keyword_hits(text: str, keywords: list[str]) -> list[str]:
    raw = str(text or "")
    hits = []
    for keyword in keywords:
        key = str(keyword or "").strip()
        if key and key in raw and key not in hits:
            hits.append(key)
    return hits


def _append_unique(items: list[str], value: str) -> None:
    if value not in items:
        items.append(value)


def _normalize_alias(value: str) -> str:
    return str(value or "").strip().lstrip("@")


def _list_setting(settings: dict, key: str) -> list[str]:
    raw = settings.get(key) or []
    if isinstance(raw, str):
        raw = raw.replace("\n", ",").split(",")
    return [str(item).strip() for item in raw if str(item or "").strip()]


def _int_list_setting(settings: dict, key: str) -> list[int]:
    out = []
    for item in _list_setting(settings, key):
        try:
            out.append(int(item))
        except (TypeError, ValueError):
            continue
    return out
