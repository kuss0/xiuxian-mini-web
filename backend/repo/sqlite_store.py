from __future__ import annotations

import json
import sqlite3
import uuid
from dataclasses import replace
from pathlib import Path
from typing import Iterable

from backend.domain.models import OutboxDraft, ParsedCard, RawMessageEvent, StatePatch, utc_now_iso
from backend.identity_state import build_default_registry
from backend.parsers import build_parser_registry
from backend.processors import MessagePipeline
from backend.processors.message_filter import DEFAULT_FOCUS_KEYWORDS
from backend.repo.sample_store import SAMPLE_EVENTS
from backend.tg.client import safe_session_name


DEFAULT_GAME_BOT_IDS = [-1003983937918, 7900199668, 8388633812, 8547797815, 8757550896]
DEFAULT_TARGET_CHAT = "-1001680975844"
DEFAULT_TARGET_TOPIC_ID = "7310786"
ACCOUNT_SECRET_KEYS = {"api_hash", "proxy_password"}


class SQLiteStore:
    def __init__(self, db_path: Path | str) -> None:
        self.db_path = Path(db_path)
        self.db_path.parent.mkdir(parents=True, exist_ok=True)
        self._init_schema()
        # 通知调度器 — 服务层注入(set_notify_dispatcher),没注入就完全不推
        self._notify_dispatcher = None
        # 玩法状态机注册表 — 默认 3 个模块(深度闭关 / 抚摸法宝 / 温养器灵)。
        # 后续可通过 set_module_registry() 替换(单测里换 fixture 用)。
        self._module_registry = build_default_registry()
        # pipeline 需要知道哪些 sender 是真游戏 bot(用户在 settings 里勾的)
        # 才能正确给 fallback 卡片归 world/system。让 pipeline 通过 callback 现读。
        # 同时需要 target_topic_id 来识别 forum 群里的「假 reply」(topic 首层
        # 消息会被 Telegram 设成 reply_to_msg_id=topic_id)。
        self._pipeline = MessagePipeline(
            build_parser_registry(),
            is_game_bot_sender=self._is_game_bot_sender,
            get_target_topic_id=self._get_target_topic_id,
            module_registry=self._module_registry,
            get_parent_event=self._lookup_parent_event,
            get_my_identities=self._collect_my_identities,
            get_game_bot_ids=self._collect_game_bot_ids,
            get_settings_snapshot=self.get_settings,
            get_module_state=self.get_module_state,
            save_module_state=lambda sid, key, state, src: self.save_module_state(
                sid, key, state, source_message_id=src
            ),
        )

    def set_module_registry(self, registry) -> None:
        """单测/扩展用,替换默认 registry 后需要重建 pipeline。"""
        self._module_registry = registry
        self._pipeline = MessagePipeline(
            build_parser_registry(),
            is_game_bot_sender=self._is_game_bot_sender,
            get_target_topic_id=self._get_target_topic_id,
            module_registry=self._module_registry,
            get_parent_event=self._lookup_parent_event,
            get_my_identities=self._collect_my_identities,
            get_game_bot_ids=self._collect_game_bot_ids,
            get_settings_snapshot=self.get_settings,
            get_module_state=self.get_module_state,
            save_module_state=lambda sid, key, state, src: self.save_module_state(
                sid, key, state, source_message_id=src
            ),
        )

    def set_notify_dispatcher(self, dispatcher) -> None:
        """注入通知调度器。MiniWebServer init 时挂上,单测里 set None 跳过推送。"""
        self._notify_dispatcher = dispatcher

    def module_registry(self):
        return self._module_registry

    def _lookup_parent_event(self, chat_id: int, msg_id: int) -> RawMessageEvent | None:
        """给 pipeline 用的父消息 lookup,只查不写,失败返 None。"""
        if not chat_id or not msg_id:
            return None
        try:
            with self._connect() as conn:
                row = conn.execute(
                    """
                    SELECT id, chat_id, msg_id, text, source, date, sender_id,
                           reply_to_msg_id, top_msg_id, mentions_json, sender_is_bot
                    FROM raw_messages
                    WHERE chat_id=? AND msg_id=?
                    LIMIT 1
                    """,
                    (int(chat_id), int(msg_id)),
                ).fetchone()
        except Exception:
            return None
        if not row:
            return None
        try:
            return RawMessageEvent(
                id=row[0],
                chat_id=int(row[1]),
                msg_id=int(row[2]),
                text=row[3] or "",
                source=row[4] or "",
                date=row[5] or "",
                sender_id=row[6],
                reply_to_msg_id=row[7],
                top_msg_id=row[8],
                mentions=tuple(json.loads(row[9] or "[]")),
                sender_is_bot=bool(row[10]),
            )
        except Exception:
            return None

    def _collect_my_identities(self) -> list[int]:
        """所有已登记身份的 send_as_id。"""
        try:
            return [int(item.get("send_as_id") or 0) for item in self.list_identities()]
        except Exception:
            return []

    def _collect_game_bot_ids(self) -> list[int]:
        try:
            ids = self.get_settings().get("game_bot_ids") or []
            return [int(x) for x in ids]
        except Exception:
            return []


    def _is_game_bot_sender(self, sender_id: int | None) -> bool:
        if sender_id is None:
            return False
        try:
            sid = int(sender_id)
        except (TypeError, ValueError):
            return False
        try:
            ids = self.get_settings().get("game_bot_ids") or []
            return sid in {int(x) for x in ids}
        except Exception:
            return False

    def _get_target_topic_id(self) -> int:
        try:
            return int(self.get_settings().get("target_topic_id") or 0)
        except (TypeError, ValueError):
            return 0

    @classmethod
    def default(cls) -> SQLiteStore:
        return cls(Path(__file__).resolve().parents[2] / "data" / "miniweb.db")

    def seed_samples_if_empty(self) -> None:
        with self._connect() as conn:
            count = conn.execute("SELECT COUNT(*) FROM raw_messages").fetchone()[0]
        if count:
            self.backfill_state_patches_if_empty()
            self.backfill_module_states_if_empty()
            return
        self.ingest_many(SAMPLE_EVENTS)

    def backfill_state_patches_if_empty(self) -> int:
        with self._connect() as conn:
            patch_count = conn.execute("SELECT COUNT(*) FROM state_patches").fetchone()[0]
            if patch_count:
                return 0
            rows = conn.execute(
                """
                SELECT id, chat_id, msg_id, text, source, date, sender_id,
                       reply_to_msg_id, top_msg_id, mentions_json, sender_is_bot,
                       edited_at, deleted_at, media_kind, media_meta_json
                FROM raw_messages
                ORDER BY rowid ASC
                """
            ).fetchall()
        count = 0
        for row in rows:
            event = RawMessageEvent(
                id=row[0],
                chat_id=int(row[1]),
                msg_id=int(row[2]),
                text=row[3],
                source=row[4],
                date=row[5],
                sender_id=row[6],
                reply_to_msg_id=row[7],
                top_msg_id=row[8],
                mentions=tuple(json.loads(row[9] or "[]")),
                sender_is_bot=bool(row[10]),
                edited_at=row[11],
                deleted_at=row[12],
                media_kind=row[13],
                media_meta=(json.loads(row[14]) if row[14] else None),
            )
            self.ingest_event(event)
            count += 1
        return count

    def backfill_module_states_if_empty(self) -> int:
        """玩法状态机表空时,把所有 raw_messages 通过新 pipeline 重放一遍。

        - ingest_event 自带幂等(raw_messages ON CONFLICT DO UPDATE;
          parsed_cards 先 DELETE 再 INSERT;state_patches 类似)
        - _maybe_observe 在 pipeline 末尾会跑,把 module state 落到 identity_module_state
        - 已有 state 就跳过整次操作,避免开机重复
        """
        with self._connect() as conn:
            existing = conn.execute(
                "SELECT COUNT(*) FROM identity_module_state"
            ).fetchone()[0]
            if existing:
                return 0
            rows = conn.execute(
                """
                SELECT id, chat_id, msg_id, text, source, date, sender_id,
                       reply_to_msg_id, top_msg_id, mentions_json, sender_is_bot,
                       edited_at, deleted_at, media_kind, media_meta_json
                FROM raw_messages
                ORDER BY rowid ASC
                """
            ).fetchall()
        count = 0
        for row in rows:
            event = RawMessageEvent(
                id=row[0],
                chat_id=int(row[1]),
                msg_id=int(row[2]),
                text=row[3],
                source=row[4],
                date=row[5],
                sender_id=row[6],
                reply_to_msg_id=row[7],
                top_msg_id=row[8],
                mentions=tuple(json.loads(row[9] or "[]")),
                sender_is_bot=bool(row[10]),
                edited_at=row[11],
                deleted_at=row[12],
                media_kind=row[13],
                media_meta=(json.loads(row[14]) if row[14] else None),
            )
            self.ingest_event(event)
            count += 1
        return count

    def rebuild_parsed_cards_if_legacy(self) -> int:
        """如果 parsed_cards 有任何「老结构」就全量重建。两种 legacy 情况:
        1. primary_channel='hall'(老 fallback 把未分类消息丢到 hall,UI 看不见)
        2. payload 里没有 chat_id/sender_id/reply_to_msg_id 字段(老 schema,
           回复链和「单机模式」过滤都用不上)

        重建走 ingest_event,新 pipeline 自动注入 enrichment 字段并选对频道。
        """
        with self._connect() as conn:
            legacy_count = conn.execute(
                "SELECT COUNT(*) FROM parsed_cards WHERE primary_channel='hall'"
            ).fetchone()[0]
            if legacy_count == 0:
                # 检查 enrichment 字段是否齐全
                sample = conn.execute("SELECT payload_json FROM parsed_cards LIMIT 1").fetchone()
                if sample:
                    try:
                        payload = json.loads(sample[0])
                        if "chat_id" not in payload or "sender_id" not in payload:
                            legacy_count = conn.execute(
                                "SELECT COUNT(*) FROM parsed_cards"
                            ).fetchone()[0]
                    except Exception:
                        pass
        if legacy_count == 0:
            return 0
        with self._connect() as conn:
            rows = conn.execute(
                """
                SELECT id, chat_id, msg_id, text, source, date, sender_id,
                       reply_to_msg_id, top_msg_id, mentions_json, sender_is_bot
                FROM raw_messages
                ORDER BY rowid ASC
                """
            ).fetchall()
        count = 0
        for row in rows:
            event = RawMessageEvent(
                id=row[0],
                chat_id=int(row[1]),
                msg_id=int(row[2]),
                text=row[3],
                source=row[4],
                date=row[5],
                sender_id=row[6],
                reply_to_msg_id=row[7],
                top_msg_id=row[8],
                mentions=tuple(json.loads(row[9] or "[]")),
                sender_is_bot=bool(row[10]),
            )
            self.ingest_event(event)
            count += 1
        return count

    def rebuild_parsed_cards_if_filter_outdated(self) -> int:
        """旧卡片没有 focus/archive/leader 过滤频道时,重放 raw_messages。

        这是产品主线从「单机/控制台」切到「消息过滤」后的轻量迁移。只在
        parsed_cards 中完全没有新过滤频道,或小库里旧版把所有 @ 都标成
        「被@」时触发。大库的历史重分流只在用户保存「过滤设置」时显式执行,
        避免服务启动被迁移拖住。
        """
        try:
            own_aliases = self.get_settings().get("own_aliases") or []
        except Exception:
            own_aliases = []
        with self._connect() as conn:
            total = conn.execute("SELECT COUNT(*) FROM parsed_cards").fetchone()[0]
            if not total:
                return 0
            classified = conn.execute(
                """
                SELECT COUNT(*) FROM parsed_cards
                WHERE channels_json LIKE '%"focus"%'
                   OR channels_json LIKE '%"archive"%'
                   OR channels_json LIKE '%"leader"%'
                """
            ).fetchone()[0]
            stale_mentions = 0
            try:
                if not own_aliases:
                    stale_mentions = conn.execute(
                        """
                        SELECT COUNT(*) FROM parsed_cards
                        WHERE payload_json LIKE '%"被@"%'
                        """
                    ).fetchone()[0]
            except Exception:
                stale_mentions = 0
            # 大库启动时不做全量重放,避免服务启动被历史迁移拖住。
            # 用户保存「过滤设置」时会走 rebuild_all_parsed_cards 显式重分流。
            if classified and (not stale_mentions or total > 5000):
                return 0
            rows = conn.execute(
                """
                SELECT id, chat_id, msg_id, text, source, date, sender_id,
                       reply_to_msg_id, top_msg_id, mentions_json, sender_is_bot,
                       edited_at, deleted_at, media_kind, media_meta_json
                FROM raw_messages
                ORDER BY rowid ASC
                """
            ).fetchall()
        count = 0
        for row in rows:
            event = RawMessageEvent(
                id=row[0],
                chat_id=int(row[1]),
                msg_id=int(row[2]),
                text=row[3],
                source=row[4],
                date=row[5],
                sender_id=row[6],
                reply_to_msg_id=row[7],
                top_msg_id=row[8],
                mentions=tuple(json.loads(row[9] or "[]")),
                sender_is_bot=bool(row[10]),
                edited_at=row[11],
                deleted_at=row[12],
                media_kind=row[13],
                media_meta=(json.loads(row[14]) if row[14] else None),
            )
            self.ingest_event(event)
            count += 1
        return count

    def rebuild_all_parsed_cards(self) -> int:
        """按当前 parser/settings 全量重建 parsed_cards/state_patches。

        用于过滤规则变更后立即让历史消息重新分流。raw_messages 是事实来源,
        ingest_event 内部会先删旧 card 再写新 card。
        """
        with self._connect() as conn:
            rows = conn.execute(
                """
                SELECT id, chat_id, msg_id, text, source, date, sender_id,
                       reply_to_msg_id, top_msg_id, mentions_json, sender_is_bot,
                       edited_at, deleted_at, media_kind, media_meta_json
                FROM raw_messages
                ORDER BY rowid ASC
                """
            ).fetchall()
        count = 0
        for row in rows:
            event = RawMessageEvent(
                id=row[0],
                chat_id=int(row[1]),
                msg_id=int(row[2]),
                text=row[3],
                source=row[4],
                date=row[5],
                sender_id=row[6],
                reply_to_msg_id=row[7],
                top_msg_id=row[8],
                mentions=tuple(json.loads(row[9] or "[]")),
                sender_is_bot=bool(row[10]),
                edited_at=row[11],
                deleted_at=row[12],
                media_kind=row[13],
                media_meta=(json.loads(row[14]) if row[14] else None),
            )
            self.ingest_event(event)
            count += 1
        return count

    def ingest_many(self, events: Iterable[RawMessageEvent]) -> None:
        for event in events:
            self.ingest_event(event)

    def ingest_event(self, event: RawMessageEvent) -> tuple[ParsedCard, ...]:
        output = self._pipeline.process(event)
        # 把编辑/删除/媒体字段从 event 透传到 card,UI 渲染需要(灰字「(已编辑)」、
        # 删除线、「[图片]」占位等)
        cards = tuple(
            replace(
                card,
                edited_at=event.edited_at,
                deleted_at=event.deleted_at,
                media_kind=event.media_kind,
                media_meta=event.media_meta,
            )
            for card in output.cards
        )
        media_meta_json = (
            json.dumps(event.media_meta, ensure_ascii=False)
            if event.media_meta
            else None
        )
        with self._connect() as conn:
            conn.execute(
                """
                INSERT INTO raw_messages(
                    id, chat_id, msg_id, text, source, date, sender_id,
                    reply_to_msg_id, top_msg_id, mentions_json, sender_is_bot,
                    edited_at, deleted_at, media_kind, media_meta_json
                )
                VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(id) DO UPDATE SET
                    chat_id=excluded.chat_id,
                    msg_id=excluded.msg_id,
                    text=excluded.text,
                    source=excluded.source,
                    date=excluded.date,
                    sender_id=excluded.sender_id,
                    reply_to_msg_id=excluded.reply_to_msg_id,
                    top_msg_id=excluded.top_msg_id,
                    mentions_json=excluded.mentions_json,
                    sender_is_bot=excluded.sender_is_bot,
                    edited_at=COALESCE(excluded.edited_at, raw_messages.edited_at),
                    deleted_at=COALESCE(excluded.deleted_at, raw_messages.deleted_at),
                    media_kind=COALESCE(excluded.media_kind, raw_messages.media_kind),
                    media_meta_json=COALESCE(excluded.media_meta_json, raw_messages.media_meta_json)
                """,
                (
                    event.id,
                    event.chat_id,
                    event.msg_id,
                    event.text,
                    event.source,
                    event.date,
                    event.sender_id,
                    event.reply_to_msg_id,
                    event.top_msg_id,
                    json.dumps(list(event.mentions), ensure_ascii=False),
                    int(event.sender_is_bot),
                    event.edited_at,
                    event.deleted_at,
                    event.media_kind,
                    media_meta_json,
                ),
            )
            conn.execute("DELETE FROM parsed_cards WHERE raw_message_id=?", (event.id,))
            for card in cards:
                conn.execute(
                    """
                    INSERT INTO parsed_cards(
                        id, raw_message_id, primary_channel, channels_json, payload_json
                    )
                    VALUES(?, ?, ?, ?, ?)
                    ON CONFLICT(id) DO UPDATE SET
                        raw_message_id=excluded.raw_message_id,
                        primary_channel=excluded.primary_channel,
                        channels_json=excluded.channels_json,
                        payload_json=excluded.payload_json
                    """,
                    (
                        card.id,
                        event.id,
                        card.primary_channel,
                        json.dumps(list(card.channels), ensure_ascii=False),
                        json.dumps(card.to_api(), ensure_ascii=False),
                    ),
                )
            for patch in output.state_patches:
                # 解析 send_as_id:patch 自己有就用;没有就回退到本条 event sender,
                # 如果本条是「游戏 bot 回复」(根据 settings.game_bot_ids 判断,不是
                # telethon sender_is_bot —— 韩天尊在 TG 里是普通用户) → 用
                # parent.sender_id(才是命令发起人)。
                send_as_id = int(getattr(patch, "send_as_id", 0) or 0)
                if send_as_id == 0:
                    candidate = event.sender_id
                    game_bot_ids = set()
                    try:
                        game_bot_ids = {int(x) for x in (self.get_settings().get("game_bot_ids") or [])}
                    except Exception:
                        game_bot_ids = set()
                    is_bot_like = (
                        bool(event.sender_is_bot)
                        or (candidate is not None and candidate < 0)
                        or (candidate is not None and int(candidate) in game_bot_ids)
                    )
                    if is_bot_like and event.reply_to_msg_id:
                        parent = self._lookup_parent_event(int(event.chat_id), int(event.reply_to_msg_id))
                        if parent and parent.sender_id:
                            candidate = parent.sender_id
                    send_as_id = int(candidate or 0)
                updated_patch = StatePatch(
                    scope=patch.scope,
                    key=patch.key,
                    value=patch.value,
                    source_message_id=patch.source_message_id,
                    updated_at=patch.updated_at or event.date or utc_now_iso(),
                    send_as_id=send_as_id,
                )
                conn.execute(
                    """
                    INSERT INTO state_patches(
                        scope, send_as_id, key, value_json, source_message_id, updated_at
                    )
                    VALUES(?, ?, ?, ?, ?, ?)
                    ON CONFLICT(scope, send_as_id, key) DO UPDATE SET
                        value_json=excluded.value_json,
                        source_message_id=excluded.source_message_id,
                        updated_at=excluded.updated_at
                    """,
                    (
                        updated_patch.scope,
                        updated_patch.send_as_id,
                        updated_patch.key,
                        json.dumps(updated_patch.value, ensure_ascii=False),
                        updated_patch.source_message_id,
                        updated_patch.updated_at,
                    ),
                )
        # 卡片落库完了再走 notification dispatch — 失败不影响 ingest
        if self._notify_dispatcher is not None and cards:
            from backend.notifications import NotificationEvent
            for card in cards:
                title = str(card.title or "")
                if not self._notify_dispatcher.event_is_enabled(title):
                    continue
                try:
                    self._notify_dispatcher.dispatch(
                        NotificationEvent(
                            kind="card",
                            title=title,
                            body=card.raw or card.summary or "",
                            source_id=event.id,
                            severity=str(card.severity or "normal"),
                        )
                    )
                except Exception as exc:
                    print(f"[notify] dispatch failed for {title}: {exc}")
        return cards

    def list_cards(self, channel: str = "all") -> tuple[ParsedCard, ...]:
        sql = "SELECT payload_json FROM parsed_cards ORDER BY rowid DESC"
        with self._connect() as conn:
            payloads = [row[0] for row in conn.execute(sql).fetchall()]
        cards = tuple(ParsedCard.from_api(json.loads(payload)) for payload in payloads)
        if channel == "all":
            return cards
        return tuple(card for card in cards if channel in card.channels)

    def list_card_page(
        self,
        *,
        since_seq: int = 0,
        before_seq: int = 0,
        limit: int = 0,
        channel: str = "all",
    ) -> list[tuple[int, ParsedCard]]:
        """对照 docs/architecture.md 的 inbox 设计:支持游标式增量拉。
        - since_seq:只返 rowid > since_seq 的新卡片(轮询用)
        - before_seq:只返 rowid < before_seq 的旧卡片(日志 modal 往下翻用)
        - limit:封顶,初始化时取最近 200 条避免一次性拉全
        - channel:服务端先过滤,省带宽

        rowid 是 SQLite 自动递增的插入序号,新进来的卡片 rowid 一定更大。
        Edit 走 UPSERT,rowid 不变 —— 当前不专门追踪「编辑过的旧卡片是否要重发」,
        前端按 id merge 即可处理。"""
        sql_parts = ["SELECT rowid, payload_json FROM parsed_cards"]
        where = []
        params: list = []
        if since_seq > 0:
            where.append("rowid > ?")
            params.append(int(since_seq))
        if before_seq > 0:
            where.append("rowid < ?")
            params.append(int(before_seq))
        if channel != "all":
            where.append("channels_json LIKE ?")
            params.append(f'%"{channel}"%')
        if where:
            sql_parts.append("WHERE " + " AND ".join(where))
        # since_seq 模式按 rowid ASC 给前端,前端按到来顺序 merge;
        # 否则按 DESC 给最新的在前。
        if since_seq > 0:
            sql_parts.append("ORDER BY rowid ASC")
        else:
            sql_parts.append("ORDER BY rowid DESC")
        if limit and limit > 0:
            sql_parts.append("LIMIT ?")
            params.append(int(limit))
        sql = " ".join(sql_parts)
        with self._connect() as conn:
            rows = conn.execute(sql, params).fetchall()

        result: list[tuple[int, ParsedCard]] = []
        for rowid, payload in rows:
            card = ParsedCard.from_api(json.loads(payload))
            result.append((int(rowid), card))
        return result

    def max_card_seq(self) -> int:
        """当前 parsed_cards 最大 rowid。前端初始化 lastSeq 用。"""
        with self._connect() as conn:
            row = conn.execute("SELECT MAX(rowid) FROM parsed_cards").fetchone()
        return int(row[0] or 0)

    def list_solo_card_page(
        self,
        *,
        my_ids: list[int],
        bot_ids: list[int],
        since_seq: int = 0,
        limit: int = 0,
        channel: str = "all",
    ) -> list[tuple[int, ParsedCard]]:
        """单机模式专用:只返「我发的」+「bot 直接回我的」。

        SQL 走 raw_messages JOIN parsed_cards:
        - sender_id IN my_ids,或
        - sender_id IN bot_ids 且 reply_to_msg_id 指向 my_ids 中某人发的某条

        相比拉一大堆再前端过滤,这里 SQL 一把梭,不受 limit 窗口的影响。
        my_ids/bot_ids 二者皆空就返空(避免错把全表当结果)。"""
        my_ids_clean = [int(x) for x in (my_ids or []) if x]
        bot_ids_clean = [int(x) for x in (bot_ids or []) if x]
        if not my_ids_clean and not bot_ids_clean:
            return []

        # 占位符,SQLite 不支持 IN ?,得展开
        my_ph = ",".join("?" for _ in my_ids_clean) if my_ids_clean else "NULL"
        bot_ph = ",".join("?" for _ in bot_ids_clean) if bot_ids_clean else "NULL"

        # 我发的
        sub_mine = f"raw_messages.sender_id IN ({my_ph})" if my_ids_clean else "0"
        # bot 回我的:bot 在 bot_ids,且 (chat_id, reply_to_msg_id) 指向 my_ids 中某人在该群发过的某条
        if my_ids_clean and bot_ids_clean:
            sub_bot_reply = (
                f"raw_messages.sender_id IN ({bot_ph}) "
                f"AND raw_messages.reply_to_msg_id IS NOT NULL "
                f"AND EXISTS ("
                f"  SELECT 1 FROM raw_messages parent "
                f"  WHERE parent.chat_id = raw_messages.chat_id "
                f"    AND parent.msg_id = raw_messages.reply_to_msg_id "
                f"    AND parent.sender_id IN ({my_ph}) "
                f")"
            )
        else:
            sub_bot_reply = "0"

        where_parts = [f"({sub_mine} OR {sub_bot_reply})"]
        params: list = []
        if my_ids_clean:
            params.extend(my_ids_clean)
        if my_ids_clean and bot_ids_clean:
            params.extend(bot_ids_clean)
            params.extend(my_ids_clean)
        if since_seq > 0:
            where_parts.append("parsed_cards.rowid > ?")
            params.append(int(since_seq))

        order = "ORDER BY parsed_cards.rowid ASC" if since_seq > 0 else "ORDER BY parsed_cards.rowid DESC"
        limit_clause = ""
        if limit and limit > 0:
            limit_clause = "LIMIT ?"
            params.append(int(limit))

        sql = f"""
            SELECT parsed_cards.rowid, parsed_cards.payload_json
            FROM parsed_cards
            JOIN raw_messages ON raw_messages.id = parsed_cards.raw_message_id
            WHERE {' AND '.join(where_parts)}
            {order}
            {limit_clause}
        """
        with self._connect() as conn:
            rows = conn.execute(sql, params).fetchall()

        result: list[tuple[int, ParsedCard]] = []
        for rowid, payload in rows:
            card = ParsedCard.from_api(json.loads(payload))
            if channel != "all" and channel not in card.channels:
                continue
            result.append((int(rowid), card))
        return result

    def get_card(self, card_id: str) -> tuple[int, ParsedCard] | None:
        """按 id 取单张卡片(给「跳到不在当前 state 里的父消息」用)。返回 (seq, card)。"""
        with self._connect() as conn:
            row = conn.execute(
                "SELECT rowid, payload_json FROM parsed_cards WHERE id=?",
                (card_id,),
            ).fetchone()
        if not row:
            return None
        return int(row[0]), ParsedCard.from_api(json.loads(row[1]))

    def get_settings(self) -> dict:
        defaults = {
            "api_id": "",
            "api_hash": "",
            "phone": "",
            "session_name": "miniweb_session",
            "target_chat": DEFAULT_TARGET_CHAT,
            "target_topic_id": DEFAULT_TARGET_TOPIC_ID,
            "game_bot_ids": list(DEFAULT_GAME_BOT_IDS),
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
            "message_retention_days": 30,
            "own_aliases": [],
            "leader_sender_ids": [],
            "leader_source_names": [],
            "focus_keywords": list(DEFAULT_FOCUS_KEYWORDS),
            "focus_include_player_plain": True,
            "archive_dot_commands": True,
            "archive_bot_replies": True,
            "message_filter_version": 1,
            "notify_enabled": False,
            "notify_tg_bot_token": "",
            "notify_tg_chat_id": "",
            "notify_card_titles": [],
        }
        with self._connect() as conn:
            rows = conn.execute("SELECT key, value_json FROM settings").fetchall()
        for key, raw_value in rows:
            if key not in defaults:
                continue
            defaults[key] = json.loads(raw_value)
        return defaults

    def ensure_default_settings(self) -> dict:
        """对照用户的「预设一下群聊/话题/游戏 bot」要求:
        如果 DB 里 target_chat / target_topic_id / game_bot_ids 是空,
        塞默认值进去。已经有值的不动。"""
        settings = self.get_settings()
        patch = {}
        if not str(settings.get("target_chat") or "").strip():
            patch["target_chat"] = DEFAULT_TARGET_CHAT
        if not str(settings.get("target_topic_id") or "").strip():
            patch["target_topic_id"] = DEFAULT_TARGET_TOPIC_ID
        bots = settings.get("game_bot_ids") or []
        if not list(bots):
            patch["game_bot_ids"] = list(DEFAULT_GAME_BOT_IDS)
        if patch:
            self.save_settings(patch)
        return self.get_settings()

    def list_state_patches(self, scope: str = "", send_as_id: int = 0) -> list[dict]:
        """列出 state patches。
        - scope:可选,空字符串返回全部 scope
        - send_as_id:0 = 不过滤(返回所有身份);>0 = **严格**只返回该身份的 patch。

        老脚本对 identity_profile 是 per-identity 严格隔离的(model/state.py),
        不要 fallback 到 send_as_id=0 — 否则字段会从别人/历史污染过来
        (例如 称号 跟身份不匹配)。要兜底就让 UI 显示「—」。
        """
        scope = str(scope or "").strip()
        send_as_id = int(send_as_id or 0)
        with self._connect() as conn:
            params: list = []
            where: list[str] = []
            if scope:
                where.append("scope=?")
                params.append(scope)
            if send_as_id > 0:
                where.append("send_as_id=?")
                params.append(send_as_id)
            where_sql = ("WHERE " + " AND ".join(where)) if where else ""
            rows = conn.execute(
                f"""
                SELECT scope, send_as_id, key, value_json, source_message_id, updated_at
                FROM state_patches
                {where_sql}
                ORDER BY updated_at DESC, scope ASC, key ASC
                """,
                params,
            ).fetchall()
        out: list[dict] = []
        for row in rows:
            out.append(
                StatePatch(
                    scope=row[0],
                    send_as_id=int(row[1] or 0),
                    key=row[2],
                    value=json.loads(row[3]),
                    source_message_id=row[4],
                    updated_at=row[5],
                ).to_api()
            )
        return out

    def list_discovered_bots(self) -> list[dict]:
        """从消息箱抓「真的发过游戏 bot 风格消息」的 sender,给 UI 让用户勾选哪些是游戏 bot
        (写到 settings.game_bot_ids)。识别条件:
        - candidate:sender_is_bot=1 或 sender_id<0(bot 用户 / 频道身份)
        - 在 candidate 的消息里查关键词命中(`bot_hints.matched_families`)
        - 命中次数 ≥ 1 的才列出,纯闲聊频道号不会被丢进来
        - 不自动加进 game_bot_ids — 需要人工确认

        返回字段:
        - sender_id / last_source / last_seen / message_count / kind
        - hit_count:命中游戏关键词的消息条数
        - matched_families:命中的玩法 family(去重后)
        """
        from backend.repo.bot_hints import matched_families

        with self._connect() as conn:
            rows = conn.execute(
                """
                SELECT sender_id, text, source, date, sender_is_bot
                FROM raw_messages
                WHERE sender_id IS NOT NULL
                  AND (sender_is_bot=1 OR sender_id < 0)
                ORDER BY rowid DESC
                """
            ).fetchall()

        senders: dict[int, dict] = {}
        for sender_id, text, source, date, any_bot in rows:
            sid = int(sender_id)
            bucket = senders.setdefault(
                sid,
                {
                    "sender_id": sid,
                    "last_source": "",
                    "last_seen": "",
                    "message_count": 0,
                    "hit_count": 0,
                    "matched_families": set(),
                    "kind": "channel" if sid < 0 else ("bot" if int(any_bot or 0) else "unknown"),
                },
            )
            bucket["message_count"] += 1
            # 第一次见(rowid DESC 顺序,故是最新一条)就记 last_source/last_seen
            if not bucket["last_source"] and source:
                bucket["last_source"] = str(source)
            if not bucket["last_seen"] and date:
                bucket["last_seen"] = str(date)
            families = matched_families(text or "")
            if families:
                bucket["hit_count"] += 1
                bucket["matched_families"].update(families)

        result = []
        for sid, bucket in senders.items():
            if bucket["hit_count"] == 0:
                # 没产出过游戏 bot 风格消息 — 大概率是闲聊玩家频道,不丢给 UI
                continue
            bucket["matched_families"] = sorted(bucket["matched_families"])
            result.append(bucket)

        # 命中越多越靠前;同分按总消息条数排
        result.sort(key=lambda b: (-b["hit_count"], -b["message_count"]))
        return result

    def save_settings(self, payload: dict) -> dict:
        current = self.get_settings()
        normalized = _normalize_settings({**current, **payload})
        with self._connect() as conn:
            for key, value in normalized.items():
                conn.execute(
                    """
                    INSERT INTO settings(key, value_json)
                    VALUES(?, ?)
                    ON CONFLICT(key) DO UPDATE SET value_json=excluded.value_json
                    """,
                    (key, json.dumps(value, ensure_ascii=False)),
                )
        return normalized

    def list_accounts(self) -> list[dict]:
        with self._connect() as conn:
            rows = conn.execute(
                "SELECT payload_json FROM accounts ORDER BY updated_at DESC, local_id ASC"
            ).fetchall()
        return [_normalize_account(json.loads(row[0])) for row in rows]

    def get_account(self, local_id: str) -> dict | None:
        local_id = safe_session_name(local_id, fallback="")
        if not local_id:
            return None
        with self._connect() as conn:
            row = conn.execute(
                "SELECT payload_json FROM accounts WHERE local_id=?",
                (local_id,),
            ).fetchone()
        if not row:
            return None
        return _normalize_account(json.loads(row[0]))

    def save_account(self, payload: dict) -> dict:
        current = self.get_account(str(payload.get("local_id") or "")) or {}
        normalized = _normalize_account({**current, **payload})
        with self._connect() as conn:
            conn.execute(
                """
                INSERT INTO accounts(local_id, payload_json, updated_at)
                VALUES(?, ?, strftime('%s','now'))
                ON CONFLICT(local_id) DO UPDATE SET
                    payload_json=excluded.payload_json,
                    updated_at=excluded.updated_at
                """,
                (
                    normalized["local_id"],
                    json.dumps(normalized, ensure_ascii=False),
                ),
            )
        return normalized

    def delete_account(self, local_id: str) -> bool:
        local_id = safe_session_name(local_id, fallback="")
        if not local_id:
            return False
        with self._connect() as conn:
            cursor = conn.execute("DELETE FROM accounts WHERE local_id=?", (local_id,))
            return cursor.rowcount > 0

    def list_identities(self) -> list[dict]:
        with self._connect() as conn:
            rows = conn.execute(
                "SELECT payload_json FROM identities ORDER BY updated_at DESC, send_as_id ASC"
            ).fetchall()
        return [_normalize_identity(json.loads(row[0])) for row in rows]

    def get_identity(self, send_as_id: int | str) -> dict | None:
        send_as_id = _coerce_non_zero_int(send_as_id)
        if send_as_id == 0:
            return None
        with self._connect() as conn:
            row = conn.execute(
                "SELECT payload_json FROM identities WHERE send_as_id=?",
                (send_as_id,),
            ).fetchone()
        if not row:
            return None
        return _normalize_identity(json.loads(row[0]))

    def save_identity(self, payload: dict) -> dict:
        current = self.get_identity(payload.get("send_as_id")) or {}
        normalized = _normalize_identity({**current, **payload})
        if normalized["send_as_id"] == 0:
            raise ValueError("身份 ID 必须是数字")
        with self._connect() as conn:
            conn.execute(
                """
                INSERT INTO identities(send_as_id, payload_json, updated_at)
                VALUES(?, ?, strftime('%s','now'))
                ON CONFLICT(send_as_id) DO UPDATE SET
                    payload_json=excluded.payload_json,
                    updated_at=excluded.updated_at
                """,
                (
                    normalized["send_as_id"],
                    json.dumps(normalized, ensure_ascii=False),
                ),
            )
        return normalized

    def delete_identity(self, send_as_id: int | str) -> bool:
        send_as_id = _coerce_non_zero_int(send_as_id)
        if send_as_id == 0:
            return False
        with self._connect() as conn:
            cursor = conn.execute("DELETE FROM identities WHERE send_as_id=?", (send_as_id,))
            return cursor.rowcount > 0

    def list_outbox_drafts(self, status: str = "draft") -> list[dict]:
        status = str(status or "draft").strip()
        with self._connect() as conn:
            if status == "all":
                rows = conn.execute(
                    "SELECT payload_json FROM outbox_drafts ORDER BY created_at DESC, id DESC"
                ).fetchall()
            else:
                rows = conn.execute(
                    """
                    SELECT payload_json FROM outbox_drafts
                    WHERE status=?
                    ORDER BY created_at DESC, id DESC
                    """,
                    (status,),
                ).fetchall()
        return [_normalize_outbox_draft(json.loads(row[0])) for row in rows]

    def save_outbox_draft(self, payload: dict) -> dict:
        normalized = _normalize_outbox_draft(payload)
        if not normalized["id"]:
            normalized["id"] = f"draft-{uuid.uuid4().hex}"
        if not normalized["created_at"]:
            normalized["created_at"] = utc_now_iso()
        with self._connect() as conn:
            conn.execute(
                """
                INSERT INTO outbox_drafts(id, status, created_at, payload_json)
                VALUES(?, ?, ?, ?)
                ON CONFLICT(id) DO UPDATE SET
                    status=excluded.status,
                    created_at=excluded.created_at,
                    payload_json=excluded.payload_json
                """,
                (
                    normalized["id"],
                    normalized["status"],
                    normalized["created_at"],
                    json.dumps(normalized, ensure_ascii=False),
                ),
            )
        return normalized

    def delete_outbox_draft(self, draft_id: str) -> bool:
        draft_id = str(draft_id or "").strip()
        if not draft_id:
            return False
        with self._connect() as conn:
            cursor = conn.execute("DELETE FROM outbox_drafts WHERE id=?", (draft_id,))
            return cursor.rowcount > 0

    # ---------- official schedule ----------

    def create_schedule_batch(self, payload: dict, items: list[dict]) -> int:
        """payload: {send_as_id, account_local_id, preset_key, label, anchor_at, horizon_days, options}
        items:    [{command, schedule_at, scheduled_msg_id?, status?}, ...]
        返回 batch_id。一次性插入 batch + N 条 messages。"""
        import time
        now = time.time()
        with self._connect() as conn:
            cur = conn.execute(
                """
                INSERT INTO official_schedule_batches
                    (send_as_id, account_local_id, preset_key, label,
                     anchor_at, horizon_days, status, options_json,
                     created_at, updated_at)
                VALUES(?, ?, ?, ?, ?, ?, 'active', ?, ?, ?)
                """,
                (
                    int(payload.get("send_as_id") or 0),
                    str(payload.get("account_local_id") or ""),
                    str(payload.get("preset_key") or ""),
                    str(payload.get("label") or ""),
                    float(payload.get("anchor_at") or 0),
                    int(payload.get("horizon_days") or 0),
                    json.dumps(payload.get("options") or {}, ensure_ascii=False, sort_keys=True),
                    now,
                    now,
                ),
            )
            batch_id = int(cur.lastrowid)
            for item in items or []:
                conn.execute(
                    """
                    INSERT INTO official_scheduled_messages
                        (batch_id, send_as_id, command, schedule_at,
                         scheduled_msg_id, status, last_error,
                         created_at, updated_at)
                    VALUES(?, ?, ?, ?, ?, ?, '', ?, ?)
                    """,
                    (
                        batch_id,
                        int(payload.get("send_as_id") or 0),
                        str(item.get("command") or "").strip(),
                        float(item.get("schedule_at") or 0),
                        int(item.get("scheduled_msg_id") or 0),
                        str(item.get("status") or "planned"),
                        now,
                        now,
                    ),
                )
        return batch_id

    def list_schedule_batches(self, *, include_inactive: bool = False) -> list[dict]:
        # include_inactive=False 默认隐藏已软删的批次。其他生命周期状态
        # (active / sending / completed / partial_failed / failed / cancelled)
        # 都要返回 — UI 要能看到正在跑的(显示进度 + 取消)和已完成的。
        sql = "SELECT id, send_as_id, account_local_id, preset_key, label, anchor_at, horizon_days, status, options_json, created_at, updated_at FROM official_schedule_batches"
        if not include_inactive:
            sql += " WHERE status != 'deleted'"
        sql += " ORDER BY created_at DESC, id DESC"
        with self._connect() as conn:
            rows = conn.execute(sql).fetchall()
        return [
            {
                "id": int(row[0]),
                "send_as_id": int(row[1]),
                "account_local_id": row[2] or "",
                "preset_key": row[3] or "",
                "label": row[4] or "",
                "anchor_at": float(row[5] or 0),
                "horizon_days": int(row[6] or 0),
                "status": row[7] or "",
                "options": json.loads(row[8] or "{}"),
                "created_at": float(row[9] or 0),
                "updated_at": float(row[10] or 0),
            }
            for row in rows
        ]

    def list_schedule_messages(self, *, batch_id: int = 0, send_as_id: int = 0, include_inactive: bool = False) -> list[dict]:
        where = []
        params: list = []
        if batch_id:
            where.append("batch_id=?")
            params.append(int(batch_id))
        if send_as_id:
            where.append("send_as_id=?")
            params.append(int(send_as_id))
        if not include_inactive:
            where.append("status!='deleted'")
        sql = "SELECT id, batch_id, send_as_id, command, schedule_at, scheduled_msg_id, status, last_error, created_at, updated_at FROM official_scheduled_messages"
        if where:
            sql += " WHERE " + " AND ".join(where)
        sql += " ORDER BY schedule_at ASC, id ASC"
        with self._connect() as conn:
            rows = conn.execute(sql, params).fetchall()
        return [
            {
                "id": int(row[0]),
                "batch_id": int(row[1] or 0),
                "send_as_id": int(row[2]),
                "command": row[3] or "",
                "schedule_at": float(row[4] or 0),
                "scheduled_msg_id": int(row[5] or 0),
                "status": row[6] or "",
                "last_error": row[7] or "",
                "created_at": float(row[8] or 0),
                "updated_at": float(row[9] or 0),
            }
            for row in rows
        ]

    def mark_schedule_message(self, message_id: int, *, scheduled_msg_id: int = 0, status: str = "", last_error: str = "") -> None:
        import time
        sets = ["updated_at=?"]
        params: list = [time.time()]
        if scheduled_msg_id:
            sets.append("scheduled_msg_id=?")
            params.append(int(scheduled_msg_id))
        if status:
            sets.append("status=?")
            params.append(str(status))
        if last_error is not None:
            sets.append("last_error=?")
            params.append(str(last_error))
        params.append(int(message_id))
        with self._connect() as conn:
            conn.execute(
                f"UPDATE official_scheduled_messages SET {', '.join(sets)} WHERE id=?",
                params,
            )

    def set_schedule_batch_status(self, batch_id: int, status: str) -> int:
        """更新 batch.status(active / sending / completed / partial_failed / failed / cancelled / deleted)。
        返回 updated rowcount。"""
        import time
        now = time.time()
        with self._connect() as conn:
            cur = conn.execute(
                "UPDATE official_schedule_batches SET status=?, updated_at=? WHERE id=?",
                (str(status or ""), now, int(batch_id)),
            )
            return cur.rowcount

    def delete_schedule_batch(self, batch_id: int) -> dict:
        """标记 batch 和它下面所有 message 为 deleted(软删,保留历史)。"""
        import time
        now = time.time()
        with self._connect() as conn:
            cur = conn.execute(
                "UPDATE official_schedule_batches SET status='deleted', updated_at=? WHERE id=?",
                (now, int(batch_id)),
            )
            batch_changed = cur.rowcount
            cur2 = conn.execute(
                "UPDATE official_scheduled_messages SET status='deleted', updated_at=? WHERE batch_id=?",
                (now, int(batch_id)),
            )
            messages_changed = cur2.rowcount
        return {"batch": batch_changed, "messages": messages_changed}

    # ---------- identity_module_state(给玩法状态机用) ----------

    def get_module_state(self, send_as_id: int, module_key: str) -> dict | None:
        """返 {state, source_message_id, updated_at} 或 None。state_json 已解析。"""
        with self._connect() as conn:
            row = conn.execute(
                "SELECT state_json, source_message_id, updated_at FROM identity_module_state WHERE send_as_id=? AND module_key=?",
                (int(send_as_id), str(module_key)),
            ).fetchone()
        if not row:
            return None
        return {
            "state": json.loads(row[0] or "{}"),
            "source_message_id": row[1] or "",
            "updated_at": float(row[2] or 0),
        }

    def save_module_state(
        self,
        send_as_id: int,
        module_key: str,
        state: dict,
        *,
        source_message_id: str = "",
    ) -> None:
        import time
        with self._connect() as conn:
            conn.execute(
                """
                INSERT INTO identity_module_state
                    (send_as_id, module_key, state_json, source_message_id, updated_at)
                VALUES(?, ?, ?, ?, ?)
                ON CONFLICT(send_as_id, module_key) DO UPDATE SET
                    state_json=excluded.state_json,
                    source_message_id=excluded.source_message_id,
                    updated_at=excluded.updated_at
                """,
                (
                    int(send_as_id),
                    str(module_key),
                    json.dumps(state or {}, ensure_ascii=False, sort_keys=True),
                    str(source_message_id or ""),
                    time.time(),
                ),
            )

    def list_module_states(self, *, send_as_id: int = 0, module_key: str = "") -> list[dict]:
        where = []
        params: list = []
        if send_as_id:
            where.append("send_as_id=?")
            params.append(int(send_as_id))
        if module_key:
            where.append("module_key=?")
            params.append(str(module_key))
        sql = "SELECT send_as_id, module_key, state_json, source_message_id, updated_at FROM identity_module_state"
        if where:
            sql += " WHERE " + " AND ".join(where)
        sql += " ORDER BY updated_at DESC"
        with self._connect() as conn:
            rows = conn.execute(sql, params).fetchall()
        return [
            {
                "send_as_id": int(row[0]),
                "module_key": row[1] or "",
                "state": json.loads(row[2] or "{}"),
                "source_message_id": row[3] or "",
                "updated_at": float(row[4] or 0),
            }
            for row in rows
        ]

    def delete_module_state(self, send_as_id: int, module_key: str) -> bool:
        with self._connect() as conn:
            cur = conn.execute(
                "DELETE FROM identity_module_state WHERE send_as_id=? AND module_key=?",
                (int(send_as_id), str(module_key)),
            )
            return cur.rowcount > 0

    def _init_schema(self) -> None:
        with self._connect() as conn:
            conn.executescript(
                """
                CREATE TABLE IF NOT EXISTS raw_messages (
                    id TEXT PRIMARY KEY,
                    chat_id INTEGER NOT NULL,
                    msg_id INTEGER NOT NULL,
                    text TEXT NOT NULL,
                    source TEXT NOT NULL,
                    date TEXT NOT NULL,
                    sender_id INTEGER,
                    reply_to_msg_id INTEGER,
                    top_msg_id INTEGER,
                    mentions_json TEXT NOT NULL DEFAULT '[]',
                    sender_is_bot INTEGER NOT NULL DEFAULT 0
                );

                CREATE TABLE IF NOT EXISTS parsed_cards (
                    id TEXT PRIMARY KEY,
                    raw_message_id TEXT NOT NULL,
                    primary_channel TEXT NOT NULL,
                    channels_json TEXT NOT NULL,
                    payload_json TEXT NOT NULL,
                    FOREIGN KEY(raw_message_id) REFERENCES raw_messages(id)
                );

                CREATE INDEX IF NOT EXISTS idx_raw_messages_msg_id
                    ON raw_messages(chat_id, msg_id);
                CREATE INDEX IF NOT EXISTS idx_parsed_cards_primary_channel
                    ON parsed_cards(primary_channel);

                CREATE TABLE IF NOT EXISTS state_patches (
                    scope TEXT NOT NULL,
                    send_as_id INTEGER NOT NULL DEFAULT 0,
                    key TEXT NOT NULL,
                    value_json TEXT NOT NULL,
                    source_message_id TEXT NOT NULL,
                    updated_at TEXT NOT NULL,
                    PRIMARY KEY(scope, send_as_id, key),
                    FOREIGN KEY(source_message_id) REFERENCES raw_messages(id)
                );

                CREATE INDEX IF NOT EXISTS idx_state_patches_scope
                    ON state_patches(scope, updated_at);

                CREATE TABLE IF NOT EXISTS settings (
                    key TEXT PRIMARY KEY,
                    value_json TEXT NOT NULL
                );

                CREATE TABLE IF NOT EXISTS accounts (
                    local_id TEXT PRIMARY KEY,
                    payload_json TEXT NOT NULL,
                    updated_at REAL NOT NULL DEFAULT 0
                );

                CREATE TABLE IF NOT EXISTS identities (
                    send_as_id INTEGER PRIMARY KEY,
                    payload_json TEXT NOT NULL,
                    updated_at REAL NOT NULL DEFAULT 0
                );

                CREATE TABLE IF NOT EXISTS outbox_drafts (
                    id TEXT PRIMARY KEY,
                    status TEXT NOT NULL,
                    created_at TEXT NOT NULL,
                    payload_json TEXT NOT NULL
                );

                CREATE INDEX IF NOT EXISTS idx_outbox_drafts_status
                    ON outbox_drafts(status, created_at);

                CREATE TABLE IF NOT EXISTS official_schedule_batches (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    send_as_id INTEGER NOT NULL,
                    account_local_id TEXT NOT NULL DEFAULT '',
                    preset_key TEXT NOT NULL DEFAULT '',
                    label TEXT NOT NULL DEFAULT '',
                    anchor_at REAL NOT NULL DEFAULT 0,
                    horizon_days INTEGER NOT NULL DEFAULT 0,
                    status TEXT NOT NULL DEFAULT 'active',
                    options_json TEXT NOT NULL DEFAULT '{}',
                    created_at REAL NOT NULL,
                    updated_at REAL NOT NULL
                );

                CREATE INDEX IF NOT EXISTS idx_official_schedule_batches_identity
                    ON official_schedule_batches(send_as_id, status);

                CREATE TABLE IF NOT EXISTS official_scheduled_messages (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    batch_id INTEGER NOT NULL DEFAULT 0,
                    send_as_id INTEGER NOT NULL,
                    command TEXT NOT NULL,
                    schedule_at REAL NOT NULL,
                    scheduled_msg_id INTEGER NOT NULL DEFAULT 0,
                    status TEXT NOT NULL DEFAULT 'planned',
                    last_error TEXT NOT NULL DEFAULT '',
                    created_at REAL NOT NULL,
                    updated_at REAL NOT NULL
                );

                CREATE INDEX IF NOT EXISTS idx_official_scheduled_messages_batch
                    ON official_scheduled_messages(batch_id);
                CREATE INDEX IF NOT EXISTS idx_official_scheduled_messages_identity
                    ON official_scheduled_messages(send_as_id, schedule_at);

                CREATE TABLE IF NOT EXISTS identity_module_state (
                    send_as_id INTEGER NOT NULL,
                    module_key TEXT NOT NULL,
                    state_json TEXT NOT NULL DEFAULT '{}',
                    source_message_id TEXT NOT NULL DEFAULT '',
                    updated_at REAL NOT NULL,
                    PRIMARY KEY(send_as_id, module_key)
                );

                CREATE INDEX IF NOT EXISTS idx_identity_module_state_updated
                    ON identity_module_state(updated_at DESC);

                CREATE INDEX IF NOT EXISTS idx_raw_messages_date
                    ON raw_messages(date);
                """
            )
            self._migrate_raw_messages_columns(conn)
            self._migrate_state_patches_columns(conn)
            # idx_state_patches_sender 引用 send_as_id 列,迁移完成后再建,避免老库 cold start 失败
            conn.execute(
                "CREATE INDEX IF NOT EXISTS idx_state_patches_sender "
                "ON state_patches(scope, send_as_id)"
            )

    def _migrate_state_patches_columns(self, conn) -> None:
        """幂等 schema 升级:给老 state_patches 加 send_as_id 列。
        老库的 PK 是 (scope, key) 全局,导致多身份共用一行覆盖,角色 HUD 串号。
        新库 PK 是 (scope, send_as_id, key),每个身份独立一行。
        老行 send_as_id 填 0(全局),不丢历史数据。"""
        existing = {row[1] for row in conn.execute("PRAGMA table_info(state_patches)").fetchall()}
        if "send_as_id" in existing:
            return
        # 旧表存在但缺 send_as_id 列:rebuild 表(SQLite 不支持 ALTER 改 PK)
        legacy_count = conn.execute("SELECT COUNT(*) FROM state_patches").fetchone()[0]
        conn.executescript(
            """
            ALTER TABLE state_patches RENAME TO state_patches_legacy;
            CREATE TABLE state_patches (
                scope TEXT NOT NULL,
                send_as_id INTEGER NOT NULL DEFAULT 0,
                key TEXT NOT NULL,
                value_json TEXT NOT NULL,
                source_message_id TEXT NOT NULL,
                updated_at TEXT NOT NULL,
                PRIMARY KEY(scope, send_as_id, key),
                FOREIGN KEY(source_message_id) REFERENCES raw_messages(id)
            );
            INSERT INTO state_patches(scope, send_as_id, key, value_json, source_message_id, updated_at)
              SELECT scope, 0, key, value_json, source_message_id, updated_at FROM state_patches_legacy;
            DROP TABLE state_patches_legacy;
            CREATE INDEX IF NOT EXISTS idx_state_patches_scope
                ON state_patches(scope, updated_at);
            CREATE INDEX IF NOT EXISTS idx_state_patches_sender
                ON state_patches(scope, send_as_id);
            """
        )
        if legacy_count:
            print(f"[mini-web] state_patches 升级:迁移 {legacy_count} 条全局行(send_as_id=0)")

    def _migrate_raw_messages_columns(self, conn) -> None:
        """幂等 schema 升级:给 raw_messages 加 4 个新列(老库没有就 ALTER 加上)。
        - edited_at:Telegram 编辑事件时间戳;NULL = 未编辑
        - deleted_at:Telegram 删除事件时间戳;NULL = 未删,行不真正 DELETE,UI 加删除线显示
        - media_kind:photo / video / voice / video_note / audio / document / sticker /
                     animation / poll / contact / dice / location 等;NULL = 纯文本
        - media_meta_json:轻量元数据(尺寸 / 时长 / 文件名 / sticker emoji 等),不下载二进制
        """
        existing = {row[1] for row in conn.execute("PRAGMA table_info(raw_messages)").fetchall()}
        for column, ddl in (
            ("edited_at", "ALTER TABLE raw_messages ADD COLUMN edited_at TEXT"),
            ("deleted_at", "ALTER TABLE raw_messages ADD COLUMN deleted_at TEXT"),
            ("media_kind", "ALTER TABLE raw_messages ADD COLUMN media_kind TEXT"),
            ("media_meta_json", "ALTER TABLE raw_messages ADD COLUMN media_meta_json TEXT"),
        ):
            if column not in existing:
                conn.execute(ddl)

    def _connect(self) -> sqlite3.Connection:
        # 多线程并发写(listener 线程在 ingest 消息 + HTTP 请求在保存账号/身份)
        # 默认 SQLite 不容忍并发,会立刻报 "database is locked"。
        # 加 WAL 模式让读不阻塞写,加 busy_timeout=5s 让写等而不立刻 fail。
        conn = sqlite3.connect(self.db_path, timeout=5.0)
        conn.execute("PRAGMA foreign_keys=ON")
        conn.execute("PRAGMA journal_mode=WAL")
        conn.execute("PRAGMA busy_timeout=5000")
        conn.execute("PRAGMA synchronous=NORMAL")
        return conn


