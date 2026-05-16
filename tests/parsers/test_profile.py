from backend.parsers.profile import ProfileParser
from tests.parsers import load_fixture, make_event


def test_extracts_root_and_sect_and_emits_state_patches():
    event = make_event(load_fixture("profile_tianming.txt"))
    output = ProfileParser().parse(event)
    assert output is not None
    card = output.cards[0]
    assert card.title == "角色信息"
    assert card.fields.get("灵根") == "天灵根(火)"
    assert card.fields.get("spiritual_root_type") == "天灵根"
    assert card.fields.get("spiritual_root_attrs") == "火"
    assert card.fields.get("宗门") == "【凌霄宫】"
    assert card.fields.get("称号") == "【紫灵的轻吻】"
    assert card.fields.get("修为") == "445955 / 1000000"
    assert card.fields.get("修为进度") == {"current": 445955, "max": 1000000}
    assert card.fields.get("xiuwei_current") == 445955
    assert card.fields.get("xiuwei_max") == 1000000
    assert card.fields.get("username") == "example"
    patches = {patch.key: patch.value for patch in output.state_patches}
    assert patches.get("灵根") == "天灵根(火)"
    assert patches.get("spiritual_root_type") == "天灵根"
    assert patches.get("spiritual_root_attrs") == "火"
    assert patches.get("xiuwei_current") == 445955
    assert patches.get("xiuwei_max") == 1000000
    assert "修为进度" not in patches  # dict 不进 patch
    assert all(patch.scope == "identity_profile" for patch in output.state_patches)
    assert all(patch.source_message_id == event.id for patch in output.state_patches)


def test_message_without_keyword_is_skipped():
    event = make_event("普通聊天,没有玉牒")
    assert ProfileParser().parse(event) is None
