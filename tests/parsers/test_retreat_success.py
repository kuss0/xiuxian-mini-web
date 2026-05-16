from backend.parsers.retreat_success import RetreatSuccessParser
from tests.parsers import load_fixture, make_event


def test_extracts_retreat_success_breakdown():
    event = make_event(load_fixture("retreat_success.txt"))
    output = RetreatSuccessParser().parse(event)
    assert output is not None
    card = output.cards[0]
    assert card.title == "闭关成功"
    assert "战报" in card.tags
    assert card.fields["基础修为"] == "480 点"
    assert card.fields["灵脉加成"] == "168 点"
    assert card.fields["阵法加成"] == "324 点"
    assert card.fields["本次总收益"] == "972 点"
    assert card.fields["当前境界"] == "元婴后期"
    assert card.fields["当前修为"] == "572479 / 2000000"
    assert card.fields["修为进度"] == {"current": 572479, "max": 2000000}
    assert card.fields["调息冷却"] == "11 分钟"
    assert "金精矿" in card.fields["奇遇"]


def test_skips_when_marker_missing():
    event = make_event("普通的聊天内容")
    assert RetreatSuccessParser().parse(event) is None
