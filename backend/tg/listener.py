from __future__ import annotations

import asyncio
import os
import sqlite3
import threading
from concurrent.futures import TimeoutError as FutureTimeoutError
from dataclasses import replace
from datetime import timezone
from typing import Protocol

from backend.domain.models import RawMessageEvent
from backend.tg.client import create_telegram_client, import_telethon, parse_api_hash, parse_api_id


def _env_int(name: str, default: int) -> int:
    raw = os.environ.get(name)
    if raw is None or str(raw).strip() == "":
        return default
    try:
        return int(str(raw).strip())
    except ValueError:
        return default


def _env_float(name: str, default: float) -> float:
    raw = os.environ.get(name)
    if raw is None or str(raw).strip() == "":
        return default
    try:
        return float(str(raw).strip())
    except ValueError:
        return default


def _env_bool(name: str, default: bool) -> bool:
    raw = os.environ.get(name)
    if raw is None or str(raw).strip() == "":
        return default
    return str(raw).strip().lower() in {"1", "true", "yes", "on"}


class EventSink(Protocol):
    def ingest_event(self, event: RawMessageEvent):
        ...

    def latest_message_id(self, chat_id: int, topic_id: int = 0) -> int:
        ...

    def message_id_gaps(self, chat_id: int, topic_id: int = 0, **kwargs) -> list[dict]:
        ...

    def has_message(self, chat_id: int, msg_id: int, topic_id: int = 0) -> bool:
        ...


