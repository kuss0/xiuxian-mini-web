"""Sender adapter boundary for guarded outbox automation.

Automation policy decides whether a command may be dispatched. Adapters only
execute already-approved send requests, which keeps future desktop-client
senders from bypassing the shared guard.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Callable, Protocol


@dataclass(frozen=True)
class SendRequest:
    skill_key: str
    identity_id: int
    chat_id: int | str
    reply_to_msg_id: int = 0
    command: str = ""
    source_message_id: str = ""


@dataclass(frozen=True)
class SendAdapterResult:
    ok: bool
    sent: bool = False
    sent_msg_id: int = 0
    command: str = ""
    error: str = ""
    adapter: str = ""
    raw: dict = field(default_factory=dict)

    def to_api(self) -> dict:
        return {
            "ok": self.ok,
            "sent": self.sent,
            "sent_msg_id": self.sent_msg_id,
            "command": self.command,
            "error": self.error,
            "adapter": self.adapter,
            "raw": self.raw,
        }


class SendAdapter(Protocol):
    name: str

    def send(self, request: SendRequest) -> SendAdapterResult:
        ...


class UserSessionSenderAdapter:
    name = "user_session"

    def __init__(self, send_func: Callable[[dict], tuple[dict, dict]]) -> None:
        self._send_func = send_func

    def send(self, request: SendRequest) -> SendAdapterResult:
        api, _context = self._send_func(
            {
                "skill_key": request.skill_key,
                "identity_id": request.identity_id,
                "chat_id": request.chat_id,
                "reply_to_msg_id": request.reply_to_msg_id,
                "command_override": request.command,
                "source_message_id": request.source_message_id,
            }
        )
        return SendAdapterResult(
            ok=bool(api.get("ok")),
            sent=bool(api.get("ok")),
            sent_msg_id=_safe_int(api.get("sent_msg_id")),
            command=str(api.get("command") or request.command),
            error=str(api.get("error") or ""),
            adapter=self.name,
            raw=api,
        )


class UnsupportedSenderAdapter:
    def __init__(self, name: str) -> None:
        self.name = str(name or "").strip() or "unknown"

    def send(self, request: SendRequest) -> SendAdapterResult:
        return SendAdapterResult(
            ok=False,
            sent=False,
            command=request.command,
            error=f"发送适配器 {self.name} 尚未接入;请保留 dry-run 或切回 user_session",
            adapter=self.name,
        )


class SenderAdapterRegistry:
    def __init__(self, adapters: list[SendAdapter] | None = None) -> None:
        self._adapters: dict[str, SendAdapter] = {}
        for adapter in adapters or []:
            self.register(adapter)

    def register(self, adapter: SendAdapter) -> None:
        name = str(adapter.name or "").strip()
        if not name:
            raise ValueError("adapter name is required")
        self._adapters[name] = adapter

    def get(self, name: str) -> SendAdapter:
        clean = str(name or "").strip() or "user_session"
        return self._adapters.get(clean) or UnsupportedSenderAdapter(clean)

    def names(self) -> list[str]:
        return sorted(self._adapters)


def _safe_int(value: object) -> int:
    try:
        return int(str(value or "0").strip() or 0)
    except (TypeError, ValueError):
        return 0
