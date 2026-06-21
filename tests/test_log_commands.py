from backend.log_commands import LogCommandDispatcher, LogCommandSource, parse_log_command
from backend.log_commands.tg_listener import LogCommandTelegramListener
from backend.repo.sample_store import SampleStore
from backend.server import MiniWebServer
from backend.skills import SkillRegistry


def test_parse_dot_and_slash_log_commands():
    draft = parse_log_command(".草稿 wild_training @123")
    assert draft is not None
    assert draft.spec.name == "draft"
    assert draft.args == ("wild_training", "@123")

    help_cmd = parse_log_command("/help@miniweb_bot")
    assert help_cmd is not None
    assert help_cmd.spec.name == "help"
    assert help_cmd.prefix == "/"

    module_status = parse_log_command(".元婴状态 @123")
    assert module_status is not None
    assert module_status.spec.name == "module_status"
    assert module_status.module_name == "元婴"


def test_telegram_ingress_allows_any_sender_in_configured_group():
    dispatcher = LogCommandDispatcher(
        settings={
            "log_command_enabled": True,
            "log_command_admin_ids": [100],
            "log_command_chat_id": -100500,
            "log_command_extra_commands": [],
        },
        skills_getter=lambda: SkillRegistry().list(),
    )

    group_member = dispatcher.dispatch(
        ".帮助",
        LogCommandSource(user_id=200, chat_id=-100500, msg_id=1, kind="telegram"),
    )
    assert group_member["ok"] is True
    assert group_member["status"] == "ok"
    assert group_member["decision"]["ingress"] == "telegram_group"
    assert group_member["decision"]["is_admin"] is False

    wrong_chat = dispatcher.dispatch(
        ".帮助",
        LogCommandSource(user_id=200, chat_id=-100700, msg_id=2, kind="telegram"),
    )
    assert wrong_chat["status"] == "reject"
    assert wrong_chat["decision"]["reason"] == "chat_not_allowed"

    admin_dm = dispatcher.dispatch(
        ".帮助",
        LogCommandSource(user_id=100, chat_id=100, msg_id=3, kind="telegram"),
    )
    assert admin_dm["ok"] is True
    assert admin_dm["decision"]["ingress"] == "telegram_admin_dm"
    assert admin_dm["decision"]["is_admin"] is True

    blocked_command = dispatcher.dispatch(
        ".发送 wild_training @123",
        LogCommandSource(user_id=200, chat_id=-100500, msg_id=4, kind="telegram"),
    )
    assert blocked_command["status"] == "reject"
    assert blocked_command["decision"]["reason"] == "command_not_allowed"


def test_telegram_ingress_does_not_require_admin_ids_for_group():
    dispatcher = LogCommandDispatcher(
        settings={
            "log_command_enabled": True,
            "log_command_chat_id": -100500,
            "log_command_extra_commands": [],
        },
        skills_getter=lambda: SkillRegistry().list(),
    )

    result = dispatcher.dispatch(
        ".帮助",
        LogCommandSource(user_id=300, chat_id=-100500, msg_id=5, kind="telegram"),
    )

    assert result["ok"] is True
    assert result["decision"]["ingress"] == "telegram_group"


def test_telegram_ingress_obeys_log_command_enabled_switch():
    dispatcher = LogCommandDispatcher(
        settings={
            "log_command_enabled": False,
            "log_command_chat_id": -100500,
        },
        skills_getter=lambda: SkillRegistry().list(),
    )

    result = dispatcher.dispatch(
        ".帮助",
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
        skills_getter=lambda: SkillRegistry().list(),
    )

    result = dispatcher.dispatch(".帮助", LogCommandSource(kind="local_api"))

    assert result["ok"] is True
    assert result["decision"]["ingress"] == "local_api"


def test_log_command_dispatch_creates_outbox_draft_only():
    server = MiniWebServer(store=SampleStore())

    result = server.log_command_dispatch_payload(
        {"text": ".草稿 wild_training", "dry_run": False}
    )

    assert result["ok"] is True
    assert result["status"] == "ok"
    assert result["actions"][0]["kind"] == "outbox_draft"
    assert result["applied_actions"][0]["ok"] is True
    assert result["applied_actions"][0]["draft"]["command"] == ".野外历练"
    assert result["applied_actions"][0]["draft"]["send_mode"] == "copy"


def test_log_command_manual_send_is_blocked_by_default():
    server = MiniWebServer(store=SampleStore())

    result = server.log_command_dispatch_payload(
        {"text": ".发送 wild_training @123", "dry_run": False}
    )

    assert result["ok"] is False
    assert result["status"] == "blocked"
    assert result["blocked_level"] == "manual_send"
    assert result["applied_actions"] == []


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
        get_settings=lambda: {"log_command_enabled": True, "notify_tg_bot_token": "token"},
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
                "text": ".帮助",
                "chat": {"id": -100500},
                "from": {"id": 300},
            },
        },
    )

    assert calls == [
        {
            "text": ".帮助",
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
