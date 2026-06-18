"""Schedule-facing contract for observe-only identity state modules.

The state machines own gameplay timing evidence.  Official scheduling consumes
their output as an anchor and as guard metadata; it does not infer gameplay
state from commands alone.
"""
from __future__ import annotations

import math
from typing import Any

from backend.identity_state.contracts import module_contract_api

DEFAULT_SCHEDULE_HORIZON_DAYS = 3
STALE_STATE_SECONDS = 7 * 86400

MODULE_HINTS: dict[str, dict[str, Any]] = {
    "deep_retreat": {
        "preset_key": "deep_retreat",
        "command": ".深度闭关",
        "trigger_command": "查看闭关",
        "interval_sec": 8 * 3600,
        "automation_level": "one_click",
        "reason": "阶段型玩法,需要先看结算/查询回复",
    },
    "yuanying": {
        "preset_key": "yuanying",
        "command": ".元婴出窍",
        "trigger_command": ".元婴状态",
        "interval_sec": 8 * 3600,
        "automation_level": "one_click",
        "reason": "阶段型玩法,需要先看状态/归窍回复",
    },
    "pet_touch": {
        "preset_key": "pet_touch",
        "command": ".抚摸法宝",
        "interval_sec": 2 * 3600,
        "arg_state_key": "pet_name",
        "arg_payload_key": "pet_name",
        "automation_level": "one_click",
        "reason": "需要确认法宝名",
    },
    "pet_warm": {
        "preset_key": "pet_warm",
        "command": ".温养器灵",
        "interval_sec": 6 * 3600,
        "arg_state_key": "pet_name",
        "arg_payload_key": "pet_name",
        "automation_level": "one_click",
        "reason": "需要确认器灵名",
    },
    "pet_trial": {
        "preset_key": "pet_trial",
        "command": ".器灵试炼",
        "interval_sec": 8 * 3600,
        "arg_state_key": "pet_name",
        "arg_payload_key": "pet_name",
        "automation_level": "one_click",
        "reason": "需要确认器灵名",
    },
    "retreat_shallow": {
        "preset_key": "retreat_shallow",
        "command": ".闭关修炼",
        "interval_sec": 10 * 60,
        "count": 24,
        "automation_level": "one_click",
        "reason": "高频闭关只允许小批量人工确认",
    },
    "concubine_heart": {
        "preset_key": "custom",
        "command": ".共历心劫",
        "interval_sec": 12 * 3600,
        "automation_level": "manual_followup",
        "reason": "共历心劫需要回复天尊提示继续选择,只做状态观测和手动接力",
    },
    "stargazer_guide": {
        "preset_key": "stargazer_guide",
        "command": ".牵引星辰",
        "interval_sec": 6 * 3600,
        "automation_level": "one_click",
        "reason": "牵引星辰通常需要星名;裸牵引只保留人工确认",
    },
    "stargazer_soothe": {
        "preset_key": "stargazer_soothe",
        "command": ".安抚星辰",
        "interval_sec": 6 * 3600,
        "automation_level": "one_click",
        "reason": "安抚是否需要执行取决于观星台状态,先保留人工确认",
    },
    "stargazer_collect": {
        "preset_key": "stargazer_collect",
        "command": ".收集精华",
        "interval_sec": 6 * 3600,
        "automation_level": "one_click",
        "reason": "收集是否有产出取决于观星台状态,先保留人工确认",
    },
    "wendao": {
        "preset_key": "wendao",
        "command": ".问道",
        "interval_sec": 12 * 3600,
        "automation_level": "semiauto",
        "reason": "12 小时 CD,以问道结果或 CD 回复为起点",
    },
    "yindao": {
        "preset_key": "yindao",
        "command": ".引道",
        "interval_sec": 12 * 3600,
        "arg_state_key": "choice",
        "automation_level": "semiauto",
        "reason": "12 小时 CD,属性来自最近一次真实回复的父命令",
    },
    "search_node": {
        "preset_key": "search_node",
        "command": ".搜寻节点",
        "interval_sec": 12 * 3600,
        "automation_level": "manual_followup",
        "reason": "可能触发虚弱和定星后续,先保留人工确认",
    },
    "small_world": {
        "preset_key": "custom",
        "command": ".小世界",
        "interval_sec": 0,
        "automation_level": "state_only",
        "reason": "小世界状态用于判断香火/祈愿/显灵窗口,不直接生成官方定时",
    },
    "weakness": {
        "preset_key": "custom",
        "command": "",
        "interval_sec": 0,
        "automation_level": "state_only",
        "reason": "虚弱/静思是全局风险约束,不应单独排官方定时",
    },
}

