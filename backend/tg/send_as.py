"""对照 Py 主线 model/ui.py:1932-1959 (ui_get_send_as_peers) 的最小复刻。

mini-web 不挂机,所以只复用「按账号 session 调 channels.GetSendAs 拉可用 send_as 列表」
+「按账号 session 调 get_entity 解析单个 send_as peer 信息」两段读路径。
不做 send-as 缓存(对照 Rust 主线 send_as_cache 的 4h TTL 优化是为高频自动发包准备的),
mini-web 是一次性 UI 操作,直接现拉现用即可。
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any

from backend.tg.client import (
    create_telegram_client,
    import_telethon,
    parse_api_hash,
    parse_api_id,
)


@dataclass(frozen=True)
class SendAsPeer:
    id: int
    kind: str
    title: str
    username: str
    premium_required: bool

    def to_api(self) -> dict:
        return {
            "id": str(self.id),
            "send_as_id": self.id,
            "kind": self.kind,
            "title": self.title,
            "username": self.username,
            "premium_required": self.premium_required,
        }


class SendAsService:
    async def list_send_as_peers(self, account: dict, target_chat: str) -> dict:
        chat = str(target_chat or "").strip()
        if not chat:
            raise ValueError("请先选择目标群 / 频道")

        _validate_connection_settings(account)
        client = create_telegram_client(account)
        await client.connect()
        try:
            await _ensure_authorized(client)
            return await self.list_send_as_peers_on_client(client, chat)
        finally:
            await client.disconnect()

    async def list_send_as_peers_on_client(self, client, chat: str) -> dict:
        """复用已登录 client 拉 send_as,避免新 client 抢 session。"""
        telethon = import_telethon()
        chat_entity = await client.get_entity(_parse_entity_ref(chat))
        request = telethon.functions.channels.GetSendAsRequest(peer=chat_entity)
        result = await client(request)
        peers: list[SendAsPeer] = []
        for raw_peer in getattr(result, "peers", []) or []:
            item = await _send_as_peer_to_item(client, telethon, raw_peer)
            if item is not None:
                peers.append(item)
        peers.sort(key=lambda item: (item.kind != "self", item.title.lower()))
        return {"ok": True, "peers": [item.to_api() for item in peers]}

    async def resolve_entity(self, account: dict, send_as_id: int) -> dict:
        try:
            send_as_id = int(send_as_id)
        except (TypeError, ValueError):
            raise ValueError("send_as_id 必须是数字")
        if send_as_id == 0:
            raise ValueError("send_as_id 不能为 0")

        _validate_connection_settings(account)
        client = create_telegram_client(account)
        await client.connect()
        try:
            await _ensure_authorized(client)
            return await self.resolve_entity_on_client(client, send_as_id)
        finally:
            await client.disconnect()

    async def resolve_entity_on_client(self, client, send_as_id: int) -> dict:
        try:
            send_as_id = int(send_as_id)
        except (TypeError, ValueError):
            raise ValueError("send_as_id 必须是数字")
        if send_as_id == 0:
            raise ValueError("send_as_id 不能为 0")
        entity = await client.get_entity(send_as_id)
        return {
            "ok": True,
            "send_as_id": send_as_id,
            "username": _entity_username(entity),
            "label": _entity_display_label(entity),
            "kind": _entity_kind(entity),
        }


def _validate_connection_settings(settings: dict) -> None:
    parse_api_id(settings.get("api_id"))
    parse_api_hash(settings.get("api_hash"))


async def _ensure_authorized(client) -> None:
    if not await client.is_user_authorized():
        raise RuntimeError("Telegram session 未登录,请先在账号配置里完成验证码登录")


def _parse_entity_ref(value: str) -> int | str:
    raw = str(value or "").strip()
    if raw.startswith("-") or raw.isdigit():
        try:
            return int(raw)
        except ValueError:
            return raw
    return raw


async def _send_as_peer_to_item(client, telethon, raw_peer) -> SendAsPeer | None:
    """对照 Py 主线 model/ui.py 的 send-as 解析:
    raw_peer 是 SendAsPeer (Telethon raw type),含一个 peer 子对象;
    我们 await get_entity(peer) 拿到完整 entity 才能渲染 title/username。
    """
    peer = getattr(raw_peer, "peer", None)
    if peer is None:
        return None
    try:
        peer_id = int(telethon.utils.get_peer_id(peer))
    except Exception:
        return None
    try:
        entity = await client.get_entity(peer)
    except Exception:
        entity = None
    title = _entity_display_label(entity) if entity is not None else str(peer_id)
    username = _entity_username(entity) if entity is not None else ""
    kind = _entity_kind(entity) if entity is not None else "unknown"
    premium_required = bool(getattr(raw_peer, "premium_required", False))
    return SendAsPeer(
        id=peer_id,
        kind=kind,
        title=title,
        username=username,
        premium_required=premium_required,
    )


def _entity_username(entity: Any) -> str:
    return str(getattr(entity, "username", "") or "").lstrip("@")


def _entity_display_label(entity: Any) -> str:
    title = getattr(entity, "title", None)
    if title:
        return str(title).strip()
    parts = [
        str(getattr(entity, "first_name", "") or "").strip(),
        str(getattr(entity, "last_name", "") or "").strip(),
    ]
    name = " ".join(part for part in parts if part).strip()
    if name:
        return name
    username = _entity_username(entity)
    if username:
        return f"@{username}"
    return ""


def _entity_kind(entity: Any) -> str:
    if entity is None:
        return "unknown"
    if bool(getattr(entity, "megagroup", False)):
        return "supergroup"
    if bool(getattr(entity, "broadcast", False)):
        return "channel"
    if bool(getattr(entity, "bot", False)):
        return "bot"
    if hasattr(entity, "first_name"):
        return "self"
    if hasattr(entity, "title"):
        return "group"
    return "unknown"
