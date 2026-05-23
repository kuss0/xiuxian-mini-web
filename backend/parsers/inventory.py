"""储物袋 parser。

职责保持轻:parser 负责从真实 bot 文案里抽出快照字段和卡片;库存持久化
由 SQLiteStore 在 ingest 阶段调用 parse_inventory_snapshot() 完成。
"""

from __future__ import annotations

import re

from backend.domain.models import ParsedCard, RawMessageEvent
from backend.domain.registry import ParserOutput


OWNER_RE = re.compile(r"^\s*@?(?P<owner>[A-Za-z0-9_]+)\s*的储物袋", re.MULTILINE)
ALT_OWNER_RE = re.compile(r"【(?P<owner>[^】]+)的储物袋】")
SECTION_RE = re.compile(r"^\s*(?P<section>[^:\n：]{1,24})\s*[:：]\s*$")
ITEM_RE = re.compile(
    r"^\s*[-•]?\s*(?P<name>.+?)\s*[xX×*]\s*(?P<amount>\d+)"
    r"(?:\s*(?P<extra>[(（][^)）]+[)）]))?\s*$"
)
TREE_HARVEST_REWARD_RE = re.compile(r"【([^】]+)】\s*(?:[xX×]\s*([\d,]+))?")
LISTING_SUCCESS_RE = re.compile(r"你已将\s*【(?P<item>.+?)】\s*[xX×](?P<count>[\d,]+)\s*上架至万宝楼")
GIFT_SUCCESS_RE = re.compile(r"赠送了\s*【(?P<item>.+?)】\s*[xX×](?P<count>[\d,]+)")
GIFT_TAX_RE = re.compile(r"额外支付了\s*(?P<count>[\d,]+)\s*灵石")
TREE_REWARD_KEYWORDS = ("获得【", "分得【", "稳定分得【")


class InventoryParser:
    name = "inventory"

    def parse(self, event: RawMessageEvent) -> ParserOutput | None:
        text = event.text
        snapshot = parse_inventory_snapshot(event)
        if snapshot is None:
            return None
        owner = snapshot.get("owner") or ""
        item_count = len(snapshot.get("items") or [])
        total_amount = sum(int(item.get("amount") or 0) for item in snapshot.get("items") or [])
        return ParserOutput(
            cards=(
                ParsedCard(
                    id=event.id,
                    channels=("system", "resource", "console"),
                    title="储物袋快照",
                    summary=f"@{owner} 的储物袋: {item_count} 类物品 / {total_amount} 件" if owner else "已识别储物袋快照",
                    source=event.source,
                    time=event.date,
                    tags=("资源", "储物袋"),
                    raw=event.text,
                    fields={
                        "owner": owner,
                        "item_count": item_count,
                        "total_amount": total_amount,
                    },
                ),
            )
        )


def parse_inventory_snapshot(event: RawMessageEvent) -> dict | None:
    """Parse a 储物袋 panel into a normalized snapshot.

    Accepted examples:
    - ``@ANekokro 的储物袋``
    - ``【example的储物袋】``

    Repeated item names in the same snapshot are aggregated per section+name.
    Extra suffixes such as ``(耐久 100/100)`` are preserved as ``extra`` but do
    not affect the item key.
    """
    text = event.text or ""
    if "储物袋" not in text:
        return None
    owner = _extract_owner(text)
    if not owner:
        return None
    items_by_key: dict[tuple[str, str, str], dict] = {}
    section = "未分组"
    for raw_line in text.splitlines():
        line = raw_line.strip()
        if not line:
            continue
        if section_match := SECTION_RE.match(line):
            section = section_match.group("section").strip()
            continue
        item_match = ITEM_RE.match(line)
        if not item_match:
            continue
        name = _clean_item_name(item_match.group("name"))
        if not name:
            continue
        amount = int(item_match.group("amount") or 0)
        if amount <= 0:
            continue
        extra = (item_match.group("extra") or "").strip()
        key = (section, name, extra)
        item = items_by_key.setdefault(
            key,
            {
                "section": section,
                "name": name,
                "amount": 0,
                "extra": extra,
            },
        )
        item["amount"] += amount
    items = list(items_by_key.values())
    if not items:
        return None
    return {
        "raw_message_id": event.id,
        "chat_id": int(event.chat_id or 0),
        "msg_id": int(event.msg_id or 0),
        "owner": owner,
        "source": event.source or "",
        "event_time": event.date or "",
        "items": items,
    }


def parse_inventory_delta_event(event: RawMessageEvent) -> dict | None:
    """Parse confirmed item changes from bot replies.

    This is deliberately conservative: only success/result text that already
    names the item and quantity becomes a delta. The caller decides which owner
    the delta belongs to, usually from the replied-to command sender.
    """
    text = event.text or ""
    deltas: dict[str, int] = {}
    source_type = ""
    confidence = "estimated"

    if match := LISTING_SUCCESS_RE.search(text):
        item = _clean_item_name(match.group("item"))
        amount = _parse_amount(match.group("count"))
        if item and amount > 0:
            deltas[item] = deltas.get(item, 0) - amount
            source_type = "listing_success"
    elif match := GIFT_SUCCESS_RE.search(text):
        item = _clean_item_name(match.group("item"))
        amount = _parse_amount(match.group("count"))
        if item and amount > 0:
            deltas[item] = deltas.get(item, 0) - amount
            source_type = "gift_success"
        if tax_match := GIFT_TAX_RE.search(text):
            tax = _parse_amount(tax_match.group("count"))
            if tax > 0:
                deltas["灵石"] = deltas.get("灵石", 0) - tax
    elif any(keyword in text for keyword in TREE_REWARD_KEYWORDS):
        for raw_line in text.splitlines():
            line = raw_line.strip()
            if not any(keyword in line for keyword in TREE_REWARD_KEYWORDS):
                continue
            for raw_item, raw_count in TREE_HARVEST_REWARD_RE.findall(line):
                item = _clean_item_name(raw_item)
                amount = _parse_amount(raw_count or "1")
                if item and amount > 0:
                    deltas[item] = deltas.get(item, 0) + amount
                    source_type = "tree_harvest"

    if not deltas or not source_type:
        return None
    return {
        "raw_message_id": event.id,
        "source_type": source_type,
        "confidence": confidence,
        "event_time": event.date or "",
        "chat_id": int(event.chat_id or 0),
        "msg_id": int(event.msg_id or 0),
        "deltas": deltas,
    }


def _extract_owner(text: str) -> str:
    if match := OWNER_RE.search(text):
        return match.group("owner").strip().lstrip("@")
    if match := ALT_OWNER_RE.search(text):
        return match.group("owner").strip().lstrip("@")
    return ""


def _clean_item_name(value: str) -> str:
    text = str(value or "").strip()
    text = re.sub(r"\s+", " ", text)
    return text.strip("-• \t")


def _parse_amount(value: object) -> int:
    try:
        return int(str(value or "0").replace(",", "").strip() or "0")
    except (TypeError, ValueError):
        return 0


__all__ = ["InventoryParser", "parse_inventory_delta_event", "parse_inventory_snapshot"]
