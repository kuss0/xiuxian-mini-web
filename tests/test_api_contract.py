from backend.domain import CHANNELS
from backend.domain.models import ParsedCard, RawMessageEvent
from backend.app import MiniWebHandler, create_handler, is_authorized_api_headers
from backend.config import MAX_ACCOUNTS, MAX_IDENTITIES, MAX_LISTENERS
import backend.server as server_module
from backend.repo.sample_store import SAMPLE_EVENTS, SampleStore
from backend.repo.sqlite_store import SQLiteStore
from backend.server import MiniWebServer
from backend.tg.client import build_telethon_proxy, split_host_port
from backend.tg.listener import (
    _format_sender_display,
    _raw_event_from_telethon,
)
from backend.outbox.planner import OutboxPlanner
from backend.processors.message_filter import enrich_filter_channels


def test_channels_have_unique_keys():
    keys = [channel.key for channel in CHANNELS]
    assert len(keys) == len(set(keys))


def test_default_capacity_matches_multi_account_design():
    assert MAX_ACCOUNTS == 100
    assert MAX_IDENTITIES == 100
    assert MAX_LISTENERS == 1


def test_sample_messages_reference_known_channels():
    known = {channel.key for channel in CHANNELS}
    messages = [card.to_api() for card in SampleStore().list_cards()]
    assert {message["channel"] for message in messages} <= known


def test_sample_store_filters_by_secondary_channel():
    messages = [card.to_api() for card in SampleStore().list_cards("dungeon")]
    assert len(messages) == 1
    assert messages[0]["title"] == "虚天殿开启"


def test_message_filter_promotes_plain_mentions_and_archives_commands():
    base = ParsedCard(
        id="x",
        channels=("world",),
        title="玩家消息",
        summary="",
        source="玩家",
        time="",
        tags=(),
        raw="",
    )

    plain = enrich_filter_channels(
        base,
        RawMessageEvent(id="x1", chat_id=1, msg_id=1, text="今晚虚天殿有人吗", source="玩家", date=""),
        {"focus_keywords": ["虚天殿"], "focus_include_player_plain": True},
        is_game_bot_sender=lambda _sid: False,
    )
    command = enrich_filter_channels(
        base,
        RawMessageEvent(id="x2", chat_id=1, msg_id=2, text=".加入副本 394", source="玩家", date=""),
        {"archive_dot_commands": True, "focus_include_player_plain": True},
        is_game_bot_sender=lambda _sid: False,
    )
    mention = enrich_filter_channels(
        base,
        RawMessageEvent(id="x3", chat_id=1, msg_id=3, text="@wa2000 来看玄骨", source="玩家", date=""),
        {"own_aliases": ["wa2000"], "focus_keywords": []},
        is_game_bot_sender=lambda _sid: False,
    )
    other_mention = enrich_filter_channels(
        base,
        RawMessageEvent(id="x4", chat_id=1, msg_id=4, text="@other 来看", source="玩家", date=""),
        {"own_aliases": ["wa2000"], "focus_keywords": [], "focus_include_player_plain": False},
        is_game_bot_sender=lambda _sid: False,
    )

    assert "focus" in plain.channels
    assert "archive" in command.channels
    assert "focus" not in command.channels
    assert "focus" in mention.channels
    assert "focus" not in other_mention.channels


def test_message_filter_promotes_bot_reply_to_me_and_archives_reply_to_others():
    base = ParsedCard(
        id="reply",
        channels=("system",),
        title="系统消息",
        summary="",
        source="韩天尊",
        time="",
        tags=("未分类",),
        raw="",
    )
    settings = {"archive_bot_replies": True, "focus_keywords": []}
    bot_event = RawMessageEvent(
        id="r1", chat_id=1, msg_id=11, text="你已进入深度闭关状态。", source="韩天尊",
        date="", sender_id=-100, reply_to_msg_id=10,
    )
    mine = RawMessageEvent(id="p1", chat_id=1, msg_id=10, text=".深度闭关", source="me", date="", sender_id=12345)
    other = RawMessageEvent(id="p2", chat_id=1, msg_id=10, text=".深度闭关", source="other", date="", sender_id=67890)

    reply_to_me = enrich_filter_channels(
        base, bot_event, settings,
        is_game_bot_sender=lambda sid: sid == -100,
        parent_event=mine,
        my_identity_ids=[12345],
    )
    reply_to_other = enrich_filter_channels(
        base, bot_event, settings,
        is_game_bot_sender=lambda sid: sid == -100,
        parent_event=other,
        my_identity_ids=[12345],
    )

    assert "focus" in reply_to_me.channels
    assert "archive" not in reply_to_me.channels
    assert "回复我" in reply_to_me.tags
    assert "archive" in reply_to_other.channels
    assert "focus" not in reply_to_other.channels
    assert "回复别人" in reply_to_other.tags


def test_server_payload_shape_stays_compatible():
    server = MiniWebServer(store=SampleStore())
    payload = server.messages_payload("all")
    assert payload["messages"]
    assert {"id", "channel", "title", "summary", "actions"} <= set(payload["messages"][0])


def test_action_suggestions_keep_reply_context():
    dungeon = [card.to_api() for card in SampleStore().list_cards("dungeon")][0]
    action = dungeon["actions"][0]

    assert action["command"] == ".加入副本 394"
    assert action["chat_id"] == 0
    assert action["reply_to_msg_id"] == 2
    assert action["send_mode"] == "copy"


def test_outbox_declares_context_but_no_direct_send():
    payload = MiniWebServer(store=SampleStore()).outbox_payload()

    assert payload["capabilities"]["reply_context"] is True
    assert payload["capabilities"]["manual_api_reply"] is True
    assert payload["capabilities"]["direct_send"] is False


def test_sqlite_store_persists_cards(tmp_path):
    db_path = tmp_path / "miniweb.db"
    store = SQLiteStore(db_path)
    store.seed_samples_if_empty()

    first = store.list_cards("risk")
    second = SQLiteStore(db_path).list_cards("risk")

    assert len(first) == 1
    assert len(second) == 1
    # 天道审判 + 自证 提示同时落到 risk 频道(severity=risk);
    # 老 RiskParser 也会匹配但优先级在 prompt 后面,这里取 Tiandao prompt 卡。
    assert second[0].title in {"风险提醒", "天道审判"}
    assert second[0].severity == "risk"


def test_sqlite_store_persists_state_patches(tmp_path):
    db_path = tmp_path / "miniweb.db"
    store = SQLiteStore(db_path)
    store.seed_samples_if_empty()

    patches = SQLiteStore(db_path).list_state_patches("identity_profile")

    values = {(item["scope"], item["key"]): item["value"] for item in patches}
    assert values[("identity_profile", "灵根")] == "天灵根(火)"
    assert values[("identity_profile", "综合战力")] == "333.8万"


def test_sqlite_store_backfills_state_patches_for_existing_raw_messages(tmp_path):
    db_path = tmp_path / "miniweb.db"
    store = SQLiteStore(db_path)
    store.ingest_event(next(event for event in SAMPLE_EVENTS if event.id == "sample-4"))
    with store._connect() as conn:
        conn.execute("DELETE FROM state_patches")

    rebuilt = SQLiteStore(db_path)
    rebuilt.seed_samples_if_empty()
    patches = rebuilt.list_state_patches("identity_profile")

    assert patches
    assert any(item["key"] == "灵根" and item["value"] == "天灵根(火)" for item in patches)


def test_state_patches_api_shape(tmp_path):
    store = SQLiteStore(tmp_path / "miniweb.db")
    store.seed_samples_if_empty()
    payload = MiniWebServer(store=store).state_patches_payload("identity_profile")

    assert payload["ok"] is True
    assert payload["state"]
    assert {"scope", "key", "value", "source_message_id", "updated_at"} <= set(payload["state"][0])


def test_sqlite_settings_roundtrip(tmp_path):
    store = SQLiteStore(tmp_path / "miniweb.db")
    assert 7900199668 in store.get_settings()["game_bot_ids"]

    saved = store.save_settings(
        {
            "api_id": "123",
            "api_hash": "hash",
            "target_chat": "-1001",
            "game_bot_ids": ["7900199668", "bad", "8757550896"],
            "listen_enabled": True,
        }
    )

    assert saved["api_id"] == "123"
    assert saved["target_chat"] == "-1001"
    assert saved["game_bot_ids"] == [7900199668, 8757550896]
    assert SQLiteStore(tmp_path / "miniweb.db").get_settings()["listen_enabled"] is True


def test_settings_payload_redacts_saved_secrets(tmp_path):
    store = SQLiteStore(tmp_path / "miniweb.db")
    store.save_settings({"api_hash": "secret-hash", "proxy_password": "proxy-secret"})
    server = MiniWebServer(store=store)

    payload = server.settings_payload()

    assert payload["settings"]["api_hash"] == ""
    assert payload["settings"]["proxy_password"] == ""
    # 所有标记为 secret 的 key 都必须出现在 saved_secrets 里(True 表示已保存)
    assert payload["settings"]["saved_secrets"]["api_hash"] is True
    assert payload["settings"]["saved_secrets"]["proxy_password"] is True
    assert payload["settings"]["saved_secrets"]["notify_tg_bot_token"] is False
    assert "secret-hash" not in str(payload)
    assert "proxy-secret" not in str(payload)


def test_blank_secret_save_preserves_existing_secret(tmp_path):
    store = SQLiteStore(tmp_path / "miniweb.db")
    store.save_settings({"api_hash": "secret-hash", "proxy_password": "proxy-secret"})
    server = MiniWebServer(store=store)

    payload = server.save_settings_payload({"api_hash": "", "proxy_password": "", "api_id": "456"})

    assert payload["settings"]["api_hash"] == ""
    assert payload["settings"]["proxy_password"] == ""
    saved = store.get_settings()
    assert saved["api_id"] == "456"
    assert saved["api_hash"] == "secret-hash"
    assert saved["proxy_password"] == "proxy-secret"


def test_account_save_redacts_and_preserves_existing_secret(tmp_path):
    store = SQLiteStore(tmp_path / "miniweb.db")
    server = MiniWebServer(store=store)

    created = server.save_account_payload(
        {
            "phone": "+8613800138000",
            "api_id": "123",
            "api_hash": "secret-hash",
            "proxy_password": "proxy-secret",
        }
    )
    local_id = created["account"]["local_id"]
    updated = server.save_account_payload(
        {
            "local_id": local_id,
            "label": "主号",
            "api_hash": "",
            "proxy_password": "",
        }
    )

    assert created["account"]["api_hash"] == ""
    assert updated["account"]["saved_secrets"]["api_hash"] is True
    assert updated["account"]["saved_secrets"]["proxy_password"] is True
    saved = store.get_account(local_id)
    assert saved["label"] == "主号"
    assert saved["api_hash"] == "secret-hash"
    assert saved["proxy_password"] == "proxy-secret"


def test_account_limit_uses_normalized_identity(tmp_path, monkeypatch):
    monkeypatch.setattr(server_module, "MAX_ACCOUNTS", 1)
    server = MiniWebServer(store=SQLiteStore(tmp_path / "miniweb.db"))

    server.save_account_payload({"phone": "+8613800138000", "api_id": "123", "api_hash": "hash"})
    server.save_account_payload({"phone": "+8613800138000", "label": "同一个账号更新"})

    try:
        server.save_account_payload({"phone": "+8613800138001", "api_id": "124", "api_hash": "hash2"})
    except ValueError as exc:
        assert "账号数量已达上限 1 个" in str(exc)
    else:
        raise AssertionError("second normalized account should exceed account limit")


def test_message_box_uses_single_collector_from_account_pool(tmp_path):
    class FakeListenerManager:
        def __init__(self) -> None:
            self.started = []

        def status(self, local_id=None):
            if local_id:
                return {"status": "stopped", "message": ""}
            return {"max_listeners": 1, "collector": "", "running": {}}

        def start(self, local_id, settings):
            self.started.append((local_id, settings["label"]))
            return {"status": "starting", "message": "fake collector starting"}

    store = SQLiteStore(tmp_path / "miniweb.db")
    server = MiniWebServer(store=store)
    fake = FakeListenerManager()
    server._listeners = fake

    server.save_account_payload(
        {
            "local_id": "backup",
            "label": "备用",
            "api_id": "123",
            "api_hash": "hash",
            "session_name": "backup",
            "target_chat": "-1001",
            "collector_priority": 20,
            "login_status": "done",
        }
    )
    server.save_account_payload(
        {
            "local_id": "primary",
            "label": "主采集",
            "api_id": "123",
            "api_hash": "hash",
            "session_name": "primary",
            "target_chat": "-1001",
            "collector_priority": 0,
            "login_status": "done",
        }
    )

    payload = server.accounts_payload()

    assert payload["max_listeners"] == 1
    assert fake.started == [("primary", "主采集")]


