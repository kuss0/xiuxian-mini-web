from __future__ import annotations

import json
import re
from datetime import datetime
from typing import Protocol

from backend.config import MAX_ACCOUNTS, MAX_IDENTITIES, MAX_LISTENERS
from backend.domain import CHANNELS
from backend.domain.models import ParsedCard, utc_now_iso
from backend.outbox import OutboxPlanner
from backend.outbox.schedule import (
    OfficialScheduleService,
    PRESET_LABELS,
    SHORT_PAUSE_MEAN_SEC,
    LONG_PAUSE_MIN_SEC,
    LONG_PAUSE_MAX_SEC,
    LONG_PAUSE_EVERY_MIN,
    LONG_PAUSE_EVERY_MAX,
    build_plan as build_schedule_plan,
    fmt_ts as schedule_fmt_ts,
    list_presets as list_schedule_presets,
)
from backend.notifications.dispatcher import NotificationDispatcher
from backend.notifications.tg_bot import TelegramBotNotifier
from backend.repo import SQLiteStore
from backend.skills import SkillRegistry
from backend.skills.send import SkillSendService
from backend.tg.client import safe_session_name
from backend.tg.dialogs import TelegramDialogService
from backend.tg.login import TelegramLoginService
from backend.tg.listener_manager import TelegramListenerManager
from backend.tg.send_as import SendAsService


class CardStore(Protocol):
    def list_cards(self, channel: str = "all") -> tuple[ParsedCard, ...]:
        ...

    def get_card_by_chat_msg(self, chat_id: int, msg_id: int) -> tuple[int, ParsedCard] | None:
        ...

    def get_settings(self) -> dict:
        ...

    def list_state_patches(self, scope: str = "", send_as_id: int = 0) -> list[dict]:
        ...

    def resource_stats(
        self,
        *,
        period: str = "day",
        source_type: str = "",
        source_name: str = "",
        limit: int = 120,
    ) -> dict:
        ...

    def list_inventory_snapshots(
        self,
        *,
        owner: str = "",
        latest_only: bool = True,
        include_items: bool = True,
        limit: int = 80,
    ) -> list[dict]:
        ...

    def save_settings(self, payload: dict) -> dict:
        ...

    def list_accounts(self) -> list[dict]:
        ...

    def get_account(self, local_id: str) -> dict | None:
        ...

    def save_account(self, payload: dict) -> dict:
        ...

    def list_identities(self) -> list[dict]:
        ...

    def get_identity(self, send_as_id: int | str) -> dict | None:
        ...

    def save_identity(self, payload: dict) -> dict:
        ...

    def delete_identity(self, send_as_id: int | str) -> bool:
        ...

    def list_outbox_drafts(self, status: str = "draft") -> list[dict]:
        ...

    def save_outbox_draft(self, payload: dict) -> dict:
        ...

    def delete_outbox_draft(self, draft_id: str) -> bool:
        ...


SECRET_SETTING_KEYS = {"api_hash", "proxy_password", "notify_tg_bot_token"}


def _parse_tg_card_ref(value: str) -> tuple[int, int]:
    """Parse canonical card refs like tg:-1001680975844:9023228.

    Older outgoing cards may append an account key after msg_id; the first
    three fields are still enough to locate the Telegram message.
    """
    parts = str(value or "").strip().split(":")
    if len(parts) < 3 or parts[0] != "tg":
        return 0, 0
    try:
        return int(parts[1]), int(parts[2])
    except (TypeError, ValueError):
        return 0, 0


