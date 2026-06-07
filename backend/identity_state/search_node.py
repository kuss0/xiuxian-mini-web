from __future__ import annotations

import re

from backend.domain.models import RawMessageEvent
from backend.identity_state.duration import parse_chinese_duration

CMD_SEARCH_NODE = ".搜寻节点"
CMD_STABILIZE_NODE = ".定星"
SEARCH_NODE_CD_SEC = 12 * 3600

RE_SEARCH_NODE_NODE = re.compile(r"获得[：:]\s*【([^】]+)】\s*x(\d+)")
RE_SEARCH_NODE_DUST = re.compile(r"【虚空尘埃】x(\d+)")
RE_SEARCH_NODE_XIUWEI_LOSS = re.compile(r"修为损失了\s*([\d,]+)\s*点")
RE_SEARCH_NODE_WEAK_TIME = re.compile(r"陷入了\s*(?:(\d+)\s*小时)?\s*(?:(\d+)\s*分钟)?\s*(?:(\d+)\s*秒)?\s*的【虚弱状态】")
RE_STABILIZE_NODE_NAME = re.compile(r"【(空间节点·[^】]+)】")

SEARCH_NODE_RESULT_TITLES = {
    "【虚空漫游】": "虚空漫游",
    "【天机垂青】": "获得节点",
    "【大凶之兆】": "大凶之兆",
    "【斩妖除魔】": "斩妖除魔",
}
SEARCH_NODE_PENDING_PREFIX = "你盘膝而坐，神识离体"
SEARCH_NODE_INTERMEDIATE_PREFIX = "【虚空遭遇】"
SEARCH_NODE_CD_KEYWORDS = ("神识尚在恢复中", "后再行搜寻")
SEARCH_NODE_WEAK_KEYWORD = "虚弱状态"
SEARCH_NODE_PAUSE_KEYWORDS = ("【境界不足】", "修为不足", "神识不足")


def _parent_command(ctx) -> str:
    if ctx.parent and ctx.parent.text:
        return str(ctx.parent.text or "").strip()
    return ""


def _is_search_node_command(command: str) -> bool:
    return str(command or "").strip() == CMD_SEARCH_NODE


def _is_stabilize_command(command: str) -> bool:
    raw = str(command or "").strip()
    return raw == CMD_STABILIZE_NODE or raw.startswith(f"{CMD_STABILIZE_NODE} ")


def _parse_int(value: object) -> int:
    try:
        return int(str(value or "0").replace(",", ""))
    except (TypeError, ValueError):
        return 0


def _extract_result_title(text: str) -> str:
    raw_text = str(text or "").strip()
    for prefix, title in SEARCH_NODE_RESULT_TITLES.items():
        if raw_text.startswith(prefix):
            return title
    if raw_text.startswith(SEARCH_NODE_INTERMEDIATE_PREFIX):
        return "天魔战斗中"
    return ""


def _extract_space_node(text: str) -> str:
    for name, _count in RE_SEARCH_NODE_NODE.findall(str(text or "")):
        name = str(name or "").strip()
        if name.startswith("空间节点"):
            return name
    return ""


def _parse_weak_time(text: str) -> int:
    match = RE_SEARCH_NODE_WEAK_TIME.search(str(text or ""))
    if not match:
        return 0
    hours, minutes, seconds = match.groups()
    return int(hours or 0) * 3600 + int(minutes or 0) * 60 + int(seconds or 0)


def parse_search_node_result_summary(text: str) -> str:
    raw_text = str(text or "").strip()
    title = _extract_result_title(raw_text)
    parts: list[str] = []
    if match := RE_SEARCH_NODE_NODE.search(raw_text):
        parts.append(f"节点：{match.group(1)}x{match.group(2)}")
    dust = [_parse_int(count) for count in RE_SEARCH_NODE_DUST.findall(raw_text)]
    if dust:
        parts.append(f"虚空尘埃x{sum(dust)}")
    if match := RE_SEARCH_NODE_XIUWEI_LOSS.search(raw_text):
        parts.append(f"修为损失：{str(match.group(1)).replace(',', '')}")
    if SEARCH_NODE_WEAK_KEYWORD in raw_text:
        parts.append("陷入虚弱")
    return f"{title or '虚弱静养'}｜{'、'.join(parts)}" if parts else (title or "未知结果")