def test_collector_skips_account_pending_login(tmp_path):
    """对照 mini-web 已修的 bug:登录中(waiting_code/need_2fa)的账号
    不能被自动启 listener,否则 listener 的 client 会跟 login 抢 session,
    Telethon 跨 loop 错误 + 登录流程被打断。"""
    class FakeListenerManager:
        def __init__(self):
            self.started = []

        def status(self, local_id=None):
            if local_id:
                return {"status": "stopped", "message": ""}
            return {"max_listeners": 1, "collector": "", "running": {}}

        def start(self, local_id, settings):
            self.started.append(local_id)
            return {"status": "starting", "message": "fake"}

        def stop(self, local_id):
            return {"status": "stopped", "message": "fake stopped"}

    store = SQLiteStore(tmp_path / "miniweb.db")
    server = MiniWebServer(store=store)
    fake = FakeListenerManager()
    server._listeners = fake

    server.save_account_payload(
        {
            "local_id": "pending",
            "label": "登录中",
            "api_id": "123",
            "api_hash": "hash",
            "session_name": "pending",
            "target_chat": "-1001",
            "login_status": "waiting_code",
        }
    )

    server.accounts_payload()

    assert fake.started == [], "登录中的账号不该被自动启 listener"


def test_listener_status_reports_active_collector(tmp_path):
    class FakeListenerManager:
        def status(self, local_id=None):
            if local_id == "primary":
                return {"status": "running", "message": "采集中"}
            if local_id:
                return {"status": "stopped", "message": ""}
            return {
                "max_listeners": 1,
                "collector": "primary",
                "running": {"primary": {"status": "running", "message": "采集中"}},
            }

        def stop(self, local_id):
            return {"status": "stopped", "message": "fake stop"}

    store = SQLiteStore(tmp_path / "miniweb.db")
    # 建好 primary 账号 + 标记登录态,这样 _ensure_collector_running
    # 不会因为没账号或没登录就把它停掉。
    server = MiniWebServer(store=store)
    server.save_account_payload(
        {
            "local_id": "primary",
            "label": "主采集",
            "api_id": "123",
            "api_hash": "hash",
            "session_name": "primary",
            "target_chat": "-1001",
            "login_status": "done",
        }
    )
    server._listeners = FakeListenerManager()

    payload = server.listener_status_payload()

    assert payload["listener"] == {"status": "running", "message": "采集中"}
    assert payload["listeners"]["collector"] == "primary"


def test_raw_message_id_is_canonical_across_collector_accounts():
    class Message:
        id = 123
        message = "hello"
        date = None
        reply_to_msg_id = None
        reply_to = None

    class Event:
        message = Message()
        sender_id = 7900199668
        chat_id = -1001

    first = _raw_event_from_telethon(Event(), account_key="account_a")
    second = _raw_event_from_telethon(Event(), account_key="account_b")

    assert first.id == "tg:-1001:123"
    assert first.id == second.id


def test_raw_event_uses_cached_sender_name_when_available():
    class Sender:
        first_name = "韩"
        last_name = "天尊"
        username = "han_tianzun"
        bot = True
        title = None

    class Message:
        id = 9
        message = "广播"
        date = None
        reply_to_msg_id = None
        reply_to = None
        sender = Sender()

    class Event:
        message = Message()
        sender_id = 7900199668
        chat_id = -1001
        sender = Sender()

    event = _raw_event_from_telethon(Event(), account_key="primary")

    assert event.source == "韩 天尊"
    assert event.sender_is_bot is True


def test_raw_event_falls_back_to_sender_id_when_sender_missing():
    class Message:
        id = 10
        message = ""
        date = None
        reply_to_msg_id = None
        reply_to = None

    class Event:
        message = Message()
        sender_id = 8757550896
        chat_id = -1002

    event = _raw_event_from_telethon(Event())

    assert event.source == "8757550896"
    assert event.sender_is_bot is False


def test_format_sender_display_uses_channel_title():
    class Channel:
        title = "凌霄宫公告"

    assert _format_sender_display(Channel()) == "凌霄宫公告"


def test_format_sender_display_falls_back_to_username():
    class User:
        first_name = ""
        last_name = ""
        username = "wa2000"
        title = None

    assert _format_sender_display(User()) == "@wa2000"


def test_identities_are_separate_from_telegram_accounts(tmp_path):
    store = SQLiteStore(tmp_path / "miniweb.db")
    server = MiniWebServer(store=store)

    account = server.save_account_payload(
        {"local_id": "main", "api_id": "123", "api_hash": "hash", "phone": "+100"}
    )["account"]
    identity = server.save_identity_payload(
        {
            "send_as_id": "8659059191",
            "account_local_id": "main",
            "label": "WA2000",
            "daohao": "清源子",
            "realm": "化神",
            "sect_name": "凌霄宫",
        }
    )["identity"]
    payload = server.identities_payload()

    assert account["local_id"] == "main"
    assert identity["send_as_id"] == 8659059191
    assert identity["account_local_id"] == "main"
    assert payload["identities"][0]["account"]["local_id"] == "main"


def test_identity_allows_channel_send_as_id(tmp_path):
    server = MiniWebServer(store=SQLiteStore(tmp_path / "miniweb.db"))
    server.save_account_payload({"local_id": "main", "api_id": "123", "api_hash": "hash"})

    identity = server.save_identity_payload({"send_as_id": "-1001234567890", "account_local_id": "main"})["identity"]

    assert identity["send_as_id"] == -1001234567890


def test_identity_binding_requires_existing_account(tmp_path):
    server = MiniWebServer(store=SQLiteStore(tmp_path / "miniweb.db"))

    try:
        server.save_identity_payload({"send_as_id": "12345", "account_local_id": "missing"})
    except ValueError as exc:
        assert "绑定账号不存在" in str(exc)
    else:
        raise AssertionError("identity should not bind to a missing account")


def test_identity_payload_drops_legacy_profile_fields(tmp_path):
    """identities 表的 profile 类字段(道号 / 境界 / 宗门 / 灵根 / 战力)
    由消息箱解析自动写入,不应该出现在用户手填表单上。
    mini-web 不挂机不解析这些字段,因此直接从身份模型移除,角色面板走 state_patches。"""
    store = SQLiteStore(tmp_path / "miniweb.db")
    server = MiniWebServer(store=store)
    server.save_account_payload({"local_id": "main", "api_id": "123", "api_hash": "hash"})

    saved = server.save_identity_payload(
        {
            "send_as_id": "12345",
            "account_local_id": "main",
            "label": "WA2000",
            "daohao": "清源子",
            "realm": "化神",
            "sect_name": "凌霄宫",
        }
    )["identity"]

    assert "daohao" not in saved
    assert "realm" not in saved
    assert "sect_name" not in saved
    assert saved["label"] == "WA2000"


def test_identities_payload_classifies_self_and_channel_kinds(tmp_path):
    """UI 友好分类:
    send_as_id == 已登录账号 account_id => self;负数 => channel;
    其它正数 => self_unbound(预登记或 account_id 未拿到)。"""
    store = SQLiteStore(tmp_path / "miniweb.db")
    server = MiniWebServer(store=store)
    server.save_account_payload(
        {"local_id": "main", "api_id": "123", "api_hash": "hash", "account_id": "7900199668"}
    )
    server.save_identity_payload(
        {"send_as_id": "7900199668", "account_local_id": "main", "label": "self"}
    )
    server.save_identity_payload(
        {"send_as_id": "-1001234567890", "account_local_id": "main", "label": "channel"}
    )
    server.save_identity_payload(
        {"send_as_id": "9999", "account_local_id": "main", "label": "stranger"}
    )

    by_label = {item["label"]: item for item in server.identities_payload()["identities"]}

    assert by_label["self"]["kind"] == "self"
    assert by_label["channel"]["kind"] == "channel"
    assert by_label["stranger"]["kind"] == "self_unbound"


def test_account_login_done_upserts_self_identity(tmp_path):
    """account 一登录成功(account_id 已知),系统就把 identity_id == account_id 的
    self-identity upsert 进库,跳过手动建身份这一步。"""
    store = SQLiteStore(tmp_path / "miniweb.db")
    server = MiniWebServer(store=store)
    server.save_account_payload({"local_id": "main", "api_id": "123", "api_hash": "hash"})
    account = server.save_account_payload(
        {"local_id": "main", "account_id": "7900199668"}
    )["account"]

    server._ensure_self_identity(account)

    payload = server.identities_payload()
    self_identities = [item for item in payload["identities"] if item["kind"] == "self"]
    assert len(self_identities) == 1
    assert self_identities[0]["send_as_id"] == 7900199668
    assert self_identities[0]["account_local_id"] == "main"


def test_account_login_self_identity_is_idempotent(tmp_path):
    store = SQLiteStore(tmp_path / "miniweb.db")
    server = MiniWebServer(store=store)
    server.save_account_payload({"local_id": "main", "api_id": "123", "api_hash": "hash"})
    account = server.save_account_payload(
        {"local_id": "main", "account_id": "7900199668"}
    )["account"]

    server._ensure_self_identity(account)
    server._ensure_self_identity(account)

    payload = server.identities_payload()
    assert len([item for item in payload["identities"] if item["kind"] == "self"]) == 1


def test_planner_synthesizes_self_identity_when_action_matches_account_id(tmp_path):
    """action.identity_id == account.account_id 即「以自己身份发」,即使 identities
    表里没这条,plan 也应该 resolved=True,自动按 self-identity 处理。"""
    store = SQLiteStore(tmp_path / "miniweb.db")
    server = MiniWebServer(store=store)
    server.save_account_payload(
        {
            "local_id": "main",
            "api_id": "123",
            "api_hash": "hash",
            "account_id": "7900199668",
            "target_chat": "-1001234567890",
        }
    )
    planner = OutboxPlanner(store)

    plan = planner.plan(
        {
            "action": {
                "type": "copy",
                "label": "签到",
                "command": ".签到",
                "identity_id": 7900199668,
                "account_local_id": "main",
            }
        }
    )

    assert plan.resolved
    assert plan.identity is not None
    assert plan.identity.get("synthesized") is True
    assert plan.identity["send_as_id"] == 7900199668


def test_planner_marks_identity_missing_when_unknown(tmp_path):
    store = SQLiteStore(tmp_path / "miniweb.db")
    server = MiniWebServer(store=store)
    server.save_account_payload(
        {
            "local_id": "main",
            "api_id": "123",
            "api_hash": "hash",
            "account_id": "7900199668",
            "target_chat": "-1001234567890",
        }
    )
    planner = OutboxPlanner(store)

    plan = planner.plan(
        {
            "action": {
                "type": "copy",
                "label": "签到",
                "command": ".签到",
                "identity_id": 11111,
                "account_local_id": "main",
            }
        }
    )

    assert not plan.resolved
    assert "identity" in plan.missing


def test_messages_payload_supports_incremental_pull(tmp_path):
    """对照 docs/architecture.md inbox 设计:轮询应该走增量,不重传全部卡片。
    - 初始化(无 since_seq)取最新若干条 + 返 max_seq
    - 第二次带 since_seq → 只返新增,空列表也合法,max_seq 更新到当前水位
    """
    store = SQLiteStore(tmp_path / "miniweb.db")
    store.seed_samples_if_empty()
    server = MiniWebServer(store=store)

    initial = server.messages_payload("all")
    assert initial["messages"], "初始化应至少返回 sample 数据"
    assert initial["max_seq"] > 0
    assert initial["incremental"] is False

    high_water = initial["max_seq"]
    incremental = server.messages_payload("all", since_seq=high_water)
    assert incremental["messages"] == [], "没有新卡片应返空"
    assert incremental["max_seq"] >= high_water
    assert incremental["incremental"] is True


def test_messages_payload_initial_caps_with_default_limit(tmp_path):
    """初始化默认 limit=200,避免一次拉全 SQLite。"""
    store = SQLiteStore(tmp_path / "miniweb.db")
    # 灌 250 条假事件
    from backend.domain.models import RawMessageEvent
    for i in range(250):
        store.ingest_event(
            RawMessageEvent(
                id=f"bulk-{i}",
                chat_id=-1,
                msg_id=i,
                text=f"bulk message {i}",
                source="韩天尊",
                date=f"2026-05-15T{i:02d}:00:00+00:00" if i < 24 else "2026-05-16T00:00:00+00:00",
                sender_is_bot=True,
            )
        )
    server = MiniWebServer(store=store)

    payload = server.messages_payload("all")

    assert len(payload["messages"]) <= 200
    assert payload["max_seq"] >= len(payload["messages"])



    """GetSendAs / resolve-entity / batch identities / accounts delete 路由必须挂上,
    前端身份表单才有得用。"""
    from backend.app import GET_ROUTES, POST_ROUTES

    assert "/api/accounts/send-as-peers" in GET_ROUTES
    assert "/api/accounts/resolve-entity" in POST_ROUTES
    assert "/api/identities/batch" in POST_ROUTES
    assert "/api/accounts/delete" in POST_ROUTES


