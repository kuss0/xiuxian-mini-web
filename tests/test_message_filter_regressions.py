from __future__ import annotations

from backend.domain.models import ActionSuggestion, ParsedCard, RawMessageEvent
from backend.processors.message_filter import enrich_filter_channels


def _card(
    *,
    channels: tuple[str, ...] = ("world",),
    source: str = "玩家",
    title: str = "消息",
    actions: tuple[ActionSuggestion, ...] = (),
) -> ParsedCard:
    return ParsedCard(
        id="regression-card",
        channels=channels,
        title=title,
        summary="",
        source=source,
        time="",
        tags=(),
        raw="",
        actions=actions,
    )


def _event(
    text: str,
    *,
    source: str = "玩家",
    sender_id: int | None = 222,
    reply_to_msg_id: int | None = None,
) -> RawMessageEvent:
    return RawMessageEvent(
        id=f"regression-{abs(hash((text, source, sender_id))) % 100000}",
        chat_id=1,
        msg_id=1,
        text=text,
        source=source,
        date="",
        sender_id=sender_id,
        reply_to_msg_id=reply_to_msg_id,
    )


def _classify(
    text: str,
    *,
    card: ParsedCard | None = None,
    event: RawMessageEvent | None = None,
    settings: dict | None = None,
    parent_event: RawMessageEvent | None = None,
    my_identity_ids: tuple[int, ...] = (12345,),
):
    return enrich_filter_channels(
        card or _card(),
        event or _event(text),
        {
            "focus_include_player_plain": True,
            "focus_keywords": ["虚天殿", "苍坤洞府", "坠魔心劫"],
            **(settings or {}),
        },
        is_game_bot_sender=lambda sid: sid == -100,
        parent_event=parent_event,
        my_identity_ids=my_identity_ids,
    )


def test_blood_trial_room_messages_are_archive_only():
    text = (
        "@MayaLing 正在召集同伴，准备进入【血色禁地】采药试炼！\n"
        "房间ID: 520\n"
        "准入境界：炼气五层 - 筑基后期\n"
        "进入次数：每日 1 次\n"
        "副本内采得的灵草会先暂存于队伍药篓，只有成功撤离时才会统一发到储物袋。\n"
        "其他道友可使用 .加入血色试炼 520 加入队伍！(最多 3 人)\n"
        "队长可随时使用 .进入血色试炼 出发。"
    )

    result = _classify(
        text,
        card=_card(channels=("system", "dungeon"), source="韩天尊", title="血色禁地"),
        event=_event(text, source="韩天尊", sender_id=-100),
    )

    assert "archive" in result.channels
    assert "focus" not in result.channels
    assert "血色禁地归档" in result.reasons


def test_falling_demon_heart_trial_round_and_settlement_are_archive_only():
    settlement = (
        "【坠魔心劫·结算】\n"
        "三轮抉择：稳 / 稳 / 稳\n"
        "你以守代攻，借势封魔，终在险境中稳稳落子。\n"
        "你以韩立式谨慎贯穿全局，收益最大。\n"
        "修为结算：+659\n"
        "情缘结算：+7\n"
        "心魔值结算：-5（当前 0）"
    )
    round_prompt = (
        "【坠魔心劫·第2轮已定】\n"
        "你按韩立式谨慎节奏步步为营，侍妾神念与你渐趋同频。\n\n"
        "【坠魔心劫·第3轮】\n"
        "幻境再变，请继续回复 .稳 / .狠 / .骗。"
    )

    for text in (settlement, round_prompt):
        result = _classify(
            text,
            card=_card(
                channels=("system", "prompt", "home"),
                source="韩天尊",
                title="坠魔心劫",
                actions=(ActionSuggestion("copy", "稳", ".稳"),),
            ),
            event=_event(text, source="韩天尊", sender_id=-100),
        )

        assert "archive" in result.channels
        assert "focus" not in result.channels
        assert "坠魔心劫归档" in result.reasons


def test_falling_demon_heart_trial_reply_to_me_keeps_mine_context():
    text = "【坠魔心劫·第3轮】\n幻境再变，请继续回复 .稳 / .狠 / .骗。"
    parent = _event(".共历心劫", source="我", sender_id=12345)
    result = _classify(
        text,
        card=_card(
            channels=("system", "prompt", "home"),
            source="韩天尊",
            title="坠魔心劫",
            actions=(ActionSuggestion("copy", "稳", ".稳"),),
        ),
        event=_event(text, source="韩天尊", sender_id=-100, reply_to_msg_id=10),
        parent_event=parent,
    )

    assert "mine" in result.channels
    assert "回复我" in result.tags
    assert "坠魔心劫归档" not in result.reasons


def test_xutian_rear_hall_stop_is_archived_and_labeled():
    text = (
        "【后殿冲关止步】\n"
        "回合耗尽，鼎灵残焰仍未被真正压灭。\n"
        "好在第三关结算所得早已锁定，这次失去的只有后殿追加机缘。"
    )

    result = _classify(
        text,
        card=_card(channels=("system", "dungeon"), source="韩天尊", title="虚天殿后殿"),
        event=_event(text, source="韩天尊", sender_id=-100),
    )

    assert "archive" in result.channels
    assert "focus" not in result.channels
    assert "虚天殿后殿止步归档" in result.reasons


def test_plain_player_chat_stays_focus_when_not_low_signal():
    text = "这边好了，可以开了"
    result = _classify(
        text,
        card=_card(channels=("world",), source="玩家", title="玩家消息"),
        event=_event(text, source="玩家", sender_id=222),
        settings={"focus_keywords": []},
    )

    assert "focus" in result.channels
    assert "archive" not in result.channels
    assert "普通玩家消息策略" in result.reasons
