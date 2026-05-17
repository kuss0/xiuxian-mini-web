"""Telegram 用户登录(手机号 + 验证码 + 2FA),所有 Telethon 调用走一个常驻线程
里的常驻 asyncio loop。

为什么要这样:HTTP server 是 ThreadingHTTPServer,每个请求落到不同线程,
而我们用的是 stdlib `asyncio.run(...)` 包装 async 调用 → 每次请求都创建新 loop。
Telethon `TelegramClient.connect()` 把 client 绑死在第一个 loop 上,后续 await
若发生在新 loop,就报 "The asyncio event loop must not change after connection"。
登录是天然跨多次 HTTP 请求(发码 → 验证码 → 可能 2FA),client 必须复用,
因此把 login 整体搬到一个常驻 loop。

dialogs / send_as / get_send_as 这些一次性请求不受影响 —— 它们的 client 全程
只在一次 asyncio.run 里使用,不跨 loop。
"""

from __future__ import annotations

import asyncio
import threading
from dataclasses import dataclass
from typing import Any

from backend.tg.client import create_telegram_client, import_telethon


@dataclass
class PendingLogin:
    client: Any
    phone: str
    phone_code_hash: str


class TelegramLoginService:
    def __init__(self) -> None:
        self._pending: dict[str, PendingLogin] = {}
        self._lock = threading.Lock()
        self._loop: asyncio.AbstractEventLoop | None = None
        self._loop_thread: threading.Thread | None = None

    # ---------- public sync API(server / app 层直接同步调用) ----------

    def send_code(self, settings: dict, key: str = "default") -> dict:
        return self._await(self._send_code(settings, key))

    def verify_code(self, code: str, password: str | None = None, key: str = "default") -> dict:
        return self._await(self._verify_code(code, password, key))

    def cancel(self, key: str = "default") -> dict:
        return self._await(self._cancel(key))

    # ---------- 常驻 loop ----------

    def _ensure_loop(self) -> asyncio.AbstractEventLoop:
        with self._lock:
            existing = self._loop
            if (
                existing is not None
                and not existing.is_closed()
                and self._loop_thread is not None
                and self._loop_thread.is_alive()
            ):
                return existing
            loop = asyncio.new_event_loop()
            ready = threading.Event()

            def _runner() -> None:
                asyncio.set_event_loop(loop)
                # 等 loop 真正进了 run_forever 才唤醒等待方,避免 race:
                # 否则 run_coroutine_threadsafe 可能赶在 run_forever 之前调度,
                # 在某些 Python 版本上会让 callback 排队但不被消费。
                loop.call_soon(ready.set)
                try:
                    loop.run_forever()
                finally:
                    loop.close()

            thread = threading.Thread(target=_runner, name="miniweb-login-loop", daemon=True)
            thread.start()
            if not ready.wait(timeout=5):
                raise RuntimeError("login event loop 启动超时")
            self._loop = loop
            self._loop_thread = thread
            return loop

    def _await(self, coro):
        loop = self._ensure_loop()
        future = asyncio.run_coroutine_threadsafe(coro, loop)
        return future.result()

    # ---------- 内部 async ----------

    async def _send_code(self, settings: dict, key: str) -> dict:
        phone = str(settings.get("phone") or "").strip()
        if not phone:
            raise ValueError("请先填写手机号")

        await self._cancel(key)
        client = create_telegram_client(settings)
        await client.connect()
        try:
            sent = await client.send_code_request(phone)
        except Exception:
            await client.disconnect()
            raise
        self._pending[key] = PendingLogin(
            client=client,
            phone=phone,
            phone_code_hash=sent.phone_code_hash,
        )
        return {"status": "waiting_code", "message": "验证码已发送,请在 Telegram 客户端查收"}

    async def _verify_code(self, code: str, password: str | None, key: str) -> dict:
        telethon = import_telethon()
        pending = self._pending.get(key)
        if pending is None:
            raise ValueError("当前没有进行中的登录流程,请先发送验证码")
        code = str(code or "").strip()
        password = str(password or "").strip()
        if not code and not password:
            raise ValueError("请输入验证码或两步验证密码")

        client = pending.client
        try:
            if password:
                await client.sign_in(password=password)
            else:
                await client.sign_in(
                    pending.phone,
                    code,
                    phone_code_hash=pending.phone_code_hash,
                )
        except telethon.errors.SessionPasswordNeededError:
            return {"status": "need_2fa", "message": "需要两步验证密码"}
        except Exception:
            await self._cancel(key)
            raise

        me = await client.get_me()
        account_id = str(getattr(me, "id", "") or "")
        username = str(getattr(me, "username", "") or "").lstrip("@")
        await client.disconnect()
        self._pending.pop(key, None)
        return {
            "status": "done",
            "message": "登录成功",
            "account_id": account_id,
            "username": username,
        }

    async def _cancel(self, key: str) -> dict:
        pending = self._pending.pop(key, None)
        if pending is not None:
            try:
                await pending.client.disconnect()
            except Exception:
                pass
        return {"status": "idle", "message": "已取消登录流程"}