# Built-in whitelist for the first semi-automatic tier.  It deliberately avoids
# phaseful modules, parameter-heavy modules, and very high-frequency loops.
SEMIAUTO_MODULE_KEYS = {
    "wild_training",
    "checkin",
    "tower",
    "ranch",
    "concubine_dream",
    "concubine_tianji",
    "tianti_climb",
    "tianti_wenxin",
    "tianti_gangfeng",
    "second_soul",
    "taiyi_cycle",
    "wendao",
    "yindao",
}

PRESET_MODULE_KEYS = {
    "deep_retreat",
    "yuanying",
    "pet_touch",
    "pet_warm",
    "pet_trial",
    "retreat_shallow",
    "stargazer_guide",
    "stargazer_soothe",
    "stargazer_collect",
    *SEMIAUTO_MODULE_KEYS,
}


def _as_float(value: object) -> float:
    try:
        return float(value or 0)
    except (TypeError, ValueError):
        return 0.0


def _has_observation(state: dict, record: dict | None) -> bool:
    if record and _as_float(record.get("updated_at")) > 0:
        return True
    for key in ("last_observed_at", "last_success_at", "cooldown_until", "entered_at", "summary_at"):
        if _as_float(state.get(key)) > 0:
            return True
    return False


def _default_count(interval_sec: int) -> int:
    if interval_sec <= 0:
        return 1
    count = int(math.floor((DEFAULT_SCHEDULE_HORIZON_DAYS * 86400) / interval_sec)) + 1
    return max(1, min(100, count))


def _generic_hint(module: object) -> dict:
    spec = getattr(module, "spec", None)
    if spec is None:
        return {}
    commands = tuple(getattr(spec, "commands", ()) or ())
    command = str(commands[0] if commands else "").strip()
    default_cd = int(getattr(spec, "default_cd_sec", 0) or 0)
    daily = bool(getattr(spec, "daily_reset", False) or getattr(spec, "daily_window_utc_hour", None) is not None)
    interval = default_cd or (24 * 3600 if daily else 0)
    arg_label = str(getattr(spec, "arg_label", "") or "")
    key = str(getattr(module, "key", "") or "")
    return {
        "preset_key": key if key in PRESET_MODULE_KEYS else "custom",
        "command": command,
        "interval_sec": interval,
        "arg_state_key": arg_label,
        "arg_payload_key": "pet_name" if arg_label == "pet_name" else "",
        "automation_level": "semiauto" if key in SEMIAUTO_MODULE_KEYS else "one_click",
        "reason": "",
    }


