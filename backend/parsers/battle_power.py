"""战力评估 parser:识别「天机阁 · 战力评估」类消息,提取综合战力 + 境界 + 角色名,
投影到 identity_profile。"""

from __future__ import annotations

import re

from backend.domain.models import ParsedCard, RawMessageEvent, StatePatch
from backend.domain.registry import ParserOutput

POWER_RE = re.compile(r"综合战力[:：]\s*(?P<power>[^\n]+)")
REALM_RE = re.compile(r"境界[:：]\s*(?P<realm>[^\n(]+)")
# "修士: 墨隐 (@VanDu2233)"  ← 角色名 + username
CULTIVATOR_RE = re.compile(
    r"修士[:：]\s*(?P<name>[^\n(@（]+?)(?:\s*[\(（]\s*@?(?P<u>[^\)）\s]+)\s*[\)）])?\s*$",
    re.MULTILINE,
)


class BattlePowerParser:
    name = "battle_power"

    def parse(self, event: RawMessageEvent) -> ParserOutput | None:
        text = event.text
        if "战力评估" not in text:
            return None
        fields: dict[str, str] = {}
        if match := POWER_RE.search(text):
            fields["综合战力"] = match.group("power").strip()
        if match := REALM_RE.search(text):
            fields["境界"] = match.group("realm").strip()
        if match := CULTIVATOR_RE.search(text):
            fields["角色名"] = match.group("name").strip()
            if match.group("u"):
                fields["username"] = match.group("u").strip()
        patches = tuple(
            StatePatch(
                scope="identity_profile",
                key=key,
                value=value,
                source_message_id=event.id,
            )
            for key, value in fields.items()
        )
        return ParserOutput(
            cards=(
                ParsedCard(
                    id=event.id,
                    channels=("mine",),
                    title="战力评估",
                    summary="已识别战力构成摘要。",
                    source=event.source,
                    time=event.date,
                    tags=("战力", "角色"),
                    raw=event.text,
                    fields=fields,
                ),
            ),
            state_patches=patches,
        )
