from backend.parsers.profile import ProfileParser
from tests.parsers import load_fixture, make_event


def test_extracts_root_and_sect_and_emits_state_patches():
    event = make_event(load_fixture("profile_tianming.txt"))
    output = ProfileParser().parse(event)
    assert output is not None
    card = output.cards[0]
    assert card.title == "角色信息"
    assert card.fields.get("灵根") == "天灵根(火)"
    assert card.fields.get("宗门") == "【凌霄宫】"
    patches = {patch.key: patch.value for patch in output.state_patches}
    assert patches.get("灵根") == "天灵根(火)"
    assert patches.get("宗门") == "【凌霄宫】"
    assert all(patch.scope == "identity_profile" for patch in output.state_patches)
    assert all(patch.source_message_id == event.id for patch in output.state_patches)


def test_message_without_keyword_is_skipped():
    event = make_event("普通聊天,没有玉牒")
    assert ProfileParser().parse(event) is None