class TelegramReadOnlyListener:
    # 自愈参数:断线后退避重连,1s 起、每次翻倍、封顶 60s。
    # 连续连接 >60s 视为「真正稳定」,backoff 重置回 1s。
    _BACKOFF_INITIAL = 1.0
    _BACKOFF_MAX = 60.0
    _STABLE_UPTIME_THRESHOLD = 60.0
    _HISTORY_BACKFILL_LIMIT = _env_int("MINIWEB_HISTORY_BACKFILL_LIMIT", 240)
    _HISTORY_BOOTSTRAP_LIMIT = _env_int("MINIWEB_HISTORY_BOOTSTRAP_LIMIT", 120)
    _HISTORY_GAP_SCAN_LIMIT = _env_int("MINIWEB_HISTORY_GAP_SCAN_LIMIT", 8)
    _HISTORY_GAP_MIN_SECONDS = _env_int("MINIWEB_HISTORY_GAP_MIN_SECONDS", 60)
    _HISTORY_GAP_MIN_MISSING = _env_int("MINIWEB_HISTORY_GAP_MIN_MISSING", 20)
    _HISTORY_GAP_RANGE_LIMIT = _env_int("MINIWEB_HISTORY_GAP_RANGE_LIMIT", 120)
    _HISTORY_GAP_MAX_PAGES = _env_int("MINIWEB_HISTORY_GAP_MAX_PAGES", 1)
    _HISTORY_YIELD_EVERY = _env_int("MINIWEB_HISTORY_YIELD_EVERY", 30)
    _HISTORY_YIELD_SEC = _env_float("MINIWEB_HISTORY_YIELD_SEC", 0.03)
    _HISTORY_STATUS_EVERY = _env_int("MINIWEB_HISTORY_STATUS_EVERY", 60)
    _HISTORY_BACKFILL_REPLY_PARENTS = _env_bool("MINIWEB_HISTORY_BACKFILL_REPLY_PARENTS", False)
    _HISTORY_BACKFILL_TIME_BUDGET_SEC = _env_float("MINIWEB_HISTORY_BACKFILL_TIME_BUDGET_SEC", 8.0)
    _INGEST_BUSY_ATTEMPTS = 6
    _INGEST_BUSY_BASE_SLEEP = 0.2

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
        try:
            return future.result(timeout=timeout)
        except FutureTimeoutError as exc:
            future.cancel()
            raise TimeoutError(f"Telegram client 查询超时({timeout:.0f}s)") from exc

    def submit_background(self, coro_factory):
        """提交一个不等结果的协程到 listener loop。

        给「后台批量排官方定时」这种长任务用 — 主线程不能等它跑完。
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

    async def backfill_message_gaps(
        self,
        client,
        target_chat,
        topic_id: int = 0,
        *,
        since_hours: int = 24,
        min_gap_seconds: int | None = None,
        min_missing_msg_ids: int | None = None,
        limit: int | None = None,
        time_budget_sec: float | None = None,
    ) -> dict:
        """Manually backfill recent msg_id gaps using this listener's client."""
        parsed_target_chat = _parse_target_chat(target_chat)
        chat_id = _target_chat_storage_id(target_chat)
        if not chat_id:
            return {"ok": False, "error": "监听目标群不是数字 chat_id,无法按 msg_id 补采"}
        try:
            entity = await client.get_entity(parsed_target_chat)
        except Exception as exc:
            return {"ok": False, "error": f"定位监听目标失败:{exc}"}

        gap_limit = max(1, int(limit or self._HISTORY_GAP_SCAN_LIMIT or 8))
        gap_seconds = self._HISTORY_GAP_MIN_SECONDS if min_gap_seconds is None else int(min_gap_seconds)
        gap_missing = self._HISTORY_GAP_MIN_MISSING if min_missing_msg_ids is None else int(min_missing_msg_ids)
        gaps = self._known_message_gaps(
            chat_id,
            int(topic_id or 0),
            since_hours=since_hours,
            min_gap_seconds=gap_seconds,
            min_missing_msg_ids=gap_missing,
            limit=gap_limit,
        )
        if not gaps:
            return {
                "ok": True,
                "status": "no_gaps",
                "ranges": 0,
                "scanned": 0,
                "ingested": 0,
                "gaps": [],
                "message": "没有命中需要补采的近期空窗",
            }

        started_at = asyncio.get_running_loop().time()
        self._set_status("running", f"手动补采空窗中 {len(gaps)} 段")
        ranges, scanned, ingested = await self._backfill_known_gaps(
            client,
            entity,
            chat_id,
            int(topic_id or 0),
            gaps=gaps,
            started_at=started_at,
            time_budget_sec=time_budget_sec,
        )
        budget_reached = self._history_time_budget_reached(started_at, budget_sec=time_budget_sec)
        message = f"手动补采空窗 {ranges} 段/{ingested} 条"
        if budget_reached:
            message += ",已到预算"
        self._set_status("running", f"只读监听运行中｜{message}")
        return {
            "ok": True,
            "status": "budget_reached" if budget_reached else "ok",
            "ranges": ranges,
            "scanned": scanned,
            "ingested": ingested,
            "gaps": gaps,
            "message": message,
        }

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
                    if _message_is_scheduled_placeholder(getattr(event, "message", None)):
                        return
                    if topic_id and _event_topic_id(event) != topic_id:
                        return
                    raw_event = _raw_event_from_telethon(event, account_key=self._account_key)
                    display_name = await _resolve_sender_display_name(event)
                    if display_name:
                        raw_event = replace(raw_event, source=display_name)
                    await self._ingest_event_and_parent(
                        client,
                        target_chat,
                        raw_event,
                        chat_id=int(getattr(event, "chat_id", 0) or 0),
                        topic_id=topic_id,
                    )

                @client.on(telethon.events.MessageEdited(chats=target_chat, incoming=True, outgoing=True))
                async def _on_message_edited(event):
                    # bot 经常 send 占位 + edit 成最终结果(.战力 / .推演 等慢操作),
                    # 不监听 edited 就只能看到「正在推演...」,拿不到结果。
                    # 走和 NewMessage 完全相同的 ingest 路径(ON CONFLICT(id) DO UPDATE
                    # 在 raw_messages 上是幂等的,会用最新 text 覆盖旧 text)。
                    if _message_is_scheduled_placeholder(getattr(event, "message", None)):
                        return
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
                    await self._ingest_event_and_parent(
                        client,
                        target_chat,
                        raw_event,
                        chat_id=int(getattr(event, "chat_id", 0) or 0),
                        topic_id=topic_id,
                    )

                self._set_status("running", "历史补采中")
                backfill_message = await self._backfill_history(client, target_chat, topic_id)
                self._set_status("running", backfill_message or "只读监听运行中")
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

    async def _backfill_history(self, client, target_chat, topic_id: int) -> str:
        chat_id = _target_chat_storage_id(target_chat)
        if not chat_id:
            return "只读监听运行中"
        latest_msg_id = self._latest_ingested_message_id(chat_id, topic_id)
        limit = self._HISTORY_BACKFILL_LIMIT if latest_msg_id > 0 else self._HISTORY_BOOTSTRAP_LIMIT
        if limit <= 0:
            return "只读监听运行中"

        try:
            entity = await client.get_entity(target_chat)
        except Exception as exc:
            print(f"[mini-web] history backfill skipped: get_entity failed: {exc}")
            return f"只读监听运行中｜历史补采跳过:{exc}"

        scanned = 0
        ingested = 0
        gap_ranges = 0
        gap_ingested = 0
        budget_reached = False
        started_at = asyncio.get_running_loop().time()
        try:
            if latest_msg_id > 0:
                async for message in client.iter_messages(
                    entity,
                    min_id=latest_msg_id,
                    reverse=True,
                    limit=limit,
                ):
                    if self._stop_flag.is_set():
                        break
                    scanned += 1
                    if _message_is_scheduled_placeholder(message):
                        continue
                    if topic_id and _message_topic_id(message) != topic_id:
                        continue
                    raw_event = await _raw_event_from_message(
                        message,
                        chat_id=chat_id,
                        account_key=self._account_key,
                    )
                    if await self._ingest_event_and_parent(
                        client,
                        entity,
                        raw_event,
                        chat_id=chat_id,
                        topic_id=topic_id,
                        backfill_reply_parent=self._HISTORY_BACKFILL_REPLY_PARENTS,
                    ):
                        ingested += 1
                    await self._maybe_yield_history(scanned, ingested=ingested, limit=limit)
                    if self._history_time_budget_reached(started_at):
                        budget_reached = True
                        break
                if self._HISTORY_GAP_SCAN_LIMIT > 0:
                    gap_started_at = asyncio.get_running_loop().time()
                    gap_ranges, gap_scanned, gap_ingested = await self._backfill_known_gaps(
                        client,
                        entity,
                        chat_id,
                        topic_id,
                        started_at=gap_started_at,
                    )
                    scanned += gap_scanned
                    ingested += gap_ingested
                    budget_reached = budget_reached or self._history_time_budget_reached(gap_started_at)
            else:
                recent = []
                async for message in client.iter_messages(entity, limit=limit):
                    if self._stop_flag.is_set():
                        break
                    recent.append(message)
                scanned = len(recent)
                for message in reversed(recent):
                    if self._stop_flag.is_set():
                        break
                    if _message_is_scheduled_placeholder(message):
                        continue
                    if topic_id and _message_topic_id(message) != topic_id:
                        continue
                    raw_event = await _raw_event_from_message(
                        message,
                        chat_id=chat_id,
                        account_key=self._account_key,
                    )
                    if await self._ingest_event_and_parent(
                        client,
                        entity,
                        raw_event,
                        chat_id=chat_id,
                        topic_id=topic_id,
                        backfill_reply_parent=self._HISTORY_BACKFILL_REPLY_PARENTS,
                    ):
                        ingested += 1
                    await self._maybe_yield_history(scanned, ingested=ingested, limit=limit)
                    if self._history_time_budget_reached(started_at):
                        budget_reached = True
                        break
        except Exception as exc:
            print(f"[mini-web] history backfill failed: {exc}")
            return f"只读监听运行中｜历史补采失败:{exc}"

        if gap_ranges:
            suffix = f"只读监听运行中｜历史补采 {ingested} 条，修补空窗 {gap_ranges} 段/{gap_ingested} 条"
            if budget_reached:
                budget = max(0.0, float(self._HISTORY_BACKFILL_TIME_BUDGET_SEC or 0.0))
                suffix += f"，已到轻量预算 {budget:g}s"
            return suffix
        if budget_reached:
            budget = max(0.0, float(self._HISTORY_BACKFILL_TIME_BUDGET_SEC or 0.0))
            return f"只读监听运行中｜历史补采 {ingested} 条，已到轻量预算 {budget:g}s"
        if scanned >= limit and latest_msg_id > 0:
            return f"只读监听运行中｜历史补采 {ingested} 条，已达上限 {limit}"
        if ingested:
            return f"只读监听运行中｜历史补采 {ingested} 条"
        if scanned:
            return f"只读监听运行中｜历史补采扫描 {scanned} 条，无新增入库"
        return "只读监听运行中｜历史补采无新增"

    async def _backfill_known_gaps(
        self,
        client,
        entity,
        chat_id: int,
        topic_id: int,
        *,
        gaps: list[dict] | None = None,
        started_at: float | None = None,
        time_budget_sec: float | None = None,
    ) -> tuple[int, int, int]:
        gaps = gaps if gaps is not None else self._known_message_gaps(chat_id, topic_id)
        ranges = 0
        scanned = 0
        ingested = 0
        for gap in gaps:
            if self._stop_flag.is_set():
                break
            after_id = int(gap.get("after_msg_id") or 0)
            before_id = int(gap.get("before_msg_id") or 0)
            if after_id <= 0 or before_id <= after_id + 1:
                continue
            ranges += 1
            pages = 0
            while after_id < before_id - 1 and pages < self._HISTORY_GAP_MAX_PAGES:
                pages += 1
                range_limit = min(self._HISTORY_GAP_RANGE_LIMIT, before_id - after_id - 1)
                last_scanned_id = after_id
                async for message in client.iter_messages(
                    entity,
                    min_id=after_id,
                    max_id=before_id,
                    reverse=True,
                    limit=range_limit,
                ):
                    if self._stop_flag.is_set():
                        break
                    scanned += 1
                    msg_id = int(getattr(message, "id", 0) or 0)
                    if msg_id > last_scanned_id:
                        last_scanned_id = msg_id
                    if _message_is_scheduled_placeholder(message):
                        continue
                    if topic_id and _message_topic_id(message) != topic_id:
                        continue
                    raw_event = await _raw_event_from_message(
                        message,
                        chat_id=chat_id,
                        account_key=self._account_key,
                    )
                    if await self._ingest_event_and_parent(
                        client,
                        entity,
                        raw_event,
                        chat_id=chat_id,
                        topic_id=topic_id,
                        backfill_reply_parent=self._HISTORY_BACKFILL_REPLY_PARENTS,
                    ):
                        ingested += 1
                    await self._maybe_yield_history(scanned, ingested=ingested, limit=range_limit)
                    if self._history_time_budget_reached(started_at, budget_sec=time_budget_sec):
                        break
                if self._stop_flag.is_set() or last_scanned_id <= after_id or self._history_time_budget_reached(started_at, budget_sec=time_budget_sec):
                    break
                after_id = last_scanned_id
            if self._history_time_budget_reached(started_at, budget_sec=time_budget_sec):
                break
        return ranges, scanned, ingested

    async def _maybe_yield_history(self, scanned: int, *, ingested: int | None = None, limit: int | None = None) -> None:
        status_every = max(0, int(self._HISTORY_STATUS_EVERY or 0))
        if status_every > 0 and scanned > 0 and scanned % status_every == 0:
            suffix = f"历史补采中 {scanned}"
            if limit:
                suffix += f"/{limit}"
            if ingested is not None:
                suffix += f"，入库 {ingested}"
            self._set_status("running", suffix)
        every = max(0, int(self._HISTORY_YIELD_EVERY or 0))
        if every <= 0 or scanned <= 0 or scanned % every:
            return
        await asyncio.sleep(max(0.0, float(self._HISTORY_YIELD_SEC or 0.0)))

    def _history_time_budget_reached(self, started_at: float | None, *, budget_sec: float | None = None) -> bool:
        budget = max(0.0, float(self._HISTORY_BACKFILL_TIME_BUDGET_SEC if budget_sec is None else budget_sec or 0.0))
        if started_at is None or budget <= 0:
            return False
        try:
            return asyncio.get_running_loop().time() - float(started_at) >= budget
        except RuntimeError:
            return False

    def _latest_ingested_message_id(self, chat_id: int, topic_id: int) -> int:
        getter = getattr(self._sink, "latest_message_id", None)
        if not callable(getter):
            return 0
        try:
            return int(getter(int(chat_id), int(topic_id or 0)) or 0)
        except Exception as exc:
            print(f"[mini-web] latest_message_id failed: {exc}")
            return 0

    def _known_message_gaps(
        self,
        chat_id: int,
        topic_id: int,
        *,
        since_hours: int = 24,
        min_gap_seconds: int | None = None,
        min_missing_msg_ids: int | None = None,
        limit: int | None = None,
    ) -> list[dict]:
        getter = getattr(self._sink, "message_id_gaps", None)
        if not callable(getter):
            return []
        try:
            return list(
                getter(
                    int(chat_id),
                    int(topic_id or 0),
                    since_hours=since_hours,
                    min_gap_seconds=self._HISTORY_GAP_MIN_SECONDS if min_gap_seconds is None else int(min_gap_seconds),
                    min_missing_msg_ids=self._HISTORY_GAP_MIN_MISSING if min_missing_msg_ids is None else int(min_missing_msg_ids),
                    limit=self._HISTORY_GAP_SCAN_LIMIT if limit is None else int(limit),
                )
                or []
            )
        except Exception as exc:
            print(f"[mini-web] message_id_gaps failed: {exc}")
            return []

    def _has_ingested_message(self, chat_id: int, msg_id: int, topic_id: int) -> bool:
        checker = getattr(self._sink, "has_message", None)
        if not callable(checker):
            return False
        try:
            return bool(checker(int(chat_id), int(msg_id), int(topic_id or 0)))
        except Exception as exc:
            print(f"[mini-web] has_message failed: {exc}")
            return False

    async def _ingest_event_and_parent(
        self,
        client,
        entity,
        raw_event: RawMessageEvent,
        *,
        chat_id: int,
        topic_id: int,
        backfill_reply_parent: bool = True,
    ) -> bool:
        if backfill_reply_parent:
            await self._maybe_backfill_reply_parent(client, entity, raw_event, chat_id, topic_id)
        return await self._ingest_event_with_retry(raw_event)

    async def _maybe_backfill_reply_parent(
        self,
        client,
        entity,
        raw_event: RawMessageEvent,
        chat_id: int,
        topic_id: int,
    ) -> bool:
        reply_id = int(raw_event.reply_to_msg_id or 0)
        if reply_id <= 0 or reply_id == int(raw_event.msg_id or 0):
            return False
        storage_chat_id = int(chat_id or raw_event.chat_id or 0)
        if not storage_chat_id:
            return False
        if self._has_ingested_message(storage_chat_id, reply_id, topic_id):
            return False
        try:
            parent = await client.get_messages(entity, ids=reply_id)
        except Exception as exc:
            print(f"[mini-web] reply parent backfill skipped: {reply_id}: {exc}")
            return False
        if parent is None:
            return False
        if _message_is_scheduled_placeholder(parent):
            return False
        if topic_id and _message_topic_id(parent) != topic_id:
            return False
        parent_event = await _raw_event_from_message(
            parent,
            chat_id=storage_chat_id,
            account_key=self._account_key,
        )
        if int(parent_event.msg_id or 0) == int(raw_event.msg_id or 0):
            return False
        return await self._ingest_event_with_retry(parent_event)

    async def _ingest_event_with_retry(self, raw_event: RawMessageEvent) -> bool:
        for index in range(self._INGEST_BUSY_ATTEMPTS):
            try:
                self._sink.ingest_event(raw_event)
                return True
            except sqlite3.OperationalError as exc:
                if not _is_sqlite_busy(exc) or index >= self._INGEST_BUSY_ATTEMPTS - 1:
                    print(f"[mini-web] ingest failed: {exc}")
                    self._set_status("running", f"消息写入失败:{exc}")
                    return False
                await asyncio.sleep(self._INGEST_BUSY_BASE_SLEEP * (2 ** index))
            except Exception as exc:
                print(f"[mini-web] ingest failed: {exc}")
                self._set_status("running", f"消息写入失败:{exc}")
                return False
        return False


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
    return _message_topic_id(getattr(event, "message", None))


