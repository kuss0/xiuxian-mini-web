"""试炼古塔战报 parser:识别「【试炼古塔 - 战报】」,
提取总层数、收获列表、塔相轨迹、构筑系数、奇遇/词缀、同境界排名。

样本:
    【试炼古塔 - 战报】
    闯塔历程:
    - 第 1 层 (炼气一层 / 宝库层):  - 碾压：...
    - 第 N 层 (...):  - 败北：...
    总收获:
    本次共闯过 19 层。
     - 修为 增加了 3659 点
     - 获得了【灵石】x520
     ...
    本次塔相轨迹: 宝库层x6 / 试炼层x6 / 机缘层x5 / 心魔层x3
    本次构筑: 攻势x1.19 / 敌势x1.14 / 收益x1.53 / 机缘+5%
    触发奇遇: 魔念回响、玄光洗礼、...
    遭遇词缀: 噬灵x1 / 天佑x2 / ...
    同境界进度: 你已超过 94% 的同境界修士。
"""

from __future__ import annotations

import re

from backend.domain.models import ParsedCard, RawMessageEvent
from backend.domain.registry import ParserOutput

TOTAL_FLOOR_RE = re.compile(r"本次共闯过\s*(?P<v>\d+)\s*层")
EXP_GAIN_RE = re.compile(r"修为\s*增加了\s*(?P<v>\d+)\s*点")
TRACK_RE = re.compile(r"本次塔相轨迹[:：]\s*(?P<v>[^\n]+)")
BUILD_RE = re.compile(r"本次构筑[:：]\s*(?P<v>[^\n]+)")
ADVENTURES_RE = re.compile(r"触发奇遇[:：]\s*(?P<v>[^\n]+)")
AFFIX_RE = re.compile(r"遭遇词缀[:：]\s*(?P<v>[^\n]+)")
RANK_RE = re.compile(r"同境界进度[:：]\s*你已超过\s*(?P<v>\d+)%")
LOOT_RE = re.compile(r"^\s*-\s+获得了?\s*(?P<v>.+?)\s*$", re.MULTILINE)
SEAL_RE = re.compile(r"获得塔印\s*(?P<delta>\d+)\s*点（累计\s*(?P<total>\d+)）")
FLOOR_LINE_RE = re.compile(
    r"^-\s*第\s*(?P<floor>\d+)\s*层\s*\((?P<realm>[^/]+)/\s*(?P<kind>[^\)]+)\)[:：]\s*(?P<rest>.+?)\s*$",
    re.MULTILINE,
)


class TowerTrialReportParser:
    name = "tower_trial_report"

    def parse(self, event: RawMessageEvent) -> ParserOutput | None:
        text = event.text or ""
        if "【试炼古塔 - 战报】" not in text:
            return None
        fields: dict[str, object] = {}
        if m := TOTAL_FLOOR_RE.search(text):
            fields["闯过层数"] = f"{m.group('v')} 层"
        if m := EXP_GAIN_RE.search(text):
            fields["修为增长"] = f"{m.group('v')} 点"
        if m := TRACK_RE.search(text):
            fields["塔相轨迹"] = m.group("v").strip()
        if m := BUILD_RE.search(text):
            fields["本次构筑"] = m.group("v").strip()
        if m := ADVENTURES_RE.search(text):
            fields["触发奇遇"] = m.group("v").strip()
        if m := AFFIX_RE.search(text):
            fields["遭遇词缀"] = m.group("v").strip()
        if m := RANK_RE.search(text):
            fields["同境界超过"] = f"{m.group('v')}%"
        if m := SEAL_RE.search(text):
            fields["塔印"] = f"+{m.group('delta')}(累计 {m.group('total')})"
        # 收获列表(灵石、图纸、妖丹 等),不包括塔印那行(单独处理)
        loots: list[str] = []
        for line in LOOT_RE.findall(text):
            ln = line.strip()
            if "塔印" in ln:
                continue
            loots.append(ln)
        if loots:
            fields["收获列表"] = loots
        # 逐层概要(给 UI 折叠显示用)
        floors: list[dict[str, str]] = []
        for m in FLOOR_LINE_RE.finditer(text):
            rest = m.group("rest").strip()
            # 用最后一个出现的结果词来判定 outcome
            if "败北" in rest:
                outcome = "败北"
            elif "险胜" in rest:
                outcome = "险胜"
            elif "碾压" in rest:
                outcome = "碾压"
            else:
                outcome = "未知"
            floors.append(
                {
                    "floor": m.group("floor"),
                    "realm": m.group("realm").strip(),
                    "kind": m.group("kind").strip(),
                    "outcome": outcome,
                    "raw": rest,
                }
            )
        if floors:
            fields["逐层详情"] = floors
        summary = "试炼古塔战报。"
        if "闯过层数" in fields:
            summary = (
                f"闯过 {fields['闯过层数']}，{fields.get('修为增长', '修为未变')}。"
            )
        return ParserOutput(
            cards=(
                ParsedCard(
                    id=event.id,
                    channels=("mine",),
                    title="试炼古塔战报",
                    summary=summary,
                    source=event.source,
                    time=event.date,
                    tags=("副本", "试炼古塔", "战报"),
                    raw=event.text,
                    fields=fields,
                ),
            ),
            state_patches=(),
        )
