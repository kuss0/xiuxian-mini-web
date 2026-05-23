"""资源统计 parser:入箱时提取执行事件和收益流水,不改变展示/发送行为。"""

from __future__ import annotations

import re

from backend.domain.models import RawMessageEvent, ResourceDelta, ResourceEvent
from backend.domain.registry import ParserOutput


WILD_TITLE_RE = re.compile(r"【野外历练(?:\s*[·・]\s*(?P<name>[^】]+))?】")
DUNGEON_LOOT_TITLE_RE = re.compile(r"【战利品结算(?:[·・]\s*(?P<name>[^】]+))?】")
HUANGLONG_RESULT_RE = re.compile(r"【黄龙山大战[·・]\s*(?P<name>[^】]+)】")
KUNWU_RESULT_RE = re.compile(r"【登顶昆吾山】")
ZHUI_MO_RESULT_RE = re.compile(r"【坠魔谷[·・]\s*(?P<name>[^】]+)】")
CANGKUN_RESULT_RE = re.compile(r"【苍坤上人洞府[·・]\s*(?P<name>脱身成功|脱身失败)】")
WIND_XI_TITLE_RE = re.compile(r"【逆天之举】")
JIYIN_REWARD_TITLE_RE = re.compile(r"【极阴的欣赏】")
JIYIN_FAIL_TITLE_RE = re.compile(r"【神魂碾压】")
JIYIN_ESCAPE_TITLE_RE = re.compile(r"【侥幸逃脱】")
NANLONG_SUCCESS_TITLE_RE = re.compile(r"【天机异闻·南陇侯的交易】")
NANLONG_FAIL_TITLE_RE = re.compile(r"【天机异闻·魔君之怒】")
TREE_HARVEST_TITLE_RE = re.compile(r"【灵果入腹[^】]*】")
PLAYER_RE = re.compile(r"@(?P<user>[A-Za-z0-9_]+)")
RESOURCE_PLUS_RE = re.compile(r"(?P<name>修为|贡献|灵石)\s*[+＋]\s*(?P<amount>\d+)")
RESOURCE_LOSS_RE = re.compile(r"(?P<name>修为)\s*折损\s*[-－]?\s*(?P<amount>\d+)")
AMOUNT_BEFORE_RESOURCE_RE = re.compile(r"(?P<amount>\d+)\s*(?:点\s*)?(?P<name>修为|贡献|灵石)")
EXP_SURGE_RE = re.compile(r"修为(?:暴涨|大涨|提升|增加)了?\s*(?P<amount>[\d,]+)\s*点")
JIYIN_REVERSE_LOSS_RE = re.compile(r"修为倒退了\s*(?P<amount>[\d,]+)\s*点")
NANLONG_REWARD_RE = re.compile(r"作为回报.*?【(?P<name>[^】]+)】", re.S)
TREE_FRUIT_RE = re.compile(r"你摘下一枚【(?P<name>[^】]+)】")
TREE_XIUWEI_RE = re.compile(r"修为增长[:：]\s*\+?\s*(?P<amount>[\d,]+)")
TREE_EXTRA_XIUWEI_RE = re.compile(r"额外转化了\s*\+?\s*(?P<amount>[\d,]+)\s*点修为")
RESOURCE_X_RE = re.compile(
    r"(?:【(?P<bracket>[^】]+)】|(?P<name>[\u4e00-\u9fff][\u4e00-\u9fff0-9]*))\s*[xX×*]\s*(?P<amount>[\d,]+)"
)
ITEM_WITHOUT_AMOUNT_RE = re.compile(
    r"(?:^|[\s，。！:：])"
    r"(?:@(?P<user>[A-Za-z0-9_]+)(?:[、,，]\s*@[A-Za-z0-9_]+)*\s*)?"
    r"(?:额外)?获得(?:了)?(?:[^【\n]{0,12})?【(?P<name>[^】]+)】"
    r"(?!\s*[xX×*]\s*\d)(?=$|[\s，。！])"
)

