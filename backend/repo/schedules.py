from __future__ import annotations

import time


def _normalize_schedule_saved_templates(raw: object) -> list[dict]:
    items = raw if isinstance(raw, list) else ([] if raw is None else [raw])
    normalized: list[dict] = []
    seen: set[str] = set()

    for item in items:
        if not isinstance(item, dict):
            continue
        name = str(item.get("name") or "").strip()
        payload = item.get("payload") or {}
        if not isinstance(payload, dict):
            payload = {}
        template_id = str(item.get("id") or "").strip()
        if not template_id:
            template_id = str(item.get("key") or "").strip()
        if not template_id:
            template_id = f"tpl-{int(time.time() * 1000)}"
        if template_id in seen:
            continue
        seen.add(template_id)
        normalized.append(
            {
                "id": template_id,
                "name": name or template_id,
                "payload": _normalize_schedule_template_payload(payload),
                "updated_at": float(item.get("updated_at") or time.time()),
            }
        )
    normalized.sort(key=lambda item: (item.get("updated_at") or 0, item.get("name") or ""), reverse=True)
    return normalized


def _normalize_schedule_template_payload(payload: dict) -> dict:
    data = dict(payload or {})
    for key in ("anchor_at", "anchor_at_text"):
        data.pop(key, None)
    if "send_as_ids" in data:
        raw_ids = data.get("send_as_ids") or []
        if isinstance(raw_ids, str):
            raw_ids = raw_ids.replace("\n", ",").split(",")
        ids = []
        for item in raw_ids:
            try:
                sid = int(str(item).strip())
            except (TypeError, ValueError):
                continue
            if sid and sid not in ids:
                ids.append(sid)
        data["send_as_ids"] = ids
    if "send_as_id" in data:
        try:
            data["send_as_id"] = int(data.get("send_as_id") or 0)
        except (TypeError, ValueError):
            data["send_as_id"] = 0
    return data