def schedule_hint(module: object, state: dict | None = None) -> dict:
    state = state or {}
    key = str(getattr(module, "key", "") or "")
    hint = {**_generic_hint(module), **MODULE_HINTS.get(key, {})}
    command = str(hint.get("command") or "").strip()
    arg_key = str(hint.get("arg_state_key") or "").strip()
    arg_value = str(state.get(arg_key) or "").strip() if arg_key else ""
    if command and arg_value and arg_key:
        command = f"{command} {arg_value}"
    interval_sec = int(hint.get("interval_sec") or 0)
    try:
        count = int(hint.get("count") or 0)
    except (TypeError, ValueError):
        count = 0
    if count <= 0:
        count = _default_count(interval_sec)
    count = max(1, min(100, count))
    payload_defaults = {
        "preset_key": str(hint.get("preset_key") or "custom"),
        "command": command,
        "interval_sec": interval_sec,
        "count": count,
        "horizon_days": DEFAULT_SCHEDULE_HORIZON_DAYS,
    }
    trigger_command = str(hint.get("trigger_command") or "").strip()
    if trigger_command:
        payload_defaults["trigger_command"] = trigger_command
    arg_payload_key = str(hint.get("arg_payload_key") or "")
    if arg_payload_key and arg_value:
        payload_defaults[arg_payload_key] = arg_value
    return {
        "preset_key": str(hint.get("preset_key") or "custom"),
        "command": command,
        "base_command": str(hint.get("command") or ""),
        "trigger_command": trigger_command,
        "interval_sec": interval_sec,
        "count": count,
        "horizon_days": DEFAULT_SCHEDULE_HORIZON_DAYS,
        "arg_state_key": arg_key,
        "arg_payload_key": arg_payload_key,
        "arg_value": arg_value,
        "requires_argument": bool(arg_key and not arg_value),
        "automation_level": str(hint.get("automation_level") or "one_click"),
        "semiauto_whitelisted": key in SEMIAUTO_MODULE_KEYS,
        "payload_defaults": payload_defaults,
        "reason": str(hint.get("reason") or ""),
    }


def build_schedule_state_contract(
    module: object,
    record: dict | None,
    *,
    send_as_id: int = 0,
    now: float,
    tianjige_status: dict | None = None,
    tianjige_profile: dict | None = None,
    observation: dict | None = None,
) -> dict:
    state = dict((record or {}).get("state") or {})
    updated_at = _as_float((record or {}).get("updated_at"))
    source_message_id = str((record or {}).get("source_message_id") or "")
    summary: dict
    try:
        summary = dict(module.status_summary(state, now=now))
    except Exception:
        summary = {"text": "状态摘要失败", "ready": False, "next_at": None, "status": "error"}
    try:
        anchor = module.compute_anchor(state, now=now)
    except Exception:
        anchor = None
    next_at = _as_float(anchor)
    observed = _has_observation(state, record)
    hint = schedule_hint(module, state)
    warnings: list[dict] = []

    def warn(code: str, message: str, severity: str = "warn") -> None:
        warnings.append({"code": code, "message": message, "severity": severity})

    if not observed:
        warn("unobserved", "未观测到机器人回复,无法证明定时起点", "risk")
    if observed and next_at <= 0:
        warn("missing_anchor", "状态机没有给出 next_at,只能人工确认", "risk")
    stale_state = updated_at > 0 and now - updated_at > STALE_STATE_SECONDS
    if stale_state:
        warn("stale", "状态超过 7 天未刷新,建议先重新观察", "warn")
    if hint["requires_argument"]:
        warn("missing_argument", "建议命令缺少必要参数", "risk")

    phase = str(state.get("phase") or "")
    if phase in {"running", "waiting_summary", "post_summary_wait"}:
        warn("phaseful", "阶段型状态需要人工确认结算/查询结果", "warn")

    automation_level = hint["automation_level"]
    if automation_level == "state_only":
        warn("state_only", hint.get("reason") or "该模块只提供状态约束,不生成官方定时", "info")
    elif automation_level == "manual_followup":
        warn("manual_followup", hint.get("reason") or "该模块需要人工接力", "warn")
    elif automation_level != "semiauto":
        reason = hint.get("reason") or "该模块未进入半自动白名单"
        warn("manual_only", reason, "info")
    if hint["interval_sec"] and int(hint["interval_sec"]) < 3600:
        warn("high_frequency", "间隔小于 1 小时,不允许白名单半自动", "warn")

    semiauto_ready = (
        automation_level == "semiauto"
        and hint["semiauto_whitelisted"]
        and observed
        and next_at > 0
        and not stale_state
        and not hint["requires_argument"]
        and not any(w["severity"] == "risk" for w in warnings)
        and not (hint["interval_sec"] and int(hint["interval_sec"]) < 3600)
    )
    tianjige = tianjige_status or {}
    api_profile = tianjige_profile or {}
    evidence = dict(observation or {})
    sources = ["bot_reply"] if observed else []
    if api_profile.get("available"):
        sources.append("tianjige_profile")
    confidence = "unknown"
    if observed and next_at > 0:
        confidence = "stale" if stale_state else "high"
    elif api_profile.get("available"):
        confidence = "api_profile_only"
    return {
        "module_key": str(getattr(module, "key", "") or ""),
        "label": str(getattr(module, "label", "") or getattr(module, "key", "") or ""),
        "module_contract": module_contract_api(str(getattr(module, "key", "") or "")),
        "send_as_id": int(send_as_id or 0),
        "summary": summary,
        "next_at": next_at if next_at > 0 else None,
        "next_at_source": "bot_reply" if observed and next_at > 0 else "",
        "confidence": confidence,
        "sources": sources,
        "source_message_id": source_message_id,
        "updated_at": updated_at,
        "evidence": {
            "latest_observation": evidence,
            "latest_decision": str(evidence.get("decision") or ""),
            "latest_reason": str(evidence.get("reason") or ""),
            "latest_family": str(evidence.get("family") or ""),
            "latest_observed_at": float(evidence.get("observed_at") or 0),
            "has_state_update_event": str(evidence.get("decision") or "") == "updated",
        },
        "suggestion": hint,
        "payload_defaults": dict(hint.get("payload_defaults") or {}),
        "warnings": warnings,
        "semiauto_ready": semiauto_ready,
        "one_click_ready": (
            observed
            and next_at > 0
            and not stale_state
            and bool(hint.get("command"))
            and automation_level not in {"state_only", "manual_followup"}
        ),
        "tianjige": {
            "enabled": bool(tianjige.get("enabled")),
            "mode": str(tianjige.get("mode") or ""),
            "authenticated": bool(tianjige.get("authenticated")),
            "message": str(tianjige.get("message") or ""),
            "profile_available": bool(api_profile.get("available")),
            "profile_source_message_id": str(api_profile.get("source_message_id") or ""),
            "profile_updated_at": str(api_profile.get("updated_at") or ""),
            "profile_keys": list(api_profile.get("keys") or []),
        },
    }


