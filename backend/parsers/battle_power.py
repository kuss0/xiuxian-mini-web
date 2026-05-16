"""战力评估 parser:识别「天机阁 · 战力评估」类消息,提取综合战力(字符串 + 数值) +
境界 + 角色名,投影到 identity_profile。"""

from __future__ import annotations

import re

from backend.domain.models import ParsedCard, RawMessageEvent, StatePatch
from backend.domain.registry import ParserOutput

POWER_RE = re.compile(r"综合战力[:：]\s*(?P<power>[^\n]+)")
POWER_VALUE_RE = re.compile(r"^\s*(?P<num>[\d.,]+)\s*(?P<unit>[万亿]?)\s*$")
REALM_RE = re.compile(r"境界[:：]\s*(?P<realm>[^\n(]+)")
# "修士: 墨隐 (@VanDu2233)"  ← 角色名 + username
CULTIVATOR_RE = re.compile(
    r"修士[:：]\s*(?P<name>[^\n(@（]+?)(?:\s*[\(（]\s*@?(?P<u>[^\)）\s]+)\s*[\)）])?\s*$",
    re.MULTILINE,
)


def _power_to_value(text: str) -> int:
    """\"333.8万\" → 3338000;\"87.54亿\" → 8754000000;\"1234\" → 1234。"""
    match = POWER_VALUE_RE.match(text or "")
    if not match:
        return 0
    try:
        num = float(match.group("num").replace(",", ""))
    except ValueError:
        return 0
    unit = match.group("unit") or ""
    multiplier = {"万": 10_000, "亿": 100_000_000}.get(unit, 1)
    return int(num * multiplier)


class BattlePowerParser:
    name = "battle_power"

    def parse(self, event: RawMessageEvent) -> ParserOutput | None:
        text = event.text
        if "战力评估" not in text:
            return None
        fields: dict[str, object] = {}
        if match := POWER_RE.search(text):
            power_text = match.group("power").strip()
            fields["综合战力"] = power_text
            value = _power_to_value(power_text)
            if value > 0:
                fields["battle_power_value"] = value
        if match := REALM_RE.search(text):
            fields["境界"] = match.group("realm").strip()
        if match := CULTIVATOR_RE.search(text):
            fields["角色名"] = match.group("name").strip()
            if match.group("u"):
                fields["username"] = match.group("u").strip()
        patches = tuple(
            StatePatch(
                scope="identity_profile",
                key=str(key),
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
