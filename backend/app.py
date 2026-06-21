from __future__ import annotations

import argparse
import gzip
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

from backend.config import WEB_DIR, RATE_LIMIT_ENABLED, RATE_LIMIT_MAX_REQUESTS, RATE_LIMIT_WINDOW_SEC
from backend.api import handlers
from backend.api.routes import RawResponse, build_get_routes, build_post_routes
from backend.rate_limiter import RateLimiter
from backend.server import MiniWebServer


BUILD_ID = os.environ.get("MINIWEB_BUILD_ID") or str(int(time.time()))
STATIC_REF_RE = re.compile(r'(?P<attr>\b(?:href|src))="/static/(?P<asset>[^"?#]+)"')


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
    protocol_version = "HTTP/1.1"  # 开启 keep-alive: 反代复用连接, 避免首屏几十个静态请求把短连接打满导致 502
    timeout = 30  # 空闲 keep-alive 连接最多占用线程 30s, 防止线程堆积
    app_server: MiniWebServer | None = None
    web_dir = WEB_DIR
    rate_limiter: RateLimiter | None = None

    @classmethod
    def set_rate_limiter(cls, limiter: RateLimiter | None) -> None:
        """设置速率限制器"""
        cls.rate_limiter = limiter

    def do_GET(self) -> None:
        self._handle_request(include_body=True)

    def do_HEAD(self) -> None:
        self._handle_request(include_body=False)

    def do_POST(self) -> None:
        self._handle_post()

    def _handle_request(self, include_body: bool) -> None:
        started = time.monotonic()
        parsed = urlparse(self.path)
        path = parsed.path
        query = parse_qs(parsed.query)

        # API 请求检查速率限制
        if path.startswith("/api/"):
            if not self._check_rate_limit(include_body):
                return

        route = GET_ROUTES.get(path)
        try:
            if route:
                result = route(self, query)
                if isinstance(result, RawResponse):
                    self._send_raw(result, include_body=include_body)
                else:
                    self._send_json(result, include_body=include_body)
                self._log_slow_api("GET", parsed, started)
                return
            self._serve_static(path, include_body=include_body)
        except (BrokenPipeError, ConnectionResetError):
            return
        except Exception as exc:
            self._safe_send_500(exc, include_body=include_body)

    def _handle_post(self) -> None:
        started = time.monotonic()
        parsed = urlparse(self.path)
        if parsed.path.startswith("/api/"):
            if not self._check_rate_limit(True):
                return

            content_type = str(self.headers.get("Content-Type") or "").split(";")[0].strip().lower()
            if content_type != "application/json":
                self._send_error(HTTPStatus.UNSUPPORTED_MEDIA_TYPE, "POST 请求必须使用 application/json")
                return

        try:
            route = POST_ROUTES.get(parsed.path)
            if route is None:
                self._send_error(HTTPStatus.NOT_FOUND, "Not found")
                return
            if route.needs_payload:
                payload = self._read_json_payload()
            else:
                self._discard_body()
                payload = {}
            if payload is not None:
                self._send_json(route(self, payload))
                self._log_slow_api("POST", parsed, started)
        except (BrokenPipeError, ConnectionResetError):
            return
        except Exception as exc:
            self._safe_send_500(exc)

    def _safe_send_500(self, exc: Exception, *, include_body: bool = True) -> None:
        print(f"[mini-web] unhandled error on {self.command} {self.path}: {exc!r}")
        try:
            self._send_error(HTTPStatus.INTERNAL_SERVER_ERROR, "服务器内部错误", include_body=include_body)
        except Exception:
            pass

    def _discard_body(self) -> None:
        """读掉并丢弃请求体。开启 HTTP/1.1 keep-alive 后, 不读完 body 会污染下一请求。"""
        try:
            length = int(self.headers.get("Content-Length") or 0)
        except (TypeError, ValueError):
            length = 0
        if length > 0:
            try:
                self.rfile.read(length)
            except (BrokenPipeError, ConnectionResetError):
                pass

    def _rate_limit_client_id(self) -> str:
        # 反代(cloudflared)后所有连接都来自同一上游 IP, 会把限流塌缩成一个共享桶。
        # 优先用 Cloudflare 注入的真实访客 IP 做 key, 退回直连地址。
        cf_ip = str(self.headers.get("CF-Connecting-IP") or "").strip()
        if cf_ip:
            return cf_ip
        try:
            return self.client_address[0]
        except Exception:
            return "unknown"

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

    def _log_slow_api(self, method: str, parsed, started: float) -> None:
        try:
            threshold = float(os.environ.get("MINIWEB_SLOW_API_LOG_SEC") or 0.5)
        except (TypeError, ValueError):
            threshold = 0.5
        if threshold <= 0:
            return
        elapsed = time.monotonic() - started
        if elapsed < threshold:
            return
        query = f"?{parsed.query}" if getattr(parsed, "query", "") else ""
        print(f"[mini-web] slow api {method} {parsed.path}{query} {elapsed:.3f}s")

    def _check_rate_limit(self, include_body: bool = True) -> bool:
        """检查速率限制

        Args:
            include_body: 是否包含响应体

        Returns:
            True 如果允许请求，False 如果超过限制
        """
        if not self.rate_limiter:
            return True

        client_ip = self._rate_limit_client_id()

        if not self.rate_limiter.is_allowed(client_ip):
            remaining = self.rate_limiter.get_remaining(client_ip)
            reset_time = int(self.rate_limiter.get_reset_time(client_ip))

            # 发送 429 Too Many Requests
            body = json.dumps({
                "ok": False,
                "error": f"速率限制: 每分钟最多 {self.rate_limiter.max_requests} 次请求",
                "retry_after": reset_time
            }, ensure_ascii=False, indent=2).encode("utf-8")

            self.send_response(HTTPStatus.TOO_MANY_REQUESTS)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Content-Length", str(len(body)))
            self.send_header("X-RateLimit-Limit", str(self.rate_limiter.max_requests))
            self.send_header("X-RateLimit-Remaining", str(remaining))
            self.send_header("X-RateLimit-Reset", str(reset_time))
            self.send_header("Retry-After", str(reset_time))
            self.end_headers()

            if include_body:
                try:
                    self.wfile.write(body)
                except (BrokenPipeError, ConnectionResetError):
                    pass

            return False

        # 添加速率限制头到正常响应
        remaining = self.rate_limiter.get_remaining(client_ip)
        # 注意：这里只是记录，实际的头会在 _send_json 中添加
        self._rate_limit_remaining = remaining
        return True

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

        # 启用 gzip 压缩
        should_compress = (
            len(body) > 1024 and  # 只压缩大于 1KB 的文件
            target.suffix in {'.js', '.css', '.html', '.json', '.svg', '.xml'} and
            'gzip' in str(self.headers.get('Accept-Encoding', '')).lower()
        )

        if should_compress:
            body = gzip.compress(body, compresslevel=6)
            self.send_response(HTTPStatus.OK)
            self.send_header("Content-Type", content_type)
            self.send_header("Content-Encoding", "gzip")
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Cache-Control", "no-store, must-revalidate")
        else:
            self.send_response(HTTPStatus.OK)
            self.send_header("Content-Type", content_type)
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Cache-Control", "no-store, must-revalidate")

        # 添加 CSP 头（仅 HTML 文件）
        if target.suffix == ".html":
            csp = (
                "default-src 'self'; "
                "script-src 'self'; "
                "style-src 'self' 'unsafe-inline'; "  # 暂时允许内联样式
                "img-src 'self' data:; "
                "connect-src 'self'; "
                "font-src 'self'; "
                "object-src 'none'; "
                "base-uri 'self'; "
                "form-action 'self'"
            )
            self.send_header("Content-Security-Policy", csp)
            # 添加其他安全头
            self.send_header("X-Content-Type-Options", "nosniff")
            self.send_header("X-Frame-Options", "DENY")
            self.send_header("X-XSS-Protection", "1; mode=block")

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

        # 添加速率限制头
        if self.rate_limiter and hasattr(self, '_rate_limit_remaining'):
            self.send_header("X-RateLimit-Limit", str(self.rate_limiter.max_requests))
            self.send_header("X-RateLimit-Remaining", str(self._rate_limit_remaining))

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
    web_dir: Path = WEB_DIR,
):
    configured_app = app_server or MiniWebServer()
    configured_web_dir = web_dir

    class ConfiguredMiniWebHandler(MiniWebHandler):
        app_server = configured_app
        web_dir = configured_web_dir

    return ConfiguredMiniWebHandler


