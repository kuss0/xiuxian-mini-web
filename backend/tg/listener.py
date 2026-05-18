from __future__ import annotations

import asyncio
import threading
from dataclasses import replace
from datetime import timezone
from typing import Protocol

from backend.domain.models import RawMessageEvent
from backend.tg.client import create_telegram_client, import_telethon, parse_api_hash, parse_api_id


class EventSink(Protocol):
    def ingest_event(self, event: RawMessageEvent):
        ...


class TelegramReadOnlyListener:
    # 自愈参数:断线后退避重连,1s 起、每次翻倍、封顶 60s。
    # 连续连接 >60s 视为「真正稳定」,backoff 重置回 1s。
    _BACKOFF_INITIAL = 1.0
    _BACKOFF_MAX = 60.0
    _STABLE_UPTIME_THRESHOLD = 60.0

    def __init__(self, sink: EventSink, *, account_key: str = "default") -> None:
        self._sink = sink
        self._account_key = account_key
        self._thread: threading.Thread | None = None
        self._loop: asyncio.AbstractEventLoop | None = None
        self._client = None
        self._status = "stopped"
        self._message = ""
        self._lock = threading.Lock()
        self._stop_flag = threading.Event()

    def status(self) -> dict:
        with self._lock:
            return {"status": self._status, "message": self._message}

    def is_running(self) -> bool:
        with self._lock:
            return self._status in {"starting", "running"} and self._client is not None and self._loop is not None

    def submit(self, coro_factory, *, timeout: float = 30.0):
        """复用 listener 的已登录 client + 已开转的 loop 跑一次性查询(dialogs / topics / send-as)。
        coro_factory: callable taking the connected client, returning a coroutine.
        这样避免新开 client 抢同一 session 文件,Telethon SQLite session 不会被锁。"""
        with self._lock:
            loop = self._loop
            client = self._client
            status = self._status
        if loop is None or client is None or status not in {"starting", "running"}:
            raise RuntimeError("listener 未在运行,无法复用其 Telegram client")
        future = asyncio.run_coroutine_threadsafe(coro_factory(client), loop)
        return future.result(timeout=timeout)

    def submit_background(self, coro_factory):
        """提交一个不等结果的协程到 listener loop。

        给「拟人节奏排官方定时」这种长任务用 — 主线程不能等 30+ 分钟。
        callee 自己负责更新 DB(否则前端就看不见进度)。
        返回 concurrent.futures.Future,调用方可以选择丢掉或留着 cancel。
        """
        with self._lock:
            loop = self._loop
            client = self._client
            status = self._status
        if loop is None or client is None or status not in {"starting", "running"}:
            raise RuntimeError("listener 未在运行,无法复用其 Telegram client")
        return asyncio.run_coroutine_threadsafe(coro_factory(client), loop)

    def start(self, settings: dict) -> dict:
        with self._lock:
            if self._thread and self._thread.is_alive():
                return {"status": self._status, "message": "监听已在运行"}
            self._status = "starting"
            self._message = "正在启动只读监听"

        try:
            _validate_settings(settings)
            import_telethon()
        except Exception as exc:
            self._set_status("error", str(exc))
            return self.status()

        # 每次 start 都重置 stop 信号,允许 stop → start 重启
        self._stop_flag = threading.Event()
        self._thread = threading.Thread(
            target=self._thread_main,
            args=(dict(settings),),
            name=f"miniweb-tg-listener-{self._account_key}",
            daemon=True,
        )
        self._thread.start()
        return self.status()

    def stop(self) -> dict:
        # 1. 通知 retry loop 不要再重连
        self._stop_flag.set()
        # 2. 主动断当前 client 连接,触发 run_until_disconnected 返回
        loop = self._loop
        client = self._client
        if loop and client:
            try:
                asyncio.run_coroutine_threadsafe(client.disconnect(), loop)
            except Exception:
                pass
        self._set_status("stopping", "正在停止只读监听")
        return self.status()

    def _thread_main(self, settings: dict) -> None:
        loop = asyncio.new_event_loop()
        self._loop = loop
        asyncio.set_event_loop(loop)
        try:
            loop.run_until_complete(self._run(settings))
        except Exception as exc:
            self._set_status("error", str(exc))
        finally:
            self._client = None
            self._loop = None
            if self.status()["status"] != "error":
                self._set_status("stopped", "只读监听已停止")
            loop.close()

    async def _run(self, settings: dict) -> None:
        """带自愈的 listener 主循环:
        - 网络断 / Telethon 内部断 → run_until_disconnected 返回 → 退避重连
        - 异常 → 退避重连
        - stop() 触发 → 干净跳出
        - 已登录但失效 / 不允许 → 标记 error,不重试
        """
        telethon = import_telethon()
        target_chat = _parse_target_chat(settings.get("target_chat"))
        topic_id = _parse_optional_int(settings.get("target_topic_id"))
        backoff = self._BACKOFF_INITIAL

        while not self._stop_flag.is_set():
            client = create_telegram_client(settings)
            self._client = client
            connected_at = 0.0
            try:
                await client.connect()
                if not await client.is_user_authorized():
                    self._set_status("error", "Telegram session 未登录,请先完成验证码登录")
                    return  # 不重试,session 没登录就是无效

                @client.on(telethon.events.NewMessage(chats=target_chat, incoming=True, outgoing=True))
                async def _on_new_message(event):
                    if topic_id and _event_topic_id(event) != topic_id:
                        return
                    raw_event = _raw_event_from_telethon(event, account_key=self._account_key)
                    display_name = await _resolve_sender_display_name(event)
                    if display_name:
                        raw_event = replace(raw_event, source=display_name)
                    self._sink.ingest_event(raw_event)

                @client.on(telethon.events.MessageEdited(chats=target_chat, incoming=True, outgoing=True))
                async def _on_message_edited(event):
                    # bot 经常 send 占位 + edit 成最终结果(.战力 / .推演 等慢操作),
                    # 不监听 edited 就只能看到「正在推演...」,拿不到结果。
                    # 走和 NewMessage 完全相同的 ingest 路径(ON CONFLICT(id) DO UPDATE
                    # 在 raw_messages 上是幂等的,会用最新 text 覆盖旧 text)。
                    if topic_id and _event_topic_id(event) != topic_id:
                        return
                    raw_event = _raw_event_from_telethon(event, account_key=self._account_key)
                    display_name = await _resolve_sender_display_name(event)
                    if display_name:
                        raw_event = replace(raw_event, source=display_name)
                    # 标个 edited_at(用 message.edit_date 或 当前 UTC)
                    edit_date = getattr(event.message, "edit_date", None)
                    if edit_date is not None:
                        if getattr(edit_date, "tzinfo", None) is None:
                            edit_date = edit_date.replace(tzinfo=timezone.utc)
                        raw_event = replace(
                            raw_event,
                            edited_at=edit_date.astimezone(timezone.utc).isoformat(),
                        )
                    self._sink.ingest_event(raw_event)

                self._set_status("running", "只读监听运行中")
                connected_at = asyncio.get_event_loop().time()
                await client.run_until_disconnected()
            except asyncio.CancelledError:
                raise
            except Exception as exc:
                if self._stop_flag.is_set():
                    break
                self._set_status(
                    "reconnecting",
                    f"连接异常,{int(backoff)}s 后重连:{exc}",
                )
            finally:
                try:
                    await client.disconnect()
                except Exception:
                    pass
                self._client = None

            if self._stop_flag.is_set():
                break

            # 跑得久就说明这次是真正稳定的连接,backoff 重置
            uptime = asyncio.get_event_loop().time() - connected_at if connected_at else 0
            if uptime >= self._STABLE_UPTIME_THRESHOLD:
                backoff = self._BACKOFF_INITIAL
            else:
                backoff = min(backoff * 2, self._BACKOFF_MAX)

            self._set_status(
                "reconnecting",
                f"已断开,{int(backoff)}s 后重连(连续 backoff)",
            )
            # 用短步长 sleep,这样 stop() 能在 0.5s 内被感知
            remaining = backoff
            while remaining > 0 and not self._stop_flag.is_set():
                step = min(remaining, 0.5)
                await asyncio.sleep(step)
                remaining -= step

    def _set_status(self, status: str, message: str) -> None:
        with self._lock:
            self._status = status
            self._message = message


