"""Guarded automation policy for outbound game commands.

This layer deliberately does not talk to Telegram. It turns an outbox plan into
an automation decision so every sender adapter shares the same safety checks.
"""

from __future__ import annotations

import hashlib
import json
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from typing import Protocol

from backend.outbox.planner import OutboxPlan
from backend.skills import Skill, SkillRegistry


DEFAULT_AUTOMATION_ALLOWED_SKILL_KEYS = (
    "storage_bag",
    "battle_power",
    "identity_info",
    "deep_retreat_query",
    "yuanying_status",
    "tianti_status",
    "tree_status",
    "concubine_status",
    "second_soul_status",
    "sect_list",
)


class AutomationLogStore(Protocol):
    def list_send_logs(
        self,
        *,
        limit: int = 100,
        kind: str = "",
        status: str = "",
        identity_id: int = 0,
        batch_id: int = 0,
    ) -> list[dict]:
        ...


@dataclass(frozen=True)
class AutomationDecision:
    skill_key: str
    can_auto_dispatch: bool
    manual_required: bool
    dry_run: bool
    reason: str
    message: str
    idempotency_key: str
    adapter: str = "user_session"
    max_per_minute: int = 6
    recent_success_count: int = 0

    def to_api(self) -> dict:
        return {
            "skill_key": self.skill_key,
            "can_auto_dispatch": self.can_auto_dispatch,
            "manual_required": self.manual_required,
            "dry_run": self.dry_run,
            "reason": self.reason,
            "message": self.message,
            "idempotency_key": self.idempotency_key,
            "adapter": self.adapter,
            "max_per_minute": self.max_per_minute,
            "recent_success_count": self.recent_success_count,
        }


class OutboxAutomation:
    def __init__(self, registry: SkillRegistry, store: AutomationLogStore) -> None:
        self._registry = registry
        self._store = store

    def decision_for_plan(
        self,
        plan: OutboxPlan,
        *,
        settings: dict,
        source_message_id: str = "",
        supported_adapters: set[str] | list[str] | tuple[str, ...] | None = None,
    ) -> AutomationDecision:
        skill = infer_skill_from_command(self._registry, plan.command)
        skill_key = skill.key if skill is not None else ""
        adapter = str(settings.get("automation_sender_adapter") or "user_session").strip() or "user_session"
        idempotency_key = automation_idempotency_key(
            plan,
            skill_key=skill_key,
            source_message_id=source_message_id,
        )
        max_per_minute = _settings_int(settings, "automation_max_per_minute", 6, minimum=1, maximum=60)
        dry_run = bool(settings.get("automation_dry_run", True))

        def blocked(reason: str, message: str) -> AutomationDecision:
            return AutomationDecision(
                skill_key=skill_key,
                can_auto_dispatch=False,
                manual_required=True,
                dry_run=dry_run,
                reason=reason,
                message=message,
                idempotency_key=idempotency_key,
                adapter=adapter,
                max_per_minute=max_per_minute,
            )

        if not plan.resolved:
            missing = "、".join(plan.missing) or "上下文"
            return blocked("missing_context", f"发送上下文未补齐: {missing}")
        if skill is None:
            return blocked("unknown_skill", "命令不在技能注册表中,必须人工确认")
        if _identity_id(plan) == 0:
            return blocked("missing_identity", "自动发送必须明确指定发送身份")
        if skill.reply_mode == "required" and int(plan.action.reply_to_msg_id or 0) <= 0:
            return blocked("missing_reply", "该命令必须回复具体 bot 消息,缺少 reply_to_msg_id")
        if not bool(settings.get("automation_enabled")):
            return blocked("automation_disabled", "自动发送未启用")

        supported = {str(item).strip() for item in supported_adapters or () if str(item or "").strip()}
        if supported and adapter not in supported:
            return blocked("adapter_not_supported", f"发送适配器 {adapter} 未接入,必须人工确认")

        allowed_skills = _settings_str_set(settings, "automation_allowed_skill_keys")
        if not allowed_skills:
            return blocked("empty_skill_allowlist", "自动发送技能白名单为空,必须人工确认")
        if skill.key not in allowed_skills:
            return blocked("skill_not_allowed", f"技能 {skill.key} 未在自动发送白名单")

        identity_id = _identity_id(plan)
        allowed_identities = _settings_int_set(settings, "automation_allowed_identity_ids")
        if allowed_identities and identity_id not in allowed_identities:
            return blocked("identity_not_allowed", f"身份 {identity_id} 未在自动发送白名单")

        if _has_successful_idempotency_key(self._store, identity_id, idempotency_key):
            return blocked("duplicate_blocked", "同一动作已经成功自动发送过,已阻止重复发送")

        recent_count = _recent_auto_success_count(self._store, identity_id)
        if recent_count >= max_per_minute:
            return AutomationDecision(
                skill_key=skill_key,
                can_auto_dispatch=False,
                manual_required=True,
                dry_run=dry_run,
                reason="rate_limited",
                message=f"自动发送限速:最近 60 秒已成功 {recent_count} 条",
                idempotency_key=idempotency_key,
                adapter=adapter,
                max_per_minute=max_per_minute,
                recent_success_count=recent_count,
            )

        return AutomationDecision(
            skill_key=skill.key,
            can_auto_dispatch=True,
            manual_required=False,
            dry_run=dry_run,
            reason="dry_run" if dry_run else "allowed",
            message="自动发送演练通过,不会真实发送" if dry_run else "策略守卫已放行,可交给发送适配器",
            idempotency_key=idempotency_key,
            adapter=adapter,
            max_per_minute=max_per_minute,
            recent_success_count=recent_count,
        )


