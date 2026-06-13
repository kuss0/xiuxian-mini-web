from __future__ import annotations

import json
import re
import sqlite3
import time
import uuid
from contextlib import contextmanager
from dataclasses import replace
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Iterable

from backend.domain.models import (
    OutboxDraft,
    ParsedCard,
    RawMessageEvent,
    ResourceDelta,
    ResourceEvent,
    StatePatch,
    utc_now_iso,
)
from backend.external.tianjige import TianjigeConfig
from backend.identity_state import build_default_registry
from backend.parsers import build_parser_registry
from backend.parsers.inventory import parse_inventory_delta_event, parse_inventory_snapshot
from backend.parsers.resource_stats import infer_wild_strategy_from_command
from backend.processors import MessagePipeline
from backend.processors.message_filter import (
    CURRENT_LEADER_MESSAGE_FILTER_VERSION,
    CURRENT_MESSAGE_FILTER_VERSION,
    DEFAULT_FOCUS_EXCLUDE_PATTERNS,
    DEFAULT_FOCUS_KEYWORDS,
    enrich_filter_channels,
)
from backend.repo.accounts import _normalize_account, _normalize_identity
from backend.repo.common import (
    _coerce_non_zero_int,
    _merge_int_defaults,
    _merge_str_defaults,
    _normalize_channel_filters,
    _parse_message_dt,
    _safe_int,
)
from backend.repo.outbox import _normalize_outbox_draft, _normalize_send_log, _send_log_row_to_api
from backend.repo.resources import (
    _inventory_item_row_to_api,
    _inventory_snapshot_row_to_api,
    _resource_coverage_kind,
    _resource_delta_row_to_api,
    _resource_event_diagnostics,
    _resource_event_row_to_api,
    _resource_event_summary,
    _resource_period_keys,
)
from backend.repo.schedules import _normalize_schedule_saved_templates
from backend.repo.settings import _merge_focus_exclude_defaults, _normalize_settings
from backend.tg.client import safe_session_name


DEFAULT_GAME_BOT_IDS = [-1003983937918, 7900199668, 8388633812, 8547797815, 8757550896]
DEFAULT_LEADER_SENDER_IDS = [-1002049298748]
DEFAULT_LEADER_SOURCE_NAMES = ["@iosdo7"]
DEFAULT_TARGET_CHAT = "-1001680975844"
DEFAULT_TARGET_TOPIC_ID = "7310786"
ALL_CHANNEL_INDEX_KEY = "__all__"
ACCOUNT_SECRET_KEYS = {"api_hash", "proxy_password"}
RESOURCE_STATS_SCHEMA_VERSION = 8
INVENTORY_SCHEMA_VERSION = 5
INVENTORY_LEDGER_SCHEMA_VERSION = 2
MODULE_STATE_BACKFILL_VERSION = 2
MODULE_STATE_BACKFILL_KEYS = ("small_world", "wendao", "yindao", "search_node")
DUNGEON_CONTEXT_SCAN_LIMIT = 2500
RESOURCE_BASIC_NAMES = ("修为", "贡献", "灵石")
RESOURCE_RARE_NAMES = (
    "阴凝之晶",
    "金精矿",
    "凝血草",
    "清灵草",
    "天雷竹",
    "朱果",
    "百年铁木",
    "阴魂丝",
    "灵眼木髓碎片",
    "天凤之翎",
    "风雷翅图纸",
    "风之祝福",
    "极阴庇护",
    "风行丹丹方",
    "黄龙阵旗残片",
    "龙蛇回元散丹方",
    "皇鳞甲图纸",
    "第二元神残篇",
    "第二元神修炼法（残篇）",
    "青元剑诀（上）",
    "金光砖",
    "九曲灵参丹丹方",
    "元磁山核·甲",
    "虚天鼎残片·甲",
    "虚天鼎残片·乙",
    "虚天鼎残片·丙",
    "虚天鼎残片·丁",
    "大挪移令",
    "坠魔谷禁制令",
    "苍坤路线残图",
    "残缺阴环",
    "碧鸠毒囊",
    "紫铖兜图谱",
)


def _module_state_backfill_marker_key(send_as_id: int) -> str:
    return f"module_state_backfill_v{MODULE_STATE_BACKFILL_VERSION}_identity_{int(send_as_id)}"