def _validate_settings(settings: dict) -> None:
    parse_api_id(settings.get("api_id"))
    parse_api_hash(settings.get("api_hash"))
    if not str(settings.get("target_chat") or "").strip():
        raise ValueError("请先填写目标群 / 频道")


def _parse_target_chat(value: object):
    raw = str(value or "").strip()
    if raw.startswith("-") or raw.isdigit():
        return int(raw)
    return raw


def _parse_optional_int(value: object) -> int:
    raw = str(value or "").strip()
    if not raw:
        return 0
    try:
        return int(raw)
    except ValueError:
        return 0


def _event_topic_id(event) -> int:
    message = getattr(event, "message", None)
    reply_to = getattr(message, "reply_to", None)
    return int(getattr(reply_to, "reply_to_top_id", 0) or getattr(message, "reply_to_msg_id", 0) or 0)


def _raw_event_from_telethon(event, *, account_key: str = "default") -> RawMessageEvent:
    message = event.message
    sender_id = int(getattr(event, "sender_id", 0) or 0) or None
    chat_id = int(getattr(event, "chat_id", 0) or 0)
    msg_id = int(getattr(message, "id", 0) or 0)
    date = getattr(message, "date", None)
    if date is not None:
        if getattr(date, "tzinfo", None) is None:
            date = date.replace(tzinfo=timezone.utc)
        date_text = date.astimezone(timezone.utc).isoformat()
    else:
        date_text = ""
    cached_source = _format_sender_display(getattr(message, "sender", None) or getattr(event, "sender", None))
    source = cached_source or (str(sender_id) if sender_id else "未知发送者")

    raw_reply = getattr(message, "reply_to_msg_id", None)
    reply_to = getattr(message, "reply_to", None)
    top_id = int(getattr(reply_to, "reply_to_top_id", 0) or 0) if reply_to else 0
    # Forum 群里,「在 topic X 里发首层消息」也会把 reply_to_msg_id 设成 X(topic root),
    # 但这不是「回复某条消息」。把这种「假 reply」清掉,chat UI 才不会显示「↪ 回复 X」
    # 这种误导。真实的 reply 是 reply_to_msg_id != top_id(在 topic 里 reply 到别的人)
    # 或者非 forum 群里普通的 reply_to。
    cleaned_reply = raw_reply
    if raw_reply and top_id and int(raw_reply) == top_id:
        cleaned_reply = None

    return RawMessageEvent(
        id=f"tg:{chat_id}:{msg_id}",
        chat_id=chat_id,
        msg_id=msg_id,
        text=str(getattr(message, "message", "") or ""),
        source=source,
        date=date_text,
        sender_id=sender_id,
        reply_to_msg_id=cleaned_reply,
        top_msg_id=top_id or None,
        mentions=tuple(),
        sender_is_bot=bool(getattr(getattr(message, "sender", None) or getattr(event, "sender", None), "bot", False)),
        media_meta=_message_meta_from_telethon(message),
    )


