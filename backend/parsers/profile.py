"""角色面板 parser:识别「天命玉牒」消息,提取灵根/宗门等基础信息,
通过 StatePatch(scope=identity_profile) 投影给角色面板。"""

from __future__ import annotations

import re

from backend.domain.models import ParsedCard, RawMessageEvent, StatePatch
from backend.domain.registry import ParserOutput

ROOT_RE = re.compile(r"灵根[:：]\s*(?P<root>[^\n]+)")


class ProfileParser:
    name = "profile"

    def parse(self, event: RawMessageEvent) -> ParserOutput | None:
        text = event.text
        if "天命玉牒" not in text:
            return None
        fields: dict[str, str] = {}
        if match := ROOT_RE.search(text):
            fields["灵根"] = match.group("root").strip()
        if "宗门:" in text:
            fields["宗门"] = text.split("宗门:", 1)[1].splitlines()[0].strip()
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
                    title="角色信息",
                    summary="已识别角色基础面板。",
                    source=event.source,
                    time=event.date,
                    tags=("角色", "灵根"),
                    raw=event.text,
                    fields=fields,
                ),
            ),
            state_patches=patches,
        )
