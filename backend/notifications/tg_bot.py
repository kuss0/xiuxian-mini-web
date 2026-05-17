"""Telegram bot notifier — 用一个独立 bot token + chat_id 推送通知。

老脚本对应:model/runtime.py:834 `_send_log_group_via_bot`。
独立 bot 的好处:不占用 user account 的发送份额,Telegram 限流也不会
误伤 game 命令。

Token 通过 BotFather 申请,chat_id 是接收方的 chat ID(私聊 = user_id;
群 = -100xxx)。
"""

from __future__ import annotations

import urllib.error
import urllib.parse
import urllib.request

from backend.notifications import NotificationEvent, Notifier

_API_BASE = "https://api.telegram.org"


class TelegramBotNotifier(Notifier):
    name = "tg_bot"

    def __init__(self, bot_token: str, chat_id: str, *, timeout: float = 6.0) -> None:
        self._token = (bot_token or "").strip()
        self._chat_id = str(chat_id or "").strip()
        self._timeout = float(timeout)

    def configured(self) -> bool:
        return bool(self._token) and bool(self._chat_id)

    def notify(self, event: NotificationEvent) -> tuple[bool, str]:
        if not self.configured():
            return False, "未配置 bot_token 或 chat_id"
        text = _format_event(event)
        url = f"{_API_BASE}/bot{self._token}/sendMessage"
        params = urllib.parse.urlencode({
            "chat_id": self._chat_id,
            "text": text,
            "disable_web_page_preview": "true",
        }).encode("utf-8")
        try:
            with urllib.request.urlopen(url, data=params, timeout=self._timeout) as resp:
                body = resp.read().decode("utf-8", errors="replace")
                if resp.status >= 200 and resp.status < 300:
                    if '"ok":true' in body or '"ok": true' in body:
                        return True, ""
                    return False, f"bot api non-ok: {body[:200]}"
                return False, f"HTTP {resp.status}: {body[:200]}"
        except urllib.error.HTTPError as exc:
            try:
                body = exc.read().decode("utf-8", errors="replace")
            except Exception:
                body = str(exc)
            return False, f"HTTP {exc.code}: {body[:200]}"
        except urllib.error.URLError as exc:
            return False, f"URL error: {exc}"
        except Exception as exc:
            return False, f"send failed: {exc}"


def _format_event(event: NotificationEvent) -> str:
    severity_prefix = {"risk": "🚨", "success": "✨"}.get(event.severity, "🔔")
    parts = [f"{severity_prefix} 【{event.title}】"]
    if event.body:
        parts.append(event.body[:1000])
    if event.target_url:
        parts.append(event.target_url)
    return "\n".join(parts)


__all__ = ["TelegramBotNotifier"]
