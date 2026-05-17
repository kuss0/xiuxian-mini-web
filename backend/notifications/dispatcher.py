"""Notification dispatcher — 根据 settings 决定哪些事件走哪些 channel。

挂在 SQLiteStore.ingest_event 后面,新解析出来的 card.title 命中
settings.notify_card_titles 就推。简单 throttle:同一 (kind, source_id) 60s 内
只推一次,避免 NewMessage + MessageEdited 双触发。
"""

from __future__ import annotations

import threading
import time
from collections.abc import Callable

from backend.notifications import NotificationEvent, Notifier
from backend.notifications.tg_bot import TelegramBotNotifier


_DEDUP_WINDOW_SEC = 60.0
_DEDUP_MAX = 2048


class NotificationDispatcher:
    """根据 settings 实时构建 notifier 列表 + dispatch。"""

    def __init__(
        self,
        *,
        get_settings: Callable[[], dict],
        time_fn: Callable[[], float] = time.time,
    ) -> None:
        self._get_settings = get_settings
        self._time_fn = time_fn
        self._lock = threading.Lock()
        # (kind, source_id) → expires_at
        self._sent: dict[tuple[str, str], float] = {}

    def settings_snapshot(self) -> dict:
        try:
            return dict(self._get_settings() or {})
        except Exception:
            return {}

    def list_notifiers(self) -> list[Notifier]:
        s = self.settings_snapshot()
        out: list[Notifier] = []
        if not s.get("notify_enabled"):
            return out
        token = str(s.get("notify_tg_bot_token") or "").strip()
        chat = str(s.get("notify_tg_chat_id") or "").strip()
        if token and chat:
            out.append(TelegramBotNotifier(token, chat))
        return out

    def event_is_enabled(self, card_title: str) -> bool:
        s = self.settings_snapshot()
        if not s.get("notify_enabled"):
            return False
        allow = s.get("notify_card_titles") or []
        if not allow:
            return False
        return str(card_title or "") in {str(x) for x in allow}

    def dispatch(self, event: NotificationEvent) -> list[tuple[str, bool, str]]:
        """返回每个 notifier 的 (name, ok, error)。dedup 内静默跳过。"""
        if not self._claim(event):
            return []
        results: list[tuple[str, bool, str]] = []
        for notifier in self.list_notifiers():
            ok, err = notifier.notify(event)
            results.append((notifier.name, ok, err))
        return results

    def _claim(self, event: NotificationEvent) -> bool:
        key = (event.kind, event.source_id or event.title)
        now = self._time_fn()
        with self._lock:
            self._gc(now)
            expires = self._sent.get(key, 0)
            if expires > now:
                return False
            self._sent[key] = now + _DEDUP_WINDOW_SEC
        return True

    def _gc(self, now: float) -> None:
        if len(self._sent) < _DEDUP_MAX:
            return
        expired = [k for k, exp in self._sent.items() if exp <= now]
        for k in expired:
            self._sent.pop(k, None)
        if len(self._sent) >= _DEDUP_MAX:
            sorted_items = sorted(self._sent.items(), key=lambda kv: kv[1])
            for k, _ in sorted_items[: _DEDUP_MAX // 2]:
                self._sent.pop(k, None)


__all__ = ["NotificationDispatcher"]
