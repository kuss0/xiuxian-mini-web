from __future__ import annotations

import json
import os
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from dataclasses import dataclass, field
from typing import Any


DEFAULT_TIANJIGE_BASE_URL = "https://asc.aiopenai.app"


@dataclass(frozen=True)
class TianjigeConfig:
    mode: str = "mock"
    base_url: str = DEFAULT_TIANJIGE_BASE_URL
    api_token: str = ""
    cookie: str = ""
    timeout_sec: float = 8.0
    min_interval_sec: float = 10.0

    @classmethod
    def from_env(cls) -> "TianjigeConfig":
        mode = str(os.environ.get("MINIWEB_TIANJIGE_MODE") or "mock").strip().lower()
        if mode not in {"off", "mock", "real"}:
            mode = "mock"
        try:
            timeout_sec = float(os.environ.get("MINIWEB_TIANJIGE_TIMEOUT_SEC") or 8)
        except (TypeError, ValueError):
            timeout_sec = 8.0
        try:
            min_interval_sec = float(os.environ.get("MINIWEB_TIANJIGE_MIN_INTERVAL_SEC") or 10)
        except (TypeError, ValueError):
            min_interval_sec = 10.0
        return cls(
            mode=mode,
            base_url=str(os.environ.get("MINIWEB_TIANJIGE_BASE_URL") or DEFAULT_TIANJIGE_BASE_URL).strip(),
            api_token=str(os.environ.get("MINIWEB_TIANJIGE_API_TOKEN") or "").strip(),
            cookie=str(os.environ.get("MINIWEB_TIANJIGE_COOKIE") or "").strip(),
            timeout_sec=max(1.0, timeout_sec),
            min_interval_sec=max(0.0, min_interval_sec),
        )

    @classmethod
    def from_settings(cls, settings: dict | None) -> "TianjigeConfig":
        settings = settings or {}
        fallback = cls.from_env()
        mode = str(settings.get("tianjige_mode") or fallback.mode).strip().lower()
        if mode not in {"off", "mock", "real"}:
            mode = fallback.mode

        def float_setting(key: str, default: float, *, minimum: float) -> float:
            raw = settings.get(key)
            if raw is None or str(raw).strip() == "":
                return default
            try:
                value = float(str(raw).strip())
            except (TypeError, ValueError):
                value = default
            return max(minimum, value)

        return cls(
            mode=mode,
            base_url=str(settings.get("tianjige_base_url") or fallback.base_url).strip(),
            api_token=str(settings.get("tianjige_api_token") or fallback.api_token).strip(),
            cookie=str(settings.get("tianjige_cookie") or fallback.cookie).strip(),
            timeout_sec=float_setting("tianjige_timeout_sec", fallback.timeout_sec, minimum=1.0),
            min_interval_sec=float_setting("tianjige_min_interval_sec", fallback.min_interval_sec, minimum=0.0),
        )


@dataclass
class TianjigeResult:
    ok: bool
    status: str
    data: Any = None
    error: str = ""
    status_code: int = 0
    retry_after: int = 0
    raw: Any = None
    meta: dict = field(default_factory=dict)

    def to_api(self) -> dict:
        return {
            "ok": self.ok,
            "status": self.status,
            "data": self.data,
            "error": self.error,
            "status_code": self.status_code,
            "retry_after": self.retry_after,
            "raw": self.raw,
            "meta": self.meta,
        }