class MiniWebHTTPServer(ThreadingHTTPServer):
    # socketserver 默认 listen backlog 只有 5; 模块化后首屏要并发拉 ~60 个静态文件,
    # backlog 太小 -> 突发连接被丢 -> 反代收到连接失败 -> 502。调大到 128。
    request_queue_size = 128
    daemon_threads = True
    allow_reuse_address = True


def create_http_server(host: str, port: int, app_server: MiniWebServer | None = None) -> MiniWebHTTPServer:
    return MiniWebHTTPServer((host, port), create_handler(app_server))


def main() -> None:
    parser = argparse.ArgumentParser(description="Xiuxian Mini Web development server")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", default=8787, type=int)
    args = parser.parse_args()

    # 初始化速率限制器
    if RATE_LIMIT_ENABLED:
        rate_limiter = RateLimiter(
            max_requests=RATE_LIMIT_MAX_REQUESTS,
            window_seconds=RATE_LIMIT_WINDOW_SEC
        )
        MiniWebHandler.set_rate_limiter(rate_limiter)
        print(f"[mini-web] 速率限制已启用: {RATE_LIMIT_MAX_REQUESTS} 次/{RATE_LIMIT_WINDOW_SEC}秒")
    else:
        MiniWebHandler.set_rate_limiter(None)
        print("[mini-web] 速率限制已禁用")

    print("[mini-web] API 内置认证已移除, 请通过 Cloudflare/反代或本地绑定控制访问")

    app_server = MiniWebServer()
    renew_worker_enabled = os.environ.get("MINIWEB_SCHEDULE_RENEW_WORKER", "1").strip().lower() not in {"0", "false", "no", "off"}
    if renew_worker_enabled:
        app_server.start_schedule_renew_worker()
        print("[mini-web] 官方定时续期 worker 已启用: 15 分钟扫描一次")
    else:
        print("[mini-web] 官方定时续期 worker 已禁用")

    log_command_listener_enabled = os.environ.get("MINIWEB_LOG_COMMAND_LISTENER", "1").strip().lower() not in {"0", "false", "no", "off"}
    if log_command_listener_enabled:
        app_server.start_log_command_listener()
        print("[mini-web] 日志群命令 listener 已启用")
    else:
        print("[mini-web] 日志群命令 listener 已禁用")

    server = create_http_server(args.host, args.port, app_server)
    print(f"Xiuxian Mini Web listening on http://{args.host}:{args.port}")
    try:
        server.serve_forever()
    finally:
        app_server.stop_log_command_listener()
        app_server.stop_schedule_renew_worker()


if __name__ == "__main__":
    main()