NON_BLOOD_DUNGEONS = ("虚天殿", "黄龙山", "昆吾山", "坠魔谷", "苍坤上人洞府")
DUNGEON_ROUTE_NAMES = {
    "玄冰秘径": "虚天殿",
    "焚炎秘径": "虚天殿",
    "极寒冰魄": "虚天殿",
    "焚天烈焰": "虚天殿",
}
BLOOD_MARKERS = ("血色试炼", "血色副本")
WILD_COOLDOWN_MARKERS = ("山中灵机未复", "后再来")
WILD_FAILED_MARKERS = ("NPC 历练失败", "修为折损")
DUNGEON_BASIC_ONLY_MARKERS = ("额外宝藏尽毁", "只保住了基础收获", "引发了反噬")
DUNGEON_EXTRA_MARKERS = ("全队额外获得", "额外获得了")
KUNWU_RARE_PATTERNS = (
    ("金精矿", "金精矿", 1),
    ("凝血草", "凝血草", 1),
    ("清灵草", "清灵草", 1),
    ("天雷竹", "天雷竹", 1),
    ("朱果", "朱果", 1),
    ("几枚一阶妖丹", "一阶妖丹", 3),
)


class ResourceStatsParser:
    name = "resource_stats"

    def parse(self, event: RawMessageEvent) -> ParserOutput | None:
        text = event.text or ""
        if not text:
            return None
        if TREE_HARVEST_TITLE_RE.search(text):
            return self._parse_tree_harvest(event)
        if WIND_XI_TITLE_RE.search(text) and "风希" in text and "【战利品】" in text:
            return self._parse_wind_xi(event)
        if (
            JIYIN_REWARD_TITLE_RE.search(text)
            or JIYIN_FAIL_TITLE_RE.search(text)
            or JIYIN_ESCAPE_TITLE_RE.search(text)
        ):
            return self._parse_jiyin(event)
        if NANLONG_SUCCESS_TITLE_RE.search(text) or NANLONG_FAIL_TITLE_RE.search(text):
            return self._parse_nanlong(event)
        if WILD_TITLE_RE.search(text):
            return self._parse_wild_training(event)
        if DUNGEON_LOOT_TITLE_RE.search(text):
            return self._parse_dungeon_loot(event)
        if HUANGLONG_RESULT_RE.search(text):
            return self._parse_named_dungeon_result(
                event,
                source_name="黄龙山",
                title="黄龙山大战",
                title_re=HUANGLONG_RESULT_RE,
                success_markers=("夺宝即退", "阵斩神师", "守住黄龙山"),
                failure_markers=("战线崩解",),
            )
        if KUNWU_RESULT_RE.search(text):
            return self._parse_kunwu_result(event)
        if ZHUI_MO_RESULT_RE.search(text):
            return self._parse_named_dungeon_result(
                event,
                source_name="坠魔谷",
                title="坠魔谷",
                title_re=ZHUI_MO_RESULT_RE,
                success_markers=("封魔成功", "净谷成功", "通关"),
                failure_markers=("封魔失败", "超时失败"),
            )
        if CANGKUN_RESULT_RE.search(text):
            return self._parse_named_dungeon_result(
                event,
                source_name="苍坤上人洞府",
                title="苍坤上人洞府",
                title_re=CANGKUN_RESULT_RE,
                success_markers=("脱身成功",),
                failure_markers=("脱身失败",),
            )
        return None

    def _parse_wild_training(self, event: RawMessageEvent) -> ParserOutput | None:
        text = event.text or ""
        title = WILD_TITLE_RE.search(text)
        player = _first_player(text)
        title_detail = (title.group("name") if title else "") or ""
        strategy = _infer_wild_strategy(text)
        meta = {"title": "野外历练"}
        if title_detail:
            meta["title_detail"] = title_detail.strip()
        if strategy:
            meta["strategy"] = strategy

        deltas = _extract_reward_deltas(
            event,
            text,
            source_type="wild_training",
            source_name=_wild_source_name(strategy),
            player=player,
            basis="player",
            meta=meta,
        )
        deltas.extend(
            _extract_loss_deltas(
                event,
                text,
                source_type="wild_training",
                source_name=_wild_source_name(strategy),
                player=player,
                basis="player",
                meta=meta,
            )
        )

        if _contains_any(text, WILD_COOLDOWN_MARKERS):
            result = "cooldown"
        elif title_detail.strip() == "负伤而归" or _contains_any(text, WILD_FAILED_MARKERS):
            result = "failed"
        elif deltas:
            result = "success"
        else:
            return None

        event_row = _resource_event(
            event,
            source_type="wild_training",
            source_name=_wild_source_name(strategy),
            player=player,
            result=result,
            outcome=title_detail.strip(),
            meta=meta,
        )
        return ParserOutput(resource_deltas=tuple(deltas), resource_events=(event_row,))

    def _parse_tree_harvest(self, event: RawMessageEvent) -> ParserOutput | None:
        text = event.text or ""
        fruit = TREE_FRUIT_RE.search(text)
        meta = {"title": "灵果入腹"}
        if fruit:
            meta["fruit"] = fruit.group("name").strip()
        deltas: list[ResourceDelta] = []
        if match := TREE_XIUWEI_RE.search(text):
            deltas.append(
                _resource_delta(
                    event,
                    source_type="tree_harvest",
                    source_name="灵树采摘",
                    player="",
                    resource_name="修为",
                    amount=_to_int(match.group("amount")),
                    basis="player",
                    meta=meta,
                )
            )
        if match := TREE_EXTRA_XIUWEI_RE.search(text):
            deltas.append(
                _resource_delta(
                    event,
                    source_type="tree_harvest",
                    source_name="灵树采摘",
                    player="",
                    resource_name="修为",
                    amount=_to_int(match.group("amount")),
                    basis="player",
                    meta=meta | {"from": "灵纹回馈"},
                )
            )
        deltas.extend(
            _extract_reward_deltas(
                event,
                "\n".join(line for line in text.splitlines() if "获得" in line),
                source_type="tree_harvest",
                source_name="灵树采摘",
                player="",
                basis="player",
                meta=meta,
            )
        )
        if not deltas:
            return None
        event_row = _resource_event(
            event,
            source_type="tree_harvest",
            source_name="灵树采摘",
            player="",
            result="success",
            outcome=meta.get("fruit", ""),
            meta=meta,
        )
        return ParserOutput(resource_deltas=tuple(deltas), resource_events=(event_row,))

    def _parse_wind_xi(self, event: RawMessageEvent) -> ParserOutput | None:
        text = event.text or ""
        player = _first_player(text)
        meta = {"title": "逆天之举", "target": "风希"}
        reward_text = text.split("【战利品】", 1)[1] if "【战利品】" in text else text
        deltas = _extract_reward_deltas(
            event,
            reward_text,
            source_type="wind_xi",
            source_name="风希",
            player=player,
            basis="player",
            meta=meta,
        )
        deltas.extend(
            _extract_exp_surge_deltas(
                event,
                reward_text,
                source_type="wind_xi",
                source_name="风希",
                player=player,
                basis="player",
                meta=meta,
            )
        )
        deltas.extend(
            _extract_wind_xi_buff_deltas(
                event,
                reward_text,
                player=player,
                meta=meta,
            )
        )
        if not deltas:
            return None
        event_row = _resource_event(
            event,
            source_type="wind_xi",
            source_name="风希",
            player=player,
            result="success",
            outcome="逆天之举",
            meta=meta,
        )
        return ParserOutput(resource_deltas=tuple(deltas), resource_events=(event_row,))

    def _parse_jiyin(self, event: RawMessageEvent) -> ParserOutput | None:
        text = event.text or ""
        player = _first_player(text)
        meta = {"title": "极阴祖师", "target": "极阴"}
        deltas: list[ResourceDelta] = []
        result = "settled"
        outcome = ""

        if JIYIN_REWARD_TITLE_RE.search(text):
            result = "success"
            outcome = "极阴的欣赏"
            deltas.extend(
                _extract_reward_deltas(
                    event,
                    text,
                    source_type="jiyin",
                    source_name="极阴",
                    player=player,
                    basis="player",
                    meta=meta,
                )
            )
            deltas.extend(
                _extract_exp_surge_deltas(
                    event,
                    text,
                    source_type="jiyin",
                    source_name="极阴",
                    player=player,
                    basis="player",
                    meta=meta,
                )
            )
            deltas.extend(_extract_jiyin_buff_deltas(event, text, player=player, meta=meta))
        elif JIYIN_FAIL_TITLE_RE.search(text):
            result = "failed"
            outcome = "神魂碾压"
            if match := JIYIN_REVERSE_LOSS_RE.search(text):
                deltas.append(
                    _resource_delta(
                        event,
                        source_type="jiyin",
                        source_name="极阴",
                        player=player,
                        resource_name="修为",
                        amount=-abs(_to_int(match.group("amount"))),
                        basis="player",
                        meta=meta | {"loss": True},
                    )
                )
        elif JIYIN_ESCAPE_TITLE_RE.search(text):
            result = "escaped"
            outcome = "侥幸逃脱"
        else:
            return None

        event_row = _resource_event(
            event,
            source_type="jiyin",
            source_name="极阴",
            player=player,
            result=result,
            outcome=outcome,
            meta=meta,
        )
        return ParserOutput(resource_deltas=tuple(deltas), resource_events=(event_row,))

    def _parse_nanlong(self, event: RawMessageEvent) -> ParserOutput | None:
        text = event.text or ""
        player = _first_player(text)
        meta = {"title": "天机异闻·南陇侯的交易", "target": "南陇侯"}
        deltas: list[ResourceDelta] = []
        result = "settled"
        outcome = ""

        if NANLONG_SUCCESS_TITLE_RE.search(text):
            reward = NANLONG_REWARD_RE.search(text)
            if not reward:
                return None
            item = str(reward.group("name") or "").strip()
            if not item:
                return None
            result = "success"
            outcome = item
            deltas.append(
                _resource_delta(
                    event,
                    source_type="nanlong",
                    source_name="南陇侯",
                    player=player,
                    resource_name=item,
                    amount=1,
                    basis="player",
                    meta=meta | {"implicit_amount": True},
                )
            )
        elif NANLONG_FAIL_TITLE_RE.search(text):
            result = "failed"
            outcome = "魔君之怒"
        else:
            return None

        event_row = _resource_event(
            event,
            source_type="nanlong",
            source_name="南陇侯",
            player=player,
            result=result,
            outcome=outcome,
            meta=meta,
        )
        return ParserOutput(resource_deltas=tuple(deltas), resource_events=(event_row,))

    def _parse_named_dungeon_result(
        self,
        event: RawMessageEvent,
        *,
        source_name: str,
        title: str,
        title_re: re.Pattern,
        success_markers: tuple[str, ...],
        failure_markers: tuple[str, ...],
    ) -> ParserOutput | None:
        text = event.text or ""
        if "奖励一览" in text:
            return None
        title_match = title_re.search(text)
        title_detail = ((title_match.group("name") if title_match else "") or "").strip()
        reward_lines = "\n".join(line for line in text.splitlines() if "获得" in line)
        if not reward_lines:
            return None
        meta = {"title": title}
        if title_detail:
            meta["settlement"] = title_detail
        result = "settled"
        if title_detail and any(marker in title_detail for marker in failure_markers):
            result = "failed"
        elif title_detail and any(marker in title_detail for marker in success_markers):
            result = "success"
        elif re.search(r"额外获得|首通奖励", reward_lines):
            result = "extra_success"
        deltas = _extract_reward_deltas(
            event,
            reward_lines,
            source_type="dungeon",
            source_name=source_name,
            player="",
            basis="run",
            meta=meta,
        )
        deltas.extend(
            _extract_explicit_item_deltas(
                event,
                reward_lines,
                source_type="dungeon",
                source_name=source_name,
                basis="run",
                meta=meta,
            )
        )
        if not deltas:
            return None
        event_row = _resource_event(
            event,
            source_type="dungeon",
            source_name=source_name,
            player="",
            result=result,
            outcome=title_detail,
            meta=meta,
        )
        return ParserOutput(resource_deltas=tuple(deltas), resource_events=(event_row,))

    def _parse_kunwu_result(self, event: RawMessageEvent) -> ParserOutput | None:
        text = event.text or ""
        if "最终收获" not in text:
            return None
        source_name = "昆吾山"
        meta = {"title": "登顶昆吾山"}
        deltas = _extract_reward_deltas(
            event,
            "\n".join(line for line in text.splitlines() if "获得" in line),
            source_type="dungeon",
            source_name=source_name,
            player="",
            basis="run",
            meta=meta,
        )
        deltas.extend(
            _extract_explicit_item_deltas(
                event,
                "\n".join(line for line in text.splitlines() if "获得" in line),
                source_type="dungeon",
                source_name=source_name,
                basis="run",
                meta=meta,
            )
        )
        deltas.extend(_extract_kunwu_rare_deltas(event, text, source_name=source_name, meta=meta))
        if not deltas:
            return None
        event_row = _resource_event(
            event,
            source_type="dungeon",
            source_name=source_name,
            player="",
            result="success",
            outcome="登顶",
            meta=meta,
        )
        return ParserOutput(resource_deltas=tuple(deltas), resource_events=(event_row,))

    def _parse_dungeon_loot(self, event: RawMessageEvent) -> ParserOutput | None:
        text = event.text or ""
        title = DUNGEON_LOOT_TITLE_RE.search(text)
        title_detail = ((title.group("name") if title else "") or "").strip()
        if any(marker in text for marker in BLOOD_MARKERS) or "血色" in title_detail:
            return None
        reward_lines = "\n".join(
            line for line in text.splitlines() if "获得" in line or "均获得" in line
        )
        if not reward_lines:
            return None
        meta = {"title": "战利品结算"}
        if title_detail:
            meta["settlement"] = title_detail
        if "天命所归" in text or re.search(r"@[A-Za-z0-9_]+\s*额外获得了", text):
            meta["lucky_drop"] = True
        if route := _infer_dungeon_route(text):
            meta["route"] = route

        result = "settled"
        if _contains_any(text, DUNGEON_BASIC_ONLY_MARKERS):
            result = "basic_only"
        elif _contains_any(text, DUNGEON_EXTRA_MARKERS):
            result = "extra_success"

        dungeon_name = _infer_dungeon_name(text, title_detail)
        deltas = _extract_reward_deltas(
            event,
            reward_lines,
            source_type="dungeon",
            source_name=dungeon_name,
            player="",
            basis="run",
            meta=meta,
        )
        deltas.extend(
            _extract_explicit_item_deltas(
                event,
                reward_lines,
                source_type="dungeon",
                source_name=dungeon_name,
                basis="run",
                meta=meta,
            )
        )
        if not deltas:
            return None
        event_row = _resource_event(
            event,
            source_type="dungeon",
            source_name=dungeon_name,
            player="",
            result=result,
            outcome=title_detail,
            meta=meta,
        )
        return ParserOutput(resource_deltas=tuple(deltas), resource_events=(event_row,))