class TianjigeGateway:
    """Manual, optional Tianjige API gateway.

    This adapter deliberately stays outside the runtime control path. It is for
    user-triggered Web reads only; failures are reported as data-source status.
    """

    def __init__(
        self,
        config: TianjigeConfig | None = None,
        *,
        opener=urllib.request.urlopen,
        now=time.monotonic,
    ) -> None:
        self.config = config or TianjigeConfig.from_env()
        self._opener = opener
        self._now = now
        self._lock = threading.Lock()
        self._last_request_at = 0.0
        self._last_result: dict = {}

    def configure(self, config: TianjigeConfig) -> None:
        with self._lock:
            self.config = config
            self._last_request_at = 0.0
            self._last_result = {}

    def status(self) -> dict:
        enabled = self.config.mode != "off"
        authenticated = self.config.mode == "mock" or bool(self.config.api_token and self.config.cookie)
        needs_oauth = self.config.mode == "real" and not authenticated
        message = "mock tianjige authorization succeeded"
        if not enabled:
            message = "天机阁 API 已关闭"
        elif needs_oauth:
            message = "缺少天机阁 cookie 或 X-API-Token"
        elif self.config.mode == "real":
            message = "天机阁凭据已配置"
        return {
            "enabled": enabled,
            "mode": self.config.mode,
            "base_url": self.config.base_url.rstrip("/"),
            "authenticated": authenticated,
            "needs_oauth": needs_oauth,
            "has_cookie": bool(self.config.cookie),
            "has_api_token": bool(self.config.api_token),
            "min_interval_seconds": self.config.min_interval_sec,
            "message": message,
            "last_result": self._last_result,
        }

    def bootstrap(self) -> TianjigeResult:
        return self._get("/api/bootstrap")

    def me(self) -> TianjigeResult:
        return self._get("/api/me")

    def cultivator(self, username: str) -> TianjigeResult:
        clean = str(username or "").strip().lstrip("@")
        if not clean:
            return TianjigeResult(False, "bad_request", error="缺少 username")
        return self._get(f"/api/cultivator/{urllib.parse.quote(clean)}", username=clean)

    def _get(self, path: str, **meta) -> TianjigeResult:
        if self.config.mode == "off":
            return self._remember(TianjigeResult(False, "disabled", error="天机阁 API 已关闭", meta=meta))
        if self.config.mode == "mock":
            return self._remember(self._mock_get(path, **meta))
        if not self.config.api_token or not self.config.cookie:
            return self._remember(TianjigeResult(False, "unauthorized", error="缺少天机阁 cookie 或 X-API-Token", meta=meta))
        limited = self._claim_request_slot()
        if limited:
            return self._remember(limited)
        return self._remember(self._real_get(path, **meta))

    def _claim_request_slot(self) -> TianjigeResult | None:
        if self.config.min_interval_sec <= 0:
            return None
        now = self._now()
        with self._lock:
            remain = self.config.min_interval_sec - (now - self._last_request_at)
            if remain > 0:
                return TianjigeResult(
                    False,
                    "rate_limited_local",
                    error=f"天机阁本地限速中,请 {int(remain) + 1} 秒后再试",
                    retry_after=int(remain) + 1,
                )
            self._last_request_at = now
        return None

    def _real_get(self, path: str, **meta) -> TianjigeResult:
        url = self.config.base_url.rstrip("/") + path
        request = urllib.request.Request(
            url,
            headers={
                "Accept": "application/json",
                "User-Agent": "xiuxian-mini-web/0.1",
                "X-API-Token": self.config.api_token,
                "Cookie": self.config.cookie,
            },
            method="GET",
        )
        try:
            with self._opener(request, timeout=self.config.timeout_sec) as response:
                status_code = int(getattr(response, "status", 200) or 200)
                raw_body = response.read().decode("utf-8", errors="replace")
                data = json.loads(raw_body) if raw_body.strip() else None
                return TianjigeResult(True, "ok", data=data, status_code=status_code, raw=data, meta=meta)
        except urllib.error.HTTPError as exc:
            raw_body = exc.read().decode("utf-8", errors="replace") if exc.fp else ""
            data = _decode_json(raw_body)
            retry_after = _safe_int(getattr(exc, "headers", {}).get("Retry-After"))
            status = _status_from_http(exc.code)
            return TianjigeResult(
                False,
                status,
                data=data,
                error=_error_message(status, exc.code),
                status_code=int(exc.code or 0),
                retry_after=retry_after,
                raw=data if data is not None else raw_body,
                meta=meta,
            )
        except (TimeoutError, urllib.error.URLError, OSError) as exc:
            return TianjigeResult(False, "network_error", error=str(exc), meta=meta)
        except (json.JSONDecodeError, UnicodeDecodeError) as exc:
            return TianjigeResult(False, "schema_unknown", error=f"天机阁响应不是可解析 JSON: {exc}", meta=meta)

    def _mock_get(self, path: str, **meta) -> TianjigeResult:
        if path == "/api/bootstrap":
            return TianjigeResult(True, "mock", data=_mock_bootstrap(), status_code=200, raw=_mock_bootstrap(), meta=meta)
        if path == "/api/me":
            return TianjigeResult(True, "mock", data=_mock_me(), status_code=200, raw=_mock_me(), meta=meta)
        if path.startswith("/api/cultivator/"):
            username = urllib.parse.unquote(path.rsplit("/", 1)[-1])
            detail = _mock_cultivator(username)
            if not detail:
                return TianjigeResult(False, "not_found", error="天机阁未找到该修士", status_code=404, meta=meta)
            return TianjigeResult(True, "mock", data=detail, status_code=200, raw=detail, meta=meta)
        return TianjigeResult(False, "not_available", error="该天机阁 API 尚未接入", status_code=404, meta=meta)

    def _remember(self, result: TianjigeResult) -> TianjigeResult:
        self._last_result = {
            "ok": result.ok,
            "status": result.status,
            "status_code": result.status_code,
            "error": result.error,
            "retry_after": result.retry_after,
            "at": int(time.time()),
        }
        return result


