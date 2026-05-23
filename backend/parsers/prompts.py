"""Prompt parsers — bot 主动发出来等用户回复的提示消息。

每个 prompt parser 识别一类「bot 在等回复」的事件,把可回复的 skill_key
和回复对象信息暴露给前端,前端在 action 区高亮一个对应的「🚀 回复发送」按钮。

参考老脚本:
- 玄骨考校 (.作答)        → features/quiz.py
- 天机考验                  → features/tianji_quiz.py
- 天道审判 (.自证)         → features/tiandao_judgement.py
- 极阴祖师 (.献上魂魄/.收敛气息) → features/jiyin.py
- 南陇侯 (.交换 / .拒绝交易) → features/nanlong.py
- 共历心劫 (.稳)           → concubine.py (心劫 prompt 部分)
"""

from __future__ import annotations

import re

from backend.domain.models import ActionSuggestion, ParsedCard, RawMessageEvent
from backend.domain.registry import ParserOutput


# ============ 玄骨考校 ============
QUIZ_TIMEOUT_RE = re.compile(r"你有\s*(\d+)\s*秒")
QUIZ_TARGET_RE = re.compile(r"@([A-Za-z0-9_]+)\s*提问")
QUIZ_OPTION_RE = re.compile(r"^\s*([A-D])\.\s*(.+?)\s*$", re.MULTILINE)
QUIZ_COMMAND_HINT = "回复本消息并使用 .作答"


class QuizPromptParser:
    name = "quiz_prompt"

    def parse(self, event: RawMessageEvent) -> ParserOutput | None:
        text = event.text or ""
        if QUIZ_COMMAND_HINT not in text:
            return None
        options = {m.group(1): m.group(2).strip() for m in QUIZ_OPTION_RE.finditer(text)}
        if not options:
            return None
        fields: dict[str, object] = {"options": options}
        if t := QUIZ_TIMEOUT_RE.search(text):
            fields["timeout_sec"] = int(t.group(1))
        if u := QUIZ_TARGET_RE.search(text):
            fields["target"] = u.group(1)
        actions = tuple(
            ActionSuggestion(
                "copy",
                f"作答 {opt}",
                f".作答 {opt}",
                chat_id=event.chat_id,
                reply_to_msg_id=event.msg_id,
            )
            for opt in sorted(options)
        )
        return ParserOutput(
            cards=(
                ParsedCard(
                    id=event.id,
                    channels=("system", "prompt"),
                    title="玄骨考校",
                    summary="bot 在等待你 .作答 <选项>",
                    source=event.source,
                    time=event.date,
                    tags=("奇遇", "玄骨考校"),
                    raw=event.text,
                    fields=fields,
                    actions=actions,
                ),
            ),
        )


# ============ 天机考验 ============
TIANJI_QUIZ_KEYWORDS = ("【天机考验】", "直接回复本消息")
TIANJI_OPTION_RE = re.compile(r"^\s*([A-D])\.\s*(.+?)\s*$", re.MULTILINE)
TIANJI_TIMEOUT_MIN_RE = re.compile(r"请在\s*(\d+)\s*分钟")
TIANJI_TIMEOUT_SEC_RE = re.compile(r"请在\s*(\d+)\s*秒")


