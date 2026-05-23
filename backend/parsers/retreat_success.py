"""闭关成功(浅闭关)parser:识别「【闭关成功】」战报,
提取修为增加各档加成、当前境界/修为、调息冷却。

样本:
    【闭关成功】
    掩月心契·守秘: 天机偏转，本次奇遇率提高。
    你福至心灵，成功炼化灵气，基础修为增加了 480 点。
    因【星宫】灵脉加持，你额外获得了 168 点修为！
    星力加持: 阵法之力使你的收益额外提升了 324 点！
    本次闭关，你的修为最终增加了 972 点。
    【奇遇】... 提炼出了【金精矿】x1！
    当前境界: 元婴后期
    当前修为: 572479 / 2000000
    你感到一阵疲惫，需要打坐调息 11 分钟方可再次闭关。
"""

from __future__ import annotations

import re

from backend.domain.models import ParsedCard, RawMessageEvent
from backend.domain.registry import ParserOutput

BASE_RE = re.compile(r"基础修为增加了\s*(?P<v>\d+)\s*点")
SECT_BONUS_RE = re.compile(r"灵脉加持[，,]\s*你额外获得了\s*(?P<v>\d+)\s*点修为")
ARRAY_BONUS_RE = re.compile(r"星力加持[:：][^\n]*?提升了\s*(?P<v>\d+)\s*点")
TOTAL_RE = re.compile(r"修为最终增加了\s*(?P<v>\d+)\s*点")
REALM_RE = re.compile(r"当前境界[:：]\s*(?P<v>[^\n]+)")
EXP_RE = re.compile(r"当前修为[:：]\s*(?P<cur>\d+)\s*/\s*(?P<max>\d+)")
COOLDOWN_RE = re.compile(r"打坐调息\s*(?P<v>\d+)\s*分钟")
ADV_RE = re.compile(r"【奇遇】(?P<v>[^\n]+)")


class RetreatSuccessParser:
    name = "retreat_success"

    def parse(self, event: RawMessageEvent) -> ParserOutput | None:
        text = event.text or ""
        if "【闭关成功】" not in text:
            return None
        fields: dict[str, object] = {}
        if m := BASE_RE.search(text):
            fields["基础修为"] = f"{m.group('v')} 点"
        if m := SECT_BONUS_RE.search(text):
            fields["灵脉加成"] = f"{m.group('v')} 点"
        if m := ARRAY_BONUS_RE.search(text):
            fields["阵法加成"] = f"{m.group('v')} 点"
        if m := TOTAL_RE.search(text):
            fields["本次总收益"] = f"{m.group('v')} 点"
        if m := REALM_RE.search(text):
            fields["当前境界"] = m.group("v").strip()
        if m := EXP_RE.search(text):
            cur, mx = int(m.group("cur")), int(m.group("max"))
            fields["当前修为"] = f"{cur} / {mx}"
            fields["修为进度"] = {"current": cur, "max": mx}
        if m := COOLDOWN_RE.search(text):
            fields["调息冷却"] = f"{m.group('v')} 分钟"
        if m := ADV_RE.search(text):
            fields["奇遇"] = m.group("v").strip()
        summary = "浅闭关结束。"
        if "本次总收益" in fields:
            summary = f"本次收益 {fields['本次总收益']}，{fields.get('当前境界', '')}".strip("，")
        return ParserOutput(
            cards=(
                ParsedCard(
                    id=event.id,
                    channels=("training",),
                    title="闭关成功",
                    summary=summary,
                    source=event.source,
                    time=event.date,
                    tags=("修炼", "浅闭关", "战报"),
                    raw=event.text,
                    fields=fields,
                ),
            ),
            state_patches=(),
        )
