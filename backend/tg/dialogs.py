from __future__ import annotations

from dataclasses import dataclass
from typing import Any

from backend.tg.client import create_telegram_client, import_telethon, parse_api_hash, parse_api_id


@dataclass(frozen=True)
class TelegramDialog:
    id: int
    title: str
    username: str
    kind: str

    def to_api(self) -> dict:
        return {
            "id": str(self.id),
            "title": self.title,
            "username": self.username,
            "kind": self.kind,
        }


@dataclass(frozen=True)
class TelegramTopic:
    id: int
    title: str

    def to_api(self) -> dict:
        return {"id": str(self.id), "title": self.title}


@dataclass(frozen=True)
class TelegramBot:
    id: int
    username: str
    title: str

    def to_api(self) -> dict:
        return {
            "id": str(self.id),
            "username": self.username,
            "title": self.title,
        }


class TelegramDialogService:
    async def list_dialogs(self, settings: dict) -> dict:
        _validate_connection_settings(settings)
        client = create_telegram_client(settings)
        await client.connect()
        try:
            await _ensure_authorized(client)
            return await self.list_dialogs_on_client(client)
        finally:
            await client.disconnect()

    async def list_dialogs_on_client(self, client) -> dict:
        """复用一个已经登录的 client 拉 dialogs。供 listener.submit() 用。"""
        telethon = import_telethon()
        dialogs: list[TelegramDialog] = []
        async for dialog in client.iter_dialogs():
            item = _dialog_to_item(telethon, dialog)
            if item is not None:
                dialogs.append(item)
        dialogs.sort(key=lambda item: (item.kind != "supergroup", item.title.lower()))
        return {"ok": True, "dialogs": [item.to_api() for item in dialogs]}

    async def list_topics(self, settings: dict, chat: str | None = None) -> dict:
        target_chat = str(chat or settings.get("target_chat") or "").strip()
        if not target_chat:
            raise ValueError("请先选择目标群 / 频道")

        _validate_connection_settings(settings)
        client = create_telegram_client(settings)
        await client.connect()
        try:
            await _ensure_authorized(client)
            return await self.list_topics_on_client(client, target_chat)
        finally:
            await client.disconnect()

    async def list_topics_on_client(self, client, chat: str) -> dict:
        telethon = import_telethon()
        entity = await client.get_entity(_parse_entity_ref(chat))
        topics = await _load_forum_topics(telethon, client, entity)
        return {"ok": True, "topics": [topic.to_api() for topic in topics]}

    async def list_chat_bots(self, settings: dict, chat: str | None = None) -> dict:
        """游戏 bot 识别:把目标群里所有 bot 类型用户拉出来,前端勾选哪些是游戏
        机器人 → 写 game_bot_ids。
        """
        target_chat = str(chat or settings.get("target_chat") or "").strip()
        if not target_chat:
            raise ValueError("请先选择目标群 / 频道")

        _validate_connection_settings(settings)
        telethon = import_telethon()
        client = create_telegram_client(settings)
        await client.connect()
        try:
            await _ensure_authorized(client)
            entity = await client.get_entity(_parse_entity_ref(target_chat))
            bots: list[TelegramBot] = []
            try:
                async for participant in client.iter_participants(
                    entity, filter=telethon.tl.types.ChannelParticipantsBots()
                ):
                    item = _user_to_bot_item(participant)
                    if item is not None:
                        bots.append(item)
            except Exception:
                # 某些群/频道(比如普通群)不支持 ChannelParticipantsBots filter,
                # 退而求其次:遍历前 200 个成员,自己挑 bot
                async for participant in client.iter_participants(entity, limit=200):
                    if not bool(getattr(participant, "bot", False)):
                        continue
                    item = _user_to_bot_item(participant)
                    if item is not None:
                        bots.append(item)
            bots.sort(key=lambda item: item.title.lower())
            return {"ok": True, "bots": [item.to_api() for item in bots]}
        finally:
            await client.disconnect()


def _validate_connection_settings(settings: dict) -> None:
    parse_api_id(settings.get("api_id"))
    parse_api_hash(settings.get("api_hash"))


async def _ensure_authorized(client) -> None:
    if not await client.is_user_authorized():
        raise RuntimeError("Telegram session 未登录，请先完成验证码登录")


def _dialog_to_item(telethon, dialog) -> TelegramDialog | None:
    entity = getattr(dialog, "entity", None)
    if entity is None:
        return None
    kind = _entity_kind(entity)
    if kind not in {"group", "supergroup", "channel"}:
        return None

    peer_id = int(telethon.utils.get_peer_id(entity))
    title = str(getattr(dialog, "title", "") or getattr(entity, "title", "") or peer_id)
    username = str(getattr(entity, "username", "") or "")
    return TelegramDialog(id=peer_id, title=title, username=username, kind=kind)


def _entity_kind(entity: Any) -> str:
    if bool(getattr(entity, "megagroup", False)):
        return "supergroup"
    if bool(getattr(entity, "broadcast", False)):
        return "channel"
    if hasattr(entity, "title"):
        return "group"
    return "private"


def _parse_entity_ref(value: str) -> int | str:
    raw = str(value or "").strip()
    if raw.startswith("-") or raw.isdigit():
        try:
            return int(raw)
        except ValueError:
            return raw
    return raw


async def _load_forum_topics(telethon, client, entity) -> list[TelegramTopic]:
    if not bool(getattr(entity, "forum", False)):
        return []

    try:
        request = telethon.functions.channels.GetForumTopicsRequest(
            channel=entity,
            offset_date=0,
            offset_id=0,
            offset_topic=0,
            limit=100,
        )
    except AttributeError:
        return []

    result = await client(request)
    topics = []
    for topic in getattr(result, "topics", []) or []:
        if bool(getattr(topic, "deleted", False)):
            continue
        topic_id = int(getattr(topic, "id", 0) or 0)
        if topic_id <= 0:
            continue
        title = str(getattr(topic, "title", "") or topic_id)
        topics.append(TelegramTopic(id=topic_id, title=title))
    topics.sort(key=lambda item: item.id)
    return topics


def _user_to_bot_item(user) -> TelegramBot | None:
    if user is None:
        return None
    user_id = int(getattr(user, "id", 0) or 0)
    if user_id == 0:
        return None
    username = str(getattr(user, "username", "") or "").lstrip("@")
    parts = [
        str(getattr(user, "first_name", "") or "").strip(),
        str(getattr(user, "last_name", "") or "").strip(),
    ]
    title = " ".join(part for part in parts if part).strip() or (
        f"@{username}" if username else f"bot {user_id}"
    )
    return TelegramBot(id=user_id, username=username, title=title)
