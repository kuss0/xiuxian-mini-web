from __future__ import annotations

import shlex
from collections.abc import Mapping as MappingABC
from dataclasses import dataclass
from typing import Callable, Iterable, Mapping

from backend.log_commands.allowlist import (
    LogCommandPolicy,
    classify_telegram_ingress,
)
from backend.log_commands.mapping import classify_group_mapping, specs_payload as mapping_specs_payload


class CommandLevel:
    OBSERVE = "observe"


COMMAND_LEVELS: dict[str, dict] = {
    CommandLevel.OBSERVE: {
        "key": CommandLevel.OBSERVE,
        "label": "只读观测",
        "can_mutate": False,
        "default_enabled": True,
        "description": "只读取健康、通知、状态或命令清单,不创建发送动作。",
    },
}


@dataclass(frozen=True)
class LogCommandSpec:
    name: str
    aliases: tuple[str, ...]
    level: str
    summary: str
    default_allowed: bool = True

    def to_api(self) -> dict:
        return {
            "name": self.name,
            "aliases": list(self.aliases),
            "level": self.level,
            "summary": self.summary,
            "default_allowed": self.default_allowed,
        }


LOG_COMMAND_SPECS: tuple[LogCommandSpec, ...] = (
    LogCommandSpec(
        "help",
        ("帮助", "指令", "help"),
        CommandLevel.OBSERVE,
        "查看日志群命令清单。",
    ),
    LogCommandSpec(
        "status",
        ("状态", "运行健康", "健康摘要", "health", "status"),
        CommandLevel.OBSERVE,
        "查看 mini-web 健康、listener 和数据库摘要。",
    ),
    LogCommandSpec(
        "notify_status",
        ("日志推送状态", "通知状态", "notify"),
        CommandLevel.OBSERVE,
        "查看通知推送配置摘要,不泄露 token。",
    ),
)


_SPECS_BY_NAME = {spec.name: spec for spec in LOG_COMMAND_SPECS}
_SPECS_BY_ALIAS = {
    alias.lower(): spec
    for spec in LOG_COMMAND_SPECS
    for alias in (spec.name, *spec.aliases)
}


@dataclass(frozen=True)
class ParsedLogCommand:
    spec: LogCommandSpec
    raw_name: str
    args: tuple[str, ...]
    prefix: str
    module_name: str = ""

    def to_api(self) -> dict:
        return {
            "name": self.spec.name,
            "raw_name": self.raw_name,
            "args": list(self.args),
            "prefix": self.prefix,
            "module_name": self.module_name,
            "level": self.spec.level,
        }


@dataclass(frozen=True)
class LogCommandSource:
    user_id: int = 0
    chat_id: int = 0
    msg_id: int = 0
    kind: str = "local_api"

    @classmethod
    def from_api(cls, payload: Mapping[str, object] | None) -> "LogCommandSource":
        payload = payload or {}
        return cls(
            user_id=_safe_int(payload.get("from_user_id") or payload.get("user_id")),
            chat_id=_safe_int(payload.get("chat_id")),
            msg_id=_safe_int(payload.get("msg_id") or payload.get("source_msg_id")),
            kind=str(payload.get("source_kind") or payload.get("kind") or "local_api").strip() or "local_api",
        )

    def to_api(self) -> dict:
        return {
            "user_id": self.user_id,
            "chat_id": self.chat_id,
            "msg_id": self.msg_id,
            "kind": self.kind,
        }