def test_delete_account_payload_removes_record(tmp_path):
    server = MiniWebServer(store=SQLiteStore(tmp_path / "miniweb.db"))
    server.save_account_payload({"local_id": "main", "api_id": "123", "api_hash": "hash"})
    assert any(item["local_id"] == "main" for item in server.accounts_payload()["accounts"])

    result = server.delete_account_payload({"local_id": "main"})

    assert result["ok"] is True
    assert result["deleted"] is True
    assert all(item["local_id"] != "main" for item in server.accounts_payload()["accounts"])


def test_delete_account_payload_rejects_missing_local_id(tmp_path):
    server = MiniWebServer(store=SQLiteStore(tmp_path / "miniweb.db"))
    result = server.delete_account_payload({})
    assert result["ok"] is False


def test_batch_save_identities_returns_per_item_results(tmp_path):
    """「新增身份」模态框:用户勾选多个 send_as,一次性提交,
    后端逐条 save_identity,每条独立返回 ok / error。"""
    server = MiniWebServer(store=SQLiteStore(tmp_path / "miniweb.db"))
    server.save_account_payload({"local_id": "main", "api_id": "123", "api_hash": "hash"})

    response = server.batch_save_identities_payload(
        {
            "identities": [
                {"send_as_id": "8659059191", "account_local_id": "main", "label": "A"},
                {"send_as_id": "0", "account_local_id": "main", "label": "bad"},
                {"send_as_id": "-1001234567890", "account_local_id": "missing", "label": "C"},
                {"send_as_id": "-1009999999999", "account_local_id": "main", "label": "D"},
            ]
        }
    )

    assert response["ok"] is True
    assert response["total"] == 4
    assert response["saved"] == 2
    results = response["results"]
    assert results[0]["ok"] is True
    assert results[1]["ok"] is False and "数字" in results[1]["error"]
    assert results[2]["ok"] is False and "账号" in results[2]["error"]
    assert results[3]["ok"] is True


def test_batch_save_identities_rejects_empty_list(tmp_path):
    server = MiniWebServer(store=SQLiteStore(tmp_path / "miniweb.db"))
    response = server.batch_save_identities_payload({"identities": []})
    assert response["ok"] is False
    assert "identities" in response["error"]


def test_send_as_payload_rejects_missing_account(tmp_path):
    server = MiniWebServer(store=SQLiteStore(tmp_path / "miniweb.db"))
    result = server.account_send_as_peers_payload("does_not_exist")

    assert result["ok"] is False
    assert "账号" in result["error"]


def test_send_as_payload_rejects_when_no_target_chat(tmp_path):
    server = MiniWebServer(store=SQLiteStore(tmp_path / "miniweb.db"))
    server.save_account_payload(
        {"local_id": "main", "api_id": "123", "api_hash": "hash", "phone": "+100"}
    )
    # 全局默认 target_chat 已被预设(ensure_default_settings),
    # 要测试「真的没目标」分支,先把 settings 里的 target_chat 清空,
    # 同时这个 account 自己也没 target_chat。
    server._store.save_settings({"target_chat": ""})
    result = server.account_send_as_peers_payload("main")

    assert result["ok"] is False
    assert "target_chat" in result["error"] or "目标群" in result["error"]


def test_identity_limit_is_independent_from_account_limit(tmp_path, monkeypatch):
    monkeypatch.setattr(server_module, "MAX_ACCOUNTS", 1)
    monkeypatch.setattr(server_module, "MAX_IDENTITIES", 2)
    server = MiniWebServer(store=SQLiteStore(tmp_path / "miniweb.db"))

    server.save_account_payload({"local_id": "main", "api_id": "123", "api_hash": "hash"})
    server.save_identity_payload({"send_as_id": "1001", "account_local_id": "main"})
    server.save_identity_payload({"send_as_id": "1002", "account_local_id": "main"})

    try:
        server.save_identity_payload({"send_as_id": "1003", "account_local_id": "main"})
    except ValueError as exc:
        assert "身份数量已达上限 2 个" in str(exc)
    else:
        raise AssertionError("third identity should exceed identity limit")


def test_legacy_listener_start_is_disabled_for_account_pool_model(tmp_path):
    server = MiniWebServer(store=SQLiteStore(tmp_path / "miniweb.db"))

    result = server.listener_start_payload()

    assert result["ok"] is False
    assert result["listener"]["status"] == "error"
    assert "账号池" in result["listener"]["message"]


def test_outbox_plan_resolves_identity_bound_account(tmp_path):
    store = SQLiteStore(tmp_path / "miniweb.db")
    server = MiniWebServer(store=store)
    server.save_account_payload(
        {
            "local_id": "main",
            "label": "主号",
            "api_id": "123",
            "api_hash": "hash",
            "target_chat": "-1001",
        }
    )
    server.save_identity_payload({"send_as_id": "8659059191", "account_local_id": "main", "label": "WA2000"})

    plan = server.outbox_plan_payload(
        {
            "command": ".自证 U9EX 13",
            "chat_id": -1001,
            "reply_to_msg_id": 8716381,
            "identity_id": 8659059191,
            "send_mode": "manual_confirm",
        }
    )

    assert plan["ok"] is True
    assert plan["resolved"] is True
    assert plan["can_send"] is False
    assert plan["account_local_id"] == "main"
    assert plan["send_as_id"] == 8659059191
    assert plan["reply_to_msg_id"] == 8716381


def test_outbox_plan_reports_missing_account_without_losing_reply_context(tmp_path):
    server = MiniWebServer(store=SQLiteStore(tmp_path / "miniweb.db"))

    plan = server.outbox_plan_payload(
        {
            "command": ".加入副本 394",
            "chat_id": -1001,
            "reply_to_msg_id": 8716381,
        }
    )

    assert plan["ok"] is True
    assert plan["resolved"] is False
    assert plan["missing"] == ["account"]
    assert plan["reply_to_msg_id"] == 8716381


def test_outbox_plan_tolerates_missing_identity_for_manual_fallback(tmp_path):
    server = MiniWebServer(store=SQLiteStore(tmp_path / "miniweb.db"))

    plan = server.outbox_plan_payload(
        {
            "command": ".加入副本 394",
            "chat_id": -1001,
            "reply_to_msg_id": 8716381,
            "identity_id": 8659059191,
        }
    )

    assert plan["ok"] is True
    assert plan["resolved"] is False
    assert plan["missing"] == ["identity", "account"]
    assert plan["identity_id"] == 8659059191
    assert plan["reply_to_msg_id"] == 8716381


def test_outbox_plan_uses_account_target_chat_when_action_has_no_chat(tmp_path):
    store = SQLiteStore(tmp_path / "miniweb.db")
    server = MiniWebServer(store=store)
    server.save_account_payload(
        {
            "local_id": "main",
            "label": "主号",
            "api_id": "123",
            "api_hash": "hash",
            "target_chat": "-1001",
        }
    )

    plan = server.outbox_plan_payload({"command": ".查看储物袋", "account_local_id": "main"})

    assert plan["ok"] is True
    assert plan["resolved"] is True
    assert plan["target_chat"] == "-1001"
    assert plan["chat_id"] is None


def test_outbox_draft_roundtrip_preserves_reply_context(tmp_path):
    store = SQLiteStore(tmp_path / "miniweb.db")
    server = MiniWebServer(store=store)
    server.save_account_payload(
        {
            "local_id": "main",
            "label": "主号",
            "api_id": "123",
            "api_hash": "hash",
            "target_chat": "-1001",
        }
    )

    created = server.create_outbox_draft_payload(
        {
            "command": ".加入副本 394",
            "reply_to_msg_id": 8716381,
            "account_local_id": "main",
            "source_message_id": "tg:-1001:8716381",
        }
    )
    payload = server.outbox_drafts_payload()

    assert created["ok"] is True
    assert created["draft"]["id"]
    assert created["draft"]["command"] == ".加入副本 394"
    assert created["draft"]["reply_to_msg_id"] == 8716381
    assert created["draft"]["source_message_id"] == "tg:-1001:8716381"
    assert payload["drafts"][0]["id"] == created["draft"]["id"]


def test_outbox_draft_delete(tmp_path):
    store = SQLiteStore(tmp_path / "miniweb.db")
    server = MiniWebServer(store=store)
    server.save_account_payload(
        {
            "local_id": "main",
            "label": "主号",
            "api_id": "123",
            "api_hash": "hash",
            "target_chat": "-1001",
        }
    )
    draft = server.create_outbox_draft_payload(
        {"command": ".查看储物袋", "account_local_id": "main"}
    )["draft"]

    deleted = server.delete_outbox_draft_payload({"id": draft["id"]})

    assert deleted == {"ok": True, "deleted": True}
    assert server.outbox_drafts_payload()["drafts"] == []


def test_telegram_dialogs_report_config_error_without_crashing(tmp_path):
    server = MiniWebServer(store=SQLiteStore(tmp_path / "miniweb.db"))

    import asyncio

    result = asyncio.run(server.telegram_dialogs_payload())

    assert result["ok"] is False
    assert result["dialogs"] == []
    assert "API ID" in result["error"]


def test_telegram_topics_require_target_chat(tmp_path):
    """target_chat 现在有默认值(-1001680975844),要测试「真的没目标群」分支
    需要显式把 settings 里 target_chat 清空。"""
    store = SQLiteStore(tmp_path / "miniweb.db")
    store.save_settings({"target_chat": ""})  # 显式清空,绕过默认
    server = MiniWebServer(store=store)

    import asyncio

    result = asyncio.run(server.telegram_topics_payload(""))

    assert result["ok"] is False
    assert result["topics"] == []
    assert "目标群" in result["error"]


def test_api_auth_helper_accepts_header_or_bearer_token():
    assert is_authorized_api_headers({}, "") is True
    assert is_authorized_api_headers({"X-Miniweb-Token": "secret"}, "secret") is True
    assert is_authorized_api_headers({"Authorization": "Bearer secret"}, "secret") is True
    assert is_authorized_api_headers({"X-Miniweb-Token": "wrong"}, "secret") is False


def test_app_import_does_not_create_default_server():
    assert MiniWebHandler.app_server is None


def test_create_handler_injects_server_instance():
    server = MiniWebServer(store=SampleStore())
    handler = create_handler(server, access_token="test-token")

    assert handler.app_server is server
    assert handler.access_token == "test-token"


def test_telethon_proxy_config_matches_old_script_shape():
    proxy = build_telethon_proxy(
        {
            "proxy_type": "socks5",
            "proxy_host": "127.0.0.1:7890",
            "proxy_username": "user",
            "proxy_password": "pass",
        }
    )

    assert proxy == {
        "proxy_type": "socks5",
        "addr": "127.0.0.1",
        "port": 7890,
        "rdns": True,
        "username": "user",
        "password": "pass",
    }


def test_proxy_host_validation():
    assert split_host_port("localhost:1080") == ("localhost", 1080)

    try:
        split_host_port("localhost")
    except ValueError as exc:
        assert "host:port" in str(exc)
    else:
        raise AssertionError("invalid proxy host should fail")


def test_discovered_bots_filters_by_game_keyword_hits(tmp_path):
    """discovered bots 只列「真发过游戏 bot 风格消息」的 sender。
    频道号闲聊(没游戏关键词)不该被丢进来。"""
    from backend.domain.models import RawMessageEvent
    store = SQLiteStore(tmp_path / "miniweb.db")
    # 一个 bot 用户发游戏卡片(应被发现)
    store.ingest_event(RawMessageEvent(
        id="tg:-1001:1", chat_id=-1001, msg_id=1,
        text="📊 【天机阁 · 战力评估】\n⚔️ 综合战力: 333.8万",
        source="韩天尊", date="2026-05-16T01:00:00+00:00",
        sender_id=7900199668, sender_is_bot=True,
    ))
    store.ingest_event(RawMessageEvent(
        id="tg:-1001:2", chat_id=-1001, msg_id=2,
        text="点卯成功,获得宗门贡献",
        source="韩天尊", date="2026-05-16T01:01:00+00:00",
        sender_id=7900199668, sender_is_bot=True,
    ))
    # 一个频道号闲聊(无游戏关键词,应被过滤)
    store.ingest_event(RawMessageEvent(
        id="tg:-1001:3", chat_id=-1001, msg_id=3,
        text="今天天气真好啊,出去走走",
        source="玩家闲聊频道", date="2026-05-16T01:02:00+00:00",
        sender_id=-1009999999999, sender_is_bot=False,
    ))
    # 一个频道号发指令(`.` 开头,不算 bot 回复)
    store.ingest_event(RawMessageEvent(
        id="tg:-1001:4", chat_id=-1001, msg_id=4,
        text=".签到 .点卯",
        source="另一玩家", date="2026-05-16T01:03:00+00:00",
        sender_id=-1008888888888, sender_is_bot=False,
    ))

    discovered = store.list_discovered_bots()
    sender_ids = {item["sender_id"] for item in discovered}
    assert 7900199668 in sender_ids, "命中关键词的 bot 应被发现"
    assert -1009999999999 not in sender_ids, "闲聊频道不该被丢进来"
    assert -1008888888888 not in sender_ids, "玩家发指令(. 开头)不该被当 bot"

    bot_item = next(item for item in discovered if item["sender_id"] == 7900199668)
    assert bot_item["hit_count"] >= 1
    assert bot_item["matched_families"]


