from __future__ import annotations

import argparse
import html
import json
import re
import shutil
import subprocess
import tempfile
import threading
from contextlib import contextmanager
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse


ROOT = Path(__file__).resolve().parents[1]
WEB_DIR = ROOT / "web"
RESULT_RE = re.compile(
    r'<pre id="layout-probe-result" data-ok="[^"]*">(?P<body>.*?)</pre>',
    re.DOTALL,
)


CHANNELS = [
    {"key": "focus", "label": "重点", "description": "重点消息"},
    {"key": "dungeon", "label": "副本", "description": "副本消息"},
    {"key": "resource", "label": "资源", "description": "资源统计"},
    {"key": "archive", "label": "归档", "description": "归档消息"},
]


MESSAGES = [
    {
        "id": "tg:-1:1001",
        "seq": 1001,
        "channel": "focus",
        "channels": ["focus"],
        "title": "普通聊天",
        "summary": "今晚先打虚天殿,然后看苍坤洞府路线。",
        "source": "MayaLing",
        "sender_id": 12345,
        "chat_id": -1,
        "msg_id": 1001,
        "time": "2026-05-23T12:00:00+08:00",
        "tags": ["聊天"],
        "raw": "今晚先打虚天殿,然后看苍坤洞府路线。",
        "actions": [],
        "fields": {},
    },
    {
        "id": "tg:-1:1002",
        "seq": 1002,
        "channel": "dungeon",
        "channels": ["dungeon", "archive"],
        "title": "虚天殿后殿冲关止步",
        "summary": "回合耗尽,后殿追加机缘止步。",
        "source": "韩天尊",
        "sender_id": 7900199668,
        "chat_id": -1,
        "msg_id": 1002,
        "time": "2026-05-23T12:01:00+08:00",
        "tags": ["副本", "虚天殿"],
        "raw": "【后殿冲关止步】\n回合耗尽,鼎灵残焰仍未被真正压灭。",
        "actions": [],
        "fields": {"副本": "虚天殿"},
    },
]


def api_payload(path: str, query: dict[str, list[str]]) -> dict:
    if path == "/api/channels":
        return {"ok": True, "channels": CHANNELS}
    if path == "/api/messages":
        selected = set()
        if query.get("channels"):
            selected.update(item for item in query["channels"][0].split(",") if item)
        if query.get("channel"):
            selected.add(query["channel"][0])
        messages = MESSAGES
        if selected and "all" not in selected:
            messages = [
                item for item in messages
                if selected.intersection(set(item.get("channels") or [item.get("channel")]))
            ]
        return {"ok": True, "messages": messages, "max_seq": 1002, "source": "probe"}
    if path == "/api/settings":
        return {
            "ok": True,
            "settings": {
                "game_bot_ids": [7900199668],
                "own_aliases": ["MayaLing"],
                "target_chat": "-1001680975844",
                "target_topic_id": 0,
                "focus_keywords": ["虚天殿", "苍坤洞府"],
                "focus_include_player_plain": True,
            },
        }
    if path == "/api/accounts":
        return {
            "ok": True,
            "max_accounts": 100,
            "listener": {"collector": "", "running": {}},
            "accounts": [
                {
                    "local_id": "main",
                    "label": "主号",
                    "username": "MayaLing",
                    "account_id": 12345,
                    "login_status": "done",
                    "listener_status": "stopped",
                    "listener_message": "",
                }
            ],
        }
    if path == "/api/identities":
        return {
            "ok": True,
            "max_identities": 100,
            "identities": [
                {
                    "send_as_id": 12345,
                    "account_local_id": "main",
                    "label": "MayaLing",
                    "username": "MayaLing",
                    "enabled": True,
                }
            ],
        }
    if path == "/api/identity-state":
        return {"ok": True, "by_identity": [{"send_as_id": 12345, "items": []}]}
    if path == "/api/state-patches":
        return {
            "ok": True,
            "state": [
                {"key": "角色名", "value": "MayaLing"},
                {"key": "境界", "value": "筑基后期"},
                {"key": "宗门", "value": "青云门"},
            ],
        }
    if path == "/api/schedule":
        return {"ok": True, "batches": []}
    if path == "/api/discovered-bots":
        return {"ok": True, "discovered": [], "marked_count": 0}
    if path == "/api/message-audit":
        return {"ok": True, "status": "ok", "gap_count": 0, "gaps": []}
    if path == "/api/dungeon-status":
        return {"ok": True, "summaries": [], "notes": [], "raw_count": 0, "total_summaries": 0}
    if path == "/api/resource-stats":
        return {"ok": True, "period": "day", "sources": [], "summary": {}, "rows": []}
    if path == "/api/health":
        return {"ok": True, "listener": {"collector": "", "running": {}}, "counts": {}}
    if path == "/api/skills":
        return {
            "ok": True,
            "groups": ["日常", "查询", "副本"],
            "realm_order": ["炼气", "筑基", "结丹", "元婴"],
            "skills": [
                {"key": "storage_bag", "label": "储物袋", "group": "查询", "command": ".储物袋", "icon": "包"},
                {"key": "deep_retreat", "label": "深度闭关", "group": "日常", "command": ".深度闭关", "icon": "闭"},
                {"key": "dungeon_status", "label": "副本状态", "group": "副本", "command": ".副本状态", "icon": "副"},
            ],
        }
    return {"ok": True}


