from __future__ import annotations

import argparse
import asyncio
import hmac
import json
import mimetypes
import os
import sys
import time
from dataclasses import dataclass
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse

if __package__ in (None, ""):
    sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from backend.config import ACCESS_TOKEN, WEB_DIR
from backend.server import MiniWebServer


@dataclass
class RawResponse:
    """非 JSON 的 GET 响应,handler 看到这个就走 _send_raw 而不是 _send_json。
    用来支持文件下载(导出消息日志等)。"""

    body: bytes
    content_type: str = "application/octet-stream"
    filename: str = ""

BUILD_ID = os.environ.get("MINIWEB_BUILD_ID") or str(int(time.time()))


def is_authorized_api_headers(headers, access_token: str) -> bool:
    if not access_token:
        return True
    token = str(headers.get("X-Miniweb-Token") or "").strip()
    authorization = str(headers.get("Authorization") or "").strip()
    if authorization.lower().startswith("bearer "):
        token = authorization[7:].strip()
    return hmac.compare_digest(token, access_token)


def _inject_build_id(body: bytes) -> bytes:
    """给 HTML 里的 /static/...js / .css 路径自动追加 ?v=BUILD_ID,
    让浏览器和反代每次重启都把它们当新 URL,绕开缓存。"""
    text = body.decode("utf-8", errors="replace")
    suffix = f"?v={BUILD_ID}"
    text = text.replace('href="/static/styles.css"', f'href="/static/styles.css{suffix}"')
    text = text.replace('src="/static/app.js"', f'src="/static/app.js{suffix}"')
    return text.encode("utf-8")


class MiniWebHandler(BaseHTTPRequestHandler):
    server_version = "XiuxianMiniWeb/0.1"
    app_server: MiniWebServer | None = None
    access_token = ACCESS_TOKEN
    web_dir = WEB_DIR

    def do_GET(self) -> None:
        self._handle_request(include_body=True)

    def do_HEAD(self) -> None:
        self._handle_request(include_body=False)

    def do_POST(self) -> None:
        self._handle_post()

    def _handle_request(self, include_body: bool) -> None:
        parsed = urlparse(self.path)
        path = parsed.path
        query = parse_qs(parsed.query)

        if path.startswith("/api/") and not self._is_authorized_api_request():
            self._send_error(HTTPStatus.UNAUTHORIZED, "需要访问口令", include_body=include_body)
            return

        route = GET_ROUTES.get(path)
        if route:
            result = route(self, query)
            if isinstance(result, RawResponse):
                self._send_raw(result, include_body=include_body)
            else:
                self._send_json(result, include_body=include_body)
            return

        self._serve_static(path, include_body=include_body)

    def _handle_post(self) -> None:
        parsed = urlparse(self.path)
        if parsed.path.startswith("/api/") and not self._is_authorized_api_request():
            self._send_error(HTTPStatus.UNAUTHORIZED, "需要访问口令")
            return

        route = POST_ROUTES.get(parsed.path)
        if route is None:
            self._send_error(HTTPStatus.NOT_FOUND, "Not found")
            return
        payload = self._read_json_payload() if route.needs_payload else {}
        if payload is not None:
            self._send_json(route(self, payload))

    def _read_json_payload(self) -> dict | None:
        try:
            length = int(self.headers.get("Content-Length") or 0)
            raw_body = self.rfile.read(length) if length > 0 else b"{}"
            payload = json.loads(raw_body.decode("utf-8") or "{}")
            if not isinstance(payload, dict):
                raise ValueError("JSON body must be an object")
            return payload
        except (UnicodeDecodeError, json.JSONDecodeError, ValueError) as exc:
            self._send_error(HTTPStatus.BAD_REQUEST, f"Invalid JSON: {exc}")
            return None

    def log_message(self, fmt: str, *args: object) -> None:
        print(f"[mini-web] {self.address_string()} - {fmt % args}")

    def _is_authorized_api_request(self) -> bool:
        return is_authorized_api_headers(self.headers, self.access_token)

    def _serve_static(self, path: str, *, include_body: bool) -> None:
        if path == "/":
            path = "/index.html"

        web_dir = Path(self.web_dir).resolve()
        target = (web_dir / path.lstrip("/")).resolve()
        try:
            target.relative_to(web_dir)
        except ValueError:
            self._send_error(HTTPStatus.FORBIDDEN, "Forbidden", include_body=include_body)
            return

        if not target.exists() or not target.is_file():
            self._send_error(HTTPStatus.NOT_FOUND, "Not found", include_body=include_body)
            return

        content_type = mimetypes.guess_type(target.name)[0] or "application/octet-stream"
        body = target.read_bytes()
        if target.suffix == ".html":
            body = _inject_build_id(body)
        self.send_response(HTTPStatus.OK)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store, must-revalidate")
        self.end_headers()
        if include_body:
            self.wfile.write(body)

    def _send_json(
        self,
        payload: dict,
        status: HTTPStatus = HTTPStatus.OK,
        *,
        include_body: bool = True,
    ) -> None:
        body = json.dumps(payload, ensure_ascii=False, indent=2).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        if include_body:
            self.wfile.write(body)

    def _send_error(self, status: HTTPStatus, message: str, *, include_body: bool = True) -> None:
        self._send_json({"ok": False, "error": message}, status=status, include_body=include_body)

    def _send_raw(self, raw: RawResponse, *, include_body: bool = True) -> None:
        body = raw.body or b""
        self.send_response(HTTPStatus.OK)
        self.send_header("Content-Type", raw.content_type or "application/octet-stream")
        self.send_header("Content-Length", str(len(body)))
        if raw.filename:
            self.send_header(
                "Content-Disposition",
                f'attachment; filename="{raw.filename}"',
            )
        self.end_headers()
        if include_body:
            self.wfile.write(body)




