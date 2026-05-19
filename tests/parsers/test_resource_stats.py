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
    assert all(delta.source_name == "野外历练·未知" for delta in output.resource_deltas)
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


def test_wild_training_sums_multi_amount_rare_drop():
    event = make_event(
        """【野外历练 · 妖兽遭遇】
@TrickPlayer 遭遇 变异碧眼金蟾。
战力对比: 你 1378174928 / 妖兽 1848017514，胜算 31%。
一番斗法后，妖兽伏诛。
获得修为 +45000，获得 【阴凝之晶】x2。
此战只结算 NPC 历练收益，不触发玩家仇怨。"""
    )
    output = ResourceStatsParser().parse(event)
    assert output is not None
    assert {(delta.resource_name, delta.amount) for delta in output.resource_deltas} == {
        ("修为", 45000),
        ("阴凝之晶", 2),
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


def test_wild_training_strategy_panel_without_result_is_not_counted():
    event = make_event(
        """【野外历练】
@yuanyao01 选择【均衡】策略，正向荒野深处行去..."""
    )
    assert ResourceStatsParser().parse(event) is None


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
    assert all(delta.source_name == "虚天殿·夺鼎" for delta in output.resource_deltas)
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
    assert output.resource_events[0].source_name == "虚天殿·求稳"
    assert output.resource_events[0].meta["lucky_drop"] is True


def test_skips_blood_trial_dungeon_loot():
    event = make_event(
        """【战利品结算·血色试炼】
所有队员均获得 5000修为 和 500贡献！
血色秘径：每位队员获得 养魂木x1"""
    )
    assert ResourceStatsParser().parse(event) is None


def test_extracts_huanglong_result():
    event = make_event(
        """【黄龙山大战·夺宝即退】
你们在大阵残火与烟尘间果断撤退，把到手战果稳稳带回了山门后方。

每位队员获得 7200修为、759贡献。
幸运道友 @hfsscxf 额外获得 【黄龙阵旗残片】x2。
首通奖励：@hfsscxf、@ccahen 获得 【龙蛇回元散丹方】。"""
    )
    output = ResourceStatsParser().parse(event)
    assert output is not None
    assert output.resource_events[0].source_name == "黄龙山"
    assert output.resource_events[0].result == "success"
    assert ("", "修为", 7200) in {
        (delta.player, delta.resource_name, delta.amount) for delta in output.resource_deltas
    }
    assert ("hfsscxf", "黄龙阵旗残片", 2) in {
        (delta.player, delta.resource_name, delta.amount) for delta in output.resource_deltas
    }
    assert ("hfsscxf", "龙蛇回元散丹方", 1) in {
        (delta.player, delta.resource_name, delta.amount) for delta in output.resource_deltas
    }


def test_infers_virtual_dungeon_from_settlement_without_route_name():
    event = make_event(
        """【战利品结算·求稳】
所有队员均获得 5000修为 和 500贡献！
天命所归，幸运道友 @snpao3 额外获得了 【第二元神残篇】！"""
    )
    output = ResourceStatsParser().parse(event)
    assert output is not None
    assert output.resource_events[0].source_name == "虚天殿·求稳"


def test_extracts_kunwu_result_with_route_rare_items():
    event = make_event(
        """【登顶昆吾山】
恭喜你们历经 9 回合，成功登顶！

最终收获:
- 每位队员获得 5000 点修为
- 队长 @cupaopao 获得登顶至宝 【大挪移令】x1

本次历程:
第1层: 你们在一处断崖下发现了一片凝血草丛，小心翼翼地采集后匆匆上路。
第2层: 在一处被水汽笼罩的瀑布下，你们幸运地找到了一株年份不低的清灵草。
第3层: 你们发现了一具早已风化的妖兽骸骨，从其骨缝中竟搜出几枚一阶妖丹。"""
    )
    output = ResourceStatsParser().parse(event)
    assert output is not None
    assert output.resource_events[0].source_name == "昆吾山"
    assert output.resource_events[0].result == "success"
    assert {(delta.resource_name, delta.amount) for delta in output.resource_deltas} >= {
        ("修为", 5000),
        ("大挪移令", 1),
        ("凝血草", 1),
        ("清灵草", 1),
        ("一阶妖丹", 3),
    }


def test_extracts_zhui_mo_failure_result():
    event = make_event(
        """【坠魔谷·封魔失败】
虽击碎古魔残识，却未完成封印，魔潮二次爆发。

虽未能封魔，众人仍从死斗中有所感悟：每人获得 2000修为、120贡献。
最终魔染值：53 | 封印进度：84"""
    )
    output = ResourceStatsParser().parse(event)
    assert output is not None
    assert output.resource_events[0].source_name == "坠魔谷"
    assert output.resource_events[0].result == "failed"
    assert {(delta.resource_name, delta.amount) for delta in output.resource_deltas} == {
        ("修为", 2000),
        ("贡献", 120),
    }


def test_extracts_wind_xi_result_as_separate_resource_source():
    event = make_event(
        """【逆天之举】
面对风希分神，@mc 竟不退反进，祭出所有神通法宝奋力一搏！竟成功将其击溃！
风希的意志传下话来：“该死的人类，竟有如此实力，这风雷翅便暂归你所有罢！”

【战利品】
- 你因此番感悟，修为暴涨 28860 点！
- 获得上界奇珍 【天凤之翎】x1！
- 获得限时增益 【风之祝福】(12小时)！
- 更令人惊喜的是，你在其消散的神魂中，捕获了一件至宝：【风雷翅图纸】x1！"""
    )
    output = ResourceStatsParser().parse(event)
    assert output is not None
    assert output.resource_events[0].source_type == "wind_xi"
    assert output.resource_events[0].source_name == "风希"
    assert output.resource_events[0].result == "success"
    assert output.resource_events[0].player == "mc"
    assert {(delta.resource_name, delta.amount) for delta in output.resource_deltas} == {
        ("修为", 28860),
        ("天凤之翎", 1),
        ("风之祝福", 1),
        ("风雷翅图纸", 1),
    }
    assert all(delta.source_type == "wind_xi" for delta in output.resource_deltas)
    assert all(delta.source_name == "风希" for delta in output.resource_deltas)


def test_extracts_deep_retreat_summary_resources():
    event = make_event(
        """📜 修士 @qiyiang_tg 深度闭关总结
【深度闭关总结】
- 天降奇遇: 12 次
  - 一阵地动山摇后，你的洞府一角竟裂开缝隙，露出了一截深埋地底的【百年铁木】！
  - 你在洞府周围布置警戒阵法时，意外发现五株年份不低的【凝血草】，小心采摘后收入囊中。
  - 你闭关时神魂出窍，误入一处古战场，心神回归之际，竟带回了几缕【阴魂丝】！
  - 你于洞府中潜心打坐，无意间竟在蒲团下摸到一处暗格，其中藏有前人遗留的【灵石】x25！

本次深度闭关，你的修为最终变化了 34087 点！
*(因 【始皇的新衣】奇遇+50%, 奇遇几率提升至 55%)*"""
    )
    output = ResourceStatsParser().parse(event)
    assert output is not None
    assert output.resource_events[0].source_type == "deep_retreat"
    assert output.resource_events[0].result == "settled"
    assert {(delta.resource_name, delta.amount) for delta in output.resource_deltas} == {
        ("修为", 34087),
        ("百年铁木", 1),
        ("凝血草", 5),
        ("阴魂丝", 1),
        ("灵石", 25),
    }


def test_extracts_shallow_retreat_tree_and_pet_resources():
    retreat = ResourceStatsParser().parse(
        make_event(
            """【闭关成功】
本次闭关，你的修为最终增加了 972 点。
【奇遇】一道流光砸在你的洞府门前，竟是一块天外陨石，你从中提炼出了【金精矿】x1！
你感到一阵疲惫，需要打坐调息 11 分钟方可再次闭关。"""
        )
    )
    assert retreat is not None
    assert {(delta.resource_name, delta.amount) for delta in retreat.resource_deltas} == {
        ("修为", 972),
        ("金精矿", 1),
    }

    tree = ResourceStatsParser().parse(
        make_event(
            """【灵果入腹 · 造化自生】
你摘下一枚【万年灵木果 (极品)】。
💪 修为增长: +28000
✨ 灵纹回馈: 本轮额外转化了 +3000 点修为
🌰 树髓余珍: 获得【灵眼木髓碎片】x3"""
        )
    )
    assert tree is not None
    assert {(delta.resource_name, delta.amount) for delta in tree.resource_deltas} == {
        ("修为", 28000),
        ("修为", 3000),
        ("灵眼木髓碎片", 3),
    }

    touch = ResourceStatsParser().parse(make_event("“鼎儿”在你手中微微颤动，似乎很享受。\n(默契 +3, 经验 +17)"))
    assert touch is not None
    assert {(delta.resource_name, delta.amount) for delta in touch.resource_deltas} == {
        ("默契", 3),
        ("经验", 17),
    }

    warm = ResourceStatsParser().parse(
        make_event(
            """【温养器灵】
你以灵石淬洗法宝灵窍，又焚化养魂木为引，细细温养 【青竹蜂云剑（庚金版）】。
- 消耗：灵石x3000、养魂木x3
- 默契提升：+0
- 经验提升：+50"""
        )
    )
    assert warm is not None
    assert {(delta.resource_name, delta.amount) for delta in warm.resource_deltas} == {
        ("灵石", -3000),
        ("养魂木", -3),
        ("经验", 50),
    }
