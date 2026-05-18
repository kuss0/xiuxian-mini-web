"""副本 parser:识别副本开启、静场令和推进抉择类消息。

这里仍然只生成 UI 卡片和手动动作按钮,不做自动加入 / 自动抉择。
"""

from __future__ import annotations

import re

from backend.domain.models import ActionSuggestion, ParsedCard, RawMessageEvent
from backend.domain.registry import ParserOutput

DUNGEON_NAMES = ("虚天殿", "黄龙山", "昆吾山", "坠魔谷", "血色试炼")
DUNGEON_ID_RE = re.compile(r"副本ID[:：]\s*(?P<id>\d+)")
OPEN_TITLE_RE = re.compile(r"【(?P<name>[^】]+?)已开启】")
OPENER_RE = re.compile(r"@(?P<opener>[A-Za-z0-9_]+)\s*消耗了【(?P<item>[^】]+)】")
CAPACITY_RE = re.compile(r"[（(]\s*(?P<max>\d+)\s*人满\s*[）)]")
STAGE_TITLE_RE = re.compile(
    rf"【(?P<name>{'|'.join(map(re.escape, DUNGEON_NAMES))})[·・](?P<stage>[^】]+)】"
)
CHOICE_RE = re.compile(r"使用\s*(?P<cmd>[.。][\w\u4e00-\u9fff]+)\s+(?P<opts>[^。\n]+?)\s*继续")
PATH_RE = re.compile(r"^\s*(?P<key>路径\d+)\s*[·.・]\s*(?P<label>[^：:\n]+)\s*[：:]", re.M)
SILENCE_READY_RE = re.compile(r"为本次【(?P<name>[^】]+)】立下静场令")


class DungeonParser:
    name = "dungeon"

    def parse(self, event: RawMessageEvent) -> ParserOutput | None:
        text = event.text
        if not text:
            return None
        return (
            self._parse_open(event)
            or self._parse_progress_choice(event)
            or self._parse_silence_order(event)
        )

    def _parse_open(self, event: RawMessageEvent) -> ParserOutput | None:
        text = event.text
        if "加入队伍" not in text:
            return None
        match = DUNGEON_ID_RE.search(text)
        if not match:
            return None
        dungeon_id = match.group("id")
        title_match = OPEN_TITLE_RE.search(text)
        dungeon_name = _normalize_dungeon_name(title_match.group("name") if title_match else "") or "副本"
        opener_match = OPENER_RE.search(text)
        capacity_match = CAPACITY_RE.search(text)
        fields = {
            "副本名": dungeon_name,
            "副本ID": dungeon_id,
            "状态": "可加入",
        }
        if opener_match:
            fields["开门人"] = f"@{opener_match.group('opener')}"
            fields["消耗道具"] = opener_match.group("item")
        if capacity_match:
            fields["人数上限"] = f"{capacity_match.group('max')}人"
        return ParserOutput(
            cards=(
                ParsedCard(
                    id=event.id,
                    channels=("system", "dungeon", "console"),
                    title=f"{dungeon_name}开启",
                    summary=f"发现{dungeon_name}副本公告,可人工确认加入。",
                    source=event.source,
                    time=event.date,
                    tags=("副本", dungeon_name, "可加入"),
                    raw=event.text,
                    fields=fields,
                    actions=(
                        ActionSuggestion(
                            "copy",
                            "加入副本",
                            f".加入副本 {dungeon_id}",
                            chat_id=event.chat_id,
                            reply_to_msg_id=event.msg_id,
                        ),
                    ),
                ),
            )
        )

    def _parse_progress_choice(self, event: RawMessageEvent) -> ParserOutput | None:
        text = event.text
        choice = CHOICE_RE.search(text)
        stage = STAGE_TITLE_RE.search(text)
        if not choice and not stage:
            return None
        dungeon_name = ""
        stage_text = ""
        if stage:
            dungeon_name = stage.group("name").strip()
            stage_text = stage.group("stage").strip()
        else:
            dungeon_name = _find_dungeon_name(text)
        if not dungeon_name:
            return None
        fields: dict[str, object] = {
            "副本名": dungeon_name,
            "状态": "需要抉择" if choice else "进行中",
        }
        if stage_text:
            fields["阶段"] = stage_text
        paths = _extract_paths(text)
        if paths:
            fields["可选路径"] = paths
        if "【稳控全场】已展开" in text:
            fields["静场令"] = "已展开"
            fields["状态"] = "静场中 / 需要抉择" if choice else "静场中"

        actions: tuple[ActionSuggestion, ...] = ()
        if choice:
            command = choice.group("cmd").strip().replace("。", ".", 1)
            options = _split_options(choice.group("opts"))
            actions = tuple(
                ActionSuggestion(
                    "copy",
                    option,
                    f"{command} {option}",
                    chat_id=event.chat_id,
                    reply_to_msg_id=event.msg_id,
                )
                for option in options
            )

        return ParserOutput(
            cards=(
                ParsedCard(
                    id=event.id,
                    channels=("system", "dungeon"),
                    title=f"{dungeon_name}推进",
                    summary=f"{dungeon_name}{stage_text or ''}正在推进,请人工选择下一步。",
                    source=event.source,
                    time=event.date,
                    tags=tuple(
                        x
                        for x in (
                            "副本",
                            dungeon_name,
                            "进行中",
                            "需要抉择" if actions else "",
                            "静场令" if fields.get("静场令") else "",
                        )
                        if x
                    ),
                    raw=event.text,
                    fields=fields,
                    actions=actions,
                ),
            )
        )

    def _parse_silence_order(self, event: RawMessageEvent) -> ParserOutput | None:
        text = event.text
        if "静场令" not in text and "稳控全场" not in text:
            return None
        ready = SILENCE_READY_RE.search(text)
        if not ready:
            return None
        dungeon_name = _normalize_dungeon_name(ready.group("name")) or "副本"
        return ParserOutput(
            cards=(
                ParsedCard(
                    id=event.id,
                    channels=("system", "dungeon"),
                    title="副本静场令",
                    summary=f"{dungeon_name}静场令已准备,正式进入副本后生效。",
                    source=event.source,
                    time=event.date,
                    tags=("副本", dungeon_name, "静场令", "待生效"),
                    raw=event.text,
                    fields={
                        "副本名": dungeon_name,
                        "状态": "静场令待生效",
                        "静场令": "待副本正式进入后展开",
                    },
                ),
            )
        )


def _normalize_dungeon_name(value: str) -> str:
    text = str(value or "").strip()
    for name in DUNGEON_NAMES:
        if name in text:
            return name
    return text if text in DUNGEON_NAMES else ""


def _find_dungeon_name(text: str) -> str:
    for name in DUNGEON_NAMES:
        if name in text:
            return name
    return ""


def _split_options(value: str) -> list[str]:
    raw = str(value or "").strip()
    parts = re.split(r"\s*[/／、]\s*", raw)
    return [part.strip() for part in parts if part.strip()]


def _extract_paths(text: str) -> list[str]:
    paths = []
    for match in PATH_RE.finditer(text or ""):
        paths.append(f"{match.group('key')} · {match.group('label').strip()}")
    return paths