def apply_schedule_contract_defaults(payload: dict, contract: dict | None) -> dict:
    if not contract:
        return dict(payload or {})
    out = dict(payload or {})
    suggestion = contract.get("suggestion") or {}
    if out.get("schedule_use_module_defaults", True):
        defaults = dict(suggestion.get("payload_defaults") or contract.get("payload_defaults") or {})
        for key, value in defaults.items():
            if value not in (None, ""):
                out[key] = value
        if not defaults:
            if suggestion.get("preset_key"):
                out["preset_key"] = suggestion["preset_key"]
            if suggestion.get("command"):
                out["command"] = suggestion["command"]
            if suggestion.get("interval_sec"):
                out["interval_sec"] = suggestion["interval_sec"]
            if suggestion.get("count"):
                out["count"] = suggestion["count"]
            if suggestion.get("trigger_command"):
                out["trigger_command"] = suggestion["trigger_command"]
        arg_payload_key = str(suggestion.get("arg_payload_key") or "")
        arg_value = str(suggestion.get("arg_value") or "")
        if arg_payload_key and arg_value:
            out[arg_payload_key] = arg_value
    return out


__all__ = [
    "DEFAULT_SCHEDULE_HORIZON_DAYS",
    "PRESET_MODULE_KEYS",
    "SEMIAUTO_MODULE_KEYS",
    "apply_schedule_contract_defaults",
    "build_schedule_state_contract",
    "schedule_hint",
]
