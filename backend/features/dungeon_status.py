from __future__ import annotations

import re
from datetime import datetime

from backend.domain.models import ParsedCard


WEAK_DUNGEON_NAMES = {"", "副本", "加入副本成功", "加入副本失败", "副本房间解散"}


def aggregate_dungeon_status_rows(rows: list[tuple[int, ParsedCard]], *, context_finder=None, order: str = "priority") -> list[dict]:
    grouped: dict[str, dict] = {}
    context_by_name: dict[tuple[int, str], dict] = {}
    context_by_id: dict[str, dict] = {}
    orphan_by_name: dict[tuple[int, str], dict] = {}
    for seq, card in sorted(rows, key=_dungeon_row_sort_key):
        key, association = _dungeon_group_key(
            card,
            seq=seq,
            context_by_id=context_by_id,
            context_by_name=context_by_name,
            orphan_by_name=orphan_by_name,
            context_finder=context_finder,
        )
        summary = grouped.get(key)
        if summary is None:
            summary = _new_dungeon_summary(key, seq, card)
            grouped[key] = summary
        if association.get("source") and not summary.get("context_source"):
            summary["context_source"] = association["source"]
        if association.get("open_seq") and not summary.get("open_seq"):
            summary["open_seq"] = association["open_seq"]
        if association.get("open_message_id") and not summary.get("open_message_id"):
            summary["open_message_id"] = association["open_message_id"]
        _update_dungeon_summary(summary, seq, card)
        _remember_dungeon_context(context_by_name, context_by_id, key, seq, card)
    result = list(grouped.values())
    if order == "recent":
        result.sort(key=lambda item: -float(item.get("_latest_order") or item.get("latest_seq") or 0))
    else:
        result.sort(key=lambda item: (_dungeon_status_rank(item.get("status_kind")), -float(item.get("_latest_order") or item.get("latest_seq") or 0)))
    for item in result:
        item.pop("_status_seq", None)
        item.pop("_status_order", None)
        item.pop("_latest_order", None)
        for action in item.get("actions") or ():
            action.pop("source_order", None)
    return result


def select_visible_dungeon_summaries(summaries: list[dict], limit: int) -> list[dict]:
    try:
        limit = max(1, int(limit))
    except (TypeError, ValueError):
        limit = 80
    primary = [item for item in summaries if _is_primary_dungeon_summary(item)]
    if primary:
        return primary[:limit]
    return summaries[:limit]


def _new_dungeon_summary(key: str, seq: int, card: ParsedCard) -> dict:
    fields = card.fields or {}
    name = _dungeon_name(card)
    dungeon_id = str(fields.get("副本ID") or "")
    if key.startswith("id:"):
        dungeon_id = _dungeon_id_from_key(key)
    return {
        "key": key,
        "dungeon_id": dungeon_id,
        "dungeon_name": name or "副本",
        "status": "副本消息",
        "status_kind": "info",
        "latest_seq": int(seq),
        "latest_message_id": card.id,
        "latest_time": card.time,
        "latest_stage": "",
        "opened_by": "",
        "capacity": "",
        "oracle": "",
        "advice": "",
        "route_verdict": "",
        "advice_basis": "",
        "advice_confidence": "",
        "team_fit": "",
        "positive_examples": [],
        "negative_examples": [],
        "route": "",
        "strategy": "",
        "silence_order": "",
        "context_source": "",
        "open_seq": 0,
        "open_message_id": "",
        "message_count": 0,
        "join_success": [],
        "failures": [],
        "actions": [],
        "messages": [],
    }


