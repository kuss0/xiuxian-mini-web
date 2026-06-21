from __future__ import annotations

import shlex
from collections.abc import Mapping as MappingABC
from dataclasses import dataclass
from typing import Callable, Iterable, Mapping

from backend.log_commands.mapping import classify_group_mapping


class CommandLevel:
    OBSERVE = "observe"
    DRAFT = "draft"
    MANUAL_SEND = "manual_send"
    OFFICIAL_SCHEDULE = "official_schedule"


COMMAND_LEVELS: dict[str, dict] = {
    CommandLevel.OBSERVE: {
        "key": CommandLevel.OBSERVE,
        "label": "只读观测",
        "can_mutate": False,
        "default_enabled": True,
        "description": "只读取健康、通知、状态或命令清单,不创建发送动作。",
    },
    CommandLevel.DRAFT: {
        "key": CommandLevel.DRAFT,
        "label": "发放草稿",
        "can_mutate": True,
        "default_enabled": True,
        "description": "只创建 outbox draft,后续仍需 Web UI 人工确认或复制。",
    },
    CommandLevel.MANUAL_SEND: {
        "key": CommandLevel.MANUAL_SEND,
        "label": "立即实发",
        "can_mutate": True,
        "default_enabled": False,
        "description": "调用现有 /api/skills/send 手动发送入口;默认策略关闭。",
    },
    CommandLevel.OFFICIAL_SCHEDULE: {
        "key": CommandLevel.OFFICIAL_SCHEDULE,
        "label": "官方定时",
        "can_mutate": True,
        "default_enabled": False,
        "description": "创建 Telegram 官方 scheduled message;默认只能走 Web 排班。",
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
        "levels",
        ("层级", "发送层级", "发放层级", "levels"),
        CommandLevel.OBSERVE,
        "查看发送/发放层级和默认开关。",
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
    LogCommandSpec(
        "module_status",
        (),
        CommandLevel.OBSERVE,
        "查看某个模块状态;语法为 .<模块>状态。",
    ),
    LogCommandSpec(
        "draft",
        ("草稿", "发放草稿", "draft"),
        CommandLevel.DRAFT,
        "把命令落成 outbox draft,不实发。",
    ),
    LogCommandSpec(
        "manual_send",
        ("发送", "实发", "send"),
        CommandLevel.MANUAL_SEND,
        "请求立即实发;必须显式开启 log_command_manual_send_enabled。",
        default_allowed=False,
    ),
    LogCommandSpec(
        "official_schedule",
        ("官方定时", "排班", "schedule"),
        CommandLevel.OFFICIAL_SCHEDULE,
        "请求官方定时;必须显式开启 log_command_schedule_enabled。",
        default_allowed=False,
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


@dataclass(frozen=True)
class LogCommandPolicy:
    enabled: bool = False
    admin_ids: tuple[int, ...] = ()
    chat_id: int = 0
    mapping_chat_id: int = 0
    extra_commands: tuple[str, ...] = ()
    manual_send_enabled: bool = False
    schedule_enabled: bool = False

    @classmethod
    def from_settings(cls, settings: Mapping[str, object] | None) -> "LogCommandPolicy":
        settings = settings or {}
        return cls(
            enabled=_bool_value(settings.get("log_command_enabled")),
            admin_ids=tuple(_int_items(settings.get("log_command_admin_ids"))),
            chat_id=_safe_int(settings.get("log_command_chat_id")),
            mapping_chat_id=_safe_int(settings.get("log_command_mapping_chat_id")),
            extra_commands=tuple(
                item.lower()
                for item in _str_items(settings.get("log_command_extra_commands"))
            ),
            manual_send_enabled=_bool_value(settings.get("log_command_manual_send_enabled")),
            schedule_enabled=_bool_value(settings.get("log_command_schedule_enabled")),
        )

    def to_api(self) -> dict:
        return {
            "enabled": self.enabled,
            "admin_count": len(self.admin_ids),
            "chat_configured": bool(self.chat_id),
            "mapping_chat_configured": bool(self.effective_mapping_chat_id),
            "group_members_allowed": bool(self.effective_mapping_chat_id),
            "extra_commands": list(self.extra_commands),
            "manual_send_enabled": self.manual_send_enabled,
            "schedule_enabled": self.schedule_enabled,
        }

    @property
    def effective_mapping_chat_id(self) -> int:
        return self.mapping_chat_id or self.chat_id


@dataclass(frozen=True)
class SendIntent:
    command: str
    identity_id: int = 0
    account_local_id: str = ""
    chat_id: int = 0
    reply_to_msg_id: int = 0
    skill_key: str = ""
    identity_selector: str = ""
    warnings: tuple[str, ...] = ()

    def to_action_payload(self, *, label: str, source: LogCommandSource) -> dict:
        payload: dict[str, object] = {
            "type": "log_group_command",
            "label": label,
            "command": self.command,
            "send_mode": "copy",
            "source_message_id": _source_message_id(source),
        }
        if self.identity_id:
            payload["identity_id"] = self.identity_id
        if self.account_local_id:
            payload["account_local_id"] = self.account_local_id
        if self.chat_id:
            payload["chat_id"] = self.chat_id
        if self.reply_to_msg_id:
            payload["reply_to_msg_id"] = self.reply_to_msg_id
        return payload


class LogCommandDispatcher:
    def __init__(
        self,
        *,
        settings: Mapping[str, object] | None = None,
        health_getter: Callable[[], dict] | None = None,
        identities_getter: Callable[[], Iterable[dict]] | None = None,
        skills_getter: Callable[[], Iterable[object]] | None = None,
        inventory_current_getter: Callable[[], Iterable[dict]] | None = None,
    ) -> None:
        self._settings = settings or {}
        self._policy = LogCommandPolicy.from_settings(self._settings)
        self._health_getter = health_getter or (lambda: {})
        self._identities_getter = identities_getter or (lambda: ())
        self._skills_getter = skills_getter or (lambda: ())
        self._inventory_current_getter = inventory_current_getter or (lambda: ())

    def specs_payload(self) -> dict:
        return {
            "ok": True,
            "commands": [spec.to_api() for spec in LOG_COMMAND_SPECS],
            "levels": list(COMMAND_LEVELS.values()),
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

        allowed_names = {parsed.spec.name, parsed.raw_name.lower()}
        allowed = parsed.spec.default_allowed or bool(allowed_names & set(self._policy.extra_commands))
        if not allowed:
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
        if not self._policy.enabled:
            return {
                "kind": "reject",
                "text": "日志群命令未启用。",
                "reason": "command_listener_disabled",
            }

        is_admin = source.user_id in self._policy.admin_ids
        in_log_group = bool(self._policy.chat_id) and source.chat_id == self._policy.chat_id
        admin_dm = is_admin and source.chat_id == source.user_id
        mapping_chat_id = self._policy.effective_mapping_chat_id
        in_mapping_group = bool(mapping_chat_id) and source.chat_id == mapping_chat_id

        if text.startswith("/"):
            if not is_admin:
                return {"kind": "skip", "reason": "not_admin", "is_admin": False}
            if not self._policy.chat_id and not self._policy.admin_ids:
                return {
                    "kind": "reject",
                    "text": "日志群命令未配置 log_command_chat_id/log_command_admin_ids,不接受 Telegram 入站。",
                    "reason": "chat_not_configured",
                    "is_admin": True,
                }
            if not in_log_group and not admin_dm:
                return {"kind": "skip", "reason": "chat_not_allowed", "is_admin": True}
            ingress = "telegram_group" if in_log_group else "telegram_admin_dm"
            return {"kind": "run", "ingress": ingress, "is_admin": True}

        if text.startswith("."):
            if not in_mapping_group:
                return {
                    "kind": "skip",
                    "reason": "mapping_chat_not_allowed",
                    "is_admin": is_admin,
                }
            return {
                "kind": "run",
                "ingress": "telegram_mapping",
                "mapping": "group",
                "is_admin": is_admin,
            }

        return {"kind": "skip", "reason": "not_a_log_command", "is_admin": is_admin}

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

        if not self._policy.enabled:
            return {
                "kind": "reject",
                "text": "日志群命令未启用。",
                "reason": "command_listener_disabled",
            }

        is_admin = source.user_id in self._policy.admin_ids
        in_log_group = bool(self._policy.chat_id) and source.chat_id == self._policy.chat_id
        admin_dm = is_admin and source.chat_id == source.user_id
        if not self._policy.chat_id and not self._policy.admin_ids:
            return {
                "kind": "reject",
                "text": "日志群命令未配置 log_command_chat_id,不接受 Telegram 入站。",
                "reason": "chat_not_configured",
            }

        if not in_log_group and not admin_dm:
            return {
                "kind": "reject",
                "text": "当前 chat 不在日志群命令白名单内。",
                "reason": "chat_not_allowed",
            }

        allowed_names = {parsed.spec.name, parsed.raw_name.lower()}
        allowed = parsed.spec.default_allowed or bool(allowed_names & set(self._policy.extra_commands))
        if not allowed:
            return {
                "kind": "reject",
                "text": f"命令 {parsed.raw_name} 未允许从日志群触发。",
                "reason": "command_not_allowed",
            }
        ingress = "telegram_group" if in_log_group else "telegram_admin_dm"
        return {"kind": "run", "ingress": ingress, "is_admin": is_admin}

    def _run(self, parsed: ParsedLogCommand, source: LogCommandSource) -> dict:
        handlers = {
            "help": self._help,
            "levels": self._levels,
            "status": self._status,
            "notify_status": self._notify_status,
            "module_status": self._module_status,
            "draft": self._draft,
            "manual_send": self._manual_send,
            "official_schedule": self._official_schedule,
        }
        handler = handlers.get(parsed.spec.name)
        if handler is None:
            return _reply(False, "error", f"未实现日志群命令: {parsed.spec.name}")
        return handler(parsed, source)

    def _help(self, parsed: ParsedLogCommand, source: LogCommandSource) -> dict:
        lines = ["mini-web 日志群命令:"]
        for spec in LOG_COMMAND_SPECS:
            if spec.name == "module_status":
                lines.append("- .<模块>状态: 本地 API 读取模块状态摘要")
                continue
            alias = spec.aliases[0] if spec.aliases else spec.name
            lines.append(f"- /{alias}: {COMMAND_LEVELS[spec.level]['label']} - {spec.summary}")
        lines.append("群业务映射: .还有多少 <物品名> admin-only,只读脱敏库存合计。未知 .xxx 静默忽略。")
        lines.append("发送动作分层仅保留本地 API/调试入口;Telegram 点号不创建 draft/send。")
        return _reply(True, "ok", "\n".join(lines), commands=[spec.to_api() for spec in LOG_COMMAND_SPECS])

    def _levels(self, parsed: ParsedLogCommand, source: LogCommandSource) -> dict:
        lines = ["日志群发送/发放层级:"]
        for level in COMMAND_LEVELS.values():
            enabled = "默认开" if level["default_enabled"] else "默认关"
            lines.append(f"- {level['key']}: {level['label']}({enabled}) - {level['description']}")
        lines.append(
            "当前策略: "
            f"manual_send={'on' if self._policy.manual_send_enabled else 'off'}, "
            f"official_schedule={'on' if self._policy.schedule_enabled else 'off'}"
        )
        return _reply(True, "ok", "\n".join(lines), levels=list(COMMAND_LEVELS.values()))

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

    def _module_status(self, parsed: ParsedLogCommand, source: LogCommandSource) -> dict:
        module = parsed.module_name or (parsed.args[0] if parsed.args else "")
        if not module:
            return _reply(False, "error", "缺少模块名;用法: .<模块>状态")
        return _reply(
            True,
            "ok",
            f"{module}状态: 已识别日志群状态查询。当前接口先返回命令层结果;详细 per-identity 状态仍以 Web UI/API 为准。",
            module=module,
        )

    def _draft(self, parsed: ParsedLogCommand, source: LogCommandSource) -> dict:
        intent = self._send_intent(parsed.args)
        if not intent.command:
            return _reply(False, "error", "缺少待发命令;用法: .草稿 <命令或技能key> [@身份]")
        action = {
            "kind": "outbox_draft",
            "level": CommandLevel.DRAFT,
            "payload": intent.to_action_payload(label="日志群草稿", source=source),
            "warnings": list(intent.warnings),
        }
        reply = f"已生成 outbox draft 意图: {intent.command}"
        if intent.identity_id:
            reply += f"\nidentity_id: {intent.identity_id}"
        if intent.warnings:
            reply += "\n" + "\n".join(f"warning: {item}" for item in intent.warnings)
        return _reply(True, "ok", reply, actions=[action])

    def _manual_send(self, parsed: ParsedLogCommand, source: LogCommandSource) -> dict:
        if not self._policy.manual_send_enabled:
            return _reply(
                False,
                "blocked",
                "日志群立即实发默认关闭;需显式开启 log_command_manual_send_enabled。",
                blocked_level=CommandLevel.MANUAL_SEND,
            )
        intent = self._send_intent(parsed.args)
        if not intent.command:
            return _reply(False, "error", "缺少待发命令;用法: .发送 <命令或技能key> @身份")
        if not intent.identity_id:
            return _reply(False, "error", "立即实发必须指定 @身份或 identity_id。")
        payload = intent.to_action_payload(label="日志群立即实发", source=source)
        payload["skill_key"] = intent.skill_key or "manual_send"
        payload["command_override"] = intent.command
        return _reply(
            True,
            "ok",
            f"已生成立即实发动作: {intent.command}",
            actions=[{"kind": "manual_send", "level": CommandLevel.MANUAL_SEND, "payload": payload}],
        )

    def _official_schedule(self, parsed: ParsedLogCommand, source: LogCommandSource) -> dict:
        if not self._policy.schedule_enabled:
            return _reply(
                False,
                "blocked",
                "日志群官方定时默认关闭;请通过 Web 排班确认账号、身份、时间和 Telegram 配额。",
                blocked_level=CommandLevel.OFFICIAL_SCHEDULE,
            )
        return _reply(
            False,
            "blocked",
            "日志群官方定时命令层已建模,但本脚本仍要求走 Web 排班落库和预检。",
            blocked_level=CommandLevel.OFFICIAL_SCHEDULE,
        )

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

    def _send_intent(self, args: Iterable[str]) -> SendIntent:
        tokens = [str(item).strip() for item in args if str(item or "").strip()]
        command_tokens: list[str] = []
        identity_selector = ""
        skill_key = ""
        chat_id = 0
        reply_to = 0
        i = 0
        while i < len(tokens):
            token = tokens[i]
            if token in {"--identity", "--as"} and i + 1 < len(tokens):
                identity_selector = tokens[i + 1]
                i += 2
                continue
            if token.startswith("--identity=") or token.startswith("--as="):
                identity_selector = token.split("=", 1)[1]
                i += 1
                continue
            if token.startswith("@") and not identity_selector:
                identity_selector = token[1:]
                i += 1
                continue
            if token == "--chat" and i + 1 < len(tokens):
                chat_id = _safe_int(tokens[i + 1])
                i += 2
                continue
            if token.startswith("--chat="):
                chat_id = _safe_int(token.split("=", 1)[1])
                i += 1
                continue
            if token == "--reply" and i + 1 < len(tokens):
                reply_to = _safe_int(tokens[i + 1])
                i += 2
                continue
            if token.startswith("--reply="):
                reply_to = _safe_int(token.split("=", 1)[1])
                i += 1
                continue
            if token == "--skill" and i + 1 < len(tokens):
                skill_key = tokens[i + 1]
                i += 2
                continue
            if token.startswith("--skill="):
                skill_key = token.split("=", 1)[1]
                i += 1
                continue
            command_tokens.append(token)
            i += 1

        skills = list(self._skills_getter() or ())
        skill = _resolve_skill(skill_key, skills) if skill_key else None
        if skill is None and command_tokens:
            skill = _resolve_skill(command_tokens[0], skills)
            if skill is not None and not str(command_tokens[0]).startswith("."):
                command_tokens = [str(getattr(skill, "command", "") or ""), *command_tokens[1:]]
        if skill is not None:
            skill_key = str(getattr(skill, "key", "") or "").strip()
            if not command_tokens:
                command_tokens = [str(getattr(skill, "command", "") or "").strip()]

        command = " ".join(item for item in command_tokens if item).strip()
        identity, identity_warnings = _resolve_identity(identity_selector, self._identities_getter())
        identity_id = _safe_int((identity or {}).get("send_as_id"))
        account_local_id = str((identity or {}).get("account_local_id") or "").strip()
        warnings = list(identity_warnings)
        if identity_selector and identity is None:
            warnings.append(f"未解析身份: {identity_selector}")
        return SendIntent(
            command=command,
            identity_id=identity_id,
            account_local_id=account_local_id,
            chat_id=chat_id,
            reply_to_msg_id=reply_to,
            skill_key=skill_key,
            identity_selector=identity_selector,
            warnings=tuple(dict.fromkeys(warnings)),
        )


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
    module_name = ""
    if spec is None and prefix == "." and name.endswith("状态") and len(name) > 2:
        spec = _SPECS_BY_NAME["module_status"]
        module_name = name[:-2]
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
        module_name=module_name,
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


def _resolve_skill(value: str, skills: Iterable[object]) -> object | None:
    target = str(value or "").strip()
    if not target:
        return None
    normalized = target.lower()
    for skill in skills:
        candidates = {
            str(getattr(skill, "key", "") or "").strip().lower(),
            str(getattr(skill, "label", "") or "").strip().lower(),
            str(getattr(skill, "command", "") or "").strip().lower(),
            str(getattr(skill, "command", "") or "").strip().lstrip(".").lower(),
        }
        if normalized in candidates:
            return skill
    return None


def _resolve_identity(selector: str, identities: Iterable[dict]) -> tuple[dict | None, tuple[str, ...]]:
    selector = str(selector or "").strip().lstrip("@")
    if not selector:
        return None, ()
    exact_id = _safe_int(selector)
    matches = []
    for identity in identities or ():
        send_as_id = _safe_int(identity.get("send_as_id"))
        label = str(identity.get("label") or "").strip()
        username = str(identity.get("username") or "").strip().lstrip("@")
        if exact_id and send_as_id == exact_id:
            return identity, ()
        if selector and selector in {label, username}:
            matches.append(identity)
    if len(matches) == 1:
        return matches[0], ()
    if len(matches) > 1:
        return None, (f"身份选择器 {selector} 命中多个身份,请改用 send_as_id。",)
    return None, ()


def _source_message_id(source: LogCommandSource) -> str:
    if source.chat_id and source.msg_id:
        return f"log-command:{source.chat_id}:{source.msg_id}"
    return "log-command:local"


def _int_items(raw: object) -> list[int]:
    out: list[int] = []
    for item in _str_items(raw):
        value = _safe_int(item)
        if value:
            out.append(value)
    return sorted(set(out))


def _str_items(raw: object) -> list[str]:
    if raw is None:
        return []
    if isinstance(raw, str):
        raw = raw.replace("\n", ",").split(",")
    if not isinstance(raw, (list, tuple, set)):
        raw = [raw]
    return [str(item).strip() for item in raw if str(item or "").strip()]


def _safe_int(value: object) -> int:
    try:
        return int(str(value or "0").strip() or 0)
    except (TypeError, ValueError):
        return 0


def _bool_value(value: object) -> bool:
    if isinstance(value, bool):
        return value
    return str(value or "").strip().lower() in {"1", "true", "yes", "on"}
