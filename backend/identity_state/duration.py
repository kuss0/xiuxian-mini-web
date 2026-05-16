"""把游戏文本里的中文时长解析成秒数。所有 module 共用。

支持
----
- "8 小时"           → 28800
- "5小时57分钟31秒"  → 21451
- "10 分钟"          → 600
- "9分钟"            → 540
- "30秒"             → 30
- "1天2小时"         → 93600

只是 module 用,不是 parser。parsers 那一层有自己的解析,各干各的。
"""
from __future__ import annotations

import re

_RE_DAY = re.compile(r"(\d+)\s*天")
_RE_HOUR = re.compile(r"(\d+)\s*小时")
_RE_MIN = re.compile(r"(\d+)\s*分钟")
_RE_SEC = re.compile(r"(\d+)\s*秒")


def parse_chinese_duration(text: str) -> int:
    """从一段游戏文本里抓出第一个中文时长,返回秒。抓不到返 0。"""
    if not text:
        return 0
    total = 0
    matched = False
    if m := _RE_DAY.search(text):
        total += int(m.group(1)) * 86400
        matched = True
    if m := _RE_HOUR.search(text):
        total += int(m.group(1)) * 3600
        matched = True
    if m := _RE_MIN.search(text):
        total += int(m.group(1)) * 60
        matched = True
    if m := _RE_SEC.search(text):
        total += int(m.group(1))
        matched = True
    return total if matched else 0


__all__ = ["parse_chinese_duration"]
