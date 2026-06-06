"""Observe-only phaseful gameplay modules.

Old automation used a shared phase machine for flows like deep retreat and
Yuanying.  The mini-web keeps the same state vocabulary, but only advances it
from real bot replies.  User commands are intent, not proof.
"""
from __future__ import annotations

from dataclasses import dataclass
from typing import Pattern

from backend.domain.models import RawMessageEvent
from backend.identity_state.duration import parse_chinese_duration

PHASE_IDLE = "idle"
PHASE_LAUNCHING = "launching"
PHASE_RUNNING = "running"
PHASE_WAITING_SUMMARY = "waiting_summary"
PHASE_POST_SUMMARY_WAIT = "post_summary_wait"


def _matches_all(text: str, pattern: str | Pattern[str] | tuple[str, ...]) -> bool:
    if isinstance(pattern, tuple):
        return all(item in text for item in pattern if item)
    if isinstance(pattern, str):
        return bool(pattern and pattern in text)
    return bool(pattern.search(text))


def _matches_any(text: str, patterns: tuple[str | Pattern[str] | tuple[str, ...], ...]) -> bool:
    return any(_matches_all(text, pattern) for pattern in patterns)


def _parent_command(ctx) -> str:
    if ctx.parent and ctx.parent.text:
        return str(ctx.parent.text or "").strip()
    return ""


def _command_matches(raw_command: str, commands: tuple[str, ...]) -> bool:
    command = str(raw_command or "").strip()
    if not command:
        return False
    for prefix in commands:
        prefix = str(prefix or "").strip()
        if command == prefix or command.startswith(f"{prefix} "):
            return True
    return False


def _as_float(value) -> float:
    try:
        return float(value or 0)
    except (TypeError, ValueError):
        return 0.0


@dataclass(frozen=True)
class PhasefulSpec:
    key: str
    label: str
    commands: tuple[str, ...]
    default_cd_sec: int
    entry_patterns: tuple[str | Pattern[str] | tuple[str, ...], ...] = ()
    running_patterns: tuple[str | Pattern[str] | tuple[str, ...], ...] = ()
    cooldown_patterns: tuple[str | Pattern[str] | tuple[str, ...], ...] = ()
    already_running_patterns: tuple[str | Pattern[str] | tuple[str, ...], ...] = ()
    ready_patterns: tuple[str | Pattern[str] | tuple[str, ...], ...] = ()
    idle_patterns: tuple[str | Pattern[str] | tuple[str, ...], ...] = ()
    summary_patterns: tuple[str | Pattern[str] | tuple[str, ...], ...] = ()
    failure_patterns: tuple[str | Pattern[str] | tuple[str, ...], ...] = ()
    post_summary_wait_sec: int = 30
    unknown_running_probe_sec: int = 30


