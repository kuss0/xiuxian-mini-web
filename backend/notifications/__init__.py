"""通知模块。

抽象一个 `Notifier` interface,具体实现支持多通道。
当前 MVP 只接入 Telegram bot(`tg_bot.TelegramBotNotifier`),后续可以加 Bark / 钉钉 /
浏览器 push 等,接口保持稳定。

触发逻辑:
- ingest_event 解析出 card 后,如果 card.title 在 settings.notify_card_titles 里
  → NotificationDispatcher.dispatch(NotificationEvent)
- Dispatcher 根据 settings 决定走哪些 channel(目前只有 TG)
"""

from __future__ import annotations

import time
from dataclasses import dataclass
from typing import Iterable


@dataclass(frozen=True)
class NotificationEvent:
    kind: str            # "card" / "module_ready" / "risk" 等
    title: str           # 卡片标题或事件名
    body: str            # 详细文本(原消息或摘要)
    source_id: str = ""  # 来源 message_id,用于去重
    severity: str = "normal"  # normal | risk | success
    target_url: str = ""      # 可选,跳转链接


class Notifier:
    name: str

    def notify(self, event: NotificationEvent) -> tuple[bool, str]:
        """返回 (ok, error_text);失败别抛,只返回 ok=False。"""
        raise NotImplementedError


__all__ = ["NotificationEvent", "Notifier"]
