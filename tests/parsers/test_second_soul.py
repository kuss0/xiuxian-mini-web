from backend.parsers.second_soul import SecondSoulParser
from tests.parsers import load_fixture, make_event


def test_recognizes_return_to_void():
    event = make_event(load_fixture("second_soul_return_to_void.txt"))
    output = SecondSoulParser().parse(event)
    assert output is not None
    card = output.cards[0]
    assert card.title == "第二元神归位"
    assert "mine" in card.channels and "training" in card.channels
    assert card.severity == "normal"
    commands = [action.command for action in card.actions]
    assert ".抉择 稳固道心" in commands
    assert ".元神修炼" in commands


def test_does_not_match_unrelated_text():
    event = make_event("普通玩家闲聊,没有元神主题")
    assert SecondSoulParser().parse(event) is None


def test_does_not_match_partial_keyword():
    # 缺少 "回归窍中温养" 关键短语,只命中标题就不该出
    event = make_event("【第二元神归位】道友正在外面渡劫,尚未归来")
    assert SecondSoulParser().parse(event) is None