def _update_dungeon_summary(summary: dict, seq: int, card: ParsedCard) -> None:
    fields = card.fields or {}
    tags = list(card.tags or ())
    title = str(card.title or "")
    raw = str(card.raw or "")
    order = _dungeon_order_value(seq, card)
    if order >= float(summary.get("_latest_order") or -1):
        summary["_latest_order"] = order
        summary["latest_seq"] = int(seq)
        summary["latest_message_id"] = card.id
        summary["latest_time"] = card.time
    candidate_name = _dungeon_name(card)
    if candidate_name and (not summary.get("dungeon_name") or summary.get("dungeon_name") == "副本"):
        summary["dungeon_name"] = candidate_name
    for target, source in (
        ("dungeon_id", "副本ID"),
        ("latest_stage", "阶段"),
        ("opened_by", "开门人"),
        ("capacity", "人数上限"),
        ("oracle", "卦象"),
        ("advice", "行运建议"),
        ("route_verdict", "路策判定"),
        ("advice_basis", "建议依据"),
        ("advice_confidence", "建议置信"),
        ("team_fit", "队伍契合"),
        ("route", "路线"),
        ("strategy", "阵策"),
        ("silence_order", "静场令"),
    ):
        if not summary.get(target) and fields.get(source):
            summary[target] = str(fields.get(source) or "")

    for target, source in (
        ("positive_examples", "历史顺例"),
        ("negative_examples", "历史反例"),
    ):
        if summary.get(target) or not fields.get(source):
            continue
        value = fields.get(source)
        if isinstance(value, (list, tuple)):
            summary[target] = [str(item) for item in value if str(item).strip()]
        else:
            text = str(value or "").strip()
            summary[target] = [text] if text else []

    if title == "加入副本成功" or ("加入" in tags and "失败" not in tags):
        username = str(fields.get("username") or _first_username(raw) or "").strip().lstrip("@")
        if username and username not in summary["join_success"]:
            summary["join_success"].append(username)
    if title == "加入副本失败" or "失败" in tags:
        reason = str(fields.get("失败原因") or card.summary or "加入失败").strip()
        if reason and reason not in summary["failures"]:
            summary["failures"].append(reason)

    for action in card.actions or ():
        payload = action.to_api()
        command = str(payload.get("command") or "").strip()
        if not command:
            continue
        action_key = f"{command}|{payload.get('reply_to_msg_id') or ''}|{payload.get('chat_id') or ''}"
        if not any(item.get("key") == action_key for item in summary["actions"]):
            summary["actions"].append({**payload, "key": action_key, "source_message_id": card.id, "source_seq": int(seq), "source_order": order})
    summary["actions"] = sorted(
        summary["actions"],
        key=lambda item: float(item.get("source_order") or item.get("source_seq") or 0),
        reverse=True,
    )[:6]

    info = _dungeon_status_from_card(card)
    current_kind = str(summary.get("status_kind") or "info")
    if current_kind == "closed" and info["kind"] != "closed":
        pass
    elif info["kind"] == "closed":
        summary["status"] = info["label"]
        summary["status_kind"] = info["kind"]
        summary["_status_seq"] = int(seq)
        summary["_status_order"] = order
    elif info["kind"] != "info" and order >= float(summary.get("_status_order") or -1):
        summary["status"] = info["label"]
        summary["status_kind"] = info["kind"]
        summary["_status_seq"] = int(seq)
        summary["_status_order"] = order
    elif summary.get("status_kind") == "info" and info["label"]:
        summary["status"] = info["label"]

    summary["messages"].append(
        {
            "seq": int(seq),
            "id": card.id,
            "title": title,
            "summary": card.summary,
            "time": card.time,
            "chat_id": card.chat_id,
            "msg_id": card.msg_id,
            "reply_to_msg_id": card.reply_to_msg_id,
        }
    )
    summary["message_count"] = int(summary.get("message_count") or 0) + 1
    summary["messages"] = sorted(summary["messages"], key=_dungeon_message_order, reverse=True)[:6]


