from __future__ import annotations

import asyncio
from typing import Protocol

from backend.api.routes import RawResponse


class MiniWebRequest(Protocol):
    app_server: object | None


def _app(request: MiniWebRequest):
    if request.app_server is None:
        raise RuntimeError("MiniWebServer is not configured")
    return request.app_server


def _get_health(request: MiniWebRequest, query: dict) -> dict:
    return _app(request).health_payload()


def _get_message_audit(request: MiniWebRequest, query: dict) -> dict:
    try:
        since_hours = int((query.get("since_hours") or ["24"])[0])
    except (TypeError, ValueError):
        since_hours = 24
    try:
        min_gap_seconds = int((query.get("min_gap_seconds") or ["60"])[0])
    except (TypeError, ValueError):
        min_gap_seconds = 60
    try:
        min_missing_msg_ids = int((query.get("min_missing_msg_ids") or ["20"])[0])
    except (TypeError, ValueError):
        min_missing_msg_ids = 20
    try:
        limit = int((query.get("limit") or ["12"])[0])
    except (TypeError, ValueError):
        limit = 12
    deep_raw = str((query.get("deep") or ["0"])[0]).lower()
    deep = deep_raw in {"1", "true", "yes"}
    return _app(request).message_audit_payload(
        since_hours=since_hours,
        min_gap_seconds=min_gap_seconds,
        min_missing_msg_ids=min_missing_msg_ids,
        limit=limit,
        deep=deep,
    )


def _post_message_audit_backfill(request: MiniWebRequest, payload: dict) -> dict:
    try:
        return _app(request).message_audit_backfill_payload(payload)
    except Exception as exc:
        return {"ok": False, "error": str(exc)}


def _get_channels(request: MiniWebRequest, query: dict) -> dict:
    return _app(request).channels_payload()


def _get_messages(request: MiniWebRequest, query: dict) -> dict:
    channel = (query.get("channel") or ["all"])[0]
    channels = query.get("channels") or []
    since_seq = (query.get("since_seq") or ["0"])[0]
    before_seq = (query.get("before_seq") or ["0"])[0]
    limit = (query.get("limit") or ["0"])[0]
    target_id = (query.get("id") or query.get("target_id") or [""])[0]
    mode = (query.get("mode") or [""])[0]
    compact_raw = str((query.get("compact") or ["0"])[0]).lower()
    compact = compact_raw in {"1", "true", "yes"}
    return _app(request).messages_payload(
        channel,
        channels=channels,
        since_seq=since_seq,
        before_seq=before_seq,
        limit=limit,
        target_id=target_id,
        mode=mode,
        compact=compact,
    )


def _get_messages_export(request: MiniWebRequest, query: dict):
    """日志 modal 的「导出」按钮端点。返 RawResponse → 浏览器触发文件下载。
    fmt: jsonl(默认)/ csv / txt"""
    channel = (query.get("channel") or ["all"])[0]
    mode = (query.get("mode") or [""])[0]
    fmt = (query.get("fmt") or query.get("format") or ["jsonl"])[0]
    result = _app(request).messages_export_payload(channel, mode=mode, fmt=fmt)
    return RawResponse(
        body=result.get("body") or b"",
        content_type=result.get("content_type") or "application/octet-stream",
        filename=result.get("filename") or "xiuxian-messages.txt",
    )


def _get_outbox(request: MiniWebRequest, query: dict) -> dict:
    return _app(request).outbox_payload()


def _get_outbox_drafts(request: MiniWebRequest, query: dict) -> dict:
    status = (query.get("status") or ["draft"])[0]
    return _app(request).outbox_drafts_payload(status)