class TianjiQuizPromptParser:
    name = "tianji_quiz_prompt"

    def parse(self, event: RawMessageEvent) -> ParserOutput | None:
        text = event.text or ""
        if not all(kw in text for kw in TIANJI_QUIZ_KEYWORDS):
            return None
        options = {m.group(1): m.group(2).strip() for m in TIANJI_OPTION_RE.finditer(text)}
        if not options:
            return None
        fields: dict[str, object] = {"options": options}
        if t := TIANJI_TIMEOUT_MIN_RE.search(text):
            fields["timeout_sec"] = int(t.group(1)) * 60
        elif t := TIANJI_TIMEOUT_SEC_RE.search(text):
            fields["timeout_sec"] = int(t.group(1))
        # 老脚本天机考验答题方式跟玄骨一样:回复 + .作答 <选项>
        actions = tuple(
            ActionSuggestion(
                "copy",
                f"作答 {opt}",
                f".作答 {opt}",
                chat_id=event.chat_id,
                reply_to_msg_id=event.msg_id,
            )
            for opt in sorted(options)
        )
        return ParserOutput(
            cards=(
                ParsedCard(
                    id=event.id,
                    channels=("system", "prompt"),
                    title="天机考验",
                    summary="bot 在等待你 .作答 <选项>",
                    source=event.source,
                    time=event.date,
                    tags=("天机", "考验"),
                    raw=event.text,
                    fields=fields,
                    actions=actions,
                ),
            ),
        )


# ============ 天道审判 / 问心 ============
TIANDAO_PROMPT_MARKERS = ("天道审判", "天道问心", "挂机嫌疑", "速答以下问心")
TIANDAO_TARGET_RE = re.compile(r"对象\s*[【\[]\s*@?([^】\]]+?)\s*[】\]]")
TIANDAO_TOKEN_RE = re.compile(r"阵眼口令\s*[:：]\s*([A-Za-z0-9_-]+)")
TIANDAO_TIMEOUT_MIN_RE = re.compile(r"请在\s*(\d+)\s*分钟")


class TiandaoPromptParser:
    name = "tiandao_prompt"

    def parse(self, event: RawMessageEvent) -> ParserOutput | None:
        text = event.text or ""
        if not any(marker in text for marker in TIANDAO_PROMPT_MARKERS):
            return None
        if "回复" not in text and "自证" not in text:
            return None
        fields: dict[str, object] = {}
        if t := TIANDAO_TARGET_RE.search(text):
            fields["target"] = t.group(1)
        if t := TIANDAO_TOKEN_RE.search(text):
            fields["token"] = t.group(1)
        if t := TIANDAO_TIMEOUT_MIN_RE.search(text):
            fields["timeout_sec"] = int(t.group(1)) * 60
        # 自证 是 reply 类 skill,这里给出动作建议
        actions = (
            ActionSuggestion(
                "copy",
                "自证",
                ".自证",
                chat_id=event.chat_id,
                reply_to_msg_id=event.msg_id,
            ),
        )
        return ParserOutput(
            cards=(
                ParsedCard(
                    id=event.id,
                    channels=("system", "prompt", "risk"),
                    title="天道审判",
                    summary="bot 在等待你 .自证(回复本消息)",
                    source=event.source,
                    time=event.date,
                    tags=("天道", "审判"),
                    raw=event.text,
                    fields=fields,
                    actions=actions,
                    severity="risk",
                ),
            ),
        )


# ============ 极阴祖师 ============
JIYIN_PROMPT_MARKERS = ("回复本消息 .献上魂魄", "回复本消息 .收敛气息")
JIYIN_TARGET_RE = re.compile(r"@([A-Za-z0-9_]+)")
JIYIN_TIMEOUT_MIN_RE = re.compile(r"你必须在\s*(\d+)\s*分钟")


class JiyinPromptParser:
    name = "jiyin_prompt"

    def parse(self, event: RawMessageEvent) -> ParserOutput | None:
        text = event.text or ""
        if not all(marker in text for marker in JIYIN_PROMPT_MARKERS):
            return None
        fields: dict[str, object] = {}
        if t := JIYIN_TARGET_RE.search(text):
            fields["target"] = t.group(1)
        if t := JIYIN_TIMEOUT_MIN_RE.search(text):
            fields["timeout_sec"] = int(t.group(1)) * 60
        actions = (
            ActionSuggestion(
                "copy", "献上魂魄(高风险高回报)", ".献上魂魄",
                chat_id=event.chat_id, reply_to_msg_id=event.msg_id,
            ),
            ActionSuggestion(
                "copy", "收敛气息(低风险低回报)", ".收敛气息",
                chat_id=event.chat_id, reply_to_msg_id=event.msg_id,
            ),
        )
        return ParserOutput(
            cards=(
                ParsedCard(
                    id=event.id,
                    channels=("system", "prompt"),
                    title="极阴祖师",
                    summary="bot 在等你抉择:献魂 or 收敛",
                    source=event.source,
                    time=event.date,
                    tags=("奇遇", "极阴祖师"),
                    raw=event.text,
                    fields=fields,
                    actions=actions,
                ),
            ),
        )