def infer_skill_from_command(registry: SkillRegistry, command: str) -> Skill | None:
    text = str(command or "").strip()
    if not text:
        return None
    candidates = sorted(registry.all(), key=lambda item: len(item.command or ""), reverse=True)
    for skill in candidates:
        base = str(skill.command or "").strip()
        if not base:
            continue
        if text == base or text.startswith(f"{base} "):
            return skill
    return None


def automation_idempotency_key(
    plan: OutboxPlan,
    *,
    skill_key: str = "",
    source_message_id: str = "",
) -> str:
    identity_id = _identity_id(plan)
    payload = {
        "skill_key": skill_key,
        "command": plan.command.strip(),
        "identity_id": identity_id,
        "chat_id": int(plan.action.chat_id or 0),
        "target_chat": plan.target_chat,
        "reply_to_msg_id": int(plan.action.reply_to_msg_id or 0),
        "source_message_id": str(source_message_id or "").strip(),
    }
    raw = json.dumps(payload, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
    return hashlib.sha256(raw.encode("utf-8")).hexdigest()[:32]


def _identity_id(plan: OutboxPlan) -> int:
    raw = (plan.identity or {}).get("send_as_id") if plan.identity else plan.action.identity_id
    try:
        return int(raw or 0)
    except (TypeError, ValueError):
        return 0


def _settings_str_set(settings: dict, key: str) -> set[str]:
    raw = settings.get(key) or []
    if isinstance(raw, str):
        raw = raw.replace("\n", ",").split(",")
    return {str(item).strip() for item in raw if str(item or "").strip()}


def _settings_int_set(settings: dict, key: str) -> set[int]:
    values: set[int] = set()
    for item in _settings_str_set(settings, key):
        try:
            values.add(int(item))
        except (TypeError, ValueError):
            continue
    return values


def _settings_int(settings: dict, key: str, default: int, *, minimum: int, maximum: int) -> int:
    try:
        value = int(str(settings.get(key) if settings.get(key) is not None else default).strip())
    except (TypeError, ValueError):
        value = default
    return max(minimum, min(maximum, value))


def _has_successful_idempotency_key(store: AutomationLogStore, identity_id: int, key: str) -> bool:
    for row in _auto_logs(store, identity_id=identity_id, limit=500):
        if row.get("status") != "success":
            continue
        meta = row.get("meta") or {}
        if isinstance(meta, dict) and meta.get("idempotency_key") == key:
            return True
    return False


def _recent_auto_success_count(store: AutomationLogStore, identity_id: int) -> int:
    cutoff = datetime.now(timezone.utc) - timedelta(seconds=60)
    count = 0
    for row in _auto_logs(store, identity_id=identity_id, limit=500):
        if row.get("status") != "success":
            continue
        created_at = _parse_dt(row.get("created_at"))
        if created_at and created_at >= cutoff:
            count += 1
    return count


def _auto_logs(store: AutomationLogStore, *, identity_id: int, limit: int) -> list[dict]:
    list_logs = getattr(store, "list_send_logs", None)
    if not callable(list_logs):
        return []
    try:
        return list_logs(limit=limit, kind="auto_send", identity_id=identity_id)
    except Exception:
        return []


def _parse_dt(value: object) -> datetime | None:
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
