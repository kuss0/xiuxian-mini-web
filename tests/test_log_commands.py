from backend.log_commands import LogCommandDispatcher, LogCommandSource, parse_log_command
from backend.domain.models import RawMessageEvent
from backend.log_commands.mapping import GROUP_MAPPING_SPECS, classify_group_mapping
from backend.log_commands.tg_listener import LogCommandTelegramListener
from backend.repo.sqlite_store import SQLiteStore
from backend.server import MiniWebServer


def test_parse_dot_and_slash_log_commands():
    old_draft = parse_log_command(".草稿 wild_training @123")
    assert old_draft is not None
    assert old_draft.spec.default_allowed is False

    help_cmd = parse_log_command("/help@miniweb_bot")
    assert help_cmd is not None
    assert help_cmd.spec.name == "help"
    assert help_cmd.prefix == "/"

    module_status = parse_log_command(".元婴状态 @123")
    assert module_status is not None
    assert module_status.spec.default_allowed is False


def test_group_mapping_registry_is_read_only_inventory_only():
    assert [spec.name for spec in GROUP_MAPPING_SPECS] == ["还有多少"]
    assert classify_group_mapping(".未知 1", is_admin=True).status == "skip"
    mapped = classify_group_mapping('.还有多少 "增元 丹"', is_admin=True)
    assert mapped.status == "run"
    assert mapped.argv == ("inventory", "find", "--simple", "增元 丹")


def test_telegram_ingress_separates_admin_slash_and_group_mapping():
    dispatcher = LogCommandDispatcher(
        settings={
            "log_command_enabled": True,
            "log_command_admin_ids": [100],
            "log_command_chat_id": -100500,
        },
    )

    group_member = dispatcher.dispatch(
        "/帮助",
        LogCommandSource(user_id=200, chat_id=-100500, msg_id=1, kind="telegram"),
    )
    assert group_member["status"] == "skip"
    assert group_member["decision"]["reason"] == "not_admin"

    admin_group = dispatcher.dispatch(
        "/帮助",
        LogCommandSource(user_id=100, chat_id=-100500, msg_id=2, kind="telegram"),
    )
    assert admin_group["ok"] is True
    assert admin_group["status"] == "ok"
    assert admin_group["decision"]["ingress"] == "telegram_group"
    assert admin_group["decision"]["is_admin"] is True

    wrong_chat = dispatcher.dispatch(
        "/帮助",
        LogCommandSource(user_id=100, chat_id=-100700, msg_id=3, kind="telegram"),
    )
    assert wrong_chat["status"] == "skip"
    assert wrong_chat["decision"]["reason"] == "chat_not_allowed"

    admin_dm = dispatcher.dispatch(
        "/帮助",
        LogCommandSource(user_id=100, chat_id=100, msg_id=4, kind="telegram"),
    )
    assert admin_dm["ok"] is True
    assert admin_dm["decision"]["ingress"] == "telegram_admin_dm"
    assert admin_dm["decision"]["is_admin"] is True

    blocked_command = dispatcher.dispatch(
        "/发送 wild_training @123",
        LogCommandSource(user_id=100, chat_id=-100500, msg_id=5, kind="telegram"),
    )
    assert blocked_command["status"] == "reject"
    assert blocked_command["decision"]["reason"] == "command_not_allowed"


def test_telegram_mapping_uses_group_members_but_admin_only_for_sensitive_mapping():
    dispatcher = LogCommandDispatcher(
        settings={
            "log_command_enabled": True,
            "log_command_chat_id": -100500,
            "log_command_admin_ids": [100],
        },
        inventory_current_getter=lambda: [
            {"owner": "alice", "name": "增元丹", "amount": 2},
            {"owner": "bob", "name": "大增元丹", "amount": 3},
            {"owner": "bob", "name": "灵石", "amount": 99},
        ],
    )

    non_admin = dispatcher.dispatch(
        ".还有多少 增元丹",
        LogCommandSource(user_id=300, chat_id=-100500, msg_id=5, kind="telegram"),
    )
    assert non_admin["status"] == "reject"
    assert non_admin["decision"]["reason"] == "admin_required"

    admin = dispatcher.dispatch(
        ".还有多少 增元丹",
        LogCommandSource(user_id=100, chat_id=-100500, msg_id=6, kind="telegram"),
    )
    assert admin["ok"] is True
    assert admin["decision"]["ingress"] == "telegram_mapping"
    assert "合计 5" in admin["reply"]
    assert "- 增元丹: 2" in admin["reply"]
    assert "- 大增元丹: 3" in admin["reply"]
    assert "alice" not in admin["reply"]
    assert "bob" not in admin["reply"]

    unknown = dispatcher.dispatch(
        ".帮助",
        LogCommandSource(user_id=300, chat_id=-100500, msg_id=7, kind="telegram"),
    )
    assert unknown["status"] == "skip"
    assert unknown["decision"]["reason"] == "unknown_group_mapping"