def _message_topic_id(message) -> int:
    reply_to = getattr(message, "reply_to", None)
    return int(getattr(reply_to, "reply_to_top_id", 0) or getattr(message, "reply_to_msg_id", 0) or 0)


def _message_is_scheduled_placeholder(message) -> bool:
    return bool(getattr(message, "schedule_date", None))


def _raw_event_from_telethon(event, *, account_key: str = "default") -> RawMessageEvent:
    return _raw_event_from_message_data(
        event.message,
        chat_id=int(getattr(event, "chat_id", 0) or 0),
        sender_id=int(getattr(event, "sender_id", 0) or 0) or None,
        sender=getattr(event, "sender", None),
        account_key=account_key,
    )


async def _raw_event_from_message(message, *, chat_id: int = 0, account_key: str = "default") -> RawMessageEvent:
    raw_event = _raw_event_from_message_data(message, chat_id=chat_id, account_key=account_key)
    display_name = await _resolve_sender_display_name_from_message(message)
    if display_name:
        raw_event = replace(raw_event, source=display_name)
    edit_date = getattr(message, "edit_date", None)
    if edit_date is not None:
        if getattr(edit_date, "tzinfo", None) is None:
            edit_date = edit_date.replace(tzinfo=timezone.utc)
        raw_event = replace(raw_event, edited_at=edit_date.astimezone(timezone.utc).isoformat())
    return raw_event


