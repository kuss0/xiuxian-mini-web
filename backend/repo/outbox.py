from __future__ import annotations

import json

from backend.domain.models import OutboxDraft, utc_now_iso
from backend.repo.common import _safe_int
from backend.tg.client import safe_session_name


def _normalize_outbox_draft(payload: dict) -> dict:
    draft = OutboxDraft.from_api(payload).to_api()
    draft["id"] = str(draft.get("id") or "").strip()
    draft["command"] = str(draft.get("command") or "").strip()
    draft["target_chat"] = str(draft.get("target_chat") or "").strip()
    draft["account_local_id"] = safe_session_name(draft.get("account_local_id") or "", fallback="")
    draft["source_message_id"] = str(draft.get("source_message_id") or "").strip()
    draft["send_mode"] = str(draft.get("send_mode") or "copy").strip() or "copy"
    draft["status"] = str(draft.get("status") or "draft").strip() or "draft"
    draft["created_at"] = str(draft.get("created_at") or "").strip()
    draft["note"] = str(draft.get("note") or "").strip()
    draft["missing"] = [str(item).strip() for item in (draft.get("missing") or []) if str(item).strip()]
    return draft


def _normalize_send_log(payload: dict) -> dict:
    payload = payload or {}
    meta = payload.get("meta") or {}
    if not isinstance(meta, dict):
        meta = {"value": meta}
    return {
        "id": _send_log_non_negative_int(payload.get("id")),
        "kind": str(payload.get("kind") or "").strip() or "unknown",
        "status": str(payload.get("status") or "").strip() or "unknown",
        "account_local_id": safe_session_name(payload.get("account_local_id") or "", fallback="")
        if str(payload.get("account_local_id") or "").strip()
        else "",
        "identity_id": _safe_int(payload.get("identity_id")),
        "send_as_id": _safe_int(payload.get("send_as_id")),
        "chat_id": _safe_int(payload.get("chat_id")),
        "topic_id": _send_log_non_negative_int(payload.get("topic_id")),
        "reply_to_msg_id": _send_log_non_negative_int(payload.get("reply_to_msg_id")),
        "command": str(payload.get("command") or "").strip(),
        "source_message_id": str(payload.get("source_message_id") or "").strip(),
        "tg_msg_id": _send_log_non_negative_int(payload.get("tg_msg_id")),
        "scheduled_msg_id": _send_log_non_negative_int(payload.get("scheduled_msg_id")),
        "batch_id": _send_log_non_negative_int(payload.get("batch_id")),
        "schedule_message_id": _send_log_non_negative_int(payload.get("schedule_message_id")),
        "error": str(payload.get("error") or "").strip(),
        "created_at": str(payload.get("created_at") or "").strip() or utc_now_iso(),
        "meta": meta,
    }


def _send_log_non_negative_int(value: object) -> int:
    try:
        return max(0, int(str(value or "0").strip() or 0))
    except (TypeError, ValueError):
        return 0


def _send_log_row_to_api(row) -> dict:
    meta = {}
    try:
        meta = json.loads(row[17] or "{}")
    except (TypeError, json.JSONDecodeError):
        meta = {}
    if not isinstance(meta, dict):
        meta = {"value": meta}
    return {
        "id": int(row[0]),
        "kind": row[1] or "",
        "status": row[2] or "",
        "account_local_id": row[3] or "",
        "identity_id": int(row[4] or 0),
        "send_as_id": int(row[5] or 0),
        "chat_id": int(row[6] or 0),
        "topic_id": int(row[7] or 0),
        "reply_to_msg_id": int(row[8] or 0),
        "command": row[9] or "",
        "source_message_id": row[10] or "",
        "tg_msg_id": int(row[11] or 0),
        "scheduled_msg_id": int(row[12] or 0),
        "batch_id": int(row[13] or 0),
        "schedule_message_id": int(row[14] or 0),
        "error": row[15] or "",
        "created_at": row[16] or "",
        "meta": meta,
    }
