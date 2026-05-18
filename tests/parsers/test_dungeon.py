from backend.parsers.dungeon import DungeonParser
from tests.parsers import load_fixture, make_event


def test_extracts_dungeon_id_and_join_action():
    event = make_event(load_fixture("dungeon_xutian_open.txt"))
    output = DungeonParser().parse(event)
    assert output is not None
    card = output.cards[0]
    assert card.title == "虚天殿开启"
    assert card.fields["副本名"] == "虚天殿"
    assert card.fields["副本ID"] == "394"
    assert card.fields["状态"] == "可加入"
    assert card.actions[0].command == ".加入副本 394"
    assert card.actions[0].chat_id == event.chat_id
    assert card.actions[0].reply_to_msg_id == event.msg_id


def test_extracts_full_open_announcement_context():
    event = make_event(
        "【虚天殿已开启】\n"
        "@tinghua01 消耗了【虚天残图】，开启了前往虚天殿的传送门！\n"
        "副本ID: 393\n"
        "其他道友可使用 .加入副本 393 加入队伍！(5人满)"
    )
    output = DungeonParser().parse(event)
    assert output is not None
    card = output.cards[0]
    assert card.title == "虚天殿开启"
    assert card.fields["开门人"] == "@tinghua01"
    assert card.fields["消耗道具"] == "虚天残图"
    assert card.fields["人数上限"] == "5人"
    assert card.actions[0].label == "加入副本"
    assert card.actions[0].command == ".加入副本 393"


def test_extracts_zhuimo_progress_choices_and_silence_status():
    event = make_event(
        "【坠魔谷·第一幕：裂隙外谷】\n"
        "你们踏入谷口，黑雾翻涌，封印符纹时明时灭。\n"
        "请队长选择推进策略：\n\n"
        "路径1 · 破煞突进：强行冲阵，抢在魔潮成形前压制谷口裂隙。\n"
        "路径2 · 稳守阵眼：以阵法缓进，先稳固封印基座再推进。\n"
        "路径3 · 潜行搜魂：避开主裂隙，绕行残阵寻找古修士遗留封纹。\n\n"
        "使用 .坠魔抉择 路径1/路径2/路径3 继续。\n\n"
        "【稳控全场】已展开\n"
        "副本结束前，天机阁将暂不响应本话题中的其他修仙指令。"
    )
    output = DungeonParser().parse(event)
    assert output is not None
    card = output.cards[0]
    assert card.title == "坠魔谷推进"
    assert card.fields["副本名"] == "坠魔谷"
    assert card.fields["阶段"] == "第一幕：裂隙外谷"
    assert card.fields["静场令"] == "已展开"
    assert card.fields["可选路径"] == [
        "路径1 · 破煞突进",
        "路径2 · 稳守阵眼",
        "路径3 · 潜行搜魂",
    ]
    assert [action.command for action in card.actions] == [
        ".坠魔抉择 路径1",
        ".坠魔抉择 路径2",
        ".坠魔抉择 路径3",
    ]
    assert all(action.reply_to_msg_id == event.msg_id for action in card.actions)


def test_extracts_silence_order_ready_message():
    event = make_event(
        "你已祭出【稳控全场】，为本次【坠魔谷】立下静场令。\n"
        "待队长正式带队进入副本后，直至副本结束前，天机阁将暂不响应本话题中的其他修仙指令。"
    )
    output = DungeonParser().parse(event)
    assert output is not None
    card = output.cards[0]
    assert card.title == "副本静场令"
    assert card.fields["副本名"] == "坠魔谷"
    assert card.fields["状态"] == "静场令待生效"
    assert card.actions == ()


def test_skips_when_no_dungeon_id_present():
    event = make_event("加入队伍但是没有副本ID 字段")
    assert DungeonParser().parse(event) is None


def test_skips_unrelated_messages():
    event = make_event("玩家聊天")
    assert DungeonParser().parse(event) is None