def _extract_reward_deltas(
    event: RawMessageEvent,
    text: str,
    *,
    source_type: str,
    source_name: str,
    player: str,
    basis: str,
    meta: dict,
) -> list[ResourceDelta]:
    found: list[ResourceDelta] = []

    def add(name: str, amount: str, *, owner: str = "") -> None:
        resource_name = str(name or "").strip()
        if not resource_name:
            return
        value = _to_int(amount)
        if value <= 0:
            return
        found.append(
            _resource_delta(
                event,
                source_type=source_type,
                source_name=source_name,
                player=owner or player,
                resource_name=resource_name,
                amount=value,
                basis=basis,
                meta=meta,
            )
        )

    for match in RESOURCE_PLUS_RE.finditer(text):
        add(match.group("name"), match.group("amount"), owner=_line_owner_for_match(text, match.start()))
    for match in AMOUNT_BEFORE_RESOURCE_RE.finditer(text):
        add(match.group("name"), match.group("amount"), owner=_line_owner_for_match(text, match.start()))
    for match in RESOURCE_X_RE.finditer(text):
        add(
            match.group("bracket") or match.group("name"),
            match.group("amount"),
            owner=_line_owner_for_match(text, match.start()),
        )
    return found


def _extract_explicit_item_deltas(
    event: RawMessageEvent,
    text: str,
    *,
    source_type: str,
    source_name: str,
    basis: str,
    meta: dict,
) -> list[ResourceDelta]:
    found: list[ResourceDelta] = []
    for match in ITEM_WITHOUT_AMOUNT_RE.finditer(text):
        item = str(match.group("name") or "").strip()
        if not item or item.startswith("大量"):
            continue
        found.append(
            _resource_delta(
                event,
                source_type=source_type,
                source_name=source_name,
                player=match.group("user") or "",
                resource_name=item,
                amount=1,
                basis=basis,
                meta=meta | {"implicit_amount": True},
            )
        )
    return found


