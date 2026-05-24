"""Background queue consumer for guarded outbox automation."""

from __future__ import annotations

import threading
import time
from dataclasses import dataclass, field
from typing import Callable, Protocol

from backend.domain.models import utc_now_iso


class AutomationWorkerStore(Protocol):
    def get_settings(self) -> dict:
        ...

    def list_outbox_drafts(self, status: str = "draft") -> list[dict]:
        ...

    def save_outbox_draft(self, payload: dict) -> dict:
        ...


@dataclass
class AutomationWorkerState:
    enabled: bool = False
    running: bool = False
    last_tick_at: str = ""
    last_error: str = ""
    last_result: dict = field(default_factory=dict)

    def to_api(self, *, pending_count: int = 0) -> dict:
        return {
            "enabled": self.enabled,
            "running": self.running,
            "last_tick_at": self.last_tick_at,
            "last_error": self.last_error,
            "last_result": self.last_result,
            "pending_count": pending_count,
        }


class OutboxAutomationWorker:
    def __init__(
        self,
        store: AutomationWorkerStore,
        *,
        dispatch: Callable[[dict], dict],
        sleep_fn: Callable[[float], None] = time.sleep,
    ) -> None:
        self._store = store
        self._dispatch = dispatch
        self._sleep_fn = sleep_fn
        self._lock = threading.Lock()
        self._stop = threading.Event()
        self._thread: threading.Thread | None = None
        self._state = AutomationWorkerState()

    def sync(self) -> None:
        settings = self._store.get_settings()
        enabled = _worker_enabled(settings)
        with self._lock:
            self._state.enabled = enabled
        if enabled:
            self.start()
        else:
            self.stop()

    def start(self) -> None:
        with self._lock:
            if self._thread and self._thread.is_alive():
                self._state.running = True
                return
            self._stop = threading.Event()
            self._thread = threading.Thread(
                target=self._run,
                name="miniweb-outbox-automation-worker",
                daemon=True,
            )
            self._state.running = True
            self._thread.start()

    def stop(self) -> None:
        with self._lock:
            self._stop.set()
            self._state.running = False

    def status(self) -> dict:
        pending_count = 0
        try:
            pending_count = len(self._store.list_outbox_drafts("auto_pending"))
        except Exception:
            pending_count = 0
        with self._lock:
            return self._state.to_api(pending_count=pending_count)

    def tick_once(self) -> dict:
        settings = self._store.get_settings()
        if not _worker_enabled(settings):
            result = {"ok": True, "processed": 0, "skipped": "worker_disabled"}
            self._remember(result=result, error="")
            return result
        limit = _settings_int(settings, "automation_worker_batch_size", 3, minimum=1, maximum=20)
        try:
            drafts = list(reversed(self._store.list_outbox_drafts("auto_pending")))[:limit]
        except Exception as exc:
            result = {"ok": False, "processed": 0, "error": str(exc)}
            self._remember(result=result, error=str(exc))
            return result

        processed: list[dict] = []
        for draft in drafts:
            draft_id = str(draft.get("id") or "")
            try:
                result = self._dispatch(dict(draft))
            except Exception as exc:
                result = {"ok": False, "error": str(exc)}
            status = _draft_status_from_dispatch(result)
            note = _draft_note_from_dispatch(result)
            try:
                self._store.save_outbox_draft({**draft, "status": status, "note": note})
            except Exception as exc:
                result = {**result, "ok": False, "error": f"{result.get('error') or ''} 保存草稿状态失败:{exc}".strip()}
            processed.append(
                {
                    "id": draft_id,
                    "status": status,
                    "ok": bool(result.get("ok")),
                    "sent": bool(result.get("sent")),
                    "dry_run": bool(result.get("dry_run")),
                    "error": str(result.get("error") or ""),
                }
            )

        summary = {"ok": True, "processed": len(processed), "items": processed}
        self._remember(result=summary, error="")
        return summary

    def _run(self) -> None:
        while not self._stop.is_set():
            try:
                self.tick_once()
            except Exception as exc:
                self._remember(result={"ok": False, "processed": 0, "error": str(exc)}, error=str(exc))
            settings = self._store.get_settings()
            interval = _settings_int(settings, "automation_worker_interval_seconds", 15, minimum=5, maximum=300)
            self._sleep_fn(interval)
        with self._lock:
            self._state.running = False

    def _remember(self, *, result: dict, error: str) -> None:
        with self._lock:
            self._state.last_tick_at = utc_now_iso()
            self._state.last_result = result
            self._state.last_error = error


def _worker_enabled(settings: dict) -> bool:
    return bool(settings.get("automation_worker_enabled")) and bool(settings.get("automation_enabled"))


def _draft_status_from_dispatch(result: dict) -> str:
    if bool(result.get("ok")) and bool(result.get("sent")):
        return "sent"
    if bool(result.get("ok")) and bool(result.get("dry_run")):
        return "auto_dry_run"
    if bool(result.get("manual_required")):
        return "manual_required"
    return "auto_failed"


def _draft_note_from_dispatch(result: dict) -> str:
    if result.get("error"):
        return str(result.get("error"))
    if result.get("message"):
        return str(result.get("message"))
    automation = result.get("automation") or {}
    if isinstance(automation, dict) and automation.get("message"):
        return str(automation.get("message"))
    return ""


def _settings_int(settings: dict, key: str, default: int, *, minimum: int, maximum: int) -> int:
    try:
        value = int(str(settings.get(key) if settings.get(key) is not None else default).strip())
    except (TypeError, ValueError):
        value = default
    return max(minimum, min(maximum, value))
