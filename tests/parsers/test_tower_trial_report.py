from backend.parsers.tower_trial_report import TowerTrialReportParser
from tests.parsers import load_fixture, make_event


def test_extracts_tower_trial_summary():
    event = make_event(load_fixture("tower_trial_report.txt"))
    output = TowerTrialReportParser().parse(event)
    assert output is not None
    card = output.cards[0]
    assert card.title == "试炼古塔战报"
    assert "副本" in card.tags
    assert "战报" in card.tags
    assert card.fields["闯过层数"] == "19 层"
    assert card.fields["修为增长"] == "3659 点"
    assert "宝库层x6" in card.fields["塔相轨迹"]
    assert "攻势" in card.fields["本次构筑"]
    assert "魔念回响" in card.fields["触发奇遇"]
    assert "天佑" in card.fields["遭遇词缀"]
    assert card.fields["同境界超过"] == "94%"
    assert "439" in card.fields["塔印"]
    loots = card.fields["收获列表"]
    assert isinstance(loots, list)
    assert any("灵石" in ln for ln in loots)
    floors = card.fields["逐层详情"]
    assert isinstance(floors, list)
    assert any(f["outcome"] == "败北" for f in floors)
    assert any(f["outcome"] == "险胜" for f in floors)
    assert any(f["outcome"] == "碾压" for f in floors)


def test_skips_when_marker_missing():
    event = make_event("你深吸一口气，踏入了古塔的第 1 层")
    assert TowerTrialReportParser().parse(event) is None
