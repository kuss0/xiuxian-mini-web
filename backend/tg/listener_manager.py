from __future__ import annotations

from typing import Protocol

from backend.config import MAX_LISTENERS
from backend.domain.models import RawMessageEvent
from backend.tg.listener import TelegramReadOnlyListener


class EventSink(Protocol):
    def ingest_event(self, event: RawMessageEvent):
        ...


class TelegramListenerManager:
    def __init__(self, sink: EventSink, *, max_listeners: int = MAX_LISTENERS) -> None:
        self._sink = sink
        self._max_listeners = max(1, int(max_listeners or 1))
        self._listeners: dict[str, TelegramReadOnlyListener] = {}

    def status(self, local_id: str | None = None) -> dict:
        if local_id:
            listener = self._listeners.get(local_id)
            if listener is None:
                return {"status": "stopped", "message": ""}
            return listener.status()
        return {
            "max_listeners": self._max_listeners,
            "collector": self._active_collector_key(),
            "running": {
                key: listener.status()
                for key, listener in sorted(self._listeners.items())
            },
        }

    def start(self, local_id: str, settings: dict) -> dict:
        local_id = str(local_id or "").strip()
        if not local_id:
            return {"status": "error", "message": "缺少账号 local_id"}
        self._stop_other_collectors(local_id)
        if local_id not in self._listeners and self._active_count() >= self._max_listeners:
            return {
                "status": "error",
                "message": f"采集监听已达上限 {self._max_listeners} 个",
            }

        listener = self._listeners.get(local_id)
        if listener is None:
            listener = TelegramReadOnlyListener(self._sink, account_key=local_id)
            self._listeners[local_id] = listener
        return listener.start(settings)

    def stop(self, local_id: str) -> dict:
        local_id = str(local_id or "").strip()
        listener = self._listeners.get(local_id)
        if listener is None:
            return {"status": "stopped", "message": "监听未运行"}
        return listener.stop()

    def get_listener(self, local_id: str) -> TelegramReadOnlyListener | None:
        """如果该 account 的 listener 在跑就返回它,让 dialog/send-as 服务可以
        复用同一个 Telethon client(session 文件只能被一个 client 持有)。"""
        listener = self._listeners.get(str(local_id or "").strip())
        if listener is None or not listener.is_running():
            return None
        return listener

    def _active_count(self) -> int:
        active = 0
        for listener in self._listeners.values():
            status = str(listener.status().get("status") or "")
            if status not in {"stopped", "error"}:
                active += 1
        return active

    def _active_collector_key(self) -> str:
        for key, listener in sorted(self._listeners.items()):
            status = str(listener.status().get("status") or "")
            if status not in {"stopped", "error"}:
                return key
        return ""

    def _stop_other_collectors(self, keep_local_id: str) -> None:
        if self._max_listeners != 1:
            return
        for key, listener in list(self._listeners.items()):
            if key == keep_local_id:
                continue
            status = str(listener.status().get("status") or "")
            if status not in {"stopped", "error"}:
                listener.stop()