def tianjige_profile_patches(data: dict) -> list[dict]:
    raw = data or {}
    rows = [
        ("角色名", raw.get("username") or raw.get("name")),
        ("道号", raw.get("dao_name")),
        ("境界", raw.get("cultivation_level") or raw.get("level")),
        ("宗门", raw.get("sect_name")),
        ("灵根", raw.get("spirit_root")),
        ("修为", raw.get("cultivation_points")),
    ]
    return [
        {"scope": "identity_profile", "key": key, "value": value}
        for key, value in rows
        if value not in (None, "")
    ]


def tianjige_inventory_items(data: dict) -> list[dict]:
    inventory = (data or {}).get("inventory") or {}
    items: list[dict] = []
    for raw in inventory.get("items") or []:
        if not isinstance(raw, dict):
            continue
        quantity = raw.get("quantity", raw.get("amount", 0))
        items.append({
            "item_id": raw.get("item_id") or "",
            "name": raw.get("name") or raw.get("item_name") or raw.get("item_id") or "",
            "amount": _safe_int(quantity),
            "type": raw.get("type") or "",
            "source": "tianjige",
            "raw": raw,
        })
    materials = inventory.get("materials") or {}
    if isinstance(materials, dict):
        for item_id, amount in materials.items():
            items.append({
                "item_id": str(item_id),
                "name": str(item_id),
                "amount": _safe_int(amount),
                "type": "material",
                "source": "tianjige",
                "raw": {"item_id": item_id, "quantity": amount},
            })
    return items


def _mock_bootstrap() -> dict:
    return {
        "game_items": {
            "mat_001": {"name": "灵石", "type": "material"},
            "elixir_001": {"name": "增元丹", "type": "elixir"},
            "elixir_201": {"name": "筑基丹", "type": "elixir"},
            "treasure_201": {"name": "青竹蜂云剑", "type": "treasure"},
            "recipe_001": {"name": "增元丹丹方", "type": "recipe"},
        },
        "level_thresholds": {
            "炼气一层": 100,
            "筑基初期": 5000,
            "结丹初期": 50000,
            "元婴初期": 500000,
            "化神初期": 4000000,
        },
    }


