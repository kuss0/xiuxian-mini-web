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
    events = store.list_resource_events(event.id)
    assert len(deltas) == 2
    assert len(events) == 1
    assert {(item["resource_name"], item["amount"]) for item in deltas} == {
        ("修为", 12000),
        ("灵石", 399),
    }
    assert {item["day"] for item in deltas} == {"2026-05-15"}
    assert events[0]["result"] == "success"


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
    summary = payload["event_summary"][0]
    assert payload["ok"] is True
    assert rows == {("修为", 5000), ("贡献", 500), ("养魂木", 1)}
    assert all(row["basis"] == "run" for row in payload["rows"])
    assert {row["resource_category"] for row in payload["rows"]} == {"basic", "rare"}
    assert summary["source_type"] == "dungeon"
    assert summary["source_name"] == "虚天殿·夺鼎"
    assert summary["settled"] == 1
    assert "血色试炼结算已排除。" in payload["notes"]


def test_resource_stats_api_tracks_wild_training_success_failed_and_cooldown(tmp_path):
    store = SQLiteStore(tmp_path / "state.db")
    for idx, text in enumerate(
        [
            """【野外历练 · 妖兽遭遇】
@xhg_xx 遭遇 三眼妖狼。
一番斗法后，妖兽伏诛。
获得修为 +345，获得 【灵石】x159。""",
            """【野外历练 · 负伤而归】
@snpao002 遭遇 玄水妖蟒，一时判断失误。
你强行脱身，修为折损 -2522。
此为 NPC 历练失败，不计入斗法记录。""",
            "【野外历练】\n山中灵机未复，请在 19分钟7秒 后再来。",
        ],
        start=1,
    ):
        store.ingest_event(
            RawMessageEvent(
                id=f"tg:-1:30{idx}",
                chat_id=-1,
                msg_id=300 + idx,
                text=text,
                source="韩天尊",
                date=f"2026-05-15T12:0{idx}:00+00:00",
                sender_id=7900199668,
                sender_is_bot=True,
            )
        )

    payload = MiniWebServer(store=store).resource_stats_payload(period="day", source_type="wild_training")
    summary = next(row for row in payload["event_summary"] if row["source_name"] == "野外历练·未知")
    assert summary["success"] == 1
    assert summary["failed"] == 1
    assert summary["cooldown"] == 1
    assert summary["success_rate"] == 50.0
    assert ("修为", "loss", -2522) in {
        (row["resource_name"], row["amount_kind"], row["total_amount"]) for row in payload["rows"]
    }


def test_resource_stats_backfill_adds_wild_strategy_from_reply_parent(tmp_path):
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
                "tg:-1:400",
                -1,
                400,
                ".野外历练 深入",
                "玩家",
                "2026-05-15T11:59:00+00:00",
                "[]",
                0,
            ),
        )
        conn.execute(
            """
            INSERT INTO raw_messages(
                id, chat_id, msg_id, text, source, date, reply_to_msg_id,
                mentions_json, sender_is_bot
            )
            VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                "tg:-1:401",
                -1,
                401,
                """【野外历练 · 灵机暗藏】
@salt9527 获得修为 +12000，获得 【灵石】x399。""",
                "韩天尊",
                "2026-05-15T12:00:00+00:00",
                400,
                "[]",
                1,
            ),
        )

    assert store.backfill_resource_records_if_needed() == {"events": 1, "deltas": 2}
    assert {item["source_name"] for item in store.list_resource_events()} == {"野外历练·深入"}
    assert {item["source_name"] for item in store.list_resource_deltas()} == {"野外历练·深入"}


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
        conn.execute(
            """
            INSERT INTO resource_events(
                raw_message_id, source_type, source_name, result, event_time,
                day_key, week_key, month_key
            )
            VALUES(?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                "tg:-1:200",
                "dungeon",
                "虚天殿",
                "settled",
                "2026-05-15T12:00:00+00:00",
                "2026-05-15",
                "2026-W20",
                "2026-05",
            ),
        )
        conn.execute(
            """
            INSERT INTO resource_deltas(
                raw_message_id, source_type, source_name, resource_name, amount,
                basis, event_time, day_key, week_key, month_key
            )
            VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                "tg:-1:200",
                "dungeon",
                "虚天殿",
                "修为",
                999,
                "per_member",
                "2026-05-15T12:00:00+00:00",
                "2026-05-15",
                "2026-W20",
                "2026-05",
            ),
        )

    assert store.backfill_resource_records_if_needed() == {"events": 1, "deltas": 2}
    assert store.backfill_resource_records_if_needed() == {"events": 0, "deltas": 0}
    assert {(item["resource_name"], item["amount"]) for item in store.list_resource_deltas()} == {
        ("修为", 12000),
        ("灵石", 399),
    }
    assert {item["source_name"] for item in store.list_resource_deltas()} == {"野外历练·未知"}
    assert [item["result"] for item in store.list_resource_events()] == ["success"]


def test_resource_stats_route_is_registered():
    assert "/api/resource-stats" in GET_ROUTES
