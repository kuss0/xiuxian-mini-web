from __future__ import annotations

import argparse
import hmac
import json
import mimetypes
import os
import re
import sys
import time
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse

if __package__ in (None, ""):
    sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from backend.config import ACCESS_TOKEN, WEB_DIR
from backend.api import handlers
from backend.api.routes import RawResponse, build_get_routes, build_post_routes
from backend.server import MiniWebServer


BUILD_ID = os.environ.get("MINIWEB_BUILD_ID") or str(int(time.time()))
STATIC_REF_RE = re.compile(r'(?P<attr>\b(?:href|src))="/static/(?P<asset>[^"?#]+)"')


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
    return STATIC_REF_RE.sub(
        lambda match: f'{match.group("attr")}="/static/{match.group("asset")}{suffix}"',
        text,
    ).encode("utf-8")


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
        if parsed.path.startswith("/api/"):
            if not self._is_authorized_api_request():
                self._send_error(HTTPStatus.UNAUTHORIZED, "需要访问口令")
                return
            content_type = str(self.headers.get("Content-Type") or "").split(";")[0].strip().lower()
            if content_type != "application/json":
                self._send_error(HTTPStatus.UNSUPPORTED_MEDIA_TYPE, "POST 请求必须使用 application/json")
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
        if os.environ.get("MINIWEB_ACCESS_LOG", "").lower() in {"1", "true", "yes"}:
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
            try:
                self.wfile.write(body)
            except (BrokenPipeError, ConnectionResetError):
                return

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
            try:
                self.wfile.write(body)
            except (BrokenPipeError, ConnectionResetError):
                return

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
            try:
                self.wfile.write(body)
            except (BrokenPipeError, ConnectionResetError):
                return

API_HANDLERS = {
    name: value
    for name, value in handlers.__dict__.items()
    if name.startswith("_get_") or name.startswith("_post_")
}

GET_ROUTES = build_get_routes(API_HANDLERS)
POST_ROUTES = build_post_routes(API_HANDLERS)


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
