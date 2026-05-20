"""虚天殿卦象样本库。

Parser 只负责抽取卦象文案;这里负责把可维护的数据样本转换成 UI 字段。
"""

from __future__ import annotations

import json
from functools import lru_cache
from importlib.resources import files
from typing import Any


Example = tuple[str, str, str]


@lru_cache(maxsize=1)
def load_xutian_oracle_cases() -> dict[str, Any]:
    data_path = files("backend.data").joinpath("xutian_oracle_cases.json")
    return json.loads(data_path.read_text(encoding="utf-8"))


@lru_cache(maxsize=1)
def _case_maps() -> tuple[dict[str, Example], dict[str, tuple[Example, ...]], dict[str, tuple[Example, ...]]]:
    data = load_xutian_oracle_cases()
    explicit: dict[str, Example] = {}
    success: dict[str, tuple[Example, ...]] = {}
    failure: dict[str, tuple[Example, ...]] = {}
    for item in data.get("explicit") or ():
        gua = _clean(item.get("gua"))
        if not gua:
            continue
        explicit[gua] = (_clean(item.get("route")), _clean(item.get("strategy")), _clean(item.get("source")))
    for bucket, target in (("success", success), ("failure", failure)):
        for item in data.get(bucket) or ():
            gua = _clean(item.get("gua"))
            if not gua:
                continue
            examples = []
            for example in item.get("examples") or ():
                route = _clean(example.get("route"))
                strategy = _clean(example.get("strategy"))
                source = _clean(example.get("source"))
                if route or strategy or source:
                    examples.append((route, strategy, source))
            target[gua] = tuple(examples)
    return explicit, success, failure


def xutian_advice(gua: str) -> dict[str, object]:
    gua = _clean(gua)
    if not gua:
        return {}
    explicit, success, failure = _case_maps()
    if gua in explicit:
        route, strategy, source = explicit[gua]
        fields: dict[str, object] = {
            "行运建议": f"{route} / {strategy}",
            "建议依据": f"历史明示 {source}",
            "建议置信": "明示",
        }
        _attach_examples(fields, gua, success, failure)
        return fields
    if gua in success:
        examples = success[gua]
        fields = {
            "行运建议": _format_observed_advice(examples),
            "建议依据": "历史顺合样本",
            "建议置信": "实测顺合",
        }
        _attach_examples(fields, gua, success, failure)
        return fields
    same_trigram = _same_trigram_explicit(gua, explicit)
    if same_trigram:
        route, strategy, source, ref_gua = same_trigram
        fields = {
            "行运建议": f"{route} / {strategy}",
            "建议依据": f"同卦系历史明示 {source}: {ref_gua}",
            "建议置信": "同卦系推断",
        }
        _attach_examples(fields, gua, success, failure)
        return fields
    if gua in failure:
        return {
            "建议依据": "仅有历史反例，暂不推荐具体路线",
            "建议置信": "反例",
            "历史反例": _format_examples(failure[gua]),
        }
    return {}


def _same_trigram_explicit(gua: str, explicit: dict[str, Example]) -> tuple[str, str, str, str] | None:
    prefix = gua.split(" · ", 1)[0].strip()
    if not prefix:
        return None
    for known_gua, (route, strategy, source) in explicit.items():
        if known_gua.split(" · ", 1)[0].strip() == prefix:
            return route, strategy, source, known_gua
    return None


def _attach_examples(
    fields: dict[str, object],
    gua: str,
    success: dict[str, tuple[Example, ...]],
    failure: dict[str, tuple[Example, ...]],
) -> None:
    if gua in success:
        fields["历史顺例"] = _format_examples(success[gua])
    if gua in failure:
        fields["历史反例"] = _format_examples(failure[gua])


def _format_observed_advice(examples: tuple[Example, ...]) -> str:
    routes = _ordered_unique(route for route, _, _ in examples)
    strategies = _ordered_unique(strategy for _, strategy, _ in examples)
    route_text = "/".join(routes)
    strategy_text = "/".join(strategies)
    return f"{route_text} / {strategy_text}" if strategy_text else route_text


def _format_examples(examples: tuple[Example, ...]) -> list[str]:
    return [f"{route} / {strategy} ({source})" for route, strategy, source in examples]


def _ordered_unique(values) -> list[str]:
    seen = set()
    result = []
    for value in values:
        if value in seen:
            continue
        seen.add(value)
        result.append(value)
    return result


def _clean(value: object) -> str:
    return str(value or "").strip()
