"""技能发送服务。

负责把 SkillRegistry 里登记的命令真的通过已登录 client 发到 Telegram。
有两种发送模式:
- 直接发送(reply_to=None):标准 send_message
- 回复发送(reply_to=msg_id):带 reply_to 标志,bot 才知道上下文(如 .加入副本 N、.抉择 ...)

skill_send_payload 只接受 reply_to_msg_id;不接受发送给非自己 send_as
(self-identity 才发,其它 send_as 留 TODO)。

发送成功后会立即把自己的 outgoing 消息 ingest 进 raw_messages(经由 event_sink 回调),
不再等 telethon 自己的 NewMessage 回调 — 老脚本里 outgoing 事件不稳定,solo 模式靠
parent-reply chain 串起来,缺了 outgoing 这条链就断了。
"""

from __future__ import annotations

import time
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Any, Callable

from backend.domain.models import RawMessageEvent
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

    event_sink:发送成功后,把 outgoing message 也 ingest 进消息箱(等价于 listener
    的 NewMessage 回调,但更可靠 — outgoing 事件 telethon 行为不一致)。
    """

    def __init__(
        self,
        registry: SkillRegistry,
        *,
        listener_lookup: Callable[[str], Any] | None = None,
        event_sink: Callable[[RawMessageEvent], None] | None = None,
        time_fn: Callable[[], float] = time.time,
    ):
        self._registry = registry
        self._listener_lookup = listener_lookup or (lambda _id: None)
        self._event_sink = event_sink
        self._time_fn = time_fn
        self._last_display = ""

    def registry(self) -> SkillRegistry:
        return self._registry

    def last_display(self) -> str:
        """最近一次成功 send 时 client.get_me() 拿到的显示名;给 server 用于
        hydrate account.label。空字符串表示还没成功过 / get_me 失败。"""
        return self._last_display

    def send(
        self,
        *,
        skill_key: str,
        chat_id: int,
        account_local_id: str,
        sender_id: int = 0,
        sender_display: str = "",
        account_key: str = "",
        reply_to_msg_id: int | None = None,
        topic_id: int | None = None,
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
        topic = int(topic_id or 0)
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
            sent = listener.submit(
                lambda client: self._send_on_client(
                    client,
                    chat_id=chat_id_int,
                    command=command,
                    reply_to_msg_id=reply_id,
                    topic_id=topic,
                )
            )
        except Exception as exc:
            # 老脚本 runtime.py:1536 在挂机模式下 catch FloodWaitError 暂停发送。
            # mini-web 一次一发不会循环,但还是要给用户一个可读的错误。
            exc_name = type(exc).__name__
            if "FloodWait" in exc_name:
                seconds = int(getattr(exc, "seconds", 0) or 0)
                if seconds > 0:
                    error = f"⏳ Telegram 限流:请等 {seconds}s 再发(FloodWait)"
                else:
                    error = f"⏳ Telegram 限流:{exc}"
            else:
                error = f"发送失败:{exc}"
            return SkillSendResult(
                ok=False,
                error=error,
                skill_key=skill_key,
                command=command,
                reply_to_msg_id=reply_id,
            )

        sent_msg_id = int((sent or {}).get("msg_id") or 0)
        # 优先用 client.get_me() 返回的真名,fallback 才用 server 传过来的 sender_display
        resolved_display = str((sent or {}).get("display") or "").strip()
        if resolved_display:
            self._last_display = resolved_display
        sent_at = self._time_fn()
        # outgoing 也 ingest 进消息箱,solo 模式才能把 bot 回复跟我的命令串起来
        if sent_msg_id > 0 and self._event_sink is not None and int(sender_id or 0) != 0:
            try:
                event = _outgoing_event(
                    chat_id=chat_id_int,
                    msg_id=sent_msg_id,
                    sender_id=int(sender_id),
                    sender_display=resolved_display or sender_display or str(sender_id),
                    text=command,
                    reply_to_msg_id=reply_id or None,
                    topic_id=topic or 0,
                    sent_at=sent_at,
                    account_key=account_key or str(sender_id),
                )
                self._event_sink(event)
            except Exception as exc:  # ingest 失败不阻塞发送结果
                print(f"[skill-send] outgoing ingest failed: {exc}")

        return SkillSendResult(
            ok=True,
            sent_msg_id=sent_msg_id,
            sent_at=sent_at,
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
        topic_id: int = 0,
    ) -> dict:
        """在已连接 client 上发一条。返回 {msg_id, display}。

        display 来自 client.get_me() 的 first_name/last_name/username,这样
        chat 里显示的发送者名跟 listener 解析其它消息时用的同一个口径
        (而不是 account.label 写死的手机号)。
        """
        if topic_id > 0 and reply_to_msg_id > 0:
            from telethon import functions, types
            peer = await client.get_input_entity(chat_id)
            reply_to_spec = types.InputReplyToMessage(
                reply_to_msg_id=int(reply_to_msg_id),
                top_msg_id=int(topic_id),
            )
            result = await client(
                functions.messages.SendMessageRequest(
                    peer=peer,
                    message=command,
                    reply_to=reply_to_spec,
                )
            )
            msg_id = 0
            for update in (getattr(result, "updates", None) or []):
                mid = getattr(update, "id", 0)
                if mid:
                    msg_id = int(mid)
                    break
        else:
            kwargs: dict[str, Any] = {}
            if reply_to_msg_id > 0:
                kwargs["reply_to"] = reply_to_msg_id
            elif topic_id > 0:
                kwargs["reply_to"] = topic_id
            sent = await client.send_message(chat_id, command, **kwargs)
            msg_id = int(getattr(sent, "id", 0) or 0)

        display = ""
        try:
            me = await client.get_me()
            display = _format_user_display(me)
        except Exception:
            display = ""
        return {"msg_id": msg_id, "display": display}


def _format_user_display(user) -> str:
    if user is None:
        return ""
    parts = [str(getattr(user, "first_name", "") or "").strip(),
             str(getattr(user, "last_name", "") or "").strip()]
    name = " ".join(p for p in parts if p).strip()
    if name:
        return name
    username = getattr(user, "username", None)
    if username:
        return f"@{str(username).lstrip('@').strip()}"
    return ""


def _outgoing_event(
    *,
    chat_id: int,
    msg_id: int,
    sender_id: int,
    sender_display: str,
    text: str,
    reply_to_msg_id: int | None,
    topic_id: int,
    sent_at: float,
    account_key: str,
) -> RawMessageEvent:
    date_text = datetime.fromtimestamp(sent_at, tz=timezone.utc).isoformat()
    # Telegram msg_id is unique inside a chat. Keep outgoing ids canonical so
    # bot replies can resolve their parent by tg:{chat_id}:{msg_id}.
    event_id = f"tg:{chat_id}:{msg_id}"
    return RawMessageEvent(
        id=event_id,
        chat_id=chat_id,
        msg_id=msg_id,
        text=text,
        source=sender_display,
        date=date_text,
        sender_id=sender_id,
        reply_to_msg_id=int(reply_to_msg_id) if reply_to_msg_id else None,
        top_msg_id=int(topic_id) if topic_id else None,
        mentions=(),
        sender_is_bot=False,
        edited_at=None,
        deleted_at=None,
        media_kind=None,
        media_meta=None,
    )


__all__ = ["SkillSendService", "SkillSendResult"]
