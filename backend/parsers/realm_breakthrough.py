"""境界突破 parser:识别「灵光一闪！恭喜 @user 道友，修为精进，成功突破至【XX】！」
广播,提取目标用户 username + 新境界,投影到 identity_profile。

老脚本:control.py:185 RE_REALM_BREAKTHROUGH + :2321 match_realm_breakthrough_identity
"""

from __future__ import annotations

import re

from backend.domain.models import ParsedCard, RawMessageEvent, StatePatch
from backend.domain.registry import ParserOutput

REALM_RE = re.compile(r"成功突破至【(?P<realm>[^】]+)】")
USERNAME_RE = re.compile(r"@(?P<u>[A-Za-z0-9_]{3,})\s*道友")


class RealmBreakthroughParser:
    name = "realm_breakthrough"

    def parse(self, event: RawMessageEvent) -> ParserOutput | None:
        text = event.text or ""
        if "灵光一闪" not in text or "成功突破至【" not in text:
            return None
        realm_match = REALM_RE.search(text)
        if not realm_match:
            return None
        realm = realm_match.group("realm").strip()
        fields: dict[str, str] = {"境界": realm}
        username_match = USERNAME_RE.search(text)
        if username_match:
            fields["username"] = username_match.group("u").strip()
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
                    title="境界突破",
                    summary=f"突破至 {realm}!",
                    source=event.source,
                    time=event.date,
                    tags=("角色", "突破"),
                    raw=event.text,
                    fields=fields,
                ),
            ),
            state_patches=patches,
        )