def _extract_kunwu_rare_deltas(
    event: RawMessageEvent,
    text: str,
    *,
    source_name: str,
    meta: dict,
) -> list[ResourceDelta]:
    found: list[ResourceDelta] = []
    for marker, resource_name, amount in KUNWU_RARE_PATTERNS:
        count = text.count(marker)
        if count <= 0:
            continue
        found.append(
            _resource_delta(
                event,
                source_type="dungeon",
                source_name=source_name,
                player="",
                resource_name=resource_name,
                amount=count * amount,
                basis="run",
                meta=meta | {"source": "route_log"},
            )
        )
    return found


def _extract_exp_surge_deltas(
    event: RawMessageEvent,
    text: str,
    *,
    source_type: str,
    source_name: str,
    player: str,
    basis: str,
    meta: dict,
) -> list[ResourceDelta]:
    found: list[ResourceDelta] = []
    for match in EXP_SURGE_RE.finditer(text):
        amount = _to_int(match.group("amount"))
        if amount <= 0:
            continue
        found.append(
            _resource_delta(
                event,
                source_type=source_type,
                source_name=source_name,
                player=player,
                resource_name="修为",
                amount=amount,
                basis=basis,
                meta=meta,
            )
        )
    return found


def _extract_wind_xi_buff_deltas(
    event: RawMessageEvent,
    text: str,
    *,
    player: str,
    meta: dict,
) -> list[ResourceDelta]:
    found: list[ResourceDelta] = []
    for match in re.finditer(r"获得限时增益\s*【(?P<name>[^】]+)】", text):
        item = str(match.group("name") or "").strip()
        if not item:
            continue
        found.append(
            _resource_delta(
                event,
                source_type="wind_xi",
                source_name="风希",
                player=player,
                resource_name=item,
                amount=1,
                basis="player",
                meta=meta | {"buff": True, "implicit_amount": True},
            )
        )
    return found