def _normalize_settings(payload: dict) -> dict:
    def text(key: str) -> str:
        return str(payload.get(key) or "").strip()

    def bool_value(key: str) -> bool:
        return bool(payload.get(key))

    raw_bot_ids = payload.get("game_bot_ids") or []
    if isinstance(raw_bot_ids, str):
        raw_bot_ids = raw_bot_ids.replace("\n", ",").split(",")
    game_bot_ids = []
    for item in raw_bot_ids:
        raw = str(item or "").strip()
        if not raw:
            continue
        try:
            game_bot_ids.append(int(raw))
        except ValueError:
            continue

    retention_raw = payload.get("message_retention_days")
    if retention_raw is None or str(retention_raw).strip() == "":
        retention = 30
    else:
        try:
            retention = int(str(retention_raw).strip())
        except (TypeError, ValueError):
            retention = 30
        if retention < 0:
            retention = 0

    # notify_card_titles: tuple/list of strings (UI 多选 checkbox)
    raw_titles = payload.get("notify_card_titles") or []
    if isinstance(raw_titles, str):
        raw_titles = [raw_titles]
    notify_card_titles = sorted(
        {str(t).strip() for t in raw_titles if str(t or "").strip()}
    )

    def str_list(key: str, default: list[str] | None = None) -> list[str]:
        raw = payload.get(key)
        if raw is None:
            raw = default or []
        if isinstance(raw, str):
            raw = raw.replace("\n", ",").split(",")
        return [str(item).strip() for item in raw if str(item or "").strip()]

    def int_list(key: str) -> list[int]:
        out = []
        for item in str_list(key):
            try:
                out.append(int(item))
            except (TypeError, ValueError):
                continue
        return sorted(set(out))

    return {
        "api_id": text("api_id"),
        "api_hash": text("api_hash"),
        "phone": text("phone"),
        "session_name": text("session_name") or "miniweb_session",
        "target_chat": text("target_chat"),
        "target_topic_id": text("target_topic_id"),
        "game_bot_ids": sorted(set(game_bot_ids)),
        "proxy_type": text("proxy_type").lower(),
        "proxy_host": text("proxy_host"),
        "proxy_username": text("proxy_username"),
        "proxy_password": text("proxy_password"),
        "listen_enabled": bool_value("listen_enabled"),
        "login_status": text("login_status") or "idle",
        "login_message": text("login_message"),
        "login_account_id": text("login_account_id"),
        "listener_status": text("listener_status") or "stopped",
        "listener_message": text("listener_message"),
        "message_retention_days": retention,
        "own_aliases": sorted(set(str_list("own_aliases"))),
        "leader_sender_ids": int_list("leader_sender_ids"),
        "leader_source_names": sorted(set(str_list("leader_source_names"))),
        "focus_keywords": sorted(set(str_list("focus_keywords", list(DEFAULT_FOCUS_KEYWORDS)))),
        "focus_include_player_plain": bool_value("focus_include_player_plain"),
        "archive_dot_commands": bool_value("archive_dot_commands"),
        "archive_bot_replies": bool_value("archive_bot_replies"),
        "message_filter_version": 1,
        "notify_enabled": bool_value("notify_enabled"),
        "notify_tg_bot_token": text("notify_tg_bot_token"),
        "notify_tg_chat_id": text("notify_tg_chat_id"),
        "notify_card_titles": notify_card_titles,
    }


