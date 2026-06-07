from __future__ import annotations

import re

from backend.domain.models import RawMessageEvent
from backend.identity_state.duration import parse_chinese_duration

CMD_WENDAO = ".问道"
WENDAO_CD_SEC = 12 * 3600
WENDAO_PENDING_KEYWORD = "虔诚地向宗门长老问道"
WENDAO_RESULT_TITLE = "【问道得宝】"
WENDAO_CD_KEYWORD = "天机不可频繁窥探"

RE_WENDAO_XIUWEI = re.compile(r"修为增加了\s*([\d,]+)\s*点")
RE_WENDAO_REWARD_BRACKET = re.compile(r"^【([^】]+)】\s*x\s*([\d,]+)$")
RE_WENDAO_REWARD_PLAIN = re.compile(r"^(.+?)\s*x\s*([\d,]+)$")


def _parent_command(ctx) -> str:
    if ctx.parent and ctx.parent.text:
        return str(ctx.parent.text or "").strip()
    return ""


def _is_wendao_command(command: str) -> bool:
    return str(command or "").strip() == CMD_WENDAO


def _parse_int(value: object) -> int:
    try:
        return int(str(value or "0").replace(",", ""))
    except (TypeError, ValueError):
        return 0


def _parse_reward_line(line: str) -> tuple[str, int]:
    raw_line = str(line or "").strip()
    if raw_line.startswith("-"):
        raw_line = raw_line[1:].strip()
    if not raw_line or "修为增加" in raw_line:
        return "", 0
    match = RE_WENDAO_REWARD_BRACKET.match(raw_line) or RE_WENDAO_REWARD_PLAIN.match(raw_line)
    if not match:
        return "", 0
    name = str(match.group(1) or "").strip()
    count = _parse_int(match.group(2))
    return (name, count) if name and count > 0 else ("", 0)


def parse_wendao_result_summary(text: str) -> tuple[str, dict[str, int]]:
    raw_text = str(text or "").strip()
    parts: list[str] = []
    items: dict[str, int] = {}
    if match := RE_WENDAO_XIUWEI.search(raw_text):
        parts.append(f"修为 +{_parse_int(match.group(1))}")
    for line in raw_text.splitlines():
        item_name, count = _parse_reward_line(line)
        if not item_name:
            continue
        items[item_name] = items.get(item_name, 0) + count
    if items:
        parts.append("奖励：" + "、".join(f"{name}x{count}" for name, count in items.items()))
    return (" ｜ ".join(parts) if parts else "问道得宝"), items


class WendaoModule:
    key = "wendao"
    label = "问道"
    default_state: dict = {
        "cooldown_until": 0.0,
        "last_observed_at": 0.0,
        "last_success_at": 0.0,
        "last_status": "unknown",
        "last_result": "",
        "last_error": "",
        "last_text_excerpt": "",
        "pending_result_msg_id": 0,
        "reward_items": {},
    }

    def resolve_target(self, event: RawMessageEvent, ctx) -> int | None:
        if ctx.sender_kind != "bot" or not ctx.parent_is_my_identity():
            return None
        if not _is_wendao_command(_parent_command(ctx)):
            return None
        return ctx.parent_sender()

    def observe(self, event: RawMessageEvent, ctx, state: dict) -> dict | None:
        text = str(event.text or "").strip()
        if not text:
            return None
        now = float(ctx.now or 0)
        new = dict(state)

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

        if WENDAO_CD_KEYWORD in text:
            wait_sec = parse_chinese_duration(text)
            until = now + wait_sec if wait_sec > 0 else now + WENDAO_CD_SEC
            new["pending_result_msg_id"] = 0
            return finish("cooldown", cooldown_until=until, result="冷却中")

        if WENDAO_PENDING_KEYWORD in text:
            try:
                new["pending_result_msg_id"] = int(event.msg_id or 0)
            except (TypeError, ValueError):
                new["pending_result_msg_id"] = 0
            return finish("pending", result="问道中")

        if text.startswith(WENDAO_RESULT_TITLE):
            summary, items = parse_wendao_result_summary(text)
            new["pending_result_msg_id"] = 0
            new["last_success_at"] = now
            new["reward_items"] = dict(items)
            return finish("success", cooldown_until=now + WENDAO_CD_SEC, result=summary)

        return None

    def compute_anchor(self, state: dict, *, now: float) -> float | None:
        cd_until = float(state.get("cooldown_until") or 0)
        if cd_until <= 0:
            return None
        return now if cd_until <= now else cd_until

    def status_summary(self, state: dict, *, now: float) -> dict:
        from backend.identity_state import fmt_remain

        status = str(state.get("last_status") or "unknown")
        cd_until = float(state.get("cooldown_until") or 0)
        result = str(state.get("last_result") or "").strip()
        if status == "unknown":
            return {"text": "未观测", "ready": False, "next_at": None, "status": status}
        if status == "pending":
            return {"text": result or "问道中", "ready": False, "next_at": None, "status": status}
        if cd_until > now:
            suffix = f"｜{result}" if result and result != "冷却中" else ""
            return {"text": f"剩 {fmt_remain(cd_until - now)}{suffix}", "ready": False, "next_at": cd_until, "status": status}
        return {"text": result or "已就绪", "ready": True, "next_at": cd_until or None, "status": status}


__all__ = [
    "CMD_WENDAO",
    "WENDAO_CD_KEYWORD",
    "WENDAO_PENDING_KEYWORD",
    "WENDAO_RESULT_TITLE",
    "WendaoModule",
    "parse_wendao_result_summary",
]