class LogCommandDispatcher:
    def __init__(
        self,
        *,
        settings: Mapping[str, object] | None = None,
        health_getter: Callable[[], dict] | None = None,
        inventory_current_getter: Callable[[], Iterable[dict]] | None = None,
    ) -> None:
        self._settings = settings or {}
        self._policy = LogCommandPolicy.from_settings(self._settings)
        self._health_getter = health_getter or (lambda: {})
        self._inventory_current_getter = inventory_current_getter or (lambda: ())

    def specs_payload(self) -> dict:
        return {
            "ok": True,
            "commands": [spec.to_api() for spec in LOG_COMMAND_SPECS],
            "levels": list(COMMAND_LEVELS.values()),
            "mappings": mapping_specs_payload(),
            "policy": self._policy.to_api(),
        }

    def dispatch(self, text: str, source: LogCommandSource) -> dict:
        if source.kind == "telegram":
            return self._dispatch_telegram(text, source)

        parsed = parse_log_command(text)
        if parsed is None:
            return {
                "ok": False,
                "status": "skip",
                "reply": "",
                "actions": [],
                "source": source.to_api(),
                "decision": {"kind": "skip", "reason": "not_a_log_command"},
            }

        decision = self._classify(parsed, source)
        if decision["kind"] != "run":
            return {
                "ok": False,
                "status": decision["kind"],
                "reply": decision.get("text", ""),
                "actions": [],
                "source": source.to_api(),
                "parsed": parsed.to_api(),
                "decision": decision,
            }

        result = self._run(parsed, source)
        result.setdefault("source", source.to_api())
        result.setdefault("parsed", parsed.to_api())
        result.setdefault("decision", decision)
        return result

    def _dispatch_telegram(self, text: str, source: LogCommandSource) -> dict:
        raw = str(text or "")
        if not raw:
            return _skip(source, reason="not_a_log_command")
        decision = self._telegram_ingress_kind(raw, source)
        if decision["kind"] == "skip":
            return {
                "ok": False,
                "status": "skip",
                "reply": "",
                "actions": [],
                "source": source.to_api(),
                "decision": decision,
            }
        if decision["kind"] == "reject":
            return {
                "ok": False,
                "status": "reject",
                "reply": decision.get("text", ""),
                "actions": [],
                "source": source.to_api(),
                "decision": decision,
            }

        if decision["ingress"] == "telegram_mapping":
            return self._run_group_mapping(raw, source, decision)

        parsed = parse_log_command(raw)
        if parsed is None:
            return _skip(source, reason="not_a_log_command", decision=decision)

        if not parsed.spec.default_allowed:
            return {
                "ok": False,
                "status": "reject",
                "reply": f"命令 {parsed.raw_name} 未允许从日志群触发。",
                "actions": [],
                "source": source.to_api(),
                "parsed": parsed.to_api(),
                "decision": {
                    **decision,
                    "kind": "reject",
                    "text": f"命令 {parsed.raw_name} 未允许从日志群触发。",
                    "reason": "command_not_allowed",
                },
            }

        result = self._run(parsed, source)
        result.setdefault("source", source.to_api())
        result.setdefault("parsed", parsed.to_api())
        result.setdefault("decision", decision)
        return result

    def _telegram_ingress_kind(self, text: str, source: LogCommandSource) -> dict:
        return classify_telegram_ingress(
            policy=self._policy,
            text=text,
            user_id=source.user_id,
            chat_id=source.chat_id,
        ).to_api()

    def _run_group_mapping(self, text: str, source: LogCommandSource, decision: dict) -> dict:
        mapped = classify_group_mapping(text, is_admin=bool(decision.get("is_admin")))
        if mapped.status == "skip":
            return _skip(source, reason="unknown_group_mapping", decision=decision)
        if mapped.status == "reject":
            return {
                "ok": False,
                "status": "reject",
                "reply": mapped.text,
                "actions": [],
                "source": source.to_api(),
                "decision": {**decision, "kind": "reject", "reason": mapped.reason, "text": mapped.text},
            }
        if mapped.name == "还有多少":
            item = mapped.args[0] if mapped.args else ""
            return self._inventory_find_simple(str(item), source, decision)
        return _skip(source, reason="unsupported_group_mapping", decision=decision)

    def _classify(self, parsed: ParsedLogCommand, source: LogCommandSource) -> dict:
        if source.kind == "local_api":
            return {"kind": "run", "ingress": "local_api", "is_admin": True}
        return {"kind": "skip", "reason": "unsupported_source"}

    def _run(self, parsed: ParsedLogCommand, source: LogCommandSource) -> dict:
        handlers = {
            "help": self._help,
            "status": self._status,
            "notify_status": self._notify_status,
        }
        handler = handlers.get(parsed.spec.name)
        if handler is None:
            return _reply(False, "error", f"未实现日志群命令: {parsed.spec.name}")
        return handler(parsed, source)

    def _help(self, parsed: ParsedLogCommand, source: LogCommandSource) -> dict:
        lines = ["mini-web 日志群命令:"]
        for spec in LOG_COMMAND_SPECS:
            alias = spec.aliases[0] if spec.aliases else spec.name
            lines.append(f"- /{alias}: {COMMAND_LEVELS[spec.level]['label']} - {spec.summary}")
        lines.append("群业务映射: .还有多少 <物品名> admin-only,只读脱敏库存合计。未知 .xxx 静默忽略。")
        lines.append("日志群入口只读;不创建 draft/send/schedule。")
        return _reply(True, "ok", "\n".join(lines), commands=[spec.to_api() for spec in LOG_COMMAND_SPECS])

    def _status(self, parsed: ParsedLogCommand, source: LogCommandSource) -> dict:
        health = self._health_getter() or {}
        listener = health.get("listener") if isinstance(health.get("listener"), dict) else {}
        db = health.get("db") if isinstance(health.get("db"), dict) else {}
        status_text = health.get("status") or ("ok" if health.get("ok") else "unknown")
        lines = [
            f"mini-web: {status_text}",
            f"listener: {listener.get('status') or health.get('listener_status') or 'unknown'}",
            f"database: {db.get('status') or health.get('db_status') or 'unknown'}",
        ]
        if health.get("message"):
            lines.append(str(health.get("message")))
        return _reply(True, "ok", "\n".join(lines), health=health)

    def _notify_status(self, parsed: ParsedLogCommand, source: LogCommandSource) -> dict:
        settings = self._settings
        enabled = _bool_value(settings.get("notify_enabled"))
        has_token = bool(str(settings.get("notify_tg_bot_token") or "").strip())
        chat = str(settings.get("notify_tg_chat_id") or "").strip()
        titles = settings.get("notify_card_titles") or []
        lines = [
            f"notify_enabled: {'on' if enabled else 'off'}",
            f"tg_bot_token: {'configured' if has_token else 'missing'}",
            f"tg_chat_id: {chat or 'missing'}",
            f"card_title_subscriptions: {len(titles) if isinstance(titles, list) else 0}",
        ]
        return _reply(True, "ok", "\n".join(lines))

    def _inventory_find_simple(self, item: str, source: LogCommandSource, decision: dict) -> dict:
        query = str(item or "").strip()
        if not query:
            return _reply(False, "reject", "usage: .还有多少 <物品名>")
        try:
            rows = list(self._inventory_current_getter() or ())
        except Exception as exc:
            return _reply(False, "error", f"库存读取失败: {exc}")

        needle = query.lower()
        grouped: dict[str, int] = {}
        for row in rows:
            if not isinstance(row, MappingABC):
                continue
            name = str(row.get("name") or row.get("item_name") or "").strip()
            if not name or needle not in name.lower():
                continue
            amount = _safe_int(row.get("amount"))
            if amount <= 0:
                continue
            grouped[name] = grouped.get(name, 0) + amount

        if not grouped:
            reply = f"{query} 库存(脱敏): 未找到当前库存记录。"
        else:
            total = sum(grouped.values())
            lines = [f"{query} 库存(脱敏): 合计 {total}"]
            for name in sorted(grouped):
                lines.append(f"- {name}: {grouped[name]}")
            lines.append("不显示账号明细。")
            reply = "\n".join(lines)
        return {
            "ok": True,
            "status": "ok",
            "reply": reply,
            "actions": [],
            "source": source.to_api(),
            "decision": decision,
            "mapping_result": {
                "name": "还有多少",
                "argv": ["inventory", "find", "--simple", query],
            },
        }

