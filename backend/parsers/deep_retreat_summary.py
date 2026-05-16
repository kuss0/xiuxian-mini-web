"""深度闭关总结 parser:识别「深度闭关总结」战报,
提取时长 / 吐纳次数 / 三类周天统计 / 奇遇次数 / 修为变化 / 状态加持。

样本头部典型形态:
    📜 修士 @xxx 深度闭关总结
    【深度闭关总结】
    本次结算时长: 8.0 小时 (基础上限8小时)
    神魂吐纳次数: 32 周天
    - 修行有成: N 次
    - 心神不宁: N 次
    - 走火入魔: N 次
    - 状态加持: ...
    - 天降奇遇: N 次
      - 具体奇遇 1
      - 具体奇遇 2
    本次深度闭关，你的修为最终变化了 N 点！
"""

from __future__ import annotations

import re

from backend.domain.models import ParsedCard, RawMessageEvent
from backend.domain.registry import ParserOutput

DURATION_RE = re.compile(r"本次结算时长[:：]\s*(?P<v>[^\n(（]+)")
ZHOUTIAN_RE = re.compile(r"神魂吐纳次数[:：]\s*(?P<v>\d+)\s*周天")
SUCCESS_RE = re.compile(r"修行有成[:：]\s*(?P<v>\d+)\s*次")
TROUBLE_RE = re.compile(r"心神不宁[:：]\s*(?P<v>\d+)\s*次")
DEMON_RE = re.compile(r"走火入魔[:：]\s*(?P<v>\d+)\s*次")
ADVENTURE_RE = re.compile(r"天降奇遇[:：]\s*(?P<v>\d+)\s*次")
BUFF_RE = re.compile(r"状态加持[:：]\s*(?P<v>[^\n]+)")
GAIN_RE = re.compile(r"修为最终变化了\s*(?P<v>-?\d+)\s*点")
ADV_LINE_RE = re.compile(r"^\s{2,}-\s+(?P<v>.+?)\s*$", re.MULTILINE)


class DeepRetreatSummaryParser:
    name = "deep_retreat_summary"

    def parse(self, event: RawMessageEvent) -> ParserOutput | None:
        text = event.text or ""
        if "【深度闭关总结】" not in text:
            return None
        fields: dict[str, object] = {}
        if m := DURATION_RE.search(text):
            fields["结算时长"] = m.group("v").strip()
        if m := ZHOUTIAN_RE.search(text):
            fields["神魂吐纳"] = f"{m.group('v')} 周天"
        if m := SUCCESS_RE.search(text):
            fields["修行有成"] = f"{m.group('v')} 次"
        if m := TROUBLE_RE.search(text):
            fields["心神不宁"] = f"{m.group('v')} 次"
        if m := DEMON_RE.search(text):
            fields["走火入魔"] = f"{m.group('v')} 次"
        if m := ADVENTURE_RE.search(text):
            fields["天降奇遇"] = f"{m.group('v')} 次"
        if m := BUFF_RE.search(text):
            fields["状态加持"] = m.group("v").strip()
        if m := GAIN_RE.search(text):
            fields["修为变化"] = f"{m.group('v')} 点"
        adventures = [line.strip() for line in ADV_LINE_RE.findall(text) if line.strip()]
        if adventures:
            fields["奇遇详情"] = adventures
        summary = "深度闭关结束，已整理本次收益与奇遇。"
        if "修为变化" in fields:
            summary = f"修为变化 {fields['修为变化']}，{fields.get('天降奇遇', '无奇遇')}。"
        return ParserOutput(
            cards=(
                ParsedCard(
                    id=event.id,
                    channels=("mine",),
                    title="深度闭关总结",
                    summary=summary,
                    source=event.source,
                    time=event.date,
                    tags=("修炼", "深度闭关", "战报"),
                    raw=event.text,
                    fields=fields,
                ),
            ),
            state_patches=(),
        )
