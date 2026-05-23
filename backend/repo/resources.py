from __future__ import annotations

import json
from datetime import datetime, timedelta, timezone

from backend.domain.models import ResourceDelta, ResourceEvent
from backend.repo.common import _parse_message_dt


def _resource_period_keys(value: object) -> tuple[str, str, str]:
    parsed = _parse_message_dt(value) or datetime.now(timezone.utc)
    local = parsed.astimezone(timezone(timedelta(hours=8)))
    iso_year, iso_week, _ = local.isocalendar()
    return (
        local.date().isoformat(),
        f"{iso_year:04d}-W{iso_week:02d}",
        f"{local.year:04d}-{local.month:02d}",
    )


def _resource_delta_row_to_api(row) -> dict:
    meta = {}
    try:
        meta = json.loads(row[14] or "{}")
    except (TypeError, ValueError, json.JSONDecodeError):
        meta = {}
    return ResourceDelta(
        raw_message_id=row[0],
        source_type=row[1],
        source_name=row[2],
        player=row[3],
        resource_name=row[4],
        amount=int(row[5] or 0),
        unit=row[6] or "",
        basis=row[7] or "event",
        event_time=row[8] or "",
        chat_id=int(row[12] or 0),
        msg_id=int(row[13] or 0),
        meta=meta,
    ).to_api() | {
        "day": row[9],
        "week": row[10],
        "month": row[11],
    }


def _resource_event_row_to_api(row) -> dict:
    meta = {}
    try:
        meta = json.loads(row[12] or "{}")
    except (TypeError, ValueError, json.JSONDecodeError):
        meta = {}
    return ResourceEvent(
        raw_message_id=row[0],
        source_type=row[1],
        source_name=row[2],
        player=row[3],
        result=row[4],
        outcome=row[5],
        event_time=row[6] or "",
        chat_id=int(row[10] or 0),
        msg_id=int(row[11] or 0),
        meta=meta,
    ).to_api() | {
        "day": row[7],
        "week": row[8],
        "month": row[9],
    }


def _inventory_snapshot_row_to_api(row) -> dict:
    return {
        "id": int(row[0]),
        "owner": row[1] or "",
        "raw_message_id": row[2] or "",
        "source": row[3] or "",
        "event_time": row[4] or "",
        "chat_id": int(row[5] or 0),
        "msg_id": int(row[6] or 0),
        "item_count": int(row[7] or 0),
        "total_amount": int(row[8] or 0),
        "created_at": row[9] or "",
        "items": [],
    }


def _inventory_item_row_to_api(row) -> dict:
    return {
        "snapshot_id": int(row[0] or 0),
        "owner": row[1] or "",
        "section": row[2] or "",
        "name": row[3] or "",
        "amount": int(row[4] or 0),
        "extra": row[5] or "",
        "event_time": row[6] or "",
        "raw_message_id": row[7] or "",
    }


def _resource_event_summary(events: list[dict]) -> list[dict]:
    grouped: dict[tuple[str, str, str], dict] = {}
    for row in events:
        key = (
            str(row.get("period") or ""),
            str(row.get("source_type") or ""),
            str(row.get("source_name") or ""),
        )
        item = grouped.setdefault(
            key,
            {
                "period": key[0],
                "source_type": key[1],
                "source_name": key[2],
                "success": 0,
                "failed": 0,
                "cooldown": 0,
                "settled": 0,
                "basic_only": 0,
                "extra_success": 0,
                "total": 0,
                "unknown_result": 0,
                "empty_outcome": 0,
                "success_rate": None,
            },
        )
        result = str(row.get("result") or "")
        outcome = str(row.get("outcome") or "")
        count = int(row.get("event_count") or 0)
        item["total"] += count
        if not outcome:
            item["empty_outcome"] += count
        if result in item:
            item[result] += count
        elif not result:
            item["unknown_result"] += count
        else:
            item.setdefault("other", 0)
            item["other"] += count
    for item in grouped.values():
        attempts = int(item.get("success") or 0) + int(item.get("failed") or 0)
        if attempts:
            item["success_rate"] = round(int(item.get("success") or 0) * 100 / attempts, 1)
    return sorted(
        grouped.values(),
        key=lambda item: (
            str(item.get("period") or ""),
            str(item.get("source_type") or ""),
            str(item.get("source_name") or ""),
        ),
        reverse=True,
    )


def _resource_event_diagnostics(events: list[dict]) -> dict:
    unknown_sources: dict[str, int] = {}
    empty_outcomes: dict[str, int] = {}
    for row in events:
        count = int(row.get("event_count") or 0)
        if count <= 0:
            continue
        source_name = str(row.get("source_name") or "")
        source_type = str(row.get("source_type") or "")
        label = f"{source_type}|{source_name}"
        if source_name.endswith("未知"):
            unknown_sources[label] = unknown_sources.get(label, 0) + count
        if not str(row.get("outcome") or ""):
            empty_outcomes[label] = empty_outcomes.get(label, 0) + count
    return {
        "unknown_source_events": sum(unknown_sources.values()),
        "empty_outcome_events": sum(empty_outcomes.values()),
        "unknown_sources": [
            {"source": key, "count": value}
            for key, value in sorted(unknown_sources.items(), key=lambda item: (-item[1], item[0]))
        ],
        "empty_outcomes": [
            {"source": key, "count": value}
            for key, value in sorted(empty_outcomes.items(), key=lambda item: (-item[1], item[0]))
        ],
    }


def _resource_coverage_kind(text: str) -> str:
    text = str(text or "")
    if "奖励一览" in text:
        return ""
    if "【野外历练" in text:
        if "正向荒野深处行去" in text or "选择【" in text:
            return ""
        if not any(marker in text for marker in ("获得", "修为折损", "负伤", "NPC 历练失败", "山中灵机未复", "后再来")):
            return ""
        return "野外历练"
    if "【战利品结算" in text and "血色试炼" not in text:
        if not any(marker in text for marker in ("均获得", "每位队员获得", "所有队员", "额外获得", "获得 【", "获得了【")):
            return ""
        if "夺鼎" in text:
            return "虚天殿·夺鼎"
        if "求稳" in text:
            return "虚天殿·求稳"
        return "副本战利品"
    if "【黄龙山大战" in text:
        if "指令" in text or "获得" not in text:
            return ""
        return "黄龙山"
    if "【登顶昆吾山" in text:
        if "最终收获" not in text:
            return ""
        return "昆吾山"
    if ("【坠魔谷·" in text or "【坠魔谷・" in text) and "获得" in text:
        return "坠魔谷"
    if "【苍坤上人洞府·" in text and "获得" in text:
        return "苍坤上人洞府"
    if "【逆天之举" in text and "风希" in text and "【战利品】" in text:
        return "风希"
    if "【灵果入腹" in text:
        return "灵树采摘"
    if "【极阴的欣赏" in text or "【神魂碾压" in text or "【侥幸逃脱" in text:
        return "极阴"
    if "【天机异闻·南陇侯的交易" in text:
        if "作为回报" not in text:
            return ""
        return "南陇侯"
    if "【天机异闻·魔君之怒" in text:
        return "南陇侯"
    return ""
