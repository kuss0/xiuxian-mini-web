from __future__ import annotations

from typing import Iterable

from backend.parsers.xutian_oracle import load_xutian_oracle_cases, xutian_advice


XUTIAN_ELEMENT_ALIASES = (
    {"label": "金系", "values": ("金", "雷")},
    {"label": "木系", "values": ("木", "风")},
    {"label": "水系", "values": ("水", "冰")},
    {"label": "火系", "values": ("火", "暗")},
    {"label": "土系", "values": ("土",)},
)

XUTIAN_CASE_LABELS = {
    "explicit": "明示",
    "success": "顺例",
    "failure": "反例",
}


def build_xutian_oracle_guide_payload() -> dict:
    data = load_xutian_oracle_cases()
    cases = {
        bucket: [_xutian_guide_case(bucket, item) for item in data.get(bucket, [])]
        for bucket in ("explicit", "success", "failure")
    }
    return {
        "ok": True,
        "element_aliases": [
            {"label": item["label"], "values": list(item["values"])}
            for item in XUTIAN_ELEMENT_ALIASES
        ],
        "case_labels": XUTIAN_CASE_LABELS,
        "counts": {bucket: len(items) for bucket, items in cases.items()},
        "cases": cases,
        "notes": [
            "虚天殿队伍契合换算仅用于虚天殿:金系=金/雷,木系=木/风,水系=水/冰,火系=火/暗,土系=土。",
            "明示优先级最高;顺例只表示历史实测可用;反例只用于避坑,不反推唯一答案。",
            "本接口只给 UI 展示和填入命令,不会自动发送。",
        ],
    }


def _xutian_guide_case(bucket: str, item: dict) -> dict:
    gua = str(item.get("gua") or "").strip()
    advice = xutian_advice(gua)
    examples = [
        {
            "route": str(example.get("route") or "").strip(),
            "strategy": str(example.get("strategy") or "").strip(),
            "source": str(example.get("source") or "").strip(),
        }
        for example in (item.get("examples") or [])
    ]
    route = str(item.get("route") or "").strip()
    strategy = str(item.get("strategy") or "").strip()
    source = str(item.get("source") or "").strip()
    if not route and examples:
        route = "/".join(_ordered_unique(example["route"] for example in examples if example["route"]))
    if not strategy and examples:
        strategy = "/".join(_ordered_unique(example["strategy"] for example in examples if example["strategy"]))
    if not source and examples:
        source = "；".join(example["source"] for example in examples[:3] if example["source"])
    return {
        "kind": bucket,
        "kind_label": XUTIAN_CASE_LABELS.get(bucket, bucket),
        "gua": gua,
        "route": route,
        "strategy": strategy,
        "source": source,
        "advice": str(advice.get("行运建议") or "").strip(),
        "basis": str(advice.get("建议依据") or "").strip(),
        "confidence": str(advice.get("建议置信") or "").strip(),
        "positive_examples": list(advice.get("历史顺例") or []),
        "negative_examples": list(advice.get("历史反例") or []),
        "examples": examples,
    }


def _ordered_unique(values: Iterable[str]) -> list[str]:
    seen: set[str] = set()
    result: list[str] = []
    for value in values:
        if not value or value in seen:
            continue
        seen.add(value)
        result.append(value)
    return result