def _extract_jiyin_buff_deltas(
    event: RawMessageEvent,
    text: str,
    *,
    player: str,
    meta: dict,
) -> list[ResourceDelta]:
    found: list[ResourceDelta] = []
    for match in re.finditer(r"得到【(?P<name>[^】]+)】增益", text):
        item = str(match.group("name") or "").strip()
        if not item:
            continue
        found.append(
            _resource_delta(
                event,
                source_type="jiyin",
                source_name="极阴",
                player=player,
                resource_name=item,
                amount=1,
                basis="player",
                meta=meta | {"buff": True, "implicit_amount": True},
            )
        )
    return found


def _extract_loss_deltas(
    event: RawMessageEvent,
    text: str,
    *,
    source_type: str,
    source_name: str,
    player: str,
    basis: str,
    meta: dict,
) -> list[ResourceDelta]:
    found: list[ResourceDelta] = []
    for match in RESOURCE_LOSS_RE.finditer(text):
        amount = -abs(_to_int(match.group("amount")))
        if amount >= 0:
            continue
        found.append(
            _resource_delta(
                event,
                source_type=source_type,
                source_name=source_name,
                player=player,
                resource_name=match.group("name"),
                amount=amount,
                basis=basis,
                meta=meta | {"loss": True},
            )
        )
    return found