class PostRoute:
    def __init__(self, handler, *, needs_payload: bool = False) -> None:
        self._handler = handler
        self.needs_payload = needs_payload

    def __call__(self, request: MiniWebHandler, payload: dict) -> dict:
        return self._handler(request, payload)


def _app(request: MiniWebHandler) -> MiniWebServer:
    if request.app_server is None:
        raise RuntimeError("MiniWebServer is not configured")
    return request.app_server


def _get_health(request: MiniWebHandler, query: dict) -> dict:
    return _app(request).health_payload()


def _get_channels(request: MiniWebHandler, query: dict) -> dict:
    return _app(request).channels_payload()


def _get_messages(request: MiniWebHandler, query: dict) -> dict:
    channel = (query.get("channel") or ["all"])[0]
    since_seq = (query.get("since_seq") or ["0"])[0]
    before_seq = (query.get("before_seq") or ["0"])[0]
    limit = (query.get("limit") or ["0"])[0]
    target_id = (query.get("id") or query.get("target_id") or [""])[0]
    mode = (query.get("mode") or [""])[0]
    return _app(request).messages_payload(
        channel, since_seq=since_seq, before_seq=before_seq, limit=limit, target_id=target_id, mode=mode
    )


def _get_messages_export(request: MiniWebHandler, query: dict):
    """日志 modal 的「导出」按钮端点。返 RawResponse → 浏览器触发文件下载。
    fmt: jsonl(默认)/ csv / txt"""
    channel = (query.get("channel") or ["all"])[0]
    mode = (query.get("mode") or [""])[0]
    fmt = (query.get("fmt") or query.get("format") or ["jsonl"])[0]
    result = _app(request).messages_export_payload(channel, mode=mode, fmt=fmt)
    return RawResponse(
        body=result.get("body") or b"",
        content_type=result.get("content_type") or "application/octet-stream",
        filename=result.get("filename") or "xiuxian-messages.txt",
    )


def _get_outbox(request: MiniWebHandler, query: dict) -> dict:
    return _app(request).outbox_payload()


def _get_outbox_drafts(request: MiniWebHandler, query: dict) -> dict:
    status = (query.get("status") or ["draft"])[0]
    return _app(request).outbox_drafts_payload(status)


def _get_settings(request: MiniWebHandler, query: dict) -> dict:
    return _app(request).settings_payload()


def _get_state_patches(request: MiniWebHandler, query: dict) -> dict:
    scope = (query.get("scope") or [""])[0]
    try:
        send_as_id = int((query.get("send_as_id") or ["0"])[0])
    except (TypeError, ValueError):
        send_as_id = 0
    return _app(request).state_patches_payload(scope, send_as_id=send_as_id)


def _get_resource_stats(request: MiniWebHandler, query: dict) -> dict:
    period = (query.get("period") or ["day"])[0]
    source_type = (query.get("source_type") or [""])[0]
    source_name = (query.get("source_name") or [""])[0]
    try:
        limit = int((query.get("limit") or ["120"])[0])
    except (TypeError, ValueError):
        limit = 120
    return _app(request).resource_stats_payload(
        period=period,
        source_type=source_type,
        source_name=source_name,
        limit=limit,
    )


