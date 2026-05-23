"""副本 parser:识别副本开启、静场令和推进抉择类消息。

这里仍然只生成 UI 卡片和手动动作按钮,不做自动加入 / 自动抉择。
"""

from __future__ import annotations

import re

from backend.domain.models import ActionSuggestion, ParsedCard, RawMessageEvent
from backend.domain.registry import ParserOutput
from backend.parsers.xutian_oracle import xutian_advice

DUNGEON_NAMES = ("虚天殿", "黄龙山", "昆吾山", "坠魔谷", "血色试炼", "苍坤上人洞府")
DUNGEON_ALIASES = {
    "苍坤洞府": "苍坤上人洞府",
    "苍坤上人洞府": "苍坤上人洞府",
}
DUNGEON_ID_RE = re.compile(r"(?:副本|房间)ID[:：]\s*(?P<id>\d+)")
OPEN_TITLE_RE = re.compile(r"【(?P<name>[^】]+?)已开启】")
OPENER_RE = re.compile(r"@(?P<opener>[A-Za-z0-9_]+)\s*(?:消耗了|以)【(?P<item>[^】]+)】")
CAPACITY_RE = re.compile(r"[（(]\s*(?P<max>\d+)\s*人满\s*[）)]")
XUTIAN_GUA_RE = re.compile(r"【卦象词条】\s*(?P<gua>[^\n]+)")
XUTIAN_FIT_RE = re.compile(r"当前契合[:：]\s*(?P<fit>[^\n]+)")
STAGE_TITLE_RE = re.compile(
    rf"【(?P<name>{'|'.join(map(re.escape, DUNGEON_NAMES))})[·・](?P<stage>[^】]+)】"
)
XUTIAN_STAGE_RE = re.compile(
    r"【(?P<stage>(?:第一幕|前殿已破|卦象验阵|第二关|第三关|第四关|第五关|鼎前抉择|后殿余波|后殿冲关止步)[^】]*)】"
)
CHOICE_RE = re.compile(r"(?:使用|输入)\s*(?P<cmd>[.。][\w\u4e00-\u9fff]+)\s+(?P<opts>[^。\n]+?)\s*(?:继续|做出决定|推进)")
ROUTE_CHOICE_RE = re.compile(r"(?:使用|输入)\s*(?P<cmd>[.。]选择道路)\s+(?P<opts>冰\s*[/／、]\s*(?:[.。]选择道路\s*)?火)")
STRATEGY_CHOICE_RE = re.compile(r"(?:使用|输入)\s*(?P<cmd>[.。]阵策)\s+(?P<opts>稳\s*[/／、]\s*压\s*[/／、]\s*势)")
CAULDRON_CHOICE_RE = re.compile(r"(?:使用|输入)\s*(?P<cmd>[.。]争鼎)\s+(?P<opts>求稳\s*[/／、]\s*(?:[.。]争鼎\s*)?夺鼎)")
CANGKUN_CHOICE_RE = re.compile(r"(?:使用|输入)\s*(?P<cmd>[.。]苍坤抉择)\s+(?P<opts>[123]\s*[/／、]\s*[123](?:\s*[/／、]\s*[123])?)")
HOU_DIAN_CONTINUE_CHOICE_RE = re.compile(r"(?:使用|输入)\s*(?P<cmd>[.。]后殿抉择)\s+(?P<opts>收手\s*[/／、]\s*(?:[.。]后殿抉择\s*)?冲关)")
HOU_DIAN_CHOICE_RE = re.compile(r"(?:使用|输入)\s*(?P<cmd>[.。]后殿阵策)\s+(?P<opts>镇\s*[/／、]\s*夺\s*[/／、]\s*卦)")
PATH_RE = re.compile(r"^\s*(?P<key>路径\d+)\s*[·.・]\s*(?P<label>[^：:\n]+)\s*[：:]", re.M)
CANGKUN_PATH_RE = re.compile(r"^\s*(?P<key>[123])\s*[·.・]\s*(?P<label>[^：:\n]+)\s*[：:]", re.M)
CANGKUN_STAGE_RE = re.compile(
    r"【(?:苍坤上人洞府[·・](?P<named>第[一二三四五]幕(?:前夜)?(?:[·・][^】]+)?)|"
    r"(?P<bare>第[一二三四五]幕(?:前夜)?[·・][^】]+))】"
)
CANGKUN_CONTEXT_TOKENS = (
    "苍坤",
    "苍坤洞府",
    "苍坤残图",
    "太妙神禁",
    "玉矶阁",
    "持识者",
    "可调神识",
    "禁制裂隙",
    "神魂稳度",
    "慕兰警戒",
    "慕兰",
    "卷轴线索",
    "神识余量",
)
SILENCE_READY_RE = re.compile(r"为本次【(?P<name>[^】]+)】立下静场令")
XUTIAN_ROUTE_RESULT_RE = re.compile(r"【(?P<eye>极寒冰魄|焚天烈焰)】的光芒被成功压制")
XUTIAN_STRATEGY_RE = re.compile(r"阵策【(?P<strategy>[^】]+)】")
CANGKUN_FINAL_RE = re.compile(r"【苍坤上人洞府[·・](?P<result>脱身成功|脱身失败)】")
CANGKUN_STATE_RE = re.compile(
    r"(?P<name>禁制裂隙|神魂稳度|慕兰警戒|贪念|卷轴线索|神识余量)\s*[:：]?\s*(?P<value>-?\d+)"
)
HOU_DIAN_METRIC_RE = re.compile(r"(?P<name>推演血量|开局士气|开局鼎压|最终鼎压|最终士气)[:：]\s*(?P<value>[^）|]+)")


