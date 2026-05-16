"""共享 fixture helper:从 tests/fixtures/parsers/ 加载文本,
喂给单个 parser,断言结构化输出。"""

from __future__ import annotations

from pathlib import Path

from backend.domain.models import RawMessageEvent

FIXTURE_DIR = Path(__file__).resolve().parent.parent / "fixtures" / "parsers"


def load_fixture(name: str) -> str:
    return (FIXTURE_DIR / name).read_text(encoding="utf-8")


def make_event(text: str, *, chat_id: int = -1001, msg_id: int = 100) -> RawMessageEvent:
    return RawMessageEvent(
        id=f"tg:{chat_id}:{msg_id}",
        chat_id=chat_id,
        msg_id=msg_id,
        text=text,
        source="韩天尊",
        date="2026-05-15T12:00:00+00:00",
        sender_id=7900199668,
        sender_is_bot=True,
    )
