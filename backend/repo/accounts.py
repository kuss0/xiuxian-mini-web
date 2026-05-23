from __future__ import annotations

from backend.repo.common import _coerce_non_negative_int, _coerce_non_zero_int
from backend.tg.client import safe_session_name


def _normalize_account(payload: dict) -> dict:
    def text(key: str) -> str:
        return str(payload.get(key) or "").strip()

    raw_local_id = text("local_id") or text("session_name") or text("phone") or "account"
    local_id = safe_session_name(raw_local_id, fallback="account")
    session_name = safe_session_name(text("session_name") or local_id, fallback=local_id)

    return {
        "local_id": local_id,
        "account_id": text("account_id"),
        "label": text("label") or text("phone") or local_id,
        "username": text("username").lstrip("@"),
        "phone": text("phone"),
        "session_name": session_name,
        "api_id": text("api_id"),
        "api_hash": text("api_hash"),
        "target_chat": text("target_chat"),
        "target_topic_id": text("target_topic_id"),
        "proxy_type": text("proxy_type").lower(),
        "proxy_host": text("proxy_host"),
        "proxy_username": text("proxy_username"),
        "proxy_password": text("proxy_password"),
        "collector_enabled": bool(payload.get("collector_enabled", True)),
        "collector_priority": _coerce_non_negative_int(payload.get("collector_priority")),
        "listen_enabled": bool(payload.get("listen_enabled")),
        "login_status": text("login_status") or "idle",
        "login_message": text("login_message"),
        "listener_status": text("listener_status") or "stopped",
        "listener_message": text("listener_message"),
    }


def _normalize_identity(payload: dict) -> dict:
    def text(key: str) -> str:
        return str(payload.get(key) or "").strip()

    send_as_id = _coerce_non_zero_int(payload.get("send_as_id") or payload.get("id"))
    account_local_id = safe_session_name(text("account_local_id"), fallback="") if text("account_local_id") else ""
    username = text("username").lstrip("@")
    label = text("label") or username or (str(send_as_id) if send_as_id != 0 else "")
    return {
        "send_as_id": send_as_id,
        "account_local_id": account_local_id,
        "label": label,
        "username": username,
        "enabled": bool(payload.get("enabled", True)),
        "note": text("note"),
    }