def parse_log_command(text: str) -> ParsedLogCommand | None:
    raw = str(text or "").strip()
    if not raw:
        return None
    if raw.startswith("/"):
        prefix = "/"
        body = raw[1:]
    elif raw.startswith("."):
        prefix = "."
        body = raw[1:]
    else:
        return None
    try:
        tokens = tuple(shlex.split(body))
    except ValueError:
        return None
    if not tokens:
        return None
    raw_name = tokens[0]
    name = raw_name.split("@", 1)[0] if prefix == "/" else raw_name
    key = name.lower()
    spec = _SPECS_BY_ALIAS.get(key)
    if spec is None:
        return ParsedLogCommand(
            spec=LogCommandSpec(name, (name,), CommandLevel.OBSERVE, "未知命令", default_allowed=False),
            raw_name=raw_name,
            args=tokens[1:],
            prefix=prefix,
        )
    return ParsedLogCommand(
        spec=spec,
        raw_name=raw_name,
        args=tokens[1:],
        prefix=prefix,
    )


def _reply(ok: bool, status: str, reply: str, **extra) -> dict:
    payload = {
        "ok": ok,
        "status": status,
        "reply": reply,
        "actions": extra.pop("actions", []),
    }
    payload.update(extra)
    return payload


def _skip(source: LogCommandSource, *, reason: str, decision: dict | None = None) -> dict:
    merged = {"kind": "skip", "reason": reason}
    if decision:
        merged.update(decision)
        merged["kind"] = "skip"
        merged["reason"] = reason
    return {
        "ok": False,
        "status": "skip",
        "reply": "",
        "actions": [],
        "source": source.to_api(),
        "decision": merged,
    }


def _safe_int(value: object) -> int:
    try:
        return int(str(value or "0").strip() or 0)
    except (TypeError, ValueError):
        return 0
