from backend.app import GET_ROUTES
from backend.domain.models import RawMessageEvent
from backend.repo.sqlite_store import SQLiteStore
from backend.server import MiniWebServer


def test_resource_deltas_are_persisted_idempotently(tmp_path):
    store = SQLiteStore(tmp_path / "state.db")
    event = RawMessageEvent(
        id="tg:-1:100",
        chat_id=-1,
        msg_id=100,
        text="""【野外历练 · 灵机暗藏】
@salt9527 在山涧残阵旁避开妖兽踪迹，采得一份机缘。
获得修为 +12000，获得 【灵石】x399。""",
        source="韩天尊",
        date="2026-05-15T12:00:00+00:00",
        sender_id=7900199668,
        sender_is_bot=True,
    )

    store.ingest_event(event)
    store.ingest_event(event)

    deltas = store.list_resource_deltas(event.id)
    assert len(deltas) == 2
    assert {(item["resource_name"], item["amount"]) for item in deltas} == {
        ("修为", 12000),
        ("灵石", 399),
    }
    assert {item["day"] for item in deltas} == {"2026-05-15"}


def test_resource_stats_api_groups_by_period_and_excludes_blood_trial(tmp_path):
    store = SQLiteStore(tmp_path / "state.db")
    store.ingest_event(
        RawMessageEvent(
            id="tg:-1:101",
            chat_id=-1,
            msg_id=101,
            text="""【战利品结算·夺鼎】
所有队员均获得 5000修为 和 500贡献！
玄冰秘径：每位队员获得 养魂木x1""",
            source="韩天尊",
            date="2026-05-15T12:00:00+00:00",
            sender_id=7900199668,
            sender_is_bot=True,
        )
    )
    store.ingest_event(
        RawMessageEvent(
            id="tg:-1:102",
            chat_id=-1,
            msg_id=102,
            text="""【战利品结算·血色试炼】
所有队员均获得 9999修为 和 999贡献！""",
            source="韩天尊",
            date="2026-05-15T13:00:00+00:00",
            sender_id=7900199668,
            sender_is_bot=True,
        )
    )

    payload = MiniWebServer(store=store).resource_stats_payload(period="day", source_type="dungeon")
    rows = {(row["resource_name"], row["total_amount"]) for row in payload["rows"]}
    assert payload["ok"] is True
    assert rows == {("修为", 5000), ("贡献", 500), ("养魂木", 1)}
    assert all(row["basis"] == "per_member" for row in payload["rows"])
    assert "血色试炼结算已排除。" in payload["notes"]


def test_resource_backfill_reads_existing_raw_messages_without_reingest(tmp_path):
    store = SQLiteStore(tmp_path / "state.db")
    with store._connect() as conn:
        conn.execute(
            """
            INSERT INTO raw_messages(
                id, chat_id, msg_id, text, source, date, mentions_json, sender_is_bot
            )
            VALUES(?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                "tg:-1:200",
                -1,
                200,
                """【野外历练 · 灵机暗藏】
@salt9527 获得修为 +12000，获得 【灵石】x399。""",
                "韩天尊",
                "2026-05-15T12:00:00+00:00",
                "[]",
                1,
            ),
        )
        conn.execute(
            """
            INSERT INTO raw_messages(
                id, chat_id, msg_id, text, source, date, mentions_json, sender_is_bot
            )
            VALUES(?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                "tg:-1:201",
                -1,
                201,
                "【战利品结算·血色试炼】\n所有队员均获得 9999修为 和 999贡献！",
                "韩天尊",
                "2026-05-15T13:00:00+00:00",
                "[]",
                1,
            ),
        )

    assert store.backfill_resource_deltas_if_empty() == 2
    assert store.backfill_resource_deltas_if_empty() == 0
    assert {(item["resource_name"], item["amount"]) for item in store.list_resource_deltas()} == {
        ("修为", 12000),
        ("灵石", 399),
    }


def test_resource_stats_route_is_registered():
    assert "/api/resource-stats" in GET_ROUTES
