from backend.log_commands import LogCommandDispatcher, LogCommandSource, parse_log_command
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
