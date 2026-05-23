from backend.parsers.dungeon_result import DungeonResultParser
from tests.parsers import make_event


def test_extracts_dungeon_join():
    event = make_event("@hallopey 已成功加入副本 12345")
    output = DungeonResultParser().parse(event)
    assert output is not None
    card = output.cards[0]
    assert card.title == "加入副本成功"
    assert card.fields["副本ID"] == "12345"
    assert card.fields["username"] == "hallopey"


def test_extracts_zuomogu():
    event = make_event("@x 已成功加入坠魔谷 999")
    output = DungeonResultParser().parse(event)
    assert output is not None
    assert output.cards[0].fields["副本ID"] == "999"


def test_extracts_room_dissolved():
    event = make_event("已将副本房间 (ID: 7777) 解散，请重新组队。")
    output = DungeonResultParser().parse(event)
    assert output is not None
    assert output.cards[0].title == "副本房间解散"
    assert output.cards[0].fields["副本ID"] == "7777"


def test_extracts_cangkun_room_dissolved():
    event = make_event("队长 @WalterWA2000 已解散苍坤上人洞府房间（ID: 13）。\n因队伍尚未出发，天道已将【苍坤残图】归还。")

    output = DungeonResultParser().parse(event)

    assert output is not None
    card = output.cards[0]
    assert card.title == "副本房间解散"
    assert card.fields["副本ID"] == "13"
    assert card.fields["副本名"] == "苍坤上人洞府"


def test_extracts_join_failed_when_room_missing():
    event = make_event("找不到此副本房间，可能已解散或ID错误。")
    output = DungeonResultParser().parse(event)
    assert output is not None
    card = output.cards[0]
    assert card.title == "加入副本失败"
    assert card.fields["状态"] == "加入失败"
    assert card.fields["失败原因"] == "找不到房间，可能已解散或ID错误"
    assert "失败" in card.tags


def test_extracts_cangkun_join_success():
    event = make_event(
        "@cupaopao 已加入苍坤上人洞府队伍！\n"
        "当前队伍 (5/5):\n"
        "- @takaranoao_bot\n"
        "- @cupaopao"
    )

    output = DungeonResultParser().parse(event)

    assert output is not None
    card = output.cards[0]
    assert card.title == "加入副本成功"
    assert card.fields["username"] == "cupaopao"
    assert card.fields["副本名"] == "苍坤上人洞府"
    assert card.fields["状态"] == "已加入"


def test_extracts_cangkun_join_failures():
    samples = [
        (
            "苍坤上人洞府只对 结丹后期 及以上修士开放。",
            "境界不足，需要 结丹后期 及以上",
        ),
        ("你已在一个苍坤上人洞府队伍中。", "已在苍坤上人洞府队伍中"),
        (
            "你并非队长，或你开启的苍坤上人洞府房间已解散。",
            "非队长或苍坤上人洞府房间已解散",
        ),
        ("苍坤洞府外层神禁极重，至少需要 5 名修士合力破禁。", "人数不足，需要 5 人"),
        (
            "找不到此苍坤上人洞府房间，可能已出发或已解散。",
            "找不到苍坤上人洞府房间，可能已出发或已解散",
        ),
    ]

    for text, reason in samples:
        output = DungeonResultParser().parse(make_event(text))
        assert output is not None
        card = output.cards[0]
        assert card.title == "加入副本失败"
        assert card.fields["副本名"] == "苍坤上人洞府"
        assert card.fields["失败原因"] == reason


def test_skips_unrelated():
    event = make_event("普通聊天")
    assert DungeonResultParser().parse(event) is None
