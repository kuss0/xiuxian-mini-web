from __future__ import annotations

from typing import Any


CANGKUN_STAGE_LABELS = {
    "first": "第一幕",
    "third": "第三幕",
    "fourth": "第四幕",
    "fifth": "第五幕",
}

CANGKUN_DEFAULT_ROUTE = ("1", "1", "2")
CANGKUN_STATE_KEYS = ("禁制裂隙", "神魂稳度", "慕兰警戒", "贪念", "卷轴线索")

CANGKUN_CHOICES = {
    "first": [
        {
            "choice": "1",
            "label": "匿踪潜行",
            "command": ".苍坤抉择 1",
            "stance": "default",
            "advice": "稳定默认。警戒增加较低,并补神魂稳度。",
        },
        {
            "choice": "2",
            "label": "伪装混入",
            "command": ".苍坤抉择 2",
            "stance": "acceptable",
            "advice": "中庸可用,但警戒和贪念会比 1 更高。",
        },
        {
            "choice": "3",
            "label": "强闯速进",
            "command": ".苍坤抉择 3",
            "stance": "risk",
            "advice": "只在禁制裂隙明显不够且队伍接受风险时考虑。",
        },
    ],
    "third": [
        {
            "choice": "1",
            "label": "先取卷轴",
            "command": ".苍坤抉择 1",
            "stance": "default",
            "advice": "偏稳且补卷轴线索,适合当前稳定通关路线。",
        },
        {
            "choice": "2",
            "label": "稳中取利",
            "command": ".苍坤抉择 2",
            "stance": "acceptable",
            "advice": "历史有成功样本,作为 1 的可接受替代。",
        },
        {
            "choice": "3",
            "label": "贪进抢利",
            "command": ".苍坤抉择 3",
            "stance": "risk",
            "advice": "会推高后续风险,不作为默认路线。",
        },
    ],
    "fourth": [
        {
            "choice": "split",
            "label": "三背盟 / 两断后",
            "command": "",
            "stance": "default",
            "advice": "目标是完成三名背盟、两名断后的分工。不要替玩家自动指定人选。",
        }
    ],
    "fifth": [
        {
            "choice": "1",
            "label": "平分速退",
            "command": ".苍坤抉择 1",
            "stance": "safe",
            "advice": "保守撤离。警戒、贪念偏高时可作为降险选择。",
        },
        {
            "choice": "2",
            "label": "夺图先遁",
            "command": ".苍坤抉择 2",
            "stance": "default",
            "advice": "当前稳定默认。历史成功路线均以五幕 2 收束。",
        },
        {
            "choice": "3",
            "label": "暗藏后手",
            "command": ".苍坤抉择 3",
            "stance": "risk",
            "advice": "高风险贪法。已观测到裂隙过百、卷轴线索 3 仍失败,不默认推荐。",
        },
    ],
}

CANGKUN_ROUTES = [
    {
        "route": "1 -> 1 -> 2",
        "kind": "default",
        "kind_label": "默认",
        "summary": "一幕匿踪,三幕先取卷轴,五幕夺图先遁。",
        "advice": "当前主推稳定通关线。",
        "commands": [".苍坤抉择 1", ".苍坤抉择 1", ".苍坤抉择 2"],
    },
    {
        "route": "1 -> 2 -> 2",
        "kind": "success",
        "kind_label": "顺例",
        "summary": "一幕匿踪,三幕走平衡线,五幕夺图先遁。",
        "advice": "历史成功样本,三幕 2 可作为替代。",
        "commands": [".苍坤抉择 1", ".苍坤抉择 2", ".苍坤抉择 2"],
    },
    {
        "route": "1 -> 1 -> 3",
        "kind": "risk",
        "kind_label": "风险",
        "summary": "前两步偏稳,五幕改暗藏后手。",
        "advice": "这就是 113。五幕 3 已有失败样本,不要当常规打法。",
        "commands": [".苍坤抉择 1", ".苍坤抉择 1", ".苍坤抉择 3"],
    },
]

CANGKUN_HISTORY = [
    {
        "time": "2026-05-21 05:37",
        "route": "1 -> 2 -> 2",
        "result": "success",
        "state": "裂隙108 / 稳102 / 警52 / 卷3",
    },
    {
        "time": "2026-05-23",
        "route": "1 -> 1 -> 2",
        "result": "success",
        "state": "裂隙106 / 稳104 / 警49 / 贪18 / 卷3",
    },
    {
        "time": "2026-05-21 11:22",
        "route": "2 -> 3 -> 3",
        "result": "failure",
        "state": "裂隙106 / 稳98 / 警72 / 卷3",
    },
    {
        "time": "2026-05-21 17:41",
        "route": "2 -> 1 -> 3",
        "result": "failure",
        "state": "裂隙110 / 稳96 / 警65 / 卷3",
    },
]

