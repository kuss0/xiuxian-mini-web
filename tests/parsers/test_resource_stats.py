from backend.parsers.resource_stats import ResourceStatsParser
from tests.parsers import make_event


def test_extracts_wild_training_resource_deltas():
    event = make_event(
        """【野外历练 · 灵机暗藏】
@salt9527 在山涧残阵旁避开妖兽踪迹，采得一份机缘。
获得修为 +12000，获得 【灵石】x399。
此为玩家对 NPC 历练，不牵连其他修士。"""
    )
    output = ResourceStatsParser().parse(event)
    assert output is not None
    deltas = {(delta.resource_name, delta.amount) for delta in output.resource_deltas}
    assert deltas == {("修为", 12000), ("灵石", 399)}
    assert all(delta.source_type == "wild_training" for delta in output.resource_deltas)
    assert all(delta.source_name == "野外历练" for delta in output.resource_deltas)
    assert all(delta.player == "salt9527" for delta in output.resource_deltas)
    assert all(delta.basis == "player" for delta in output.resource_deltas)
    assert [(event.result, event.outcome) for event in output.resource_events] == [
        ("success", "灵机暗藏")
    ]


def test_wild_training_does_not_parse_username_with_x_digits_as_resource():
    event = make_event(
        """【野外历练 · 妖兽遭遇】
@Xoxox006 在山道遭遇妖兽，负伤而归。
获得修为 +8000，获得 【二级妖丹】x1。"""
    )
    output = ResourceStatsParser().parse(event)
    assert output is not None
    assert {(delta.resource_name, delta.amount) for delta in output.resource_deltas} == {
        ("修为", 8000),
        ("二级妖丹", 1),
    }
    assert output.resource_events[0].result == "success"


def test_extracts_wild_training_failed_event_and_loss():
    event = make_event(
        """【野外历练 · 负伤而归】
@snpao002 遭遇 玄水妖蟒，一时判断失误。
战力对比: 你 2107240 / 妖兽 1935703，胜算 53%。
你强行脱身，修为折损 -2522。
此为 NPC 历练失败，不计入斗法记录。"""
    )
    output = ResourceStatsParser().parse(event)
    assert output is not None
    assert [(delta.resource_name, delta.amount) for delta in output.resource_deltas] == [
        ("修为", -2522)
    ]
    assert output.resource_events[0].result == "failed"


def test_extracts_wild_training_cooldown_event_without_delta():
    event = make_event("【野外历练】\n山中灵机未复，请在 19分钟7秒 后再来。")
    output = ResourceStatsParser().parse(event)
    assert output is not None
    assert output.resource_deltas == ()
    assert output.resource_events[0].result == "cooldown"


def test_extracts_dungeon_loot_run_deltas():
    event = make_event(
        """【战利品结算·夺鼎】
你们逆着鼎火冲入核心，试图在宝光消散前强夺最后一缕机缘。
所有队员均获得 5000修为 和 500贡献！
你们强夺鼎火时引发了反噬，额外宝藏尽毁，只保住了基础收获。
玄冰秘径：每位队员获得 养魂木x1"""
    )
    output = ResourceStatsParser().parse(event)
    assert output is not None
    deltas = {(delta.resource_name, delta.amount) for delta in output.resource_deltas}
    assert deltas == {("修为", 5000), ("贡献", 500), ("养魂木", 1)}
    assert all(delta.source_type == "dungeon" for delta in output.resource_deltas)
    assert all(delta.source_name == "虚天殿" for delta in output.resource_deltas)
    assert all(delta.basis == "run" for delta in output.resource_deltas)
    assert output.resource_events[0].result == "basic_only"


def test_extracts_dungeon_explicit_lucky_item_without_amount_as_one():
    event = make_event(
        """【战利品结算·求稳】
所有队员均获得 5000修为 和 500贡献！
天命所归，幸运道友 @snpao3 额外获得了 【第二元神残篇】！
焚炎秘径：每位队员获得 三级妖丹x1
@snpao3 额外获得了 【二级妖丹】x2"""
    )
    output = ResourceStatsParser().parse(event)
    assert output is not None
    assert {(delta.player, delta.resource_name, delta.amount) for delta in output.resource_deltas} == {
        ("", "修为", 5000),
        ("", "贡献", 500),
        ("", "三级妖丹", 1),
        ("snpao3", "第二元神残篇", 1),
        ("snpao3", "二级妖丹", 2),
    }
    assert output.resource_events[0].result == "extra_success"
    assert output.resource_events[0].meta["lucky_drop"] is True


def test_skips_blood_trial_dungeon_loot():
    event = make_event(
        """【战利品结算·血色试炼】
所有队员均获得 5000修为 和 500贡献！
血色秘径：每位队员获得 养魂木x1"""
    )
    assert ResourceStatsParser().parse(event) is None