class PhasefulModule:
    """Shared observe-only state machine for long-running gameplay."""

    def __init__(self, spec: PhasefulSpec) -> None:
        self.spec = spec
        self.key = spec.key
        self.label = spec.label
        self.default_state: dict = {
            "phase": PHASE_IDLE,
            "entered_at": 0.0,
            "finished_at": 0.0,
            "summary_at": 0.0,
            "post_summary_until": 0.0,
            "cooldown_until": 0.0,
            "last_observed_at": 0.0,
            "last_success_at": 0.0,
            "last_status": "unknown",
            "last_result": "",
            "last_error": "",
            "last_text_excerpt": "",
            "reply_to_msg_id": 0,
            "last_message_id": 0,
            "probe_pending": False,
            "summary_sent_at": 0.0,
            "last_summary_msg_id": 0,
            "idle_confirmed_at": 0.0,
        }

    def resolve_target(self, event: RawMessageEvent, ctx) -> int | None:
        if ctx.sender_kind != "bot":
            return None
        if not ctx.parent_is_my_identity():
            return None
        if not _command_matches(_parent_command(ctx), self.spec.commands):
            return None
        return ctx.parent_sender()

    def observe(self, event: RawMessageEvent, ctx, state: dict) -> dict | None:
        text = str(event.text or "").strip()
        if not text:
            return None
        now = float(ctx.now or 0)
        wait_sec = parse_chinese_duration(text)

        if self.spec.summary_patterns and _matches_any(text, self.spec.summary_patterns):
            return self._summary_state(state, event, now, text)

        if self.spec.ready_patterns and _matches_any(text, self.spec.ready_patterns):
            return self._idle_state(
                state,
                event,
                now,
                text,
                status="ready",
                result="已就绪",
                next_at=now,
            )

        if self.spec.entry_patterns and _matches_any(text, self.spec.entry_patterns):
            return self._running_state(
                state,
                event,
                now,
                text,
                wait_sec=wait_sec or self.spec.default_cd_sec,
                status="running",
                result="已启动",
                success=True,
            )

        if self.spec.running_patterns and _matches_any(text, self.spec.running_patterns):
            if wait_sec > 0:
                return self._running_state(
                    state,
                    event,
                    now,
                    text,
                    wait_sec=wait_sec,
                    status="running",
                    result="运行中",
                    success=False,
                )
            return self._unknown_running_state(state, event, now, text, result="运行中")

        if self.spec.cooldown_patterns and _matches_any(text, self.spec.cooldown_patterns):
            if wait_sec > 0:
                return self._running_state(
                    state,
                    event,
                    now,
                    text,
                    wait_sec=wait_sec,
                    status="cooldown",
                    result="冷却中",
                    success=False,
                )
            return self._unknown_running_state(state, event, now, text, result="冷却中")

        if self.spec.already_running_patterns and _matches_any(text, self.spec.already_running_patterns):
            return self._unknown_running_state(state, event, now, text, result="运行中")

        if self.spec.idle_patterns and _matches_any(text, self.spec.idle_patterns):
            return self._idle_state(
                state,
                event,
                now,
                text,
                status="idle",
                result="未运行",
                next_at=now,
            )

        if self.spec.failure_patterns and _matches_any(text, self.spec.failure_patterns):
            return self._idle_state(
                state,
                event,
                now,
                text,
                status="failed",
                result="失败",
                next_at=now,
                error=text[:160],
            )

        return None

    def _base(self, state: dict, event: RawMessageEvent, now: float, text: str) -> dict:
        new = dict(state or {})
        for key, value in self.default_state.items():
            new.setdefault(key, value)
        new["last_observed_at"] = now
        new["last_text_excerpt"] = text[:120]
        new["last_message_id"] = int(event.msg_id or 0)
        new["reply_to_msg_id"] = int(event.reply_to_msg_id or 0)
        return new

    def _running_state(
        self,
        state: dict,
        event: RawMessageEvent,
        now: float,
        text: str,
        *,
        wait_sec: int,
        status: str,
        result: str,
        success: bool,
    ) -> dict:
        new = self._base(state, event, now, text)
        new["phase"] = PHASE_RUNNING
        new["entered_at"] = now if success or _as_float(new.get("entered_at")) <= 0 else new.get("entered_at")
        new["cooldown_until"] = now + max(0, int(wait_sec or 0))
        new["post_summary_until"] = 0.0
        new["summary_at"] = 0.0
        new["probe_pending"] = False
        new["summary_sent_at"] = 0.0
        new["last_summary_msg_id"] = 0
        new["idle_confirmed_at"] = 0.0
        new["last_status"] = status
        new["last_result"] = result
        new["last_error"] = ""
        if success:
            new["last_success_at"] = now
        return new

    def _unknown_running_state(
        self,
        state: dict,
        event: RawMessageEvent,
        now: float,
        text: str,
        *,
        result: str,
    ) -> dict:
        new = self._base(state, event, now, text)
        current_until = _as_float(new.get("cooldown_until"))
        fallback_until = now + max(0, int(self.spec.unknown_running_probe_sec or 0))
        new["phase"] = PHASE_RUNNING
        new["cooldown_until"] = max(current_until, fallback_until)
        new["post_summary_until"] = 0.0
        new["summary_at"] = 0.0
        new["probe_pending"] = True
        new["summary_sent_at"] = 0.0
        new["last_summary_msg_id"] = 0
        new["idle_confirmed_at"] = 0.0
        new["last_status"] = "running"
        new["last_result"] = result
        new["last_error"] = ""
        return new

    def _idle_state(
        self,
        state: dict,
        event: RawMessageEvent,
        now: float,
        text: str,
        *,
        status: str,
        result: str,
        next_at: float,
        error: str = "",
    ) -> dict:
        new = self._base(state, event, now, text)
        new["phase"] = PHASE_IDLE
        new["cooldown_until"] = float(next_at or 0)
        new["post_summary_until"] = 0.0
        new["summary_at"] = 0.0
        new["probe_pending"] = False
        new["summary_sent_at"] = 0.0
        new["last_summary_msg_id"] = 0
        new["idle_confirmed_at"] = now
        new["last_status"] = status
        new["last_result"] = result
        new["last_error"] = error
        return new

    def _summary_state(self, state: dict, event: RawMessageEvent, now: float, text: str) -> dict:
        new = self._base(state, event, now, text)
        post_until = now + max(0, int(self.spec.post_summary_wait_sec or 0))
        new["phase"] = PHASE_POST_SUMMARY_WAIT
        new["finished_at"] = now
        new["summary_at"] = now
        new["post_summary_until"] = post_until
        new["cooldown_until"] = post_until
        new["probe_pending"] = False
        new["summary_sent_at"] = 0.0
        new["last_summary_msg_id"] = int(event.msg_id or 0)
        new["idle_confirmed_at"] = now
        new["last_status"] = "summary"
        new["last_result"] = "已结算"
        new["last_error"] = ""
        return new

    def compute_anchor(self, state: dict, *, now: float) -> float | None:
        observed = _as_float(state.get("last_observed_at"))
        phase = str(state.get("phase") or PHASE_IDLE)
        post_until = _as_float(state.get("post_summary_until"))
        cooldown_until = _as_float(state.get("cooldown_until"))
        if phase == PHASE_POST_SUMMARY_WAIT and post_until > 0:
            return now if post_until <= now else post_until
        if cooldown_until > 0:
            return now if cooldown_until <= now else cooldown_until
        if observed > 0:
            return now
        return None

    def status_summary(self, state: dict, *, now: float) -> dict:
        from backend.identity_state import fmt_remain

        phase = str(state.get("phase") or PHASE_IDLE)
        observed = _as_float(state.get("last_observed_at"))
        cooldown_until = _as_float(state.get("cooldown_until"))
        post_until = _as_float(state.get("post_summary_until"))
        status = str(state.get("last_status") or "unknown")
        result = str(state.get("last_result") or "").strip()
        error = str(state.get("last_error") or "").strip()

        if observed <= 0 and cooldown_until <= 0:
            return {"text": "未观测", "ready": False, "next_at": None, "phase": phase, "status": status}

        if phase == PHASE_POST_SUMMARY_WAIT:
            next_at = post_until or cooldown_until
            if next_at > now:
                return {
                    "text": f"总结后缓冲 {fmt_remain(next_at - now)}",
                    "ready": False,
                    "next_at": next_at,
                    "phase": phase,
                    "status": status,
                }
            return {"text": "已就绪", "ready": True, "next_at": next_at or now, "phase": phase, "status": status}

        if phase == PHASE_WAITING_SUMMARY:
            return {"text": "等待总结", "ready": False, "next_at": cooldown_until or None, "phase": phase, "status": status}

        if phase == PHASE_RUNNING:
            if cooldown_until > now:
                return {
                    "text": f"进行中 剩 {fmt_remain(cooldown_until - now)}",
                    "ready": False,
                    "next_at": cooldown_until,
                    "phase": phase,
                    "status": status,
                }
            return {"text": "待总结确认", "ready": False, "next_at": now, "phase": phase, "status": status}

        if error:
            return {"text": f"异常 {error[:24]}", "ready": False, "next_at": cooldown_until or None, "phase": phase, "status": status}

        if cooldown_until > now:
            return {
                "text": f"剩 {fmt_remain(cooldown_until - now)}",
                "ready": False,
                "next_at": cooldown_until,
                "phase": phase,
                "status": status,
            }
        suffix = f" {result}" if result and result not in {"已就绪", "未运行"} else ""
        return {"text": f"已就绪{suffix}", "ready": True, "next_at": cooldown_until or now, "phase": phase, "status": status}


__all__ = [
    "PHASE_IDLE",
    "PHASE_LAUNCHING",
    "PHASE_POST_SUMMARY_WAIT",
    "PHASE_RUNNING",
    "PHASE_WAITING_SUMMARY",
    "PhasefulModule",
    "PhasefulSpec",
]