def _get_outbox_logs(request: MiniWebRequest, query: dict) -> dict:
    kind = (query.get("kind") or [""])[0]
    status = (query.get("status") or [""])[0]
    try:
        identity_id = int((query.get("identity_id") or ["0"])[0])
    except (TypeError, ValueError):
        identity_id = 0
    try:
        batch_id = int((query.get("batch_id") or ["0"])[0])
    except (TypeError, ValueError):
        batch_id = 0
    try:
        limit = int((query.get("limit") or ["100"])[0])
    except (TypeError, ValueError):
        limit = 100
    return _app(request).outbox_logs_payload(
        limit=limit,
        kind=kind,
        status=status,
        identity_id=identity_id,
        batch_id=batch_id,
    )


def _get_log_commands(request: MiniWebRequest, query: dict) -> dict:
    return _app(request).log_commands_payload()


def _post_log_command_dispatch(request: MiniWebRequest, payload: dict) -> dict:
    try:
        return _app(request).log_command_dispatch_payload(payload or {})
    except Exception as exc:
        return {"ok": False, "status": "error", "error": str(exc), "actions": []}


def _get_settings(request: MiniWebRequest, query: dict) -> dict:
    return _app(request).settings_payload()


def _get_state_patches(request: MiniWebRequest, query: dict) -> dict:
    scope = (query.get("scope") or [""])[0]
    try:
        send_as_id = int((query.get("send_as_id") or ["0"])[0])
    except (TypeError, ValueError):
        send_as_id = 0
    return _app(request).state_patches_payload(scope, send_as_id=send_as_id)


def _get_resource_stats(request: MiniWebRequest, query: dict) -> dict:
    period = (query.get("period") or ["day"])[0]
    source_type = (query.get("source_type") or [""])[0]
    source_name = (query.get("source_name") or [""])[0]
    try:
        limit = int((query.get("limit") or ["120"])[0])
    except (TypeError, ValueError):
        limit = 120
    return _app(request).resource_stats_payload(
        period=period,
        source_type=source_type,
        source_name=source_name,
        limit=limit,
    )


def _get_resource_coverage(request: MiniWebRequest, query: dict) -> dict:
    try:
        limit = int((query.get("limit") or ["5000"])[0])
    except (TypeError, ValueError):
        limit = 5000
    return _app(request).resource_coverage_payload(limit=limit)


def _post_resource_reparse(request: MiniWebRequest, payload: dict) -> dict:
    return _app(request).resource_reparse_payload(payload)


def _get_dungeon_status(request: MiniWebRequest, query: dict) -> dict:
    try:
        limit = int((query.get("limit") or ["500"])[0])
    except (TypeError, ValueError):
        limit = 500
    try:
        summary_limit = int((query.get("summary_limit") or ["80"])[0])
    except (TypeError, ValueError):
        summary_limit = 80
    order = (query.get("order") or ["priority"])[0]
    return _app(request).dungeon_status_payload(limit=limit, summary_limit=summary_limit, order=order)


def _get_xutian_oracle_guide(request: MiniWebRequest, query: dict) -> dict:
    return _app(request).xutian_oracle_guide_payload()


def _get_cangkun_guide(request: MiniWebRequest, query: dict) -> dict:
    return _app(request).cangkun_guide_payload()


def _get_inventory(request: MiniWebRequest, query: dict) -> dict:
    owner = (query.get("owner") or [""])[0]
    latest_raw = str((query.get("latest_only") or ["1"])[0]).lower()
    latest_only = latest_raw not in {"0", "false", "no"}
    include_items_raw = str((query.get("include_items") or ["1"])[0]).lower()
    include_items = include_items_raw not in {"0", "false", "no"}
    try:
        limit = int((query.get("limit") or ["80"])[0])
    except (TypeError, ValueError):
        limit = 80
    return _app(request).inventory_payload(
        owner=owner,
        latest_only=latest_only,
        include_items=include_items,
        limit=limit,
    )


def _get_discovered_bots(request: MiniWebRequest, query: dict) -> dict:
    return _app(request).discovered_bots_payload()


def _get_accounts(request: MiniWebRequest, query: dict) -> dict:
    return _app(request).accounts_payload()