class SQLiteStore:
    def __init__(self, db_path: Path | str) -> None:
        self.db_path = Path(db_path)
        self.db_path.parent.mkdir(parents=True, exist_ok=True)
        self._init_schema()
        # 通知调度器 — 服务层注入(set_notify_dispatcher),没注入就完全不推
        self._notify_dispatcher = None
        self._runtime_cache: dict[str, tuple[float, object]] = {}
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

    def has_message(self, chat_id: int, msg_id: int, topic_id: int = 0) -> bool:
        """消息箱是否已经有这条 Telegram 消息。

        listener 补拉 reply 父消息前会先问这里,避免每条 reply 都打 TG API。
        msg_id 在同一个 chat 内唯一;topic_id 只作为额外保护,防止配置错话题时误判。
        """
        if not chat_id or not msg_id:
            return False
        params: list = [int(chat_id), int(msg_id)]
        where = "chat_id=? AND msg_id=?"
        if topic_id:
            where += " AND (top_msg_id=? OR top_msg_id IS NULL OR top_msg_id=0)"
            params.append(int(topic_id))
        try:
            with self._connect() as conn:
                row = conn.execute(
                    f"SELECT 1 FROM raw_messages WHERE {where} LIMIT 1",
                    params,
                ).fetchone()
        except Exception:
            return False
        return row is not None

    def _collect_my_identities(self) -> list[int]:
        """所有已登记身份的 send_as_id。"""
        cached = self._runtime_cache_get("my_identities")
        if cached is not None:
            return list(cached)
        ids: set[int] = set()
        try:
            ids.update(int(item.get("send_as_id") or 0) for item in self.list_identities())
        except Exception:
            pass
        try:
            ids.update(int(account.get("account_id") or 0) for account in self.list_accounts())
        except Exception:
            pass
        result = [item for item in sorted(ids) if item]
        self._runtime_cache_set("my_identities", result)
        return result

    def _collect_my_aliases(self) -> list[str]:
        """从账号/身份里自动收集自己的 @username,用于过滤 @我的消息。"""
        aliases: list[str] = []
        for collection in (self.list_accounts, self.list_identities):
            try:
                items = collection()
            except Exception:
                continue
            for item in items:
                username = str((item or {}).get("username") or "").strip().lstrip("@")
                if username:
                    aliases.append(username)
        return _merge_str_defaults([], aliases)

    def inventory_owner_allowlist(self) -> list[str]:
        """库存/转移页只展示明确配置成自己的储物袋 owner。"""
        owners: list[str] = []
        seen: set[str] = set()

        def add(value: object) -> None:
            owner = str(value or "").strip().lstrip("@")
            if not owner:
                return
            key = owner.lower()
            if key in seen:
                return
            seen.add(key)
            owners.append(owner)

        try:
            for alias in self.get_settings().get("own_aliases") or []:
                add(alias)
        except Exception:
            pass
        for collection in (self.list_accounts, self.list_identities):
            try:
                items = collection()
            except Exception:
                continue
            for item in items:
                add((item or {}).get("username"))
                add((item or {}).get("label"))
        return owners

    def _collect_game_bot_ids(self) -> list[int]:
        cached = self._runtime_cache_get("game_bot_ids")
        if cached is not None:
            return list(cached)
        try:
            ids = self.get_settings().get("game_bot_ids") or []
            result = [int(x) for x in ids]
            self._runtime_cache_set("game_bot_ids", result)
            return result
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
            ids = self._collect_game_bot_ids()
            return sid in {int(x) for x in ids}
        except Exception:
            return False

    def _get_target_topic_id(self) -> int:
        cached = self._runtime_cache_get("target_topic_id")
        if cached is not None:
            return int(cached or 0)
        try:
            result = int(self.get_settings().get("target_topic_id") or 0)
            self._runtime_cache_set("target_topic_id", result)
            return result
        except (TypeError, ValueError):
            return 0

    def _runtime_cache_get(self, key: str, *, ttl: float = 1.0):
        now = time.time()
        item = self._runtime_cache.get(key)
        if not item:
            return None
        expires_at, value = item
        if float(expires_at or 0) <= now:
            self._runtime_cache.pop(key, None)
            return None
        return value

    def _runtime_cache_set(self, key: str, value: object, *, ttl: float = 1.0) -> None:
        self._runtime_cache[key] = (time.time() + max(0.0, float(ttl or 0.0)), value)

    def _runtime_cache_clear(self, *keys: str) -> None:
        if not keys:
            self._runtime_cache.clear()
            return
        for key in keys:
            self._runtime_cache.pop(key, None)

    @classmethod
    def default(cls) -> SQLiteStore:
        return cls(Path(__file__).resolve().parents[2] / "data" / "miniweb.db")

    def seed_samples_if_empty(self) -> None:
        self.cleanup_seed_samples()
        with self._connect() as conn:
            count = conn.execute("SELECT COUNT(*) FROM raw_messages").fetchone()[0]
        if count:
            self.backfill_state_patches_if_empty()
            self.backfill_module_states_if_empty()
            self.backfill_missing_module_states_if_needed()
            return

    def cleanup_seed_samples(self) -> int:
        """Remove old in-database bootstrap samples.

        Samples belong to SampleStore only. Keeping them in the real SQLite store
        pollutes health checks because their date is display text, not ISO time.
        """
        with self._connect() as conn:
            row = conn.execute(
                """
                SELECT COUNT(*)
                FROM raw_messages
                WHERE chat_id=0
                  AND id LIKE 'sample-%'
                """
            ).fetchone()
            deleted = int((row or [0])[0] or 0)
            if not deleted:
                return 0
            conn.execute(
                """
                DELETE FROM parsed_cards
                WHERE raw_message_id LIKE 'sample-%'
                """
            )
            conn.execute(
                """
                DELETE FROM state_patches
                WHERE source_message_id LIKE 'sample-%'
                """
            )
            conn.execute(
                """
                DELETE FROM resource_events
                WHERE raw_message_id LIKE 'sample-%'
                """
            )
            conn.execute(
                """
                DELETE FROM resource_deltas
                WHERE raw_message_id LIKE 'sample-%'
                """
            )
            conn.execute(
                """
                DELETE FROM inventory_snapshots
                WHERE raw_message_id LIKE 'sample-%'
                """
            )
            conn.execute(
                """
                DELETE FROM raw_messages
                WHERE chat_id=0
                  AND id LIKE 'sample-%'
                """
            )
        return deleted

    def message_health_summary(self) -> dict:
        def looks_like_message_time(value: object) -> bool:
            return bool(re.match(r"^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}", str(value or "")))

        with self._connect() as conn:
            total = int(conn.execute("SELECT COUNT(*) FROM raw_messages").fetchone()[0] or 0)
            sample_total = int(
                conn.execute("SELECT COUNT(*) FROM raw_messages WHERE chat_id=0").fetchone()[0] or 0
            )
            invalid = self._runtime_cache_get("message_health_invalid_date_total")
            if invalid is None:
                first_any = conn.execute("SELECT date FROM raw_messages ORDER BY date ASC LIMIT 1").fetchone()
                latest_any = conn.execute("SELECT date FROM raw_messages ORDER BY date DESC LIMIT 1").fetchone()
                if (
                    total > 0
                    and looks_like_message_time((first_any or [""])[0])
                    and looks_like_message_time((latest_any or [""])[0])
                ):
                    invalid = 0
                else:
                    invalid = int(
                        conn.execute(
                            """
                            SELECT COUNT(*)
                            FROM raw_messages
                            WHERE date NOT LIKE '____-__-__T__:__:__%'
                              AND date NOT LIKE '____-__-__ __:__:__%'
                            """
                        ).fetchone()[0]
                        or 0
                    )
                self._runtime_cache_set("message_health_invalid_date_total", invalid, ttl=600.0)
            if int(invalid or 0) > 0:
                real = conn.execute(
                    """
                    SELECT COUNT(*), MIN(date), MAX(date), MIN(msg_id), MAX(msg_id)
                    FROM raw_messages
                    WHERE chat_id != 0
                      AND (
                        date LIKE '____-__-__T__:__:__%'
                        OR date LIKE '____-__-__ __:__:__%'
                      )
                    """
                ).fetchone()
                real_total = int((real or [0])[0] or 0)
                first_message_time = (real or [None, "", ""])[1] or ""
                latest_message_time = (real or [None, "", ""])[2] or ""
                first_msg_id = int((real or [None, None, None, 0, 0])[3] or 0)
                latest_msg_id = int((real or [None, None, None, 0, 0])[4] or 0)
            else:
                first_row = conn.execute(
                    "SELECT date, msg_id FROM raw_messages WHERE chat_id != 0 ORDER BY date ASC LIMIT 1"
                ).fetchone()
                latest_row = conn.execute(
                    "SELECT date, msg_id FROM raw_messages WHERE chat_id != 0 ORDER BY date DESC LIMIT 1"
                ).fetchone()
                real_total = max(0, total - sample_total)
                first_message_time = (first_row or ["", 0])[0] or ""
                latest_message_time = (latest_row or ["", 0])[0] or ""
                first_msg_id = int((first_row or ["", 0])[1] or 0)
                latest_msg_id = int((latest_row or ["", 0])[1] or 0)
            cards = int(conn.execute("SELECT COUNT(*) FROM parsed_cards").fetchone()[0] or 0)
            resources = int(conn.execute("SELECT COUNT(*) FROM resource_events").fetchone()[0] or 0)
        return {
            "raw_total": total,
            "real_raw_total": real_total,
            "invalid_date_total": int(invalid or 0),
            "parsed_cards": cards,
            "resource_events": resources,
            "first_message_time": first_message_time,
            "latest_message_time": latest_message_time,
            "first_msg_id": first_msg_id,
            "latest_msg_id": latest_msg_id,
        }

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

    def backfill_missing_module_states_if_needed(
        self,
        send_as_id: int | str | None = None,
        *,
        force: bool = False,
    ) -> dict[str, object]:
        """Targeted historical observe for modules added after the first backfill.

        The original full backfill only runs when identity_module_state is empty.
        When new observe-only modules are introduced later, old bot replies are
        already in raw_messages but the table is not empty anymore.  This pass
        replays only replies whose parent command can affect the new modules,
        and only through MessagePipeline.observe_event() so cards/resources are
        not rewritten.
        """
        target_keys = tuple(MODULE_STATE_BACKFILL_KEYS)
        if send_as_id is None:
            target_sids = [int(sid) for sid in self._collect_my_identities() if int(sid or 0)]
        else:
            sid = _coerce_non_zero_int(send_as_id)
            target_sids = [sid] if sid else []
        target_sids = sorted(set(target_sids))
        if not target_sids:
            return {"events": 0, "states": 0, "modules": [], "identities": [], "skipped": 0}

        processed_sids: list[int] = []
        missing_union: set[str] = set()
        skipped = 0
        with self._connect() as conn:
            for sid in target_sids:
                marker_row = conn.execute(
                    "SELECT value_json FROM settings WHERE key=?",
                    (_module_state_backfill_marker_key(sid),),
                ).fetchone()
                try:
                    marker_version = int(json.loads(marker_row[0])) if marker_row else 0
                except (TypeError, ValueError, json.JSONDecodeError):
                    marker_version = 0
                if marker_version >= MODULE_STATE_BACKFILL_VERSION and not force:
                    skipped += 1
                    continue
                existing_keys = {
                    str(row[0] or "")
                    for row in conn.execute(
                        "SELECT DISTINCT module_key FROM identity_module_state WHERE send_as_id=?",
                        (sid,),
                    ).fetchall()
                }
                missing = [key for key in target_keys if key not in existing_keys]
                if missing:
                    missing_union.update(missing)
                    processed_sids.append(sid)
                else:
                    conn.execute(
                        """
                        INSERT INTO settings(key, value_json)
                        VALUES(?, ?)
                        ON CONFLICT(key) DO UPDATE SET value_json=excluded.value_json
                        """,
                        (
                            _module_state_backfill_marker_key(sid),
                            json.dumps(MODULE_STATE_BACKFILL_VERSION),
                        ),
                    )
            if not processed_sids:
                return {
                    "events": 0,
                    "states": 0,
                    "modules": [],
                    "identities": [],
                    "skipped": skipped,
                }
            sid_placeholders = ",".join("?" for _ in processed_sids)
            key_placeholders = ",".join("?" for _ in target_keys)
            before_count = conn.execute(
                f"""
                SELECT COUNT(*)
                FROM identity_module_state
                WHERE send_as_id IN ({sid_placeholders})
                  AND module_key IN ({key_placeholders})
                """,
                (*processed_sids, *target_keys),
            ).fetchone()[0]
            rows = []
            for sid in processed_sids:
                rows.extend(
                    conn.execute(
                        """
                        SELECT rm.id, rm.chat_id, rm.msg_id, rm.text, rm.source, rm.date,
                               rm.sender_id, rm.reply_to_msg_id, rm.top_msg_id,
                               rm.mentions_json, rm.sender_is_bot,
                               rm.edited_at, rm.deleted_at, rm.media_kind, rm.media_meta_json
                        FROM raw_messages rm
                        JOIN raw_messages parent
                          ON parent.chat_id=rm.chat_id
                         AND parent.msg_id=rm.reply_to_msg_id
                        WHERE rm.reply_to_msg_id IS NOT NULL
                          AND parent.sender_id=?
                          AND (
                            parent.text = '.问道'
                            OR parent.text = '.搜寻节点'
                            OR parent.text LIKE '.引道%'
                            OR parent.text LIKE '.定星%'
                            OR parent.text LIKE '.小世界%'
                            OR parent.text LIKE '.收割香火%'
                            OR parent.text LIKE '.神识淬炼%'
                            OR parent.text LIKE '.神迹%'
                            OR parent.text LIKE '.显灵%'
                          )
                        ORDER BY rm.rowid ASC
                        """,
                        (sid,),
                    ).fetchall()
                )
        events = 0
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
            observed_dt = _parse_message_dt(event.date)
            self._pipeline.observe_event(
                event,
                observed_at=observed_dt.timestamp() if observed_dt else None,
                force=True,
            )
            events += 1
        with self._connect() as conn:
            sid_placeholders = ",".join("?" for _ in processed_sids)
            key_placeholders = ",".join("?" for _ in target_keys)
            after_count = conn.execute(
                f"""
                SELECT COUNT(*)
                FROM identity_module_state
                WHERE send_as_id IN ({sid_placeholders})
                  AND module_key IN ({key_placeholders})
                """,
                (*processed_sids, *target_keys),
            ).fetchone()[0]
            for sid in processed_sids:
                conn.execute(
                    """
                    INSERT INTO settings(key, value_json)
                    VALUES(?, ?)
                    ON CONFLICT(key) DO UPDATE SET value_json=excluded.value_json
                    """,
                    (
                        _module_state_backfill_marker_key(sid),
                        json.dumps(MODULE_STATE_BACKFILL_VERSION),
                    ),
                )
        return {
            "events": events,
            "states": max(0, int(after_count or 0) - int(before_count or 0)),
            "modules": sorted(missing_union),
            "identities": processed_sids,
            "skipped": skipped,
        }

    def backfill_resource_records_if_needed(self) -> dict[str, int]:
        """资源统计表首次启用/升级时,从历史消息箱补一次。

        只跑 parser registry 提取 resource_events/resource_deltas,不走
        ingest_event,避免重建卡片、observe 状态机或触发通知。
        """
        with self._connect() as conn:
            existing_events = conn.execute("SELECT COUNT(*) FROM resource_events").fetchone()[0]
            legacy_per_member = conn.execute(
                "SELECT COUNT(*) FROM resource_deltas WHERE basis='per_member'"
            ).fetchone()[0]
            legacy_unsplit_source = conn.execute(
                """
                SELECT COUNT(*)
                FROM resource_events
                WHERE (source_type='wild_training' AND source_name='野外历练')
                   OR (source_type='dungeon' AND source_name='虚天殿')
                """
            ).fetchone()[0]
            legacy_removed_sources = conn.execute(
                """
                SELECT COUNT(*)
                FROM resource_events
                WHERE source_type IN ('deep_retreat', 'retreat_shallow', 'pet_touch', 'pet_warm')
                """
            ).fetchone()[0]
            stored_version_row = conn.execute(
                "SELECT value_json FROM settings WHERE key='resource_stats_schema_version'"
            ).fetchone()
            try:
                stored_version = int(json.loads(stored_version_row[0])) if stored_version_row else 0
            except (TypeError, ValueError, json.JSONDecodeError):
                stored_version = 0
            if (
                existing_events
                and not legacy_per_member
                and not legacy_unsplit_source
                and not legacy_removed_sources
                and stored_version >= RESOURCE_STATS_SCHEMA_VERSION
            ):
                return {"events": 0, "deltas": 0}
            rows = conn.execute(
                """
                SELECT id, chat_id, msg_id, text, source, date, sender_id,
                       reply_to_msg_id, top_msg_id, mentions_json, sender_is_bot,
                       edited_at, deleted_at, media_kind, media_meta_json
                FROM raw_messages
                WHERE text LIKE '%野外历练%'
                   OR text LIKE '%战利品结算%'
                   OR text LIKE '%黄龙山大战%'
                   OR text LIKE '%登顶昆吾山%'
                   OR text LIKE '%坠魔谷%'
                   OR text LIKE '%苍坤上人洞府%'
                   OR text LIKE '%灵果入腹%'
                   OR (text LIKE '%逆天之举%' AND text LIKE '%风希%')
                   OR text LIKE '%【极阴的欣赏】%'
                   OR text LIKE '%【神魂碾压】%'
                   OR text LIKE '%【侥幸逃脱】%'
                   OR text LIKE '%【天机异闻·南陇侯的交易】%'
                   OR text LIKE '%【天机异闻·魔君之怒】%'
                ORDER BY rowid ASC
                """
            ).fetchall()
        if not rows:
            return {"events": 0, "deltas": 0}
        registry = build_parser_registry()
        event_count = 0
        delta_count = 0
        with self._connect() as conn:
            # resource_events 是新表。首次升级时顺手重建 resource_deltas,
            # 把旧的副本 per_member 口径改成 run 口径。
            conn.execute("DELETE FROM resource_deltas")
            conn.execute("DELETE FROM resource_events")
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
                output = registry.parse(event)
                if not output.resource_deltas and not output.resource_events:
                    continue
                self._replace_resource_records(
                    conn,
                    event,
                    output.resource_deltas,
                    output.resource_events,
                )
                event_count += len(output.resource_events)
                delta_count += len(output.resource_deltas)
            conn.execute(
                """
                INSERT INTO settings(key, value_json)
                VALUES(?, ?)
                ON CONFLICT(key) DO UPDATE SET value_json=excluded.value_json
                """,
                ("resource_stats_schema_version", json.dumps(RESOURCE_STATS_SCHEMA_VERSION)),
            )
        return {"events": event_count, "deltas": delta_count}

    def backfill_resource_deltas_if_empty(self) -> int:
        """兼容旧调用名。返回本次写入的 resource_deltas 数量。"""
        return self.backfill_resource_records_if_needed()["deltas"]

    def backfill_inventory_snapshots_if_needed(self) -> dict[str, int]:
        """从历史消息箱补储物袋快照。

        .储物袋 面板是权威快照;成功回执只作为快照之后的估算账本,
        用来减少手动刷新频率。UI 仍会暴露 confidence,方便回到手动刷新兜底。
        """
        with self._connect() as conn:
            stored_version_row = conn.execute(
                "SELECT value_json FROM settings WHERE key='inventory_schema_version'"
            ).fetchone()
            try:
                stored_version = int(json.loads(stored_version_row[0])) if stored_version_row else 0
            except (TypeError, ValueError, json.JSONDecodeError):
                stored_version = 0
            stored_ledger_version_row = conn.execute(
                "SELECT value_json FROM settings WHERE key='inventory_ledger_schema_version'"
            ).fetchone()
            try:
                stored_ledger_version = (
                    int(json.loads(stored_ledger_version_row[0])) if stored_ledger_version_row else 0
                )
            except (TypeError, ValueError, json.JSONDecodeError):
                stored_ledger_version = 0
            existing = conn.execute("SELECT COUNT(*) FROM inventory_snapshots").fetchone()[0]
            missing_delta_candidates = self._missing_inventory_ledger_delta_candidates(conn)
            if (
                existing
                and stored_version >= INVENTORY_SCHEMA_VERSION
                and stored_ledger_version >= INVENTORY_LEDGER_SCHEMA_VERSION
                and missing_delta_candidates == 0
            ):
                return {"snapshots": 0, "items": 0, "deltas": 0}
            rows = conn.execute(
                """
                SELECT id, chat_id, msg_id, text, source, date, sender_id,
                       reply_to_msg_id, top_msg_id, mentions_json, sender_is_bot,
                       edited_at, deleted_at, media_kind, media_meta_json
                FROM raw_messages
                WHERE text LIKE '%储物袋%'
                   OR text LIKE '%上架成功%'
                   OR text LIKE '%上架至万宝楼%'
                   OR text LIKE '%赠送了%'
                   OR text LIKE '%归还至你的储物袋%'
                   OR text LIKE '%获得【%'
                   OR text LIKE '%分得【%'
                ORDER BY rowid ASC
                """
            ).fetchall()
        snapshot_count = 0
        item_count = 0
        delta_count = 0
        with self._connect() as conn:
            conn.execute("DELETE FROM inventory_items")
            conn.execute("DELETE FROM inventory_snapshots")
            conn.execute("DELETE FROM inventory_ledger")
            conn.execute("DELETE FROM inventory_current")
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
                before = conn.execute("SELECT COUNT(*) FROM inventory_items").fetchone()[0]
                self._replace_inventory_snapshot(conn, event)
                self._replace_inventory_delta_records(conn, event)
                after = conn.execute("SELECT COUNT(*) FROM inventory_items").fetchone()[0]
                if after > before:
                    snapshot_count += 1
                    item_count += after - before
                delta_count += int(
                    conn.execute(
                        "SELECT COUNT(*) FROM inventory_ledger WHERE raw_message_id=?",
                        (event.id,),
                    ).fetchone()[0]
                    or 0
                )
            conn.execute(
                """
                INSERT INTO settings(key, value_json)
                VALUES(?, ?)
                ON CONFLICT(key) DO UPDATE SET value_json=excluded.value_json
                """,
                ("inventory_schema_version", json.dumps(INVENTORY_SCHEMA_VERSION)),
            )
            conn.execute(
                """
                INSERT INTO settings(key, value_json)
                VALUES(?, ?)
                ON CONFLICT(key) DO UPDATE SET value_json=excluded.value_json
                """,
                ("inventory_ledger_schema_version", json.dumps(INVENTORY_LEDGER_SCHEMA_VERSION)),
            )
        return {"snapshots": snapshot_count, "items": item_count, "deltas": delta_count}

    def _missing_inventory_ledger_delta_candidates(self, conn) -> int:
        sender_ids = self._inventory_owner_sender_ids(conn)
        if not sender_ids:
            return 0
        placeholders = ",".join("?" for _ in sender_ids)
        params = [*sender_ids, *sender_ids]
        row = conn.execute(
            f"""
            SELECT COUNT(*)
            FROM raw_messages rm
            LEFT JOIN raw_messages parent
              ON parent.chat_id=rm.chat_id
             AND parent.msg_id=rm.reply_to_msg_id
            WHERE (
                    rm.text LIKE '%上架至万宝楼%'
                 OR (rm.text LIKE '%从万宝楼下架%' AND rm.text LIKE '%归还至你的储物袋%')
                 OR rm.text LIKE '%赠送了%【%'
                 OR (rm.text LIKE '%因副本未曾开启%' AND rm.text LIKE '%归还至你的储物袋%')
                 OR (
                        (rm.text LIKE '%灵果入腹%'
                         OR rm.text LIKE '%树髓余珍%'
                         OR rm.text LIKE '%稳定分得【%'
                         OR rm.text LIKE '%枝榜机缘%'
                         OR rm.text LIKE '%天降鸿运%')
                    AND (rm.text LIKE '%获得【%' OR rm.text LIKE '%分得【%')
                    )
                )
              AND (
                    parent.sender_id IN ({placeholders})
                 OR (rm.reply_to_msg_id IS NULL AND rm.sender_id IN ({placeholders}))
                )
              AND NOT EXISTS (
                    SELECT 1 FROM inventory_ledger il
                    WHERE il.raw_message_id=rm.id
                )
            """,
            params,
        ).fetchone()
        return int((row or [0])[0] or 0)

    def _inventory_owner_sender_ids(self, conn) -> list[int]:
        sender_ids: set[int] = set()
        for table, key in (("identities", "send_as_id"), ("accounts", "account_id")):
            try:
                rows = conn.execute(f"SELECT payload_json FROM {table}").fetchall()
            except sqlite3.Error:
                continue
            for row in rows:
                try:
                    payload = json.loads(row[0] or "{}")
                    sender_id = int(payload.get(key) or 0)
                except (TypeError, ValueError, json.JSONDecodeError):
                    continue
                if sender_id:
                    sender_ids.add(sender_id)
        return sorted(sender_ids)

    def latest_message_id(self, chat_id: int, topic_id: int = 0) -> int:
        """返回当前消息箱在指定 chat/topic 里已落库的最大 Telegram msg_id。"""
        chat_id = int(chat_id or 0)
        topic_id = int(topic_id or 0)
        if not chat_id:
            return 0
        with self._connect() as conn:
            if topic_id:
                row = conn.execute(
                    """
                    SELECT MAX(msg_id)
                    FROM raw_messages
                    WHERE chat_id=?
                      AND (top_msg_id=? OR reply_to_msg_id=?)
                    """,
                    (chat_id, topic_id, topic_id),
                ).fetchone()
            else:
                row = conn.execute(
                    "SELECT MAX(msg_id) FROM raw_messages WHERE chat_id=?",
                    (chat_id,),
                ).fetchone()
        return int((row or [0])[0] or 0)

    def message_id_gaps(
        self,
        chat_id: int,
        topic_id: int = 0,
        *,
        since_hours: int = 24,
        min_gap_seconds: int = 300,
        min_missing_msg_ids: int = 20,
        limit: int = 8,
    ) -> list[dict]:
        """返回最近一段时间内 msg_id/date 明显断档的区间,供 Telegram history 补采。

        有些漏采窗口消息很多但耗时很短,只用时间阈值会漏掉;所以这里同时
        支持「时间断档」和「msg_id 数量断档」两个触发条件。
        """
        chat_id = int(chat_id or 0)
        topic_id = int(topic_id or 0)
        if not chat_id:
            return []
        cutoff = (datetime.now(timezone.utc) - timedelta(hours=max(1, int(since_hours or 24)))).isoformat()
        params: list = [chat_id, cutoff]
        topic_sql = ""
        if topic_id:
            topic_sql = "AND (top_msg_id=? OR reply_to_msg_id=?)"
            params.extend([topic_id, topic_id])
        params.extend([
            max(0, int(min_gap_seconds or 0)),
            max(1, int(min_missing_msg_ids or 1)),
            max(1, int(limit or 8)),
        ])
        with self._connect() as conn:
            rows = conn.execute(
                f"""
                WITH ordered AS (
                    SELECT
                        msg_id,
                        date,
                        LAG(msg_id) OVER (ORDER BY msg_id) AS prev_msg_id,
                        LAG(date) OVER (ORDER BY msg_id) AS prev_date
                    FROM raw_messages
                    WHERE chat_id=?
                      AND date >= ?
                      {topic_sql}
                )
                SELECT prev_msg_id, msg_id, prev_date, date,
                       CAST((julianday(date) - julianday(prev_date)) * 86400 AS INTEGER) AS gap_seconds,
                       msg_id - prev_msg_id - 1 AS missing_msg_ids
                FROM ordered
                WHERE prev_msg_id IS NOT NULL
                  AND msg_id - prev_msg_id > 1
                  AND (
                    (julianday(date) - julianday(prev_date)) * 86400 >= ?
                    OR msg_id - prev_msg_id - 1 >= ?
                  )
                ORDER BY
                    CASE WHEN msg_id - prev_msg_id - 1 <= 1000 THEN 0 ELSE 1 END ASC,
                    prev_msg_id DESC
                LIMIT ?
                """,
                params,
            ).fetchall()
        return [
            {
                "after_msg_id": int(row[0] or 0),
                "before_msg_id": int(row[1] or 0),
                "after_date": row[2] or "",
                "before_date": row[3] or "",
                "gap_seconds": int(row[4] or 0),
                "missing_msg_ids": int(row[5] or 0),
            }
            for row in rows
        ]

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
            settings = self.get_settings()
        except Exception:
            settings = {}
        try:
            own_aliases = settings.get("own_aliases") or []
        except Exception:
            own_aliases = []
        try:
            filter_version = int(settings.get("message_filter_version") or 0)
        except (TypeError, ValueError):
            filter_version = 0
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
            if (
                classified
                and not stale_mentions
                and filter_version >= CURRENT_MESSAGE_FILTER_VERSION
            ):
                return 0
        return self.reclassify_message_filters()

    def reclassify_configured_leader_messages_if_needed(self) -> int:
        """补会长 sender 规则历史消息,不触发全库过滤重算。"""
        stored_version = self._stored_int_setting("leader_message_filter_version")
        if stored_version >= CURRENT_LEADER_MESSAGE_FILTER_VERSION:
            return 0
        updated = self.reclassify_configured_leader_messages()
        self.save_settings({"leader_message_filter_version": CURRENT_LEADER_MESSAGE_FILTER_VERSION})
        return updated

    def reclassify_configured_leader_messages(self) -> int:
        """只重算配置会长 sender 的历史消息过滤频道。"""
        settings = self.get_settings()
        leader_ids = []
        for item in settings.get("leader_sender_ids") or []:
            try:
                leader_ids.append(int(item))
            except (TypeError, ValueError):
                continue
        leader_ids = sorted(set(leader_ids))
        if not leader_ids:
            self.save_settings({"leader_message_filter_version": CURRENT_LEADER_MESSAGE_FILTER_VERSION})
            return 0
        my_identity_ids = self._collect_my_identities()
        topic_id = self._get_target_topic_id()
        placeholders = ",".join("?" for _ in leader_ids)
        with self._connect() as conn:
            rows = conn.execute(
                f"""
                SELECT pc.rowid, pc.payload_json,
                       rm.id, rm.chat_id, rm.msg_id, rm.text, rm.source, rm.date,
                       rm.sender_id, rm.reply_to_msg_id, rm.top_msg_id,
                       rm.mentions_json, rm.sender_is_bot,
                       rm.edited_at, rm.deleted_at, rm.media_kind, rm.media_meta_json
                FROM parsed_cards pc
                JOIN raw_messages rm ON rm.id = pc.raw_message_id
                WHERE rm.sender_id IN ({placeholders})
                   OR pc.payload_json LIKE '%"本人上号"%'
                ORDER BY pc.rowid ASC
                """,
                leader_ids,
            ).fetchall()
            updates = []
            channel_updates = []
            for row in rows:
                rowid = int(row[0])
                card = ParsedCard.from_api(json.loads(row[1]))
                event = RawMessageEvent(
                    id=row[2],
                    chat_id=int(row[3]),
                    msg_id=int(row[4]),
                    text=row[5] or "",
                    source=row[6] or "",
                    date=row[7] or "",
                    sender_id=row[8],
                    reply_to_msg_id=row[9],
                    top_msg_id=row[10],
                    mentions=tuple(json.loads(row[11] or "[]")),
                    sender_is_bot=bool(row[12]),
                    edited_at=row[13],
                    deleted_at=row[14],
                    media_kind=row[15],
                    media_meta=(json.loads(row[16]) if row[16] else None),
                )
                clean_reply = _clean_reply_to(event, topic_id)
                parent = self._lookup_parent_event(int(event.chat_id), int(clean_reply)) if clean_reply else None
                base_card = replace(
                    card,
                    channels=tuple(
                        channel for channel in card.channels
                        if channel not in {"focus", "leader", "archive"}
                    ),
                    tags=tuple(
                        tag for tag in card.tags
                        if tag not in {
                            "会长",
                            "本人上号",
                            "会长上号",
                            "被@",
                            "归档",
                            "回复我",
                            "回复别人",
                            "提到别人",
                            "我发出",
                        }
                        and not str(tag).startswith("关键词:")
                        and not str(tag).startswith("重点排除:")
                        and not str(tag).startswith("重点静音:")
                    ),
                )
                filtered = enrich_filter_channels(
                    base_card,
                    event,
                    settings,
                    is_game_bot_sender=self._is_game_bot_sender,
                    parent_event=parent,
                    clean_reply_to_msg_id=clean_reply,
                    my_identity_ids=my_identity_ids,
                )
                updated_card = replace(
                    card,
                    channels=filtered.channels,
                    tags=filtered.tags,
                    filter_reasons=filtered.reasons,
                    reply_to_msg_id=clean_reply if card.reply_to_msg_id is None else card.reply_to_msg_id,
                )
                if updated_card.channels != card.channels or updated_card.tags != card.tags:
                    updates.append((
                        updated_card.primary_channel,
                        json.dumps(list(updated_card.channels), ensure_ascii=False),
                        json.dumps(updated_card.to_api(), ensure_ascii=False),
                        rowid,
                    ))
                    channel_updates.append((updated_card, event))
            if updates:
                conn.executemany(
                    """
                    UPDATE parsed_cards
                    SET primary_channel=?, channels_json=?, payload_json=?
                    WHERE rowid=?
                    """,
                    updates,
                )
                for updated_card, event in channel_updates:
                    self._replace_card_channel_rows(conn, updated_card, event)
        return len(updates)

    def reclassify_message_filters(self) -> int:
        """只重算 focus/leader/archive 频道和过滤标签,不重跑 parser/状态机。"""
        settings = self.get_settings()
        my_identity_ids = self._collect_my_identities()
        topic_id = self._get_target_topic_id()
        game_bot_ids = {int(x) for x in (settings.get("game_bot_ids") or [])}

        def is_game_bot_sender(sender_id: int | None) -> bool:
            if sender_id is None:
                return False
            try:
                return int(sender_id) in game_bot_ids
            except (TypeError, ValueError):
                return False

        with self._connect() as conn:
            rows = conn.execute(
                """
                SELECT pc.rowid, pc.payload_json,
                       rm.id, rm.chat_id, rm.msg_id, rm.text, rm.source, rm.date,
                       rm.sender_id, rm.reply_to_msg_id, rm.top_msg_id,
                       rm.mentions_json, rm.sender_is_bot,
                       rm.edited_at, rm.deleted_at, rm.media_kind, rm.media_meta_json
                FROM parsed_cards pc
                JOIN raw_messages rm ON rm.id = pc.raw_message_id
                ORDER BY pc.rowid ASC
                """
            ).fetchall()
            prepared_rows = []
            events_by_key: dict[tuple[int, int], RawMessageEvent] = {}
            for row in rows:
                event = RawMessageEvent(
                    id=row[2],
                    chat_id=int(row[3]),
                    msg_id=int(row[4]),
                    text=row[5] or "",
                    source=row[6] or "",
                    date=row[7] or "",
                    sender_id=row[8],
                    reply_to_msg_id=row[9],
                    top_msg_id=row[10],
                    mentions=tuple(json.loads(row[11] or "[]")),
                    sender_is_bot=bool(row[12]),
                    edited_at=row[13],
                    deleted_at=row[14],
                    media_kind=row[15],
                    media_meta=(json.loads(row[16]) if row[16] else None),
                )
                prepared_rows.append((int(row[0]), row[1], event))
                if event.chat_id and event.msg_id:
                    events_by_key[(int(event.chat_id), int(event.msg_id))] = event
            updates = []
            channel_updates = []
            for rowid, payload_json, event in prepared_rows:
                card = ParsedCard.from_api(json.loads(payload_json))
                clean_reply = _clean_reply_to(event, topic_id)
                parent = (
                    events_by_key.get((int(event.chat_id), int(clean_reply)))
                    if clean_reply
                    else None
                )
                base_card = replace(
                    card,
                    channels=tuple(
                        channel for channel in card.channels
                        if channel not in {"focus", "leader", "archive"}
                    ),
                    tags=tuple(
                        tag for tag in card.tags
                        if tag not in {
                            "会长",
                            "本人上号",
                            "会长上号",
                            "被@",
                            "归档",
                            "回复我",
                            "回复别人",
                            "提到别人",
                            "我发出",
                        }
                        and not str(tag).startswith("关键词:")
                        and not str(tag).startswith("重点排除:")
                        and not str(tag).startswith("重点静音:")
                    ),
                )
                filtered = enrich_filter_channels(
                    base_card,
                    event,
                    settings,
                    is_game_bot_sender=is_game_bot_sender,
                    parent_event=parent,
                    clean_reply_to_msg_id=clean_reply,
                    my_identity_ids=my_identity_ids,
                )
                updated_card = replace(
                    card,
                    channels=filtered.channels,
                    tags=filtered.tags,
                    filter_reasons=filtered.reasons,
                    reply_to_msg_id=clean_reply if card.reply_to_msg_id is None else card.reply_to_msg_id,
                )
                if updated_card.channels != card.channels or updated_card.tags != card.tags:
                    updates.append((
                        updated_card.primary_channel,
                        json.dumps(list(updated_card.channels), ensure_ascii=False),
                        json.dumps(updated_card.to_api(), ensure_ascii=False),
                        rowid,
                    ))
                    channel_updates.append((updated_card, event))
            if updates:
                conn.executemany(
                    """
                    UPDATE parsed_cards
                    SET primary_channel=?, channels_json=?, payload_json=?
                    WHERE rowid=?
                    """,
                    updates,
                )
                for updated_card, event in channel_updates:
                    self._replace_card_channel_rows(conn, updated_card, event)
        self.save_settings({"message_filter_version": CURRENT_MESSAGE_FILTER_VERSION})
        return len(updates)

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
        event = self._coalesce_event_identity(event)
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
            card_ids = [str(card.id) for card in cards]
            if card_ids:
                placeholders = ",".join("?" for _ in card_ids)
                conn.execute(
                    f"DELETE FROM parsed_cards WHERE raw_message_id=? AND id NOT IN ({placeholders})",
                    (event.id, *card_ids),
                )
            else:
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
                self._replace_card_channel_rows(conn, card, event)
            resource_deltas = tuple(output.resource_deltas)
            resource_events = tuple(output.resource_events)
            if resource_deltas or resource_events or self._has_resource_records(conn, event.id):
                self._replace_resource_records(
                    conn,
                    event,
                    resource_deltas,
                    resource_events,
                )
            self._replace_inventory_snapshot(conn, event)
            self._replace_inventory_delta_records(conn, event)
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
        # 发送链路和 listener 可能并发写库:bot 回复有时先入库,父级 outgoing
        # 消息稍后才由 event_sink 写入。父消息补齐后,要把直接回复它的卡片
        # 重新分流,否则「bot 回复我」会停留在 archive,首页重点流看不到。
        self._reclassify_direct_reply_children(event)
        return cards

    def _replace_card_channel_rows(self, conn, card: ParsedCard, event: RawMessageEvent) -> None:
        row = conn.execute("SELECT rowid FROM parsed_cards WHERE id=?", (card.id,)).fetchone()
        if row is None:
            return
        card_rowid = int(row[0] or 0)
        channels: list[str] = []
        seen: set[str] = set()
        for channel in (ALL_CHANNEL_INDEX_KEY, *tuple(card.channels or ())):
            channel = str(channel or "").strip()
            if not channel or channel in seen:
                continue
            seen.add(channel)
            channels.append(channel)
        conn.execute("DELETE FROM parsed_card_channels WHERE card_id=?", (card.id,))
        conn.executemany(
            """
            INSERT OR REPLACE INTO parsed_card_channels(
                card_id, channel, card_rowid, raw_message_id, sort_date, msg_id
            )
            VALUES(?, ?, ?, ?, ?, ?)
            """,
            [
                (
                    str(card.id),
                    channel,
                    card_rowid,
                    str(event.id),
                    str(event.date or ""),
                    int(event.msg_id or 0),
                )
                for channel in channels
            ],
        )

    def _coalesce_event_identity(self, event: RawMessageEvent) -> RawMessageEvent:
        """按 Telegram 事实键合并同一条消息的不同本地 id。

        历史版本里 miniweb 主动发送的 outgoing 可能带过额外后缀,而 listener
        回调又会用 canonical `tg:{chat}:{msg}` 入库。同一个 chat/msg 如果落两
        行,资源统计和回复链都会重复。这里在 parser 之前把新事件改写到已存在
        的 raw id 上,让后续 ON CONFLICT(id) 走更新而不是新增。
        """
        if not event.chat_id or not event.msg_id:
            return event
        canonical_id = f"tg:{int(event.chat_id)}:{int(event.msg_id)}"
        try:
            with self._connect() as conn:
                row = conn.execute(
                    """
                    SELECT id
                    FROM raw_messages
                    WHERE chat_id=? AND msg_id=?
                    ORDER BY
                        CASE
                            WHEN id=? THEN 0
                            WHEN id=? THEN 1
                            ELSE 2
                        END,
                        rowid DESC
                    LIMIT 1
                    """,
                    (int(event.chat_id), int(event.msg_id), str(event.id), canonical_id),
                ).fetchone()
        except Exception:
            return event
        if not row or not row[0] or str(row[0]) == str(event.id):
            return event
        return replace(event, id=str(row[0]))

    def _replace_resource_records(
        self,
        conn,
        event: RawMessageEvent,
        deltas: Iterable[ResourceDelta],
        events: Iterable[ResourceEvent],
    ) -> None:
        deltas, events = self._enrich_resource_records_from_parent(conn, event, deltas, events)
        conn.execute("DELETE FROM resource_events WHERE raw_message_id=?", (event.id,))
        self._replace_resource_deltas(conn, event, deltas)
        for resource_event in events:
            event_time = resource_event.event_time or event.date or utc_now_iso()
            day_key, week_key, month_key = _resource_period_keys(event_time)
            conn.execute(
                """
                INSERT INTO resource_events(
                    raw_message_id, source_type, source_name, player,
                    result, outcome, event_time, day_key, week_key, month_key,
                    chat_id, msg_id, meta_json
                )
                VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    resource_event.raw_message_id or event.id,
                    resource_event.source_type,
                    resource_event.source_name,
                    resource_event.player,
                    resource_event.result,
                    resource_event.outcome,
                    event_time,
                    day_key,
                    week_key,
                    month_key,
                    int(resource_event.chat_id or event.chat_id or 0),
                    int(resource_event.msg_id or event.msg_id or 0),
                    json.dumps(resource_event.meta or {}, ensure_ascii=False),
                ),
            )

    def _has_resource_records(self, conn, raw_message_id: str) -> bool:
        if not raw_message_id:
            return False
        for table in ("resource_events", "resource_deltas"):
            row = conn.execute(
                f"SELECT 1 FROM {table} WHERE raw_message_id=? LIMIT 1",
                (raw_message_id,),
            ).fetchone()
            if row:
                return True
        return False

    def _enrich_resource_records_from_parent(
        self,
        conn,
        event: RawMessageEvent,
        deltas: Iterable[ResourceDelta],
        events: Iterable[ResourceEvent],
    ) -> tuple[tuple[ResourceDelta, ...], tuple[ResourceEvent, ...]]:
        deltas_tuple = tuple(deltas)
        events_tuple = tuple(events)
        if not events_tuple:
            return deltas_tuple, events_tuple
        if not any(
            item.source_type == "wild_training" and item.source_name == "野外历练·未知"
            for item in events_tuple
        ):
            return deltas_tuple, events_tuple
        parent_text = self._lookup_parent_text_for_event(conn, event)
        strategy = infer_wild_strategy_from_command(parent_text)
        if not strategy:
            return deltas_tuple, events_tuple
        source_name = f"野外历练·{strategy}"

        def patch_meta(meta: dict) -> dict:
            return dict(meta or {}) | {"strategy": strategy, "strategy_source": "reply_parent"}

        return (
            tuple(
                replace(delta, source_name=source_name, meta=patch_meta(delta.meta))
                if delta.source_type == "wild_training" and delta.source_name == "野外历练·未知"
                else delta
                for delta in deltas_tuple
            ),
            tuple(
                replace(resource_event, source_name=source_name, meta=patch_meta(resource_event.meta))
                if resource_event.source_type == "wild_training"
                and resource_event.source_name == "野外历练·未知"
                else resource_event
                for resource_event in events_tuple
            ),
        )

    def _lookup_parent_text_for_event(self, conn, event: RawMessageEvent) -> str:
        if not event.reply_to_msg_id:
            return ""
        row = conn.execute(
            """
            SELECT text
            FROM raw_messages
            WHERE chat_id=? AND msg_id=?
            LIMIT 1
            """,
            (int(event.chat_id or 0), int(event.reply_to_msg_id or 0)),
        ).fetchone()
        return str(row[0] or "") if row else ""

    def _replace_resource_deltas(self, conn, event: RawMessageEvent, deltas: Iterable[ResourceDelta]) -> None:
        conn.execute("DELETE FROM resource_deltas WHERE raw_message_id=?", (event.id,))
        for delta in deltas:
            event_time = delta.event_time or event.date or utc_now_iso()
            day_key, week_key, month_key = _resource_period_keys(event_time)
            conn.execute(
                """
                INSERT INTO resource_deltas(
                    raw_message_id, source_type, source_name, player,
                    resource_name, amount, unit, basis, event_time,
                    day_key, week_key, month_key, chat_id, msg_id, meta_json
                )
                VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    delta.raw_message_id or event.id,
                    delta.source_type,
                    delta.source_name,
                    delta.player,
                    delta.resource_name,
                    int(delta.amount),
                    delta.unit,
                    delta.basis,
                    event_time,
                    day_key,
                    week_key,
                    month_key,
                    int(delta.chat_id or event.chat_id or 0),
                    int(delta.msg_id or event.msg_id or 0),
                    json.dumps(delta.meta or {}, ensure_ascii=False),
                ),
            )

    def _replace_inventory_snapshot(self, conn, event: RawMessageEvent) -> None:
        snapshot = parse_inventory_snapshot(event)
        if snapshot is None and not self._has_inventory_snapshot(conn, event.id):
            return
        existing = conn.execute(
            "SELECT id FROM inventory_snapshots WHERE raw_message_id=?",
            (event.id,),
        ).fetchall()
        for row in existing:
            conn.execute("DELETE FROM inventory_items WHERE snapshot_id=?", (int(row[0]),))
        conn.execute("DELETE FROM inventory_snapshots WHERE raw_message_id=?", (event.id,))

        if snapshot is None:
            return
        items = list(snapshot.get("items") or [])
        if not items:
            return
        total_amount = sum(int(item.get("amount") or 0) for item in items)
        owner = str(snapshot.get("owner") or "")
        cur = conn.execute(
            """
            INSERT INTO inventory_snapshots(
                owner, raw_message_id, source, event_time, chat_id, msg_id,
                item_count, total_amount, created_at
            )
            VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                owner,
                event.id,
                str(snapshot.get("source") or event.source or ""),
                str(snapshot.get("event_time") or event.date or utc_now_iso()),
                int(snapshot.get("chat_id") or event.chat_id or 0),
                int(snapshot.get("msg_id") or event.msg_id or 0),
                len(items),
                total_amount,
                utc_now_iso(),
            ),
        )
        snapshot_id = int(cur.lastrowid)
        for item in items:
            conn.execute(
                """
                INSERT INTO inventory_items(
                    snapshot_id, owner, section, item_name, amount, extra,
                    event_time, raw_message_id
                )
                VALUES(?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    snapshot_id,
                    owner,
                    str(item.get("section") or ""),
                    str(item.get("name") or ""),
                    int(item.get("amount") or 0),
                    str(item.get("extra") or ""),
                    str(snapshot.get("event_time") or event.date or utc_now_iso()),
                    event.id,
                ),
            )
        self._reset_inventory_current_from_snapshot(conn, owner, event, items)

    def _reset_inventory_current_from_snapshot(
        self,
        conn,
        owner: str,
        event: RawMessageEvent,
        items: Iterable[dict],
    ) -> None:
        owner = str(owner or "").strip().lstrip("@")
        if not owner:
            return
        now = utc_now_iso()
        event_time = event.date or now
        conn.execute("DELETE FROM inventory_current WHERE LOWER(owner)=LOWER(?)", (owner,))
        for item in items:
            name = str(item.get("name") or "").strip()
            amount = int(item.get("amount") or 0)
            if not name or amount <= 0:
                continue
            conn.execute(
                """
                INSERT INTO inventory_current(
                    owner, section, item_name, amount, extra, confidence,
                    basis, last_snapshot_message_id, last_delta_message_id,
                    event_time, updated_at
                )
                VALUES(?, ?, ?, ?, ?, 'snapshot', 'snapshot', ?, '', ?, ?)
                ON CONFLICT(owner, item_name, extra) DO UPDATE SET
                    section=excluded.section,
                    amount=excluded.amount,
                    confidence=excluded.confidence,
                    basis=excluded.basis,
                    last_snapshot_message_id=excluded.last_snapshot_message_id,
                    event_time=excluded.event_time,
                    updated_at=excluded.updated_at
                """,
                (
                    owner,
                    str(item.get("section") or ""),
                    name,
                    amount,
                    str(item.get("extra") or ""),
                    event.id,
                    event_time,
                    now,
                ),
            )
        self._replay_inventory_ledger_after_snapshot(conn, owner, event.id, event_time)

    def _replace_inventory_delta_records(self, conn, event: RawMessageEvent) -> None:
        parsed = parse_inventory_delta_event(event)
        if parsed is None and not self._has_inventory_ledger_records(conn, event.id):
            return
        self._rollback_inventory_delta_records(conn, event.id)
        conn.execute("DELETE FROM inventory_ledger WHERE raw_message_id=?", (event.id,))
        if parsed is None:
            return
        owner = self._inventory_owner_for_event(conn, event)
        if not owner:
            return
        now = utc_now_iso()
        event_time = str(parsed.get("event_time") or event.date or now)
        for item_name, delta in (parsed.get("deltas") or {}).items():
            name = str(item_name or "").strip()
            amount_delta = int(delta or 0)
            if not name or amount_delta == 0:
                continue
            conn.execute(
                """
                INSERT INTO inventory_ledger(
                    owner, raw_message_id, source_type, item_name, amount_delta,
                    confidence, event_time, chat_id, msg_id, created_at
                )
                VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    owner,
                    event.id,
                    str(parsed.get("source_type") or "event_delta"),
                    name,
                    amount_delta,
                    str(parsed.get("confidence") or "estimated"),
                    event_time,
                    int(parsed.get("chat_id") or event.chat_id or 0),
                    int(parsed.get("msg_id") or event.msg_id or 0),
                    now,
                ),
            )
            row = conn.execute(
                """
                SELECT amount, section, extra FROM inventory_current
                WHERE LOWER(owner)=LOWER(?) AND item_name=? AND extra=''
                LIMIT 1
                """,
                (owner, name),
            ).fetchone()
            section = str(row[1] or "材料") if row else "材料"
            self._apply_inventory_current_delta(
                conn,
                owner=owner,
                item_name=name,
                amount_delta=amount_delta,
                section=section,
                raw_message_id=event.id,
                event_time=event_time,
                updated_at=now,
            )

    def _inventory_owner_for_event(self, conn, event: RawMessageEvent) -> str:
        sender_id = 0
        if event.reply_to_msg_id:
            parent = self._lookup_parent_event(int(event.chat_id or 0), int(event.reply_to_msg_id or 0))
            if parent and parent.sender_id is not None:
                try:
                    sender_id = int(parent.sender_id)
                except (TypeError, ValueError):
                    sender_id = 0
        if not sender_id and event.sender_id is not None:
            try:
                sender_id = int(event.sender_id)
            except (TypeError, ValueError):
                sender_id = 0
        if not sender_id:
            return ""
        for table, key in (("identities", "send_as_id"), ("accounts", "account_id")):
            try:
                rows = conn.execute(f"SELECT payload_json FROM {table}").fetchall()
            except sqlite3.Error:
                continue
            for row in rows:
                try:
                    payload = json.loads(row[0] or "{}")
                except (TypeError, ValueError, json.JSONDecodeError):
                    continue
                try:
                    if int(payload.get(key) or 0) != sender_id:
                        continue
                except (TypeError, ValueError):
                    continue
                for candidate in (payload.get("username"), payload.get("label"), payload.get("daohao")):
                    owner = str(candidate or "").strip().lstrip("@")
                    if owner:
                        return owner
        return ""

    def _has_inventory_snapshot(self, conn, raw_message_id: str) -> bool:
        if not raw_message_id:
            return False
        return bool(
            conn.execute(
                "SELECT 1 FROM inventory_snapshots WHERE raw_message_id=? LIMIT 1",
                (raw_message_id,),
            ).fetchone()
        )

    def _has_inventory_ledger_records(self, conn, raw_message_id: str) -> bool:
        if not raw_message_id:
            return False
        return bool(
            conn.execute(
                "SELECT 1 FROM inventory_ledger WHERE raw_message_id=? LIMIT 1",
                (raw_message_id,),
            ).fetchone()
        )

    def _replay_inventory_ledger_after_snapshot(
        self,
        conn,
        owner: str,
        snapshot_raw_message_id: str,
        snapshot_event_time: str,
    ) -> None:
        owner = str(owner or "").strip().lstrip("@")
        if not owner:
            return
        snapshot_dt = _parse_message_dt(snapshot_event_time)
        rows = conn.execute(
            """
            SELECT raw_message_id, item_name, amount_delta, event_time
            FROM inventory_ledger
            WHERE LOWER(owner)=LOWER(?)
            ORDER BY event_time ASC, id ASC
            """,
            (owner,),
        ).fetchall()
        now = utc_now_iso()
        for row in rows:
            raw_message_id = str(row[0] or "")
            if raw_message_id == str(snapshot_raw_message_id or ""):
                continue
            ledger_time = str(row[3] or "")
            ledger_dt = _parse_message_dt(ledger_time)
            if snapshot_dt and ledger_dt:
                if ledger_dt <= snapshot_dt:
                    continue
            elif ledger_time <= str(snapshot_event_time or ""):
                continue
            self._apply_inventory_current_delta(
                conn,
                owner=owner,
                item_name=str(row[1] or ""),
                amount_delta=int(row[2] or 0),
                section="材料",
                raw_message_id=raw_message_id,
                event_time=ledger_time,
                updated_at=now,
            )

    def _apply_inventory_current_delta(
        self,
        conn,
        *,
        owner: str,
        item_name: str,
        amount_delta: int,
        section: str = "材料",
        raw_message_id: str = "",
        event_time: str = "",
        updated_at: str = "",
    ) -> None:
        owner = str(owner or "").strip().lstrip("@")
        name = str(item_name or "").strip()
        amount_delta = int(amount_delta or 0)
        if not owner or not name or amount_delta == 0:
            return
        row = conn.execute(
            """
            SELECT amount, section FROM inventory_current
            WHERE LOWER(owner)=LOWER(?) AND item_name=? AND extra=''
            LIMIT 1
            """,
            (owner, name),
        ).fetchone()
        old_amount = int(row[0] or 0) if row else 0
        resolved_section = str(row[1] or section or "材料") if row else str(section or "材料")
        new_amount = max(0, old_amount + amount_delta)
        now = updated_at or utc_now_iso()
        if new_amount > 0:
            conn.execute(
                """
                INSERT INTO inventory_current(
                    owner, section, item_name, amount, extra, confidence,
                    basis, last_snapshot_message_id, last_delta_message_id,
                    event_time, updated_at
                )
                VALUES(?, ?, ?, ?, '', 'estimated', 'ledger_delta', '', ?, ?, ?)
                ON CONFLICT(owner, item_name, extra) DO UPDATE SET
                    section=excluded.section,
                    amount=excluded.amount,
                    confidence=excluded.confidence,
                    basis=excluded.basis,
                    last_delta_message_id=excluded.last_delta_message_id,
                    event_time=excluded.event_time,
                    updated_at=excluded.updated_at
                """,
                (
                    owner,
                    resolved_section,
                    name,
                    new_amount,
                    str(raw_message_id or ""),
                    str(event_time or now),
                    now,
                ),
            )
        else:
            conn.execute(
                """
                DELETE FROM inventory_current
                WHERE LOWER(owner)=LOWER(?) AND item_name=? AND extra=''
                """,
                (owner, name),
            )

    def _rollback_inventory_delta_records(self, conn, raw_message_id: str) -> None:
        rows = conn.execute(
            """
            SELECT owner, item_name, amount_delta
            FROM inventory_ledger
            WHERE raw_message_id=?
            """,
            (raw_message_id,),
        ).fetchall()
        if not rows:
            return
        now = utc_now_iso()
        for row in rows:
            owner = str(row[0] or "")
            name = str(row[1] or "")
            amount_delta = int(row[2] or 0)
            current = conn.execute(
                """
                SELECT amount, section FROM inventory_current
                WHERE LOWER(owner)=LOWER(?) AND item_name=? AND extra=''
                LIMIT 1
                """,
                (owner, name),
            ).fetchone()
            if not current:
                continue
            new_amount = max(0, int(current[0] or 0) - amount_delta)
            if new_amount > 0:
                conn.execute(
                    """
                    UPDATE inventory_current
                    SET amount=?, confidence='estimated', basis='ledger_delta', updated_at=?
                    WHERE LOWER(owner)=LOWER(?) AND item_name=? AND extra=''
                    """,
                    (new_amount, now, owner, name),
                )
            else:
                conn.execute(
                    """
                    DELETE FROM inventory_current
                    WHERE LOWER(owner)=LOWER(?) AND item_name=? AND extra=''
                    """,
                    (owner, name),
                )

    def _reclassify_direct_reply_children(self, parent_event: RawMessageEvent) -> int:
        """父消息落库后,重算直接回复它的卡片过滤频道。

        只处理同 chat 且 reply_to_msg_id == parent.msg_id 的直接子消息,避免每次
        ingest 都全量 reclassify。主要覆盖 miniweb 主动发送后,bot 秒回比
        outgoing event_sink 更早入库的竞态。
        """
        if not parent_event.chat_id or not parent_event.msg_id:
            return 0
        with self._connect() as conn:
            rows = conn.execute(
                """
                SELECT pc.rowid, pc.payload_json,
                       rm.id, rm.chat_id, rm.msg_id, rm.text, rm.source, rm.date,
                       rm.sender_id, rm.reply_to_msg_id, rm.top_msg_id,
                       rm.mentions_json, rm.sender_is_bot,
                       rm.edited_at, rm.deleted_at, rm.media_kind, rm.media_meta_json
                FROM parsed_cards pc
                JOIN raw_messages rm ON rm.id = pc.raw_message_id
                WHERE rm.chat_id=? AND rm.reply_to_msg_id=?
                """,
                (int(parent_event.chat_id), int(parent_event.msg_id)),
            ).fetchall()
            if not rows:
                return 0
            settings = self.get_settings()
            my_identity_ids = self._collect_my_identities()
            topic_id = self._get_target_topic_id()
            updates = []
            channel_updates = []
            for row in rows:
                rowid = int(row[0])
                card = ParsedCard.from_api(json.loads(row[1]))
                event = RawMessageEvent(
                    id=row[2],
                    chat_id=int(row[3]),
                    msg_id=int(row[4]),
                    text=row[5] or "",
                    source=row[6] or "",
                    date=row[7] or "",
                    sender_id=row[8],
                    reply_to_msg_id=row[9],
                    top_msg_id=row[10],
                    mentions=tuple(json.loads(row[11] or "[]")),
                    sender_is_bot=bool(row[12]),
                    edited_at=row[13],
                    deleted_at=row[14],
                    media_kind=row[15],
                    media_meta=(json.loads(row[16]) if row[16] else None),
                )
                clean_reply = _clean_reply_to(event, topic_id)
                parent = None
                if clean_reply:
                    parent = self._lookup_parent_event(int(event.chat_id), int(clean_reply))
                base_card = replace(
                    card,
                    channels=tuple(
                        channel for channel in card.channels
                        if channel not in {"focus", "leader", "archive"}
                    ),
                    tags=tuple(
                        tag for tag in card.tags
                        if tag not in {
                            "会长",
                            "本人上号",
                            "会长上号",
                            "被@",
                            "归档",
                            "回复我",
                            "回复别人",
                            "提到别人",
                            "我发出",
                        }
                        and not str(tag).startswith("关键词:")
                        and not str(tag).startswith("重点排除:")
                    ),
                )
                filtered = enrich_filter_channels(
                    base_card,
                    event,
                    settings,
                    is_game_bot_sender=self._is_game_bot_sender,
                    parent_event=parent,
                    clean_reply_to_msg_id=clean_reply,
                    my_identity_ids=my_identity_ids,
                )
                updated_card = replace(
                    card,
                    channels=filtered.channels,
                    tags=filtered.tags,
                    reply_to_msg_id=clean_reply if card.reply_to_msg_id is None else card.reply_to_msg_id,
                )
                if updated_card.channels != card.channels or updated_card.tags != card.tags:
                    updates.append((
                        updated_card.primary_channel,
                        json.dumps(list(updated_card.channels), ensure_ascii=False),
                        json.dumps(updated_card.to_api(), ensure_ascii=False),
                        rowid,
                    ))
                    channel_updates.append((updated_card, event))
            if updates:
                conn.executemany(
                    """
                    UPDATE parsed_cards
                    SET primary_channel=?, channels_json=?, payload_json=?
                    WHERE rowid=?
                    """,
                    updates,
                )
                for updated_card, event in channel_updates:
                    self._replace_card_channel_rows(conn, updated_card, event)
        return len(updates)

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
        channels: list[str] | tuple[str, ...] | None = None,
    ) -> list[tuple[int, ParsedCard]]:
        """对照 docs/architecture.md 的 inbox 设计:支持游标式增量拉。
        - since_seq:只返 rowid > since_seq 的新卡片(轮询用)
        - before_seq:只返 rowid < before_seq 的旧卡片(日志 modal 往下翻用)
        - limit:封顶,初始化时取最近 200 条避免一次性拉全
        - channel/channels:服务端先过滤,省带宽;channels 为 OR 组合

        rowid 是 SQLite 自动递增的插入序号,新进来的卡片 rowid 一定更大。
        Edit 走 UPSERT,rowid 不变 —— 当前不专门追踪「编辑过的旧卡片是否要重发」,
        前端按 id merge 即可处理。"""
        channel_filters = _normalize_channel_filters(channel, channels)
        indexed_channels = channel_filters or [ALL_CHANNEL_INDEX_KEY]
        if len(indexed_channels) == 1:
            where = ["pcc.channel=?"]
            params: list = [indexed_channels[0]]
            if since_seq > 0:
                where.append("pcc.card_rowid > ?")
                params.append(int(since_seq))
            if before_seq > 0:
                where.append("pcc.card_rowid < ?")
                params.append(int(before_seq))
            order = (
                "ORDER BY pcc.card_rowid ASC"
                if since_seq > 0
                else "ORDER BY pcc.sort_date DESC, pcc.msg_id DESC, pcc.card_rowid DESC"
            )
            limit_clause = ""
            if limit and limit > 0:
                limit_clause = "LIMIT ?"
                params.append(int(limit))
            sql = f"""
                SELECT pcc.card_rowid, pc.payload_json
                FROM parsed_card_channels pcc
                JOIN parsed_cards pc ON pc.id = pcc.card_id
                WHERE {' AND '.join(where)}
                {order}
                {limit_clause}
            """
            with self._connect() as conn:
                rows = conn.execute(sql, params).fetchall()
            result: list[tuple[int, ParsedCard]] = []
            for rowid, payload in rows:
                card = ParsedCard.from_api(json.loads(payload))
                result.append((int(rowid), card))
            return result

        if limit and limit > 0:
            combined: dict[str, tuple[int, str, int, str]] = {}
            per_channel_limit = int(limit)
            with self._connect() as conn:
                for indexed_channel in indexed_channels:
                    where = ["pcc.channel=?"]
                    params: list = [indexed_channel]
                    if since_seq > 0:
                        where.append("pcc.card_rowid > ?")
                        params.append(int(since_seq))
                    if before_seq > 0:
                        where.append("pcc.card_rowid < ?")
                        params.append(int(before_seq))
                    order = (
                        "ORDER BY pcc.card_rowid ASC"
                        if since_seq > 0
                        else "ORDER BY pcc.sort_date DESC, pcc.msg_id DESC, pcc.card_rowid DESC"
                    )
                    params.append(per_channel_limit)
                    rows = conn.execute(
                        f"""
                        SELECT pcc.card_id, pcc.card_rowid, pcc.sort_date, pcc.msg_id, pc.payload_json
                        FROM parsed_card_channels pcc
                        JOIN parsed_cards pc ON pc.id = pcc.card_id
                        WHERE {' AND '.join(where)}
                        {order}
                        LIMIT ?
                        """,
                        params,
                    ).fetchall()
                    for card_id, rowid, sort_date, msg_id, payload in rows:
                        combined[str(card_id)] = (int(rowid or 0), str(sort_date or ""), int(msg_id or 0), payload)
            ordered = sorted(
                combined.values(),
                key=(
                    (lambda item: item[0])
                    if since_seq > 0
                    else (lambda item: (item[1], item[2], item[0]))
                ),
                reverse=since_seq <= 0,
            )[: int(limit)]
            result: list[tuple[int, ParsedCard]] = []
            for rowid, _sort_date, _msg_id, payload in ordered:
                card = ParsedCard.from_api(json.loads(payload))
                result.append((int(rowid), card))
            return result

        channel_placeholders = ",".join("?" for _ in indexed_channels)
        where = []
        params: list = list(indexed_channels)
        where.append(f"channel IN ({channel_placeholders})")
        if since_seq > 0:
            where.append("card_rowid > ?")
            params.append(int(since_seq))
        if before_seq > 0:
            where.append("card_rowid < ?")
            params.append(int(before_seq))
        order = (
            "ORDER BY card_rowid ASC"
            if since_seq > 0
            else "ORDER BY sort_date DESC, msg_id DESC, card_rowid DESC"
        )
        if limit and limit > 0:
            limit_clause = "LIMIT ?"
            params.append(int(limit))
        else:
            limit_clause = ""
        matched_sql = f"""
            SELECT card_id,
                   MIN(card_rowid) AS card_rowid,
                   MAX(sort_date) AS sort_date,
                   MAX(msg_id) AS msg_id
            FROM parsed_card_channels
            WHERE {' AND '.join(where)}
            GROUP BY card_id
            {order}
            {limit_clause}
        """
        outer_order = (
            "ORDER BY matched.card_rowid ASC"
            if since_seq > 0
            else "ORDER BY matched.sort_date DESC, matched.msg_id DESC, matched.card_rowid DESC"
        )
        sql = f"""
            SELECT matched.card_rowid, pc.payload_json
            FROM ({matched_sql}) matched
            JOIN parsed_cards pc ON pc.id = matched.card_id
            {outer_order}
        """
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
        channels: list[str] | tuple[str, ...] | None = None,
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
        channel_filters = _normalize_channel_filters(channel, channels)
        if channel_filters:
            channel_placeholders = ",".join("?" for _ in channel_filters)
            where_parts.append(
                "EXISTS ("
                "SELECT 1 FROM parsed_card_channels pcc "
                "WHERE pcc.card_id = parsed_cards.id "
                f"AND pcc.channel IN ({channel_placeholders})"
                ")"
            )
            params.extend(channel_filters)

        order = (
            "ORDER BY parsed_cards.rowid ASC"
            if since_seq > 0
            else """
            ORDER BY
                CASE WHEN raw_messages.date IS NULL OR raw_messages.date='' THEN 1 ELSE 0 END ASC,
                raw_messages.date DESC,
                raw_messages.msg_id DESC,
                parsed_cards.rowid DESC
            """
        )
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

    def get_card_by_chat_msg(self, chat_id: int, msg_id: int) -> tuple[int, ParsedCard] | None:
        """按 Telegram (chat_id,msg_id) 取卡片。

        UI 回复链只知道 Telegram msg_id,但 mini-web 自己发出的 outgoing
        曾经会把 account_key 追加进 card.id,例如:
        tg:-1001680975844:9023228:447851861646
        这时按 canonical id tg:-1001680975844:9023228 查不到,必须回落到
        raw_messages 的 chat_id/msg_id 索引。
        """
        with self._connect() as conn:
            row = conn.execute(
                """
                SELECT parsed_cards.rowid, parsed_cards.payload_json
                FROM parsed_cards
                JOIN raw_messages ON raw_messages.id = parsed_cards.raw_message_id
                WHERE raw_messages.chat_id=? AND raw_messages.msg_id=?
                ORDER BY parsed_cards.rowid DESC
                LIMIT 1
                """,
                (int(chat_id), int(msg_id)),
            ).fetchone()
        if not row:
            return None
        return int(row[0]), ParsedCard.from_api(json.loads(row[1]))

    def preview_focus_exclude_pattern(self, pattern: str, *, sample_limit: int = 8) -> dict:
        """预览新增 focus_exclude_patterns 后会从重点流移走的普通玩家消息。

        这里按当前过滤器的保护口径近似:
        - 只看当前在 focus 的消息
        - 跳过 bot / 游戏 bot
        - 跳过被@、会长、风险、副本和动作草稿
        """
        item = str(pattern or "").strip()
        if not item:
            return {"ok": False, "error": "规则为空"}
        sample_limit = max(1, min(30, int(sample_limit or 8)))
        game_bot_ids = {int(x) for x in self._collect_game_bot_ids() if x}
        now = datetime.now(timezone.utc)
        cutoff_24h = now - timedelta(hours=24)
        cutoff_7d = now - timedelta(days=7)
        total = 0
        last_24h = 0
        last_7d = 0
        samples: list[dict] = []
        invalid_regex = ""

        with self._connect() as conn:
            rows = conn.execute(
                """
                SELECT pc.rowid, pc.payload_json,
                       rm.text, rm.source, rm.date, rm.sender_id, rm.sender_is_bot, rm.msg_id
                FROM parsed_cards pc
                JOIN raw_messages rm ON rm.id = pc.raw_message_id
                WHERE pc.channels_json LIKE '%"focus"%'
                ORDER BY pc.rowid DESC
                """
            ).fetchall()

        for row in rows:
            card = ParsedCard.from_api(json.loads(row[1]))
            raw_text = str(row[2] or card.raw or "")
            sender_id = _safe_int(row[5])
            bot_like = bool(row[6]) or bool(sender_id and sender_id in game_bot_ids)
            if bot_like:
                continue
            if _is_focus_protected_card(card):
                continue
            try:
                matched = bool(re.search(item, raw_text.strip()))
            except re.error as exc:
                invalid_regex = str(exc)
                matched = item == raw_text.strip()
            if not matched:
                continue

            total += 1
            dt = _parse_message_dt(row[4])
            if dt and dt >= cutoff_7d:
                last_7d += 1
            if dt and dt >= cutoff_24h:
                last_24h += 1
            if len(samples) < sample_limit:
                samples.append(
                    {
                        "seq": int(row[0]),
                        "source": row[3] or "",
                        "sender_id": sender_id,
                        "time": row[4] or "",
                        "msg_id": int(row[7] or 0),
                        "text": raw_text[:240],
                    }
                )

        return {
            "ok": True,
            "pattern": item,
            "invalid_regex": invalid_regex,
            "total": total,
            "last_24h": last_24h,
            "last_7d": last_7d,
            "samples": samples,
        }

    def get_settings(self) -> dict:
        tianjige_env = TianjigeConfig.from_env()
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
            "leader_sender_ids": list(DEFAULT_LEADER_SENDER_IDS),
            "leader_source_names": list(DEFAULT_LEADER_SOURCE_NAMES),
            "focus_muted_sender_ids": [],
            "focus_muted_source_names": [],
            "focus_keywords": list(DEFAULT_FOCUS_KEYWORDS),
            "focus_exclude_patterns": list(DEFAULT_FOCUS_EXCLUDE_PATTERNS),
            "focus_include_player_plain": True,
            "archive_dot_commands": True,
            "archive_bot_replies": True,
            "message_filter_version": CURRENT_MESSAGE_FILTER_VERSION,
            "leader_message_filter_version": CURRENT_LEADER_MESSAGE_FILTER_VERSION,
            "notify_enabled": False,
            "notify_tg_bot_token": "",
            "notify_tg_chat_id": "",
            "notify_card_titles": [],
            "tianjige_mode": tianjige_env.mode,
            "tianjige_base_url": tianjige_env.base_url,
            "tianjige_api_token": "",
            "tianjige_cookie": "",
            "tianjige_timeout_sec": tianjige_env.timeout_sec,
            "tianjige_min_interval_sec": tianjige_env.min_interval_sec,
            "schedule_saved_templates": [],
        }
        with self._connect() as conn:
            rows = conn.execute("SELECT key, value_json FROM settings").fetchall()
        for key, raw_value in rows:
            if key not in defaults:
                continue
            defaults[key] = json.loads(raw_value)
        defaults["own_aliases"] = _merge_str_defaults(
            defaults.get("own_aliases"),
            self._collect_my_aliases(),
        )
        defaults["focus_exclude_patterns"] = _merge_focus_exclude_defaults(
            defaults.get("focus_exclude_patterns"),
        )
        return defaults

    def _stored_int_setting(self, key: str) -> int:
        try:
            with self._connect() as conn:
                row = conn.execute(
                    "SELECT value_json FROM settings WHERE key=?",
                    (str(key),),
                ).fetchone()
        except Exception:
            return 0
        if not row:
            return 0
        try:
            return int(json.loads(row[0]))
        except (TypeError, ValueError, json.JSONDecodeError):
            return 0

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
        leaders = _merge_int_defaults(settings.get("leader_sender_ids"), DEFAULT_LEADER_SENDER_IDS)
        if leaders != list(settings.get("leader_sender_ids") or []):
            patch["leader_sender_ids"] = leaders
        leader_names = _merge_str_defaults(settings.get("leader_source_names"), DEFAULT_LEADER_SOURCE_NAMES)
        if leader_names != list(settings.get("leader_source_names") or []):
            patch["leader_source_names"] = leader_names
        if patch:
            self.save_settings(patch)
        return self.get_settings()

    def list_state_patches(self, scope: str = "", send_as_id: int = 0) -> list[dict]:
        """列出 state patches。
        - scope:可选,空字符串返回全部 scope
        - send_as_id:0 = 不过滤(返回所有身份);非 0 = **严格**只返回该身份的 patch。

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
            if send_as_id != 0:
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

    def save_state_patches(
        self,
        patches: Iterable[dict | StatePatch],
        *,
        send_as_id: int = 0,
        source: str = "external",
        source_text: str = "",
        source_message_id: str = "",
        updated_at: str = "",
    ) -> list[dict]:
        """Persist externally sourced state patches.

        Parser-created patches point at real Telegram raw_messages.  API
        refreshes need the same traceability without pretending to be a bot
        reply, so this method first creates a synthetic raw_messages row and
        then upserts all patches against it.
        """
        rows = list(patches or [])
        if not rows:
            return []
        sid = int(send_as_id or 0)
        if sid == 0:
            return []
        source = str(source or "external").strip() or "external"
        now_iso = str(updated_at or utc_now_iso())
        raw_id = str(source_message_id or f"{source}:{uuid.uuid4().hex}")
        text = str(source_text or f"{source} state refresh").strip()
        saved: list[StatePatch] = []
        with self._connect() as conn:
            conn.execute(
                """
                INSERT INTO raw_messages(
                    id, chat_id, msg_id, text, source, date, sender_id,
                    reply_to_msg_id, top_msg_id, mentions_json, sender_is_bot
                )
                VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(id) DO UPDATE SET
                    text=excluded.text,
                    source=excluded.source,
                    date=excluded.date
                """,
                (
                    raw_id,
                    0,
                    0,
                    text,
                    source,
                    now_iso,
                    0,
                    None,
                    None,
                    json.dumps([], ensure_ascii=False),
                    0,
                ),
            )
            for item in rows:
                if isinstance(item, StatePatch):
                    patch = item
                    scope = patch.scope
                    key = patch.key
                    value = patch.value
                else:
                    scope = str((item or {}).get("scope") or "")
                    key = str((item or {}).get("key") or "")
                    value = (item or {}).get("value")
                if not scope or not key:
                    continue
                saved_patch = StatePatch(
                    scope=scope,
                    send_as_id=sid,
                    key=key,
                    value=value,
                    source_message_id=raw_id,
                    updated_at=now_iso,
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
                        saved_patch.scope,
                        saved_patch.send_as_id,
                        saved_patch.key,
                        json.dumps(saved_patch.value, ensure_ascii=False),
                        saved_patch.source_message_id,
                        saved_patch.updated_at,
                    ),
                )
                saved.append(saved_patch)
        return [patch.to_api() for patch in saved]

    def list_resource_deltas(self, raw_message_id: str = "") -> list[dict]:
        where = []
        params: list = []
        if raw_message_id:
            where.append("raw_message_id=?")
            params.append(str(raw_message_id))
        where_sql = ("WHERE " + " AND ".join(where)) if where else ""
        with self._connect() as conn:
            rows = conn.execute(
                f"""
                SELECT raw_message_id, source_type, source_name, player,
                       resource_name, amount, unit, basis, event_time,
                       day_key, week_key, month_key, chat_id, msg_id, meta_json
                FROM resource_deltas
                {where_sql}
                ORDER BY event_time DESC, id DESC
                """,
                params,
            ).fetchall()
        return [_resource_delta_row_to_api(row) for row in rows]

    def list_resource_events(self, raw_message_id: str = "") -> list[dict]:
        where = []
        params: list = []
        if raw_message_id:
            where.append("raw_message_id=?")
            params.append(str(raw_message_id))
        where_sql = ("WHERE " + " AND ".join(where)) if where else ""
        with self._connect() as conn:
            rows = conn.execute(
                f"""
                SELECT raw_message_id, source_type, source_name, player,
                       result, outcome, event_time, day_key, week_key, month_key,
                       chat_id, msg_id, meta_json
                FROM resource_events
                {where_sql}
                ORDER BY event_time DESC, id DESC
                """,
                params,
            ).fetchall()
        return [_resource_event_row_to_api(row) for row in rows]

    def list_inventory_snapshots(
        self,
        *,
        owner: str = "",
        owners: Iterable[str] | None = None,
        latest_only: bool = True,
        include_items: bool = True,
        limit: int = 80,
    ) -> list[dict]:
        owner = str(owner or "").strip().lstrip("@")
        try:
            limit = int(limit or 80)
        except (TypeError, ValueError):
            limit = 80
        limit = max(1, min(limit, 300))
        params: list = []
        where = []
        if owner:
            where.append("LOWER(owner)=LOWER(?)")
            params.append(owner)
        elif owners is not None:
            owner_list = []
            seen_owner_keys: set[str] = set()
            for item in owners:
                normalized = str(item or "").strip().lstrip("@")
                if not normalized:
                    continue
                key = normalized.lower()
                if key in seen_owner_keys:
                    continue
                seen_owner_keys.add(key)
                owner_list.append(normalized)
            if not owner_list:
                return []
            placeholders = ",".join("?" for _ in owner_list)
            where.append(f"LOWER(owner) IN ({placeholders})")
            params.extend(item.lower() for item in owner_list)
        where_sql = ("WHERE " + " AND ".join(where)) if where else ""
        if latest_only:
            sql = f"""
                WITH ranked AS (
                    SELECT *,
                           ROW_NUMBER() OVER (
                               PARTITION BY LOWER(owner)
                               ORDER BY event_time DESC, id DESC
                           ) AS rn
                    FROM inventory_snapshots
                    {where_sql}
                )
                SELECT id, owner, raw_message_id, source, event_time, chat_id, msg_id,
                       item_count, total_amount, created_at
                FROM ranked
                WHERE rn=1
                ORDER BY event_time DESC, id DESC
                LIMIT ?
            """
        else:
            sql = f"""
                SELECT id, owner, raw_message_id, source, event_time, chat_id, msg_id,
                       item_count, total_amount, created_at
                FROM inventory_snapshots
                {where_sql}
                ORDER BY event_time DESC, id DESC
                LIMIT ?
            """
        params.append(limit)
        with self._connect() as conn:
            rows = conn.execute(sql, params).fetchall()
            snapshots = [_inventory_snapshot_row_to_api(row) for row in rows]
            if not include_items:
                for snapshot in snapshots:
                    snapshot.pop("items", None)
            if include_items and snapshots:
                ids = [int(item["id"]) for item in snapshots]
                placeholders = ",".join("?" for _ in ids)
                item_rows = conn.execute(
                    f"""
                    SELECT snapshot_id, owner, section, item_name, amount, extra,
                           event_time, raw_message_id
                    FROM inventory_items
                    WHERE snapshot_id IN ({placeholders})
                    ORDER BY section ASC, item_name ASC, extra ASC
                    """,
                    ids,
                ).fetchall()
                grouped: dict[int, list[dict]] = {}
                for row in item_rows:
                    grouped.setdefault(int(row[0]), []).append(_inventory_item_row_to_api(row))
                for snapshot in snapshots:
                    snapshot["items"] = grouped.get(int(snapshot["id"]), [])
        return snapshots

    def list_inventory_current(
        self,
        *,
        owner: str = "",
        owners: Iterable[str] | None = None,
        limit: int = 500,
    ) -> list[dict]:
        owner = str(owner or "").strip().lstrip("@")
        try:
            limit = int(limit or 500)
        except (TypeError, ValueError):
            limit = 500
        limit = max(1, min(limit, 2000))
        params: list = []
        where = []
        if owner:
            where.append("LOWER(owner)=LOWER(?)")
            params.append(owner)
        elif owners is not None:
            owner_list: list[str] = []
            seen: set[str] = set()
            for item in owners:
                normalized = str(item or "").strip().lstrip("@")
                if not normalized:
                    continue
                key = normalized.lower()
                if key in seen:
                    continue
                seen.add(key)
                owner_list.append(normalized)
            if not owner_list:
                return []
            placeholders = ",".join("?" for _ in owner_list)
            where.append(f"LOWER(owner) IN ({placeholders})")
            params.extend(item.lower() for item in owner_list)
        where_sql = ("WHERE " + " AND ".join(where)) if where else ""
        params.append(limit)
        with self._connect() as conn:
            rows = conn.execute(
                f"""
                SELECT owner, section, item_name, amount, extra, confidence, basis,
                       last_snapshot_message_id, last_delta_message_id, event_time, updated_at
                FROM inventory_current
                {where_sql}
                ORDER BY owner ASC, section ASC, item_name ASC, extra ASC
                LIMIT ?
                """,
                params,
            ).fetchall()
        return [
            {
                "owner": row[0] or "",
                "section": row[1] or "",
                "name": row[2] or "",
                "amount": int(row[3] or 0),
                "extra": row[4] or "",
                "confidence": row[5] or "snapshot",
                "basis": row[6] or "snapshot",
                "last_snapshot_message_id": row[7] or "",
                "last_delta_message_id": row[8] or "",
                "event_time": row[9] or "",
                "updated_at": row[10] or "",
            }
            for row in rows
        ]

    def resource_stats(
        self,
        *,
        period: str = "day",
        source_type: str = "",
        source_name: str = "",
        limit: int = 120,
    ) -> dict:
        period = str(period or "day").strip().lower()
        period_col = {
            "day": "day_key",
            "week": "week_key",
            "month": "month_key",
        }.get(period, "day_key")
        period = {"day_key": "day", "week_key": "week", "month_key": "month"}[period_col]
        try:
            limit = int(limit or 120)
        except (TypeError, ValueError):
            limit = 120
        limit = max(1, min(limit, 500))
        where = []
        params: list = []
        source_type = str(source_type or "").strip()
        if source_type and source_type != "all":
            where.append("source_type=?")
            params.append(source_type)
        source_name = str(source_name or "").strip()
        if source_name:
            where.append("source_name=?")
            params.append(source_name)
        where_sql = ("WHERE " + " AND ".join(where)) if where else ""
        basic_placeholders = ",".join("?" for _ in RESOURCE_BASIC_NAMES)
        rare_placeholders = ",".join("?" for _ in RESOURCE_RARE_NAMES)
        category_params = list(RESOURCE_BASIC_NAMES) + list(RESOURCE_RARE_NAMES)
        event_params = list(params)
        event_params.append(limit)
        delta_params = category_params + list(params)
        delta_params.append(limit)
        with self._connect() as conn:
            event_rows = conn.execute(
                f"""
                SELECT {period_col} AS period_key, source_type, source_name,
                       result, outcome, COUNT(*) AS event_count,
                       MIN(event_time), MAX(event_time)
                FROM resource_events
                {where_sql}
                GROUP BY {period_col}, source_type, source_name, result, outcome
                ORDER BY {period_col} DESC, source_type ASC, source_name ASC, result ASC, outcome ASC
                LIMIT ?
                """,
                event_params,
            ).fetchall()
            rows = conn.execute(
                f"""
                SELECT {period_col} AS period_key, source_type, source_name,
                       resource_name, unit, basis,
                       CASE WHEN amount < 0 THEN 'loss' ELSE 'gain' END AS amount_kind,
                       CASE
                           WHEN resource_name IN ({basic_placeholders}) THEN 'basic'
                           WHEN resource_name IN ({rare_placeholders}) THEN 'rare'
                           ELSE 'common'
                       END AS resource_category,
                       SUM(amount) AS total_amount,
                       COUNT(DISTINCT raw_message_id) AS event_count, MIN(event_time), MAX(event_time)
                FROM resource_deltas
                {where_sql}
                GROUP BY {period_col}, source_type, source_name, resource_name, unit, basis,
                         amount_kind, resource_category
                ORDER BY {period_col} DESC, source_type ASC, source_name ASC,
                         resource_category DESC, amount_kind ASC, ABS(SUM(amount)) DESC, resource_name ASC
                LIMIT ?
                """,
                delta_params,
            ).fetchall()
        events = [
            {
                "period": row[0],
                "source_type": row[1],
                "source_name": row[2],
                "result": row[3],
                "outcome": row[4],
                "event_count": int(row[5] or 0),
                "first_event_time": row[6],
                "last_event_time": row[7],
            }
            for row in event_rows
        ]
        return {
            "ok": True,
            "period": period,
            "source_type": source_type or "all",
            "source_name": source_name,
            "events": events,
            "event_summary": _resource_event_summary(events),
            "diagnostics": _resource_event_diagnostics(events),
            "rows": [
                {
                    "period": row[0],
                    "source_type": row[1],
                    "source_name": row[2],
                    "resource_name": row[3],
                    "unit": row[4],
                    "basis": row[5],
                    "amount_kind": row[6],
                    "resource_category": row[7],
                    "total_amount": int(row[8] or 0),
                    "event_count": int(row[9] or 0),
                    "first_event_time": row[10],
                    "last_event_time": row[11],
                }
                for row in rows
            ],
            "notes": [
                "野外历练单独统计成功、失败和冷却;资源成果按正收益/负收益分开,不做净额抵消。",
                "副本结算按具体副本/入口分开统计,按单次结算文案记录,不按队伍人数放大。",
                "风希单独统计逆天之举收益,含限时增益出现次数。",
                "极阴、南陇侯单独统计抉择结算;灵树采摘只统计明确结算文案。",
                "血色试炼结算已排除。",
            ],
        }

    def list_discovered_bots(self, *, scan_limit: int = 10000) -> list[dict]:
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

        try:
            scan_limit = max(500, min(50000, int(scan_limit or 10000)))
        except (TypeError, ValueError):
            scan_limit = 10000
        with self._connect() as conn:
            rows = conn.execute(
                """
                SELECT sender_id, text, source, date, sender_is_bot
                FROM raw_messages
                WHERE sender_id IS NOT NULL
                  AND (sender_is_bot=1 OR sender_id < 0)
                ORDER BY rowid DESC
                LIMIT ?
                """,
                (scan_limit,),
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
        self._runtime_cache_clear("game_bot_ids", "target_topic_id")
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
        self._runtime_cache_clear("my_identities")
        return normalized

    def delete_account(self, local_id: str) -> bool:
        local_id = safe_session_name(local_id, fallback="")
        if not local_id:
            return False
        with self._connect() as conn:
            cursor = conn.execute("DELETE FROM accounts WHERE local_id=?", (local_id,))
            deleted = cursor.rowcount > 0
        if deleted:
            self._runtime_cache_clear("my_identities")
        return deleted

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
        self._runtime_cache_clear("my_identities")
        return normalized

    def delete_identity(self, send_as_id: int | str) -> bool:
        send_as_id = _coerce_non_zero_int(send_as_id)
        if send_as_id == 0:
            return False
        with self._connect() as conn:
            cursor = conn.execute("DELETE FROM identities WHERE send_as_id=?", (send_as_id,))
            deleted = cursor.rowcount > 0
        if deleted:
            self._runtime_cache_clear("my_identities")
        return deleted

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

    def append_send_log(self, payload: dict) -> dict:
        """Append one outbound audit row.

        send_logs is an append-only audit trail for user-triggered sends and
        official scheduled-message creation attempts. It deliberately lives in
        the repo layer so senders can stay focused on Telegram I/O.
        """
        row = _normalize_send_log(payload)
        with self._connect() as conn:
            cur = conn.execute(
                """
                INSERT INTO send_logs(
                    kind, status, account_local_id, identity_id, send_as_id,
                    chat_id, topic_id, reply_to_msg_id, command,
                    source_message_id, tg_msg_id, scheduled_msg_id,
                    batch_id, schedule_message_id, error, created_at, meta_json
                )
                VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    row["kind"],
                    row["status"],
                    row["account_local_id"],
                    row["identity_id"],
                    row["send_as_id"],
                    row["chat_id"],
                    row["topic_id"],
                    row["reply_to_msg_id"],
                    row["command"],
                    row["source_message_id"],
                    row["tg_msg_id"],
                    row["scheduled_msg_id"],
                    row["batch_id"],
                    row["schedule_message_id"],
                    row["error"],
                    row["created_at"],
                    json.dumps(row["meta"], ensure_ascii=False, sort_keys=True),
                ),
            )
            row["id"] = int(cur.lastrowid)
        return row

    def list_send_logs(
        self,
        *,
        limit: int = 100,
        kind: str = "",
        status: str = "",
        identity_id: int = 0,
        batch_id: int = 0,
    ) -> list[dict]:
        try:
            limit = int(limit or 100)
        except (TypeError, ValueError):
            limit = 100
        limit = max(1, min(limit, 500))
        where = []
        params: list = []
        kind = str(kind or "").strip()
        if kind:
            where.append("kind=?")
            params.append(kind)
        status = str(status or "").strip()
        if status:
            where.append("status=?")
            params.append(status)
        try:
            identity_id = int(identity_id or 0)
        except (TypeError, ValueError):
            identity_id = 0
        if identity_id:
            where.append("identity_id=?")
            params.append(identity_id)
        try:
            batch_id = int(batch_id or 0)
        except (TypeError, ValueError):
            batch_id = 0
        if batch_id:
            where.append("batch_id=?")
            params.append(batch_id)
        where_sql = ("WHERE " + " AND ".join(where)) if where else ""
        params.append(limit)
        with self._connect() as conn:
            rows = conn.execute(
                f"""
                SELECT id, kind, status, account_local_id, identity_id, send_as_id,
                       chat_id, topic_id, reply_to_msg_id, command,
                       source_message_id, tg_msg_id, scheduled_msg_id,
                       batch_id, schedule_message_id, error, created_at, meta_json
                FROM send_logs
                {where_sql}
                ORDER BY id DESC
                LIMIT ?
                """,
                params,
            ).fetchall()
        return [_send_log_row_to_api(row) for row in rows]

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

    def mark_schedule_message(self, message_id: int, *, scheduled_msg_id: int | None = None, status: str = "", last_error: str = "", schedule_at: float = -1.0) -> None:
        import time
        sets = ["updated_at=?"]
        params: list = [time.time()]
        if scheduled_msg_id is not None:
            sets.append("scheduled_msg_id=?")
            params.append(int(scheduled_msg_id))
        if status:
            sets.append("status=?")
            params.append(str(status))
        if last_error is not None:
            sets.append("last_error=?")
            params.append(str(last_error))
        if schedule_at is not None and schedule_at >= 0:
            sets.append("schedule_at=?")
            params.append(float(schedule_at))
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

    def update_schedule_batch_options(self, batch_id: int, patch: dict) -> dict:
        """Patch official_schedule_batches.options_json and return the updated options."""
        import time
        current = next(
            (b for b in self.list_schedule_batches(include_inactive=True) if int(b.get("id") or 0) == int(batch_id)),
            None,
        )
        if not current:
            return {}
        options = dict(current.get("options") or {})
        options.update(patch or {})
        now = time.time()
        with self._connect() as conn:
            conn.execute(
                "UPDATE official_schedule_batches SET options_json=?, updated_at=? WHERE id=?",
                (json.dumps(options, ensure_ascii=False, sort_keys=True), now, int(batch_id)),
            )
        return options

    def save_schedule_renew_profile(self, payload: dict) -> dict:
        """Create/update an official-schedule renewal profile."""
        now = time.time()
        profile_id = _safe_int((payload or {}).get("id"))
        send_as_id = _safe_int((payload or {}).get("send_as_id"))
        renew_days = max(1, min(3, _safe_int((payload or {}).get("renew_days")) or 1))
        threshold_hours = max(1, min(72, _safe_int((payload or {}).get("threshold_hours")) or 24))
        soft_limit = max(1, min(100, _safe_int((payload or {}).get("soft_limit")) or 95))
        record = {
            "send_as_id": send_as_id,
            "account_local_id": str((payload or {}).get("account_local_id") or ""),
            "preset_key": str((payload or {}).get("preset_key") or ""),
            "module_key": str((payload or {}).get("module_key") or ""),
            "label": str((payload or {}).get("label") or ""),
            "enabled": 1 if (payload or {}).get("enabled", True) else 0,
            "renew_days": renew_days,
            "threshold_hours": threshold_hours,
            "soft_limit": soft_limit,
            "payload_json": json.dumps((payload or {}).get("payload") or {}, ensure_ascii=False, sort_keys=True),
            "covered_until": float((payload or {}).get("covered_until") or 0),
            "last_batch_id": _safe_int((payload or {}).get("last_batch_id")),
            "last_run_at": float((payload or {}).get("last_run_at") or 0),
            "last_error": str((payload or {}).get("last_error") or ""),
        }
        with self._connect() as conn:
            if profile_id:
                current = conn.execute(
                    "SELECT created_at, covered_until, last_batch_id, last_run_at, last_error FROM official_schedule_renew_profiles WHERE id=?",
                    (profile_id,),
                ).fetchone()
                if current is None:
                    raise ValueError("renew profile 不存在")
                if "covered_until" not in (payload or {}):
                    record["covered_until"] = float(current[1] or 0)
                if "last_batch_id" not in (payload or {}):
                    record["last_batch_id"] = int(current[2] or 0)
                if "last_run_at" not in (payload or {}):
                    record["last_run_at"] = float(current[3] or 0)
                if "last_error" not in (payload or {}):
                    record["last_error"] = str(current[4] or "")
                conn.execute(
                    """
                    UPDATE official_schedule_renew_profiles
                    SET send_as_id=?, account_local_id=?, preset_key=?, module_key=?, label=?,
                        enabled=?, renew_days=?, threshold_hours=?, soft_limit=?, payload_json=?,
                        covered_until=?, last_batch_id=?, last_run_at=?, last_error=?, updated_at=?
                    WHERE id=?
                    """,
                    (
                        record["send_as_id"],
                        record["account_local_id"],
                        record["preset_key"],
                        record["module_key"],
                        record["label"],
                        record["enabled"],
                        record["renew_days"],
                        record["threshold_hours"],
                        record["soft_limit"],
                        record["payload_json"],
                        record["covered_until"],
                        record["last_batch_id"],
                        record["last_run_at"],
                        record["last_error"],
                        now,
                        profile_id,
                    ),
                )
            else:
                cur = conn.execute(
                    """
                    INSERT INTO official_schedule_renew_profiles
                        (send_as_id, account_local_id, preset_key, module_key, label,
                         enabled, renew_days, threshold_hours, soft_limit, payload_json,
                         covered_until, last_batch_id, last_run_at, last_error, created_at, updated_at)
                    VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                    """,
                    (
                        record["send_as_id"],
                        record["account_local_id"],
                        record["preset_key"],
                        record["module_key"],
                        record["label"],
                        record["enabled"],
                        record["renew_days"],
                        record["threshold_hours"],
                        record["soft_limit"],
                        record["payload_json"],
                        record["covered_until"],
                        record["last_batch_id"],
                        record["last_run_at"],
                        record["last_error"],
                        now,
                        now,
                    ),
                )
                profile_id = int(cur.lastrowid)
        profile = self.get_schedule_renew_profile(profile_id)
        if not profile:
            raise ValueError("renew profile 保存失败")
        return profile

    def _schedule_renew_profile_row_to_api(self, row) -> dict:
        payload = {}
        try:
            payload = json.loads(row[10] or "{}")
        except (TypeError, ValueError, json.JSONDecodeError):
            payload = {}
        return {
            "id": int(row[0]),
            "send_as_id": int(row[1] or 0),
            "account_local_id": row[2] or "",
            "preset_key": row[3] or "",
            "module_key": row[4] or "",
            "label": row[5] or "",
            "enabled": bool(row[6]),
            "renew_days": int(row[7] or 1),
            "threshold_hours": int(row[8] or 24),
            "soft_limit": int(row[9] or 95),
            "payload": payload,
            "covered_until": float(row[11] or 0),
            "last_batch_id": int(row[12] or 0),
            "last_run_at": float(row[13] or 0),
            "last_error": row[14] or "",
            "created_at": float(row[15] or 0),
            "updated_at": float(row[16] or 0),
        }

    def get_schedule_renew_profile(self, profile_id: int) -> dict | None:
        with self._connect() as conn:
            row = conn.execute(
                """
                SELECT id, send_as_id, account_local_id, preset_key, module_key, label,
                       enabled, renew_days, threshold_hours, soft_limit, payload_json,
                       covered_until, last_batch_id, last_run_at, last_error, created_at, updated_at
                FROM official_schedule_renew_profiles
                WHERE id=?
                """,
                (int(profile_id or 0),),
            ).fetchone()
        return self._schedule_renew_profile_row_to_api(row) if row else None

    def list_schedule_renew_profiles(self, *, enabled_only: bool = False) -> list[dict]:
        sql = """
            SELECT id, send_as_id, account_local_id, preset_key, module_key, label,
                   enabled, renew_days, threshold_hours, soft_limit, payload_json,
                   covered_until, last_batch_id, last_run_at, last_error, created_at, updated_at
            FROM official_schedule_renew_profiles
        """
        if enabled_only:
            sql += " WHERE enabled=1"
        sql += " ORDER BY enabled DESC, updated_at DESC, id DESC"
        with self._connect() as conn:
            rows = conn.execute(sql).fetchall()
        return [self._schedule_renew_profile_row_to_api(row) for row in rows]

    def delete_schedule_renew_profile(self, profile_id: int) -> bool:
        with self._connect() as conn:
            cur = conn.execute(
                "DELETE FROM official_schedule_renew_profiles WHERE id=?",
                (int(profile_id or 0),),
            )
        return cur.rowcount > 0

    def update_schedule_renew_profile_runtime(
        self,
        profile_id: int,
        *,
        covered_until: float | None = None,
        last_batch_id: int | None = None,
        last_run_at: float | None = None,
        last_error: str | None = None,
    ) -> dict | None:
        sets = ["updated_at=?"]
        params: list = [time.time()]
        if covered_until is not None:
            sets.append("covered_until=?")
            params.append(float(covered_until or 0))
        if last_batch_id is not None:
            sets.append("last_batch_id=?")
            params.append(int(last_batch_id or 0))
        if last_run_at is not None:
            sets.append("last_run_at=?")
            params.append(float(last_run_at or 0))
        if last_error is not None:
            sets.append("last_error=?")
            params.append(str(last_error or ""))
        params.append(int(profile_id or 0))
        with self._connect() as conn:
            conn.execute(
                f"UPDATE official_schedule_renew_profiles SET {', '.join(sets)} WHERE id=?",
                params,
            )
        return self.get_schedule_renew_profile(profile_id)

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

    def list_schedule_templates(self) -> list[dict]:
        settings = self.get_settings()
        raw_templates = settings.get("schedule_saved_templates") or []
        templates = []
        for item in raw_templates:
            if not isinstance(item, dict):
                continue
            template_id = str(item.get("id") or "").strip()
            if not template_id:
                continue
            templates.append(
                {
                    "id": template_id,
                    "name": str(item.get("name") or template_id).strip(),
                    "payload": dict(item.get("payload") or {}),
                    "updated_at": float(item.get("updated_at") or 0),
                }
            )
        templates.sort(key=lambda item: (item.get("updated_at") or 0, item.get("name") or ""), reverse=True)
        return templates

    def save_schedule_templates(self, templates: list[dict]) -> list[dict]:
        normalized = _normalize_schedule_saved_templates(templates)
        self.save_settings({"schedule_saved_templates": normalized})
        return self.list_schedule_templates()

    def replace_dungeon_rooms(self, rooms: list[dict]) -> int:
        import time
        now = time.time()
        rows = []
        for room in rooms or []:
            key = str(room.get("key") or "").strip()
            if not key:
                continue
            rows.append(
                (
                    key,
                    str(room.get("dungeon_id") or "").strip(),
                    str(room.get("dungeon_name") or "").strip(),
                    str(room.get("status") or "").strip(),
                    str(room.get("status_kind") or "").strip(),
                    int(room.get("latest_seq") or 0),
                    str(room.get("latest_message_id") or "").strip(),
                    str(room.get("latest_time") or "").strip(),
                    json.dumps(room, ensure_ascii=False),
                    now,
                )
            )
        with self._connect() as conn:
            conn.execute("DELETE FROM dungeon_rooms")
            if rows:
                conn.executemany(
                    """
                    INSERT INTO dungeon_rooms(
                        key, dungeon_id, dungeon_name, status, status_kind,
                        latest_seq, latest_message_id, latest_time, payload_json, updated_at
                    )
                    VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                    """,
                    rows,
                )
        return len(rows)

    def list_dungeon_rooms(self) -> list[dict]:
        with self._connect() as conn:
            rows = conn.execute(
                """
                SELECT key, dungeon_id, dungeon_name, status, status_kind,
                       latest_seq, latest_message_id, latest_time, payload_json, updated_at
                FROM dungeon_rooms
                ORDER BY latest_seq DESC, updated_at DESC
                """
            ).fetchall()
        return [
            {
                "key": row[0] or "",
                "dungeon_id": row[1] or "",
                "dungeon_name": row[2] or "",
                "status": row[3] or "",
                "status_kind": row[4] or "",
                "latest_seq": int(row[5] or 0),
                "latest_message_id": row[6] or "",
                "latest_time": row[7] or "",
                "payload": json.loads(row[8] or "{}"),
                "updated_at": float(row[9] or 0),
            }
            for row in rows
        ]

    def max_dungeon_card_seq(self) -> int:
        with self._connect() as conn:
            row = conn.execute(
                """
                SELECT MAX(rowid)
                FROM parsed_cards
                WHERE channels_json LIKE '%"dungeon"%'
                """
            ).fetchone()
        return int((row or [0])[0] or 0)

    def _recent_dungeon_card_rows(
        self,
        *,
        before_seq: int | None = None,
        limit: int = DUNGEON_CONTEXT_SCAN_LIMIT,
    ) -> list[tuple[int, ParsedCard]]:
        params: list[object] = ['%"dungeon"%']
        where = ["channels_json LIKE ?"]
        if before_seq is not None:
            try:
                before_seq_int = int(before_seq)
            except (TypeError, ValueError):
                before_seq_int = 0
            if before_seq_int > 0:
                where.append("rowid <= ?")
                params.append(before_seq_int)
        try:
            row_limit = max(1, min(int(limit or DUNGEON_CONTEXT_SCAN_LIMIT), 10000))
        except (TypeError, ValueError):
            row_limit = DUNGEON_CONTEXT_SCAN_LIMIT
        params.append(row_limit)
        with self._connect() as conn:
            rows = conn.execute(
                f"""
                SELECT rowid, payload_json
                FROM parsed_cards
                WHERE {" AND ".join(where)}
                ORDER BY rowid DESC
                LIMIT ?
                """,
                params,
            ).fetchall()
        result: list[tuple[int, ParsedCard]] = []
        for rowid, payload in rows:
            try:
                result.append((int(rowid), ParsedCard.from_api(json.loads(payload or "{}"))))
            except Exception:
                continue
        return result

    def find_dungeon_contexts_by_ids(
        self,
        dungeon_ids: Iterable[str | int],
        *,
        before_by_id: dict[str, int] | None = None,
    ) -> dict[str, dict]:
        ids = {str(item or "").strip() for item in dungeon_ids}
        ids.discard("")
        if not ids:
            return {}
        before_by_id = {str(key): int(value or 0) for key, value in (before_by_id or {}).items()}
        max_before = max((value for value in before_by_id.values() if value > 0), default=0)
        rows = self._recent_dungeon_card_rows(before_seq=max_before or None)
        contexts: dict[str, dict] = {}
        completed: set[str] = set()
        for rowid, card in rows:
            fields = card.fields or {}
            dungeon_id = str(fields.get("副本ID") or "").strip()
            if dungeon_id not in ids or dungeon_id in completed:
                continue
            before_seq = before_by_id.get(dungeon_id, 0)
            if before_seq > 0 and int(rowid) > before_seq:
                continue
            name = _dungeon_context_name(card)
            best = contexts.get(dungeon_id)
            if not best:
                best = contexts[dungeon_id] = {
                    "seq": int(rowid),
                    "message_id": card.id,
                    "dungeon_id": dungeon_id,
                    "dungeon_name": name,
                    "opened_by": str(fields.get("开门人") or "").strip(),
                    "capacity": str(fields.get("人数上限") or "").strip(),
                    "oracle": str(fields.get("卦象") or "").strip(),
                    "advice": str(fields.get("行运建议") or "").strip(),
                }
            for key, source in (
                ("dungeon_name", name),
                ("opened_by", fields.get("开门人")),
                ("capacity", fields.get("人数上限")),
                ("oracle", fields.get("卦象")),
                ("advice", fields.get("行运建议")),
            ):
                if not best.get(key) and source:
                    best[key] = str(source).strip()
            if card.title.endswith("开启") and best.get("dungeon_name"):
                best["open_seq"] = int(rowid)
                best["open_message_id"] = card.id
                completed.add(dungeon_id)
                if completed == ids:
                    break
        return contexts

    def find_dungeon_context_by_id(self, dungeon_id: str | int, *, before_seq: int | None = None) -> dict:
        dungeon_id = str(dungeon_id or "").strip()
        if not dungeon_id:
            return {}
        contexts = self.find_dungeon_contexts_by_ids(
            [dungeon_id],
            before_by_id={dungeon_id: int(before_seq or 0)} if before_seq else None,
        )
        return contexts.get(dungeon_id) or {}

    def find_latest_dungeon_open_context(
        self,
        dungeon_name: str,
        *,
        chat_id: int | None = None,
        before_seq: int | None = None,
    ) -> dict:
        dungeon_name = str(dungeon_name or "").strip()
        if not dungeon_name:
            return {}
        rows = self._recent_dungeon_card_rows(before_seq=before_seq)
        for rowid, card in rows:
            fields = card.fields or {}
            if chat_id is not None and card.chat_id is not None and int(card.chat_id) != int(chat_id):
                continue
            search_text = f"{card.title or ''}\n{card.raw or ''}"
            if str(fields.get("副本名") or "").strip() != dungeon_name and dungeon_name not in search_text:
                continue
            if _is_dungeon_context_closed_card(card):
                return {}
            dungeon_id = str(fields.get("副本ID") or "").strip()
            if not dungeon_id:
                continue
            title = str(card.title or "")
            status = str(fields.get("状态") or "")
            if not title.endswith("开启") and "可加入" not in status:
                continue
            return {
                "seq": int(rowid),
                "message_id": card.id,
                "dungeon_id": dungeon_id,
                "dungeon_name": dungeon_name,
                "opened_by": str(fields.get("开门人") or "").strip(),
                "capacity": str(fields.get("人数上限") or "").strip(),
                "oracle": str(fields.get("卦象") or "").strip(),
                "advice": str(fields.get("行运建议") or "").strip(),
            }
        return {}

    def resource_coverage(self, *, limit: int = 5000) -> dict:
        try:
            limit = int(limit or 5000)
        except (TypeError, ValueError):
            limit = 5000
        limit = max(1, min(limit, 10000))
        with self._connect() as conn:
            rows = conn.execute(
                """
                SELECT rm.id, rm.text, rm.source, rm.date, rm.chat_id, rm.msg_id
                FROM raw_messages rm
                WHERE (
                    rm.text LIKE '%【野外历练%'
                    OR (rm.text LIKE '%【战利品结算%' AND rm.text NOT LIKE '%血色试炼%')
                    OR rm.text LIKE '%【黄龙山大战%'
                    OR rm.text LIKE '%【登顶昆吾山%'
                    OR rm.text LIKE '%【坠魔谷%'
                    OR rm.text LIKE '%【苍坤上人洞府%'
                    OR rm.text LIKE '%【逆天之举%'
                    OR rm.text LIKE '%【灵果入腹%'
                    OR rm.text LIKE '%【极阴的欣赏%'
                    OR rm.text LIKE '%【神魂碾压%'
                    OR rm.text LIKE '%【侥幸逃脱%'
                    OR rm.text LIKE '%【天机异闻·南陇侯的交易%'
                    OR rm.text LIKE '%【天机异闻·魔君之怒%'
                )
                ORDER BY rowid DESC
                LIMIT ?
                """,
                (limit,),
            ).fetchall()
            candidate_ids = {str(row[0]) for row in rows}
            existing_ids = {
                str(row[0])
                for row in conn.execute("SELECT raw_message_id FROM resource_events").fetchall()
                if str(row[0]) in candidate_ids
            } if candidate_ids else set()
        summary: dict[str, dict[str, object]] = {}
        missing_samples: list[dict] = []
        candidate_rows = len(rows)
        scanned = 0
        parsed = 0
        for row in rows:
            kind = _resource_coverage_kind(str(row[1] or ""))
            if not kind:
                continue
            scanned += 1
            is_parsed = str(row[0]) in existing_ids
            if is_parsed:
                parsed += 1
            bucket = summary.setdefault(
                kind,
                {"kind": kind, "total": 0, "parsed": 0, "missing": 0},
            )
            bucket["total"] = int(bucket["total"]) + 1
            if is_parsed:
                bucket["parsed"] = int(bucket["parsed"]) + 1
            else:
                bucket["missing"] = int(bucket["missing"]) + 1
                if len(missing_samples) < 12:
                    missing_samples.append(
                        {
                            "id": row[0],
                            "kind": kind,
                            "source": row[2] or "",
                            "time": row[3] or "",
                            "chat_id": int(row[4] or 0),
                            "msg_id": int(row[5] or 0),
                            "text": str(row[1] or "")[:220],
                        }
                    )
        coverage_rows = sorted(summary.values(), key=lambda item: (int(item.get("missing") or 0), int(item.get("total") or 0), str(item.get("kind") or "")), reverse=True)
        return {
            "ok": True,
            "limit": limit,
            "candidate_rows": candidate_rows,
            "scanned": scanned,
            "parsed": parsed,
            "missing": scanned - parsed,
            "ignored": candidate_rows - scanned,
            "rows": coverage_rows,
            "missing_samples": missing_samples,
            "notes": [
                "这里只扫最近一段疑似资源结算文案,用于发现漏解析样本。",
                "血色试炼会被刻意排除,不算资源统计目标。",
            ],
        }

    def reparse_missing_resource_records(self, *, limit: int = 5000) -> dict:
        """只重跑资源覆盖诊断里「候选但无 resource_events」的消息。

        这用于上线后补 parser 漏样本,不重建 parsed_cards,也不碰状态机。
        """
        try:
            limit = int(limit or 5000)
        except (TypeError, ValueError):
            limit = 5000
        limit = max(1, min(limit, 10000))
        with self._connect() as conn:
            rows = conn.execute(
                """
                SELECT rm.id, rm.chat_id, rm.msg_id, rm.text, rm.source, rm.date, rm.sender_id,
                       rm.reply_to_msg_id, rm.top_msg_id, rm.mentions_json, rm.sender_is_bot,
                       rm.edited_at, rm.deleted_at, rm.media_kind, rm.media_meta_json
                FROM raw_messages rm
                WHERE (
                    rm.text LIKE '%【野外历练%'
                    OR (rm.text LIKE '%【战利品结算%' AND rm.text NOT LIKE '%血色试炼%')
                    OR rm.text LIKE '%【黄龙山大战%'
                    OR rm.text LIKE '%【登顶昆吾山%'
                    OR rm.text LIKE '%【坠魔谷%'
                    OR rm.text LIKE '%【苍坤上人洞府%'
                    OR rm.text LIKE '%【逆天之举%'
                    OR rm.text LIKE '%【灵果入腹%'
                    OR rm.text LIKE '%【极阴的欣赏%'
                    OR rm.text LIKE '%【神魂碾压%'
                    OR rm.text LIKE '%【侥幸逃脱%'
                    OR rm.text LIKE '%【天机异闻·南陇侯的交易%'
                    OR rm.text LIKE '%【天机异闻·魔君之怒%'
                )
                AND NOT EXISTS (
                    SELECT 1 FROM resource_events re WHERE re.raw_message_id = rm.id
                )
                ORDER BY rm.rowid DESC
                LIMIT ?
                """,
                (limit,),
            ).fetchall()
        if not rows:
            return {
                "ok": True,
                "candidate_rows": 0,
                "scanned": 0,
                "skipped": 0,
                "reparsed_events": 0,
                "reparsed_deltas": 0,
                "still_missing": 0,
            }
        registry = build_parser_registry()
        candidate_rows = len(rows)
        scanned = 0
        event_count = 0
        delta_count = 0
        still_missing = 0
        samples: list[dict] = []
        with self._connect() as conn:
            for row in rows:
                if not _resource_coverage_kind(str(row[3] or "")):
                    continue
                scanned += 1
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
                output = registry.parse(event)
                if not output.resource_deltas and not output.resource_events:
                    still_missing += 1
                    if len(samples) < 10:
                        samples.append(
                            {
                                "id": row[0],
                                "msg_id": int(row[2] or 0),
                                "kind": _resource_coverage_kind(str(row[3] or "")),
                                "text": str(row[3] or "")[:220],
                            }
                        )
                    continue
                self._replace_resource_records(
                    conn,
                    event,
                    output.resource_deltas,
                    output.resource_events,
                )
                event_count += len(output.resource_events)
                delta_count += len(output.resource_deltas)
        return {
            "ok": True,
            "candidate_rows": candidate_rows,
            "scanned": scanned,
            "skipped": candidate_rows - scanned,
            "reparsed_events": event_count,
            "reparsed_deltas": delta_count,
            "still_missing": still_missing,
            "missing_samples": samples,
        }

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
            conn.execute("PRAGMA journal_mode=WAL")
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

                CREATE TABLE IF NOT EXISTS parsed_card_channels (
                    card_id TEXT NOT NULL,
                    channel TEXT NOT NULL,
                    card_rowid INTEGER NOT NULL,
                    raw_message_id TEXT NOT NULL,
                    sort_date TEXT NOT NULL DEFAULT '',
                    msg_id INTEGER NOT NULL DEFAULT 0,
                    PRIMARY KEY(channel, card_id),
                    FOREIGN KEY(card_id) REFERENCES parsed_cards(id) ON DELETE CASCADE
                );

                CREATE INDEX IF NOT EXISTS idx_raw_messages_msg_id
                    ON raw_messages(chat_id, msg_id);
                CREATE INDEX IF NOT EXISTS idx_raw_messages_reply_to_msg_id
                    ON raw_messages(chat_id, reply_to_msg_id)
                    WHERE reply_to_msg_id IS NOT NULL;
                CREATE INDEX IF NOT EXISTS idx_parsed_cards_primary_channel
                    ON parsed_cards(primary_channel);
                CREATE INDEX IF NOT EXISTS idx_parsed_cards_raw_message
                    ON parsed_cards(raw_message_id);

                CREATE TABLE IF NOT EXISTS resource_deltas (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    raw_message_id TEXT NOT NULL,
                    source_type TEXT NOT NULL,
                    source_name TEXT NOT NULL DEFAULT '',
                    player TEXT NOT NULL DEFAULT '',
                    resource_name TEXT NOT NULL,
                    amount INTEGER NOT NULL,
                    unit TEXT NOT NULL DEFAULT '',
                    basis TEXT NOT NULL DEFAULT 'event',
                    event_time TEXT NOT NULL,
                    day_key TEXT NOT NULL,
                    week_key TEXT NOT NULL,
                    month_key TEXT NOT NULL,
                    chat_id INTEGER NOT NULL DEFAULT 0,
                    msg_id INTEGER NOT NULL DEFAULT 0,
                    meta_json TEXT NOT NULL DEFAULT '{}',
                    FOREIGN KEY(raw_message_id) REFERENCES raw_messages(id)
                );

                CREATE INDEX IF NOT EXISTS idx_resource_deltas_period
                    ON resource_deltas(day_key, week_key, month_key);
                CREATE INDEX IF NOT EXISTS idx_resource_deltas_week
                    ON resource_deltas(week_key);
                CREATE INDEX IF NOT EXISTS idx_resource_deltas_month
                    ON resource_deltas(month_key);
                CREATE INDEX IF NOT EXISTS idx_resource_deltas_source
                    ON resource_deltas(source_type, source_name);
                CREATE INDEX IF NOT EXISTS idx_resource_deltas_resource
                    ON resource_deltas(resource_name);
                CREATE INDEX IF NOT EXISTS idx_resource_deltas_raw_message
                    ON resource_deltas(raw_message_id);

                CREATE TABLE IF NOT EXISTS resource_events (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    raw_message_id TEXT NOT NULL,
                    source_type TEXT NOT NULL,
                    source_name TEXT NOT NULL DEFAULT '',
                    player TEXT NOT NULL DEFAULT '',
                    result TEXT NOT NULL,
                    outcome TEXT NOT NULL DEFAULT '',
                    event_time TEXT NOT NULL,
                    day_key TEXT NOT NULL,
                    week_key TEXT NOT NULL,
                    month_key TEXT NOT NULL,
                    chat_id INTEGER NOT NULL DEFAULT 0,
                    msg_id INTEGER NOT NULL DEFAULT 0,
                    meta_json TEXT NOT NULL DEFAULT '{}',
                    FOREIGN KEY(raw_message_id) REFERENCES raw_messages(id)
                );

                CREATE INDEX IF NOT EXISTS idx_resource_events_period
                    ON resource_events(day_key, week_key, month_key);
                CREATE INDEX IF NOT EXISTS idx_resource_events_source
                    ON resource_events(source_type, source_name);
                CREATE INDEX IF NOT EXISTS idx_resource_events_result
                    ON resource_events(result);
                CREATE INDEX IF NOT EXISTS idx_resource_events_raw_message
                    ON resource_events(raw_message_id);

                CREATE TABLE IF NOT EXISTS inventory_snapshots (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    owner TEXT NOT NULL,
                    raw_message_id TEXT NOT NULL,
                    source TEXT NOT NULL DEFAULT '',
                    event_time TEXT NOT NULL,
                    chat_id INTEGER NOT NULL DEFAULT 0,
                    msg_id INTEGER NOT NULL DEFAULT 0,
                    item_count INTEGER NOT NULL DEFAULT 0,
                    total_amount INTEGER NOT NULL DEFAULT 0,
                    created_at TEXT NOT NULL,
                    FOREIGN KEY(raw_message_id) REFERENCES raw_messages(id)
                );

                CREATE UNIQUE INDEX IF NOT EXISTS idx_inventory_snapshots_raw
                    ON inventory_snapshots(raw_message_id);
                CREATE INDEX IF NOT EXISTS idx_inventory_snapshots_owner
                    ON inventory_snapshots(owner, event_time DESC);

                CREATE TABLE IF NOT EXISTS inventory_items (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    snapshot_id INTEGER NOT NULL,
                    owner TEXT NOT NULL,
                    section TEXT NOT NULL DEFAULT '',
                    item_name TEXT NOT NULL,
                    amount INTEGER NOT NULL,
                    extra TEXT NOT NULL DEFAULT '',
                    event_time TEXT NOT NULL,
                    raw_message_id TEXT NOT NULL,
                    FOREIGN KEY(snapshot_id) REFERENCES inventory_snapshots(id) ON DELETE CASCADE,
                    FOREIGN KEY(raw_message_id) REFERENCES raw_messages(id)
                );

                CREATE INDEX IF NOT EXISTS idx_inventory_items_snapshot
                    ON inventory_items(snapshot_id);
                CREATE INDEX IF NOT EXISTS idx_inventory_items_name
                    ON inventory_items(item_name);

                CREATE TABLE IF NOT EXISTS inventory_current (
                    owner TEXT NOT NULL,
                    section TEXT NOT NULL DEFAULT '',
                    item_name TEXT NOT NULL,
                    amount INTEGER NOT NULL DEFAULT 0,
                    extra TEXT NOT NULL DEFAULT '',
                    confidence TEXT NOT NULL DEFAULT 'snapshot',
                    basis TEXT NOT NULL DEFAULT 'snapshot',
                    last_snapshot_message_id TEXT NOT NULL DEFAULT '',
                    last_delta_message_id TEXT NOT NULL DEFAULT '',
                    event_time TEXT NOT NULL,
                    updated_at TEXT NOT NULL,
                    PRIMARY KEY(owner, item_name, extra)
                );

                CREATE INDEX IF NOT EXISTS idx_inventory_current_owner
                    ON inventory_current(owner, item_name);

                CREATE TABLE IF NOT EXISTS inventory_ledger (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    owner TEXT NOT NULL,
                    raw_message_id TEXT NOT NULL,
                    source_type TEXT NOT NULL,
                    item_name TEXT NOT NULL,
                    amount_delta INTEGER NOT NULL,
                    confidence TEXT NOT NULL DEFAULT 'estimated',
                    event_time TEXT NOT NULL,
                    chat_id INTEGER NOT NULL DEFAULT 0,
                    msg_id INTEGER NOT NULL DEFAULT 0,
                    created_at TEXT NOT NULL,
                    FOREIGN KEY(raw_message_id) REFERENCES raw_messages(id)
                );

                CREATE INDEX IF NOT EXISTS idx_inventory_ledger_owner
                    ON inventory_ledger(owner, event_time DESC);
                CREATE UNIQUE INDEX IF NOT EXISTS idx_inventory_ledger_raw_item
                    ON inventory_ledger(raw_message_id, owner, item_name);

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

                CREATE TABLE IF NOT EXISTS send_logs (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    kind TEXT NOT NULL,
                    status TEXT NOT NULL,
                    account_local_id TEXT NOT NULL DEFAULT '',
                    identity_id INTEGER NOT NULL DEFAULT 0,
                    send_as_id INTEGER NOT NULL DEFAULT 0,
                    chat_id INTEGER NOT NULL DEFAULT 0,
                    topic_id INTEGER NOT NULL DEFAULT 0,
                    reply_to_msg_id INTEGER NOT NULL DEFAULT 0,
                    command TEXT NOT NULL DEFAULT '',
                    source_message_id TEXT NOT NULL DEFAULT '',
                    tg_msg_id INTEGER NOT NULL DEFAULT 0,
                    scheduled_msg_id INTEGER NOT NULL DEFAULT 0,
                    batch_id INTEGER NOT NULL DEFAULT 0,
                    schedule_message_id INTEGER NOT NULL DEFAULT 0,
                    error TEXT NOT NULL DEFAULT '',
                    created_at TEXT NOT NULL,
                    meta_json TEXT NOT NULL DEFAULT '{}'
                );

                CREATE INDEX IF NOT EXISTS idx_send_logs_kind_status
                    ON send_logs(kind, status, id DESC);
                CREATE INDEX IF NOT EXISTS idx_send_logs_identity
                    ON send_logs(identity_id, id DESC);
                CREATE INDEX IF NOT EXISTS idx_send_logs_batch
                    ON send_logs(batch_id, schedule_message_id);

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

                CREATE TABLE IF NOT EXISTS official_schedule_renew_profiles (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    send_as_id INTEGER NOT NULL,
                    account_local_id TEXT NOT NULL DEFAULT '',
                    preset_key TEXT NOT NULL DEFAULT '',
                    module_key TEXT NOT NULL DEFAULT '',
                    label TEXT NOT NULL DEFAULT '',
                    enabled INTEGER NOT NULL DEFAULT 1,
                    renew_days INTEGER NOT NULL DEFAULT 1,
                    threshold_hours INTEGER NOT NULL DEFAULT 24,
                    soft_limit INTEGER NOT NULL DEFAULT 95,
                    payload_json TEXT NOT NULL DEFAULT '{}',
                    covered_until REAL NOT NULL DEFAULT 0,
                    last_batch_id INTEGER NOT NULL DEFAULT 0,
                    last_run_at REAL NOT NULL DEFAULT 0,
                    last_error TEXT NOT NULL DEFAULT '',
                    created_at REAL NOT NULL,
                    updated_at REAL NOT NULL
                );

                CREATE INDEX IF NOT EXISTS idx_official_schedule_renew_profiles_identity
                    ON official_schedule_renew_profiles(send_as_id, enabled);

                CREATE TABLE IF NOT EXISTS dungeon_rooms (
                    key TEXT PRIMARY KEY,
                    dungeon_id TEXT NOT NULL DEFAULT '',
                    dungeon_name TEXT NOT NULL DEFAULT '',
                    status TEXT NOT NULL DEFAULT '',
                    status_kind TEXT NOT NULL DEFAULT '',
                    latest_seq INTEGER NOT NULL DEFAULT 0,
                    latest_message_id TEXT NOT NULL DEFAULT '',
                    latest_time TEXT NOT NULL DEFAULT '',
                    payload_json TEXT NOT NULL DEFAULT '{}',
                    updated_at REAL NOT NULL
                );

                CREATE INDEX IF NOT EXISTS idx_dungeon_rooms_status
                    ON dungeon_rooms(status_kind, latest_seq DESC);
                CREATE INDEX IF NOT EXISTS idx_dungeon_rooms_latest
                    ON dungeon_rooms(latest_seq DESC);

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
            self._migrate_parsed_card_channels_columns(conn)
            self._backfill_parsed_card_channels_if_needed(conn)
            self._ensure_parsed_card_channel_indexes(conn)
            self._migrate_state_patches_columns(conn)
            # idx_state_patches_sender 引用 send_as_id 列,迁移完成后再建,避免老库 cold start 失败
            conn.execute(
                "CREATE INDEX IF NOT EXISTS idx_state_patches_sender "
                "ON state_patches(scope, send_as_id)"
            )

    def _ensure_parsed_card_channel_indexes(self, conn) -> None:
        conn.execute(
            "CREATE INDEX IF NOT EXISTS idx_parsed_card_channels_card "
            "ON parsed_card_channels(card_id)"
        )
        conn.execute(
            "CREATE INDEX IF NOT EXISTS idx_parsed_card_channels_channel_rowid "
            "ON parsed_card_channels(channel, card_rowid)"
        )
        conn.execute(
            "CREATE INDEX IF NOT EXISTS idx_parsed_card_channels_channel_sort "
            "ON parsed_card_channels(channel, sort_date DESC, msg_id DESC, card_rowid DESC)"
        )

    def _migrate_parsed_card_channels_columns(self, conn) -> None:
        existing = {row[1] for row in conn.execute("PRAGMA table_info(parsed_card_channels)").fetchall()}
        for column, ddl in (
            ("card_rowid", "ALTER TABLE parsed_card_channels ADD COLUMN card_rowid INTEGER NOT NULL DEFAULT 0"),
            ("raw_message_id", "ALTER TABLE parsed_card_channels ADD COLUMN raw_message_id TEXT NOT NULL DEFAULT ''"),
            ("sort_date", "ALTER TABLE parsed_card_channels ADD COLUMN sort_date TEXT NOT NULL DEFAULT ''"),
            ("msg_id", "ALTER TABLE parsed_card_channels ADD COLUMN msg_id INTEGER NOT NULL DEFAULT 0"),
        ):
            if column not in existing:
                conn.execute(ddl)

    def _backfill_parsed_card_channels_if_needed(self, conn) -> int:
        parsed_count = int(conn.execute("SELECT COUNT(*) FROM parsed_cards").fetchone()[0] or 0)
        if parsed_count <= 0:
            return 0
        indexed_count = int(
            conn.execute(
                "SELECT COUNT(*) FROM parsed_card_channels WHERE channel=?",
                (ALL_CHANNEL_INDEX_KEY,),
            ).fetchone()[0]
            or 0
        )
        if indexed_count >= parsed_count:
            return 0
        missing_only = indexed_count > 0
        if not missing_only:
            conn.execute("DELETE FROM parsed_card_channels")
        missing_join = ""
        missing_where = ""
        missing_params: tuple = ()
        if missing_only:
            max_indexed_rowid = int(
                conn.execute(
                    "SELECT MAX(card_rowid) FROM parsed_card_channels WHERE channel=?",
                    (ALL_CHANNEL_INDEX_KEY,),
                ).fetchone()[0]
                or 0
            )
            max_parsed_rowid = int(conn.execute("SELECT MAX(rowid) FROM parsed_cards").fetchone()[0] or 0)
            if 0 < max_indexed_rowid < max_parsed_rowid:
                missing_where = "WHERE pc.rowid > ?"
                missing_params = (max_indexed_rowid,)
            else:
                missing_join = """
                LEFT JOIN parsed_card_channels existing
                  ON existing.channel = ? AND existing.card_id = pc.id
                """
                missing_where = "WHERE existing.card_id IS NULL"
                missing_params = (ALL_CHANNEL_INDEX_KEY,)
        try:
            conn.execute(
                f"""
                INSERT OR REPLACE INTO parsed_card_channels(
                    card_id, channel, card_rowid, raw_message_id, sort_date, msg_id
                )
                SELECT pc.id, ?, pc.rowid, pc.raw_message_id, COALESCE(rm.date, ''), COALESCE(rm.msg_id, 0)
                FROM parsed_cards pc
                JOIN raw_messages rm ON rm.id = pc.raw_message_id
                {missing_join}
                {missing_where}
                """,
                (ALL_CHANNEL_INDEX_KEY, *missing_params),
            )
            conn.execute(
                f"""
                INSERT OR REPLACE INTO parsed_card_channels(
                    card_id, channel, card_rowid, raw_message_id, sort_date, msg_id
                )
                SELECT pc.id, json_each.value, pc.rowid, pc.raw_message_id,
                       COALESCE(rm.date, ''), COALESCE(rm.msg_id, 0)
                FROM parsed_cards pc
                JOIN raw_messages rm ON rm.id = pc.raw_message_id
                {missing_join}
                JOIN json_each(pc.channels_json)
                WHERE json_each.value IS NOT NULL AND json_each.value != ''
                {"AND " + missing_where.removeprefix("WHERE ") if missing_where else ""}
                """,
                missing_params,
            )
        except sqlite3.OperationalError:
            if not missing_only:
                conn.execute("DELETE FROM parsed_card_channels")
            rows = conn.execute(
                f"""
                SELECT pc.id, pc.rowid, pc.raw_message_id, pc.channels_json,
                       COALESCE(rm.date, ''), COALESCE(rm.msg_id, 0)
                FROM parsed_cards pc
                JOIN raw_messages rm ON rm.id = pc.raw_message_id
                {missing_join}
                {missing_where}
                """,
                missing_params,
            ).fetchall()
            inserts = []
            for card_id, rowid, raw_message_id, channels_json, sort_date, msg_id in rows:
                channels = [ALL_CHANNEL_INDEX_KEY]
                try:
                    channels.extend(str(item or "").strip() for item in json.loads(channels_json or "[]"))
                except Exception:
                    pass
                seen: set[str] = set()
                for channel in channels:
                    if not channel or channel in seen:
                        continue
                    seen.add(channel)
                    inserts.append((card_id, channel, int(rowid or 0), raw_message_id, sort_date or "", int(msg_id or 0)))
            conn.executemany(
                """
                INSERT OR REPLACE INTO parsed_card_channels(
                    card_id, channel, card_rowid, raw_message_id, sort_date, msg_id
                )
                VALUES(?, ?, ?, ?, ?, ?)
                """,
                inserts,
            )
        return parsed_count

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

    @contextmanager
    def _connect(self):
        # 多线程并发写(listener 线程在 ingest 消息 + HTTP 请求在保存账号/身份)
        # 默认 SQLite 不容忍并发,会立刻报 "database is locked"。
        # schema 初始化时启用 WAL;这里加 busy_timeout 让写等而不立刻 fail。
        conn = sqlite3.connect(self.db_path, timeout=30.0)
        try:
            conn.execute("PRAGMA foreign_keys=ON")
            conn.execute("PRAGMA busy_timeout=30000")
            conn.execute("PRAGMA synchronous=NORMAL")
            with conn:
                yield conn
        finally:
            conn.close()


def _clean_reply_to(event: RawMessageEvent, topic_id: int = 0) -> int | None:
    raw_reply = event.reply_to_msg_id
    if raw_reply and (
        (event.top_msg_id and int(raw_reply) == int(event.top_msg_id))
        or (topic_id and int(raw_reply) == int(topic_id))
    ):
        return None
    return int(raw_reply) if raw_reply else None


def _is_focus_protected_card(card: ParsedCard) -> bool:
    tags = set(card.tags or ())
    channels = set(card.channels or ())
    if tags.intersection({"被@", "会长"}):
        return True
    if card.severity == "risk" or channels.intersection({"risk", "dungeon"}):
        return True
    return bool(card.actions)


def _dungeon_context_name(card: ParsedCard) -> str:
    fields = card.fields or {}
    name = str(fields.get("副本名") or "").strip()
    if name:
        return name
    text = f"{card.title or ''}\n{card.raw or ''}"
    for candidate in ("虚天殿", "黄龙山", "昆吾山", "坠魔谷", "血色试炼", "苍坤上人洞府"):
        if candidate in text:
            return candidate
    return ""


def _is_dungeon_context_closed_card(card: ParsedCard) -> bool:
    fields = card.fields or {}
    tags = set(card.tags or ())
    title = str(card.title or "")
    status = str(fields.get("状态") or "")
    stage = str(fields.get("阶段") or "")
    text = f"{title}\n{status}\n{stage}\n{card.raw or ''}"
    if title == "副本房间解散" or "解散" in tags:
        return True
    if any(token in text for token in ("撤离成功", "撤离失败", "脱身成功", "脱身失败", "后殿冲关止步", "后殿冲关成功")):
        return True
    return bool(
        "第五关" in text
        and ("鼎灵退散" in text or "所有队员额外获得" in text or "最终鼎压" in text)
        and "回合耗尽" not in text
        and "仍未被真正压灭" not in text
    )