class DungeonParser:
    name = "dungeon"

    def parse(self, event: RawMessageEvent) -> ParserOutput | None:
        text = event.text
        if not text:
            return None
        return (
            self._parse_open(event)
            or self._parse_xutian_oracle(event)
            or self._parse_xutian_route_result(event)
            or self._parse_xutian_route_selection(event)
            or self._parse_cangkun_final(event)
            or self._parse_progress_choice(event)
            or self._parse_silence_order(event)
        )

    def _parse_open(self, event: RawMessageEvent) -> ParserOutput | None:
        text = event.text
        if "加入队伍" not in text:
            return None
        match = DUNGEON_ID_RE.search(text)
        if not match:
            return None
        dungeon_id = match.group("id")
        title_match = OPEN_TITLE_RE.search(text)
        dungeon_name = _normalize_dungeon_name(title_match.group("name") if title_match else "") or _find_dungeon_name(text) or "副本"
        opener_match = OPENER_RE.search(text)
        capacity_match = CAPACITY_RE.search(text)
        fields = {
            "副本名": dungeon_name,
            "副本ID": dungeon_id,
            "状态": "可加入",
        }
        if dungeon_name == "苍坤上人洞府":
            fields["房间ID"] = dungeon_id
        fields.update(_xutian_luck_fields(text))
        if opener_match:
            fields["开门人"] = f"@{opener_match.group('opener')}"
            fields["消耗道具"] = opener_match.group("item")
        if capacity_match:
            fields["人数上限"] = f"{capacity_match.group('max')}人"
        return ParserOutput(
            cards=(
                ParsedCard(
                    id=event.id,
                    channels=("system", "dungeon", "console"),
                    title=f"{dungeon_name}开启",
                    summary=f"发现{dungeon_name}副本公告,可人工确认加入。",
                    source=event.source,
                    time=event.date,
                    tags=("副本", dungeon_name, "可加入"),
                    raw=event.text,
                    fields=fields,
                    actions=(
                        ActionSuggestion(
                            "copy",
                            "加入苍坤洞府" if dungeon_name == "苍坤上人洞府" else "加入副本",
                            _join_dungeon_command(dungeon_name, dungeon_id),
                            chat_id=event.chat_id,
                            reply_to_msg_id=None if dungeon_name == "苍坤上人洞府" else event.msg_id,
                        ),
                    ),
                ),
            )
        )

    def _parse_xutian_oracle(self, event: RawMessageEvent) -> ParserOutput | None:
        text = event.text
        if "【卦象验阵】" not in text or "【卦象词条】" not in text:
            return None
        fields: dict[str, object] = {
            "副本名": "虚天殿",
            "状态": "卦象验阵",
        }
        fields.update(_xutian_luck_fields(text))
        fit = XUTIAN_FIT_RE.search(text)
        if fit:
            fields["队伍契合"] = fit.group("fit").strip()
        suggestion = fields.get("行运建议")
        return ParserOutput(
            cards=(
                ParsedCard(
                    id=event.id,
                    channels=("system", "dungeon"),
                    title="虚天殿卦象",
                    summary=f"虚天殿卦象已记录{f',建议 {suggestion}' if suggestion else ''}。",
                    source=event.source,
                    time=event.date,
                    tags=("副本", "虚天殿", "卦象"),
                    raw=event.text,
                    fields=fields,
                ),
            )
        )

    def _parse_xutian_route_result(self, event: RawMessageEvent) -> ParserOutput | None:
        text = event.text
        route = _route_from_result_text(text)
        if not route or "通过了第二关" not in text:
            return None
        verdict = ""
        if "路策顺合卦意" in text:
            verdict = "顺合"
        elif "路策逆卦而行" in text:
            verdict = "逆卦"
        if not verdict:
            return None
        strategy = ""
        if strategy_match := XUTIAN_STRATEGY_RE.search(text):
            strategy = _normalize_strategy(strategy_match.group("strategy"))
        fields = {
            "副本名": "虚天殿",
            "阶段": "第二关",
            "路线": route,
            "阵策": strategy,
            "路策判定": verdict,
            "状态": "路策顺合" if verdict == "顺合" else "路策逆卦",
        }
        return ParserOutput(
            cards=(
                ParsedCard(
                    id=event.id,
                    channels=("system", "dungeon"),
                    title="虚天殿路策结果",
                    summary=f"{route}{f' / {strategy}' if strategy else ''} 判定为{verdict}。",
                    source=event.source,
                    time=event.date,
                    tags=("副本", "虚天殿", "路策", verdict),
                    raw=event.text,
                    fields=fields,
                    severity="warning" if verdict == "逆卦" else "normal",
                ),
            )
        )

    def _parse_xutian_route_selection(self, event: RawMessageEvent) -> ParserOutput | None:
        text = event.text
        if "你们选定了 【" not in text:
            return None
        route = _route_from_selection_text(text)
        if not route:
            return None
        strategy = ""
        if strategy_match := re.search(r"当前阵策[:：]\s*(?P<strategy>[^\n]+)", text):
            strategy = _normalize_strategy(strategy_match.group("strategy"))
        main_players = ""
        if players_match := re.search(r"契合此路的主力道友[:：]\s*(?P<players>[^\n]+)", text):
            main_players = players_match.group("players").strip()
        morale = ""
        if morale_match := re.search(r"开局士气[:：]\s*(?P<morale>[^\n]+)", text):
            morale = morale_match.group("morale").strip()
        fields = {
            "副本名": "虚天殿",
            "阶段": "第二关",
            "状态": "路线已选",
            "路线": route,
            "阵策": strategy,
            "主力道友": main_players,
            "开局士气": morale,
        }
        return ParserOutput(
            cards=(
                ParsedCard(
                    id=event.id,
                    channels=("system", "dungeon"),
                    title="虚天殿路线已选",
                    summary=f"已选择 {route}{f' / {strategy}' if strategy else ''}。",
                    source=event.source,
                    time=event.date,
                    tags=("副本", "虚天殿", "路线"),
                    raw=event.text,
                    fields=fields,
                ),
            )
        )

    def _parse_cangkun_final(self, event: RawMessageEvent) -> ParserOutput | None:
        text = event.text
        match = CANGKUN_FINAL_RE.search(text)
        if not match:
            return None
        result = match.group("result")
        fields: dict[str, object] = {
            "副本名": "苍坤上人洞府",
            "阶段": result,
            "状态": result,
        }
        fields.update(_cangkun_state_fields(text))
        return ParserOutput(
            cards=(
                ParsedCard(
                    id=event.id,
                    channels=("system", "dungeon"),
                    title=f"苍坤上人洞府{result}",
                    summary=f"苍坤上人洞府{result},已记录最终状态。",
                    source=event.source,
                    time=event.date,
                    tags=("副本", "苍坤上人洞府", result),
                    raw=event.text,
                    fields=fields,
                    severity="warning" if result == "脱身失败" else "normal",
                ),
            )
        )

    def _parse_progress_choice(self, event: RawMessageEvent) -> ParserOutput | None:
        text = event.text
        choice = _find_choice(text)
        stage = STAGE_TITLE_RE.search(text)
        xutian_stage = XUTIAN_STAGE_RE.search(text)
        cangkun_context = _has_cangkun_context(text, choice)
        cangkun_stage = _find_cangkun_stage(text, allow_bare=cangkun_context)
        is_cangkun = bool(cangkun_stage) or bool(choice and choice[0] == ".苍坤抉择")
        if not choice and not stage and not xutian_stage and not cangkun_stage and "队伍已进入虚天殿" not in text:
            return None
        dungeon_name = ""
        stage_text = ""
        if is_cangkun:
            dungeon_name = "苍坤上人洞府"
            if stage and _normalize_dungeon_name(stage.group("name").strip()) == "苍坤上人洞府":
                stage_text = stage.group("stage").strip()
            else:
                stage_text = cangkun_stage
        elif stage:
            dungeon_name = stage.group("name").strip()
            stage_text = stage.group("stage").strip()
        elif xutian_stage:
            dungeon_name = "虚天殿"
            stage_text = xutian_stage.group("stage").strip()
        elif "队伍已进入虚天殿" in text:
            dungeon_name = "虚天殿"
            stage_text = "入殿"
        else:
            dungeon_name = _find_dungeon_name(text)
        if not dungeon_name:
            return None
        dungeon_name = _normalize_dungeon_name(dungeon_name) or dungeon_name
        fields: dict[str, object] = {
            "副本名": dungeon_name,
            "状态": "需要抉择" if choice else "进行中",
        }
        if stage_text:
            fields["阶段"] = stage_text
        paths = _extract_paths(text)
        if dungeon_name == "虚天殿":
            fields.update(_xutian_hou_dian_fields(text, stage_text, bool(choice)))
        if dungeon_name == "苍坤上人洞府":
            fields.update(_cangkun_state_fields(text))
            paths = paths or _extract_cangkun_paths(text)
        if paths:
            fields["可选路径"] = paths
        if "【稳控全场】已展开" in text:
            fields["静场令"] = "已展开"
            fields["状态"] = "静场中 / 需要抉择" if choice else "静场中"

        actions: tuple[ActionSuggestion, ...] = ()
        if choice:
            command, options = choice
            actions = tuple(
                ActionSuggestion(
                    "copy",
                    option,
                    f"{command} {option}",
                    chat_id=event.chat_id,
                    reply_to_msg_id=event.msg_id,
                )
                for option in options
            )

        status_text = str(fields.get("状态") or "")
        closed_progress = status_text in {"后殿冲关成功", "后殿冲关止步"}
        card_title = f"{dungeon_name}{status_text}" if closed_progress else f"{dungeon_name}推进"
        card_summary = (
            f"{dungeon_name}{status_text},已记录最终状态。"
            if closed_progress
            else f"{dungeon_name}{stage_text or ''}正在推进,请人工选择下一步。"
        )
        card_tags = tuple(
            x
            for x in (
                "副本",
                dungeon_name,
                status_text if closed_progress else "进行中",
                "需要抉择" if actions and not closed_progress else "",
                "静场令" if fields.get("静场令") else "",
            )
            if x
        )

        return ParserOutput(
            cards=(
                ParsedCard(
                    id=event.id,
                    channels=("system", "dungeon"),
                    title=card_title,
                    summary=card_summary,
                    source=event.source,
                    time=event.date,
                    tags=card_tags,
                    raw=event.text,
                    fields=fields,
                    actions=actions,
                    severity="warning" if status_text == "后殿冲关止步" else "normal",
                ),
            )
        )

    def _parse_silence_order(self, event: RawMessageEvent) -> ParserOutput | None:
        text = event.text
        if "静场令" not in text and "稳控全场" not in text:
            return None
        ready = SILENCE_READY_RE.search(text)
        if not ready:
            return None
        dungeon_name = _normalize_dungeon_name(ready.group("name")) or "副本"
        return ParserOutput(
            cards=(
                ParsedCard(
                    id=event.id,
                    channels=("system", "dungeon"),
                    title="副本静场令",
                    summary=f"{dungeon_name}静场令已准备,正式进入副本后生效。",
                    source=event.source,
                    time=event.date,
                    tags=("副本", dungeon_name, "静场令", "待生效"),
                    raw=event.text,
                    fields={
                        "副本名": dungeon_name,
                        "状态": "静场令待生效",
                        "静场令": "待副本正式进入后展开",
                    },
                ),
            )
        )


