from __future__ import annotations

from dataclasses import dataclass
from typing import Callable, Mapping


@dataclass
class RawResponse:
    """Non-JSON GET response for downloads and other raw payloads."""

    body: bytes
    content_type: str = "application/octet-stream"
    filename: str = ""


class PostRoute:
    def __init__(self, handler: Callable, *, needs_payload: bool = False) -> None:
        self._handler = handler
        self.needs_payload = needs_payload

    def __call__(self, request, payload: dict) -> dict:
        return self._handler(request, payload)


def build_get_routes(handlers: Mapping[str, Callable]) -> dict[str, Callable]:
    return {
        "/api/health": handlers["_get_health"],
        "/api/message-audit": handlers["_get_message_audit"],
        "/api/channels": handlers["_get_channels"],
        "/api/messages": handlers["_get_messages"],
        "/api/messages/export": handlers["_get_messages_export"],
        "/api/outbox": handlers["_get_outbox"],
        "/api/outbox/drafts": handlers["_get_outbox_drafts"],
        "/api/outbox/logs": handlers["_get_outbox_logs"],
        "/api/settings": handlers["_get_settings"],
        "/api/state-patches": handlers["_get_state_patches"],
        "/api/resource-stats": handlers["_get_resource_stats"],
        "/api/resource-coverage": handlers["_get_resource_coverage"],
        "/api/dungeon-status": handlers["_get_dungeon_status"],
        "/api/xutian-oracle-guide": handlers["_get_xutian_oracle_guide"],
        "/api/cangkun-guide": handlers["_get_cangkun_guide"],
        "/api/inventory": handlers["_get_inventory"],
        "/api/discovered-bots": handlers["_get_discovered_bots"],
        "/api/accounts": handlers["_get_accounts"],
        "/api/identities": handlers["_get_identities"],
        "/api/identity-state": handlers["_get_identity_state"],
        "/api/tianjige/status": handlers["_get_tianjige_status"],
        "/api/tianjige/bootstrap": handlers["_get_tianjige_bootstrap"],
        "/api/listener/status": handlers["_get_listener_status"],
        "/api/telegram/dialogs": handlers["_get_telegram_dialogs"],
        "/api/telegram/topics": handlers["_get_telegram_topics"],
        "/api/accounts/send-as-peers": handlers["_get_account_send_as_peers"],
        "/api/accounts/dialogs": handlers["_get_account_dialogs"],
        "/api/accounts/topics": handlers["_get_account_topics"],
        "/api/schedule/bootstrap": handlers["_get_schedule_bootstrap"],
        "/api/schedule/presets": handlers["_get_schedule_presets"],
        "/api/schedule/modules": handlers["_get_schedule_modules"],
        "/api/schedule/templates": handlers["_get_schedule_templates"],
        "/api/schedule": handlers["_get_schedule"],
        "/api/schedule/sync": handlers["_get_schedule_sync"],
        "/api/schedule/renew": handlers["_get_schedule_renew"],
        "/api/skills": handlers["_get_skills"],
        "/api/notify/card-titles": handlers["_get_notify_card_titles"],
        "/api/filter/diagnostics": handlers["_get_filter_diagnostics"],
    }


