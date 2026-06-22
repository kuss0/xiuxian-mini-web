from __future__ import annotations

from dataclasses import dataclass
from typing import Mapping


@dataclass(frozen=True)
class LogCommandPolicy:
    enabled: bool = False
    admin_ids: tuple[int, ...] = ()
    chat_id: int = 0
    mapping_chat_id: int = 0

    @classmethod
    def from_settings(cls, settings: Mapping[str, object] | None) -> "LogCommandPolicy":
        settings = settings or {}
        return cls(
            enabled=_bool_value(settings.get("log_command_enabled")),
            admin_ids=tuple(_int_items(settings.get("log_command_admin_ids"))),
            chat_id=_safe_int(settings.get("log_command_chat_id")),
            mapping_chat_id=_safe_int(settings.get("log_command_mapping_chat_id")),
        )

    @property
    def effective_mapping_chat_id(self) -> int:
        return self.mapping_chat_id or self.chat_id

    def to_api(self) -> dict:
        return {
            "enabled": self.enabled,
            "admin_count": len(self.admin_ids),
            "chat_configured": bool(self.chat_id),
            "mapping_chat_configured": bool(self.effective_mapping_chat_id),
            "group_members_allowed": bool(self.effective_mapping_chat_id),
            "group_members_admin": bool(self.chat_id or self.effective_mapping_chat_id),
        }


@dataclass(frozen=True)
class IngressDecision:
    kind: str
    reason: str = ""
    text: str = ""
    ingress: str = ""
    mapping: str = ""
    is_admin: bool = False

    def to_api(self) -> dict:
        payload = {
            "kind": self.kind,
            "is_admin": self.is_admin,
        }
        if self.reason:
            payload["reason"] = self.reason
        if self.text:
            payload["text"] = self.text
        if self.ingress:
            payload["ingress"] = self.ingress
        if self.mapping:
            payload["mapping"] = self.mapping
        return payload


def classify_telegram_ingress(
    *,
    policy: LogCommandPolicy,
    text: str,
    user_id: int,
    chat_id: int,
    dot_log_command: bool = False,
    plain_log_command: bool = False,
) -> IngressDecision:
    if not policy.enabled:
        return IngressDecision(
            "reject",
            reason="command_listener_disabled",
            text="日志群命令未启用。",
        )

    in_log_group = bool(policy.chat_id) and int(chat_id or 0) == policy.chat_id
    mapping_chat_id = policy.effective_mapping_chat_id
    in_mapping_group = bool(mapping_chat_id) and int(chat_id or 0) == mapping_chat_id
    explicit_admin = int(user_id or 0) in policy.admin_ids
    group_member_admin = in_log_group or in_mapping_group
    is_admin = explicit_admin or group_member_admin
    admin_dm = explicit_admin and int(chat_id or 0) == int(user_id or 0)

    def allow_log_command() -> IngressDecision:
        if not is_admin:
            return IngressDecision("skip", reason="not_admin", is_admin=False)
        if not policy.chat_id and not policy.admin_ids:
            return IngressDecision(
                "reject",
                reason="chat_not_configured",
                text="日志群命令未配置 log_command_chat_id/log_command_admin_ids,不接受 Telegram 入站。",
                is_admin=True,
            )
        if not in_log_group and not admin_dm:
            return IngressDecision("skip", reason="chat_not_allowed", is_admin=True)
        return IngressDecision(
            "run",
            ingress="telegram_group" if in_log_group else "telegram_admin_dm",
            is_admin=True,
        )

    if text.startswith("/"):
        return allow_log_command()

    if text.startswith("."):
        if dot_log_command:
            return allow_log_command()
        if not in_mapping_group:
            return IngressDecision(
                "skip",
                reason="mapping_chat_not_allowed",
                is_admin=is_admin,
            )
        return IngressDecision(
            "run",
            ingress="telegram_mapping",
            mapping="group",
            is_admin=is_admin,
        )

    if plain_log_command:
        return allow_log_command()

    return IngressDecision("skip", reason="not_a_log_command", is_admin=is_admin)


def _int_items(raw: object) -> list[int]:
    out: list[int] = []
    for item in _str_items(raw):
        value = _safe_int(item)
        if value:
            out.append(value)
    return sorted(set(out))


def _str_items(raw: object) -> list[str]:
    if raw is None:
        return []
    if isinstance(raw, str):
        raw = raw.replace("\n", ",").split(",")
    if not isinstance(raw, (list, tuple, set)):
        raw = [raw]
    return [str(item).strip() for item in raw if str(item or "").strip()]


def _safe_int(value: object) -> int:
    try:
        return int(str(value or "0").strip() or 0)
    except (TypeError, ValueError):
        return 0


def _bool_value(value: object) -> bool:
    if isinstance(value, bool):
        return value
    return str(value or "").strip().lower() in {"1", "true", "yes", "on"}
