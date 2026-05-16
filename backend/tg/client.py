from __future__ import annotations

from pathlib import Path

from backend.config import SESSION_DIR


def import_telethon():
    try:
        import telethon
    except ModuleNotFoundError as exc:
        raise RuntimeError("缺少 telethon 依赖，请先安装项目依赖") from exc
    return telethon


def parse_api_id(value: object) -> int:
    raw = str(value or "").strip()
    if not raw:
        raise ValueError("请先填写 API ID")
    try:
        api_id = int(raw)
    except ValueError:
        raise ValueError("API ID 必须是数字") from None
    if api_id <= 0:
        raise ValueError("API ID 必须大于 0")
    return api_id


def session_path(settings: dict) -> str:
    SESSION_DIR.mkdir(parents=True, exist_ok=True)
    return str(Path(SESSION_DIR) / safe_session_name(settings.get("session_name")))


def safe_session_name(value: object, fallback: str = "miniweb_session") -> str:
    raw_name = str(value or fallback).strip() or fallback
    safe_name = "".join(ch for ch in raw_name if ch.isalnum() or ch in {"_", "-"})
    return safe_name or fallback


def create_telegram_client(settings: dict):
    telethon = import_telethon()
    return telethon.TelegramClient(
        session_path(settings),
        parse_api_id(settings.get("api_id")),
        parse_api_hash(settings.get("api_hash")),
        proxy=build_telethon_proxy(settings),
    )


def parse_api_hash(value: object) -> str:
    api_hash = str(value or "").strip()
    if not api_hash:
        raise ValueError("请先填写 API Hash")
    return api_hash


def build_telethon_proxy(settings: dict) -> dict | None:
    proxy_type = str(settings.get("proxy_type") or "").strip().lower()
    if not proxy_type:
        return None
    if proxy_type not in {"http", "socks5"}:
        raise ValueError(f"代理类型仅支持 HTTP / SOCKS5，当前为: {proxy_type}")

    host, port = split_host_port(settings.get("proxy_host"))
    username = str(settings.get("proxy_username") or "").strip()
    password = str(settings.get("proxy_password") or "").strip()
    if bool(username) != bool(password):
        raise ValueError("代理用户名和代理密码需要同时填写")

    proxy = {
        "proxy_type": proxy_type,
        "addr": host,
        "port": port,
        "rdns": True,
    }
    if username and password:
        proxy["username"] = username
        proxy["password"] = password
    return proxy


def split_host_port(value: object) -> tuple[str, int]:
    raw = str(value or "").strip()
    if not raw:
        raise ValueError("请先填写代理 host:port")
    if raw.count(":") != 1:
        raise ValueError(f"代理 host:port 格式无效: {raw}")
    host, port_text = [part.strip() for part in raw.rsplit(":", 1)]
    if not host:
        raise ValueError(f"代理 host 不能为空: {raw}")
    try:
        port = int(port_text)
    except ValueError:
        raise ValueError(f"代理端口无效: {raw}") from None
    if port <= 0 or port > 65535:
        raise ValueError(f"代理端口超出范围: {raw}")
    return host, port