def _estimate_send_seconds(n: int) -> int:
    """根据条数估算后台发送总时长(秒)。前端展示给用户「大约还要 X 分钟」。

    平均短停顿 SHORT_PAUSE_MEAN_SEC 一条;每 (LONG_EVERY_MIN+MAX)/2 条插一次长停顿
    LONG_PAUSE_(MIN+MAX)/2,再加上每条的请求耗时(估 1.5s/条)。"""
    n = int(n or 0)
    if n <= 1:
        return n  # 1 条几乎没等待
    avg_long_every = (LONG_PAUSE_EVERY_MIN + LONG_PAUSE_EVERY_MAX) / 2
    avg_long_pause = (LONG_PAUSE_MIN_SEC + LONG_PAUSE_MAX_SEC) / 2
    short_pauses = n - 1
    long_pauses = max(0, int((n - 1) // avg_long_every))
    short_pauses -= long_pauses
    request_time = n * 1.5
    return int(short_pauses * SHORT_PAUSE_MEAN_SEC + long_pauses * avg_long_pause + request_time)



class MiniWebServer:
    def __init__(self, store: CardStore | None = None) -> None:
        if store is None:
            sqlite_store = SQLiteStore.default()
            sqlite_store.seed_samples_if_empty()
            sqlite_store.ensure_default_settings()
            migrated = sqlite_store.rebuild_parsed_cards_if_legacy()
            if migrated:
                print(f"[mini-web] 迁移了 {migrated} 条历史卡片 (hall → world/system)")
            filter_migrated = sqlite_store.rebuild_parsed_cards_if_filter_outdated()
            if filter_migrated:
                print(f"[mini-web] 消息过滤频道迁移: 重分流 {filter_migrated} 条历史卡片")
            backfilled = sqlite_store.backfill_module_states_if_empty()
            if backfilled:
                print(f"[mini-web] 状态机历史 backfill: 重放 {backfilled} 条 raw_messages")
            resource_backfilled = sqlite_store.backfill_resource_records_if_needed()
            if resource_backfilled.get("events") or resource_backfilled.get("deltas"):
                print(
                    "[mini-web] 资源统计历史 backfill: "
                    f"写入 {resource_backfilled.get('events', 0)} 条 resource_events, "
                    f"{resource_backfilled.get('deltas', 0)} 条 resource_deltas"
                )
            inventory_backfilled = sqlite_store.backfill_inventory_snapshots_if_needed()
            if inventory_backfilled.get("snapshots") or inventory_backfilled.get("items"):
                print(
                    "[mini-web] 储物袋历史 backfill: "
                    f"写入 {inventory_backfilled.get('snapshots', 0)} 条快照, "
                    f"{inventory_backfilled.get('items', 0)} 条物品"
                )
            store = sqlite_store
        self._store = store
        self._outbox = OutboxPlanner(self._store)
        self._dialogs = TelegramDialogService()
        self._login = TelegramLoginService()
        self._listeners = TelegramListenerManager(self._store)
        self._send_as = SendAsService()
        # 官方定时:复用 listener 的 client 排 Telegram scheduled message
        self._schedule = OfficialScheduleService(
            listener_lookup=self._listeners.get_listener
        )
        # 技能盘:登记好的常用命令 + 一键 send_message(reply_to 可选)
        self._skill_registry = SkillRegistry()
        self._skill_send = SkillSendService(
            self._skill_registry,
            listener_lookup=lambda local_id: self._listeners.get_listener(local_id),
            event_sink=lambda event: self._store.ingest_event(event),
        )
        # 通知调度器(MVP 只支持 TG bot,后续可加 Bark/钉钉/浏览器推送)
        self._notify = NotificationDispatcher(get_settings=self._store.get_settings)
        if hasattr(self._store, "set_notify_dispatcher"):
            self._store.set_notify_dispatcher(self._notify)

    def health_payload(self) -> dict:
        return {"ok": True, "service": "xiuxian-mini-web", "time": utc_now_iso()}

    def channels_payload(self) -> dict:
        return {"channels": [channel.to_api() for channel in CHANNELS]}

    def messages_payload(
        self,
        channel: str = "all",
        *,
        channels: list[str] | tuple[str, ...] | None = None,
        since_seq: int = 0,
        before_seq: int = 0,
        limit: int = 0,
        target_id: str = "",
        mode: str = "",
    ) -> dict:
        """对照 docs/architecture.md inbox 设计:
        - 空 since_seq → 取最近 limit 条(默认 200),前端初始化用
        - since_seq > 0 → 增量,只返 rowid > since_seq 的新卡片(轮询用)
        - channels 给定 → 多频道 OR 合并过滤,支撑网游频道式合并视图
        - target_id 给定 → 只返这一条(回复跳转用,父消息不在 state 时按需拉)
        - mode='solo' → server 端 SQL 过滤「我发的 + bot 回我的」,不依赖前端窗口
        - 返回 max_seq 让前端记录新水位
        """
        channel_filters = normalize_channel_filters(channel, channels)
        target_id = str(target_id or "").strip()
        if target_id and hasattr(self._store, "get_card"):
            result = self._store.get_card(target_id)
            if result is None and hasattr(self._store, "get_card_by_chat_msg"):
                chat_id, msg_id = _parse_tg_card_ref(target_id)
                if chat_id and msg_id:
                    result = self._store.get_card_by_chat_msg(chat_id, msg_id)
            if result is None:
                return {"messages": [], "source": "sqlite", "max_seq": 0, "incremental": False}
            seq, card = result
            payload = card.to_api()
            payload["seq"] = seq
            return {
                "messages": [payload],
                "source": "sqlite",
                "max_seq": seq,
                "incremental": False,
            }

        try:
            since_seq = int(since_seq or 0)
        except (TypeError, ValueError):
            since_seq = 0
        try:
            before_seq = int(before_seq or 0)
        except (TypeError, ValueError):
            before_seq = 0
        try:
            limit = int(limit or 0)
        except (TypeError, ValueError):
            limit = 0
        if since_seq <= 0 and limit <= 0:
            limit = 200

        if str(mode or "").lower() == "solo":
            my_ids = self._store._collect_my_identities()
            for account in self._store.list_accounts():
                try:
                    aid = int(account.get("account_id") or 0)
                    if aid:
                        my_ids.append(aid)
                except (TypeError, ValueError):
                    continue
            bot_ids = self._store._collect_game_bot_ids()
            page = self._store.list_solo_card_page(
                my_ids=list({int(x) for x in my_ids if x}),
                bot_ids=list({int(x) for x in bot_ids if x}),
                since_seq=since_seq,
                limit=limit,
                channel="all" if channel_filters else channel,
                channels=channel_filters,
            )
        else:
            page = self._store.list_card_page(
                since_seq=since_seq,
                before_seq=before_seq,
                limit=limit,
                channel="all" if channel_filters else channel,
                channels=channel_filters,
            )
        messages = []
        max_seq = since_seq
        for seq, card in page:
            payload = card.to_api()
            payload["seq"] = seq
            messages.append(payload)
            if seq > max_seq:
                max_seq = seq
        if max_seq <= 0:
            max_seq = self._store.max_card_seq()
        return {
            "messages": messages,
            "source": "sqlite",
            "max_seq": max_seq,
            "incremental": since_seq > 0,
            "mode": str(mode or "all"),
            "channels": channel_filters or ([str(channel or "all")] if str(channel or "all") != "all" else []),
        }

    def messages_export_payload(self, channel: str = "all", *, mode: str = "", fmt: str = "jsonl") -> dict:
        """全量导出(无 limit),返 {body: bytes, content_type: str, filename: str}。
        app.py 看到这种 dict 形态会包成 RawResponse 直接当文件下载。

        - fmt='jsonl'  默认,每行一个 ParsedCard JSON,字段最全
        - fmt='csv'    扁平表:time,channel,sender_id,chat_id,msg_id,raw
        - fmt='txt'    人类可读:[time] channel | from sender_id\\n  raw\\n
        """
        import csv as _csv
        import io as _io
        from datetime import datetime as _dt

        if str(mode or "").lower() == "solo":
            my_ids = self._store._collect_my_identities()
            for account in self._store.list_accounts():
                try:
                    aid = int(account.get("account_id") or 0)
                    if aid:
                        my_ids.append(aid)
                except (TypeError, ValueError):
                    continue
            bot_ids = self._store._collect_game_bot_ids()
            page = self._store.list_solo_card_page(
                my_ids=list({int(x) for x in my_ids if x}),
                bot_ids=list({int(x) for x in bot_ids if x}),
                since_seq=0,
                limit=0,  # 0 = 不限
                channel=channel,
            )
        else:
            page = self._store.list_card_page(
                since_seq=0,
                before_seq=0,
                limit=0,
                channel=channel,
            )

        # SQLite list_card_page DESC 默认,导出时按时间正序更易读
        cards = [(seq, card) for seq, card in page]
        cards.sort(key=lambda item: item[0])

        ts = _dt.now().strftime("%Y%m%d-%H%M%S")
        suffix_mode = mode or "all"
        suffix_chan = channel or "all"
        fmt = (fmt or "jsonl").lower()

        if fmt == "csv":
            buf = _io.StringIO()
            writer = _csv.writer(buf)
            writer.writerow(["seq", "time", "channel", "sender_id", "chat_id", "msg_id", "reply_to_msg_id", "raw"])
            for seq, card in cards:
                writer.writerow([
                    seq,
                    card.time or "",
                    card.primary_channel,
                    card.sender_id if card.sender_id is not None else "",
                    card.chat_id if card.chat_id is not None else "",
                    card.msg_id if card.msg_id is not None else "",
                    card.reply_to_msg_id if card.reply_to_msg_id is not None else "",
                    (card.raw or "").replace("\n", "\\n"),
                ])
            body = buf.getvalue().encode("utf-8")
            return {
                "body": body,
                "content_type": "text/csv; charset=utf-8",
                "filename": f"xiuxian-messages-{suffix_mode}-{suffix_chan}-{ts}.csv",
            }

        if fmt == "txt":
            lines = []
            for seq, card in cards:
                t = (card.time or "").replace("T", " ").split("+")[0]
                lines.append(f"[{t}] #{seq} {card.primary_channel} | from {card.sender_id or '?'}")
                raw = (card.raw or "").rstrip()
                for raw_line in raw.split("\n"):
                    lines.append(f"  {raw_line}")
                lines.append("")
            body = "\n".join(lines).encode("utf-8")
            return {
                "body": body,
                "content_type": "text/plain; charset=utf-8",
                "filename": f"xiuxian-messages-{suffix_mode}-{suffix_chan}-{ts}.txt",
            }

        # jsonl 默认
        out_lines = []
        for seq, card in cards:
            payload = card.to_api()
            payload["seq"] = seq
            out_lines.append(json.dumps(payload, ensure_ascii=False))
        body = ("\n".join(out_lines) + ("\n" if out_lines else "")).encode("utf-8")
        return {
            "body": body,
            "content_type": "application/x-ndjson; charset=utf-8",
            "filename": f"xiuxian-messages-{suffix_mode}-{suffix_chan}-{ts}.jsonl",
        }

    def outbox_payload(self) -> dict:
        return {
            "items": [public_outbox_draft(item) for item in self._store.list_outbox_drafts()],
            "capabilities": {
                "manual_copy": True,
                "reply_context": True,
                "manual_api_reply": True,
                "official_schedule": False,
                "direct_send": False,
            },
            "note": "发送出口未接入自动发送。动作会保留目标群、回复消息和建议身份上下文，UI 可先解析手动回复计划。",
        }

    def outbox_plan_payload(self, payload: dict) -> dict:
        try:
            plan = self._outbox.plan(payload)
            return plan.to_api(public_account=public_account, public_identity=public_identity)
        except ValueError as exc:
            return {"ok": False, "error": str(exc)}

    def outbox_drafts_payload(self, status: str = "draft") -> dict:
        return {
            "ok": True,
            "drafts": [
                public_outbox_draft(item)
                for item in self._store.list_outbox_drafts(status)
            ],
        }

    def create_outbox_draft_payload(self, payload: dict) -> dict:
        plan = self._outbox.plan(payload)
        plan_payload = plan.to_api(public_account=public_account, public_identity=public_identity)
        source_message_id = _source_message_id_from_payload(payload)
        draft = self._store.save_outbox_draft(
            {
                **plan_payload,
                "source_message_id": source_message_id,
                "status": "draft",
            }
        )
        return {"ok": True, "draft": public_outbox_draft(draft)}

    def delete_outbox_draft_payload(self, payload: dict) -> dict:
        draft_id = str(payload.get("id") or payload.get("draft_id") or "").strip()
        deleted = self._store.delete_outbox_draft(draft_id)
        return {"ok": deleted, "deleted": deleted}

    def settings_payload(self) -> dict:
        return {"settings": public_settings(self._store.get_settings())}

    def state_patches_payload(self, scope: str = "", *, send_as_id: int = 0) -> dict:
        return {
            "ok": True,
            "state": self._store.list_state_patches(scope, send_as_id=send_as_id),
        }

    def resource_stats_payload(
        self,
        *,
        period: str = "day",
        source_type: str = "",
        source_name: str = "",
        limit: int = 120,
    ) -> dict:
        if not hasattr(self._store, "resource_stats"):
            return {"ok": False, "error": "store does not support resource stats", "rows": []}
        return self._store.resource_stats(
            period=period,
            source_type=source_type,
            source_name=source_name,
            limit=limit,
        )

    def resource_coverage_payload(self, *, limit: int = 5000) -> dict:
        if not hasattr(self._store, "resource_coverage"):
            return {"ok": False, "error": "store does not support resource coverage", "rows": []}
        return self._store.resource_coverage(limit=limit)

    def resource_reparse_payload(self, payload: dict | None = None) -> dict:
        payload = payload or {}
        try:
            limit = int(payload.get("limit") or 5000)
        except (TypeError, ValueError):
            limit = 5000
        if not hasattr(self._store, "reparse_missing_resource_records"):
            return {"ok": False, "error": "store does not support resource reparse"}
        return self._store.reparse_missing_resource_records(limit=limit)

    def _dungeon_status_rows(self, *, limit: int = 500) -> list[tuple[int, ParsedCard]]:
        try:
            limit = int(limit or 500)
        except (TypeError, ValueError):
            limit = 500
        limit = max(1, min(limit, 2000))
        if hasattr(self._store, "list_card_page"):
            page = self._store.list_card_page(channel="dungeon", limit=limit)
            return [(int(seq), card) for seq, card in page]
        cards = self._store.list_cards("dungeon")
        return [(idx + 1, card) for idx, card in enumerate(reversed(cards[-limit:]))]

    def dungeon_status_payload(self, *, limit: int = 500, summary_limit: int = 80, order: str = "priority") -> dict:
        """从消息箱副本卡片派生当前副本状态。

        这仍然不是自动状态机,但聚合逻辑放在后端,避免前端每次临时推断且
        能被测试覆盖。`.加入副本` 动作只算「可操作」,只有天尊明确回复
        「加入副本成功/失败」才会改变 joined/failed。
        """
        try:
            limit = int(limit or 500)
        except (TypeError, ValueError):
            limit = 500
        limit = max(1, min(limit, 2000))
        try:
            summary_limit = int(summary_limit or 80)
        except (TypeError, ValueError):
            summary_limit = 80
        summary_limit = max(1, min(summary_limit, 200))
        order = "recent" if str(order or "").strip() == "recent" else "priority"
        rows = self._dungeon_status_rows(limit=limit)
        context_finder = None if order == "recent" and summary_limit <= 3 else self._find_latest_dungeon_open_context
        summaries = _aggregate_dungeon_status_rows(rows, context_finder=context_finder, order=order)
        self._hydrate_dungeon_summaries(summaries)
        if hasattr(self._store, "replace_dungeon_rooms"):
            try:
                self._store.replace_dungeon_rooms(summaries)
            except Exception as exc:
                print(f"[mini-web] dungeon room cache refresh failed: {exc}")
        total_summaries = len(summaries)
        visible_summaries = summaries[:summary_limit]
        return {
            "ok": True,
            "source": "derived_from_messages",
            "raw_count": len(rows),
            "summary_limit": summary_limit,
            "order": order,
            "total_summaries": total_summaries,
            "summaries": visible_summaries,
            "notes": [
                "副本状态只从消息箱派生,不自动加入。",
                ".加入副本 只算请求/动作,必须等天尊回复成功或失败后才更新状态。",
            ],
        }

    def _find_latest_dungeon_open_context(self, card: ParsedCard, seq: int, dungeon_name: str) -> dict:
        finder = getattr(self._store, "find_latest_dungeon_open_context", None)
        if not callable(finder):
            return {}
        try:
            return finder(dungeon_name, chat_id=card.chat_id, before_seq=seq) or {}
        except Exception:
            return {}

    def _hydrate_dungeon_summaries(self, summaries: list[dict]) -> None:
        finder = getattr(self._store, "find_dungeon_context_by_id", None)
        if not callable(finder):
            return
        weak_names = {"", "副本", "加入副本成功", "加入副本失败", "副本房间解散"}
        for summary in summaries:
            dungeon_id = str(summary.get("dungeon_id") or "").strip()
            if not dungeon_id:
                continue
            if (
                str(summary.get("dungeon_name") or "") not in weak_names
                and summary.get("opened_by")
                and summary.get("capacity")
            ):
                continue
            try:
                context = finder(dungeon_id, before_seq=int(summary.get("latest_seq") or 0))
            except TypeError:
                context = finder(dungeon_id)
            except Exception:
                context = {}
            if not context:
                continue
            if str(summary.get("dungeon_name") or "") in weak_names and context.get("dungeon_name"):
                summary["dungeon_name"] = context["dungeon_name"]
                summary["context_source"] = "open_lookup"
            for target, source in (
                ("opened_by", "opened_by"),
                ("capacity", "capacity"),
                ("oracle", "oracle"),
                ("advice", "advice"),
            ):
                if not summary.get(target) and context.get(source):
                    summary[target] = context[source]
                    summary["context_source"] = "open_lookup"

    def inventory_payload(
        self,
        *,
        owner: str = "",
        latest_only: bool = True,
        limit: int = 80,
    ) -> dict:
        if not hasattr(self._store, "list_inventory_snapshots"):
            return {"ok": False, "error": "store does not support inventory", "snapshots": []}
        snapshots = self._store.list_inventory_snapshots(
            owner=owner,
            latest_only=latest_only,
            include_items=True,
            limit=limit,
        )
        return {
            "ok": True,
            "snapshots": snapshots,
            "notes": [
                "库存来自最近一次 .储物袋 面板,不是实时账本。",
                "生成转移命令不会自动发送,也不会自动核减库存。",
            ],
        }

    def inventory_transfer_plan_payload(self, payload: dict) -> dict:
        try:
            plan = build_inventory_transfer_plan(payload)
            return {"ok": True, **plan}
        except ValueError as exc:
            return {"ok": False, "error": str(exc)}

    def discovered_bots_payload(self) -> dict:
        """从消息箱「自动发现」可能是游戏 bot 的 sender(必须真的产出过游戏关键词消息,
        参考 backend/repo/bot_hints.py),每条带「是否已被标记为 game bot」标志。
        前端勾选 → POST /api/settings 写 game_bot_ids 列表。chat UI 用此区分
        韩天尊 vs 普通玩家。

        额外:把 game_bot_ids 里手动添加但消息箱还没收到过 / 命中过的 sender 也并进列表,
        免得用户标记了找不到。"""
        discovered = self._store.list_discovered_bots()
        discovered_ids = {item["sender_id"] for item in discovered}
        marked: set[int] = set()
        for raw in self._store.get_settings().get("game_bot_ids") or []:
            try:
                marked.add(int(raw))
            except (TypeError, ValueError):
                continue
        for item in discovered:
            item["is_game_bot"] = item["sender_id"] in marked
            item["manual_only"] = False
        for sender_id in marked:
            if sender_id in discovered_ids:
                continue
            discovered.append(
                {
                    "sender_id": sender_id,
                    "last_source": "(手动添加,消息箱里还没采到过这个 sender 的游戏消息)",
                    "message_count": 0,
                    "last_seen": "",
                    "kind": "channel" if sender_id < 0 else "bot",
                    "is_game_bot": True,
                    "manual_only": True,
                    "hit_count": 0,
                    "matched_families": [],
                }
            )
        return {
            "ok": True,
            "discovered": discovered,
            "marked_count": sum(1 for item in discovered if item["is_game_bot"]),
        }

    def save_settings_payload(self, payload: dict) -> dict:
        before = self._store.get_settings()
        patch = preserve_existing_secrets(payload, self._store.get_settings())
        saved = self._store.save_settings(patch)
        rebuilt = 0
        filter_keys = {
            "own_aliases",
            "leader_sender_ids",
            "leader_source_names",
            "focus_muted_sender_ids",
            "focus_muted_source_names",
            "focus_keywords",
            "focus_exclude_patterns",
            "focus_include_player_plain",
            "archive_dot_commands",
            "archive_bot_replies",
            "game_bot_ids",
        }
        if any(saved.get(key) != before.get(key) for key in filter_keys):
            reclassify = getattr(self._store, "reclassify_message_filters", None)
            if callable(reclassify):
                rebuilt = int(reclassify() or 0)
        return {"ok": True, "settings": public_settings(saved), "rebuilt_messages": rebuilt}

    def schedule_templates_payload(self) -> dict:
        if not hasattr(self._store, "list_schedule_templates"):
            return {"ok": False, "error": "store does not support schedule templates", "templates": []}
        return {"ok": True, "templates": self._store.list_schedule_templates()}

    def schedule_template_save_payload(self, payload: dict) -> dict:
        if not hasattr(self._store, "save_schedule_templates"):
            return {"ok": False, "error": "store does not support schedule templates"}
        template = payload.get("template") if isinstance(payload.get("template"), dict) else payload
        name = str(template.get("name") or "").strip()
        if not name:
            return {"ok": False, "error": "请输入模板名称"}
        template_id = str(template.get("id") or "").strip()
        if not template_id:
            import time as _time
            template_id = f"tpl-{int(_time.time() * 1000)}"
        payload_data = dict(template.get("payload") or template)
        for key in ("name", "id", "template", "updated_at"):
            payload_data.pop(key, None)
        import time as _time
        existing = {item["id"]: item for item in self._store.list_schedule_templates()}
        existing[template_id] = {
            "id": template_id,
            "name": name,
            "payload": payload_data,
            "updated_at": _time.time(),
        }
        templates = self._store.save_schedule_templates(list(existing.values()))
        return {"ok": True, "templates": templates}

    def schedule_template_delete_payload(self, payload: dict) -> dict:
        if not hasattr(self._store, "save_schedule_templates"):
            return {"ok": False, "error": "store does not support schedule templates"}
        template_id = str(payload.get("id") or payload.get("template_id") or "").strip()
        if not template_id:
            return {"ok": False, "error": "请提供模板 id"}
        templates = [item for item in self._store.list_schedule_templates() if item["id"] != template_id]
        saved = self._store.save_schedule_templates(templates)
        return {"ok": True, "templates": saved}

    def focus_exclude_preview_payload(self, payload: dict) -> dict:
        mode = str(payload.get("mode") or "exact").strip().lower()
        raw_text = str(payload.get("text") or payload.get("phrase") or payload.get("pattern") or "").strip()
        if not raw_text:
            return {"ok": False, "error": "请输入要归档的内容"}
        if mode == "contains":
            pattern = re.escape(raw_text)
            label = f"包含短语：{raw_text}"
        elif mode == "regex":
            pattern = raw_text
            label = f"正则：{raw_text}"
        else:
            pattern = f"^{re.escape(raw_text)}$"
            label = f"完全相同：{raw_text}"
        preview = self._store.preview_focus_exclude_pattern(pattern)
        return {
            **preview,
            "mode": mode,
            "label": label,
        }

    def filter_diagnostics_payload(self, *, limit: int = 1000) -> dict:
        try:
            limit = int(limit or 1000)
        except (TypeError, ValueError):
            limit = 1000
        limit = max(1, min(limit, 5000))
        settings = self._store.get_settings()
        focus_keywords = [str(item).strip() for item in settings.get("focus_keywords") or [] if str(item or "").strip()]
        own_aliases = [str(item).strip().lstrip("@") for item in settings.get("own_aliases") or [] if str(item or "").strip()]
        leader_ids = {int(x) for x in settings.get("leader_sender_ids") or [] if str(x).strip()}
        leader_names = {str(x).strip() for x in settings.get("leader_source_names") or [] if str(x).strip()}

        if hasattr(self._store, "list_card_page"):
            rows = self._store.list_card_page(limit=limit)
        else:
            rows = list(enumerate(self._store.list_cards(), start=1))[:limit]

        scanned = 0
        focus = 0
        archive = 0
        leader = 0
        reason_counter: dict[str, int] = {}
        focus_sender_counter: dict[tuple[int, str], dict] = {}
        samples: list[dict] = []

        for seq, card in rows:
            scanned += 1
            reasons = list(card.filter_reasons or ()) or _fallback_filter_reasons(card)
            channels = set(card.channels or ())
            tags = set(card.tags or ())
            sender_id = int(card.sender_id or 0)
            source = str(card.source or "")
            if "focus" in channels:
                focus += 1
            if "archive" in channels:
                archive += 1
            if "leader" in channels:
                leader += 1
            for reason in reasons:
                reason_counter[reason] = reason_counter.get(reason, 0) + 1
            if "focus" in channels and source:
                key = (sender_id, source)
                sender_row = focus_sender_counter.setdefault(
                    key,
                    {"sender_id": sender_id, "source": source, "count": 0},
                )
                sender_row["count"] = int(sender_row.get("count") or 0) + 1
            if len(samples) < 12 and ("focus" in channels or "archive" in channels or "leader" in channels):
                samples.append(
                    {
                        "seq": int(seq),
                        "id": card.id,
                        "title": card.title,
                        "source": source,
                        "sender_id": sender_id,
                        "channels": list(card.channels or ()),
                        "tags": list(tags),
                        "reasons": reasons,
                        "summary": card.summary,
                    }
                )

        return {
            "ok": True,
            "limit": limit,
            "scanned": scanned,
            "focus_count": focus,
            "archive_count": archive,
            "leader_count": leader,
            "focus_keyword_count": len(focus_keywords),
            "own_alias_count": len(own_aliases),
            "leader_sender_count": len(leader_ids),
            "leader_name_count": len(leader_names),
            "reason_rows": [
                {"reason": reason, "count": count}
                for reason, count in sorted(reason_counter.items(), key=lambda item: (-item[1], item[0]))
            ],
            "focus_sender_rows": [
                {**item, "sender": f"{item.get('source') or '(未知)'}｜{item.get('sender_id') or 'unknown'}"}
                for item in sorted(
                    focus_sender_counter.values(),
                    key=lambda row: (-int(row.get("count") or 0), str(row.get("source") or "")),
                )
            ],
            "samples": samples,
            "notes": [
                "重点流的判定依赖 filter_reasons 和频道标签,这里展示最近样本的归类理由。",
                "会长频道只按 sender_id 判定,用户名备注只用于展示。",
            ],
        }

    def accounts_payload(self) -> dict:
        self._ensure_collector_running()
        return {
            "accounts": [public_account(account) for account in self._store.list_accounts()],
            "max_accounts": MAX_ACCOUNTS,
            "max_listeners": MAX_LISTENERS,
            "listener": self._listeners.status(),
        }

    def identities_payload(self) -> dict:
        accounts = self._store.list_accounts()
        accounts_by_local_id = {
            account["local_id"]: public_account(account) for account in accounts
        }
        accounts_by_account_id: dict[int, dict] = {}
        for account in accounts:
            account_id_text = str(account.get("account_id") or "").strip()
            if not account_id_text:
                continue
            try:
                accounts_by_account_id[int(account_id_text)] = account
            except ValueError:
                continue
        identities = []
        for identity in self._store.list_identities():
            item = public_identity(identity)
            item["account"] = accounts_by_local_id.get(identity.get("account_local_id") or "")
            item["kind"] = classify_identity_kind(identity, accounts_by_account_id)
            identities.append(item)
        return {
            "identities": identities,
            "max_identities": MAX_IDENTITIES,
        }

    def identity_state_payload(self, send_as_id_text: str = "") -> dict:
        """每个 (identity, module) 的当前 state + status_summary。

        - 不传 send_as_id:返所有身份的状态(供 UI 一次性渲染侧边栏)
        - 传了:只返该身份的
        """
        import time as _t
        registry = self._store.module_registry()
        modules = registry.all() if registry else []
        module_by_key = {m.key: m for m in modules}
        try:
            target_send_as = int(send_as_id_text or 0)
        except (TypeError, ValueError):
            target_send_as = 0

        records = self._store.list_module_states(send_as_id=target_send_as)
        by_identity: dict[int, list[dict]] = {}
        now = _t.time()
        for record in records:
            sid = int(record.get("send_as_id") or 0)
            key = str(record.get("module_key") or "")
            module = module_by_key.get(key)
            state = record.get("state") or {}
            entry = {
                "module_key": key,
                "label": module.label if module else key,
                "state": state,
                "summary": module.status_summary(state, now=now) if module else None,
                "source_message_id": record.get("source_message_id") or "",
                "updated_at": float(record.get("updated_at") or 0),
            }
            by_identity.setdefault(sid, []).append(entry)
        return {
            "ok": True,
            "modules": [
                {"key": m.key, "label": m.label, "default_state": dict(m.default_state)}
                for m in modules
            ],
            "by_identity": [
                {"send_as_id": sid, "items": items}
                for sid, items in sorted(by_identity.items())
            ],
        }

    def save_account_payload(self, payload: dict) -> dict:
        local_id = account_local_id_from_payload(payload)
        if not local_id:
            raise ValueError("请填写 local_id、session 名称或手机号")
        current = self._store.get_account(local_id)
        if current is None:
            if len(self._store.list_accounts()) >= MAX_ACCOUNTS:
                raise ValueError(f"账号数量已达上限 {MAX_ACCOUNTS} 个")
        patch = preserve_existing_secrets({**payload, "local_id": local_id}, current or {})
        account = self._store.save_account(patch)
        if _username_changed(current, account):
            self._reclassify_message_filters()
        return {"ok": True, "account": public_account(account)}

    def delete_account_payload(self, payload: dict) -> dict:
        local_id = str(payload.get("local_id") or "").strip()
        if not local_id:
            return {"ok": False, "error": "请提供 local_id"}
        # 如果该账号正在采集,先停掉以释放 session
        listeners = self._listeners.status()
        running = listeners.get("running") or {}
        if local_id in running and str(running[local_id].get("status") or "") in {"starting", "running"}:
            self._listeners.stop(local_id)
        deleted = self._store.delete_account(local_id) if hasattr(self._store, "delete_account") else False
        return {"ok": deleted, "deleted": deleted}

    def logout_account_payload(self, payload: dict) -> dict:
        """登出 = 停 listener + 删 session 文件 + 重置 login_status,
        但保留 account 配置和绑定的 identity 记录,以便重新登录后继续用。
        """
        local_id = str(payload.get("local_id") or "").strip()
        if not local_id:
            return {"ok": False, "error": "请提供 local_id"}
        account = self._store.get_account(local_id)
        if account is None:
            return {"ok": False, "error": "账号不存在"}

        listeners = self._listeners.status()
        running = listeners.get("running") or {}
        if local_id in running and str(running[local_id].get("status") or "") in {"starting", "running"}:
            self._listeners.stop(local_id)

        # 清 session 文件,让下次重新登录拿到全新 session
        try:
            from pathlib import Path
            from backend.tg.client import session_path
            session_file = Path(session_path(account) + ".session")
            if session_file.exists():
                session_file.unlink()
        except Exception:
            pass

        # 关联的 identities 数量(只是反馈给前端展示,不删它们)
        bound_identities = [
            identity for identity in self._store.list_identities()
            if str(identity.get("account_local_id") or "") == local_id
        ]

        updated = self._store.save_account(
            {
                **account,
                "account_id": "",
                "login_status": "idle",
                "login_message": "已登出",
                "listen_enabled": False,
                "listener_status": "stopped",
                "listener_message": "登出后采集已停止",
            }
        )
        return {
            "ok": True,
            "account": public_account(updated),
            "bound_identities": len(bound_identities),
        }

    def save_identity_payload(self, payload: dict) -> dict:
        send_as_id = coerce_send_as_id(payload.get("send_as_id") or payload.get("id"))
        if send_as_id == 0:
            raise ValueError("身份 ID 必须是数字")
        current = self._store.get_identity(send_as_id)
        if current is None and len(self._store.list_identities()) >= MAX_IDENTITIES:
            raise ValueError(f"身份数量已达上限 {MAX_IDENTITIES} 个")
        account_local_id = str(payload.get("account_local_id") or "").strip()
        if account_local_id and self._store.get_account(account_local_id) is None:
            raise ValueError("绑定账号不存在，请先保存 Telegram 账号")
        identity = self._store.save_identity({**payload, "send_as_id": send_as_id})
        if _username_changed(current, identity):
            self._reclassify_message_filters()
        return {"ok": True, "identity": public_identity(identity)}

    def batch_save_identities_payload(self, payload: dict) -> dict:
        """「新增身份」模态框:用户在 send_as 列表勾选多条,前端一次性提交
        → 后端逐条 save_identity,每条独立返回 ok / error,某一条失败不阻塞其他条。"""
        raw_items = payload.get("identities")
        if not isinstance(raw_items, list) or not raw_items:
            return {"ok": False, "error": "请提供 identities 列表", "results": []}

        results: list[dict] = []
        saved = 0
        for index, item in enumerate(raw_items):
            if not isinstance(item, dict):
                results.append({"index": index, "ok": False, "error": "条目必须是对象"})
                continue
            try:
                outcome = self.save_identity_payload(item)
                results.append(
                    {
                        "index": index,
                        "ok": True,
                        "identity": outcome.get("identity"),
                        "send_as_id": (outcome.get("identity") or {}).get("send_as_id"),
                    }
                )
                saved += 1
            except ValueError as exc:
                results.append(
                    {
                        "index": index,
                        "ok": False,
                        "error": str(exc),
                        "send_as_id": item.get("send_as_id"),
                    }
                )
        return {"ok": True, "saved": saved, "total": len(raw_items), "results": results}

    def delete_identity_payload(self, payload: dict) -> dict:
        send_as_id = coerce_send_as_id(payload.get("send_as_id") or payload.get("id"))
        if send_as_id == 0:
            raise ValueError("身份 ID 必须是数字")
        deleted = self._store.delete_identity(send_as_id)
        return {"ok": deleted, "deleted": deleted}

    async def telegram_dialogs_payload(self) -> dict:
        try:
            return await self._dialogs.list_dialogs(self._store.get_settings())
        except Exception as exc:
            return {"ok": False, "error": str(exc), "dialogs": []}

    async def telegram_topics_payload(self, chat: str | None = None) -> dict:
        try:
            return await self._dialogs.list_topics(self._store.get_settings(), chat=chat)
        except Exception as exc:
            return {"ok": False, "error": str(exc), "topics": []}

    def account_dialogs_payload(self, local_id: str) -> dict:
        """「读取群 / 频道」按钮:用账号的 session 拉它能看到的所有
        群/频道,供「监听目标」picker 使用。
        如果该账号 listener 已经在跑,直接复用其 client,避免新开 client 抢
        Telethon session SQLite → "database is locked"。"""
        try:
            account = self._require_account(local_id)
            listener = self._listeners.get_listener(local_id)
            if listener is not None:
                return listener.submit(lambda client: self._dialogs.list_dialogs_on_client(client))
            import asyncio
            return asyncio.run(self._dialogs.list_dialogs(account))
        except Exception as exc:
            return {"ok": False, "error": str(exc), "dialogs": []}

    def account_topics_payload(self, local_id: str, chat: str | None = None) -> dict:
        try:
            account = self._require_account(local_id)
            target = str(chat or account.get("target_chat") or "").strip()
            if not target:
                return {"ok": False, "error": "请先选择目标群 / 频道", "topics": []}
            listener = self._listeners.get_listener(local_id)
            if listener is not None:
                return listener.submit(
                    lambda client: self._dialogs.list_topics_on_client(client, target)
                )
            import asyncio
            return asyncio.run(self._dialogs.list_topics(account, chat=target))
        except Exception as exc:
            return {"ok": False, "error": str(exc), "topics": []}

    def account_send_as_peers_payload(
        self, local_id: str, target_chat: str = ""
    ) -> dict:
        """按 account_local_id 拿登录态,调 channels.GetSendAs(target_chat) 拉可用
        send_as 列表。listener 在跑就复用 listener client,避免 session 锁。"""
        try:
            account = self._require_account(local_id)
            chat = str(target_chat or account.get("target_chat") or "").strip()
            if not chat:
                return {"ok": False, "error": "请先在该账号上配置目标群,或在请求里指定 target_chat", "peers": []}
            listener = self._listeners.get_listener(local_id)
            if listener is not None:
                return listener.submit(
                    lambda client: self._send_as.list_send_as_peers_on_client(client, chat)
                )
            import asyncio
            return asyncio.run(self._send_as.list_send_as_peers(account, chat))
        except Exception as exc:
            return {"ok": False, "error": str(exc), "peers": []}

    def account_resolve_entity_payload(self, payload: dict) -> dict:
        """给定一个 send_as_id,用账号 session 调 get_entity 拉 username/title。
        listener 在跑就复用,避免 session 锁。"""
        try:
            account = self._require_account(payload.get("local_id"))
            send_as_id = int(payload.get("send_as_id") or 0)
            if send_as_id == 0:
                return {"ok": False, "error": "请先填写 send_as_id"}
            listener = self._listeners.get_listener(account["local_id"])
            if listener is not None:
                return listener.submit(
                    lambda client: self._send_as.resolve_entity_on_client(client, send_as_id)
                )
            import asyncio
            return asyncio.run(self._send_as.resolve_entity(account, send_as_id))
        except Exception as exc:
            return {"ok": False, "error": str(exc)}

    def login_start_payload(self) -> dict:
        try:
            result = self._login.send_code(self._store.get_settings())
            self._store.save_settings(
                {
                    "login_status": result["status"],
                    "login_message": result["message"],
                    "login_account_id": "",
                }
            )
            return {"ok": True, **result}
        except Exception as exc:
            self._store.save_settings({"login_status": "error", "login_message": str(exc)})
            return {"ok": False, "error": str(exc)}

    def account_login_start_payload(self, payload: dict) -> dict:
        try:
            account = self._require_account(payload.get("local_id"))
            result = self._login.send_code(account, key=account["local_id"])
            account = self._store.save_account(
                {
                    **account,
                    "login_status": result["status"],
                    "login_message": result["message"],
                    "account_id": "",
                }
            )
            return {"ok": True, **result, "account": public_account(account)}
        except Exception as exc:
            self._mark_account_login_error(payload.get("local_id"), str(exc))
            return {"ok": False, "error": str(exc)}

    def login_verify_payload(self, payload: dict) -> dict:
        try:
            result = self._login.verify_code(
                str(payload.get("code") or ""),
                password=payload.get("password"),
            )
            patch = {
                "login_status": result["status"],
                "login_message": result["message"],
                "login_account_id": result.get("account_id") or "",
            }
            self._store.save_settings(patch)
            return {"ok": result["status"] != "need_2fa", **result}
        except Exception as exc:
            self._store.save_settings({"login_status": "error", "login_message": str(exc)})
            return {"ok": False, "error": str(exc)}

    def account_login_verify_payload(self, payload: dict) -> dict:
        try:
            account = self._require_account(payload.get("local_id"))
            result = self._login.verify_code(
                str(payload.get("code") or ""),
                password=payload.get("password"),
                key=account["local_id"],
            )
            patch = {
                **account,
                "login_status": result["status"],
                "login_message": result["message"],
                "account_id": result.get("account_id") or account.get("account_id") or "",
                "username": result.get("username") or account.get("username") or "",
            }
            account = self._store.save_account(patch)
            if result["status"] == "done":
                self._ensure_self_identity(account)
            return {"ok": result["status"] != "need_2fa", **result, "account": public_account(account)}
        except Exception as exc:
            self._mark_account_login_error(payload.get("local_id"), str(exc))
            return {"ok": False, "error": str(exc)}

    def login_cancel_payload(self) -> dict:
        result = self._login.cancel()
        self._store.save_settings(
            {
                "login_status": result["status"],
                "login_message": result["message"],
                "login_account_id": "",
            }
        )
        return {"ok": True, **result}

    def account_login_cancel_payload(self, payload: dict) -> dict:
        local_id = str(payload.get("local_id") or "").strip()
        result = self._login.cancel(local_id)
        account = self._store.get_account(local_id)
        if account:
            account = self._store.save_account(
                {
                    **account,
                    "login_status": result["status"],
                    "login_message": result["message"],
                }
            )
        return {"ok": True, **result, "account": public_account(account) if account else None}

    def listener_status_payload(self) -> dict:
        self._ensure_collector_running()
        listeners = self._listeners.status()
        collector_key = str(listeners.get("collector") or "")
        return {
            "ok": True,
            "listener": self._listeners.status(collector_key) if collector_key else {"status": "stopped", "message": ""},
            "listeners": listeners,
        }

    # ---------- 官方定时(Telegram scheduled message)----------

    def _dedupe_schedule_seconds(self, items: list[dict]) -> int:
        """让 items 里的 schedule_at(秒级)跟当前所有 active scheduled_messages 全局唯一。
        撞秒就 +1s 一直直到独占。返回调整过的条数。

        Why
        ---
        多账号同时下定时,jitter 把分布拉开但不保证唯一秒。撞秒会让天尊
        同时收到多条指令处理不过来 — 用户说「60 号内只要别在同一秒就行」。
        """
        try:
            existing = self._store.list_schedule_messages(include_inactive=False)
        except Exception:
            return 0
        used: set[int] = set()
        for m in existing:
            try:
                used.add(int(float(m.get("schedule_at") or 0)))
            except (TypeError, ValueError):
                continue
        adjusted = 0
        for item in items:
            try:
                ts = float(item.get("schedule_at") or 0)
            except (TypeError, ValueError):
                continue
            sec = int(ts)
            bumped = False
            while sec in used:
                sec += 1
                bumped = True
            if bumped:
                # 保留小数部分,在新整数秒上加微小 jitter 避免严格 .000(更像人)
                item["schedule_at"] = float(sec) + (ts - int(ts))
                adjusted += 1
            used.add(sec)
        return adjusted

    def _resolve_module_anchor(self, send_as_id: int, module_key: str) -> float | None:
        """给 schedule.build_plan 当 auto_anchor 用:读 (send_as_id, module) 的 state,
        让对应 module 算下一次可用绝对时间。没观测过 / 没该 module 返 None。"""
        registry = self._store.module_registry()
        module = registry.get(module_key) if registry else None
        if module is None:
            return None
        record = self._store.get_module_state(send_as_id, module_key)
        if not record:
            return None
        state = record.get("state") or {}
        try:
            import time as _t
            return module.compute_anchor(state, now=_t.time())
        except Exception:
            return None

    def schedule_presets_payload(self) -> dict:
        return {"ok": True, "presets": list_schedule_presets()}

    def skills_payload(self) -> dict:
        return self._skill_registry.to_api()

    def notify_test_payload(self, payload: dict | None = None) -> dict:
        """对当前 notify 配置发一条测试通知,返回每个 channel 的结果。"""
        from backend.notifications import NotificationEvent

        payload = payload or {}
        title = str(payload.get("title") or "通知测试")
        body = str(payload.get("body") or "若收到此条,说明你的通知通道已配通。\n\n— mini-web 修仙助手")
        event = NotificationEvent(
            kind="test",
            title=title,
            body=body,
            source_id=f"test-{int(utc_now_iso().__hash__()) & 0xFFFFFFFF}",
            severity=str(payload.get("severity") or "success"),
        )
        notifiers = self._notify.list_notifiers()
        if not notifiers:
            return {"ok": False, "error": "未启用通知或未配置 channel", "results": []}
        results = []
        for n in notifiers:
            ok, err = n.notify(event)
            results.append({"channel": n.name, "ok": ok, "error": err})
        return {"ok": all(r["ok"] for r in results), "results": results}

    def notify_card_titles_payload(self) -> dict:
        """返回当前 registry 里所有 parser 会生成的卡片标题,给 UI 当 toggle 列表用。"""
        # 静态列表;新加 parser 时同步加在这里(避免引入 parser 自省的复杂度)
        titles = [
            "风险提醒", "天道审判",
            "玄骨考校", "天机考验",
            "极阴祖师", "南陇侯", "共历心劫",
            "境界突破", "赐予道号",
            "深度闭关总结", "闭关成功",
            "试炼古塔战报",
            "虚天殿开启", "黄龙山开启", "昆吾山开启", "坠魔谷开启", "血色试炼开启",
            "虚天殿推进", "黄龙山推进", "昆吾山推进", "坠魔谷推进", "血色试炼推进",
            "副本静场令", "加入副本成功", "加入副本失败", "副本房间解散",
            "第二元神归位", "角色信息", "战力评估", "储物袋快照",
            "登天阶面板", "观星台面板", "星盘显化", "天机阁快报",
            "小世界面板", "侍妾面板", "灵树面板", "灵树采摘",
            "抚摸法宝", "温养器灵", "器灵试炼",
            "引动大道", "空间节点", "定星成功",
        ]
        return {"ok": True, "titles": titles}

    def skill_send_payload(self, payload: dict) -> dict:
        payload = payload or {}
        skill_key = str(payload.get("skill_key") or "").strip()
        if not skill_key:
            return {"ok": False, "error": "缺少 skill_key"}
        if self._skill_registry.get(skill_key) is None:
            return {"ok": False, "error": f"未知技能 key: {skill_key}"}

        try:
            identity_id = int(str(payload.get("identity_id") or 0).strip())
        except (TypeError, ValueError):
            return {"ok": False, "error": "identity_id 必须是数字"}

        identity = self._store.get_identity(identity_id) if identity_id else None
        if identity is None:
            return {"ok": False, "error": f"找不到 identity {identity_id},请先在身份列表里注册"}

        account_local_id = str(identity.get("account_local_id") or "").strip()
        if not account_local_id:
            return {"ok": False, "error": "identity 没绑定 account_local_id,无法定位 listener"}

        account = self._store.get_account(account_local_id)
        if account is None:
            return {"ok": False, "error": f"找不到 account {account_local_id}"}

        try:
            account_id = int(str(account.get("account_id") or 0).strip())
        except (TypeError, ValueError):
            account_id = 0
        if account_id == 0:
            return {"ok": False, "error": "account_id 为空,请先确认该 Telegram 账号已登录成功"}
        send_as_id = 0 if identity_id == account_id else identity_id

        chat_id_raw = payload.get("chat_id") or account.get("target_chat") or ""
        try:
            chat_id = int(str(chat_id_raw).strip())
        except (TypeError, ValueError):
            return {"ok": False, "error": "缺少 chat_id 或 account.target_chat"}

        try:
            topic_id = int(str(payload.get("top_msg_id") or account.get("target_topic_id") or 0).strip())
        except (TypeError, ValueError):
            topic_id = 0

        reply_to = payload.get("reply_to_msg_id")
        command_override = str(payload.get("command_override") or "").strip()

        result = self._skill_send.send(
            skill_key=skill_key,
            chat_id=chat_id,
            account_local_id=account_local_id,
            sender_id=identity_id,
            send_as_id=send_as_id,
            sender_display=str(identity.get("label") or account.get("label") or "我"),
            account_key=account_local_id,
            reply_to_msg_id=reply_to,
            topic_id=topic_id,
            command_override=command_override,
        )
        api = result.to_api()
        # 顺手把 client.get_me() 抓到的真名 hydrate 回 account.label / identity.label
        # —— 之前两者都是手机号,UI 显示 +44... 很丑
        display = self._skill_send.last_display()
        if result.ok and display and identity_id == account_id:
            self._maybe_hydrate_account_display(account, identity, display)
        return api

    def _maybe_hydrate_account_display(
        self,
        account: dict,
        identity: dict,
        display: str,
    ) -> None:
        """如果 account.label 还是手机号(+xxx)就替换成 TG 真名;
        identity.label 同理。一旦用户手动改过(label 不是手机号)就保留,不覆盖。"""
        display = (display or "").strip()
        if not display:
            return

        def _looks_like_phone(s: object) -> bool:
            text = str(s or "").strip()
            return text.startswith("+") and text[1:].replace(" ", "").isdigit()

        if account is not None and _looks_like_phone(account.get("label")):
            try:
                self._store.save_account({**account, "label": display})
            except Exception as exc:
                print(f"[skill-send] hydrate account label failed: {exc}")
        if identity is not None and _looks_like_phone(identity.get("label")):
            try:
                self._store.save_identity({**identity, "label": display})
            except Exception as exc:
                print(f"[skill-send] hydrate identity label failed: {exc}")

    def schedule_preview_payload(self, payload: dict) -> dict:
        try:
            plan = build_schedule_plan(payload or {}, anchor_resolver=self._resolve_module_anchor)
            return {"ok": True, **plan}
        except Exception as exc:
            return {"ok": False, "error": str(exc), "items": []}

    def schedule_create_payload(self, payload: dict) -> dict:
        """单个或批量创建。
        - send_as_ids: [id, id, ...] 批量 — 每个 id 创建一个独立 batch
        - send_as_id: id  单个 — 兼容老接口
        批量时,每个身份基于 offset_minutes_base + i * offset_step_minutes 阶梯错峰。
        """
        payload = payload or {}
        sids_raw = payload.get("send_as_ids") or []
        if not sids_raw:
            single = payload.get("send_as_id")
            if single:
                sids_raw = [single]
        sids: list[int] = []
        for x in sids_raw:
            try:
                sid = int(x)
                if sid and sid not in sids:
                    sids.append(sid)
            except (TypeError, ValueError):
                continue
        if not sids:
            return {"ok": False, "error": "请选择至少一个 identity (send_as_id 或 send_as_ids)"}

        if len(sids) == 1:
            return self._create_one_schedule({**payload, "send_as_id": sids[0]})

        # 批量
        try:
            base_offset = max(0, int(payload.get("offset_minutes") or 0))
        except (TypeError, ValueError):
            base_offset = 0
        try:
            step = max(0, int(payload.get("offset_step_minutes") or 5))
        except (TypeError, ValueError):
            step = 5
        results: list[dict] = []
        ok_count = 0
        fail_count = 0
        total_estimate = 0
        for i, sid in enumerate(sids):
            sub = dict(payload)
            sub.pop("send_as_ids", None)
            sub["send_as_id"] = sid
            sub["offset_minutes"] = base_offset + i * step
            r = self._create_one_schedule(sub)
            r["send_as_id"] = sid
            r["offset_minutes_applied"] = sub["offset_minutes"]
            if r.get("ok"):
                ok_count += 1
                total_estimate += int(r.get("estimate_seconds") or 0)
            else:
                fail_count += 1
            results.append(r)
        return {
            "ok": fail_count == 0,
            "batch_count": len(results),
            "succeeded": ok_count,
            "failed": fail_count,
            "total_estimate_seconds": total_estimate,
            "offset_step_minutes": step,
            "results": results,
        }

    def _create_one_schedule(self, payload: dict) -> dict:
        """payload: {send_as_id, preset_key, anchor_at?, horizon_days?, pet_name?,
                     command?, interval_sec?, count?, dry_run?, offset_minutes?, trigger_command?, ...}
        - dry_run=True 或没有 listener 对应 client → 只在本地落 batch + planned items,不发 TG
        - dry_run=False 且 listener 在跑 → 后台拟人节奏排 Telegram scheduled message
        """
        try:
            send_as_id = int(payload.get("send_as_id") or 0)
            if send_as_id == 0:
                return {"ok": False, "error": "请选择 identity (send_as_id)"}

            # 找该身份归属的账号
            identity = self._store.get_identity(send_as_id)
            account_local_id = ""
            if identity:
                account_local_id = str(identity.get("account_local_id") or "")
            elif send_as_id > 0:
                # send_as_id 等于某 account.account_id → self-identity
                for account in self._store.list_accounts():
                    try:
                        if int(account.get("account_id") or 0) == send_as_id:
                            account_local_id = str(account.get("local_id") or "")
                            break
                    except (TypeError, ValueError):
                        continue

            plan = build_schedule_plan(payload or {}, anchor_resolver=self._resolve_module_anchor)
            preset_key = plan["preset_key"]
            label = PRESET_LABELS.get(preset_key, preset_key)

            dry_run = bool(payload.get("dry_run"))
            listener = self._listeners.get_listener(account_local_id) if account_local_id else None
            if listener is None:
                # 没 listener → 强制 dry_run(没 client 没法发 TG 端)
                dry_run = True

            items_for_db = [
                {
                    "command": item["command"],
                    "schedule_at": item["schedule_at"],
                    "status": "planned",
                    "scheduled_msg_id": 0,
                }
                for item in plan["items"]
            ]
            # 去重秒:让所有 active scheduled_messages 的 schedule_at(秒级)全局唯一,
            # 避免 N 个账号同一秒撞天尊。jitter 已经把分布拉开,这里只兜底极少数撞秒情况。
            self._dedupe_schedule_seconds(items_for_db)

            batch_id = self._store.create_schedule_batch(
                {
                    "send_as_id": send_as_id,
                    "account_local_id": account_local_id,
                    "preset_key": preset_key,
                    "label": label,
                    "anchor_at": plan["anchor_at"],
                    "horizon_days": plan["horizon_days"],
                    "options": {
                        "pet_name": payload.get("pet_name") or "",
                        "command": payload.get("command") or "",
                        "interval_sec": payload.get("interval_sec") or 0,
                        "count": payload.get("count") or 0,
                        "dry_run": dry_run,
                    },
                },
                items_for_db,
            )

            created_ids: list[int] = []
            send_errors: list[str] = []
            sending_status = "queued"
            if not dry_run and listener is not None:
                target_chat = self._store.get_settings().get("target_chat") or ""
                target_topic_id = self._store.get_settings().get("target_topic_id") or 0
                try:
                    target_topic_id = int(target_topic_id)
                except (TypeError, ValueError):
                    target_topic_id = 0
                if not target_chat:
                    return {
                        "ok": False,
                        "error": "settings.target_chat 未配置,无法定位发送目标群",
                        "batch_id": batch_id,
                        "items": items_for_db,
                    }
                msgs = self._store.list_schedule_messages(batch_id=batch_id, include_inactive=False)
                # 拟人节奏发送可能要 30+ 分钟,不能阻塞 HTTP 响应。
                # 走后台:listener loop 上 fire-and-forget,DB 实时更新每条状态,
                # 前端轮询 /api/schedule 看 planned/scheduled/failed 计数。
                self._store.set_schedule_batch_status(batch_id, "sending")
                try:
                    listener.submit_background(
                        lambda client: self._run_official_send_background(
                            client, batch_id, target_chat, target_topic_id, send_as_id, msgs
                        )
                    )
                    sending_status = "sending"
                except Exception as exc:
                    self._store.set_schedule_batch_status(batch_id, "failed")
                    return {
                        "ok": False,
                        "error": f"提交后台发送失败:{exc}",
                        "batch_id": batch_id,
                        "items": items_for_db,
                    }
            return {
                "ok": True,
                "batch_id": batch_id,
                "preset_key": preset_key,
                "preset_label": label,
                "dry_run": dry_run,
                "planned_count": len(items_for_db),
                "created_official": len(created_ids),
                "errors": send_errors,
                "status": "dry_run" if dry_run else sending_status,
                "estimate_seconds": _estimate_send_seconds(len(items_for_db)) if (not dry_run and listener is not None) else 0,
            }
        except Exception as exc:
            return {"ok": False, "error": str(exc)}

    async def _run_official_send_background(
        self,
        client,
        batch_id: int,
        target_chat,
        target_topic_id: int,
        send_as_id: int,
        messages: list[dict],
    ) -> None:
        """在 listener loop 上跑的后台发送。逐条排 + 实时更新 DB + 拟人节奏停顿。
        每次循环前看一眼 batch.status,如果被改成 cancelled / deleted 就早退。"""
        import asyncio as _asyncio
        from telethon import types as _types
        from backend.outbox.schedule import (
            humanized_send_pause,
            humanized_long_pause,
            next_long_pause_gap,
        )

        ok_count = 0
        fail_count = 0
        try:
            # GetSendAs precheck —— 错就早错,整批标失败
            try:
                peers_payload = await self._send_as.list_send_as_peers_on_client(
                    client, str(target_chat)
                )
                available_ids = {
                    int(p.get("send_as_id") or p.get("id") or 0)
                    for p in (peers_payload.get("peers") or [])
                }
                if send_as_id not in available_ids:
                    err = (
                        f"send_as_id {send_as_id} 不在该群可用 send_as 列表里。"
                        f"用「+ 新增身份」模态的「获取可用身份」按钮核对,或换登录账号。"
                    )
                    for m in messages:
                        self._store.mark_schedule_message(int(m["id"]), status="failed", last_error=err)
                    self._store.set_schedule_batch_status(batch_id, "failed")
                    return
            except Exception as exc:
                print(f"[mini-web] schedule precheck GetSendAs failed: {exc}")

            peer = await client.get_input_entity(int(target_chat) if str(target_chat).lstrip("-").isdigit() else target_chat)
            send_as_peer = await client.get_input_entity(send_as_id)
            reply_to = _types.InputReplyToMessage(reply_to_msg_id=target_topic_id) if target_topic_id > 0 else None

            countdown_to_long = next_long_pause_gap()
            last_index = len(messages) - 1
            for index, msg in enumerate(messages):
                # cancel / delete 早退
                current = self._store.list_schedule_batches(include_inactive=True)
                this_batch = next((b for b in current if b["id"] == batch_id), None)
                if this_batch and this_batch.get("status") in {"cancelled", "deleted"}:
                    print(f"[mini-web] schedule batch {batch_id} cancelled at {index}/{len(messages)}")
                    return

                db_id = int(msg["id"])
                command = str(msg.get("command") or "").strip()
                schedule_at = float(msg.get("schedule_at") or 0)
                if not command or schedule_at <= 0:
                    self._store.mark_schedule_message(db_id, status="failed", last_error="命令或时间无效")
                    fail_count += 1
                    continue
                try:
                    scheduled_msg_id = await self._schedule.create_one_on_client(
                        client,
                        peer=peer,
                        send_as_peer=send_as_peer,
                        reply_to=reply_to,
                        command=command,
                        schedule_at=schedule_at,
                    )
                    self._store.mark_schedule_message(
                        db_id, scheduled_msg_id=scheduled_msg_id, status="scheduled"
                    )
                    ok_count += 1
                except Exception as exc:
                    self._store.mark_schedule_message(db_id, status="failed", last_error=str(exc))
                    fail_count += 1

                if index < last_index:
                    countdown_to_long -= 1
                    if countdown_to_long <= 0:
                        pause = humanized_long_pause()
                        countdown_to_long = next_long_pause_gap()
                        print(f"[mini-web] schedule long pause {pause:.1f}s after #{index+1}/{len(messages)}")
                    else:
                        pause = humanized_send_pause()
                    await _asyncio.sleep(pause)
        finally:
            # 决定最终批次状态。
            # 但要先看当前 status —— 如果用户在中途 cancel 或 batch 被 delete,
            # 已经标 cancelled / deleted 的就别覆盖回 completed,否则前端看着像「复活」。
            try:
                current = self._store.list_schedule_batches(include_inactive=True)
                cur_status = next((b.get("status") for b in current if b["id"] == batch_id), "")
            except Exception:
                cur_status = ""
            if cur_status in {"cancelled", "deleted"}:
                return  # 用户取消或已删除 → 状态保持
            if ok_count and not fail_count:
                final = "completed"
            elif ok_count and fail_count:
                final = "partial_failed"
            elif fail_count and not ok_count:
                final = "failed"
            else:
                final = "completed"  # 0 条 — 标完成,batch 上能反映
            try:
                self._store.set_schedule_batch_status(batch_id, final)
            except Exception:
                pass

    async def _do_create_official_messages(
        self,
        client,
        target_chat,
        target_topic_id: int,
        send_as_id: int,
        messages: list[dict],
    ) -> list[tuple[int, int, str]]:
        """已废弃,留作 API 兼容。新流程用 _run_official_send_background 后台跑。"""
        raise NotImplementedError(
            "use _run_official_send_background; this sync helper is retained only for tests"
        )

    def schedule_list_payload(self) -> dict:
        """返回所有 active batch 及其 items。前端按 identity 分组渲染。"""
        batches = self._store.list_schedule_batches(include_inactive=False)
        all_messages = self._store.list_schedule_messages(include_inactive=False)
        msgs_by_batch: dict[int, list[dict]] = {}
        for m in all_messages:
            m["schedule_text"] = schedule_fmt_ts(m["schedule_at"])
            msgs_by_batch.setdefault(m["batch_id"], []).append(m)
        for b in batches:
            b["anchor_text"] = schedule_fmt_ts(b["anchor_at"])
            b["items"] = msgs_by_batch.get(b["id"], [])
            b["counts"] = {
                "planned": sum(1 for x in b["items"] if x["status"] == "planned"),
                "scheduled": sum(1 for x in b["items"] if x["status"] == "scheduled"),
                "failed": sum(1 for x in b["items"] if x["status"] == "failed"),
                "deleted": sum(1 for x in b["items"] if x["status"] == "deleted"),
            }
        return {"ok": True, "batches": batches}

    def schedule_cancel_payload(self, payload: dict) -> dict:
        """中途取消正在拟人节奏发送的 batch。
        把 batch.status 改成 'cancelled',后台 loop 在下一次循环开头检查到就早退。
        已经成功排到 TG 的不动(可以再用 schedule_delete_payload 一并清掉)。"""
        try:
            batch_id = int(payload.get("batch_id") or 0)
            if batch_id == 0:
                return {"ok": False, "error": "请提供 batch_id"}
            batches = [b for b in self._store.list_schedule_batches(include_inactive=True) if b["id"] == batch_id]
            if not batches:
                return {"ok": False, "error": "batch 不存在"}
            current_status = batches[0].get("status") or ""
            if current_status not in {"sending", "queued", "active"}:
                return {
                    "ok": False,
                    "error": f"当前 batch 状态 {current_status},不在发送中,无需取消",
                }
            self._store.set_schedule_batch_status(batch_id, "cancelled")
            return {"ok": True, "batch_id": batch_id, "status": "cancelled"}
        except Exception as exc:
            return {"ok": False, "error": str(exc)}

    def schedule_delete_payload(self, payload: dict) -> dict:
        """删除 batch:本地软删 + 如果有 scheduled_msg_id,也从 Telegram 删。"""
        try:
            batch_id = int(payload.get("batch_id") or 0)
            if batch_id == 0:
                return {"ok": False, "error": "请提供 batch_id"}
            batches = [b for b in self._store.list_schedule_batches(include_inactive=True) if b["id"] == batch_id]
            if not batches:
                return {"ok": False, "error": "batch 不存在"}
            batch = batches[0]
            account_local_id = batch.get("account_local_id") or ""
            listener = self._listeners.get_listener(account_local_id) if account_local_id else None
            tg_deleted = 0
            tg_error = ""
            if listener is not None and not payload.get("local_only"):
                msgs = self._store.list_schedule_messages(batch_id=batch_id, include_inactive=False)
                scheduled_ids = [m["scheduled_msg_id"] for m in msgs if m.get("scheduled_msg_id", 0) > 0]
                if scheduled_ids:
                    target_chat = self._store.get_settings().get("target_chat") or ""
                    try:
                        tg_deleted = listener.submit(
                            lambda client: self._do_delete_official_messages(
                                client, target_chat, scheduled_ids
                            ),
                            timeout=30.0,
                        )
                    except Exception as exc:
                        tg_error = str(exc)
            local = self._store.delete_schedule_batch(batch_id)
            return {
                "ok": True,
                "batch_id": batch_id,
                "local": local,
                "tg_deleted": tg_deleted,
                "tg_error": tg_error,
            }
        except Exception as exc:
            return {"ok": False, "error": str(exc)}

    def schedule_sync_payload(self, send_as_id: int = 0) -> dict:
        """对照 TG 端真实状态。拉 GetScheduledHistory,跟本地 scheduled_messages 对账。
        - tg_messages:TG 端当前所有 scheduled message(每条 scheduled_msg_id+text+time)
        - orphans:TG 有但本地没记录的(可能是从其它地方排的)
        - lost:本地标 scheduled 但 TG 没找到的(可能被 TG 端手动取消了)
        - matched:对得上的
        """
        try:
            send_as_id = int(send_as_id or 0)
            if send_as_id == 0:
                return {"ok": False, "error": "请指定 send_as_id"}

            # 找该身份归属的账号
            identity = self._store.get_identity(send_as_id)
            account_local_id = str((identity or {}).get("account_local_id") or "")
            if not account_local_id and send_as_id > 0:
                for account in self._store.list_accounts():
                    try:
                        if int(account.get("account_id") or 0) == send_as_id:
                            account_local_id = str(account.get("local_id") or "")
                            break
                    except (TypeError, ValueError):
                        continue
            listener = self._listeners.get_listener(account_local_id) if account_local_id else None
            if listener is None:
                return {
                    "ok": False,
                    "error": "该身份对应账号没在采集运行中,无法用其 client 拉 TG 定时列表",
                }

            target_chat = self._store.get_settings().get("target_chat") or ""
            if not target_chat:
                return {"ok": False, "error": "settings.target_chat 未配置"}

            tg_messages = listener.submit(
                lambda client: self._do_list_official_messages(client, target_chat),
                timeout=30.0,
            )

            # 跨集合对账
            local_messages = self._store.list_schedule_messages(
                send_as_id=send_as_id, include_inactive=False
            )
            local_by_tg_id = {m["scheduled_msg_id"]: m for m in local_messages if m["scheduled_msg_id"]}
            tg_ids = {m["scheduled_msg_id"] for m in tg_messages}

            matched = []
            orphans = []
            for tg_msg in tg_messages:
                local = local_by_tg_id.get(tg_msg["scheduled_msg_id"])
                if local:
                    matched.append({"local_id": local["id"], "tg": tg_msg, "local": local})
                else:
                    orphans.append(tg_msg)
            lost = [m for m in local_messages if m["scheduled_msg_id"] and m["scheduled_msg_id"] not in tg_ids]

            return {
                "ok": True,
                "send_as_id": send_as_id,
                "account_local_id": account_local_id,
                "tg_messages": tg_messages,
                "matched": matched,
                "orphans": orphans,
                "lost": lost,
            }
        except Exception as exc:
            return {"ok": False, "error": str(exc)}

    async def _do_list_official_messages(self, client, target_chat) -> list[dict]:
        peer = await client.get_input_entity(int(target_chat) if str(target_chat).lstrip("-").isdigit() else target_chat)
        return await self._schedule.list_on_client(client, peer=peer)

    async def _do_delete_official_messages(self, client, target_chat, scheduled_ids: list[int]) -> int:
        peer = await client.get_input_entity(int(target_chat) if str(target_chat).lstrip("-").isdigit() else target_chat)
        return await self._schedule.delete_on_client(client, peer=peer, scheduled_msg_ids=scheduled_ids)

    def listener_start_payload(self) -> dict:
        result = {"status": "error", "message": "请先在 Telegram 账号池中选择采集账号"}
        return {"ok": False, "listener": result}

    def listener_stop_payload(self) -> dict:
        listeners = self._listeners.status()
        collector_key = str(listeners.get("collector") or "")
        if not collector_key:
            return {"ok": True, "listener": {"status": "stopped", "message": "采集未运行"}}
        result = self._listeners.stop(collector_key)
        account = self._store.get_account(collector_key)
        if account is not None:
            self._store.save_account(
                {
                    **account,
                    "listen_enabled": False,
                    "listener_status": result.get("status", ""),
                    "listener_message": result.get("message", ""),
                }
            )
        return {"ok": True, "listener": result}

    def account_listener_start_payload(self, payload: dict) -> dict:
        account = self._require_account(payload.get("local_id"))
        result = self._listeners.start(account["local_id"], account)
        ok = result["status"] not in {"error"}
        if ok:
            self._mark_only_collector_account(account["local_id"])
        account = self._store.save_account(
            {
                **account,
                "collector_enabled": True,
                "collector_priority": 0,
                "listen_enabled": ok,
                "listener_status": result.get("status", ""),
                "listener_message": result.get("message", ""),
            }
        )
        return {"ok": ok, "listener": result, "account": public_account(account)}

    def account_listener_stop_payload(self, payload: dict) -> dict:
        account = self._require_account(payload.get("local_id"))
        result = self._listeners.stop(account["local_id"])
        account = self._store.save_account(
            {
                **account,
                "collector_enabled": False,
                "listen_enabled": False,
                "listener_status": result.get("status", ""),
                "listener_message": result.get("message", ""),
            }
        )
        return {"ok": True, "listener": result, "account": public_account(account)}

    def _require_account(self, local_id: object) -> dict:
        account = self._store.get_account(str(local_id or ""))
        if account is None:
            raise ValueError("账号不存在，请先保存账号配置")
        return account

    def _ensure_self_identity(self, account: dict) -> dict | None:
        """登录成功后,如果 account_id 已知,就 upsert 一条 send_as_id == account_id 的
        self-identity,跳过手动建身份这一步。"""
        try:
            account_id = int(str(account.get("account_id") or "").strip())
        except (TypeError, ValueError):
            return None
        if account_id == 0:
            return None
        existing = self._store.get_identity(account_id)
        if existing is not None:
            username = str(account.get("username") or "").strip().lstrip("@")
            if username and not str(existing.get("username") or "").strip():
                return self._store.save_identity({**existing, "username": username})
            return existing
        if len(self._store.list_identities()) >= MAX_IDENTITIES:
            return None
        payload = {
            "send_as_id": account_id,
            "account_local_id": account.get("local_id") or "",
            "label": account.get("label") or "",
            "username": account.get("username") or "",
            "enabled": True,
            "note": "登录后自动创建的 self-identity（identity_id == account_id）",
        }
        return self._store.save_identity(payload)

    def _reclassify_message_filters(self) -> int:
        reclassify = getattr(self._store, "reclassify_message_filters", None)
        if callable(reclassify):
            return int(reclassify() or 0)
        return 0

    def _mark_account_login_error(self, local_id: object, message: str) -> None:
        account = self._store.get_account(str(local_id or ""))
        if account is not None:
            self._store.save_account({**account, "login_status": "error", "login_message": message})

    def _mark_only_collector_account(self, local_id: str) -> None:
        for account in self._store.list_accounts():
            if account.get("local_id") == local_id:
                continue
            if account.get("listen_enabled") or account.get("listener_status") not in {"", "stopped"}:
                self._store.save_account(
                    {
                        **account,
                        "listen_enabled": False,
                        "listener_status": "stopped",
                        "listener_message": "已切换到其他采集账号",
                    }
                )

    def _ensure_collector_running(self) -> None:
        status = self._listeners.status()
        running = status.get("running") or {}
        active_statuses = {"starting", "running", "stopping", "reconnecting"}

        # 把已经在跑但账号又不再合格的 listener 停掉(比如登录态过期、
        # 账号被改、session 被删)。这是登录中 listener 别乱抢 session
        # 的反向保护。
        for local_id, item in list(running.items()):
            current_status = str(item.get("status") or "")
            if current_status not in active_statuses:
                continue
            account = self._store.get_account(local_id)
            if account is None or not _account_can_collect(account):
                self._listeners.stop(local_id)

        status = self._listeners.status()
        running = status.get("running") or {}
        if any(str(item.get("status") or "") in active_statuses for item in running.values()):
            self._sync_collector_statuses(running)
            return

        failed_collectors = {
            local_id
            for local_id, item in running.items()
            if str(item.get("status") or "") == "error"
        }
        self._sync_collector_statuses(running)
        for account in self._collector_candidates(skip_local_ids=failed_collectors):
            result = self._listeners.start(account["local_id"], account)
            ok = result["status"] not in {"error"}
            account = self._store.save_account(
                {
                    **account,
                    "listen_enabled": ok,
                    "listener_status": result.get("status", ""),
                    "listener_message": result.get("message", ""),
                }
            )
            if ok:
                self._mark_only_collector_account(account["local_id"])
                return

    def _sync_collector_statuses(self, running: dict) -> None:
        for local_id, item in running.items():
            account = self._store.get_account(local_id)
            if account is None:
                continue
            status = str((item or {}).get("status") or "")
            message = str((item or {}).get("message") or "")
            if (
                account.get("listener_status") == status
                and account.get("listener_message") == message
                and account.get("listen_enabled") == (status in {"starting", "running", "reconnecting"})
            ):
                continue
            self._store.save_account(
                {
                    **account,
                    "listen_enabled": status in {"starting", "running", "reconnecting"},
                    "listener_status": status,
                    "listener_message": message,
                }
            )

    def _collector_candidates(self, *, skip_local_ids: set[str] | None = None) -> list[dict]:
        skip_local_ids = skip_local_ids or set()
        candidates = []
        for account in self._store.list_accounts():
            if account.get("local_id") in skip_local_ids:
                continue
            if not account.get("collector_enabled", True):
                continue
            if not _account_can_collect(account):
                continue
            candidates.append(account)
        return sorted(
            candidates,
            key=lambda item: (
                int(item.get("collector_priority", 100)),
                str(item.get("local_id") or ""),
            ),
        )


def public_settings(settings: dict) -> dict:
    public = dict(settings)
    saved_secrets = {}
    for key in SECRET_SETTING_KEYS:
        has_value = bool(str(settings.get(key) or "").strip())
        saved_secrets[key] = has_value
        public[key] = ""
    public["saved_secrets"] = saved_secrets
    return public


def public_account(account: dict | None) -> dict | None:
    if account is None:
        return None
    public = dict(account)
    saved_secrets = {}
    for key in SECRET_SETTING_KEYS:
        has_value = bool(str(account.get(key) or "").strip())
        saved_secrets[key] = has_value
        public[key] = ""
    public["saved_secrets"] = saved_secrets
    return public


def public_identity(identity: dict | None) -> dict | None:
    if identity is None:
        return None
    return dict(identity)


def _username_changed(before: dict | None, after: dict | None) -> bool:
    before_name = str((before or {}).get("username") or "").strip().lstrip("@")
    after_name = str((after or {}).get("username") or "").strip().lstrip("@")
    return before_name != after_name and bool(after_name)


def classify_identity_kind(identity: dict, accounts_by_account_id: dict[int, dict]) -> str:
    """一个身份(send_as_id)归属某个 account。如果 send_as_id 等于某个已登录账号的
    TG account_id,即「以自己身份发」(self);负数 -100… 即频道 / 超级群身份;
    正数但匹配不上任何账号,意味着账号还没登录拿到 account_id,或这是预登记。
    仅作为 UI 侧的友好提示标签,不改变底层数据。"""
    try:
        send_as_id = int(identity.get("send_as_id") or 0)
    except (TypeError, ValueError):
        return "unknown"
    if send_as_id == 0:
        return "unknown"
    if send_as_id < 0:
        return "channel"
    if send_as_id in accounts_by_account_id:
        return "self"
    return "self_unbound"


def synth_self_identity(account: dict) -> dict | None:
    """合成 self-identity:identity_id == account_id 时,哪怕 identities 表里没这条,
    也能让 plan 解析过。不写库,只用于内存解析。

    登录后 _ensure_self_identity 会把 account_id 自身作为一条默认 identity 落库;
    这里只是 planner 的内存兜底,即使没落库也能解析。"""
    try:
        account_id = int(str(account.get("account_id") or "").strip())
    except (TypeError, ValueError):
        return None
    if account_id == 0:
        return None
    return {
        "send_as_id": account_id,
        "account_local_id": str(account.get("local_id") or ""),
        "label": str(account.get("label") or "") or "自己",
        "username": "",
        "enabled": True,
        "note": "登录账号自身的 self-identity（自动合成,未写入身份表）",
        "kind": "self",
        "synthesized": True,
    }


def public_outbox_draft(draft: dict) -> dict:
    return dict(draft)


def normalize_channel_filters(
    channel: str = "all",
    channels: list[str] | tuple[str, ...] | None = None,
) -> list[str]:
    raw_items: list[str] = []
    for item in channels or ():
        for part in str(item or "").split(","):
            raw_items.append(part.strip())
    channel = str(channel or "all").strip()
    if channel and channel != "all":
        raw_items.append(channel)

    result: list[str] = []
    seen: set[str] = set()
    known = {item.key for item in CHANNELS}
    for item in raw_items:
        if not item or item == "all" or item in seen or item not in known:
            continue
        seen.add(item)
        result.append(item)
    return result


def _aggregate_dungeon_status_rows(rows: list[tuple[int, ParsedCard]], *, context_finder=None, order: str = "priority") -> list[dict]:
    grouped: dict[str, dict] = {}
    context_by_name: dict[tuple[int, str], dict] = {}
    context_by_id: dict[str, dict] = {}
    orphan_by_name: dict[tuple[int, str], dict] = {}
    for seq, card in sorted(rows, key=_dungeon_row_sort_key):
        key, association = _dungeon_group_key(
            card,
            seq=seq,
            context_by_id=context_by_id,
            context_by_name=context_by_name,
            orphan_by_name=orphan_by_name,
            context_finder=context_finder,
        )
        summary = grouped.get(key)
        if summary is None:
            summary = _new_dungeon_summary(key, seq, card)
            grouped[key] = summary
        if association.get("source") and not summary.get("context_source"):
            summary["context_source"] = association["source"]
        if association.get("open_seq") and not summary.get("open_seq"):
            summary["open_seq"] = association["open_seq"]
        if association.get("open_message_id") and not summary.get("open_message_id"):
            summary["open_message_id"] = association["open_message_id"]
        _update_dungeon_summary(summary, seq, card)
        _remember_dungeon_context(context_by_name, context_by_id, key, seq, card)
    result = list(grouped.values())
    if order == "recent":
        result.sort(key=lambda item: -float(item.get("_latest_order") or item.get("latest_seq") or 0))
    else:
        result.sort(key=lambda item: (_dungeon_status_rank(item.get("status_kind")), -float(item.get("_latest_order") or item.get("latest_seq") or 0)))
    for item in result:
        item.pop("_status_seq", None)
        item.pop("_status_order", None)
        item.pop("_latest_order", None)
        for action in item.get("actions") or ():
            action.pop("source_order", None)
    return result


def _new_dungeon_summary(key: str, seq: int, card: ParsedCard) -> dict:
    fields = card.fields or {}
    name = _dungeon_name(card)
    dungeon_id = str(fields.get("副本ID") or "")
    if key.startswith("id:"):
        dungeon_id = _dungeon_id_from_key(key)
    return {
        "key": key,
        "dungeon_id": dungeon_id,
        "dungeon_name": name or "副本",
        "status": "副本消息",
        "status_kind": "info",
        "latest_seq": int(seq),
        "latest_message_id": card.id,
        "latest_time": card.time,
        "latest_stage": "",
        "opened_by": "",
        "capacity": "",
        "oracle": "",
        "advice": "",
        "route_verdict": "",
        "advice_basis": "",
        "advice_confidence": "",
        "team_fit": "",
        "positive_examples": [],
        "negative_examples": [],
        "route": "",
        "strategy": "",
        "silence_order": "",
        "context_source": "",
        "open_seq": 0,
        "open_message_id": "",
        "message_count": 0,
        "join_success": [],
        "failures": [],
        "actions": [],
        "messages": [],
    }


def _update_dungeon_summary(summary: dict, seq: int, card: ParsedCard) -> None:
    fields = card.fields or {}
    tags = list(card.tags or ())
    title = str(card.title or "")
    raw = str(card.raw or "")
    order = _dungeon_order_value(seq, card)
    if order >= float(summary.get("_latest_order") or -1):
        summary["_latest_order"] = order
        summary["latest_seq"] = int(seq)
        summary["latest_message_id"] = card.id
        summary["latest_time"] = card.time
    candidate_name = _dungeon_name(card)
    if candidate_name and (not summary.get("dungeon_name") or summary.get("dungeon_name") == "副本"):
        summary["dungeon_name"] = candidate_name
    for target, source in (
        ("dungeon_id", "副本ID"),
        ("latest_stage", "阶段"),
        ("opened_by", "开门人"),
        ("capacity", "人数上限"),
        ("oracle", "卦象"),
        ("advice", "行运建议"),
        ("route_verdict", "路策判定"),
        ("advice_basis", "建议依据"),
        ("advice_confidence", "建议置信"),
        ("team_fit", "队伍契合"),
        ("route", "路线"),
        ("strategy", "阵策"),
        ("silence_order", "静场令"),
    ):
        if not summary.get(target) and fields.get(source):
            summary[target] = str(fields.get(source) or "")

    for target, source in (
        ("positive_examples", "历史顺例"),
        ("negative_examples", "历史反例"),
    ):
        if summary.get(target) or not fields.get(source):
            continue
        value = fields.get(source)
        if isinstance(value, (list, tuple)):
            summary[target] = [str(item) for item in value if str(item).strip()]
        else:
            text = str(value or "").strip()
            summary[target] = [text] if text else []

    if title == "加入副本成功" or ("加入" in tags and "失败" not in tags):
        username = str(fields.get("username") or _first_username(raw) or "").strip().lstrip("@")
        if username and username not in summary["join_success"]:
            summary["join_success"].append(username)
    if title == "加入副本失败" or "失败" in tags:
        reason = str(fields.get("失败原因") or card.summary or "加入失败").strip()
        if reason and reason not in summary["failures"]:
            summary["failures"].append(reason)

    for action in card.actions or ():
        payload = action.to_api()
        command = str(payload.get("command") or "").strip()
        if not command:
            continue
        action_key = f"{command}|{payload.get('reply_to_msg_id') or ''}|{payload.get('chat_id') or ''}"
        if not any(item.get("key") == action_key for item in summary["actions"]):
            summary["actions"].append({**payload, "key": action_key, "source_message_id": card.id, "source_seq": int(seq), "source_order": order})
    summary["actions"] = sorted(
        summary["actions"],
        key=lambda item: float(item.get("source_order") or item.get("source_seq") or 0),
        reverse=True,
    )[:6]

    info = _dungeon_status_from_card(card)
    if info["kind"] != "info" and order >= float(summary.get("_status_order") or -1):
        summary["status"] = info["label"]
        summary["status_kind"] = info["kind"]
        summary["_status_seq"] = int(seq)
        summary["_status_order"] = order
    elif summary.get("status_kind") == "info" and info["label"]:
        summary["status"] = info["label"]

    summary["messages"].append(
        {
            "seq": int(seq),
            "id": card.id,
            "title": title,
            "summary": card.summary,
            "time": card.time,
            "chat_id": card.chat_id,
            "msg_id": card.msg_id,
            "reply_to_msg_id": card.reply_to_msg_id,
        }
    )
    summary["message_count"] = int(summary.get("message_count") or 0) + 1
    summary["messages"] = sorted(summary["messages"], key=_dungeon_message_order, reverse=True)[:6]


def _dungeon_group_key(
    card: ParsedCard,
    *,
    seq: int,
    context_by_id: dict[str, dict],
    context_by_name: dict[tuple[int, str], dict],
    orphan_by_name: dict[tuple[int, str], dict],
    context_finder=None,
) -> tuple[str, dict]:
    fields = card.fields or {}
    dungeon_id = str(fields.get("副本ID") or "").strip()
    if dungeon_id:
        if _is_dungeon_open_card(card):
            existing = context_by_id.get(dungeon_id)
            if existing and existing.get("open_seq"):
                key = f"id:{dungeon_id}:open:{seq}"
            else:
                key = f"id:{dungeon_id}"
            context_by_id[dungeon_id] = {
                "key": key,
                "source": "open_in_window",
                "open_seq": int(seq),
                "open_message_id": card.id,
            }
            return key, {"source": "explicit_id", "open_seq": int(seq), "open_message_id": card.id}
        context = context_by_id.get(dungeon_id)
        if context and context.get("key"):
            return str(context["key"]), {
                "source": context.get("source") or "explicit_id",
                "open_seq": context.get("open_seq") or 0,
                "open_message_id": context.get("open_message_id") or "",
            }
        return f"id:{dungeon_id}", {"source": "explicit_id"}
    if card.title == "加入副本失败" and card.reply_to_msg_id:
        return f"join-failed:{card.chat_id or 0}:{card.reply_to_msg_id}", {"source": "reply_to"}
    name = _dungeon_name(card) or "副本"
    name_key = (int(card.chat_id or 0), name)
    context = context_by_name.get(name_key)
    if not context and callable(context_finder):
        context = context_finder(card, seq, name) or {}
        if context.get("dungeon_id"):
            context_by_name[name_key] = {
                "key": f"id:{context['dungeon_id']}",
                "source": "open_lookup",
                "open_seq": int(context.get("seq") or 0),
                "open_message_id": context.get("message_id") or "",
                "ts": _card_timestamp(card),
            }
            context = context_by_name[name_key]
        else:
            context_by_name[name_key] = {"missing": True}
    if context and context.get("key"):
        return str(context["key"]), {
            "source": context.get("source") or "open_context",
            "open_seq": context.get("open_seq") or 0,
            "open_message_id": context.get("open_message_id") or "",
        }
    return _dungeon_orphan_group_key(card, seq, name, orphan_by_name), {"source": "time_segment"}


def _remember_dungeon_context(
    context_by_name: dict[tuple[int, str], dict],
    context_by_id: dict[str, dict],
    key: str,
    seq: int,
    card: ParsedCard,
) -> None:
    fields = card.fields or {}
    name = _dungeon_name(card) or ""
    dungeon_id = str(fields.get("副本ID") or "").strip()
    if not name or not dungeon_id:
        return
    name_key = (int(card.chat_id or 0), name)
    status_info = _dungeon_status_from_card(card)
    current = context_by_name.get(name_key)
    if status_info["kind"] == "closed":
        if current and current.get("key") == key:
            context_by_name.pop(name_key, None)
        if context_by_id.get(dungeon_id, {}).get("key") == key:
            context_by_id.pop(dungeon_id, None)
        return
    if _is_dungeon_open_card(card) or status_info["kind"] in {"open", "joined", "active", "choice"}:
        open_seq = int(seq) if _is_dungeon_open_card(card) else int((current or context_by_id.get(dungeon_id) or {}).get("open_seq") or 0)
        open_message_id = card.id if _is_dungeon_open_card(card) else str((current or context_by_id.get(dungeon_id) or {}).get("open_message_id") or "")
        context_by_id[dungeon_id] = {
            "key": key,
            "source": "open_in_window" if _is_dungeon_open_card(card) else "id_in_window",
            "open_seq": open_seq,
            "open_message_id": open_message_id,
        }
        context_by_name[name_key] = {
            "key": key,
            "source": "open_in_window" if _is_dungeon_open_card(card) else "id_in_window",
            "open_seq": open_seq,
            "open_message_id": open_message_id,
            "ts": _card_timestamp(card),
        }


def _dungeon_orphan_group_key(
    card: ParsedCard,
    seq: int,
    name: str,
    orphan_by_name: dict[tuple[int, str], dict],
) -> str:
    name_key = (int(card.chat_id or 0), name)
    ts = _card_timestamp(card)
    existing = orphan_by_name.get(name_key)
    if existing and ts and existing.get("ts") and abs(ts - float(existing["ts"])) <= 7200:
        existing["ts"] = ts
        return str(existing["key"])
    key = f"segment:{name}:{card.chat_id or 0}:{seq}"
    orphan_by_name[name_key] = {"key": key, "ts": ts}
    return key


def _dungeon_name(card: ParsedCard) -> str:
    fields = card.fields or {}
    if fields.get("副本名"):
        return str(fields.get("副本名") or "").strip()
    if card.title in {"加入副本成功", "加入副本失败", "副本房间解散"}:
        return "副本"
    text = f"{card.title or ''}\n{card.raw or ''}"
    for name in ("虚天殿", "黄龙山", "昆吾山", "坠魔谷", "血色试炼"):
        if name in text:
            return name
    title = str(card.title or "").strip()
    return title[:-2] if title.endswith("开启") else title


def _dungeon_status_from_card(card: ParsedCard) -> dict:
    fields = card.fields or {}
    tags = set(card.tags or ())
    title = str(card.title or "")
    status = str(fields.get("状态") or "").strip()
    if title == "副本房间解散" or "解散" in tags:
        return {"kind": "closed", "label": "已解散"}
    if title == "加入副本失败" or "失败" in tags:
        return {"kind": "failed", "label": "加入失败"}
    if "静场" in status or "静场令" in tags:
        return {"kind": "choice", "label": status or "静场令"}
    if "需要抉择" in status or "需要抉择" in tags:
        return {"kind": "choice", "label": status or "需要抉择"}
    if "可加入" in status or "可加入" in tags or title.endswith("开启"):
        return {"kind": "open", "label": status or "可加入"}
    if "已加入" in status or title == "加入副本成功":
        return {"kind": "joined", "label": status or "已加入"}
    if re.search(r"进行中|路线已选|卦象|路策", status) or re.search(r"推进|卦象|路线|路策", title):
        return {"kind": "active", "label": status or "进行中"}
    return {"kind": "info", "label": status or title or "副本消息"}


def _dungeon_status_rank(kind: object) -> int:
    return {
        "choice": 0,
        "open": 1,
        "active": 2,
        "joined": 3,
        "failed": 4,
        "closed": 5,
        "info": 6,
    }.get(str(kind or "info"), 6)


def _dungeon_row_sort_key(item: tuple[int, ParsedCard]) -> tuple[float, int]:
    seq, card = item
    return (_dungeon_order_value(seq, card), int(seq))


def _dungeon_order_value(seq: int, card: ParsedCard) -> float:
    ts = _card_timestamp(card)
    return ts if ts > 0 else float(seq)


def _dungeon_message_order(message: dict) -> float:
    text = str(message.get("time") or "").strip()
    if text:
        try:
            return datetime.fromisoformat(text.replace("Z", "+00:00")).timestamp()
        except ValueError:
            pass
    return float(message.get("seq") or message.get("msg_id") or 0)


def _dungeon_id_from_key(key: str) -> str:
    if not key.startswith("id:"):
        return ""
    return key.split(":", 2)[1] if ":" in key[3:] else key[3:]


def _is_dungeon_open_card(card: ParsedCard) -> bool:
    fields = card.fields or {}
    return str(card.title or "").endswith("开启") or str(fields.get("状态") or "").strip() == "可加入"


def _card_timestamp(card: ParsedCard) -> float:
    text = str(card.time or "").strip()
    if text:
        try:
            return datetime.fromisoformat(text.replace("Z", "+00:00")).timestamp()
        except ValueError:
            pass
    return float(card.msg_id or 0)


def _first_username(text: str) -> str:
    match = re.search(r"@(?P<user>[A-Za-z0-9_]+)", text or "")
    return match.group("user") if match else ""


def _fallback_filter_reasons(card: ParsedCard) -> list[str]:
    channels = set(card.channels or ())
    tags = set(card.tags or ())
    reasons: list[str] = []

    def add(reason: str) -> None:
        if reason and reason not in reasons:
            reasons.append(reason)

    if "我发出" in tags or "mine" in channels:
        add("我的发送")
    if "回复我" in tags:
        add("天尊回复我")
    if "回复别人" in tags:
        add("天尊回复别人")
    if "提到别人" in tags:
        add("天尊提到别人")
    if "被@" in tags:
        add("提到我")
    if "会长" in tags or "leader" in channels:
        add("会长/情报源普通发言")
    for tag in tags:
        text = str(tag or "")
        if text.startswith("关键词:"):
            add(text)
        elif text.startswith("重点排除:"):
            add(text)
        elif text.startswith("重点静音:"):
            add(text)
    if card.severity == "risk" or "risk" in channels:
        add("风险消息")
    if card.actions:
        add("有可操作按钮")
    if "dungeon" in channels:
        add("副本消息")
    if "resource" in channels:
        add("资源/背包消息")
    if "training" in channels:
        add("修炼状态消息")
    if "home" in channels:
        add("洞府/家园消息")
    if "archive" in channels:
        add("归档")
    if "focus" in channels and not reasons:
        add("重点流")
    if not reasons:
        add("未命中重点规则")
    return reasons


def build_inventory_transfer_plan(payload: dict) -> dict:
    """Generate manual commands for multi-item inventory transfer.

    交易玩法里“资源号提供物品、购买方集中资源”的安全流程通常是:
    1. 购买方先上架低价值诱饵,换目标物品;
    2. 资源号打开购买方货摊,按实际 ID 购买。

    货摊 ID 只能从 bot 回复里拿,这里不伪造 ID,只生成可复制命令和待填
    模板。miniweb 不自动发送、不扣库存。
    """
    buyer = str(payload.get("buyer") or payload.get("buyer_owner") or "").strip().lstrip("@")
    provider = str(payload.get("provider") or payload.get("provider_owner") or "").strip().lstrip("@")
    bait_name = str(payload.get("bait_name") or "凝血草").strip()
    try:
        bait_amount = int(str(payload.get("bait_amount") or "1").strip())
    except (TypeError, ValueError):
        bait_amount = 1
    bait_amount = max(1, bait_amount)
    raw_items = payload.get("items") or []
    if not isinstance(raw_items, list):
        raise ValueError("items 必须是数组")
    if not buyer:
        raise ValueError("请填写购买方")
    if not bait_name:
        raise ValueError("请填写诱饵物品")

    commands: list[dict] = []
    wanted: list[dict] = []
    for raw in raw_items:
        if not isinstance(raw, dict):
            continue
        name = str(raw.get("name") or raw.get("item_name") or "").strip()
        if not name:
            continue
        try:
            amount = int(str(raw.get("amount") or raw.get("qty") or "0").strip())
        except (TypeError, ValueError):
            amount = 0
        if amount <= 0:
            continue
        amount = min(amount, 999999)
        wanted.append({"name": name, "amount": amount})
        commands.append(
            {
                "role": "buyer",
                "owner": buyer,
                "command": f"上架 {bait_name}*{bait_amount} 换 {name}*{amount}",
                "note": f"购买方 @{buyer} 先发,用诱饵换资源号的 {name} x{amount}",
            }
        )
    if not wanted:
        raise ValueError("请至少选择一种要转移的物品")

    commands.append(
        {
            "role": "provider",
            "owner": provider,
            "command": f".我的货摊 @{buyer}" if buyer else ".我的货摊",
            "note": "资源号查看购买方货摊,从回复里拿真实 ID。",
        }
    )
    for item in wanted:
        commands.append(
            {
                "role": "provider",
                "owner": provider,
                "command": f".购买 <货摊ID> {item['amount']}",
                "note": f"把 <货摊ID> 换成 {item['name']} 对应那条货摊 ID 后再发。",
                "template": True,
            }
        )

    return {
        "buyer": buyer,
        "provider": provider,
        "bait": {"name": bait_name, "amount": bait_amount},
        "items": wanted,
        "commands": commands,
        "notes": [
            "这里只生成命令,不自动发送。",
            "库存来自最近快照,转移后请重新 .储物袋 刷新。",
            "购买命令里的货摊 ID 必须按 .我的货摊 回复填写。",
        ],
    }


def coerce_send_as_id(value: object) -> int:
    try:
        send_as_id = int(str(value or "").strip())
    except (TypeError, ValueError):
        return 0
    return send_as_id if send_as_id != 0 else 0


def _account_can_collect(account: dict) -> bool:
    required_keys = ("api_id", "api_hash", "session_name", "target_chat")
    if not all(str(account.get(key) or "").strip() for key in required_keys):
        return False
    # 没完成登录的账号别启 listener,否则 listener 的 client 会跟
    # login 的 client 抢同一个 session,导致 Telethon 跨 loop 异常 +
    # 登录流程被打断。
    if str(account.get("login_status") or "") != "done":
        return False
    return True


def account_local_id_from_payload(payload: dict) -> str:
    raw_identity = str(
        payload.get("local_id")
        or payload.get("session_name")
        or payload.get("phone")
        or ""
    ).strip()
    if not raw_identity:
        return ""
    return safe_session_name(raw_identity, fallback="")


def preserve_existing_secrets(payload: dict, current_settings: dict) -> dict:
    patch = dict(payload)
    for key in SECRET_SETTING_KEYS:
        value = str(patch.get(key) or "").strip()
        if not value:
            if str(current_settings.get(key) or "").strip():
                patch[key] = current_settings.get(key) or ""
            else:
                patch[key] = ""
    return patch


def _source_message_id_from_payload(payload: dict) -> str:
    action = payload.get("action") if isinstance(payload.get("action"), dict) else payload
    return str(
        payload.get("source_message_id")
        or action.get("source_message_id")
        or action.get("message_id")
        or ""
    ).strip()
