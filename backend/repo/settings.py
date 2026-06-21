from __future__ import annotations

from backend.processors.message_filter import (
    CURRENT_LEADER_MESSAGE_FILTER_VERSION,
    CURRENT_MESSAGE_FILTER_VERSION,
    DEFAULT_FOCUS_EXCLUDE_PATTERNS,
    DEFAULT_FOCUS_KEYWORDS,
    LEGACY_FOCUS_EXCLUDE_PATTERNS,
)
from backend.external.tianjige import DEFAULT_TIANJIGE_BASE_URL
from backend.repo.common import _merge_str_defaults
from backend.repo.schedules import _normalize_schedule_saved_templates


def _normalize_settings(payload: dict) -> dict:
    def text(key: str) -> str:
        return str(payload.get(key) or "").strip()

    def bool_value(key: str) -> bool:
        return bool(payload.get(key))

    raw_bot_ids = payload.get("game_bot_ids") or []
    if isinstance(raw_bot_ids, str):
        raw_bot_ids = raw_bot_ids.replace("\n", ",").split(",")
    game_bot_ids = []
    for item in raw_bot_ids:
        raw = str(item or "").strip()
        if not raw:
            continue
        try:
            game_bot_ids.append(int(raw))
        except ValueError:
            continue

    retention_raw = payload.get("message_retention_days")
    if retention_raw is None or str(retention_raw).strip() == "":
        retention = 30
    else:
        try:
            retention = int(str(retention_raw).strip())
        except (TypeError, ValueError):
            retention = 30
        if retention < 0:
            retention = 0

    raw_titles = payload.get("notify_card_titles") or []
    if isinstance(raw_titles, str):
        raw_titles = [raw_titles]
    notify_card_titles = sorted({str(t).strip() for t in raw_titles if str(t or "").strip()})

    raw_templates = payload.get("schedule_saved_templates") or []
    schedule_saved_templates = _normalize_schedule_saved_templates(raw_templates)

    def str_list(key: str, default: list[str] | None = None) -> list[str]:
        raw = payload.get(key)
        if raw is None:
            raw = default or []
        if isinstance(raw, str):
            raw = raw.splitlines() if key == "focus_exclude_patterns" else raw.replace("\n", ",").split(",")
        return [str(item).strip() for item in raw if str(item or "").strip()]

    def int_list(key: str) -> list[int]:
        out = []
        for item in str_list(key):
            try:
                out.append(int(item))
            except (TypeError, ValueError):
                continue
        return sorted(set(out))

    def int_value(key: str, default: int, *, minimum: int, maximum: int) -> int:
        raw = payload.get(key)
        if raw is None or str(raw).strip() == "":
            value = default
        else:
            try:
                value = int(str(raw).strip())
            except (TypeError, ValueError):
                value = default
        return max(minimum, min(maximum, value))

    def float_value(key: str, default: float, *, minimum: float) -> float:
        raw = payload.get(key)
        if raw is None or str(raw).strip() == "":
            value = default
        else:
            try:
                value = float(str(raw).strip())
            except (TypeError, ValueError):
                value = default
        return max(minimum, value)

    tianjige_mode = text("tianjige_mode").lower() or "mock"
    if tianjige_mode not in {"off", "mock", "real"}:
        tianjige_mode = "mock"

    return {
        "api_id": text("api_id"),
        "api_hash": text("api_hash"),
        "phone": text("phone"),
        "session_name": text("session_name") or "miniweb_session",
        "target_chat": text("target_chat"),
        "target_topic_id": text("target_topic_id"),
        "game_bot_ids": sorted(set(game_bot_ids)),
        "proxy_type": text("proxy_type").lower(),
        "proxy_host": text("proxy_host"),
        "proxy_username": text("proxy_username"),
        "proxy_password": text("proxy_password"),
        "listen_enabled": bool_value("listen_enabled"),
        "login_status": text("login_status") or "idle",
        "login_message": text("login_message"),
        "login_account_id": text("login_account_id"),
        "listener_status": text("listener_status") or "stopped",
        "listener_message": text("listener_message"),
        "message_retention_days": retention,
        "own_aliases": sorted(set(str_list("own_aliases"))),
        "leader_sender_ids": int_list("leader_sender_ids"),
        "leader_source_names": sorted(set(str_list("leader_source_names"))),
        "focus_muted_sender_ids": int_list("focus_muted_sender_ids"),
        "focus_muted_source_names": sorted(set(str_list("focus_muted_source_names"))),
        "focus_keywords": sorted(set(str_list("focus_keywords", list(DEFAULT_FOCUS_KEYWORDS)))),
        "focus_exclude_patterns": _merge_focus_exclude_defaults(
            str_list("focus_exclude_patterns", []),
        ),
        "focus_include_player_plain": bool_value("focus_include_player_plain"),
        "archive_dot_commands": bool_value("archive_dot_commands"),
        "archive_bot_replies": bool_value("archive_bot_replies"),
        "message_filter_version": CURRENT_MESSAGE_FILTER_VERSION,
        "leader_message_filter_version": CURRENT_LEADER_MESSAGE_FILTER_VERSION,
        "notify_enabled": bool_value("notify_enabled"),
        "notify_tg_bot_token": text("notify_tg_bot_token"),
        "notify_tg_chat_id": text("notify_tg_chat_id"),
        "notify_card_titles": notify_card_titles,
        "log_command_enabled": bool_value("log_command_enabled"),
        "log_command_chat_id": text("log_command_chat_id"),
        "log_command_mapping_chat_id": text("log_command_mapping_chat_id"),
        "log_command_admin_ids": int_list("log_command_admin_ids"),
        "tianjige_mode": tianjige_mode,
        "tianjige_base_url": text("tianjige_base_url") or DEFAULT_TIANJIGE_BASE_URL,
        "tianjige_api_token": text("tianjige_api_token"),
        "tianjige_cookie": text("tianjige_cookie"),
        "tianjige_timeout_sec": float_value("tianjige_timeout_sec", 8.0, minimum=1.0),
        "tianjige_min_interval_sec": float_value("tianjige_min_interval_sec", 10.0, minimum=0.0),
        "schedule_saved_templates": schedule_saved_templates,
    }


def _merge_focus_exclude_defaults(raw_value) -> list[str]:
    legacy = {str(item).strip() for item in LEGACY_FOCUS_EXCLUDE_PATTERNS}
    custom = [
        str(item or "").strip()
        for item in list(raw_value or [])
        if str(item or "").strip() and str(item or "").strip() not in legacy
    ]
    return _merge_str_defaults(custom, list(DEFAULT_FOCUS_EXCLUDE_PATTERNS))
