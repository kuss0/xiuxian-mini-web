from backend.app import GET_ROUTES
from backend.domain.models import RawMessageEvent
from backend.repo.sqlite_store import RESOURCE_STATS_SCHEMA_VERSION, SQLiteStore
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


def test_ingest_coalesces_same_chat_message_with_different_local_ids(tmp_path):
    store = SQLiteStore(tmp_path / "state.db")
    base = {
        "chat_id": -1,
        "msg_id": 100,
        "text": """【野外历练 · 妖兽遭遇】
@TrickPlayer 遭遇 变异碧眼金蟾。
战力对比: 你 1378174928 / 妖兽 1848017514，胜算 31%。
一番斗法后，妖兽伏诛。
获得修为 +45000，获得 【阴凝之晶】x2。
此战只结算 NPC 历练收益，不触发玩家仇怨。""",
        "source": "韩天尊",
        "date": "2026-05-15T12:00:00+00:00",
        "sender_id": 7900199668,
        "sender_is_bot": True,
    }

    store.ingest_event(RawMessageEvent(id="tg:-1:100:legacy", **base))
    store.ingest_event(RawMessageEvent(id="tg:-1:100", **base))

    with store._connect() as conn:
        raw_count = conn.execute(
            "SELECT COUNT(*) FROM raw_messages WHERE chat_id=-1 AND msg_id=100"
        ).fetchone()[0]
    deltas = store.list_resource_deltas("tg:-1:100:legacy")
    events = store.list_resource_events("tg:-1:100:legacy")

    assert raw_count == 1
    assert {(item["resource_name"], item["amount"]) for item in deltas} == {
        ("修为", 45000),
        ("阴凝之晶", 2),
    }
    assert len(events) == 1


def test_inventory_snapshots_are_persisted_idempotently(tmp_path):
    store = SQLiteStore(tmp_path / "state.db")
    event = RawMessageEvent(
        id="tg:-1:90",
        chat_id=-1,
        msg_id=90,
        text="""@seller 的储物袋

材料:
- 灵石 x 100
- 阴凝之晶 x 2
- 阴凝之晶 x 3""",
        source="韩天尊",
        date="2026-05-15T10:00:00+00:00",
        sender_id=7900199668,
        sender_is_bot=True,
    )

    store.ingest_event(event)
    store.ingest_event(event)

    snapshots = store.list_inventory_snapshots(owner="seller")
    assert len(snapshots) == 1
    assert snapshots[0]["owner"] == "seller"
    assert {(item["name"], item["amount"]) for item in snapshots[0]["items"]} == {
        ("灵石", 100),
        ("阴凝之晶", 5),
    }


def test_inventory_transfer_plan_generates_manual_commands():
    server = MiniWebServer(store=SQLiteStore(":memory:"))
    payload = server.inventory_transfer_plan_payload(
        {
            "provider": "seller",
            "buyer": "buyer",
            "bait_name": "凝血草",
            "bait_amount": 1,
            "items": [
                {"name": "阴凝之晶", "amount": 5},
                {"name": "虚天残图", "amount": 2},
            ],
        }
    )

    assert payload["ok"] is True
    commands = [item["command"] for item in payload["commands"]]
    assert commands[:2] == [
        "上架 凝血草*1 换 阴凝之晶*5",
        "上架 凝血草*1 换 虚天残图*2",
    ]
    assert ".我的货摊 @buyer" in commands
    assert commands[-1] == ".购买 <货摊ID> 2"


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
    assert {row["resource_category"] for row in payload["rows"]} == {"basic", "common"}
    assert summary["source_type"] == "dungeon"
    assert summary["source_name"] == "虚天殿·夺鼎"
    assert summary["settled"] == 1
    assert "血色试炼结算已排除。" in payload["notes"]


def test_resource_stats_api_can_filter_by_exact_source_name(tmp_path):
    store = SQLiteStore(tmp_path / "state.db")
    store.ingest_event(
        RawMessageEvent(
            id="tg:-1:111",
            chat_id=-1,
            msg_id=111,
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
            id="tg:-1:112",
            chat_id=-1,
            msg_id=112,
            text="""【黄龙山大战·夺宝即退】
每位队员获得 7200修为、759贡献。
幸运道友 @hfsscxf 额外获得 【黄龙阵旗残片】x2。""",
            source="韩天尊",
            date="2026-05-15T13:00:00+00:00",
            sender_id=7900199668,
            sender_is_bot=True,
        )
    )

    payload = MiniWebServer(store=store).resource_stats_payload(
        period="day",
        source_type="dungeon",
        source_name="黄龙山",
    )

    assert {row["source_name"] for row in payload["rows"]} == {"黄龙山"}
    assert {row["source_name"] for row in payload["event_summary"]} == {"黄龙山"}
    assert {(row["resource_name"], row["total_amount"]) for row in payload["rows"]} == {
        ("修为", 7200),
        ("贡献", 759),
        ("黄龙阵旗残片", 2),
    }


