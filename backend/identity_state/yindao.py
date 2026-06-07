from __future__ import annotations

import re

from backend.domain.models import RawMessageEvent
from backend.identity_state.duration import parse_chinese_duration

CMD_YINDAO = ".引道"
YINDAO_CD_SEC = 12 * 3600
YINDAO_CHOICES = {"金", "木", "水", "火", "土"}
YINDAO_CD_KEYWORD = "再次引道"
YINDAO_NON_TAIYI_TEXT = "你并非太一门弟子，无法参悟大道本源"

RE_YINDAO_RESULT = re.compile(r"你引动【([^】]+之道)】，获得了\s*([\d,]+)\s*点神识")
RE_YINDAO_BUFF = re.compile(r"临时增益【([^】]+)】")
RE_YINDAO_XIUWEI_BONUS = re.compile(r"修为增加\s*(\d+)\s*%")


def _parent_command(ctx) -> str:
    if ctx.parent and ctx.parent.text:
        return str(ctx.parent.text or "").strip()
    return ""


def _command_arg(command: str) -> str:
    raw = str(command or "").strip()
    if raw == CMD_YINDAO:
        return ""
    if raw.startswith(f"{CMD_YINDAO} "):
        return raw[len(CMD_YINDAO):].strip().split()[0]
    return ""


def _is_yindao_command(command: str) -> bool:
    raw = str(command or "").strip()
    return raw == CMD_YINDAO or raw.startswith(f"{CMD_YINDAO} ")


def _parse_int(value: object) -> int:
    try:
        return int(str(value or "0").replace(",", ""))
    except (TypeError, ValueError):
        return 0


def normalize_yindao_choice(choice: str) -> str:
    value = str(choice or "").strip()
    return value if value in YINDAO_CHOICES else "水"


def parse_yindao_result_summary(text: str) -> str:
    raw_text = str(text or "").strip()
    parts: list[str] = []
    if match := RE_YINDAO_RESULT.search(raw_text):
        parts.append(match.group(1).strip())
        parts.append(f"神识 +{_parse_int(match.group(2))}")
    if match := RE_YINDAO_BUFF.search(raw_text):
        parts.append(match.group(1).strip())
    if match := RE_YINDAO_XIUWEI_BONUS.search(raw_text):
        parts.append(f"修为 +{match.group(1)}%")
    return " ｜ ".join(parts) if parts else "引道成功"


class YindaoModule:
    key = "yindao"
    label = "引道"
    default_state: dict = {
        "cooldown_until": 0.0,
        "last_observed_at": 0.0,
        "last_success_at": 0.0,
        "last_status": "unknown",
        "last_result": "",
        "last_error": "",
        "last_text_excerpt": "",
        "choice": "水",
    }

    def resolve_target(self, event: RawMessageEvent, ctx) -> int | None:
        if ctx.sender_kind != "bot" or not ctx.parent_is_my_identity():
            return None
        if not _is_yindao_command(_parent_command(ctx)):
            return None
        return ctx.parent_sender()

    def observe(self, event: RawMessageEvent, ctx, state: dict) -> dict | None:
        text = str(event.text or "").strip()
        if not text:
            return None
        now = float(ctx.now or 0)
        parent_cmd = _parent_command(ctx)
        new = dict(state)
        arg = _command_arg(parent_cmd)
        if arg:
            new["choice"] = normalize_yindao_choice(arg)

        def finish(status: str, *, cooldown_until: float | None = None, result: str = "", error: str = "") -> dict:
            new["last_observed_at"] = now
            new["last_status"] = status
            new["last_text_excerpt"] = text[:160]
            if cooldown_until is not None:
                new["cooldown_until"] = float(cooldown_until or 0)
            if result:
                new["last_result"] = result
            new["last_error"] = error
            return new

        if YINDAO_CD_KEYWORD in text:
            wait_sec = parse_chinese_duration(text)
            until = now + wait_sec if wait_sec > 0 else now + YINDAO_CD_SEC
            return finish("cooldown", cooldown_until=until, result="冷却中")

        if YINDAO_NON_TAIYI_TEXT in text:
            return finish("unavailable", cooldown_until=0, result="非太一门", error="仅太一门弟子可引道")

        if RE_YINDAO_RESULT.search(text):
            new["last_success_at"] = now
            return finish("success", cooldown_until=now + YINDAO_CD_SEC, result=parse_yindao_result_summary(text))

        return None

    def compute_anchor(self, state: dict, *, now: float) -> float | None:
        if str(state.get("last_status") or "") == "unavailable":
            return None
        cd_until = float(state.get("cooldown_until") or 0)
        if cd_until <= 0:
            return None
        return now if cd_until <= now else cd_until

    def status_summary(self, state: dict, *, now: float) -> dict:
        from backend.identity_state import fmt_remain

        status = str(state.get("last_status") or "unknown")
        cd_until = float(state.get("cooldown_until") or 0)
        choice = str(state.get("choice") or "水")
        result = str(state.get("last_result") or "").strip()
        if status == "unknown":
            return {"text": f"未观测 {choice}", "ready": False, "next_at": None, "status": status}
        if status == "unavailable":
            return {"text": result or "不可用", "ready": False, "next_at": None, "status": status}
        if cd_until > now:
            return {"text": f"剩 {fmt_remain(cd_until - now)} {choice}", "ready": False, "next_at": cd_until, "status": status}
        return {"text": f"已就绪 {choice}", "ready": True, "next_at": cd_until or None, "status": status}


__all__ = [
    "CMD_YINDAO",
    "YINDAO_CD_KEYWORD",
    "YINDAO_NON_TAIYI_TEXT",
    "YindaoModule",
    "normalize_yindao_choice",
    "parse_yindao_result_summary",
]
