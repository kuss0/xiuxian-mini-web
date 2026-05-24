from backend.parsers.inventory import InventoryParser, parse_inventory_delta_event, parse_inventory_snapshot
from tests.parsers import load_fixture, make_event


def test_inventory_message_produces_card():
    event = make_event(load_fixture("inventory_storage.txt"))
    output = InventoryParser().parse(event)
    assert output is not None
    card = output.cards[0]
    assert card.title == "储物袋快照"
    assert "resource" in card.channels
    assert card.fields["owner"] == "example"
    assert card.fields["item_count"] == 3


def test_inventory_snapshot_parses_and_merges_items():
    event = make_event(
        """@ANekokro 的储物袋

法宝/丹药/杂物:
- 清灵丹 x 1
- 清灵丹 x 6
- 乌龙幡 x 1 (耐久 100/100)

材料:
- 灵石 x 1485
- 阴凝之晶 x 2"""
    )
    snapshot = parse_inventory_snapshot(event)
    assert snapshot is not None
    assert snapshot["owner"] == "ANekokro"
    items = {
        (item["section"], item["name"], item["extra"]): item["amount"]
        for item in snapshot["items"]
    }
    assert items[("法宝/丹药/杂物", "清灵丹", "")] == 7
    assert items[("法宝/丹药/杂物", "乌龙幡", "(耐久 100/100)")] == 1
    assert items[("材料", "阴凝之晶", "")] == 2


def test_inventory_delta_parses_wanbaolou_delisting_return():
    event = make_event("你已成功将 【二级妖丹】x10 从万宝楼下架，物品已归还至你的储物袋。")
    delta = parse_inventory_delta_event(event)

    assert delta is not None
    assert delta["source_type"] == "delisting_success"
    assert delta["deltas"] == {"二级妖丹": 10}


def test_skips_unrelated_message():
    event = make_event("无关消息")
    assert InventoryParser().parse(event) is None