def _normalize_account(payload: dict) -> dict:
    def text(key: str) -> str:
        return str(payload.get(key) or "").strip()

    raw_local_id = text("local_id") or text("session_name") or text("phone") or "account"
    local_id = safe_session_name(raw_local_id, fallback="account")
    session_name = safe_session_name(text("session_name") or local_id, fallback=local_id)

    return {
        "local_id": local_id,
        "account_id": text("account_id"),
        "label": text("label") or text("phone") or local_id,
        "phone": text("phone"),
        "session_name": session_name,
        "api_id": text("api_id"),
        "api_hash": text("api_hash"),
        "target_chat": text("target_chat"),
        "target_topic_id": text("target_topic_id"),
        "proxy_type": text("proxy_type").lower(),
        "proxy_host": text("proxy_host"),
        "proxy_username": text("proxy_username"),
        "proxy_password": text("proxy_password"),
        "collector_enabled": bool(payload.get("collector_enabled", True)),
        "collector_priority": _coerce_non_negative_int(payload.get("collector_priority")),
        "listen_enabled": bool(payload.get("listen_enabled")),
        "login_status": text("login_status") or "idle",
        "login_message": text("login_message"),
        "listener_status": text("listener_status") or "stopped",
        "listener_message": text("listener_message"),
    }


