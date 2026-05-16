from backend.parsers.dungeon import DungeonParser
from tests.parsers import load_fixture, make_event


def test_extracts_dungeon_id_and_join_action():
    event = make_event(load_fixture("dungeon_xutian_open.txt"))
    output = DungeonParser().parse(event)
    assert output is not None
    card = output.cards[0]
    assert card.title == "虚天殿开启"
    assert card.fields["副本ID"] == "394"
    assert card.actions[0].command == ".加入副本 394"
    assert card.actions[0].chat_id == event.chat_id
    assert card.actions[0].reply_to_msg_id == event.msg_id


def test_skips_when_no_dungeon_id_present():
    event = make_event("加入队伍但是没有副本ID 字段")
    assert DungeonParser().parse(event) is None


def test_skips_unrelated_messages():
    event = make_event("玩家聊天")
    assert DungeonParser().parse(event) is None