def _get_identities(request: MiniWebRequest, query: dict) -> dict:
    return _app(request).identities_payload()


def _get_identity_state(request: MiniWebRequest, query: dict) -> dict:
    send_as_id = (query.get("send_as_id") or [""])[0]
    return _app(request).identity_state_payload(send_as_id)


def _get_state_observations(request: MiniWebRequest, query: dict) -> dict:
    send_as_id = (query.get("send_as_id") or [""])[0]
    module_key = (query.get("module_key") or [""])[0]
    family = (query.get("family") or [""])[0]
    decision = (query.get("decision") or [""])[0]
    try:
        limit = int((query.get("limit") or ["50"])[0])
    except (TypeError, ValueError):
        limit = 50
    return _app(request).state_observations_payload(
        send_as_id,
        module_key=module_key,
        family=family,
        decision=decision,
        limit=limit,
    )


def _get_tianjige_status(request: MiniWebRequest, query: dict) -> dict:
    return _app(request).tianjige_status_payload()


def _get_tianjige_bootstrap(request: MiniWebRequest, query: dict) -> dict:
    return _app(request).tianjige_bootstrap_payload()


def _get_listener_status(request: MiniWebRequest, query: dict) -> dict:
    return _app(request).listener_status_payload()


def _get_telegram_dialogs(request: MiniWebRequest, query: dict) -> dict:
    return asyncio.run(_app(request).telegram_dialogs_payload())


def _get_telegram_topics(request: MiniWebRequest, query: dict) -> dict:
    chat = (query.get("chat") or [""])[0]
    return asyncio.run(_app(request).telegram_topics_payload(chat))


def _get_account_send_as_peers(request: MiniWebRequest, query: dict) -> dict:
    local_id = (query.get("local_id") or [""])[0]
    target_chat = (query.get("target_chat") or [""])[0]
    return _app(request).account_send_as_peers_payload(local_id, target_chat)


def _get_account_dialogs(request: MiniWebRequest, query: dict) -> dict:
    local_id = (query.get("local_id") or [""])[0]
    return _app(request).account_dialogs_payload(local_id)


def _get_account_topics(request: MiniWebRequest, query: dict) -> dict:
    local_id = (query.get("local_id") or [""])[0]
    chat = (query.get("chat") or [""])[0]
    return _app(request).account_topics_payload(local_id, chat)


def _post_settings(request: MiniWebRequest, payload: dict) -> dict:
    return _app(request).save_settings_payload(payload)


def _post_focus_exclude_preview(request: MiniWebRequest, payload: dict) -> dict:
    try:
        return _app(request).focus_exclude_preview_payload(payload)
    except Exception as exc:
        return {"ok": False, "error": str(exc)}


def _post_inventory_transfer_plan(request: MiniWebRequest, payload: dict) -> dict:
    try:
        return _app(request).inventory_transfer_plan_payload(payload)
    except Exception as exc:
        return {"ok": False, "error": str(exc)}


def _post_account(request: MiniWebRequest, payload: dict) -> dict:
    try:
        return _app(request).save_account_payload(payload)
    except Exception as exc:
        return {"ok": False, "error": str(exc)}


def _post_account_delete(request: MiniWebRequest, payload: dict) -> dict:
    try:
        return _app(request).delete_account_payload(payload)
    except Exception as exc:
        return {"ok": False, "error": str(exc)}


def _post_account_logout(request: MiniWebRequest, payload: dict) -> dict:
    try:
        return _app(request).logout_account_payload(payload)
    except Exception as exc:
        return {"ok": False, "error": str(exc)}


def _post_identity(request: MiniWebRequest, payload: dict) -> dict:
    try:
        return _app(request).save_identity_payload(payload)
    except Exception as exc:
        return {"ok": False, "error": str(exc)}


def _post_identity_batch(request: MiniWebRequest, payload: dict) -> dict:
    try:
        return _app(request).batch_save_identities_payload(payload)
    except Exception as exc:
        return {"ok": False, "error": str(exc), "results": []}


