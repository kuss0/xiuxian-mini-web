"""测试 8 个 panel parser — 跟老脚本 features/*.py 对齐。"""

from backend.parsers.panels import (
    ConcubinePanelParser,
    GuanxingParser,
    PetParser,
    SmallWorldPanelParser,
    StargazerPanelParser,
    TaiyiParser,
    TiantiPanelParser,
    TreeParser,
)
from tests.parsers import make_event


def test_tianti_panel_extracts_progress_and_cooldown():
    text = ("【凌霄云阶】\n当前进度: 7 / 12 阶\n已完成周天: 7 轮\n罡风淬体: 12 / 12 层\n"
            "下次目标: 第 8 阶\n登阶冷却: 1小时32分钟26秒\n问心状态: 今日尚未问心。")
    out = TiantiPanelParser().parse(make_event(text))
    assert out is not None
    f = out.cards[0].fields
    assert f["阶进度"] == "7 / 12"
    assert f["周天"] == "7 轮"
    assert f["罡风淬体"] == "12 / 12 层"
    assert f["登阶冷却"] == "1小时32分钟26秒"
    assert f["问心"].startswith("今日")


def test_stargazer_extracts_slots():
    text = ("【星宫 · 观星台】 (引星盘总数: 3座)\n"
            "1号引星盘: 庚金星 - 凝聚中 ✨ (剩余: 5小时59分钟49秒)\n"
            "2号引星盘: 庚金星 - 凝聚中 ✨ (剩余: 4小时)\n"
            "3号引星盘: 空闲")
    out = StargazerPanelParser().parse(make_event(text))
    assert out is not None
    f = out.cards[0].fields
    assert f["引星盘总数"] == 3
    assert len(f["引星盘"]) == 3
    assert f["引星盘"][0]["idx"] == 1


def test_guanxing_panel_emits_prompt_card():
    text = ("【星盘显化】\n@adam 闭目凝神，推演天机...\n"
            "下一次天道演化将是: 【Bad - 丹炉炸裂】\n"
            "当前天命所归: @xiaoyanxz\n"
            "你有 5分钟 时间...回复...使用 .改换星移 @新目标")
    out = GuanxingParser().parse(make_event(text))
    assert out is not None
    card = out.cards[0]
    assert card.title == "星盘显化"
    assert card.fields["下次事件"] == "Bad - 丹炉炸裂"
    assert card.fields["天命所归"] == "@xiaoyanxz"


def test_guanxing_result_emits_summary_card():
    text = "【天机阁快报 - 天雷竹现世】\n天机演化结果: 其在焦黑的竹林中，幸运地发现了一小截完好无损的【天雷竹】！"
    out = GuanxingParser().parse(make_event(text))
    assert out is not None
    assert out.cards[0].title == "天机阁快报"
    assert "天雷竹" in out.cards[0].fields["演化结果"]


def test_small_world_extracts_full_fields():
    text = ("【吕洛的小世界】\n👥 人口: 100513 人\n🙏 信仰: 100 / 100\n"
            "☁️ 待收香火: 3189.33\n🏺 香火库存: 3\n🧠 神识强度: 107338\n"
            "暂无祈愿，凡间风调雨顺。\n(下一次祈愿感应需等待: 7小时53分钟50秒)")
    out = SmallWorldPanelParser().parse(make_event(text))
    assert out is not None
    f = out.cards[0].fields
    assert f["主人"] == "吕洛"
    assert f["信仰"] == "100 / 100"
    assert f["待收香火"] == "3189.33"
    assert f["香火库存"] == 3


def test_concubine_panel_extracts_kinds_and_cd():
    text = ("你的道心侍妾: 【紫灵】 (状态: 随行中)\n"
            "情缘值: 408\n当前誓约: 共修\n"
            "入梦寻图冷却: 322分钟\n共历心劫冷却: 可施展\n"
            "虚天残图拼片: 3/4")
    out = ConcubinePanelParser().parse(make_event(text))
    assert out is not None
    f = out.cards[0].fields
    assert f["侍妾"] == "紫灵"
    assert f["情缘值"] == 408
    assert f["共历心劫冷却"] == "可施展"
    assert f["拼片"] == "3 / 4"


def test_tree_panel_recognized():
    text = "【落云宗 · 灵眼之树】\n💧 环境: 干渴\n进度: 55%"
    out = TreeParser().parse(make_event(text))
    assert out is not None
    assert out.cards[0].title == "灵树面板"


def test_tree_harvest_extracts_fruit():
    text = "你摘下一枚【天雷果】！\n修为增长: +12,345"
    out = TreeParser().parse(make_event(text))
    assert out is not None
    assert out.cards[0].title == "灵树采摘"
    assert out.cards[0].fields["采摘果实"] == "天雷果"
    assert out.cards[0].fields["修为增长"] == "12345 点"


def test_pet_touch_extracts_deltas():
    text = "“雷隐”在你手中微微颤动，似乎很享受。\n(默契 +4, 经验 +15)"
    out = PetParser().parse(make_event(text))
    assert out is not None
    assert out.cards[0].title == "抚摸法宝"
    assert out.cards[0].fields["默契"] == 4
    assert out.cards[0].fields["经验"] == 15


def test_taiyi_yindao():
    out = TaiyiParser().parse(make_event("你引动【土之道】，获得了 100点神识"))
    assert out is not None
    assert out.cards[0].title == "引动大道"
    assert out.cards[0].fields["五行"] == "土"


def test_taiyi_node():
    out = TaiyiParser().parse(make_event("...获得：【空间节点·乙木幼苗】..."))
    assert out is not None
    assert out.cards[0].title == "空间节点"
    assert "乙木" in out.cards[0].fields["节点"]


def test_panels_skip_unrelated():
    for parser in [TiantiPanelParser(), StargazerPanelParser(), GuanxingParser(),
                   SmallWorldPanelParser(), ConcubinePanelParser(), TreeParser(),
                   PetParser(), TaiyiParser()]:
        assert parser.parse(make_event("普通玩家闲聊")) is None
