from __future__ import annotations

import shlex
from dataclasses import dataclass
from typing import Callable


class GroupMappingPermission:
    PUBLIC = "public"
    ADMIN_ONLY = "admin_only"


@dataclass(frozen=True)
class GroupMappingSpec:
    name: str
    description: str
    usage: str
    permission: str
    map_args: Callable[[tuple[str, ...]], "GroupMappingResult"]


@dataclass(frozen=True)
class GroupMappingResult:
    status: str
    name: str = ""
    args: tuple[str, ...] = ()
    reason: str = ""
    text: str = ""
    argv: tuple[str, ...] = ()


def map_inventory_query(args: tuple[str, ...]) -> GroupMappingResult:
    item = args[0] if args else ""
    if not item:
        return GroupMappingResult(
            "reject",
            name="还有多少",
            reason="usage",
            text="usage: .还有多少 <物品名>",
        )
    return GroupMappingResult(
        "run",
        name="还有多少",
        args=(item,),
        argv=("inventory", "find", "--simple", item),
    )


GROUP_MAPPING_SPECS: tuple[GroupMappingSpec, ...] = (
    GroupMappingSpec(
        name="还有多少",
        description="查某物品跨身份库存总量;脱敏,不暴露账号明细。",
        usage=".还有多少 <物品名>",
        permission=GroupMappingPermission.ADMIN_ONLY,
        map_args=map_inventory_query,
    ),
)

_SPECS_BY_NAME = {spec.name: spec for spec in GROUP_MAPPING_SPECS}


def specs_payload() -> list[dict]:
    return [
        {
            "name": spec.name,
            "description": spec.description,
            "usage": spec.usage,
            "permission": spec.permission,
        }
        for spec in GROUP_MAPPING_SPECS
    ]


def classify_group_mapping(text: str, *, is_admin: bool) -> GroupMappingResult:
    raw = str(text or "")
    rest = raw[1:] if raw.startswith(".") else ""
    if not rest or rest[0].isspace():
        return GroupMappingResult("skip")

    parts = rest.split(maxsplit=1)
    name = parts[0]
    tail = parts[1] if len(parts) > 1 else ""
    spec = _SPECS_BY_NAME.get(name)
    if spec is None:
        return GroupMappingResult("skip")

    args = _split_args(tail)
    if args is None:
        return GroupMappingResult(
            "reject",
            name=name,
            reason="parse_error",
            text="failed to parse group mapping args",
        )
    if spec.permission == GroupMappingPermission.ADMIN_ONLY and not is_admin:
        return GroupMappingResult(
            "reject",
            name=name,
            reason="admin_required",
            text=f"command `.{name}` requires admin",
        )
    return spec.map_args(args)


def _split_args(tail: str) -> tuple[str, ...] | None:
    if not tail.strip():
        return ()
    try:
        return tuple(shlex.split(tail))
    except ValueError:
        return None
