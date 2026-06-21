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


SCHEDULE_BATCHES = [
    {
        "id": 1,
        "send_as_id": 12345,
        "preset_key": "checkin",
        "label": "宗门点卯",
        "status": "completed",
        "anchor_at": 1781748000,
        "anchor_text": "06-18 10:00",
        "created_at": 1781740000,
        "updated_at": 1781740100,
        "counts": {"scheduled": 3, "planned": 0, "failed": 0},
        "items": [
            {"command": ".宗门点卯", "schedule_at": 1781748000, "schedule_text": "06-18 10:00", "status": "scheduled", "scheduled_msg_id": 1001},
            {"command": ".宗门点卯", "schedule_at": 1781834400, "schedule_text": "06-19 10:00", "status": "scheduled", "scheduled_msg_id": 1002},
            {"command": ".宗门点卯", "schedule_at": 1781920800, "schedule_text": "06-20 10:00", "status": "scheduled", "scheduled_msg_id": 1003},
        ],
        "options": {"renew_profile_id": 11, "state_contract": {"module_key": "checkin"}},
    },
    {
        "id": 2,
        "send_as_id": 12345,
        "preset_key": "tower",
        "label": "闯塔",
        "status": "completed",
        "anchor_at": 1781748300,
        "anchor_text": "06-18 10:05",
        "created_at": 1781740010,
        "updated_at": 1781740110,
        "counts": {"scheduled": 3, "planned": 0, "failed": 0},
        "items": [
            {"command": ".闯塔", "schedule_at": 1781748300, "schedule_text": "06-18 10:05", "status": "scheduled", "scheduled_msg_id": 1011},
            {"command": ".闯塔", "schedule_at": 1781834700, "schedule_text": "06-19 10:05", "status": "scheduled", "scheduled_msg_id": 1012},
            {"command": ".闯塔", "schedule_at": 1781921100, "schedule_text": "06-20 10:05", "status": "scheduled", "scheduled_msg_id": 1013},
        ],
        "options": {"renew_profile_id": 12, "state_contract": {"module_key": "tower"}},
    },
    {
        "id": 3,
        "send_as_id": 12345,
        "preset_key": "lingxiao_elder",
        "label": "凌霄宫·长老包",
        "status": "completed",
        "anchor_at": 1781749200,
        "anchor_text": "06-18 10:20",
        "created_at": 1781740020,
        "updated_at": 1781740120,
        "counts": {"scheduled": 8, "planned": 0, "failed": 0},
        "hidden_item_count": 4,
        "items": [
            {"command": ".借天门势", "schedule_at": 1781749200, "schedule_text": "06-18 10:20", "status": "scheduled", "scheduled_msg_id": 1021},
            {"command": ".引九天罡风", "schedule_at": 1781749380, "schedule_text": "06-18 10:23", "status": "scheduled", "scheduled_msg_id": 1022},
            {"command": ".登天阶", "schedule_at": 1781749560, "schedule_text": "06-18 10:26", "status": "scheduled", "scheduled_msg_id": 1023},
            {"command": ".登天阶", "schedule_at": 1781760360, "schedule_text": "06-18 13:26", "status": "scheduled", "scheduled_msg_id": 1024},
        ],
        "options": {"renew_profile_id": 13, "state_contract": {"module_key": "tianti_climb"}},
    },
    {
        "id": 4,
        "send_as_id": 12345,
        "preset_key": "wendao",
        "label": "问道",
        "status": "completed",
        "anchor_at": 1781749500,
        "anchor_text": "06-18 10:25",
        "created_at": 1781740030,
        "updated_at": 1781740130,
        "counts": {"scheduled": 2, "planned": 0, "failed": 0},
        "items": [
            {"command": ".问道", "schedule_at": 1781749500, "schedule_text": "06-18 10:25", "status": "scheduled", "scheduled_msg_id": 1031},
            {"command": ".问道", "schedule_at": 1781792700, "schedule_text": "06-18 22:25", "status": "scheduled", "scheduled_msg_id": 1032},
        ],
        "options": {"renew_profile_id": 14, "state_contract": {"module_key": "wendao"}},
    },
    {
        "id": 5,
        "send_as_id": 12345,
        "preset_key": "concubine_cycle",
        "label": "侍妾图卜",
        "status": "completed",
        "anchor_at": 1781750400,
        "anchor_text": "06-18 10:40",
        "created_at": 1781740040,
        "updated_at": 1781740140,
        "counts": {"scheduled": 4, "planned": 0, "failed": 0},
        "items": [
            {"command": ".入梦寻图", "schedule_at": 1781750400, "schedule_text": "06-18 10:40", "status": "scheduled", "scheduled_msg_id": 1041},
            {"command": ".天机代卜", "schedule_at": 1781750700, "schedule_text": "06-18 10:45", "status": "scheduled", "scheduled_msg_id": 1042},
            {"command": ".入梦寻图", "schedule_at": 1781779200, "schedule_text": "06-18 18:40", "status": "scheduled", "scheduled_msg_id": 1043},
            {"command": ".天机代卜", "schedule_at": 1781779500, "schedule_text": "06-18 18:45", "status": "scheduled", "scheduled_msg_id": 1044},
        ],
        "options": {"renew_profile_id": 15, "state_contract": {"module_key": "concubine_dream"}},
    },
]


