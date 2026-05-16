from __future__ import annotations

from backend.domain.models import ParsedCard, RawMessageEvent, StatePatch
from backend.parsers import build_parser_registry
from backend.processors import MessagePipeline


SAMPLE_EVENTS = [
    RawMessageEvent(
        id="sample-1",
        chat_id=0,
        msg_id=1,
        source="韩天尊",
        date="待接入 Telegram",
        text="【第二元神归位】\n道友 @example 的第二元神已结束修炼，回归窍中温养。",
        sender_is_bot=True,
    ),
    RawMessageEvent(
        id="sample-2",
        chat_id=0,
        msg_id=2,
        source="韩天尊",
        date="待接入 Telegram",
        text="【虚天殿已开启】\n副本ID: 394\n其他道友可使用 .加入副本 394 加入队伍！",
        sender_is_bot=True,
    ),
    RawMessageEvent(
        id="sample-3",
        chat_id=0,
        msg_id=3,
        source="韩天尊",
        date="待接入 Telegram",
        text=(
            "🚨 【天道审判 · 挂机嫌疑】 🚨\n\n"
            "对象 【example】，你被举报使用了自动化傀儡法术！\n"
            "审判关卡：第 1/1 关\n"
            "文本题面：请直接计算：计算：(890+24×9) 除以 31 的余数 = ?\n"
            "🔐 本轮阵眼口令：U9EX\n"
            "3分钟内未自证或答错，将被永久打入死牢。"
        ),
        sender_is_bot=True,
    ),
    RawMessageEvent(
        id="sample-4",
        chat_id=0,
        msg_id=4,
        source="韩天尊",
        date="待接入 Telegram",
        text=(
            "@example 的天命玉牒\n"
            "────────────────\n"
            "称号: 【紫灵的轻吻】\n"
            "宗门: 【凌霄宫】\n"
            "灵根: 天灵根(火)\n"
            "修为: 445955 / 1000000"
        ),
        sender_is_bot=True,
    ),
    RawMessageEvent(
        id="sample-5",
        chat_id=0,
        msg_id=5,
        source="韩天尊",
        date="待接入 Telegram",
        text=(
            "📊 【天机阁 · 战力评估】\n\n"
            "👤 修士: 空尘子 (@example)\n"
            "🏔️ 境界: 元婴中期 (凌霄宫)\n"
            "⚔️ 综合战力: 333.8万\n"
            "【力量构成】:\n"
            " - 基础修为: 135.2万\n"
            " - 祭出法宝: +81.2万"
        ),
        sender_is_bot=True,
    ),
    RawMessageEvent(
        id="sample-6",
        chat_id=0,
        msg_id=6,
        source="韩天尊",
        date="待接入 Telegram",
        text="【example的储物袋】\n凝血草 x 128\n玄天灵果 x 3\n灵石 x 360000",
        sender_is_bot=True,
    ),
]


class SampleStore:
    def __init__(self) -> None:
        self._pipeline = MessagePipeline(build_parser_registry())
        cards = []
        patches = {}
        for event in SAMPLE_EVENTS:
            output = self._pipeline.process(event)
            cards.extend(output.cards)
            for patch in output.state_patches:
                patches[(patch.scope, patch.key)] = StatePatch(
                    scope=patch.scope,
                    key=patch.key,
                    value=patch.value,
                    source_message_id=patch.source_message_id,
                    updated_at=patch.updated_at or event.date,
                )
        self._cards = tuple(cards)
        self._state_patches = tuple(patches.values())

    def list_cards(self, channel: str = "all") -> tuple[ParsedCard, ...]:
        if channel == "all":
            return self._cards
        return tuple(card for card in self._cards if channel in card.channels)

    def list_card_page(
        self,
        *,
        since_seq: int = 0,
        before_seq: int = 0,
        limit: int = 0,
        channel: str = "all",
    ) -> list[tuple[int, ParsedCard]]:
        """In-memory mirror of SQLiteStore.list_card_page。把列表索引当 seq。"""
        ordered = list(enumerate(self._cards, start=1))  # (seq, card),最旧 seq=1
        if channel != "all":
            ordered = [(seq, card) for seq, card in ordered if channel in card.channels]
        if since_seq > 0:
            ordered = [(seq, card) for seq, card in ordered if seq > since_seq]
        if before_seq > 0:
            ordered = [(seq, card) for seq, card in ordered if seq < before_seq]
        if since_seq > 0:
            ordered.sort(key=lambda item: item[0])  # ASC
        else:
            ordered.sort(key=lambda item: item[0], reverse=True)
            if limit > 0:
                ordered = ordered[:limit]
        return ordered

    def max_card_seq(self) -> int:
        return len(self._cards)

    def get_settings(self) -> dict:
        return {
            "api_id": "",
            "api_hash": "",
            "phone": "",
            "session_name": "miniweb_session",
            "target_chat": "",
            "target_topic_id": "",
            "game_bot_ids": [-1003983937918, 7900199668, 8388633812, 8547797815, 8757550896],
            "proxy_type": "",
            "proxy_host": "",
            "proxy_username": "",
            "proxy_password": "",
            "listen_enabled": False,
            "login_status": "idle",
            "login_message": "",
            "login_account_id": "",
            "listener_status": "stopped",
            "listener_message": "",
        }

    def list_state_patches(self, scope: str = "") -> list[dict]:
        scope = str(scope or "").strip()
        patches = self._state_patches
        if scope:
            patches = tuple(patch for patch in patches if patch.scope == scope)
        return [patch.to_api() for patch in patches]

    def save_settings(self, payload: dict) -> dict:
        settings = self.get_settings()
        settings.update(payload)
        return settings

    def list_accounts(self) -> list[dict]:
        return []

    def get_account(self, local_id: str) -> dict | None:
        return None

    def save_account(self, payload: dict) -> dict:
        return dict(payload)

    def list_identities(self) -> list[dict]:
        return []

    def get_identity(self, send_as_id) -> dict | None:
        return None

    def save_identity(self, payload: dict) -> dict:
        return dict(payload)

    def delete_identity(self, send_as_id) -> bool:
        return False

    def list_outbox_drafts(self, status: str = "draft") -> list[dict]:
        return []

    def save_outbox_draft(self, payload: dict) -> dict:
        return dict(payload)

    def delete_outbox_draft(self, draft_id: str) -> bool:
        return False
