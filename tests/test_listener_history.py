import asyncio
import sqlite3

from backend.domain.models import RawMessageEvent
from backend.repo.sqlite_store import SQLiteStore
from backend.tg.listener import TelegramReadOnlyListener


class AsyncMessageIter:
    def __init__(self, messages):
        self._messages = list(messages)

    def __aiter__(self):
        self._iter = iter(self._messages)
        return self

    async def __anext__(self):
        try:
            return next(self._iter)
        except StopIteration:
            raise StopAsyncIteration


class FakeReply:
    def __init__(self, top_id: int):
        self.reply_to_top_id = top_id


class FakeSender:
    title = None
    username = ""
    bot = False

    def __init__(self, first_name: str):
        self.first_name = first_name
        self.last_name = ""


class FakeMessage:
    def __init__(self, msg_id: int, text: str, *, topic_id: int, reply_to_msg_id: int | None = None):
        self.id = msg_id
        self.message = text
        self.date = None
        self.edit_date = None
        self.sender_id = 8757550896
        self.chat_id = -1001680975844
        self.reply_to_msg_id = topic_id if reply_to_msg_id is None else reply_to_msg_id
        self.reply_to = FakeReply(topic_id)
        self.sender = FakeSender("韩天尊")


class FakeClient:
    def __init__(self, messages=None, *, responses=None, parent_messages=None):
        self.messages = list(messages or [])
        self.responses = [list(item) for item in responses] if responses is not None else None
        self.parent_messages = dict(parent_messages or {})
        self.calls = []

    async def get_entity(self, target_chat):
        return target_chat

    def iter_messages(self, entity, **kwargs):
        self.calls.append(kwargs)
        if self.responses is not None:
            return AsyncMessageIter(self.responses.pop(0))
        return AsyncMessageIter(self.messages)

    async def get_messages(self, entity, ids):
        self.calls.append({"get_messages": ids})
        return self.parent_messages.get(int(ids))


class FakeSink:
    def __init__(self, latest: int = 0, gaps=None):
        self.latest = latest
        self.gaps = list(gaps or [])
        self.events = []

    def latest_message_id(self, chat_id: int, topic_id: int = 0) -> int:
        return self.latest

    def message_id_gaps(self, chat_id: int, topic_id: int = 0, **kwargs):
        return self.gaps

    def has_message(self, chat_id: int, msg_id: int, topic_id: int = 0) -> bool:
        return any(event.chat_id == chat_id and event.msg_id == msg_id for event in self.events)

    def ingest_event(self, event: RawMessageEvent):
        self.events.append(event)


def test_listener_backfills_history_after_latest_message_id():
    sink = FakeSink(latest=100)
    listener = TelegramReadOnlyListener(sink)
    client = FakeClient(
        [
            FakeMessage(101, "其他话题", topic_id=999),
            FakeMessage(102, "目标话题", topic_id=7310786),
        ]
    )

    message = asyncio.run(listener._backfill_history(client, -1001680975844, 7310786))

    assert "历史补采 1 条" in message
    assert [event.msg_id for event in sink.events] == [102]
    assert sink.events[0].source == "韩天尊"
    assert client.calls == [{"min_id": 100, "reverse": True, "limit": listener._HISTORY_BACKFILL_LIMIT}]


def test_listener_backfills_known_message_id_gaps():
    sink = FakeSink(
        latest=300,
        gaps=[
            {
                "after_msg_id": 100,
                "before_msg_id": 200,
                "gap_seconds": 900,
                "missing_msg_ids": 99,
            }
        ],
    )
    listener = TelegramReadOnlyListener(sink)
    client = FakeClient(
        responses=[
            [],
            [FakeMessage(150, "空窗消息", topic_id=7310786)],
            [],
        ]
    )

    message = asyncio.run(listener._backfill_history(client, -1001680975844, 7310786))

    assert "修补空窗 1 段/1 条" in message
    assert [event.msg_id for event in sink.events] == [150]
    assert client.calls == [
        {"min_id": 300, "reverse": True, "limit": listener._HISTORY_BACKFILL_LIMIT},
        {"min_id": 100, "max_id": 200, "reverse": True, "limit": 99},
        {"min_id": 150, "max_id": 200, "reverse": True, "limit": 49},
    ]


def test_listener_backfills_missing_reply_parent_before_child():
    sink = FakeSink(latest=80)
    listener = TelegramReadOnlyListener(sink)
    parent = FakeMessage(90, ".宗门战况", topic_id=7310786)
    child = FakeMessage(91, "【宗门战况】\n当前无战事。", topic_id=7310786, reply_to_msg_id=90)
    client = FakeClient([child], parent_messages={90: parent})

    message = asyncio.run(listener._backfill_history(client, -1001680975844, 7310786))

    assert "历史补采 1 条" in message
    assert [event.msg_id for event in sink.events] == [90, 91]
    assert sink.events[1].reply_to_msg_id == 90
    assert {"get_messages": 90} in client.calls


def test_listener_ingest_retries_sqlite_busy():
    event = RawMessageEvent(id="x", chat_id=1, msg_id=1, text="hi", source="me", date="")

    class BusySink:
        def __init__(self):
            self.calls = 0
            self.events = []

        def ingest_event(self, raw_event):
            self.calls += 1
            if self.calls < 3:
                raise sqlite3.OperationalError("database is locked")
            self.events.append(raw_event)

    sink = BusySink()
    listener = TelegramReadOnlyListener(sink)
    listener._INGEST_BUSY_BASE_SLEEP = 0

    ok = asyncio.run(listener._ingest_event_with_retry(event))

    assert ok is True
    assert sink.calls == 3
    assert sink.events == [event]


def test_sqlite_store_latest_message_id_respects_topic(tmp_path):
    store = SQLiteStore(tmp_path / "miniweb.db")
    store.ingest_event(RawMessageEvent(id="m1", chat_id=-1001, msg_id=10, text="a", source="x", date="", top_msg_id=111))
    store.ingest_event(RawMessageEvent(id="m2", chat_id=-1001, msg_id=20, text="b", source="x", date="", top_msg_id=222))
    store.ingest_event(RawMessageEvent(id="m3", chat_id=-1001, msg_id=30, text="c", source="x", date=""))

    assert store.latest_message_id(-1001, 111) == 10
    assert store.latest_message_id(-1001, 222) == 20
    assert store.latest_message_id(-1001) == 30
