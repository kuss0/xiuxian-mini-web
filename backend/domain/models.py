from __future__ import annotations

from dataclasses import asdict, dataclass, field
from datetime import datetime, timezone
from typing import Any


def utc_now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


@dataclass(frozen=True)
class Channel:
    key: str
    label: str
    description: str

    def to_api(self) -> dict[str, Any]:
        return asdict(self)


@dataclass(frozen=True)
class RawMessageEvent:
    id: str
    chat_id: int
    msg_id: int
    text: str
    source: str
    date: str
    sender_id: int | None = None
    reply_to_msg_id: int | None = None
    top_msg_id: int | None = None
    mentions: tuple[str, ...] = ()
    sender_is_bot: bool = False
    edited_at: str | None = None
    deleted_at: str | None = None
    media_kind: str | None = None
    media_meta: dict[str, Any] | None = None


@dataclass(frozen=True)
class ActionSuggestion:
    type: str
    label: str
    command: str
    target: str | None = None
    chat_id: int | None = None
    reply_to_msg_id: int | None = None
    account_local_id: str | None = None
    identity_id: int | None = None
    send_mode: str = "copy"

    def to_api(self) -> dict[str, Any]:
        payload: dict[str, Any] = {
            "type": self.type,
            "label": self.label,
            "command": self.command,
            "send_mode": self.send_mode,
        }
        if self.target:
            payload["target"] = self.target
        if self.chat_id is not None:
            payload["chat_id"] = self.chat_id
        if self.reply_to_msg_id is not None:
            payload["reply_to_msg_id"] = self.reply_to_msg_id
        if self.account_local_id:
            payload["account_local_id"] = self.account_local_id
        if self.identity_id is not None:
            payload["identity_id"] = self.identity_id
        return payload

    @classmethod
    def from_api(cls, payload: dict[str, Any]) -> ActionSuggestion:
        chat_id = payload.get("chat_id")
        reply_to_msg_id = payload.get("reply_to_msg_id")
        identity_id = payload.get("identity_id")
        return cls(
            type=str(payload.get("type") or ""),
            label=str(payload.get("label") or ""),
            command=str(payload.get("command") or ""),
            target=payload.get("target"),
            chat_id=int(chat_id) if chat_id is not None else None,
            reply_to_msg_id=int(reply_to_msg_id) if reply_to_msg_id is not None else None,
            account_local_id=payload.get("account_local_id"),
            identity_id=int(identity_id) if identity_id is not None else None,
            send_mode=str(payload.get("send_mode") or "copy"),
        )


@dataclass(frozen=True)
class OutboxDraft:
    id: str
    command: str
    chat_id: int | None = None
    target_chat: str = ""
    reply_to_msg_id: int | None = None
    account_local_id: str = ""
    identity_id: int | None = None
    send_as_id: int | None = None
    source_message_id: str = ""
    send_mode: str = "copy"
    status: str = "draft"
    resolved: bool = False
    missing: tuple[str, ...] = ()
    created_at: str = ""
    note: str = ""

    def to_api(self) -> dict[str, Any]:
        return {
            "id": self.id,
            "command": self.command,
            "chat_id": self.chat_id,
            "target_chat": self.target_chat,
            "reply_to_msg_id": self.reply_to_msg_id,
            "account_local_id": self.account_local_id,
            "identity_id": self.identity_id,
            "send_as_id": self.send_as_id,
            "source_message_id": self.source_message_id,
            "send_mode": self.send_mode,
            "status": self.status,
            "resolved": self.resolved,
            "missing": list(self.missing),
            "created_at": self.created_at,
            "note": self.note,
        }

    @classmethod
    def from_api(cls, payload: dict[str, Any]) -> OutboxDraft:
        chat_id = payload.get("chat_id")
        reply_to_msg_id = payload.get("reply_to_msg_id")
        identity_id = payload.get("identity_id")
        send_as_id = payload.get("send_as_id")
        raw_missing = payload.get("missing") or ()
        if isinstance(raw_missing, str):
            raw_missing = [item.strip() for item in raw_missing.split(",") if item.strip()]
        return cls(
            id=str(payload.get("id") or ""),
            command=str(payload.get("command") or ""),
            chat_id=int(chat_id) if chat_id is not None else None,
            target_chat=str(payload.get("target_chat") or ""),
            reply_to_msg_id=int(reply_to_msg_id) if reply_to_msg_id is not None else None,
            account_local_id=str(payload.get("account_local_id") or ""),
            identity_id=int(identity_id) if identity_id is not None else None,
            send_as_id=int(send_as_id) if send_as_id is not None else None,
            source_message_id=str(payload.get("source_message_id") or ""),
            send_mode=str(payload.get("send_mode") or "copy"),
            status=str(payload.get("status") or "draft"),
            resolved=bool(payload.get("resolved")),
            missing=tuple(str(item) for item in raw_missing),
            created_at=str(payload.get("created_at") or ""),
            note=str(payload.get("note") or ""),
        )


