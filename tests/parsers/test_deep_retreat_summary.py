from backend.parsers.deep_retreat_summary import DeepRetreatSummaryParser
from tests.parsers import load_fixture, make_event


def test_extracts_summary_block_fields():
    event = make_event(load_fixture("deep_retreat_summary.txt"))
    output = DeepRetreatSummaryParser().parse(event)
    assert output is not None
    card = output.cards[0]
    assert card.title == "深度闭关总结"
    assert "战报" in card.tags
    assert card.fields["结算时长"] == "8.0 小时"
    assert card.fields["神魂吐纳"] == "32 周天"
    assert card.fields["修行有成"] == "22 次"
    assert card.fields["心神不宁"] == "10 次"
    assert card.fields["走火入魔"] == "0 次"
    assert card.fields["天降奇遇"] == "12 次"
    assert card.fields["修为变化"] == "34087 点"
    assert "掩月心契" in card.fields["状态加持"]
    adventures = card.fields["奇遇详情"]
    assert isinstance(adventures, list)
    assert len(adventures) >= 3
    assert any("百年铁木" in line for line in adventures)


def test_skips_when_marker_missing():
    event = make_event("你正在深度闭关，预计还需 1小时 即可功成圆满。")
    assert DeepRetreatSummaryParser().parse(event) is None
