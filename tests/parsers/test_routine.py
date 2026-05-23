from backend.parsers.routine import RoutineResultParser
from tests.parsers import make_event


def test_routine_parser_classifies_deep_retreat_start():
    output = RoutineResultParser().parse(
        make_event("你已进入深度闭关状态，神魂将自行吐纳 8 小时。")
    )

    assert output is not None
    card = output.cards[0]
    assert card.title == "深度闭关开始"
    assert "training" in card.channels


def test_routine_parser_classifies_attendance_as_resource():
    output = RoutineResultParser().parse(make_event("点卯成功！你获得了 5 点宗门贡献。"))

    assert output is not None
    card = output.cards[0]
    assert card.title == "宗门点卯"
    assert "resource" in card.channels


def test_routine_parser_classifies_second_soul_panel_as_training():
    output = RoutineResultParser().parse(
        make_event("你的本命元婴\n\n等级: 7 级\n经验: 529 / 3500\n状态: 窍中温养")
    )

    assert output is not None
    assert output.cards[0].title == "本命元婴"
    assert "training" in output.cards[0].channels


def test_routine_parser_skips_unrelated_chat():
    assert RoutineResultParser().parse(make_event("普通玩家闲聊")) is None