def _dungeon_group_key(
    card: ParsedCard,
    *,
    seq: int,
    context_by_id: dict[str, dict],
    context_by_name: dict[tuple[int, str], dict],
    orphan_by_name: dict[tuple[int, str], dict],
    context_finder=None,
) -> tuple[str, dict]:
    fields = card.fields or {}
    dungeon_id = str(fields.get("副本ID") or "").strip()
    if dungeon_id:
        if _is_dungeon_open_card(card):
            existing = context_by_id.get(dungeon_id)
            if existing and existing.get("open_seq"):
                key = f"id:{dungeon_id}:open:{seq}"
            else:
                key = f"id:{dungeon_id}"
            context_by_id[dungeon_id] = {
                "key": key,
                "source": "open_in_window",
                "open_seq": int(seq),
                "open_message_id": card.id,
            }
            return key, {"source": "explicit_id", "open_seq": int(seq), "open_message_id": card.id}
        context = context_by_id.get(dungeon_id)
        if context and context.get("key"):
            return str(context["key"]), {
                "source": context.get("source") or "explicit_id",
                "open_seq": context.get("open_seq") or 0,
                "open_message_id": context.get("open_message_id") or "",
            }
        return f"id:{dungeon_id}", {"source": "explicit_id"}
    if card.title == "加入副本失败" and card.reply_to_msg_id:
        return f"join-failed:{card.chat_id or 0}:{card.reply_to_msg_id}", {"source": "reply_to"}
    name = _dungeon_name(card) or "副本"
    name_key = (int(card.chat_id or 0), name)
    context = context_by_name.get(name_key)
    if not context and callable(context_finder):
        context = context_finder(card, seq, name) or {}
        if context.get("dungeon_id"):
            context_by_name[name_key] = {
                "key": f"id:{context['dungeon_id']}",
                "source": "open_lookup",
                "open_seq": int(context.get("seq") or 0),
                "open_message_id": context.get("message_id") or "",
                "ts": _card_timestamp(card),
            }
            context = context_by_name[name_key]
        else:
            context_by_name[name_key] = {"missing": True}
    if context and context.get("key"):
        return str(context["key"]), {
            "source": context.get("source") or "open_context",
            "open_seq": context.get("open_seq") or 0,
            "open_message_id": context.get("open_message_id") or "",
        }
    return _dungeon_orphan_group_key(card, seq, name, orphan_by_name), {"source": "time_segment"}


def _remember_dungeon_context(
    context_by_name: dict[tuple[int, str], dict],
    context_by_id: dict[str, dict],
    key: str,
    seq: int,
    card: ParsedCard,
) -> None:
    fields = card.fields or {}
    name = _dungeon_name(card) or ""
    dungeon_id = str(fields.get("副本ID") or "").strip()
    if not name or not dungeon_id:
        return
    name_key = (int(card.chat_id or 0), name)
    status_info = _dungeon_status_from_card(card)
    current = None if name in WEAK_DUNGEON_NAMES else context_by_name.get(name_key)
    if status_info["kind"] == "closed":
        if current and current.get("key") == key:
            context_by_name.pop(name_key, None)
        if context_by_id.get(dungeon_id, {}).get("key") == key:
            context_by_id.pop(dungeon_id, None)
        return
    if _is_dungeon_open_card(card) or status_info["kind"] in {"open", "joined", "active", "choice"}:
        open_seq = int(seq) if _is_dungeon_open_card(card) else int((current or context_by_id.get(dungeon_id) or {}).get("open_seq") or 0)
        open_message_id = card.id if _is_dungeon_open_card(card) else str((current or context_by_id.get(dungeon_id) or {}).get("open_message_id") or "")
        context_by_id[dungeon_id] = {
            "key": key,
            "source": "open_in_window" if _is_dungeon_open_card(card) else "id_in_window",
            "open_seq": open_seq,
            "open_message_id": open_message_id,
        }
        if name not in WEAK_DUNGEON_NAMES:
            context_by_name[name_key] = {
                "key": key,
                "source": "open_in_window" if _is_dungeon_open_card(card) else "id_in_window",
                "open_seq": open_seq,
                "open_message_id": open_message_id,
                "ts": _card_timestamp(card),
            }


def _dungeon_orphan_group_key(
    card: ParsedCard,
    seq: int,
    name: str,
    orphan_by_name: dict[tuple[int, str], dict],
) -> str:
    name_key = (int(card.chat_id or 0), name)
    ts = _card_timestamp(card)
    existing = orphan_by_name.get(name_key)
    if existing and ts and existing.get("ts") and abs(ts - float(existing["ts"])) <= 7200:
        existing["ts"] = ts
        return str(existing["key"])
    key = f"segment:{name}:{card.chat_id or 0}:{seq}"
    orphan_by_name[name_key] = {"key": key, "ts": ts}
    return key