class SearchNodeModule:
    key = "search_node"
    label = "搜寻节点"
    default_state: dict = {
        "cooldown_until": 0.0,
        "weak_until": 0.0,
        "last_observed_at": 0.0,
        "last_success_at": 0.0,
        "last_status": "unknown",
        "last_result": "",
        "last_error": "",
        "last_text_excerpt": "",
        "pending_msg_id": 0,
        "last_node": "",
        "stabilize_command": "",
        "stabilize_last_result": "",
    }

    def resolve_target(self, event: RawMessageEvent, ctx) -> int | None:
        if ctx.sender_kind != "bot" or not ctx.parent_is_my_identity():
            return None
        parent_cmd = _parent_command(ctx)
        if not (_is_search_node_command(parent_cmd) or _is_stabilize_command(parent_cmd)):
            return None
        return ctx.parent_sender()

    def observe(self, event: RawMessageEvent, ctx, state: dict) -> dict | None:
        text = str(event.text or "").strip()
        if not text:
            return None
        now = float(ctx.now or 0)
        parent_cmd = _parent_command(ctx)
        new = dict(state)

        def finish(status: str, *, cooldown_until: float | None = None, weak_until: float | None = None, result: str = "", error: str = "") -> dict:
            new["last_observed_at"] = now
            new["last_status"] = status
            new["last_text_excerpt"] = text[:180]
            if cooldown_until is not None:
                new["cooldown_until"] = float(cooldown_until or 0)
            if weak_until is not None:
                new["weak_until"] = float(weak_until or 0)
            if result:
                new["last_result"] = result
            new["last_error"] = error
            return new

        if _is_stabilize_command(parent_cmd):
            if text.startswith("【定星成功】"):
                new["stabilize_last_result"] = text.splitlines()[0].strip()
                return finish("stabilized", result=new["stabilize_last_result"])
            if "定星失败" in text or "材料不足" in text or "没有【空间节点" in text:
                new["stabilize_last_result"] = text.splitlines()[0].strip() if text.splitlines() else text[:80]
                return finish("stabilize_failed", result=new["stabilize_last_result"], error=new["stabilize_last_result"])
            return None

        if any(keyword in text for keyword in SEARCH_NODE_CD_KEYWORDS):
            wait_sec = parse_chinese_duration(text)
            until = now + wait_sec if wait_sec > 0 else now + SEARCH_NODE_CD_SEC
            new["pending_msg_id"] = 0
            return finish("cooldown", cooldown_until=until, result="冷却中")

        if text.startswith(SEARCH_NODE_PENDING_PREFIX):
            new["pending_msg_id"] = int(event.msg_id or 0)
            return finish("pending", result="搜寻中")

        if text.startswith(SEARCH_NODE_INTERMEDIATE_PREFIX):
            new["pending_msg_id"] = int(event.msg_id or 0)
            return finish("intermediate", result="天魔战斗中")

        weak_sec = _parse_weak_time(text)
        if weak_sec > 0:
            new["pending_msg_id"] = 0
            return finish(
                "weak",
                cooldown_until=now + SEARCH_NODE_CD_SEC,
                weak_until=now + weak_sec,
                result=parse_search_node_result_summary(text),
            )

        result_title = _extract_result_title(text)
        if result_title:
            new["pending_msg_id"] = 0
            new["last_success_at"] = now
            if node := _extract_space_node(text):
                new["last_node"] = node
                new["stabilize_command"] = f"{CMD_STABILIZE_NODE} {node}"
            return finish("success", cooldown_until=now + SEARCH_NODE_CD_SEC, result=parse_search_node_result_summary(text))

        if any(keyword in text for keyword in SEARCH_NODE_PAUSE_KEYWORDS):
            reason = text.splitlines()[0].strip() if text.splitlines() else text[:120]
            new["pending_msg_id"] = 0
            return finish("blocked", cooldown_until=0, result="失败", error=reason)

        return None

    def compute_anchor(self, state: dict, *, now: float) -> float | None:
        if str(state.get("last_status") or "") == "blocked":
            return None
        cd_until = float(state.get("cooldown_until") or 0)
        weak_until = float(state.get("weak_until") or 0)
        anchor = max(cd_until, weak_until)
        if anchor <= 0:
            return None
        return now if anchor <= now else anchor

    def status_summary(self, state: dict, *, now: float) -> dict:
        from backend.identity_state import fmt_remain

        status = str(state.get("last_status") or "unknown")
        cd_until = float(state.get("cooldown_until") or 0)
        weak_until = float(state.get("weak_until") or 0)
        next_at = max(cd_until, weak_until)
        node = str(state.get("last_node") or "")
        if status == "unknown":
            return {"text": "未观测", "ready": False, "next_at": None, "status": status}
        if status in {"pending", "intermediate"}:
            return {"text": str(state.get("last_result") or "搜寻中"), "ready": False, "next_at": None, "status": status}
        if status == "blocked":
            return {"text": str(state.get("last_error") or "不可用"), "ready": False, "next_at": None, "status": status}
        if weak_until > now:
            return {"text": f"虚弱剩 {fmt_remain(weak_until - now)}", "ready": False, "next_at": next_at, "status": status}
        if cd_until > now:
            suffix = f"｜{node}" if node else ""
            return {"text": f"剩 {fmt_remain(cd_until - now)}{suffix}", "ready": False, "next_at": next_at, "status": status}
        suffix = f"｜{node}" if node else ""
        return {"text": f"已就绪{suffix}", "ready": True, "next_at": next_at or None, "status": status}


__all__ = [
    "CMD_SEARCH_NODE",
    "CMD_STABILIZE_NODE",
    "SearchNodeModule",
    "parse_search_node_result_summary",
]
