from __future__ import annotations

import time
from dataclasses import replace
from hashlib import sha1
from typing import Callable, Iterable

from backend.domain.models import ParsedCard, RawMessageEvent
from backend.domain.registry import ParserOutput, ParserRegistry
from backend.processors.message_filter import enrich_filter_channels


# 跨 NewMessage + MessageEdited 两条入口的幂等去重 — 同一 (chat_id, msg_id)
# 内容没变化时跳过 _maybe_observe(state machine 不重复 tick)。
# 老脚本对照:app.py:324 `_claim_runtime_event`。TTL 自己 GC。
_OBSERVE_CACHE_TTL_SEC = 600.0
_OBSERVE_CACHE_MAX = 4096


def _first_matching_family(module_key: str, families: list[str]) -> str:
    try:
        from backend.identity_state.contracts import module_contract
        contract = module_contract(module_key)
    except Exception:
        contract = None
    known = set((contract.reply_families if contract else ()) or ())
    for family in families or []:
        if not known or family in known:
            return str(family or "")
    return ""


class MessagePipeline:
    """单条消息的处理管线:parser → enrich → 状态机 observe。

    parser / enrich 一直在做,不变。
    状态机部分(玩法 module)是可选的:没注入 module_registry 就不跑,
    保证旧测试和无副作用调用照旧通过。
    """

    def __init__(
        self,
        registry: ParserRegistry,
        *,
        is_game_bot_sender: Callable[[int | None], bool] | None = None,
        get_target_topic_id: Callable[[], int] | None = None,
        # 玩法状态机相关 callbacks(都可选,缺一个就不跑 observe)
        module_registry=None,
        get_parent_event: Callable[[int, int], RawMessageEvent | None] | None = None,
        get_my_identities: Callable[[], Iterable[int]] | None = None,
        get_game_bot_ids: Callable[[], Iterable[int]] | None = None,
        get_settings_snapshot: Callable[[], dict] | None = None,
        get_module_state: Callable[[int, str], dict | None] | None = None,
        save_module_state: Callable[[int, str, dict, str], None] | None = None,
        save_state_observation: Callable[[dict], None] | None = None,
    ) -> None:
        self._registry = registry
        # 给 fallback 判定「这条算系统消息还是玩家消息」用。
        # 默认行为:没注入 callback 时退回老逻辑(sender_is_bot 或 sender_id<0)。
        self._is_game_bot_sender = is_game_bot_sender or (lambda sid: False)
        # 用来识别「topic 内首层消息」的假 reply(reply_to_msg_id == target_topic_id)。
        # forum 群里 Telegram 会把 reply_to_msg_id 设成 topic root id,这不是真 reply。
        self._get_target_topic_id = get_target_topic_id or (lambda: 0)

        self._module_registry = module_registry
        self._get_parent_event = get_parent_event
        self._get_my_identities = get_my_identities
        self._get_game_bot_ids = get_game_bot_ids
        self._get_settings_snapshot = get_settings_snapshot
        self._get_module_state = get_module_state
        self._save_module_state = save_module_state
        self._save_state_observation = save_state_observation
        # observe 幂等缓存:{(chat_id, msg_id): (text_hash, expires_at)}
        self._observe_cache: dict[tuple[int, int], tuple[int, float]] = {}

    def process(self, event: RawMessageEvent) -> ParserOutput:
        output = self._registry.parse(event)
        if output.cards:
            enriched = self._enrich(output, event)
        else:
            # 「真系统消息」的判定:
            # 1. sender_id 在 game_bot_ids 里(用户标定的「韩天尊们」) → system
            # 2. sender_is_bot=True 且不是频道(sid>0,正常 bot 用户) → system
            # 3. 其它(包括频道身份发声但不在 game_bot_ids) → world
            sid = event.sender_id
            if sid and self._is_game_bot_sender(sid):
                is_system_like = True
            elif event.sender_is_bot and (sid is None or sid > 0):
                is_system_like = True
            else:
                is_system_like = False
            fallback_channel = "system" if is_system_like else "world"
            title = "系统消息" if is_system_like else "玩家消息"
            fallback_output = ParserOutput(
                cards=(
                    ParsedCard(
                        id=event.id,
                        channels=(fallback_channel,),
                        title=title,
                        summary=event.text.splitlines()[0][:80] if event.text else "空消息",
                        source=event.source,
                        time=event.date,
                        tags=("未分类",),
                        raw=event.text,
                    ),
                ),
                state_patches=output.state_patches,
                resource_deltas=output.resource_deltas,
                resource_events=output.resource_events,
            )
            enriched = self._enrich(fallback_output, event)

        # 状态机 observe — 只在所有需要的 callback 都注入时才跑
        self._maybe_observe(event)
        return enriched

    def observe_event(
        self,
        event: RawMessageEvent,
        *,
        observed_at: float | None = None,
        force: bool = False,
    ) -> None:
        """Run only state-machine observation for historical targeted backfills."""
        self._maybe_observe(event, observed_at=observed_at, force=force)

    def _gc_observe_cache(self, now: float) -> None:
        if len(self._observe_cache) < _OBSERVE_CACHE_MAX:
            # 按 max 容量做被动 GC,够用且代价低
            return
        expired = [k for k, (_h, exp) in self._observe_cache.items() if exp <= now]
        for k in expired:
            self._observe_cache.pop(k, None)
        # 仍超容 → 砍掉最老的一半
        if len(self._observe_cache) >= _OBSERVE_CACHE_MAX:
            items = sorted(self._observe_cache.items(), key=lambda kv: kv[1][1])
            for k, _ in items[: _OBSERVE_CACHE_MAX // 2]:
                self._observe_cache.pop(k, None)

    def _maybe_observe(
        self,
        event: RawMessageEvent,
        *,
        observed_at: float | None = None,
        force: bool = False,
    ) -> None:
        """跑玩法 module 的 observe;失败静默,不影响 parser 落库。"""
        if (
            self._module_registry is None
            or self._get_module_state is None
            or self._save_module_state is None
        ):
            return
        # 幂等去重:同 (chat_id, msg_id) 内容未变就跳过(NewMessage + 多次 MessageEdited
        # 会反复送同一条进来)。text_hash 是 hash(text or "") — 编辑了文字才重跑。
        key = (int(event.chat_id or 0), int(event.msg_id or 0))
        text_hash = hash(event.text or "")
        wall_now = time.time()
        if key[0] and key[1]:
            self._gc_observe_cache(wall_now)
            prev = self._observe_cache.get(key)
            if not force and prev and prev[0] == text_hash and prev[1] > wall_now:
                return
            self._observe_cache[key] = (text_hash, wall_now + _OBSERVE_CACHE_TTL_SEC)
        try:
            from backend.identity_state import ObserveContext, classify_sender
            from backend.identity_state.contracts import module_keys_for_families
            from backend.repo.bot_hints import matched_families
        except Exception:
            return
        my_ids = frozenset(int(x) for x in (self._get_my_identities() if self._get_my_identities else ()))
        bot_ids = frozenset(int(x) for x in (self._get_game_bot_ids() if self._get_game_bot_ids else ()))
        settings = {}
        if self._get_settings_snapshot:
            try:
                settings = dict(self._get_settings_snapshot() or {})
            except Exception:
                settings = {}
        parent = None
        if event.reply_to_msg_id and self._get_parent_event:
            try:
                parent = self._get_parent_event(int(event.chat_id), int(event.reply_to_msg_id))
            except Exception:
                parent = None
        ctx = ObserveContext(
            parent=parent,
            sender_kind=classify_sender(
                event.sender_id, my_identities=my_ids, game_bot_ids=bot_ids
            ),
            my_identities=my_ids,
            game_bot_ids=bot_ids,
            settings=settings,
            now=float(observed_at or wall_now),
        )
        families: list[str] = []
        try:
            families = matched_families(event.text or "")
        except Exception:
            families = []
        parent_identity = ctx.parent_sender() if ctx.parent_is_my_identity() else None
        try:
            results = self._module_registry.observe_all(
                event,
                ctx,
                get_state=self._module_state_getter(),
                save_state=lambda sid, key, state, src: self._save_module_state(
                    sid, key, state, src
                ),
            )
        except Exception:
            self._record_state_observation(
                event,
                module_key="",
                send_as_id=int(parent_identity or 0),
                family=families[0] if families else "",
                reason="observe_exception",
                decision="error",
                matched_families=families,
            )
            return
        if results:
            for item in results:
                self._record_state_observation(
                    event,
                    module_key=item.module_key,
                    send_as_id=item.send_as_id,
                    family=_first_matching_family(item.module_key, families),
                    reason="state_updated",
                    decision="updated",
                    state_after=str((item.state or {}).get("phase") or (item.state or {}).get("last_status") or ""),
                    matched_families=families,
                )
            return
        if not families:
            return
        candidate_modules = module_keys_for_families(families)
        if ctx.sender_kind != "bot":
            reason = "sender_not_game_bot"
        elif not parent_identity:
            reason = "reply_context_no_identity"
        elif candidate_modules:
            reason = "module_no_match"
        else:
            reason = "unhandled_family"
        self._record_state_observation(
            event,
            module_key=candidate_modules[0] if candidate_modules else "",
            send_as_id=int(parent_identity or 0),
            family=families[0] if families else "",
            reason=reason,
            decision="skipped",
            matched_families=families,
        )

    def _record_state_observation(
        self,
        event: RawMessageEvent,
        *,
        module_key: str,
        send_as_id: int,
        family: str,
        reason: str,
        decision: str,
        state_before: str = "",
        state_after: str = "",
        matched_families: list[str] | None = None,
    ) -> None:
        if self._save_state_observation is None:
            return
        text = str(event.text or "")
        try:
            self._save_state_observation(
                {
                    "module_key": str(module_key or ""),
                    "send_as_id": int(send_as_id or 0),
                    "family": str(family or ""),
                    "reason": str(reason or ""),
                    "decision": str(decision or ""),
                    "source_message_id": str(event.id or ""),
                    "chat_id": int(event.chat_id or 0),
                    "msg_id": int(event.msg_id or 0),
                    "reply_to_msg_id": int(event.reply_to_msg_id or 0),
                    "sender_id": int(event.sender_id or 0) if event.sender_id is not None else 0,
                    "event_type": "edit" if event.edited_at else "message",
                    "matched_families": list(matched_families or []),
                    "matched_text_hash": sha1(text.encode("utf-8", errors="ignore")).hexdigest()[:16] if text else "",
                    "matched_text": text[:240],
                    "state_before": str(state_before or ""),
                    "state_after": str(state_after or ""),
                    "observed_at": time.time(),
                }
            )
        except Exception:
            return

    def _module_state_getter(self):
        cache: dict[tuple[int, str], dict | None] = {}

        def get_state(sid, key):
            cache_key = (int(sid or 0), str(key or ""))
            if cache_key not in cache:
                cache[cache_key] = self._get_module_state(cache_key[0], cache_key[1])
            row = cache.get(cache_key) or {}
            return row.get("state")

        return get_state

    def _enrich(self, output: ParserOutput, event: RawMessageEvent) -> ParserOutput:
        """把 event 上下文(chat_id/msg_id/sender_id/reply_to_msg_id)注入每张卡片,
        前端 chat UI 用来做回复链和「单机模式」过滤。parsers 不用关心这些字段。

        Forum 群里「topic 内首层消息」会把 reply_to_msg_id 设成 topic_id(假 reply),
        如果 reply_to_msg_id 等于 top_msg_id,清掉,避免 UI 误显示「↪ 回复 X」。"""
        raw_reply = event.reply_to_msg_id
        topic_id = 0
        try:
            topic_id = int(self._get_target_topic_id() or 0)
        except Exception:
            topic_id = 0
        # 两种「假 reply」都清:
        # 1) reply_to_msg_id == top_msg_id (forum 内 reply_to_top_id 已知的情况)
        # 2) reply_to_msg_id == 配置的 target_topic_id (forum 内 top_id 未导出的情况)
        if raw_reply and (
            (event.top_msg_id and int(raw_reply) == int(event.top_msg_id))
            or (topic_id and int(raw_reply) == topic_id)
        ):
            clean_reply = None
        else:
            clean_reply = raw_reply
        settings = {}
        if self._get_settings_snapshot:
            try:
                settings = dict(self._get_settings_snapshot() or {})
            except Exception:
                settings = {}
        parent = None
        if clean_reply and self._get_parent_event:
            try:
                parent = self._get_parent_event(int(event.chat_id), int(clean_reply))
            except Exception:
                parent = None
        my_identity_ids = frozenset(
            int(x) for x in (self._get_my_identities() if self._get_my_identities else ())
        )
        enriched = tuple(
            self._enrich_one_card(
                card,
                event=event,
                clean_reply=clean_reply,
                settings=settings,
                parent=parent,
                my_identity_ids=my_identity_ids,
            )
            for card in output.cards
        )
        return ParserOutput(
            cards=enriched,
            state_patches=output.state_patches,
            resource_deltas=output.resource_deltas,
            resource_events=output.resource_events,
        )

    def _enrich_one_card(
        self,
        card: ParsedCard,
        *,
        event: RawMessageEvent,
        clean_reply: int | None,
        settings: dict,
        parent: RawMessageEvent | None,
        my_identity_ids: Iterable[int],
    ) -> ParsedCard:
        filtered = enrich_filter_channels(
            card,
            event,
            settings,
            is_game_bot_sender=self._is_game_bot_sender,
            parent_event=parent,
            clean_reply_to_msg_id=clean_reply,
            my_identity_ids=my_identity_ids,
        )
        return replace(
            card,
            channels=filtered.channels,
            tags=filtered.tags,
            chat_id=event.chat_id if card.chat_id is None else card.chat_id,
            msg_id=event.msg_id if card.msg_id is None else card.msg_id,
            sender_id=event.sender_id if card.sender_id is None else card.sender_id,
            reply_to_msg_id=(
                clean_reply if card.reply_to_msg_id is None else card.reply_to_msg_id
            ),
            filter_reasons=filtered.reasons,
        )