def _dungeon_name(card: ParsedCard) -> str:
    fields = card.fields or {}
    if fields.get("副本名"):
        return str(fields.get("副本名") or "").strip()
    if card.title in {"加入副本成功", "加入副本失败", "副本房间解散"}:
        return "副本"
    text = f"{card.title or ''}\n{card.raw or ''}"
    for name in ("虚天殿", "黄龙山", "昆吾山", "坠魔谷", "血色试炼"):
        if name in text:
            return name
    title = str(card.title or "").strip()
    return title[:-2] if title.endswith("开启") else title


def _dungeon_status_from_card(card: ParsedCard) -> dict:
    fields = card.fields or {}
    tags = set(card.tags or ())
    title = str(card.title or "")
    status = str(fields.get("状态") or "").strip()
    if title == "副本房间解散" or "解散" in tags:
        return {"kind": "closed", "label": "已解散"}
    if title == "加入副本失败" or "失败" in tags:
        return {"kind": "failed", "label": "加入失败"}
    if "静场" in status or "静场令" in tags:
        return {"kind": "choice", "label": status or "静场令"}
    if "需要抉择" in status or "需要抉择" in tags:
        return {"kind": "choice", "label": status or "需要抉择"}
    if "可加入" in status or "可加入" in tags or title.endswith("开启"):
        return {"kind": "open", "label": status or "可加入"}
    if "已加入" in status or title == "加入副本成功":
        return {"kind": "joined", "label": status or "已加入"}
    if re.search(r"进行中|路线已选|卦象|路策", status) or re.search(r"推进|卦象|路线|路策", title):
        return {"kind": "active", "label": status or "进行中"}
    return {"kind": "info", "label": status or title or "副本消息"}


def _dungeon_status_rank(kind: object) -> int:
    return {
        "choice": 0,
        "open": 1,
        "active": 2,
        "joined": 3,
        "failed": 4,
        "closed": 5,
        "info": 6,
    }.get(str(kind or "info"), 6)


def _dungeon_row_sort_key(item: tuple[int, ParsedCard]) -> tuple[float, int]:
    seq, card = item
    return (_dungeon_order_value(seq, card), int(seq))


def _dungeon_order_value(seq: int, card: ParsedCard) -> float:
    ts = _card_timestamp(card)
    base = ts if ts > 0 else float(seq)
    tie = int(card.msg_id or seq or 0) % 1_000_000
    return base + (tie / 1_000_000_000)


def _dungeon_message_order(message: dict) -> float:
    text = str(message.get("time") or "").strip()
    if text:
        try:
            return datetime.fromisoformat(text.replace("Z", "+00:00")).timestamp()
        except ValueError:
            pass
    return float(message.get("seq") or message.get("msg_id") or 0)


def _dungeon_id_from_key(key: str) -> str:
    if not key.startswith("id:"):
        return ""
    return key.split(":", 2)[1] if ":" in key[3:] else key[3:]


def _is_dungeon_open_card(card: ParsedCard) -> bool:
    fields = card.fields or {}
    return str(card.title or "").endswith("开启") or str(fields.get("状态") or "").strip() == "可加入"


def _card_timestamp(card: ParsedCard) -> float:
    text = str(card.time or "").strip()
    if text:
        try:
            return datetime.fromisoformat(text.replace("Z", "+00:00")).timestamp()
        except ValueError:
            pass
    return float(card.msg_id or 0)


def _first_username(text: str) -> str:
    match = re.search(r"@(?P<user>[A-Za-z0-9_]+)", text or "")
    return match.group("user") if match else ""


def _is_primary_dungeon_summary(summary: dict) -> bool:
    key = str(summary.get("key") or "")
    if key.startswith("join-failed:"):
        return False
    name = str(summary.get("dungeon_name") or "").strip()
    if int(summary.get("open_seq") or 0) > 0 or str(summary.get("open_message_id") or "").strip():
        return True
    if name in WEAK_DUNGEON_NAMES:
        return False
    kind = str(summary.get("status_kind") or "info")
    return kind in {"choice", "open", "active"}