def _post_identity_delete(request: MiniWebRequest, payload: dict) -> dict:
    try:
        return _app(request).delete_identity_payload(payload)
    except Exception as exc:
        return {"ok": False, "error": str(exc)}


def _post_tianjige_me(request: MiniWebRequest, payload: dict) -> dict:
    return _app(request).tianjige_me_payload(payload)


def _post_tianjige_cultivator(request: MiniWebRequest, payload: dict) -> dict:
    return _app(request).tianjige_cultivator_payload(payload)


def _post_outbox_plan(request: MiniWebRequest, payload: dict) -> dict:
    try:
        return _app(request).outbox_plan_payload(payload)
    except Exception as exc:
        return {"ok": False, "error": str(exc)}


def _post_outbox_draft(request: MiniWebRequest, payload: dict) -> dict:
    try:
        return _app(request).create_outbox_draft_payload(payload)
    except Exception as exc:
        return {"ok": False, "error": str(exc)}


def _post_outbox_draft_delete(request: MiniWebRequest, payload: dict) -> dict:
    try:
        return _app(request).delete_outbox_draft_payload(payload)
    except Exception as exc:
        return {"ok": False, "error": str(exc)}


def _post_login_start(request: MiniWebRequest, payload: dict) -> dict:
    return _app(request).login_start_payload()


def _post_login_cancel(request: MiniWebRequest, payload: dict) -> dict:
    return _app(request).login_cancel_payload()


def _post_login_verify(request: MiniWebRequest, payload: dict) -> dict:
    return _app(request).login_verify_payload(payload)


def _post_listener_start(request: MiniWebRequest, payload: dict) -> dict:
    return _app(request).listener_start_payload()


def _post_listener_stop(request: MiniWebRequest, payload: dict) -> dict:
    return _app(request).listener_stop_payload()


def _post_account_login_start(request: MiniWebRequest, payload: dict) -> dict:
    try:
        return _app(request).account_login_start_payload(payload)
    except Exception as exc:
        return {"ok": False, "error": str(exc)}


def _post_account_login_verify(request: MiniWebRequest, payload: dict) -> dict:
    try:
        return _app(request).account_login_verify_payload(payload)
    except Exception as exc:
        return {"ok": False, "error": str(exc)}


def _post_account_login_cancel(request: MiniWebRequest, payload: dict) -> dict:
    try:
        return _app(request).account_login_cancel_payload(payload)
    except Exception as exc:
        return {"ok": False, "error": str(exc)}


def _post_account_listener_start(request: MiniWebRequest, payload: dict) -> dict:
    try:
        return _app(request).account_listener_start_payload(payload)
    except Exception as exc:
        return {"ok": False, "error": str(exc)}


def _post_account_listener_stop(request: MiniWebRequest, payload: dict) -> dict:
    try:
        return _app(request).account_listener_stop_payload(payload)
    except Exception as exc:
        return {"ok": False, "error": str(exc)}


def _post_account_resolve_entity(request: MiniWebRequest, payload: dict) -> dict:
    return _app(request).account_resolve_entity_payload(payload)


# ---------- 官方定时 ----------

def _get_schedule_presets(request: MiniWebRequest, query: dict) -> dict:
    return _app(request).schedule_presets_payload()


def _get_schedule_bootstrap(request: MiniWebRequest, query: dict) -> dict:
    send_as_id = (query.get("send_as_id") or [""])[0]
    include = (query.get("include") or [None])[0]
    return _app(request).schedule_bootstrap_payload(send_as_id, include=include)


def _get_schedule_modules(request: MiniWebRequest, query: dict) -> dict:
    send_as_id = (query.get("send_as_id") or [""])[0]
    return _app(request).schedule_modules_payload(send_as_id)


def _get_schedule_templates(request: MiniWebRequest, query: dict) -> dict:
    return _app(request).schedule_templates_payload()


