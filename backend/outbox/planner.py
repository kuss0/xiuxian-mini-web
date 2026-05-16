from __future__ import annotations

from dataclasses import dataclass
from typing import Callable, Protocol

from backend.domain.models import ActionSuggestion


class OutboxStore(Protocol):
    def get_account(self, local_id: str) -> dict | None:
        ...

    def get_identity(self, send_as_id: int | str) -> dict | None:
        ...


PublicMapper = Callable[[dict | None], dict | None]


@dataclass(frozen=True)
class OutboxPlan:
    action: ActionSuggestion
    command: str
    identity: dict | None
    account: dict | None
    account_local_id: str
    missing: tuple[str, ...]
    target_chat: str

    @property
    def resolved(self) -> bool:
        return not self.missing

    def to_api(
        self,
        *,
        public_account: PublicMapper,
        public_identity: PublicMapper,
    ) -> dict:
        identity_id = self.identity.get("send_as_id") if self.identity else self.action.identity_id
        account_local_id = (self.account or {}).get("local_id") or self.account_local_id
        return {
            "ok": True,
            "resolved": self.resolved,
            "missing": list(self.missing),
            "send_mode": self.action.send_mode or "copy",
            "command": self.command,
            "chat_id": self.action.chat_id,
            "target_chat": self.target_chat,
            "reply_to_msg_id": self.action.reply_to_msg_id,
            "identity_id": identity_id,
            "send_as_id": identity_id,
            "account_local_id": account_local_id,
            "identity": public_identity(self.identity),
            "account": public_account(self.account),
            "can_send": False,
            "manual_confirm_required": True,
            "note": "这是手动 API 回复计划，不会由行为模块自动发送。",
        }


class OutboxPlanner:
    def __init__(self, store: OutboxStore) -> None:
        self._store = store

    def plan(self, payload: dict) -> OutboxPlan:
        action_payload = payload.get("action") if isinstance(payload.get("action"), dict) else payload
        action = ActionSuggestion.from_api(action_payload)
        command = action.command.strip()
        if not command:
            raise ValueError("缺少待发送命令")

        missing: list[str] = []
        identity = self._resolve_identity(action, missing)
        account_local_id = action.account_local_id or (identity or {}).get("account_local_id") or ""
        account = self._resolve_account(account_local_id, missing)

        # 对照 Py 主线 model/runtime.py:868-925 (_send_game_command_impl):
        # action.identity_id 就是 Telegram 的 send_as peer ID;一旦 == account.account_id,
        # 即「以自己身份发」(对应 Py 主线 _finalize_account_login 后自动注册的那条 identity)。
        # 即使用户没在 identities 表里手建这条,也按 self-identity 处理,不阻塞 plan。
        if identity is None and account is not None and action.identity_id is not None:
            try:
                account_id = int(str(account.get("account_id") or "").strip())
            except (TypeError, ValueError):
                account_id = 0
            if account_id != 0 and account_id == int(action.identity_id):
                identity = _synth_self_identity(account)
                while "identity" in missing:
                    missing.remove("identity")

        target_chat = str((account or {}).get("target_chat") or "").strip()
        if action.chat_id is None and not target_chat:
            missing.append("target_chat")

        # TODO(send_as): 真要发送时,对照 Py 主线 model/runtime.py:897-904
        # 的 await client.get_input_entity(send_as_id) + SendMessageRequest(send_as=…)
        # 路径,在这里把 identity_id 解析成 InputPeer 再交给发送出口。
        # mini-web 当前不真发送,先不接。

        return OutboxPlan(
            action=action,
            command=command,
            identity=identity,
            account=account,
            account_local_id=account_local_id,
            missing=tuple(dict.fromkeys(missing)),
            target_chat=target_chat,
        )

    def _resolve_identity(self, action: ActionSuggestion, missing: list[str]) -> dict | None:
        if action.identity_id is None:
            return None
        identity = self._store.get_identity(action.identity_id)
        if identity is None:
            missing.append("identity")
        return identity

    def _resolve_account(self, local_id: str, missing: list[str]) -> dict | None:
        if not local_id:
            missing.append("account")
            return None
        account = self._store.get_account(local_id)
        if account is None:
            missing.append("account")
        return account


def _synth_self_identity(account: dict) -> dict:
    return {
        "send_as_id": int(str(account.get("account_id") or "").strip() or 0),
        "account_local_id": str(account.get("local_id") or ""),
        "label": str(account.get("label") or "") or "自己",
        "username": "",
        "enabled": True,
        "note": "登录账号自身的 self-identity（自动合成,未写入身份表）",
        "kind": "self",
        "synthesized": True,
    }
