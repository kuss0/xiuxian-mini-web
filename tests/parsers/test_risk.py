from backend.parsers.risk import RISK_KEYWORDS, RiskParser
from tests.parsers import load_fixture, make_event


def test_marks_severity_risk_and_no_actions():
    event = make_event(load_fixture("risk_judgement.txt"))
    output = RiskParser().parse(event)
    assert output is not None
    card = output.cards[0]
    assert card.severity == "risk"
    assert "risk" in card.channels
    # 风险消息不自动给动作 — 用户必须人工查看
    assert card.actions == ()


def test_each_keyword_triggers_match():
    for keyword in RISK_KEYWORDS:
        event = make_event(f"前缀 {keyword} 后缀")
        assert RiskParser().parse(event) is not None, f"keyword {keyword} 未命中"


def test_clean_message_is_ignored():
    event = make_event("一切平静,没有任何风险关键字")
    assert RiskParser().parse(event) is None
