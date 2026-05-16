from backend.parsers.realm_breakthrough import RealmBreakthroughParser
from tests.parsers import load_fixture, make_event


def test_extracts_realm_and_username():
    event = make_event(load_fixture("realm_breakthrough.txt"))
    output = RealmBreakthroughParser().parse(event)
    assert output is not None
    card = output.cards[0]
    assert card.title == "境界突破"
    assert card.fields.get("境界") == "元婴中期"
    assert card.fields.get("username") == "wisemole"
    patches = {patch.key: patch.value for patch in output.state_patches}
    assert patches.get("境界") == "元婴中期"
    assert patches.get("username") == "wisemole"


def test_skips_unrelated():
    event = make_event("一些不相关的消息,没有突破")
    assert RealmBreakthroughParser().parse(event) is None


def test_skips_partial_keywords():
    event = make_event("成功突破至【元婴】 但是没有「灵」字提示")
    assert RealmBreakthroughParser().parse(event) is None