def _message_meta_from_telethon(message) -> dict | None:
    entities = _extract_text_entities(message)
    if not entities:
        return None
    return {"text_entities": entities}


def _extract_text_entities(message) -> list[dict]:
    out: list[dict] = []
    for entity in getattr(message, "entities", None) or ():
        try:
            offset = int(getattr(entity, "offset", 0) or 0)
            length = int(getattr(entity, "length", 0) or 0)
        except (TypeError, ValueError):
            continue
        if length <= 0:
            continue
        item = {
            "type": _text_entity_type(entity),
            "offset": offset,
            "length": length,
        }
        for attr in ("url", "language"):
            value = getattr(entity, attr, None)
            if value:
                item[attr] = str(value)
        for attr in ("document_id", "user_id"):
            value = getattr(entity, attr, None)
            if value:
                item[attr] = str(value)
        out.append(item)
    return out


def _text_entity_type(entity) -> str:
    name = entity.__class__.__name__
    if name == "MessageEntityCustomEmoji":
        return "custom_emoji"
    if name.startswith("MessageEntity"):
        name = name[len("MessageEntity"):]
    chars: list[str] = []
    for idx, ch in enumerate(name):
        if idx and ch.isupper() and (not name[idx - 1].isupper()):
            chars.append("_")
        chars.append(ch.lower())
    return "".join(chars) or "entity"


async def _resolve_sender_display_name(event) -> str:
    sender = getattr(event.message, "sender", None) or getattr(event, "sender", None)
    if sender is None:
        getter = getattr(event, "get_sender", None)
        if getter is not None:
            try:
                sender = await getter()
            except Exception:
                sender = None
    return _format_sender_display(sender)


def _format_sender_display(sender) -> str:
    if sender is None:
        return ""
    title = getattr(sender, "title", None)
    if title:
        return str(title).strip()
    parts = [getattr(sender, "first_name", "") or "", getattr(sender, "last_name", "") or ""]
    name = " ".join(part.strip() for part in parts if part).strip()
    if name:
        return name
    username = getattr(sender, "username", None)
    if username:
        return f"@{str(username).lstrip('@').strip()}"
    return ""