SCHEDULE_RENEW_PROFILES = [
    {
        "id": 11,
        "send_as_id": 12345,
        "preset_key": "checkin",
        "module_key": "checkin",
        "label": "宗门点卯",
        "enabled": True,
        "renew_ready": True,
        "covered_until_text": "06-20 10:00",
        "state_contract": {"semiauto_ready": True, "updated_at": 1781740000, "source_message_id": "tg:-1:1001"},
    },
    {
        "id": 12,
        "send_as_id": 12345,
        "preset_key": "tower",
        "module_key": "tower",
        "label": "闯塔",
        "enabled": True,
        "renew_ready": True,
        "covered_until_text": "06-20 10:05",
        "state_contract": {"semiauto_ready": True, "updated_at": 1781740000, "source_message_id": "tg:-1:1011"},
    },
    {
        "id": 13,
        "send_as_id": 12345,
        "preset_key": "lingxiao_elder",
        "module_key": "tianti_climb",
        "label": "凌霄宫·长老",
        "enabled": True,
        "renew_ready": False,
        "covered_until_text": "06-19 19:26",
        "state_contract": {"semiauto_ready": False, "updated_at": 1781740000, "source_message_id": "tg:-1:1021"},
    },
    {
        "id": 15,
        "send_as_id": 12345,
        "preset_key": "concubine_cycle",
        "module_key": "concubine_dream",
        "label": "侍妾图卜",
        "enabled": False,
        "renew_ready": True,
        "covered_until_text": "06-18 18:45",
        "state_contract": {"semiauto_ready": True, "updated_at": 1781740000, "source_message_id": "tg:-1:1041"},
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
        return {"ok": True, "batches": SCHEDULE_BATCHES}
    if path == "/api/schedule/renew":
        return {
            "ok": True,
            "profiles": SCHEDULE_RENEW_PROFILES,
            "allowed_presets": [
                {"preset_key": "checkin", "module_key": "checkin", "interval_sec": 86400},
                {"preset_key": "tower", "module_key": "tower", "interval_sec": 86400},
                {"preset_key": "lingxiao_elder", "module_key": "tianti_climb", "interval_sec": 10800},
                {"preset_key": "concubine_cycle", "module_key": "concubine_dream", "interval_sec": 28800},
                {"preset_key": "wild_training", "module_key": "wild_training", "interval_sec": 7380},
            ],
            "defaults": {"renew_days": 1, "threshold_hours": 24, "soft_limit": 95},
            "worker": {"running": True, "last_run_text": "06-18 09:33", "last_result": {"ok": True}},
        }
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
  var systemMenu = document.querySelector(".sidebar-primary-tools");
  var commonMenu = document.querySelector(".common-action-panel");
  var chatSecondary = document.querySelector(".chat-secondary-shell");
  [shell, systemMenu, commonMenu, chatSecondary].forEach(function(menu) {
    if (menu) menu.open = false;
  });
  await wait(120);
  var boxes = {
    shell: rect(".chat-client-shell"),
    rail: rect(".conversation-rail"),
    schedulePanel: rect(".schedule-rail-panel"),
    scheduleList: rect(".schedule-rail-list"),
    scheduleSummary: rect(".schedule-rail-summary"),
    scheduleFirstRow: rect(".schedule-rail-row-main"),
    scheduleRenewSummary: rect(".schedule-rail-renew-summary"),
    scheduleRenewSwitch: rect(".schedule-renew-switch"),
    scheduleIdentityDock: rect("#scheduleIdentityDock"),
    scheduleRefresh: rect("#scheduleRailRefreshButton"),
    scheduleNew: rect("#scheduleButton"),
    activeIdentityDock: rect("#activeIdentityDock"),
    activeIdentitySelect: rect("#activeIdentityQuickSelect"),
    activeIdentityStatus: rect("#activeIdentityStatusButton"),
    systemMenu: rect(".sidebar-primary-tools"),
    systemMenuToggle: rect(".sidebar-primary-tools > summary"),
    commonPanel: rect(".common-action-panel"),
    commonPanelToggle: rect(".common-action-panel > summary"),
    logsButton: rect("#logsButton"),
    dungeonStatusButton: rect("#dungeonStatusButton"),
    resourceStatsButton: rect("#resourceStatsButton"),
    inventoryButton: rect("#inventoryButton"),
    outboxButton: rect("#outboxButton"),
    chatSecondary: rect(".chat-secondary-shell"),
    chatSecondaryContent: rect(".chat-secondary-content"),
    chatSecondaryToggle: rect(".chat-secondary-toggle"),
    accountMenu: rect(".sidebar-tools-shell"),
    accountMenuToggle: rect(".sidebar-tools-shell > summary"),
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
    health: rect("#healthButton"),
    settings: rect("#settingsButton")
  };
  var checks = [];
  function check(name, ok, detail) {
    checks.push({ name: name, ok: Boolean(ok), detail: detail || "" });
  }
  check("no document horizontal overflow", document.documentElement.scrollWidth <= window.innerWidth + 1,
    document.documentElement.scrollWidth + " <= " + window.innerWidth);
  check("no body horizontal overflow", document.body.scrollWidth <= window.innerWidth + 1,
    document.body.scrollWidth + " <= " + window.innerWidth);
  check("schedule panel visible", visible(boxes.schedulePanel, 220, 160), JSON.stringify(boxes.schedulePanel));
  var scheduleRows = Array.from(document.querySelectorAll(".schedule-rail-row"));
  var scheduleSummaryText = document.querySelector(".schedule-rail-summary") ?
    document.querySelector(".schedule-rail-summary").textContent.trim() : "";
  var scheduleRenewText = document.querySelector(".schedule-rail-renew-summary") ?
    document.querySelector(".schedule-rail-renew-summary").textContent.trim() : "";
  check("schedule populated groups render", scheduleRows.length >= 3,
    JSON.stringify({ rowCount: scheduleRows.length, summary: scheduleSummaryText }));
  check("schedule list visible and scroll-contained",
    visible(boxes.scheduleList, 220, 100) && boxes.scheduleList.bottom <= boxes.schedulePanel.bottom + 1,
    JSON.stringify({ scheduleList: boxes.scheduleList, schedulePanel: boxes.schedulePanel }));
  check("schedule first card clickable", visible(boxes.scheduleFirstRow, 120, 48) && centerHit(".schedule-rail-row-main"),
    hitDetail(".schedule-rail-row-main"));
  check("schedule renewal summary visible", visible(boxes.scheduleRenewSummary, 160, 28) &&
      scheduleRenewText.indexOf("自动中") !== -1 && scheduleRenewText.indexOf("待处理") !== -1,
    JSON.stringify({ scheduleRenewSummary: boxes.scheduleRenewSummary, text: scheduleRenewText }));
  check("schedule renewal switch clickable", visible(boxes.scheduleRenewSwitch, 42, 20) && centerHit(".schedule-renew-switch"),
    hitDetail(".schedule-renew-switch"));
  check("schedule identity dock compact", visible(boxes.scheduleIdentityDock, 120, 24) && boxes.scheduleIdentityDock.height <= 42,
    JSON.stringify(boxes.scheduleIdentityDock));
  check("schedule panel stays inside workspace",
    boxes.schedulePanel.left >= boxes.workspace.left - 1 && boxes.schedulePanel.right <= boxes.workspace.right + 1,
    JSON.stringify({ schedulePanel: boxes.schedulePanel, workspace: boxes.workspace }));
  check("schedule panel is primary surface",
    boxes.schedulePanel.height >= Math.min(260, boxes.workspace.height * 0.60),
    JSON.stringify({ schedulePanel: boxes.schedulePanel, workspace: boxes.workspace }));
  if (window.innerWidth > 900) {
    check("desktop rail touches workspace",
      Math.abs(boxes.workspace.left - boxes.rail.right) <= 1,
      JSON.stringify({ rail: boxes.rail, workspace: boxes.workspace }));
  }
  check("schedule refresh clickable", visible(boxes.scheduleRefresh, 34, 24) && centerHit("#scheduleRailRefreshButton"),
    hitDetail("#scheduleRailRefreshButton"));
  check("schedule new clickable", visible(boxes.scheduleNew, 34, 24) && centerHit("#scheduleButton"),
    hitDetail("#scheduleButton"));
  var scheduleButton = document.querySelector("#scheduleButton");
  if (scheduleButton) scheduleButton.click();
  await wait(1000);
  boxes.scheduleModal = rect(".schedule-modal-dialog");
  boxes.scheduleModalBody = rect(".schedule-modal-dialog .modal-body");
  boxes.scheduleModalMain = rect(".schedule-modal-main");
  boxes.scheduleModalRecords = rect(".schedule-modal-records");
  boxes.scheduleCreateSection = rect(".schedule-create-section");
  boxes.scheduleIdentityPicker = rect("#scheduleIdentityPicker");
  boxes.schedulePlanWorkbench = rect("#schedulePlanWorkbench");
  boxes.schedulePrimaryActions = rect(".schedule-create-section .schedule-form-actions-top");
  var scheduleModal = document.querySelector(".schedule-modal-dialog");
  var scheduleModalBody = document.querySelector(".schedule-modal-dialog .modal-body");
  var scheduleMain = document.querySelector(".schedule-modal-main");
  var scheduleRecords = document.querySelector(".schedule-modal-records");
  var scheduleCreate = document.querySelector(".schedule-create-section");
  var modalOverflow = scheduleModal ? scheduleModal.scrollWidth - scheduleModal.clientWidth : 0;
  var modalBodyOverflow = scheduleModalBody ? scheduleModalBody.scrollWidth - scheduleModalBody.clientWidth : 0;
  check("schedule modal opens inside viewport",
    visible(boxes.scheduleModal, Math.min(320, window.innerWidth - 20), 260) &&
      boxes.scheduleModal.left >= -1 && boxes.scheduleModal.right <= window.innerWidth + 1,
    JSON.stringify({ scheduleModal: boxes.scheduleModal, viewport: { width: window.innerWidth, height: window.innerHeight } }));
  check("schedule modal has no horizontal overflow",
    modalOverflow <= 1 && modalBodyOverflow <= 1,
    JSON.stringify({ modalOverflow: modalOverflow, modalBodyOverflow: modalBodyOverflow }));
  check("schedule modal primary workbench visible",
    visible(boxes.scheduleCreateSection, 240, 180) &&
      visible(boxes.scheduleIdentityPicker, 220, 70) &&
      visible(boxes.schedulePlanWorkbench, 220, 100),
    JSON.stringify({ create: boxes.scheduleCreateSection, identity: boxes.scheduleIdentityPicker, workbench: boxes.schedulePlanWorkbench }));
  check("schedule modal actions reachable",
    visible(boxes.schedulePrimaryActions, 160, 30) &&
      boxes.schedulePrimaryActions.top >= boxes.scheduleModal.top - 1 &&
      boxes.schedulePrimaryActions.left >= boxes.scheduleModal.left - 1 &&
      boxes.schedulePrimaryActions.right <= boxes.scheduleModal.right + 1,
    JSON.stringify({ actions: boxes.schedulePrimaryActions, modal: boxes.scheduleModal }));
  check("schedule modal keeps records after main content on narrow screens",
    window.innerWidth > 980 || (scheduleMain && scheduleRecords && scheduleCreate && scheduleMain.offsetTop <= scheduleRecords.offsetTop && scheduleCreate.offsetTop <= scheduleRecords.offsetTop),
    JSON.stringify({ main: boxes.scheduleModalMain, records: boxes.scheduleModalRecords, create: boxes.scheduleCreateSection }));
  var scheduleClose = document.querySelector(".schedule-modal-dialog [data-modal-close], .schedule-modal-dialog .modal-close");
  if (scheduleClose) scheduleClose.click();
  await wait(160);
  check("active identity dock visible", visible(boxes.activeIdentityDock, 160, 42),
    JSON.stringify(boxes.activeIdentityDock));
  check("active identity select clickable", visible(boxes.activeIdentitySelect, 80, 28) && centerHit("#activeIdentityQuickSelect"),
    hitDetail("#activeIdentityQuickSelect"));
  check("active identity status button clickable", visible(boxes.activeIdentityStatus, 36, 26) && centerHit("#activeIdentityStatusButton"),
    hitDetail("#activeIdentityStatusButton"));
  check("system menu visible", visible(boxes.systemMenuToggle, 120, 28) && centerHit(".sidebar-primary-tools > summary"),
    hitDetail(".sidebar-primary-tools > summary"));
  check("common menu visible", visible(boxes.commonPanelToggle, 120, 28) && centerHit(".common-action-panel > summary"),
    hitDetail(".common-action-panel > summary"));
  check("account management menu visible", visible(boxes.accountMenuToggle, 120, 28) && centerHit(".sidebar-tools-shell > summary"),
    hitDetail(".sidebar-tools-shell > summary"));
  check("chat secondary menu removed", !chatSecondary && boxes.chatSecondary.missing,
    JSON.stringify(boxes.chatSecondary));
  check("chat message DOM removed",
    !document.querySelector("#messageList") &&
      !document.querySelector("#detailPanel") &&
      !document.querySelector("#directSendComposer") &&
      !document.querySelector("#quickActionHotbar"),
    JSON.stringify({
      messageList: boxes.messageList,
      detailPanel: rect("#detailPanel"),
      composer: boxes.composer,
      hotbar: boxes.hotbar
    }));
  if (systemMenu) systemMenu.open = true;
  await wait(160);
  boxes.settings = rect("#settingsButton");
  boxes.health = rect("#healthButton");
  check("settings button clickable in system menu", visible(boxes.settings, 44, 28) && centerHit("#settingsButton"),
    hitDetail("#settingsButton"));
  check("health button clickable in system menu", visible(boxes.health, 40, 28) && centerHit("#healthButton"),
    hitDetail("#healthButton"));
  if (systemMenu) systemMenu.open = false;
  if (commonMenu) commonMenu.open = true;
  await wait(160);
  boxes.commonPanel = rect(".common-action-panel");
  boxes.logsButton = rect("#logsButton");
  boxes.dungeonStatusButton = rect("#dungeonStatusButton");
  boxes.resourceStatsButton = rect("#resourceStatsButton");
  boxes.inventoryButton = rect("#inventoryButton");
  boxes.outboxButton = rect("#outboxButton");
  check("common panel visible", visible(boxes.commonPanel, 160, 48), JSON.stringify(boxes.commonPanel));
  check("logs button clickable", visible(boxes.logsButton, 34, 24) && centerHit("#logsButton"),
    hitDetail("#logsButton"));
  ["dungeonStatusButton", "resourceStatsButton", "inventoryButton", "outboxButton"].forEach(function(key) {
    var selector = "#" + key;
    check("common action " + key + " clickable", visible(boxes[key], 46, 24) && centerHit(selector),
      hitDetail(selector));
  });
  if (shell) shell.open = true;
  await wait(120);
  boxes.toolsPanel = rect(".workspace-tools-panel");
  check("account management menu opens", visible(boxes.toolsPanel, 160, 80), JSON.stringify(boxes.toolsPanel));
  if (shell) shell.open = false;
  await wait(120);
  boxes.emojiButton = rect("#emojiPickerButton");
  boxes.cultivationButton = rect("#openCultivationButton");
  check("chat composer auxiliary buttons removed",
    boxes.emojiButton.missing && boxes.cultivationButton.missing,
    JSON.stringify({ emoji: boxes.emojiButton, cultivation: boxes.cultivationButton }));
  if (commonMenu) commonMenu.open = true;
  await wait(120);
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
            "boxes": {
                key: (item.get("boxes") or {}).get(key)
                for key in (
                    "rail",
                    "workspace",
                    "schedulePanel",
                    "commonPanel",
                    "chatSecondary",
                    "chatSecondaryToggle",
                    "accountMenu",
                    "accountMenuToggle",
                    "systemMenu",
                    "systemMenuToggle",
                )
            },
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