def test_telegram_ingress_obeys_log_command_enabled_switch():
    dispatcher = LogCommandDispatcher(
        settings={
            "log_command_enabled": False,
            "log_command_chat_id": -100500,
        },
    )

    result = dispatcher.dispatch(
        "/帮助",
        LogCommandSource(user_id=300, chat_id=-100500, msg_id=5, kind="telegram"),
    )

    assert result["ok"] is False
    assert result["status"] == "reject"
    assert result["decision"]["reason"] == "command_listener_disabled"


def test_local_api_dispatch_ignores_log_command_enabled_switch():
    dispatcher = LogCommandDispatcher(
        settings={
            "log_command_enabled": False,
            "log_command_chat_id": "",
        },
    )

    result = dispatcher.dispatch(".帮助", LogCommandSource(kind="local_api"))

    assert result["ok"] is True
    assert result["decision"]["ingress"] == "local_api"


def test_log_command_local_api_no_longer_creates_send_actions(tmp_path):
    server = MiniWebServer(store=SQLiteStore(tmp_path / "miniweb.db"))

    result = server.log_command_dispatch_payload(
        {"text": ".草稿 wild_training", "dry_run": False}
    )

    assert result["ok"] is False
    assert result["status"] == "error"
    assert result["applied_actions"] == []


def test_server_telegram_mapping_queries_inventory_without_owner_details(tmp_path):
    store = SQLiteStore(tmp_path / "miniweb.db")
    store.save_settings(
        {
            "log_command_enabled": True,
            "log_command_chat_id": "-100500",
            "log_command_admin_ids": [100],
        }
    )
    store.save_account({"local_id": "main", "account_id": "1", "username": "seller"})
    store.ingest_event(
        RawMessageEvent(
            id="tg:-1:90",
            chat_id=-1,
            msg_id=90,
            text="""@seller 的储物袋

材料:
- 增元丹 x 4
- 灵石 x 100""",
            source="韩天尊",
            date="2026-05-15T10:00:00+00:00",
            sender_id=7900199668,
            sender_is_bot=True,
        )
    )
    server = MiniWebServer(store=store)

    result = server.log_command_dispatch_payload(
        {
            "text": ".还有多少 增元丹",
            "source_kind": "telegram",
            "chat_id": -100500,
            "from_user_id": 100,
            "msg_id": 12,
            "dry_run": False,
        }
    )

    assert result["ok"] is True
    assert result["status"] == "ok"
    assert result["applied_actions"] == []
    assert "合计 4" in result["reply"]
    assert "- 增元丹: 4" in result["reply"]
    assert "seller" not in result["reply"]


def test_log_command_telegram_listener_start_stop_does_not_deadlock():
    listener = LogCommandTelegramListener(
        get_settings=lambda: {"log_command_enabled": False},
        dispatch=lambda payload: {"ok": True},
    )

    assert listener.start() is True
    status = listener.status()
    assert status["running"] is True
    assert listener.start() is False
    listener.stop(timeout=1.0)

    assert listener.status()["running"] is False


def test_log_command_telegram_listener_dispatches_and_replies():
    calls = []
    api_calls = []

    def dispatch(payload):
        calls.append(payload)
        return {
            "ok": True,
            "status": "ok",
            "reply": "帮助内容",
            "actions": [],
            "decision": {"kind": "run", "ingress": "telegram_group"},
        }

    listener = LogCommandTelegramListener(
        get_settings=lambda: {
            "log_command_enabled": True,
            "notify_tg_bot_token": "token",
            "log_command_chat_id": -100500,
            "log_command_admin_ids": [300],
        },
        dispatch=dispatch,
    )

    def fake_api(token, method, payload, *, timeout):
        api_calls.append((token, method, payload, timeout))
        return {"ok": True, "result": []}

    listener._bot_api = fake_api
    listener._handle_update(
        "token",
        {
            "update_id": 10,
            "message": {
                "message_id": 20,
                "text": "/帮助",
                "chat": {"id": -100500},
                "from": {"id": 300},
            },
        },
    )

    assert calls == [
        {
            "text": "/帮助",
            "source_kind": "telegram",
            "chat_id": -100500,
            "from_user_id": 300,
            "msg_id": 20,
            "dry_run": False,
        }
    ]
    assert api_calls[0][1] == "sendMessage"
    assert api_calls[0][2]["chat_id"] == "-100500"
    assert api_calls[0][2]["reply_to_message_id"] == "20"
    assert api_calls[0][2]["text"] == "帮助内容"


def test_log_command_telegram_listener_prefilters_unclaimed_text():
    calls = []
    listener = LogCommandTelegramListener(
        get_settings=lambda: {
            "log_command_enabled": True,
            "notify_tg_bot_token": "token",
            "log_command_chat_id": -100500,
            "log_command_admin_ids": [300],
        },
        dispatch=lambda payload: calls.append(payload) or {"ok": True},
    )

    listener._handle_update(
        "token",
        {
            "update_id": 11,
            "message": {
                "message_id": 21,
                "text": " .帮助",
                "chat": {"id": -100500},
                "from": {"id": 300},
            },
        },
    )

    assert calls == []
