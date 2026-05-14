from __future__ import annotations

import argparse
import json
import mimetypes
from dataclasses import asdict, dataclass
from datetime import datetime, timezone
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse


ROOT_DIR = Path(__file__).resolve().parents[1]
WEB_DIR = ROOT_DIR / "web"


@dataclass(frozen=True)
class Channel:
    key: str
    label: str
    description: str


CHANNELS = [
    Channel("mine", "我的修仙", "当前角色相关消息"),
    Channel("hall", "游戏大厅", "世界聊天、系统公告、公共事件"),
    Channel("events", "事件中心", "副本、交易、风险、CD、可响应事件"),
    Channel("console", "操作台", "人工确认发送与官方定时"),
]


SAMPLE_MESSAGES = [
    {
        "id": "sample-1",
        "channel": "mine",
        "title": "第二元神归位",
        "summary": "第二元神已结束修炼，可以考虑抉择后继续修炼。",
        "source": "韩天尊",
        "time": "待接入 Telegram",
        "tags": ["修炼", "第二元神"],
        "raw": "【第二元神归位】\n道友 @example 的第二元神已结束修炼，回归窍中温养。",
        "actions": [
            {
                "type": "copy",
                "label": "复制抉择",
                "command": ".抉择 稳固道心",
            },
            {
                "type": "copy",
                "label": "复制修炼",
                "command": ".元神修炼",
            },
        ],
    },
    {
        "id": "sample-2",
        "channel": "events",
        "title": "虚天殿开启",
        "summary": "发现副本公告，可人工确认加入。",
        "source": "韩天尊",
        "time": "待接入 Telegram",
        "tags": ["副本", "可加入"],
        "raw": "【虚天殿已开启】\n副本ID: 394\n其他道友可使用 .加入副本 394 加入队伍！",
        "actions": [
            {
                "type": "copy",
                "label": "复制加入副本",
                "command": ".加入副本 394",
            }
        ],
    },
]


def utc_now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


class MiniWebHandler(BaseHTTPRequestHandler):
    server_version = "XiuxianMiniWeb/0.1"

    def do_GET(self) -> None:
        self._handle_request(include_body=True)

    def do_HEAD(self) -> None:
        self._handle_request(include_body=False)

    def _handle_request(self, include_body: bool) -> None:
        parsed = urlparse(self.path)
        path = parsed.path
        query = parse_qs(parsed.query)

        if path == "/api/health":
            self._send_json({"ok": True, "service": "xiuxian-mini-web", "time": utc_now_iso()}, include_body=include_body)
            return

        if path == "/api/channels":
            self._send_json({"channels": [asdict(channel) for channel in CHANNELS]}, include_body=include_body)
            return

        if path == "/api/messages":
            channel = (query.get("channel") or ["all"])[0]
            messages = SAMPLE_MESSAGES
            if channel != "all":
                messages = [message for message in messages if message["channel"] == channel]
            self._send_json({"messages": messages, "source": "sample"}, include_body=include_body)
            return

        if path == "/api/outbox":
            self._send_json(
                {
                    "items": [],
                    "note": "发送出口未接入。基座阶段只展示人工确认与官方定时边界。",
                },
                include_body=include_body,
            )
            return

        self._serve_static(path, include_body=include_body)

    def log_message(self, fmt: str, *args: object) -> None:
        print(f"[mini-web] {self.address_string()} - {fmt % args}")

    def _serve_static(self, path: str, *, include_body: bool) -> None:
        if path == "/":
            path = "/index.html"

        target = (WEB_DIR / path.lstrip("/")).resolve()
        if not str(target).startswith(str(WEB_DIR.resolve())):
            self._send_error(HTTPStatus.FORBIDDEN, "Forbidden", include_body=include_body)
            return

        if not target.exists() or not target.is_file():
            self._send_error(HTTPStatus.NOT_FOUND, "Not found", include_body=include_body)
            return

        content_type = mimetypes.guess_type(target.name)[0] or "application/octet-stream"
        body = target.read_bytes()
        self.send_response(HTTPStatus.OK)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
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


def main() -> None:
    parser = argparse.ArgumentParser(description="Xiuxian Mini Web development server")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", default=8787, type=int)
    args = parser.parse_args()

    server = ThreadingHTTPServer((args.host, args.port), MiniWebHandler)
    print(f"Xiuxian Mini Web listening on http://{args.host}:{args.port}")
    server.serve_forever()


if __name__ == "__main__":
    main()
