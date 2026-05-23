"""Small Telethon request helpers.

Tests use fake clients and do not need the real Telethon package installed. In
production these helpers return Telethon request objects; without Telethon they
return lightweight objects with the same public attributes the fake clients
inspect.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any


@dataclass
class LiteInputReplyToMessage:
    reply_to_msg_id: int
    top_msg_id: int | None = None


@dataclass
class LiteSendMessageRequest:
    peer: Any
    message: str
    reply_to: Any = None
    send_as: Any = None
    schedule_date: Any = None


def input_reply_to_message(*, reply_to_msg_id: int, top_msg_id: int | None = None):
    kwargs = {"reply_to_msg_id": int(reply_to_msg_id)}
    if top_msg_id is not None:
        kwargs["top_msg_id"] = int(top_msg_id)
    try:
        from telethon import types
    except ModuleNotFoundError:
        return LiteInputReplyToMessage(**kwargs)
    return types.InputReplyToMessage(**kwargs)


def send_message_request(
    *,
    peer,
    message: str,
    reply_to=None,
    send_as=None,
    schedule_date=None,
):
    try:
        from telethon import functions
    except ModuleNotFoundError:
        return LiteSendMessageRequest(
            peer=peer,
            message=message,
            reply_to=reply_to,
            send_as=send_as,
            schedule_date=schedule_date,
        )
    return functions.messages.SendMessageRequest(
        peer=peer,
        message=message,
        reply_to=reply_to,
        send_as=send_as,
        schedule_date=schedule_date,
    )
