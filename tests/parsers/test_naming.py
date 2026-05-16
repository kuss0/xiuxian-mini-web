from backend.parsers.naming import NamingParser
from tests.parsers import load_fixture, make_event


def test_extracts_daohao_root_realm():
    event = make_event(load_fixture("naming_event.txt"))
    output = NamingParser().parse(event)
    assert output is not None
    card = output.cards[0]
    assert card.title == "赐予道号"
    assert card.fields.get("道号") == "素尘子"
    assert card.fields.get("灵根") == "伪灵根(金木水)"
    assert card.fields.get("境界") == "炼气一层"
    patches = {patch.key: patch.value for patch in output.state_patches}
    assert patches.get("道号") == "素尘子"
    assert patches.get("灵根") == "伪灵根(金木水)"
    assert patches.get("境界") == "炼气一层"
    assert all(patch.scope == "identity_profile" for patch in output.state_patches)


def test_skips_when_no_daohao_keyword():
    event = make_event("普通的消息,不涉及道号")
    assert NamingParser().parse(event) is None
