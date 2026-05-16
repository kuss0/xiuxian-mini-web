"""赐予道号 parser:识别「天命已定」事件,抽取 道号 + 先天灵根 + 起始境界。

老脚本 .检测灵根 / .结缘 触发的事件消息长这样:
    天命已定！恭喜 @user 成功踏入仙途!
    赐予道号: 素尘子
    先天灵根: 伪灵根(金木水)
    长老判词: "..."
    你当前的境界为 【炼气一层】,...
"""

from __future__ import annotations

import re

from backend.domain.models import ParsedCard, RawMessageEvent, StatePatch
from backend.domain.registry import ParserOutput

NAMING_RE = re.compile(r"赐予道号[:：]\s*(?P<name>[^\n]+)")
ROOT_RE = re.compile(r"先天灵根[:：]\s*(?P<root>[^\n]+)")
REALM_RE = re.compile(r"当前的境界为\s*【(?P<realm>[^】]+)】")


class NamingParser:
    name = "naming"

    def parse(self, event: RawMessageEvent) -> ParserOutput | None:
        text = event.text
        if "赐予道号" not in text:
            return None
        fields: dict[str, str] = {}
        if match := NAMING_RE.search(text):
            fields["道号"] = match.group("name").strip()
        if match := ROOT_RE.search(text):
            fields["灵根"] = match.group("root").strip()
        if match := REALM_RE.search(text):
            fields["境界"] = match.group("realm").strip()
        if not fields:
            return None
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
                    channels=("mine", "system"),
                    title="赐予道号",
                    summary="新角色诞生,记录道号 + 灵根 + 起始境界。",
                    source=event.source,
                    time=event.date,
                    tags=("角色", "道号"),
                    raw=event.text,
                    fields=fields,
                ),
            ),
            state_patches=patches,
        )