def _get_inventory(request: MiniWebHandler, query: dict) -> dict:
    owner = (query.get("owner") or [""])[0]
    latest_raw = str((query.get("latest_only") or ["1"])[0]).lower()
    latest_only = latest_raw not in {"0", "false", "no"}
    try:
        limit = int((query.get("limit") or ["80"])[0])
    except (TypeError, ValueError):
        limit = 80
    return _app(request).inventory_payload(
        owner=owner,
        latest_only=latest_only,
        limit=limit,
    )


def _get_discovered_bots(request: MiniWebHandler, query: dict) -> dict:
    return _app(request).discovered_bots_payload()


def _get_accounts(request: MiniWebHandler, query: dict) -> dict:
    return _app(request).accounts_payload()


def _get_identities(request: MiniWebHandler, query: dict) -> dict:
    return _app(request).identities_payload()


def _get_identity_state(request: MiniWebHandler, query: dict) -> dict:
    send_as_id = (query.get("send_as_id") or [""])[0]
    return _app(request).identity_state_payload(send_as_id)


def _get_listener_status(request: MiniWebHandler, query: dict) -> dict:
    return _app(request).listener_status_payload()


def _get_telegram_dialogs(request: MiniWebHandler, query: dict) -> dict:
    return asyncio.run(_app(request).telegram_dialogs_payload())


def _get_telegram_topics(request: MiniWebHandler, query: dict) -> dict:
    chat = (query.get("chat") or [""])[0]
    return asyncio.run(_app(request).telegram_topics_payload(chat))


def _get_account_send_as_peers(request: MiniWebHandler, query: dict) -> dict:
    local_id = (query.get("local_id") or [""])[0]
    target_chat = (query.get("target_chat") or [""])[0]
    return _app(request).account_send_as_peers_payload(local_id, target_chat)


def _get_account_dialogs(request: MiniWebHandler, query: dict) -> dict:
    local_id = (query.get("local_id") or [""])[0]
    return _app(request).account_dialogs_payload(local_id)


def _get_account_topics(request: MiniWebHandler, query: dict) -> dict:
    local_id = (query.get("local_id") or [""])[0]
    chat = (query.get("chat") or [""])[0]
    return _app(request).account_topics_payload(local_id, chat)


def _post_settings(request: MiniWebHandler, payload: dict) -> dict:
    return _app(request).save_settings_payload(payload)


def _post_focus_exclude_preview(request: MiniWebHandler, payload: dict) -> dict:
    try:
        return _app(request).focus_exclude_preview_payload(payload)
    except Exception as exc:
        return {"ok": False, "error": str(exc)}


def _post_inventory_transfer_plan(request: MiniWebHandler, payload: dict) -> dict:
    try:
        return _app(request).inventory_transfer_plan_payload(payload)
    except Exception as exc:
        return {"ok": False, "error": str(exc)}


def _post_account(request: MiniWebHandler, payload: dict) -> dict:
    try:
        return _app(request).save_account_payload(payload)
    except Exception as exc:
        return {"ok": False, "error": str(exc)}


def _post_account_delete(request: MiniWebHandler, payload: dict) -> dict:
    try:
        return _app(request).delete_account_payload(payload)
    except Exception as exc:
        return {"ok": False, "error": str(exc)}


def _post_account_logout(request: MiniWebHandler, payload: dict) -> dict:
    try:
        return _app(request).logout_account_payload(payload)
    except Exception as exc:
        return {"ok": False, "error": str(exc)}


def _post_identity(request: MiniWebHandler, payload: dict) -> dict:
    try:
        return _app(request).save_identity_payload(payload)
    except Exception as exc:
        return {"ok": False, "error": str(exc)}


def _post_identity_batch(request: MiniWebHandler, payload: dict) -> dict:
    try:
        return _app(request).batch_save_identities_payload(payload)
    except Exception as exc:
        return {"ok": False, "error": str(exc), "results": []}


def _post_identity_delete(request: MiniWebHandler, payload: dict) -> dict:
    try:
        return _app(request).delete_identity_payload(payload)
    except Exception as exc:
        return {"ok": False, "error": str(exc)}


def _post_outbox_plan(request: MiniWebHandler, payload: dict) -> dict:
    try:
        return _app(request).outbox_plan_payload(payload)
    except Exception as exc:
        return {"ok": False, "error": str(exc)}