def test_discovered_bots_keeps_manual_marked_even_without_messages(tmp_path):
    """game_bot_ids 里手动加的 sender,即使消息箱里没采到过,也要列出来让用户能取消。"""
    store = SQLiteStore(tmp_path / "miniweb.db")
    store.save_settings({"game_bot_ids": [7900199668]})
    server = MiniWebServer(store=store)

    payload = server.discovered_bots_payload()

    assert any(
        item["sender_id"] == 7900199668 and item.get("manual_only") and item["is_game_bot"]
        for item in payload["discovered"]
    )


def test_schedule_presets_payload_lists_known_presets():
    """5 个预设(深度闭关 / 抚摸 / 温养 / 试炼 + 自定义)。"""
    import tempfile, pathlib
    with tempfile.TemporaryDirectory() as tmp:
        server = MiniWebServer(store=SQLiteStore(pathlib.Path(tmp) / "x.db"))
        payload = server.schedule_presets_payload()
    assert payload["ok"] is True
    keys = {p["key"] for p in payload["presets"]}
    assert keys >= {"deep_retreat", "pet_touch", "pet_warm", "pet_trial", "custom"}


def test_schedule_preview_deep_retreat_returns_plan_items(tmp_path):
    server = MiniWebServer(store=SQLiteStore(tmp_path / "miniweb.db"))
    result = server.schedule_preview_payload({"preset_key": "deep_retreat", "horizon_days": 2})
    assert result["ok"] is True
    items = result["items"]
    assert items, "深度闭关 2 天应至少出 1 个 CD 周期"
    commands = [it["command"] for it in items]
    assert "查看闭关" in commands
    assert ".深度闭关" in commands


def test_schedule_preview_custom_uses_user_command(tmp_path):
    server = MiniWebServer(store=SQLiteStore(tmp_path / "miniweb.db"))
    result = server.schedule_preview_payload(
        {"preset_key": "custom", "command": ".签到", "interval_sec": 3600, "count": 3}
    )
    assert result["ok"] is True
    assert len(result["items"]) == 3
    assert all(it["command"] == ".签到" for it in result["items"])


def test_schedule_create_dry_run_writes_batch_without_telegram(tmp_path):
    store = SQLiteStore(tmp_path / "miniweb.db")
    server = MiniWebServer(store=store)
    server.save_account_payload(
        {"local_id": "main", "api_id": "123", "api_hash": "hash", "account_id": "12345"}
    )
    server.save_identity_payload({"send_as_id": "12345", "account_local_id": "main"})

    result = server.schedule_create_payload(
        {"send_as_id": 12345, "preset_key": "deep_retreat", "horizon_days": 1, "dry_run": True}
    )
    assert result["ok"] is True
    assert result["dry_run"] is True
    assert result["planned_count"] > 0
    assert result["created_official"] == 0

    listing = server.schedule_list_payload()
    assert len(listing["batches"]) == 1
    assert listing["batches"][0]["counts"]["planned"] > 0


def test_schedule_delete_marks_batch_and_messages_deleted(tmp_path):
    store = SQLiteStore(tmp_path / "miniweb.db")
    server = MiniWebServer(store=store)
    server.save_account_payload(
        {"local_id": "main", "api_id": "123", "api_hash": "hash", "account_id": "12345"}
    )
    server.save_identity_payload({"send_as_id": "12345", "account_local_id": "main"})
    created = server.schedule_create_payload(
        {"send_as_id": 12345, "preset_key": "deep_retreat", "horizon_days": 1, "dry_run": True}
    )
    deleted = server.schedule_delete_payload({"batch_id": created["batch_id"]})
    assert deleted["ok"] is True
    assert deleted["local"]["batch"] == 1
    assert server.schedule_list_payload()["batches"] == []


def test_schedule_routes_are_wired():
    from backend.app import GET_ROUTES, POST_ROUTES
    assert "/api/schedule/presets" in GET_ROUTES
    assert "/api/schedule" in GET_ROUTES
    assert "/api/schedule/sync" in GET_ROUTES
    assert "/api/schedule/preview" in POST_ROUTES
    assert "/api/schedule/create" in POST_ROUTES
    assert "/api/schedule/delete" in POST_ROUTES


def test_schedule_sync_without_listener_returns_error(tmp_path):
    """没有 listener 在跑就没 client 可拉 TG,这时 sync 应明确报错而不是默默挂掉。"""
    store = SQLiteStore(tmp_path / "miniweb.db")
    server = MiniWebServer(store=store)
    server.save_account_payload(
        {"local_id": "main", "api_id": "123", "api_hash": "hash", "account_id": "12345"}
    )
    server.save_identity_payload({"send_as_id": "12345", "account_local_id": "main"})

    result = server.schedule_sync_payload(12345)

    assert result["ok"] is False
    assert "采集" in result["error"]


def test_schedule_sync_reconciles_with_local_records(tmp_path):
    """灌假 listener,模拟 TG 返回 3 条 scheduled,本地有 2 条(一条对得上、一条 TG 没了),
    sync 应正确分出 matched / orphans / lost。"""
    class FakeListenerManager:
        def status(self, local_id=None):
            return {"status": "running", "message": ""} if local_id else {
                "max_listeners": 1,
                "collector": "main",
                "running": {"main": {"status": "running", "message": "ok"}},
            }

        def stop(self, _local_id):
            return {"status": "stopped", "message": "fake"}

        def get_listener(self, local_id):
            if local_id != "main":
                return None
            outer = self

            class FakeListener:
                def is_running(self):
                    return True

                def submit(self, coro_factory, *, timeout=30.0):
                    # 直接返我们假造的 TG 列表,不真去 Telegram
                    return [
                        {"scheduled_msg_id": 100, "message": ".签到", "schedule_at": 0, "schedule_text": ""},
                        {"scheduled_msg_id": 101, "message": ".抚摸法宝", "schedule_at": 0, "schedule_text": ""},
                        {"scheduled_msg_id": 999, "message": "orphan from phone", "schedule_at": 0, "schedule_text": ""},
                    ]

            return FakeListener()

    store = SQLiteStore(tmp_path / "miniweb.db")
    server = MiniWebServer(store=store)
    server.save_account_payload(
        {"local_id": "main", "api_id": "123", "api_hash": "hash", "account_id": "12345"}
    )
    server.save_identity_payload({"send_as_id": "12345", "account_local_id": "main"})

    # 建一个 batch,人为标记两条已排:scheduled_msg_id=100(对得上 TG)+ scheduled_msg_id=555(TG 没有,会成为 lost)
    server.schedule_create_payload(
        {"send_as_id": 12345, "preset_key": "custom", "command": ".签到", "interval_sec": 60, "count": 2, "dry_run": True}
    )
    msgs = store.list_schedule_messages(send_as_id=12345)
    store.mark_schedule_message(msgs[0]["id"], scheduled_msg_id=100, status="scheduled")
    store.mark_schedule_message(msgs[1]["id"], scheduled_msg_id=555, status="scheduled")

    server._listeners = FakeListenerManager()

    result = server.schedule_sync_payload(12345)

    assert result["ok"] is True
    assert len(result["tg_messages"]) == 3
    assert len(result["matched"]) == 1
    assert result["matched"][0]["tg"]["scheduled_msg_id"] == 100
    assert any(o["scheduled_msg_id"] == 999 for o in result["orphans"]), "TG 多出来的应在 orphans"
    assert any(o["scheduled_msg_id"] == 101 for o in result["orphans"]), "TG 有但本地没的也算 orphans"
    assert any(l["scheduled_msg_id"] == 555 for l in result["lost"]), "本地标已排但 TG 没找到的应在 lost"



# ====================================================================
# Identity state machine framework (deep_retreat / pet_touch / pet_warm)
# ====================================================================

def test_parse_chinese_duration_handles_mixed_units():
    from backend.identity_state.duration import parse_chinese_duration
    assert parse_chinese_duration("8 小时") == 8 * 3600
    assert parse_chinese_duration("5小时57分钟31秒") == 5 * 3600 + 57 * 60 + 31
    assert parse_chinese_duration("9分钟") == 540
    assert parse_chinese_duration("1天2小时") == 86400 + 7200
    assert parse_chinese_duration("空") == 0
    assert parse_chinese_duration("") == 0


def test_classify_sender_buckets_correctly():
    from backend.identity_state import classify_sender
    assert classify_sender(12345, my_identities={12345}, game_bot_ids={}) == "self"
    assert classify_sender(-1003983937918, my_identities={}, game_bot_ids={-1003983937918}) == "bot"
    assert classify_sender(8388633812, my_identities={}, game_bot_ids={8388633812}) == "bot"
    assert classify_sender(-100200300, my_identities={}, game_bot_ids={}) == "channel"
    assert classify_sender(99999, my_identities={}, game_bot_ids={}) == "player"
    assert classify_sender(None, my_identities={}, game_bot_ids={}) == "player"


def _fake_ctx(*, parent, sender_kind, now=1_700_000_000.0):
    from backend.identity_state import ObserveContext
    return ObserveContext(
        parent=parent,
        sender_kind=sender_kind,
        my_identities=frozenset({12345}),
        game_bot_ids=frozenset({-1003983937918}),
        settings={},
        now=now,
    )


def _evt(**kw):
    from backend.domain.models import RawMessageEvent
    base = dict(id="x", chat_id=-1001680975844, msg_id=0, text="",
                source="", date="", sender_id=None, reply_to_msg_id=None)
    base.update(kw)
    return RawMessageEvent(**base)


def test_deep_retreat_module_captures_entry_and_cooldown():
    from backend.identity_state.deep_retreat import DeepRetreatModule, DEEP_RETREAT_DEFAULT_CD
    module = DeepRetreatModule()
    parent = _evt(id="p", msg_id=100, text=".深度闭关", sender_id=12345)
    event = _evt(
        id="e",
        msg_id=101,
        text="你已进入深度闭关状态，神魂将自行吐纳 8 小时。\n期间你将无法进行大部分操作。下次发言时将自动结算本次闭关的收获。",
        sender_id=-1003983937918,
        reply_to_msg_id=100,
    )
    ctx = _fake_ctx(parent=parent, sender_kind="bot")
    state = module.observe(event, ctx, dict(module.default_state))
    assert state is not None
    assert state["phase"] == "running"
    assert state["entered_at"] == ctx.now
    assert state["cooldown_until"] == ctx.now + DEEP_RETREAT_DEFAULT_CD
    assert module.compute_anchor(state, now=ctx.now) == state["cooldown_until"]
    summary = module.status_summary(state, now=ctx.now)
    assert "剩" in summary["text"]
    assert summary["ready"] is False


def test_deep_retreat_module_ignores_player_messages():
    from backend.identity_state.deep_retreat import DeepRetreatModule
    module = DeepRetreatModule()
    parent = _evt(id="p", msg_id=100, text=".深度闭关", sender_id=12345)
    event = _evt(
        id="e",
        msg_id=101,
        text="你已进入深度闭关状态，神魂将自行吐纳 8 小时。",
        sender_id=99999,  # 玩家
        reply_to_msg_id=100,
    )
    ctx = _fake_ctx(parent=parent, sender_kind="player")
    # resolve_target 要求 sender_kind=='bot',player 不会被处理
    assert module.resolve_target(event, ctx) is None


def test_pet_touch_module_records_pet_name_from_parent_command():
    from backend.identity_state.pet_touch import PetTouchModule, PET_TOUCH_DEFAULT_CD
    module = PetTouchModule()
    parent = _evt(id="p", msg_id=200, text=".抚摸法宝 玄天斩灵剑", sender_id=12345)
    event = _evt(
        id="e",
        msg_id=201,
        text="你抚摸了玄天斩灵剑，与法宝心意相通。(默契+1, 经验+5)",
        sender_id=-1003983937918,
        reply_to_msg_id=200,
    )
    ctx = _fake_ctx(parent=parent, sender_kind="bot")
    state = module.observe(event, ctx, dict(module.default_state))
    assert state["pet_name"] == "玄天斩灵剑"
    assert state["cooldown_until"] == ctx.now + PET_TOUCH_DEFAULT_CD


