"""技能发送服务。

负责把 SkillRegistry 里登记的命令真的通过已登录 client 发到 Telegram。
有两种发送模式:
- 直接发送(reply_to=None):标准 send_message
- 回复发送(reply_to=msg_id):带 reply_to 标志,bot 才知道上下文(如 .加入副本 N、.抉择 ...)

skill_send_payload 只接受 reply_to_msg_id;不接受发送给非自己 send_as
(self-identity 才发,其它 send_as 留 TODO)。
"""

from __future__ import annotations

import time
from dataclasses import dataclass
from typing import Any, Callable

from backend.skills import Skill, SkillRegistry


@dataclass(frozen=True)
class SkillSendResult:
    ok: bool
    sent_msg_id: int = 0
    sent_at: float = 0.0
    error: str = ""
    command: str = ""
    skill_key: str = ""
    reply_to_msg_id: int = 0

    def to_api(self) -> dict:
        return {
            "ok": self.ok,
            "sent_msg_id": self.sent_msg_id,
            "sent_at": self.sent_at,
            "error": self.error,
            "command": self.command,
            "skill_key": self.skill_key,
            "reply_to_msg_id": self.reply_to_msg_id,
        }


class SkillSendService:
    """实际跑 send 的服务。需要 listener manager 注入,这样能复用已登录 client。
    没 listener 的情况下,所有 Telethon 调用都失败 — 这是预期的(未登录就不能发)。
    """

    def __init__(
        self,
        registry: SkillRegistry,
        *,
        listener_lookup: Callable[[str], Any] | None = None,
        time_fn: Callable[[], float] = time.time,
    ):
        self._registry = registry
        self._listener_lookup = listener_lookup or (lambda _id: None)
        self._time_fn = time_fn

    def registry(self) -> SkillRegistry:
        return self._registry

    def send(
        self,
        *,
        skill_key: str,
        chat_id: int,
        account_local_id: str,
        reply_to_msg_id: int | None = None,
        command_override: str = "",
    ) -> SkillSendResult:
        """同步入口,内部用 listener.submit 跑到 listener loop 里。"""
        skill = self._registry.get(skill_key)
        if skill is None:
            return SkillSendResult(ok=False, error=f"未知技能 key: {skill_key}", skill_key=skill_key)

        command = (command_override or skill.command).strip()
        if not command:
            return SkillSendResult(ok=False, error="命令文本为空", skill_key=skill_key)

        try:
            chat_id_int = int(chat_id)
        except (TypeError, ValueError):
            return SkillSendResult(ok=False, error="chat_id 必须是数字", skill_key=skill_key, command=command)
        if chat_id_int == 0:
            return SkillSendResult(ok=False, error="chat_id 不能为 0", skill_key=skill_key, command=command)

        reply_id = int(reply_to_msg_id or 0)
        if skill.reply_mode == "required" and reply_id <= 0:
            return SkillSendResult(
                ok=False,
                error=f"该技能必须回复发送(reply_to_msg_id),command={command}",
                skill_key=skill_key,
                command=command,
            )

        listener = self._listener_lookup(str(account_local_id or "").strip())
        if listener is None:
            return SkillSendResult(
                ok=False,
                error="account 没在采集运行中,无法用其 client 发送(需先登录并启动 listener)",
                skill_key=skill_key,
                command=command,
            )

        try:
            sent_msg_id = listener.submit(
                lambda client: self._send_on_client(
                    client,
                    chat_id=chat_id_int,
                    command=command,
                    reply_to_msg_id=reply_id,
                )
            )
        except Exception as exc:
            return SkillSendResult(
                ok=False,
                error=f"发送失败:{exc}",
                skill_key=skill_key,
                command=command,
                reply_to_msg_id=reply_id,
            )

        return SkillSendResult(
            ok=True,
            sent_msg_id=int(sent_msg_id or 0),
            sent_at=self._time_fn(),
            command=command,
            skill_key=skill_key,
            reply_to_msg_id=reply_id,
        )

    async def _send_on_client(
        self,
        client,
        *,
        chat_id: int,
        command: str,
        reply_to_msg_id: int,
    ) -> int:
        """在已连接 client 上发一条。返回 Telegram 给的 msg_id(>0 表示成功)。"""
        kwargs: dict[str, Any] = {}
        if reply_to_msg_id > 0:
            kwargs["reply_to"] = reply_to_msg_id
        sent = await client.send_message(chat_id, command, **kwargs)
        return int(getattr(sent, "id", 0) or 0)


__all__ = ["SkillSendService", "SkillSendResult"]