def _resource_delta(
    event: RawMessageEvent,
    *,
    source_type: str,
    source_name: str,
    player: str,
    resource_name: str,
    amount: int,
    basis: str,
    meta: dict,
) -> ResourceDelta:
    return ResourceDelta(
        raw_message_id=event.id,
        source_type=source_type,
        source_name=source_name,
        player=player,
        resource_name=resource_name,
        amount=amount,
        unit="点" if resource_name == "修为" else "",
        basis=basis,
        event_time=event.date,
        chat_id=int(event.chat_id or 0),
        msg_id=int(event.msg_id or 0),
        meta=dict(meta) | {"amount_kind": "gain" if amount >= 0 else "loss"},
    )


def _resource_event(
    event: RawMessageEvent,
    *,
    source_type: str,
    source_name: str,
    player: str,
    result: str,
    outcome: str,
    meta: dict,
) -> ResourceEvent:
    return ResourceEvent(
        raw_message_id=event.id,
        source_type=source_type,
        source_name=source_name,
        player=player,
        result=result,
        outcome=outcome,
        event_time=event.date,
        chat_id=int(event.chat_id or 0),
        msg_id=int(event.msg_id or 0),
        meta=dict(meta),
    )


def _first_player(text: str) -> str:
    if match := PLAYER_RE.search(text):
        return match.group("user")
    return ""


