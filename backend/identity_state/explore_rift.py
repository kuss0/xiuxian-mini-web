from __future__ import annotations

import re

from backend.domain.models import RawMessageEvent
from backend.identity_state.duration import parse_chinese_duration

CMD_EXPLORE_RIFT = ".探寻裂缝"
EXPLORE_RIFT_CD_SEC = 12 * 3600

EXPLORE_RIFT_PENDING_KEYWORD = "撕开一道漆黑的空间裂缝"
EXPLORE_RIFT_CD_KEYWORD = "空间裂缝尚未稳定"
EXPLORE_RIFT_SUCCESS_TITLES = ("【探寻成功】", "【激战得胜】")
EXPLORE_RIFT_FAILURE_TITLES = ("【遭遇风暴】", "【不敌败退】")

RE_RIFT_XIUWEI_GAIN = re.compile(r"修为(?:最终)?(?:增加了|增加)\s*([\d,]+)\s*点")
RE_RIFT_XIUWEI_LOSS = re.compile(r"修为(?:倒退了|倒退|暴跌了|损失)\s*([\d,]+)\s*点")
RE_RIFT_REWARD = re.compile(r"【([^】]+)】\s*[x×*＊]\s*([\d,]+)")


def _parent_command(ctx) -> str:
    if ctx.parent and ctx.parent.text:
        return str(ctx.parent.text or "").strip()
    return ""


def _is_explore_rift_command(command: str) -> bool:
    raw = str(command or "").strip()
    return raw == CMD_EXPLORE_RIFT or raw.startswith(f"{CMD_EXPLORE_RIFT} ")


def _parse_int(value: object) -> int:
    try:
        return int(str(value or "0").replace(",", ""))
    except (TypeError, ValueError):
        return 0


def _title(text: str) -> str:
    first = str(text or "").strip().splitlines()[0] if str(text or "").strip() else ""
    if first.startswith("【") and "】" in first:
        return first.split("】", 1)[0].strip("【")
    return ""


def parse_explore_rift_summary(text: str) -> tuple[str, dict[str, int]]:
    raw = str(text or "").strip()
    parts: list[str] = []
    rewards: dict[str, int] = {}
    if match := RE_RIFT_XIUWEI_GAIN.search(raw):
        parts.append(f"修为 +{_parse_int(match.group(1))}")
    if match := RE_RIFT_XIUWEI_LOSS.search(raw):
        parts.append(f"修为 -{_parse_int(match.group(1))}")
    for name, count_text in RE_RIFT_REWARD.findall(raw):
        item = str(name or "").strip()
        count = _parse_int(count_text)
        if item and count > 0 and item not in {"探寻成功", "激战得胜", "遭遇风暴", "不敌败退"}:
            rewards[item] = rewards.get(item, 0) + count
    if rewards:
        parts.append("奖励：" + "、".join(f"{name}x{count}" for name, count in rewards.items()))
    title = _title(raw)
    if title in {"遭遇风暴", "不敌败退"} and parts:
        parts.insert(0, title)
    return (" ｜ ".join(parts) if parts else (title or "探寻裂缝结果")), rewards


class ExploreRiftModule:
    key = "explore_rift"
    label = "探寻裂缝"
    default_state: dict = {
        "cooldown_until": 0.0,
        "last_observed_at": 0.0,
        "last_success_at": 0.0,
        "last_status": "unknown",
        "last_result": "",
        "last_error": "",
        "last_text_excerpt": "",
        "pending_msg_id": 0,
        "reward_items": {},
    }

    def resolve_target(self, event: RawMessageEvent, ctx) -> int | None:
        if ctx.sender_kind != "bot" or not ctx.parent_is_my_identity():
            return None
        if not _is_explore_rift_command(_parent_command(ctx)):
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
            new["last_text_excerpt"] = text[:180]
            if cooldown_until is not None:
                new["cooldown_until"] = float(cooldown_until or 0)
            if result:
                new["last_result"] = result
            new["last_error"] = error
            return new

        if EXPLORE_RIFT_CD_KEYWORD in text:
            wait_sec = parse_chinese_duration(text)
            until = now + wait_sec if wait_sec > 0 else now + EXPLORE_RIFT_CD_SEC
            new["pending_msg_id"] = 0
            return finish("cooldown", cooldown_until=until, result="冷却中")

        if EXPLORE_RIFT_PENDING_KEYWORD in text or "时空异兽" in text or "探寻机缘" in text:
            new["pending_msg_id"] = int(event.msg_id or 0)
            return finish("pending", result="探寻中")

        if any(text.startswith(prefix) for prefix in (*EXPLORE_RIFT_SUCCESS_TITLES, *EXPLORE_RIFT_FAILURE_TITLES)):
            summary, rewards = parse_explore_rift_summary(text)
            new["pending_msg_id"] = 0
            new["last_success_at"] = now
            new["reward_items"] = dict(rewards)
            status = "success" if any(text.startswith(prefix) for prefix in EXPLORE_RIFT_SUCCESS_TITLES) else "failed"
            return finish(status, cooldown_until=now + EXPLORE_RIFT_CD_SEC, result=summary)

        if any(marker in text for marker in ("境界不足", "未到元婴", "修为不足")):
            reason = text.splitlines()[0].strip() if text.splitlines() else text[:120]
            new["pending_msg_id"] = 0
            return finish("blocked", cooldown_until=0, result="不可用", error=reason)

        return None

    def compute_anchor(self, state: dict, *, now: float) -> float | None:
        if str(state.get("last_status") or "") == "blocked":
            return None
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
            return {"text": result or "探寻中", "ready": False, "next_at": None, "status": status}
        if status == "blocked":
            return {"text": str(state.get("last_error") or "不可用"), "ready": False, "next_at": None, "status": status}
        if cd_until > now:
            suffix = f"｜{result}" if result and result != "冷却中" else ""
            return {"text": f"剩 {fmt_remain(cd_until - now)}{suffix}", "ready": False, "next_at": cd_until, "status": status}
        return {"text": result or "已就绪", "ready": True, "next_at": cd_until or None, "status": status}


__all__ = [
    "CMD_EXPLORE_RIFT",
    "EXPLORE_RIFT_CD_SEC",
    "ExploreRiftModule",
    "parse_explore_rift_summary",
]
