from __future__ import annotations

import json
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from collections.abc import Callable

from backend.log_commands.allowlist import LogCommandPolicy, classify_telegram_ingress


_API_BASE = "https://api.telegram.org"
_POLL_TIMEOUT_SEC = 20
_REPLY_LIMIT = 3800


class LogCommandTelegramListener:
    """Telegram Bot API ingress for log-group commands.

    This layer owns Bot API I/O and ingress filtering. Command parsing and
    read-only handlers stay in the dispatcher/server.
    """

    def __init__(
        self,
        *,
        get_settings: Callable[[], dict],
        dispatch: Callable[[dict], dict],
        api_base: str = _API_BASE,
        time_fn: Callable[[], float] = time.time,
    ) -> None:
        self._get_settings = get_settings
        self._dispatch = dispatch
        self._api_base = api_base.rstrip("/")
        self._time_fn = time_fn
        self._stop = threading.Event()
        self._thread: threading.Thread | None = None
        self._lock = threading.Lock()
        self._offset = 0
        self._token = ""
        self._status: dict = {
            "running": False,
            "enabled": False,
            "status": "stopped",
            "message": "",
            "last_update_id": 0,
            "last_error": "",
            "last_seen_at": 0.0,
            "last_command_at": 0.0,
        }

    def start(self) -> bool:
        with self._lock:
            if self._thread and self._thread.is_alive():
                return False
            self._stop.clear()
            thread = threading.Thread(
                target=self._loop,
                name="log-command-tg-listener",
                daemon=True,
            )
            self._thread = thread
        thread.start()
        self._update_status(running=True, status="starting", message="日志群命令 listener 启动中")
        return True

    def stop(self, timeout: float = 5.0) -> None:
        self._stop.set()
        thread = self._thread
        if thread and thread.is_alive():
            thread.join(timeout=timeout)
        self._update_status(running=False, status="stopped", message="日志群命令 listener 已停止")

    def status(self) -> dict:
        with self._lock:
            out = dict(self._status)
        out["thread_alive"] = bool(self._thread and self._thread.is_alive())
        out["last_seen_text"] = _fmt_ts(out.get("last_seen_at") or 0, self._time_fn)
        out["last_command_text"] = _fmt_ts(out.get("last_command_at") or 0, self._time_fn)
        return out

    def _loop(self) -> None:
        while not self._stop.is_set():
            try:
                settings = self._settings_snapshot()
                if not settings.get("log_command_enabled"):
                    self._update_status(
                        running=True,
                        enabled=False,
                        status="disabled",
                        message="log_command_enabled 未开启",
                    )
                    self._wait(5.0)
                    continue
                token = str(settings.get("notify_tg_bot_token") or "").strip()
                if not token:
                    self._update_status(
                        running=True,
                        enabled=True,
                        status="waiting_config",
                        message="缺少 notify_tg_bot_token,无法接收日志群命令",
                    )
                    self._wait(5.0)
                    continue
                if token != self._token:
                    self._token = token
                    self._offset = self._drain_backlog(token)
                self._update_status(
                    running=True,
                    enabled=True,
                    status="polling",
                    message="日志群命令 listener 轮询中",
                    last_error="",
                )
                self._poll_once(token)
            except Exception as exc:
                self._update_status(
                    running=True,
                    status="error",
                    message="日志群命令 listener 出错",
                    last_error=str(exc) or exc.__class__.__name__,
                )
                self._wait(5.0)
        self._update_status(running=False, status="stopped", message="日志群命令 listener 已停止")

    def _settings_snapshot(self) -> dict:
        try:
            return dict(self._get_settings() or {})
        except Exception:
            return {}

    def _poll_once(self, token: str) -> None:
        payload = {
            "timeout": _POLL_TIMEOUT_SEC,
            "limit": 50,
            "allowed_updates": json.dumps(["message"], ensure_ascii=False),
        }
        if self._offset:
            payload["offset"] = self._offset
        data = self._bot_api(token, "getUpdates", payload, timeout=_POLL_TIMEOUT_SEC + 5)
        if not data.get("ok"):
            raise RuntimeError(str(data.get("description") or data)[:300])
        for update in data.get("result") or []:
            self._handle_update(token, update)
            update_id = int(update.get("update_id") or 0)
            if update_id:
                self._offset = max(self._offset, update_id + 1)
                self._update_status(last_update_id=update_id, last_seen_at=self._time_fn())

    def _drain_backlog(self, token: str) -> int:
        try:
            data = self._bot_api(
                token,
                "getUpdates",
                {
                    "timeout": 0,
                    "limit": 100,
                    "allowed_updates": json.dumps(["message"], ensure_ascii=False),
                },
                timeout=8,
            )
        except Exception:
            return 0
        max_update = 0
        for update in data.get("result") or []:
            max_update = max(max_update, int(update.get("update_id") or 0))
        if max_update:
            self._update_status(last_update_id=max_update, last_seen_at=self._time_fn())
        return max_update + 1 if max_update else 0

    def _handle_update(self, token: str, update: dict) -> None:
        message = update.get("message") if isinstance(update.get("message"), dict) else {}
        text = str(message.get("text") or "")
        if not text.strip():
            return
        chat = message.get("chat") if isinstance(message.get("chat"), dict) else {}
        sender = message.get("from") if isinstance(message.get("from"), dict) else {}
        chat_id = _safe_int(chat.get("id"))
        user_id = _safe_int(sender.get("id"))
        msg_id = _safe_int(message.get("message_id"))
        if not chat_id or not msg_id:
            return
        settings = self._settings_snapshot()
        policy = LogCommandPolicy.from_settings(settings)
        ingress = classify_telegram_ingress(
            policy=policy,
            text=text,
            user_id=user_id,
            chat_id=chat_id,
        )
        if ingress.kind == "skip":
            return
        result = self._dispatch(
            {
                "text": text,
                "source_kind": "telegram",
                "chat_id": chat_id,
                "from_user_id": user_id,
                "msg_id": msg_id,
                "dry_run": False,
            }
        )
        if result.get("status") == "skip":
            return
        decision = result.get("decision") if isinstance(result.get("decision"), dict) else {}
        reason = str(decision.get("reason") or "")
        if reason in {"chat_not_allowed", "chat_not_configured", "command_listener_disabled"}:
            return
        reply = _reply_text(result)
        if not reply:
            return
        self._bot_api(
            token,
            "sendMessage",
            {
                "chat_id": str(chat_id),
                "text": reply,
                "reply_to_message_id": str(msg_id),
                "disable_web_page_preview": "true",
            },
            timeout=8,
        )
        self._update_status(last_command_at=self._time_fn())

    def _bot_api(self, token: str, method: str, payload: dict, *, timeout: float) -> dict:
        url = f"{self._api_base}/bot{token}/{method}"
        body = urllib.parse.urlencode(payload).encode("utf-8")
        try:
            with urllib.request.urlopen(url, data=body, timeout=timeout) as resp:
                raw = resp.read().decode("utf-8", errors="replace")
        except urllib.error.HTTPError as exc:
            raw = exc.read().decode("utf-8", errors="replace")
            try:
                data = json.loads(raw)
            except json.JSONDecodeError:
                data = {"ok": False, "description": raw[:300]}
            if "description" not in data:
                data["description"] = f"HTTP {exc.code}"
            return data
        try:
            return json.loads(raw)
        except json.JSONDecodeError:
            return {"ok": False, "description": raw[:300]}

    def _wait(self, seconds: float) -> None:
        self._stop.wait(max(0.2, float(seconds or 0)))

    def _update_status(self, **patch) -> None:
        with self._lock:
            self._status.update(patch)


def _reply_text(result: dict) -> str:
    reply = str(result.get("reply") or result.get("error") or "").strip()
    if not reply:
        return ""
    if len(reply) > _REPLY_LIMIT:
        return reply[: _REPLY_LIMIT - 20].rstrip() + "\n...(已截断)"
    return reply


def _safe_int(value: object) -> int:
    try:
        return int(str(value or "0").strip() or 0)
    except (TypeError, ValueError):
        return 0


def _fmt_ts(ts: object, time_fn: Callable[[], float]) -> str:
    try:
        value = float(ts or 0)
    except (TypeError, ValueError):
        value = 0.0
    if value <= 0:
        return ""
    age = max(0, int(time_fn() - value))
    if age < 60:
        return f"{age}s ago"
    if age < 3600:
        return f"{age // 60}m ago"
    return f"{age // 3600}h ago"


__all__ = ["LogCommandTelegramListener"]