def test_pet_warm_module_respects_cd_reply_wait():
    from backend.identity_state.pet_warm import PetWarmModule
    module = PetWarmModule()
    parent = _evt(id="p", msg_id=300, text=".温养器灵 青竹蜂云剑（庚金版）", sender_id=12345)
    event = _evt(
        id="e",
        msg_id=301,
        text="器灵方才吞纳过灵机，请在 5小时57分钟31秒 后再行温养。",
        sender_id=-1003983937918,
        reply_to_msg_id=300,
    )
    ctx = _fake_ctx(parent=parent, sender_kind="bot")
    state = module.observe(event, ctx, dict(module.default_state))
    assert state["pet_name"] == "青竹蜂云剑（庚金版）"
    assert state["cooldown_until"] == ctx.now + 5 * 3600 + 57 * 60 + 31


def test_module_registry_observe_only_writes_when_state_changes():
    from backend.identity_state import build_default_registry
    reg = build_default_registry()
    parent = _evt(id="p", msg_id=200, text=".抚摸法宝 玄天斩灵剑", sender_id=12345)
    unrelated = _evt(id="e", msg_id=201, text="今天天气真好。", sender_id=-1003983937918, reply_to_msg_id=200)
    storage: dict = {}
    def _get(sid, key):
        return {"state": storage.get((sid, key))} if (sid, key) in storage else None
    def _save(sid, key, state, src):
        storage[(sid, key)] = state
    ctx = _fake_ctx(parent=parent, sender_kind="bot")
    results = reg.observe_all(unrelated, ctx, get_state=_get, save_state=_save)
    assert results == []
    assert storage == {}


def test_sqlite_store_persists_module_state_via_pipeline(tmp_path):
    from backend.domain.models import RawMessageEvent
    store = SQLiteStore(tmp_path / "miniweb.db")
    store.save_settings({"game_bot_ids": [-1003983937918]})
    store.save_identity({"send_as_id": 12345, "label": "me"})

    parent = RawMessageEvent(
        id="p1", chat_id=-1001680975844, msg_id=100,
        text=".深度闭关", source="", date="", sender_id=12345,
    )
    store.ingest_event(parent)
    bot_reply = RawMessageEvent(
        id="e1", chat_id=-1001680975844, msg_id=101,
        text="你已进入深度闭关状态，神魂将自行吐纳 8 小时。",
        source="", date="", sender_id=-1003983937918, reply_to_msg_id=100,
    )
    store.ingest_event(bot_reply)

    record = store.get_module_state(12345, "deep_retreat")
    assert record is not None
    assert record["state"]["phase"] == "running"
    assert record["state"]["cooldown_until"] > record["state"]["entered_at"]


def test_identity_state_payload_groups_by_send_as(tmp_path):
    from backend.domain.models import RawMessageEvent
    store = SQLiteStore(tmp_path / "miniweb.db")
    store.save_settings({"game_bot_ids": [-1003983937918]})
    store.save_identity({"send_as_id": 12345, "label": "me"})
    store.ingest_event(RawMessageEvent(
        id="p1", chat_id=-1001680975844, msg_id=100,
        text=".抚摸法宝 玄天斩灵剑", source="", date="", sender_id=12345,
    ))
    store.ingest_event(RawMessageEvent(
        id="e1", chat_id=-1001680975844, msg_id=101,
        text="你抚摸了玄天斩灵剑(默契+1, 经验+5)", source="", date="",
        sender_id=-1003983937918, reply_to_msg_id=100,
    ))
    server = MiniWebServer(store=store)
    payload = server.identity_state_payload("")
    assert payload["ok"] is True
    assert {m["key"] for m in payload["modules"]} == {"deep_retreat", "pet_touch", "pet_warm"}
    by_identity = payload["by_identity"]
    assert any(entry["send_as_id"] == 12345 for entry in by_identity)
    me_items = next(entry for entry in by_identity if entry["send_as_id"] == 12345)["items"]
    pet_item = next(i for i in me_items if i["module_key"] == "pet_touch")
    assert pet_item["state"]["pet_name"] == "玄天斩灵剑"
    assert "剩" in pet_item["summary"]["text"] or pet_item["summary"]["ready"]


def test_schedule_build_plan_uses_auto_anchor_resolver(tmp_path):
    from backend.outbox.schedule import build_plan
    import time
    now = time.time()
    later = now + 5 * 3600  # 5h 后才可用
    resolver_calls: list[tuple[int, str]] = []
    def resolver(sid: int, key: str) -> float | None:
        resolver_calls.append((sid, key))
        return later
    plan = build_plan(
        {
            "preset_key": "deep_retreat",
            "anchor_at": now,
            "horizon_days": 1,
            "auto_anchor": True,
            "auto_anchor_module": "deep_retreat",
            "send_as_id": 12345,
        },
        anchor_resolver=resolver,
    )
    assert plan["auto_anchor_used"] is True
    assert plan["anchor_at"] == later
    assert resolver_calls == [(12345, "deep_retreat")]
    # 没有 auto_anchor 时,resolver 不应被调
    resolver_calls.clear()
    plan2 = build_plan({"preset_key": "deep_retreat", "anchor_at": now, "horizon_days": 1}, anchor_resolver=resolver)
    assert plan2["auto_anchor_used"] is False
    assert resolver_calls == []


def test_identity_state_route_is_wired():
    routes_get = create_handler(MiniWebServer())
    assert "/api/identity-state" in routes_get.__dict__.get("__module__", "") or True
    # The above is a soft check; rely on the imports route table directly:
    from backend.app import GET_ROUTES
    assert "/api/identity-state" in GET_ROUTES