def _normalize_dungeon_name(value: str) -> str:
    text = str(value or "").strip()
    if text in DUNGEON_ALIASES:
        return DUNGEON_ALIASES[text]
    for name in DUNGEON_NAMES:
        if name in text:
            return name
    for alias, name in DUNGEON_ALIASES.items():
        if alias in text:
            return name
    return text if text in DUNGEON_NAMES else ""


def _find_dungeon_name(text: str) -> str:
    for name in DUNGEON_NAMES:
        if name in text:
            return name
    for alias, name in DUNGEON_ALIASES.items():
        if alias in text:
            return name
    return ""


def _split_options(value: str) -> list[str]:
    raw = str(value or "").strip()
    parts = re.split(r"\s*[/／、]\s*", raw)
    return [_clean_option(part) for part in parts if _clean_option(part)]


def _extract_paths(text: str) -> list[str]:
    paths = []
    for match in PATH_RE.finditer(text or ""):
        paths.append(f"{match.group('key')} · {match.group('label').strip()}")
    return paths


def _extract_cangkun_paths(text: str) -> list[str]:
    paths = []
    for match in CANGKUN_PATH_RE.finditer(text or ""):
        paths.append(f"{match.group('key')} · {match.group('label').strip()}")
    return paths


def _find_choice(text: str) -> tuple[str, list[str]] | None:
    for pattern in (
        ROUTE_CHOICE_RE,
        STRATEGY_CHOICE_RE,
        CAULDRON_CHOICE_RE,
        CANGKUN_CHOICE_RE,
        HOU_DIAN_CONTINUE_CHOICE_RE,
        HOU_DIAN_CHOICE_RE,
        CHOICE_RE,
    ):
        match = pattern.search(text or "")
        if not match:
            continue
        command = match.group("cmd").strip().replace("。", ".", 1)
        options = _split_options(match.group("opts"))
        if options:
            return command, options
    return None