def _line_owner_for_match(text: str, pos: int) -> str:
    start = text.rfind("\n", 0, max(0, pos)) + 1
    end = text.find("\n", max(0, pos))
    if end < 0:
        end = len(text)
    return _first_player(text[start:end])


def _contains_any(text: str, markers: tuple[str, ...]) -> bool:
    return any(marker in text for marker in markers)


def _to_int(value: object) -> int:
    raw = str(value or "").strip().replace(",", "")
    if not raw:
        return 0
    if raw in CN_DIGITS:
        return CN_DIGITS[raw]
    try:
        return int(raw)
    except ValueError:
        return 0


CN_DIGITS = {
    "一": 1,
    "二": 2,
    "两": 2,
    "三": 3,
    "四": 4,
    "五": 5,
    "六": 6,
    "七": 7,
    "八": 8,
    "九": 9,
    "十": 10,
    # 文案里的「几缕」没有精确数量,这里只按一次产出记录。
    "几": 1,
}


def _infer_wild_strategy(text: str) -> str:
    if match := re.search(r"选择【(?P<strategy>谨慎|均衡|深入)】策略", text):
        return match.group("strategy")
    return infer_wild_strategy_from_command(text)


def infer_wild_strategy_from_command(text: str) -> str:
    if match := re.search(r"\.野外历练\s+(?P<strategy>谨慎|均衡|深入)(?:\s|$)", text or ""):
        return match.group("strategy")
    if re.fullmatch(r"\s*\.野外历练\s*", text or ""):
        return "均衡"
    return ""


def _wild_source_name(strategy: str) -> str:
    return f"野外历练·{strategy}" if strategy else "野外历练·未知"


def _infer_dungeon_name(text: str, title_detail: str = "") -> str:
    settlement = str(title_detail or "").strip()
    if settlement in {"夺鼎", "求稳"}:
        return _dungeon_source_name("虚天殿", settlement)
    for name in NON_BLOOD_DUNGEONS:
        if name in text:
            return _dungeon_source_name(name, settlement)
    for marker, name in DUNGEON_ROUTE_NAMES.items():
        if marker in text:
            return _dungeon_source_name(name, settlement)
    if any(marker in text for marker in ("夺鼎", "求稳")):
        return _dungeon_source_name("副本·未识别", settlement)
    return "副本"


def _infer_dungeon_route(text: str) -> str:
    if "玄冰秘径" in text or "极寒冰魄" in text:
        return "玄冰秘径"
    if "焚炎秘径" in text or "焚天烈焰" in text:
        return "焚炎秘径"
    return ""


def _dungeon_source_name(name: str, settlement: str) -> str:
    if name.startswith("虚天殿") and settlement in {"夺鼎", "求稳"}:
        return f"{name}·{settlement}"
    return name
