from __future__ import annotations

from datetime import datetime, timezone


def _safe_int(value: object) -> int:
    try:
        return int(value or 0)
    except (TypeError, ValueError):
        return 0


def _coerce_positive_int(value: object) -> int:
    try:
        number = int(str(value or "").strip())
    except (TypeError, ValueError):
        return 0
    return number if number > 0 else 0


def _coerce_non_zero_int(value: object) -> int:
    try:
        number = int(str(value or "").strip())
    except (TypeError, ValueError):
        return 0
    return number if number != 0 else 0


def _coerce_non_negative_int(value: object) -> int:
    try:
        number = int(str(value).strip())
    except (TypeError, ValueError):
        return 100
    return max(0, number)


def _merge_int_defaults(raw_value, defaults: list[int]) -> list[int]:
    items: list[int] = []
    seen: set[int] = set()
    for value in list(raw_value or []) + list(defaults or []):
        try:
            parsed = int(value)
        except (TypeError, ValueError):
            continue
        if parsed and parsed not in seen:
            seen.add(parsed)
            items.append(parsed)
    return items


def _merge_str_defaults(raw_value, defaults: list[str]) -> list[str]:
    items: list[str] = []
    seen: set[str] = set()
    for value in list(raw_value or []) + list(defaults or []):
        text = str(value or "").strip()
        if not text:
            continue
        if text not in seen:
            seen.add(text)
            items.append(text)
    return items


def _normalize_channel_filters(
    channel: str = "all",
    channels: list[str] | tuple[str, ...] | None = None,
) -> list[str]:
    raw_items: list[str] = []
    if channels:
        raw_items.extend(str(item or "").strip() for item in channels)
    channel = str(channel or "all").strip()
    if channel and channel != "all":
        raw_items.append(channel)

    result: list[str] = []
    seen: set[str] = set()
    for item in raw_items:
        if not item or item == "all" or item in seen:
            continue
        seen.add(item)
        result.append(item)
    return result


def _parse_message_dt(value: object) -> datetime | None:
    text = str(value or "").strip()
    if not text:
        return None
    try:
        parsed = datetime.fromisoformat(text.replace("Z", "+00:00"))
    except ValueError:
        return None
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    return parsed.astimezone(timezone.utc)
