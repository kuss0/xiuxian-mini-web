from __future__ import annotations

import pytest

from layout_probe import run_layout_probe


def test_chat_layout_probe_with_headless_chromium():
    try:
        run_layout_probe()
    except RuntimeError as exc:
        pytest.skip(str(exc))
    except PermissionError as exc:
        pytest.skip(f"local layout probe server is not permitted: {exc}")
