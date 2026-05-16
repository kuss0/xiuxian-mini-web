from backend.parsers.battle_power import BattlePowerParser
from tests.parsers import load_fixture, make_event


def test_extracts_combined_power_and_realm():
    event = make_event(load_fixture("battle_power.txt"))
    output = BattlePowerParser().parse(event)
    assert output is not None
    card = output.cards[0]
    assert card.title == "战力评估"
    assert card.fields.get("综合战力") == "333.8万"
    assert card.fields.get("境界") == "元婴中期"  # 注意去掉了括号宗门
    assert card.fields.get("角色名") == "空尘子"
    assert card.fields.get("username") == "example"
    patches = {patch.key: patch.value for patch in output.state_patches}
    assert patches.get("综合战力") == "333.8万"
    assert patches.get("角色名") == "空尘子"
    assert patches.get("username") == "example"


def test_skips_when_keyword_missing():
    event = make_event("一些普通玩家聊天")
    assert BattlePowerParser().parse(event) is None
