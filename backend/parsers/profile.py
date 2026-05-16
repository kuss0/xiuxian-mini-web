"""角色面板 parser:识别「天命玉牒」消息,提取灵根/宗门/称号/修为等基础信息,
通过 StatePatch(scope=identity_profile) 投影给角色面板。

跟老脚本 SEND_AS_PROFILE_DEFAULTS 对齐 — 修为拆 current/max、灵根拆 type/attrs,
方便 UI 渲染进度条 + 排序比较。
"""

from __future__ import annotations

import re

from backend.domain.models import ParsedCard, RawMessageEvent, StatePatch
from backend.domain.realm import infer_realm_from_xiuwei_max
from backend.domain.registry import ParserOutput

ROOT_RE = re.compile(r"灵根[:：]\s*(?P<root>[^\n]+)")
TITLE_RE = re.compile(r"称号[:：]\s*(?P<title>[^\n]+)")
CULTIVATION_RE = re.compile(r"修为[:：]\s*(?P<cur>[\d,]+)\s*/\s*(?P<mx>[\d,]+)")
USERNAME_RE = re.compile(r"@(?P<u>[A-Za-z0-9_]{3,})\s*的天命玉牒")
# "天灵根(火)" / "伪灵根(金木水)" / "异灵根(雷)" 等 — 拆出 type + attrs
ROOT_SPLIT_RE = re.compile(r"^(?P<t>[^\(（]+?)\s*[\(（](?P<a>[^\)）]*)[\)）]\s*$")


def _split_root(root: str) -> tuple[str, str]:
    text = (root or "").strip()
    m = ROOT_SPLIT_RE.match(text)
    if m:
        return m.group("t").strip(), m.group("a").strip()
    return text, ""


class ProfileParser:
    name = "profile"

    def parse(self, event: RawMessageEvent) -> ParserOutput | None:
        text = event.text
        if "天命玉牒" not in text:
            return None
        fields: dict[str, object] = {}
        if match := ROOT_RE.search(text):
            root_raw = match.group("root").strip()
            fields["灵根"] = root_raw
            rtype, rattrs = _split_root(root_raw)
            if rtype:
                fields["spiritual_root_type"] = rtype
            if rattrs:
                fields["spiritual_root_attrs"] = rattrs
        if "宗门:" in text:
            fields["宗门"] = text.split("宗门:", 1)[1].splitlines()[0].strip()
        if match := TITLE_RE.search(text):
            fields["称号"] = match.group("title").strip()
        if match := CULTIVATION_RE.search(text):
            cur = int(match.group("cur").replace(",", ""))
            mx = int(match.group("mx").replace(",", ""))
            fields["修为"] = f"{cur} / {mx}"
            fields["修为进度"] = {"current": cur, "max": mx}
            fields["xiuwei_current"] = cur
            fields["xiuwei_max"] = mx
            # 玉牒 没明确写 境界,但 xiuwei_max 是固定阶梯 → 反推
            inferred = infer_realm_from_xiuwei_max(mx)
            if inferred:
                fields["境界"] = inferred
        if match := USERNAME_RE.search(text):
            fields["username"] = match.group("u").strip()
        # 复杂结构(dict)不走 state patch,只在卡片字段;基本字段都进 patch
        skip_in_patches = {"修为进度"}
        patches = tuple(
            StatePatch(
                scope="identity_profile",
                key=str(key),
                value=value,
                source_message_id=event.id,
            )
            for key, value in fields.items()
            if key not in skip_in_patches
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
