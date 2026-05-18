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


def test_extracts_join_failed_when_room_missing():
    event = make_event("找不到此副本房间，可能已解散或ID错误。")
    output = DungeonResultParser().parse(event)
    assert output is not None
    card = output.cards[0]
    assert card.title == "加入副本失败"
    assert card.fields["状态"] == "加入失败"
    assert card.fields["失败原因"] == "找不到房间，可能已解散或ID错误"
    assert "失败" in card.tags


def test_skips_unrelated():
    event = make_event("普通聊天")
    assert DungeonResultParser().parse(event) is None