PROBE_PRELUDE = """
<script>
window.__layoutProbeErrors = [];
window.addEventListener("error", function(event) {
  window.__layoutProbeErrors.push(String(event.message || event.error || "error"));
});
window.addEventListener("unhandledrejection", function(event) {
  window.__layoutProbeErrors.push(String((event.reason && event.reason.message) || event.reason || "rejection"));
});
</script>
"""


PROBE_SCRIPT = """
<script>
(async function() {
  function wait(ms) {
    return new Promise(function(resolve) { window.setTimeout(resolve, ms); });
  }
  function rect(selector) {
    var node = document.querySelector(selector);
    if (!node) return { missing: true, selector: selector };
    var box = node.getBoundingClientRect();
    var style = window.getComputedStyle(node);
    return {
      missing: false,
      selector: selector,
      x: box.x,
      y: box.y,
      width: box.width,
      height: box.height,
      top: box.top,
      right: box.right,
      bottom: box.bottom,
      left: box.left,
      display: style.display,
      visibility: style.visibility,
      hidden: node.hidden === true
    };
  }
  function visible(box, minWidth, minHeight) {
    return !box.missing && !box.hidden && box.display !== "none" && box.visibility !== "hidden" &&
      box.width >= minWidth && box.height >= minHeight;
  }
  function centerHit(selector) {
    var node = document.querySelector(selector);
    if (!node) return false;
    var box = node.getBoundingClientRect();
    var x = Math.max(0, Math.min(window.innerWidth - 1, box.left + box.width / 2));
    var y = Math.max(0, Math.min(window.innerHeight - 1, box.top + box.height / 2));
    var hit = document.elementFromPoint(x, y);
    return Boolean(hit && (hit === node || node.contains(hit)));
  }
  await wait(1600);
  var shell = document.querySelector(".workspace-tools-shell");
  if (shell) shell.open = true;
  await wait(120);
  var boxes = {
    shell: rect(".chat-client-shell"),
    rail: rect(".conversation-rail"),
    workspace: rect(".chat-workspace"),
    header: rect(".chat-pane .section-head"),
    toolsToggle: rect(".workspace-tools-toggle"),
    toolsPanel: rect(".workspace-tools-panel"),
    messageList: rect("#messageList"),
    composer: rect("#directSendComposer"),
    input: rect("#directSendInput"),
    hotbar: rect("#quickActionHotbar"),
    health: rect("#healthButton")
  };
  var checks = [];
  function check(name, ok, detail) {
    checks.push({ name: name, ok: Boolean(ok), detail: detail || "" });
  }
  check("no document horizontal overflow", document.documentElement.scrollWidth <= window.innerWidth + 1,
    document.documentElement.scrollWidth + " <= " + window.innerWidth);
  check("no body horizontal overflow", document.body.scrollWidth <= window.innerWidth + 1,
    document.body.scrollWidth + " <= " + window.innerWidth);
  check("message list visible", visible(boxes.messageList, 180, 120), JSON.stringify(boxes.messageList));
  check("composer visible", visible(boxes.composer, 180, 80), JSON.stringify(boxes.composer));
  check("composer within viewport", boxes.composer.bottom <= window.innerHeight + 1 && boxes.composer.top >= -1,
    JSON.stringify(boxes.composer));
  check("input visible", visible(boxes.input, 80, 38), JSON.stringify(boxes.input));
  check("tool center toggle visible", visible(boxes.toolsToggle, 90, 28), JSON.stringify(boxes.toolsToggle));
  check("tool center opens", visible(boxes.toolsPanel, 160, 120), JSON.stringify(boxes.toolsPanel));
  check("health button clickable when tools open", visible(boxes.health, 40, 28) && centerHit("#healthButton"),
    JSON.stringify(boxes.health));
  check("hotbar does not cover composer", boxes.hotbar.bottom <= boxes.composer.bottom + 1,
    JSON.stringify({ hotbar: boxes.hotbar, composer: boxes.composer }));
  var result = {
    ok: checks.every(function(item) { return item.ok; }) && window.__layoutProbeErrors.length === 0,
    viewport: { width: window.innerWidth, height: window.innerHeight },
    scroll: { document: document.documentElement.scrollWidth, body: document.body.scrollWidth },
    boxes: boxes,
    checks: checks,
    errors: window.__layoutProbeErrors
  };
  var pre = document.createElement("pre");
  pre.id = "layout-probe-result";
  pre.dataset.ok = result.ok ? "1" : "0";
  pre.textContent = JSON.stringify(result);
  document.body.appendChild(pre);
})();
</script>
"""


