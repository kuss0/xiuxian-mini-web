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


DUNGEON_SUMMARIES = [
    {
        "key": "虚天殿:777",
        "latest_seq": 1002,
        "dungeon_id": "777",
        "dungeon_name": "虚天殿",
        "status": "需要抉择",
        "status_kind": "choice",
        "latest_stage": "二阶段",
        "opened_by": "MayaLing",
        "capacity": "3/5",
        "oracle": "兑泽上离火下 · 四爻转阵",
        "advice": "冰路 / 稳策",
        "route_verdict": "顺合",
        "advice_basis": "明示优先,顺例辅助,反例只用于避坑。",
        "advice_confidence": "实测顺合",
        "team_fit": "顺卦",
        "route": "冰",
        "strategy": "稳",
        "context_source": "cache",
        "message_count": 1,
        "join_success": [],
        "failures": [],
        "actions": [
            {"command": ".选择道路 冰", "label": "冰路", "source_seq": 1002},
            {"command": ".阵策 稳", "label": "稳策", "source_seq": 1002},
        ],
        "messages": [
            {
                "seq": 1002,
                "id": "tg:-1:1002",
                "title": "虚天殿二阶段",
                "summary": "卦象顺合,建议冰路 / 稳策。",
                "time": "2026-05-23T12:01:00+08:00",
                "chat_id": -1,
                "msg_id": 1002,
            }
        ],
    },
    {
        "key": "苍坤上人洞府:16",
        "latest_seq": 1003,
        "dungeon_id": "16",
        "dungeon_name": "苍坤上人洞府",
        "status": "需要抉择",
        "status_kind": "choice",
        "latest_stage": "第五幕",
        "opened_by": "MayaLing",
        "capacity": "5/5",
        "context_source": "cache",
        "message_count": 1,
        "join_success": [],
        "failures": [],
        "cangkun_state": {
            "禁制裂隙": "106",
            "神魂稳度": "104",
            "慕兰警戒": "49",
            "贪念": "18",
            "卷轴线索": "3",
        },
        "cangkun_advice": {
            "stage": "第五幕",
            "command": ".苍坤抉择 2",
            "choice": "2",
            "label": "夺图先遁",
            "stance": "default",
            "reason": "历史成功路线均以五幕 2 收束,113/五幕 3 不作为常规打法。",
            "avoid": ".苍坤抉择 3",
            "state_rows": [["禁制裂隙", "106"], ["卷轴线索", "3"]],
        },
        "actions": [
            {"command": ".苍坤抉择 2", "label": "夺图先遁", "source_seq": 1003},
            {"command": ".苍坤抉择 3", "label": "暗藏后手", "source_seq": 1003},
        ],
        "messages": [
            {
                "seq": 1003,
                "id": "tg:-1:1003",
                "title": "苍坤上人洞府·第五幕",
                "summary": "禁制裂隙106 / 卷轴线索3,默认夺图先遁。",
                "time": "2026-05-23T12:02:00+08:00",
                "chat_id": -1,
                "msg_id": 1003,
            }
        ],
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
        return {
            "ok": True,
            "summaries": DUNGEON_SUMMARIES,
            "notes": [],
            "raw_count": len(DUNGEON_SUMMARIES),
            "total_summaries": len(DUNGEON_SUMMARIES),
            "context_mode": "cache",
        }
    if path == "/api/cangkun-guide":
        return {
            "ok": True,
            "default_route": "1 -> 1 -> 2",
            "default_commands": [".苍坤抉择 1", ".苍坤抉择 1", ".苍坤抉择 2"],
        }
    if path == "/api/xutian-oracle-guide":
        return {"ok": True, "counts": {"explicit": 2, "success": 4, "failure": 2}}
    if path == "/api/resource-stats":
        return {"ok": True, "period": "day", "sources": [], "summary": {}, "rows": []}
    if path == "/api/health":
        return {"ok": True, "listener": {"collector": "", "running": {}}, "counts": {}}
    if path == "/api/skills":
        return {
            "ok": True,
            "groups": ["日常", "玩法", "查询", "法宝", "副本"],
            "realm_order": ["炼气", "筑基", "结丹", "元婴"],
            "skills": [
                {"key": "deep_retreat", "label": "深度闭关", "group": "日常", "command": ".深度闭关", "icon": "闭"},
                {"key": "field_training", "label": "野外历练", "group": "日常", "command": ".野外历练", "icon": "历"},
                {"key": "daily_checkin", "label": "点卯", "group": "日常", "command": ".点卯", "icon": "卯"},
                {"key": "tower", "label": "闯塔", "group": "玩法", "command": ".闯塔", "icon": "塔"},
                {"key": "nascent_soul", "label": "元婴", "group": "玩法", "command": ".元婴", "icon": "婴"},
                {"key": "second_soul", "label": "第二元神", "group": "玩法", "command": ".第二元神", "icon": "神"},
                {"key": "pet_touch", "label": "抚摸", "group": "玩法", "command": ".抚摸", "icon": "抚"},
                {"key": "warm_nurture", "label": "温养", "group": "法宝", "command": ".温养", "icon": "养"},
                {"key": "profile", "label": "我的", "group": "查询", "command": ".我的", "icon": "我"},
                {"key": "power", "label": "战力", "group": "查询", "command": ".战力", "icon": "战"},
                {"key": "storage_bag", "label": "储物袋", "group": "查询", "command": ".储物袋", "icon": "包"},
                {"key": "dungeon_status", "label": "副本状态", "group": "副本", "command": ".副本状态", "icon": "副"},
                {"key": "sect_list", "label": "宗门列表", "group": "查询", "command": ".宗门列表", "icon": "宗"},
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
  function hitDetail(selector) {
    var node = document.querySelector(selector);
    if (!node) return JSON.stringify({ missing: true, selector: selector });
    var box = node.getBoundingClientRect();
    var x = Math.max(0, Math.min(window.innerWidth - 1, box.left + box.width / 2));
    var y = Math.max(0, Math.min(window.innerHeight - 1, box.top + box.height / 2));
    var hit = document.elementFromPoint(x, y);
    return JSON.stringify({
      target: selector,
      point: [x, y],
      hitTag: hit && hit.tagName,
      hitId: hit && hit.id,
      hitClass: hit && hit.className,
      hitText: hit && String(hit.textContent || "").trim().slice(0, 80),
      targetRect: box
    });
  }
  await wait(1600);
  var shell = document.querySelector(".workspace-tools-shell");
  if (shell) shell.open = true;
  await wait(120);
  var boxes = {
    shell: rect(".chat-client-shell"),
    rail: rect(".conversation-rail"),
    schedulePanel: rect(".schedule-rail-panel"),
    scheduleRefresh: rect("#scheduleRailRefreshButton"),
    scheduleNew: rect("#scheduleButton"),
    commonPanel: rect(".common-action-panel"),
    logsButton: rect("#logsButton"),
    dungeonStatusButton: rect("#dungeonStatusButton"),
    resourceStatsButton: rect("#resourceStatsButton"),
    inventoryButton: rect("#inventoryButton"),
    outboxButton: rect("#outboxButton"),
    workspace: rect(".chat-workspace"),
    header: rect(".chat-pane .section-head"),
    toolsToggle: rect(".workspace-tools-toggle"),
    toolsPanel: rect(".workspace-tools-panel"),
    messageList: rect("#messageList"),
    composer: rect("#directSendComposer"),
    composerHead: rect("#directSendComposer .direct-send-head"),
    input: rect("#directSendInput"),
    hotbar: rect("#quickActionHotbar"),
    emojiButton: rect("#emojiPickerButton"),
    cultivationButton: rect("#openCultivationButton"),
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
  check("schedule panel visible", visible(boxes.schedulePanel, 160, 42), JSON.stringify(boxes.schedulePanel));
  check("schedule panel stays inside rail",
    boxes.schedulePanel.left >= boxes.rail.left - 1 && boxes.schedulePanel.right <= boxes.rail.right + 1,
    JSON.stringify({ schedulePanel: boxes.schedulePanel, rail: boxes.rail }));
  if (window.innerWidth > 900) {
    check("desktop rail touches workspace",
      Math.abs(boxes.workspace.left - boxes.rail.right) <= 1,
      JSON.stringify({ rail: boxes.rail, workspace: boxes.workspace }));
  }
  check("schedule refresh clickable", visible(boxes.scheduleRefresh, 34, 24) && centerHit("#scheduleRailRefreshButton"),
    hitDetail("#scheduleRailRefreshButton"));
  check("schedule new clickable", visible(boxes.scheduleNew, 34, 24) && centerHit("#scheduleButton"),
    hitDetail("#scheduleButton"));
  check("common panel visible", visible(boxes.commonPanel, 160, 48), JSON.stringify(boxes.commonPanel));
  check("logs button clickable", visible(boxes.logsButton, 34, 24) && centerHit("#logsButton"),
    hitDetail("#logsButton"));
  ["dungeonStatusButton", "resourceStatsButton", "inventoryButton", "outboxButton"].forEach(function(key) {
    var selector = "#" + key;
    check("common action " + key + " clickable", visible(boxes[key], 46, 24) && centerHit(selector),
      hitDetail(selector));
  });
  check("message list visible", visible(boxes.messageList, 180, 120), JSON.stringify(boxes.messageList));
  check("composer visible", visible(boxes.composer, 180, 80), JSON.stringify(boxes.composer));
  check("composer within viewport", boxes.composer.bottom <= window.innerHeight + 1 && boxes.composer.top >= -1,
    JSON.stringify(boxes.composer));
  check("composer stays compact", boxes.composer.height <= 170,
    JSON.stringify(boxes.composer));
  check("composer tool row stays compact", visible(boxes.composerHead, 160, 20) && boxes.composerHead.height <= 32,
    JSON.stringify(boxes.composerHead));
  check("input visible", visible(boxes.input, 80, 38), JSON.stringify(boxes.input));
  check("tool center toggle visible", visible(boxes.toolsToggle, 90, 28), JSON.stringify(boxes.toolsToggle));
  check("tool center opens", visible(boxes.toolsPanel, 160, 120), JSON.stringify(boxes.toolsPanel));
  check("health button clickable when tools open", visible(boxes.health, 40, 28) && centerHit("#healthButton"),
    JSON.stringify(boxes.health));
  check("hotbar does not cover composer", boxes.hotbar.bottom <= boxes.composer.bottom + 1,
    JSON.stringify({ hotbar: boxes.hotbar, composer: boxes.composer }));
  var hotbarChips = Array.from(document.querySelectorAll("#quickActionHotbar .skill-chip"));
  var hotbarRowTops = Array.from(new Set(hotbarChips.map(function(chip) {
    return Math.round(chip.getBoundingClientRect().top);
  }))).sort(function(a, b) { return a - b; });
  var hotbarOversized = hotbarChips.filter(function(chip) {
    var box = chip.getBoundingClientRect();
    return box.height > 21;
  }).map(function(chip) {
    var box = chip.getBoundingClientRect();
    return { text: chip.textContent.trim(), width: box.width, height: box.height };
  });
  var firstHotbarChip = hotbarChips[0] && hotbarChips[0].getBoundingClientRect();
  var firstRowChips = hotbarChips.filter(function(chip) {
    return Math.round(chip.getBoundingClientRect().top) === hotbarRowTops[0];
  });
  var lastFirstRowHotbarChip = firstRowChips[firstRowChips.length - 1] && firstRowChips[firstRowChips.length - 1].getBoundingClientRect();
  var hotbarMore = document.querySelector("#quickActionHotbar [data-hotbar-more]");
  var hotbarClipped = hotbarChips.filter(function(chip) {
    var box = chip.getBoundingClientRect();
    return box.left < boxes.hotbar.left - 1 || box.right > boxes.hotbar.right + 1 ||
      box.top < boxes.hotbar.top - 1 || box.bottom > boxes.hotbar.bottom + 1;
  }).map(function(chip) {
    var box = chip.getBoundingClientRect();
    return { text: chip.textContent.trim(), left: box.left, right: box.right, top: box.top, bottom: box.bottom };
  });
  var hotbarTexts = hotbarChips.map(function(chip) { return chip.textContent.trim(); });
  check("hotbar renders compact shortcuts", hotbarChips.length === 12, String(hotbarChips.length));
  check("hotbar keeps common query shortcuts visible",
    hotbarTexts.some(function(text) { return text.indexOf("储物袋") !== -1; }) &&
    hotbarTexts.some(function(text) { return text.indexOf("战力") !== -1; }) &&
    hotbarTexts.some(function(text) { return text.indexOf("我的") !== -1; }),
    JSON.stringify(hotbarTexts));
  check("hotbar exposes full shortcut menu", Boolean(hotbarMore), hotbarMore ? hotbarMore.textContent.trim() : "");
  check("hotbar uses two compact rows", hotbarRowTops.length === 2 && boxes.hotbar.height <= 40,
    JSON.stringify({ rows: hotbarRowTops, hotbar: boxes.hotbar }));
  check("hotbar uses available width", firstHotbarChip && lastFirstRowHotbarChip &&
      firstHotbarChip.left <= boxes.hotbar.left + 1 && lastFirstRowHotbarChip.right >= boxes.hotbar.right - 2,
    JSON.stringify({ hotbar: boxes.hotbar, first: firstHotbarChip, lastFirstRow: lastFirstRowHotbarChip }));
  check("hotbar chips stay compact", hotbarOversized.length === 0, JSON.stringify(hotbarOversized));
  check("hotbar shows all chips without clipping", hotbarClipped.length === 0,
    JSON.stringify({ clipped: hotbarClipped, hotbar: boxes.hotbar }));
  if (shell) shell.open = false;
  await wait(120);
  boxes.emojiButton = rect("#emojiPickerButton");
  boxes.cultivationButton = rect("#openCultivationButton");
  check("emoji button clickable", visible(boxes.emojiButton, 36, 24) && centerHit("#emojiPickerButton"),
    JSON.stringify(boxes.emojiButton));
  check("cultivation button clickable", visible(boxes.cultivationButton, 54, 24) && centerHit("#openCultivationButton"),
    JSON.stringify(boxes.cultivationButton));
  boxes.dungeonTrigger = rect("#dungeonStatusButton");
  check("dungeon status trigger visible", visible(boxes.dungeonTrigger, 60, 28), JSON.stringify(boxes.dungeonTrigger));
  check("dungeon status trigger clickable", centerHit("#dungeonStatusButton"), hitDetail("#dungeonStatusButton"));
  var dungeonButton = document.querySelector("#dungeonStatusButton");
  if (dungeonButton) dungeonButton.click();
  await wait(800);
  boxes.dungeonModal = rect(".dungeon-status-modal");
  boxes.dungeonModalBody = rect(".dungeon-status-modal .modal-body");
  boxes.dungeonPlaybooks = rect("#dungeonPlaybookPanels");
  boxes.xutianPlaybook = rect('[data-dungeon-playbook="xutian"]');
  boxes.cangkunPlaybook = rect('[data-dungeon-playbook="cangkun"]');
  boxes.playbookCommand = rect("[data-playbook-command]");
  boxes.playbookGuide = rect("[data-playbook-guide]");
  var playbookOverflow = document.querySelector("#dungeonPlaybookPanels") ?
    document.querySelector("#dungeonPlaybookPanels").scrollWidth - document.querySelector("#dungeonPlaybookPanels").clientWidth : 0;
  check("dungeon modal visible", visible(boxes.dungeonModal, Math.min(300, window.innerWidth - 40), 260), JSON.stringify(boxes.dungeonModal));
  check("dungeon modal within viewport", boxes.dungeonModal.left >= -1 && boxes.dungeonModal.right <= window.innerWidth + 1,
    JSON.stringify(boxes.dungeonModal));
  check("dungeon playbook panels visible", visible(boxes.dungeonPlaybooks, 240, 120), JSON.stringify(boxes.dungeonPlaybooks));
  check("xutian playbook visible", visible(boxes.xutianPlaybook, 120, 90), JSON.stringify(boxes.xutianPlaybook));
  check("cangkun playbook visible", visible(boxes.cangkunPlaybook, 120, 90), JSON.stringify(boxes.cangkunPlaybook));
  check("dungeon playbooks do not overflow", playbookOverflow <= 1, String(playbookOverflow));
  check("playbook command button clickable", visible(boxes.playbookCommand, 48, 26) && centerHit("[data-playbook-command]"),
    hitDetail("[data-playbook-command]"));
  check("playbook guide button exists", visible(boxes.playbookGuide, 48, 26), JSON.stringify(boxes.playbookGuide));
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