def _post_outbox_draft(request: MiniWebHandler, payload: dict) -> dict:
    try:
        return _app(request).create_outbox_draft_payload(payload)
    except Exception as exc:
        return {"ok": False, "error": str(exc)}


def _post_outbox_draft_delete(request: MiniWebHandler, payload: dict) -> dict:
    try:
        return _app(request).delete_outbox_draft_payload(payload)
    except Exception as exc:
        return {"ok": False, "error": str(exc)}


def _post_login_start(request: MiniWebHandler, payload: dict) -> dict:
    return _app(request).login_start_payload()


def _post_login_cancel(request: MiniWebHandler, payload: dict) -> dict:
    return _app(request).login_cancel_payload()


def _post_login_verify(request: MiniWebHandler, payload: dict) -> dict:
    return _app(request).login_verify_payload(payload)


def _post_listener_start(request: MiniWebHandler, payload: dict) -> dict:
    return _app(request).listener_start_payload()


def _post_listener_stop(request: MiniWebHandler, payload: dict) -> dict:
    return _app(request).listener_stop_payload()


def _post_account_login_start(request: MiniWebHandler, payload: dict) -> dict:
    try:
        return _app(request).account_login_start_payload(payload)
    except Exception as exc:
        return {"ok": False, "error": str(exc)}


def _post_account_login_verify(request: MiniWebHandler, payload: dict) -> dict:
    try:
        return _app(request).account_login_verify_payload(payload)
    except Exception as exc:
        return {"ok": False, "error": str(exc)}


def _post_account_login_cancel(request: MiniWebHandler, payload: dict) -> dict:
    try:
        return _app(request).account_login_cancel_payload(payload)
    except Exception as exc:
        return {"ok": False, "error": str(exc)}


def _post_account_listener_start(request: MiniWebHandler, payload: dict) -> dict:
    try:
        return _app(request).account_listener_start_payload(payload)
    except Exception as exc:
        return {"ok": False, "error": str(exc)}


def _post_account_listener_stop(request: MiniWebHandler, payload: dict) -> dict:
    try:
        return _app(request).account_listener_stop_payload(payload)
    except Exception as exc:
        return {"ok": False, "error": str(exc)}


def _post_account_resolve_entity(request: MiniWebHandler, payload: dict) -> dict:
    return _app(request).account_resolve_entity_payload(payload)


# ---------- 官方定时 ----------

def _get_schedule_presets(request: MiniWebHandler, query: dict) -> dict:
    return _app(request).schedule_presets_payload()


def _get_schedule(request: MiniWebHandler, query: dict) -> dict:
    return _app(request).schedule_list_payload()


def _get_schedule_sync(request: MiniWebHandler, query: dict) -> dict:
    send_as_id = (query.get("send_as_id") or ["0"])[0]
    return _app(request).schedule_sync_payload(send_as_id)


def _post_schedule_preview(request: MiniWebHandler, payload: dict) -> dict:
    return _app(request).schedule_preview_payload(payload)


def _post_schedule_create(request: MiniWebHandler, payload: dict) -> dict:
    return _app(request).schedule_create_payload(payload)


def _post_schedule_delete(request: MiniWebHandler, payload: dict) -> dict:
    return _app(request).schedule_delete_payload(payload)


def _post_schedule_cancel(request: MiniWebHandler, payload: dict) -> dict:
    return _app(request).schedule_cancel_payload(payload)


# ---------- 技能盘(直接 / 回复发送)----------

def _get_skills(request: MiniWebHandler, query: dict) -> dict:
    return _app(request).skills_payload()


def _post_skill_send(request: MiniWebHandler, payload: dict) -> dict:
    try:
        return _app(request).skill_send_payload(payload)
    except Exception as exc:
        return {"ok": False, "error": str(exc)}


# ---------- 通知 ----------

def _post_notify_test(request: MiniWebHandler, payload: dict) -> dict:
    try:
        return _app(request).notify_test_payload(payload or {})
    except Exception as exc:
        return {"ok": False, "error": str(exc)}


def _get_notify_card_titles(request: MiniWebHandler, query: dict) -> dict:
    return _app(request).notify_card_titles_payload()


