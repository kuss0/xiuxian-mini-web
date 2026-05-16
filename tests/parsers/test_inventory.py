from backend.parsers.inventory import InventoryParser
from tests.parsers import load_fixture, make_event


def test_inventory_message_produces_card():
    event = make_event(load_fixture("inventory_storage.txt"))
    output = InventoryParser().parse(event)
    assert output is not None
    card = output.cards[0]
    assert card.title == "储物袋快照"
    assert "resource" in card.channels


def test_skips_unrelated_message():
    event = make_event("无关消息")
    assert InventoryParser().parse(event) is None
