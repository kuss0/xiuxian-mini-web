from __future__ import annotations

import os
from dataclasses import dataclass
from pathlib import Path


ROOT_DIR = Path(__file__).resolve().parents[1]
DATA_DIR = ROOT_DIR / "data"
SESSION_DIR = DATA_DIR / "sessions"
WEB_DIR = ROOT_DIR / "web"
ACCESS_TOKEN = os.environ.get("MINIWEB_ACCESS_TOKEN", "").strip()
MAX_ACCOUNTS = int(os.environ.get("MINIWEB_MAX_ACCOUNTS", "100") or "100")
MAX_IDENTITIES = int(os.environ.get("MINIWEB_MAX_IDENTITIES", "100") or "100")
MAX_LISTENERS = int(os.environ.get("MINIWEB_MAX_LISTENERS", "1") or "1")

# 速率限制配置
RATE_LIMIT_ENABLED = os.environ.get("MINIWEB_RATE_LIMIT", "true").lower() in {"1", "true", "yes"}
RATE_LIMIT_MAX_REQUESTS = int(os.environ.get("MINIWEB_RATE_LIMIT_MAX", "60") or "60")
RATE_LIMIT_WINDOW_SEC = int(os.environ.get("MINIWEB_RATE_LIMIT_WINDOW", "60") or "60")


@dataclass(frozen=True)
class ServerConfig:
    host: str = "127.0.0.1"
    port: int = 8787
    web_dir: Path = WEB_DIR