def _get_schedule(request: MiniWebRequest, query: dict) -> dict:
    summary = str((query.get("summary") or [""])[0]).strip().lower() in {"1", "true", "yes"}
    include_history = str((query.get("history") or ["1"])[0]).strip().lower() not in {"0", "false", "no"}
    return _app(request).schedule_list_payload(summary=summary, include_history=include_history)


def _get_schedule_sync(request: MiniWebRequest, query: dict) -> dict:
    send_as_id = (query.get("send_as_id") or ["0"])[0]
    return _app(request).schedule_sync_payload(send_as_id)


def _get_schedule_renew(request: MiniWebRequest, query: dict) -> dict:
    return _app(request).schedule_renew_profiles_payload()


def _post_schedule_preview(request: MiniWebRequest, payload: dict) -> dict:
    return _app(request).schedule_preview_payload(payload)


def _post_schedule_create(request: MiniWebRequest, payload: dict) -> dict:
    return _app(request).schedule_create_payload(payload)


def _post_schedule_delete(request: MiniWebRequest, payload: dict) -> dict:
    return _app(request).schedule_delete_payload(payload)


def _post_schedule_template_save(request: MiniWebRequest, payload: dict) -> dict:
    return _app(request).schedule_template_save_payload(payload)


def _post_schedule_template_delete(request: MiniWebRequest, payload: dict) -> dict:
    return _app(request).schedule_template_delete_payload(payload)


def _post_schedule_cancel(request: MiniWebRequest, payload: dict) -> dict:
    return _app(request).schedule_cancel_payload(payload)


def _post_schedule_retry_failed(request: MiniWebRequest, payload: dict) -> dict:
    return _app(request).schedule_retry_failed_payload(payload)


def _post_schedule_activate_dry_run(request: MiniWebRequest, payload: dict) -> dict:
    return _app(request).schedule_activate_dry_run_payload(payload)


def _post_schedule_sync_repair(request: MiniWebRequest, payload: dict) -> dict:
    return _app(request).schedule_sync_repair_payload(payload)


def _post_schedule_refill_preview(request: MiniWebRequest, payload: dict) -> dict:
    return _app(request).schedule_refill_preview_payload(payload)


def _post_schedule_refill_run(request: MiniWebRequest, payload: dict) -> dict:
    return _app(request).schedule_refill_run_payload(payload)


def _post_schedule_renew_save(request: MiniWebRequest, payload: dict) -> dict:
    return _app(request).schedule_renew_save_payload(payload)


def _post_schedule_renew_delete(request: MiniWebRequest, payload: dict) -> dict:
    return _app(request).schedule_renew_delete_payload(payload)


def _post_schedule_renew_preview(request: MiniWebRequest, payload: dict) -> dict:
    return _app(request).schedule_renew_preview_payload(payload)


def _post_schedule_renew_run(request: MiniWebRequest, payload: dict) -> dict:
    return _app(request).schedule_renew_run_payload(payload)


# ---------- 技能盘(直接 / 回复发送)----------

def _get_skills(request: MiniWebRequest, query: dict) -> dict:
    return _app(request).skills_payload()


def _post_skill_send(request: MiniWebRequest, payload: dict) -> dict:
    try:
        return _app(request).skill_send_payload(payload)
    except Exception as exc:
        return {"ok": False, "error": str(exc)}


# ---------- 通知 ----------

def _post_notify_test(request: MiniWebRequest, payload: dict) -> dict:
    try:
        return _app(request).notify_test_payload(payload or {})
    except Exception as exc:
        return {"ok": False, "error": str(exc)}


def _get_notify_card_titles(request: MiniWebRequest, query: dict) -> dict:
    return _app(request).notify_card_titles_payload()


def _get_filter_diagnostics(request: MiniWebRequest, query: dict) -> dict:
    try:
        limit = int((query.get("limit") or ["1000"])[0])
    except (TypeError, ValueError):
        limit = 1000
    return _app(request).filter_diagnostics_payload(limit=limit)