def _mock_me() -> dict:
    characters = [
        _mock_cultivator("mock_main"),
        _mock_cultivator("avatar_7652191864"),
        _mock_cultivator("avatar_8357414829"),
        _mock_cultivator("channel_-1003878543765"),
    ]
    return {
        "binding": {
            "active_character_id": 7239362314,
            "bound_channel_character_ids": [-1003878543765],
            "bound_character_ids": [-1003878543765, 7239362314, 7652191864, 8357414829],
            "bound_personal_character_ids": [7239362314, 7652191864, 8357414829],
            "personal_id": 1047775783,
            "verified_channel_ids": [],
            "web_self_service_enabled": False,
        },
        "characters": [item for item in characters if item],
    }


def _mock_cultivator(username: str) -> dict | None:
    key = str(username or "").strip().lstrip("@").lower()
    rows = {
        "mock_main": {
            "username": "mock_main",
            "telegram_id": 7239362314,
            "dao_name": "获赦之人",
            "cultivation_level": "化神初期",
            "cultivation_points": 265959,
            "sect_id": 9,
            "sect_name": "星宫",
            "spirit_root": "异灵根",
            "inventory": {
                "items": [{"item_id": "treasure_201", "name": "青竹蜂云剑", "quantity": 1, "type": "treasure"}],
                "materials": {"mat_001": 50000, "mat_101": 200},
            },
        },
        "avatar_7652191864": {
            "username": "avatar_7652191864",
            "telegram_id": 7652191864,
            "dao_name": "墨竹生",
            "cultivation_level": "元婴后期",
            "cultivation_points": 802200,
            "sect_id": 4,
            "sect_name": "落云宗",
            "spirit_root": "木灵根",
            "inventory": {"items": [], "materials": {"mat_001": 12000}},
        },
        "avatar_8357414829": {
            "username": "avatar_8357414829",
            "telegram_id": 8357414829,
            "dao_name": "清源子",
            "cultivation_level": "结丹后期",
            "cultivation_points": 225000,
            "sect_id": 6,
            "sect_name": "万灵宗",
            "spirit_root": "水灵根",
            "inventory": {"items": [], "materials": {"mat_001": 9000}},
        },
        "channel_-1003878543765": {
            "username": "channel_-1003878543765",
            "telegram_id": -1003878543765,
            "dao_name": "守山灵",
            "cultivation_level": "筑基后期",
            "cultivation_points": 13000,
            "sect_id": 7,
            "sect_name": "太一门",
            "spirit_root": "土灵根",
            "inventory": {"items": [], "materials": {"mat_001": 3000}},
        },
    }
    if key in rows:
        return rows[key]
    # Useful for local manual checks: any username gets a schema-valid mock panel.
    if key:
        return {
            "username": key,
            "telegram_id": 0,
            "dao_name": key,
            "cultivation_level": "未知",
            "cultivation_points": 0,
            "sect_id": None,
            "sect_name": None,
            "spirit_root": None,
            "inventory": {"items": [], "materials": {}},
        }
    return None


def _decode_json(raw: str) -> Any:
    if not str(raw or "").strip():
        return None
    try:
        return json.loads(raw)
    except json.JSONDecodeError:
        return None


def _safe_int(value: object) -> int:
    try:
        return int(value)
    except (TypeError, ValueError):
        return 0


def _status_from_http(code: int) -> str:
    if code == 401:
        return "unauthorized"
    if code == 403:
        return "forbidden"
    if code == 404:
        return "not_found"
    if code == 429:
        return "rate_limited"
    return "http_error"


def _error_message(status: str, code: int) -> str:
    return {
        "unauthorized": "天机阁登录态失效",
        "forbidden": "天机阁暂不可用或被拒绝",
        "not_found": "天机阁未找到该资源",
        "rate_limited": "天机阁限流中",
    }.get(status, f"天机阁 HTTP {code}")


__all__ = [
    "TianjigeConfig",
    "TianjigeGateway",
    "TianjigeResult",
    "tianjige_inventory_items",
    "tianjige_profile_patches",
]