@dataclass(frozen=True)
class StatePatch:
    scope: str
    key: str
    value: Any
    source_message_id: str
    updated_at: str = ""
    send_as_id: int = 0  # 哪个身份的状态(0 = 未知 / 全局)

    def to_api(self) -> dict[str, Any]:
        return {
            "scope": self.scope,
            "key": self.key,
            "value": self.value,
            "source_message_id": self.source_message_id,
            "updated_at": self.updated_at,
            "send_as_id": self.send_as_id,
        }

    @classmethod
    def from_api(cls, payload: dict[str, Any]) -> StatePatch:
        return cls(
            scope=str(payload.get("scope") or ""),
            key=str(payload.get("key") or ""),
            value=payload.get("value"),
            source_message_id=str(payload.get("source_message_id") or ""),
            updated_at=str(payload.get("updated_at") or ""),
        )


@dataclass(frozen=True)
class ResourceDelta:
    raw_message_id: str
    source_type: str
    resource_name: str
    amount: int
    event_time: str
    source_name: str = ""
    player: str = ""
    unit: str = ""
    basis: str = "event"
    chat_id: int = 0
    msg_id: int = 0
    meta: dict[str, Any] = field(default_factory=dict)

    def to_api(self) -> dict[str, Any]:
        return {
            "raw_message_id": self.raw_message_id,
            "source_type": self.source_type,
            "source_name": self.source_name,
            "player": self.player,
            "resource_name": self.resource_name,
            "amount": self.amount,
            "unit": self.unit,
            "basis": self.basis,
            "event_time": self.event_time,
            "chat_id": self.chat_id,
            "msg_id": self.msg_id,
            "meta": self.meta,
        }


@dataclass(frozen=True)
class ParsedCard:
    id: str
    channels: tuple[str, ...]
    title: str
    summary: str
    source: str
    time: str
    tags: tuple[str, ...]
    raw: str
    fields: dict[str, Any] = field(default_factory=dict)
    actions: tuple[ActionSuggestion, ...] = ()
    severity: str = "normal"
    # 透传自 RawMessageEvent,用于 chat UI 回复链 / 模式过滤
    chat_id: int | None = None
    msg_id: int | None = None
    sender_id: int | None = None
    reply_to_msg_id: int | None = None
    # 编辑 / 删除标记 + 媒体元数据(不下载本体,只记类型+轻量 meta)
    edited_at: str | None = None
    deleted_at: str | None = None
    media_kind: str | None = None
    media_meta: dict[str, Any] | None = None

    @property
    def primary_channel(self) -> str:
        return self.channels[0] if self.channels else "hall"

    def to_api(self) -> dict[str, Any]:
        return {
            "id": self.id,
            "channel": self.primary_channel,
            "channels": list(self.channels),
            "title": self.title,
            "summary": self.summary,
            "source": self.source,
            "time": self.time,
            "tags": list(self.tags),
            "raw": self.raw,
            "fields": self.fields,
            "actions": [action.to_api() for action in self.actions],
            "severity": self.severity,
            "chat_id": self.chat_id,
            "msg_id": self.msg_id,
            "sender_id": self.sender_id,
            "reply_to_msg_id": self.reply_to_msg_id,
            "edited_at": self.edited_at,
            "deleted_at": self.deleted_at,
            "media_kind": self.media_kind,
            "media_meta": self.media_meta,
        }

    @classmethod
    def from_api(cls, payload: dict[str, Any]) -> ParsedCard:
        def _opt_int(value):
            if value is None or value == "":
                return None
            try:
                return int(value)
            except (TypeError, ValueError):
                return None
        return cls(
            id=str(payload["id"]),
            channels=tuple(payload.get("channels") or [payload.get("channel") or "world"]),
            title=str(payload.get("title") or ""),
            summary=str(payload.get("summary") or ""),
            source=str(payload.get("source") or ""),
            time=str(payload.get("time") or ""),
            tags=tuple(payload.get("tags") or ()),
            raw=str(payload.get("raw") or ""),
            fields=dict(payload.get("fields") or {}),
            actions=tuple(ActionSuggestion.from_api(action) for action in payload.get("actions") or ()),
            severity=str(payload.get("severity") or "normal"),
            chat_id=_opt_int(payload.get("chat_id")),
            msg_id=_opt_int(payload.get("msg_id")),
            sender_id=_opt_int(payload.get("sender_id")),
            reply_to_msg_id=_opt_int(payload.get("reply_to_msg_id")),
            edited_at=(str(payload["edited_at"]) if payload.get("edited_at") else None),
            deleted_at=(str(payload["deleted_at"]) if payload.get("deleted_at") else None),
            media_kind=(str(payload["media_kind"]) if payload.get("media_kind") else None),
            media_meta=(dict(payload["media_meta"]) if isinstance(payload.get("media_meta"), dict) else None),
        )