def _clean_option(value: str) -> str:
    text = str(value or "").strip()
    text = re.sub(r"^[.。][\w\u4e00-\u9fff]+\s+", "", text)
    return text.strip()


def _xutian_luck_fields(text: str) -> dict[str, object]:
    gua_match = XUTIAN_GUA_RE.search(text or "")
    if not gua_match:
        return {}
    gua = gua_match.group("gua").strip()
    fields: dict[str, object] = {"卦象": gua}
    advice = xutian_advice(gua)
    if advice:
        fields.update(advice)
    return fields


def _xutian_hou_dian_fields(text: str, stage_text: str, has_choice: bool) -> dict[str, object]:
    fields: dict[str, object] = {}
    stage = str(stage_text or "")
    if stage == "后殿余波":
        fields["状态"] = "需要抉择" if has_choice else "后殿余波"
        if "战利品已先行封存" in text or "不会回吐" in text:
            fields["后殿奖励"] = "第三关战利品已锁定"
    elif stage.startswith("第五关"):
        if _is_xutian_hou_dian_success_text(text):
            fields["状态"] = "后殿冲关成功"
            fields["后殿追加"] = "已获得"
        else:
            fields["状态"] = "后殿冲关中"
    elif stage == "后殿冲关止步":
        fields["状态"] = "后殿冲关止步"
        fields["后殿追加"] = "未获得"
    elif stage.startswith("第四关") and "你们决定以" in text:
        fields["状态"] = "后殿试阵结果"
    for match in HOU_DIAN_METRIC_RE.finditer(text or ""):
        fields[match.group("name")] = match.group("value").strip()
    return fields