def test_resource_stats_api_tracks_wind_xi_separately(tmp_path):
    store = SQLiteStore(tmp_path / "state.db")
    event = RawMessageEvent(
        id="tg:-1:120",
        chat_id=-1,
        msg_id=120,
        text="""【逆天之举】
面对风希分神，@mc 竟不退反进，祭出所有神通法宝奋力一搏！竟成功将其击溃！

【战利品】
- 你因此番感悟，修为暴涨 28860 点！
- 获得上界奇珍 【天凤之翎】x1！
- 获得限时增益 【风之祝福】(12小时)！
- 更令人惊喜的是，你在其消散的神魂中，捕获了一件至宝：【风雷翅图纸】x1！""",
        source="韩天尊",
        date="2026-05-15T14:00:00+00:00",
        sender_id=7900199668,
        sender_is_bot=True,
    )
    store.ingest_event(event)

    payload = MiniWebServer(store=store).resource_stats_payload(period="day", source_type="wind_xi")

    assert payload["event_summary"][0]["source_type"] == "wind_xi"
    assert payload["event_summary"][0]["source_name"] == "风希"
    assert payload["event_summary"][0]["success"] == 1
    assert {(row["resource_name"], row["total_amount"]) for row in payload["rows"]} == {
        ("修为", 28860),
        ("天凤之翎", 1),
        ("风之祝福", 1),
        ("风雷翅图纸", 1),
    }


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


def test_resource_stats_api_only_marks_whitelist_as_rare(tmp_path):
    store = SQLiteStore(tmp_path / "state.db")
    for idx, text in enumerate(
        [
            """【野外历练 · 灵机暗藏】
@salt9527 在山涧残阵旁避开妖兽踪迹，采得一份机缘。
获得修为 +12000，获得 【阴凝之晶】x1。""",
            """【野外历练 · 灵机暗藏】
@salt9527 在山涧残阵旁避开妖兽踪迹，采得一份机缘。
获得修为 +12000，获得 【三级妖丹】x1。""",
            """【野外历练 · 灵机暗藏】
@salt9527 在山涧残阵旁避开妖兽踪迹，采得一份机缘。
获得修为 +12000，获得 【养魂木】x1。""",
        ],
        start=1,
    ):
        store.ingest_event(
            RawMessageEvent(
                id=f"tg:-1:35{idx}",
                chat_id=-1,
                msg_id=350 + idx,
                text=text,
                source="韩天尊",
                date=f"2026-05-15T12:1{idx}:00+00:00",
                sender_id=7900199668,
                sender_is_bot=True,
            )
        )

    payload = MiniWebServer(store=store).resource_stats_payload(period="day", source_type="wild_training")
    categories = {row["resource_name"]: row["resource_category"] for row in payload["rows"]}
    assert categories["阴凝之晶"] == "rare"
    assert categories["三级妖丹"] == "common"
    assert categories["养魂木"] == "common"


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


def test_resource_backfill_rebuilds_current_version_legacy_source_names(tmp_path):
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
                "tg:-1:500",
                -1,
                500,
                """【野外历练 · 妖兽遭遇】
@salt9527 获得修为 +12000，获得 【灵石】x399。""",
                "韩天尊",
                "2026-05-15T12:00:00+00:00",
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
                "tg:-1:500",
                "wild_training",
                "野外历练",
                "success",
                "2026-05-15T12:00:00+00:00",
                "2026-05-15",
                "2026-W20",
                "2026-05",
            ),
        )
        conn.execute(
            """
            INSERT INTO settings(key, value_json)
            VALUES('resource_stats_schema_version', ?)
            """,
            (str(RESOURCE_STATS_SCHEMA_VERSION),),
        )

    assert store.backfill_resource_records_if_needed() == {"events": 1, "deltas": 2}
    assert {item["source_name"] for item in store.list_resource_events()} == {"野外历练·未知"}


def test_resource_stats_route_is_registered():
    assert "/api/resource-stats" in GET_ROUTES