def test_backfill_module_states_replays_existing_raw_messages(tmp_path):
    """模拟"老库":raw_messages 已经有数据,但 identity_module_state 是空的。
    backfill_module_states_if_empty 应该重新跑 pipeline,把 module state 填好。"""
    import json as _json, time as _time
    store = SQLiteStore(tmp_path / "miniweb.db")
    store.save_settings({"game_bot_ids": [-1003983937918]})
    store.save_identity({"send_as_id": 12345, "label": "me"})

    # 绕过 ingest_event,直接 SQL 写两条 raw_messages,模拟"老 pipeline 跑过但 module 表为空"
    with store._connect() as conn:
        for (mid, sid, reply_to, text) in [
            (100, 12345, None, ".深度闭关"),
            (101, -1003983937918, 100, "你已进入深度闭关状态，神魂将自行吐纳 8 小时。"),
        ]:
            conn.execute(
                """
                INSERT INTO raw_messages(id, chat_id, msg_id, text, source, date,
                    sender_id, reply_to_msg_id, top_msg_id, mentions_json, sender_is_bot)
                VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (f"raw-{mid}", -1001680975844, mid, text, "", "2026-05-15T00:00:00Z",
                 sid, reply_to, None, _json.dumps([]), int(sid < 0)),
            )

    assert store.list_module_states() == []
    processed = store.backfill_module_states_if_empty()
    assert processed == 2
    record = store.get_module_state(12345, "deep_retreat")
    assert record is not None
    assert record["state"]["phase"] == "running"
    assert record["state"]["cooldown_until"] > record["state"]["entered_at"]


def test_backfill_module_states_noop_when_table_nonempty(tmp_path):
    """已经有 state 就不再重放,避免重启时反复扫表。"""
    store = SQLiteStore(tmp_path / "miniweb.db")
    store.save_module_state(12345, "deep_retreat", {"phase": "running"}, source_message_id="sentinel")
    assert store.backfill_module_states_if_empty() == 0


def test_schedule_build_plan_auto_anchor_first_due_lands_on_cooldown_until():
    """auto_anchor 推算的下次可用时间是 cooldown_until。
    第一条 plan(trigger 词)应该落在 cooldown_until + 触发偏移(60-120s + jitter),
    而不是再加一整个 CD。"""
    from backend.outbox.schedule import build_plan, DEEP_RETREAT_CD, DEFAULT_TRIGGER_DELAY_SEC, JITTER_MAX_SEC
    import time
    now = time.time()
    cooldown_until = now + 3 * 3600 + 35 * 60  # 状态机说"还剩 3:35"
    def resolver(sid: int, key: str) -> float | None:
        return cooldown_until
    plan = build_plan(
        {
            "preset_key": "deep_retreat",
            "anchor_at": now,
            "horizon_days": 1,
            "auto_anchor": True,
            "auto_anchor_module": "deep_retreat",
            "send_as_id": 12345,
        },
        anchor_resolver=resolver,
    )
    assert plan["auto_anchor_used"] is True
    assert plan["anchor_at"] == cooldown_until  # 显示锚点保持 cooldown_until
    assert plan["items"], "应该至少有一条 item"
    first_due = plan["items"][0]["schedule_at"]
    # 第一条 = anchor + 触发偏移(默认 60s)+ jitter[0, JITTER_MAX_SEC]
    # 区间:cooldown_until + 60 ~ cooldown_until + 60 + JITTER_MAX
    lo = cooldown_until + DEFAULT_TRIGGER_DELAY_SEC
    hi = cooldown_until + DEFAULT_TRIGGER_DELAY_SEC + JITTER_MAX_SEC + 5
    assert lo <= first_due <= hi, f"first_due={first_due}, expected in [{lo}, {hi}]"
    assert plan["first_due_at"] == first_due
    # horizon 不缩水:1 天的窗口里至少能塞下 1 个 CD(8h)的下一对
    last_due = plan["items"][-1]["schedule_at"]
    assert last_due > cooldown_until + DEEP_RETREAT_CD, "1 天 horizon 至少跨过一次 CD"


def test_estimate_send_seconds_scales_with_count():
    """估算函数随条数线性增长,21 天 60 条应该落在 30-50 分钟区间。"""
    from backend.server import _estimate_send_seconds
    assert _estimate_send_seconds(0) == 0
    assert _estimate_send_seconds(1) == 1
    six = _estimate_send_seconds(6)
    assert 100 < six < 250
    sixty = _estimate_send_seconds(60)
    assert 30 * 60 < sixty < 50 * 60


def test_schedule_create_returns_immediately_with_sending_status(tmp_path):
    """real send 模式下,schedule_create_payload 应该立刻返,不阻塞等待发送完成。
    submit_background 被调用一次,batch.status 标 sending。"""
    submitted: list = []
    background_ran = []

    class FakeListener:
        def is_running(self):
            return True

        def submit_background(self, coro_factory):
            submitted.append(coro_factory)

            class FakeFuture:
                def cancel(self): pass

            return FakeFuture()

        def submit(self, coro_factory, *, timeout=30.0):
            return None

    class FakeListenerManager:
        def get_listener(self, *_args, **_kwargs):
            return FakeListener()

    store = SQLiteStore(tmp_path / "miniweb.db")
    store.save_settings({"target_chat": "-1001680975844", "target_topic_id": 7310786})
    server = MiniWebServer(store=store)
    server.save_account_payload({"local_id": "main", "api_id": "1", "api_hash": "h", "account_id": "12345"})
    server.save_identity_payload({"send_as_id": "12345", "account_local_id": "main"})
    server._listeners = FakeListenerManager()

    result = server.schedule_create_payload({
        "send_as_id": 12345,
        "preset_key": "custom",
        "command": ".签到",
        "interval_sec": 60,
        "count": 3,
        "dry_run": False,
    })
    assert result["ok"] is True, result
    assert result["status"] == "sending"
    assert result["estimate_seconds"] > 0
    # submit_background 应该恰好被调一次
    assert len(submitted) == 1
    # batch 状态在 store 里应该是 sending
    batches = store.list_schedule_batches(include_inactive=True)
    assert any(b["id"] == result["batch_id"] and b["status"] == "sending" for b in batches)


def test_schedule_cancel_marks_batch_cancelled(tmp_path):
    """cancel API 把 sending 批次标 cancelled,后台 loop 看到就早退。"""
    store = SQLiteStore(tmp_path / "miniweb.db")
    server = MiniWebServer(store=store)
    server.save_account_payload({"local_id": "main", "api_id": "1", "api_hash": "h", "account_id": "12345"})
    server.save_identity_payload({"send_as_id": "12345", "account_local_id": "main"})
    server.schedule_create_payload({
        "send_as_id": 12345,
        "preset_key": "custom",
        "command": ".签到",
        "interval_sec": 60,
        "count": 2,
        "dry_run": True,
    })
    batch_id = store.list_schedule_batches(include_inactive=True)[0]["id"]
    # dry_run 不会进 sending,先手动标
    store.set_schedule_batch_status(batch_id, "sending")

    result = server.schedule_cancel_payload({"batch_id": batch_id})
    assert result["ok"] is True
    assert result["status"] == "cancelled"
    refreshed = store.list_schedule_batches(include_inactive=True)
    assert any(b["id"] == batch_id and b["status"] == "cancelled" for b in refreshed)


def test_schedule_cancel_route_is_wired():
    from backend.app import POST_ROUTES
    assert "/api/schedule/cancel" in POST_ROUTES


def test_messages_solo_mode_filters_to_me_and_bot_replies(tmp_path):
    """solo 模式 SQL 过滤:只返我发的消息 + bot 回我的消息。
    与窗口大小无关 — 这是修「200 条窗口里没我自己的消息,solo 一片空白」的关键。"""
    from backend.domain.models import RawMessageEvent
    store = SQLiteStore(tmp_path / "miniweb.db")
    store.save_settings({"game_bot_ids": [-100]})
    store.save_identity({"send_as_id": 12345, "label": "me"})

    # 灌一堆杂讯(其他玩家 + bot 回别人) + 一条我的指令 + 一条 bot 回我
    events = [
        RawMessageEvent(id=f"noise-{i}", chat_id=-1, msg_id=1000 + i, text="嘿嘿",
                        source="", date="", sender_id=99000 + i)
        for i in range(50)
    ]
    events.append(RawMessageEvent(id="me1", chat_id=-1, msg_id=2000, text=".我的灵根",
                                   source="", date="", sender_id=12345))
    events.append(RawMessageEvent(id="bot1", chat_id=-1, msg_id=2001, text="你的灵根:玄灵根",
                                   source="", date="", sender_id=-100, reply_to_msg_id=2000))
    events.append(RawMessageEvent(id="bot-other", chat_id=-1, msg_id=2002, text="你的灵根:火灵根",
                                   source="", date="", sender_id=-100, reply_to_msg_id=1010))
    for ev in events:
        store.ingest_event(ev)

    server = MiniWebServer(store=store)
    payload = server.messages_payload("all", limit=200, mode="solo")
    ids = {m["id"] for m in payload["messages"]}
    assert "me1" in ids
    assert "bot1" in ids
    assert "bot-other" not in ids
    assert all(not m["id"].startswith("noise-") for m in payload["messages"])
    assert payload["mode"] == "solo"


def test_messages_before_seq_returns_older(tmp_path):
    """before_seq 给「日志 modal 加载更早」用,返 rowid < before_seq 的卡片。"""
    from backend.domain.models import RawMessageEvent
    store = SQLiteStore(tmp_path / "miniweb.db")
    for i in range(10):
        store.ingest_event(RawMessageEvent(
            id=f"e-{i}", chat_id=-1, msg_id=1000 + i, text=f"#{i}",
            source="", date="", sender_id=99,
        ))
    server = MiniWebServer(store=store)
    first = server.messages_payload("all", limit=3)
    assert len(first["messages"]) == 3
    oldest_seq = min(m["seq"] for m in first["messages"])
    page2 = server.messages_payload("all", limit=3, before_seq=oldest_seq)
    page2_seqs = {m["seq"] for m in page2["messages"]}
    assert page2_seqs and max(page2_seqs) < oldest_seq


def test_messages_export_jsonl_returns_full_dataset(tmp_path):
    """日志 modal 的「导出」端点:无 limit 全量,jsonl 格式每行一个卡片。"""
    from backend.domain.models import RawMessageEvent
    store = SQLiteStore(tmp_path / "miniweb.db")
    for i in range(5):
        store.ingest_event(RawMessageEvent(
            id=f"e-{i}", chat_id=-1, msg_id=1000 + i, text=f"msg {i}",
            source="", date="", sender_id=99,
        ))
    server = MiniWebServer(store=store)
    result = server.messages_export_payload("all", fmt="jsonl")
    assert "body" in result and isinstance(result["body"], bytes)
    assert "ndjson" in result["content_type"]
    lines = result["body"].decode("utf-8").strip().split("\n")
    assert len(lines) == 5
    import json as _json
    parsed = [_json.loads(line) for line in lines]
    assert {p["id"] for p in parsed} == {f"e-{i}" for i in range(5)}
    # 文件名带时间戳和 mode/channel
    assert result["filename"].startswith("xiuxian-messages-")
    assert result["filename"].endswith(".jsonl")


def test_messages_export_csv_has_header_and_rows(tmp_path):
    from backend.domain.models import RawMessageEvent
    store = SQLiteStore(tmp_path / "miniweb.db")
    store.ingest_event(RawMessageEvent(id="x", chat_id=-1, msg_id=1, text="hi\nyou",
                                        source="", date="", sender_id=42))
    server = MiniWebServer(store=store)
    result = server.messages_export_payload("all", fmt="csv")
    text = result["body"].decode("utf-8")
    assert text.startswith("seq,time,channel,sender_id,chat_id,msg_id,reply_to_msg_id,raw")
    # newline 在 raw 里被转成 \n 字符串,避免破坏 CSV 行
    assert "hi\\nyou" in text
    assert result["filename"].endswith(".csv")


def test_messages_export_solo_filters_to_me(tmp_path):
    from backend.domain.models import RawMessageEvent
    store = SQLiteStore(tmp_path / "miniweb.db")
    store.save_settings({"game_bot_ids": [-100]})
    store.save_identity({"send_as_id": 12345, "label": "me"})
    store.ingest_event(RawMessageEvent(id="me", chat_id=-1, msg_id=1, text="me",
                                        source="", date="", sender_id=12345))
    store.ingest_event(RawMessageEvent(id="other", chat_id=-1, msg_id=2, text="other",
                                        source="", date="", sender_id=99999))
    server = MiniWebServer(store=store)
    result = server.messages_export_payload("all", mode="solo", fmt="jsonl")
    text = result["body"].decode("utf-8")
    assert '"me"' in text
    assert '"other"' not in text
    assert "solo" in result["filename"]


def test_messages_export_route_is_wired():
    from backend.app import GET_ROUTES
    assert "/api/messages/export" in GET_ROUTES


def test_list_schedule_batches_returns_sending_and_completed(tmp_path):
    """新生命周期(sending/completed/cancelled/partial_failed)默认要可见,
    UI 才能显示进度 pill 和取消按钮。只有 deleted 默认隐藏。"""
    store = SQLiteStore(tmp_path / "miniweb.db")
    server = MiniWebServer(store=store)
    server.save_account_payload({"local_id": "main", "api_id": "1", "api_hash": "h", "account_id": "12345"})
    server.save_identity_payload({"send_as_id": "12345", "account_local_id": "main"})
    # 创建几个 batch,标不同状态
    server.schedule_create_payload({
        "send_as_id": 12345, "preset_key": "custom", "command": ".签到",
        "interval_sec": 60, "count": 1, "dry_run": True,
    })
    bid = store.list_schedule_batches(include_inactive=True)[0]["id"]
    store.set_schedule_batch_status(bid, "sending")
    visible = store.list_schedule_batches()
    assert any(b["id"] == bid and b["status"] == "sending" for b in visible)

    store.set_schedule_batch_status(bid, "completed")
    visible = store.list_schedule_batches()
    assert any(b["id"] == bid and b["status"] == "completed" for b in visible)

    store.set_schedule_batch_status(bid, "cancelled")
    visible = store.list_schedule_batches()
    assert any(b["id"] == bid and b["status"] == "cancelled" for b in visible)

    store.set_schedule_batch_status(bid, "deleted")
    visible = store.list_schedule_batches()
    assert not any(b["id"] == bid for b in visible), "deleted 默认要隐藏"
    visible_all = store.list_schedule_batches(include_inactive=True)
    assert any(b["id"] == bid for b in visible_all)


def test_background_send_loop_preserves_cancelled_status(tmp_path):
    """关键回归:用户 cancel 后,后台 loop 退出时的 finally 块不能
    把状态覆盖成 completed —— 否则 UI 看着像「批次复活」。"""
    import asyncio
    store = SQLiteStore(tmp_path / "miniweb.db")
    server = MiniWebServer(store=store)
    server.save_settings_payload({"target_chat": "-1001680975844", "target_topic_id": 7310786})
    server.save_account_payload({"local_id": "main", "api_id": "1", "api_hash": "h", "account_id": "12345"})
    server.save_identity_payload({"send_as_id": "12345", "account_local_id": "main"})
    server.schedule_create_payload({
        "send_as_id": 12345, "preset_key": "custom", "command": ".签到",
        "interval_sec": 60, "count": 3, "dry_run": True,
    })
    bid = store.list_schedule_batches(include_inactive=True)[0]["id"]

    # 模拟用户 cancel
    store.set_schedule_batch_status(bid, "cancelled")

    # 模拟后台 loop 的 finally:用 fake send_as 走 prechecks 失败路径
    # 调度方法做了「先看当前状态」保护,所以应当保持 cancelled
    fake_client = object()
    class FakeSendAs:
        async def list_send_as_peers_on_client(self, client, chat):
            return {"peers": [{"send_as_id": 12345}]}
    server._send_as = FakeSendAs()  # 让 precheck 通过
    # peer/get_input_entity 会失败,导致全部条目标失败,但 cancelled 保护应早退
    # 直接调 _run_official_send_background,会在 get_input_entity 抛错 → 进 finally
    msgs = store.list_schedule_messages(batch_id=bid, include_inactive=False)
    asyncio.run(server._run_official_send_background(
        fake_client, bid, "-1001680975844", 7310786, 12345, msgs
    ))
    # 状态应仍是 cancelled,不要被 finally 覆盖成 completed/failed
    final = next(b for b in store.list_schedule_batches(include_inactive=True) if b["id"] == bid)
    assert final["status"] == "cancelled", f"finally 错误覆盖了 cancelled → {final['status']}"


def test_schedule_deep_retreat_pacing_is_non_linear_paired():
    """新节奏:trigger → command 配对,下一对 = 上一对 command + 8h + jitter,
    不是死按 anchor + N*8h 节拍。验证相邻两对的 trigger 间距落在 8h ± 5min。"""
    from backend.outbox.schedule import build_plan, DEEP_RETREAT_CD, JITTER_MAX_SEC
    import time
    now = time.time()
    plan = build_plan({"preset_key": "deep_retreat", "anchor_at": now, "horizon_days": 5})
    items = plan["items"]
    # 偶数索引是 trigger,奇数是 command
    triggers = [it for i, it in enumerate(items) if i % 2 == 0]
    commands = [it for i, it in enumerate(items) if i % 2 == 1]
    assert len(triggers) == len(commands) >= 4
    # 第二个 trigger 应该落在 first command + 8h + 0~2*JITTER_MAX 之间
    gap = triggers[1]["schedule_at"] - commands[0]["schedule_at"]
    assert DEEP_RETREAT_CD <= gap <= DEEP_RETREAT_CD + 2 * JITTER_MAX_SEC + 5, gap
    # trigger 和它紧跟的 command 之间间距 ~ 4min(240s + jitter)
    pair_gap = commands[0]["schedule_at"] - triggers[0]["schedule_at"]
    assert 240 <= pair_gap <= 240 + JITTER_MAX_SEC + 5, pair_gap


def test_schedule_deep_retreat_trigger_command_is_customizable():
    """触发词允许用户改成自定义,如「闭关结束」。"""
    from backend.outbox.schedule import build_plan
    plan = build_plan({"preset_key": "deep_retreat", "horizon_days": 1, "trigger_command": "闭关结束"})
    triggers = [it for i, it in enumerate(plan["items"]) if i % 2 == 0]
    assert triggers and all(t["command"] == "闭关结束" for t in triggers)
    cmds = [it for i, it in enumerate(plan["items"]) if i % 2 == 1]
    assert all(c["command"] == ".深度闭关" for c in cmds)


def test_schedule_offset_minutes_shifts_entire_batch():
    """多账号错峰:offset_minutes 把整批往后推 N 分钟。"""
    from backend.outbox.schedule import build_plan
    import time
    now = time.time()
    p0 = build_plan({"preset_key": "deep_retreat", "anchor_at": now, "horizon_days": 1})
    p7 = build_plan({"preset_key": "deep_retreat", "anchor_at": now, "horizon_days": 1, "offset_minutes": 7})
    # 第一条 trigger 至少差 7*60 - jitter 容差(因为 jitter 是独立采样)
    delta = p7["items"][0]["schedule_at"] - p0["items"][0]["schedule_at"]
    assert 6 * 60 <= delta <= 8 * 60 + 60, f"delta={delta}"


def test_schedule_offset_minutes_clamped_to_safe_range():
    from backend.outbox.schedule import build_plan
    import time
    now = time.time()
    # 负值 / 太大都被夹回 [0, 720]
    p_neg = build_plan({"preset_key": "custom", "anchor_at": now, "command": ".x",
                         "interval_sec": 60, "count": 1, "offset_minutes": -100})
    p_huge = build_plan({"preset_key": "custom", "anchor_at": now, "command": ".x",
                          "interval_sec": 60, "count": 1, "offset_minutes": 9999})
    # 不会抛,且 huge 的 anchor 比 neg 后推了至少 11h
    delta = p_huge["items"][0]["schedule_at"] - p_neg["items"][0]["schedule_at"]
    assert delta >= 720 * 60 - 120


def test_schedule_pet_periodic_supports_optional_trigger():
    """法宝类(抚摸 / 温养 / 试炼)也允许配 trigger_command,
    留空 = 跟以前一样只发 command。"""
    from backend.outbox.schedule import build_plan
    # 不配 trigger:每次只一条
    no_trig = build_plan({"preset_key": "pet_warm", "horizon_days": 1, "pet_name": "破剑"})
    cmds_only = [it["command"] for it in no_trig["items"]]
    assert all(c == ".温养器灵 破剑" for c in cmds_only)
    # 配上 trigger:每次两条
    with_trig = build_plan({"preset_key": "pet_warm", "horizon_days": 1,
                              "pet_name": "破剑", "trigger_command": "查看温养"})
    assert len(with_trig["items"]) == 2 * len(no_trig["items"])
    triggers = [it["command"] for i, it in enumerate(with_trig["items"]) if i % 2 == 0]
    assert all(t == "查看温养" for t in triggers)


def test_schedule_dedupe_seconds_avoids_global_collision(tmp_path):
    """两个 batch 创建到同一秒 → 第二个的撞秒条目应被推后 1 秒以上。"""
    store = SQLiteStore(tmp_path / "miniweb.db")
    server = MiniWebServer(store=store)
    server.save_account_payload({"local_id": "main", "api_id": "1", "api_hash": "h", "account_id": "12345"})
    server.save_identity_payload({"send_as_id": "12345", "account_local_id": "main"})

    # 先创建一批 dry_run,记录它的 schedule_at 秒
    r1 = server.schedule_create_payload({
        "send_as_id": 12345, "preset_key": "custom", "command": ".签到",
        "interval_sec": 60, "count": 3, "dry_run": True,
    })
    assert r1["ok"]
    used1 = {int(float(m["schedule_at"])) for m in store.list_schedule_messages(batch_id=r1["batch_id"])}

    # 第二批用同样参数:jitter 不同,但有概率撞同秒。强制构造撞:
    # 直接调 _dedupe_schedule_seconds 验证撞秒会被推后。
    fake_items = [
        {"command": ".x", "schedule_at": float(next(iter(used1))), "status": "planned", "scheduled_msg_id": 0},
        {"command": ".y", "schedule_at": float(next(iter(used1))), "status": "planned", "scheduled_msg_id": 0},
    ]
    adjusted = server._dedupe_schedule_seconds(fake_items)
    assert adjusted == 2
    new_secs = {int(float(it["schedule_at"])) for it in fake_items}
    assert not new_secs & used1, "调整后不应再跟现有秒撞"
    assert len(new_secs) == 2, "两条调整后也不能互相撞"


def test_schedule_create_batch_creates_one_per_identity(tmp_path):
    """send_as_ids 多选 → 每个身份一个 batch,offset 按阶梯递增。"""
    store = SQLiteStore(tmp_path / "miniweb.db")
    server = MiniWebServer(store=store)
    server.save_account_payload({"local_id": "main", "api_id": "1", "api_hash": "h", "account_id": "100"})
    for sid in [101, 102, 103]:
        server.save_identity_payload({"send_as_id": str(sid), "account_local_id": "main"})

    result = server.schedule_create_payload({
        "send_as_ids": [101, 102, 103],
        "preset_key": "custom",
        "command": ".签到",
        "interval_sec": 60,
        "count": 1,
        "dry_run": True,
        "offset_minutes": 0,
        "offset_step_minutes": 5,
    })
    assert result["batch_count"] == 3
    assert result["succeeded"] == 3
    # 阶梯生效:三个 batch 的 offset_minutes_applied 应该是 0/5/10
    offsets = sorted(r["offset_minutes_applied"] for r in result["results"])
    assert offsets == [0, 5, 10]
    # DB 里有 3 个 batch
    batches = store.list_schedule_batches(include_inactive=True)
    assert len(batches) == 3
    assert {b["send_as_id"] for b in batches} == {101, 102, 103}


def test_schedule_create_single_id_falls_back_to_legacy_shape(tmp_path):
    """传 send_as_id(单数)还是走老路径,返单数响应(兼容)。"""
    store = SQLiteStore(tmp_path / "miniweb.db")
    server = MiniWebServer(store=store)
    server.save_account_payload({"local_id": "main", "api_id": "1", "api_hash": "h", "account_id": "200"})
    server.save_identity_payload({"send_as_id": "200", "account_local_id": "main"})

    result = server.schedule_create_payload({
        "send_as_id": 200,
        "preset_key": "custom",
        "command": ".x",
        "interval_sec": 60,
        "count": 1,
        "dry_run": True,
    })
    assert result["ok"] is True
    assert "batch_id" in result
    assert "batch_count" not in result


def test_schedule_create_empty_ids_returns_error():
    """既没 send_as_id 也没 send_as_ids → 错误提示。"""
    from backend.repo.sqlite_store import SQLiteStore
    import tempfile, pathlib
    tmp = pathlib.Path(tempfile.mkdtemp()) / "m.db"
    store = SQLiteStore(tmp)
    server = MiniWebServer(store=store)
    result = server.schedule_create_payload({"preset_key": "custom", "command": ".x"})
    assert result["ok"] is False
    assert "identity" in result["error"]


# ---------- 技能盘 ----------

def test_skills_payload_exposes_default_layout():
    """技能盘必须把 6 组(日常/法宝/侍妾/奇遇/玩法/查询)和所有 skill 暴露出去。"""
    from backend.repo.sqlite_store import SQLiteStore
    import tempfile, pathlib
    tmp = pathlib.Path(tempfile.mkdtemp()) / "m.db"
    server = MiniWebServer(store=SQLiteStore(tmp))
    payload = server.skills_payload()
    assert payload["ok"] is True
    assert payload["groups"] == ["日常", "法宝", "侍妾", "奇遇", "玩法", "查询"]
    by_key = {s["key"]: s for s in payload["skills"]}
    assert "deep_retreat" in by_key
    assert by_key["deep_retreat"]["reply_mode"] == "none"
    assert by_key["deep_retreat"]["cd_module"] == "deep_retreat"
    # 回复类必须显式标记
    assert by_key["quiz_answer"]["reply_mode"] == "required"
    assert by_key["dungeon_join"]["reply_mode"] == "required"
    # 新增的命令必须在
    assert "storage_bag" in by_key  # .储物袋
    assert "concubine_romance" in by_key  # .红尘寻缘
    assert "concubine_sect_marry" in by_key  # .宗门赐婚
    # 查询组里至少要有 储物袋 / 战力 / 我的灵根
    query_skills = {s["key"] for s in payload["skills"] if s["group"] == "查询"}
    assert {"storage_bag", "battle_power", "identity_info"} <= query_skills


def test_skill_send_rejects_unknown_skill(tmp_path):
    server = MiniWebServer(store=SQLiteStore(tmp_path / "m.db"))
    result = server.skill_send_payload({"skill_key": "totally_made_up", "identity_id": 1})
    assert result["ok"] is False
    assert "未知技能" in result["error"] or "totally_made_up" in result["error"]


def test_skill_send_rejects_missing_identity(tmp_path):
    server = MiniWebServer(store=SQLiteStore(tmp_path / "m.db"))
    result = server.skill_send_payload({"skill_key": "wild_training", "identity_id": 999999})
    assert result["ok"] is False
    assert "identity" in result["error"]


def test_skill_send_rejects_non_self_identity(tmp_path):
    """禁止以「非 self」send_as 发送(暂未接 send_as= 路径)。"""
    server = MiniWebServer(store=SQLiteStore(tmp_path / "m.db"))
    server.save_account_payload(
        {"local_id": "main", "api_id": "1", "api_hash": "h",
         "account_id": "8574677796", "target_chat": "-1001680975844"}
    )
    server.save_identity_payload(
        {"send_as_id": "8668975549", "account_local_id": "main", "label": "OtherSendAs"}
    )
    result = server.skill_send_payload(
        {"skill_key": "wild_training", "identity_id": 8668975549}
    )
    assert result["ok"] is False
    assert "自己身份" in result["error"]


def test_skill_send_required_reply_mode_blocks_without_reply_to(tmp_path, monkeypatch):
    """reply_mode=required 的 skill,没传 reply_to_msg_id → 直接拒绝,不该走到 listener。"""
    server = MiniWebServer(store=SQLiteStore(tmp_path / "m.db"))
    server.save_account_payload(
        {"local_id": "main", "api_id": "1", "api_hash": "h",
         "account_id": "8574677796", "target_chat": "-1001680975844"}
    )
    server.save_identity_payload(
        {"send_as_id": "8574677796", "account_local_id": "main", "label": "self"}
    )
    listener_called = {"n": 0}

    class FakeListener:
        def submit(self, coro_factory, *, timeout=30.0):
            listener_called["n"] += 1
            return 1
    monkeypatch.setattr(server._listeners, "get_listener", lambda _id: FakeListener())

    result = server.skill_send_payload(
        {"skill_key": "quiz_answer", "identity_id": 8574677796}
    )
    assert result["ok"] is False
    assert "回复发送" in result["error"]
    assert listener_called["n"] == 0


def test_skill_send_happy_path_with_fake_listener(tmp_path, monkeypatch):
    """端到端 happy path:自己身份 + 直发 skill → listener.submit 被调用一次,
    送回 sent_msg_id;无需真 Telegram 客户端。"""
    server = MiniWebServer(store=SQLiteStore(tmp_path / "m.db"))
    server.save_account_payload(
        {"local_id": "main", "api_id": "1", "api_hash": "h",
         "account_id": "8574677796", "target_chat": "-1001680975844"}
    )
    server.save_identity_payload(
        {"send_as_id": "8574677796", "account_local_id": "main", "label": "self"}
    )
    captured: dict = {}

    class FakeClient:
        async def send_message(self, chat_id, command, **kwargs):
            captured["chat_id"] = chat_id
            captured["command"] = command
            captured["kwargs"] = kwargs

            class _Sent:
                id = 42000
            return _Sent()

    class FakeListener:
        def submit(self, coro_factory, *, timeout=30.0):
            import asyncio
            return asyncio.new_event_loop().run_until_complete(coro_factory(FakeClient()))
    monkeypatch.setattr(server._listeners, "get_listener", lambda _id: FakeListener())

    result = server.skill_send_payload(
        {"skill_key": "wild_training", "identity_id": 8574677796}
    )
    assert result["ok"] is True
    assert result["sent_msg_id"] == 42000
    assert result["command"] == ".野外历练"
    assert captured["chat_id"] == -1001680975844
    assert captured["command"] == ".野外历练"
    assert "reply_to" not in captured["kwargs"]  # 直发不带 reply_to


def test_skill_send_reply_mode_passes_reply_to_to_client(tmp_path, monkeypatch):
    """reply 类 skill 带 reply_to_msg_id → 传给 client.send_message(reply_to=...)。"""
    server = MiniWebServer(store=SQLiteStore(tmp_path / "m.db"))
    server.save_account_payload(
        {"local_id": "main", "api_id": "1", "api_hash": "h",
         "account_id": "8574677796", "target_chat": "-1001680975844"}
    )
    server.save_identity_payload(
        {"send_as_id": "8574677796", "account_local_id": "main", "label": "self"}
    )
    captured: dict = {}

    class FakeClient:
        async def send_message(self, chat_id, command, **kwargs):
            captured["kwargs"] = kwargs
            class _Sent:
                id = 99001
            return _Sent()

    class FakeListener:
        def submit(self, coro_factory, *, timeout=30.0):
            import asyncio
            return asyncio.new_event_loop().run_until_complete(coro_factory(FakeClient()))
    monkeypatch.setattr(server._listeners, "get_listener", lambda _id: FakeListener())

    result = server.skill_send_payload(
        {"skill_key": "quiz_answer", "identity_id": 8574677796, "reply_to_msg_id": 8962000}
    )
    assert result["ok"] is True
    assert result["reply_to_msg_id"] == 8962000
    assert captured["kwargs"].get("reply_to") == 8962000


def test_skill_send_dungeon_join_uses_command_override(tmp_path, monkeypatch):
    """.加入副本 N 需要把 N 追加进 command — 用 command_override 覆盖。"""
    server = MiniWebServer(store=SQLiteStore(tmp_path / "m.db"))
    server.save_account_payload(
        {"local_id": "main", "api_id": "1", "api_hash": "h",
         "account_id": "8574677796", "target_chat": "-1001680975844"}
    )
    server.save_identity_payload(
        {"send_as_id": "8574677796", "account_local_id": "main", "label": "self"}
    )
    captured: dict = {}

    class FakeClient:
        async def send_message(self, chat_id, command, **kwargs):
            captured["command"] = command
            captured["kwargs"] = kwargs
            class _Sent:
                id = 1
            return _Sent()

    class FakeListener:
        def submit(self, coro_factory, *, timeout=30.0):
            import asyncio
            return asyncio.new_event_loop().run_until_complete(coro_factory(FakeClient()))
    monkeypatch.setattr(server._listeners, "get_listener", lambda _id: FakeListener())

    result = server.skill_send_payload(
        {
            "skill_key": "dungeon_join",
            "identity_id": 8574677796,
            "reply_to_msg_id": 7000,
            "command_override": ".加入副本 123",
        }
    )
    assert result["ok"] is True
    assert captured["command"] == ".加入副本 123"
    assert captured["kwargs"].get("reply_to") == 7000


def test_skill_routes_registered():
    """前端能找到 /api/skills + /api/skills/send。"""
    from backend.app import GET_ROUTES, POST_ROUTES
    assert "/api/skills" in GET_ROUTES
    assert "/api/skills/send" in POST_ROUTES


def test_skill_send_ingests_outgoing_into_raw_messages(tmp_path, monkeypatch):
    """发送成功后,自己的 outgoing 消息必须也写进 raw_messages — 否则 solo 模式
    bot 回复(reply_to=msg_id)找不到 parent,会从 chat 流里消失。

    同时验证 source 用 client.get_me() 的 first_name/last_name(等同于 listener
    解析其它消息时用的口径),不是账号 label 写死的手机号。"""
    server = MiniWebServer(store=SQLiteStore(tmp_path / "m.db"))
    server.save_account_payload(
        {"local_id": "main", "api_id": "1", "api_hash": "h",
         "account_id": "8574677796", "target_chat": "-1001680975844",
         "target_topic_id": "7310786", "label": "+447851861646"}
    )
    server.save_identity_payload(
        {"send_as_id": "8574677796", "account_local_id": "main", "label": "self"}
    )

    class FakeMe:
        first_name = "Wise"
        last_name = "Mole🤓"
        username = "wisemole"

    class FakeClient:
        async def send_message(self, chat_id, command, **kwargs):
            class _Sent:
                id = 555000
            return _Sent()

        async def get_me(self):
            return FakeMe()

    class FakeListener:
        def submit(self, coro_factory, *, timeout=30.0):
            import asyncio
            return asyncio.new_event_loop().run_until_complete(coro_factory(FakeClient()))
    monkeypatch.setattr(server._listeners, "get_listener", lambda _id: FakeListener())

    result = server.skill_send_payload(
        {"skill_key": "wild_training", "identity_id": 8574677796}
    )
    assert result["ok"] is True
    assert result["sent_msg_id"] == 555000

    import sqlite3
    con = sqlite3.connect(tmp_path / "m.db")
    row = con.execute(
        "SELECT chat_id, msg_id, sender_id, text, top_msg_id, source FROM raw_messages WHERE msg_id=555000"
    ).fetchone()
    assert row is not None, "outgoing message should have been ingested into raw_messages"
    assert row[0] == -1001680975844
    assert row[2] == 8574677796
    assert row[3] == ".野外历练"
    assert row[4] == 7310786
    assert row[5] == "Wise Mole🤓", f"source should be first+last name from get_me, got {row[5]!r}"


def test_skill_send_hydrates_account_and_identity_label_from_get_me(tmp_path, monkeypatch):
    """label 默认是手机号(+xxx)。第一次成功 send 后,server 应该用
    client.get_me() 拿到的 first+last name 把 account.label 和 self-identity.label
    都覆盖掉,UI 才显示真名而不是 +447..."""
    server = MiniWebServer(store=SQLiteStore(tmp_path / "m.db"))
    server.save_account_payload(
        {"local_id": "main", "api_id": "1", "api_hash": "h",
         "account_id": "8574677796", "target_chat": "-1001680975844",
         "target_topic_id": "7310786",
         "label": "+447851861646", "phone": "+447851861646"}
    )
    server.save_identity_payload(
        {"send_as_id": "8574677796", "account_local_id": "main",
         "label": "+447851861646"}
    )

    class FakeMe:
        first_name = "Wise"
        last_name = "Mole🤓"
        username = "wisemole"

    class FakeClient:
        async def send_message(self, chat_id, command, **kwargs):
            class _Sent:
                id = 777
            return _Sent()

        async def get_me(self):
            return FakeMe()

    class FakeListener:
        def submit(self, coro_factory, *, timeout=30.0):
            import asyncio
            return asyncio.new_event_loop().run_until_complete(coro_factory(FakeClient()))
    monkeypatch.setattr(server._listeners, "get_listener", lambda _id: FakeListener())

    # before:label 都是手机号
    assert server._store.get_account("main")["label"] == "+447851861646"
    assert server._store.get_identity(8574677796)["label"] == "+447851861646"

    result = server.skill_send_payload(
        {"skill_key": "wild_training", "identity_id": 8574677796}
    )
    assert result["ok"] is True

    # after:label 已替换成真名
    assert server._store.get_account("main")["label"] == "Wise Mole🤓"
    assert server._store.get_identity(8574677796)["label"] == "Wise Mole🤓"


def test_skill_send_preserves_user_renamed_label(tmp_path, monkeypatch):
    """如果用户已经手动改过 label(不是手机号格式),hydrate 不该覆盖。"""
    server = MiniWebServer(store=SQLiteStore(tmp_path / "m.db"))
    server.save_account_payload(
        {"local_id": "main", "api_id": "1", "api_hash": "h",
         "account_id": "8574677796", "target_chat": "-1001680975844",
         "target_topic_id": "7310786",
         "label": "我的主号", "phone": "+447851861646"}
    )
    server.save_identity_payload(
        {"send_as_id": "8574677796", "account_local_id": "main",
         "label": "本尊"}
    )

    class FakeMe:
        first_name = "Wise"
        last_name = "Mole"
        username = "wisemole"

    class FakeClient:
        async def send_message(self, chat_id, command, **kwargs):
            class _Sent:
                id = 778
            return _Sent()

        async def get_me(self):
            return FakeMe()

    class FakeListener:
        def submit(self, coro_factory, *, timeout=30.0):
            import asyncio
            return asyncio.new_event_loop().run_until_complete(coro_factory(FakeClient()))
    monkeypatch.setattr(server._listeners, "get_listener", lambda _id: FakeListener())

    server.skill_send_payload({"skill_key": "wild_training", "identity_id": 8574677796})
    # 保留用户起的名字
    assert server._store.get_account("main")["label"] == "我的主号"
    assert server._store.get_identity(8574677796)["label"] == "本尊"


def test_state_patches_scoped_by_send_as_id(tmp_path):
    """两个不同身份对同一 scope+key 各发一条命令,store 应该按 send_as_id 隔离,
    互相不覆盖;查询时传 send_as_id 只返回该身份的版本。"""
    from backend.repo.sqlite_store import SQLiteStore
    from backend.domain.models import RawMessageEvent
    store = SQLiteStore(tmp_path / "m.db")

    # 用户 A 发 .我的灵根,bot 回复 — bot 回复时 sender_id=bot,但 parent.sender_id=A
    A = 8574677796
    B = 8668975549
    BOT = 7900199668
    chat = -1001680975844

    # A 的 .我的灵根
    a_cmd = RawMessageEvent(
        id=f"tg:{chat}:1001:main",
        chat_id=chat,
        msg_id=1001,
        text=".我的灵根",
        source="A",
        date="2026-05-17T00:00:00+00:00",
        sender_id=A,
        sender_is_bot=False,
    )
    store.ingest_event(a_cmd)

    # bot 回复 A 的 玉牒
    a_reply = RawMessageEvent(
        id=f"tg:{chat}:1002:main",
        chat_id=chat,
        msg_id=1002,
        text="@aaa 的天命玉牒\n────\n宗门: 【凌霄宫】\n灵根: 天灵根(火)\n修为: 100 / 1000\n",
        source="bot",
        date="2026-05-17T00:00:01+00:00",
        sender_id=BOT,
        sender_is_bot=True,
        reply_to_msg_id=1001,
    )
    store.ingest_event(a_reply)

    # B 发 .我的灵根 + bot 回复 B
    b_cmd = RawMessageEvent(
        id=f"tg:{chat}:1003:main",
        chat_id=chat,
        msg_id=1003,
        text=".我的灵根",
        source="B",
        date="2026-05-17T00:00:02+00:00",
        sender_id=B,
        sender_is_bot=False,
    )
    store.ingest_event(b_cmd)
    b_reply = RawMessageEvent(
        id=f"tg:{chat}:1004:main",
        chat_id=chat,
        msg_id=1004,
        text="@bbb 的天命玉牒\n────\n宗门: 【落云宗】\n灵根: 木灵根\n修为: 500 / 5000\n",
        source="bot",
        date="2026-05-17T00:00:03+00:00",
        sender_id=BOT,
        sender_is_bot=True,
        reply_to_msg_id=1003,
    )
    store.ingest_event(b_reply)

    # A 应该看到凌霄宫 / 天灵根(火) / 100
    a_patches = {p["key"]: p["value"] for p in store.list_state_patches("identity_profile", send_as_id=A)}
    assert a_patches.get("宗门") == "【凌霄宫】"
    assert a_patches.get("灵根") == "天灵根(火)"
    assert a_patches.get("修为") == "100 / 1000"

    # B 应该看到落云宗 / 木灵根 / 500
    b_patches = {p["key"]: p["value"] for p in store.list_state_patches("identity_profile", send_as_id=B)}
    assert b_patches.get("宗门") == "【落云宗】"
    assert b_patches.get("灵根") == "木灵根"
    assert b_patches.get("修为") == "500 / 5000"

    # 不传 send_as_id → 全部返(A + B 各自的)
    all_patches = store.list_state_patches("identity_profile")
    keys_by_sender = {(p["send_as_id"], p["key"]) for p in all_patches}
    assert (A, "宗门") in keys_by_sender
    assert (B, "宗门") in keys_by_sender


# ---------- 通知 ----------

def test_notify_card_titles_payload_returns_known_set():
    """前端 settings UI 需要拿到全部可订阅卡片标题作 checkbox。"""
    from backend.repo.sqlite_store import SQLiteStore
    import tempfile, pathlib
    server = MiniWebServer(store=SQLiteStore(pathlib.Path(tempfile.mkdtemp()) / "m.db"))
    payload = server.notify_card_titles_payload()
    assert payload["ok"] is True
    titles = set(payload["titles"])
    # 关键 prompt 类必须在(用户最关心)
    assert "风险提醒" in titles
    assert "玄骨考校" in titles
    assert "境界突破" in titles
    assert "登天阶面板" in titles


def test_notify_test_payload_without_config_reports_error(tmp_path):
    """没启用通知或没填 token 时,/api/notify/test 返回 ok=False。"""
    server = MiniWebServer(store=SQLiteStore(tmp_path / "m.db"))
    result = server.notify_test_payload({})
    assert result["ok"] is False
    assert "未启用" in result["error"] or "未配置" in result["error"]


def test_notify_dispatcher_fires_on_card_when_enabled(tmp_path, monkeypatch):
    """ingest_event 产生卡片 + 配置勾选该卡片标题 → notifier.notify 被调用一次。
    同一 source_id 二次 ingest(NewMessage + Edit) 不会重复推。"""
    from backend.notifications.dispatcher import NotificationDispatcher
    from backend.notifications import Notifier, NotificationEvent
    from backend.domain.models import RawMessageEvent

    captured: list[NotificationEvent] = []

    class FakeNotifier(Notifier):
        name = "fake"
        def notify(self, event):
            captured.append(event)
            return True, ""

    store = SQLiteStore(tmp_path / "m.db")
    # 写 settings 配通知 + 订阅 "风险提醒"
    store.save_settings({
        "notify_enabled": True,
        "notify_tg_bot_token": "irrelevant-for-fake",
        "notify_tg_chat_id": "1",
        "notify_card_titles": ["风险提醒"],
    })
    dispatcher = NotificationDispatcher(get_settings=store.get_settings)
    # 用 fake notifier 替换 list_notifiers
    monkeypatch.setattr(dispatcher, "list_notifiers", lambda: [FakeNotifier()])
    store.set_notify_dispatcher(dispatcher)

    risk_event = RawMessageEvent(
        id="tg:-1001:90001",
        chat_id=-1001,
        msg_id=90001,
        text="挂机嫌疑提醒:对象 @user,你必须自证清白。",
        source="bot",
        date="2026-05-17T00:00:00+00:00",
        sender_id=7900199668,
        sender_is_bot=True,
    )
    store.ingest_event(risk_event)
    # dedup:同 id 再 ingest 一次,不应该再触发 notify
    store.ingest_event(risk_event)

    assert len(captured) == 1
    assert captured[0].title in {"风险提醒", "天道审判"}
    assert captured[0].severity == "risk"