class ProbeHandler(BaseHTTPRequestHandler):
    def do_GET(self) -> None:
        parsed = urlparse(self.path)
        if parsed.path.startswith("/api/"):
            self._send_json(api_payload(parsed.path, parse_qs(parsed.query)))
            return
        self._serve_static(parsed.path)

    def do_POST(self) -> None:
        parsed = urlparse(self.path)
        if parsed.path.startswith("/api/"):
            self._send_json({"ok": True})
            return
        self.send_error(HTTPStatus.NOT_FOUND)

    def log_message(self, _fmt: str, *args: object) -> None:
        return

    def _serve_static(self, path: str) -> None:
        if path in {"", "/"}:
            path = "/index.html"
        target = (WEB_DIR / path.lstrip("/")).resolve()
        try:
            target.relative_to(WEB_DIR.resolve())
        except ValueError:
            self.send_error(HTTPStatus.FORBIDDEN)
            return
        if not target.is_file():
            self.send_error(HTTPStatus.NOT_FOUND)
            return
        body = target.read_bytes()
        if target.name == "index.html":
            text = body.decode("utf-8")
            text = text.replace("<script src=\"/static/state.js\"></script>", PROBE_PRELUDE + "\n    <script src=\"/static/state.js\"></script>", 1)
            text = text.replace("</body>", PROBE_SCRIPT + "\n  </body>", 1)
            body = text.encode("utf-8")
        content_type = "text/html; charset=utf-8" if target.suffix == ".html" else "application/octet-stream"
        if target.suffix == ".js":
            content_type = "text/javascript; charset=utf-8"
        elif target.suffix == ".css":
            content_type = "text/css; charset=utf-8"
        self.send_response(HTTPStatus.OK)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def _send_json(self, payload: dict) -> None:
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(HTTPStatus.OK)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)


@contextmanager
def probe_server():
    server = ThreadingHTTPServer(("127.0.0.1", 0), ProbeHandler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        host, port = server.server_address[:2]
        yield f"http://{host}:{port}/"
    finally:
        server.shutdown()
        server.server_close()
        thread.join(timeout=3)


def chromium_command(chromium_bin: str, url: str, width: int, height: int, user_data_dir: Path) -> list[str]:
    return [
        chromium_bin,
        "--headless",
        "--no-sandbox",
        "--disable-gpu",
        "--disable-dev-shm-usage",
        "--hide-scrollbars",
        f"--user-data-dir={user_data_dir}",
        f"--window-size={width},{height}",
        "--virtual-time-budget=5000",
        "--dump-dom",
        url,
    ]


def run_layout_probe(
    *,
    chromium_bin: str | None = None,
    viewports: list[tuple[int, int]] | None = None,
) -> list[dict]:
    browser = chromium_bin or shutil.which("chromium") or shutil.which("chromium-browser") or shutil.which("google-chrome")
    if not browser:
        raise RuntimeError("chromium executable was not found")
    sizes = viewports or [(1280, 800), (1024, 768), (800, 720), (390, 740)]
    results: list[dict] = []
    with probe_server() as url:
        for width, height in sizes:
            with tempfile.TemporaryDirectory(prefix="miniweb-layout-") as tmp:
                command = chromium_command(browser, url, width, height, Path(tmp))
                completed = subprocess.run(command, text=True, capture_output=True, timeout=20)
            if completed.returncode != 0:
                raise AssertionError(
                    f"chromium failed for {width}x{height}: {completed.stderr.strip()}"
                )
            match = RESULT_RE.search(completed.stdout)
            if not match:
                raise AssertionError(
                    f"layout probe result missing for {width}x{height}. stderr={completed.stderr.strip()}"
                )
            result = json.loads(html.unescape(match.group("body")))
            results.append(result)
    failures = [
        {
            "viewport": item.get("viewport"),
            "failed": [check for check in item.get("checks", []) if not check.get("ok")],
            "errors": item.get("errors") or [],
        }
        for item in results
        if not item.get("ok")
    ]
    if failures:
        raise AssertionError(json.dumps(failures, ensure_ascii=False, indent=2))
    return results


def main() -> None:
    parser = argparse.ArgumentParser(description="Run headless Chromium layout checks for the chat UI.")
    parser.add_argument("--chromium", default="", help="Path to Chromium/Chrome executable.")
    args = parser.parse_args()
    results = run_layout_probe(chromium_bin=args.chromium or None)
    print(json.dumps({"ok": True, "viewports": [item["viewport"] for item in results]}, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