# ============ 南陇侯 ============
NANLONG_PROMPT_MARKERS = ("回复本消息.交换法宝", "回复本消息.交换功法", "回复本消息.拒绝交易")
NANLONG_TARGET_RE = re.compile(r"@([A-Za-z0-9_]+)")
NANLONG_TIMEOUT_MIN_RE = re.compile(r"你有\s*(\d+)\s*分钟")


class NanlongPromptParser:
    name = "nanlong_prompt"

    def parse(self, event: RawMessageEvent) -> ParserOutput | None:
        text = event.text or ""
        if not all(marker in text for marker in NANLONG_PROMPT_MARKERS):
            return None
        fields: dict[str, object] = {}
        if t := NANLONG_TARGET_RE.search(text):
            fields["target"] = t.group(1)
        if t := NANLONG_TIMEOUT_MIN_RE.search(text):
            fields["timeout_sec"] = int(t.group(1)) * 60
        actions = (
            ActionSuggestion(
                "copy", "交换 法宝", ".交换 法宝",
                chat_id=event.chat_id, reply_to_msg_id=event.msg_id,
            ),
            ActionSuggestion(
                "copy", "交换 功法", ".交换 功法",
                chat_id=event.chat_id, reply_to_msg_id=event.msg_id,
            ),
            ActionSuggestion(
                "copy", "拒绝交易", ".拒绝交易",
                chat_id=event.chat_id, reply_to_msg_id=event.msg_id,
            ),
        )
        return ParserOutput(
            cards=(
                ParsedCard(
                    id=event.id,
                    channels=("system", "prompt"),
                    title="南陇侯",
                    summary="bot 在等你抉择:交换法宝 / 交换功法 / 拒绝",
                    source=event.source,
                    time=event.date,
                    tags=("奇遇", "南陇侯"),
                    raw=event.text,
                    fields=fields,
                    actions=actions,
                ),
            ),
        )


# ============ 共历心劫 ============
HEART_PROMPT_KEYWORDS = ("坠魔心劫", "共历心劫", "心劫余波", "心劫抉择正在进行", "开启共历心劫")


class HeartPromptParser:
    name = "heart_prompt"

    def parse(self, event: RawMessageEvent) -> ParserOutput | None:
        text = event.text or ""
        # 必须含心劫关键词,且 bot 在请求一个抉择回复(出现 .稳 提示)。
        # 结算文里可能出现“三轮抉择：稳 / 稳 / 稳”,不能误判成 prompt。
        if not any(kw in text for kw in HEART_PROMPT_KEYWORDS):
            return None
        if not re.search(r"[.。]\s*稳", text):
            # 没出现 .稳 提示就不是 prompt,而是 status / cd 提示
            return None
        actions = (
            ActionSuggestion(
                "copy", "稳(回复)", ".稳",
                chat_id=event.chat_id, reply_to_msg_id=event.msg_id,
            ),
        )
        return ParserOutput(
            cards=(
                ParsedCard(
                    id=event.id,
                    channels=("system", "prompt"),
                    title="共历心劫",
                    summary="bot 在等你 .稳(回复本消息)",
                    source=event.source,
                    time=event.date,
                    tags=("侍妾", "心劫"),
                    raw=event.text,
                    actions=actions,
                ),
            ),
        )
