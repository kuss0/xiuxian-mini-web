"""角色面板 parser:识别「天命玉牒」消息,提取灵根/宗门/称号/修为等基础信息,
通过 StatePatch(scope=identity_profile) 投影给角色面板。"""

from __future__ import annotations

import re

from backend.domain.models import ParsedCard, RawMessageEvent, StatePatch
from backend.domain.registry import ParserOutput

ROOT_RE = re.compile(r"灵根[:：]\s*(?P<root>[^\n]+)")
TITLE_RE = re.compile(r"称号[:：]\s*(?P<title>[^\n]+)")
CULTIVATION_RE = re.compile(r"修为[:：]\s*(?P<cur>\d+)\s*/\s*(?P<mx>\d+)")
USERNAME_RE = re.compile(r"@(?P<u>[A-Za-z0-9_]{3,})\s*的天命玉牒")


class ProfileParser:
    name = "profile"

    def parse(self, event: RawMessageEvent) -> ParserOutput | None:
        text = event.text
        if "天命玉牒" not in text:
            return None
        fields: dict[str, object] = {}
        if match := ROOT_RE.search(text):
            fields["灵根"] = match.group("root").strip()
        if "宗门:" in text:
            fields["宗门"] = text.split("宗门:", 1)[1].splitlines()[0].strip()
        if match := TITLE_RE.search(text):
            fields["称号"] = match.group("title").strip()
        if match := CULTIVATION_RE.search(text):
            cur = int(match.group("cur"))
            mx = int(match.group("mx"))
            fields["修为"] = f"{cur} / {mx}"
            fields["修为进度"] = {"current": cur, "max": mx}
        if match := USERNAME_RE.search(text):
            fields["username"] = match.group("u").strip()
        patches = tuple(
            StatePatch(
                scope="identity_profile",
                key=str(key),
                value=value,
                source_message_id=event.id,
            )
            for key, value in fields.items()
            if key != "修为进度"  # dict 值不进 state patch,只在卡片字段里用
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