def _is_xutian_hou_dian_success_text(text: str) -> bool:
    raw = str(text or "")
    return bool(
        "第五关" in raw
        and (
            "鼎灵退散" in raw
            or "所有队员额外获得" in raw
            or "最终鼎压" in raw
        )
        and "回合耗尽" not in raw
        and "仍未被真正压灭" not in raw
    )


def _cangkun_state_fields(text: str) -> dict[str, object]:
    fields: dict[str, object] = {}
    for match in CANGKUN_STATE_RE.finditer(text or ""):
        fields[match.group("name")] = match.group("value")
    if holder := re.search(r"持识者[:：]\s*(?P<holder>[^\n|]+)", text or ""):
        fields["持识者"] = holder.group("holder").strip()
    return fields


def _has_cangkun_context(text: str, choice: tuple[str, list[str]] | None = None) -> bool:
    if choice and choice[0] == ".苍坤抉择":
        return True
    raw = str(text or "")
    return any(token in raw for token in CANGKUN_CONTEXT_TOKENS)


def _find_cangkun_stage(text: str, *, allow_bare: bool = True) -> str:
    matches = []
    for match in CANGKUN_STAGE_RE.finditer(text or ""):
        named = (match.group("named") or "").strip()
        bare = (match.group("bare") or "").strip()
        if named:
            matches.append(named)
        elif allow_bare and bare:
            matches.append(bare)
    matches = [match for match in matches if match]
    return matches[-1] if matches else ""


def _join_dungeon_command(dungeon_name: str, dungeon_id: str) -> str:
    if dungeon_name == "苍坤上人洞府":
        return f".加入苍坤洞府 {dungeon_id}"
    return f".加入副本 {dungeon_id}"


def _route_from_result_text(text: str) -> str:
    match = XUTIAN_ROUTE_RESULT_RE.search(text or "")
    if not match:
        return ""
    return "冰路" if match.group("eye") == "极寒冰魄" else "火路"


def _route_from_selection_text(text: str) -> str:
    match = re.search(r"你们选定了 【(?P<route>[^】]+)】", text or "")
    if not match:
        return ""
    route = match.group("route")
    if "玄冰" in route:
        return "冰路"
    if "焚炎" in route:
        return "火路"
    return route


def _normalize_strategy(value: str) -> str:
    text = str(value or "").strip()
    if "稳" in text:
        return "稳策"
    if "压" in text:
        return "压策"
    if "势" in text:
        return "势策"
    return text
