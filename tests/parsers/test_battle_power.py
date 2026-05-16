from backend.parsers.battle_power import BattlePowerParser
from tests.parsers import load_fixture, make_event


def test_extracts_combined_power_and_realm():
    event = make_event(load_fixture("battle_power.txt"))
    output = BattlePowerParser().parse(event)
    assert output is not None
    card = output.cards[0]
    assert card.title == "战力评估"
    assert card.fields.get("综合战力") == "333.8万"
    assert card.fields.get("battle_power_value") == 3338000
    assert card.fields.get("境界") == "元婴中期"
    assert card.fields.get("角色名") == "空尘子"
    assert card.fields.get("username") == "example"
    patches = {patch.key: patch.value for patch in output.state_patches}
    assert patches.get("综合战力") == "333.8万"
    assert patches.get("battle_power_value") == 3338000
    assert patches.get("角色名") == "空尘子"
    assert patches.get("username") == "example"


def test_power_to_value_handles_units():
    from backend.parsers.battle_power import _power_to_value
    assert _power_to_value("333.8万") == 3338000
    assert _power_to_value("87.54亿") == 8754000000
    assert _power_to_value("1234") == 1234
    assert _power_to_value("12,345") == 12345
    assert _power_to_value("") == 0
    assert _power_to_value("not a number") == 0


def test_skips_when_keyword_missing():
    event = make_event("一些普通玩家聊天")
    assert BattlePowerParser().parse(event) is None