def build_post_routes(handlers: Mapping[str, Callable]) -> dict[str, PostRoute]:
    return {
        "/api/settings": PostRoute(handlers["_post_settings"], needs_payload=True),
        "/api/focus-exclude/preview": PostRoute(handlers["_post_focus_exclude_preview"], needs_payload=True),
        "/api/message-audit/backfill": PostRoute(handlers["_post_message_audit_backfill"], needs_payload=True),
        "/api/resource-coverage/reparse": PostRoute(handlers["_post_resource_reparse"], needs_payload=True),
        "/api/inventory/transfer-plan": PostRoute(handlers["_post_inventory_transfer_plan"], needs_payload=True),
        "/api/accounts": PostRoute(handlers["_post_account"], needs_payload=True),
        "/api/accounts/delete": PostRoute(handlers["_post_account_delete"], needs_payload=True),
        "/api/accounts/logout": PostRoute(handlers["_post_account_logout"], needs_payload=True),
        "/api/identities": PostRoute(handlers["_post_identity"], needs_payload=True),
        "/api/identities/batch": PostRoute(handlers["_post_identity_batch"], needs_payload=True),
        "/api/identities/delete": PostRoute(handlers["_post_identity_delete"], needs_payload=True),
        "/api/tianjige/me": PostRoute(handlers["_post_tianjige_me"], needs_payload=True),
        "/api/tianjige/cultivator": PostRoute(handlers["_post_tianjige_cultivator"], needs_payload=True),
        "/api/outbox/plan": PostRoute(handlers["_post_outbox_plan"], needs_payload=True),
        "/api/outbox/drafts": PostRoute(handlers["_post_outbox_draft"], needs_payload=True),
        "/api/outbox/drafts/delete": PostRoute(handlers["_post_outbox_draft_delete"], needs_payload=True),
        "/api/login/start": PostRoute(handlers["_post_login_start"]),
        "/api/login/cancel": PostRoute(handlers["_post_login_cancel"]),
        "/api/login/verify": PostRoute(handlers["_post_login_verify"], needs_payload=True),
        "/api/listener/start": PostRoute(handlers["_post_listener_start"]),
        "/api/listener/stop": PostRoute(handlers["_post_listener_stop"]),
        "/api/accounts/login/start": PostRoute(handlers["_post_account_login_start"], needs_payload=True),
        "/api/accounts/login/verify": PostRoute(handlers["_post_account_login_verify"], needs_payload=True),
        "/api/accounts/login/cancel": PostRoute(handlers["_post_account_login_cancel"], needs_payload=True),
        "/api/accounts/listener/start": PostRoute(handlers["_post_account_listener_start"], needs_payload=True),
        "/api/accounts/listener/stop": PostRoute(handlers["_post_account_listener_stop"], needs_payload=True),
        "/api/accounts/resolve-entity": PostRoute(handlers["_post_account_resolve_entity"], needs_payload=True),
        "/api/schedule/preview": PostRoute(handlers["_post_schedule_preview"], needs_payload=True),
        "/api/schedule/create": PostRoute(handlers["_post_schedule_create"], needs_payload=True),
        "/api/schedule/delete": PostRoute(handlers["_post_schedule_delete"], needs_payload=True),
        "/api/schedule/templates/save": PostRoute(handlers["_post_schedule_template_save"], needs_payload=True),
        "/api/schedule/templates/delete": PostRoute(handlers["_post_schedule_template_delete"], needs_payload=True),
        "/api/schedule/cancel": PostRoute(handlers["_post_schedule_cancel"], needs_payload=True),
        "/api/schedule/retry-failed": PostRoute(handlers["_post_schedule_retry_failed"], needs_payload=True),
        "/api/schedule/activate-dry-run": PostRoute(handlers["_post_schedule_activate_dry_run"], needs_payload=True),
        "/api/schedule/sync/repair": PostRoute(handlers["_post_schedule_sync_repair"], needs_payload=True),
        "/api/schedule/renew/save": PostRoute(handlers["_post_schedule_renew_save"], needs_payload=True),
        "/api/schedule/renew/delete": PostRoute(handlers["_post_schedule_renew_delete"], needs_payload=True),
        "/api/schedule/renew/preview": PostRoute(handlers["_post_schedule_renew_preview"], needs_payload=True),
        "/api/schedule/renew/run": PostRoute(handlers["_post_schedule_renew_run"], needs_payload=True),
        "/api/skills/send": PostRoute(handlers["_post_skill_send"], needs_payload=True),
        "/api/notify/test": PostRoute(handlers["_post_notify_test"], needs_payload=True),
    }
