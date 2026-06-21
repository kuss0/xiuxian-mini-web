from __future__ import annotations

import shlex
from dataclasses import dataclass


@dataclass(frozen=True)
class GroupMappingResult:
    status: str
    name: str = ""
    args: tuple[str, ...] = ()
    reason: str = ""
    text: str = ""
    argv: tuple[str, ...] = ()


def classify_group_mapping(text: str, *, is_admin: bool) -> GroupMappingResult:
    raw = str(text or "")
    rest = raw[1:] if raw.startswith(".") else ""
    if not rest or rest[0].isspace():
        return GroupMappingResult("skip")

    parts = rest.split(maxsplit=1)
    name = parts[0]
    tail = parts[1] if len(parts) > 1 else ""
    if name != "还有多少":
        return GroupMappingResult("skip")

    args = _split_args(tail)
    if args is None:
        return GroupMappingResult(
            "reject",
            name=name,
            reason="parse_error",
            text="failed to parse group mapping args",
        )
    if not is_admin:
        return GroupMappingResult(
            "reject",
            name=name,
            reason="admin_required",
            text="command `.还有多少` requires admin",
        )
    item = args[0] if args else ""
    if not item:
        return GroupMappingResult(
            "reject",
            name=name,
            reason="usage",
            text="usage: .还有多少 <物品名>",
        )
    return GroupMappingResult(
        "run",
        name=name,
        args=(item,),
        argv=("inventory", "find", "--simple", item),
    )


def _split_args(tail: str) -> tuple[str, ...] | None:
    if not tail.strip():
        return ()
    try:
        return tuple(shlex.split(tail))
    except ValueError:
        return None