GET_ROUTES = {
    "/api/health": _get_health,
    "/api/channels": _get_channels,
    "/api/messages": _get_messages,
    "/api/messages/export": _get_messages_export,
    "/api/outbox": _get_outbox,
    "/api/outbox/drafts": _get_outbox_drafts,
    "/api/settings": _get_settings,
    "/api/state-patches": _get_state_patches,
    "/api/resource-stats": _get_resource_stats,
    "/api/inventory": _get_inventory,
    "/api/discovered-bots": _get_discovered_bots,
    "/api/accounts": _get_accounts,
    "/api/identities": _get_identities,
    "/api/identity-state": _get_identity_state,
    "/api/listener/status": _get_listener_status,
    "/api/telegram/dialogs": _get_telegram_dialogs,
    "/api/telegram/topics": _get_telegram_topics,
    "/api/accounts/send-as-peers": _get_account_send_as_peers,
    "/api/accounts/dialogs": _get_account_dialogs,
    "/api/accounts/topics": _get_account_topics,
    "/api/schedule/presets": _get_schedule_presets,
    "/api/schedule": _get_schedule,
    "/api/schedule/sync": _get_schedule_sync,
    "/api/skills": _get_skills,
    "/api/notify/card-titles": _get_notify_card_titles,
}


POST_ROUTES = {
    "/api/settings": PostRoute(_post_settings, needs_payload=True),
    "/api/focus-exclude/preview": PostRoute(_post_focus_exclude_preview, needs_payload=True),
    "/api/inventory/transfer-plan": PostRoute(_post_inventory_transfer_plan, needs_payload=True),
    "/api/accounts": PostRoute(_post_account, needs_payload=True),
    "/api/accounts/delete": PostRoute(_post_account_delete, needs_payload=True),
    "/api/accounts/logout": PostRoute(_post_account_logout, needs_payload=True),
    "/api/identities": PostRoute(_post_identity, needs_payload=True),
    "/api/identities/batch": PostRoute(_post_identity_batch, needs_payload=True),
    "/api/identities/delete": PostRoute(_post_identity_delete, needs_payload=True),
    "/api/outbox/plan": PostRoute(_post_outbox_plan, needs_payload=True),
    "/api/outbox/drafts": PostRoute(_post_outbox_draft, needs_payload=True),
    "/api/outbox/drafts/delete": PostRoute(_post_outbox_draft_delete, needs_payload=True),
    "/api/login/start": PostRoute(_post_login_start),
    "/api/login/cancel": PostRoute(_post_login_cancel),
    "/api/login/verify": PostRoute(_post_login_verify, needs_payload=True),
    "/api/listener/start": PostRoute(_post_listener_start),
    "/api/listener/stop": PostRoute(_post_listener_stop),
    "/api/accounts/login/start": PostRoute(_post_account_login_start, needs_payload=True),
    "/api/accounts/login/verify": PostRoute(_post_account_login_verify, needs_payload=True),
    "/api/accounts/login/cancel": PostRoute(_post_account_login_cancel, needs_payload=True),
    "/api/accounts/listener/start": PostRoute(_post_account_listener_start, needs_payload=True),
    "/api/accounts/listener/stop": PostRoute(_post_account_listener_stop, needs_payload=True),
    "/api/accounts/resolve-entity": PostRoute(_post_account_resolve_entity, needs_payload=True),
    "/api/schedule/preview": PostRoute(_post_schedule_preview, needs_payload=True),
    "/api/schedule/create": PostRoute(_post_schedule_create, needs_payload=True),
    "/api/schedule/delete": PostRoute(_post_schedule_delete, needs_payload=True),
    "/api/schedule/cancel": PostRoute(_post_schedule_cancel, needs_payload=True),
    "/api/skills/send": PostRoute(_post_skill_send, needs_payload=True),
    "/api/notify/test": PostRoute(_post_notify_test, needs_payload=True),
}


def create_handler(
    app_server: MiniWebServer | None = None,
    *,
    access_token: str = ACCESS_TOKEN,
    web_dir: Path = WEB_DIR,
):
    configured_app = app_server or MiniWebServer()
    configured_access_token = access_token
    configured_web_dir = web_dir

    class ConfiguredMiniWebHandler(MiniWebHandler):
        app_server = configured_app
        access_token = configured_access_token
        web_dir = configured_web_dir

    return ConfiguredMiniWebHandler


def create_http_server(host: str, port: int, app_server: MiniWebServer | None = None) -> ThreadingHTTPServer:
    return ThreadingHTTPServer((host, port), create_handler(app_server))


def main() -> None:
    parser = argparse.ArgumentParser(description="Xiuxian Mini Web development server")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", default=8787, type=int)
    args = parser.parse_args()

    server = create_http_server(args.host, args.port)
    print(f"Xiuxian Mini Web listening on http://{args.host}:{args.port}")
    server.serve_forever()


if __name__ == "__main__":
    main()