def _raw_event_from_message_data(
    message,
    *,
    chat_id: int = 0,
    sender_id: int | None = None,
    sender=None,
    account_key: str = "default",
) -> RawMessageEvent:
    sender_id = int(sender_id or getattr(message, "sender_id", 0) or 0) or None
    chat_id = int(chat_id or getattr(message, "chat_id", 0) or 0)
    msg_id = int(getattr(message, "id", 0) or 0)
    date = getattr(message, "date", None)
    if date is not None:
        if getattr(date, "tzinfo", None) is None:
            date = date.replace(tzinfo=timezone.utc)
        date_text = date.astimezone(timezone.utc).isoformat()
    else:
        date_text = ""
    cached_source = _format_sender_display(getattr(message, "sender", None) or sender)
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
        sender_is_bot=bool(getattr(getattr(message, "sender", None) or sender, "bot", False)),
        media_meta=_message_meta_from_telethon(message),
    )


def _target_chat_storage_id(value: object) -> int:
    parsed = _parse_target_chat(value)
    return parsed if isinstance(parsed, int) else 0


def _is_sqlite_busy(exc: BaseException) -> bool:
    text = str(exc).lower()
    return "database is locked" in text or "database table is locked" in text or "database is busy" in text


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


async def _resolve_sender_display_name_from_message(message) -> str:
    sender = getattr(message, "sender", None)
    if sender is None:
        getter = getattr(message, "get_sender", None)
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
