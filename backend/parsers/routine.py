"""Routine result parser for common personal gameplay replies.

These messages are not urgent prompts. They should land in functional channels
so the UI can show them under daily/resource/training instead of treating every
bot reply as a focus item.
"""

from __future__ import annotations

import re

from backend.domain.models import ParsedCard, RawMessageEvent
from backend.domain.registry import ParserOutput

DEEP_START_RE = re.compile(r"你已进入深度闭关状态")
DEEP_RUNNING_RE = re.compile(r"你正在深度闭关")
DEEP_NONE_RE = re.compile(r"你并未处于深度闭关")
RETREAT_COOLDOWN_RE = re.compile(r"灵气尚未平复|无法立即再次闭关|需要打坐调息")
RETREAT_FAILED_RE = re.compile(r"【闭关失败】")
ATTENDANCE_RE = re.compile(r"点卯成功|今日已点卯")
TOWER_LIMIT_RE = re.compile(r"今日已挑战失败|重置古塔")
SECOND_SOUL_PANEL_RE = re.compile(r"你的本命元婴")
SECOND_SOUL_SENT_RE = re.compile(r"元婴化作一道流光飞出|将在外云游")
SECOND_SOUL_BLOCKED_RE = re.compile(r"你的元婴正在执行|你尚未凝聚元婴")
SECOND_SOUL_SETTLED_RE = re.compile(r"【元婴闭关结算】|元神归窍总结")
HOME_BLOCKED_RE = re.compile(r"你尚无侍妾|你尚无红颜知己|侍妾情缘未至|包含侍妾/道侣")


class RoutineResultParser:
    name = "routine_result"

    def parse(self, event: RawMessageEvent) -> ParserOutput | None:
        text = event.text or ""
        if not text:
            return None

        if DEEP_START_RE.search(text):
            return _card(event, "深度闭关开始", "已进入深度闭关，等待下次发言结算。", ("training",), ("修炼", "深度闭关"))
        if DEEP_RUNNING_RE.search(text):
            return _card(event, "深度闭关中", _first_line(text), ("training",), ("修炼", "深度闭关"))
        if DEEP_NONE_RE.search(text):
            return _card(event, "未在深度闭关", _first_line(text), ("training",), ("修炼", "深度闭关"))
        if RETREAT_FAILED_RE.search(text):
            return _card(event, "闭关失败", "本次闭关失败，已进入调息。", ("training",), ("修炼", "闭关"))
        if RETREAT_COOLDOWN_RE.search(text):
            return _card(event, "闭关冷却", _first_line(text), ("training",), ("修炼", "冷却"))
        if ATTENDANCE_RE.search(text):
            return _card(event, "宗门点卯", _first_line(text), ("resource",), ("资源", "点卯"))
        if TOWER_LIMIT_RE.search(text):
            return _card(event, "试炼古塔", _first_line(text), ("training",), ("修炼", "试炼古塔"))
        if SECOND_SOUL_PANEL_RE.search(text):
            return _card(event, "本命元婴", "本命元婴状态面板。", ("training",), ("修炼", "元婴"))
        if SECOND_SOUL_SENT_RE.search(text):
            return _card(event, "元婴出窍", "元婴已外出云游，等待归来结算。", ("training",), ("修炼", "元婴"))
        if SECOND_SOUL_BLOCKED_RE.search(text):
            return _card(event, "元婴状态", _first_line(text), ("training",), ("修炼", "元婴"))
        if SECOND_SOUL_SETTLED_RE.search(text):
            return _card(event, "元婴结算", "元婴归来结算已记录。", ("training", "resource"), ("修炼", "元婴", "资源"))
        if HOME_BLOCKED_RE.search(text):
            return _card(event, "洞府关系", _first_line(text), ("home",), ("洞府", "侍妾"))
        return None


def _card(
    event: RawMessageEvent,
    title: str,
    summary: str,
    channels: tuple[str, ...],
    tags: tuple[str, ...],
) -> ParserOutput:
    return ParserOutput(
        cards=(
            ParsedCard(
                id=event.id,
                channels=channels,
                title=title,
                summary=summary,
                source=event.source,
                time=event.date,
                tags=tags,
                raw=event.text,
            ),
        )
    )


def _first_line(text: str) -> str:
    for line in str(text or "").splitlines():
        clean = line.strip()
        if clean:
            return clean[:120]
    return "日常结果"