def _normalize_identity(payload: dict) -> dict:
    def text(key: str) -> str:
        return str(payload.get(key) or "").strip()

    send_as_id = _coerce_non_zero_int(payload.get("send_as_id") or payload.get("id"))
    account_local_id = safe_session_name(text("account_local_id"), fallback="") if text("account_local_id") else ""
    username = text("username").lstrip("@")
    label = text("label") or username or (str(send_as_id) if send_as_id != 0 else "")
    return {
        "send_as_id": send_as_id,
        "account_local_id": account_local_id,
        "label": label,
        "username": username,
        "enabled": bool(payload.get("enabled", True)),
        "note": text("note"),
    }


def _normalize_outbox_draft(payload: dict) -> dict:
    draft = OutboxDraft.from_api(payload).to_api()
    draft["id"] = str(draft.get("id") or "").strip()
    draft["command"] = str(draft.get("command") or "").strip()
    draft["target_chat"] = str(draft.get("target_chat") or "").strip()
    draft["account_local_id"] = safe_session_name(draft.get("account_local_id") or "", fallback="")
    draft["source_message_id"] = str(draft.get("source_message_id") or "").strip()
    draft["send_mode"] = str(draft.get("send_mode") or "copy").strip() or "copy"
    draft["status"] = str(draft.get("status") or "draft").strip() or "draft"
    draft["created_at"] = str(draft.get("created_at") or "").strip()
    draft["note"] = str(draft.get("note") or "").strip()
    draft["missing"] = [
        str(item).strip()
        for item in (draft.get("missing") or [])
        if str(item).strip()
    ]
    return draft


def _coerce_positive_int(value: object) -> int:
    try:
        number = int(str(value or "").strip())
    except (TypeError, ValueError):
        return 0
    return number if number > 0 else 0


def _coerce_non_zero_int(value: object) -> int:
    try:
        number = int(str(value or "").strip())
    except (TypeError, ValueError):
        return 0
    return number if number != 0 else 0


def _coerce_non_negative_int(value: object) -> int:
    try:
        number = int(str(value).strip())
    except (TypeError, ValueError):
        return 100
    return max(0, number)