CANGKUN_THRESHOLDS = {
    "禁制裂隙": {"target": 100, "note": "低于 100 时核心破禁门槛不稳。"},
    "神魂稳度": {"danger": 0, "note": "归零会失败,越高越能承受后续波动。"},
    "慕兰警戒": {"watch": 60, "note": "越高越影响后段脱身,不宜主动堆高。"},
    "贪念": {"watch": 20, "note": "收益上限更高,但会提高失败风险。"},
    "卷轴线索": {"target": 3, "note": "决定苍坤路线和昆魔前置信息,但不抵消五幕 3 风险。"},
}


def build_cangkun_guide_payload() -> dict[str, Any]:
    return {
        "ok": True,
        "name": "苍坤上人洞府",
        "default_route": " -> ".join(CANGKUN_DEFAULT_ROUTE),
        "default_commands": [".苍坤抉择 1", ".苍坤抉择 1", ".苍坤抉择 2"],
        "stages": [
            {
                "key": key,
                "label": CANGKUN_STAGE_LABELS[key],
                "choices": list(CANGKUN_CHOICES[key]),
                "recommendation": cangkun_stage_recommendation(CANGKUN_STAGE_LABELS[key]),
            }
            for key in ("first", "third", "fourth", "fifth")
        ],
        "routes": list(CANGKUN_ROUTES),
        "history": list(CANGKUN_HISTORY),
        "thresholds": CANGKUN_THRESHOLDS,
        "boundaries": [
            "本攻略只覆盖苍坤上人洞府入本后的阶段抉择。",
            "苍坤残图、入梦寻图等前置链路不并入副本路线建议。",
            "所有按钮只填入发送框,不会自动发送或替队伍做选择。",
            "五幕 3 属于明确接受失败风险后的贪法,不作为默认路线。",
        ],
    }


def cangkun_stage_recommendation(stage: str, fields: dict[str, Any] | None = None) -> dict[str, Any]:
    key = _stage_key(stage)
    fields = fields or {}
    if key == "first":
        return {
            "stage": CANGKUN_STAGE_LABELS[key],
            "command": ".苍坤抉择 1",
            "choice": "1",
            "label": "匿踪潜行",
            "stance": "default",
            "reason": "默认先保神魂稳度和低警戒。3 只在裂隙明显不足时作为风险补裂隙。",
        }
    if key == "third":
        return {
            "stage": CANGKUN_STAGE_LABELS[key],
            "command": ".苍坤抉择 1",
            "choice": "1",
            "label": "先取卷轴",
            "stance": "default",
            "reason": "以卷轴线索和通关稳定性优先。2 可接受,3 不默认。",
        }
    if key == "fourth":
        return {
            "stage": CANGKUN_STAGE_LABELS[key],
            "command": "",
            "choice": "split",
            "label": "三背盟 / 两断后",
            "stance": "coordination",
            "reason": "只提示目标分工,不替玩家分配具体人选。",
        }
    if key == "fifth":
        warning = _fifth_warning(fields)
        return {
            "stage": CANGKUN_STAGE_LABELS[key],
            "command": ".苍坤抉择 2",
            "choice": "2",
            "label": "夺图先遁",
            "stance": "default",
            "reason": warning or "卷轴线索成型后优先用 2 收束。113/五幕 3 不作为常规打法。",
            "avoid": ".苍坤抉择 3",
        }
    return {
        "stage": str(stage or ""),
        "command": "",
        "choice": "",
        "label": "等待阶段",
        "stance": "info",
        "reason": "当前消息未落到苍坤一/三/四/五幕抉择,先看原文。",
    }


def build_cangkun_current_advice(stage: str, fields: dict[str, Any] | None = None) -> dict[str, Any]:
    fields = fields or {}
    advice = dict(cangkun_stage_recommendation(stage, fields))
    advice["state_rows"] = [
        [key, str(fields.get(key) or "")]
        for key in CANGKUN_STATE_KEYS
        if fields.get(key) is not None and str(fields.get(key) or "") != ""
    ]
    return advice


def _stage_key(stage: str) -> str:
    text = str(stage or "")
    if "第一幕" in text:
        return "first"
    if "第三幕" in text:
        return "third"
    if "第四幕" in text:
        return "fourth"
    if "第五幕" in text:
        return "fifth"
    return ""


def _fifth_warning(fields: dict[str, Any]) -> str:
    alert = _int_field(fields, "慕兰警戒")
    greed = _int_field(fields, "贪念")
    stability = _int_field(fields, "神魂稳度")
    if alert >= 60 or greed >= 20:
        return "警戒或贪念偏高时更不该走五幕 3。默认仍是 2,极保守可退 1。"
    if 0 < stability <= 60:
        return "神魂稳度偏低,优先用 2 收束;不要转 3 贪后手。"
    return ""


def _int_field(fields: dict[str, Any], key: str) -> int:
    try:
        return int(str(fields.get(key) or "").strip())
    except (TypeError, ValueError):
        return 0
